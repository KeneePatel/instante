import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// scripts/ci/*.sh, each run with stubs on PATH in place of the tools CI downloads (curl,
// ShellCheck, osv-scanner), or in a scratch git repository.

const CI = fileURLToPath(new URL('../ci/', import.meta.url));
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const BASH = existsSync('/bin/bash') ? '/bin/bash' : 'bash';
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'instante-ci-'));
  made.push(dir);
  return dir;
}

/** A folder of executable stubs, each a bash script, for the front of PATH. */
function stubs(scripts: Record<string, string>): string {
  const dir = path.join(scratch(), 'bin');
  mkdirSync(dir);
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(path.join(dir, name), `#!/bin/bash\n${body}\n`);
    chmodSync(path.join(dir, name), 0o755);
  }
  return dir;
}

function run(
  script: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
) {
  const result = spawnSync(BASH, [path.join(CI, script), ...args], {
    cwd: options.cwd ?? REPO,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ...options.env },
  });
  return { status: result.status, stdout: result.stdout, output: result.stdout + result.stderr };
}

describe('fetch-checked.sh', () => {
  const CONTENT = 'a release file\n';
  // sha256 of CONTENT.
  const SHA = '1fe59ee6454cdea118d4f0a67e551bf121341b1b24ad1ee45c9aaeb241d6c013';
  // A curl that saves CONTENT to the -o file and records its arguments, or fails with $FAIL.
  const curl = () =>
    stubs({
      curl: [
        'printf "%s\\n" "$@" > "$ARGS_FILE"',
        '[ -n "${FAIL:-}" ] && exit "$FAIL"',
        'while [ "$#" -gt 0 ]; do [ "$1" = -o ] && { printf "a release file\\n" > "$2"; }; shift; done',
      ].join('\n'),
    });

  function fetch(args: string[], extra: Record<string, string> = {}) {
    const dir = scratch();
    const bin = curl();
    const args_file = path.join(dir, 'args');
    const result = run(
      'fetch-checked.sh',
      args.map((a) => a.replace('$DIR', dir)),
      {
        env: { PATH: `${bin}:/usr/bin:/bin:/sbin`, ARGS_FILE: args_file, ...extra },
      },
    );
    return { ...result, dir, args: existsSync(args_file) ? readFileSync(args_file, 'utf8') : '' };
  }

  it('saves a file whose SHA-256 matches, asking curl for HTTPS only, with retries', () => {
    expect(
      execFileSync(
        '/bin/bash',
        [
          '-c',
          `printf '${CONTENT.replace('\n', '\\n')}' | (sha256sum 2>/dev/null || shasum -a 256) | cut -d ' ' -f 1`,
        ],
        {
          encoding: 'utf8',
        },
      ).trim(),
    ).toBe(SHA);
    const result = fetch(['https://example.test/tool.tar.gz', SHA, '$DIR/tool.tar.gz']);
    expect(result.status).toBe(0);
    expect(readFileSync(path.join(result.dir, 'tool.tar.gz'), 'utf8')).toBe(CONTENT);
    expect(result.args.split('\n')).toEqual(
      expect.arrayContaining(['--proto', '=https', '--proto-redir', '=https', '--retry', '3']),
    );
  });

  it('removes a file whose SHA-256 differs, and exits 1', () => {
    const other = SHA.replace(/^1/, '2');
    const result = fetch(['https://example.test/tool.tar.gz', other, '$DIR/tool.tar.gz']);
    expect(result.status).toBe(1);
    expect(result.output).toContain(`has SHA-256 ${SHA}, not the pinned ${other}`);
    expect(existsSync(path.join(result.dir, 'tool.tar.gz'))).toBe(false);
  });

  it('exits 1 when the download fails, leaving nothing', () => {
    const result = fetch(['https://example.test/tool.tar.gz', SHA, '$DIR/tool.tar.gz'], {
      FAIL: '22',
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain("couldn't download");
    expect(existsSync(path.join(result.dir, 'tool.tar.gz'))).toBe(false);
  });

  it.each([
    [['https://example.test/x', SHA], 'usage'],
    [['https://example.test/x', SHA.toUpperCase(), '$DIR/x'], "isn't a SHA-256"],
    [['https://example.test/x', SHA.slice(1), '$DIR/x'], "isn't a SHA-256"],
    [['http://example.test/x', SHA, '$DIR/x'], "isn't an https:// address"],
  ])('refuses %j, downloading nothing', (args, said) => {
    const result = fetch(args);
    expect(result.status).toBe(2);
    expect(result.output).toContain(said);
    expect(result.args).toBe('');
  });
});

describe('scan-base.sh', () => {
  // main: a, b (origin/main), then c on main itself; feature: b, then d.
  function repo() {
    const dir = scratch();
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: dir,
        encoding: 'utf8',
        env: {
          PATH: process.env['PATH'] ?? '',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_AUTHOR_NAME: 'T',
          GIT_AUTHOR_EMAIL: 't@example.test',
          GIT_COMMITTER_NAME: 'T',
          GIT_COMMITTER_EMAIL: 't@example.test',
        },
      }).trim();
    git('init', '-q', '-b', 'main');
    const commit = (m: string) => {
      git('commit', '-q', '--allow-empty', '-m', m);
      return git('rev-parse', 'HEAD');
    };
    const a = commit('a');
    const b = commit('b');
    git('update-ref', 'refs/remotes/origin/main', b);
    git('switch', '-q', '-c', 'feature');
    const d = commit('d');
    git('switch', '-q', 'main');
    const c = commit('c');
    git('update-ref', 'refs/remotes/origin/main', c);
    return { dir, git, a, b, c, d };
  }
  const base = (dir: string, env: Record<string, string>) =>
    run('scan-base.sh', [], { cwd: dir, env: { PATH: process.env['PATH'] ?? '', ...env } });

  it('takes the commit main was at before a push to main', () => {
    const r = repo();
    expect(base(r.dir, { GITHUB_REF: 'refs/heads/main', BEFORE: r.a }).stdout.trim()).toBe(r.a);
  });

  it('takes the merge base with origin/main for a branch, a pull request, or a push to main with no usable before', () => {
    const r = repo();
    r.git('switch', '-q', 'feature');
    expect(base(r.dir, { GITHUB_REF: 'refs/heads/feature', BEFORE: r.a }).stdout.trim()).toBe(r.b);
    expect(base(r.dir, { GITHUB_REF: 'refs/pull/7/merge' }).stdout.trim()).toBe(r.b);
    r.git('switch', '-q', 'main');
    for (const before of ['0000000000000000000000000000000000000000', 'f'.repeat(40), '']) {
      const result = base(r.dir, { GITHUB_REF: 'refs/heads/main', BEFORE: before });
      expect(result.stdout.trim(), before).toBe(r.c);
      expect(result.output).toContain("the base is HEAD, so there's nothing new to scan");
    }
  });

  it('exits 2 when there is no origin/main to compare with', () => {
    const r = repo();
    r.git('update-ref', '-d', 'refs/remotes/origin/main');
    const result = base(r.dir, { GITHUB_REF: 'refs/heads/main' });
    expect(result.status).toBe(2);
    expect(result.output).toContain('no merge base with origin/main');
  });
});

