import { describe, expect, it } from 'vitest';

// The contract never lets zod test for eval (zod-config.ts): in the browser, under the web app's
// production policy, `Function('')` is reported as a CSP violation even though zod catches it.

describe('the contract', () => {
  it('builds every schema without calling Function, so zod never tests for eval', async () => {
    const calls: unknown[][] = [];
    const original = globalThis.Function;
    globalThis.Function = new Proxy(original, {
      apply(target, self, args: unknown[]) {
        calls.push(args);
        return Reflect.apply(target, self, args) as unknown;
      },
      construct(target, args: unknown[]) {
        calls.push(args);
        return Reflect.construct(target, args) as object;
      },
    });
    try {
      const contract = await import('./index.ts');
      // Building and using a schema is where zod would test.
      expect(
        contract.routes.ping.response.parse({ ok: true, at: '2026-11-18T00:00:00.000Z' }),
      ).toEqual({ ok: true, at: '2026-11-18T00:00:00.000Z' });
    } finally {
      globalThis.Function = original;
    }
    expect(calls).toEqual([]);
  });
});
