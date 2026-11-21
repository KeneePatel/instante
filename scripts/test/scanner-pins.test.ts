import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
// "This bar isn't weakened". The pins are data, in scanner-pins.json; this file checks the
// repository against them. The floor guard (its rule 10) treats both files as part of the bar:
//   - in scanner-pins.json, a value changed or removed needs a `Pins changed: <reason>` line in
//     the message of the commit that changes it; a pin added (a job, a file, a command) doesn't;
//   - in this file, any line added or removed needs that line, since an added line can switch a
//     pin off;
//   - either file gone is flagged.
// CI's guards job runs this file by its path, so a narrowed test include can't leave it out.
//
// Pinned: each workflow's top-level settings and each checking job, by hash once comment lines
// and the version each action is pinned at are dropped (so Dependabot's bumps pass, and any
// other change to a checking job, a step added or a key respelled, doesn't); no other job
// answering to a checking job's name; the scanners' scripts, check-osv.ts, Playwright's config
// and scripts/e2e-stack.sh, by hash; the root package.json commands CI calls, the end-to-end
// run's among them; each scanner's exact arguments and exit codes; ShellCheck's choice of files;
// and CONSTRAINTS.md's CVSS bar against check-osv.ts.

const REPO = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const BASH = '/bin/bash';
const read = (file: string): string => readFileSync(path.join(REPO, file), 'utf8');

interface Pins {
  workflows: Record<string, { top: string; jobs: Record<string, string> }>;
  files: Record<string, string>;
  commands: Record<string, string>;
  arguments: { semgrep: string[]; 'osv-scanner': string[]; shellcheck: string[] };
  cvss: string;
}
const PINS = JSON.parse(read('scripts/test/scanner-pins.json')) as Pins;

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