describe('shellcheck.sh', () => {
  // A repository holding scripts of each kind, and a ShellCheck that records what it's given.
  function repo(files: Record<string, string>) {
    const dir = scratch();
    for (const [file, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), body);
    }
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: dir,
        env: {
          PATH: process.env['PATH'] ?? '',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      });
    git('init', '-q');
    git('add', '-A');
    return dir;
  }
  const shellcheck = (status = 0) =>
    stubs({
      shellcheck: `if [ "$1" = --version ]; then echo "version: 0.11.0"; exit 0; fi\nprintf "%s\\n" "$@" > "$ARGS_FILE"\nexit ${String(status)}`,
    });

  it('checks every tracked shell script in scripts/, by extension or by its first line', () => {
    const dir = repo({
      'scripts/a.sh': 'echo a\n',
      'scripts/local/instante': '#!/usr/bin/env bash\necho launcher\n',
      'scripts/c': '#!/bin/sh\necho c\n',
      'scripts/b.ts': 'export {};\n',
      'scripts/d': '#!/usr/bin/env python3\n',
      'scripts/empty': '',
      'apps/x.sh': 'echo not under scripts\n',
    });
    writeFileSync(path.join(dir, 'scripts/untracked.sh'), 'echo u\n');
    const args = path.join(dir, 'args');
    const result = run('shellcheck.sh', [], {
      cwd: dir,
      env: { PATH: `${shellcheck()}:${process.env['PATH'] ?? ''}`, ARGS_FILE: args },
    });
    expect(result.status).toBe(0);
    expect(result.output).toContain('ShellCheck 0.11.0');
    expect(readFileSync(args, 'utf8').trim().split('\n').sort()).toEqual([
      '--',
      '--norc',
      'scripts/a.sh',
      'scripts/c',
      'scripts/local/instante',
    ]);
  });

  it("exits 1 on ShellCheck's findings", () => {
    const dir = repo({ 'scripts/a.sh': 'echo $1\n' });
    const result = run('shellcheck.sh', [], {
      cwd: dir,
      env: {
        PATH: `${shellcheck(1)}:${process.env['PATH'] ?? ''}`,
        ARGS_FILE: path.join(dir, 'args'),
      },
    });
    expect(result.status).toBe(1);
  });

  it('exits 2 with no script to check, or no ShellCheck', () => {
    const none = repo({ 'scripts/b.ts': 'export {};\n' });
    expect(
      run('shellcheck.sh', [], {
        cwd: none,
        env: {
          PATH: `${shellcheck()}:${process.env['PATH'] ?? ''}`,
          ARGS_FILE: path.join(none, 'args'),
        },
      }),
    ).toMatchObject({ status: 2 });
    const some = repo({ 'scripts/a.sh': 'echo a\n' });
    // An empty PATH: the runner's own ShellCheck (apt's) is in /usr/bin.
    const missing = run('shellcheck.sh', [], { cwd: some, env: { PATH: stubs({}) } });
    expect(missing.status).toBe(2);
    expect(missing.output).toContain("shellcheck isn't on PATH");
  });
});

