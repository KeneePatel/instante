// What the web app's launch lets it read (scripts/test/web-launch.test.ts): it runs in Next's
// place under scripts/prod-build/stack.sh's `web`, so with exactly the web app's flags and, on
// macOS, its sandbox profile. For each path in PROBE_PATHS, one per line, it prints a JSON line
// with the path and READ, or the error's code (ERR_ACCESS_DENIED is Node's permission model,
// EPERM the sandbox); never what it read.
import { readFileSync } from 'node:fs';

for (const path of (process.env['PROBE_PATHS'] ?? '').split('\n').filter(Boolean)) {
  let outcome = 'READ';
  try {
    readFileSync(path);
  } catch (error) {
    outcome = (error as { code?: string }).code ?? String(error);
  }
  process.stdout.write(`${JSON.stringify({ path, outcome })}\n`);
}
