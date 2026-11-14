import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { PgBoss, fromDrizzle, type JobAttempt, type SchemaDriftReport } from 'pg-boss';
import type { Logger } from '../kit/logger.ts';
import type { Tx } from './db.ts';
import { MigrationError } from './migrate.ts';

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

/** pg-boss's own CLI, which `cli db migrate` runs as a child. */
export const PGBOSS_CLI: string = require.resolve('pg-boss/dist/cli.js');

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

/**
 * Why the database's pg-boss schema isn't this release's, whole: none when it is. Beyond the
 * version, pg-boss's own read-only drift check, since an index build interrupted after pg-boss
 * committed its version leaves an index invalid or missing, and nothing builds it later.
 */
export async function queueSchemaProblems(client: pg.ClientBase): Promise<string[]> {
  // A migrate cut short between pg-boss's install and the grants leaves a schema the app role
  // can't read, so `db status` as that role reports it rather than failing on it.
  const { rows } = await client.query<{ unreadable: boolean; role: string }>(
    `SELECT s.oid IS NOT NULL AND NOT has_schema_privilege(s.oid, 'USAGE') AS unreadable,
            current_user AS role
       FROM (SELECT to_regnamespace('pgboss') AS oid) s`,
  );
  if (rows[0]?.unreadable === true) {
    return [`pg-boss: schema not readable as ${rows[0].role}; \`cli db migrate\` grants it`];
  }
  const version = await queueSchemaVersion(client);
  const needs = `this release needs ${String(PGBOSS_SCHEMA_VERSION)}`;
  if (version === null) return [`pg-boss: schema not installed; ${needs}`];
  if (version !== PGBOSS_SCHEMA_VERSION) return [`pg-boss: schema ${String(version)}; ${needs}`];
  // Never started: it only reads the catalog, through this client.
  const reader = new PgBoss({
    db: { executeSql: (text, values) => client.query(text, values) },
    migrate: false,
    supervise: false,
    schedule: false,
  });
  const drift = await reader.detectSchemaDrift();
  return drift.ok ? [] : [`pg-boss: schema ${String(version)} is incomplete: ${driftNames(drift)}`];
}

function driftNames(drift: SchemaDriftReport): string {
  const named = [
    ...drift.missingTables.map((table) => `missing table ${table}`),
    ...drift.invalid.map((index) => `invalid index ${index.name}`),
    ...drift.missing.map((index) => `missing index ${index.name}`),
    ...drift.mismatched.map((index) => `changed index ${index.name}`),
  ];
  return named.length > 0
    ? named.join(', ')
    : 'its functions, columns or constraints differ (`pg-boss doctor` lists them)';
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
  // The message only: a slow query's data carries the query's values.
  boss.on('warning', (warning) => {
    options.logger.warn('queue.warning', { message: warning.message });
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

/**
 * Completes the attempt the caller fetched, inside the caller's transaction, beside the writes
 * that finish it. Throws, so the transaction rolls back, unless it completed exactly that
 * attempt: the job may have failed, expired or been fetched again since.
 */
export async function completeInTx(
  boss: PgBoss,
  tx: Tx,
  name: QueueName,
  job: JobAttempt,
  data: object | null = null,
): Promise<void> {
  const attempt: JobAttempt = { id: job.id, retryCount: job.retryCount };
  // CommandResponse is typed empty; pg-boss returns { jobs, requested, affected, settled }.
  const { affected } = (await boss.complete(name, attempt, data, {
    db: fromDrizzle(tx, sql),
  })) as { affected?: number };
  if (affected !== 1) {
    throw new Error(
      `completeInTx: ${name} job ${job.id}, attempt ${String(job.retryCount)}, is no longer active`,
    );
  }
}

/**
 * `cli db migrate`'s steps after our own migrations, as instante_owner:
 * 2. pg-boss's own `pg-boss migrate` (runPgBossMigrate), which also builds its indexes, then a
 *    check that the schema is this release's and whole, so a rerun can't pass over a failed build;
 * 3. idempotent grants letting instante_app use pg-boss's schema, tables, sequences and functions,
 *    except writing pgboss.bam, whose rows are statements an owner's pg-boss would run;
 * 4. the queues, made as the owner, since the app role can't create their partitions.
 * pg-boss's own output goes to `log`. A refusal throws MigrationError.
 */
export async function migrateQueue(ownerUrl: string, log: (line: string) => void): Promise<void> {
  await runPgBossMigrate(ownerUrl, log);
  const client = new pg.Client({ connectionString: ownerUrl, application_name: 'instante-cli' });
  await client.connect();
  try {
    const problems = await queueSchemaProblems(client);
    if (problems.length > 0) throw new MigrationError(problems);
    await client.query(`
      GRANT USAGE ON SCHEMA pgboss TO instante_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO instante_app;
      REVOKE INSERT, UPDATE, DELETE ON pgboss.bam FROM instante_app;
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

/**
 * pg-boss's CLI as a child, like every Instante process with --disable-sigusr1, since it holds
 * the owner's URL. Only that URL is in its environment, never on its command line, and it runs
 * in pg-boss's own folder, so no pgboss.json or .pgbossrc where it was started is read.
 */
export function runPgBossMigrate(
  ownerUrl: string,
  log: (line: string) => void,
  spawnChild: typeof spawn = spawn,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnChild(process.execPath, ['--disable-sigusr1', PGBOSS_CLI, 'migrate'], {
      cwd: path.dirname(PGBOSS_CLI),
      env: { PGBOSS_DATABASE_URL: ownerUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      for (const line of output.split('\n').filter((l) => l.trim() !== '')) log(`pg-boss: ${line}`);
      if (code === 0) resolve();
      else reject(new MigrationError([`pg-boss migrate exited with ${String(code ?? signal)}`]));
    });
  });
}
