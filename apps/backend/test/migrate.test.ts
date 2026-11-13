import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/db.ts';
import { manualClock } from '../src/kit/clock.ts';
import { createLogger } from '../src/kit/logger.ts';
import { createPool } from '../src/store/pool.ts';
import type { CliConfig } from '../src/kit/config.ts';
import {
  MigrationError,
  PINNED_LOCALE,
  migrate,
  migrationStatus,
  readMigrations,
  type Migration,
} from '../src/store/migrate.ts';
import { asApp, asOwner, dropScratchDatabases, scratchDatabase, urlFor } from './db.ts';

// The migration runner on a real Postgres 18 (docs/specs/platform.md, acceptance criterion 6):
// it refuses a gap, an unknown name, a changed file and the wrong locale, and has no mode
// that relaxes this.

afterAll(async () => {
  await dropScratchDatabases();
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
  ])('refuses %s', (_case, files, message) => {
    expect(() => readMigrations(folderWith(files))).toThrow(MigrationError);
    expect(() => readMigrations(folderWith(files))).toThrow(message);
  });
});

describe('migrate', () => {
  it('applies every migration once, in order, and records each name and hash', async () => {
    const db = await scratchDatabase();
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
    const db = await scratchDatabase();
    await asOwner(db, async (client) => {
      expect(await migrate(client, real.slice(0, 1))).toEqual(['0001_baseline']);
      expect((await migrationStatus(client, real)).pending.map((m) => m.name)).toEqual([
        '0002_skeleton',
      ]);
      expect(await migrate(client, real)).toEqual(['0002_skeleton']);
    });
  });

  it('refuses an applied migration that has no file', async () => {
    const db = await scratchDatabase();
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
    const db = await scratchDatabase();
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
    const db = await scratchDatabase();
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
  ])('refuses a database with the wrong locale: %s', async (_case, locale, named) => {
    const db = await scratchDatabase(locale);
    await asOwner(db, async (client) => {
      const problems = await problemsOf(() => migrate(client, real));
      expect(problems).toMatch(/migrations need UTF8, builtin C\.UTF-8/);
      expect(problems).toMatch(named);
      expect((await client.query("SELECT to_regclass('schema_migrations') AS t")).rows).toEqual([
        { t: null },
      ]);
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

  it('runs only as the database owner', async () => {
    const db = await scratchDatabase();
    await asApp(db, async (client) => {
      expect(await problemsOf(() => migrate(client, real))).toMatch(
        /migrations run only as the database owner/,
      );
    });
  });

  it('keeps nothing of a migration that fails, and says which one', async () => {
    const db = await scratchDatabase();
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
    const db = await scratchDatabase();
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
    const db = await scratchDatabase();
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
      // SQLSTATE class 42: insufficient privilege, or no such right.
      const privilegeError: unknown = expect.stringMatching(/^42/);
      for (const sql of [
        "INSERT INTO schema_migrations VALUES ('0003_x', repeat('a', 64))",
        'DELETE FROM schema_migrations',
        'CREATE TABLE nope (id int)',
        'TRUNCATE skeleton_ping',
        'DROP TABLE skeleton_ping',
        'ALTER TABLE skeleton_ping ADD COLUMN x int',
      ]) {
        await expect(client.query(sql), sql).rejects.toMatchObject({
          code: privilegeError,
        });
      }
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
    const pool = createPool(urlFor('instante_test', 'app'), { logger, max: 2 });
    try {
      const { rows } = await pool.query<{ role: string; app: string }>(
        "SELECT current_user AS role, current_setting('application_name') AS app",
      );
      expect(rows).toEqual([{ role: 'instante_app', app: 'instante' }]);
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
    const db = await scratchDatabase();
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

  it('migrate needs the owner role', async () => {
    lines.length = 0;
    expect(await runCli(config('instante_test', ['app']), ['db', 'migrate'], print)).toBe(78);
    expect(lines).toEqual([expect.stringMatching(/needs OWNER_DATABASE_URL_FILE/)]);
  });

  it('prints a refusal and exits 1', async () => {
    const db = await scratchDatabase("ENCODING 'UTF8' LOCALE_PROVIDER libc LOCALE 'C'");
    lines.length = 0;
    expect(await runCli(config(db), ['db', 'migrate'], print)).toBe(1);
    expect(lines.join('\n')).toMatch(/The migrations can't run:\n- the database uses UTF8, libc/);
  });

  it('runs through main.ts with ROLE=cli, as dev-db.sh and the launcher run it', async () => {
    const db = await scratchDatabase();
    const folder = mkdtempSync(path.join(tmpdir(), 'instante-cli-'));
    folders.push(folder);
    const file = path.join(folder, 'owner.url');
    writeFileSync(file, `${urlFor(db, 'owner')}\n`, { mode: 0o600 });
    const run = (args: string[]) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(
          process.execPath,
          ['--disable-sigusr1', new URL('../src/main.ts', import.meta.url).pathname, ...args],
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
  }, 15_000);

  it.each([[[]], [['db']], [['db', 'drop']], [['db', 'migrate', '--force']], [['users', 'add']]])(
    'shows its usage for %j, and exits 64',
    async (args) => {
      lines.length = 0;
      expect(await runCli(config('instante_test'), args, print)).toBe(64);
      expect(lines).toEqual(['usage: cli db migrate | cli db status']);
    },
  );
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
