import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CHILD_CODE, copyCode, type Code } from '../src/documents/code.ts';
import { listOpenFiles } from '../src/documents/guards.ts';
import { runChild } from '../src/documents/run-child.ts';
import {
  TASKS,
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
// Every child the service starts, counted; and the backend's lookup, which a test can fail.
const runs = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/documents/run-child.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/documents/run-child.ts')>();
  return {
    ...real,
    runChild: (run: Parameters<typeof real.runChild>[0]) => {
      runs.count++;
      return real.runChild(run);
    },
  };
});
const lookupFails = vi.hoisted(() => ({ with: undefined as string | undefined }));
vi.mock('node:dns/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:dns/promises')>();
  return {
    ...real,
    lookup: (host: string) =>
      lookupFails.with === undefined
        ? real.lookup(host)
        : Promise.reject(Object.assign(new Error(lookupFails.with), { code: lookupFails.with })),
  };
});

const children = realpathSync(fileURLToPath(new URL('./children/', import.meta.url)));
const child = (name: string) => path.join(children, `${name}.ts`);
/** The platform's tasks and these tests' children, as the service copies them for its children. */
const code: Code = {
  root: path.dirname(path.dirname(children)),
  files: [
    ...CHILD_CODE.files.map((file) => `src/${file}`),
    ...readdirSync(children).map((file) => `test/children/${file}`),
  ],
};
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
      documents: { tasks, code, jobsRoot },
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
            // The code's copy, beside the socket.
            expect.stringMatching(/^--allow-fs-read=\/.+\/instante-code-\w+$/),
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

  it('fails when the backend can’t look up localhost', async () => {
    lookupFails.with = 'ENOTFOUND';
    try {
      const result = await createDocumentsClient(service.socket).selftest(targets);
      expect(result.ok).toBe(false);
      expect(result.positiveControl).toEqual({ tcp: 'allowed', lookup: 'failed: ENOTFOUND' });
      expect(result.problems).toEqual([
        "the backend couldn't look up localhost: failed: ENOTFOUND",
      ]);
    } finally {
      lookupFails.with = undefined;
    }
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
    for (const reply of [
      { ...passing, extra: 1 },
      { ...passing, service: { ...passing.service, extra: true } },
      { ...passing, child: { ...passing.child, probes: {} } },
      { ...passing, child: { ...passing.child, probes: { ...DENIED, extra: 'denied' } } },
      { ...passing, child: { ...passing.child, probes: { ...DENIED, tcp: 'maybe' } } },
    ]) {
      expect(await problems(200, JSON.stringify(reply)), JSON.stringify(reply)).toEqual([
        "the document service's selftest reply doesn't parse",
      ]);
    }
    expect(await problems(200, 'not json')).toEqual(["the selftest reply isn't JSON"]);
    expect(await problems(200, JSON.stringify({ ...passing, ok: false }))).toEqual([
      'the document service failed its selftest without saying why',
    ]);
    expect(await problems(500, '{"error":{"code":"failed"}}')).toEqual([
      'the document service answered selftest with 500',
    ]);
    expect(await problems(504, '{"error":{"code":"timed_out"}}')).toEqual([
      'the document service answered selftest with 504',
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
      documents: { jobsRoot },
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
    const started = runs.count;
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
      // Refused before its child started, not after.
      expect(runs.count).toBe(started);
    }
    expect(lines.filter((line) => line['event'] === 'documents.run')).toEqual([]);
    expect(readdirSync(jobsRoot)).toEqual([]);
    // The next job, with nothing planted, runs.
    expect((await client.run('echo', new TextEncoder().encode('hello'))).status).toBe(200);
    expect(runs.count).toBe(started + 1);
  });
});

