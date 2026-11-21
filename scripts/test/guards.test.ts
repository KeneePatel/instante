import { describe, expect, it } from 'vitest';
import {
  CONTINUE,
  DISABLE,
  EMPTY_CATCH,
  LATER,
  ONLY,
  SC_DISABLE,
  SKIP,
  TS_IGNORE,
  k,
  makeRepo,
} from './support/guard-repo.ts';

// scripts/floor-guard.ts, run in a scratch repository (./support/guard-repo.ts): its rules but
// the scanners', the pins' and the reasons for removing tests, which guards-scanners.test.ts
// holds; check-commits and check-agent-settings are in guards-commits.test.ts.

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
    // ShellCheck's directive, with another key first; Semgrep's ignore comment, short or loud.
    ['silenced-checker', 'scripts/a.sh', k('# shell', 'check source=b.sh dis', 'able=SC2086\n')],
    ['silenced-checker', 'src/a.ts', k('eval(x); // no', 'sem\n')],
    ['silenced-checker', 'src/a.ts', k('eval(x); // NO', 'SEMGREP\n')],
    // A shell script with no extension, as the launcher will be.
    [
      'silenced-checker',
      'scripts/local/instante',
      `#!/usr/bin/env bash\n# ${SC_DISABLE}=SC2086\necho $1\n`,
    ],
    ['scanner-weakened', 'scripts/shellcheckrc', 'disable=all\n'],
    ['scanner-weakened', '.gitleaksignore', 'abc:src/a.ts:generic-api-key:1\n'],
    ['scanner-weakened', '.gitleaks.toml', '[allowlist]\npaths = ["src"]\n'],
    [
      'scanner-weakened',
      '.github/workflows/ci.yml',
      k('    env:\n      SHELLCHECK', '_OPTS: -e x\n'),
    ],
    ['scanner-weakened', '.github/workflows/ci.yml', k('      GITLEAKS', '_CONFIG: a.toml\n')],
    [
      'scanner-weakened',
      '.github/workflows/ci.yml',
      `          gitleaks git --redact ${k('--exit-', 'code')} 0 .\n`,
    ],
    [
      'scanner-weakened',
      '.github/workflows/ci.yml',
      `        run: bash scripts/ci/semgrep.sh ${k('|', '| true')}\n`,
    ],
    [
      'scanner-weakened',
      '.github/workflows/ci.yml',
      `        run: bash scripts/ci/shellcheck.sh${k(';', ' exit 0')}\n`,
    ],
    ['scanner-weakened', 'scripts/ci/shellcheck.sh', `shellcheck ${k('--rc', 'file')} x -- a.sh\n`],
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

    // "Fails on ... 7.0 or more" is a ceiling: raising it loosens the bar.
    it('reads a number a check fails from as a ceiling', () => {
      const failing = `${constraints}| Dependencies | none high | fails on a CVSS score of 7.0 or more |\n`;
      const raised = makeRepo({ 'CONSTRAINTS.md': failing });
      raised.write('CONSTRAINTS.md', failing.replace('7.0 or more', '9.0 or more'));
      expect(raised.run(guard).output).toContain('[threshold-loosened]');
      const lowered = makeRepo({ 'CONSTRAINTS.md': failing });
      lowered.write('CONSTRAINTS.md', failing.replace('7.0 or more', '4.0 or more'));
      expect(lowered.run(guard)).toMatchObject({ status: 0 });
    });

    // Only "fails on", "at" or "from" turns a number round: "fail fast" says nothing of it.
    it('leaves a number after “fail fast” as it reads', () => {
      const fast = `${constraints}| Unit tests | fail fast, in 5 s or less | vitest |\n`;
      const repo = makeRepo({ 'CONSTRAINTS.md': fast });
      repo.write('CONSTRAINTS.md', fast.replace('5 s or less', '9 s or less'));
      expect(repo.run(guard).output).toContain('[threshold-loosened]');
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
