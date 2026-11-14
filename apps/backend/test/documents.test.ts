import { execFile, spawn } from 'node:child_process';
import { getEventListeners, once } from 'node:events';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CHILD_TIMEOUT_MS, MAX_CHILD_OUTPUT_BYTES, runChild } from '../src/documents/run-child.ts';
import {
  MAX_INPUT_BYTES,
  TASKS,
  createDocumentsApp,
  grantedCode,
  startDocuments,
  type RunningDocuments,
  type Task,
} from '../src/documents/server.ts';
import { systemClock } from '../src/kit/clock.ts';
import { PINNED_NODE } from '../src/kit/config.ts';
import {
  DOCUMENTS_DEADLINE_MS,
  DocumentsError,
  MAX_REPLY_BYTES,
  READY_DEADLINE_MS,
  createDocumentsClient,
} from '../src/kit/documents-client.ts';
import { createLogger, type Sink } from '../src/kit/logger.ts';

// The document service for real: children under the permission model, on a Unix socket, through
// the backend's client (docs/specs/platform.md, "documents"; T12).

const children = realpathSync(fileURLToPath(new URL('./children/', import.meta.url)));
const child = (name: string) => path.join(children, `${name}.ts`);
const folders: string[] = [];
/** A new private folder (mode 0700, from mkdtemp), by real path. */
function privateFolder(): string {
  const folder = realpathSync(mkdtempSync(path.join(tmpdir(), 'instante-doc-')));
  folders.push(folder);
  return folder;
}
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

