import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Each test makes a scratch git repository with an `origin/main`, plants one change and runs
// a guard in it. The planted keywords are built in pieces, so this file passes the floor guard.
const k = (...parts: string[]): string => parts.join('');
const DISABLE = k('eslint-', 'disable');
const TS_IGNORE = k('@ts-', 'ignore');
const LATER = k('TO', 'DO');
const SKIP = k('.sk', 'ip(');
const ONLY = k('.on', 'ly(');
const EMPTY_CATCH = k('catch ', '{}');

const scripts = fileURLToPath(new URL('..', import.meta.url));
const OWNER = { name: 'Kenee Patel', email: 'patelkenee2804@gmail.com' };
const cleanups: string[] = [];

afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Identity {
  name: string;
  email: string;
}

function makeRepo(files: Record<string, string> = {}) {
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

describe('floor-guard', () => {
  const guard = 'floor-guard.ts';

  it('passes a clean change, and ignores keywords in the docs', () => {
    const repo = makeRepo({ 'src/a.ts': 'export const a = 1;\n' });
    repo.write('src/b.ts', 'export const b = 2;\n');
    repo.write('docs/notes.md', `${LATER}: write more docs\n`);
    expect(repo.run(guard)).toMatchObject({ status: 0 });
  });

  it('exits 2 when there is no base to compare with', () => {
    const repo = makeRepo();
    repo.git(['update-ref', '-d', 'refs/remotes/origin/main']);
    expect(repo.run(guard).status).toBe(2);
  });

  it.each([
    ['silenced-checker', 'src/a.ts', `// ${DISABLE}-next-line no-console\nconsole.log(1);\n`],
    ['silenced-checker', 'src/a.ts', `// ${TS_IGNORE}\nexport const a: number = 'x';\n`],
    ['unfinished-work', 'src/a.ts', `try {\n  run();\n} ${EMPTY_CATCH}\n`],
    ['unfinished-work', 'src/a.ts', `// ${LATER}: handle the error\n`],
    ['test-made-easier', 'src/a.test.ts', `it${SKIP}'works', () => {});\n`],
    ['test-made-easier', 'src/a.test.ts', `describe${ONLY}'all', () => {});\n`],
    ['web-app-ban', 'apps/web/app/page.tsx', k("'use ", "server';\n")],
    [
      'web-app-ban',
      'apps/web/app/page.tsx',
      k('export const html = { dangerously', 'SetInnerHTML: 1 };\n'),
    ],
    ['web-app-ban', 'apps/web/app/api/x/route.ts', 'export const GET = 1;\n'],
    [
      'get-session-outside-token-provider',
      'apps/web/lib/api.ts',
      'await supabase.auth.getSession();\n',
    ],
    ['backend-reads-cookie', 'apps/backend/src/api/x.ts', `const c = req.header('cookie');\n`],
    ['model-not-allowed', 'apps/backend/src/ai/models.ts', `const model = 'claude-opus-5-5';\n`],
    ['lint-weakened', 'eslint.config.mjs', `  rules: { 'no-console': 'off' },\n`],
    [
      'coverage-scope-changed',
      'vitest.config.ts',
      `  coverage: { exclude: ['apps/web/lib/x.ts'] },\n`,
    ],
  ])('flags %s in %s', (rule, path, text) => {
    const repo = makeRepo();
    repo.write(path, text);
    const result = repo.run(guard);
    expect(result.status).toBe(1);
    expect(result.output).toContain(`[${rule}]`);
  });

  it('flags a change even before it is committed or added', () => {
    const repo = makeRepo();
    repo.write('src/untracked.ts', `// ${LATER}\n`);
    expect(repo.run(guard).output).toContain('[unfinished-work]');
  });

  it('allows the allowed models, and getSession() in the token provider', () => {
    const repo = makeRepo();
    repo.write(
      'apps/backend/src/ai/models.ts',
      `export const m = ['claude-sonnet-5-5', 'claude-haiku-5-5'];\n`,
    );
    repo.write('apps/web/lib/auth/token-provider.ts', 'await supabase.auth.getSession();\n');
    repo.write(
      'apps/backend/test/fixtures/refused-model.ts',
      `export const refused = 'claude-opus-5-5';\n`,
    );
    expect(repo.run(guard)).toMatchObject({ status: 0 });
  });

  it('flags partialPrefetching off while Cache Components is on', () => {
    const repo = makeRepo();
    repo.write(
      'apps/web/next.config.ts',
      'export default { cacheComponents: true, partialPrefetching: false };\n',
    );
    expect(repo.run(guard).output).toContain('[web-app-ban]');
  });

  it('flags a deleted test, and an assertion removed from a test that stays', () => {
    const repo = makeRepo({
      'src/gone.test.ts': "it('a', () => { expect(1).toBe(1); });\n",
      'src/kept.test.ts': "it('b', () => {\n  expect(2).toBe(2);\n  expect(3).toBe(3);\n});\n",
    });
    repo.remove('src/gone.test.ts');
    repo.write('src/kept.test.ts', "it('b', () => {\n  expect(2).toBe(2);\n});\n");
    const { output } = repo.run(guard);
    expect(output).toContain('[test-deleted] src/gone.test.ts');
    expect(output).toContain('[assertion-removed] src/kept.test.ts');
  });

  it('does not flag an assertion that only moved', () => {
    const repo = makeRepo({
      'src/kept.test.ts': "it('b', () => {\n  expect(2).toBe(2);\n  expect(3).toBe(3);\n});\n",
    });
    repo.write(
      'src/kept.test.ts',
      "it('b', () => {\n  expect(3).toBe(3);\n  expect(2).toBe(2);\n});\n",
    );
    expect(repo.run(guard)).toMatchObject({ status: 0 });
  });

  it('flags a tsconfig strictness flag turned off', () => {
    const repo = makeRepo({ 'tsconfig.base.json': '{\n  "strict": true\n}\n' });
    repo.write('tsconfig.base.json', '{\n  "strict": false\n}\n');
    expect(repo.run(guard).output).toContain('[strictness-loosened]');
  });

  it('flags the coverage scope shrinking and the coverage threshold going down', () => {
    const repo = makeRepo({
      'vitest.config.ts': "include: ['apps/backend/src/**', 'apps/web/lib/**'],\n",
      '.github/workflows/ci.yml': 'run: diff-cover lcov.info --fail-under=80\n',
    });
    repo.write('vitest.config.ts', "include: ['apps/backend/src/**'],\n");
    repo.write('.github/workflows/ci.yml', 'run: diff-cover lcov.info --fail-under=70\n');
    const { output } = repo.run(guard);
    expect(output).toContain('[coverage-scope-changed]');
    expect(output).toContain('[coverage-threshold-loosened]');
  });

  describe('CONSTRAINTS.md', () => {
    const constraints = [
      '- **No secrets:** none in source.',
      '| Coverage | Changed lines ≥ 80% covered | diff-cover |',
      '| Fast checks | under 5 s | check:fast |',
      '| ID | Rule | Path |',
      '| — | — | — |',
      '',
    ].join('\n');

    it('flags a minimum lowered and a maximum raised', () => {
      const repo = makeRepo({ 'CONSTRAINTS.md': constraints });
      repo.write(
        'CONSTRAINTS.md',
        constraints.replace('≥ 80%', '≥ 70%').replace('under 5 s', 'under 9 s'),
      );
      const { output } = repo.run(guard);
      expect(output.match(/\[threshold-loosened\]/g)).toHaveLength(2);
    });

    it('stays quiet when a threshold tightens', () => {
      const repo = makeRepo({ 'CONSTRAINTS.md': constraints });
      repo.write('CONSTRAINTS.md', constraints.replace('≥ 80%', '≥ 90%'));
      expect(repo.run(guard)).toMatchObject({ status: 0 });
    });

    it('flags a rule removed and a new exception row', () => {
      const repo = makeRepo({ 'CONSTRAINTS.md': constraints });
      repo.write(
        'CONSTRAINTS.md',
        constraints
          .replace('- **No secrets:** none in source.\n', '')
          .replace('| — | — | — |', '| E1 | no-explicit-any | src/** |'),
      );
      const { output } = repo.run(guard);
      expect(output).toContain('[rule-removed]');
      expect(output).toContain('[new-exception]');
    });
  });
});

describe('check-commits', () => {
  const check = 'check-commits.ts';
  const stranger = { name: 'Someone Else', email: 'someone@example.com' };

  it('passes commits authored and committed as the owner', () => {
    const repo = makeRepo();
    repo.write('a.txt', 'a');
    repo.commit('Add a');
    expect(repo.run(check)).toMatchObject({ status: 0 });
  });

  it('flags another author or committer', () => {
    const repo = makeRepo();
    repo.write('a.txt', 'a');
    repo.commit('Add a', stranger);
    repo.write('b.txt', 'b');
    repo.commit('Add b', OWNER, stranger);
    const { status, output } = repo.run(check);
    expect(status).toBe(1);
    expect(output).toContain('author is Someone Else');
    expect(output).toContain('committer is Someone Else');
  });

  it('flags a trailer and AI attribution', () => {
    const repo = makeRepo();
    repo.write('a.txt', 'a');
    repo.commit(`Add a\n\n${k('Co-Authored', '-By')}: A Bot <bot@example.com>`);
    const { status, output } = repo.run(check);
    expect(status).toBe(1);
    expect(output).toContain('has trailers');
    expect(output).toContain('AI attribution');
  });

  it('skips merge commits, which GitHub makes to test a pull request', () => {
    const repo = makeRepo();
    repo.git(['switch', '-q', '-c', 'topic']);
    repo.write('a.txt', 'a');
    repo.commit('Add a');
    repo.git(['switch', '-q', 'main']);
    repo.write('b.txt', 'b');
    repo.commit('Add b');
    repo.git(['merge', '-q', '--no-ff', '-m', 'Merge topic', 'topic'], stranger);
    expect(repo.run(check)).toMatchObject({ status: 0 });
  });
});

describe('check-agent-settings', () => {
  const check = 'check-agent-settings.ts';
  const settings = (value: unknown): string => JSON.stringify(value, null, 2);

  it('passes deny rules for ~/.instante', () => {
    const repo = makeRepo();
    repo.write(
      '.claude/settings.json',
      settings({ permissions: { deny: ['Read(~/.instante/**)'] } }),
    );
    expect(repo.run(check)).toMatchObject({ status: 0 });
  });

  it.each([
    ['a sandbox setting', { sandbox: { enabled: false } }],
    ['an allowRead setting', { allowRead: ['~/x'] }],
    ['~/.instante outside permissions.deny', { permissions: { allow: ['Read(~/.instante/**)'] } }],
  ])('flags %s', (problem, value) => {
    const repo = makeRepo();
    repo.write('.claude/settings.local.json', settings(value));
    const result = repo.run(check);
    expect(result.status).toBe(1);
    expect(result.output).toContain(problem.replace(/^an? /, ''));
  });

  it('flags a settings file that is not valid JSON', () => {
    const repo = makeRepo();
    repo.write('.claude/settings.json', '{ not json');
    expect(repo.run(check).output).toContain("isn't valid JSON");
  });
});
