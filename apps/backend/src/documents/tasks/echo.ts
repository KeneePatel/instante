import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// `echo`, the platform's own task (docs/specs/platform.md, "documents"): the input's length and
// SHA-256. Like every task, run as a child, it reads `input` from its working folder (the job's
// folder) and writes its result on stdout.

export type EchoResult = { length: number; sha256: string };

export function echo(input: Uint8Array): EchoResult {
  return { length: input.byteLength, sha256: createHash('sha256').update(input).digest('hex') };
}

if (import.meta.main) {
  process.stdout.write(JSON.stringify(echo(readFileSync('input'))));
}
