import type { Page } from '@playwright/test';

/** What a page did that a test should see: its policy's violations, and its console errors. */
export interface Watched {
  violations: () => Promise<string[]>;
  consoleErrors: string[];
}

/** Watches a page from its first script on: each Content-Security-Policy violation, from the
 * browser's own event, and each console error. Call before the page loads. */
export async function watch(page: Page): Promise<Watched> {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => {
    consoleErrors.push(`Error: ${error.message}`);
  });
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.defineProperty(window, '__violations', { value: seen });
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push(`${event.effectiveDirective} ${event.blockedURI}`);
    });
  });
  return {
    violations: () =>
      page.evaluate(() => (window as unknown as { __violations: string[] }).__violations),
    consoleErrors,
  };
}

/** The console errors not among those the page logs by design. */
export function unexpected(errors: readonly string[], allowed: readonly RegExp[] = []): string[] {
  return errors.filter((error) => !allowed.some((pattern) => pattern.test(error)));
}
