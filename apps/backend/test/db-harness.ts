import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { inject } from 'vitest';

// The integration harness, on the cluster scripts/dev-db.sh set up: Homebrew's on the Mac, the
// postgres:18 service in CI. The global setup migrates one template per run; each test file
// copies it (testDatabase), or takes an empty database for the runner's own tests
// (emptyDatabase). Every database a run makes is named after its template, and dropped.

const OWNER_URL_FILE =
  process.env['INSTANTE_TEST_OWNER_URL_FILE'] ??
  fileURLToPath(new URL('../../../.dev/secrets/owner-test.url', import.meta.url));

export const PINNED = "ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' LOCALE 'C'";

export function templateName(pid: number): string {
  return `instante_tpl_${String(pid)}`;
}

function ownerUrl(): string {
  try {
    return readFileSync(OWNER_URL_FILE, 'utf8').trim();
  } catch (cause) {
    throw new Error(`No test database: run scripts/dev-db.sh first (${OWNER_URL_FILE})`, { cause });
  }
}

/** The URL of a database on the test cluster, as one of the two roles. */
export function urlFor(database: string, role: 'owner' | 'app' = 'owner'): string {
  const url = new URL(ownerUrl());
  url.pathname = `/${database}`;
  url.username = `instante_${role}`;
  return url.href;
}

/** A superuser on the test cluster: your own on Homebrew's, postgres on CI's service. */
export function adminUrl(database: string): string {
  const url = new URL(
    process.env['INSTANTE_TEST_ADMIN_URL'] ??
      `postgresql://${userInfo().username}@localhost:5432/postgres`,
  );
  url.pathname = `/${database}`;
  return url.href;
}

let count = 0;
const made: string[] = [];

function nextName(kind: 'c' | 'e'): string {
  count += 1;
  return `${inject('instanteTemplate')}_${kind}${String(process.pid)}_${String(count)}`;
}

/** A copy of the migrated template, owned by instante_owner, with the database-level rights
 * 0001 sets (a copy doesn't carry them). */
export async function testDatabase(): Promise<string> {
  const name = nextName('c');
  await asOwner('instante_test', async (client) => {
    await client.query(
      `CREATE DATABASE ${name} OWNER instante_owner TEMPLATE ${inject('instanteTemplate')}`,
    );
    await client.query(`REVOKE TEMPORARY, CONNECT ON DATABASE ${name} FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${name} TO instante_app`);
  });
  made.push(name);
  return name;
}

/** An empty database from template0, with the pinned locale unless told otherwise. */
export async function emptyDatabase(locale: string = PINNED): Promise<string> {
  const name = nextName('e');
  await asOwner('instante_test', (client) =>
    client.query(`CREATE DATABASE ${name} OWNER instante_owner TEMPLATE template0 ${locale}`),
  );
  made.push(name);
  return name;
}

/** Drops this file's databases; call it after closing their clients. */
export async function dropTestDatabases(): Promise<void> {
  for (const name of made.splice(0)) await dropDatabase(name);
}

/** Drops every database whose name starts with `prefix`: the global teardown's sweep. */
export async function dropDatabasesStartingWith(prefix: string): Promise<void> {
  const { rows } = await asOwner('instante_test', (client) =>
    client.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE starts_with(datname, $1)',
      [prefix],
    ),
  );
  for (const { datname } of rows) await dropDatabase(datname);
}

/** A plain DROP, not FORCE: instante_owner may not terminate an autovacuum worker, and a plain
 * DROP waits for one. A database still in use (a just-closed client's backend still exiting) is
 * retried 4 times, a quarter second apart, before its error is let through. */
export async function dropDatabase(name: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await asOwner('instante_test', (client) => client.query(`DROP DATABASE IF EXISTS ${name}`));
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== '55006' || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

export async function asOwner<T>(database: string, work: (client: pg.Client) => Promise<T>) {
  return as(urlFor(database, 'owner'), work);
}

export async function asApp<T>(database: string, work: (client: pg.Client) => Promise<T>) {
  return as(urlFor(database, 'app'), work);
}

export async function asAdmin<T>(database: string, work: (client: pg.Client) => Promise<T>) {
  return as(adminUrl(database), work);
}

async function as<T>(connectionString: string, work: (client: pg.Client) => Promise<T>) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}
