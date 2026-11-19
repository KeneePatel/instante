import { describe, expect, it } from 'vitest';
import { digestOf } from './errors.ts';

// The reference an error page shows: the digest Next gives a Server Component's error, which
// matches the `digest:` in the web log's line for it. A browser's own errors have none.

describe('digestOf', () => {
  it('is the digest of a Server Component’s error', () => {
    expect(
      digestOf(Object.assign(new Error('Minified React error #441'), { digest: '3440023046' })),
    ).toBe('3440023046');
    // Up to 64 characters.
    expect(digestOf(Object.assign(new Error('x'), { digest: 'x'.repeat(64) }))).toBe(
      'x'.repeat(64),
    );
  });

  it('is nothing for an error without one, or with one that isn’t short text', () => {
    const cases: unknown[] = [
      new Error('raw text, jordan@example.com'),
      Object.assign(new Error('x'), { digest: 3440023046 }),
      Object.assign(new Error('x'), { digest: '' }),
      Object.assign(new Error('x'), { digest: 'x'.repeat(65) }),
      { digest: 'not an error' },
      'thrown text',
      null,
      undefined,
    ];
    for (const [index, error] of cases.entries()) {
      expect(digestOf(error), `case ${String(index)}`).toBeUndefined();
    }
  });
});
