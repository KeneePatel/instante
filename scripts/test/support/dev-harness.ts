import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect } from 'vitest';

// The harness for scripts/dev.sh's tests (`pnpm dev`; dev.test.ts, dev-stop.test.ts, in two
// files so Vitest runs them side by side): dev.sh copied into a tree whose backend entry point and
// next are stubs, run on two free ports under /bin/bash, macOS's bash 3.2, where there is one.

export const SCRIPT = fileURLToPath(new URL('../../dev.sh', import.meta.url));
export const BASH = existsSync('/bin/bash') ? '/bin/bash' : 'bash';
export let WEB = 0;
export let BACKEND = 0;
const made: string[] = [];
const running: ChildProcess[] = [];
export const servers: Server[] = [];

export const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Signals a pid, or a process group as a negative pid; one already gone is fine. */
export function signal(pid: number | undefined, name: NodeJS.Signals) {
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
export function under(root: string): number[] {
  const mark = path.basename(root);
  return execFileSync('ps', ['-A', '-ww', '-o', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.includes(mark))
    .map((line) => Number.parseInt(line.trim(), 10));
}

export async function eventually(check: () => boolean, ms = 5000) {
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
// The second listener stands for a process outside next's group, so it starts, through sh, with
// every descriptor above 2 closed: Linux's spawn passes on those without close-on-exec, among
// them bash's copy of the [web] label's pipe (/dev/fd/63), and the label, in the web group,
// would wait out dev.sh's 15 seconds for it to close.
if (existsSync('../../marker-second-listener')) {
  const closeAbove2 = 'fd=3; while [ "$fd" -lt 256 ]; do eval "exec $fd>&-"; fd=$((fd + 1)); done; exec "$@"';
  const second = spawn('/bin/sh', ['-c', closeAbove2, 'sh', process.execPath, __filename, 'second', String(port)], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  record.second = second.pid;
  second.stdout.once('data', () => { second.stdout.destroy(); second.unref(); serve(); });
} else serve();
`;

export interface Stub {
  pid: number;
  worker?: number;
  second?: number;
  cwd?: string;
  args?: string[];
  execArgv: string[];
  env: Record<string, string>;
}

export function fixture(options: { database?: boolean; node?: string; markers?: string[] } = {}) {
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

export function startDev(
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

export const alive = (pid: number | undefined) => {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
export const read = (root: string, name: string) =>
  JSON.parse(readFileSync(path.join(root, 'stub', `${name}.json`), 'utf8')) as Stub;
/** An environment without the name macOS adds to every process. */
export const own = (env: Record<string, string>) =>
  Object.fromEntries(Object.entries(env).filter(([name]) => name !== '__CF_USER_TEXT_ENCODING'));
export const stubsOf = (root: string) =>
  ['documents', 'all', 'web'].map((name) => read(root, name));
