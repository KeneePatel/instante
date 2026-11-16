import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/** Runs the check on a .next folder holding `manifest` as its prerender manifest, or none. */
function check(manifest: unknown) {
  const folder = mkdtempSync(path.join(tmpdir(), 'instante-next-'));
  made.push(folder);
  if (manifest !== undefined) {
    writeFileSync(path.join(folder, 'prerender-manifest.json'), JSON.stringify(manifest));
  }
  const run = spawnSync(process.execPath, [script, folder], { encoding: 'utf8' });
  return { status: run.status, output: run.stdout + run.stderr };
}
/** A version 4 manifest, as Next 16.4 writes it, listing these routes with their types. */
const built = (routes: Record<string, 'page' | 'route'>) => ({
  version: 4,
  routes: Object.fromEntries(
    Object.entries(routes).map(([route, routeType]) => [route, { routeType }]),
  ),
});

describe('check-no-static', () => {
  it('passes a build that prerendered only route handlers and Next’s own global error page', () => {
    expect(
      check(
        built({ '/favicon.ico': 'route', '/opengraph-image': 'route', '/_global-error': 'page' }),
      ),
    ).toEqual({ status: 0, output: 'check-no-static: no static page\n' });
    expect(check(built({})).status).toBe(0);
  });

  it('fails on any page prerendered, one or many, whatever its name, naming each', () => {
    expect(check(built({ '/settings': 'page' }))).toMatchObject({ status: 1 });
    const { status, output } = check(
      built({ '/': 'page', '/_not-found': 'page', '/favicon.ico': 'route', '/v1.0': 'page' }),
    );
    expect(status).toBe(1);
    expect(output).toContain('check-no-static: next build prerendered /, /_not-found, /v1.0');
  });

  it('says so when there is no build, or a manifest it can’t read', () => {
    for (const manifest of [undefined, { version: 5, routes: {} }, { version: 4 }, null]) {
      expect(check(manifest).status, JSON.stringify(manifest)).toBe(2);
    }
    expect(check(undefined).output).toContain('check-no-static: no build to read in');
    expect(check({ version: 5, routes: {} }).output).toContain(
      "isn't the version 4 manifest this check reads",
    );
  });
});
