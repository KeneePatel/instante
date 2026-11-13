import { describe, expect, it } from 'vitest';
import { EchoResponseSchema, PingResponseSchema, routes, testRoutes } from './index.ts';

const all = [...Object.values(routes), ...Object.values(testRoutes)];

describe('the route tables', () => {
  it('declare each method and path once, across both tables', () => {
    const keys = all.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keep every test route under /api/test/, and no other route there', () => {
    for (const r of Object.values(testRoutes)) expect(r.path).toMatch(/^\/api\/test\//);
    for (const r of Object.values(routes)) expect(r.path).not.toMatch(/^\/api\/test\//);
  });

  it('give GET /api/ping a public reply of { ok: true, at }', () => {
    expect(routes.ping).toMatchObject({ method: 'GET', path: '/api/ping', auth: 'public' });
    expect(PingResponseSchema.parse({ ok: true, at: '2026-11-13T16:00:00.000Z' })).toBeTruthy();
    expect(PingResponseSchema.safeParse({ ok: true, at: 'yesterday' }).success).toBe(false);
  });

  it('give the test routes what the platform spec asks of them', () => {
    expect(testRoutes.userOnly.auth).toBe('user');
    expect(testRoutes.echo).toMatchObject({ method: 'POST', maxBodyBytes: 5 * 1024 * 1024 });
    expect(testRoutes.slow.query.parse({ seconds: '35' })).toEqual({ seconds: 35 });
    expect(testRoutes.filePdf.response).toEqual({ kind: 'file', contentType: 'application/pdf' });
  });

  it("describe echo's reply: a hash of Authorization, whether a cookie arrived, the body's size", () => {
    expect(
      EchoResponseSchema.parse({ authorizationSha256: null, cookieArrived: false, bodyBytes: 0 }),
    ).toBeTruthy();
    expect(
      EchoResponseSchema.safeParse({
        authorizationSha256: 'not-a-hash',
        cookieArrived: false,
        bodyBytes: 0,
      }).success,
    ).toBe(false);
  });
});
