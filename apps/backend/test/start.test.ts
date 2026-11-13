import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PINNED_NODE } from '../src/kit/config.ts';
import { manualClock } from '../src/kit/clock.ts';
import type { Sink } from '../src/kit/logger.ts';
import { start, type Running } from '../src/start.ts';

// The backend started for real, on loopback: requests over a socket carry their own Host
// header, unlike app.request.

const folder = mkdtempSync(path.join(tmpdir(), 'instante-start-'));
const secret = path.join(folder, 'app-url');
writeFileSync(secret, 'postgresql://instante_app@localhost:5432/instante_test\n', { mode: 0o600 });
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
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
        readFile: (f) => (f === secret ? 'postgresql://x@localhost/y' : ''),
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
