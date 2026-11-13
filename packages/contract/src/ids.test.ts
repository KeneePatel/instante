import { describe, expect, it } from 'vitest';
import { ID_PREFIXES, idType, isId, newId, type IdPrefix } from './ids.ts';

const fixed =
  (...values: number[]) =>
  (bytes: Uint8Array): Uint8Array => {
    bytes.set(values);
    return bytes;
  };

describe('newId', () => {
  it('makes a prefix and 8 lowercase Crockford base32 characters (ADR-008)', () => {
    const id = newId('x', fixed(1, 2, 3, 4, 5));
    expect(id).toMatch(/^x_[0-9a-hjkmnp-tv-z]{8}$/);
  });

  it('encodes the 40 random bits exactly, so ids are reproducible from their bytes', () => {
    expect(newId('b', fixed(0, 0, 0, 0, 0))).toBe('b_00000000');
    expect(newId('b', fixed(255, 255, 255, 255, 255))).toBe('b_zzzzzzzz');
    expect(newId('b', fixed(0, 0, 0, 0, 31))).toBe('b_0000000z');
  });

  it('never uses the letters Crockford leaves out', () => {
    for (let i = 0; i < 256; i++) {
      const id = newId('s', fixed(i, 255 - i, i, 255 - i, i));
      expect(id.slice(2)).not.toMatch(/[ilou]/);
    }
  });

  it('refuses a random source that does not fill 5 bytes', () => {
    expect(() => newId('x', () => new Uint8Array(4))).toThrow(/5 bytes/);
  });
});

describe('isId and idType', () => {
  it('accepts every prefix ADR-008 names, and gives back its type', () => {
    for (const prefix of Object.keys(ID_PREFIXES) as IdPrefix[]) {
      const id = newId(prefix, fixed(9, 8, 7, 6, 5));
      expect(isId(id)).toBe(true);
      expect(idType(id)).toBe(ID_PREFIXES[prefix]);
    }
  });

  it.each([
    ['an unknown prefix', 'q_8k2m4q7r'],
    ['uppercase', 'x_8K2M4Q7R'],
    ['a left-out letter', 'x_8k2m4q7l'],
    ['seven characters', 'x_8k2m4q7'],
    ['nine characters', 'x_8k2m4q7rr'],
    ['no underscore', 'x8k2m4q7r'],
  ])('refuses %s', (_case, value) => {
    expect(isId(value)).toBe(false);
  });
});
