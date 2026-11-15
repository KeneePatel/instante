import { execFile } from 'node:child_process';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { CHILD_CODE, SOURCE, copyCode, inCopy } from './code.ts';

// The copy of the children's code (docs/specs/platform.md, "documents"): what it holds, and what
// it refuses. That a child can't read past it is shown with real children in
// test/selftest.test.ts.

const folders: string[] = [];
/** A new private folder (mode 0700, from mkdtemp), by real path. */
function folder(): string {
  const made = realpathSync(mkdtempSync(path.join(tmpdir(), 'instante-code-test-')));
  folders.push(made);
  return made;
}
afterAll(() => {
  for (const made of folders) rmSync(made, { recursive: true, force: true });
});

/** Source code: `task.ts` importing `lib/helper.ts`, and a secret outside it. */
function source() {
  const root = folder();
  mkdirSync(path.join(root, 'lib'));
  writeFileSync(path.join(root, 'task.ts'), "import './lib/helper.ts';\n");
  writeFileSync(path.join(root, 'lib', 'helper.ts'), 'export {};\n');
  const secret = path.join(folder(), 'secret');
  writeFileSync(secret, 'top secret');
  return { root, secret };
}

describe('copyCode', () => {
  it('copies each file new, the owner’s alone to read, beside a package.json making them ES modules', () => {
    const { root } = source();
    const parent = folder();
    const copy = copyCode({ root, files: ['task.ts', 'lib/helper.ts'] }, parent);
    expect(path.dirname(copy)).toBe(parent);
    expect(path.basename(copy)).toMatch(/^instante-code-[A-Za-z0-9]{6}$/);
    expect(realpathSync.native(copy)).toBe(copy);
    expect(readdirSync(copy, { recursive: true }).sort()).toEqual([
      'lib',
      'lib/helper.ts',
      'package.json',
      'task.ts',
    ]);
    expect(readFileSync(path.join(copy, 'task.ts'), 'utf8')).toBe("import './lib/helper.ts';\n");
    expect(readFileSync(path.join(copy, 'package.json'), 'utf8')).toBe('{ "type": "module" }\n');
    for (const file of ['task.ts', 'lib/helper.ts', 'package.json']) {
      const stat = statSync(path.join(copy, file));
      expect(stat.mode & 0o777, file).toBe(0o400);
      expect(stat.nlink, file).toBe(1);
      expect(stat.ino, file).not.toBe(
        statSync(path.join(root, file), { throwIfNoEntry: false })?.ino,
      );
    }
    for (const made of [copy, path.join(copy, 'lib')]) {
      expect(statSync(made).mode & 0o777).toBe(0o700);
    }
  });

  it('refuses a symlink, one on the way, a folder, a FIFO and a hard link, naming each, and leaves nothing', async () => {
    const { root, secret } = source();
    symlinkSync(secret, path.join(root, 'link.ts'));
    symlinkSync(path.join(root, 'lib'), path.join(root, 'via'));
    mkdirSync(path.join(root, 'folder.ts'));
    await promisify(execFile)('mkfifo', [path.join(root, 'fifo.ts')]);
    linkSync(secret, path.join(root, 'hard.ts'));
    const parent = folder();
    expect(() =>
      copyCode(
        {
          root,
          files: ['task.ts', 'link.ts', 'via/helper.ts', 'folder.ts', 'fifo.ts', 'hard.ts'],
        },
        parent,
      ),
    ).toThrow(
      [
        "The document service won't give its children this code:",
        `${path.join(root, 'link.ts')} is reached through a symlink, to ${secret}`,
        `${path.join(root, 'via/helper.ts')} is reached through a symlink, to ${path.join(root, 'lib/helper.ts')}`,
        `${path.join(root, 'folder.ts')} isn't a regular file`,
        `${path.join(root, 'fifo.ts')} isn't a regular file`,
        `${path.join(root, 'hard.ts')} has 2 links`,
      ].join('\n'),
    );
    expect(readdirSync(parent)).toEqual([]);
  });

  it('refuses a path that leaves its root, or isn’t there', () => {
    const { root } = source();
    const parent = folder();
    expect(() =>
      copyCode({ root, files: ['../secret', '/etc/hosts', 'lib/../task.ts', 'gone.ts'] }, parent),
    ).toThrow(
      [
        "The document service won't give its children this code:",
        `../secret isn't a plain path inside ${root}`,
        `/etc/hosts isn't a plain path inside ${root}`,
        `lib/../task.ts isn't a plain path inside ${root}`,
        `${path.join(root, 'gone.ts')} isn't there`,
      ].join('\n'),
    );
    expect(readdirSync(parent)).toEqual([]);
  });

  it('copies the platform’s tasks and what they import: Node’s built-ins aside, only each other', () => {
    expect(CHILD_CODE.root).toBe(SOURCE);
    expect(SOURCE.endsWith('/apps/backend/src')).toBe(true);
    for (const file of CHILD_CODE.files) {
      const text = readFileSync(path.join(SOURCE, file), 'utf8');
      const imports = [...text.matchAll(/(?:from|import)\s+'([^']+)'/g)].map(([, name]) => name);
      for (const name of imports) {
        if (name?.startsWith('node:') === true) continue;
        expect(
          CHILD_CODE.files,
          `${file} imports ${String(name)}, which isn't copied for the children`,
        ).toContain(path.join(path.dirname(file), String(name)));
      }
    }
  });
});

describe('inCopy', () => {
  it('finds a task’s script in the copy only if the code holds it', () => {
    const code = { root: '/src', files: ['tasks/echo.ts'] };
    expect(inCopy(code, '/run/instante-code-x', '/src/tasks/echo.ts')).toBe(
      '/run/instante-code-x/tasks/echo.ts',
    );
    expect(inCopy(code, '/run/instante-code-x', '/src/tasks/other.ts')).toBeUndefined();
    expect(inCopy(code, '/run/instante-code-x', '/elsewhere/tasks/echo.ts')).toBeUndefined();
  });
});
