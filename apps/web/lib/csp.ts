// The pages' Content-Security-Policy (docs/specs/platform.md, "proxy.ts"), after Next's CSP
// guide: a fresh nonce per request, which Next puts on its own scripts and styles. No
// `upgrade-insecure-requests`: real use is plain http on loopback.

/** What answers under /api: the backend's JSON, never a page. Should Next render HTML there
 * instead (no route answering, as for `/_next/data/<id>/api/….json`, whose path Next reads as
 * /api), it runs nothing. */
export const API_POLICY = "default-src 'none'; frame-ancestors 'none'";

/** A nonce: 16 random bytes, in base64. */
export function newNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
}

/** The policy for one page. `dev` adds what `next dev` needs: `'unsafe-eval'`, for React's
 * error stacks, and inline styles, which Next's own tools insert with no nonce (none for styles
 * then, since browsers ignore `'unsafe-inline'` beside a nonce). `connect` adds the addresses
 * the browser may call beside this one. Style attributes are allowed: they run no script, and
 * React renders them on the server without restoring any a policy blocks (the owner's choice,
 * 2026-11-16). */
export function contentSecurityPolicy(
  nonce: string,
  options: { dev: boolean; connect?: readonly string[] },
): string {
  const scripts = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  if (options.dev) scripts.push("'unsafe-eval'");
  const styles = options.dev ? ["'self'", "'unsafe-inline'"] : ["'self'", `'nonce-${nonce}'`];
  return [
    "default-src 'self'",
    `script-src ${scripts.join(' ')}`,
    `style-src ${styles.join(' ')}`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    `connect-src ${["'self'", ...(options.connect ?? [])].join(' ')}`,
    'frame-src blob:',
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}
