import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runChild } from '../src/documents/run-child.ts';
import {
  TASKS,
  grantedCode,
  startDocuments,
  type RunningDocuments,
  type Task,
} from '../src/documents/server.ts';
import { PINNED_NODE } from '../src/kit/config.ts';
import {
  DOCUMENTS_DEADLINE_MS,
  DocumentsError,
  createDocumentsClient,
} from '../src/kit/documents-client.ts';
import type { Sink } from '../src/kit/logger.ts';

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
const json = (task: string): Task => ({ script: child(task), contentType: 'application/json' });
const tasks = {
  echo: TASKS['echo'] as Task,
  report: json('report'),
  forever: json('forever'),
  loud: json('loud'),
  broken: json('broken'),
};

describe('runChild', () => {
  const run = (name: string, extra: { timeoutMs?: number; maxOutputBytes?: number } = {}) => {
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
        `--allow-fs-read=${jobFolder}`,
        `--allow-fs-read=${children}`,
      ],
      // macOS's CoreFoundation sets its text-encoding hint in every process it starts in; the
      // spawn itself passes nothing.
      env: process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : [],
      ipc: false,
      cwd: jobFolder,
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
      signal: stopping.signal,
    });
    setTimeout(() => {
      stopping.abort();
    }, 200);
    expect(await result).toMatchObject({ ok: false, reason: 'stopped', signal: 'SIGKILL' });
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
});
