import { describe, expect, it } from 'vitest';
import { API_POLICY, contentSecurityPolicy, newNonce } from './csp.ts';
import { fetchMetadataAllows, type FetchMetadata } from './fetch-metadata.ts';
import { hostAllowed } from './host.ts';
import { isApi } from './request.ts';

// The web app's request rules (docs/specs/platform.md, "proxy.ts"; T14), as pure functions:
// proxy.ts applies them in this order, and proxy.test.ts checks it does.

describe('hostAllowed', () => {
  it('takes exactly ALLOWED_HOST, port included', () => {
    expect(hostAllowed('instante.localhost:4310', 'instante.localhost:4310')).toBe(true);
    expect(hostAllowed('localhost:3000', 'localhost:3000')).toBe(true);
  });

  it('refuses any other host: another port, another name, another spelling, none at all', () => {
    for (const host of [
      'instante.localhost:4311',
      'instante.localhost',
      'evil.example:4310',
      '127.0.0.1:4310',
      'INSTANTE.localhost:4310',
      'instante.localhost:4310.',
      ' instante.localhost:4310',
      '',
      null,
    ]) {
      expect(hostAllowed(host, 'instante.localhost:4310'), String(host)).toBe(false);
    }
  });

  it('refuses everything when ALLOWED_HOST isn’t set', () => {
    expect(hostAllowed('localhost:3000', undefined)).toBe(false);
    expect(hostAllowed('', '')).toBe(false);
    expect(hostAllowed(null, undefined)).toBe(false);
  });
});

describe('fetchMetadataAllows', () => {
  const request = (change: Partial<FetchMetadata> = {}): FetchMetadata => ({
    site: 'cross-site',
    mode: 'navigate',
    dest: 'document',
    method: 'GET',
    page: true,
    ...change,
  });

  it('lets through what the browser says this site started, the user started, or no browser sent', () => {
    for (const site of ['same-origin', 'none', null]) {
      for (const mode of ['cors', 'no-cors', 'navigate']) {
        expect(fetchMetadataAllows(request({ site, mode, page: false, method: 'POST' }))).toBe(
          true,
        );
      }
    }
  });

  it('lets through a top-level GET navigation to a page from another site', () => {
    expect(fetchMetadataAllows(request())).toBe(true);
    expect(fetchMetadataAllows(request({ site: 'same-site' }))).toBe(true);
  });

  it('refuses anything else another site started: a fetch, a form post, a frame, a navigation to /api', () => {
    for (const site of ['cross-site', 'same-site']) {
      for (const change of [
        { mode: 'cors' },
        { mode: 'no-cors', dest: 'script' },
        { mode: 'same-origin' },
        { method: 'POST' },
        { method: 'HEAD' },
        { dest: 'iframe' },
        { dest: 'embed' },
        { dest: null },
        { page: false },
        { mode: null },
      ]) {
        expect(fetchMetadataAllows(request({ site, ...change })), JSON.stringify(change)).toBe(
          false,
        );
      }
    }
  });

  it('reads the headers as browsers send them, in any case', () => {
    expect(fetchMetadataAllows(request({ site: 'Cross-Site', mode: 'cors' }))).toBe(false);
    expect(
      fetchMetadataAllows(request({ site: 'CROSS-SITE', mode: 'NAVIGATE', dest: 'Document' })),
    ).toBe(true);
  });
});

describe('isApi', () => {
  it('knows /api and what’s under it, in any case, as Next’s rewrite does, and nothing that only starts like it', () => {
    for (const path of ['/api', '/api/', '/api/ping', '/API', '/API/ping', '/Api/x/y', '/aPi']) {
      expect(isApi(path), path).toBe(true);
    }
    for (const path of ['/apis', '/APIs', '/apiary/x', '/', '/x/api/ping', '/ap', '/api.json']) {
      expect(isApi(path), path).toBe(false);
    }
  });
});

describe('contentSecurityPolicy', () => {
  it('is the platform spec’s policy, with the nonce for scripts and styles', () => {
    expect(contentSecurityPolicy('abc123', { dev: false })).toBe(
      [
        "default-src 'self'",
        "script-src 'self' 'nonce-abc123' 'strict-dynamic'",
        "style-src 'self' 'nonce-abc123'",
        "img-src 'self' data: blob:",
        "connect-src 'self'",
        'frame-src blob:',
        "object-src 'none'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self'",
      ].join('; '),
    );
  });

  it('adds what accounts connects to, after self', () => {
    expect(
      contentSecurityPolicy('n', { dev: false, connect: ['https://auth.example.supabase.co'] }),
    ).toContain("connect-src 'self' https://auth.example.supabase.co;");
  });

  it('allows eval in development only, as Next’s guide asks for next dev', () => {
    const dev = contentSecurityPolicy('n', { dev: true });
    expect(dev).toContain("script-src 'self' 'nonce-n' 'strict-dynamic' 'unsafe-eval';");
    expect(contentSecurityPolicy('n', { dev: false })).not.toContain('unsafe');
    // Production's policy is development's without the eval, and nothing else.
    expect(dev.replace(" 'unsafe-eval'", '')).toBe(contentSecurityPolicy('n', { dev: false }));
  });

  it('gives /api a policy that runs nothing, should Next render a page there', () => {
    expect(API_POLICY).toBe("default-src 'none'; frame-ancestors 'none'");
  });

  it('never upgrades to https: real use is plain http on loopback', () => {
    expect(contentSecurityPolicy('n', { dev: false })).not.toContain('upgrade-insecure-requests');
  });
});

describe('newNonce', () => {
  it('is 16 random bytes in base64, new each time', () => {
    const nonces = new Set(Array.from({ length: 100 }, () => newNonce()));
    expect(nonces.size).toBe(100);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      expect(Buffer.from(nonce, 'base64')).toHaveLength(16);
    }
  });
});
