import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The code the document service's children may read (docs/specs/platform.md, "documents"): read
// once at start, and written into each job's own folder, the one folder a child may read.
//
// Node's permission model checks a path after removing `name/..` as text, while the kernel
// follows every symlink along the path, wherever it is. So a grant only holds if the kernel can
// reach a path inside it in one way: the folder's last name must exist nowhere else (mkdtemp's
// random one), and the folder must hold no symlink. Then a path whose text ends inside the job's
// folder can only have gone through the real folder, and from there the kernel and the text
// move together. The checkout and the installed packages can't meet that: pnpm's links, here and
// in any other project, steer the kernel to other folders named `src` or `.pnpm`. The job's
// folder is granted as `.`, its working folder, and the script named from there, so the service
// never puts its name on the child's command line, which every local account can read (`ps`).
// A compromised child can still publish the name itself (its process title, its CPU time), so
// another local account working with it could plant a folder of that name where the kernel can
// be steered: the case threat-model.md accepts under R2, which a sandbox profile would close.

/** The children's code: each task's script and what it imports (Node's built-ins aside), as
 * paths inside `root`, a real path. */
export type Code = { root: string; files: readonly string[] };

/** The code as read at start: each file's path inside it, and its bytes. */
export type CodeFiles = ReadonlyMap<string, Buffer>;

/** The backend's source, by real path. */
export const SOURCE = realpathSync.native(fileURLToPath(new URL('../', import.meta.url)));

/** What the platform's own tasks run: their scripts, and the probes `selftest` imports. */
export const CHILD_CODE: Code = {
  root: SOURCE,
  files: ['documents/tasks/echo.ts', 'documents/tasks/selftest.ts', 'kit/probes.ts'],
};

/** The folder, inside a job's, that holds its code. */
export const CODE_FOLDER = 'code';

/** Reads `code`: only regular files with one link, reached through no symlink, each opened
 * without following one. Throws, naming each problem, on anything else. */
export function readCode(code: Code): CodeFiles {
  const files = new Map<string, Buffer>();
  const problems: string[] = [];
  for (const file of code.files) {
    const read = readOne(code.root, file);
    if (typeof read === 'string') problems.push(read);
    else files.set(file, read);
  }
  if (problems.length > 0) {
    throw new Error(
      `The document service won't give its children this code:\n${problems.join('\n')}`,
    );
  }
  return files;
}

/** One file's bytes, or why it won't be given. */
function readOne(root: string, file: string): Buffer | string {
  const source = path.join(root, file);
  if (path.isAbsolute(file) || path.normalize(file) !== file || file.startsWith('..')) {
    return `${file} isn't a plain path inside ${root}`;
  }
  let fd: number;
  try {
    // Not following a link, and not blocking on a FIFO waiting for a writer.
    fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') return `${source} is a symlink`;
    if (code === 'ENOENT') return `${source} isn't there`;
    return `${source} can't be opened as a file`;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return `${source} isn't a regular file`;
    if (stat.nlink !== 1) return `${source} has ${String(stat.nlink)} links`;
    // A link on the way would give the children another file's bytes.
    const real = realpathSync.native(source);
    if (real !== source) return `${source} is reached through a symlink, to ${real}`;
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Writes `files` into `<folder>/code/`: each file new, the owner's alone to read, beside a
 * package.json making them ES modules, since Node looks for one in the folders above a script
 * without checking its grants. */
export async function writeCode(files: CodeFiles, folder: string): Promise<void> {
  const top = path.join(folder, CODE_FOLDER);
  const write = async (file: string, bytes: Uint8Array) => {
    await mkdir(path.dirname(path.join(top, file)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(top, file), bytes, { flag: 'wx', mode: 0o400 });
  };
  for (const [file, bytes] of files) await write(file, bytes);
  await write('package.json', new TextEncoder().encode('{ "type": "module" }\n'));
}

/** A task's script as its child names it, from its job's folder, if `code` holds it. */
export function scriptIn(code: Code, script: string): string | undefined {
  const file = path.relative(code.root, script);
  return code.files.includes(file) ? path.join(CODE_FOLDER, file) : undefined;
}
