import { afterEach, describe, expect, it, vi } from 'vitest';
import { register } from '../instrumentation.ts';
import { backendMismatch, backendUrlProblem } from './backend.ts';

// The backend's address (docs/specs/platform.md, "next.config.ts" and "instrumentation.ts"):
// what the build takes, and the start-up check. On the built server, a start with another
// address exits 1 with the message below (checked by hand in T15; T19 starts it for real).

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('backendUrlProblem', () => {
  it('takes http on 127.0.0.1 with a port, or nothing at all', () => {
    for (const url of [
      'http://127.0.0.1:8080',
      'http://127.0.0.1:4311',
      'http://127.0.0.1:1',
      '',
    ]) {
      expect(backendUrlProblem(url), url).toBeUndefined();
    }
    expect(backendUrlProblem(undefined)).toBeUndefined();
  });

  it('refuses anything that could send /api, and its tokens, anywhere else', () => {
    for (const url of [
      'http://localhost:8080',
      'https://127.0.0.1:8080',
      'http://127.0.0.1',
      'http://127.0.0.1:0',
      'http://127.0.0.1:65536',
      'http://127.0.0.1:8080/',
      'http://127.0.0.1:8080/api',
      'http://127.0.0.10:8080',
      'http://evil.example:8080',
    ]) {
      expect(backendUrlProblem(url), url).toBe(
        `BACKEND_INTERNAL_URL must be http://127.0.0.1:<port>, not ${url}`,
      );
    }
  });
});

describe('backendMismatch', () => {
  it('passes the address the build has, and no address when it has none', () => {
    expect(backendMismatch('http://127.0.0.1:8080', 'http://127.0.0.1:8080')).toBeUndefined();
    expect(backendMismatch('', undefined)).toBeUndefined();
    expect(backendMismatch('', '')).toBeUndefined();
  });

  it('names both addresses when they differ', () => {
    expect(backendMismatch('http://127.0.0.1:8080', 'http://127.0.0.1:9999')).toBe(
      'This build sends /api to http://127.0.0.1:8080, but BACKEND_INTERNAL_URL is http://127.0.0.1:9999: build again with it, or set it back.',
    );
    expect(backendMismatch('http://127.0.0.1:8080', undefined)).toBe(
      'This build sends /api to http://127.0.0.1:8080, but BACKEND_INTERNAL_URL is unset: build again with it, or set it back.',
    );
    expect(backendMismatch('', 'http://127.0.0.1:8080')).toBe(
      'This build sends /api to no backend, but BACKEND_INTERNAL_URL is http://127.0.0.1:8080: build again with it, or set it back.',
    );
  });
});

describe('register', () => {
  /** Runs register() with these settings, and says whether it stopped the process, and why. */
  async function start(env: Record<string, string | undefined>) {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await register();
    return { exit: exit.mock.calls, error: error.mock.calls };
  }

  it('stops a Node server started with another address than its build’s, saying why', async () => {
    expect(
      await start({
        NEXT_RUNTIME: 'nodejs',
        INSTANTE_BUILT_BACKEND: 'http://127.0.0.1:8080',
        BACKEND_INTERNAL_URL: 'http://127.0.0.1:9999',
      }),
    ).toEqual({
      exit: [[1]],
      error: [
        [
          'This build sends /api to http://127.0.0.1:8080, but BACKEND_INTERNAL_URL is http://127.0.0.1:9999: build again with it, or set it back.',
        ],
      ],
    });
  });

  it('lets one start with its build’s address, and leaves the Edge runtime alone', async () => {
    const built = { INSTANTE_BUILT_BACKEND: 'http://127.0.0.1:8080' };
    expect(
      await start({
        ...built,
        NEXT_RUNTIME: 'nodejs',
        BACKEND_INTERNAL_URL: 'http://127.0.0.1:8080',
      }),
    ).toEqual({ exit: [], error: [] });
    expect(
      await start({
        ...built,
        NEXT_RUNTIME: 'edge',
        BACKEND_INTERNAL_URL: 'http://127.0.0.1:9999',
      }),
    ).toEqual({ exit: [], error: [] });
  });
});
