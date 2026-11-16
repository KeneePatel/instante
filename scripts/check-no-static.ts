// No static page (docs/specs/platform.md, "Cache Components is off"): every page renders per
// request, so each gets proxy.ts's fresh CSP nonce. A page `next build` prerendered has no nonce
// on its scripts, and the policy blocks them.
//
//   node scripts/check-no-static.ts [<the web app's .next folder>]   default: apps/web/.next
//
// It reads the build's prerender manifest (version 4, as Next 16.4 writes it), and counts the
// routes it marks as pages. Next's own `/_global-error` is left out: Next always prerenders it,
// real errors are rendered per request, and proxy.ts answers 404 at its address.
// Exit codes: 0 no static page, 1 at least one, 2 no build it can read.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const folder = process.argv[2] ?? 'apps/web/.next';
const file = path.join(folder, 'prerender-manifest.json');
let manifest: unknown;
try {
  manifest = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
  console.error(`check-no-static: no build to read in ${folder}: ${String(error)}`);
  process.exit(2);
}
const { version, routes } = (manifest ?? {}) as { version?: unknown; routes?: unknown };
if (version !== 4 || typeof routes !== 'object' || routes === null) {
  console.error(`check-no-static: ${file} isn't the version 4 manifest this check reads`);
  process.exit(2);
}
const NEXTS_OWN = new Set(['/_global-error']);
const pages = Object.entries(routes as Record<string, { routeType?: unknown }>)
  .filter(([route, entry]) => entry.routeType === 'page' && !NEXTS_OWN.has(route))
  .map(([route]) => route);
if (pages.length === 0) {
  console.log('check-no-static: no static page');
  process.exit(0);
}
console.error(`check-no-static: next build prerendered ${pages.join(', ')}`);
console.error(
  'Every page must render per request, for its CSP nonce: does the root layout still await headers()?',
);
process.exit(1);
