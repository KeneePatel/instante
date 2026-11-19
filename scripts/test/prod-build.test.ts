import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// scripts/prod-build/web-sources.ts, on fake builds: server source maps whose sources are, as
// Turbopack writes them, URL-encoded paths relative to each map. scripts/prod-build-check.sh
// runs it, with the relay and selftest, against a real build in the production-build job.

const SCRIPT = fileURLToPath(new URL('../prod-build/web-sources.ts', import.meta.url));
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const EVERY_BUILD = ['apps/web/instrumentation.ts', 'apps/web/proxy.ts', 'apps/web/app/layout.tsx'];

/** A repository whose build has the maps given: their file under .next/server, and contents. */
function build(maps: Record<string, unknown>) {
  const root = mkdtempSync(path.join(tmpdir(), 'instante-web-sources-'));
  made.push(root);
  for (const [file, map] of Object.entries(maps)) {
    const full = path.join(root, 'apps/web/.next/server', file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, typeof map === 'string' ? map : JSON.stringify(map));
  }
  return root;
}
/** A source, as a map at .next/server/<depth folders>/x.js.map lists a repository file. */
const from = (depth: number, file: string) =>
  `${'../'.repeat(depth + 4)}${file}`.split('/').map(encodeURIComponent).join('/');
const run = (root: string | undefined) => {
  const result = spawnSync(process.execPath, root === undefined ? [SCRIPT] : [SCRIPT, root], {
    encoding: 'utf8',
  });
  return { status: result.status, output: result.stdout + result.stderr };
};

describe('web-sources', () => {
  it('passes a build whose maps list only the app’s own files and its packages', () => {
    const root = build({
      'chunks/a.js.map': { sources: EVERY_BUILD.map((f) => from(1, f)) },
      'app/page/b.js.map': {
        sources: [
          from(2, 'apps/web/lib/api.ts'),
          from(2, 'node_modules/.pnpm/x@1/node_modules/x/test/helper.js'),
          `${'../'.repeat(7)}outside/test/x.ts`,
        ],
      },
    });
    const result = run(root);
    expect(result.status).toBe(0);
    expect(result.output).toContain('2 server source maps list 4 of the repository');
  });

  it.each([
    ['a test folder', 'apps/backend/test/db-harness.ts'],
    ['an e2e folder', 'apps/web/e2e/skeleton.spec.ts'],
    ['a test file', 'apps/web/lib/api.test.ts'],
    ['a tsx test file', 'apps/web/components/screen.test.tsx'],
    ['a path with spaces', 'apps/web/test/a b.ts'],
  ])('fails on a source in %s, naming it', (_case, file) => {
    const root = build({
      'chunks/a.js.map': { sources: [...EVERY_BUILD.map((f) => from(1, f)), from(1, file)] },
    });
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain(`the build holds ${file}`);
  });

  it('reads the sections of an index map', () => {
    const root = build({
      'chunks/a.js.map': {
        sections: [
          { map: { sources: EVERY_BUILD.map((f) => from(1, f)) } },
          { map: { sources: [from(1, 'packages/contract/test/x.ts')] } },
        ],
      },
    });
    expect(run(root)).toMatchObject({ status: 1 });
  });

  it('fails when the maps don’t list the files every build has, so listing nothing can’t pass', () => {
    const root = build({ 'chunks/a.js.map': { sources: [from(1, 'apps/web/proxy.ts')] } });
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "don't list apps/web/instrumentation.ts, apps/web/app/layout.tsx, which every build has",
    );
    expect(run(build({ 'chunks/a.js': 'no maps' }))).toMatchObject({ status: 1 });
  });

  it('exits 2 with no build, or a map it can’t read', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'instante-web-sources-'));
    made.push(empty);
    expect(run(empty).status).toBe(2);
    expect(run(build({ 'chunks/a.js.map': '{ broken' })).status).toBe(2);
  });
});

