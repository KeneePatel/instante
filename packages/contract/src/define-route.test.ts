import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  defineRoute,
  fileResponse,
  rawBody,
  type BodyOf,
  type QueryOf,
  type ResponseOf,
  type RouteSpec,
} from './define-route.ts';

const ok = z.object({ ok: z.literal(true) });

describe('defineRoute', () => {
  it('returns the route as declared', () => {
    const route = defineRoute({
      method: 'GET',
      path: '/api/ping',
      auth: 'public',
      response: ok,
      errors: [],
    });
    expect(route).toMatchObject({ method: 'GET', path: '/api/ping', auth: 'public' });
  });

  it('needs every route to declare its auth, in the types', () => {
    // @ts-expect-error -- a route without `auth` must not type-check (fail closed)
    const route: RouteSpec = { method: 'GET', path: '/api/x', response: ok, errors: [] };
    expect(route).toBeDefined();
  });

  it('refuses a route without a known auth value at run time', () => {
    const missing = { method: 'GET', path: '/api/x', response: ok, errors: [] };
    expect(() => defineRoute(missing as unknown as RouteSpec)).toThrow(/auth/);
    const wrong = { ...missing, auth: 'anyone' };
    expect(() => defineRoute(wrong as unknown as RouteSpec)).toThrow(/auth/);
  });

  it('refuses paths outside /api/ and unknown methods', () => {
    const base = { auth: 'public', response: ok, errors: [] } as const;
    expect(() =>
      defineRoute({ ...base, method: 'GET', path: '/healthz' } as unknown as RouteSpec),
    ).toThrow(/\/api\//);
    expect(() =>
      defineRoute({ ...base, method: 'TRACE', path: '/api/x' } as unknown as RouteSpec),
    ).toThrow(/method/);
  });

  it('refuses a body limit that is not a positive whole number', () => {
    for (const maxBodyBytes of [0, -1, 1.5]) {
      expect(() =>
        defineRoute({
          method: 'POST',
          path: '/api/x',
          auth: 'user',
          body: rawBody,
          maxBodyBytes,
          response: ok,
          errors: [],
        }),
      ).toThrow(/maxBodyBytes/);
    }
  });

  it('infers request and response types from the schemas', () => {
    const route = defineRoute({
      method: 'POST',
      path: '/api/things',
      auth: 'user',
      query: z.object({ page: z.coerce.number() }),
      body: z.object({ name: z.string() }),
      response: z.object({ id: z.string() }),
      errors: ['validation_failed'],
    });
    expect(route.errors).toEqual(['validation_failed']);
    expectTypeOf<BodyOf<typeof route>>().toEqualTypeOf<{ name: string }>();
    expectTypeOf<QueryOf<typeof route>>().toEqualTypeOf<{ page: number }>();
    expectTypeOf<ResponseOf<typeof route>>().toEqualTypeOf<{ id: string }>();
  });

  it('types a raw body as bytes and a file reply as a Blob', () => {
    const route = defineRoute({
      method: 'POST',
      path: '/api/upload',
      auth: 'user',
      body: rawBody,
      maxBodyBytes: 1024,
      response: fileResponse('application/pdf'),
      errors: [],
    });
    expectTypeOf<BodyOf<typeof route>>().toEqualTypeOf<Uint8Array>();
    expectTypeOf<ResponseOf<typeof route>>().toEqualTypeOf<Blob>();
    expect(route.response).toEqual({ kind: 'file', contentType: 'application/pdf' });
  });
});
