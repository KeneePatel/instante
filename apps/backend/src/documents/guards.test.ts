import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ChildReport } from '../kit/probes.ts';
import {
  checkJobFolder,
  parseLsof,
  selftestReply,
  serviceFacts,
  unexpectedFiles,
  type OpenFile,
} from './guards.ts';

const folders: string[] = [];
/** A new private folder (mode 0700, from mkdtemp), by real path. */
function folder(): string {
  const made = realpathSync(mkdtempSync(path.join(tmpdir(), 'instante-guards-')));
  folders.push(made);
  return made;
}
afterAll(() => {
  for (const made of folders) rmSync(made, { recursive: true, force: true });
});

/** A folder holding `secret`, outside a job's folder. */
function outsideFolder(): string {
  const outside = folder();
  writeFileSync(path.join(outside, 'secret'), 'top secret');
  return outside;
}

describe('checkJobFolder', () => {
  /** A job folder holding `input`, as the service makes it. */
  function job(): string {
    const made = folder();
    writeFileSync(path.join(made, 'input'), 'bytes', { mode: 0o600 });
    return made;
  }

  it('passes a folder holding only regular files with one link', () => {
    expect(checkJobFolder(job())).toEqual([]);
  });

  it('refuses a symlink, a folder, and a file with more than one link', () => {
    const made = job();
    const outside = outsideFolder();
    symlinkSync(path.join(outside, 'secret'), path.join(made, 'link'));
    mkdirSync(path.join(made, 'sub'));
    linkSync(path.join(outside, 'secret'), path.join(made, 'hard'));
    expect(checkJobFolder(made).sort()).toEqual([
      'hard has 2 links',
      'link is a symlink',
      "sub isn't a regular file",
    ]);
  });

  it('refuses the input itself once it has a second name elsewhere', () => {
    const made = job();
    linkSync(path.join(made, 'input'), path.join(folder(), 'copy'));
    expect(checkJobFolder(made)).toEqual(['input has 2 links']);
  });

  it('refuses a folder others can reach, another user’s, or one that is a symlink', () => {
    for (const mode of [0o750, 0o701]) {
      const open = job();
      chmodSync(open, mode);
      expect(checkJobFolder(open)).toEqual(["the job's folder isn't the owner's alone"]);
    }
    const uid = process.getuid?.() ?? 0;
    const spy = vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    try {
      expect(checkJobFolder(job())).toEqual(["the job's folder isn't the owner's alone"]);
    } finally {
      spy.mockRestore();
    }
    const link = path.join(folder(), 'job');
    symlinkSync(job(), link);
    expect(checkJobFolder(link)).toEqual(["the job's folder isn't a folder"]);
  });
});

/** What `lsof -F fltn` printed for a `selftest` child on macOS 27 (Node 26.13.1). */
const MACOS = [
  'p21122',
  'fcwd',
  'l ',
  'tDIR',
  'n/private/var/folders/xy/T/instante-job-UqVS7R',
  'ftxt',
  'l ',
  'tREG',
  'n/Users/someone/.local/share/mise/installs/node/26.13.1/bin/node',
  ...[0, 1, 2].flatMap((fd) => [
    `f${String(fd)}`,
    'l ',
    'tunix',
    `n->0x4acc5ee7f403a43${String(fd)}`,
  ]),
  ...['f3', 'l ', 'tKQUEUE', 'ncount=0, state=0x8'],
  ...['f4', 'l ', 'tPIPE', 'n->0x384b7c6d6c8df314', 'f5', 'l ', 'tPIPE', 'n->0x465f733987eb92fc'],
  ...['f6', 'l ', 'tDIR', 'n/', 'f7', 'l ', 'tKQUEUE', 'ncount=0, state=0xa'],
  ...['f8', 'l ', 'tDIR', 'n/', 'f9', 'l ', 'tKQUEUE', 'ncount=0, state=0xa'],
  ...['f10', 'l ', 'tDIR', 'n/', 'f11', 'l ', 'tCHR', 'n/dev/null'],
  '',
].join('\n');

const file = (fd: string, type: string, name: string, lock = ''): OpenFile => ({
  fd,
  lock,
  type,
  name,
});

describe('parseLsof', () => {
  it('reads one file per `f` line, with its lock, type and name', () => {
    const files = parseLsof(MACOS);
    expect(files).toHaveLength(14);
    expect(files[0]).toEqual(file('cwd', 'DIR', '/private/var/folders/xy/T/instante-job-UqVS7R'));
    expect(files.at(-1)).toEqual(file('11', 'CHR', '/dev/null'));
    expect(parseLsof('p1\nf9\nlW\ntREG\nn/run/instante.lock\n')).toEqual([
      file('9', 'REG', '/run/instante.lock', 'W'),
    ]);
  });
});

