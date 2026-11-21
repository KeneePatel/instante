import { expect, test, type Page } from '@playwright/test';

// The error and not-found screens (docs/specs/platform.md, "The shell"; T19's notes from T17a),
// reached through the end-to-end build's fixture pages (scripts/e2e-stack.sh, next.config.ts)
// and checked once hydrated, since React draws them in the browser. An error page names no
// error: a server error shows its digest as a reference, a browser error nothing.

/** The error screen; its own title shows where the page set none before failing (a page loaded
 * first keeps its own, as the Inbox does when its shell then fails in the browser). */
async function expectErrorScreen(
  page: Page,
  {
    shell,
    inbox,
    reference,
    title = 'Error · Instante',
  }: { shell: boolean; inbox: boolean; reference: boolean; title?: string },
): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Something went wrong');
  await expect(page).toHaveTitle(title);
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(shell ? 1 : 0);
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to Inbox' })).toHaveCount(inbox ? 1 : 0);
  await expect(page.getByText(/^Reference: \S+$/)).toHaveCount(reference ? 1 : 0);
}

test('a server error in a shell page shows inside the shell, with its reference', async ({
  page,
}) => {
  const response = await page.goto('/e2e/shell-error');
  expect(response?.status()).toBe(500);
  await expectErrorScreen(page, { shell: true, inbox: true, reference: true });
});

test('a server error outside the shell shows alone', async ({ page }) => {
  const response = await page.goto('/e2e/root-error');
  expect(response?.status()).toBe(500);
  await expectErrorScreen(page, { shell: false, inbox: true, reference: true });
});

test('a page whose metadata fails shows the error screen, with a title of its own', async ({
  page,
}) => {
  await page.goto('/e2e/metadata-error');
  await expectErrorScreen(page, { shell: true, inbox: true, reference: true });
});

test('a browser error in a shell page shows inside the shell, with no reference', async ({
  page,
}) => {
  await page.goto('/e2e/browser-error');
  await page.getByRole('button', { name: 'Break the page' }).click();
  await expectErrorScreen(page, { shell: true, inbox: true, reference: false });
});

test('notFound() in a shell page shows the not-found page inside the shell', async ({ page }) => {
  const response = await page.goto('/e2e/not-found');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found');
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Go to Inbox' })).toBeVisible();
});

test('an unknown address shows the not-found page alone', async ({ page }) => {
  const response = await page.goto('/no-such-page');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found');
  await expect(page).toHaveTitle('Not found · Instante');
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
});

// The Inbox can't fail by itself, so the browser makes the shell's navigation throw: its effect
// asks matchMedia for the side nav's width. On the Inbox a link to it would do nothing, so only
// "Try again" is offered, and it brings the Inbox back once the cause is gone.
test('an error on the Inbox offers only “Try again”, which recovers once the cause is gone', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const flag = window as unknown as { __failNav: boolean };
    flag.__failNav = true;
    const real = window.matchMedia.bind(window);
    window.matchMedia = (query: string) => {
      if (flag.__failNav && query === '(min-width: 48rem)') {
        throw new Error('the navigation fails, for the end-to-end tests');
      }
      return real(query);
    };
  });
  await page.goto('/');
  await expectErrorScreen(page, {
    shell: false,
    inbox: false,
    reference: false,
    title: 'Inbox · Instante',
  });
  await page.evaluate(() => {
    (window as unknown as { __failNav: boolean }).__failNav = false;
  });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Inbox');
});

// "Try again" asks the server for the page again, so a server error that has gone recovers.
test('“Try again” after a server error that has gone shows the page', async ({ page, context }) => {
  await context.addCookies([
    { name: 'instante-e2e-fail', value: '1', url: 'http://localhost:4320' },
  ]);
  await page.goto('/e2e/recover');
  await expectErrorScreen(page, { shell: true, inbox: true, reference: true });
  await context.clearCookies();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Recovered');
});
