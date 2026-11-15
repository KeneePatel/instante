import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// The lint rules the platform spec names, tried on code they must refuse and code they must
// let through, with the untyped config `check:fast` uses (the typed one adds to it).

const root = fileURLToPath(new URL('../../', import.meta.url));
const eslint = new ESLint({ cwd: root, overrideConfigFile: 'eslint.fast.config.mjs' });

const RULES = ['no-restricted-imports', 'no-restricted-syntax'];

/** Which of the two restricting rules fire on `code` placed at `file`, each once. */
async function fired(
  code: string,
  file = 'apps/backend/src/documents/probe.ts',
): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: file });
  const ids = result?.messages.map((m) => m.ruleId ?? `fatal: ${m.message}`) ?? ['no result'];
  return [...new Set(ids.filter((id) => RULES.includes(id) || id.startsWith('fatal')))];
}

describe('the document service never uses exec, a shell or fork', () => {
  it('refuses every other import from child_process, however it is written', async () => {
    for (const code of [
      "import { exec } from 'node:child_process';",
      "import { execSync, spawnSync } from 'child_process';",
      "import { fork } from 'node:child_process';",
      "import { execFileSync } from 'node:child_process';",
      "import * as cp from 'node:child_process';",
      "import cp from 'node:child_process';",
      "export { fork } from 'node:child_process';",
    ]) {
      expect(await fired(code), code).toEqual(['no-restricted-imports']);
    }
  });

  it('refuses a shell, a dynamic import, or a shell named by a variable', async () => {
    for (const code of [
      "import { spawn } from 'node:child_process';\nspawn('lsof', [], { shell: true });",
      "import { execFile } from 'node:child_process';\nconst sh = '/bin/sh';\nexecFile('lsof', [], { shell: sh });",
      "import { spawn } from 'node:child_process';\nspawn('lsof', [], { 'shell': true });",
      "await import('node:child_process');",
    ]) {
      expect(await fired(code), code).toEqual(['no-restricted-syntax']);
    }
  });

  it('lets through spawn and execFile without a shell', async () => {
    expect(
      await fired(
        "import { execFile, spawn } from 'node:child_process';\nspawn('/usr/sbin/lsof', [], { shell: false });\nexecFile('/usr/sbin/lsof', []);",
      ),
    ).toEqual([]);
  });

  it('holds in the document service only, beside its layer rule', async () => {
    const exec = "import { exec } from 'node:child_process';\nexec('ls');";
    expect(await fired(exec, 'apps/backend/src/kit/probe.ts')).toEqual([]);
    expect(await fired("import { pool } from '../store/pool.ts';\nvoid pool;")).toEqual([
      'no-restricted-imports',
    ]);
  });
});
