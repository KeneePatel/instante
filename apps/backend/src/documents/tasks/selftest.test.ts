import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseTargets, probeAll } from './selftest.ts';

// `selftest`'s child, outside the permission model: its targets, and its probes, which here all
// succeed. Under its flags each is denied (test/selftest.test.ts).

const TARGETS = { port: 4311, databaseSocket: '/home/run/.s.PGSQL.5432', secrets: '/home/secrets' };

describe('parseTargets', () => {
  it('takes a port and two absolute paths', () => {
    expect(parseTargets(JSON.stringify(TARGETS))).toEqual(TARGETS);
    expect(parseTargets(JSON.stringify({ ...TARGETS, port: 1 })).port).toBe(1);
    expect(parseTargets(JSON.stringify({ ...TARGETS, port: 65_535 })).port).toBe(65_535);
  });

  it('refuses anything else', () => {
    for (const value of [
      null,
      [],
      'targets',
      { ...TARGETS, extra: true },
      { ...TARGETS, port: 0 },
      { ...TARGETS, port: 65_536 },
      { ...TARGETS, port: 80.5 },
      { ...TARGETS, port: '4311' },
      { ...TARGETS, databaseSocket: 'run/.s.PGSQL.5432' },
      { ...TARGETS, databaseSocket: 5432 },
      { ...TARGETS, secrets: 'secrets' },
      { port: 4311, databaseSocket: '/run/db' },
    ]) {
      expect(() => parseTargets(JSON.stringify(value)), JSON.stringify(value)).toThrow(
        /^selftest: /,
      );
    }
    expect(() => parseTargets('not json')).toThrow(SyntaxError);
  });
});

describe('probeAll', () => {
  let folder: string;
  let backend: Server;
  let database: Server;
  beforeAll(async () => {
    folder = realpathSync(mkdtempSync(path.join(tmpdir(), 'instante-selftest-')));
    backend = createServer((socket) => socket.end());
    database = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => database.listen(path.join(folder, 'db.sock'), resolve));
  });
  afterAll(() => {
    backend.close();
    database.close();
    rmSync(folder, { recursive: true, force: true });
  });

  it('tries each target, and writes in the folder it’s given', async () => {
    const address = backend.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    expect(
      await probeAll(
        { port, databaseSocket: path.join(folder, 'db.sock'), secrets: folder },
        folder,
      ),
    ).toEqual({
      tcp: 'allowed',
      databaseSocket: 'allowed',
      lookup: 'allowed',
      write: 'allowed',
      spawn: 'allowed',
      readSecrets: 'allowed',
    });
  });
});
