import { describe, expect, it } from 'vitest';
import { tookAtMost, withProcs } from './support/procs-harness.ts';

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
