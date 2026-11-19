import { describe, expect, it } from 'vitest';
import { ApiError, UNREACHABLE } from './api.ts';
import { failureText, outcomeOf } from './call-failure.ts';

// What a page shows for a call that failed (docs/specs/platform.md, "The typed fetch helper").

describe('failureText', () => {
  it('is “can’t reach its server” for an outage, and for a wait that ran out', () => {
    expect(failureText(new ApiError('upstream_unavailable', UNREACHABLE))).toBe(UNREACHABLE);
    expect(failureText(new DOMException('Timed out.', 'TimeoutError'))).toBe(UNREACHABLE);
  });

  it('is the contract’s message with its code for the contract’s other errors', () => {
    expect(
      failureText(new ApiError('misdirected', 'Instante answers only at its own address.')),
    ).toBe('Instante answers only at its own address. (misdirected)');
  });

  it('is nothing for anything else, which the caller lets through to the error page', () => {
    for (const error of [
      new DOMException('Stopped.', 'AbortError'),
      new Error('a bug'),
      new TypeError('fetch failed'),
      'thrown text',
      undefined,
    ]) {
      expect(failureText(error)).toBeUndefined();
    }
  });
});

describe('outcomeOf', () => {
  it('is the value, the text for what went wrong, or the error for the error page', async () => {
    expect(await outcomeOf(Promise.resolve(7))).toEqual({ value: 7 });
    expect(
      await outcomeOf(Promise.reject(new ApiError('upstream_unavailable', UNREACHABLE))),
    ).toEqual({
      problem: UNREACHABLE,
    });
    const bug = new Error('a bug');
    expect(await outcomeOf(Promise.reject(bug))).toEqual({ error: bug });
  });
});
