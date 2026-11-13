import { defineRoute, fileResponse, rawBody, type RouteSpec } from '@instante/contract';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { manualClock } from '../kit/clock.ts';
import { errorReply } from '../kit/errors.ts';
import { systemIds } from '../kit/ids.ts';
import { createLogger, type Sink } from '../kit/logger.ts';
import {
  DEFAULT_MAX_BODY_BYTES,
  registerRoutes,
  type AppEnv,
  type Authenticate,
  type Deps,
  type Handlers,
  type RouteTable,
} from './register-routes.ts';

const lines: unknown[] = [];
const sink: Sink = { out: (l) => lines.push(JSON.parse(l)), err: (l) => lines.push(JSON.parse(l)) };
const clock = manualClock('2026-11-13T16:00:00.000Z');
const deps: Deps = {
  clock,
  ids: systemIds,
  logger: createLogger({ clock, sink }),
  sleep: () => Promise.resolve(),
};
const acceptBearerGood: Authenticate = (authorization) =>
  Promise.resolve(authorization === 'Bearer good' ? { userId: 'u1' } : null);

/** A bare app with only registerRoutes' own steps, and the error reply main's app uses. */
function appWith<T extends RouteTable>(table: T, handlers: Handlers<T>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'r1');
    c.set('logger', deps.logger);
    c.set('cookieArrived', false);
    await next();
  });
  registerRoutes(app, table, handlers, { authenticate: acceptBearerGood, deps });
  app.onError((error, c) => {
    const { status, body } = errorReply(error);
    return c.json(body, status as ContentfulStatusCode);
  });
  return app;
}

const ok = z.object({ ok: z.literal(true) });
const table = {
  open: defineRoute({ method: 'GET', path: '/api/open', auth: 'public', response: ok, errors: [] }),
  mine: defineRoute({ method: 'GET', path: '/api/mine', auth: 'user', response: ok, errors: [] }),
  item: defineRoute({
    method: 'GET',
    path: '/api/items/:id',
    auth: 'public',
    params: z.object({ id: z.string().regex(/^j_[a-z0-9]{8}$/) }),
    query: z.object({ n: z.coerce.number().int().min(1) }),
    response: z.object({ id: z.string(), n: z.number() }),
    errors: ['validation_failed'],
  }),
  save: defineRoute({
    method: 'POST',
    path: '/api/save',
    auth: 'public',
    body: z.object({ title: z.string().max(10) }),
    maxBodyBytes: 64,
    response: z.object({ title: z.string() }),
    errors: ['validation_failed', 'payload_too_large', 'unsupported_media_type'],
  }),
  upload: defineRoute({
    method: 'POST',
    path: '/api/upload',
    auth: 'public',
    body: rawBody,
    maxBodyBytes: 16,
    response: z.object({ bytes: z.number() }),
    errors: ['payload_too_large'],
  }),
  big: defineRoute({
    method: 'POST',
    path: '/api/big',
    auth: 'public',
    body: z.object({ text: z.string() }),
    response: ok,
    errors: [],
  }),
  file: defineRoute({
    method: 'GET',
    path: '/api/file',
    auth: 'public',
    response: fileResponse('application/pdf'),
    errors: [],
  }),
  mineSave: defineRoute({
    method: 'POST',
    path: '/api/mine/save',
    auth: 'user',
    body: z.object({ title: z.string() }),
    maxBodyBytes: 64,
    response: ok,
    errors: ['unauthenticated'],
  }),
  mineUpload: defineRoute({
    method: 'POST',
    path: '/api/mine/upload',
    auth: 'user',
    body: rawBody,
    maxBodyBytes: 16,
    response: ok,
    errors: ['unauthenticated'],
  }),
  notBytes: defineRoute({
    method: 'GET',
    path: '/api/not-bytes',
    auth: 'public',
    response: fileResponse('application/pdf'),
    errors: [],
  }),
  leaky: defineRoute({
    method: 'GET',
    path: '/api/leaky',
    auth: 'public',
    response: z.object({ id: z.string() }),
    errors: [],
  }),
  broken: defineRoute({
    method: 'GET',
    path: '/api/broken',
    auth: 'public',
    response: z.object({ id: z.string() }),
    errors: [],
  }),
} as const;

