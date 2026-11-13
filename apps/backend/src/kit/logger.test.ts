import { afterEach, describe, expect, it, vi } from 'vitest';
import { manualClock } from './clock.ts';
import { consoleSink, createLogger, type Sink } from './logger.ts';
import { REDACTED, UNREADABLE } from './sanitize.ts';

function capture(): { sink: Sink; out: unknown[]; err: unknown[] } {
  const out: unknown[] = [];
  const err: unknown[] = [];
  return {
    sink: {
      out: (line) => out.push(JSON.parse(line)),
      err: (line) => err.push(JSON.parse(line)),
    },
    out,
    err,
  };
}

const clock = manualClock('2026-11-13T16:00:00.000Z');

describe('createLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes one JSON line per event, with the time, level and event first', () => {
    const lines: string[] = [];
    const logger = createLogger({ clock, sink: { out: (l) => lines.push(l), err: () => {} } });
    logger.info('request.done', { status: 200, ms: 4 });
    expect(lines).toEqual([
      '{"at":"2026-11-13T16:00:00.000Z","level":"info","event":"request.done","status":200,"ms":4}',
    ]);
  });

  it('sends errors to stderr and the rest to stdout', () => {
    const { sink, out, err } = capture();
    const logger = createLogger({ clock, sink });
    logger.info('a');
    logger.warn('b');
    logger.error('c');
    expect(out).toMatchObject([{ level: 'info' }, { level: 'warn' }]);
    expect(err).toMatchObject([{ level: 'error' }]);
  });

  it('passes every field through the sanitizer', () => {
    const { sink, err } = capture();
    const failure = Object.assign(new Error('duplicate key'), {
      severity: 'ERROR',
      code: '23505',
      detail: 'Key (email)=(jordan@example.com) already exists.',
      table: 'users',
    });
    createLogger({ clock, sink }).error('resume.save_failed', {
      error: failure,
      headers: { authorization: 'Bearer abc', cookie: 'sb-x-auth-token=y' },
    });
    expect(err).toEqual([
      {
        at: '2026-11-13T16:00:00.000Z',
        level: 'error',
        event: 'resume.save_failed',
        error: { name: 'DatabaseError', code: '23505', table: 'users' },
        headers: { authorization: REDACTED, cookie: REDACTED },
      },
    ]);
  });

  it("never lets a field replace the line's own time, level or event", () => {
    const { sink, out } = capture();
    createLogger({ clock, sink }).info('real', { at: 'then', level: 'error', event: 'fake' });
    expect(out).toEqual([{ at: '2026-11-13T16:00:00.000Z', level: 'info', event: 'real' }]);
  });

  it('adds a child’s fields to every line, under the fields of each call', () => {
    const { sink, out } = capture();
    const logger = createLogger({ clock, sink, fields: { role: 'all' } });
    const request = logger.child({ requestId: 'r1' });
    request.info('one');
    request.child({ requestId: 'r2', step: 2 }).info('two', { step: 3 });
    logger.info('three');
    expect(out).toEqual([
      { at: '2026-11-13T16:00:00.000Z', level: 'info', event: 'one', role: 'all', requestId: 'r1' },
      {
        at: '2026-11-13T16:00:00.000Z',
        level: 'info',
        event: 'two',
        role: 'all',
        requestId: 'r2',
        step: 3,
      },
      { at: '2026-11-13T16:00:00.000Z', level: 'info', event: 'three', role: 'all' },
    ]);
  });

  it("sanitizes a child's fields and the logger's own, not only each call's", () => {
    const { sink, out } = capture();
    const logger = createLogger({ clock, sink, fields: { authorization: 'Bearer a' } });
    logger.child({ cookie: 'sb-x-auth-token=y', note: 'Bearer zzz' }).info('e');
    expect(out).toEqual([
      {
        at: '2026-11-13T16:00:00.000Z',
        level: 'info',
        event: 'e',
        authorization: REDACTED,
        cookie: REDACTED,
        note: `Bearer ${REDACTED}`,
      },
    ]);
  });

  it('still writes the line when a field cannot be read', () => {
    const { sink, err } = capture();
    const fields = {
      kept: 1,
      get broken(): never {
        throw new Error('getter failed');
      },
    };
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const logger = createLogger({ clock, sink });
    expect(() => {
      logger.error('odd', fields);
      logger.error('odder', proxy);
      logger.child(fields).error('oddest');
    }).not.toThrow();
    expect(err).toEqual([
      { at: '2026-11-13T16:00:00.000Z', level: 'error', event: 'odd', kept: 1, broken: UNREADABLE },
      { at: '2026-11-13T16:00:00.000Z', level: 'error', event: 'odder' },
      {
        at: '2026-11-13T16:00:00.000Z',
        level: 'error',
        event: 'oddest',
        kept: 1,
        broken: UNREADABLE,
      },
    ]);
  });

  it('writes to console by default', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createLogger({ clock });
    logger.info('a');
    logger.error('b');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"event":"a"'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('"event":"b"'));
    consoleSink.out('x');
    expect(log).toHaveBeenLastCalledWith('x');
  });
});
