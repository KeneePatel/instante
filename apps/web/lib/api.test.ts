import {
  EchoResponseSchema,
  PingResponseSchema,
  defineRoute,
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

  it('is parsed with the route’s schema', async () => {
    expect(await call(() => json(PING))).toEqual(PING);
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
  });

  it('lets the caller’s own abort through as itself', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetch } = fakeFetch(() => Promise.reject(controller.signal.reason as Error));
    await expect(
      createApi({ base: '', fetch })(routes.ping, { signal: controller.signal }),
    ).rejects.toBe(controller.signal.reason);
  });
});

describe('serverBase', () => {
  it('is the backend address the build has, so a Server Component’s call matches the rewrite', () => {
    vi.stubEnv('INSTANTE_BUILT_BACKEND', 'http://127.0.0.1:4311');
    expect(serverBase()).toBe('http://127.0.0.1:4311');
  });

  it('refuses to call without one', () => {
    vi.stubEnv('INSTANTE_BUILT_BACKEND', '');
    expect(() => serverBase()).toThrow('This build has no backend address (BACKEND_INTERNAL_URL)');
  });
});
