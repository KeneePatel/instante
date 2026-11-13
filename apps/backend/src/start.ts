import { serve } from '@hono/node-server';
import { Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './api/app.ts';
import { refuseEveryToken, type Authenticate } from './api/register-routes.ts';
import { systemClock, type Clock } from './kit/clock.ts';
import { loadConfig, processRuntime, type Runtime } from './kit/config.ts';
import { systemIds } from './kit/ids.ts';
import { createLogger, type Sink } from './kit/logger.ts';

// What `src/main.ts` runs, kept apart so tests can start it in-process. It reads ROLE from
// the configuration; ROLE=documents (T12) and ROLE=cli (T9) arrive with their tasks.

export type Running = {
  port: number;
  /** Stops taking connections, ends in-flight ones with their reply, and closes whatever is
   * left after the grace period, so a stop always finishes. */
  close: (graceMs?: number) => Promise<void>;
};

/** Under the web app's 30-second rewrite timeout, so no reply it could still use is cut. */
export const SHUTDOWN_GRACE_MS = 10_000;

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
  if (!(server instanceof Server)) throw new Error('start: expected an HTTP/1.1 server');
  const { port } = server.address() as AddressInfo;
  logger.info('start.listening', { address: config.listen.address, port, env: config.env });

  // Once stopping, every reply still to be sent tells its client to close the connection, so
  // keep-alive sockets (the rewrite pools them) can't hold the process open. That includes a
  // request that only finishes arriving after the stop began.
  let closing = false;
  const inFlight = new Set<ServerResponse>();
  server.on('request', (_request, response) => {
    if (closing) response.setHeader('Connection', 'close');
    inFlight.add(response);
    response.once('close', () => inFlight.delete(response));
  });
  return {
    port,
    close: (graceMs = SHUTDOWN_GRACE_MS) => {
      closing = true;
      for (const response of inFlight) {
        if (!response.headersSent) response.setHeader('Connection', 'close');
      }
      logger.info('stop.started', { graceMs, inFlight: inFlight.size });
      return new Promise<void>((resolve, reject) => {
        // Node stops enforcing its header and request timeouts once close() is called, so
        // a half-sent request would otherwise hold the process open for good.
        const deadline = setTimeout(() => {
          server.closeAllConnections();
        }, graceMs);
        deadline.unref();
        server.close((error) => {
          clearTimeout(deadline);
          if (error === undefined) resolve();
          else reject(error);
        });
        server.closeIdleConnections();
      });
    },
  };
}
