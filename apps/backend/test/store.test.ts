import { readFileSync, readdirSync } from 'node:fs';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable, pgTable, uuid } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { manualClock } from '../src/kit/clock.ts';
import { createLogger } from '../src/kit/logger.ts';
import { createDb, type Db } from '../src/store/db.ts';
import { migrationStatus, readMigrations } from '../src/store/migrate.ts';
import { asPersonId } from '../src/store/person.ts';
import { createPool, type Pool } from '../src/store/pool.ts';
import * as schema from '../src/store/schema.ts';
import { listPings, recordPing } from '../src/store/skeleton.ts';
import { asApp, asOwner, dropTestDatabases, testDatabase, urlFor } from './db-harness.ts';
import { personTableProblems, personTables, scopingViolations } from './store-scoping.ts';

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
                has_database_privilege(current_user, current_database(), 'TEMPORARY') AS temp`,
      );
      expect(rows).toEqual([{ public: 0, temp: false }]);
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

  it('mirrors the migrations: every table and column the schema names exists, NOT NULL alike', async () => {
    const tables = Object.values(schema as Record<string, unknown>).filter(
      (value): value is PgTable => is(value, PgTable),
    );
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      const { rows } = await pool.query<{ column: string; nullable: string }>(
        `SELECT column_name AS column, is_nullable AS nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
        [getTableName(table)],
      );
      const columns = Object.values(getTableColumns(table)).map((c) => ({
        column: c.name,
        nullable: c.notNull ? 'NO' : 'YES',
      }));
      expect(rows, getTableName(table)).toEqual(expect.arrayContaining(columns));
      expect(rows.length, getTableName(table)).toBe(columns.length);
    }
  });
});

describe('the person-scoped store rule', () => {
  const STORE = new URL('../src/store/', import.meta.url);
  const sources = readdirSync(STORE)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => ({ file, text: readFileSync(new URL(file, STORE), 'utf8') }));

  it('holds for every store function', () => {
    expect(scopingViolations(sources, personTables(schema))).toEqual([]);
  });

  it('flags a function that touches a per-person table without a PersonId', () => {
    const text = `
      export async function listNotes(db: Db) { return db.select().from(userNote); }
      export async function myNotes(db: Db, person: PersonId) { return db.select().from(userNote); }
      export const addNote = async (db: Db, note: { userId: PersonId; text: string }) =>
        db.insert(userNote).values(note);
      export const dropNotes = (db: Db, id: string) => db.delete(userNote);
      export function ping(db: Db) { return db.select().from(skeletonPing); }
    `;
    expect(scopingViolations([{ file: 'notes.ts', text }], ['userNote'])).toEqual([
      'notes.ts: listNotes touches userNote without a PersonId',
      'notes.ts: dropNotes touches userNote without a PersonId',
    ]);
  });

  it('finds the per-person tables by their user_id column', () => {
    expect(personTables(schema)).toEqual([]);
    const userNote = pgTable('user_note', { userId: uuid('user_id').notNull(), id: uuid('id') });
    expect(personTables({ ...schema, userNote, notATable: 'x' })).toEqual(['userNote']);
  });

  it('holds in the database: user_id NOT NULL and first in the primary key', async () => {
    const scratch = await testDatabase();
    await asOwner(scratch, async (client) => {
      expect(await personTableProblems(client)).toEqual([]);
      await client.query(
        'CREATE TABLE good_note (user_id uuid NOT NULL, id uuid NOT NULL, PRIMARY KEY (user_id, id))',
      );
      await client.query('CREATE TABLE loose_note (id uuid PRIMARY KEY, user_id uuid)');
      expect(await personTableProblems(client)).toEqual([
        'loose_note.user_id may be null',
        "loose_note's primary key doesn't start with user_id",
      ]);
    });
  });

  it('makes a PersonId only from an account id', () => {
    expect(asPersonId(ids[0])).toBe(ids[0]);
    for (const bad of ['', 'u1', `${ids[0]} `, ids[0].toUpperCase(), '1 OR 1=1']) {
      expect(() => asPersonId(bad), bad).toThrow(/not an account id/);
    }
  });
});
