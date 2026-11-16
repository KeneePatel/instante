// What a request is, as proxy.ts sorts them (docs/specs/platform.md, "proxy.ts").

/** Whether a path is the backend's, which the web app passes through: `/api` and below. */
export function isApi(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/** Whether Next's router (`next-router-prefetch`) or the browser (`Purpose: prefetch`) is
 * fetching a page ahead of a visit. */
export function isPrefetch(headers: Headers): boolean {
  return (
    headers.has('next-router-prefetch') || headers.get('purpose')?.toLowerCase() === 'prefetch'
  );
}
