import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

// The walking skeleton (docs/specs/platform.md, criteria 8 and 10): the ping page's calls from
// the server and the browser, the sample PDF through a Blob, the Inbox at /, and no static page.

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/;

test('the ping page answers from the server and from the browser', async ({ page }) => {
  await page.goto('/ping');
  await expect(page.getByText(/^Server Component: answered at /)).toHaveText(
    new RegExp(`^Server Component: answered at ${ISO.source}$`),
  );
  await expect(page.getByRole('status').filter({ hasText: 'Client Component:' })).toHaveText(
    new RegExp(`^Client Component: answered at ${ISO.source}$`),
  );
});

// In the headless shell a PDF frame never loads, and reading the blob back through its URL is
// a connect-src violation, so the test checks the frame's blob: URL, the route's media type and
// the bytes the link saves (T19's notes from T17a).
test('the ping page shows the sample PDF through a Blob, and its link saves the same bytes', async ({
  page,
  request,
}) => {
  await page.goto('/ping');
  const frame = page.getByTitle('Sample PDF');
  await expect(frame).toHaveAttribute('src', /^blob:http:\/\/localhost:4320\//);
  const url = await frame.getAttribute('src');
  const link = page.getByRole('link', { name: 'Download the PDF' });
  await expect(link).toHaveAttribute('href', url ?? '');

  const route = await request.get('/api/test/file.pdf');
  expect(route.status()).toBe(200);
  expect(route.headers()['content-type']).toBe('application/pdf');
  const served = await route.body();
  expect(served.subarray(0, 5).toString('latin1')).toBe('%PDF-');

  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  expect(download.suggestedFilename()).toBe('instante-sample.pdf');
  const saved = readFileSync(await download.path());
  expect(saved.equals(served)).toBe(true);
});

test('/ shows the shell’s navigation and the Inbox', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Inbox');
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'Inbox' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('link')).toHaveText(['Inbox', 'Resumes', 'Applied', 'Settings']);
});

// Run on the build this suite serves, fixture pages and all: every page renders per request.
// (Playwright loads this file as CommonJS, so it has __dirname and no import.meta.)
test('the build lists no static page', () => {
  const root = path.resolve(__dirname, '../../..');
  const out = execFileSync(process.execPath, ['scripts/check-no-static.ts'], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(out).toContain('no static page');
});
