// The master resume's permanent ids (ADR-008): a prefix naming the element's type, an
// underscore, and 8 lowercase Crockford base32 characters, for example `x_8k2m4q7r`.
// One generator, here, for the backend and the web app alike.

export const ID_PREFIXES = {
  x: 'experience',
  p: 'position',
  b: 'bullet',
  j: 'project',
  e: 'education',
  c: 'certification',
  l: 'language',
  s: 'skill',
  u: 'customSection',
  i: 'customItem',
} as const;

export type IdPrefix = keyof typeof ID_PREFIXES;
export type IdType = (typeof ID_PREFIXES)[IdPrefix];
export type Id<P extends IdPrefix = IdPrefix> = `${P}_${string}`;

// Crockford's alphabet leaves out i, l, o and u.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const ID_PATTERN = /^([xpbjeclsui])_[0-9a-hjkmnp-tv-z]{8}$/;

/** Fills the array with random bytes and returns it, as `crypto.getRandomValues` does. */
export type RandomFill = (bytes: Uint8Array) => Uint8Array;

/** 8 base32 characters carry 40 bits: exactly 5 random bytes. */
export function newId<P extends IdPrefix>(prefix: P, fill: RandomFill): Id<P> {
  const bytes = fill(new Uint8Array(5));
  if (bytes.length !== 5) throw new Error('newId: the random source must fill 5 bytes');
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  let digits = '';
  for (let i = 7; i >= 0; i--) digits += ALPHABET.charAt(Math.floor(value / 32 ** i) % 32);
  return `${prefix}_${digits}`;
}

export function isId(value: string): value is Id {
  return ID_PATTERN.test(value);
}

export function idType(id: Id): IdType {
  return ID_PREFIXES[id.charAt(0) as IdPrefix];
}
