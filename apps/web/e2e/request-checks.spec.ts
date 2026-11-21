import { request as httpRequest } from 'node:http';
import { expect, test } from '@playwright/test';
import { PAGES } from './support/pages';
import { unexpected, watch } from './support/watch';

// The web app's request rules on the production build (docs/specs/platform.md, criteria 2, 8
// and 12; proxy.ts): a fresh nonce on every page and no policy violation, the Host and Fetch
// Metadata refusals on a page, a prefetch and /api, and the slow route's message.

/** A request with exactly the headers given, Host included, as a browser can't send one. */
function send(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const WEB = 4320;
const BACKEND = 4321;
const OWN = 'localhost:4320';
const FOREIGN = 'evil.example:4320';
const PREFETCH = { 'next-router-prefetch': '1', rsc: '1' };

// The policy governs the server's HTML: each of its scripts must carry the response's nonce.
// Scripts Next adds later, as it loads an error screen's code, carry none and need none, since
// 'strict-dynamic' trusts what a trusted script loads; any it didn't trust would be a violation.
for (const page of PAGES) {
  test(`${page.path}: a fresh nonce on each load, on every script, and no policy violation`, async ({
    browser,
  }) => {
    const nonces: string[] = [];
    for (let load = 0; load < 2; load += 1) {
      const tab = await browser.newPage();
      const watched = await watch(tab);
      const response = await tab.goto(page.path);
      expect(response?.status()).toBe(page.status);
      const policy = (await response?.headerValue('content-security-policy')) ?? '';
      const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
      expect(nonce, policy).toBeDefined();
      nonces.push(nonce ?? '');
      const scripts = ((await response?.text()) ?? '').match(/<script\b[^>]*>/g) ?? [];
      expect(scripts.length).toBeGreaterThan(0);
      expect(scripts.filter((tag) => !tag.includes(` nonce="${nonce ?? ''}"`))).toEqual([]);
      await expect(tab.getByRole('heading', { level: 1 })).toHaveText(page.heading);
      expect(await watched.violations()).toEqual([]);
      expect(unexpected(watched.consoleErrors, page.logs)).toEqual([]);
      await tab.close();
    }
    expect(nonces[0]).not.toBe(nonces[1]);
  });
}

test('a foreign Host gets 421 on a page, a prefetch, /api and the backend itself', async () => {
  for (const [port, path, extra] of [
    [WEB, '/', {}],
    [WEB, '/', PREFETCH],
    [WEB, '/api/ping', {}],
    [BACKEND, '/api/ping', {}],
  ] as const) {
    const { status, body } = await send(port, path, { host: FOREIGN, ...extra });
    expect(status, `${String(port)}${path}`).toBe(421);
    expect(JSON.parse(body)).toMatchObject({ error: { code: 'misdirected' } });
  }
  expect((await send(WEB, '/', { host: OWN })).status).toBe(200);
});

test('another site gets 403 on a prefetch and /api, but may navigate to a page', async () => {
  const crossSite = { host: OWN, 'sec-fetch-site': 'cross-site' };
  for (const [path, extra] of [
    ['/', { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', ...PREFETCH }],
    ['/api/ping', { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }],
    ['/api/ping', { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }],
  ] as const) {
    const { status, body } = await send(WEB, path, { ...crossSite, ...extra });
    expect(status, path).toBe(403);
    expect(JSON.parse(body)).toMatchObject({ error: { code: 'forbidden' } });
  }
  const navigation = await send(WEB, '/', {
    ...crossSite,
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
  });
  expect(navigation.status).toBe(200);
});

// The rewrite gives up at 30 seconds (next.config.ts's proxyTimeout), and the page says so.
test('the slow route’s message, once the rewrite gives up', async ({ page }) => {
  test.setTimeout(45_000);
  await page.goto('/ping?slow=35');
  await expect(page.getByRole('status').filter({ hasText: 'Slow route:' })).toHaveText(
    "Slow route: Instante can't reach its server right now.",
    { timeout: 40_000 },
  );
});