const runtime = {
  nodeVersion: PINNED_NODE,
  execArgv: [],
  homeDir: '/Users/nobody',
  readFile: () => '',
};
const quiet: Sink = { out: () => {}, err: () => {} };
/** A sink that keeps each line, parsed. */
function recording(): { sink: Sink; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const keep = (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>);
  return { sink: { out: keep, err: keep }, lines };
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** The ids of this process's own children running `script`. `ps` runs beside the event loop, which
 * the service under test shares. */
async function childrenRunning(script: string): Promise<number[]> {
  const { stdout } = await promisify(execFile)('ps', ['-A', '-ww', '-o', 'pid=,ppid=,command=']);
  return stdout
    .split('\n')
    .map((row) => row.trim().split(/\s+/))
    .filter(
      ([, ppid, ...command]) => Number(ppid) === process.pid && command.join(' ').includes(script),
    )
    .map(([pid]) => Number(pid));
}
/** The checkout this file is in, by real path. */
const root = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
const json = (task: string): Task => ({ script: child(task), contentType: 'application/json' });
const tasks = {
  echo: TASKS['echo'] as Task,
  report: json('report'),
  forever: json('forever'),
  loud: json('loud'),
  broken: json('broken'),
};

describe('runChild', () => {
  const run = (
    name: string,
    extra: { timeoutMs?: number; maxOutputBytes?: number; args?: readonly string[] } = {},
  ) => {
    const jobFolder = privateFolder();
    return {
      jobFolder,
      result: runChild({ script: child(name), args: [], jobFolder, grants: [children], ...extra }),
    };
  };

  it('starts the child with exactly its flags, an empty environment, no IPC, in the job folder', async () => {
    const { jobFolder, result } = run('report');
    const done = await result;
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(JSON.parse(done.stdout.toString())).toEqual({
      execArgv: [
        '--permission',
        '--disable-sigusr1',
        '--max-old-space-size=256',
        '--no-experimental-sqlite',
        '--freeze-flags-after-init',
        `--allow-fs-read=${jobFolder}`,
        `--allow-fs-read=${children}`,
      ],
      // macOS's CoreFoundation sets its text-encoding hint in every process it starts in; the
      // spawn itself passes nothing.
      env: process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : [],
      ipc: false,
      cwd: jobFolder,
      // Three pipes of its own (libuv makes them socket pairs), and a stdin that has ended.
      streams: ['socket', 'socket', 'socket'],
      stdin: 0,
      input: 'ENOENT',
    });
  });

  it('kills a child past its time limit', async () => {
    const began = Date.now();
    const done = await run('forever', { timeoutMs: 300 }).result;
    expect(done).toMatchObject({ ok: false, reason: 'timed_out', signal: 'SIGKILL' });
    expect(Date.now() - began).toBeLessThan(5000);
  });

  it('kills a child that writes more than its output limit', async () => {
    const done = await run('loud', { maxOutputBytes: 1024 * 1024 }).result;
    expect(done).toMatchObject({ ok: false, reason: 'too_much_output', signal: 'SIGKILL' });
  });

  it('keeps a result of exactly its output limit, and refuses one byte more', async () => {
    const cap = 1024 * 1024;
    const exact = await run('loud', { maxOutputBytes: cap, args: [String(cap)] }).result;
    expect(exact.ok && exact.stdout.byteLength).toBe(cap);
    const over = await run('loud', { maxOutputBytes: cap, args: [String(cap + 1)] }).result;
    expect(over).toMatchObject({ ok: false, reason: 'too_much_output' });
  });

  it('refuses a result past its limit even from a child that has already exited cleanly', async () => {
    const { result } = run('loud', { maxOutputBytes: 1, args: ['2'] });
    // The parent, blocked, reads the output only after the child has exited with 0.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    expect(await result).toMatchObject({ ok: false, reason: 'too_much_output' });
  });

  it('keeps the first 64 KiB of stderr, whole characters only', async () => {
    // 1 MiB of '€', 3 bytes each: 21,845 of them fit in 65,536 bytes.
    const done = await run('loud', { args: [String(1024 * 1024), 'stderr', '€'] }).result;
    expect(done.ok).toBe(true);
    expect(done.stderr).toBe('€'.repeat(21_845));
  });

  it('keeps 64 KiB of stderr however it arrives', async () => {
    // Two writes of 40,000 bytes, read apart: the cap cuts the second.
    const done = await run('loud', { args: ['40000', 'stderr', 'a', '2'] }).result;
    expect(done.stderr).toBe('a'.repeat(65_536));
  });

  it('lets a child write nothing, not even through node:sqlite', async () => {
    const { jobFolder, result } = run('writes');
    const done = await result;
    expect(done.ok && JSON.parse(done.stdout.toString())).toEqual([
      'ERR_ACCESS_DENIED',
      'ERR_UNKNOWN_BUILTIN_MODULE',
    ]);
    expect(readdirSync(jobFolder)).toEqual([]);
  });

  it('lets a child write nothing through V8’s own flags either: they’re frozen once it starts', async () => {
    const { jobFolder, result } = run('v8-flags');
    const done = await result;
    // V8 stops the process at the first flag it's asked to change.
    expect(done).toMatchObject({ ok: false, reason: 'failed', code: null });
    expect(done.stderr).toContain('IsFrozen');
    expect(readdirSync(jobFolder)).toEqual([]);
  });

  it('reports a child that fails, with its stderr', async () => {
    const done = await run('broken').result;
    expect(done).toMatchObject({
      ok: false,
      reason: 'failed',
      code: 3,
      signal: null,
      stderr: 'could not read the document',
    });
  });

  it('kills the child when told to stop', async () => {
    const stopping = new AbortController();
    const jobFolder = privateFolder();
    const result = runChild({
      script: child('forever'),
      args: [],
      jobFolder,
      grants: [children],
      // Below the test's own timeout, so a stop that fails still ends the child.
      timeoutMs: 4000,
      signal: stopping.signal,
    });
    setTimeout(() => {
      stopping.abort();
    }, 200);
    expect(await result).toMatchObject({ ok: false, reason: 'stopped', signal: 'SIGKILL' });
  });

  it('kills at once a child whose stop came before it started', async () => {
    const began = Date.now();
    const done = await runChild({
      script: child('forever'),
      args: [],
      jobFolder: privateFolder(),
      grants: [children],
      timeoutMs: 4000,
      signal: AbortSignal.abort(),
    });
    expect(done).toMatchObject({ ok: false, reason: 'stopped', signal: 'SIGKILL' });
    expect(Date.now() - began).toBeLessThan(2000);
  });

  it('lets go of the stop signal once each child ends, so no job is kept for the service’s life', async () => {
    const stopping = new AbortController();
    for (const name of ['report', 'broken']) {
      await runChild({
        script: child(name),
        args: [],
        jobFolder: privateFolder(),
        grants: [children],
        signal: stopping.signal,
      });
    }
    expect(getEventListeners(stopping.signal, 'abort')).toEqual([]);
  });

  it('lets a child read the granted code and nothing else: not the tests, nor the checkout', async () => {
    const paths = [
      path.join(root, 'apps/backend/src/documents/tasks/echo.ts'),
      path.join(root, 'packages/contract/package.json'),
      realpathSync(createRequire(import.meta.url).resolve('hono')),
      path.join(root, 'apps/backend/test/start.test.ts'),
      path.join(root, 'apps/backend/package.json'),
      path.join(root, 'package.json'),
    ];
    const done = await runChild({
      script: child('reach'),
      args: paths,
      jobFolder: privateFolder(),
      grants: [...grantedCode(), children],
    });
    expect(done.ok && JSON.parse(done.stdout.toString())).toEqual([
      'read',
      'read',
      'read',
      'ERR_ACCESS_DENIED',
      'ERR_ACCESS_DENIED',
      'ERR_ACCESS_DENIED',
    ]);
  });
});

describe('grantedCode', () => {
  it('is the backend source, packages/contract and node_modules/.pnpm, by real path', () => {
    expect(grantedCode()).toEqual([
      path.join(root, 'apps/backend/src'),
      path.join(root, 'packages/contract'),
      path.join(root, 'node_modules/.pnpm'),
    ]);
    const link = path.join(privateFolder(), 'checkout');
    symlinkSync(root, link);
    expect(grantedCode(link)).toEqual(grantedCode());
  });
});

describe('the limits', () => {
  it('hold the platform spec’s values', () => {
    expect(MAX_INPUT_BYTES).toBe(50_000_000);
    expect(MAX_CHILD_OUTPUT_BYTES).toBe(64 * 1024 * 1024);
    expect(MAX_REPLY_BYTES).toBe(MAX_CHILD_OUTPUT_BYTES);
    expect(READY_DEADLINE_MS).toBe(5000);
  });
});

describe('the document service', () => {
  let service: RunningDocuments;
  let jobsRoot: string;
  const lines: Record<string, unknown>[] = [];
  const sink: Sink = {
    out: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    err: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  };

  beforeAll(async () => {
    jobsRoot = privateFolder();
    service = await startDocuments({
      env: {
        INSTANTE_ENV: 'test',
        ROLE: 'documents',
        DOCUMENTS_SOCKET: path.join(privateFolder(), 'documents.sock'),
      },
      runtime,
      sink,
      documents: {
        tasks,
        grants: [...grantedCode(), children],
        jobsRoot,
        maxInputBytes: 1024,
        timeoutMs: 500,
      },
    });
  });
  afterAll(async () => {
    await service.close();
  });

  it("returns echo's length and SHA-256 through the client, and keeps no job folder", async () => {
    const client = createDocumentsClient(service.socket);
    const reply = await client.run('echo', new TextEncoder().encode('hello'));
    expect(reply.status).toBe(200);
    expect(reply.contentType).toBe('application/json');
    expect(JSON.parse(reply.body.toString())).toEqual({
      length: 5,
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    });
    expect(await client.answers()).toBe(true);
    expect(readdirSync(jobsRoot)).toEqual([]);
    expect(lines).toContainEqual(
      expect.objectContaining({ event: 'documents.run', task: 'echo', inputBytes: 5 }),
    );
    expect(reply.body.toString()).toBe(
      '{"length":5,"sha256":"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"}',
    );
    expect(lines).toContainEqual({
      at: expect.any(String) as unknown,
      level: 'info',
      event: 'documents.run',
      role: 'documents',
      task: 'echo',
      ms: expect.any(Number) as unknown,
      inputBytes: 5,
      outputBytes: reply.body.byteLength,
    });
    expect(lines).toContainEqual(
      expect.objectContaining({
        event: 'documents.listening',
        socket: service.socket,
        env: 'test',
      }),
    );
  });

  it('answers 404 for a task it doesn’t have, and 413 for an input past its limit', async () => {
    const client = createDocumentsClient(service.socket);
    for (const name of ['nope', 'constructor', '__proto__', '../echo']) {
      const reply = await client.run(name, new Uint8Array());
      expect(reply.status).toBe(404);
      expect(JSON.parse(reply.body.toString())).toEqual({ error: { code: 'unknown_task' } });
    }
    const big = await client.run('echo', new Uint8Array(1025));
    expect(big.status).toBe(413);
    expect(JSON.parse(big.body.toString())).toEqual({ error: { code: 'too_large' } });
    const exact = await client.run('echo', new Uint8Array(1024));
    expect(exact.status).toBe(200);
  });

  it('answers 404 unknown_task, in JSON, to anything but POST /run/:task', async () => {
    for (const [method, route] of [
      ['GET', '/run/echo'],
      ['PUT', '/run/echo'],
      ['POST', '/run'],
      ['POST', '/run/echo/more'],
    ] as const) {
      const reply = await new Promise<{
        status: number | undefined;
        type: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = request({ socketPath: service.socket, method, path: route }, (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => (body += chunk.toString()));
          res.on('end', () => {
            resolve({ status: res.statusCode, type: res.headers['content-type'], body });
          });
        });
        req.on('error', reject);
        req.end();
      });
      expect(reply).toEqual({
        status: 404,
        type: 'application/json',
        body: '{"error":{"code":"unknown_task"}}',
      });
    }
  });

  it('arms the limits that run by default: 30 s for a child, 25 s for a call, 5 s for readiness', async () => {
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const clears = vi.spyOn(globalThis, 'clearTimeout');
    try {
      const app = createDocumentsApp({
        logger: createLogger({ clock: systemClock, sink: quiet }),
        jobsRoot: privateFolder(),
      });
      const reply = await app.request('/run/echo', { method: 'POST', body: new Uint8Array([1]) });
      expect(reply.status).toBe(200);
      expect(timers).toHaveBeenCalledWith(expect.any(Function), CHILD_TIMEOUT_MS);
      // A deadline given for one call wins over the client's own: readiness keeps its 5 s.
      expect(await createDocumentsClient(service.socket, { deadlineMs: 1 }).answers()).toBe(true);
      expect(timers).toHaveBeenCalledWith(expect.any(Function), READY_DEADLINE_MS);
      await createDocumentsClient(service.socket).run('echo', new Uint8Array());
      expect(timers).toHaveBeenCalledWith(expect.any(Function), DOCUMENTS_DEADLINE_MS);
      // Each call's deadline is cleared once it settles.
      const deadlines = timers.mock.calls.flatMap(([, ms], i) =>
        ms === READY_DEADLINE_MS || ms === DOCUMENTS_DEADLINE_MS
          ? [timers.mock.results[i]?.value as unknown]
          : [],
      );
      expect(deadlines).toHaveLength(2);
      for (const deadline of deadlines) expect(clears).toHaveBeenCalledWith(deadline);
    } finally {
      timers.mockRestore();
      clears.mockRestore();
    }
  });

  it('answers 500 failed when a job can’t start, logging why', async () => {
    const { sink, lines: logged } = recording();
    const app = createDocumentsApp({
      logger: createLogger({ clock: systemClock, sink }),
      jobsRoot: path.join(privateFolder(), 'gone'),
    });
    const reply = await app.request('/run/echo', { method: 'POST', body: new Uint8Array([1]) });
    expect(reply.status).toBe(500);
    expect(await reply.json()).toEqual({ error: { code: 'failed' } });
    expect(logged).toContainEqual(
      expect.objectContaining({ level: 'error', event: 'documents.error' }),
    );
  });

  it('answers 500 for a child that fails, logging its stderr, and 504 for one past its time', async () => {
    const client = createDocumentsClient(service.socket);
    const failed = await client.run('broken', new Uint8Array());
    expect(failed.status).toBe(500);
    expect(JSON.parse(failed.body.toString())).toEqual({ error: { code: 'failed' } });
    expect(lines).toContainEqual(
      expect.objectContaining({
        event: 'documents.failed',
        task: 'broken',
        code: 3,
        stderr: 'could not read the document',
      }),
    );
    expect(lines).toContainEqual({
      at: expect.any(String) as unknown,
      level: 'warn',
      event: 'documents.failed',
      role: 'documents',
      task: 'broken',
      reason: 'failed',
      code: 3,
      signal: null,
      ms: expect.any(Number) as unknown,
      stderr: 'could not read the document',
    });
    const slow = await client.run('forever', new Uint8Array());
    expect(slow.status).toBe(504);
    expect(JSON.parse(slow.body.toString())).toEqual({ error: { code: 'timed_out' } });
    expect(readdirSync(jobsRoot)).toEqual([]);
  });

  it('gives each job the input bytes in its own folder, which the next job can’t see', async () => {
    const client = createDocumentsClient(service.socket);
    const [a, b] = await Promise.all([
      client.run('report', new Uint8Array([1])),
      client.run('report', new Uint8Array([2])),
    ]);
    const cwdOf = (reply: typeof a) =>
      (JSON.parse(reply.body.toString()) as { cwd: string; execArgv: string[] }).cwd;
    expect(path.dirname(cwdOf(a))).toBe(jobsRoot);
    expect(cwdOf(a)).not.toBe(cwdOf(b));
    expect(
      (JSON.parse(a.body.toString()) as { execArgv: string[] }).execArgv.filter((f) =>
        f.startsWith('--allow-fs-read='),
      ),
    ).toEqual([cwdOf(a), ...grantedCode(), children].map((p) => `--allow-fs-read=${p}`));
    expect((JSON.parse(a.body.toString()) as { input: string }).input).toBe('600');
  });
});

