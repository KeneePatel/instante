import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { PAGES } from './support/pages';

// Accessibility (CONSTRAINTS.md: zero critical or serious axe findings, every page): axe's own
// default rules, its WCAG ones and its best practices, on every page once hydrated, the error
// screens included, on a desktop and on a phone, with the phone's menu open. axe leaves its
// 24 px target-size rule off by default; shell.spec.ts measures the 44 px targets instead.

async function expectNoSeriousViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const serious = violations
    .filter((v) => v.impact === 'critical' || v.impact === 'serious')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  expect(serious).toEqual([]);
}

for (const { path, heading } of PAGES) {
  test(`${path}: axe finds nothing critical or serious`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
    await expectNoSeriousViolations(page);
  });
}

test('a browser error’s screen: axe finds nothing critical or serious', async ({ page }) => {
  await page.goto('/e2e/browser-error');
  await page.getByRole('button', { name: 'Break the page' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Something went wrong');
  await expectNoSeriousViolations(page);
});

test.describe('on a phone, 375 px wide', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test('the Inbox, and its menu open: axe finds nothing critical or serious', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Inbox');
    await expectNoSeriousViolations(page);
    await page.getByRole('button', { name: 'Menu' }).click();
    // The sheet fades in over 200 ms, and axe blends colours at the opacity it finds: halfway
    // through, the links measure about 3.5:1. Judge the menu once it is opaque.
    const menu = page.getByRole('dialog', { name: 'Instante' });
    await expect(menu).toHaveCSS('opacity', '1');
    await expectNoSeriousViolations(page);
  });
});
