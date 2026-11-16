import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_BUILD,
  PHASE_PRODUCTION_SERVER,
} from 'next/constants';
import { afterEach, describe, expect, it, vi } from 'vitest';
import config, { STARTING } from './next.config.ts';

// next.config.ts (docs/specs/platform.md, "next.config.ts"; T15): what each build is given.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('next.config.ts', () => {
  it('rewrites /api to the backend’s loopback address, recorded for the start-up check', async () => {
    vi.stubEnv('BACKEND_INTERNAL_URL', 'http://127.0.0.1:4311');
    const built = config(PHASE_PRODUCTION_BUILD);
    expect(await built.rewrites?.()).toEqual([
      { source: '/api/:path*', destination: 'http://127.0.0.1:4311/api/:path*' },
    ]);
    expect(built.env).toEqual({ INSTANTE_BUILT_BACKEND: 'http://127.0.0.1:4311' });
  });

  it('writes out the 30-second proxy timeout, turns image optimization and Cache Components off', () => {
    const built = config(PHASE_PRODUCTION_BUILD);
    expect(built.experimental?.proxyTimeout).toBe(30_000);
    expect(built.images).toEqual({ unoptimized: true });
    expect(built.cacheComponents).toBe(false);
  });

  it('builds no rewrite and records no address without one, as next typegen loads it', async () => {
    vi.stubEnv('BACKEND_INTERNAL_URL', undefined);
    const built = config(PHASE_PRODUCTION_BUILD);
    expect(await built.rewrites?.()).toEqual([]);
    expect(built.env).toEqual({ INSTANTE_BUILT_BACKEND: '' });
  });

  it('refuses an address off loopback when building or in development, and leaves a start to the check', () => {
    vi.stubEnv('BACKEND_INTERNAL_URL', 'http://evil.example:4311');
    const message =
      'BACKEND_INTERNAL_URL must be http://127.0.0.1:<port>, not http://evil.example:4311';
    expect(() => config(PHASE_PRODUCTION_BUILD)).toThrow(message);
    expect(() => config(PHASE_DEVELOPMENT_SERVER)).toThrow(message);
    expect(() => config(PHASE_PRODUCTION_SERVER)).not.toThrow();
    expect(STARTING).toBe(PHASE_PRODUCTION_SERVER);
  });
});