describe('unexpectedFiles', () => {
  it('finds nothing in a macOS child: its pipes and Node’s own descriptors', () => {
    expect(unexpectedFiles(parseLsof(MACOS))).toEqual([]);
  });

  it('finds nothing in a Linux child’s pipes and event descriptors', () => {
    expect(
      unexpectedFiles([
        file('rtd', 'DIR', '/'),
        file('mem', 'REG', '/usr/lib/x86_64-linux-gnu/libc.so.6'),
        ...['0', '1', '2'].map((fd) => file(fd, 'unix', 'type=STREAM (CONNECTED)')),
        file('3', 'a_inode', '[eventpoll:4,5]'),
        file('4', 'FIFO', 'pipe'),
        file('5', 'FIFO', 'pipe'),
        file('6', 'a_inode', '[eventfd:7]'),
      ]),
    ).toEqual([]);
  });

  it('finds a regular file, a socket, a lock, a terminal, a folder, or a pipe where its own aren’t', () => {
    expect(
      unexpectedFiles([
        file('0', 'REG', '/Users/someone/.instante/secrets/database-url'),
        file('9', 'REG', '/Users/someone/.instante/run/instante.lock', 'W'),
        file('12', 'IPv4', '127.0.0.1:52000->127.0.0.1:4311'),
        file('13', 'unix', '/Users/someone/.instante/run/.s.PGSQL.5432'),
        file('14', 'CHR', '/dev/ttys001'),
        file('15', 'DIR', '/Users/someone/.instante'),
        file('16', 'KQUEUE', 'count=0, state=0x8', 'r'),
        file('17', 'sock', 'protocol: TCP'),
        file('1', 'PIPE', '->0x384b7c6d6c8df314'),
        file('2', 'FIFO', 'pipe'),
      ]),
    ).toEqual([
      '0 REG /Users/someone/.instante/secrets/database-url',
      '9W REG /Users/someone/.instante/run/instante.lock',
      '12 IPv4 127.0.0.1:52000->127.0.0.1:4311',
      '13 unix /Users/someone/.instante/run/.s.PGSQL.5432',
      '14 CHR /dev/ttys001',
      '15 DIR /Users/someone/.instante',
      '16r KQUEUE count=0, state=0x8',
      '17 sock protocol: TCP',
      '1 PIPE ->0x384b7c6d6c8df314',
      '2 FIFO pipe',
    ]);
  });
});

const ALLOWED_ENV = {
  INSTANTE_ENV: 'production',
  ROLE: 'documents',
  INSTANTE_HOME: '/Users/someone/.instante',
  DOCUMENTS_SOCKET: '/Users/someone/.instante/run/documents.sock',
};

describe('serviceFacts', () => {
  it('passes the allowed names, macOS’s own, and --disable-sigusr1', () => {
    expect(
      serviceFacts({
        env: { ...ALLOWED_ENV, __CF_USER_TEXT_ENCODING: '0x1F5:0x0:0x0', ABSENT: undefined },
        execArgv: ['--disable-sigusr1'],
        platform: 'darwin',
      }),
    ).toEqual({ extraNames: [], databaseUrl: false, secretFile: false, disableSigusr1: true });
  });

  it('names every other name, macOS’s own included elsewhere, in order', () => {
    expect(
      serviceFacts({
        env: {
          ...ALLOWED_ENV,
          PATH: '/usr/bin',
          __CF_USER_TEXT_ENCODING: 'x',
          HOME: '',
          // The backend's own, which the documents role refuses, even when empty.
          PORT: '',
        },
        execArgv: [],
        platform: 'linux',
      }).extraNames,
    ).toEqual(['HOME', 'PATH', 'PORT', '__CF_USER_TEXT_ENCODING']);
  });

  it('finds a database URL under any name, whatever its case', () => {
    const facts = (value: string) =>
      serviceFacts({ env: { X: value }, execArgv: [], platform: 'linux' }).databaseUrl;
    expect(facts('postgres://instante_app@/instante')).toBe(true);
    expect(facts(' POSTGRESQL://x')).toBe(true);
    expect(facts('jdbc:postgresql://localhost/instante')).toBe(true);
    expect(facts('http://postgres.example')).toBe(false);
    expect(facts('postgres')).toBe(false);
    expect(facts('postgres:5432')).toBe(false);
  });

  it('finds a secret file’s path: a name ending in _FILE, or a value inside the secrets folder', () => {
    const facts = (env: Record<string, string>) =>
      serviceFacts({ env: { ...ALLOWED_ENV, ...env }, execArgv: [], platform: 'linux' }).secretFile;
    expect(facts({ TOKEN_FILE: '/elsewhere' })).toBe(true);
    expect(facts({ X: '/Users/someone/.instante/secrets/database-url' })).toBe(true);
    expect(facts({ X: '/Users/someone/.instante/secrets' })).toBe(true);
    expect(facts({ X: '/Users/someone/.instante/secrets-old' })).toBe(false);
    expect(facts({})).toBe(false);
  });

  it('reads --disable-sigusr1 as Node does, and sees it undone', () => {
    const facts = (execArgv: string[]) =>
      serviceFacts({ env: {}, execArgv, platform: 'linux' }).disableSigusr1;
    expect(facts(['--disable_sigusr1'])).toBe(true);
    expect(facts(['--disable-sigusr1', '--no_disable_sigusr1=false'])).toBe(false);
    expect(facts([])).toBe(false);
  });
});

