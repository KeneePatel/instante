import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // One project per package; each later package adds its own (T5, T6, T14).
    projects: [
      { test: { name: 'scripts', include: ['scripts/**/*.test.ts'] } },
      { test: { name: 'contract', include: ['packages/contract/src/**/*.test.ts'] } },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      // The fixed coverage scope (CONSTRAINTS.md): changing it counts as weakening.
      include: ['apps/backend/src/**', 'packages/contract/src/**', 'apps/web/lib/**'],
    },
  },
});
