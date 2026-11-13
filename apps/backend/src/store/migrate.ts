import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type pg from 'pg';

// The migration runner (docs/specs/platform.md, "store"; docs/architecture.md, "Migrations").
// Numbered SQL files, applied in order as the database's owner, each in its own transaction
// with its record in schema_migrations. It refuses to run, and has no mode that relaxes this:
//
// - on a file whose name isn't NNNN_name.sql, a gap or a repeated number;
// - on an applied migration with no file, or applied out of order;
// - on a file changed since it was applied;
// - on a database whose encoding, locale provider or collation isn't the pinned one;
// - for any role but the database's owner.
//
// A rollback restores a dump instead (docs/specs/platform.md, "The local stack").

export const MIGRATIONS = new URL('../../migrations/', import.meta.url);

/** Every database Instante uses: UTF-8, the builtin C.UTF-8 locale, and C collation, so text
 * sorts the same in development, tests, CI and real use (ADR-012). */
export const PINNED_LOCALE = {
  encoding: 'UTF8',
  provider: 'builtin',
  locale: 'C.UTF-8',
  collate: 'C',
  ctype: 'C',
} as const;

const FILE_NAME = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
/** One runner at a time, across every process that migrates this database. */
const LOCK_KEY = '7346917310026113';

export type Migration = { name: string; sha256: string; sql: string };
export type Applied = { name: string; sha256: string; appliedAt: Date };
export type Status = { applied: Applied[]; pending: Migration[] };

export class MigrationError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[], options?: { cause?: unknown }) {
    super(`The migrations can't run:\n${problems.map((p) => `- ${p}`).join('\n')}`, options);
    this.name = 'MigrationError';
    this.problems = problems;
  }
}

/** The folder's migrations in order, refusing any file the runner wouldn't know how to place. */
export function readMigrations(folder: URL = MIGRATIONS): Migration[] {
  const problems: string[] = [];
  const files = readdirSync(folder).sort();
  files.forEach((file, i) => {
    const match = FILE_NAME.exec(file);
    if (match === null) {
      problems.push(`${file} isn't named NNNN_name.sql`);
      return;
    }
    const expected = String(i + 1).padStart(4, '0');
    if (match[1] !== expected)
      problems.push(`${file} should be numbered ${expected}: a gap or a repeat`);
  });
  if (problems.length > 0) throw new MigrationError(problems);
  return files.map((file) => {
    const bytes = readFileSync(new URL(file, folder));
    return {
      name: file.replace(/\.sql$/, ''),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sql: bytes.toString('utf8'),
    };
  });
}

/** What has run and what would run next, after every check; changes nothing. Any role may
 * ask, so /readyz can as instante_app. */
export async function migrationStatus(
  client: pg.ClientBase,
  migrations: readonly Migration[],
  options: { asOwner?: boolean } = {},
): Promise<Status> {
  const problems = [...(await checkDatabase(client, options.asOwner === true))];
  const applied = await appliedMigrations(client);
  applied.forEach((row, i) => {
    const file = migrations[i];
    if (!migrations.some((m) => m.name === row.name)) {
      problems.push(`${row.name} was applied, but no file has that name`);
    } else if (file?.name !== row.name) {
      problems.push(
        `${row.name} was applied out of order: the files have ${file?.name ?? 'fewer'} there`,
      );
    } else if (file.sha256 !== row.sha256) {
      problems.push(`${row.name} has changed since it was applied`);
    }
  });
  if (problems.length > 0) throw new MigrationError(problems);
  return { applied, pending: migrations.slice(applied.length) };
}

/** Applies every pending migration, in order, each in its own transaction. Returns their names. */
export async function migrate(
  client: pg.ClientBase,
  migrations: readonly Migration[] = readMigrations(),
): Promise<string[]> {
  await client.query('SELECT pg_advisory_lock($1::bigint)', [LOCK_KEY]);
  try {
    const { pending } = await migrationStatus(client, migrations, { asOwner: true });
    for (const migration of pending) {
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '10s'");
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)', [
          migration.name,
          migration.sha256,
        ]);
        await client.query('COMMIT');
      } catch (cause) {
        await client.query('ROLLBACK');
        throw new MigrationError([`${migration.name} failed, and nothing of it was kept`], {
          cause,
        });
      }
    }
    return pending.map((m) => m.name);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY]);
  }
}

async function checkDatabase(client: pg.ClientBase, asOwner: boolean): Promise<string[]> {
  const { rows } = await client.query<{
    encoding: string;
    provider: string;
    locale: string | null;
    collate: string;
    ctype: string;
    owner: boolean;
  }>(
    `SELECT pg_encoding_to_char(encoding) AS encoding,
            CASE datlocprovider WHEN 'b' THEN 'builtin' WHEN 'c' THEN 'libc' WHEN 'i' THEN 'icu'
                                ELSE datlocprovider::text END AS provider,
            datlocale AS locale, datcollate AS collate, datctype AS ctype,
            pg_get_userbyid(datdba) = current_user AS owner
       FROM pg_database WHERE datname = current_database()`,
  );
  const db = rows[0];
  if (db === undefined) return ["the current database isn't in pg_database"];
  const problems: string[] = [];
  const want = PINNED_LOCALE;
  if (db.encoding !== want.encoding || db.provider !== want.provider || db.locale !== want.locale) {
    problems.push(
      `the database uses ${db.encoding}, ${db.provider} ${db.locale ?? '(no locale)'}; ` +
        `migrations need ${want.encoding}, ${want.provider} ${want.locale}`,
    );
  }
  if (db.collate !== want.collate || db.ctype !== want.ctype) {
    problems.push(`the database collates as ${db.collate}/${db.ctype}; migrations need C/C`);
  }
  if (asOwner && !db.owner) {
    problems.push('migrations run only as the database owner, instante_owner');
  }
  return problems;
}

async function appliedMigrations(client: pg.ClientBase): Promise<Applied[]> {
  const { rows: exists } = await client.query<{ found: boolean }>(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS found",
  );
  if (exists[0]?.found !== true) return [];
  const { rows } = await client.query<{ name: string; sha256: string; applied_at: Date }>(
    'SELECT name, sha256, applied_at FROM schema_migrations ORDER BY name',
  );
  return rows.map((row) => ({ name: row.name, sha256: row.sha256, appliedAt: row.applied_at }));
}
