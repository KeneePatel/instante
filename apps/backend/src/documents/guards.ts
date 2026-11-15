import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { allowedNames, optionNames } from '../kit/config.ts';
import { ChildReportSchema, type SelftestReply } from '../kit/documents-client.ts';
import { PROBES } from '../kit/probes.ts';

// The document service's checks on what its children can reach (docs/specs/platform.md,
// "documents"; docs/threat-model.md, "A restricted child reads through a symlink or an inherited
// descriptor"). Node's permission model follows a symlink inside a read grant wherever it
// points, so the code granted to the children must hold none that leads out of it, and a job's
// folder nothing but plain files. `selftest` then shows a child's flags, environment, probes and
// open files, and the service's own environment and flags.

/** The grant holding `target`, if any. */
const grantOf = (grants: readonly string[], target: string) =>
  grants.find((grant) => target === grant || target.startsWith(`${grant}/`));

/** How many names `target` adds to `grant`'s path. */
const depth = (grant: string, target: string) =>
  target === grant ? 0 : target.slice(grant.length + 1).split('/').length;

/** Walks the granted code, following no link, and resolves every symlink in it as the kernel
 * does. Throws, naming them, if any points outside the grants or nowhere, or to a folder that sits
 * nearer its grant's top than the link sits in its own, or if a grant isn't a folder's real path
 * (the path a child's grant must name).
 *
 * The permission model checks a path after removing `link/..` as text, while the kernel follows
 * the link first and climbs from its target. So `..` after a link to a shallower folder climbs
 * out of the grants while the path still reads as inside them. */
export function checkGrantedCode(grants: readonly string[]): { entries: number; links: number } {
  const problems: string[] = [];
  for (const grant of grants) {
    if (
      !existsSync(grant) ||
      realpathSync.native(grant) !== grant ||
      !lstatSync(grant).isDirectory()
    ) {
      problems.push(`${grant} isn't a folder's real path`);
    }
  }
  let entries = 0;
  let links = 0;
  const folders = problems.length === 0 ? grants.map((grant) => ({ grant, folder: grant })) : [];
  for (let next = folders.pop(); next !== undefined; next = folders.pop()) {
    const { grant, folder } = next;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      entries++;
      const entryPath = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        folders.push({ grant, folder: entryPath });
      } else if (entry.isSymbolicLink()) {
        links++;
        let target: string;
        try {
          // The JS realpath removes `..` as text, which the kernel doesn't.
          target = realpathSync.native(entryPath);
        } catch {
          problems.push(`${entryPath} points nowhere`);
          continue;
        }
        const holder = grantOf(grants, target);
        if (holder === undefined) {
          problems.push(`${entryPath} points outside, to ${target}`);
        } else if (
          statSync(target).isDirectory() &&
          depth(holder, target) < depth(grant, entryPath)
        ) {
          problems.push(`${entryPath} sits deeper than the folder it points to, ${target}`);
        }
      }
    }
  }
  if (problems.length > 0) {
    const shown = problems.slice(0, 10);
    const more =
      problems.length > shown.length ? `\n(and ${String(problems.length - 10)} more)` : '';
    throw new Error(
      `The document service won't grant its children this code:\n${shown.join('\n')}${more}`,
    );
  }
  return { entries, links };
}

/** What's wrong with a job's folder, if anything: it must be a real folder, the owner's alone,
 * holding only regular files with one link each, since through a symlink or a hard link a child
 * could read what its grant doesn't cover. */
export function checkJobFolder(folder: string): string[] {
  const stat = lstatSync(folder);
  if (!stat.isDirectory()) return ["the job's folder isn't a folder"];
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    return ["the job's folder isn't the owner's alone"];
  }
  return readdirSync(folder).flatMap((name) => {
    const entry = lstatSync(path.join(folder, name));
    if (entry.isSymbolicLink()) return [`${name} is a symlink`];
    if (!entry.isFile()) return [`${name} isn't a regular file`];
    if (entry.nlink !== 1) return [`${name} has ${String(entry.nlink)} links`];
    return [];
  });
}

/** One open file, as `lsof -F` lists it. */
export type OpenFile = { fd: string; lock: string; type: string; name: string };

/** Where `lsof` is: macOS, then Linux. The service starts with no PATH. */
const LSOF = ['/usr/sbin/lsof', '/usr/bin/lsof'];

/** Lists a process's open files with `lsof`. */
export async function listOpenFiles(pid: number): Promise<OpenFile[]> {
  const lsof = LSOF.find((file) => existsSync(file));
  if (lsof === undefined) throw new Error(`lsof isn't at ${LSOF.join(' or ')}`);
  // -n and -P: no name lookups; -w: no warnings; -F: one field per line.
  const { stdout } = await promisify(execFile)(
    lsof,
    ['-n', '-P', '-w', '-F', 'fltn', '-p', String(pid)],
    { env: {}, timeout: 5_000, maxBuffer: 1024 * 1024 },
  );
  return parseLsof(stdout);
}

/** `lsof -F fltn`: a line per field, its first character naming it; `f` starts each file. */
export function parseLsof(output: string): OpenFile[] {
  const files: OpenFile[] = [];
  let file: OpenFile | undefined;
  for (const line of output.split('\n')) {
    const value = line.slice(1);
    if (line.startsWith('f')) {
      file = { fd: value, lock: '', type: '', name: '' };
      files.push(file);
    } else if (file !== undefined) {
      if (line.startsWith('l')) file.lock = value.trim();
      else if (line.startsWith('t')) file.type = value;
      else if (line.startsWith('n')) file.name = value;
    }
  }
  return files;
}

