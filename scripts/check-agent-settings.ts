// Committed Claude Code settings can't loosen what keeps agents out of ~/.instante
// (ADR-012, residual risk R9): no `sandbox` key, no `allowRead`, and no rule naming
// ~/.instante except a deny. The sandbox, if the owner turns it on, lives in the owner's
// user settings, which a repository can't change.
//
//   node scripts/check-agent-settings.ts
//
// Exit codes: 0 clean, 1 a setting breaks the rule, 2 the check could not run.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function bail(message: string): never {
  console.error(`check-agent-settings: ${message}`);
  process.exit(2);
}

let listed: string;
try {
  listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
  });
} catch {
  bail('could not list the repository files');
}
const files = listed.split('\n').filter((f) => /(^|\/)\.claude\/[^/]+\.json$/.test(f));

const problems: string[] = [];

function walk(value: unknown, path: string[], file: string): void {
  if (typeof value === 'string') {
    const inDeny = path[0] === 'permissions' && path[1] === 'deny';
    if (value.includes('.instante') && !inDeny) {
      problems.push(`${file}: ${path.join('.')} names ~/.instante outside permissions.deny`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item: unknown, i) => {
      walk(item, [...path, String(i)], file);
    });
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'sandbox') problems.push(`${file}: has a sandbox setting`);
      if (key === 'allowRead') problems.push(`${file}: has an allowRead setting`);
      walk(item, [...path, key], file);
    }
  }
}

for (const file of files) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    problems.push(`${file}: isn't valid JSON`);
    continue;
  }
  walk(parsed, [], file);
}

if (problems.length === 0) {
  console.log(`check-agent-settings: clean (${String(files.length)} file(s))`);
  process.exit(0);
}
console.error(`check-agent-settings: ${String(problems.length)} problem(s):`);
for (const p of problems) console.error(`  ${p}`);
process.exit(1);
