import pg from 'pg';
import type { Logger } from '../kit/logger.ts';

// The pool for instante_app. It takes the URL as `{ connectionString }`: a bare string handed
// to pg is parsed twice, so a URL nesting a second one could connect somewhere the
// configuration's guard never checked (docs/specs/platform.md, "Configuration").

export type Pool = pg.Pool;

export function createPool(
  connectionString: string,
  options: { logger: Logger; max?: number; applicationName?: string },
): Pool {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'instante',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  // An idle client's error (the server restarting, say) would otherwise end the process.
  pool.on('error', (error) => {
    options.logger.error('pool.error', { error });
  });
  return pool;
}
