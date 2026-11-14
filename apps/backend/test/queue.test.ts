import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Job, JobAttempt } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/db.ts';
import { manualClock } from '../src/kit/clock.ts';
import type { CliConfig } from '../src/kit/config.ts';
import { createLogger } from '../src/kit/logger.ts';
import { createDb, type Db } from '../src/store/db.ts';
import { migrate, readMigrations } from '../src/store/migrate.ts';
import { createPool, type Pool } from '../src/store/pool.ts';
import {
  PGBOSS_CLI,
  PGBOSS_SCHEMA_VERSION,
  QUEUES,
  completeInTx,
  createBoss,
  queueSchemaVersion,
  runPgBossMigrate,
  sendInTx,
} from '../src/store/queue.ts';
import { failingChecks } from '../src/store/readiness.ts';
import { listPings, recordPing } from '../src/store/skeleton.ts';
import {
  asAdmin,
  asApp,
  asOwner,
  dropTestDatabases,
  emptyDatabase,
  openSessions,
  testDatabase,
  urlFor,
} from './db-harness.ts';
import { errorCode, testApp } from './helpers.ts';

// The queue pattern on a copy of the migrated template (docs/specs/platform.md, acceptance
// criterion 5): a committed transaction writes the row and completes the job, and a rolled-back
// one leaves neither. pg-boss runs as instante_app, with migrate: false.

const quiet = createLogger({
  clock: manualClock('2026-11-14T16:00:00Z'),
  sink: { out: () => {}, err: () => {} },
});
const ping = QUEUES.skeletonPing;

const needs = `this release needs ${String(PGBOSS_SCHEMA_VERSION)}`;

/** The next job, claimed. */
async function fetchOne(boss: ReturnType<typeof createBoss>): Promise<Job<{ note: string }>> {
  const [job] = await boss.fetch<{ note: string }>(ping);
  if (job === undefined) throw new Error('no job to fetch');
  return job;
}

/** A job by id, or undefined if no such job exists. */
async function jobOf(boss: ReturnType<typeof createBoss>, id: string) {
  const [job] = await boss.findJobs(ping, { id });
  return job;
}

afterAll(async () => {
  await dropTestDatabases();
});

