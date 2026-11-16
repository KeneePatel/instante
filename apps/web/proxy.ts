import { NextResponse, type NextRequest } from 'next/server';
import { contentSecurityPolicy, newNonce } from './lib/csp.ts';
import { fetchMetadataAllows } from './lib/fetch-metadata.ts';
import { hostAllowed } from './lib/host.ts';
import { isApi, isPrefetch } from './lib/request.ts';

// The web app's request rules (docs/specs/platform.md, "proxy.ts"; Next.js 16's name for
// middleware), in order:
// 1. `Host` must be ALLOWED_HOST, read from the header (the URL's host is the server's own);
// 2. Fetch Metadata: another site's page may only navigate to a page;
// 3. /api passes through, to the backend's own answer; prefetches skip the CSP;
// 4. pages get a nonce and the Content-Security-Policy, on the request and the response.
// `accounts` adds the session refresh between 2 and 3.

/** A refusal in the backend's error shape, so /api's callers read it the same way. */
function refuse(status: 421 | 403, code: 'misdirected' | 'forbidden', message: string) {
  return Response.json({ error: { code, message } }, { status });
}

export function proxy(request: NextRequest): Response {
  const { headers } = request;
  if (!hostAllowed(headers.get('host'), process.env['ALLOWED_HOST'])) {
    return refuse(421, 'misdirected', 'Instante answers only at its own address.');
  }
  const path = request.nextUrl.pathname;
  const allowed = fetchMetadataAllows({
    site: headers.get('sec-fetch-site'),
    mode: headers.get('sec-fetch-mode'),
    dest: headers.get('sec-fetch-dest'),
    method: request.method,
    page: !isApi(path),
  });
  if (!allowed) return refuse(403, 'forbidden', "Another site's page can't make this request.");
  if (isApi(path) || isPrefetch(headers)) return NextResponse.next();

  const nonce = newNonce();
  const policy = contentSecurityPolicy(nonce, { dev: process.env.NODE_ENV === 'development' });
  const forwarded = new Headers(headers);
  forwarded.set('x-nonce', nonce);
  forwarded.set('content-security-policy', policy);
  const response = NextResponse.next({ request: { headers: forwarded } });
  response.headers.set('content-security-policy', policy);
  return response;
}

// Every request but Next's static files, image optimizer and the favicon: /api and prefetches
// included, with no header conditions.
export const config = {
  matcher: ['/((?!_next/static/|_next/image$|favicon\\.ico$).*)'],
};
