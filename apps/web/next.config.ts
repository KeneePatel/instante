import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Off (decision D6): every page is per person and renders dynamically, which
  // allows the nonce-based CSP that `proxy.ts` sets (docs/decisions/ADR-005).
  cacheComponents: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
