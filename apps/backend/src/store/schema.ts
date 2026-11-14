import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// The tables the app reads and writes, as Drizzle sees them. The SQL in migrations/ is the
// truth; these mirror it, and only store/ knows them (docs/architecture.md, "store").
//
// A per-person table has a user_id column, NOT NULL, and a primary key of (user_id, id); every
// store function that touches one takes the person's id (see person.ts). Tests hold both.

/** The walking skeleton's one table (0002_skeleton.sql). Shared, not per person. */
export const skeletonPing = pgTable('skeleton_ping', {
  id: uuid('id').primaryKey(),
  note: text('note').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});
