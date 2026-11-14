import type { Hono } from 'hono';
import { createApp } from '../src/api/app.ts';
import { refuseEveryToken, type AppEnv, type Authenticate } from '../src/api/register-routes.ts';
import { manualClock } from '../src/kit/clock.ts';
import { systemIds } from '../src/kit/ids.ts';
import { createLogger, type Sink } from '../src/kit/logger.ts';

export const PORT = 4321;
export const OWN_HOST = `127.0.0.1:${String(PORT)}`;
export const ALLOWED_HOST = 'localhost:4320';

export type TestApp = {
  app: Hono<AppEnv>;
  lines: Record<string, unknown>[];
  slept: number[];
  /** A request as the web app's rewrite sends it: to the backend's own address. */
  call: (
    path: string,
    init?: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> },
  ) => Promise<Response>;
};

export function testApp(
  options: {
    testRoutes?: boolean;
    authenticate?: Authenticate;
    sleep?: (ms: number) => Promise<void>;
    ready?: () => Promise<readonly string[]>;
  } = {},
): TestApp {
  const lines: Record<string, unknown>[] = [];
  const slept: number[] = [];
  const sink: Sink = {
    out: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    err: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  };
  const clock = manualClock('2026-11-13T16:00:00.000Z');
  const app = createApp({
    port: PORT,
    allowedHost: ALLOWED_HOST,
    testRoutes: options.testRoutes ?? true,
    authenticate: options.authenticate ?? refuseEveryToken,
    ready: options.ready ?? (() => Promise.resolve([])),
    deps: {
      clock,
      ids: systemIds,
      logger: createLogger({ clock, sink }),
      sleep: (ms) => {
        slept.push(ms);
        return options.sleep === undefined ? Promise.resolve() : options.sleep(ms);
      },
    },
  });
  return {
    app,
    lines,
    slept,
    call: async (path, init = {}) =>
      app.request(`http://${OWN_HOST}${path}`, {
        ...init,
        headers: { host: OWN_HOST, ...init.headers },
      }),
  };
}

export async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}
