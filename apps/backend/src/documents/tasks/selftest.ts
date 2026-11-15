import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  probeLookup,
  probeRead,
  probeSpawn,
  probeTcp,
  probeUnixSocket,
  probeWrite,
  type ChildReport,
  type SelftestTargets,
} from '../../kit/probes.ts';

// `selftest`'s child (docs/specs/platform.md, "documents"). Started like every task, it reports
// its flags and its environment's names, and tries each thing its flags must stop. Then it stays
// until its stdin ends, which the service does once it has listed the child's open files
// (guards.ts), so the list is taken from the child as it was after every probe.

/** Throws unless `input` holds a port and two absolute paths, and nothing else. */
export function parseTargets(input: string): SelftestTargets {
  const value = JSON.parse(input) as unknown;
  if (typeof value !== 'object' || value === null) throw new Error('selftest: no targets');
  const { port, databaseSocket, secrets, ...rest } = value as Record<string, unknown>;
  if (
    Object.keys(rest).length > 0 ||
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    typeof databaseSocket !== 'string' ||
    !path.isAbsolute(databaseSocket) ||
    typeof secrets !== 'string' ||
    !path.isAbsolute(secrets)
  ) {
    throw new Error('selftest: the targets are a port and two absolute paths');
  }
  return { port, databaseSocket, secrets };
}

/** Every probe; the write is tried in `folder`, the child's working folder, the job's, which it
 * can read. */
export async function probeAll(
  targets: SelftestTargets,
  folder: string,
): Promise<ChildReport['probes']> {
  return {
    tcp: await probeTcp(targets.port),
    databaseSocket: await probeUnixSocket(targets.databaseSocket),
    lookup: await probeLookup(),
    write: probeWrite(path.join(folder, 'selftest-write')),
    spawn: probeSpawn(),
    readSecrets: probeRead(targets.secrets),
  };
}

if (import.meta.main) {
  const report: ChildReport = {
    execArgv: process.execArgv,
    env: Object.keys(process.env).sort(),
    probes: await probeAll(parseTargets(readFileSync('input', 'utf8')), process.cwd()),
  };
  process.stdout.write(JSON.stringify(report));
  process.stdin.resume();
  await once(process.stdin, 'end');
}
