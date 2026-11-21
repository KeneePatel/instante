import type { NextConfig } from 'next';
import { backendUrlProblem } from './lib/backend.ts';

/** Next's PHASE_PRODUCTION_SERVER (`next start`), written out: under the production command,
 * Node's own type stripping loads this file, and `next/constants` doesn't resolve there. */
export const STARTING = 'phase-production-server';

// The backend's loopback address (docs/specs/platform.md, "next.config.ts"): the /api rewrite
// is fixed at build time, so each build (development, CI, a release on the Mac) carries its
// own, and instrumentation.ts stops a server started with another.
export default function config(phase: string): NextConfig {
  const backend = process.env['BACKEND_INTERNAL_URL'] ?? '';
  const problem = backendUrlProblem(backend);
  // At start the build's address is already fixed, and register() stops a server whose address
  // differs from it, saying why; thrown here, Next would report a config loader failure instead.
  if (problem !== undefined && phase !== STARTING) throw new Error(problem);
  return {
    // Off (decision D6): every page is per person and renders dynamically, which
    // allows the nonce-based CSP that `proxy.ts` sets (docs/decisions/ADR-005).
    cacheComponents: false,
    // The address the rewrite was built with, inlined where instrumentation.ts reads it.
    env: { INSTANTE_BUILT_BACKEND: backend },
    rewrites: () =>
      Promise.resolve(
        backend === '' ? [] : [{ source: '/api/:path*', destination: `${backend}/api/:path*` }],
      ),
    experimental: {
      // Written out so a change of Next's default shows; it's an idle timeout.
      proxyTimeout: 30_000,
    },
    images: { unoptimized: true },
    // The end-to-end build's fixture pages (T19): `page.e2e.tsx` files under `e2e/` folders,
    // which reach the error screens the app ships no way into. Only a build with
    // INSTANTE_E2E_PAGES=1 has them as pages; to any other build, the file is no page at all.
    ...(process.env['INSTANTE_E2E_PAGES'] === '1'
      ? { pageExtensions: ['tsx', 'ts', 'jsx', 'js', 'e2e.tsx'] }
      : {}),
    turbopack: {
      rules: {
        '*.css': {
          loaders: ['@tailwindcss/turbopack'],
          as: '*.css',
        },
      },
    },
  };
}
