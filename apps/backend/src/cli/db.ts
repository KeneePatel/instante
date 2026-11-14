import pg from 'pg';
import type { CliConfig } from '../kit/config.ts';
import { sanitize } from '../kit/sanitize.ts';
import { MigrationError, migrate, migrationStatus, readMigrations } from '../store/migrate.ts';
import { PGBOSS_SCHEMA_VERSION, migrateQueue, queueSchemaVersion } from '../store/queue.ts';

// The owner's database commands (docs/specs/platform.md, "cli"):
//   cli db migrate   applies pending migrations, then pg-boss's own, its grants and the queues,
//                    as instante_owner
//   cli db status    lists applied and pending migrations; exits 3 when any is pending, or
//                    when pg-boss's schema isn't this release's
// Our migrations are reported on `print` (stdout); pg-boss's on `log` (stderr).
// Later modules add their commands beside these.

export const USAGE = 'usage: cli db migrate | cli db status';

/** Exit codes: 0 done, 1 refused, 3 not current, 64 usage, 78 configuration. */
export async function runCli(
  config: CliConfig,
  args: readonly string[],
  print: (line: string) => void,
  options: { migrations?: URL; log?: (line: string) => void } = {},
): Promise<number> {
  const log =
    options.log ??
    ((line: string) => {
      console.error(line);
    });
  const [group, command, ...rest] = args;
  if (group !== 'db' || (command !== 'migrate' && command !== 'status') || rest.length > 0) {
    print(USAGE);
    return 64;
  }
  const url =
    command === 'migrate'
      ? config.ownerDatabaseUrl
      : (config.ownerDatabaseUrl ?? config.databaseUrl);
  if (url === undefined) {
    print('cli db migrate needs OWNER_DATABASE_URL_FILE: migrations run as instante_owner');
    return 78;
  }

  const client = new pg.Client({ connectionString: url, application_name: 'instante-cli' });
  await client.connect();
  try {
    const migrations = readMigrations(options.migrations);
    if (command === 'migrate') {
      const applied = await migrate(client, migrations);
      if (applied.length === 0) print('Nothing to apply: the database is current.');
      for (const name of applied) print(`Applied ${name}`);
      await migrateQueue(url, log);
      return 0;
    }
    const { applied, pending } = await migrationStatus(client, migrations);
    for (const row of applied) print(`applied  ${row.name}  ${row.appliedAt.toISOString()}`);
    for (const migration of pending) print(`pending  ${migration.name}`);
    const queue = await queueSchemaVersion(client);
    if (queue !== PGBOSS_SCHEMA_VERSION) {
      log(
        `pg-boss: schema ${queue === null ? 'not installed' : String(queue)}; ` +
          `this release needs ${String(PGBOSS_SCHEMA_VERSION)}`,
      );
    }
    return pending.length === 0 && queue === PGBOSS_SCHEMA_VERSION ? 0 : 3;
  } catch (error) {
    if (!(error instanceof MigrationError)) throw error;
    print(error.message);
    // The database's own error, sanitized: its code and constraint, never a row's values.
    if (error.cause !== undefined) print(JSON.stringify(sanitize(error.cause)));
    return 1;
  } finally {
    await client.end();
  }
}
