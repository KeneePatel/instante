import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// The lint rules the platform spec names, tried on code they must refuse and code they must
// let through, with the untyped config `check:fast` uses (the typed one adds to it).

const root = fileURLToPath(new URL('../../', import.meta.url));
const eslint = new ESLint({ cwd: root, overrideConfigFile: 'eslint.fast.config.mjs' });

const RULES = ['no-restricted-imports', 'no-restricted-syntax'];
/** A file at the document service's top, and one in the folder its children's scripts are in. */
const DOCUMENTS = [
  'apps/backend/src/documents/probe.ts',
  'apps/backend/src/documents/tasks/probe.ts',
];

/** Which of the two restricting rules fire on `code` placed at `file`, each once. */
async function fired(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: file });
  const ids = result?.messages.map((m) => m.ruleId ?? `fatal: ${m.message}`) ?? ['no result'];
  return [...new Set(ids.filter((id) => RULES.includes(id) || id.startsWith('fatal')))];
}

/** Expects `rule`, alone, to refuse each piece of code, wherever it sits in the service. */
async function refusedBy(rule: string, codes: readonly string[]): Promise<void> {
  for (const file of DOCUMENTS) {
    for (const code of codes) expect(await fired(code, file), `${file}: ${code}`).toEqual([rule]);
  }
}

describe('the document service never uses exec, a shell or fork', () => {
  it('refuses every other import from child_process, and node:module and node:cluster', async () => {
    await refusedBy('no-restricted-imports', [
      "import { exec } from 'node:child_process';",
      "import { execSync, spawnSync } from 'child_process';",
      "import { fork } from 'node:child_process';",
      "import { execFileSync } from 'node:child_process';",
      "import * as cp from 'node:child_process';",
      "import cp from 'node:child_process';",
      "export { fork } from 'node:child_process';",
      "import { createRequire } from 'node:module';",
      "import { createRequire } from 'module';",
      "import cluster from 'node:cluster';",
      "import { fork } from 'cluster';",
    ]);
  });

  it('refuses a shell set as an option, a member or a name, however the value is given', async () => {
    await refusedBy('no-restricted-syntax', [
      "import { spawn } from 'node:child_process';\nspawn('lsof', [], { shell: true });",
      "import { execFile } from 'node:child_process';\nconst sh = '/bin/sh';\nexecFile('lsof', [], { shell: sh });",
      "import { spawn } from 'node:child_process';\nspawn('lsof', [], { shell: '/bin/sh' });",
      "import { spawn } from 'node:child_process';\nspawn('lsof', [], { 'shell': true });",
      'const options = {};\noptions.shell = true;',
      "const options = {};\noptions['shell'] = '/bin/sh';",
      "const options = {};\nReflect.set(options, 'shell', true);",
      'const options = { [`shell`]: true };\nvoid options;',
      "const options = Object.fromEntries([['shell', true]]);\nvoid options;",
    ]);
  });

  it('refuses a shell started as the program, by its path or its name', async () => {
    await refusedBy('no-restricted-syntax', [
      "import { spawn } from 'node:child_process';\nspawn('/bin/sh', ['-c', 'ls'], { shell: false });",
      "import { execFile } from 'node:child_process';\nexecFile('bash', ['-c', 'ls']);",
      "import { spawn } from 'node:child_process';\nspawn('/usr/bin/env', ['sh', '-c', 'ls']);",
      "import { spawn } from 'node:child_process';\nspawn('/opt/homebrew/bin/fish', ['-c', 'ls']);",
    ]);
  });

  it('refuses a dynamic import of child_process, or of any name built at run time, and a built-in loaded by name', async () => {
    await refusedBy('no-restricted-syntax', [
      "await import('node:child_process');",
      "await import('child_process');",
      "await import('node:module');",
      "await import('module');",
      "await import('node:cluster');",
      "await import('cluster');",
      'await import(`node:child_process`);',
      "const name = 'node:child_process';\nawait import(name);",
      "process.getBuiltinModule('node:child_process');",
      "process['getBuiltinModule']('node:child_process');",
      'process[`getBuiltinModule`](`node:child_process`);',
      "const { getBuiltinModule } = process;\ngetBuiltinModule('node:child_process');",
      "const load = Reflect.get(process, 'getBuiltinModule');\nvoid load;",
      "process.binding('spawn_sync');",
      "process._linkedBinding('spawn_sync');",
    ]);
  });

  it('lets through spawn and execFile without a shell', async () => {
    for (const file of DOCUMENTS) {
      expect(
        await fired(
          "import { execFile, spawn } from 'node:child_process';\nspawn(process.execPath, ['task.ts'], { shell: false });\nspawn('/usr/sbin/lsof', [], { 'shell': false });\nexecFile('/usr/sbin/lsof', []);\nawait import('./run-child.ts');",
          file,
        ),
      ).toEqual([]);
    }
  });

  it('holds in the document service only, beside its layer rule', async () => {
    const kit = 'apps/backend/src/kit/probe.ts';
    expect(await fired("import { exec } from 'node:child_process';\nexec('ls');", kit)).toEqual([]);
    expect(
      await fired(
        "import { spawn } from 'node:child_process';\nspawn('ls', [], { shell: true });\nawait import(`node:${'fs'}`);",
        kit,
      ),
    ).toEqual([]);
    for (const file of DOCUMENTS) {
      expect(await fired("import { pool } from '../store/pool.ts';\nvoid pool;", file)).toEqual([
        'no-restricted-imports',
      ]);
    }
  });
});
