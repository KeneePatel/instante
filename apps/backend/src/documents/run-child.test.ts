import { describe, expect, it } from 'vitest';
import {
  CHILD_HEAP_MB,
  CHILD_TIMEOUT_MS,
  MAX_CHILD_OUTPUT_BYTES,
  MAX_CHILD_STDERR_BYTES,
  childArgs,
} from './run-child.ts';
import { echo } from './tasks/echo.ts';

describe('childArgs', () => {
  it('gives the permission model, no SIGUSR1, a 256 MB heap, no sqlite and read grants only, then the script', () => {
    expect(
      childArgs({
        script: '/code/src/documents/tasks/echo.ts',
        args: ['a'],
        jobFolder: '/jobs/instante-job-1',
        grants: ['/code/src', '/code/node_modules/.pnpm'],
      }),
    ).toEqual([
      '--permission',
      '--disable-sigusr1',
      '--max-old-space-size=256',
      '--no-experimental-sqlite',
      '--allow-fs-read=/jobs/instante-job-1',
      '--allow-fs-read=/code/src',
      '--allow-fs-read=/code/node_modules/.pnpm',
      '/code/src/documents/tasks/echo.ts',
      'a',
    ]);
  });

  it('holds the limits in docs/architecture.md: 30 seconds and 256 MB', () => {
    expect(CHILD_TIMEOUT_MS).toBe(30_000);
    expect(CHILD_HEAP_MB).toBe(256);
  });

  it('holds the platform spec’s caps: a 64 MiB result and 64 KiB of stderr', () => {
    expect(MAX_CHILD_OUTPUT_BYTES).toBe(64 * 1024 * 1024);
    expect(MAX_CHILD_STDERR_BYTES).toBe(64 * 1024);
  });
});

describe('echo', () => {
  it("gives the input's length and SHA-256", () => {
    expect(echo(new TextEncoder().encode('hello'))).toEqual({
      length: 5,
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    });
    expect(echo(new Uint8Array())).toEqual({
      length: 0,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
  });
});