/** A child's descriptors beyond its own three pipes and Node's internal ones, each as
 * `<fd> <type> <name>`. Memory-mapped files and the working folder aren't descriptors, so only
 * numbered entries count; any lock counts against one. Node's own, on macOS: kqueues, the event
 * loop's pipe, `/` opened read-only and `/dev/null`; on Linux, pipes and event descriptors. */
export function unexpectedFiles(files: readonly OpenFile[]): string[] {
  const expected = (file: OpenFile, fd: number) => {
    if (file.lock !== '') return false;
    // The service's own pipes: libuv makes them socket pairs, on macOS and Linux.
    if (fd <= 2) return file.type === 'unix';
    if (['KQUEUE', 'PIPE', 'FIFO', 'a_inode'].includes(file.type)) return true;
    if (file.type === 'DIR') return file.name === '/';
    if (file.type === 'CHR') return file.name === '/dev/null';
    return false;
  };
  return files
    .filter((file) => /^\d+$/.test(file.fd) && !expected(file, Number(file.fd)))
    .map((file) => `${file.fd}${file.lock} ${file.type} ${file.name}`);
}

/** Another process's environment and flags, as the service checks its own. */
export type ProcessFacts = {
  env: Readonly<Record<string, string | undefined>>;
  execArgv: readonly string[];
  platform: NodeJS.Platform;
};

/** macOS's CoreFoundation sets its text-encoding hint in every process it starts in. */
const PLATFORM_NAMES: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: ['__CF_USER_TEXT_ENCODING'],
};

/** The service's own process: names beyond its allowed ones, whether any value is a database
 * URL or a secret file's path, and whether it started with --disable-sigusr1. */
export function serviceFacts(facts: ProcessFacts): SelftestReply['service'] {
  const allowed = new Set<string>([
    ...allowedNames('documents'),
    ...(PLATFORM_NAMES[facts.platform] ?? []),
  ]);
  const names = Object.keys(facts.env).filter((name) => facts.env[name] !== undefined);
  const values = names.map((name) => facts.env[name] ?? '');
  const home = facts.env['INSTANTE_HOME'];
  const secrets = home === undefined ? undefined : path.join(home, 'secrets');
  const flags = optionNames(facts.execArgv);
  return {
    extraNames: names.filter((name) => !allowed.has(name)).sort(),
    databaseUrl: values.some((value) => /postgres(ql)?:\/\//i.test(value)),
    secretFile:
      names.some((name) => name.endsWith('_FILE')) ||
      (secrets !== undefined &&
        values.some((value) => value === secrets || value.startsWith(`${secrets}/`))),
    disableSigusr1: flags.includes('--disable-sigusr1') && !flags.includes('--no-disable-sigusr1'),
  };
}

/** `selftest`'s reply: the service's own checks, the child's report judged against the flags it
 * must have, and its open files. */
export function selftestReply(input: {
  service: SelftestReply['service'];
  /** The child's stdout. */
  stdout: Buffer;
  expectedFlags: readonly string[];
  platform: NodeJS.Platform;
  /** The child's open files, or why they couldn't be listed. */
  openFiles: readonly OpenFile[] | Error;
}): SelftestReply {
  const { service } = input;
  const problems: string[] = [];
  if (service.extraNames.length > 0) {
    problems.push(`the service's environment holds other names: ${service.extraNames.join(', ')}`);
  }
  if (service.databaseUrl) problems.push("the service's environment holds a database URL");
  if (service.secretFile) problems.push("the service's environment holds a secret file's path");
  if (!service.disableSigusr1) problems.push('the service started without --disable-sigusr1');

  let child: SelftestReply['child'] = null;
  try {
    const parsed = ChildReportSchema.safeParse(JSON.parse(input.stdout.toString('utf8')));
    if (parsed.success) child = parsed.data;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  if (child === null) {
    problems.push("the child's report doesn't parse");
  } else {
    const { execArgv, env, probes } = child;
    if (
      execArgv.length !== input.expectedFlags.length ||
      execArgv.some((flag, i) => flag !== input.expectedFlags[i])
    ) {
      problems.push("the child's flags aren't exactly the expected ones");
    }
    const platformNames = PLATFORM_NAMES[input.platform] ?? [];
    const extra = env.filter((name) => !platformNames.includes(name));
    if (extra.length > 0) problems.push(`the child's environment holds ${extra.join(', ')}`);
    for (const name of PROBES) {
      if (probes[name] !== 'denied') problems.push(`the child's ${name} probe: ${probes[name]}`);
    }
  }

  let openFiles: string[] = [];
  if (input.openFiles instanceof Error) {
    problems.push(`the child's open files couldn't be listed: ${input.openFiles.message}`);
  } else {
    openFiles = unexpectedFiles(input.openFiles);
    if (input.openFiles.length === 0) problems.push("lsof listed none of the child's files");
    if (openFiles.length > 0) {
      problems.push(`the child holds descriptors beyond its own: ${openFiles.join('; ')}`);
    }
  }
  return { ok: problems.length === 0, problems, service, child, openFiles };
}
