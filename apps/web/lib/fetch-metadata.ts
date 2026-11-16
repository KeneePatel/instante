// Fetch Metadata (docs/specs/platform.md, "proxy.ts"): what a browser says about who started a
// request. Another site's page may send the user here with a link, a top-level navigation to a
// page, and nothing else: no fetch, form post, frame or navigation to /api.

/** The request's `Sec-Fetch-*` headers, null when absent, and what it asks for. */
export type FetchMetadata = {
  site: string | null;
  mode: string | null;
  dest: string | null;
  method: string;
  /** Whether it asks for a page, not /api. */
  page: boolean;
};

/** Whether a request may go on. One without `Sec-Fetch-Site` came from no browser, or a browser
 * too old to say; `same-origin` and `none` (typed or bookmarked) are the user's own. */
export function fetchMetadataAllows(request: FetchMetadata): boolean {
  const site = request.site?.toLowerCase();
  if (site !== 'cross-site' && site !== 'same-site') return true;
  return (
    request.method === 'GET' &&
    request.mode?.toLowerCase() === 'navigate' &&
    request.dest?.toLowerCase() === 'document' &&
    request.page
  );
}
