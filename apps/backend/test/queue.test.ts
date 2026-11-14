import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/db.ts';
import { manualClock } from '../src/kit/clock.ts';
import type { CliConfig } from '../src/kit/config.ts';
import { createLogger } from '../src/kit/logger.ts';
import { createDb, type Db } from '../src/store/db.ts';
import { readMigrations } from '../src/store/migrate.ts';
import { createPool, type Pool } from '../src/store/pool.ts';
import {
  PGBOSS_SCHEMA_VERSION,
  QUEUES,
  completeInTx,
  createBoss,
  queueSchemaVersion,
  sendInTx,
} from '../src/store/queue.ts';
import { failingChecks } from '../src/store/readiness.ts';
import { listPings, recordPing } from '../src/store/skeleton.ts';
import {
  asApp,
  asOwner,
  dropTestDatabases,
  emptyDatabase,
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
        await completeInTx(boss, tx, ping, job.id);
      });
    await finish(first);
    await expect(
      db.transaction(async (tx) => {
        await recordPing(tx, {
          id: '01a1d6d4-6c3f-71d9-9b53-1b1e1f754b21',
          note: second.data.note,
        });
        await completeInTx(boss, tx, ping, second.id);
        throw new Error('the write failed');
      }),
    ).rejects.toThrow('the write failed');

    expect((await listPings(db)).map((p) => p.note)).toEqual([first.data.note]);
    expect(await jobOf(boss, first.id)).toMatchObject({ state: 'completed' });
    expect(await jobOf(boss, second.id)).toMatchObject({ state: 'active' });
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

  it('answers 200 when ready and 503 naming what failed, behind the Host check', async () => {
    const ready = testApp();
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
