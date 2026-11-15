import { execFileSync, spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { listOpenFiles } from '../src/documents/guards.ts';
import { runChild } from '../src/documents/run-child.ts';
import {
  TASKS,
  grantedCode,
  startDocuments,
  type RunningDocuments,
  type Task,
} from '../src/documents/server.ts';
import { PINNED_NODE } from '../src/kit/config.ts';
import { createDocumentsClient } from '../src/kit/documents-client.ts';
import type { Sink } from '../src/kit/logger.ts';
import { probeRead, probeUnixSocket, type SelftestTargets } from '../src/kit/probes.ts';

// The document service's isolation checks (docs/specs/platform.md, "documents", and its criterion
// 13; T13): selftest with the backend's positive control, the open-files check, the start-up walk
// over the granted code, and the job-folder check.

// Each job's folder comes from mkdtemp; a test can plant something in the next one before the
// service checks it.
const plant = vi.hoisted(() => ({ next: undefined as ((folder: string) => void) | undefined }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    mkdtemp: async (prefix: string) => {
      const folder = await real.mkdtemp(prefix);
      const planting = plant.next;
      plant.next = undefined;
      planting?.(folder);
      return folder;
    },
  };
});

const children = realpathSync(fileURLToPath(new URL('./children/', import.meta.url)));
const child = (name: string) => path.join(children, `${name}.ts`);
const folders: string[] = [];
/** A new private folder (mode 0700, from mkdtemp), by real path. */
function privateFolder(): string {
  const folder = realpathSync(mkdtempSync(path.join(tmpdir(), 'instante-self-')));
  folders.push(folder);
  return folder;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const runtime = (execArgv: string[]) => ({
  nodeVersion: PINNED_NODE,
  execArgv,
  homeDir: '/Users/nobody',
  readFile: () => '',
});
const env = (socket: string) => ({
  INSTANTE_ENV: 'test',
  ROLE: 'documents',
  DOCUMENTS_SOCKET: socket,
});
function recording(): { sink: Sink; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const keep = (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>);
  return { sink: { out: keep, err: keep }, lines };
}
const listen = (server: Server, at: number | string) =>
  new Promise<void>((resolve) => {
    if (typeof at === 'number') server.listen(at, '127.0.0.1', resolve);
    else server.listen(at, resolve);
  });
const portOf = (server: Server) => {
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
};

// What selftest probes: a port standing for the backend's, a socket for the database's, and a
// secrets folder holding a secret. This process reaches each, so a denial in the child is the
// permission model's, not a missing target.
let backend: Server;
let database: Server;
let targets: SelftestTargets;
let secret: string;

const DENIED = {
  tcp: 'denied',
  databaseSocket: 'denied',
  lookup: 'denied',
  write: 'denied',
  spawn: 'denied',
  readSecrets: 'denied',
} as const;
/** CoreFoundation's text-encoding hint, which macOS sets in every process. */
const PLATFORM_NAMES = process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : [];

beforeAll(async () => {
  backend = createServer((socket) => socket.end());
  database = createServer((socket) => socket.end());
  const run = privateFolder();
  const secrets = path.join(privateFolder(), 'secrets');
  mkdirSync(secrets, { mode: 0o700 });
  secret = path.join(secrets, 'database-url');
  writeFileSync(secret, 'postgresql://instante_app:hex@/instante', { mode: 0o600 });
  await listen(backend, 0);
  await listen(database, path.join(run, '.s.PGSQL.5432'));
  targets = {
    port: portOf(backend),
    databaseSocket: path.join(run, '.s.PGSQL.5432'),
    secrets,
  };
});
afterAll(() => {
  backend.close();
  database.close();
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

describe('selftest', () => {
  let service: RunningDocuments;
  let jobsRoot: string;
  const { sink, lines } = recording();
  const tasks: Record<string, Task> = {
    ...TASKS,
    holds: { script: child('holds-input'), contentType: 'application/json', selftest: true },
  };

  beforeAll(async () => {
    jobsRoot = privateFolder();
    service = await startDocuments({
      env: env(path.join(privateFolder(), 'documents.sock')),
      runtime: runtime(['--disable-sigusr1']),
      sink,
      documents: { tasks, grants: [...grantedCode(), children], jobsRoot },
    });
  });
  afterAll(async () => {
    await service.close();
  });

  it('passes: the child is denied every probe the backend’s own reach, and holds nothing more', async () => {
    const result = await createDocumentsClient(service.socket).selftest(targets);
    expect(result).toEqual({
      ok: true,
      problems: [],
      positiveControl: { tcp: 'allowed', lookup: 'allowed' },
      documents: {
        ok: true,
        problems: [],
        service: { extraNames: [], databaseUrl: false, secretFile: false, disableSigusr1: true },
        child: {
          execArgv: [
            '--permission',
            '--disable-sigusr1',
            '--max-old-space-size=256',
            '--no-experimental-sqlite',
            '--freeze-flags-after-init',
            expect.stringMatching(new RegExp(`^--allow-fs-read=${jobsRoot}/instante-job-\\w+$`)),
            ...[...grantedCode(), children].map((grant) => `--allow-fs-read=${grant}`),
          ] as unknown,
          env: PLATFORM_NAMES,
          probes: DENIED,
        },
        openFiles: [],
      },
    });
    // The same targets, from here, where nothing stops them.
    expect(await probeUnixSocket(targets.databaseSocket)).toBe('allowed');
    expect(probeRead(targets.secrets)).toBe('allowed');
    expect(readdirSync(jobsRoot)).toEqual([]);
  });

  it('finds a descriptor the child holds beyond its own: here, its input', async () => {
    const reply = await createDocumentsClient(service.socket).run(
      'holds',
      new TextEncoder().encode(JSON.stringify(targets)),
    );
    const body = JSON.parse(reply.body.toString()) as { ok: boolean; openFiles: string[] };
    expect(reply.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.openFiles).toEqual([
      expect.stringMatching(new RegExp(`^\\d+ REG ${jobsRoot}/instante-job-\\w+/input$`)),
    ]);
  });

  it('fails on targets that aren’t a port and two absolute paths, and logs why', async () => {
    const client = createDocumentsClient(service.socket);
    for (const input of ['not json', JSON.stringify({ ...targets, port: 0 })]) {
      const reply = await client.run('selftest', new TextEncoder().encode(input));
      expect(reply.status).toBe(500);
      expect(JSON.parse(reply.body.toString())).toEqual({ error: { code: 'failed' } });
    }
    expect(lines.filter((line) => line['event'] === 'documents.failed')).toHaveLength(2);
  });

  it('fails when the backend can’t reach its own port, though the child is denied as ever', async () => {
    const closed = createServer();
    await listen(closed, 0);
    const port = portOf(closed);
    closed.close();
    const result = await createDocumentsClient(service.socket).selftest({ ...targets, port });
    expect(result.ok).toBe(false);
    expect(result.positiveControl).toEqual({ tcp: 'failed: ECONNREFUSED', lookup: 'allowed' });
    expect(result.problems).toEqual([
      "the backend couldn't reach its own port: failed: ECONNREFUSED",
    ]);
    expect(result.documents?.ok).toBe(true);
  });
});

describe('selftest’s checks of the service itself', () => {
  it('names the names beyond its own, a database URL, a secret file’s path and a missing --disable-sigusr1', async () => {
    const socket = path.join(privateFolder(), 'documents.sock');
    const service = await startDocuments({
      env: {
        ...env(socket),
        PATH: '/usr/bin',
        PGURL: 'postgres://instante_app@/instante',
        TOKEN_FILE: '/elsewhere/token',
      },
      runtime: runtime([]),
      sink: recording().sink,
      documents: { grants: grantedCode() },
    });
    try {
      const result = await createDocumentsClient(socket).selftest(targets);
      expect(result.ok).toBe(false);
      expect(result.documents?.service).toEqual({
        extraNames: ['PATH', 'PGURL', 'TOKEN_FILE'],
        databaseUrl: true,
        secretFile: true,
        disableSigusr1: false,
      });
      expect(result.problems).toEqual([
        "the service's environment holds other names: PATH, PGURL, TOKEN_FILE",
        "the service's environment holds a database URL",
        "the service's environment holds a secret file's path",
        'the service started without --disable-sigusr1',
      ]);
    } finally {
      await service.close();
    }
  });
});

describe('the backend’s side of selftest', () => {
  const fakes: { close: () => void }[] = [];
  afterAll(() => {
    for (const server of fakes) server.close();
  });
  /** A socket server answering every request with this status and body. */
  async function fake(status: number, body: string): Promise<string> {
    const socket = path.join(privateFolder(), 'fake.sock');
    const server = createHttpServer((_request, response) => {
      response.writeHead(status, { 'content-type': 'application/json' }).end(body);
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    fakes.push(server);
    return socket;
  }
  const passing = {
    ok: true,
    problems: [],
    service: { extraNames: [], databaseUrl: false, secretFile: false, disableSigusr1: true },
    child: { execArgv: [], env: [], probes: DENIED },
    openFiles: [],
  };

  it('takes a reply that passes, and refuses one that doesn’t parse, isn’t JSON, or fails without a reason', async () => {
    const problems = async (status: number, body: string) =>
      (await createDocumentsClient(await fake(status, body)).selftest(targets)).problems;
    expect(await problems(200, JSON.stringify(passing))).toEqual([]);
    expect(await problems(200, JSON.stringify({ ...passing, extra: 1 }))).toEqual([
      "the document service's selftest reply doesn't parse",
    ]);
    expect(
      await problems(200, JSON.stringify({ ...passing, child: { ...passing.child, probes: {} } })),
    ).toEqual(["the document service's selftest reply doesn't parse"]);
    expect(await problems(200, 'not json')).toEqual(["the selftest reply isn't JSON"]);
    expect(await problems(200, JSON.stringify({ ...passing, ok: false }))).toEqual([
      'the document service failed its selftest without saying why',
    ]);
    expect(await problems(500, '{"error":{"code":"failed"}}')).toEqual([
      'the document service answered selftest with 500',
    ]);
  });

  it('reports a service that isn’t there', async () => {
    const result = await createDocumentsClient(path.join(privateFolder(), 'none.sock')).selftest(
      targets,
    );
    expect(result).toMatchObject({
      ok: false,
      problems: ["The document service couldn't be reached"],
      documents: undefined,
    });
  });
});

describe('the job folder check', () => {
  let service: RunningDocuments;
  let jobsRoot: string;
  const { sink, lines } = recording();

  beforeAll(async () => {
    jobsRoot = privateFolder();
    service = await startDocuments({
      env: env(path.join(privateFolder(), 'documents.sock')),
      runtime: runtime(['--disable-sigusr1']),
      sink,
      documents: { grants: grantedCode(), jobsRoot },
    });
  });
  afterAll(async () => {
    await service.close();
  });

  it('refuses a job whose folder holds a symlink, a hard link, a folder or a FIFO, before any child starts', async () => {
    const plants: [string, (folder: string) => void][] = [
      [
        'link is a symlink',
        (folder) => {
          symlinkSync(secret, path.join(folder, 'link'));
        },
      ],
      [
        'hard has 2 links',
        (folder) => {
          linkSync(secret, path.join(folder, 'hard'));
        },
      ],
      [
        "sub isn't a regular file",
        (folder) => {
          mkdirSync(path.join(folder, 'sub'));
        },
      ],
      [
        "fifo isn't a regular file",
        (folder) => execFileSync('mkfifo', [path.join(folder, 'fifo')]),
      ],
    ];
    const client = createDocumentsClient(service.socket);
    for (const [problem, make] of plants) {
      plant.next = make;
      const reply = await client.run('echo', new TextEncoder().encode('hello'));
      expect(reply.status).toBe(500);
      expect(JSON.parse(reply.body.toString())).toEqual({ error: { code: 'failed' } });
      expect(lines.at(-1)).toMatchObject({
        level: 'warn',
        event: 'documents.refused',
        task: 'echo',
        problems: [problem],
      });
    }
    // No child ran, and every folder went.
    expect(lines.filter((line) => line['event'] === 'documents.run')).toEqual([]);
    expect(readdirSync(jobsRoot)).toEqual([]);
    // The next job, with nothing planted, runs.
    expect((await client.run('echo', new TextEncoder().encode('hello'))).status).toBe(200);
  });
});

describe('the granted code at start', () => {
  it('refuses to start when a symlink in it leads out, before binding its socket', async () => {
    const grant = privateFolder();
    mkdirSync(path.join(grant, 'pkg'));
    symlinkSync(secret, path.join(grant, 'pkg', 'link'));
    const socket = path.join(privateFolder(), 'documents.sock');
    await expect(
      startDocuments({
        env: env(socket),
        runtime: runtime(['--disable-sigusr1']),
        sink: recording().sink,
        documents: { grants: [grant] },
      }),
    ).rejects.toThrow(`${path.join(grant, 'pkg', 'link')} points outside, to ${secret}`);
    expect(existsSync(socket)).toBe(false);
  });

  it('is needed: a child reads outside its grant through a symlink inside it', async () => {
    const grant = privateFolder();
    symlinkSync(secret, path.join(grant, 'link'));
    const read = async (file: string) => {
      const done = await runChild({
        script: child('reads'),
        args: [file],
        jobFolder: privateFolder(),
        grants: [grant, children],
      });
      return done.ok ? done.stdout.toString() : done.stderr;
    };
    expect(await read(secret)).toBe('ERR_ACCESS_DENIED');
    expect(await read(path.join(grant, 'link'))).toBe('postgresql://instante_app:hex@/instante');
  });

  it('starts on the real granted code, and logs what it walked', async () => {
    const { sink, lines } = recording();
    const service = await startDocuments({
      env: env(path.join(privateFolder(), 'documents.sock')),
      runtime: runtime(['--disable-sigusr1']),
      sink,
    });
    await service.close();
    const listening = lines.find((line) => line['event'] === 'documents.listening');
    expect(listening?.['grantedLinks']).toBeGreaterThan(100);
    expect(listening?.['grantedEntries']).toBeGreaterThan(Number(listening?.['grantedLinks']));
  });
});

describe('selftest in a service started as `instante start` will start it', () => {
  it('passes with env -i and its own names, --disable-sigusr1, and the lock on descriptor 9', async () => {
    const socket = path.join(privateFolder(), 'documents.sock');
    const lock = path.join(privateFolder(), 'instante.lock');
    const lockFd = openSync(lock, 'a');
    const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
    const service = spawn(process.execPath, ['--disable-sigusr1', main], {
      env: env(socket),
      // The launcher's lock, inherited by each Instante process, which its children mustn't get.
      stdio: ['ignore', 'pipe', 'pipe', ...Array<'ignore'>(6).fill('ignore'), lockFd],
      timeout: 15_000,
    });
    closeSync(lockFd);
    try {
      let out = '';
      service.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
      for (let i = 0; i < 100 && !out.includes('documents.listening'); i++) await sleep(50);
      // The service holds the lock, so the check below has something to find.
      const held = await listOpenFiles(service.pid ?? 0);
      expect(held).toContainEqual(expect.objectContaining({ fd: '9', type: 'REG', name: lock }));

      const result = await createDocumentsClient(socket).selftest(targets);
      expect(result.problems).toEqual([]);
      expect(result.documents?.service.extraNames).toEqual([]);
      expect(result.documents?.child?.env).toEqual(PLATFORM_NAMES);
    } finally {
      service.kill('SIGTERM');
    }
  }, 20_000);
});
