import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, Socket, type NetConnectOpts, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PROBE_TIMEOUT_MS,
  probeLookup,
  probeRead,
  probeSpawn,
  probeTcp,
  probeUnixSocket,
  probeWrite,
} from './probes.ts';

// The probes outside the permission model, as the backend's positive control runs them: each
// succeeds, or names what stopped it. Under the model they're denied (test/selftest.test.ts).

// A test can stand in for a connection, a lookup or a spawn; the real one runs otherwise.
const fake = vi.hoisted(() => ({
  connect: undefined as (() => unknown) | undefined,
  lookup: undefined as (() => Promise<unknown>) | undefined,
  spawnSync: undefined as (() => unknown) | undefined,
}));
vi.mock('node:net', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:net')>();
  return {
    ...real,
    connect: (options: NetConnectOpts) => (fake.connect ? fake.connect() : real.connect(options)),
  };
});
vi.mock('node:dns/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:dns/promises')>();
  return {
    ...real,
    lookup: (host: string) => (fake.lookup ? fake.lookup() : real.lookup(host)),
  };
});
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawnSync: (...args: Parameters<typeof real.spawnSync>) =>
      fake.spawnSync ? fake.spawnSync() : real.spawnSync(...args),
  };
});
afterEach(() => {
  fake.connect = undefined;
  fake.lookup = undefined;
  fake.spawnSync = undefined;
  vi.useRealTimers();
});
const failure = (code: string) => Object.assign(new Error(code), { code });

let folder: string;
let tcp: Server;
let unix: Server;
let port: number;
const listen = (server: Server, at: number | string) =>
  new Promise<void>((resolve) => {
    if (typeof at === 'number') server.listen(at, '127.0.0.1', resolve);
    else server.listen(at, resolve);
  });

beforeAll(async () => {
  folder = realpathSync(mkdtempSync(path.join(tmpdir(), 'instante-probes-')));
  tcp = createServer((socket) => socket.end());
  unix = createServer((socket) => socket.end());
  await listen(tcp, 0);
  await listen(unix, path.join(folder, 'db.sock'));
  const address = tcp.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
});
afterAll(() => {
  tcp.close();
  unix.close();
  rmSync(folder, { recursive: true, force: true });
});

describe('the probes, where nothing stops them', () => {
  it('connect to a port on 127.0.0.1 and to a Unix socket, and look up localhost', async () => {
    expect(await probeTcp(port)).toBe('allowed');
    expect(await probeUnixSocket(path.join(folder, 'db.sock'))).toBe('allowed');
    expect(await probeLookup()).toBe('allowed');
  });

  it('write a new file, start a process and list a folder', () => {
    expect(probeWrite(path.join(folder, 'new'))).toBe('allowed');
    expect(probeSpawn()).toBe('allowed');
    expect(probeRead(folder)).toBe('allowed');
  });

  it('name what stopped them otherwise', async () => {
    const closed = createServer();
    await listen(closed, 0);
    const address = closed.address();
    closed.close();
    const freed = typeof address === 'object' && address !== null ? address.port : 0;
    expect(await probeTcp(freed)).toBe('failed: ECONNREFUSED');
    expect(await probeUnixSocket(path.join(folder, 'missing.sock'))).toBe('failed: ENOENT');
    writeFileSync(path.join(folder, 'taken'), '');
    expect(probeWrite(path.join(folder, 'taken'))).toBe('failed: EEXIST');
    expect(probeRead(path.join(folder, 'missing'))).toBe('failed: ENOENT');
    expect(await probeTcp(70_000)).toBe('failed: ERR_SOCKET_BAD_PORT');
  });

  it('name a lookup that fails, and a spawn that does', async () => {
    fake.lookup = () => Promise.reject(failure('ENOTFOUND'));
    expect(await probeLookup()).toBe('failed: ENOTFOUND');
    fake.spawnSync = () => ({ error: failure('ETIMEDOUT') });
    expect(probeSpawn()).toBe('failed: ETIMEDOUT');
  });

  it('give up on a connection or a lookup after two seconds, as failed, not denied', async () => {
    expect(PROBE_TIMEOUT_MS).toBe(2_000);
    vi.useFakeTimers();
    // A socket that is never connected, and a lookup that never answers.
    fake.connect = () => new Socket();
    fake.lookup = () => new Promise(() => undefined);
    let settled = 0;
    const answers = Promise.all(
      [probeTcp(port), probeUnixSocket('/nowhere'), probeLookup()].map((answer) =>
        answer.finally(() => (settled += 1)),
      ),
    );
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1);
    expect(settled).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await answers).toEqual(['failed: timeout', 'failed: timeout', 'failed: timeout']);
  });
});
