import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

  it('give up on a connection after two seconds', () => {
    expect(PROBE_TIMEOUT_MS).toBe(2_000);
  });
});
