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
const SC_DISABLE = k('shellcheck ', 'disable');
const CONTINUE = k('continue-on-', 'error');

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
    ['silenced-checker', 'scripts/a.sh', `# ${SC_DISABLE}=SC2086\necho $1\n`],
    ['scanner-weakened', '.github/workflows/ci.yml', `      - run: x\n        ${CONTINUE}: true\n`],
    ['scanner-weakened', 'scripts/ci/semgrep.sh', `semgrep scan ${k('--exclude', '-rule')} r\n`],
    ['scanner-weakened', 'scripts/ci/semgrep.sh', `semgrep scan ${k('--incl', 'ude')} src\n`],
    [
      'scanner-weakened',
      'scripts/ci/osv-scan.sh',
      `osv-scanner scan ${k('--con', 'fig')} a.toml .\n`,
    ],
    [
      'scanner-weakened',
      'scripts/ci/osv-scan.sh',
      `osv-scanner scan ${k('-', 'L')} pnpm-lock.yaml\n`,
    ],
    ['scanner-weakened', 'scripts/ci/osv-scan.sh', `osv-scanner ${k('--off', 'line')} .\n`],
    ['scanner-weakened', 'scripts/ci/shellcheck.sh', `shellcheck ${k('-', 'e')} SC2086 -- a.sh\n`],
    ['scanner-weakened', '.semgrepignore', 'apps/\n'],
    ['scanner-weakened', 'osv-scanner.toml', '[[IgnoredVulns]]\nid = "GHSA-x"\n'],
    ['scanner-weakened', 'scripts/.shellcheckrc', 'disable=SC2086\n'],
  ])('flags %s in %s', (rule, path, text) => {
    const repo = makeRepo();
    repo.write(path, text);
    const result = repo.run(guard);
    expect(result.status).toBe(1);
    expect(result.output).toContain(`[${rule}]`);
  });

  it('flags an empty scanner ignore file, which replaces the scanner’s own defaults', () => {
    const repo = makeRepo();
    repo.write('.semgrepignore', '');
    const result = repo.run(guard);
    expect(result.status).toBe(1);
    expect(result.output).toContain('[scanner-weakened] .semgrepignore');
  });

  it('flags a workflow that stops running a scanner, but not one moved to another workflow', () => {
    const run = (script: string) => `      - run: bash scripts/ci/${script}.sh\n`;
    const repo = makeRepo({
      '.github/workflows/ci.yml': `${run('semgrep')}${run('shellcheck')}`,
    });
    repo.write('.github/workflows/ci.yml', run('shellcheck'));
    const dropped = repo.run(guard);
    expect(dropped.status).toBe(1);
    expect(dropped.output).toContain('[scanner-removed] .github/workflows/ci.yml');
    repo.write('.github/workflows/weekly.yml', run('semgrep'));
    expect(repo.run(guard)).toMatchObject({ status: 0 });
  });

  it('leaves the same flags alone outside the scanners’ own scripts and in the docs', () => {
    const repo = makeRepo();
    repo.write('scripts/ci/fetch.sh', 'curl -fsS -L -o out https://example.test/x\n');
    repo.write('scripts/ci/semgrep.sh', 'semgrep scan --severity ERROR --error --strict\n');
    repo.write('docs/notes.md', `${CONTINUE}, ${k('--exclude', '-rule')} and ${SC_DISABLE}\n`);
    expect(repo.run(guard)).toMatchObject({ status: 0 });
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

  it('lets a deleted test and removed assertions through when the commit that removes them says why, for that file only', () => {
    const repo = makeRepo({
      'src/gone.test.ts': "it('a', () => { expect(1).toBe(1); });\n",
      'src/also.test.ts': "it('d', () => { expect(5).toBe(5); });\n",
      'src/kept.test.ts': "it('b', () => {\n  expect(2).toBe(2);\n  expect(3).toBe(3);\n});\n",
      'src/other.test.ts': "it('c', () => {\n  expect(4).toBe(4);\n});\n",
    });
    repo.remove('src/gone.test.ts');
    repo.remove('src/also.test.ts');
    repo.write('src/kept.test.ts', "it('b', () => {\n  expect(2).toBe(2);\n});\n");
    repo.write('src/other.test.ts', "it('c', () => {});\n");
    repo.commit(
      [
        'Drop what the tests checked',
        '',
        'Tests removed from src/gone.test.ts: the feature it tested is gone',
        'Tests removed from src/kept.test.ts: three is no longer a case',
        // Nine characters: too short to be a reason, so it counts for nothing.
        'Tests removed from src/other.test.ts: obsolete.',
      ].join('\n'),
    );
    const { status, output } = repo.run(guard);
    expect(status).toBe(1);
    expect(output).toContain(
      'floor-guard: tests removed from src/gone.test.ts, as a commit says: the feature it tested is gone',
    );
    expect(output).toContain(
      'floor-guard: tests removed from src/kept.test.ts, as a commit says: three is no longer a case',
    );
    expect(output).not.toContain('[test-deleted] src/gone.test.ts');
    expect(output).not.toContain('[assertion-removed] src/kept.test.ts');
    // Deleted in the same commit, but not named in it.
    expect(output).toContain('[test-deleted] src/also.test.ts');
    expect(output).toContain('[assertion-removed] src/other.test.ts');
    expect(output).toContain('`Tests removed from <file>: <reason>`, ten characters or more');
  });

  it('vouches only for what the commit giving the reason removes: not a later commit’s, nor an uncommitted change', () => {
    const repo = makeRepo({
      'src/kept.test.ts':
        "it('b', () => {\n  expect(2).toBe(2);\n  expect(3).toBe(3);\n  expect(4).toBe(4);\n});\n",
    });
    repo.write(
      'src/kept.test.ts',
      "it('b', () => {\n  expect(2).toBe(2);\n  expect(4).toBe(4);\n});\n",
    );
    repo.commit('Drop three\n\nTests removed from src/kept.test.ts: three is no longer a case');
    repo.write('src/kept.test.ts', "it('b', () => {\n  expect(2).toBe(2);\n});\n");
    repo.commit('Drop four as well');
    repo.write('src/kept.test.ts', "it('b', () => {});\n");
    const { status, output } = repo.run(guard);
    expect(status).toBe(1);
    expect(output).not.toContain('expect(3)');
    expect(output).toContain('[assertion-removed] src/kept.test.ts: expect(4).toBe(4);');
    expect(output).toContain('[assertion-removed] src/kept.test.ts: expect(2).toBe(2);');
  });

  it('flags a test file deleted by a later commit than the one naming it', () => {
    const repo = makeRepo({ 'src/gone.test.ts': "it('a', () => { expect(1).toBe(1); });\n" });
    repo.write('src/note.md', 'a change that deletes nothing\n');
    repo.commit('Plan\n\nTests removed from src/gone.test.ts: about to go, but not in this commit');
    repo.remove('src/gone.test.ts');
    repo.commit('Drop it');
    const { status, output } = repo.run(guard);
    expect(status).toBe(1);
    expect(output).toContain('[test-deleted] src/gone.test.ts');
  });

  it('vouches for each removed line once: the same text removed again later is flagged', () => {
    const line = '  expect(1).toBe(1);';
    const repo = makeRepo({
      'src/kept.test.ts': `it('a', () => {\n${line}\n});\nit('b', () => {\n${line}\n});\n`,
    });
    repo.write('src/kept.test.ts', `it('a', () => {});\nit('b', () => {\n${line}\n});\n`);
    repo.commit("Drop a's check\n\nTests removed from src/kept.test.ts: a no longer checks one");
    repo.write('src/kept.test.ts', "it('a', () => {});\nit('b', () => {});\n");
    const { status, output } = repo.run(guard);
    expect(status).toBe(1);
    expect(output).toContain('[assertion-removed] src/kept.test.ts: expect(1).toBe(1);');
  });

  it('holds each reason to its own commit’s files: one it only edits, one it doesn’t name, one it doesn’t touch', () => {
    const repo = makeRepo({
      'src/edited.test.ts': "it('a', () => { expect(1).toBe(1); });\n",
      'src/named.test.ts': "it('b', () => { expect(2).toBe(2); });\n",
      'src/unnamed.test.ts': "it('c', () => { expect(2).toBe(2); });\n",
      'src/other.test.ts': "it('d', () => { expect(3).toBe(3); });\n",
    });
    // Edits edited.test.ts without removing a check, and deletes named and unnamed, both
    // holding the same check, naming only named; other.test.ts is named but untouched.
    repo.write('src/edited.test.ts', "it('a', () => { expect(1).toBe(1); });\n// later\n");
    repo.remove('src/named.test.ts');
    repo.remove('src/unnamed.test.ts');
    repo.commit(
      [
        'Rearrange',
        '',
        'Tests removed from src/edited.test.ts: about to go, but not in this commit',
        'Tests removed from src/named.test.ts: what it tested is gone',
        'Tests removed from src/other.test.ts: named, though this commit leaves it',
      ].join('\n'),
    );
    repo.remove('src/edited.test.ts');
    repo.remove('src/other.test.ts');
    repo.commit('Drop the rest');
    const { status, output } = repo.run(guard);
    expect(status).toBe(1);
    expect(output).not.toContain('[test-deleted] src/named.test.ts');
    expect(output).toContain('[test-deleted] src/unnamed.test.ts');
    expect(output).toContain('[test-deleted] src/edited.test.ts');
    expect(output).toContain('[test-deleted] src/other.test.ts');
  });

  it('follows a test file renamed and trimmed in one commit, named by either name', () => {
    for (const named of ['src/alpha.test.ts', 'src/beta.test.ts']) {
      const body = Array.from(
        { length: 12 },
        (_, i) => `  expect(${String(i)}).toBe(${String(i)});`,
      );
      const repo = makeRepo({ 'src/alpha.test.ts': `it('a', () => {\n${body.join('\n')}\n});\n` });
      repo.git(['mv', 'src/alpha.test.ts', 'src/beta.test.ts']);
      repo.write('src/beta.test.ts', `it('a', () => {\n${body.slice(1).join('\n')}\n});\n`);
      repo.commit(`Rename and trim\n\nTests removed from ${named}: zero is no longer a case`);
      const { status, output } = repo.run(guard);
      expect({ named, status, output }).toMatchObject({ status: 0 });
      expect(output).toContain('zero is no longer a case');
    }
  });

  it('ignores a reason given before the branch, or not at a line’s start', () => {
    const repo = makeRepo({ 'src/gone.test.ts': "it('a', () => { expect(1).toBe(1); });\n" });
    repo.commit('Tests removed from src/gone.test.ts: said before the branch began');
    repo.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    repo.remove('src/gone.test.ts');
    repo.commit('Drop it\n\n  Tests removed from src/gone.test.ts: indented, so not a reason line');
    const { status, output } = repo.run(guard);
    expect(status).toBe(1);
    expect(output).toContain('[test-deleted] src/gone.test.ts');
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
