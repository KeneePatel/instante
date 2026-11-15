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
import { CHILD_CODE, SOURCE, readCode, scriptIn, writeCode } from './code.ts';
import { checkJobFolder } from './guards.ts';

// The children's code (docs/specs/platform.md, "documents"): what's read at start, what it
// refuses, and what's written into each job's folder. That a child can't read past it is shown
// with real children in test/selftest.test.ts.

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

describe('readCode', () => {
  it('reads each file', () => {
    const { root } = source();
    expect(readCode({ root, files: ['task.ts', 'lib/helper.ts'] })).toEqual(
      new Map([
        ['task.ts', Buffer.from("import './lib/helper.ts';\n")],
        ['lib/helper.ts', Buffer.from('export {};\n')],
      ]),
    );
  });

  it('refuses a symlink, one on the way, a folder, a FIFO and a hard link, naming each', async () => {
    const { root, secret } = source();
    symlinkSync(secret, path.join(root, 'link.ts'));
    symlinkSync(path.join(root, 'lib'), path.join(root, 'via'));
    mkdirSync(path.join(root, 'folder.ts'));
    await promisify(execFile)('mkfifo', [path.join(root, 'fifo.ts')]);
    linkSync(secret, path.join(root, 'hard.ts'));
    expect(() =>
      readCode({
        root,
        files: ['task.ts', 'link.ts', 'via/helper.ts', 'folder.ts', 'fifo.ts', 'hard.ts'],
      }),
    ).toThrow(
      [
        "The document service won't give its children this code:",
        `${path.join(root, 'link.ts')} is a symlink`,
        `${path.join(root, 'via/helper.ts')} is reached through a symlink, to ${path.join(root, 'lib/helper.ts')}`,
        `${path.join(root, 'folder.ts')} isn't a regular file`,
        `${path.join(root, 'fifo.ts')} isn't a regular file`,
        `${path.join(root, 'hard.ts')} has 2 links`,
      ].join('\n'),
    );
  });

  it('refuses a path that leaves its root, or isn’t there', () => {
    const { root } = source();
    expect(() =>
      readCode({ root, files: ['../secret', '/etc/hosts', 'lib/../task.ts', 'gone.ts'] }),
    ).toThrow(
      [
        "The document service won't give its children this code:",
        `../secret isn't a plain path inside ${root}`,
        `/etc/hosts isn't a plain path inside ${root}`,
        `lib/../task.ts isn't a plain path inside ${root}`,
        `${path.join(root, 'gone.ts')} isn't there`,
      ].join('\n'),
    );
  });

  it('reads the platform’s tasks and what they import: Node’s built-ins aside, only each other', () => {
    expect(CHILD_CODE.root).toBe(SOURCE);
    expect(SOURCE.endsWith('/apps/backend/src')).toBe(true);
    expect([...readCode(CHILD_CODE).keys()]).toEqual(CHILD_CODE.files);
    for (const file of CHILD_CODE.files) {
      const text = readFileSync(path.join(SOURCE, file), 'utf8');
      const imports = [...text.matchAll(/(?:from|import)\s+'([^']+)'/g)].map(([, name]) => name);
      for (const name of imports) {
        if (name?.startsWith('node:') === true) continue;
        expect(
          CHILD_CODE.files,
          `${file} imports ${String(name)}, which isn't given to the children`,
        ).toContain(path.join(path.dirname(file), String(name)));
      }
    }
  });
});

describe('writeCode', () => {
  it('writes each file new into the job’s code folder, the owner’s alone to read, beside a package.json', async () => {
    const { root } = source();
    const job = folder();
    writeFileSync(path.join(job, 'input'), 'a document', { mode: 0o600 });
    await writeCode(readCode({ root, files: ['task.ts', 'lib/helper.ts'] }), job);
    expect(readdirSync(job, { recursive: true }).sort()).toEqual([
      'code',
      'code/lib',
      'code/lib/helper.ts',
      'code/package.json',
      'code/task.ts',
      'input',
    ]);
    expect(readFileSync(path.join(job, 'code/task.ts'), 'utf8')).toBe(
      "import './lib/helper.ts';\n",
    );
    // Node looks for a package.json above a script without checking its grants; this one stops
    // it inside the job's folder.
    expect(readFileSync(path.join(job, 'code/package.json'), 'utf8')).toBe(
      '{ "type": "module" }\n',
    );
    for (const file of ['code/task.ts', 'code/lib/helper.ts', 'code/package.json']) {
      const stat = statSync(path.join(job, file));
      expect(stat.mode & 0o777, file).toBe(0o400);
      expect(stat.nlink, file).toBe(1);
    }
    for (const made of ['code', 'code/lib']) {
      expect(statSync(path.join(job, made)).mode & 0o777, made).toBe(0o700);
    }
    expect(checkJobFolder(job)).toEqual([]);
  });

  it('writes nothing over what’s there', async () => {
    const { root } = source();
    const job = folder();
    mkdirSync(path.join(job, 'code'));
    writeFileSync(path.join(job, 'code', 'task.ts'), 'planted');
    await expect(writeCode(readCode({ root, files: ['task.ts'] }), job)).rejects.toMatchObject({
      code: 'EEXIST',
    });
  });
});

describe('scriptIn', () => {
  it('names a task’s script from its job’s folder, only if the code holds it', () => {
    const code = { root: '/src', files: ['tasks/echo.ts'] };
    expect(scriptIn(code, '/src/tasks/echo.ts')).toBe('code/tasks/echo.ts');
    expect(scriptIn(code, '/src/tasks/other.ts')).toBeUndefined();
    expect(scriptIn(code, '/elsewhere/tasks/echo.ts')).toBeUndefined();
  });
});
