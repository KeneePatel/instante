import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { parse } from 'pg-connection-string';
import { z } from 'zod';

// The backend's settings, read once at start (docs/specs/platform.md, "Configuration").
// Secrets arrive as file paths and are read here; no message ever repeats a value read
// from a file, so a refusal can be logged as it is.

/** The Node every production process runs. A test holds it equal to mise.toml's pin. */
export const PINNED_NODE = 'v26.13.1';

/** macOS's limit for a socket path that Node binds: Node passes the length, so all 104
 * bytes of sun_path are usable (ADR-012; PostgreSQL's own socket, NUL-terminated, gets 103). */
export const MAX_SOCKET_PATH_BYTES = 104;

/** Real use's own ports and name. Nothing else may take them, so a tab left open on
 * real use can never reach another run of Instante. */
const RESERVED_PORTS: ReadonlySet<number> = new Set([4310, 4311]);
const RESERVED_NAME = /(^|\.)instante\.localhost$/;

export const ENVS = ['development', 'test', 'production'] as const;
export const ROLES = ['all', 'documents', 'cli'] as const;
export type Env = (typeof ENVS)[number];
export type Role = (typeof ROLES)[number];

type Common = {
  env: Env;
  /** The test-only route table is registered only with INSTANTE_ENV=test. */
  testRoutes: boolean;
};
export type BackendConfig = Common & {
  role: 'all';
  listen: { address: '127.0.0.1'; port: number };
  allowedHost: string;
  databaseUrl: string;
  documentsSocket: string;
};
export type DocumentsConfig = Common & { role: 'documents'; documentsSocket: string };
export type CliConfig = Common & {
  role: 'cli';
  databaseUrl: string | undefined;
  ownerDatabaseUrl: string | undefined;
};
export type Config = BackendConfig | DocumentsConfig | CliConfig;

/** What loadConfig reads from the process besides its environment, so tests can vary it. */
export type Runtime = {
  nodeVersion: string;
  execArgv: readonly string[];
  homeDir: string;
  readFile: (file: string) => string;
};

export function processRuntime(): Runtime {
  return {
    nodeVersion: process.version,
    execArgv: process.execArgv,
    // The account's own home, never $HOME: real use is decided by who runs, not by the environment.
    homeDir: userInfo().homedir,
    readFile: (file) => readFileSync(file, 'utf8'),
  };
}

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Instante won't start:\n${problems.map((p) => `- ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const absolutePath = z
  .string()
  .refine((p) => path.isAbsolute(p) && path.normalize(p) === p && !p.endsWith('/'), {
    error: 'must be an absolute, normalized path (no "//", ".", ".." or trailing slash)',
  });

const port = z
  .string()
  .regex(/^[1-9][0-9]{0,4}$/, { error: 'must be a port number' })
  .transform(Number)
  .pipe(z.number().max(65535, { error: 'must be a port number' }));

const EnvSchema = z.object({
  INSTANTE_ENV: z.enum(ENVS, { error: 'must be development, test or production' }),
  ROLE: z.enum(ROLES, { error: 'must be all, documents or cli' }),
  INSTANTE_HOME: absolutePath.optional(),
  LISTEN_ADDRESS: z
    .literal('127.0.0.1', { error: 'must be 127.0.0.1: the backend listens on loopback only' })
    .optional(),
  PORT: port.optional(),
  ALLOWED_HOST: z
    .string()
    .regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?:[1-9][0-9]{0,4}$/, {
      error: 'must be a lower-case host and port, such as localhost:3000',
    })
    .refine((h) => Number(h.split(':')[1]) <= 65535, {
      error: 'must be a lower-case host and port, such as localhost:3000',
    })
    .optional(),
  DATABASE_URL_FILE: absolutePath.optional(),
  OWNER_DATABASE_URL_FILE: absolutePath.optional(),
  DOCUMENTS_SOCKET: absolutePath
    .refine((p) => Buffer.byteLength(p) <= MAX_SOCKET_PATH_BYTES, {
      error: `must be at most ${String(MAX_SOCKET_PATH_BYTES)} bytes, macOS's limit for a socket path`,
    })
    .optional(),
});
type Name = keyof typeof EnvSchema.shape;
const NAMES = Object.keys(EnvSchema.shape) as Name[];

/** Which settings each role needs, and which it must never be given. */
const ROLE_RULES: Record<Role, { needs: Name[]; refuses: Name[] }> = {
  all: {
    needs: ['LISTEN_ADDRESS', 'PORT', 'ALLOWED_HOST', 'DATABASE_URL_FILE', 'DOCUMENTS_SOCKET'],
    refuses: ['OWNER_DATABASE_URL_FILE'],
  },
  // The document service gets no secret, no database and no TCP port.
  documents: {
    needs: ['DOCUMENTS_SOCKET'],
    refuses: [
      'LISTEN_ADDRESS',
      'PORT',
      'ALLOWED_HOST',
      'DATABASE_URL_FILE',
      'OWNER_DATABASE_URL_FILE',
    ],
  },
  cli: { needs: [], refuses: [] },
};

