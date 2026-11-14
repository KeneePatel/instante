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
// (docs/specs/platform.md, "Integration tests"). The run's own databases are dropped after it,
// and those of runs that died (Ctrl-C, a crash) are reclaimed at the next start.

declare module 'vitest' {
  export interface ProvidedContext {
    instanteTemplate: string;
  }
}

export async function setup(project: TestProject): Promise<() => Promise<void>> {
  await reclaimDeadRuns();
  const template = templateName(process.pid);
  const teardown = async () => {
    await dropDatabasesStartingWith(`${template}_`);
    await dropDatabase(template);
  };
  try {
    await asOwner('instante_test', (client) =>
      client.query(`CREATE DATABASE ${template} OWNER instante_owner TEMPLATE template0 ${PINNED}`),
    );
    await asOwner(template, (client) => migrate(client, readMigrations()));
  } catch (error) {
    await teardown().catch(() => undefined);
    throw new Error(
      'The integration tests need Postgres 18 on localhost:5432 with scripts/dev-db.sh run ' +
        '(brew services start postgresql@18), and migrations that apply. Without a database, ' +
        'run the unit tests alone: pnpm exec vitest run --project backend',
      { cause: error },
    );
  }
  project.provide('instanteTemplate', template);
  return teardown;
}

/** Drops the templates and copies of earlier runs whose process is gone. */
async function reclaimDeadRuns(): Promise<void> {
  const { rows } = await asOwner('instante_test', (client) =>
    client.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname ~ '^instante_tpl_[0-9]+$'",
    ),
  ).catch(() => ({ rows: [] }));
  for (const { datname } of rows) {
    const pid = Number(datname.slice('instante_tpl_'.length));
    if (isAlive(pid)) continue;
    await dropDatabasesStartingWith(`${datname}_`);
    await dropDatabase(datname);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, but another user's.
    return (error as { code?: string }).code === 'EPERM';
  }
}
