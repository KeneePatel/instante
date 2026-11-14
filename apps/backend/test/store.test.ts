import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { manualClock } from '../src/kit/clock.ts';
import { createLogger } from '../src/kit/logger.ts';
import { createDb, type Db } from '../src/store/db.ts';
import { migrationStatus, readMigrations } from '../src/store/migrate.ts';
import { asPersonId } from '../src/store/person.ts';
import { createPool, type Pool } from '../src/store/pool.ts';
import * as schema from '../src/store/schema.ts';
import { PERSON_TABLES, SHARED_TABLES } from '../src/store/schema.ts';
import { listPings, recordPing } from '../src/store/skeleton.ts';
import { asApp, asOwner, dropTestDatabases, testDatabase, urlFor } from './db-harness.ts';
import { personTableProblems, scopingViolations, sourcesUnder } from './store-scoping.ts';

// The store over a copy of the migrated template (docs/specs/platform.md, "store"), and the
// person-scoped store rule.

const logger = createLogger({
  clock: manualClock('2026-11-13T16:00:00Z'),
  sink: { out: () => {}, err: () => {} },
});
const ids = [
  '01a1d6d4-6c3f-70a4-8d32-3cec9c5a9747',
  '01a1d6d4-6c3f-71d9-9b53-1b1e1f754b21',
] as const;

let database: string;
let pool: Pool;
let db: Db;

beforeAll(async () => {
  database = await testDatabase();
  pool = createPool(urlFor(database, 'app'), { logger, max: 2 });
  db = createDb(pool);
});

afterAll(async () => {
  await pool.end();
  await dropTestDatabases();
});

describe('the harness', () => {
  it('copies the migrated template, with the pinned locale, for instante_owner', async () => {
    await asApp(database, async (client) => {
      const { applied, pending } = await migrationStatus(client, readMigrations());
      expect(applied.map((a) => a.name)).toEqual(['0001_baseline', '0002_skeleton']);
      expect(pending).toEqual([]);
      const { rows } = await client.query(
        `SELECT datlocprovider AS provider, datlocale AS locale, datcollate AS collate,
                pg_encoding_to_char(encoding) AS encoding, pg_get_userbyid(datdba) AS owner
           FROM pg_database WHERE datname = current_database()`,
      );
      expect(rows).toEqual([
        {
          provider: 'b',
          locale: 'C.UTF-8',
          collate: 'C',
          encoding: 'UTF8',
          owner: 'instante_owner',
        },
      ]);
    });
  });

  it('gives each copy the database-level rights a copy would otherwise lack', async () => {
    await asApp(database, async (client) => {
      const { rows } = await client.query(
        `SELECT (SELECT count(*)::int FROM pg_database d, aclexplode(d.datacl) a
                  WHERE d.datname = current_database() AND a.grantee = 0) AS public,
                has_database_privilege(current_user, current_database(), 'TEMPORARY') AS temp,
                has_database_privilege(current_user, current_database(), 'CREATE') AS create`,
      );
      expect(rows).toEqual([{ public: 0, temp: false, create: false }]);
      await expect(client.query('CREATE TEMP TABLE t (id int)')).rejects.toMatchObject({
        code: '42501',
      });
    });
  });

  it('gives each call a database of its own', async () => {
    const other = await testDatabase();
    expect(other).not.toBe(database);
    await asOwner(other, (client) =>
      client.query("INSERT INTO skeleton_ping (id, note) VALUES ($1, 'only here')", [ids[0]]),
    );
    expect(await listPings(db)).toEqual([]);
  });
});

