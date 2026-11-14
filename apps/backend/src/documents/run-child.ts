import { spawn } from 'node:child_process';

// Each document task runs in a child process (docs/specs/platform.md, "documents"), a seat belt
// against a parser bug, not a sandbox (docs/threat-model.md, R2). The child gets:
// - Node's permission model, reading only the job's folder and the granted code, with no
//   writes, child processes, workers, addons or network (all denied unless allowed);
// - --disable-sigusr1, so nothing can open its inspector, and a 256 MB heap;
// - no node:sqlite, which writes files the permission model doesn't check;
// - an empty environment, so no NODE_OPTIONS and nothing of the service's own;
// - three pipes and nothing else: no IPC channel, no other file descriptor;
// - 30 seconds, then a kill.

/** The children's time limit (docs/architecture.md, "Limits"). */
export const CHILD_TIMEOUT_MS = 30_000;
/** The children's heap, in megabytes (docs/architecture.md, "Limits"). */
export const CHILD_HEAP_MB = 256;
/** The most a child may write on stdout, its result; past it, it's killed. */
export const MAX_CHILD_OUTPUT_BYTES = 64 * 1024 * 1024;
/** What's kept of a child's stderr, in bytes; the log line holds the logger's 2,000 characters
 * of it. */
export const MAX_CHILD_STDERR_BYTES = 64 * 1024;

export type ChildRun = {
  /** The task's script: an absolute path inside one of `grants`. */
  script: string;
  /** Arguments after the script. */
  args: readonly string[];
  /** The job's own folder: the child's working folder, and one of its read grants. */
  jobFolder: string;
  /** Real paths, beside the job folder, the child may read: the code it runs. */
  grants: readonly string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Kills the child when aborted, as when the service stops. */
  signal?: AbortSignal;
};

export type ChildResult =
  | { ok: true; stdout: Buffer; stderr: string; ms: number }
  | {
      ok: false;
      reason: 'failed' | 'timed_out' | 'too_much_output' | 'stopped';
      code: number | null;
      signal: NodeJS.Signals | null;
      stderr: string;
      ms: number;
    };

/** The child's command line after `process.execPath`: its flags, then the script. */
export function childArgs(run: Pick<ChildRun, 'script' | 'args' | 'jobFolder' | 'grants'>) {
  return [
    '--permission',
    '--disable-sigusr1',
    `--max-old-space-size=${String(CHILD_HEAP_MB)}`,
    '--no-experimental-sqlite',
    ...[run.jobFolder, ...run.grants].map((path) => `--allow-fs-read=${path}`),
    run.script,
    ...run.args,
  ];
}

/** Runs one task's child to its end, its time limit or its output limit. Never rejects for
 * anything the child does; rejects only if it can't be started. */
export function runChild(run: ChildRun): Promise<ChildResult> {
  const timeoutMs = run.timeoutMs ?? CHILD_TIMEOUT_MS;
  const maxOutputBytes = run.maxOutputBytes ?? MAX_CHILD_OUTPUT_BYTES;
  const began = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, childArgs(run), {
      cwd: run.jobFolder,
      env: {},
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    child.stdin.end();

    const out: Buffer[] = [];
    let outBytes = 0;
    const err: Buffer[] = [];
    let errBytes = 0;
    let stopped: 'timed_out' | 'too_much_output' | 'stopped' | undefined;
    const stop = (why: NonNullable<typeof stopped>) => {
      stopped ??= why;
      child.kill('SIGKILL');
    };
    const deadline = setTimeout(() => {
      stop('timed_out');
    }, timeoutMs);
    const onAbort = () => {
      stop('stopped');
    };
    if (run.signal?.aborted === true) onAbort();
    else run.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxOutputBytes) stop('too_much_output');
      else out.push(chunk);
    });
    // Read to the end, so the child never blocks on a full pipe, but only the first bytes kept.
    child.stderr.on('data', (chunk: Buffer) => {
      // Even an empty view would keep the whole chunk's memory.
      if (errBytes === MAX_CHILD_STDERR_BYTES) return;
      const kept = chunk.subarray(0, MAX_CHILD_STDERR_BYTES - errBytes);
      err.push(kept);
      errBytes += kept.length;
    });
    const settle = () => {
      clearTimeout(deadline);
      run.signal?.removeEventListener('abort', onAbort);
    };
    child.once('error', (error) => {
      settle();
      reject(error);
    });
    child.once('close', (code, signal) => {
      settle();
      const ms = Math.round(performance.now() - began);
      // Decoded once, so a character split between chunks survives; `stream` drops the last
      // character when the cap cut it in two.
      const stderr = new TextDecoder().decode(Buffer.concat(err), { stream: true });
      if (stopped === undefined && code === 0) {
        resolve({ ok: true, stdout: Buffer.concat(out), stderr, ms });
      } else {
        resolve({ ok: false, reason: stopped ?? 'failed', code, signal, stderr, ms });
      }
    });
  });
}
