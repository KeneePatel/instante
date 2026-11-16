import {
  EchoResponseSchema,
  PingResponseSchema,
  defineRoute,
  fileResponse,
  routes,
  testRoutes,
} from '@instante/contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, UNREACHABLE, createApi, serverBase } from './api.ts';

// The typed fetch helper (docs/specs/platform.md, "The typed fetch helper"; ADR-005): what it
// sends, and what it makes of each kind of reply.

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A fetch that records each request and answers with `reply`. */
function fakeFetch(reply: () => Response | Promise<Response>) {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetch = (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: url instanceof Request ? url.url : url.toString(), init: init ?? {} });
    return Promise.resolve(reply());
  };
  return { fetch, sent };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
const PING = { ok: true, at: '2026-11-16T12:00:00.000Z' } as const;

// A route with path parameters, a query and a JSON body, built from the contract's own schemas,
// since the web app takes Zod only through the contract.
const item = defineRoute({
  method: 'PATCH',
  path: '/api/items/:authorizationSha256/notes/:bodyBytes',
  auth: 'user',
  params: EchoResponseSchema,
  query: testRoutes.slow.query,
  body: PingResponseSchema,
  response: testRoutes.userOnly.response,
  errors: ['not_found'],
});
const upload = testRoutes.echo;
/** A reply whose body starts and then stops: with the caller's abort, or else as a dropped
 * connection does. */
function stopping(type: string, status: number, signal?: AbortSignal): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":'));
      if (signal === undefined) {
        queueMicrotask(() => {
          controller.error(new TypeError('terminated'));
        });
      } else {
        signal.addEventListener('abort', () => {
          controller.error(signal.reason);
        });
      }
    },
  });
  return new Response(body, { status, headers: { 'content-type': type } });
}
const pdf = testRoutes.filePdf;
const ECHOED = { authorizationSha256: null, cookieArrived: false, bodyBytes: 3 };

describe('the request', () => {
  it('goes to the route’s path on the base, with no cookies, no cache, and no redirect followed', async () => {
    const { fetch, sent } = fakeFetch(() => json(PING));
    await createApi({ base: '', fetch })(routes.ping);
    expect(sent).toEqual([
      {
        url: '/api/ping',
        init: {
          method: 'GET',
          headers: { accept: 'application/json' },
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
        },
      },
    ]);
    await createApi({ base: 'http://127.0.0.1:4311', fetch })(routes.ping);
    expect(sent[1]?.url).toBe('http://127.0.0.1:4311/api/ping');
  });

  it('carries the token as a bearer token when the provider has one, and none when it hasn’t', async () => {
    const { fetch, sent } = fakeFetch(() => json(PING));
    await createApi({ base: '', fetch, token: () => Promise.resolve('abc.def') })(routes.ping);
    await createApi({ base: '', fetch, token: () => Promise.resolve(null) })(routes.ping);
    expect(sent.map(({ init }) => init.headers)).toEqual([
      { accept: 'application/json', authorization: 'Bearer abc.def' },
      { accept: 'application/json' },
    ]);
  });

  it('asks the provider for the token on every call, since a session’s token changes', async () => {
    const { fetch, sent } = fakeFetch(() => json(PING));
    const tokens = ['first', 'second'];
    const api = createApi({
      base: '',
      fetch,
      token: () => Promise.resolve(tokens.shift() ?? null),
    });
    await api(routes.ping);
    await api(routes.ping);
    expect(
      sent.map(({ init }) => (init.headers as Record<string, string>)['authorization']),
    ).toEqual(['Bearer first', 'Bearer second']);
  });

  it('leaves out a query’s undefined values, sends booleans, and refuses a value with no text', async () => {
    const { fetch, sent } = fakeFetch(() => json({ ok: true }));
    const call = createApi({ base: '', fetch });
    const withQuery = (query: Record<string, unknown>) =>
      ({ query }) as Parameters<typeof call<typeof testRoutes.slow>>[1];
    await call(testRoutes.slow, withQuery({ seconds: undefined }));
    await call(testRoutes.slow, withQuery({ seconds: true }));
    expect(sent.map(({ url }) => url)).toEqual(['/api/test/slow', '/api/test/slow?seconds=true']);
    await expect(call(testRoutes.slow, withQuery({ seconds: { n: 1 } }))).rejects.toThrow(
      "the query's seconds must be a string, a number or a boolean",
    );
    expect(sent).toHaveLength(2);
  });

  it('refuses a path with Hono’s other parameter forms, which it would send as they are', async () => {
    const { fetch, sent } = fakeFetch(() => json({ ok: true }));
    for (const path of ['/api/items/:id?', '/api/items/:id{[0-9]+}', '/api/files/*'] as const) {
      const route = defineRoute({ ...testRoutes.userOnly, path });
      await expect(createApi({ base: '', fetch })(route), path).rejects.toThrow(
        `${path} has a path form only plain :name parameters stand in for`,
      );
    }
    expect(sent).toEqual([]);
  });

  it('fills in the path’s parameters, encoded, adds the query, and sends a JSON body', async () => {
    const { fetch, sent } = fakeFetch(() => json({ ok: true }));
    const signal = new AbortController().signal;
    await createApi({ base: '', fetch })(item, {
      params: { authorizationSha256: 'a/b c?d', cookieArrived: true, bodyBytes: 7 },
      query: { seconds: 3 },
      body: PING,
      signal,
    });
    expect(sent[0]?.url).toBe('/api/items/a%2Fb%20c%3Fd/notes/7?seconds=3');
    expect(sent[0]?.init.signal).toBe(signal);
    expect(sent[0]?.init).toMatchObject({
      method: 'PATCH',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(PING),
      signal,
    });
  });

  it('refuses a missing parameter, or a value with no text, before sending anything', async () => {
    const { fetch, sent } = fakeFetch(() => json({ ok: true }));
    const call = createApi({ base: '', fetch });
    const input = (params: Record<string, unknown>) =>
      ({ params, query: { seconds: 3 }, body: PING }) as Parameters<typeof call<typeof item>>[1];
    await expect(call(item, input({ bodyBytes: 7 }))).rejects.toThrow(
      '/api/items/:authorizationSha256/notes/:bodyBytes needs its authorizationSha256 parameter',
    );
    await expect(call(item, input({ authorizationSha256: {}, bodyBytes: 7 }))).rejects.toThrow(
      "/api/items/:authorizationSha256/notes/:bodyBytes's authorizationSha256 parameter must be a string, a number or a boolean",
    );
    // The URL would drop or climb a segment and call another route.
    for (const value of ['', '.', '..']) {
      await expect(
        call(item, input({ authorizationSha256: value, bodyBytes: 7 })),
        value,
      ).rejects.toThrow(
        "/api/items/:authorizationSha256/notes/:bodyBytes's authorizationSha256 parameter can't be empty, . or ..",
      );
    }
    expect(new URL('/api/items/../notes/7', 'http://x').pathname).toBe('/api/notes/7');
    expect(sent).toEqual([]);
  });

  it('sends a raw body as bytes', async () => {
    const { fetch, sent } = fakeFetch(() => json(ECHOED));
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await createApi({ base: '', fetch })(upload, { body: bytes })).toEqual(ECHOED);
    expect(sent[0]?.init).toMatchObject({
      headers: { accept: 'application/json', 'content-type': 'application/octet-stream' },
      body: bytes,
    });
  });

  it('asks a file route for its media type', async () => {
    const { fetch, sent } = fakeFetch(
      () => new Response('%PDF-1.7', { headers: { 'content-type': 'application/pdf' } }),
    );
    await createApi({ base: '', fetch })(pdf);
    expect(sent[0]?.init.headers).toEqual({ accept: 'application/pdf' });
  });
});

