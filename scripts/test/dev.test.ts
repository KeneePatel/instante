import { spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// scripts/dev.sh (`pnpm dev`), copied into a tree whose backend entry point and next are stubs,
// run on ports 4596 and 4597 under /bin/bash, macOS's bash 3.2, where there is one.

const SCRIPT = fileURLToPath(new URL('../dev.sh', import.meta.url));
const BASH = existsSync('/bin/bash') ? '/bin/bash' : 'bash';
const WEB = 4596;
const BACKEND = 4597;
const made: string[] = [];
const running: ChildProcess[] = [];
const servers: Server[] = [];

// A test that fails part way must not leave its stubs running: stop the script the way a person
// would (it stops them), then kill every stub's process group whatever happened.
afterEach(async () => {
  for (const child of running.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  for (const server of servers.splice(0)) server.close();
  for (const dir of made.splice(0)) {
    for (const name of ['documents', 'all', 'web']) {
      const file = path.join(dir, 'stub', `${name}.json`);
      if (!existsSync(file)) continue;
      const pid = (JSON.parse(readFileSync(file, 'utf8')) as { pid: number }).pid;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Already gone, as it should be.
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

// Each stub records its pid, its working folder and its environment's names, then listens.
const BACKEND_STUB = `
import http from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
const role = process.env.ROLE;
mkdirSync('stub', { recursive: true });
writeFileSync('stub/' + role + '.json', JSON.stringify({ pid: process.pid, names: Object.keys(process.env).sort() }));
const server = http.createServer((req, res) => { res.statusCode = req.url === '/readyz' ? 200 : 404; res.end(); });
if (role === 'documents') server.listen(process.env.DOCUMENTS_SOCKET);
else server.listen(Number(process.env.PORT), '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;
const NEXT_STUB = `
const http = require('node:http');
const { fork } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'worker') { setInterval(() => {}, 1000); return; }
const port = Number(args[args.indexOf('-p') + 1]);
const host = args[args.indexOf('-H') + 1];
const worker = fork(__filename, ['worker'], { stdio: 'ignore' });
writeFileSync('../../stub/web.json', JSON.stringify({ pid: process.pid, worker: worker.pid, cwd: process.cwd(), args,
  names: Object.keys(process.env).sort(), allowedHost: process.env.ALLOWED_HOST, backend: process.env.BACKEND_INTERNAL_URL }));
const server = http.createServer((req, res) => res.end()).listen(port, host);
// It leaves its worker to the group's TERM, as next dev's own children are reached.
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

function fixture(options: { database?: boolean; node?: string } = {}) {
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
    for (let i = 0; i < 150 && !output.includes(text); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(output).toContain(text);
  };
  return { child, exited, until, output: () => output };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const read = (root: string, name: string) =>
  JSON.parse(readFileSync(path.join(root, 'stub', `${name}.json`), 'utf8')) as Record<
    string,
    unknown
  >;
const others = (names: unknown) =>
  (names as string[]).filter((name) => name !== '__CF_USER_TEXT_ENCODING');

describe('scripts/dev.sh', () => {
  it('starts the three in a 0700 folder, each with only its own names, then stops them all on SIGINT', async () => {
    const { root, tmp } = fixture();
    const dev = startDev(root, tmp);
    await dev.until(`dev: open http://localhost:${String(WEB)}`);
    const [folder] = readdirSync(tmp);
    expect(folder).toMatch(/^instante-dev\./);
    expect(statSync(path.join(tmp, folder ?? '')).mode & 0o777).toBe(0o700);
    const documents = read(root, 'documents');
    const backend = read(root, 'all');
    const web = read(root, 'web');
    expect(others(documents['names'])).toEqual(['DOCUMENTS_SOCKET', 'INSTANTE_ENV', 'ROLE']);
    expect(others(backend['names'])).toEqual([
      'ALLOWED_HOST',
      'DATABASE_URL_FILE',
      'DOCUMENTS_SOCKET',
      'INSTANTE_ENV',
      'LISTEN_ADDRESS',
      'PORT',
      'ROLE',
    ]);
    expect(others(web['names'])).toEqual([
      'ALLOWED_HOST',
      'BACKEND_INTERNAL_URL',
      'NEXT_TELEMETRY_DISABLED',
      'PATH',
      'TMPDIR',
    ]);
    expect(web).toMatchObject({
      allowedHost: `localhost:${String(WEB)}`,
      backend: `http://127.0.0.1:${String(BACKEND)}`,
      args: ['dev', '-H', '127.0.0.1', '-p', String(WEB)],
    });
    expect(String(web['cwd'])).toMatch(/apps\/web$/);
    dev.child.kill('SIGINT');
    expect(await dev.exited).toBe(130);
    // One TERM to each process group stops them all: the KILL that follows a slow stop isn't
    // what did it.
    expect(dev.output()).not.toContain("didn't stop");
    for (const pid of [documents['pid'], backend['pid'], web['pid'], web['worker']]) {
      expect(alive(pid as number), String(pid)).toBe(false);
    }
    expect(readdirSync(tmp)).toEqual([]);
  }, 30_000);

  it('stops the others and exits 1 when one of them dies', async () => {
    const { root, tmp } = fixture();
    const dev = startDev(root, tmp);
    await dev.until('dev: open');
    const backend = read(root, 'all');
    const web = read(root, 'web');
    process.kill(backend['pid'] as number, 'SIGKILL');
    expect(await dev.exited).toBe(1);
    expect(dev.output()).toContain('dev: backend stopped (exit status 137)');
    expect(alive(web['pid'] as number)).toBe(false);
    expect(alive(web['worker'] as number)).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
  }, 30_000);

  it('removes what a killed run left, a folder whose socket nothing answers', async () => {
    const { root, tmp } = fixture();
    const left = path.join(tmp, 'instante-dev.killed');
    mkdirSync(path.join(left, 'instante-job-x'), { recursive: true, mode: 0o700 });
    const dev = startDev(root, tmp);
    await dev.until('dev: open');
    expect(existsSync(left)).toBe(false);
    dev.child.kill('SIGTERM');
    expect(await dev.exited).toBe(143);
  }, 30_000);

  it('refuses, starting nothing, without the development database, with another Node, or with a bad argument or port', async () => {
    const cases: [ReturnType<typeof fixture>, string[], Record<string, string>, string][] = [
      [fixture({ database: false }), [], {}, 'run scripts/dev-db.sh first'],
      [fixture({ node: '1.2.3' }), [], {}, 'but mise.toml pins node 1.2.3'],
      [fixture(), ['--fast'], {}, 'dev: unknown argument --fast'],
      [fixture(), [], { DEV_WEB_PORT: '4310' }, 'port 4310 belongs to real use'],
      [
        fixture(),
        [],
        { DEV_BACKEND_PORT: '80a' },
        "a port must be a number from 1 to 65535, not '80a'",
      ],
    ];
    for (const [{ root, tmp }, args, env, said] of cases) {
      const dev = startDev(root, tmp, args, env);
      expect(await dev.exited, said).toBe(2);
      expect(dev.output()).toContain(said);
      expect(existsSync(path.join(root, 'stub'))).toBe(false);
      expect(readdirSync(tmp)).toEqual([]);
    }
  }, 30_000);

  it('refuses a port something else listens on, naming it', async () => {
    const { root, tmp } = fixture();
    const squatter = createServer().listen(WEB, '::1');
    servers.push(squatter);
    await new Promise((resolve) => squatter.once('listening', resolve));
    const dev = startDev(root, tmp);
    expect(await dev.exited).toBe(2);
    expect(dev.output()).toContain(`dev: port ${String(WEB)} is in use: node`);
    expect(existsSync(path.join(root, 'stub'))).toBe(false);
  }, 30_000);
});
