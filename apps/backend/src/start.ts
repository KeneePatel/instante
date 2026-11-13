import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { createApp } from './api/app.ts';
import { refuseEveryToken, type Authenticate } from './api/register-routes.ts';
import { systemClock, type Clock } from './kit/clock.ts';
import { loadConfig, processRuntime, type Runtime } from './kit/config.ts';
import { systemIds } from './kit/ids.ts';
import { createLogger, type Sink } from './kit/logger.ts';

// What `src/main.ts` runs, kept apart so tests can start it in-process. It reads ROLE from
// the configuration; ROLE=documents (T12) and ROLE=cli (T9) arrive with their tasks.

export type Running = { port: number; close: () => Promise<void> };

export type StartOptions = {
  env: Readonly<Record<string, string | undefined>>;
  runtime?: Runtime;
  clock?: Clock;
  sink?: Sink;
  authenticate?: Authenticate;
};

/** Throws ConfigError when the configuration refuses to start. */
export async function start(options: StartOptions): Promise<Running> {
  const config = loadConfig(options.env, options.runtime ?? processRuntime());
  const clock = options.clock ?? systemClock;
  const logger = createLogger({
    clock,
    fields: { role: config.role },
    ...(options.sink === undefined ? {} : { sink: options.sink }),
  });
  if (config.role !== 'all') {
    throw new Error(`ROLE=${config.role} has nothing to run in this release`);
  }

  const app = createApp({
    port: config.listen.port,
    allowedHost: config.allowedHost,
    testRoutes: config.testRoutes,
    authenticate: options.authenticate ?? refuseEveryToken,
    deps: {
      clock,
      ids: systemIds,
      logger,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  });

  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const listening = serve(
      { fetch: app.fetch, hostname: config.listen.address, port: config.listen.port },
      () => {
        resolve(listening);
      },
    );
    listening.once('error', reject);
  });
  const { port } = server.address() as AddressInfo;
  logger.info('start.listening', { address: config.listen.address, port, env: config.env });

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}
