import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect, createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { beforeAll } from 'vitest';
import { PINNED_NODE } from '../src/kit/config.ts';
import { manualClock } from '../src/kit/clock.ts';
import type { Sink } from '../src/kit/logger.ts';
import { start, type Running } from '../src/start.ts';
import { dropTestDatabases, testDatabase, urlFor } from './db-harness.ts';

// The backend started for real, on loopback: requests over a socket carry their own Host
// header, unlike app.request.

const folder = mkdtempSync(path.join(tmpdir(), 'instante-start-'));
const secret = path.join(folder, 'app-url');
// The backend now starts its pool and pg-boss, so it gets a real database: a harness copy.
let appUrl = '';
beforeAll(async () => {
  appUrl = urlFor(await testDatabase(), 'app');
  writeFileSync(secret, `${appUrl}\n`, { mode: 0o600 });
});
afterAll(async () => {
  rmSync(folder, { recursive: true, force: true });
  await dropTestDatabases();
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}

function envFor(port: number): Record<string, string> {
  return {
    INSTANTE_ENV: 'test',
    ROLE: 'all',
    LISTEN_ADDRESS: '127.0.0.1',
    PORT: String(port),
    ALLOWED_HOST: 'localhost:4320',
    DATABASE_URL_FILE: secret,
    DOCUMENTS_SOCKET: path.join(folder, 'documents.sock'),
  };
}

/** A raw HTTP request, so the Host header is exactly what the test says. */
function get(port: number, target: string, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>(
    (resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: target, headers, setHost: false },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => (body += chunk.toString()));
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
          });
        },
      );
      req.on('error', reject);
      req.end();
    },
  );
}

