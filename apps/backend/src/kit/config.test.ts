import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigError,
  MAX_SOCKET_PATH_BYTES,
  PINNED_NODE,
  loadConfig,
  processRuntime,
  type Runtime,
} from './config.ts';

const HOME = '/Users/owner/.instante';
const SOCKET_URL = `postgresql://instante_app:hex@/instante?host=${encodeURIComponent(`${HOME}/run`)}&port=5432`;

function runtime(files: Record<string, string> = {}, overrides: Partial<Runtime> = {}): Runtime {
  return {
    nodeVersion: PINNED_NODE,
    execArgv: ['--disable-sigusr1'],
    homeDir: '/Users/owner',
    readFile: (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`no such file: ${path}`);
      return text;
    },
    ...overrides,
  };
}

const devEnv = {
  INSTANTE_ENV: 'development',
  ROLE: 'all',
  LISTEN_ADDRESS: '127.0.0.1',
  PORT: '8080',
  ALLOWED_HOST: 'localhost:3000',
  DATABASE_URL_FILE: '/secrets/app',
  DOCUMENTS_SOCKET: '/tmp/instante-dev/documents.sock',
};
const devFiles = { '/secrets/app': 'postgresql://instante_app@localhost:5432/instante_dev\n' };

const prodEnv = {
  ...devEnv,
  INSTANTE_ENV: 'production',
  INSTANTE_HOME: HOME,
  PORT: '4311',
  ALLOWED_HOST: 'instante.localhost:4310',
  DOCUMENTS_SOCKET: `${HOME}/run/documents.sock`,
};
const prodFiles = { '/secrets/app': `${SOCKET_URL}\n` };

/** Production at a home that isn't the default: guarded the same, but not real use. */
const SCRATCH = '/tmp/scratch';
const scratchEnv = {
  ...prodEnv,
  INSTANTE_HOME: SCRATCH,
  PORT: '4321',
  ALLOWED_HOST: 'localhost:4320',
  DOCUMENTS_SOCKET: `${SCRATCH}/run/documents.sock`,
};
const scratchFiles = { '/secrets/app': socketUrl(`${SCRATCH}/run`) };

function socketUrl(folder: string): string {
  return `postgresql://instante_app:hex@/instante?host=${encodeURIComponent(folder)}&port=5432`;
}

function problemsOf(load: () => unknown): string {
  try {
    load();
  } catch (error) {
    if (error instanceof ConfigError) return error.problems.join('\n');
    throw error;
  }
  return '';
}