describe('starting and stopping the document service', () => {
  const env = (socket: string) => ({
    INSTANTE_ENV: 'test',
    ROLE: 'documents',
    DOCUMENTS_SOCKET: socket,
  });

  it('refuses a socket folder other users can reach', async () => {
    const folder = privateFolder();
    chmodSync(folder, 0o755);
    await expect(
      startDocuments({ env: env(path.join(folder, 'd.sock')), runtime, sink: quiet }),
    ).rejects.toThrow(/must be yours, mode 0700, not 755/);
  });

  it('refuses a socket folder open to its group alone, or to others alone', async () => {
    for (const mode of [0o750, 0o705]) {
      const folder = privateFolder();
      chmodSync(folder, mode);
      await expect(
        startDocuments({ env: env(path.join(folder, 'd.sock')), runtime, sink: quiet }),
      ).rejects.toThrow(`must be yours, mode 0700, not ${mode.toString(8)}`);
    }
  });

  it('refuses a socket folder that isn’t yours, or isn’t a folder, saying which', async () => {
    // The root folder belongs to root.
    await expect(startDocuments({ env: env('/d.sock'), runtime, sink: quiet })).rejects.toThrow(
      "socket folder must be yours, not uid 0's",
    );
    const file = path.join(privateFolder(), 'file');
    writeFileSync(file, '');
    await expect(
      startDocuments({ env: env(path.join(file, 'd.sock')), runtime, sink: quiet }),
    ).rejects.toThrow("socket folder isn't a folder");
  });

  it('refuses a socket path held by a symlink, even one that points nowhere', async () => {
    const open = privateFolder();
    chmodSync(open, 0o1777);
    const planted = path.join(open, 'planted.sock');
    const socket = path.join(privateFolder(), 'd.sock');
    symlinkSync(planted, socket);
    await expect(startDocuments({ env: env(socket), runtime, sink: quiet })).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
    expect(lstatSync(socket).isSymbolicLink()).toBe(true);
    expect(existsSync(planted)).toBe(false);
  });

  it('kills the children still running when it stops, and their folders go before it’s done', async () => {
    const socket = path.join(privateFolder(), 'd.sock');
    const jobsRoot = privateFolder();
    const { sink, lines } = recording();
    const service = await startDocuments({
      env: env(socket),
      runtime,
      sink,
      documents: {
        tasks: { forever: json('forever') },
        grants: [...grantedCode(), children],
        jobsRoot,
        // Below the test's own timeout, so a stop that fails still ends the child.
        timeoutMs: 4000,
      },
    });
    try {
      const running = createDocumentsClient(socket)
        .run('forever', new Uint8Array([1]))
        .catch((error: unknown) => error);
      const script = child('forever');
      for (let i = 0; i < 40 && (await childrenRunning(script)).length === 0; i++) await sleep(50);
      expect(await childrenRunning(script)).toHaveLength(1);
      expect(readdirSync(jobsRoot)).toHaveLength(1);
      const began = Date.now();
      await service.close();
      expect(Date.now() - began).toBeLessThan(2000);
      expect(await childrenRunning(script)).toEqual([]);
      expect(readdirSync(jobsRoot)).toEqual([]);
      expect(lines).toContainEqual(
        expect.objectContaining({ event: 'documents.failed', task: 'forever', reason: 'stopped' }),
      );
      expect(await running).toMatchObject({ name: 'DocumentsError', reason: 'unavailable' });
    } finally {
      await service.close();
    }
  });

  it('answers 500 too_much_output for a result past 64 MiB', async () => {
    const socket = path.join(privateFolder(), 'd.sock');
    const service = await startDocuments({
      env: env(socket),
      runtime,
      sink: quiet,
      documents: {
        tasks: { loud: json('loud') },
        grants: [...grantedCode(), children],
        jobsRoot: privateFolder(),
      },
    });
    try {
      const reply = await createDocumentsClient(socket).run('loud', new Uint8Array());
      expect(reply.status).toBe(500);
      expect(JSON.parse(reply.body.toString())).toEqual({ error: { code: 'too_much_output' } });
    } finally {
      await service.close();
    }
  });

  it('refuses a socket another process answers on, and replaces one a dead process left', async () => {
    const socket = path.join(privateFolder(), 'd.sock');
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `require('node:net').createServer().listen(${JSON.stringify(socket)}, () => console.log('up'))`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 12_000 },
    );
    await once(holder.stdout, 'data');
    await expect(startDocuments({ env: env(socket), runtime, sink: quiet })).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
    // Killed, it can't remove its socket: the file a crash leaves behind.
    holder.kill('SIGKILL');
    await once(holder, 'exit');
    expect(existsSync(socket)).toBe(true);
    const service = await startDocuments({ env: env(socket), runtime, sink: quiet });
    try {
      expect(await createDocumentsClient(socket).answers()).toBe(true);
    } finally {
      await service.close();
    }
    expect(existsSync(socket)).toBe(false);
  });

  it('refuses a socket path held by something that isn’t a socket', async () => {
    const folder = privateFolder();
    const socket = path.join(folder, 'd.sock');
    writeFileSync(socket, 'not a socket');
    await expect(startDocuments({ env: env(socket), runtime, sink: quiet })).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
    expect(existsSync(socket)).toBe(true);
  });

  it('stops answering, and removes its socket, when it stops', async () => {
    const socket = path.join(privateFolder(), 'd.sock');
    const service = await startDocuments({ env: env(socket), runtime, sink: quiet });
    const client = createDocumentsClient(socket);
    expect(await client.answers()).toBe(true);
    expect(lstatSync(socket).mode & 0o777).toBe(0o600);
    await service.close();
    expect(existsSync(socket)).toBe(false);
    expect(await client.answers()).toBe(false);
    await expect(client.run('echo', new Uint8Array())).rejects.toMatchObject({
      name: 'DocumentsError',
      reason: 'unavailable',
    });
  });

  it('runs through main.ts with ROLE=documents, and stops on SIGTERM', async () => {
    const socket = path.join(privateFolder(), 'd.sock');
    const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
    const service = spawn(process.execPath, ['--disable-sigusr1', main], {
      env: { PATH: process.env['PATH'] ?? '', ...env(socket) },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 12_000,
    });
    let out = '';
    service.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    const exited = new Promise<number | null>((resolve) =>
      service.on('exit', (code) => {
        resolve(code);
      }),
    );
    for (let i = 0; i < 100 && !out.includes('documents.listening'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(await createDocumentsClient(socket).answers()).toBe(true);
    service.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(existsSync(socket)).toBe(false);
  }, 15_000);
});

