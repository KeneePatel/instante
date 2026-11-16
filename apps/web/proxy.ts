import { NextResponse, type NextRequest } from 'next/server';
import { API_POLICY, contentSecurityPolicy, newNonce } from './lib/csp.ts';
import { fetchMetadataAllows } from './lib/fetch-metadata.ts';
import { hostAllowed } from './lib/host.ts';
import { isApi } from './lib/request.ts';

// The web app's request rules (docs/specs/platform.md, "proxy.ts"; Next.js 16's name for
// middleware), in order:
// 1. `Host` must be ALLOWED_HOST, read from the header (the URL's host is the server's own);
// 2. Fetch Metadata: another site's page may only navigate to a page; then /_next/image and
//    Next's prerendered /_global-error answer 404;
// 3. /api passes through, to the backend's own answer, with a policy that runs nothing;
// 4. everything else gets a nonce and the pages' Content-Security-Policy, on the request and the
//    response. Prefetches too: Next removes its router's prefetch headers before proxy.ts runs,
//    and a page the browser prefetches itself may be shown.
// `accounts` adds the session refresh after 4 (docs/specs/accounts.md); /api never gets it.

/** A refusal in the backend's error shape, so /api's callers read it the same way. */
function refuse(
  status: 421 | 403 | 404,
  code: 'misdirected' | 'forbidden' | 'not_found',
  message: string,
) {
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
  // Nothing is served at these, and each would do harm: Next prerenders its own global error
  // page with no nonce on its scripts (real errors are rendered per request), and with image
  // optimization off, Next's image handler only renders the not-found page after trying to
  // write its cache, which the permission model refuses.
  if (/^\/(_global-error(\.rsc)?|_next\/image)$/i.test(path)) {
    return refuse(404, 'not_found', 'Not found.');
  }
  if (isApi(path)) {
    const response = NextResponse.next();
    response.headers.set('content-security-policy', API_POLICY);
    return response;
  }

  const nonce = newNonce();
  const policy = contentSecurityPolicy(nonce, { dev: process.env.NODE_ENV === 'development' });
  const forwarded = new Headers(headers);
  forwarded.set('x-nonce', nonce);
  forwarded.set('content-security-policy', policy);
  const response = NextResponse.next({ request: { headers: forwarded } });
  response.headers.set('content-security-policy', policy);
  return response;
}

// Every request but Next's static files and the favicon: /api and prefetches included, with no
// header conditions. /_next/image too, which image optimization being off (next.config.ts) left
// rendering an unchecked not-found page: it gets the Host and Fetch Metadata checks, then 404.
export const config = {
  matcher: ['/((?!_next/static/|favicon\\.ico$).*)'],
};
