// What a request is, as proxy.ts sorts them (docs/specs/platform.md, "proxy.ts").

/** Whether a path is the backend's, which the web app passes through: `/api` and below, in
 * any case, since Next matches the `/api/:path*` rewrite without regard to case. */
export function isApi(path: string): boolean {
  const lower = path.toLowerCase();
  return lower === '/api' || lower.startsWith('/api/');
}