// Text as hashed: no blank or comment-only lines, no trailing space, and each action without
// the version it's pinned at.
function normal(text: string[], comment: RegExp): string {
  return text
    .filter((l) => l.trim() !== '' && !comment.test(l))
    .map((l) => l.trimEnd().replace(/^(\s*(?:- )?uses:\s*[^@\s]+)@\S+(?:\s+#.*)?$/, '$1@'))
    .join('\n');
}
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const YAML_COMMENT = /^\s*#/;

// A workflow, read as text: its lines outside `jobs:`, and each job's block, under its
// two-space key. Anything else at that depth in `jobs:` (a job in flow style, a quoted key)
// is reported as unparsed, so the reading can't be steered round.
interface Workflow {
  top: string[];
  jobs: Map<string, string[]>;
  jobsKeys: number;
  duplicates: string[];
  unparsed: string[];
}
function workflow(file: string): Workflow {
  const out: Workflow = { top: [], jobs: new Map(), jobsKeys: 0, duplicates: [], unparsed: [] };
  let inJobs = false;
  let body: string[] | null = null;
  for (const line of read(file).split('\n')) {
    if (/^[^\s#]/.test(line)) {
      inJobs = /^jobs\s*:\s*(#.*)?$/.test(line);
      if (inJobs) {
        out.jobsKeys += 1;
        body = null;
        continue;
      }
    }
    if (!inJobs) {
      out.top.push(line);
      continue;
    }
    const id = /^ {2}([A-Za-z_][\w-]*)\s*:\s*(#.*)?$/.exec(line)?.[1];
    if (id !== undefined) {
      if (out.jobs.has(id)) out.duplicates.push(id);
      body = [];
      out.jobs.set(id, body);
    } else if (/^ {0,2}[^\s#]/.test(line)) out.unparsed.push(line);
    else body?.push(line);
  }
  return out;
}
/** The name a job's check runs carry: its `name:`, or its id. */
const checkName = (id: string, body: string[]): string =>
  body
    .map((l) => /^ {4}['"]?name['"]?\s*:\s*['"]?([^'"#]*?)['"]?\s*(#.*)?$/.exec(l)?.[1])
    .find((n) => n !== undefined) ?? id;

const WORKFLOWS = readdirSync(path.join(REPO, '.github/workflows'))
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => `.github/workflows/${f}`);

describe('the workflows', () => {
  it('match the pins: each one’s settings and each checking job', () => {
    for (const [file, pin] of Object.entries(PINS.workflows)) {
      const w = workflow(file);
      expect(
        { jobsKeys: w.jobsKeys, duplicates: w.duplicates, unparsed: w.unparsed },
        file,
      ).toEqual({ jobsKeys: 1, duplicates: [], unparsed: [] });
      const top = normal(w.top, YAML_COMMENT);
      expect(hash(top), `${file}, outside jobs:\n${top}`).toBe(pin.top);
      for (const [id, pinned] of Object.entries(pin.jobs)) {
        const job = normal(w.jobs.get(id) ?? [], YAML_COMMENT);
        expect(hash(job), `${file}, job ${id}:\n${job}`).toBe(pinned);
      }
    }
  });

  // GitHub reports a skipped job as passing a required check, and every job that needs a
  // skipped one is skipped; the hashes above catch these too, this says why.
  it('give no checking job a condition, an allowed failure, a dependency or a shell of its own', () => {
    for (const [file, pin] of Object.entries(PINS.workflows)) {
      const w = workflow(file);
      for (const id of Object.keys(pin.jobs)) {
        const loose = (w.jobs.get(id) ?? []).filter(
          (l) =>
            /^\s*(- )?['"]?(if|continue-on-error|needs|shell|working-directory|defaults)['"]?\s*:/.test(
              l,
            ) || /\|\||\bset\s+\+\w*[eou]/.test(l),
        );
        expect(loose, `${file}: ${id}`).toEqual([]);
      }
    }
  });

  // The ruleset and `release` go by the check's name, so a stub job can't stand in for one.
  it('let no other job answer to a checking job’s name', () => {
    const checking = new Set<string>();
    for (const [file, pin] of Object.entries(PINS.workflows)) {
      const w = workflow(file);
      for (const id of Object.keys(pin.jobs)) {
        expect(checkName(id, w.jobs.get(id) ?? []), `${file}: ${id}`).toBe(id);
        checking.add(id);
      }
    }
    for (const file of WORKFLOWS) {
      const w = workflow(file);
      expect(w.unparsed, file).toEqual([]);
      for (const [id, body] of w.jobs) {
        if (PINS.workflows[file]?.jobs[id] !== undefined) continue;
        expect(checking.has(checkName(id, body)), `${file}: ${id}`).toBe(false);
      }
    }
  });
});

describe('the scripts', () => {
  it('match the pins: the scanners’ scripts and the dependency gate', () => {
    for (const [file, pinned] of Object.entries(PINS.files)) {
      const text = normal(read(file).split('\n'), file.endsWith('.ts') ? /^\s*\/\// : /^\s*#/);
      expect(hash(text), file).toBe(pinned);
    }
  });

  it('match the pins: the package.json commands CI calls', () => {
    const { scripts } = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    for (const [name, command] of Object.entries(PINS.commands)) {
      expect(scripts[name], name).toBe(command);
    }
  });
});

describe('the scanners', () => {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  const image = `semgrep/semgrep:1.183.0@sha256:${'0'.repeat(64)}`;
  const fill = (args: string[], values: Record<string, string>): string[] =>
    args.map((a) => a.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? `{${k}}`));

  function semgrep(exit: number) {
    const args = path.join(scratch(), 'args');
    const bin = stubs({ docker: `printf "%s\\n" "$@" > "$ARGS_FILE"\nexit ${String(exit)}` });
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
    return { status: result.status, args: lines(args), stderr: result.stderr };
  }

  it('run Semgrep from the pinned image with the pinned arguments, and pass on its exit', () => {
    const clean = semgrep(0);
    expect(clean.status, clean.stderr).toBe(0);
    expect(clean.args).toEqual(
      fill(PINS.arguments.semgrep, {
        uid: String(process.getuid?.()),
        gid: String(process.getgid?.()),
        repo: REPO,
        image,
        base: head,
      }),
    );
    expect(semgrep(1).status).toBe(1);
    expect(semgrep(2).status).toBe(2);
  });

  function osv(exit: number) {
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
        `exit ${String(exit)}`,
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
    return { status: result.status, args: lines(path.join(dir, 'args')), report };
  }

  it('run osv-scanner over the whole checkout with the pinned arguments, and fail when it does', () => {
    const clean = osv(0);
    expect(clean.status).toBe(0);
    expect(clean.args).toEqual(fill(PINS.arguments['osv-scanner'], { report: clean.report }));
    expect(osv(2).status).toBe(2);
  });

  it('run ShellCheck on the pinned files, with no rc file or SHELLCHECK_OPTS, and fail when it does', () => {
    const dir = scratch();
    const files: Record<string, string> = {
      'scripts/a.sh': 'echo a\n',
      'scripts/local/instante': '#!/usr/bin/env bash\necho launcher\n',
      'scripts/c': '#!/bin/sh\necho c\n',
      'scripts/b.ts': 'export {};\n',
      'scripts/d': '#!/usr/bin/env python3\n',
      'apps/x.sh': 'echo not under scripts\n',
    };
    for (const [file, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), body);
    }
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: dir,
        env: { PATH: process.env['PATH'] ?? '', GIT_CONFIG_GLOBAL: '/dev/null' },
      });
    git('init', '-q');
    git('add', '-A');
    const check = (exit: number) => {
      const bin = stubs({
        shellcheck: [
          'if [ "$1" = --version ]; then echo "version: 0.11.0"; exit 0; fi',
          'printf "%s\\n" "$@" > "$ARGS_FILE"',
          'echo "${SHELLCHECK_OPTS-unset}" > "$OPTS_FILE"',
          `exit ${String(exit)}`,
        ].join('\n'),
      });
      return spawnSync(BASH, [path.join(REPO, 'scripts/ci/shellcheck.sh')], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          PATH: `${bin}:${process.env['PATH'] ?? ''}`,
          ARGS_FILE: path.join(dir, 'args'),
          OPTS_FILE: path.join(dir, 'opts'),
          SHELLCHECK_OPTS: '-e SC2086',
        },
      });
    };
    const clean = check(0);
    expect(clean.status, clean.stderr).toBe(0);
    expect(lines(path.join(dir, 'args'))).toEqual(PINS.arguments.shellcheck);
    expect(lines(path.join(dir, 'opts'))).toEqual(['unset']);
    expect(check(1).status).toBe(1);
  });
});

describe('the dependency bar', () => {
  it('is the CVSS score CONSTRAINTS.md names, failing from it and passing just below', () => {
    const row = read('CONSTRAINTS.md')
      .split('\n')
      .find((l) => l.startsWith('| Dependencies |'));
    expect(/fails on a CVSS score of (\d+\.\d) or more/.exec(row ?? '')?.[1]).toBe(PINS.cvss);
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
    expect(judge(PINS.cvss)).toBe(1);
    expect(judge((Number(PINS.cvss) - 0.1).toFixed(1))).toBe(0);
  });
});
