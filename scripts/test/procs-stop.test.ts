import { describe, expect, it } from 'vitest';
import { withProcs } from './support/procs-harness.ts';

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
