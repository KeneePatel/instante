import { describe, expect, it } from 'vitest';
import { OWNER, k, makeRepo } from './support/guard-repo.ts';

// scripts/check-commits.ts and scripts/check-agent-settings.ts, each run in a scratch repository
// (./support/guard-repo.ts).

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

  it('refuses a Dependabot commit, pointing at the takeover, and says nothing of it otherwise', () => {
    const repo = makeRepo();
    repo.write('a.txt', 'a');
    repo.commit(
      'Bump next from 16.4.5 to 16.4.6\n\nSigned-off-by: dependabot[bot] <bot@example.test>',
      { name: 'dependabot[bot]', email: 'bot@example.test' },
      { name: 'GitHub', email: 'committer@example.test' },
    );
    const { status, output } = repo.run(check);
    expect(status).toBe(1);
    expect(output).toContain('author is dependabot[bot]');
    expect(output).toContain('has trailers');
    expect(output).toContain('as AGENTS.md says under "Dependency updates"');
    const other = makeRepo();
    other.write('a.txt', 'a');
    other.commit('Add a', stranger);
    expect(other.run(check).output).not.toContain('Dependency updates');
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
