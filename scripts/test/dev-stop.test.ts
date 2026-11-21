import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { alive, eventually, fixture, read, startDev } from './support/dev-harness.ts';

// scripts/dev.sh's stop of a process that ignores TERM, which waits out its 15 seconds: in a
// file of its own, so Vitest runs it beside dev.test.ts's other cases.

describe('scripts/dev.sh', () => {
  it('kills a process that ignores TERM after 15 seconds, saying which', async () => {
    const { root, tmp } = fixture({ markers: ['marker-backend-ignores-term'] });
    const dev = startDev(root, tmp);
    await dev.until('dev: open');
    const backend = read(root, 'all');
    dev.child.kill('SIGINT');
    expect(await dev.exited).toBe(130);
    expect(dev.output()).toContain("dev: backend didn't stop in 15 seconds; killing it");
    expect(await eventually(() => !alive(backend.pid))).toBe(true);
    expect(readdirSync(tmp)).toEqual([]);
  }, 40_000);
});
