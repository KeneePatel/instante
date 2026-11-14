import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { PgBoss, fromDrizzle } from 'pg-boss';
import type { Logger } from '../kit/logger.ts';
import type { Tx } from './db.ts';

// The queue (docs/specs/platform.md, "The queue pattern"; docs/architecture.md, "Jobs"). pg-boss
// keeps its jobs in this database, so a job sent or completed inside one of our transactions
// exists, or is done, only if that transaction commits:
//
// - slow work (AI calls, fetches, parsing) happens outside any transaction;
// - then one short transaction writes the result and completes the job (completeInTx);
// - jobs a request creates are sent inside the request's own transaction (sendInTx).
//
// The app starts pg-boss with migrate: false, so a schema other than this release's refuses to
// start; `cli db migrate` installs and upgrades it as instante_owner (migrateQueue).

export const QUEUES = { skeletonPing: 'skeleton-ping' } as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

const require = createRequire(import.meta.url);

/** The pg-boss schema version this release runs on: pg-boss's own, from its package.json. */
export const PGBOSS_SCHEMA_VERSION: number = (
  require('pg-boss/package.json') as { pgboss: { schema: number } }
).pgboss.schema;

/** The database's pg-boss schema version, or null when pg-boss isn't installed. */
export async function queueSchemaVersion(client: pg.ClientBase): Promise<number | null> {
  // Two queries: Postgres plans a subquery on a missing table, and fails, even under a CASE.
  const { rows: found } = await client.query<{ installed: boolean }>(
    "SELECT to_regclass('pgboss.version') IS NOT NULL AS installed",
  );
  if (found[0]?.installed !== true) return null;
  const { rows } = await client.query<{ version: number }>('SELECT version FROM pgboss.version');
  return rows[0]?.version ?? null;
}

/** The app's pg-boss, as instante_app. Never migrates, and keeps no queue statistics. */
export function createBoss(connectionString: string, options: { logger: Logger }): PgBoss {
  const boss = new PgBoss({
    connectionString,
    // docs/architecture.md, "Data": a pool of 3 for pg-boss.
    max: 3,
    application_name: 'instante-queue',
    migrate: false,
    persistQueueStats: false,
  });
  boss.on('error', (error) => {
    options.logger.error('queue.error', { error });
  });
  return boss;
}

/** Sends a job inside the caller's transaction: it exists only if that transaction commits. */
export async function sendInTx(
  boss: PgBoss,
  tx: Tx,
  name: QueueName,
  data: object,
): Promise<string> {
  const id = await boss.send(name, data, { db: fromDrizzle(tx, sql) });
  if (id === null) throw new Error(`sendInTx: ${name} refused the job`);
  return id;
}

/** Completes a job inside the caller's transaction, beside the writes that finish it. */
export async function completeInTx(
  boss: PgBoss,
  tx: Tx,
  name: QueueName,
  id: string,
  data: object | null = null,
): Promise<void> {
  await boss.complete(name, id, data, { db: fromDrizzle(tx, sql) });
}

/**
 * `cli db migrate`'s steps after our own migrations, as instante_owner:
 * 2. pg-boss's own `pg-boss migrate`, with the URL in PGBOSS_DATABASE_URL, never on a command
 *    line, so it also builds its indexes, which a process started with migrate: false never would;
 * 3. idempotent grants letting instante_app use pg-boss's schema, tables, sequences and functions;
 * 4. the queues, made as the owner, since the app role can't create their partitions.
 * pg-boss's own output goes to `log`.
 */
export async function migrateQueue(ownerUrl: string, log: (line: string) => void): Promise<void> {
  await runPgBossMigrate(ownerUrl, log);
  const client = new pg.Client({ connectionString: ownerUrl, application_name: 'instante-cli' });
  await client.connect();
  try {
    await client.query(`
      GRANT USAGE ON SCHEMA pgboss TO instante_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO instante_app;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO instante_app;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO instante_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE instante_owner IN SCHEMA pgboss
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO instante_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE instante_owner IN SCHEMA pgboss
        GRANT USAGE, SELECT ON SEQUENCES TO instante_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE instante_owner IN SCHEMA pgboss
        GRANT EXECUTE ON FUNCTIONS TO instante_app;
    `);
  } finally {
    await client.end();
  }
  const boss = new PgBoss({
    connectionString: ownerUrl,
    max: 1,
    application_name: 'instante-cli',
    migrate: false,
    supervise: false,
    schedule: false,
    persistQueueStats: false,
  });
  boss.on('error', () => undefined);
  await boss.start();
  try {
    for (const name of Object.values(QUEUES)) {
      if ((await boss.getQueue(name)) === null) await boss.createQueue(name);
    }
  } finally {
    await boss.stop({ graceful: false, close: true });
  }
}

/** pg-boss's CLI, as a child with only the URL in its environment. */
function runPgBossMigrate(ownerUrl: string, log: (line: string) => void): Promise<void> {
  const cli = require.resolve('pg-boss/dist/cli.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'migrate'], {
      env: { PGBOSS_DATABASE_URL: ownerUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      for (const line of output.split('\n').filter((l) => l.trim() !== '')) log(`pg-boss: ${line}`);
      if (code === 0) resolve();
      else reject(new Error(`pg-boss migrate exited with ${String(code)}`));
    });
  });
}
