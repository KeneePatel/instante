import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_POLICY } from './lib/csp.ts';
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
      // Image optimization is off, so this only renders the not-found page.
      '/_next/image',
      '/_next/image/x',
      '/favicon.ico.html',
      '/faviconXico',
      '/favicon-ico',
    ]) {
      expect(matches(url), url).toBe(true);
    }
    expect(matches('/', { 'next-router-prefetch': '1' })).toBe(true);
    expect(matches('/', { purpose: 'prefetch' })).toBe(true);
  });

  it('leaves out only Next’s static files and the favicon', () => {
    for (const url of [
      '/_next/static/chunks/main.js',
      '/_next/static/media/font.woff2',
      '/_next/static/css/app.css',
      '/favicon.ico',
    ]) {
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
    for (const refused of [
      // /api in any case: Next's rewrite to the backend ignores case.
      request('/API/ping', { 'sec-fetch-site': 'cross-site', ...navigation }),
      request('/', { 'sec-fetch-site': 'cross-site', ...navigation }, 'POST'),
      // A frame, or a navigation that doesn't say where it lands.
      request('/', { 'sec-fetch-site': 'cross-site', ...navigation, 'sec-fetch-dest': 'iframe' }),
      request('/', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' }),
      // A prefetch header changes nothing.
      request('/', {
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'no-cors',
        'sec-fetch-dest': 'empty',
        purpose: 'prefetch',
      }),
    ]) {
      expect(proxy(refused).status, `${refused.method} ${refused.nextUrl.pathname}`).toBe(403);
    }
    const followed = proxy(request('/', { 'sec-fetch-site': 'cross-site', ...navigation }));
    expect(passed(followed)).toBe(true);
    expect(policy(followed)).not.toBeNull();
  });

  it('answers 404 at Next’s prerendered global error page and its image optimizer, which is off', async () => {
    for (const path of ['/_global-error', '/_global-error.rsc', '/_GLOBAL-error', '/_next/image']) {
      const response = proxy(request(path));
      expect(response.status, path).toBe(404);
      expect(await response.json()).toEqual({
        error: { code: 'not_found', message: 'Not found.' },
      });
    }
    expect(passed(proxy(request('/_global-errors')))).toBe(true);
    expect(passed(proxy(request('/_next/image/x')))).toBe(true);
    // After the Host check, as for any request.
    expect(proxy(request('/_next/image', { host: 'evil.example:4310' })).status).toBe(421);
  });

  it('passes /api through, in any case, with a policy that runs nothing and no nonce', () => {
    for (const path of ['/api/ping', '/API/ping', '/api']) {
      const response = proxy(request(path));
      expect(passed(response), path).toBe(true);
      expect(policy(response), path).toBe(API_POLICY);
      expect(response.headers.get('x-middleware-request-x-nonce')).toBeNull();
    }
  });

  it('gives a prefetch a page’s policy and nonce, as any page', () => {
    for (const headers of [{ 'next-router-prefetch': '1' }, { purpose: 'prefetch' }]) {
      const response = proxy(request('/settings', headers));
      expect(passed(response)).toBe(true);
      expect(response.headers.get('x-middleware-request-x-nonce')).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      expect(policy(response)).toContain("script-src 'self' 'nonce-");
    }
  });

  it('gives each page a fresh nonce, in its policy on the response and on the request Next renders', () => {
    const nonces = [request('/'), request('/settings')].map((each) => {
      each.headers.set('cookie', 'session=1');
      const response = proxy(each);
      expect(passed(response)).toBe(true);
      // The request Next renders keeps everything it came with, beside the nonce and policy.
      expect(response.headers.get('x-middleware-override-headers')?.split(',')).toEqual(
        expect.arrayContaining(['host', 'cookie', 'sec-fetch-site', 'x-nonce']),
      );
      expect(response.headers.get('x-middleware-request-host')).toBe(HOST);
      expect(response.headers.get('x-middleware-request-cookie')).toBe('session=1');
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
