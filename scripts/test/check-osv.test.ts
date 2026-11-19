import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// scripts/check-osv.ts, run on reports shaped as osv-scanner 2.7's JSON
// (`scan source -r --all-packages --format json`).

const SCRIPT = fileURLToPath(new URL('../check-osv.ts', import.meta.url));
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Advisory = Record<string, unknown>;
const pkg = (
  name: string,
  version: string,
  vulnerabilities: Advisory[] = [],
  groups: Record<string, unknown>[] = [],
) => ({ package: { name, version, ecosystem: 'npm' }, vulnerabilities, groups });
/** A report of the lockfile with both its documents read: pnpm's own packages and next. */
const report = (...extra: ReturnType<typeof pkg>[]) => ({
  results: [
    {
      source: { path: '/runner/work/instante/pnpm-lock.yaml', type: 'lockfile' },
      packages: [pkg('pnpm', '12.18.0'), pkg('next', '16.4.5'), ...extra],
    },
  ],
});
const ghsa = (id: string, severity?: string, aliases: string[] = []): Advisory => ({
  id,
  aliases,
  ...(severity === undefined ? {} : { database_specific: { severity } }),
});
const group = (ids: string[], maxSeverity: string) => ({
  ids,
  aliases: [],
  max_severity: maxSeverity,
});

function run(contents: unknown, env: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'instante-osv-'));
  made.push(dir);
  const file = path.join(dir, 'report.json');
  writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  const result = spawnSync(process.execPath, [SCRIPT, file], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', ...env },
  });
  return { status: result.status, output: result.stdout + result.stderr, dir };
}

describe('check-osv', () => {
  it('passes a report with no advisory, counting the lockfile’s packages', () => {
    const result = run(report());
    expect(result.status).toBe(0);
    expect(result.output).toContain(
      '2 package names in pnpm-lock.yaml, 0 advisory group(s), 0 at high',
    );
  });

  it.each([
    ['a CVSS score of 9.8', [ghsa('GHSA-aaaa')], [group(['GHSA-aaaa'], '9.8')], 'CVSS 9.8'],
    ['a CVSS score of exactly 7.0', [ghsa('GHSA-aaaa')], [group(['GHSA-aaaa'], '7.0')], 'CVSS 7.0'],
    [
      'no score, but rated HIGH in words',
      [ghsa('GHSA-aaaa', 'HIGH')],
      [group(['GHSA-aaaa'], '')],
      'rated HIGH',
    ],
    [
      'a low score, but one advisory of the group rates it CRITICAL',
      [ghsa('GHSA-aaaa', 'CRITICAL'), ghsa('CVE-2026-1')],
      [group(['GHSA-aaaa', 'CVE-2026-1'], '5.0')],
      'rated CRITICAL',
    ],
    [
      'no severity at all',
      [ghsa('GHSA-aaaa')],
      [group(['GHSA-aaaa'], '')],
      'no severity given, which counts as high',
    ],
    [
      'a malicious package, whatever its score',
      [ghsa('MAL-2026-1', 'LOW')],
      [group(['MAL-2026-1'], '0.0')],
      'a malicious package',
    ],
    [
      'a malicious package named only as an alias',
      [ghsa('GHSA-aaaa', 'MODERATE', ['MAL-2026-2'])],
      [group(['GHSA-aaaa'], '')],
      'a malicious package',
    ],
    [
      'an advisory left out of every group, so with no score',
      [ghsa('GHSA-aaaa')],
      [],
      'no severity',
    ],
  ])('fails on %s, naming the package and why', (_case, advisories, groups, why) => {
    const result = run(report(pkg('left-pad', '1.0.0', advisories, groups)));
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/HIGH {3}GHSA-aaaa|HIGH {3}MAL-2026-1/);
    expect(result.output).toContain('left-pad@1.0.0 (npm, pnpm-lock.yaml)');
    expect(result.output).toContain(why);
  });

  it.each([
    ['a CVSS score of 6.9', [ghsa('GHSA-aaaa')], [group(['GHSA-aaaa'], '6.9')], 'CVSS 6.9'],
    [
      'no score, rated MODERATE',
      [ghsa('GHSA-aaaa', 'MODERATE')],
      [group(['GHSA-aaaa'], '')],
      'rated MODERATE',
    ],
    [
      'no score, rated LOW, in the camelCase form',
      [{ id: 'GHSA-aaaa', databaseSpecific: { severity: 'low' } }],
      [group(['GHSA-aaaa'], '')],
      'rated LOW',
    ],
  ])('passes %s, listing it below high', (_case, advisories, groups, why) => {
    const result = run(report(pkg('left-pad', '1.0.0', advisories, groups)));
    expect(result.status).toBe(0);
    expect(result.output).toContain(
      `below  GHSA-aaaa  left-pad@1.0.0 (npm, pnpm-lock.yaml): ${why}`,
    );
  });

  it('fails when the lockfile wasn’t read whole, or at all', () => {
    const onlyPnpm = report();
    onlyPnpm.results[0]?.packages.splice(1, 1);
    expect(run(onlyPnpm)).toMatchObject({ status: 1 });
    expect(run(onlyPnpm).output).toContain(
      "don't include next: its two documents weren't both read",
    );
    const onlyProject = report();
    onlyProject.results[0]?.packages.splice(0, 1);
    expect(run(onlyProject).output).toContain("don't include pnpm");
    const noLockfile = { results: [{ source: { path: '/r/requirements.txt' }, packages: [] }] };
    expect(run(noLockfile)).toMatchObject({ status: 1 });
    expect(run(noLockfile).output).toContain('the report has no pnpm-lock.yaml');
  });

  it('exits 2 on a report it can’t read', () => {
    expect(run('{ not json').status).toBe(2);
    expect(run({ packages: [] }).status).toBe(2);
    expect(run('null').status).toBe(2);
  });

  it('writes its findings to the job’s summary when there is one', () => {
    const { dir } = run(report());
    const summary = path.join(dir, 'summary.md');
    const high = report(
      pkg('left-pad', '1.0.0', [ghsa('GHSA-aaaa')], [group(['GHSA-aaaa'], '9.8')]),
    );
    writeFileSync(path.join(dir, 'report.json'), JSON.stringify(high));
    const result = spawnSync(process.execPath, [SCRIPT, path.join(dir, 'report.json')], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', GITHUB_STEP_SUMMARY: summary },
    });
    expect(result.status).toBe(1);
    expect(readFileSync(summary, 'utf8')).toContain('HIGH   GHSA-aaaa  left-pad@1.0.0');
  });
});