// scripts/prod-build/procs.sh, sourced in macOS's bash 3.2 (Linux's bash in CI) under `set -u`,
// in a scratch folder. helpers.sh holds the tests' own shell: `serve <file>` has web()'s shape
// in the check, a subshell that execs the process, so the process is a grandchild of whoever
// starts it, and writes its pid to <file>; `report <file>` says whether that process is still
// running, then stops it. check.sh, when a test gives one, is a check: it sources procs.sh and
// calls procs_setup on ./work, and `run_check` starts it as a terminal starts a job, in a process
// group of its own, so an INT to that group is a Ctrl-C.
const PROCS = fileURLToPath(new URL('../prod-build/procs.sh', import.meta.url));
const HELPERS = String.raw`
serve() { (exec sh -c 'echo $$ >"$0"; exec sleep 8' "$1"); }
server() { serve child.pid; }
report() {
  sleep 0.3
  if [ ! -s "$1" ]; then echo "$1=never-started"
  elif kill -0 "$(cat "$1")" 2>/dev/null; then echo "$1=running"; kill -KILL "$(cat "$1")"
  else echo "$1=stopped"; fi
}
appears() {
  local n=0
  until [ -s "$1" ]; do sleep 0.1; n=$((n + 1)); [ "$n" -lt 100 ] || return 1; done
}
run_check() {
  set -m
  /bin/bash check.sh "$PROCS" >check.log 2>&1 &
  check=$!
  set +m
}
folder() { if [ -d work ]; then echo work=left; else echo work=gone; fi; }
`;
function withProcs(body: string, check?: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'instante-procs-'));
  made.push(dir);
  writeFileSync(path.join(dir, 'helpers.sh'), HELPERS);
  if (check !== undefined) {
    const setup = 'procs_setup "$PWD/work" || exit 2\necho "$procs_watchdog" >wd.pid';
    writeFileSync(
      path.join(dir, 'check.sh'),
      `set -u -o pipefail\n. "$1" || exit 2\n. ./helpers.sh\n${setup}\n${check}\n`,
    );
  }
  const script = `set -u -o pipefail\nPROCS="$1"\n. "$1" || exit 2\n. ./helpers.sh\n${body}`;
  const result = spawnSync('/bin/bash', ['-c', script, 'bash', PROCS], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 40_000,
  });
  return { status: result.status, output: result.stdout + result.stderr };
}
const tookAtMost = (output: string, seconds: number) => {
  expect(Number(/took=(\d+)/.exec(output)?.[1])).toBeLessThanOrEqual(seconds);
};

// A deadline of 2 seconds, since SECONDS counts whole seconds of the clock: `run_for 1` can end
// at the next tick, before the command has started.
describe('procs.sh: run_for', () => {
  it('stops everything the command started at its deadline, a grandchild included', () => {
    const { output } = withProcs(`
start=$SECONDS
run_for 2 server >out.log 2>&1
echo "status=$? took=$((SECONDS - start)) running=[$running]"
report child.pid`);
    expect(output).toContain('status=124');
    expect(output).toContain('running=[]');
    expect(output).toContain('child.pid=stopped');
    tookAtMost(output, 4);
  }, 20_000);

  it('returns at its deadline inside $(...), though a child would hold the output open', () => {
    const { output } = withProcs(`
start=$SECONDS
out="$(run_for 2 server 2>&1)"
echo "status=$? took=$((SECONDS - start))"
report child.pid`);
    expect(output).toContain('status=124');
    expect(output).toContain('child.pid=stopped');
    tookAtMost(output, 4);
  }, 20_000);

  it('returns 125 for a command that ends but leaves a process running, and stops it', () => {
    const { output } = withProcs(`
run_for 5 sh -c 'sleep 8 & echo $! >child.pid; exit 0' >out.log 2>&1
status=$?
echo "status=$status running=[$running] said=[$(ended_as "$status")]"
report child.pid`);
    expect(output).toContain('status=125 running=[] said=[ended, but left a process running]');
    expect(output).toContain('child.pid=stopped');
  }, 20_000);

  it('gives a child that’s still exiting a moment, rather than calling it left running', () => {
    const { output } = withProcs(`
run_for 5 sh -c '(sleep 0.4) & exit 7' >out.log 2>&1
status=$?
echo "status=$status running=[$running] said=[$(ended_as "$status")]"`);
    expect(output).toContain('status=7 running=[] said=[exit 7]');
  }, 20_000);

  it('passes on the command’s own status, and its output as the caller sends it', () => {
    const { output } = withProcs(`
run_for 5 sh -c 'echo said; echo problem >&2; exit 78' >out.log 2>err.log
echo "status=$? out=$(cat out.log) err=$(cat err.log) running=[$running]"`);
    expect(output).toContain('status=78 out=said err=problem running=[]');
  }, 20_000);

  // On macOS a child being forked as the group's KILL lands joins the group without it, so one
  // KILL can leave a process behind; here the command's three loops fork without stop when its
  // deadline comes (each loop ends within 6 seconds, whatever happens). A single KILL left
  // something in about two runs in three; Linux, which restarts such a fork, shouldn't.
  it('leaves nothing in the group of a command that’s forking at its deadline', () => {
    const { output } = withProcs(`
loop() { end=$((SECONDS + 6)); while [ "$SECONDS" -lt "$end" ]; do sleep 8 & kill -KILL $! 2>/dev/null; done; }
busy() { (loop) & (loop) & (loop); }
left=0
for i in 1 2 3 4 5 6; do
  run_for 1 busy >out.log 2>&1
  leader=$!
  sleep 0.2
  if pgrep -g "$leader" >/dev/null; then left=$((left + 1)); pkill -KILL -g "$leader"; fi
done
echo "left=$left"`);
    expect(output).toContain('left=0');
  }, 40_000);
});