describe('Drizzle over the pool', () => {
  it('connects as instante_app', async () => {
    const { rows } = await pool.query<{ role: string }>('SELECT current_user AS role');
    expect(rows).toEqual([{ role: 'instante_app' }]);
  });

  it('keeps what a transaction commits, and nothing of one that rolls back', async () => {
    await db.transaction(async (tx) => {
      await recordPing(tx, { id: ids[0], note: 'kept' });
    });
    await expect(
      db.transaction(async (tx) => {
        await recordPing(tx, { id: ids[1], note: 'rolled back' });
        throw new Error('stop');
      }),
    ).rejects.toThrow('stop');
    const pings = await listPings(db);
    expect(pings).toEqual([{ id: ids[0], note: 'kept', createdAt: expect.any(Date) as unknown }]);
  });

  it('mirrors the migrations: every column the schema names, with its type and NOT NULL', async () => {
    const tables = Object.values(schema as Record<string, unknown>).filter(
      (value): value is PgTable => is(value, PgTable),
    );
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      const { rows } = await pool.query<{ column: string; type: string; notNull: boolean }>(
        `SELECT a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type,
                a.attnotnull AS "notNull"
           FROM pg_attribute a
          WHERE a.attrelid = format('public.%I', $1::text)::regclass
            AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum`,
        [getTableName(table)],
      );
      const columns = Object.values(getTableColumns(table)).map((c) => ({
        column: c.name,
        type: c.getSQLType(),
        notNull: c.notNull,
      }));
      expect(rows, getTableName(table)).toEqual(expect.arrayContaining(columns));
      expect(rows.length, getTableName(table)).toBe(columns.length);
    }
  });

  it('lists pings oldest first, then by id, all of them', async () => {
    const copy = await testDatabase();
    const copyPool = createPool(urlFor(copy, 'app'), { logger, max: 1 });
    try {
      const rows: [string, string][] = [
        ['01a1d6d4-0000-7000-8000-00000000000a', '2026-11-13T16:00:02Z'],
        ['01a1d6d4-0000-7000-8000-00000000000c', '2026-11-13T16:00:01Z'],
        ['01a1d6d4-0000-7000-8000-00000000000b', '2026-11-13T16:00:01Z'],
      ];
      for (const [id, at] of rows) {
        await copyPool.query(
          "INSERT INTO skeleton_ping (id, note, created_at) VALUES ($1, 'n', $2)",
          [id, at],
        );
      }
      const pings = await listPings(createDb(copyPool));
      expect(pings.map((p) => [p.id, p.createdAt.toISOString()])).toEqual([
        ['01a1d6d4-0000-7000-8000-00000000000b', '2026-11-13T16:00:01.000Z'],
        ['01a1d6d4-0000-7000-8000-00000000000c', '2026-11-13T16:00:01.000Z'],
        ['01a1d6d4-0000-7000-8000-00000000000a', '2026-11-13T16:00:02.000Z'],
      ]);
    } finally {
      await copyPool.end();
    }
  });

  it('knows the schema, so the relational queries work', async () => {
    expect(
      await db.query.skeletonPing.findMany({ where: (t, { eq }) => eq(t.note, 'none') }),
    ).toEqual([]);
  });
});

