import type { Hono } from 'hono';
import type { AppEnv } from '../register-routes.ts';

// GET /readyz, outside /api: 200 when every check passes, 503 naming the ones that fail.
// GET /healthz only says the process is up.

export type Ready = () => Promise<readonly string[]>;

export function registerReadyz(app: Hono<AppEnv>, ready: Ready): void {
  app.get('/readyz', async (c) => {
    const failed = await ready();
    return c.json({ ok: failed.length === 0, failed }, failed.length === 0 ? 200 : 503);
  });
}
