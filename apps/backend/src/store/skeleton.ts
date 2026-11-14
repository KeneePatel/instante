import { asc } from 'drizzle-orm';
import type { Db, Tx } from './db.ts';
import { skeletonPing } from './schema.ts';

// The walking skeleton's store functions, for the queue check (T11). skeleton_ping is shared,
// not per person, so these take no PersonId.

export type Ping = { id: string; note: string; createdAt: Date };

export async function recordPing(db: Db | Tx, ping: { id: string; note: string }): Promise<void> {
  await db.insert(skeletonPing).values(ping);
}

export async function listPings(db: Db | Tx): Promise<Ping[]> {
  return db.select().from(skeletonPing).orderBy(asc(skeletonPing.createdAt), asc(skeletonPing.id));
}
