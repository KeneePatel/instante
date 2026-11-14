import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from './pool.ts';
import * as schema from './schema.ts';

// Drizzle over the app's pool. Store functions take a Db or a Tx, so one written for a request
// also runs inside the queue's transactions (docs/specs/platform.md, "The queue pattern").

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export function createDb(pool: Pool): Db {
  return drizzle({ client: pool, schema });
}
