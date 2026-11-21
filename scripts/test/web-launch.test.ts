import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// The web app's launch (scripts/prod-build/stack.sh's `web`, as `instante start` runs it):
// what its flags and, on macOS, its sandbox profile let it read (docs/specs/platform.md,
// criterion 7), and Next's private names the end-to-end stack relies on.

const ROOT = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'instante-web-launch-')));
  made.push(dir);
  return dir;
}

/** What the probe, launched as the web app is, says of each path: READ, or the error's code. */
function probe(paths: string[]): Record<string, string> {
  const logs = scratch();
  const result = spawnSync(
    '/bin/bash',
    [
      '-c',
      [
        'set -u',
        '. "$ROOT/scripts/prod-build/stack.sh" || exit 2',
        'stack_node || exit 2',
        // The folder web() names to the profile for its output; this output is a pipe.
        'procs_dir="$LOGS" && mkdir -p "$procs_dir/logs" || exit 2',
        'STACK_WEB_MAIN="$ROOT/scripts/prod-build/read-probe.ts" web "PROBE_PATHS=$PROBE_PATHS"',
      ].join('\n'),
    ],
    {
      encoding: 'utf8',
      env: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        ROOT,
        LOGS: logs,
        PROBE_PATHS: paths.join('\n'),
      },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return Object.fromEntries(
    result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { path: string; outcome: string })
      .map(({ path: p, outcome }) => [p, outcome]),
  );
}

/** A secret planted outside the checkout, 0600 in a 0700 folder, as ~/.instante/secrets is. */
function plant(): string {
  const folder = path.join(scratch(), 'secrets');
  mkdirSync(folder, { mode: 0o700 });
  const secret = path.join(folder, 'app.url');
  writeFileSync(secret, 'postgresql://planted\n');
  chmodSync(secret, 0o600);
  return secret;
}

/** A path that reads as inside the checkout, as Node's permission model reads it (dropping
 * `link/..` as text), but that the kernel follows through the checkout's own pnpm link,
 * apps/backend/node_modules/@instante/contract -> packages/contract, up to the root and down to
 * the secret (found in T13). */
function climb(secret: string): string {
  const link = path.join(ROOT, 'apps/backend/node_modules/@instante/contract');
  const depth = ROOT.split('/').filter(Boolean).length;
  // Each repeat keeps the kernel at packages/contract and puts the text three levels deeper,
  // so the text can climb as far as the kernel must and still read as inside the checkout.
  const repeats = Math.ceil(depth / 3) + 1;
  const p =
    link +
    '/../../apps/backend/node_modules/@instante/contract'.repeat(repeats) +
    '/..'.repeat(depth + 2) +
    secret;
  expect(path.resolve(p).startsWith(`${ROOT}/`)).toBe(true);
  return p;
}

describe('the web app’s launch', () => {
  // On macOS the profile refuses the read through the link, judged by where the kernel lands. On
  // Linux, which has no profile, the flags alone let it through: the gap R2 records.
  it('can’t read a planted secret straight, and through the checkout’s pnpm link only on Linux', () => {
    const secret = plant();
    const through = climb(secret);
    const own = path.join(ROOT, 'package.json');

    const plain = spawnSync(process.execPath, [
      '-e',
      'process.stdout.write(String(require("node:fs").readFileSync(process.argv[1]).length))',
      through,
    ]);
    expect(plain.status, 'the path reaches the secret without the flags').toBe(0);

    const seen = probe([secret, through, own]);
    expect(seen[own], 'the probe reads inside the checkout').toBe('READ');
    expect(seen[secret]).toBe('ERR_ACCESS_DENIED');
    expect(seen[through]).toBe(process.platform === 'darwin' ? 'EPERM' : 'READ');
  });
});

describe('Next’s private names', () => {
  // scripts/e2e-stack.sh builds and starts the web app with __NEXT_PROCESSED_ENV=true, so a
  // checkout's apps/web/.env.local, kept for `pnpm dev`, isn't applied. A Next.js that stops
  // honouring the name fails here.
  it('__NEXT_PROCESSED_ENV keeps an env file from being applied', () => {
    const dir = scratch();
    writeFileSync(path.join(dir, '.env.local'), 'INSTANTE_SENTINEL=from-the-file\n');
    // Next's own copy of @next/env, found from next's real folder in pnpm's store.
    const next = realpathSync(path.join(ROOT, 'apps/web/node_modules/next/package.json'));
    const load = (extra: Record<string, string>) => {
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=commonjs',
          '-e',
          [
            'const { createRequire } = require("node:module");',
            'const fromNext = createRequire(process.argv[1]);',
            'fromNext("@next/env").loadEnvConfig(process.argv[2], false, { info() {}, error() {} });',
            'process.stdout.write(process.env.INSTANTE_SENTINEL ?? "unset");',
          ].join('\n'),
          next,
          dir,
        ],
        { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ...extra } },
      );
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    expect(load({}), 'applied without the name').toBe('from-the-file');
    expect(load({ __NEXT_PROCESSED_ENV: 'true' })).toBe('unset');
  });
});
