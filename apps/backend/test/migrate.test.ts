import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/db.ts';
import { manualClock } from '../src/kit/clock.ts';
import { createLogger } from '../src/kit/logger.ts';
import { createPool } from '../src/store/pool.ts';
import type { CliConfig } from '../src/kit/config.ts';
import type pg from 'pg';
import {
  MigrationError,
  PINNED_LOCALE,
  forbiddenStatements,
  migrate,
  migrationStatus,
  readMigrations,
  statementsOf,
  type Migration,
} from '../src/store/migrate.ts';
import {
  PINNED,
  asAdmin,
  asApp,
  asOwner,
  dropTestDatabases,
  emptyDatabase,
  testDatabase,
  urlFor,
} from './db-harness.ts';

// The migration runner on a real Postgres 18 (docs/specs/platform.md, acceptance criterion 6):
// it refuses a gap, an unknown name, a changed file and the wrong locale, and has no mode
// that relaxes this.

afterAll(async () => {
  await dropTestDatabases();
});

const folders: string[] = [];
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

/** A migrations folder holding exactly these files. */
function folderWith(files: Record<string, string>): URL {
  const folder = mkdtempSync(path.join(tmpdir(), 'instante-migrations-'));
  folders.push(folder);
  for (const [name, sql] of Object.entries(files)) writeFileSync(path.join(folder, name), sql);
  return pathToFileURL(`${folder}/`);
}

async function problemsOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    if (error instanceof MigrationError) return error.problems.join('\n');
    throw error;
  }
  return '';
}

const real = readMigrations();

