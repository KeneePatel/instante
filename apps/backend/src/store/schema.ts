import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { PgTable } from 'drizzle-orm/pg-core';

// The tables the app reads and writes, as Drizzle sees them. The SQL in migrations/ is the
// truth; these mirror it, and only store/ knows them (docs/architecture.md, "store").
//
// Every table is classified, once, in one of the lists at the end, and tests hold the lists to
// the database both ways. A per-person table has a user_id column, NOT NULL and first in its
// primary key, and every store function that touches it sits in a function taking the person's
// id as a PersonId (see person.ts).

/** The walking skeleton's one table (0002_skeleton.sql). */
export const skeletonPing = pgTable('skeleton_ping', {
  id: uuid('id').primaryKey(),
  note: text('note').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/** Tables whose every row belongs to one person. */
export const PERSON_TABLES: readonly PgTable[] = [];

/** Tables shared by everyone, or holding no one's data. */
export const SHARED_TABLES: readonly PgTable[] = [skeletonPing];
