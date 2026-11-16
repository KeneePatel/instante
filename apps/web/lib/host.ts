// The one `Host` the web app answers (docs/specs/platform.md, "proxy.ts"): a page on another
// site that resolves its own name to this Mac (DNS rebinding) sends its own name, and gets 421.

/** Whether a request's `Host` is exactly `ALLOWED_HOST`, port included. With no
 * `ALLOWED_HOST`, nothing is. */
export function hostAllowed(host: string | null, allowed: string | undefined): boolean {
  return allowed !== undefined && allowed !== '' && host === allowed;
}