describe('start', () => {
  it('serves on loopback, answering only to its own Host', async () => {
    const port = await freePort();
    const lines: unknown[] = [];
    const sink: Sink = {
      out: (l) => lines.push(JSON.parse(l)),
      err: (l) => lines.push(JSON.parse(l)),
    };
    const running: Running = await start({
      env: envFor(port),
      runtime: {
        nodeVersion: PINNED_NODE,
        execArgv: [],
        homeDir: '/Users/nobody',
        readFile: (f) => (f === secret ? appUrl : ''),
      },
      clock: manualClock('2026-11-13T16:00:00Z'),
      sink,
    });
    try {
      expect(running.port).toBe(port);
      const own = { host: `127.0.0.1:${String(port)}` };
      const ping = await get(port, '/api/ping', own);
      expect(ping.status).toBe(200);
      expect(JSON.parse(ping.body)).toEqual({ ok: true, at: '2026-11-13T16:00:00.000Z' });
      expect(ping.headers['cache-control']).toBe('private, no-store');

      expect((await get(port, '/api/ping', { host: 'evil.test' })).status).toBe(421);
      expect((await get(port, '/api/ping', { host: `localhost:${String(port)}` })).status).toBe(
        421,
      );
      expect((await get(port, `http://evil.test/api/ping`, own)).status).toBe(200);
      expect((await get(port, `http://${own.host}/api/ping`, { host: 'evil.test' })).status).toBe(
        421,
      );
      expect((await get(port, '/api/test/user-only', own)).status).toBe(401);
      expect(lines).toContainEqual(
        expect.objectContaining({
          event: 'start.listening',
          address: '127.0.0.1',
          port,
          env: 'test',
        }),
      );
    } finally {
      await running.close();
    }
    await expect(get(port, '/healthz', { host: `127.0.0.1:${String(port)}` })).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });

  const runtime = {
    nodeVersion: PINNED_NODE,
    execArgv: [],
    homeDir: '/Users/nobody',
    readFile: () => appUrl,
  };
  const quiet: Sink = { out: () => {}, err: () => {} };
  const acceptGood = (authorization: string | undefined) =>
    Promise.resolve(authorization === 'Bearer good' ? { userId: 'u1' } : null);

  async function running(
    env: Record<string, string> = {},
    options: { sink?: Sink } = {},
  ): Promise<Running & { own: Record<string, string> }> {
    const port = await freePort();
    const started = await start({
      env: { ...envFor(port), ...env },
      runtime,
      sink: options.sink ?? quiet,
      authenticate: acceptGood,
    });
    return { ...started, own: { host: `127.0.0.1:${String(port)}`, authorization: 'Bearer good' } };
  }

  it.each([
    ['test', 200],
    ['development', 404],
  ] as const)(
    'with INSTANTE_ENV=%s, answers the test routes with %i',
    async (instanteEnv, status) => {
      const server = await running({ INSTANTE_ENV: instanteEnv });
      try {
        expect((await get(server.port, '/api/test/file.pdf', server.own)).status).toBe(status);
        expect((await get(server.port, '/api/ping', server.own)).status).toBe(200);
      } finally {
        await server.close();
      }
    },
  );

  it('takes a request forwarded from ALLOWED_HOST, and no other', async () => {
    const server = await running();
    try {
      const from = (host: string) =>
        get(server.port, '/api/ping', { ...server.own, 'x-forwarded-host': host });
      expect((await from('localhost:4320')).status).toBe(200);
      expect((await from('localhost:3000')).status).toBe(421);
    } finally {
      await server.close();
    }
  });

  it('really waits in slow, sending nothing first', async () => {
    const server = await running();
    try {
      const began = Date.now();
      const response = await get(server.port, '/api/test/slow?seconds=1', server.own);
      expect(response.status).toBe(200);
      expect(Date.now() - began).toBeGreaterThanOrEqual(950);
    } finally {
      await server.close();
    }
  });

  it('refuses a port already in use', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address() as AddressInfo;
    try {
      await expect(start({ env: envFor(port), runtime, sink: quiet })).rejects.toThrow(
        /EADDRINUSE/,
      );
    } finally {
      blocker.close();
    }
  });

  it('logs an upload its client abandons as aborted, not as a failure', async () => {
    const lines: Record<string, unknown>[] = [];
    const sink: Sink = {
      out: (l) => lines.push(JSON.parse(l) as Record<string, unknown>),
      err: (l) => lines.push(JSON.parse(l) as Record<string, unknown>),
    };
    const server = await running({}, { sink });
    try {
      const socket = connect(server.port, '127.0.0.1');
      await new Promise<void>((resolve) => socket.once('connect', resolve));
      socket.write(
        `POST /api/test/echo HTTP/1.1\r\nHost: ${server.own['host'] ?? ''}\r\nContent-Length: 1000\r\n\r\n0123456789`,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      socket.destroy();
      for (let i = 0; i < 40 && !lines.some((l) => l['event'] === 'request'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(lines).toContainEqual(
        expect.objectContaining({ level: 'info', event: 'request.aborted' }),
      );
      expect(lines.some((l) => l['event'] === 'request.failed')).toBe(false);
      expect(lines).toContainEqual(expect.objectContaining({ event: 'request', status: 422 }));
    } finally {
      await server.close();
    }
  });

  it('stops within its grace period, even with a half-sent request open', async () => {
    const server = await running();
    const socket = connect(server.port, '127.0.0.1');
    socket.on('error', () => {});
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write(`GET /api/ping HTTP/1.1\r\nHost: ${server.own['host'] ?? ''}\r\n`);
    const began = Date.now();
    await server.close(300);
    expect(Date.now() - began).toBeLessThan(2000);
    socket.destroy();
  });

  it('cuts a request still running when the grace period ends', async () => {
    const server = await running();
    const reply = get(server.port, '/api/test/slow?seconds=5', server.own).catch(
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const began = Date.now();
    await server.close(300);
    expect(Date.now() - began).toBeLessThan(2000);
    expect(await reply).toBeInstanceOf(Error);
  });

  it('tells a request that finishes arriving after the stop began to close its connection', async () => {
    const server = await running();
    const socket = connect(server.port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    let head = '';
    socket.on('data', (chunk: Buffer) => {
      head += chunk.toString();
    });
    const ended = new Promise<void>((resolve) => {
      socket.once('close', () => {
        resolve();
      });
    });
    socket.write(`GET /api/ping HTTP/1.1\r\nHost: ${server.own['host'] ?? ''}\r\n`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const closed = server.close(5000);
    socket.write('\r\n');
    await ended;
    await closed;
    expect(head).toMatch(/^HTTP\/1\.1 200/);
    expect(head).toMatch(/\r\nconnection: close\r\n/i);
  });

  it('tells a request still in flight to close its connection once stopping', async () => {
    const server = await running();
    const reply = get(server.port, '/api/test/slow?seconds=1', server.own);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const closed = server.close();
    const response = await reply;
    expect(response.status).toBe(200);
    expect(response.headers['connection']).toBe('close');
    await closed;
  });

  it('refuses a role this release has nothing to run for', async () => {
    const env = { INSTANTE_ENV: 'test', ROLE: 'documents', DOCUMENTS_SOCKET: '/tmp/d.sock' };
    await expect(start({ env })).rejects.toThrow(/ROLE=documents has nothing to run/);
  });
});

describe('main.ts', () => {
  const main = path.resolve(import.meta.dirname, '../src/main.ts');

  function run(env: Record<string, string>) {
    const child = spawn(process.execPath, ['--disable-sigusr1', main], {
      env: { PATH: process.env['PATH'] ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    const exited = new Promise<number | null>((resolve) =>
      child.on('exit', (code) => {
        resolve(code);
      }),
    );
    return { child, exited, output: () => ({ out, err }) };
  }

  it('starts, answers, and stops on SIGTERM', async () => {
    const port = await freePort();
    const { child, exited, output } = run(envFor(port));
    for (let i = 0; i < 100 && !output().out.includes('start.listening'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(output().out).toMatch(/"event":"start.listening"/);
    const ping = await get(port, '/api/ping', { host: `127.0.0.1:${String(port)}` });
    expect(ping.status).toBe(200);
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
  }, 15_000);

  it('stops on SIGINT too', async () => {
    const port = await freePort();
    const { child, exited, output } = run(envFor(port));
    for (let i = 0; i < 100 && !output().out.includes('start.listening'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    child.kill('SIGINT');
    expect(await exited).toBe(0);
  }, 15_000);

  it('exits 1 when it cannot start for another reason, logging why', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address() as AddressInfo;
    try {
      const { exited, output } = run(envFor(port));
      expect(await exited).toBe(1);
      expect(output().err).toMatch(/"event":"start.failed"/);
      expect(output().err).toMatch(/EADDRINUSE/);
    } finally {
      blocker.close();
    }
  }, 15_000);

  it('refuses a bad configuration with exit code 78, naming the problem and no secret', async () => {
    const leaky = path.join(folder, 'leaky-url');
    writeFileSync(leaky, 'postgresql://instante_app:s3cret-pw@db.example.com/x\n', { mode: 0o600 });
    const { exited, output } = run({
      ...envFor(4999),
      INSTANTE_ENV: 'production',
      INSTANTE_HOME: folder,
      DATABASE_URL_FILE: leaky,
    });
    expect(await exited).toBe(78);
    expect(output().err).toMatch(/Instante won't start/);
    expect(output().err).toMatch(/DATABASE_URL_FILE/);
    expect(output().err).not.toMatch(/s3cret-pw/);
  }, 15_000);
});
