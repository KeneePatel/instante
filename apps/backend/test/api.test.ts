import { createHash } from 'node:crypto';
import { EchoResponseSchema, PingResponseSchema } from '@instante/contract';
import { describe, expect, it } from 'vitest';
import { FIXTURE_PDF } from '../src/api/handlers/test-routes.ts';
import { ALLOWED_HOST, OWN_HOST, errorCode, testApp } from './helpers.ts';

// Routes through app.request: the checks every request passes, and the walking skeleton's
// routes (docs/specs/platform.md, "apps/backend" and the acceptance criteria).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('the backend', () => {
  describe('answers only to its own address', () => {
    it.each([
      ['another host', { host: 'evil.test' }],
      ['the web app’s host, sent directly', { host: ALLOWED_HOST }],
      ['localhost instead of 127.0.0.1', { host: 'localhost:4321' }],
      ['its own address with a longer port', { host: '127.0.0.1:43210' }],
      ['an empty forwarded host', { 'x-forwarded-host': '' }],
      ['another port', { host: '127.0.0.1:4311' }],
      ['a forwarded host that is not the web app’s', { 'x-forwarded-host': 'evil.test' }],
      ['two forwarded hosts', { 'x-forwarded-host': `${ALLOWED_HOST}, evil.test` }],
      ['a forwarded host of the wrong case', { 'x-forwarded-host': 'LOCALHOST:4320' }],
    ])('refusing %s with 421', async (_case, headers) => {
      const { call } = testApp();
      const response = await call('/api/ping', { headers });
      expect(response.status).toBe(421);
      expect(await errorCode(response)).toBe('misdirected');
    });

    it('and takes a request the web app forwarded', async () => {
      const { call } = testApp();
      const response = await call('/api/ping', { headers: { 'x-forwarded-host': ALLOWED_HOST } });
      expect(response.status).toBe(200);
    });

    it('and refuses a request with no Host at all', async () => {
      const { app } = testApp();
      const response = await app.request(`http://${OWN_HOST}/api/ping`);
      expect(response.status).toBe(421);
    });

    it('checks the Host header, never the address in the request line', async () => {
      const { app } = testApp();
      const response = await app.request(`http://${OWN_HOST}/api/ping`, {
        headers: { host: 'evil.test' },
      });
      expect(response.status).toBe(421);
    });
  });

  describe('refuses requests another site started', () => {
    it.each(['cross-site', 'same-site', 'Cross-Site'])(
      'with 403 for Sec-Fetch-Site: %s',
      async (site) => {
        const { call } = testApp();
        const response = await call('/api/ping', { headers: { 'sec-fetch-site': site } });
        expect(response.status).toBe(403);
        expect(await errorCode(response)).toBe('forbidden');
      },
    );

    it.each(['same-origin', 'none'])('and takes Sec-Fetch-Site: %s', async (site) => {
      const { call } = testApp();
      expect((await call('/api/ping', { headers: { 'sec-fetch-site': site } })).status).toBe(200);
    });

    it('and takes requests without the header, as Server Components send', async () => {
      const { call } = testApp();
      expect((await call('/api/ping')).status).toBe(200);
    });

    it('after the Host check', async () => {
      const { call } = testApp();
      const response = await call('/api/ping', {
        headers: { host: 'evil.test', 'sec-fetch-site': 'cross-site' },
      });
      expect(response.status).toBe(421);
    });
  });

  it('removes Cookie before any route can read it', async () => {
    const { app, call } = testApp();
    app.get('/api/probe-cookie', (c) =>
      c.json({ header: c.req.header('cookie') ?? null, raw: c.req.raw.headers.has('cookie') }),
    );
    const response = await call('/api/probe-cookie', {
      headers: { cookie: 'sb-abcd-auth-token=v' },
    });
    expect(await response.json()).toEqual({ header: null, raw: false });
  });

  it('hands each route the request’s own logger, carrying its id', async () => {
    const { app, call, lines } = testApp();
    app.get('/api/probe-log', (c) => {
      c.get('logger').info('probe');
      return c.json({});
    });
    const response = await call('/api/probe-log');
    expect(lines).toContainEqual(
      expect.objectContaining({ event: 'probe', requestId: response.headers.get('x-request-id') }),
    );
  });

  it('reports an empty Authorization to echo as present, with its hash', async () => {
    const { call } = testApp();
    const response = await call('/api/test/echo', {
      method: 'POST',
      headers: { authorization: '' },
      body: '',
    });
    expect(await response.json()).toMatchObject({
      authorizationSha256: createHash('sha256').update('').digest('hex'),
    });
  });

  it('drops Cookie, and shows Authorization to the route unchanged', async () => {
    const { call } = testApp();
    const authorization = 'Bearer eyJhbGciOi.payload.signature';
    const response = await call('/api/test/echo', {
      method: 'POST',
      headers: { authorization, cookie: 'sb-abcd-auth-token=v', 'content-type': 'text/plain' },
      body: 'four',
    });
    expect(EchoResponseSchema.parse(await response.json())).toEqual({
      authorizationSha256: createHash('sha256').update(authorization).digest('hex'),
      cookieArrived: true,
      bodyBytes: 4,
    });
    const bare = await call('/api/test/echo', { method: 'POST', body: '' });
    expect(await bare.json()).toEqual({
      authorizationSha256: null,
      cookieArrived: false,
      bodyBytes: 0,
    });
  });

  it('refuses a 6 MB body to echo with 413, before reading it', async () => {
    const { call } = testApp();
    const response = await call('/api/test/echo', {
      method: 'POST',
      headers: { 'content-length': String(6 * 1024 * 1024) },
      body: new Uint8Array(6 * 1024 * 1024),
    });
    expect(response.status).toBe(413);
    expect(await errorCode(response)).toBe('payload_too_large');
  });

  describe('on every reply', () => {
    it.each([
      ['a success', {}, '/api/ping'],
      ['a 421', { host: 'evil.test' }, '/api/ping'],
      ['a 403', { 'sec-fetch-site': 'cross-site' }, '/api/ping'],
      ['a 401', {}, '/api/test/user-only'],
      ['an unknown path', {}, '/api/nowhere'],
      ['/healthz', {}, '/healthz'],
    ])('after %s, says not to cache and to vary by Authorization', async (_case, headers, path) => {
      const { call } = testApp();
      const response = await call(path, { headers });
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('vary')).toBe('Authorization');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('x-request-id')).toMatch(UUID);
    });

    it('logs one line with the request id, method, path and status, and no query', async () => {
      const { call, lines } = testApp();
      const response = await call('/api/test/slow?seconds=1', { headers: { host: 'evil.test' } });
      expect(lines).toEqual([
        {
          at: '2026-11-13T16:00:00.000Z',
          level: 'info',
          event: 'request',
          requestId: response.headers.get('x-request-id'),
          method: 'GET',
          path: '/api/test/slow',
          status: 421,
          ms: 0,
        },
      ]);
    });
  });

  it('answers GET /healthz and GET /api/ping', async () => {
    const { call } = testApp();
    expect(await (await call('/healthz')).json()).toEqual({ ok: true });
    expect(PingResponseSchema.parse(await (await call('/api/ping')).json())).toEqual({
      ok: true,
      at: '2026-11-13T16:00:00.000Z',
    });
  });

  describe('the test routes', () => {
    it('a path no route matches asks for sign-in, and only a signed-in caller gets 404', async () => {
      const { call } = testApp({
        authenticate: (authorization) =>
          Promise.resolve(authorization === 'Bearer good' ? { userId: 'u1' } : null),
      });
      expect((await call('/api/nowhere')).status).toBe(401);
      expect(
        (await call('/api/nowhere', { headers: { authorization: 'Bearer bad' } })).status,
      ).toBe(401);
      expect(
        (await call('/api/nowhere', { headers: { authorization: 'Bearer good' } })).status,
      ).toBe(404);
    });

    it('are not registered unless asked for, as in production', async () => {
      const signedIn = testApp({
        testRoutes: false,
        authenticate: () => Promise.resolve({ userId: 'u1' }),
      });
      for (const path of ['/api/test/echo', '/api/test/slow?seconds=0', '/api/test/file.pdf']) {
        const response = await signedIn.call(path);
        expect(response.status).toBe(404);
      }
      expect((await signedIn.call('/api/ping')).status).toBe(200);
    });

    it('slow sends its reply only once its wait is over', async () => {
      let release = (): void => {};
      const { call } = testApp({
        sleep: () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      });
      let settled = false;
      const pending = call('/api/test/slow?seconds=5').then((response) => {
        settled = true;
        return response;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);
      release();
      expect((await pending).status).toBe(200);
    });

    it('slow waits as long as asked before it sends anything', async () => {
      const { call, slept } = testApp();
      expect((await call('/api/test/slow?seconds=35')).status).toBe(200);
      expect(slept).toEqual([35_000]);
      expect((await call('/api/test/slow?seconds=61')).status).toBe(422);
    });

    it('file.pdf sends a whole PDF, its cross-reference table pointing at each object', async () => {
      const { call } = testApp();
      const response = await call('/api/test/file.pdf');
      expect(response.headers.get('content-type')).toBe('application/pdf');
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes).toEqual(FIXTURE_PDF);
      const text = new TextDecoder().decode(bytes);
      expect(text.startsWith('%PDF-1.7\n')).toBe(true);
      expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
      const offsets = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
      offsets.forEach((offset, i) => {
        expect(text.slice(offset).startsWith(`${String(i + 1)} 0 obj`)).toBe(true);
      });
      const startxref = Number(/startxref\n(\d+)\n/.exec(text)?.[1]);
      expect(text.slice(startxref).startsWith('xref\n')).toBe(true);
      // The trailer's root is the catalog, whose pages hold the one page.
      const object = (n: number) => text.slice(offsets[n - 1]).split('endobj')[0] ?? '';
      expect(text).toMatch(/trailer\n<< \/Size 4 \/Root 1 0 R >>/);
      expect(object(1)).toMatch(/\/Type \/Catalog \/Pages 2 0 R/);
      expect(object(2)).toMatch(/\/Type \/Pages \/Kids \[3 0 R\] \/Count 1/);
      expect(object(3)).toMatch(/\/Type \/Page \/Parent 2 0 R .*\/Resources/);
    });
  });

  it('answers a failure with a plain 500, and logs it sanitized', async () => {
    const { app, call, lines } = testApp();
    app.get('/api/boom', () => {
      throw Object.assign(new Error('duplicate key'), {
        severity: 'ERROR',
        code: '23505',
        detail: 'Key (email)=(jordan@example.com) already exists.',
      });
    });
    const response = await call('/api/boom');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: 'internal', message: 'Something went wrong.' },
    });
    expect(JSON.stringify(lines)).not.toMatch(/jordan/);
    expect(lines).toContainEqual(
      expect.objectContaining({
        event: 'request.failed',
        requestId: response.headers.get('x-request-id'),
        error: { name: 'DatabaseError', code: '23505' },
      }),
    );
  });
});