describe('the client', () => {
  /** A socket server that takes a request and does whatever `reply` does with it. */
  async function fake(reply: (socket: Socket) => void): Promise<string> {
    const socket = path.join(privateFolder(), 'fake.sock');
    const server = createNetServer(reply);
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    servers.push(server);
    return socket;
  }
  const servers: NetServer[] = [];
  afterAll(() => {
    for (const server of servers) server.close();
  });

  it('gives up at its deadline, 25 seconds unless told otherwise', async () => {
    expect(DOCUMENTS_DEADLINE_MS).toBe(25_000);
    const silent = await fake(() => undefined);
    const began = Date.now();
    await expect(
      createDocumentsClient(silent, { deadlineMs: 200 }).run('echo', new Uint8Array()),
    ).rejects.toMatchObject({ name: 'DocumentsError', reason: 'deadline' });
    expect(Date.now() - began).toBeLessThan(2000);
  });

  it('refuses a reply past its limit', async () => {
    const flood = await fake((socket) => {
      socket.once('data', () => {
        socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n');
        socket.write(Buffer.alloc(4096, 0x61));
      });
    });
    const error = await createDocumentsClient(flood, { maxReplyBytes: 1024 })
      .run('echo', new Uint8Array())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DocumentsError);
    expect(error).toMatchObject({ reason: 'too_large' });
  });

  it('takes a reply of exactly its limit', async () => {
    const full = await fake((socket) => {
      socket.once('data', () => {
        socket.end(`HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n${'a'.repeat(1024)}`);
      });
    });
    const reply = await createDocumentsClient(full, { maxReplyBytes: 1024 }).run(
      'echo',
      new Uint8Array(),
    );
    expect(reply.body.byteLength).toBe(1024);
  });

  it('fails at once, not at its deadline, on a reply cut off midway', async () => {
    const cut = await fake((socket) => {
      socket.once('data', () => {
        socket.write('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nabc', () => socket.destroy());
      });
    });
    const began = Date.now();
    await expect(
      createDocumentsClient(cut, { deadlineMs: 5000 }).run('echo', new Uint8Array()),
    ).rejects.toMatchObject({ name: 'DocumentsError', reason: 'unavailable' });
    expect(Date.now() - began).toBeLessThan(2000);
  });

  it('closes its connection when it gives up', async () => {
    let closed!: Promise<unknown>;
    const silent = await fake((socket) => {
      socket.resume(); // reads the request, so the client's end arrives
      closed = once(socket, 'close');
    });
    await expect(
      createDocumentsClient(silent, { deadlineMs: 200 }).run('echo', new Uint8Array()),
    ).rejects.toMatchObject({ reason: 'deadline' });
    await expect(Promise.race([closed, sleep(1000).then(() => 'still open')])).resolves.not.toBe(
      'still open',
    );
  });

  it('isn’t ready on a wrong answer', async () => {
    const liar = await fake((socket) => {
      socket.once('data', () => {
        const body = JSON.stringify({ length: 0, sha256: 'not-it' });
        socket.end(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${String(body.length)}\r\n\r\n${body}`,
        );
      });
    });
    expect(await createDocumentsClient(liar).answers()).toBe(false);
  });

  it('isn’t ready on a wrong length, or a failure that carries the right hash', async () => {
    const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const answering = (status: string, body: string) =>
      fake((socket) => {
        socket.once('data', () => {
          socket.end(
            `HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${String(body.length)}\r\n\r\n${body}`,
          );
        });
      });
    const wrongLength = await answering('200 OK', JSON.stringify({ length: 7, sha256: empty }));
    expect(await createDocumentsClient(wrongLength).answers()).toBe(false);
    const failing = await answering(
      '500 Internal Server Error',
      JSON.stringify({ length: 0, sha256: empty }),
    );
    expect(await createDocumentsClient(failing).answers()).toBe(false);
  });
});