describe('the children’s code', () => {
  it('refuses to start when the code holds a symlink, before binding its socket, leaving no copy', async () => {
    const source = privateFolder();
    symlinkSync(secret, path.join(source, 'task.ts'));
    const socket = path.join(privateFolder(), 'documents.sock');
    const jobsRoot = privateFolder();
    await expect(
      startDocuments({
        env: env(socket),
        runtime: runtime(['--disable-sigusr1']),
        sink: recording().sink,
        documents: { code: { root: source, files: ['task.ts'] }, jobsRoot },
      }),
    ).rejects.toThrow(`${path.join(source, 'task.ts')} is reached through a symlink, to ${secret}`);
    expect(existsSync(socket)).toBe(false);
    expect(readdirSync(jobsRoot)).toEqual([]);
  });

  it('leaves no copy when a task’s script isn’t in the code, or the socket is taken', async () => {
    const folder = privateFolder();
    const start = (tasks?: Record<string, Task>) =>
      startDocuments({
        env: env(path.join(folder, 'documents.sock')),
        runtime: runtime(['--disable-sigusr1']),
        sink: recording().sink,
        documents: tasks === undefined ? {} : { tasks },
      });
    await expect(
      start({ outside: { script: child('reads'), contentType: 'text/plain' } }),
    ).rejects.toThrow(`The task outside's script, ${child('reads')}, isn't in its children's code`);
    expect(readdirSync(folder)).toEqual([]);
    writeFileSync(path.join(folder, 'documents.sock'), 'not a socket');
    await expect(start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(readdirSync(folder)).toEqual(['documents.sock']);
  });

  it('refuses a folder for its copy and jobs that others can enter, or whose path holds a `*`', async () => {
    const start = (jobsRoot: string) =>
      startDocuments({
        env: env(path.join(privateFolder(), 'documents.sock')),
        runtime: runtime(['--disable-sigusr1']),
        sink: recording().sink,
        documents: { jobsRoot },
      });
    const open = privateFolder();
    chmodSync(open, 0o750);
    await expect(start(open)).rejects.toThrow(
      "The document service's jobs folder must be yours, mode 0700, not 750",
    );
    // Node reads `*` in a read grant as a wildcard: a grant of <folder>/st*r/x reaches
    // <folder>/stuff.
    const starred = path.join(privateFolder(), 'st*r');
    mkdirSync(starred, { mode: 0o700 });
    await expect(start(starred)).rejects.toThrow(/may hold only letters, digits/);
    expect(readdirSync(starred)).toEqual([]);
  });

  it('starts with a copy beside its socket, clears what a killed service left, and removes it on stop', async () => {
    const folder = privateFolder();
    for (const left of ['instante-code-OLD', 'instante-job-OLD']) {
      mkdirSync(path.join(folder, left));
      writeFileSync(path.join(folder, left, 'input'), 'an old document');
    }
    const { sink, lines } = recording();
    const service = await startDocuments({
      env: env(path.join(folder, 'documents.sock')),
      runtime: runtime(['--disable-sigusr1']),
      sink,
    });
    const listening = lines.find((line) => line['event'] === 'documents.listening');
    const copy = String(listening?.['code']);
    try {
      expect(listening).toMatchObject({ codeFiles: CHILD_CODE.files.length, removed: 2 });
      expect(path.dirname(copy)).toBe(folder);
      expect(readdirSync(folder).sort()).toEqual(['documents.sock', path.basename(copy)].sort());
      expect(readdirSync(copy, { recursive: true }).sort()).toEqual(
        ['documents', 'documents/tasks', 'kit', 'package.json', ...CHILD_CODE.files].sort(),
      );
      // Node looks for a package.json above a script without checking its grants; this one
      // stops it in the copy.
      expect(readFileSync(path.join(copy, 'package.json'), 'utf8')).toBe('{ "type": "module" }\n');
      expect(statSync(path.join(copy, 'kit/probes.ts')).mode & 0o777).toBe(0o400);
      expect(readFileSync(path.join(copy, 'kit/probes.ts'), 'utf8')).toBe(
        readFileSync(path.join(CHILD_CODE.root, 'kit/probes.ts'), 'utf8'),
      );
    } finally {
      await service.close();
    }
    expect(readdirSync(folder)).toEqual([]);
  });

  it('is needed: through a symlink, inside a grant or anywhere on a path, a child reads what its grants don’t cover, except in a folder whose name nothing else has', async () => {
    const read = async (file: string, grant: string) => {
      const copy = copyCode(code, privateFolder());
      const done = await runChild({
        script: path.join(copy, 'test/children/reads.ts'),
        args: [file],
        jobFolder: privateFolder(),
        grants: [copy, grant],
      });
      return done.ok ? done.stdout.toString() : done.stderr;
    };
    // A symlink inside a grant is followed wherever it points.
    const linked = privateFolder();
    symlinkSync(secret, path.join(linked, 'link'));
    expect(await read(secret, linked)).toBe('ERR_ACCESS_DENIED');
    expect(await read(path.join(linked, 'link'), linked)).toBe(
      'postgresql://instante_app:hex@/instante',
    );

    // A symlink outside every grant steers the kernel too: Node checks the path after removing
    // `name/..` as text, while the kernel follows `out` to a deeper folder before climbing. With
    // as many `..` as `out` has names, the text is at `/` and the kernel at `<scratch>/m`; the
    // rest of the path then reads, as text, as inside the grant, and the kernel looks for it
    // under `<scratch>/m`.
    const scratch = privateFolder();
    const depth = scratch.split('/').length - 1;
    const deeper = path.join(scratch, 'm', ...Array<string>(depth + 1).fill('z'));
    mkdirSync(deeper, { recursive: true });
    symlinkSync(deeper, path.join(scratch, 'out'));
    const via = (target: string) =>
      `${path.join(scratch, 'out')}${'/..'.repeat(depth + 1)}${target}`;
    const twinOf = (target: string) => path.join(scratch, 'm', target);

    // A grant named like other folders, such as `src`: the kernel reads whichever it reaches.
    const grant = path.join(privateFolder(), 'src');
    mkdirSync(grant);
    writeFileSync(path.join(grant, 'file'), 'the grant');
    mkdirSync(twinOf(grant), { recursive: true });
    writeFileSync(path.join(twinOf(grant), 'file'), 'another src folder');
    expect(path.normalize(via(path.join(grant, 'file')))).toBe(path.join(grant, 'file'));
    expect(await read(via(path.join(grant, 'file')), grant)).toBe('another src folder');

    // A grant whose name nothing else has, like the code's copy and a job's folder: the path
    // either goes through the real folder or doesn't resolve.
    const unique = path.join(privateFolder(), 'instante-code-a1b2c3');
    mkdirSync(unique);
    writeFileSync(path.join(unique, 'file'), 'the grant');
    expect(await read(via(path.join(unique, 'file')), unique)).toBe('ENOENT');
    // Unless someone makes a folder of that name where the kernel lands: the reason the copy's
    // folder is the owner's alone, with a name no one else learns.
    mkdirSync(twinOf(unique), { recursive: true });
    writeFileSync(path.join(twinOf(unique), 'file'), 'a twin');
    expect(await read(via(path.join(unique, 'file')), unique)).toBe('a twin');
  });
});

describe('selftest in a service started as `instante start` will start it', () => {
  it('passes with env -i and its own names, --disable-sigusr1, and the lock file open on descriptor 9', async () => {
    const socket = path.join(privateFolder(), 'documents.sock');
    const lock = path.join(privateFolder(), 'instante.lock');
    const lockFd = openSync(lock, 'a');
    const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
    const service = spawn(process.execPath, ['--disable-sigusr1', main], {
      env: env(socket),
      // The launcher's lock file, inherited by each Instante process, which its children mustn't
      // get. Node can't take the lock itself; the file's descriptor is what a child would hold.
      stdio: ['ignore', 'pipe', 'pipe', ...Array<'ignore'>(6).fill('ignore'), lockFd],
      timeout: 15_000,
    });
    closeSync(lockFd);
    try {
      let out = '';
      service.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
      for (let i = 0; i < 100 && !out.includes('documents.listening'); i++) await sleep(50);
      // The service holds the lock file, so the check below has something to find.
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
