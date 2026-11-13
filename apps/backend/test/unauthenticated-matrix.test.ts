import { routes, testRoutes, type RouteSpec } from '@instante/contract';
import { describe, expect, it } from 'vitest';
import { errorCode, testApp } from './helpers.ts';

// Generated from the route tables: every `user` route answers 401 to a caller without a
// token it accepts, in every spelling of its path (docs/specs/platform.md, "Testing").
// Until `accounts` brings the real authenticate, every token is refused.

const userRoutes = Object.entries({ ...routes, ...testRoutes }).filter(
  ([, spec]) => (spec as RouteSpec).auth === 'user',
) as [string, RouteSpec][];

/** The route's path with each parameter filled in. */
function concrete(path: string): string {
  return path.replace(/:[A-Za-z]+/g, 'x');
}

/** Percent-encodes the last segment's first character whose code has a hex letter (such as
 * '-', 'n' or 'o'), so the lower- and upper-case spellings really differ. */
function encodeOneLetter(path: string, upper: boolean): string {
  const start = path.lastIndexOf('/') + 1;
  let i = start;
  while (i < path.length && !/[a-f]/.test(path.charCodeAt(i).toString(16))) i++;
  if (i === path.length) i = start;
  const hex = path.charCodeAt(i).toString(16);
  return `${path.slice(0, i)}%${upper ? hex.toUpperCase() : hex}${path.slice(i + 1)}`;
}

const spellings = (path: string): [string, string][] => [
  ['as declared', path],
  ['with a trailing slash', `${path}/`],
  ['with a letter percent-encoded', encodeOneLetter(path, false)],
  ['with a letter percent-encoded in upper case', encodeOneLetter(path, true)],
  ['in upper case', path.toUpperCase()],
  ['with a doubled slash', path.replace('/api/', '/api//')],
  ['with a dot segment', path.replace('/api/', '/api/./')],
  ['with a climb back into it', path.replace('/api/', '/api/x/../')],
  ['with a matrix parameter', `${path};x`],
  ['with a query', `${path}?a=1`],
];

const tokens: [string, Record<string, string>][] = [
  ['no Authorization', {}],
  ['an empty Authorization', { authorization: '' }],
  ['a bearer token', { authorization: 'Bearer eyJhbGciOi.payload.signature' }],
  ['basic credentials', { authorization: 'Basic dXNlcjpwYXNz' }],
  ['a session cookie and no token', { cookie: 'sb-abcd-auth-token=base64-eyJ' }],
];

describe('the unauthenticated matrix', () => {
  it('covers at least one user route', () => {
    expect(userRoutes.length).toBeGreaterThan(0);
  });

  describe.each(userRoutes)('%s', (_name, spec) => {
    const path = concrete(spec.path);

    it('is spelled ten different ways', () => {
      expect(new Set(spellings(path).map(([, target]) => target)).size).toBe(10);
    });

    it.each(spellings(path))('answers 401 to its path %s', async (_spelling, target) => {
      const { call } = testApp();
      for (const [, headers] of tokens) {
        const response = await call(target, { method: spec.method, headers });
        expect(response.status, `${spec.method} ${target} ${JSON.stringify(headers)}`).toBe(401);
        expect(await errorCode(response)).toBe('unauthenticated');
        expect(response.headers.get('cache-control')).toBe('private, no-store');
      }
    });

    it('answers 401 to every other method on it', async () => {
      const { call } = testApp();
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const response = await call(path, { method });
        expect(response.status, method).toBe(401);
      }
    });
  });
});
