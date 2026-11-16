import type { NextConfig } from 'next';
import { backendUrlProblem } from './lib/backend.ts';

// The backend's loopback address (docs/specs/platform.md, "next.config.ts"): the /api rewrite
// is fixed at build time, so each build (development, CI, a release on the Mac) carries its
// own, and instrumentation.ts stops a server started with another.
const backend = process.env['BACKEND_INTERNAL_URL'] ?? '';
const problem = backendUrlProblem(backend);
if (problem !== undefined) throw new Error(problem);

const nextConfig: NextConfig = {
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
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
};

export default nextConfig;
