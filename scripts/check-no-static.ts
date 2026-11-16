// No static page (docs/specs/platform.md, "Cache Components is off"): every page renders per
// request, so each gets proxy.ts's fresh CSP nonce. A page `next build` prerendered has no nonce
// on its scripts, and the policy blocks them.
//
//   node scripts/check-no-static.ts [<the web app's .next folder>]   default: apps/web/.next
//
// It reads the build's prerender manifest. Files (`/favicon.ico`) aren't pages, and Next's own
// `/_global-error`, shown only when the root layout itself fails, is Next's to render.
// Exit codes: 0 no static page, 1 at least one, 2 no build to read.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const folder = process.argv[2] ?? 'apps/web/.next';
let manifest: { routes?: Record<string, unknown> };
try {
  manifest = JSON.parse(readFileSync(path.join(folder, 'prerender-manifest.json'), 'utf8')) as {
    routes?: Record<string, unknown>;
  };
} catch (error) {
  console.error(`check-no-static: no build to read in ${folder}: ${String(error)}`);
  process.exit(2);
}
const NEXTS_OWN = new Set(['/_global-error']);
const pages = Object.keys(manifest.routes ?? {}).filter(
  (route) => !NEXTS_OWN.has(route) && !/\.[a-z0-9]+$/i.test(route),
);
if (pages.length === 0) {
  console.log('check-no-static: no static page');
  process.exit(0);
}
console.error(`check-no-static: next build prerendered ${pages.join(', ')}`);
console.error(
  'Every page must render per request, for its CSP nonce: does the root layout still await headers()?',
);
process.exit(1);