describe('loadConfig', () => {
  it('reads a development backend, with the secret read from its file', () => {
    expect(loadConfig(devEnv, runtime(devFiles))).toEqual({
      env: 'development',
      role: 'all',
      testRoutes: false,
      listen: { address: '127.0.0.1', port: 8080 },
      allowedHost: 'localhost:3000',
      databaseUrl: 'postgresql://instante_app@localhost:5432/instante_dev',
      documentsSocket: '/tmp/instante-dev/documents.sock',
    });
  });

  it('treats an empty value as unset, as in a copied .env.example', () => {
    const env = { ...devEnv, OWNER_DATABASE_URL_FILE: '', INSTANTE_HOME: '' };
    expect(loadConfig(env, runtime(devFiles)).role).toBe('all');
  });

  it('registers the test routes only with INSTANTE_ENV=test', () => {
    const env = { ...devEnv, INSTANTE_ENV: 'test', PORT: '4321', ALLOWED_HOST: 'localhost:4320' };
    expect(loadConfig(env, runtime(devFiles)).testRoutes).toBe(true);
    expect(loadConfig(prodEnv, runtime(prodFiles)).testRoutes).toBe(false);
  });

  it('accepts real use: production at the default home, on the reserved port and name', () => {
    expect(loadConfig(prodEnv, runtime(prodFiles))).toMatchObject({
      env: 'production',
      listen: { port: 4311 },
      allowedHost: 'instante.localhost:4310',
      databaseUrl: SOCKET_URL,
    });
  });

  it('reports every malformed value at once, as a ConfigError listing them', () => {
    const load = () =>
      loadConfig({ ...devEnv, INSTANTE_ENV: 'staging', ROLE: 'worker' }, runtime(devFiles));
    expect(problemsOf(load)).toMatch(/INSTANTE_ENV[^]*ROLE/);
    expect(load).toThrow(/Instante won't start:\n- INSTANTE_ENV/);
  });

  it('needs INSTANTE_ENV and ROLE', () => {
    expect(problemsOf(() => loadConfig({}, runtime()))).toMatch(/INSTANTE_ENV[^]*ROLE/);
  });

  const notAPort = /must be a port number/;
  const notAHost = /must be a lower-case host and port/;
  const notAPath = /must be an absolute, normalized path/;
  it.each([
    ['PORT', '80a', notAPort],
    ['PORT', '0', notAPort],
    ['PORT', '70000', notAPort],
    ['PORT', '65536', notAPort],
    ['PORT', '-80', notAPort],
    ['PORT', '080', notAPort],
    ['ALLOWED_HOST', 'localhost', notAHost],
    ['ALLOWED_HOST', 'LOCALHOST:3000', notAHost],
    ['ALLOWED_HOST', 'localhost:70000', notAHost],
    ['ALLOWED_HOST', 'instante.localhost.:4320', notAHost],
    ['ALLOWED_HOST', '.localhost:3000', notAHost],
    ['ALLOWED_HOST', 'localhost:65536', notAHost],
    ['ALLOWED_HOST', 'localhost:0', notAHost],
    ['ALLOWED_HOST', 'localhost:03000', notAHost],
    ['ALLOWED_HOST', 'localhost:4320:4310', notAHost],
    ['DATABASE_URL_FILE', 'secrets/app', notAPath],
    ['DATABASE_URL_FILE', '/secrets/../app', notAPath],
    ['DATABASE_URL_FILE', '/secrets//app', notAPath],
    ['OWNER_DATABASE_URL_FILE', 'secrets/owner', notAPath],
    ['DOCUMENTS_SOCKET', 'tmp/d.sock', notAPath],
    ['DOCUMENTS_SOCKET', '/tmp/./d.sock', notAPath],
    ['DOCUMENTS_SOCKET', '/var/folders/x/T//instante-dev/d.sock', notAPath],
    ['INSTANTE_HOME', '/Users/owner/.instante/', notAPath],
  ])('refuses %s=%s', (name, value, message) => {
    expect(problemsOf(() => loadConfig({ ...devEnv, [name]: value }, runtime(devFiles)))).toMatch(
      new RegExp(`^${name} ${message.source}`),
    );
  });

  it('takes the highest port, and names that only resemble the reserved one', () => {
    for (const extra of [
      { PORT: '65535' },
      { ALLOWED_HOST: 'localhost:65535' },
      { ALLOWED_HOST: 'instante.localhost-dev:3000' },
      { ALLOWED_HOST: 'myinstante.localhost:3000' },
    ]) {
      expect(problemsOf(() => loadConfig({ ...devEnv, ...extra }, runtime(devFiles)))).toBe('');
    }
  });

  it('refuses a listen address that is not loopback, in every environment', () => {
    for (const address of ['0.0.0.0', '192.168.1.5', '::', 'localhost']) {
      const problems = problemsOf(() =>
        loadConfig({ ...devEnv, LISTEN_ADDRESS: address }, runtime(devFiles)),
      );
      expect(problems).toMatch(/LISTEN_ADDRESS/);
    }
  });

  it('never puts a secret in its messages', () => {
    const files = { '/secrets/app': 'postgresql://instante_app:s3cret-pw@db.example.com/x' };
    const problems = problemsOf(() => loadConfig(prodEnv, runtime(files)));
    expect(problems).toMatch(/DATABASE_URL_FILE/);
    expect(problems).not.toMatch(/s3cret-pw|db\.example\.com/);
  });

  it('refuses a secret file that is missing or empty', () => {
    expect(problemsOf(() => loadConfig(devEnv, runtime({})))).toMatch(
      /DATABASE_URL_FILE names a file that can't be read/,
    );
    expect(problemsOf(() => loadConfig(devEnv, runtime({ '/secrets/app': '  \n' })))).toMatch(
      /DATABASE_URL_FILE names an empty file/,
    );
  });

  it('trims the white space around a secret', () => {
    const files = { '/secrets/app': '\n  postgresql://instante_app@localhost/x \n' };
    expect(loadConfig(devEnv, runtime(files))).toMatchObject({
      databaseUrl: 'postgresql://instante_app@localhost/x',
    });
  });

  it('takes a DOCUMENTS_SOCKET of up to 104 bytes, the most Node can bind on macOS', () => {
    expect(MAX_SOCKET_PATH_BYTES).toBe(104);
    const at = (socket: string) =>
      problemsOf(() => loadConfig({ ...devEnv, DOCUMENTS_SOCKET: socket }, runtime(devFiles)));
    const ascii = (bytes: number) => `/tmp/${'d'.repeat(bytes - '/tmp//s.sock'.length)}/s.sock`;
    expect(Buffer.byteLength(ascii(104))).toBe(104);
    expect(at(ascii(104))).toBe('');
    expect(at(ascii(105))).toMatch(/^DOCUMENTS_SOCKET must be at most 104 bytes/);
  });

  it('counts the socket path in bytes, not characters', () => {
    const accented = (count: number) => `/tmp/${'é'.repeat(count)}/s.sock`;
    const at = (socket: string) =>
      problemsOf(() => loadConfig({ ...devEnv, DOCUMENTS_SOCKET: socket }, runtime(devFiles)));
    expect(Buffer.byteLength(accented(46))).toBe(104);
    expect(at(accented(46))).toBe('');
    expect(accented(47).length).toBeLessThan(104);
    expect(Buffer.byteLength(accented(47))).toBe(106);
    expect(at(accented(47))).toMatch(/^DOCUMENTS_SOCKET must be at most 104 bytes/);
  });

  describe('per role', () => {
    it('needs everything the backend serves with', () => {
      const problems = problemsOf(() =>
        loadConfig({ INSTANTE_ENV: 'development', ROLE: 'all' }, runtime()),
      );
      for (const name of [
        'LISTEN_ADDRESS',
        'PORT',
        'ALLOWED_HOST',
        'DATABASE_URL_FILE',
        'DOCUMENTS_SOCKET',
      ]) {
        expect(problems).toMatch(new RegExp(`${name} is required with ROLE=all`));
      }
    });

    it('needs the socket for the document service', () => {
      expect(
        problemsOf(() => loadConfig({ INSTANTE_ENV: 'development', ROLE: 'documents' }, runtime())),
      ).toBe('DOCUMENTS_SOCKET is required with ROLE=documents');
    });

    it('never gives the backend the owner role', () => {
      const problems = problemsOf(() =>
        loadConfig({ ...devEnv, OWNER_DATABASE_URL_FILE: '/secrets/owner' }, runtime(devFiles)),
      );
      expect(problems).toMatch(/OWNER_DATABASE_URL_FILE must not be set with ROLE=all/);
    });

    it('gives the document service no secret, no database and no TCP port', () => {
      const env = {
        INSTANTE_ENV: 'development',
        ROLE: 'documents',
        DOCUMENTS_SOCKET: '/tmp/instante-dev/documents.sock',
      };
      expect(loadConfig(env, runtime())).toEqual({
        env: 'development',
        role: 'documents',
        testRoutes: false,
        documentsSocket: '/tmp/instante-dev/documents.sock',
      });
      for (const name of [
        'LISTEN_ADDRESS',
        'PORT',
        'ALLOWED_HOST',
        'DATABASE_URL_FILE',
        'OWNER_DATABASE_URL_FILE',
      ]) {
        const problems = problemsOf(() => loadConfig({ ...env, ...pick(name) }, runtime(devFiles)));
        expect(problems).toMatch(new RegExp(`${name} must not be set with ROLE=documents`));
      }
    });

    it.each([
      ['all', devEnv, 'OWNER_DATABASE_URL_FILE'],
      ['documents', { ...devEnv, ROLE: 'documents', ...unset(BACKEND_ONLY) }, 'DATABASE_URL_FILE'],
      [
        'documents',
        { ...devEnv, ROLE: 'documents', ...unset(BACKEND_ONLY) },
        'OWNER_DATABASE_URL_FILE',
      ],
    ])('with ROLE=%s, never reads the file %s names', (_role, env, name) => {
      const read: string[] = [];
      const reader = (file: string) => {
        read.push(file);
        return `${SOCKET_URL}\n`;
      };
      const refused = `/secrets/refused-${name}`;
      problemsOf(() => loadConfig({ ...env, [name]: refused }, runtime({}, { readFile: reader })));
      expect(read).not.toContain(refused);
    });

    it('lets the cli hold either database role, and needs one', () => {
      const env = { INSTANTE_ENV: 'development', ROLE: 'cli' };
      const files = { '/secrets/owner': 'postgresql://o@localhost/x' };
      expect(
        loadConfig({ ...env, OWNER_DATABASE_URL_FILE: '/secrets/owner' }, runtime(files)),
      ).toEqual({
        env: 'development',
        role: 'cli',
        testRoutes: false,
        databaseUrl: undefined,
        ownerDatabaseUrl: 'postgresql://o@localhost/x',
      });
      expect(problemsOf(() => loadConfig(env, runtime()))).toMatch(/ROLE=cli needs/);
    });

    it('reads the app URL for the cli, alone or beside the owner URL, each from its own file', () => {
      const env = { INSTANTE_ENV: 'development', ROLE: 'cli', DATABASE_URL_FILE: '/secrets/app' };
      const files = {
        '/secrets/app': 'postgresql://instante_app@localhost/x',
        '/secrets/owner': 'postgresql://instante_owner@localhost/x',
      };
      expect(loadConfig(env, runtime(files))).toMatchObject({
        databaseUrl: 'postgresql://instante_app@localhost/x',
        ownerDatabaseUrl: undefined,
      });
      expect(
        loadConfig({ ...env, OWNER_DATABASE_URL_FILE: '/secrets/owner' }, runtime(files)),
      ).toMatchObject({
        databaseUrl: 'postgresql://instante_app@localhost/x',
        ownerDatabaseUrl: 'postgresql://instante_owner@localhost/x',
      });
    });
  });

  describe('outside real use', () => {
    it.each([
      ['port 4310', { PORT: '4310' }],
      ['port 4311', { PORT: '4311' }],
      ['the name instante.localhost', { ALLOWED_HOST: 'instante.localhost:4320' }],
      ['a name under instante.localhost', { ALLOWED_HOST: 'a.instante.localhost:4320' }],
      ['port 4310 behind another name', { ALLOWED_HOST: 'localhost:4310' }],
      ['port 4311 behind another name', { ALLOWED_HOST: 'localhost:4311' }],
    ])('refuses %s, which only real use may have', (_case, extra) => {
      expect(problemsOf(() => loadConfig({ ...devEnv, ...extra }, runtime(devFiles)))).toMatch(
        /reserved for real use/,
      );
    });

    it.each([SCRATCH, '/tmp/x/.instante', '/Users/other/.instante'])(
      'counts production at %s, not the default home, as outside real use',
      (home) => {
        const env = { ...prodEnv, INSTANTE_HOME: home, DOCUMENTS_SOCKET: `${home}/run/d.sock` };
        const files = { '/secrets/app': socketUrl(`${home}/run`) };
        const problems = problemsOf(() => loadConfig(env, runtime(files)));
        expect(problems).toMatch(/PORT 4311 is reserved for real use/);
        expect(problems).toMatch(/ALLOWED_HOST names a host or port reserved for real use/);
      },
    );

    it.each(['development', 'test'])(
      'counts %s at the default home as outside real use',
      (instanteEnv) => {
        const env = { ...prodEnv, INSTANTE_ENV: instanteEnv };
        const problems = problemsOf(() => loadConfig(env, runtime(prodFiles)));
        expect(problems).toMatch(/PORT 4311 is reserved for real use/);
        expect(problems).toMatch(/ALLOWED_HOST names a host or port reserved for real use/);
      },
    );
  });

  describe('the production guard', () => {
    describe.each([
      ['real use', prodEnv, prodFiles, HOME],
      ['a scratch home', scratchEnv, scratchFiles, SCRATCH],
    ])('at %s', (_place, env, files, home) => {
      const run = `${home}/run`;
      const at = (extra: object, process_: Partial<Runtime> = {}) =>
        problemsOf(() => loadConfig({ ...env, ...extra }, runtime(files, process_)));
      const withUrl = (url: string) =>
        problemsOf(() => loadConfig(env, runtime({ '/secrets/app': `${url}\n` })));

      it('accepts a process that meets it', () => {
        expect(at({})).toBe('');
      });

      it.each([
        ['a TCP database', 'postgresql://instante_app:hex@127.0.0.1:5432/instante'],
        ['a socket elsewhere', socketUrl('/tmp')],
        ['host= pointing elsewhere after the right one', `${socketUrl(run)}&host=%2Ftmp%2Fother`],
        ['no host at all', 'postgresql://instante_app:hex@/instante'],
        ['text that is no URL', 'garbage'],
        ['a URL that fails to parse', 'postgresql://[::1'],
        [
          'a second URL nested in the query, which pg parses again',
          `${socketUrl(run)}&connectionString=${encodeURIComponent('postgresql://x@127.0.0.1/i')}`,
        ],
        ['a folder that climbs out of run', socketUrl(`${run}/../../../../tmp`)],
        ['a folder that only starts like run', socketUrl(`${run}-other`)],
        ['a folder inside run', socketUrl(`${run}/sub`)],
        ['the home itself', socketUrl(home)],
      ])('refuses %s', (_case, url) => {
        expect(withUrl(url)).toBe(
          `DATABASE_URL_FILE: production connects only through the socket folder ${run}`,
        );
      });

      it.each(['v26.12.0', 'v26.13.2', 'v26.13.10', 'v27.0.0'])(
        'refuses Node %s, which is not the pinned one',
        (nodeVersion) => {
          expect(at({}, { nodeVersion })).toBe(`production runs only on Node ${PINNED_NODE}`);
        },
      );

      it('refuses a process started without --disable-sigusr1', () => {
        expect(at({}, { execArgv: [] })).toBe('production processes start with --disable-sigusr1');
        expect(at({}, { execArgv: ['--max-old-space-size=512'] })).toBe(
          'production processes start with --disable-sigusr1',
        );
      });

      it('takes --disable-sigusr1 anywhere, in any spelling Node accepts', () => {
        for (const execArgv of [
          ['--max-old-space-size=512', '--disable-sigusr1'],
          ['--disable_sigusr1'],
          ['--disable-sigusr1=false'],
        ]) {
          expect(at({}, { execArgv })).toBe('');
        }
      });

      it.each([
        '--no-disable-sigusr1',
        '--no_disable_sigusr1',
        '--no-disable_sigusr1',
        '--no-disable-sigusr1=false',
        '--inspect',
        '--inspect_brk',
        '--inspect-brk=0.0.0.0:9229',
        '--inspect-port=0',
        '--debug-port=0',
      ])('refuses %s, which can open an inspector despite --disable-sigusr1', (flag) => {
        expect(at({}, { execArgv: ['--disable-sigusr1', flag] })).toBe(
          'production processes start with no inspector flags',
        );
      });

      it.each(['--inspect=127.0.0.1:0', '--require /tmp/x.cjs', '--max-old-space-size=512'])(
        'refuses NODE_OPTIONS=%s, which execArgv never shows',
        (options) => {
          expect(at({ NODE_OPTIONS: options })).toBe('NODE_OPTIONS must not be set in production');
        },
      );

      it('treats an empty NODE_OPTIONS as unset, like every other empty value', () => {
        expect(at({ NODE_OPTIONS: '' })).toBe('');
      });

      it('needs INSTANTE_HOME', () => {
        expect(at({ INSTANTE_HOME: undefined })).toMatch(/INSTANTE_HOME is required in production/);
      });

      it.each(['/tmp/documents.sock', '-other/d.sock', '/sub/d.sock', '/../d.sock'])(
        "keeps the document service's socket in $INSTANTE_HOME/run, refusing %s",
        (socket) => {
          const path = socket.startsWith('/tmp') ? socket : `${run}${socket}`;
          expect(at({ DOCUMENTS_SOCKET: path })).toMatch(
            new RegExp(`^DOCUMENTS_SOCKET (must be in ${escape(run)} in production|must be an)`),
          );
        },
      );
    });

    it.each(['development', 'test'])('applies none of its checks in %s', (instanteEnv) => {
      const env = {
        ...devEnv,
        INSTANTE_ENV: instanteEnv,
        INSTANTE_HOME: '/tmp/dev',
        NODE_OPTIONS: '--inspect',
      };
      const process_ = { nodeVersion: 'v26.12.0', execArgv: ['--inspect', '--no-disable-sigusr1'] };
      expect(loadConfig(env, runtime(devFiles, process_)).env).toBe(instanteEnv);
    });

    describe('for every role', () => {
      const documents = {
        INSTANTE_ENV: 'production',
        INSTANTE_HOME: HOME,
        ROLE: 'documents',
        DOCUMENTS_SOCKET: `${HOME}/run/documents.sock`,
      };
      const cli = {
        INSTANTE_ENV: 'production',
        INSTANTE_HOME: HOME,
        ROLE: 'cli',
        DATABASE_URL_FILE: '/secrets/app',
      };
      const roles = [
        ['documents', documents],
        ['cli', cli],
      ] as const;

      it("checks the cli's owner URL as well as the app's", () => {
        const env = {
          ...cli,
          DATABASE_URL_FILE: undefined,
          OWNER_DATABASE_URL_FILE: '/secrets/owner',
        };
        const tcp = { '/secrets/owner': 'postgresql://instante_owner:hex@127.0.0.1/instante' };
        expect(problemsOf(() => loadConfig(env, runtime(tcp)))).toBe(
          `OWNER_DATABASE_URL_FILE: production connects only through the socket folder ${HOME}/run`,
        );
        expect(loadConfig(env, runtime({ '/secrets/owner': SOCKET_URL }))).toMatchObject({
          ownerDatabaseUrl: SOCKET_URL,
        });
      });

      it('accepts the document service and the cli when they meet the guard', () => {
        expect(loadConfig(documents, runtime())).toEqual({
          env: 'production',
          role: 'documents',
          testRoutes: false,
          documentsSocket: `${HOME}/run/documents.sock`,
        });
        expect(loadConfig(cli, runtime(prodFiles))).toMatchObject({ databaseUrl: SOCKET_URL });
      });

      it.each(roles)('checks Node, the flags and INSTANTE_HOME with ROLE=%s', (_role, env) => {
        const at = (extra: object, process_: Partial<Runtime> = {}) =>
          problemsOf(() => loadConfig({ ...env, ...extra }, runtime(prodFiles, process_)));
        expect(at({}, { nodeVersion: 'v26.12.0' })).toMatch(/production runs only on Node/);
        expect(at({}, { execArgv: [] })).toMatch(/--disable-sigusr1/);
        expect(at({}, { execArgv: ['--disable-sigusr1', '--inspect'] })).toMatch(/inspector/);
        expect(at({ NODE_OPTIONS: '--inspect' })).toMatch(/NODE_OPTIONS/);
        expect(at({ INSTANTE_HOME: undefined })).toMatch(/INSTANTE_HOME is required/);
      });

      it("keeps the document service's own socket in $INSTANTE_HOME/run", () => {
        const env = { ...documents, DOCUMENTS_SOCKET: '/tmp/documents.sock' };
        expect(problemsOf(() => loadConfig(env, runtime()))).toMatch(
          /DOCUMENTS_SOCKET must be in \/Users\/owner\/\.instante\/run/,
        );
      });
    });
  });

  it("pins the same Node as mise.toml, so the guard can't drift from the tools", () => {
    const mise = readFileSync(new URL('../../../../mise.toml', import.meta.url), 'utf8');
    expect(PINNED_NODE).toBe(`v${/node = "([^"]+)"/.exec(mise)?.[1] ?? ''}`);
  });
});

describe('processRuntime', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads this process's version and flags, and files as UTF-8", () => {
    const process_ = processRuntime();
    expect(process_.nodeVersion).toBe(process.version);
    expect(process_.execArgv).toBe(process.execArgv);
    expect(process_.readFile(new URL(import.meta.url).pathname)).toContain("'é'.repeat");
  });

  it("takes the account's own home, whatever $HOME says", () => {
    vi.stubEnv('HOME', '/nonexistent-home');
    expect(processRuntime().homeDir).toBe(userInfo().homedir);
    expect(processRuntime().homeDir).not.toBe('/nonexistent-home');
  });
});

const BACKEND_ONLY = ['LISTEN_ADDRESS', 'PORT', 'ALLOWED_HOST', 'DATABASE_URL_FILE'];

function unset(names: readonly string[]): Record<string, undefined> {
  return Object.fromEntries(names.map((name) => [name, undefined]));
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A valid value for one setting, so a refusal can only come from the role rules. */
function pick(name: string): Record<string, string> {
  const values: Record<string, string> = {
    LISTEN_ADDRESS: '127.0.0.1',
    PORT: '8081',
    ALLOWED_HOST: 'localhost:3000',
    DATABASE_URL_FILE: '/secrets/app',
    OWNER_DATABASE_URL_FILE: '/secrets/owner',
  };
  return { [name]: values[name] ?? '' };
}