describe('procs.sh: the check stopping', () => {
  const after = `
run_check
wait "$check"
echo "check=$?"
`;

  it('a TERM during a case stops it, the watchdog and the folder', () => {
    const { output } = withProcs(
      `run_check
appears child.pid
kill -TERM "$check"
wait "$check"
echo "check=$?"
report child.pid; report wd.pid; folder`,
      'run_for 30 server >case.log 2>&1\necho not-stopped',
    );
    expect(output).toContain('check=143');
    expect(output).toContain('child.pid=stopped');
    expect(output).toContain('wd.pid=stopped');
    expect(output).toContain('work=gone');
  }, 20_000);

  // The case runs in a group of its own, which a Ctrl-C doesn't reach: the check's trap stops it.
  it('a Ctrl-C during a case stops it', () => {
    const { output } = withProcs(
      `run_check
appears child.pid
kill -INT -- "-$check"
wait "$check"
echo "check=$?"
report child.pid; folder`,
      'run_for 30 server >case.log 2>&1\necho not-stopped',
    );
    expect(output).toContain('check=130');
    expect(output).toContain('child.pid=stopped');
    expect(output).toContain('work=gone');
  }, 20_000);

  // As if the TERM came between launch's fork and the caller recording the group.
  it('a trap during a launch, after its fork, stops what it started', () => {
    const { output } = withProcs(
      `${after}report child.pid; folder`,
      `launch_before="\${!:-}"; launch_pending=yes; set -m; server </dev/null >/dev/null 2>&1 &
set +m
appears child.pid
kill -TERM $$
sleep 5`,
    );
    expect(output).toContain('check=143');
    expect(output).toContain('child.pid=stopped');
    expect(output).toContain('work=gone');
  }, 20_000);

  // $! is then still the group before, as a group start or run_for made would be.
  it('a trap during a launch, before its fork, stops nothing else', () => {
    const { output } = withProcs(
      `${after}report other.pid`,
      `set -m; sleep 8 & echo $! >other.pid
set +m
launch_before="\${!:-}"; launch_pending=yes
kill -TERM $$
sleep 5`,
    );
    expect(output).toContain('check=143');
    expect(output).toContain('other.pid=running');
  }, 20_000);

  // A KILL to the check's group, as a harness's timeout sends, reaches neither the case's group
  // nor start's: the watchdog stops them.
  it('the watchdog stops everything when the check is killed outright', () => {
    const { output } = withProcs(
      `run_check
appears srv.pid; appears child.pid
kill -KILL -- "-$check"
wait "$check" 2>/dev/null
n=0
while { kill -0 "$(cat srv.pid)" || kill -0 "$(cat child.pid)" || [ -d work ]; } 2>/dev/null && [ "$n" -lt 80 ]; do
  sleep 0.1; n=$((n + 1))
done
report srv.pid; report child.pid; folder
grep -c 'killed before it stopped its processes' check.log`,
      'start srv serve srv.pid\nrun_for 30 server >case.log 2>&1',
    );
    expect(output).toContain('srv.pid=stopped');
    expect(output).toContain('child.pid=stopped');
    expect(output).toContain('work=gone');
    expect(output).toMatch(/\n1\n?$/);
  }, 20_000);

  it('an exit stops the watchdog and removes the folder', () => {
    const { output } = withProcs(`${after}report wd.pid; folder`, 'exit 0');
    expect(output).toContain('check=0');
    expect(output).toContain('wd.pid=stopped');
    expect(output).toContain('work=gone');
  }, 20_000);
});