export function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
  runtime: Runtime,
): Config {
  // An empty value counts as unset, as in a copied .env.example.
  const present = Object.fromEntries(
    NAMES.flatMap((name) => {
      const value = env[name];
      return value === undefined || value === '' ? [] : [[name, value]];
    }),
  );
  const parsed = EnvSchema.safeParse(present);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${String(i.path[0])} ${i.message}`));
  }
  const v = parsed.data;
  const problems: string[] = [];
  const production = v.INSTANTE_ENV === 'production';

  const rules = ROLE_RULES[v.ROLE];
  for (const name of rules.needs) {
    if (v[name] === undefined) problems.push(`${name} is required with ROLE=${v.ROLE}`);
  }
  for (const name of rules.refuses) {
    if (v[name] !== undefined) problems.push(`${name} must not be set with ROLE=${v.ROLE}`);
  }
  if (
    v.ROLE === 'cli' &&
    v.DATABASE_URL_FILE === undefined &&
    v.OWNER_DATABASE_URL_FILE === undefined
  ) {
    problems.push('ROLE=cli needs DATABASE_URL_FILE or OWNER_DATABASE_URL_FILE');
  }

  const realUse = production && v.INSTANTE_HOME === path.join(runtime.homeDir, '.instante');
  if (!realUse) {
    if (v.PORT !== undefined && RESERVED_PORTS.has(v.PORT)) {
      problems.push(`PORT ${String(v.PORT)} is reserved for real use`);
    }
    if (v.ALLOWED_HOST !== undefined) {
      const [name = '', hostPort = ''] = v.ALLOWED_HOST.split(':');
      if (RESERVED_NAME.test(name) || RESERVED_PORTS.has(Number(hostPort))) {
        problems.push('ALLOWED_HOST names a host or port reserved for real use');
      }
    }
  }

  // The production guard: the pinned Node, no inspector by signal, flag or NODE_OPTIONS, and
  // the database only through the cluster's own socket folder.
  const run = v.INSTANTE_HOME === undefined ? undefined : path.join(v.INSTANTE_HOME, 'run');
  if (production) {
    if (runtime.nodeVersion !== PINNED_NODE) {
      problems.push(`production runs only on Node ${PINNED_NODE}`);
    }
    // Node reads `_` as `-` in option names and ignores a value on these flags, so compare
    // names alone: `--no_disable_sigusr1=false` still turns the signal back on.
    const flags = runtime.execArgv.map((a) => (a.split('=', 1)[0] ?? '').replaceAll('_', '-'));
    if (!flags.includes('--disable-sigusr1')) {
      problems.push('production processes start with --disable-sigusr1');
    }
    if (flags.some((f) => f === '--no-disable-sigusr1' || /^--(inspect|debug)/.test(f))) {
      problems.push('production processes start with no inspector flags');
    }
    if (env['NODE_OPTIONS'] !== undefined && env['NODE_OPTIONS'] !== '') {
      problems.push('NODE_OPTIONS must not be set in production');
    }
    if (run === undefined) {
      problems.push('INSTANTE_HOME is required in production');
    } else if (v.DOCUMENTS_SOCKET !== undefined && path.dirname(v.DOCUMENTS_SOCKET) !== run) {
      problems.push(`DOCUMENTS_SOCKET must be in ${run} in production`);
    }
  }

  const readUrl = (name: 'DATABASE_URL_FILE' | 'OWNER_DATABASE_URL_FILE'): string | undefined => {
    const file = v[name];
    if (file === undefined || rules.refuses.includes(name)) return undefined;
    let url: string;
    try {
      url = runtime.readFile(file).trim();
    } catch {
      problems.push(`${name} names a file that can't be read`);
      return undefined;
    }
    if (url === '') {
      problems.push(`${name} names an empty file`);
      return undefined;
    }
    if (production && run !== undefined && socketFolderOf(url) !== run) {
      problems.push(`${name}: production connects only through the socket folder ${run}`);
    }
    return url;
  };
  const databaseUrl = readUrl('DATABASE_URL_FILE');
  const ownerDatabaseUrl = readUrl('OWNER_DATABASE_URL_FILE');

  if (problems.length > 0) throw new ConfigError(problems);

  const common = { env: v.INSTANTE_ENV, testRoutes: v.INSTANTE_ENV === 'test' };
  switch (v.ROLE) {
    case 'all':
      return {
        ...common,
        role: 'all',
        listen: { address: '127.0.0.1', port: need(v.PORT) },
        allowedHost: need(v.ALLOWED_HOST),
        databaseUrl: need(databaseUrl),
        documentsSocket: need(v.DOCUMENTS_SOCKET),
      };
    case 'documents':
      return { ...common, role: 'documents', documentsSocket: need(v.DOCUMENTS_SOCKET) };
    case 'cli':
      return { ...common, role: 'cli', databaseUrl, ownerDatabaseUrl };
  }
}

/** The host `pg` would connect to: for a socket, its folder. Undefined if the URL doesn't
 * parse, or nests a second URL that `pg` would parse again when given a string. */
function socketFolderOf(url: string): string | null | undefined {
  try {
    const options = parse(url);
    return 'connectionString' in options ? undefined : options.host;
  } catch {
    return undefined;
  }
}

/** For values the role rules above have already required. */
function need<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('a required setting was missed by the role rules');
  return value;
}