describe('osv-scan.sh', () => {
  const clean = {
    results: [
      {
        source: { path: 'pnpm-lock.yaml' },
        packages: [{ package: { name: 'pnpm' } }, { package: { name: 'next' } }],
      },
    ],
  };
  const high = {
    results: [
      {
        source: { path: 'pnpm-lock.yaml' },
        packages: [
          { package: { name: 'pnpm' } },
          { package: { name: 'next' } },
          {
            package: { name: 'left-pad', version: '1.0.0' },
            vulnerabilities: [{ id: 'GHSA-a' }],
            groups: [{ ids: ['GHSA-a'], max_severity: '9.1' }],
          },
        ],
      },
    ],
  };
  // An osv-scanner that writes REPORT to --output-file, records its arguments, and exits $EXIT.
  function scan(report: unknown, exit: number) {
    const dir = scratch();
    writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify(report));
    const bin = stubs({
      'osv-scanner': [
        'printf "%s\\n" "$@" > "$ARGS_FILE"',
        'while [ "$#" -gt 0 ]; do [ "$1" = --output-file ] && cp "$FIXTURE" "$2"; shift; done',
        `exit ${String(exit)}`,
      ].join('\n'),
    });
    const result = run('osv-scan.sh', [path.join(dir, 'report.json')], {
      env: {
        PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        ARGS_FILE: path.join(dir, 'args'),
        FIXTURE: path.join(dir, 'fixture.json'),
      },
    });
    return { ...result, args: readFileSync(path.join(dir, 'args'), 'utf8').trim().split('\n') };
  }

  it('scans the whole checkout for every package, then judges the report', () => {
    const result = scan(clean, 0);
    expect(result.status).toBe(0);
    expect(result.args).toEqual(
      expect.arrayContaining(['scan', 'source', '-r', '--all-packages', '--format', 'json', '.']),
    );
  });

  it("passes osv-scanner's exit 1, an advisory found, to the gate", () => {
    const below = scan(clean, 1);
    expect(below.status).toBe(0);
    const result = scan(high, 1);
    expect(result.status).toBe(1);
    expect(result.output).toContain('HIGH   GHSA-a');
  });

  it.each([127, 128, 2])('exits 2 when osv-scanner itself fails with %i', (exit) => {
    const result = scan(clean, exit);
    expect(result.status).toBe(2);
    expect(result.output).toContain(`osv-scanner failed with exit ${String(exit)}`);
  });
});

describe('semgrep-canary.sh', () => {
  // A docker that answers each call with the next exit code given, recording its arguments;
  // CI runs the real image.
  function canary(codes: number[]) {
    const dir = scratch();
    writeFileSync(path.join(dir, 'codes'), `${codes.join('\n')}\n`);
    const bin = stubs({
      docker: [
        'n=$(( $(cat "$DIR/count" 2>/dev/null || echo 0) + 1 ))',
        'echo "$n" > "$DIR/count"',
        'printf "%s\\n" "$@" > "$DIR/args.$n"',
        'exit "$(sed -n "${n}p" "$DIR/codes")"',
      ].join('\n'),
    });
    const result = run('semgrep-canary.sh', [], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        DIR: dir,
        RUNNER_TEMP: dir,
        SEMGREP_IMAGE: 'semgrep/semgrep:1@sha256:abc',
      },
    });
    const args = (n: number) => readFileSync(path.join(dir, `args.${String(n)}`), 'utf8');
    return { ...result, args };
  }

  it('passes when the base’s finding passes and a new one fails', () => {
    const result = canary([0, 1]);
    expect(result.status).toBe(0);
    const first = result.args(1).trim().split('\n');
    expect(first).toEqual(
      expect.arrayContaining(['--config', '/rules/canary.yml', '--error', '--strict']),
    );
    const base = first[first.indexOf('--baseline-commit') + 1];
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    expect(result.args(2)).toContain(base);
  });

  it.each([
    [[1, 1], 1, 'the base’s finding counted'],
    [[0, 0], 1, 'a new finding missed'],
    [[2, 1], 2, 'Semgrep itself failing'],
  ])('fails on %j with exit %i: %s', (codes, status) => {
    const result = canary(codes);
    expect(result.status).toBe(status);
    expect(result.output).toContain('expected exit 0 with the base');
  });
});
