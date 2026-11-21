import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';

// The harness for the guards' tests (guards.test.ts, guards-scanners.test.ts and
// guards-commits.test.ts, three files so Vitest runs them side by side): each test makes a
// scratch git repository with an `origin/main`, plants one change and runs a guard in it. The
// planted keywords are built in pieces, so these files pass the floor guard.
export const k = (...parts: string[]): string => parts.join('');
export const DISABLE = k('eslint-', 'disable');
export const TS_IGNORE = k('@ts-', 'ignore');
export const LATER = k('TO', 'DO');
export const SKIP = k('.sk', 'ip(');
export const ONLY = k('.on', 'ly(');
export const EMPTY_CATCH = k('catch ', '{}');
export const SC_DISABLE = k('shellcheck ', 'disable');
export const CONTINUE = k('continue-on-', 'error');

const scripts = fileURLToPath(new URL('../..', import.meta.url));
export const OWNER = { name: 'Kenee Patel', email: 'patelkenee2804@gmail.com' };
const cleanups: string[] = [];

afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export interface Identity {
  name: string;
  email: string;
}

export function makeRepo(files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'instante-guards-'));
  cleanups.push(dir);
  const env = (who: Identity = OWNER, committer: Identity = who) => ({
    PATH: process.env['PATH'] ?? '',
    HOME: dir,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: who.name,
    GIT_AUTHOR_EMAIL: who.email,
    GIT_COMMITTER_NAME: committer.name,
    GIT_COMMITTER_EMAIL: committer.email,
  });
  const git = (args: string[], who?: Identity, committer?: Identity): string =>
    execFileSync('git', args, {
      cwd: dir,
      env: env(who, committer),
      encoding: 'utf8',
      stdio: 'pipe',
    });
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  git(['init', '-q', '-b', 'main']);
  for (const [path, text] of Object.entries(files)) write(path, text);
  git(['add', '-A']);
  git(['commit', '-q', '--allow-empty', '-m', 'base']);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);

  return {
    write,
    remove: (path: string): void => {
      rmSync(join(dir, path));
    },
    commit: (message: string, who?: Identity, committer?: Identity): void => {
      git(['add', '-A']);
      git(['commit', '-q', '--allow-empty', '-m', message], who, committer);
    },
    git,
    run: (script: string): { status: number | null; output: string } => {
      const result = spawnSync(process.execPath, [join(scripts, script)], {
        cwd: dir,
        env: env(),
        encoding: 'utf8',
      });
      return { status: result.status, output: result.stdout + result.stderr };
    },
  };
}