describe('selftestReply', () => {
  const FLAGS = ['--permission', '--allow-fs-read=/jobs/1'];
  const denied = {
    tcp: 'denied',
    databaseSocket: 'denied',
    lookup: 'denied',
    write: 'denied',
    spawn: 'denied',
    readSecrets: 'denied',
  } as const;
  const clean = { extraNames: [], databaseUrl: false, secretFile: false, disableSigusr1: true };
  const report = (change: Partial<ChildReport> = {}): Buffer =>
    Buffer.from(JSON.stringify({ execArgv: FLAGS, env: [], probes: denied, ...change }));
  const reply = (change: Partial<Parameters<typeof selftestReply>[0]> = {}) =>
    selftestReply({
      service: clean,
      stdout: report(),
      expectedFlags: FLAGS,
      platform: 'linux',
      openFiles: parseLsof(MACOS),
      ...change,
    });

  it('is ok when every check passes, and carries what it judged', () => {
    expect(reply()).toEqual({
      ok: true,
      problems: [],
      service: clean,
      child: { execArgv: FLAGS, env: [], probes: denied },
      openFiles: [],
    });
  });

  it('names each of the service’s problems', () => {
    expect(
      reply({
        service: {
          extraNames: ['A', 'B'],
          databaseUrl: true,
          secretFile: true,
          disableSigusr1: false,
        },
      }).problems,
    ).toEqual([
      "the service's environment holds other names: A, B",
      "the service's environment holds a database URL",
      "the service's environment holds a secret file's path",
      'the service started without --disable-sigusr1',
    ]);
    expect(reply({ service: { ...clean, extraNames: ['PATH'] } }).problems).toEqual([
      "the service's environment holds other names: PATH",
    ]);
  });

  it('names flags that differ in any way, every name in the environment, and each probe not denied', () => {
    for (const execArgv of [
      [...FLAGS].reverse(),
      [...FLAGS, '--inspect'],
      FLAGS.slice(1),
      FLAGS.slice(0, -1),
    ]) {
      expect(reply({ stdout: report({ execArgv }) }).problems).toEqual([
        "the child's flags aren't exactly the expected ones",
      ]);
    }
    expect(reply({ stdout: report({ env: ['NODE_OPTIONS', 'PATH'] }) }).problems).toEqual([
      "the child's environment holds NODE_OPTIONS, PATH",
    ]);
    expect(reply({ stdout: report({ env: ['NODE_OPTIONS'] }) }).problems).toEqual([
      "the child's environment holds NODE_OPTIONS",
    ]);
    // macOS's own name, on macOS only.
    expect(
      reply({ stdout: report({ env: ['__CF_USER_TEXT_ENCODING'] }), platform: 'darwin' }).ok,
    ).toBe(true);
    expect(reply({ stdout: report({ env: ['__CF_USER_TEXT_ENCODING'] }) }).problems).toEqual([
      "the child's environment holds __CF_USER_TEXT_ENCODING",
    ]);
    const { ok, problems } = reply({
      stdout: report({ probes: { ...denied, tcp: 'allowed', readSecrets: 'failed: ENOENT' } }),
    });
    expect(ok).toBe(false);
    expect(problems).toEqual([
      "the child's tcp probe: allowed",
      "the child's readSecrets probe: failed: ENOENT",
    ]);
  });

  it('fails on a report that doesn’t parse, or holds anything else', () => {
    for (const stdout of [
      'not json',
      '{}',
      JSON.stringify({ ...JSON.parse(report().toString()), x: 1 }),
      report({ probes: { ...denied, extra: 'denied' } as ChildReport['probes'] }).toString(),
      report({
        probes: { ...denied, tcp: 'maybe' } as unknown as ChildReport['probes'],
      }).toString(),
    ]) {
      const result = reply({ stdout: Buffer.from(stdout) });
      expect(result.child).toBeNull();
      expect(result.problems).toEqual(["the child's report doesn't parse"]);
    }
  });

  it('fails when the open files can’t be listed, come back empty, or hold too much', () => {
    expect(reply({ openFiles: new Error('lsof timed out') }).problems).toEqual([
      "the child's open files couldn't be listed: lsof timed out",
    ]);
    expect(reply({ openFiles: [] }).problems).toEqual(["lsof listed none of the child's files"]);
    const held = reply({ openFiles: [...parseLsof(MACOS), file('12', 'REG', '/secret')] });
    expect(held.openFiles).toEqual(['12 REG /secret']);
    expect(held.problems).toEqual(['the child holds descriptors beyond its own: 12 REG /secret']);
  });
});