const handlers: Handlers<typeof table> = {
  open: () => ({ ok: true }),
  mine: ({ user }) => {
    expect(user).toEqual({ userId: 'u1' });
    return { ok: true };
  },
  item: ({ params, query }) => ({ id: params.id, n: query.n }),
  save: ({ body }) => ({ title: body.title }),
  upload: ({ body }) => ({ bytes: body.byteLength }),
  big: () => ({ ok: true }),
  file: () => new TextEncoder().encode('%PDF-1.7'),
  leaky: () => ({ id: 'x', email: 'jordan@example.com' }) as { id: string },
  broken: () => ({ id: 42 }) as unknown as { id: string },
  mineSave: ({ user }) => {
    expect(user).toEqual({ userId: 'u1' });
    return { ok: true };
  },
  mineUpload: () => ({ ok: true }),
  notBytes: () => 'not bytes' as unknown as Uint8Array<ArrayBuffer>,
};

const app = appWith(table, handlers);
const call = (path: string, init?: RequestInit) => app.request(`http://127.0.0.1${path}`, init);
const codeOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;
const json = (body: unknown, type = 'application/json') => ({
  method: 'POST',
  headers: { 'content-type': type },
  body: JSON.stringify(body),
});

describe('registerRoutes', () => {
  describe('fails closed, registering nothing', () => {
    it('without a handler for every route', () => {
      const missing = Object.fromEntries(
        Object.entries(handlers).filter(([name]) => name !== 'open'),
      );
      expect(() => {
        appWith(table, missing as unknown as Handlers<typeof table>);
      }).toThrow(/open has no handler/);
    });

    it('with a handler for no route', () => {
      expect(() => {
        appWith(table, { ...handlers, extra: () => ({ ok: true }) } as Handlers<typeof table>);
      }).toThrow(/extra has a handler but no route/);
    });

    it('with a route that has no auth value', () => {
      const loose = { ...table.open, auth: undefined } as unknown as RouteSpec;
      expect(() => {
        appWith({ open: loose }, { open: () => ({ ok: true }) } as unknown as Handlers<{
          open: RouteSpec;
        }>);
      }).toThrow(/open has no auth value/);
      const wrong = { ...table.open, auth: 'admin' } as unknown as RouteSpec;
      expect(() => {
        appWith({ open: wrong }, { open: () => ({ ok: true }) } as unknown as Handlers<{
          open: RouteSpec;
        }>);
      }).toThrow(/open has no auth value/);
    });

    it('so a bad table leaves the app without any of its routes', async () => {
      const bare = new Hono<AppEnv>();
      expect(() => {
        registerRoutes(bare, table, { ...handlers, file: undefined } as never, {
          authenticate: acceptBearerGood,
          deps,
        });
      }).toThrow(/file has no handler/);
      expect((await bare.request('http://127.0.0.1/api/open')).status).toBe(404);
    });
  });

  it('asks a user route for a token it accepts, before anything else', async () => {
    expect(await codeOf(await call('/api/mine'))).toBe('unauthenticated');
    expect(
      await codeOf(await call('/api/mine', { headers: { authorization: 'Bearer bad' } })),
    ).toBe('unauthenticated');
    const signedIn = await call('/api/mine', { headers: { authorization: 'Bearer good' } });
    expect(signedIn.status).toBe(200);
  });

  it('asks for the token before it reads, sizes or types a body', async () => {
    const tooBig = 'x'.repeat(100);
    const cases: [string, RequestInit][] = [
      ['/api/mine/save', json({ title: tooBig })],
      ['/api/mine/save', json({ title: 'a' }, 'text/plain')],
      ['/api/mine/upload', { method: 'POST', body: new Uint8Array(100) }],
    ];
    for (const [path, init] of cases) {
      expect(await codeOf(await call(path, init))).toBe('unauthenticated');
      const headers = {
        ...(init.headers as Record<string, string> | undefined),
        authorization: 'Bearer good',
      };
      const signedIn = await call(path, { ...init, headers });
      expect([413, 415]).toContain(signedIn.status);
    }
    const good = await call('/api/mine/save', {
      ...json({ title: 'a' }),
      headers: { 'content-type': 'application/json', authorization: 'Bearer good' },
    });
    expect(good.status).toBe(200);
  });

  it('registers each route for its own method only', async () => {
    expect((await call('/api/save')).status).toBe(404);
    expect((await call('/api/open', { method: 'POST' })).status).toBe(404);
  });

  it('validates params and query, and hands the handler the parsed values', async () => {
    const good = await call('/api/items/j_8k2m4q7r?n=3');
    expect(await good.json()).toEqual({ id: 'j_8k2m4q7r', n: 3 });
    const badParam = await call('/api/items/nope?n=3');
    expect(badParam.status).toBe(422);
    expect(await badParam.json()).toMatchObject({
      error: { code: 'validation_failed', details: { issues: [{ path: 'id' }] } },
    });
    expect((await call('/api/items/j_8k2m4q7r?n=0')).status).toBe(422);
  });

  describe('JSON bodies', () => {
    it('are parsed and validated', async () => {
      expect(await (await call('/api/save', json({ title: 'Résumé' }))).json()).toEqual({
        title: 'Résumé',
      });
      const long = await call('/api/save', json({ title: 'far too long a title' }));
      expect(long.status).toBe(422);
      expect(await long.json()).toMatchObject({
        error: { details: { issues: [{ path: 'title' }] } },
      });
    });

    it('that are not JSON get 422, without repeating them', async () => {
      const response = await call('/api/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'jordan@example.com',
      });
      expect(response.status).toBe(422);
      expect(await response.text()).not.toMatch(/jordan/);
    });

    it.each([
      'text/plain',
      'application/x-www-form-urlencoded',
      'application/jsonp',
      'application/json; charset=latin1',
      'application/json; CHARSET=latin1',
      'application/json; foo=bar; charset=latin1',
    ])('need application/json, so %s gets 415', async (type) => {
      expect((await call('/api/save', json({ title: 'a' }, type))).status).toBe(415);
    });

    it('need a Content-Type at all', async () => {
      // Bytes, since a string body would be given text/plain on its own.
      const body = new TextEncoder().encode('{"title":"a"}');
      const response = await call('/api/save', { method: 'POST', body });
      expect(response.headers.get('content-type')).not.toBeNull();
      expect(response.status).toBe(415);
    });

    it('check the size before the type', async () => {
      const response = await call('/api/save', json({ title: 'x'.repeat(100) }, 'text/plain'));
      expect(response.status).toBe(413);
    });

    it('take a media type with spaces around its parts', async () => {
      const type = ' application/json ; charset=utf-8';
      expect((await call('/api/save', json({ title: 'a' }, type))).status).toBe(200);
    });

    it('take application/json with a UTF-8 charset, in any case', async () => {
      const response = await call(
        '/api/save',
        json({ title: 'a' }, 'Application/JSON; Charset=UTF-8'),
      );
      expect(response.status).toBe(200);
    });

    it('are refused on Content-Length before they are read, and as they stream in', async () => {
      const large = JSON.stringify({ title: 'x'.repeat(100) });
      const declared = await call('/api/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(large.length) },
        body: large,
      });
      expect(declared.status).toBe(413);
      const streamed = await call('/api/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(large));
            controller.close();
          },
        }),
        duplex: 'half',
      });
      expect(streamed.status).toBe(413);
    });

    it(`default to a limit of ${String(DEFAULT_MAX_BODY_BYTES)} bytes`, async () => {
      expect(DEFAULT_MAX_BODY_BYTES).toBe(1024 * 1024);
      const at = (size: number) => call('/api/big', json({ text: 'x'.repeat(size - 11) }));
      expect((await at(DEFAULT_MAX_BODY_BYTES)).status).toBe(200);
      expect((await at(DEFAULT_MAX_BODY_BYTES + 1)).status).toBe(413);
    });
  });

  it('hands a raw body over as bytes, of any type, within its limit', async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const response = await call('/api/upload', { method: 'POST', body: bytes });
    expect(await response.json()).toEqual({ bytes: 4 });
    expect((await call('/api/upload', { method: 'POST', body: new Uint8Array(17) })).status).toBe(
      413,
    );
  });

  it('sends a file reply as its bytes, with its content type', async () => {
    const response = await call('/api/file');
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe('%PDF-1.7');
  });

  it('refuses a file reply that is not bytes', async () => {
    expect((await call('/api/not-bytes')).status).toBe(500);
  });

  it('drops the fields a reply schema leaves out', async () => {
    expect(await (await call('/api/leaky')).json()).toEqual({ id: 'x' });
  });

  it('turns a reply that breaks its schema into a 500, and logs where, not what', async () => {
    lines.length = 0;
    const response = await call('/api/broken');
    expect(response.status).toBe(500);
    expect(await codeOf(response)).toBe('internal');
    expect(lines).toEqual([
      expect.objectContaining({ event: 'reply.invalid', route: 'GET /api/broken', issues: ['id'] }),
    ]);
  });
});
