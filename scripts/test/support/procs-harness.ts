import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect } from 'vitest';

// The harness for scripts/prod-build/procs.sh's tests (procs-run.test.ts, procs-stop.test.ts),
// in two files so Vitest runs them side by side.

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// scripts/prod-build/procs.sh, sourced in macOS's bash 3.2 (Linux's bash in CI) under `set -u`,
// in a scratch folder. helpers.sh holds the tests' own shell: `serve <file>` has web()'s shape
// in the check, a subshell that execs the process, so the process is a grandchild of whoever
// starts it, and writes its pid to <file>; `report <file>` says whether that process is still
// running, then stops it. check.sh, when a test gives one, is a check: it sources procs.sh and
// calls procs_setup on ./work, and `run_check` starts it as a terminal starts a job, in a process
// group of its own, so an INT to that group is a Ctrl-C.
const PROCS = fileURLToPath(new URL('../../prod-build/procs.sh', import.meta.url));
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
export function withProcs(body: string, check?: string) {
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
  // stdin from /dev/null, so bash -c never takes itself for rshd's and runs ~/.bashrc.
  const result = spawnSync('/bin/bash', ['-c', script, 'bash', PROCS], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 40_000,
  });
  return { status: result.status, output: result.stdout + result.stderr };
}
export const tookAtMost = (output: string, seconds: number) => {
  expect(Number(/took=(\d+)/.exec(output)?.[1])).toBeLessThanOrEqual(seconds);
};
