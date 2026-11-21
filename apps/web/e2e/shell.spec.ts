import { expect, test, type Locator, type Page } from '@playwright/test';

// The shell (docs/specs/platform.md, "The shell"; T19's notes from T17a): the phone's menu, 44 px
// targets on a phone held either way, and the route announcer.

/** At least 44 by 44 CSS pixels, the phone target size (CLAUDE.md's visual rules). */
async function expectTouchSize(target: Locator): Promise<void> {
  const box = await target.boundingBox();
  expect(box, 'a laid-out target').not.toBeNull();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
}

const focusIsIn = (page: Page, dialog: Locator) =>
  dialog.evaluate((element) => element.contains(document.activeElement));

test.describe('on a phone, 375 px wide', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test('the menu: 44 px targets, its name, focus in and back, and closed by Escape', async ({
    page,
  }) => {
    await page.goto('/');
    const button = page.getByRole('button', { name: 'Menu' });
    await expectTouchSize(button);
    await button.click();
    const menu = page.getByRole('dialog', { name: 'Instante' });
    await expect(menu).toBeVisible();
    // Focus moves in once the sheet has opened, just after it shows.
    await expect.poll(() => focusIsIn(page, menu)).toBe(true);
    for (const link of await menu.getByRole('link').all()) await expectTouchSize(link);
    await expectTouchSize(menu.getByRole('button', { name: 'Close the menu' }));
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(button).toBeFocused();
  });

  test('the menu closes after a link, after Back or Forward, and when the window widens', async ({
    page,
  }) => {
    await page.goto('/');
    const button = page.getByRole('button', { name: 'Menu' });
    const menu = page.getByRole('dialog', { name: 'Instante' });

    await button.click();
    await menu.getByRole('link', { name: 'Resumes' }).click();
    await expect(page).toHaveURL(/\/resumes$/);
    await expect(menu).toBeHidden();

    await button.click();
    await expect(menu).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(menu).toBeHidden();

    await button.click();
    await expect(menu).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(/\/resumes$/);
    await expect(menu).toBeHidden();

    await button.click();
    await expect(menu).toBeVisible();
    await page.setViewportSize({ width: 1024, height: 812 });
    await expect(menu).toBeHidden();
    await expect(page.getByRole('complementary').getByRole('navigation')).toBeVisible();
  });
});

// The other screens' targets, on a phone held either way: the error screen's two, the not-found
// page's link, and the ping page's download link (axe's target-size rule, off by default, would
// check only 24 px).
for (const [held, viewport] of [
  ['upright, 375 by 812', { width: 375, height: 812 }],
  ['sideways, 844 by 390', { width: 844, height: 390 }],
] as const) {
  test.describe(`on a phone held ${held}`, () => {
    test.use({ viewport, hasTouch: true });

    test('the error, not-found and ping pages’ targets are 44 px', async ({ page }) => {
      await page.goto('/e2e/shell-error');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Something went wrong');
      await expectTouchSize(page.getByRole('button', { name: 'Try again' }));
      await expectTouchSize(page.getByRole('link', { name: 'Go to Inbox' }));
      await page.goto('/no-such-page');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found');
      await expectTouchSize(page.getByRole('link', { name: 'Go to Inbox' }));
      await page.goto('/ping');
      const download = page.getByRole('link', { name: 'Download the PDF' });
      await expect(download).toBeVisible();
      await expectTouchSize(download);
    });
  });
}

// Held sideways, the side nav shows, and its links are still 44 px tall.
test.describe('on a phone held sideways, 844 by 390', () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true });

  test('the side nav’s links are 44 px tall', async ({ page }) => {
    await page.goto('/');
    const nav = page.getByRole('complementary').getByRole('navigation', { name: 'Main' });
    await expect(nav).toBeVisible();
    for (const link of await nav.getByRole('link').all()) {
      const box = await link.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });
});

// Next's announcer reads the new page's title on a client navigation, or its <h1> while the title
// hasn't arrived, and the title after Back or Forward.
test('the route announcer names each page navigated to', async ({ page }) => {
  await page.goto('/');
  const announcer = page.locator('#__next-route-announcer__');
  const nav = page.getByRole('complementary').getByRole('navigation', { name: 'Main' });
  await nav.getByRole('link', { name: 'Applied' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Applied');
  await expect(announcer).toHaveText(/^(Applied · Instante|Applied)$/);
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Inbox');
  await expect(announcer).toHaveText('Inbox · Instante');
  await page.goForward();
  await expect(announcer).toHaveText('Applied · Instante');
});
