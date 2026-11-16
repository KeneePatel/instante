// The pages' Content-Security-Policy (docs/specs/platform.md, "proxy.ts"), after Next's CSP
// guide: a fresh nonce per request, which Next puts on its own scripts and styles. No
// `upgrade-insecure-requests`: real use is plain http on loopback.

/** A nonce: 16 random bytes, in base64. */
export function newNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
}

/** The policy for one page. `dev` adds what `next dev` needs (`'unsafe-eval'`, for React's
 * error stacks); `connect` adds the addresses the browser may call beside this one. */
export function contentSecurityPolicy(
  nonce: string,
  options: { dev: boolean; connect?: readonly string[] },
): string {
  const scripts = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  if (options.dev) scripts.push("'unsafe-eval'");
  return [
    "default-src 'self'",
    `script-src ${scripts.join(' ')}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: blob:",
    `connect-src ${["'self'", ...(options.connect ?? [])].join(' ')}`,
    'frame-src blob:',
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}
