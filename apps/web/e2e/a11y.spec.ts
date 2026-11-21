import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { PAGES } from './support/pages';

// Accessibility (CONSTRAINTS.md: axe with WCAG 2 A, AA and 2.1 AA, nothing critical or serious)
// on every page once hydrated, the error screens included, on a desktop and on a phone, with the
// phone's menu open.

async function expectNoSeriousViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
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
    await expect(page.getByRole('dialog', { name: 'Instante' })).toBeVisible();
    await expectNoSeriousViolations(page);
  });
});
