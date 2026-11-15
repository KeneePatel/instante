import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The code the document service's children may read (docs/specs/platform.md, "documents"): a
// copy, made at each start, in a folder of its own that only it names.
//
// Node's permission model checks a path after removing `name/..` as text, while the kernel
// follows every symlink along the path, wherever it is. So a grant only holds if the kernel can
// reach a path inside it in one way: the folder's last name must exist nowhere else (mkdtemp's
// random one, which no one else knows), and the folder must hold no symlink. Then a path whose
// text ends inside the copy can only have gone through the real folder, and from there the
// kernel and the text move together. The installed packages and the checkout can't meet that:
// pnpm's links, here and in any other project, steer the kernel to other folders named `src` or
// `.pnpm`.

/** The children's code: each task's script and what it imports (Node's built-ins aside), as
 * paths inside `root`, a real path. */
export type Code = { root: string; files: readonly string[] };

/** The backend's source, by real path. */
export const SOURCE = realpathSync.native(fileURLToPath(new URL('../', import.meta.url)));

/** What the platform's own tasks run: their scripts, and the probes `selftest` imports. */
export const CHILD_CODE: Code = {
  root: SOURCE,
  files: ['documents/tasks/echo.ts', 'documents/tasks/selftest.ts', 'kit/probes.ts'],
};

/** Copies `code` into a new folder under `parent` (a real path the owner alone can enter): each
 * file new, the owner's alone to read, beside a package.json that makes them ES modules, since
 * Node looks for one in the folders above a script without checking its grants. Only regular
 * files with one link are copied, read without following a link. Throws, leaving nothing behind,
 * on anything else. Returns the copy's real path. */
export function copyCode(code: Code, parent: string): string {
  const copy = mkdtempSync(path.join(parent, 'instante-code-'));
  try {
    const problems = code.files.flatMap((file) => copyFile(code.root, file, copy));
    if (problems.length > 0) {
      throw new Error(
        `The document service won't give its children this code:\n${problems.join('\n')}`,
      );
    }
    writeFileSync(path.join(copy, 'package.json'), '{ "type": "module" }\n', {
      flag: 'wx',
      mode: 0o400,
    });
    return copy;
  } catch (error) {
    rmSync(copy, { recursive: true, force: true });
    throw error;
  }
}

/** Copies one file, or says why it won't. */
function copyFile(root: string, file: string, copy: string): string[] {
  const source = path.join(root, file);
  if (path.isAbsolute(file) || path.normalize(file) !== file || file.startsWith('..')) {
    return [`${file} isn't a plain path inside ${root}`];
  }
  let real: string;
  try {
    real = realpathSync.native(source);
  } catch {
    return [`${source} isn't there`];
  }
  // A link on the way would make the copy hold another file's bytes.
  if (real !== source) return [`${source} is reached through a symlink, to ${real}`];
  let fd: number;
  try {
    // Non-blocking, so a FIFO doesn't hang the start waiting for a writer.
    fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return [`${source} can't be opened as a file`];
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return [`${source} isn't a regular file`];
    if (stat.nlink !== 1) return [`${source} has ${String(stat.nlink)} links`];
    mkdirSync(path.dirname(path.join(copy, file)), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(copy, file), readFileSync(fd), { flag: 'wx', mode: 0o400 });
    return [];
  } finally {
    closeSync(fd);
  }
}

/** Where a task's script is in the copy, if `code` holds it. */
export function inCopy(code: Code, copy: string, script: string): string | undefined {
  const file = path.relative(code.root, script);
  return code.files.includes(file) ? path.join(copy, file) : undefined;
}
