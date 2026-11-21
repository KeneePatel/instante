import { describe, expect, it } from 'vitest';
import { CONTINUE, SC_DISABLE, k, makeRepo } from './support/guard-repo.ts';

// scripts/floor-guard.ts on the scanners (rule 9), the checks' pins (rule 10), and the reasons a
// commit gives for removing tests (rule 6), each run in a scratch repository
// (./support/guard-repo.ts); its other rules are in guards.test.ts.

describe('floor-guard', () => {
  const guard = 'floor-guard.ts';

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

  it('leaves ordinary flags alone off a scanner’s command line, and in comments', () => {
    const repo = makeRepo();
    repo.write('scripts/ci/list.sh', 'git ls-files --others --exclude-standard\n');
    repo.write('scripts/ci/pack.sh', 'tar --exclude=node_modules -cf a.tar .\n');
    repo.write(
      'scripts/ci/shellcheck.sh',
      k('# SHELLCHECK', '_OPTS is unset here\nunset SHELLCHECK', '_OPTS\n'),
    );
    repo.write(
      '.github/workflows/ci.yml',
      '        run: pnpm install --frozen-lockfile --offline\n',
    );
    expect(repo.run(guard)).toMatchObject({ status: 0 });
  });

  it('flags a file renamed into a scanner’s ignore file, though an exact rename has no lines', () => {
    const repo = makeRepo({ 'docs/ignore-example': 'apps/\n' });
    repo.git(['mv', 'docs/ignore-example', '.semgrepignore']);
    repo.commit('Move the example');
    const result = repo.run(guard);
    expect(result.status).toBe(1);
    expect(result.output).toContain('[scanner-weakened] .semgrepignore');
  });

  describe('the checks’ pins', () => {
    const PINS = 'scripts/test/scanner-pins.test.ts';
    const DATA = 'scripts/test/scanner-pins.json';
    const pins =
      "const PINS = read();\nit('pins', () => {\n  expect(hash(job)).toBe(PINS.job);\n});\n";
    const data = (jobs: Record<string, string>, args = ['a', 'b']): string =>
      `${JSON.stringify({ jobs, arguments: { semgrep: args }, cvss: '7.0' }, null, 2)}\n`;
    const pinned = { [PINS]: pins, [DATA]: data({ semgrep: 'aaa' }) };

    it('flags a line added to the test or taken out of it, and passes one moved', () => {
      const added = makeRepo(pinned);
      added.write(PINS, pins.replace('() => {\n', "() => {\n  if (process.env['CI']) return;\n"));
      expect(added.run(guard).output).toContain(`[pin-changed] ${PINS}: +if (process.env['CI'])`);
      const taken = makeRepo(pinned);
      taken.write(PINS, pins.replace('  expect(hash(job)).toBe(PINS.job);\n', ''));
      expect(taken.run(guard).output).toContain(`[pin-changed] ${PINS}: -expect(hash(job))`);
      const moved = makeRepo(pinned);
      const [first, ...rest] = pins.trimEnd().split('\n');
      moved.write(PINS, `${[...rest, first].join('\n')}\n`);
      expect(moved.run(guard)).toMatchObject({ status: 0 });
    });

    it('flags a pinned value changed or removed, or a list grown, and passes a pin added', () => {
      const changed = makeRepo(pinned);
      changed.write(DATA, data({ semgrep: 'bbb' }));
      expect(changed.run(guard).output).toContain(`[pin-loosened] ${DATA}: jobs › semgrep: "bbb"`);
      const removed = makeRepo(pinned);
      removed.write(DATA, data({}));
      expect(removed.run(guard).output).toContain(`${DATA}: jobs › semgrep: nothing`);
      const grown = makeRepo(pinned);
      grown.write(DATA, data({ semgrep: 'aaa' }, ['a', 'b', k('--exclude', '-rule')]));
      expect(grown.run(guard).output).toContain('[pin-loosened]');
      const added = makeRepo(pinned);
      added.write(DATA, data({ semgrep: 'aaa', e2e: 'ccc' }));
      expect(added.run(guard)).toMatchObject({ status: 0 });
    });

    it('passes a change a commit gives a reason for, and no later change to it', () => {
      const repo = makeRepo(pinned);
      repo.write(DATA, data({ semgrep: 'bbb' }));
      repo.write(PINS, pins.replace('PINS.job', 'PINS.jobs.semgrep'));
      repo.commit('Pin the job by its id\n\nPins changed: the job moved under its own id');
      const vouched = repo.run(guard);
      expect(vouched.status).toBe(0);
      expect(vouched.output).toContain('the job moved under its own id');
      repo.write(DATA, data({ semgrep: 'ccc' }));
      repo.commit('Change the job again');
      expect(repo.run(guard).output).toContain(`[pin-loosened] ${DATA}: jobs › semgrep: "ccc"`);
    });

    it('flags either file gone, deleted or renamed', () => {
      const deleted = makeRepo(pinned);
      deleted.remove(PINS);
      expect(deleted.run(guard).output).toContain(`[pin-removed] ${PINS}`);
      const renamed = makeRepo(pinned);
      renamed.git(['mv', DATA, 'scripts/test/pins.json']);
      renamed.commit('Rename the pins');
      expect(renamed.run(guard).output).toContain(`[pin-removed] ${DATA}`);
    });
  });

  it('leaves a job failed with pg-boss, or an assertion that fails on purpose, alone', () => {
    const repo = makeRepo();
    repo.write('apps/backend/test/q.test.ts', "await boss.fail('q', id);\nassert.fail('no');\n");
    expect(repo.run(guard)).toMatchObject({ status: 0 });
  });

  it('leaves retries in application code, and none in a runner’s config, alone', () => {
    const repo = makeRepo();
    repo.write('apps/backend/src/fetch.ts', k('export const options = { retri', 'es: 3 };\n'));
    repo.write('apps/web/playwright.config.ts', k('export default { retri', 'es: 0 };\n'));
    expect(repo.run(guard)).toMatchObject({ status: 0 });
  });

  // A commit that moves an assertion within its file vouches for nothing a later one removes.
  it('takes no reason for an assertion a commit only moved', () => {
    const test = "it('a', () => {\n  expect(1).toBe(1);\n});\nit('b', () => {});\n";
    const repo = makeRepo({ 'src/a.test.ts': test });
    repo.write(
      'src/a.test.ts',
      test.replace('  expect(1).toBe(1);\n', '') + '// moved\n  expect(1).toBe(1);\n',
    );
    repo.commit('Move it\n\nTests removed from src/a.test.ts: only moving the assertion here');
    repo.write('src/a.test.ts', test.replace('  expect(1).toBe(1);\n', ''));
    repo.commit('Drop it');
    expect(repo.run(guard).output).toContain('[assertion-removed] src/a.test.ts');
  });

  it.each([
    ['test-made-easier', 'src/a.test.ts', k('it.skip', "If(true)('a', () => {});\n")],
    ['test-made-easier', 'src/a.test.ts', k('it.run', "If(false)('a', () => {});\n")],
    ['test-made-easier', 'vitest.config.ts', k('  test: { passWithNo', 'Tests: true },\n')],
    ['test-made-easier', 'package.json', k('{ "vitest": { "passWithNo', 'Tests": true } }\n')],
    ['test-made-easier', 'apps/web/e2e/a.spec.ts', k('test.fix', "me('a', () => {});\n")],
    ['test-made-easier', 'apps/web/e2e/a.spec.ts', k('test.describe.fa', "il('a', () => {});\n")],
    ['test-made-easier', 'apps/web/e2e/a.spec.ts', k('  testInfo.fix', 'me();\n')],
    ['test-made-easier', 'apps/web/e2e/a.spec.ts', k('  test.info().fa', 'il();\n')],
    [
      'test-made-easier',
      'apps/web/e2e/a.spec.ts',
      k('test.describe.configure({ retri', 'es: 2 });\n'),
    ],
    ['test-made-easier', 'apps/web/playwright.config.ts', k('  retri', 'es: 1,\n')],
    ['test-made-easier', 'src/a.test.ts', k("it('a', { retr", 'y: 3 }, () => {});\n')],
    [
      'test-made-easier',
      'package.json',
      k('{ "scripts": { "test:e2e": "playwright test --pass-with-no', '-tests" } }\n'),
    ],
    ['silenced-checker', 'scripts/x.bash', `#!/bin/bash\n# ${SC_DISABLE}=SC2086\necho $1\n`],
    [
      'scanner-weakened',
      '.github/workflows/ci.yml',
      k("        run: printf 'x\\n' > .gitleaks", 'ignore\n'),
    ],
    [
      'scanner-weakened',
      '.github/workflows/ci.yml',
      k('        run: git update', '-ref refs/remotes/origin/main HEAD\n'),
    ],
  ])('flags %s in %s', (rule, path, text) => {
    const repo = makeRepo();
    repo.write(path, text);
    const result = repo.run(guard);
    expect(result.status).toBe(1);
    expect(result.output).toContain(`[${rule}]`);
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
});
