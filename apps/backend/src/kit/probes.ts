import { spawnSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { readdirSync, writeFileSync } from 'node:fs';
import { connect, type NetConnectOpts } from 'node:net';

// `selftest`'s probes (docs/specs/platform.md, "documents"): each tries one thing a document
// task's child must not be able to do. The child runs them under its flags, where each must be
// denied; the backend runs the TCP and lookup ones as the positive control, where they must
// succeed, which shows a denial means the permission model stopped the attempt, not that the
// target was missing. Node's built-ins only, since that's all a child can load. Every probe
// stays on this machine.

/** `denied`: the permission model refused it. `allowed`: it worked. `failed: <code>`: something
 * else stopped it, which means the attempt itself got through. */
export type Probe = 'denied' | 'allowed' | `failed: ${string}`;

/** What `selftest`'s child probes: given by the backend, as JSON in the job's `input`. */
export type SelftestTargets = {
  /** The backend's port, on 127.0.0.1. */
  port: number;
  /** The database's socket. */
  databaseSocket: string;
  /** The secrets folder, `$INSTANTE_HOME/secrets`. */
  secrets: string;
};

export const PROBES = ['tcp', 'databaseSocket', 'lookup', 'write', 'spawn', 'readSecrets'] as const;
export type ProbeName = (typeof PROBES)[number];

/** What `selftest`'s child reports on stdout. */
export type ChildReport = {
  execArgv: string[];
  /** Its environment's names, never their values. */
  env: string[];
  probes: Record<ProbeName, Probe>;
};

/** How long a connection or lookup may take before it counts as failed. */
export const PROBE_TIMEOUT_MS = 2_000;

function outcome(error: unknown): Probe {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ERR_ACCESS_DENIED') return 'denied';
  return `failed: ${code ?? String(error)}`;
}

function tryConnect(options: NetConnectOpts): Promise<Probe> {
  return new Promise((resolve) => {
    try {
      const socket = connect(options);
      const timer = setTimeout(() => {
        socket.destroy();
        resolve('failed: timeout');
      }, PROBE_TIMEOUT_MS);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve('allowed');
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        resolve(outcome(error));
      });
    } catch (error) {
      resolve(outcome(error));
    }
  });
}

/** A TCP connection to a port on 127.0.0.1, such as the backend's. */
export const probeTcp = (port: number): Promise<Probe> => tryConnect({ host: '127.0.0.1', port });

/** A connection to a Unix socket, such as the database's. */
export const probeUnixSocket = (path: string): Promise<Probe> => tryConnect({ path });

/** A lookup of `localhost`. */
export async function probeLookup(): Promise<Probe> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Probe>((resolve) => {
    timer = setTimeout(() => {
      resolve('failed: timeout');
    }, PROBE_TIMEOUT_MS);
  });
  const attempt = lookup('localhost').then(
    (): Probe => 'allowed',
    (error: unknown) => outcome(error),
  );
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Writing a new, empty file. */
export function probeWrite(file: string): Probe {
  try {
    writeFileSync(file, '', { flag: 'wx' });
    return 'allowed';
  } catch (error) {
    return outcome(error);
  }
}

/** Starting a process: this Node, printing its version. */
export function probeSpawn(): Probe {
  try {
    const run = spawnSync(process.execPath, ['--version'], {
      env: {},
      stdio: 'ignore',
      timeout: PROBE_TIMEOUT_MS,
    });
    return run.error === undefined ? 'allowed' : outcome(run.error);
  } catch (error) {
    return outcome(error);
  }
}

/** Listing a folder, such as the secrets folder. */
export function probeRead(folder: string): Probe {
  try {
    readdirSync(folder);
    return 'allowed';
  } catch (error) {
    return outcome(error);
  }
}
