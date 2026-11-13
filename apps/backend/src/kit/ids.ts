import { randomFillSync, randomUUIDv7 } from 'node:crypto';
import { newId, type Id, type IdPrefix } from '@instante/contract';

// Row ids are UUIDv7, made here rather than by the database (docs/architecture.md, "Data").
// Node's v7 carries the millisecond and random bits after it, so ids sort by time only to
// the millisecond: order rows by their timestamps, never by id alone.
// The master resume's element ids come from the contract's one generator (ADR-008).

export type Ids = {
  uuid: () => string;
  documentId: <P extends IdPrefix>(prefix: P) => Id<P>;
};

export const systemIds: Ids = {
  uuid: () => randomUUIDv7(),
  documentId: (prefix) => newId(prefix, (bytes) => randomFillSync(bytes)),
};
