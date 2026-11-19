import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// scripts/dev.sh (`pnpm dev`), copied into a tree whose backend entry point and next are stubs,
// run on two free ports under /bin/bash, macOS's bash 3.2, where there is one.

const SCRIPT = fileURLToPath(new URL('../dev.sh', import.meta.url));
const BASH = existsSync('/bin/bash') ? '/bin/bash' : 'bash';
let WEB = 0;
let BACKEND = 0;
const made: string[] = [];
const running: ChildProcess[] = [];
const servers: Server[] = [];

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Signals a pid, or a process group as a negative pid; one already gone is fine. */
function signal(pid: number | undefined, name: NodeJS.Signals) {
  // 0 would be this test's own process group.
  if (pid === undefined || pid === 0) return;
  try {
    process.kill(pid, name);
  } catch {
    // Already gone, as it should be.
  }
}

/** The pids of every process whose command line names the fixture: the script, its labels and
 * watchdog, and the next stubs. The backend stubs' entry point is relative, so their pids are
 * checked on their own. */
function under(root: string): number[] {
  const mark = path.basename(root);
  return execFileSync('ps', ['-A', '-ww', '-o', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.includes(mark))
    .map((line) => Number.parseInt(line.trim(), 10));
}

async function eventually(check: () => boolean, ms = 5000) {
  for (let waited = 0; waited < ms && !check(); waited += 100) await sleep(100);
  return check();
}

// Two ports nothing listens on, held together so they differ.
beforeEach(async () => {
  const held = [createServer(), createServer()];
  const ports = await Promise.all(
    held.map(
      (server) =>
        new Promise<number>((resolve) => {
          server.listen(0, '127.0.0.1', () => {
            resolve((server.address() as AddressInfo).port);
          });
        }),
    ),
  );
  await Promise.all(held.map((server) => new Promise((resolve) => server.close(resolve))));
  [WEB, BACKEND] = ports as [number, number];
});

// A test that fails part way must not leave its stubs running: stop the script the way a person
// would (it stops them), then kill the script's group, each stub's group and anything else that
// names the fixture, whatever happened.
afterEach(async () => {
  for (const child of running.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await sleep(2000);
    }
    // A child that didn't get a group of its own is in the script's.
    signal(child.pid === undefined ? undefined : -child.pid, 'SIGKILL');
  }
  for (const server of servers.splice(0)) server.close();
  for (const dir of made.splice(0)) {
    for (const name of ['documents', 'all', 'web']) {
      const file = path.join(dir, 'stub', `${name}.json`);
      if (!existsSync(file)) continue;
      const stub = JSON.parse(readFileSync(file, 'utf8')) as Stub;
      for (const pid of [stub.pid, stub.second]) signal(pid === undefined ? pid : -pid, 'SIGKILL');
    }
    for (const pid of under(dir)) signal(pid, 'SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

// Each stub records its pid, its environment and its Node flags, then listens. A marker file in
// the fixture's root changes one: the document service exits at once, the backend ignores TERM,
// or next starts a second listener on its port, in a process group of its own.
const BACKEND_STUB = `
import http from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const role = process.env.ROLE;
if (role === 'documents' && existsSync('marker-documents-exits')) process.exit(3);
mkdirSync('stub', { recursive: true });
writeFileSync('stub/' + role + '.json', JSON.stringify({ pid: process.pid, env: process.env, execArgv: process.execArgv }));
const server = http.createServer((req, res) => { res.statusCode = req.url === '/readyz' ? 200 : 404; res.end(); });
if (role === 'documents') server.listen(process.env.DOCUMENTS_SOCKET);
else server.listen(Number(process.env.PORT), '127.0.0.1');
if (role === 'all' && existsSync('marker-backend-ignores-term')) process.on('SIGTERM', () => {});
else process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;
const NEXT_STUB = `
const http = require('node:http');
const { fork, spawn } = require('node:child_process');
const { existsSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'worker') { setInterval(() => {}, 1000); return; }
if (args[0] === 'second') {
  http.createServer((req, res) => res.end()).listen(Number(args[1]), '::1', () => process.stdout.write('ready\\n'));
  return;
}
const port = Number(args[args.indexOf('-p') + 1]);
const host = args[args.indexOf('-H') + 1];
const worker = fork(__filename, ['worker'], { stdio: 'ignore' });
const record = { pid: process.pid, worker: worker.pid, cwd: process.cwd(), args, execArgv: process.execArgv, env: process.env };
function serve() {
  writeFileSync('../../stub/web.json', JSON.stringify(record));
  // As proxy.ts does: 421 unless the Host is the one allowed.
  const server = http.createServer((req, res) => {
    res.statusCode = req.headers.host === process.env.ALLOWED_HOST ? 200 : 421;
    res.end();
  }).listen(port, host);
  // It leaves its worker to the group's TERM, as next dev's own children are reached.
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
if (existsSync('../../marker-second-listener')) {
  const second = spawn(process.execPath, [__filename, 'second', String(port)], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  record.second = second.pid;
  second.stdout.once('data', () => { second.stdout.destroy(); second.unref(); serve(); });
} else serve();
`;

interface Stub {
  pid: number;
  worker?: number;
  second?: number;
  cwd?: string;
  args?: string[];
  execArgv: string[];
  env: Record<string, string>;
}

function fixture(options: { database?: boolean; node?: string; markers?: string[] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'dt'));
  made.push(root);
  const tmp = path.join(root, 't');
  mkdirSync(tmp);
  mkdirSync(path.join(root, 'scripts'));
  copyFileSync(SCRIPT, path.join(root, 'scripts/dev.sh'));
  chmodSync(path.join(root, 'scripts/dev.sh'), 0o755);
  writeFileSync(
    path.join(root, 'mise.toml'),
    `[tools]\nnode = "${options.node ?? process.version.slice(1)}"\n`,
  );
  mkdirSync(path.join(root, 'apps/backend/src'), { recursive: true });
  writeFileSync(path.join(root, 'apps/backend/src/main.ts'), BACKEND_STUB);
  const bin = path.join(root, 'apps/web/node_modules/next/dist/bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'next'), NEXT_STUB);
  if (options.database ?? true) {
    mkdirSync(path.join(root, '.dev/secrets'), { recursive: true });
    writeFileSync(path.join(root, '.dev/secrets/app-dev.url'), 'postgresql://stub\n');
  }
  for (const marker of options.markers ?? []) writeFileSync(path.join(root, marker), '');
  return { root, tmp };
}

function startDev(
  root: string,
  tmp: string,
  args: string[] = [],
  env: Record<string, string> = {},
) {
  const child = spawn(BASH, [path.join(root, 'scripts/dev.sh'), ...args], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // The Node running this test, which the fixture's mise.toml pins.
      PATH: `${path.dirname(process.execPath)}:${process.env['PATH'] ?? ''}`,
      TMPDIR: tmp,
      DEV_WEB_PORT: String(WEB),
      DEV_BACKEND_PORT: String(BACKEND),
      ...env,
    },
  });
  running.push(child);
  let output = '';
  child.stdout.on('data', (d: Buffer) => {
    output += d.toString();
  });
  child.stderr.on('data', (d: Buffer) => {
    output += d.toString();
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => {
      resolve(code);
    });
  });
  const until = async (text: string) => {
    await eventually(() => output.includes(text), 15_000);
    expect(output).toContain(text);
  };
  return { child, exited, until, output: () => output };
}

const alive = (pid: number | undefined) => {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const read = (root: string, name: string) =>
  JSON.parse(readFileSync(path.join(root, 'stub', `${name}.json`), 'utf8')) as Stub;
/** An environment without the name macOS adds to every process. */
const own = (env: Record<string, string>) =>
  Object.fromEntries(Object.entries(env).filter(([name]) => name !== '__CF_USER_TEXT_ENCODING'));
const stubsOf = (root: string) => ['documents', 'all', 'web'].map((name) => read(root, name));

describe('scripts/dev.sh', () => {
  it('starts the three in a 0700 folder, each with only its own names and values, then stops them all on SIGINT', async () => {
    const { root, tmp } = fixture();
    const dev = startDev(root, tmp);
    await dev.until(`dev: open http://localhost:${String(WEB)}`);
    const [folder = ''] = readdirSync(tmp);
    expect(folder).toMatch(/^instante-dev\./);
    const run = path.join(tmp, folder);
    expect(statSync(run).mode & 0o777).toBe(0o700);
    expect(readFileSync(path.join(run, 'dev.pid'), 'utf8')).toBe(`${String(dev.child.pid)}\n`);
    const socket = path.join(run, 'documents.sock');
    const [documents, backend, web] = stubsOf(root) as [Stub, Stub, Stub];
    expect(own(documents.env)).toEqual({
      DOCUMENTS_SOCKET: socket,
      INSTANTE_ENV: 'development',
      ROLE: 'documents',
    });
    expect(own(backend.env)).toEqual({
      ALLOWED_HOST: `localhost:${String(WEB)}`,
      DATABASE_URL_FILE: path.join(realpathSync(root), '.dev/secrets/app-dev.url'),
      DOCUMENTS_SOCKET: socket,
      INSTANTE_ENV: 'development',
      LISTEN_ADDRESS: '127.0.0.1',
      PORT: String(BACKEND),
      ROLE: 'all',
    });
    expect(own(web.env)).toEqual({
      ALLOWED_HOST: `localhost:${String(WEB)}`,
      BACKEND_INTERNAL_URL: `http://127.0.0.1:${String(BACKEND)}`,
      NEXT_TELEMETRY_DISABLED: '1',
      PATH: `${path.dirname(realpathSync(process.execPath))}:/usr/bin:/bin`,
      TMPDIR: tmp,
    });
    expect(documents.execArgv).toEqual(['--disable-sigusr1']);
    expect(backend.execArgv).toEqual(['--disable-sigusr1']);
    // The web port as the debugger's: next dev's server holds it, so no debugger can open.
    expect(web.execArgv).toEqual(['--disable-sigusr1', `--inspect-port=${String(WEB)}`]);
    expect(web.args).toEqual(['dev', '-H', '127.0.0.1', '-p', String(WEB)]);
    expect(web.cwd).toMatch(/apps\/web$/);
    dev.child.kill('SIGINT');
    expect(await dev.exited).toBe(130);
    // One TERM to each process group stops them all: the KILL that follows a slow stop isn't
    // what did it.
    expect(dev.output()).not.toContain("didn't stop");
    for (const pid of [documents.pid, backend.pid, web.pid, web.worker]) {
      expect(alive(pid), String(pid)).toBe(false);
    }
    expect(readdirSync(tmp)).toEqual([]);
    // The labels and the watchdog end too.
    expect(await eventually(() => under(root).length === 0)).toBe(true);
  }, 30_000);

  it.each([
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ] as const)(
    'stops them all on %s and exits %i',
    async (name, code) => {
      const { root, tmp } = fixture();
      const dev = startDev(root, tmp);
      await dev.until('dev: open');
      const stubs = stubsOf(root);
      dev.child.kill(name);
      expect(await dev.exited).toBe(code);
      for (const stub of stubs) expect(alive(stub.pid), String(stub.pid)).toBe(false);
      expect(readdirSync(tmp)).toEqual([]);
    },
    30_000,
  );

  it('stops the others and exits 1 when one of them dies', async () => {
    const { root, tmp } = fixture();
    const dev = startDev(root, tmp);
    await dev.until('dev: open');
    const [, backend, web] = stubsOf(root) as [Stub, Stub, Stub];
    process.kill(backend.pid, 'SIGKILL');
    expect(await dev.exited).toBe(1);
    expect(dev.output()).toContain('dev: backend stopped (exit status 137)');
    expect(alive(web.pid)).toBe(false);
    expect(alive(web.worker)).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
  }, 30_000);

  it('exits 1, naming it, when one ends before it is ready', async () => {
    const { root, tmp } = fixture({ markers: ['marker-documents-exits'] });
    const dev = startDev(root, tmp);
    expect(await dev.exited).toBe(1);
    expect(dev.output()).toContain('dev: documents stopped (exit status 3)');
    expect(existsSync(path.join(root, 'stub'))).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
  }, 30_000);

  it("stops the three and removes the folder when the script's process group is killed outright", async () => {
    const { root, tmp } = fixture();
    const dev = startDev(root, tmp);
    await dev.until('dev: open');
    const [documents, backend, web] = stubsOf(root) as [Stub, Stub, Stub];
    // As pnpm's own KILL does: the script, its labels and any check under way.
    signal(dev.child.pid === undefined ? undefined : -dev.child.pid, 'SIGKILL');
    expect(await dev.exited).toBe(null);
    expect(await eventually(() => readdirSync(tmp).length === 0)).toBe(true);
    for (const pid of [documents.pid, backend.pid, web.pid, web.worker]) {
      expect(await eventually(() => !alive(pid)), String(pid)).toBe(true);
    }
    expect(await eventually(() => under(root).length === 0)).toBe(true);
    expect(dev.output()).toContain('dev: the script was killed before it stopped the others');
  }, 30_000);

  it('kills a process that ignores TERM after 15 seconds, saying which', async () => {
    const { root, tmp } = fixture({ markers: ['marker-backend-ignores-term'] });
    const dev = startDev(root, tmp);
    await dev.until('dev: open');
    const backend = read(root, 'all');
    dev.child.kill('SIGINT');
    expect(await dev.exited).toBe(130);
    expect(dev.output()).toContain("dev: backend didn't stop in 15 seconds; killing it");
    expect(await eventually(() => !alive(backend.pid))).toBe(true);
    expect(readdirSync(tmp)).toEqual([]);
  }, 40_000);

  it('removes the folders killed runs left, and keeps those of runs still going', async () => {
    const { root, tmp } = fixture();
    const folder = (name: string, owner?: string) => {
      const dir = path.join(tmp, `instante-dev.${name}`);
      mkdirSync(path.join(dir, 'instante-job-x'), { recursive: true, mode: 0o700 });
      if (owner !== undefined) writeFileSync(path.join(dir, 'dev.pid'), `${owner}\n`);
      return dir;
    };
    // No dev.pid and an hour old: a run killed before it wrote one, or before there was one.
    const old = folder('old');
    const anHourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(old, anHourAgo, anHourAgo);
    const ended = folder('ended', '999999999');
    // No dev.pid yet and new: a run that is starting.
    const starting = folder('starting');
    const going = folder('going', String(process.pid));
    // Its script has ended, but something still answers on its socket.
    const answering = folder('answering', '999999999');
    const service = createServer((_req, res) => res.end()).listen(
      path.join(answering, 'documents.sock'),
    );
    servers.push(service);
    await new Promise((resolve) => service.once('listening', resolve));
    const dev = startDev(root, tmp);
    await dev.until('dev: open');
    expect([old, ended].filter((dir) => existsSync(dir))).toEqual([]);
    expect([starting, going, answering].filter((dir) => existsSync(dir))).toEqual([
      starting,
      going,
      answering,
    ]);
    dev.child.kill('SIGTERM');
    expect(await dev.exited).toBe(143);
  }, 30_000);

  it('refuses, starting nothing, without the development database, with another Node, or with a bad argument or port', async () => {
    const cases: [ReturnType<typeof fixture>, string[], Record<string, string>, string][] = [
      [fixture({ database: false }), [], {}, 'run scripts/dev-db.sh first'],
      [fixture({ node: '1.2.3' }), [], {}, 'but mise.toml pins node 1.2.3'],
      [fixture(), ['--fast'], {}, 'dev: unknown argument --fast'],
      ...['4310', '4311', '4320', '4321'].map(
        (port): [ReturnType<typeof fixture>, string[], Record<string, string>, string] => [
          fixture(),
          [],
          { DEV_WEB_PORT: port },
          `port ${port} belongs to real use`,
        ],
      ),
      ...['0', '65536', '80a', '99999999999999999999'].map(
        (port): [ReturnType<typeof fixture>, string[], Record<string, string>, string] => [
          fixture(),
          [],
          { DEV_BACKEND_PORT: port },
          `a port must be a number from 1 to 65535, not '${port}'`,
        ],
      ),
    ];
    for (const [{ root, tmp }, args, env, said] of cases) {
      const dev = startDev(root, tmp, args, env);
      expect(await dev.exited, said).toBe(2);
      expect(dev.output()).toContain(said);
      expect(existsSync(path.join(root, 'stub'))).toBe(false);
      expect(readdirSync(tmp)).toEqual([]);
    }
  }, 30_000);

  it.each(['web', 'backend'] as const)(
    'refuses when something else listens on the %s port, naming it',
    async (which) => {
      const { root, tmp } = fixture();
      const port = which === 'web' ? WEB : BACKEND;
      const squatter = createServer().listen(port, '::1');
      servers.push(squatter);
      await new Promise((resolve) => squatter.once('listening', resolve));
      const dev = startDev(root, tmp);
      expect(await dev.exited).toBe(2);
      expect(dev.output()).toContain(`dev: port ${String(port)} is in use: node`);
      expect(existsSync(path.join(root, 'stub'))).toBe(false);
    },
    30_000,
  );

  it('stops everything when another process listens on the web port too', async () => {
    const { root, tmp } = fixture({ markers: ['marker-second-listener'] });
    const dev = startDev(root, tmp);
    expect(await dev.exited).toBe(1);
    const web = read(root, 'web');
    // The second listener is in a group of its own, so it's the test's to stop.
    signal(web.second === undefined ? undefined : -web.second, 'SIGKILL');
    expect(dev.output()).toMatch(
      new RegExp(
        `dev: another process listens on port ${String(WEB)} too: .* second ${String(WEB)}`,
      ),
    );
    expect(dev.output()).not.toContain('dev: open');
    expect(await eventually(() => !alive(web.pid))).toBe(true);
    expect(readdirSync(tmp)).toEqual([]);
  }, 30_000);
});
