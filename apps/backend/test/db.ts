import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import pg from 'pg';

// Scratch databases for the runner's tests, on the cluster scripts/dev-db.sh set up: Homebrew's
// on the Mac, the postgres:18 service in CI. Until T10's harness, each test creates its own
// database from template0 and drops it afterwards.

const OWNER_URL_FILE =
  process.env['INSTANTE_TEST_OWNER_URL_FILE'] ??
  new URL('../../../.dev/secrets/owner-test.url', import.meta.url).pathname;

function ownerUrl(): string {
  try {
    return readFileSync(OWNER_URL_FILE, 'utf8').trim();
  } catch (cause) {
    throw new Error(`No test database: run scripts/dev-db.sh first (${OWNER_URL_FILE})`, { cause });
  }
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

/** The URL of a database on the test cluster, as one of the two roles. */
export function urlFor(database: string, role: 'owner' | 'app' = 'owner'): string {
  const url = new URL(ownerUrl());
  url.pathname = `/${database}`;
  url.username = `instante_${role}`;
  return url.href;
}

export const PINNED = "ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' LOCALE 'C'";

let count = 0;
const created: string[] = [];

/** A fresh, empty database owned by instante_owner, with the pinned locale unless told
 * otherwise. */
export async function scratchDatabase(locale: string = PINNED): Promise<string> {
  count += 1;
  const name = `instante_t_${String(process.pid)}_${String(count)}`;
  await asOwner('instante_test', (client) =>
    client.query(`CREATE DATABASE ${name} OWNER instante_owner TEMPLATE template0 ${locale}`),
  );
  created.push(name);
  return name;
}

/** Drops every scratch database once its clients are closed. A plain DROP waits out an
 * autovacuum worker, which instante_owner may not terminate; another session is retried. */
export async function dropScratchDatabases(): Promise<void> {
  for (const name of created.splice(0)) {
    for (let attempt = 1; ; attempt++) {
      try {
        await asOwner('instante_test', (client) => client.query(`DROP DATABASE IF EXISTS ${name}`));
        break;
      } catch (error) {
        if ((error as { code?: string }).code !== '55006' || attempt === 20) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
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
