import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// How CI runs each check, pinned: CONSTRAINTS.md's floor, "No scanner told to look at less" and
// "This bar isn't weakened". The floor guard treats this file as part of the bar (its rule 10):
// a line taken out of it is flagged unless the commit that takes it out says why, in a line of
// its message, `Tests removed from scripts/test/scanner-pins.test.ts: <reason>`, and so is the
// file gone. So a job, script or command that runs a check differently fails here, and loosening
// a pin is loud. Adding a pin, or a job to CHECKING, needs no reason.

const REPO = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const BASH = '/bin/bash';
const read = (file: string): string => readFileSync(path.join(REPO, file), 'utf8');
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'instante-pins-'));
  made.push(dir);
  return dir;
}
/** A folder of executable bash stubs, for the front of PATH. */
function stubs(scripts: Record<string, string>): string {
  const dir = path.join(scratch(), 'bin');
  mkdirSync(dir);
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(path.join(dir, name), `#!/bin/bash\n${body}\n`);
    chmodSync(path.join(dir, name), 0o755);
  }
  return dir;
}
const lines = (file: string): string[] => readFileSync(file, 'utf8').trim().split('\n');

// Workflows, read as text: none uses anchors, merge keys or flow style (checked below), so a
// job is the block of lines under its two-space key in `jobs:`, comments left out.
const WORKFLOWS = readdirSync(path.join(REPO, '.github/workflows'))
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => `.github/workflows/${f}`);
const uncommented = (text: string): string[] =>
  text.split('\n').filter((l) => l.trim() !== '' && !/^\s*#/.test(l));
/** The lines under the top-level key given, comments and blank lines left out. */
function section(workflow: string, key: string): string[] {
  const all = read(workflow).split('\n');
  const start = all.indexOf(`${key}:`);
  if (start === -1) return [];
  const end = all.findIndex((l, i) => i > start && /^\S/.test(l));
  return uncommented(all.slice(start + 1, end === -1 ? undefined : end).join('\n'));
}
function jobs(workflow: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let body: string[] = [];
  for (const line of section(workflow, 'jobs')) {
    const id = /^ {2}([a-z][a-z0-9-]*):$/.exec(line)?.[1];
    if (id !== undefined) {
      body = [];
      out.set(id, body);
    } else body.push(line);
  }
  return out;
}

// The jobs whose checks decide a merge or a release, and the weekly scan.
const CHECKING: Record<string, string[]> = {
  '.github/workflows/ci.yml': [
    'install',
    'checks',
    'production-build',
    'guards',
    'gitleaks',
    'shellcheck',
    'osv-scanner',
    'semgrep',
  ],
  '.github/workflows/osv-weekly.yml': ['osv-scanner-weekly'],
};

// Each checking job's commands, as lines of the job.
const RUNS: Record<string, string[]> = {
  install: ['run: pnpm install --frozen-lockfile'],
  checks: [
    'run: pnpm format:check',
    'run: pnpm typecheck',
    'run: pnpm lint',
    'run: pnpm test:coverage',
    '--compare-branch=origin/main --fail-under=80',
  ],
  'production-build': ['run: bash scripts/prod-build-check.sh'],
  guards: ['run: pnpm floor-guard', 'run: pnpm check:commits', 'run: pnpm check:agent-settings'],
  gitleaks: ['set -euo pipefail', 'gitleaks git --redact --no-banner --log-opts="${base}..HEAD" .'],
  shellcheck: ['run: bash scripts/ci/shellcheck.sh'],
  'osv-scanner': ['run: bash scripts/ci/osv-scan.sh "$RUNNER_TEMP/osv.json"'],
  semgrep: ['run: bash scripts/ci/semgrep.sh', 'run: bash scripts/ci/semgrep-canary.sh'],
  'osv-scanner-weekly': ['run: bash scripts/ci/osv-scan.sh "$RUNNER_TEMP/osv.json"'],
};

describe('the workflows', () => {
  it('have every checking job, with no condition, allowed failure, shell or folder of its own', () => {
    for (const [workflow, ids] of Object.entries(CHECKING)) {
      const all = jobs(workflow);
      for (const id of ids) {
        const body = all.get(id) ?? [];
        expect(body.length, `${workflow}: ${id}`).toBeGreaterThan(0);
        const loose = body.filter(
          (l) =>
            /^\s*(- )?(if|continue-on-error|shell|working-directory|defaults)\s*:/.test(l) ||
            /\|\||\bset \+[eo]\b/.test(l),
        );
        expect(loose, `${workflow}: ${id}`).toEqual([]);
      }
    }
  });

  it('run each check exactly so', () => {
    for (const [workflow, ids] of Object.entries(CHECKING)) {
      const all = jobs(workflow);
      for (const id of ids) {
        const body = (all.get(id) ?? []).map((l) => l.trim());
        for (const command of RUNS[id] ?? []) {
          expect(body, `${workflow}: ${id}`).toContain(command);
        }
      }
    }
  });

  it('set no defaults, anchors or merge keys, and configure no scanner through the environment', () => {
    for (const workflow of WORKFLOWS) {
      const text = uncommented(read(workflow));
      expect(
        text.filter((l) => /^defaults\s*:|<<\s*:|:\s+[&*][A-Za-z]|^\s*-\s+[&*][A-Za-z]/.test(l)),
        workflow,
      ).toEqual([]);
      expect(
        text.filter((l) => /\b(SHELLCHECK_OPTS|GITLEAKS_CONFIG\w*)\b/.test(l)),
        workflow,
      ).toEqual([]);
    }
  });

  it('run CI on every push but Dependabot’s and every pull request, and the scan every Monday', () => {
    expect(section('.github/workflows/ci.yml', 'on')).toEqual([
      '  push:',
      '    branches-ignore:',
      "      - 'dependabot/**'",
      '  pull_request:',
    ]);
    expect(section('.github/workflows/osv-weekly.yml', 'on')).toEqual([
      '  schedule:',
      "    - cron: '23 7 * * 1'",
      '  workflow_dispatch:',
    ]);
  });
});

describe('package.json', () => {
  it('runs each command CI calls exactly so', () => {
    const { scripts } = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(scripts['format:check']).toBe('prettier --check .');
    expect(scripts['typecheck']).toBe('tsc --noEmit -p . && pnpm -r typecheck');
    expect(scripts['lint']).toBe('eslint --max-warnings 0 .');
    expect(scripts['test:coverage']).toBe('vitest run --coverage');
    expect(scripts['floor-guard']).toBe('node scripts/floor-guard.ts');
    expect(scripts['check:commits']).toBe('node scripts/check-commits.ts');
    expect(scripts['check:agent-settings']).toBe('node scripts/check-agent-settings.ts');
  });
});

describe('the scanners’ scripts', () => {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  const image = `semgrep/semgrep:1.183.0@sha256:${'0'.repeat(64)}`;

  it('run Semgrep from the pinned image with exactly these arguments', () => {
    const args = path.join(scratch(), 'args');
    const bin = stubs({ docker: 'printf "%s\\n" "$@" > "$ARGS_FILE"' });
    const result = spawnSync(BASH, ['scripts/ci/semgrep.sh'], {
      cwd: REPO,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        ARGS_FILE: args,
        SEMGREP_IMAGE: image,
        GITHUB_REF: 'refs/heads/main',
        BEFORE: head,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(lines(args)).toEqual([
      'run',
      '--rm',
      '--user',
      `${String(process.getuid?.())}:${String(process.getgid?.())}`,
      '-e',
      'HOME=/tmp',
      '-e',
      'SEMGREP_ENABLE_VERSION_CHECK=0',
      '-v',
      `${REPO}:/src`,
      '-w',
      '/src',
      image,
      'semgrep',
      'scan',
      '--config',
      'p/default',
      '--baseline-commit',
      head,
      '--severity',
      'ERROR',
      '--error',
      '--strict',
      '--metrics=off',
    ]);
  });

  it('run osv-scanner over the whole checkout with exactly these arguments', () => {
    const dir = scratch();
    const report = path.join(dir, 'report.json');
    writeFileSync(
      path.join(dir, 'fixture.json'),
      JSON.stringify({
        results: [
          {
            source: { path: 'pnpm-lock.yaml' },
            packages: [{ package: { name: 'pnpm' } }, { package: { name: 'next' } }],
          },
        ],
      }),
    );
    const bin = stubs({
      'osv-scanner': [
        'printf "%s\\n" "$@" > "$ARGS_FILE"',
        'while [ "$#" -gt 0 ]; do [ "$1" = --output-file ] && cp "$FIXTURE" "$2"; shift; done',
      ].join('\n'),
    });
    const result = spawnSync(BASH, ['scripts/ci/osv-scan.sh', report], {
      cwd: REPO,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        ARGS_FILE: path.join(dir, 'args'),
        FIXTURE: path.join(dir, 'fixture.json'),
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(lines(path.join(dir, 'args'))).toEqual([
      'scan',
      'source',
      '-r',
      '--all-packages',
      '--format',
      'json',
      '--output-file',
      report,
      '.',
    ]);
  });

  it('run ShellCheck with no rc file and none of SHELLCHECK_OPTS', () => {
    const dir = scratch();
    mkdirSync(path.join(dir, 'scripts'));
    writeFileSync(path.join(dir, 'scripts/a.sh'), 'echo a\n');
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: dir,
        env: { PATH: process.env['PATH'] ?? '', GIT_CONFIG_GLOBAL: '/dev/null' },
      });
    git('init', '-q');
    git('add', '-A');
    const bin = stubs({
      shellcheck: [
        'if [ "$1" = --version ]; then echo "version: 0.11.0"; exit 0; fi',
        'printf "%s\\n" "$@" > "$ARGS_FILE"',
        'echo "${SHELLCHECK_OPTS-unset}" > "$OPTS_FILE"',
      ].join('\n'),
    });
    const result = spawnSync(BASH, [path.join(REPO, 'scripts/ci/shellcheck.sh')], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env['PATH'] ?? ''}`,
        ARGS_FILE: path.join(dir, 'args'),
        OPTS_FILE: path.join(dir, 'opts'),
        SHELLCHECK_OPTS: '-e SC2086',
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(lines(path.join(dir, 'args'))).toEqual(['--norc', '--', 'scripts/a.sh']);
    expect(lines(path.join(dir, 'opts'))).toEqual(['unset']);
  });
});

describe('the dependency bar', () => {
  // The number in CONSTRAINTS.md's Dependencies row, and check-osv.ts failing from it on.
  it('fails at the CVSS score CONSTRAINTS.md names, and passes just below it', () => {
    const row = read('CONSTRAINTS.md')
      .split('\n')
      .find((l) => l.startsWith('| Dependencies |'));
    const bar = /fails on a CVSS score of (\d+\.\d) or more/.exec(row ?? '')?.[1];
    expect(bar).toBe('7.0');
    const judge = (score: string) => {
      const report = path.join(scratch(), 'report.json');
      writeFileSync(
        report,
        JSON.stringify({
          results: [
            {
              source: { path: 'pnpm-lock.yaml' },
              packages: [
                { package: { name: 'pnpm' } },
                { package: { name: 'next' } },
                {
                  package: { name: 'left-pad', version: '1.0.0' },
                  vulnerabilities: [{ id: 'GHSA-x', database_specific: { severity: 'MODERATE' } }],
                  groups: [{ ids: ['GHSA-x'], aliases: [], max_severity: score }],
                },
              ],
            },
          ],
        }),
      );
      return spawnSync(process.execPath, ['scripts/check-osv.ts', report], { cwd: REPO }).status;
    };
    expect(judge('7.0')).toBe(1);
    expect(judge('6.9')).toBe(0);
  });
});
