import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BACKEND,
  WEB,
  alive,
  eventually,
  fixture,
  own,
  read,
  servers,
  signal,
  startDev,
  stubsOf,
  under,
  type Stub,
} from './support/dev-harness.ts';

// scripts/dev.sh (`pnpm dev`), through ./support/dev-harness.ts; its 15-second stop of a process
// that ignores TERM is in dev-stop.test.ts, so Vitest runs the two side by side.

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
    // Each group stops on its TERM, not after the 15 seconds' KILL.
    expect(dev.output()).not.toContain("didn't stop in 15 seconds");
    expect(await eventually(() => !alive(web.pid))).toBe(true);
    expect(readdirSync(tmp)).toEqual([]);
  }, 30_000);
});