describe('cli db migrate', () => {
  const config = (database: string, roles: ('owner' | 'app')[] = ['owner']): CliConfig => ({
    env: 'development',
    role: 'cli',
    testRoutes: false,
    databaseUrl: roles.includes('app') ? urlFor(database, 'app') : undefined,
    ownerDatabaseUrl: roles.includes('owner') ? urlFor(database, 'owner') : undefined,
  });

  it("installs pg-boss after our migrations, with the app's grants and the queues, and again changes nothing", async () => {
    const db = await emptyDatabase();
    const printed: string[] = [];
    const logged: string[] = [];
    const run = (args: string[], roles?: ('owner' | 'app')[]) =>
      runCli(config(db, roles), args, (line) => printed.push(line), {
        log: (line) => logged.push(line),
      });

    expect(await run(['db', 'status'], ['app'])).toBe(3);
    expect(logged).toEqual([
      `pg-boss: schema not installed; this release needs ${String(PGBOSS_SCHEMA_VERSION)}`,
    ]);

    printed.length = 0;
    logged.length = 0;
    expect(await run(['db', 'migrate'])).toBe(0);
    expect(printed).toEqual(['Applied 0001_baseline', 'Applied 0002_skeleton']);
    expect(logged.join('\n')).toMatch(/^pg-boss: /m);
    await asOwner(db, async (client) => {
      expect(await queueSchemaVersion(client)).toBe(PGBOSS_SCHEMA_VERSION);
      const { rows } = await client.query<{ name: string }>('SELECT name FROM pgboss.queue');
      expect(rows).toEqual([{ name: ping }]);
    });

    printed.length = 0;
    logged.length = 0;
    expect(await run(['db', 'migrate'])).toBe(0);
    expect(printed).toEqual(['Nothing to apply: the database is current.']);
    expect(await run(['db', 'status'], ['app'])).toBe(0);
  }, 30_000);

  it('passes the owner URL to pg-boss in its environment, never on a command line', async () => {
    const db = await emptyDatabase();
    const logged: string[] = [];
    await runCli(config(db), ['db', 'migrate'], () => {}, { log: (line) => logged.push(line) });
    expect(logged.join('\n')).not.toMatch(/postgresql:\/\//);
  }, 30_000);

  it('status exits 3 and says why when pg-boss is behind', async () => {
    const db = await testDatabase();
    await asOwner(db, (client) => client.query('UPDATE pgboss.version SET version = version - 1'));
    const logged: string[] = [];
    expect(
      await runCli(config(db, ['app']), ['db', 'status'], () => {}, { log: (l) => logged.push(l) }),
    ).toBe(3);
    expect(logged).toEqual([
      `pg-boss: schema ${String(PGBOSS_SCHEMA_VERSION - 1)}; this release needs ${String(PGBOSS_SCHEMA_VERSION)}`,
    ]);
  });

  it('migrate refuses, and status reports, a pg-boss schema newer than this release’s', async () => {
    const db = await testDatabase();
    await asOwner(db, (client) => client.query('UPDATE pgboss.version SET version = version + 1'));
    const problem = `pg-boss: schema ${String(PGBOSS_SCHEMA_VERSION + 1)}; ${needs}`;
    const printed: string[] = [];
    const logged: string[] = [];
    const log = { log: (line: string) => logged.push(line) };
    expect(await runCli(config(db), ['db', 'migrate'], (l) => printed.push(l), log)).toBe(1);
    expect(printed).toEqual([
      'Nothing to apply: the database is current.',
      `The migrations can't run:\n- ${problem}`,
    ]);
    logged.length = 0;
    expect(await runCli(config(db, ['app']), ['db', 'status'], () => {}, log)).toBe(3);
    expect(logged).toEqual([problem]);
  }, 30_000);

  it('migrate refuses, and status reports, pg-boss indexes an interrupted build left behind', async () => {
    const db = await testDatabase();
    // What a CREATE INDEX CONCURRENTLY cut short after pg-boss committed its version leaves.
    await asOwner(db, (client) => client.query('DROP INDEX pgboss.job_common_i14'));
    await asAdmin(db, (client) =>
      client.query(
        "UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'pgboss.job_common_i15'::regclass",
      ),
    );
    const problem =
      `pg-boss: schema ${String(PGBOSS_SCHEMA_VERSION)} is incomplete: ` +
      'invalid index job_common_i15, missing index job_common_i14';
    const printed: string[] = [];
    const logged: string[] = [];
    const log = { log: (line: string) => logged.push(line) };
    expect(await runCli(config(db, ['app']), ['db', 'status'], () => {}, log)).toBe(3);
    expect(logged).toEqual([problem]);
    expect(await runCli(config(db), ['db', 'migrate'], (l) => printed.push(l), log)).toBe(1);
    expect(printed).toEqual([
      'Nothing to apply: the database is current.',
      `The migrations can't run:\n- ${problem}`,
    ]);
  }, 30_000);

  it('installs pg-boss where our migrations are already current, as a pg-boss-only release does', async () => {
    const db = await emptyDatabase();
    await asOwner(db, (client) => migrate(client, readMigrations()));
    const printed: string[] = [];
    const quietLog = { log: () => {} };
    expect(await runCli(config(db), ['db', 'migrate'], (l) => printed.push(l), quietLog)).toBe(0);
    expect(printed).toEqual(['Nothing to apply: the database is current.']);
    expect(await runCli(config(db, ['app']), ['db', 'status'], () => {}, quietLog)).toBe(0);
  }, 30_000);

  it('installs nothing of pg-boss in a database our runner refuses', async () => {
    const db = await emptyDatabase("ENCODING 'UTF8' LOCALE_PROVIDER libc LOCALE 'C'");
    expect(await runCli(config(db), ['db', 'migrate'], () => {}, { log: () => {} })).toBe(1);
    await asOwner(db, async (client) => {
      expect(await queueSchemaVersion(client)).toBeNull();
    });
  });
});

describe('runPgBossMigrate', () => {
  it('starts pg-boss’s CLI with --disable-sigusr1, in its own folder, with only the URL in its environment', async () => {
    const db = await emptyDatabase();
    const url = urlFor(db, 'owner');
    const calls: unknown[][] = [];
    const recording = ((...args: Parameters<typeof spawn>) => {
      calls.push(args);
      return spawn(...args);
    }) as typeof spawn;
    await runPgBossMigrate(url, () => {}, recording);
    expect(calls).toEqual([
      [
        process.execPath,
        ['--disable-sigusr1', PGBOSS_CLI, 'migrate'],
        {
          cwd: path.dirname(PGBOSS_CLI),
          env: { PGBOSS_DATABASE_URL: url },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ],
    ]);
    await asOwner(db, async (client) => {
      expect(await queueSchemaVersion(client)).toBe(PGBOSS_SCHEMA_VERSION);
    });
  }, 30_000);

  it('refuses when pg-boss’s CLI fails, passing on why', async () => {
    const logged: string[] = [];
    await expect(
      runPgBossMigrate(urlFor('instante_t_no_such_database', 'owner'), (l) => logged.push(l)),
    ).rejects.toMatchObject({
      name: 'MigrationError',
      problems: ['pg-boss migrate exited with 1'],
    });
    expect(logged).toContainEqual(
      expect.stringMatching(
        /^pg-boss: Error: database "instante_t_no_such_database" does not exist/,
      ),
    );
  });
});

describe('the app’s pg-boss', () => {
  it('refuses to start on a schema other than this release’s, and never migrates it', async () => {
    const db = await testDatabase();
    await asOwner(db, (client) => client.query('UPDATE pgboss.version SET version = version - 1'));
    const boss = createBoss(urlFor(db, 'app'), { logger: quiet });
    await expect(boss.start()).rejects.toThrow(/requires migrations/);
    await asOwner(db, async (client) => {
      expect(await queueSchemaVersion(client)).toBe(PGBOSS_SCHEMA_VERSION - 1);
    });
  });

  it('refuses to start where pg-boss isn’t installed', async () => {
    const db = await emptyDatabase();
    const boss = createBoss(urlFor(db, 'app'), { logger: quiet });
    await expect(boss.start()).rejects.toThrow(/not installed/);
  });

  it('can use pg-boss’s tables, but not change its schema', async () => {
    const db = await testDatabase();
    await asApp(db, async (client) => {
      await expect(client.query('CREATE TABLE pgboss.mine (id int)')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(client.query('DROP TABLE pgboss.version')).rejects.toMatchObject({
        code: '42501',
      });
    });
  });

  it('may read and write the rows of pg-boss’s tables and nothing more, and never write pgboss.bam', async () => {
    const db = await testDatabase();
    // Default privileges cover what the owner creates there later, such as a partitioned queue's table.
    await asOwner(db, (client) =>
      client.query('CREATE TABLE pgboss.later (id int); CREATE SEQUENCE pgboss.later_seq'),
    );
    await asOwner(db, async (client) => {
      const { rows } = await client.query<{ table: string; app: string[]; public: string[] }>(
        `SELECT c.relname AS table,
                ARRAY(SELECT a.privilege_type FROM aclexplode(c.relacl) a
                       WHERE a.grantee = 'instante_app'::regrole ORDER BY 1) AS app,
                ARRAY(SELECT a.privilege_type FROM aclexplode(c.relacl) a
                       WHERE a.grantee = 0 ORDER BY 1) AS public
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'pgboss' AND c.relkind IN ('r', 'p')
          ORDER BY 1`,
      );
      const rowWrites = ['DELETE', 'INSERT', 'SELECT', 'UPDATE'];
      expect(rows.length).toBeGreaterThan(5);
      expect(rows).toEqual(
        rows.map(({ table }) => ({
          table,
          app: table === 'bam' ? ['SELECT'] : rowWrites,
          public: [],
        })),
      );
    });
    await asApp(db, async (client) => {
      await expect(client.query('TRUNCATE pgboss.job')).rejects.toMatchObject({ code: '42501' });
      await expect(client.query('INSERT INTO pgboss.bam DEFAULT VALUES')).rejects.toMatchObject({
        code: '42501',
      });
      await client.query('INSERT INTO pgboss.later VALUES (1)');
      await client.query("SELECT nextval('pgboss.later_seq')");
    });
  });

  it('logs its errors and its warnings, a warning without its data, and never crashes on them', () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({
      clock: manualClock('2026-11-14T16:00:00Z'),
      sink: {
        out: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
        err: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
      },
    });
    const boss = createBoss(urlFor('instante_t_never_opened', 'app'), { logger });
    boss.emit('error', Object.assign(new Error('terminating connection'), { code: '57P01' }));
    boss.emit('warning', {
      message: 'Warning: slow query',
      data: { sql: 'SELECT $1', values: ['jordan@example.com'] },
    });
    expect(lines).toEqual([
      expect.objectContaining({ level: 'error', event: 'queue.error' }),
      expect.objectContaining({
        level: 'warn',
        event: 'queue.warning',
        message: 'Warning: slow query',
      }),
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/jordan/);
  });

  it('keeps no queue statistics, and holds at most 3 connections', async () => {
    const db = await testDatabase();
    const boss = createBoss(urlFor(db, 'app'), { logger: quiet });
    await boss.start();
    try {
      await boss.supervise();
      await Promise.all(
        Array.from({ length: 8 }, () => boss.getDb().executeSql('SELECT pg_sleep(0.2)')),
      );
      expect(await openSessions(db, ['instante-queue'])).toBe(3);
      await asOwner(db, async (client) => {
        const { rows } = await client.query('SELECT 1 FROM pgboss.queue_stats');
        expect(rows).toEqual([]);
      });
    } finally {
      await boss.stop({ graceful: false, close: true });
    }
  });
});

describe('the queue pattern', () => {
  let database: string;
  let pool: Pool;
  let db: Db;
  let boss: ReturnType<typeof createBoss>;

  beforeAll(async () => {
    database = await testDatabase();
    pool = createPool(urlFor(database, 'app'), { logger: quiet, max: 3 });
    db = createDb(pool);
    boss = createBoss(urlFor(database, 'app'), { logger: quiet });
    await boss.start();
  });

  afterAll(async () => {
    await boss.stop({ graceful: false, close: true });
    await pool.end();
  });

  it('sends a job only if the request’s transaction commits', async () => {
    const kept = await db.transaction((tx) => sendInTx(boss, tx, ping, { note: 'kept' }));
    let dropped = '';
    await expect(
      db.transaction(async (tx) => {
        dropped = await sendInTx(boss, tx, ping, { note: 'dropped' });
        throw new Error('the request failed');
      }),
    ).rejects.toThrow('the request failed');
    expect(dropped).not.toBe('');
    expect(await jobOf(boss, kept)).toMatchObject({ id: kept, state: 'created' });
    expect(await jobOf(boss, dropped)).toBeUndefined();
  });

  it('writes the row and completes the job in one transaction, or does neither', async () => {
    await db.transaction((tx) => sendInTx(boss, tx, ping, { note: 'one' }));
    await db.transaction((tx) => sendInTx(boss, tx, ping, { note: 'two' }));
    const jobs = await boss.fetch<{ note: string }>(ping, { batchSize: 2 });
    expect(jobs).toHaveLength(2);
    const [first, second] = jobs as [(typeof jobs)[number], (typeof jobs)[number]];

    // The slow work happens outside any transaction; then one short one finishes the job.
    const finish = (job: typeof first) =>
      db.transaction(async (tx) => {
        await recordPing(tx, { id: '01a1d6d4-6c3f-70a4-8d32-3cec9c5a9747', note: job.data.note });
        await completeInTx(boss, tx, ping, job);
      });
    await finish(first);
    await expect(
      db.transaction(async (tx) => {
        await recordPing(tx, {
          id: '01a1d6d4-6c3f-71d9-9b53-1b1e1f754b21',
          note: second.data.note,
        });
        await completeInTx(boss, tx, ping, second);
        throw new Error('the write failed');
      }),
    ).rejects.toThrow('the write failed');

    expect((await listPings(db)).map((p) => p.note)).toEqual([first.data.note]);
    expect(await jobOf(boss, first.id)).toMatchObject({ state: 'completed' });
    expect(await jobOf(boss, second.id)).toMatchObject({ state: 'active' });
  });
});

describe('completeInTx', () => {
  it('completes only the attempt it was given, and only while that attempt is active', async () => {
    const database = await testDatabase();
    const pool = createPool(urlFor(database, 'app'), { logger: quiet, max: 2 });
    const db = createDb(pool);
    const boss = createBoss(urlFor(database, 'app'), { logger: quiet });
    await boss.start();
    try {
      const id = await db.transaction((tx) => sendInTx(boss, tx, ping, { note: 'once' }));
      const finish = (job: JobAttempt, pingId: string, note: string) =>
        db.transaction(async (tx) => {
          await recordPing(tx, { id: pingId, note });
          await completeInTx(boss, tx, ping, job);
        });

      const first = await fetchOne(boss);
      await boss.fail(ping, first.id);
      await expect(
        finish(first, '01a1d6d4-6c3f-7aaa-8d32-3cec9c5a9747', 'after its failure'),
      ).rejects.toThrow(/no longer active/);
      const second = await fetchOne(boss);
      expect(second).toMatchObject({ id, retryCount: 1 });
      await expect(
        finish(first, '01a1d6d4-6c3f-7bbb-8d32-3cec9c5a9747', 'over the retry'),
      ).rejects.toThrow(/no longer active/);
      await finish(second, '01a1d6d4-6c3f-7ccc-8d32-3cec9c5a9747', 'the retry');

      expect((await listPings(db)).map((p) => p.note)).toEqual(['the retry']);
      expect(await jobOf(boss, id)).toMatchObject({ state: 'completed' });
    } finally {
      await boss.stop({ graceful: false, close: true });
      await pool.end();
    }
  });
});

describe('/readyz', () => {
  it('passes every check on a migrated database', async () => {
    const database = await testDatabase();
    const pool = createPool(urlFor(database, 'app'), { logger: quiet, max: 2 });
    const boss = createBoss(urlFor(database, 'app'), { logger: quiet });
    await boss.start();
    try {
      expect(await failingChecks(pool, boss, readMigrations())).toEqual([]);
      await asOwner(database, async (client) => {
        await client.query("DELETE FROM schema_migrations WHERE name = '0002_skeleton'");
        await client.query('UPDATE pgboss.version SET version = version - 1');
      });
      expect(await failingChecks(pool, boss, readMigrations())).toEqual(['migrations', 'queue']);
    } finally {
      await boss.stop({ graceful: false, close: true });
      await pool.end();
    }
  });

  it('fails each check when the database is gone', async () => {
    const database = await testDatabase();
    const boss = createBoss(urlFor(database, 'app'), { logger: quiet });
    await boss.start();
    const gone = createPool(urlFor('instante_t_no_such_database', 'app'), { logger: quiet });
    try {
      expect(await failingChecks(gone, boss, readMigrations())).toEqual(['database', 'migrations']);
    } finally {
      await boss.stop({ graceful: false, close: true });
      await gone.end();
    }
  });

  it('fails the queue check on a newer pg-boss schema, and when pg-boss can’t answer', async () => {
    const database = await testDatabase();
    const pool = createPool(urlFor(database, 'app'), { logger: quiet, max: 2 });
    const boss = createBoss(urlFor(database, 'app'), { logger: quiet });
    const stopped = createBoss(urlFor(database, 'app'), { logger: quiet });
    await boss.start();
    await stopped.start();
    await stopped.stop({ graceful: false, close: true });
    try {
      await asOwner(database, (client) =>
        client.query('UPDATE pgboss.version SET version = version + 1'),
      );
      expect(await failingChecks(pool, boss, readMigrations())).toEqual(['queue']);
      await asOwner(database, (client) =>
        client.query('UPDATE pgboss.version SET version = version - 1'),
      );
      expect(await failingChecks(pool, boss, readMigrations())).toEqual([]);
      expect(await failingChecks(pool, stopped, readMigrations())).toEqual(['queue']);
    } finally {
      await boss.stop({ graceful: false, close: true });
      await pool.end();
    }
  });

  it('answers 200 when ready and 503 naming what failed, behind the Host check', async () => {
    const ready = testApp();
    expect((await ready.call('/readyz')).status).toBe(200);
    expect(await (await ready.call('/readyz')).json()).toEqual({ ok: true, failed: [] });
    const failing = testApp({ ready: () => Promise.resolve(['queue']) });
    const response = await failing.call('/readyz');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, failed: ['queue'] });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const foreign = await failing.call('/readyz', { headers: { host: 'evil.test' } });
    expect(await errorCode(foreign)).toBe('misdirected');
  });
});