describe('the reply', () => {
  const call = (reply: () => Response | Promise<Response>) =>
    createApi({ base: '', fetch: fakeFetch(reply).fetch })(routes.ping);
  /** What a call failed with, as the page would see it. */
  const failure = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof ApiError) {
        return {
          code: error.code,
          status: error.status,
          message: error.message,
          details: error.details,
        };
      }
      throw error;
    }
    throw new Error('expected the call to fail');
  };
  const unreachable = {
    code: 'upstream_unavailable',
    status: 502,
    message: UNREACHABLE,
    details: undefined,
  };

  it('is parsed with the route’s schema, and what it parses is what comes back', async () => {
    expect(await call(() => json(PING))).toEqual(PING);
    // The schema drops what it doesn't know.
    expect(await call(() => json({ ...PING, extra: 'dropped' }))).toEqual(PING);
  });

  it('turns the backend’s error into an ApiError with its code, message and details', async () => {
    expect(
      await failure(
        call(() =>
          json(
            {
              error: {
                code: 'validation_failed',
                message: 'Check the date.',
                details: { field: 'at' },
              },
            },
            422,
          ),
        ),
      ),
    ).toEqual({
      code: 'validation_failed',
      status: 422,
      message: 'Check the date.',
      details: { field: 'at' },
    });
    expect(
      await failure(call(() => json({ error: { code: 'misdirected', message: 'No.' } }, 421))),
    ).toMatchObject({ code: 'misdirected', status: 421 });
    // The status the reply came with, whatever its code's usual one.
    expect(
      await failure(call(() => json({ error: { code: 'forbidden', message: 'No.' } }, 409))),
    ).toMatchObject({ code: 'forbidden', status: 409 });
  });

  it('is “can’t reach its server” for a 5xx, a non-JSON reply, a reply that doesn’t parse, or no reply', async () => {
    expect(UNREACHABLE).toBe("Instante can't reach its server right now.");
    for (const reply of [
      () => json({ error: { code: 'internal', message: 'Something broke.' } }, 500),
      () => new Response('<html>Bad gateway</html>', { status: 502 }),
      () =>
        new Response('<html>Not found</html>', {
          status: 404,
          headers: { 'content-type': 'text/html' },
        }),
      () => new Response('not json', { headers: { 'content-type': 'application/json' } }),
      () => new Response(JSON.stringify(PING), { headers: { 'content-type': 'text/plain' } }),
      () => json({ ok: false }),
      () => json({ error: { code: 'no_such_code', message: 'x' } }, 400),
      () => json({ unexpected: true }, 404),
      () => Promise.reject(new TypeError('fetch failed')),
    ]) {
      expect(await failure(call(reply))).toEqual(unreachable);
    }
  });

  it('gives a file route a Blob of its media type, and refuses any other', async () => {
    const api = (reply: () => Response) =>
      createApi({ base: '', fetch: fakeFetch(reply).fetch })(pdf);
    const blob = await api(
      () => new Response('%PDF-1.7', { headers: { 'content-type': 'application/pdf' } }),
    );
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('application/pdf');
    expect(await blob.text()).toBe('%PDF-1.7');
    expect(
      await failure(
        api(() => new Response('<html></html>', { headers: { 'content-type': 'text/html' } })),
      ),
    ).toEqual(unreachable);
    // Its media type in any case and with parameters, on either side.
    const loose = defineRoute({ ...pdf, response: fileResponse('Application/PDF; x=y') });
    const reply = () =>
      new Response('%PDF', { headers: { 'content-type': 'application/pdf; charset=binary' } });
    expect(await createApi({ base: '', fetch: fakeFetch(reply).fetch })(loose)).toBeInstanceOf(
      Blob,
    );
    // A file route's errors are the contract's, as any route's.
    expect(
      await failure(
        api(() => json({ error: { code: 'unauthenticated', message: 'Sign in.' } }, 401)),
      ),
    ).toMatchObject({ code: 'unauthenticated', status: 401 });
    expect(
      await failure(
        api(
          () =>
            new Response('%PDF', { status: 404, headers: { 'content-type': 'application/pdf' } }),
        ),
      ),
    ).toEqual(unreachable);
  });

  it('lets the caller’s own abort through as itself, before the reply or while it’s read', async () => {
    const before = new AbortController();
    before.abort();
    // The fake rejects only for the caller's own signal.
    const fetch = (_url: string | URL | Request, init?: RequestInit) =>
      init?.signal === before.signal
        ? Promise.reject(before.signal.reason as Error)
        : Promise.resolve(json(PING));
    await expect(
      createApi({ base: '', fetch })(routes.ping, { signal: before.signal }),
    ).rejects.toBe(before.signal.reason);
    for (const [route, type, status] of [
      [routes.ping, 'application/json', 200],
      [routes.ping, 'application/json', 404],
      [pdf, 'application/pdf', 200],
    ] as const) {
      const during = new AbortController();
      // Read when the call settles, after the abort: so a reason of its own, known ahead.
      const reason = new DOMException('Stopped.', 'AbortError');
      const reply = stopping(type, status, during.signal);
      const call = createApi({ base: '', fetch: fakeFetch(() => reply).fetch })(route, {
        signal: during.signal,
      });
      setTimeout(() => {
        during.abort(reason);
      }, 0);
      await expect(call, `${type} ${String(status)}`).rejects.toBe(reason);
    }
  });

  it('is “can’t reach its server”, keeping the cause, when the connection fails, signal or not', async () => {
    const live = new AbortController().signal;
    for (const [route, type, signal] of [
      [routes.ping, 'application/json', undefined],
      [pdf, 'application/pdf', undefined],
      [routes.ping, 'application/json', live],
    ] as const) {
      const reply = stopping(type, 200);
      let error: unknown;
      try {
        await createApi({ base: '', fetch: fakeFetch(() => reply).fetch })(
          route,
          ...(signal === undefined ? [] : [{ signal }]),
        );
      } catch (thrown) {
        error = thrown;
      }
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ code: 'upstream_unavailable', name: 'ApiError' });
      expect((error as ApiError).cause).toEqual(new TypeError('terminated'));
    }
    const failed = new TypeError('fetch failed');
    const call = createApi({ base: '', fetch: () => Promise.reject(failed) })(routes.ping, {
      signal: live,
    });
    await expect(call).rejects.toMatchObject({ code: 'upstream_unavailable', cause: failed });
  });

  it('gives an ApiError its code’s usual status when none is given', () => {
    expect(new ApiError('not_found', 'x').status).toBe(404);
    expect(new ApiError('upstream_unavailable', UNREACHABLE).status).toBe(502);
  });
});

describe('serverBase', () => {
  it('is the backend address the build has, so a Server Component’s call matches the rewrite', () => {
    vi.stubEnv('INSTANTE_BUILT_BACKEND', 'http://127.0.0.1:4311');
    // next dev reloads this from .env.local, but the rewrite keeps the build's.
    vi.stubEnv('BACKEND_INTERNAL_URL', 'http://127.0.0.1:9999');
    expect(serverBase()).toBe('http://127.0.0.1:4311');
  });

  it('refuses to call without one', () => {
    vi.stubEnv('INSTANTE_BUILT_BACKEND', '');
    expect(() => serverBase()).toThrow('This build has no backend address (BACKEND_INTERNAL_URL)');
  });
});
