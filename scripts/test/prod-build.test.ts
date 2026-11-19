import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// scripts/prod-build/web-sources.ts, on fake builds: server source maps whose sources are, as
// Turbopack writes them, URL-encoded paths relative to each map. scripts/prod-build-check.sh
// runs it, with the relay and selftest, against a real build in the production-build job.

const SCRIPT = fileURLToPath(new URL('../prod-build/web-sources.ts', import.meta.url));
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const EVERY_BUILD = ['apps/web/instrumentation.ts', 'apps/web/proxy.ts', 'apps/web/app/layout.tsx'];

/** A repository whose build has the maps given: their file under .next/server, and contents. */
function build(maps: Record<string, unknown>) {
  const root = mkdtempSync(path.join(tmpdir(), 'instante-web-sources-'));
  made.push(root);
  for (const [file, map] of Object.entries(maps)) {
    const full = path.join(root, 'apps/web/.next/server', file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, typeof map === 'string' ? map : JSON.stringify(map));
  }
  return root;
}
/** A source, as a map at .next/server/<depth folders>/x.js.map lists a repository file. */
const from = (depth: number, file: string) =>
  `${'../'.repeat(depth + 4)}${file}`.split('/').map(encodeURIComponent).join('/');
const run = (root: string | undefined) => {
  const result = spawnSync(process.execPath, root === undefined ? [SCRIPT] : [SCRIPT, root], {
    encoding: 'utf8',
  });
  return { status: result.status, output: result.stdout + result.stderr };
};

describe('web-sources', () => {
  it('passes a build whose maps list only the app’s own files and its packages', () => {
    const root = build({
      'chunks/a.js.map': { sources: EVERY_BUILD.map((f) => from(1, f)) },
      'app/page/b.js.map': {
        sources: [
          from(2, 'apps/web/lib/api.ts'),
          from(2, 'node_modules/.pnpm/x@1/node_modules/x/test/helper.js'),
          `${'../'.repeat(7)}outside/test/x.ts`,
        ],
      },
    });
    const result = run(root);
    expect(result.status).toBe(0);
    expect(result.output).toContain('2 server source maps list 4 of the repository');
  });

  it.each([
    ['a test folder', 'apps/backend/test/db-harness.ts'],
    ['an e2e folder', 'apps/web/e2e/skeleton.spec.ts'],
    ['a test file', 'apps/web/lib/api.test.ts'],
    ['a tsx test file', 'apps/web/components/screen.test.tsx'],
    ['a path with spaces', 'apps/web/test/a b.ts'],
  ])('fails on a source in %s, naming it', (_case, file) => {
    const root = build({
      'chunks/a.js.map': { sources: [...EVERY_BUILD.map((f) => from(1, f)), from(1, file)] },
    });
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain(`the build holds ${file}`);
  });

  it('reads the sections of an index map', () => {
    const root = build({
      'chunks/a.js.map': {
        sections: [
          { map: { sources: EVERY_BUILD.map((f) => from(1, f)) } },
          { map: { sources: [from(1, 'packages/contract/test/x.ts')] } },
        ],
      },
    });
    expect(run(root)).toMatchObject({ status: 1 });
  });

  it('fails when the maps don’t list the files every build has, so listing nothing can’t pass', () => {
    const root = build({ 'chunks/a.js.map': { sources: [from(1, 'apps/web/proxy.ts')] } });
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "don't list apps/web/instrumentation.ts, apps/web/app/layout.tsx, which every build has",
    );
    expect(run(build({ 'chunks/a.js': 'no maps' }))).toMatchObject({ status: 1 });
  });

  it('exits 2 with no build, or a map it can’t read', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'instante-web-sources-'));
    made.push(empty);
    expect(run(empty).status).toBe(2);
    expect(run(build({ 'chunks/a.js.map': '{ broken' })).status).toBe(2);
  });
});
