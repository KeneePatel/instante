import type pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { migrationStatus, type Migration } from './migrate.ts';
import type { Pool } from './pool.ts';
import { PGBOSS_SCHEMA_VERSION } from './queue.ts';

// What /readyz checks, as instante_app (docs/specs/platform.md, "api"): the database answers,
// our migrations are current, and pg-boss's schema is the one this release runs on. The
// document service's own check arrives with it (T12).

export type ReadinessCheck = 'database' | 'migrations' | 'queue';

/** The checks that fail, or none. Each runs on its own, so one failure doesn't hide another. */
export async function failingChecks(
  pool: Pool,
  boss: PgBoss,
  migrations: readonly Migration[],
): Promise<ReadinessCheck[]> {
  const [database, current, queue] = await Promise.all([
    pool.query('SELECT 1').then(
      () => true,
      () => false,
    ),
    withClient(pool, async (client) => {
      const { pending } = await migrationStatus(client, migrations);
      return pending.length === 0;
    }),
    boss.schemaVersion().then(
      (version) => version === PGBOSS_SCHEMA_VERSION,
      () => false,
    ),
  ]);
  return [
    ...(database ? [] : (['database'] as const)),
    ...(current ? [] : (['migrations'] as const)),
    ...(queue ? [] : (['queue'] as const)),
  ];
}

async function withClient(
  pool: Pool,
  work: (client: pg.PoolClient) => Promise<boolean>,
): Promise<boolean> {
  try {
    const client = await pool.connect();
    try {
      return await work(client);
    } finally {
      client.release();
    }
  } catch {
    return false;
  }
}
