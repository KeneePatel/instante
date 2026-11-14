import { writeFile } from 'node:fs/promises';

// A child that tries to write a file in its own folder, plainly and through node:sqlite (which the
// permission model doesn't cover), and reports each error's code, or 'wrote'.
const attempts = [
  async () => {
    await writeFile('plain', '');
  },
  async () => {
    const { DatabaseSync } = await import('node:sqlite');
    new DatabaseSync('sqlite.db').exec('CREATE TABLE t (x)');
  },
];
const results: unknown[] = [];
for (const attempt of attempts) {
  try {
    await attempt();
    results.push('wrote');
  } catch (error) {
    results.push((error as NodeJS.ErrnoException).code);
  }
}
process.stdout.write(JSON.stringify(results));