describe('the person-scoped store rule', () => {
  const STORE = fileURLToPath(new URL('../src/store/', import.meta.url));
  const personFile = path.join(STORE, 'person.ts');

  it('holds for every store function, in every folder of src/store', () => {
    const files = sourcesUnder(STORE);
    expect(files).toContain(path.join(STORE, 'skeleton.ts'));
    const input = {
      files,
      schemaFile: path.join(STORE, 'schema.ts'),
      personFile,
      sqlNames: PERSON_TABLES.map((table) => getTableName(table)),
    };
    expect(scopingViolations(input)).toEqual([]);
  });

  describe('the check', () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'instante-scoping-'));
    afterAll(() => {
      rmSync(folder, { recursive: true, force: true });
    });
    const schemaFile = path.join(folder, 'schema.ts');
    writeFileSync(
      schemaFile,
      [
        "export const userNote = { sql: 'user_note' };",
        "export const skeleton = { sql: 'skeleton_ping' };",
        'export const PERSON_TABLES = [userNote] as const;',
      ].join('\n'),
    );
    const header = [
      `import type { PersonId } from '${personFile}';`,
      "import { skeleton, userNote, userNote as notes } from './schema.ts';",
      'type NotAPersonId = string;',
    ];
    const flagged: [string, string][] = [
      ['plain', 'export function listNotes(db: unknown) { return [db, userNote]; }'],
      ['an import alias', 'export function aliased(db: unknown) { return [db, notes]; }'],
      ['a module-level alias', 'export const everyone = userNote;'],
      ['a re-export', 'export { userNote as all };'],
      [
        'an object method',
        'export const store = { list(db: unknown) { return [db, userNote]; } };',
      ],
      ['a class method', 'export class Notes { list() { return userNote; } }'],
      ['raw SQL', "export function raw() { return 'SELECT * FROM user_note'; }"],
      [
        'a SQL template',
        'export function tpl(n: number) { return `DELETE FROM user_note WHERE n = ${String(n)}`; }',
      ],
      [
        'an optional PersonId',
        'export function optional(person?: PersonId) { return [person, userNote]; }',
      ],
      [
        'a union with string',
        'export function union(person: PersonId | string) { return [person, userNote]; }',
      ],
      [
        'a defaulted PersonId',
        "export function dflt(person: PersonId = 'x' as PersonId) { return [person, userNote]; }",
      ],
      [
        'a lookalike type',
        'export function lookalike(person: NotAPersonId) { return [person, userNote]; }',
      ],
      ['a default export', 'export default function (db: unknown) { return [db, userNote]; }'],
    ];
    const allowed = [
      'export function mine(db: unknown, person: PersonId) { return [db, person, userNote]; }',
      'export function inTx(person: PersonId) { return [person].map(() => userNote); }',
      'export type Note = typeof userNote;',
      "export function scopedRaw(person: PersonId) { return [person, 'SELECT * FROM user_note WHERE user_id = $1']; }",
      'export function aliasedMine(person: PersonId) { return [person, notes]; }',
      'export function shared(db: unknown) { return [db, skeleton]; }',
      'export const arrowMine = (person: PersonId) => [person, userNote];',
      'export const methods = { list(person: PersonId) { return [person, userNote]; } };',
    ];

    it.each(flagged)('flags %s', (_case, line) => {
      const file = path.join(folder, `${String(Math.random()).slice(2)}.ts`);
      writeFileSync(file, [...header, line].join('\n'));
      const found = scopingViolations({
        files: [file],
        schemaFile,
        personFile,
        sqlNames: ['user_note'],
      });
      expect(found).toEqual([
        expect.stringMatching(new RegExp(`:${String(header.length + 1)}: user`)),
      ]);
    });

    it('passes a use inside any function taking a PersonId, a type, and shared tables', () => {
      const file = path.join(folder, 'allowed.ts');
      writeFileSync(file, [...header, ...allowed].join('\n'));
      // The schema itself lists the tables at module level, which is how they're declared.
      expect(
        scopingViolations({
          files: [file, schemaFile],
          schemaFile,
          personFile,
          sqlNames: ['user_note'],
        }),
      ).toEqual([]);
    });

    it('reads every folder, at any depth', () => {
      const nested = path.join(folder, 'deep', 'er');
      mkdirSync(nested, { recursive: true });
      writeFileSync(path.join(nested, 'x.ts'), 'export {};');
      writeFileSync(path.join(nested, 'x.test.ts'), 'export {};');
      expect(sourcesUnder(folder)).toContain(path.join(nested, 'x.ts'));
      expect(sourcesUnder(folder)).not.toContain(path.join(nested, 'x.test.ts'));
    });
  });

  it('classifies every table once, and every table in the database', async () => {
    const declared = Object.values(schema as Record<string, unknown>).filter(
      (value): value is PgTable => is(value, PgTable),
    );
    const classified = [...PERSON_TABLES, ...SHARED_TABLES];
    expect(new Set(classified).size).toBe(classified.length);
    expect(new Set(classified)).toEqual(new Set(declared));
    const { rows } = await pool.query<{ table: string; person: boolean }>(
      `SELECT t.table_name AS table,
              EXISTS (SELECT 1 FROM information_schema.columns c
                       WHERE c.table_schema = 'public' AND c.table_name = t.table_name
                         AND c.column_name = 'user_id') AS person
         FROM information_schema.tables t
        WHERE t.table_schema = 'public' AND t.table_name <> 'schema_migrations'
        ORDER BY 1`,
    );
    expect(rows.map((r) => r.table)).toEqual(classified.map((t) => getTableName(t)).sort());
    // A table with a user_id is per person; one that holds a person's id another way needs the
    // owner's decision and a list of its own.
    expect(rows.filter((r) => r.person).map((r) => r.table)).toEqual(
      PERSON_TABLES.map((t) => getTableName(t)).sort(),
    );
    for (const table of PERSON_TABLES) {
      const userId = Object.values(getTableColumns(table)).find((c) => c.name === 'user_id');
      expect(userId?.notNull, getTableName(table)).toBe(true);
    }
  });

  it('holds in the database: user_id NOT NULL and first in the primary key', async () => {
    const scratch = await testDatabase();
    await asOwner(scratch, async (client) => {
      expect(await personTableProblems(client)).toEqual([]);
      await client.query(
        'CREATE TABLE good_note (user_id uuid NOT NULL, id uuid NOT NULL, PRIMARY KEY (user_id, id))',
      );
      await client.query('CREATE TABLE loose_note (id uuid PRIMARY KEY, user_id uuid)');
      await client.query('CREATE TABLE keyless_note (user_id uuid NOT NULL, id uuid)');
      await client.query(
        'CREATE TABLE unique_note (user_id uuid NOT NULL, id uuid, UNIQUE (user_id, id))',
      );
      expect(await personTableProblems(client)).toEqual([
        "keyless_note's primary key doesn't start with user_id",
        'loose_note.user_id may be null',
        "loose_note's primary key doesn't start with user_id",
        "unique_note's primary key doesn't start with user_id",
      ]);
    });
  });

  it('makes a PersonId only from an account id', () => {
    expect(asPersonId(ids[0])).toBe(ids[0]);
    const misplaced = `${'0'.repeat(34)}-0`;
    for (const bad of ['', 'u1', `${ids[0]} `, ids[0].toUpperCase(), '1 OR 1=1', misplaced]) {
      expect(() => asPersonId(bad), bad).toThrow(/not an account id/);
    }
  });
});
