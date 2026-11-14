import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type pg from 'pg';

// The migration runner (docs/specs/platform.md, "store"; docs/architecture.md, "Migrations").
// Numbered SQL files, applied in order as instante_owner, each in its own transaction with its
// record in schema_migrations. It refuses to run, and has no mode that relaxes this:
//
// - on a file whose name isn't NNNN_name.sql, a gap or a repeated number, a file that isn't
//   valid UTF-8, and a file that ends or opens transactions or changes role itself (the
//   runner's own transaction is what makes a failed migration keep nothing);
// - on an applied migration with no file, or applied out of order;
// - on a file changed since it was applied;
// - on a database whose encoding, locale provider or collation isn't the pinned one;
// - for any role but instante_owner, owning the database, and not a superuser.
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

/** The one role that runs migrations, so every object it creates has the same owner. */
export const OWNER_ROLE = 'instante_owner';

/** One runner at a time, across every process that migrates the same database. */
export const MIGRATION_LOCK_KEY = '7346917310026113';

const FILE_NAME = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

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
  const migrations: Migration[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const file of readdirSync(folder).sort()) {
    const match = FILE_NAME.exec(file);
    if (match === null) {
      problems.push(`${file} isn't named NNNN_name.sql`);
      continue;
    }
    // Numbered among the well-named files, so one stray file reports only itself.
    const expected = String(migrations.length + 1).padStart(4, '0');
    if (match[1] !== expected) {
      problems.push(`${file} should be numbered ${expected}: a gap or a repeat`);
    }
    const bytes = readFileSync(new URL(file, folder));
    let sql = '';
    try {
      sql = decoder.decode(bytes);
    } catch {
      problems.push(`${file} isn't valid UTF-8`);
    }
    for (const statement of forbiddenStatements(sql)) {
      problems.push(`${file} runs ${statement} itself; the runner holds the transaction and role`);
    }
    migrations.push({
      name: file.replace(/\.sql$/, ''),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sql,
    });
  }
  if (problems.length > 0) throw new MigrationError(problems);
  return migrations;
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
  await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
  try {
    const { pending } = await migrationStatus(client, migrations, { asOwner: true });
    for (const migration of pending) await applyOne(client, migration);
    return pending.map((m) => m.name);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY]);
  }
}

async function applyOne(client: pg.ClientBase, migration: Migration): Promise<void> {
  await client.query('BEGIN');
  try {
    const before = await transactionId(client, 'pg_current_xact_id');
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query(migration.sql);
    // A second guard on transaction control the file check missed: the SQL must leave the
    // runner's transaction as it found it.
    if ((await transactionId(client, 'pg_current_xact_id_if_assigned')) !== before) {
      throw new MigrationError([
        `${migration.name} ended the runner's transaction, so part of it may have been kept: ` +
          'restore the dump taken before this release',
      ]);
    }
    await client.query('INSERT INTO public.schema_migrations (name, sha256) VALUES ($1, $2)', [
      migration.name,
      migration.sha256,
    ]);
    await client.query('COMMIT');
  } catch (cause) {
    await client.query('ROLLBACK');
    if (cause instanceof MigrationError) throw cause;
    throw new MigrationError([`${migration.name} failed, and nothing of it was kept`], { cause });
  }
}

async function transactionId(client: pg.ClientBase, fn: string): Promise<string | null> {
  const { rows } = await client.query<{ id: string | null }>(`SELECT ${fn}()::text AS id`);
  return rows[0]?.id ?? null;
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
    `SELECT pg_encoding_to_char(d.encoding) AS encoding,
            CASE d.datlocprovider WHEN 'b' THEN 'builtin' WHEN 'c' THEN 'libc' WHEN 'i' THEN 'icu'
                                  ELSE d.datlocprovider::text END AS provider,
            d.datlocale AS locale, d.datcollate AS collate, d.datctype AS ctype,
            current_user = $1 AND pg_get_userbyid(d.datdba) = current_user AND NOT r.rolsuper
              AS owner
       FROM pg_database d, pg_roles r
      WHERE d.datname = current_database() AND r.rolname = current_user`,
    [OWNER_ROLE],
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
    problems.push(`migrations run only as ${OWNER_ROLE}, owning the database, and no superuser`);
  }
  return problems;
}

async function appliedMigrations(client: pg.ClientBase): Promise<Applied[]> {
  const { rows: exists } = await client.query<{ found: boolean }>(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS found",
  );
  if (exists[0]?.found !== true) return [];
  const { rows } = await client.query<{ name: string; sha256: string; applied_at: Date }>(
    'SELECT name, sha256, applied_at FROM public.schema_migrations ORDER BY name',
  );
  return rows.map((row) => ({ name: row.name, sha256: row.sha256, appliedAt: row.applied_at }));
}

const FORBIDDEN =
  /^(begin|start\s+transaction|commit|end|abort|rollback(?!\s+to\b)|prepare\s+transaction|(set|reset)(\s+(session|local))?\s+(role|session\s+authorization))\b/i;
const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

/** The statements in `sql` that would end or open transactions, or change role, read past
 * comments, quoted strings and identifiers, and dollar-quoted bodies (so a function's own
 * BEGIN … END is fine). Errs on the side of refusing. */
export function forbiddenStatements(sql: string): string[] {
  return statementsOf(sql)
    .map((statement) => FORBIDDEN.exec(statement)?.[0])
    .filter((match): match is string => match !== undefined)
    .map((match) => match.toUpperCase().replace(/\s+/g, ' '));
}

/** Each statement's text, split on semicolons, with comments, quoted strings, quoted
 * identifiers and dollar-quoted bodies taken out. */
export function statementsOf(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  /** Moves past a quoted run that ends at `quote`; in an escape string, a backslash takes the
   * next character. A doubled quote reads as an end and a new start, which keeps the same text
   * out, so it needs no case of its own. */
  const skipQuoted = (quote: string, backslash: boolean) => {
    while (i < sql.length) {
      const c = sql.charAt(i);
      if (backslash && c === '\\') i += 2;
      else if (c === quote) {
        i += 1;
        return;
      } else i += 1;
    }
  };
  while (i < sql.length) {
    const rest = sql.slice(i);
    const tag = DOLLAR_TAG.exec(rest)?.[0];
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
    } else if (rest.startsWith('/*')) {
      // Block comments nest in PostgreSQL.
      let depth = 0;
      do {
        if (sql.startsWith('/*', i)) {
          depth += 1;
          i += 2;
        } else if (sql.startsWith('*/', i)) {
          depth -= 1;
          i += 2;
        } else i += 1;
      } while (depth > 0 && i < sql.length);
    } else if (/^[eE]'/.test(rest)) {
      i += 2;
      skipQuoted("'", true);
      current += ' ';
    } else if (rest.startsWith("'") || rest.startsWith('"')) {
      i += 1;
      skipQuoted(rest.charAt(0), false);
      current += ' ';
    } else if (tag !== undefined) {
      const end = sql.indexOf(tag, i + tag.length);
      i = end === -1 ? sql.length : end + tag.length;
      current += ' ';
    } else if (rest.startsWith(';')) {
      statements.push(current.trim());
      current = '';
      i += 1;
    } else {
      current += sql.charAt(i);
      i += 1;
    }
  }
  statements.push(current.trim());
  return statements
    .map((statement) => statement.replace(/\s+/g, ' '))
    .filter((statement) => statement.length > 0);
}
