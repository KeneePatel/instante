import type { TestProject } from 'vitest/node';
import { migrate, readMigrations } from '../src/store/migrate.ts';
import {
  PINNED,
  asOwner,
  dropDatabase,
  dropDatabasesStartingWith,
  templateName,
} from './db-harness.ts';

// Once per test run: one migrated template database, which each integration test file copies
// (docs/specs/platform.md, "Integration tests"). The run's own databases are dropped after it.

declare module 'vitest' {
  export interface ProvidedContext {
    instanteTemplate: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const template = templateName(process.pid);
  await asOwner('instante_test', (client) =>
    client.query(`CREATE DATABASE ${template} OWNER instante_owner TEMPLATE template0 ${PINNED}`),
  );
  await asOwner(template, (client) => migrate(client, readMigrations()));
  project.provide('instanteTemplate', template);
  return async () => {
    await dropDatabasesStartingWith(`${template}_`);
    await dropDatabase(template);
  };
}
