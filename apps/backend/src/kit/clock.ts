// The one source of "now", injected everywhere so tests can fix it.

export type Clock = { now: () => Date };

export const systemClock: Clock = { now: () => new Date() };

/** A clock that stands still until moved, for tests. Each call returns a fresh Date. */
export type ManualClock = Clock & { advance: (ms: number) => void; set: (at: string) => void };

export function manualClock(start: string): ManualClock {
  let ms = parse(start);
  return {
    now: () => new Date(ms),
    advance: (by) => {
      if (!Number.isFinite(by)) throw new Error('manualClock: advance takes a finite number');
      ms += by;
    },
    set: (at) => {
      ms = parse(at);
    },
  };
}

/** An ISO time with its zone: without one, Date.parse reads local time, which differs between
 * the Mac and CI. */
function parse(at: string): number {
  const ms = /(Z|[+-]\d\d:\d\d)$/.test(at) ? Date.parse(at) : Number.NaN;
  if (Number.isNaN(ms)) throw new Error(`manualClock: not a date with a time zone: ${at}`);
  return ms;
}