describe('readMigrations', () => {
  it('reads the repository’s migrations in order, each with its SHA-256', () => {
    expect(real.map((m) => m.name)).toEqual(['0001_baseline', '0002_skeleton']);
    for (const migration of real) expect(migration.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(real[0]?.sql).toMatch(/CREATE TABLE schema_migrations/);
  });

  it('hashes the bytes, so any change to a file changes its hash', () => {
    const a = readMigrations(folderWith({ '0001_a.sql': 'SELECT 1;\n' }));
    const b = readMigrations(folderWith({ '0001_a.sql': 'SELECT 1; \n' }));
    expect(a[0]?.sha256).not.toBe(b[0]?.sha256);
  });

  it.each([
    ['a gap', { '0001_a.sql': '', '0003_c.sql': '' }, /0003_c\.sql should be numbered 0002/],
    [
      'a repeated number',
      { '0001_a.sql': '', '0001_b.sql': '' },
      /0001_b\.sql should be numbered 0002/,
    ],
    ['a first file that is not 0001', { '0002_a.sql': '' }, /should be numbered 0001/],
    ['a name without four digits', { '1_a.sql': '' }, /1_a\.sql isn't named NNNN_name\.sql/],
    ['a name with a hyphen', { '0001_a-b.sql': '' }, /isn't named/],
    ['a name in capitals', { '0001_Baseline.sql': '' }, /isn't named/],
    ['a file that is not SQL', { '0001_a.sql': '', 'README.md': '' }, /README\.md isn't named/],
    ['a name with text before it', { 'x0001_a.sql': '' }, /x0001_a\.sql isn't named/],
    ['a name with text after it', { '0001_a.sql.bak': '' }, /0001_a\.sql\.bak isn't named/],
    ['a name without its dot', { '0001_a~sql': '' }, /0001_a~sql isn't named/],
  ])('refuses %s', (_case, files, message) => {
    expect(() => readMigrations(folderWith(files))).toThrow(MigrationError);
    expect(() => readMigrations(folderWith(files))).toThrow(message);
  });

  it('reports a stray file alone, without miscounting the files after it', () => {
    const folder = folderWith({ '.DS_Store': '', '0001_a.sql': '', '0002_b.sql': '' });
    let problems: readonly string[] = [];
    try {
      readMigrations(folder);
    } catch (error) {
      problems = (error as MigrationError).problems;
    }
    expect(problems).toEqual([".DS_Store isn't named NNNN_name.sql"]);
  });

  it('reads UTF-8, and refuses a file that is not valid UTF-8', () => {
    const [migration] = readMigrations(folderWith({ '0001_a.sql': "SELECT 'café';" }));
    expect(migration?.sql).toBe("SELECT 'café';");
    const folder = mkdtempSync(path.join(tmpdir(), 'instante-migrations-'));
    folders.push(folder);
    writeFileSync(path.join(folder, '0001_a.sql'), Buffer.from([0x53, 0x45, 0x4c, 0xe9, 0x3b]));
    expect(() => readMigrations(pathToFileURL(`${folder}/`))).toThrow(
      /0001_a\.sql isn't valid UTF-8/,
    );
  });

  it.each([
    ['BEGIN', 'BEGIN; CREATE TABLE a (id int); COMMIT;'],
    ['COMMIT', 'CREATE TABLE half (id int); COMMIT; SELECT 1;'],
    ['ROLLBACK', 'CREATE TABLE a (id int); ROLLBACK;'],
    ['ROLLBACK', 'ROLLBACK WORK;'],
    ['ROLLBACK', "ROLLBACK PREPARED 'x';"],
    ['START TRANSACTION', 'start  transaction; SELECT 1;'],
    ['END', 'SELECT 1; END;'],
    ['ABORT', 'ABORT;'],
    ['PREPARE TRANSACTION', "PREPARE TRANSACTION 'x';"],
    ['SET ROLE', 'SET ROLE instante_app; CREATE TABLE a (id int);'],
    ['SET LOCAL ROLE', 'SET LOCAL ROLE instante_app;'],
    ['RESET ROLE', 'RESET ROLE;'],
    ['SET SESSION AUTHORIZATION', 'SET SESSION AUTHORIZATION instante_app;'],
  ])('refuses a file that runs %s itself: %s', (statement, sql) => {
    expect(() => readMigrations(folderWith({ '0001_a.sql': sql }))).toThrow(
      `0001_a.sql runs ${statement} itself`,
    );
  });

  it('takes transaction words inside comments, strings, identifiers and function bodies', () => {
    const sql = [
      '-- COMMIT;',
      '/* outer /* COMMIT; */ still a comment; ROLLBACK; */',
      "SELECT 'it''s; COMMIT;', E'don\\'t; COMMIT;', \"COMMIT;\";",
      'DO $$ BEGIN PERFORM 1; END $$;',
      'CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $body$ BEGIN RETURN 1; END; $body$;',
      'SAVEPOINT s; ROLLBACK TO s; RELEASE s;',
      'ALTER TABLE t ADD COLUMN end_date date;',
    ].join('\n');
    expect(forbiddenStatements(sql)).toEqual([]);
    expect(statementsOf(sql)).toEqual([
      'SELECT , ,',
      'DO',
      'CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS',
      'SAVEPOINT s',
      'ROLLBACK TO s',
      'RELEASE s',
      'ALTER TABLE t ADD COLUMN end_date date',
    ]);
  });

  it('errs on the side of refusing: an SQL-standard function body ends in END', () => {
    expect(
      forbiddenStatements(
        'CREATE FUNCTION g() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END;',
      ),
    ).toEqual(['END']);
  });
});

describe('migrate', () => {
  it('applies every migration once, in order, and records each name and hash', async () => {
    const db = await emptyDatabase();
    await asOwner(db, async (client) => {
      expect(await migrate(client, real)).toEqual(['0001_baseline', '0002_skeleton']);
      expect(await migrate(client, real)).toEqual([]);
      const { rows } = await client.query<{ name: string; sha256: string }>(
        'SELECT name, sha256 FROM schema_migrations ORDER BY name',
      );
      expect(rows).toEqual(real.map((m) => ({ name: m.name, sha256: m.sha256 })));
      const status = await migrationStatus(client, real);
      expect(status.pending).toEqual([]);
      expect(status.applied.map((a) => a.name)).toEqual(['0001_baseline', '0002_skeleton']);
      expect(status.applied[0]?.appliedAt).toBeInstanceOf(Date);
    });
  });

  it('applies only what is pending', async () => {
    const db = await emptyDatabase();
    await asOwner(db, async (client) => {
      expect(await migrate(client, real.slice(0, 1))).toEqual(['0001_baseline']);
      expect((await migrationStatus(client, real)).pending.map((m) => m.name)).toEqual([
        '0002_skeleton',
      ]);
      expect(await migrate(client, real)).toEqual(['0002_skeleton']);
    });
  });

  it('refuses an applied migration that has no file', async () => {
    const db = await emptyDatabase();
    await asOwner(db, async (client) => {
      await migrate(client, real);
      await client.query("INSERT INTO schema_migrations VALUES ('0003_ghost', repeat('a', 64))");
      expect(await problemsOf(() => migrate(client, real))).toMatch(
        /0003_ghost was applied, but no file has that name/,
      );
      expect(await problemsOf(() => migrationStatus(client, real))).toMatch(/0003_ghost/);
    });
  });

  it('refuses migrations applied out of order', async () => {
    const db = await emptyDatabase();
    const [baseline, skeleton] = real as [Migration, Migration];
    const extra: Migration = { name: '0002_extra', sha256: 'b'.repeat(64), sql: 'SELECT 1;' };
    await asOwner(db, async (client) => {
      await migrate(client, real);
      // A file slipped in before one already applied.
      expect(await problemsOf(() => migrate(client, [baseline, extra, skeleton]))).toMatch(
        /0002_skeleton was applied out of order: the files have 0002_extra there/,
      );
    });
  });

  it('refuses a file changed since it was applied, and applies nothing more', async () => {
    const db = await emptyDatabase();
    const [baseline, skeleton] = real as [Migration, Migration];
    await asOwner(db, async (client) => {
      await migrate(client, [baseline]);
      const changed = { ...baseline, sha256: 'c'.repeat(64) };
      expect(await problemsOf(() => migrate(client, [changed, skeleton]))).toMatch(
        /0001_baseline has changed since it was applied/,
      );
      const { rows } = await client.query("SELECT to_regclass('skeleton_ping') AS t");
      expect(rows).toEqual([{ t: null }]);
    });
  });

  it.each([
    ['libc C', "ENCODING 'UTF8' LOCALE_PROVIDER libc LOCALE 'C'", /libc/],
    [
      'builtin C',
      "ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C' LOCALE 'C'",
      /builtin C;/,
    ],
    [
      'SQL_ASCII',
      "ENCODING 'SQL_ASCII' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C' LOCALE 'C'",
      /SQL_ASCII/,
    ],
    [
      'ICU with C.UTF-8',
      "ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE 'C.UTF-8' LOCALE 'C'",
      /icu C\.UTF-8/,
    ],
  ])('refuses a database with the wrong locale: %s', async (_case, locale, named) => {
    const db = await emptyDatabase(locale);
    await asOwner(db, async (client) => {
      const problems = await problemsOf(() => migrate(client, real));
      expect(problems).toMatch(/migrations need UTF8, builtin C\.UTF-8/);
      expect(problems).toMatch(named);
      expect((await client.query("SELECT to_regclass('schema_migrations') AS t")).rows).toEqual([
        { t: null },
      ]);
    });
  });

  it.each([
    ['collation', "LC_COLLATE 'en_US.UTF-8' LC_CTYPE 'C'", /collates as en_US\.UTF-8\/C/],
    ['character type', "LC_COLLATE 'C' LC_CTYPE 'en_US.UTF-8'", /collates as C\/en_US\.UTF-8/],
  ])('refuses a database whose %s is not C', async (_case, lc, named) => {
    const db = await emptyDatabase(
      `ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' ${lc}`,
    );
    await asOwner(db, async (client) => {
      expect(await problemsOf(() => migrate(client, real))).toMatch(named);
    });
  });

  it('pins the locale ADR-012 names', () => {
    expect(PINNED_LOCALE).toEqual({
      encoding: 'UTF8',
      provider: 'builtin',
      locale: 'C.UTF-8',
      collate: 'C',
      ctype: 'C',
    });
  });

  it('runs only as instante_owner, owning the database: never the app role or a superuser', async () => {
    const owned = /migrations run only as instante_owner, owning the database, and no superuser/;
    const db = await emptyDatabase();
    await asApp(db, async (client) => {
      expect(await problemsOf(() => migrate(client, real))).toMatch(owned);
    });
    await asAdmin(db, async (client) => {
      expect(await problemsOf(() => migrate(client, real))).toMatch(owned);
    });
    // A database a superuser made for itself, as a bare createdb would.
    const theirs = `instante_t_${String(process.pid)}_admin`;
    await asAdmin('postgres', (client) =>
      client.query(`CREATE DATABASE ${theirs} TEMPLATE template0 ${PINNED}`),
    );
    // And one the app role owns, though no superuser.
    const apps = `instante_t_${String(process.pid)}_apps`;
    await asAdmin('postgres', (client) =>
      client.query(`CREATE DATABASE ${apps} OWNER instante_app TEMPLATE template0 ${PINNED}`),
    );
    try {
      await asAdmin(theirs, async (client) => {
        expect(await problemsOf(() => migrate(client, real))).toMatch(owned);
      });
      await asApp(apps, async (client) => {
        expect(await problemsOf(() => migrate(client, real))).toMatch(owned);
      });
    } finally {
      await asAdmin('postgres', async (client) => {
        await client.query(`DROP DATABASE ${theirs}`);
        await client.query(`DROP DATABASE ${apps}`);
      });
    }
  });

  it('keeps nothing of a migration whose record fails, so it never runs twice', async () => {
    const db = await emptyDatabase();
    const unrecordable: Migration = {
      name: '0003_kept',
      sha256: 'not-a-sha',
      sql: 'CREATE TABLE kept (id int);',
    };
    await asOwner(db, async (client) => {
      expect(await problemsOf(() => migrate(client, [...real, unrecordable]))).toMatch(
        /0003_kept failed, and nothing of it was kept/,
      );
      expect((await client.query("SELECT to_regclass('kept') AS t")).rows).toEqual([{ t: null }]);
    });
  });

  it.each([
    ['COMMIT', 'CREATE TABLE early (id int); COMMIT; CREATE TABLE after_commit (id int);'],
    ['ROLLBACK', 'CREATE TABLE gone (id int); ROLLBACK;'],
    ['BEGIN … COMMIT', 'COMMIT; BEGIN; CREATE TABLE own (id int); COMMIT;'],
  ])(
    'refuses, as a second guard, SQL that ran %s past the file check, and records nothing',
    async (_case, sql) => {
      const db = await emptyDatabase();
      const sneaky: Migration = { name: '0003_sneaky', sha256: 'f'.repeat(64), sql };
      await asOwner(db, async (client) => {
        expect(await problemsOf(() => migrate(client, [...real, sneaky]))).toMatch(
          /0003_sneaky ended the runner's transaction, so part of it may have been kept/,
        );
        const { rows } = await client.query(
          "SELECT 1 FROM schema_migrations WHERE name = '0003_sneaky'",
        );
        expect(rows).toEqual([]);
      });
    },
  );

  it('releases its lock when it returns or fails, with the session still open', async () => {
    const db = await emptyDatabase();
    const failing: Migration = {
      name: '0003_failing',
      sha256: 'a'.repeat(64),
      sql: 'SELECT 1 / 0;',
    };
    const held = (client: pg.Client) =>
      client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()",
      );
    await asOwner(db, async (client) => {
      await migrate(client, real);
      expect((await held(client)).rows).toEqual([{ n: 0 }]);
      await problemsOf(() => migrate(client, [...real, failing]));
      expect((await held(client)).rows).toEqual([{ n: 0 }]);
      // Another runner isn't kept waiting by this open session.
      await asOwner(db, async (other) => {
        await other.query("SET statement_timeout = '3s'");
        expect(await migrate(other, real)).toEqual([]);
      });
    });
  });

  it('reads the record in name order, however its rows were stored', async () => {
    const db = await emptyDatabase();
    await asOwner(db, async (client) => {
      await migrate(client, real);
      await client.query(
        "WITH gone AS (DELETE FROM schema_migrations WHERE name = '0001_baseline' RETURNING *) INSERT INTO schema_migrations SELECT * FROM gone",
      );
      const status = await migrationStatus(client, real);
      expect(status.applied.map((a) => a.name)).toEqual(['0001_baseline', '0002_skeleton']);
    });
  });

  it('runs non-ASCII SQL as written', async () => {
    const db = await emptyDatabase();
    const [migration] = readMigrations(
      folderWith({
        '0001_a.sql': "CREATE TABLE t (v text); INSERT INTO t VALUES ('café, naïve, 東京');",
      }),
    );
    await asOwner(db, async (client) => {
      await client.query(
        'CREATE TABLE schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      await migrate(client, [migration as Migration]);
      expect((await client.query('SELECT v FROM t')).rows).toEqual([{ v: 'café, naïve, 東京' }]);
    });
  });

  it('keeps nothing of a migration that fails, and says which one', async () => {
    const db = await emptyDatabase();
    const [baseline] = real as [Migration];
    const failing: Migration = {
      name: '0002_failing',
      sha256: 'd'.repeat(64),
      sql: 'CREATE TABLE half_done (id int); SELECT 1 / 0;',
    };
    await asOwner(db, async (client) => {
      let thrown: unknown;
      try {
        await migrate(client, [baseline, failing]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(MigrationError);
      expect((thrown as MigrationError).problems).toEqual([
        '0002_failing failed, and nothing of it was kept',
      ]);
      expect((thrown as MigrationError).cause).toMatchObject({ code: '22012' });
      expect((await client.query("SELECT to_regclass('half_done') AS t")).rows).toEqual([
        { t: null },
      ]);
      const { rows } = await client.query('SELECT name FROM schema_migrations');
      expect(rows).toEqual([{ name: '0001_baseline' }]);
    });
  });

  it('lets one runner at a time apply each migration', async () => {
    const db = await emptyDatabase();
    const slow: Migration = {
      name: '0003_slow',
      sha256: 'e'.repeat(64),
      sql: 'SELECT pg_sleep(0.3);',
    };
    const runs = await Promise.all(
      [0, 1, 2].map(() => asOwner(db, (client) => migrate(client, [...real, slow]))),
    );
    expect(runs.flat().sort()).toEqual(['0001_baseline', '0002_skeleton', '0003_slow']);
  });
});

describe('the baseline’s grants', () => {
  it('let instante_app read and write rows, read the migrations record, and nothing else', async () => {
    const db = await emptyDatabase();
    await asOwner(db, (client) => migrate(client, real));
    await asApp(db, async (client) => {
      const id = '01a1d6d4-6c3f-70a4-8d32-3cec9c5a9747';
      await client.query("INSERT INTO skeleton_ping (id, note) VALUES ($1, 'hello')", [id]);
      await client.query("UPDATE skeleton_ping SET note = 'again' WHERE id = $1", [id]);
      expect((await client.query('SELECT note FROM skeleton_ping')).rows).toEqual([
        { note: 'again' },
      ]);
      await client.query('DELETE FROM skeleton_ping');
      expect((await client.query('SELECT count(*)::int AS n FROM schema_migrations')).rows).toEqual(
        [{ n: 2 }],
      );
      // SQLSTATE 42 (insufficient privilege) or 23 (a constraint, for the note's length).
      const refused: unknown = expect.stringMatching(/^(42|23)/);
      for (const sql of [
        'CREATE TEMP TABLE scratch (id int)',
        "INSERT INTO skeleton_ping (id, note) VALUES (gen_random_uuid(), repeat('x', 201))",
        "INSERT INTO schema_migrations VALUES ('0003_x', repeat('a', 64))",
        'DELETE FROM schema_migrations',
        'CREATE TABLE nope (id int)',
        'TRUNCATE skeleton_ping',
        'DROP TABLE skeleton_ping',
        'ALTER TABLE skeleton_ping ADD COLUMN x int',
      ]) {
        await expect(client.query(sql), sql).rejects.toMatchObject({
          code: refused,
        });
      }
      // PUBLIC holds nothing on the database; the app role may only connect.
      const { rows } = await client.query<{ public: number; temp: boolean; connect: boolean }>(
        `SELECT (SELECT count(*)::int FROM pg_database d, aclexplode(d.datacl) a
                  WHERE d.datname = current_database() AND a.grantee = 0) AS public,
                has_database_privilege(current_user, current_database(), 'TEMPORARY') AS temp,
                has_database_privilege(current_user, current_database(), 'CONNECT') AS connect`,
      );
      expect(rows).toEqual([{ public: 0, temp: false, connect: true }]);
      const { rows: schema } = await client.query<{ public: number }>(
        `SELECT count(*)::int AS public FROM pg_namespace n, aclexplode(n.nspacl) a
          WHERE n.nspname = 'public' AND a.grantee = 0`,
      );
      expect(schema).toEqual([{ public: 0 }]);
    });
  });

  it('let instante_app use the sequences of tables the owner makes later', async () => {
    const db = await emptyDatabase();
    await asOwner(db, async (client) => {
      await migrate(client, real);
      // A plain sequence: an identity column's own sequence needs no rights of its own.
      await client.query('CREATE SEQUENCE counter');
      await client.query("CREATE TABLE numbered (id bigint DEFAULT nextval('counter'), v int)");
    });
    await asApp(db, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        'INSERT INTO numbered (v) VALUES (1) RETURNING id',
      );
      expect(rows).toEqual([{ id: '1' }]);
    });
  });
});

describe('createPool', () => {
  it('connects as the role its URL names, and logs an idle client’s error instead of crashing', async () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({
      clock: manualClock('2026-11-13T16:00:00Z'),
      sink: {
        out: () => {},
        err: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
      },
    });
    const db = await testDatabase();
    const pool = createPool(urlFor(db, 'app'), { logger, max: 2 });
    try {
      const { rows } = await pool.query<{ role: string; app: string }>(
        "SELECT current_user AS role, current_setting('application_name') AS app",
      );
      expect(rows).toEqual([{ role: 'instante_app', app: 'instante' }]);
      // Never connects: a pool opens no connection until it's used.
      expect(createPool(urlFor('instante_test', 'app'), { logger }).options.max).toBe(5);
      pool.emit(
        'error',
        Object.assign(new Error('terminating connection'), { severity: 'FATAL', code: '57P01' }),
      );
      expect(lines).toEqual([
        expect.objectContaining({
          event: 'pool.error',
          error: { name: 'DatabaseError', code: '57P01' },
        }),
      ]);
    } finally {
      await pool.end();
    }
  });
});

describe('cli db', () => {
  const lines: string[] = [];
  const print = (line: string) => {
    lines.push(line);
  };
  const config = (database: string, roles: ('owner' | 'app')[] = ['owner']): CliConfig => ({
    env: 'development',
    role: 'cli',
    testRoutes: false,
    databaseUrl: roles.includes('app') ? urlFor(database, 'app') : undefined,
    ownerDatabaseUrl: roles.includes('owner') ? urlFor(database, 'owner') : undefined,
  });

  it('status lists what is pending and exits 3; migrate applies it; status then exits 0', async () => {
    const db = await emptyDatabase();
    lines.length = 0;
    expect(await runCli(config(db, ['app']), ['db', 'status'], print)).toBe(3);
    expect(lines).toEqual(['pending  0001_baseline', 'pending  0002_skeleton']);
    lines.length = 0;
    expect(await runCli(config(db), ['db', 'migrate'], print)).toBe(0);
    expect(lines).toEqual(['Applied 0001_baseline', 'Applied 0002_skeleton']);
    lines.length = 0;
    expect(await runCli(config(db), ['db', 'migrate'], print)).toBe(0);
    expect(lines).toEqual(['Nothing to apply: the database is current.']);
    lines.length = 0;
    expect(await runCli(config(db, ['app']), ['db', 'status'], print)).toBe(0);
    expect(lines).toEqual([
      expect.stringMatching(/^applied {2}0001_baseline {2}\d{4}-\d\d-\d\dT/),
      expect.stringMatching(/^applied {2}0002_skeleton {2}/),
    ]);
  });

  it("prints a failing migration's database error sanitized, never its values", async () => {
    const db = await emptyDatabase();
    const folder = folderWith({
      '0001_a.sql':
        "CREATE TABLE people (email text UNIQUE); INSERT INTO people VALUES ('jordan@example.com'), ('jordan@example.com');",
    });
    lines.length = 0;
    expect(await runCli(config(db), ['db', 'migrate'], print, { migrations: folder })).toBe(1);
    expect(lines[0]).toMatch(/0001_a failed, and nothing of it was kept/);
    expect(JSON.parse(lines[1] ?? '')).toEqual({
      name: 'DatabaseError',
      code: '23505',
      constraint: 'people_email_key',
      table: 'people',
    });
    expect(lines.join('\n')).not.toMatch(/jordan/);
  });

  it('lets an error that is no refusal through, such as a missing folder or database', async () => {
    const missing = new URL('file:///nonexistent-instante-migrations/');
    await expect(
      runCli(config(await testDatabase()), ['db', 'status'], print, { migrations: missing }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      runCli(config('instante_t_no_such_database'), ['db', 'status'], print),
    ).rejects.toMatchObject({ code: '3D000' });
  });

  it('migrate needs the owner role', async () => {
    lines.length = 0;
    expect(await runCli(config('instante_test', ['app']), ['db', 'migrate'], print)).toBe(78);
    expect(lines).toEqual([expect.stringMatching(/needs OWNER_DATABASE_URL_FILE/)]);
  });

  it('prints a refusal and exits 1', async () => {
    const db = await emptyDatabase("ENCODING 'UTF8' LOCALE_PROVIDER libc LOCALE 'C'");
    lines.length = 0;
    expect(await runCli(config(db), ['db', 'migrate'], print)).toBe(1);
    expect(lines.join('\n')).toMatch(/The migrations can't run:\n- the database uses UTF8, libc/);
  });

  it('runs through main.ts with ROLE=cli, as dev-db.sh and the launcher run it', async () => {
    const db = await emptyDatabase();
    const folder = mkdtempSync(path.join(tmpdir(), 'instante-cli-'));
    folders.push(folder);
    const file = path.join(folder, 'owner.url');
    writeFileSync(file, `${urlFor(db, 'owner')}\n`, { mode: 0o600 });
    const run = (args: string[]) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(
          process.execPath,
          ['--disable-sigusr1', fileURLToPath(new URL('../src/main.ts', import.meta.url)), ...args],
          {
            env: {
              PATH: process.env['PATH'] ?? '',
              INSTANTE_ENV: 'development',
              ROLE: 'cli',
              OWNER_DATABASE_URL_FILE: file,
            },
          },
        );
        let out = '';
        child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
        child.on('exit', (code) => {
          resolve({ code, out });
        });
      });
    expect(await run(['db', 'status'])).toEqual({
      code: 3,
      out: 'pending  0001_baseline\npending  0002_skeleton\n',
    });
    expect(await run(['db', 'migrate'])).toEqual({
      code: 0,
      out: 'Applied 0001_baseline\nApplied 0002_skeleton\n',
    });
    const wrong = await emptyDatabase("ENCODING 'UTF8' LOCALE_PROVIDER libc LOCALE 'C'");
    writeFileSync(file, `${urlFor(wrong, 'owner')}\n`, { mode: 0o600 });
    const refused = await run(['db', 'migrate']);
    expect(refused.code).toBe(1);
    expect(refused.out).toMatch(/The migrations can't run/);
  }, 15_000);

  it.each([
    [[]],
    [['db']],
    [['db', 'drop']],
    [['db', 'migrate', '--force']],
    [['dbx', 'migrate']],
    [['DB', 'status']],
    [['users', 'add']],
  ])('shows its usage for %j, and exits 64', async (args) => {
    lines.length = 0;
    expect(await runCli(config('instante_test'), args, print)).toBe(64);
    expect(lines).toEqual(['usage: cli db migrate | cli db status']);
  });
});

it('pins pg-connection-string to the version pg itself uses, so the guard parses as pg does', () => {
  const require = createRequire(import.meta.url);
  // The package exports no package.json, so find it next to the module.
  const versionAt = (entry: string) => {
    let folder = path.dirname(entry);
    while (!existsSync(path.join(folder, 'package.json'))) folder = path.dirname(folder);
    return (
      JSON.parse(readFileSync(path.join(folder, 'package.json'), 'utf8')) as { version: string }
    ).version;
  };
  const ours = versionAt(require.resolve('pg-connection-string'));
  const pgs = versionAt(createRequire(require.resolve('pg')).resolve('pg-connection-string'));
  expect(ours).toBe(pgs);
  expect(ours).toBe('2.14.1');
});
