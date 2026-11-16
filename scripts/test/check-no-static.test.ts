import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// scripts/check-no-static.ts on a build's prerender manifest: pages prerendered fail it.

const script = fileURLToPath(new URL('../check-no-static.ts', import.meta.url));
const made: string[] = [];
afterAll(() => {
  for (const folder of made) rmSync(folder, { recursive: true, force: true });
});

/** Runs the check on a .next folder whose prerender manifest lists `routes`, or has none. */
function check(routes: string[] | undefined) {
  const folder = mkdtempSync(path.join(tmpdir(), 'instante-next-'));
  made.push(folder);
  if (routes !== undefined) {
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      path.join(folder, 'prerender-manifest.json'),
      JSON.stringify({ version: 4, routes: Object.fromEntries(routes.map((r) => [r, {}])) }),
    );
  }
  const run = spawnSync(process.execPath, [script, folder], { encoding: 'utf8' });
  return { status: run.status, output: run.stdout + run.stderr };
}

describe('check-no-static', () => {
  it('passes a build that prerendered only files and Next’s own global error page', () => {
    expect(check(['/favicon.ico', '/_global-error', '/icon.png'])).toEqual({
      status: 0,
      output: 'check-no-static: no static page\n',
    });
    expect(check([]).status).toBe(0);
  });

  it('fails on any page prerendered, naming each', () => {
    const { status, output } = check(['/', '/_not-found', '/favicon.ico', '/settings']);
    expect(status).toBe(1);
    expect(output).toContain('check-no-static: next build prerendered /, /_not-found, /settings');
  });

  it('says so when there is no build to read', () => {
    const { status, output } = check(undefined);
    expect(status).toBe(2);
    expect(output).toContain('check-no-static: no build to read in');
  });
});
