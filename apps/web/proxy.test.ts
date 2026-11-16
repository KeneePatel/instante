import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config, proxy } from './proxy.ts';

// proxy.ts (docs/specs/platform.md, "proxy.ts"; T14): which requests it sees, and its rules in
// order, through Next's own request type. The rules themselves are in lib/rules.test.ts.

const HOST = 'instante.localhost:4310';

beforeEach(() => {
  vi.stubEnv('ALLOWED_HOST', HOST);
  vi.stubEnv('NODE_ENV', 'production');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** A request as a browser sends it to `path`, from this site unless the headers say otherwise. */
function request(path: string, headers: Record<string, string> = {}, method = 'GET') {
  return new NextRequest(`http://${HOST}${path}`, {
    method,
    headers: { host: HOST, 'sec-fetch-site': 'same-origin', ...headers },
  });
}
/** Whether proxy.ts let the request go on to Next. */
const passed = (response: Response) => response.headers.get('x-middleware-next') === '1';
const policy = (response: Response) => response.headers.get('content-security-policy');

describe('the matcher', () => {
  const matches = (url: string, headers: Record<string, string> = {}) =>
    unstable_doesMiddlewareMatch({ config, url, headers });

  it('takes every page, /api and the rest, prefetches included', () => {
    for (const url of [
      '/',
      '/settings',
      '/api',
      '/api/ping',
      '/_next/data/build/index.json',
      '/file.svg',
      '/_next/staticky',
      '/_next/image/x',
      '/favicon.ico.html',
    ]) {
      expect(matches(url), url).toBe(true);
    }
    expect(matches('/', { 'next-router-prefetch': '1' })).toBe(true);
    expect(matches('/', { purpose: 'prefetch' })).toBe(true);
  });

  it('leaves out only Next’s static files, its image optimizer and the favicon', () => {
    for (const url of ['/_next/static/chunks/main.js', '/_next/image', '/favicon.ico']) {
      expect(matches(url), url).toBe(false);
    }
  });
});

describe('proxy', () => {
  it('answers 421 to another Host, on a page, a prefetch and /api alike, before anything else', async () => {
    for (const [path, headers] of [
      ['/', {}],
      ['/', { 'next-router-prefetch': '1' }],
      ['/api/ping', {}],
      ['/api/ping', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' }],
    ] as const) {
      const response = proxy(request(path, { ...headers, host: 'evil.example:4310' }));
      expect(response.status, path).toBe(421);
      expect(await response.json()).toEqual({
        error: { code: 'misdirected', message: 'Instante answers only at its own address.' },
      });
      expect(policy(response)).toBeNull();
    }
  });

  it('answers 421 to everything while ALLOWED_HOST isn’t set', () => {
    vi.stubEnv('ALLOWED_HOST', undefined);
    expect(proxy(request('/')).status).toBe(421);
  });

  it('answers 403 to what another site’s page starts, but lets it navigate to a page', async () => {
    const fetched = proxy(
      request('/api/ping', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' }),
    );
    expect(fetched.status).toBe(403);
    expect(await fetched.json()).toEqual({
      error: { code: 'forbidden', message: "Another site's page can't make this request." },
    });
    const navigation = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    expect(
      proxy(request('/api/ping', { 'sec-fetch-site': 'same-site', ...navigation })).status,
    ).toBe(403);
    expect(
      proxy(request('/', { 'sec-fetch-site': 'cross-site', ...navigation }, 'POST')).status,
    ).toBe(403);
    const followed = proxy(request('/', { 'sec-fetch-site': 'cross-site', ...navigation }));
    expect(passed(followed)).toBe(true);
    expect(policy(followed)).not.toBeNull();
  });

  it('passes /api and prefetches through without a policy', () => {
    for (const response of [
      proxy(request('/api/ping')),
      proxy(request('/', { 'next-router-prefetch': '1' })),
      proxy(request('/settings', { purpose: 'prefetch' })),
    ]) {
      expect(passed(response)).toBe(true);
      expect(policy(response)).toBeNull();
      expect(response.headers.get('x-middleware-request-x-nonce')).toBeNull();
    }
  });

  it('gives each page a fresh nonce, in its policy on the response and on the request Next renders', () => {
    const nonces = [request('/'), request('/settings')].map((each) => {
      const response = proxy(each);
      expect(passed(response)).toBe(true);
      const nonce = response.headers.get('x-middleware-request-x-nonce') ?? '';
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      expect(policy(response)).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic';`);
      expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(
        policy(response),
      );
      return nonce;
    });
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it('allows eval in the policy only under next dev', () => {
    expect(policy(proxy(request('/')))).not.toContain('unsafe-eval');
    vi.stubEnv('NODE_ENV', 'development');
    expect(policy(proxy(request('/')))).toContain("'unsafe-eval'");
  });
});
