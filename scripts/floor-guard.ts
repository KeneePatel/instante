// Floor guard: diff-scoped checks for the floor in CONSTRAINTS.md, adapted from the
// constraint-driven-development skill's reference (references/floor-guard.md).
//
//   node scripts/floor-guard.ts [--base <ref>]      default base: origin/main
//
// It reads the diff from the merge base to the working tree, untracked files included.
// Exit codes: 0 clean, 1 at least one floor violation, 2 the guard could not run.
// It reports the rule, the file and the line, and only ever flags moves that lower the bar.
//
// CONSTRAINTS.md allows a test deleted with a reason in the commit message. A commit since the
// merge base whose message holds the line `Tests removed from <file>: <reason>` (ten characters
// or more of reason) vouches for what that same commit removes from that file: the tests it
// deletes and the assertions it takes out, and nothing else. The guard prints the reason for the
// review. A removal not yet committed has no message, so it's always flagged.
//
// The patterns spell their own keywords with a character class (for example "TOD[O]"),
// so this file never matches itself.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

interface Line {
  file: string;
  text: string;
  /** The file's name before a rename in the same diff, if it was renamed. */
  from?: string;
}
interface Finding {
  rule: string;
  file: string;
  text: string;
}

function git(args: string[], allowDiffExit = false): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // `git diff --no-index` exits 1 whenever the sides differ, the normal case for a new file.
    const failed = error as { status?: number; stdout?: unknown };
    if (allowDiffExit && failed.status === 1 && typeof failed.stdout === 'string') {
      return failed.stdout;
    }
    return null;
  }
}

function bail(message: string): never {
  console.error(`floor-guard: ${message}`);
  process.exit(2);
}

const baseFlag = process.argv.indexOf('--base');
const base = baseFlag === -1 ? 'origin/main' : process.argv[baseFlag + 1];
if (base === undefined || base === '') bail('--base needs a ref');

const top = git(['rev-parse', '--show-toplevel'])?.trim();
if (top === undefined || top === '') bail('not inside a git work tree');
process.chdir(top);

const mergeBase = git(['merge-base', base, 'HEAD'])?.trim();
if (mergeBase === undefined || mergeBase === '') bail(`no merge base against ${base}`);

const tracked = git(['diff', '--unified=0', mergeBase, '--']);
if (tracked === null) bail(`could not diff against ${mergeBase}`);
const untrackedList = git(['ls-files', '--others', '--exclude-standard']);
if (untrackedList === null) bail('could not list untracked files');
const untracked = untrackedList
  .split('\n')
  .filter(Boolean)
  .map((file) => {
    const diff = git(['diff', '--no-index', '--unified=0', '/dev/null', file], true);
    if (diff === null) bail(`could not diff untracked file ${file}`);
    return diff;
  })
  .join('\n');

// Walk a diff. `---` and `+++` are headers only between a file's `diff` line and its first
// hunk; inside a hunk every line is content. A deleted file keeps its old name; a renamed one's
// lines carry its new name, and its old one in `from`.
interface Diff {
  added: Line[];
  removed: Line[];
  deleted: string[];
  newFiles: string[];
}
function walk(text: string): Diff {
  const diff: Diff = { added: [], removed: [], deleted: [], newFiles: [] };
  const pathOf = (s: string): string => s.replace(/^[ab]\//, '');
  // An empty new file has no ---/+++ lines, only `diff --git a/P b/P` and `new file mode`.
  const samePath = (s: string): string => {
    const rest = s.slice('diff --git '.length);
    const p = rest.slice(2, 2 + (rest.length - 5) / 2);
    return rest === `a/${p} b/${p}` ? p : '';
  };
  const addNew = (f: string): void => {
    if (f !== '' && !diff.newFiles.includes(f)) diff.newFiles.push(f);
  };
  let file = '';
  let oldFile = '';
  let headerPath = '';
  let inHeader = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff ')) {
      inHeader = true;
      headerPath = samePath(line);
    } else if (line.startsWith('@@')) {
      inHeader = false;
    } else if (inHeader) {
      // A file renamed or copied into place is new where it lands, though an exact rename has
      // no ---/+++ lines and no content.
      if (line.startsWith('new file mode')) addNew(headerPath);
      else if (line.startsWith('rename to ')) addNew(line.slice('rename to '.length));
      else if (line.startsWith('copy to ')) addNew(line.slice('copy to '.length));
      else if (line.startsWith('--- ')) oldFile = pathOf(line.slice(4));
      else if (line.startsWith('+++ ')) {
        const newFile = pathOf(line.slice(4));
        file = newFile === '/dev/null' ? oldFile : newFile;
        if (newFile === '/dev/null') diff.deleted.push(file);
        if (oldFile === '/dev/null') addNew(file);
      }
    } else if (line.startsWith('+')) {
      diff.added.push({ file, text: line.slice(1) });
    } else if (line.startsWith('-')) {
      const from = oldFile !== file && oldFile !== '/dev/null' ? { from: oldFile } : {};
      diff.removed.push({ file, text: line.slice(1), ...from });
    }
  }
  return diff;
}
const { added, removed, deleted, newFiles } = walk(`${tracked}\n${untracked}`);

// The checks' pins (rule 10): their data, and the test that reads it.
const PINS = 'scripts/test/scanner-pins.test.ts';
const PINS_DATA = 'scripts/test/scanner-pins.json';

// Lines a diff adds and removes in one file, less those it only moves (the same text taken out
// and put back), blank ones aside: `${'+' or '-'}${text}`, counted.
const lineKey = (f: string, text: string): string => `${f}\n${text.trim()}`;
function unmoved(d: Diff, f: string): Map<string, number> {
  const out = new Map<string, number>();
  const bump = (k: string, by: number): void => {
    out.set(k, (out.get(k) ?? 0) + by);
  };
  for (const l of d.added) if (l.file === f && l.text.trim() !== '') bump(`+${l.text.trim()}`, 1);
  for (const l of d.removed) {
    if ((l.file !== f && l.from !== f) || l.text.trim() === '') continue;
    const back = `+${l.text.trim()}`;
    if ((out.get(back) ?? 0) > 0) bump(back, -1);
    else bump(`-${l.text.trim()}`, 1);
  }
  return out;
}

// The pins' data as JSON, null when the file isn't there; text that isn't JSON pins nothing.
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
function pinData(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return 'not JSON';
  }
}
// Each pinned value `base` holds that `now` changes or drops, as `<path>: <value now>`. A key
// added is a pin added, so it isn't listed; a list or a value is one pin, compared whole.
function loosenedPins(base: unknown, now: unknown, at: string[] = []): string[] {
  if (isRecord(base)) {
    const here = isRecord(now) ? now : {};
    return Object.keys(base).flatMap((k) => loosenedPins(base[k], here[k], [...at, k]));
  }
  const is = now === undefined ? 'nothing' : JSON.stringify(now);
  return JSON.stringify(base) === is ? [] : [`${at.join(' › ')}: ${is}`];
}

// What the branch's own commits changed with a reason.
//   - `Tests removed from <file>: <reason>` vouches for the test files the commit deletes and
//     the assertion lines it removes in that file (by its name before or after a rename in that
//     commit), once for each line it removed and didn't put back.
//   - `Pins changed: <reason>` vouches for each line the commit adds or removes in the pins'
//     test, and each pinned value it changes or removes, as the commit leaves it.
const commits = git(['rev-list', '--no-merges', `${mergeBase}..HEAD`]);
if (commits === null) bail(`could not list the commits since ${mergeBase}`);
const reasons = new Map<string, string>();
const vouchedDeletes = new Set<string>();
const vouchedLines = new Map<string, number>();
const vouchedPinLines = new Map<string, number>();
const vouchedPinValues = new Set<string>();
for (const commit of commits.split('\n').filter(Boolean)) {
  const message = git(['log', '-1', '--format=%B', commit]);
  if (message === null) bail(`could not read commit ${commit}`);
  const named = [...message.matchAll(/^Tests removed from (\S+): (\S.{9,})$/gm)];
  const pinsWhy = /^Pins changed: (\S.{9,})$/m.exec(message)?.[1];
  if (named.length === 0 && pinsWhy === undefined) continue;
  const shown = git(['show', '-M', '--unified=0', '--format=', commit]);
  if (shown === null) bail(`could not read what ${commit} changed`);
  const changes = walk(shown);
  for (const [, where, why] of named) {
    if (where === undefined || why === undefined) continue;
    reasons.set(where, why.trim());
    if (changes.deleted.includes(where)) vouchedDeletes.add(where);
    const putBack = new Map<string, number>();
    for (const l of changes.added) {
      putBack.set(lineKey(l.file, l.text), (putBack.get(lineKey(l.file, l.text)) ?? 0) + 1);
    }
    for (const line of changes.removed) {
      if (line.file !== where && line.from !== where) continue;
      const key = lineKey(line.file, line.text);
      const back = putBack.get(lineKey(line.file, line.text)) ?? 0;
      if (back > 0) {
        putBack.set(key, back - 1);
        continue;
      }
      vouchedLines.set(key, (vouchedLines.get(key) ?? 0) + 1);
      if (line.file !== where) reasons.set(line.file, why.trim());
    }
  }
  if (pinsWhy !== undefined) {
    reasons.set(PINS, pinsWhy.trim());
    for (const [k, n] of unmoved(changes, PINS)) {
      if (n > 0) vouchedPinLines.set(k, (vouchedPinLines.get(k) ?? 0) + n);
    }
    const before = pinData(git(['show', `${commit}^:${PINS_DATA}`]));
    const after = pinData(git(['show', `${commit}:${PINS_DATA}`]));
    for (const v of loosenedPins(before ?? {}, after)) vouchedPinValues.add(v);
  }
}

const findings: Finding[] = [];
const flag = (rule: string, where: string, text: string): void => {
  findings.push({ rule, file: where, text: text.trim().slice(0, 120) });
};

// A shell script under scripts/ is one by its first line, whatever its extension, as
// scripts/ci/shellcheck.sh picks them: the launcher in scripts/local/ will have none.
const startsAsShell = (f: string): boolean => {
  if (!f.startsWith('scripts/') || !existsSync(f)) return false;
  const first = readFileSync(f, 'utf8').slice(0, 200).split('\n', 1)[0] ?? '';
  return /^#!.*\b(ba)?sh\b/.test(first);
};
const isCode = (f: string): boolean =>
  /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|sh|bash|ya?ml|css)$/.test(f) || startsAsShell(f);
const isTest = (f: string): boolean => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f);
const isConstraints = (f: string): boolean => f === 'CONSTRAINTS.md';

// 1. A silenced checker: suppression comments and ESLint inline configuration.
const SUPPRESSIONS: RegExp[] = [
  /@ts-ignor[e]/,
  /@ts-nochec[k]/,
  /@ts-expect-erro[r]\s*(\*\/)?\s*$/, // without a reason after it
  /eslint-disabl[e]/,
  /eslint-enabl[e]/,
  /\/\*\s*(eslin[t]|global[s]?|exporte[d])\s/,
  /(istanbul|c8|v8) ignor[e]/,
  // Semgrep's ignore comment, short or long, which it reads in any case.
  /\bnose[m](gre[p])?\b/i,
  /gitleaks:allo[w]/,
  // ShellCheck's directive key, wherever it stands among the directive's keys.
  /\bshellchec[k]\b.*\bdisabl[e]\s*=/,
];
// 2. Unfinished work.
const STUBS: RegExp[] = [
  /throw new [\w.]*\(.*not implemente[d]/i,
  /catc[h]\s*(\([^)]*\))?\s*\{\s*\}/,
  /\bTOD[O]\b/,
];
// 3. A test made easier.
const SKIPS: RegExp[] = [
  /\.(ski[p]|onl[y]|tod[o]|skipI[f]|runI[f])\(/,
  /\b(xi[t]|xdescrib[e]|xtes[t])\(/,
  // Playwright's: a test marked to be fixed, or expected to fail, on test or on its TestInfo (not
  // pg-boss's boss.fail()).
  /\b(test(\.describe)?|testInfo|test\.info\(\))\.(fixm[e]|fai[l])\(/,
  // A run that finds no test file passes: Vitest's spelling and Playwright's.
  /passWithNoTest[s]|pass-with-no-test[s]/,
];
// A failure retried until it passes, in a test file or a runner's config: any count but a plain 0.
const RETRIES = /\bretr(y|ie[s])\s*:(?!\s*0\b)/;
const isRunnerConfig = (f: string): boolean =>
  /(^|\/)(vitest|playwright)\.config\.[cm]?ts$/.test(f);

// 4. The web app's bans (ADR-005), and the auth rule (ADR-004).
const WEB_BANS: RegExp[] = [
  /['"]use serve[r]['"]/,
  /['"]use cach[e]['"]/,
  /force-cach[e]/,
  /dangerouslySetInnerHTM[L]/,
  /rehype-ra[w]/,
];
const TOKEN_PROVIDER = 'apps/web/lib/auth/token-provider.ts';
const BACKEND_COOKIE: RegExp[] = [
  /getCooki[e]\(/,
  /hono\/cooki[e]/,
  /\.get\(\s*['"]cooki[e]['"]/i,
  /header\(\s*['"]cooki[e]['"]/i,
];

// 5. Models: only these ids, in application code and configuration (ADR-010).
const ALLOWED_MODELS = new Set(['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-sonnet-5']);
const REFUSED_MODEL_FIXTURE = 'apps/backend/test/fixtures/refused-model.ts';
const inModelScope = (f: string): boolean =>
  /^(apps|packages)\/[^/]+\/src\//.test(f) ||
  /(^|\/)[^/]*\.config\.(ts|mts|js|mjs|cjs)$/.test(f) ||
  /(^|\/)\.env\.example$/.test(f);

for (const { file: f, text } of added) {
  if (isCode(f)) {
    for (const p of SUPPRESSIONS) if (p.test(text)) flag('silenced-checker', f, text);
    for (const p of STUBS) if (p.test(text)) flag('unfinished-work', f, text);
    for (const p of SKIPS) if (p.test(text)) flag('test-made-easier', f, text);
    if ((isTest(f) || isRunnerConfig(f)) && RETRIES.test(text)) flag('test-made-easier', f, text);
  } else if (
    /(^|\/)package\.json$/.test(f) &&
    /passWithNoTest[s]|pass-with-no-test[s]/.test(text)
  ) {
    flag('test-made-easier', f, text);
  }
  if (f.startsWith('apps/web/') && isCode(f)) {
    for (const p of WEB_BANS) if (p.test(text)) flag('web-app-ban', f, text);
    if (/\bgetSessio[n]\(/.test(text) && f !== TOKEN_PROVIDER) {
      flag('get-session-outside-token-provider', f, text);
    }
  }
  if (f.startsWith('apps/backend/src/')) {
    for (const p of BACKEND_COOKIE) if (p.test(text)) flag('backend-reads-cookie', f, text);
  }
  if (inModelScope(f) && f !== REFUSED_MODEL_FIXTURE) {
    for (const id of text.match(/claude-[a-z0-9][a-z0-9.-]*/g) ?? []) {
      if (!ALLOWED_MODELS.has(id)) flag('model-not-allowed', f, text);
    }
  }
}

for (const f of newFiles) {
  if (/^apps\/web\/app\/(.+\/)?route\.(ts|js)$/.test(f)) flag('web-app-ban', f, 'a Route Handler');
}
for (const f of ['apps/web/next.config.ts', 'apps/web/next.config.mjs']) {
  const config = existsSync(f) ? readFileSync(f, 'utf8') : '';
  if (/cacheComponents:\s*true/.test(config) && /partialPrefetching:\s*false/.test(config)) {
    flag('web-app-ban', f, 'partialPrefetching off while cacheComponents is on');
  }
}

// 6. Tests deleted, or assertions removed from a test that stays (moved lines don't count),
// unless the commit that removed them says why.
const reasoned = new Set<string>();
for (const f of deleted) {
  if (!isTest(f)) continue;
  if (vouchedDeletes.has(f)) reasoned.add(f);
  else flag('test-deleted', f, 'file deleted');
}
// The checks' pins (rule 10) count every line, so they're left to that rule.
for (const { file: f, text } of removed) {
  if (f === PINS || !isTest(f) || deleted.includes(f) || !/\b(expect|assert)\b/.test(text)) {
    continue;
  }
  const moved = added.some((a) => a.file === f && a.text.trim() === text.trim());
  if (moved) continue;
  const left = vouchedLines.get(lineKey(f, text)) ?? 0;
  if (left > 0) {
    vouchedLines.set(lineKey(f, text), left - 1);
    reasoned.add(f);
  } else flag('assertion-removed', f, text);
}

// 7. The bar weakened in its configuration.
const STRICT_FLAG =
  /"(strict|noUncheckedIndexedAccess|exactOptionalPropertyTypes|verbatimModuleSyntax)"\s*:\s*(true|false)/;
for (const { file: f, text } of removed) {
  const m = STRICT_FLAG.exec(text);
  if (!m || !/(^|\/)tsconfig[^/]*\.json$/.test(f) || m[2] !== 'true') continue;
  const kept = added.some(
    (a) => a.file === f && a.text.includes(`"${m[1] ?? ''}"`) && a.text.includes('true'),
  );
  if (!kept) flag('strictness-loosened', f, text);
}
for (const { file: f, text } of added) {
  const m = STRICT_FLAG.exec(text);
  if (m && /(^|\/)tsconfig[^/]*\.json$/.test(f) && m[2] === 'false')
    flag('strictness-loosened', f, text);
  if (
    /^eslint[^/]*\.config\.mjs$/.test(f) &&
    /['"](off|warn)['"]|:\s*\[?\s*[01]\s*[,\]]/.test(text)
  ) {
    flag('lint-weakened', f, text);
  }
  if (f === 'vitest.config.ts' && /\bexclude\b/.test(text)) flag('coverage-scope-changed', f, text);
}
const COVERAGE_SCOPE = ['apps/backend/src/**', 'packages/contract/src/**', 'apps/web/lib/**'];
for (const { file: f, text } of removed) {
  if (f !== 'vitest.config.ts') continue;
  for (const glob of COVERAGE_SCOPE) {
    if (text.includes(glob) && !added.some((a) => a.file === f && a.text.includes(glob))) {
      flag('coverage-scope-changed', f, text);
    }
  }
}
const failUnder = (t: string): number | undefined => {
  const n = /--fail-under[= ](\d+)/.exec(t)?.[1];
  return n === undefined ? undefined : Number(n);
};
for (const { file: f, text } of removed) {
  const was = failUnder(text);
  if (was === undefined) continue;
  const now = added
    .filter((a) => a.file === f)
    .map((a) => failUnder(a.text))
    .find((n) => n !== undefined);
  if (now === undefined || now < was) flag('coverage-threshold-loosened', f, text);
}

// 8. CONSTRAINTS.md: a rule removed, a threshold loosened, a new exception row.
// A rule is a floor bullet (keyed by its text before the first colon) or a table row
// (keyed by its first cell). Numbers carry a direction from the words around them.
const ruleKey = (t: string): string | null => {
  const s = t.trim();
  if (s.startsWith('|'))
    return (
      s
        .split('|')
        .map((c) => c.trim())
        .find(Boolean) ?? ''
    );
  if (/^[-*] /.test(s)) return s.slice(2).split(':')[0]?.trim() ?? '';
  return null;
};
const isExceptionRow = (t: string): boolean => /^\|\s*[A-Z]{1,3}\d+\s*\|/.test(t.trim());
const MIN_BEFORE = /(>=|>|≥|at least|minimum|\bmin\b|no less than|not fall|not drop)\s*$/;
const MAX_BEFORE =
  /(<=|<|≤|at most|maximum|\bmax\b|no more than|under|below|not grow|not exceed)\s*$/;
const MIN_AFTER = /^\s*\S*\s*(or more|or higher|must not fall|must not drop)/;
const MAX_AFTER = /^\s*\S*\s*(or less|or lower|must not grow|must not exceed)/;
// After "fails on" (or "fail", "failing"), in the same clause, a number is where failing
// starts, so its direction turns round: "fails on a score of 7.0 or more" is a ceiling.
const FAILS_BEFORE = /\bfails? (on|at|from|above|over|below|under)\b[^.;:|()]*$/;
type Direction = 'min' | 'max' | null;
const thresholds = (t: string): { n: number; dir: Direction }[] => {
  const out: { n: number; dir: Direction }[] = [];
  for (const m of t.matchAll(/\d+(?:\.\d+)?/g)) {
    const before = t.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 40).toLowerCase();
    const read: Direction =
      MIN_BEFORE.test(before) || MIN_AFTER.test(after)
        ? 'min'
        : MAX_BEFORE.test(before) || MAX_AFTER.test(after)
          ? 'max'
          : null;
    const failing = FAILS_BEFORE.test(t.slice(Math.max(0, m.index - 48), m.index).toLowerCase());
    const dir: Direction = !failing || read === null ? read : read === 'min' ? 'max' : 'min';
    out.push({ n: Number(m[0]), dir });
  }
  return out;
};
// Pairs numbers within their direction (first minimum with first minimum, and so on).
// A number whose direction can't be read is reported whenever it changes.
function compareThresholds(
  before: { n: number; dir: Direction }[],
  after: { n: number; dir: Direction }[],
): string | null {
  for (const dir of ['min', 'max', null] as const) {
    const was = before.filter((x) => x.dir === dir);
    const now = after.filter((x) => x.dir === dir);
    for (const [i, b] of was.entries()) {
      const n = now[i];
      if (n === undefined) return 'threshold-removed';
      if (n.n === b.n) continue;
      if (dir === null) return 'threshold-changed';
      if (dir === 'min' ? n.n < b.n : n.n > b.n) return 'threshold-loosened';
    }
  }
  return null;
}
for (const { file: f, text } of added) {
  if (isConstraints(f) && isExceptionRow(text)) flag('new-exception', f, text);
}
const removedRules = removed.filter((l) => isConstraints(l.file) && ruleKey(l.text) !== null);
const addedRules = added.filter((l) => isConstraints(l.file) && ruleKey(l.text) !== null);
for (const r of removedRules) {
  const a = addedRules.find((x) => ruleKey(x.text) === ruleKey(r.text));
  if (!a) {
    if (!isExceptionRow(r.text)) flag('rule-removed', r.file, r.text);
    continue;
  }
  const verdict = compareThresholds(thresholds(r.text), thresholds(a.text));
  if (verdict !== null) flag(verdict, r.file, `${r.text}  ->  ${a.text}`);
}

// 9. A scanner told to look at less (CONSTRAINTS.md's Secrets, ShellCheck, osv-scanner and
// Semgrep rows):
//   - its own ignore or configuration file, new, changed or renamed into place, even empty (a
//     .semgrepignore replaces Semgrep's defaults);
//   - in a workflow or scripts/ci/: continue-on-error, which turns a job's check green; an
//     environment variable that configures a scanner; on a scanner's own command line, a flag
//     that skips files, rules or failures (elsewhere --exclude and --offline mean other
//     things); and a workflow line that runs a scanner then goes on whatever it says;
//   - a workflow that stops running one of them.
// How CI runs each one exactly is pinned in scripts/test/scanner-pins.test.ts (rule 10).
const SCANNER_CONFIG =
  /(^|\/)(\.?shellcheckr[c]|\.semgrepignor[e]|osv-scanner\.tom[l]|\.gitleaksignor[e]|\.?gitleaks\.tom[l])$/;
const SCANNER_CONFIG_NAMED =
  /(\.?shellcheckr[c]|\.semgrepignor[e]|osv-scanner\.tom[l]|\.gitleaksignor[e]|gitleaks\.tom[l])\b/;
const runsScanners = (f: string): boolean =>
  /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f) || f.startsWith('scripts/ci/');
const SCANNER_SCRIPTS = new Set([
  'scripts/ci/shellcheck.sh',
  'scripts/ci/osv-scan.sh',
  'scripts/ci/semgrep.sh',
]);
const NAMES_A_SCANNER = /\b(shellchec[k]|osv-scanne[r]|semgre[p]|gitleak[s])\b/;
const SCANNER_ENV = /(?<!unset )\b(SHELLCHECK_OPT[S]|GITLEAKS_CONFI[G]\w*)\b/;
const SCANNER_FLAGS: RegExp[] = [
  /-exclud[e]/,
  /--includ[e]/,
  /--no-erro[r]/,
  /--allow-no-lockfile[s]/,
  /--offlin[e]/,
];
// Flags that mean something else to other tools, checked only where that scanner runs.
const SCANNER_FLAGS_IN = new Map<string, RegExp[]>([
  ['scripts/ci/osv-scan.sh', [/--confi[g]/, /--lockfil[e]/, /(^|\s)-[L](\s|=|$)/]],
  ['scripts/ci/shellcheck.sh', [/(^|\s)-[eS](\s|=|$)/, /--severit[y]/, /--rcfil[e]/]],
]);
const GITLEAKS_RUN = /\bgitleak[s] gi[t]\b/;
const GITLEAKS_FLAGS: RegExp[] = [
  /--exit-cod[e]/,
  /--confi[g]/,
  /(^|\s)-[ci](\s|=|$)/,
  /--baseline-pat[h]/,
  /--gitleaks-ignore-pat[h]/,
  /--max-target-megabyte[s]/,
];
const SCANNER_RUNS = /scripts\/ci\/(osv-scan|semgrep|shellcheck)\.s[h]|gitleaks gi[t]/g;
const RUNS_A_SCANNER = /scripts\/ci\/(osv-scan|semgrep|shellcheck)\.s[h]|\bgitleak[s] gi[t]\b/;
for (const f of newFiles) {
  if (SCANNER_CONFIG.test(f)) flag('scanner-weakened', f, 'a scanner configuration file');
}
for (const { file: f, text } of added) {
  if (SCANNER_CONFIG.test(f) && !newFiles.includes(f)) flag('scanner-weakened', f, text);
  // A comment line, in YAML or shell, configures nothing.
  if (!runsScanners(f) || /^\s*#/.test(text)) continue;
  const workflow = f.startsWith('.github/');
  if ((workflow && /continue-on-erro[r]/.test(text)) || SCANNER_ENV.test(text)) {
    flag('scanner-weakened', f, text);
  }
  // A step or script that writes a scanner's configuration file, or moves the branch a scan's
  // base comes from (scripts/ci/scan-base.sh, and the floor guard's own merge base).
  if (SCANNER_CONFIG_NAMED.test(text) || /\bupdate-re[f]\b|refs\/remote[s]\//.test(text)) {
    flag('scanner-weakened', f, text);
  }
  const flags = SCANNER_SCRIPTS.has(f) || NAMES_A_SCANNER.test(text) ? SCANNER_FLAGS : [];
  for (const p of [...flags, ...(SCANNER_FLAGS_IN.get(f) ?? [])]) {
    if (p.test(text)) flag('scanner-weakened', f, text);
  }
  if (GITLEAKS_RUN.test(text)) {
    for (const p of GITLEAKS_FLAGS) if (p.test(text)) flag('scanner-weakened', f, text);
  }
  if (workflow && RUNS_A_SCANNER.test(text) && /\|\||;|&\s*$/.test(text)) {
    flag('scanner-weakened', f, text);
  }
}
const stillRun = new Set(
  added
    .filter((a) => /^\.github\/workflows\//.test(a.file))
    .flatMap((a) => [...a.text.matchAll(SCANNER_RUNS)].map((m) => m[0])),
);
for (const { file: f, text } of removed) {
  if (!/^\.github\/workflows\//.test(f)) continue;
  for (const [run] of text.matchAll(SCANNER_RUNS)) {
    if (!stillRun.has(run)) flag('scanner-removed', f, text);
  }
}

// 10. The checks' pins: scripts/test/scanner-pins.json holds how CI runs each check (each
// checking job and the scanners' scripts by hash, the commands, the arguments, the CVSS bar), and
// scanner-pins.test.ts checks the repository against it. Both are part of the bar, once they're
// at the merge base:
//   - a pinned value changed or removed in the data, unless a commit that changes it to what it
//     is now says why (`Pins changed: <reason>`); a pin added isn't flagged;
//   - any line added to or removed from the test (one only moved, or blank, aside), unless a
//     commit that adds or removes it says why, since an added line can switch a pin off;
//   - either file gone.
const pinned: string[] = [];
const pinsAtBase = git(['cat-file', '-e', `${mergeBase}:${PINS}`]) !== null;
const dataAtBase = git(['show', `${mergeBase}:${PINS_DATA}`]);
if (pinsAtBase && !existsSync(PINS)) flag('pin-removed', PINS, 'the checks’ pins test is gone');
if (dataAtBase !== null && !existsSync(PINS_DATA)) {
  flag('pin-removed', PINS_DATA, 'the checks’ pins are gone');
}
if (pinsAtBase && existsSync(PINS)) {
  for (const [k, n] of unmoved({ added, removed, deleted, newFiles }, PINS)) {
    for (let i = 0; i < n; i += 1) {
      const left = vouchedPinLines.get(k) ?? 0;
      if (left > 0) {
        vouchedPinLines.set(k, left - 1);
        pinned.push(PINS);
      } else flag('pin-changed', PINS, k);
    }
  }
}
if (dataAtBase !== null && existsSync(PINS_DATA)) {
  const now = pinData(readFileSync(PINS_DATA, 'utf8'));
  for (const v of loosenedPins(pinData(dataAtBase), now)) {
    if (vouchedPinValues.has(v)) pinned.push(PINS_DATA);
    else flag('pin-loosened', PINS_DATA, v);
  }
}

for (const f of reasoned) {
  console.log(`floor-guard: tests removed from ${f}, as a commit says: ${reasons.get(f) ?? ''}`);
}
if (pinned.length > 0) {
  console.log(
    `floor-guard: the checks' pins changed, as a commit says: ${reasons.get(PINS) ?? ''}`,
  );
}
if (findings.length === 0) {
  console.log('floor-guard: clean');
  process.exit(0);
}
console.error(`floor-guard: ${String(findings.length)} floor violation(s):`);
for (const f of findings) console.error(`  [${f.rule}] ${f.file}: ${f.text}`);
console.error(
  '\nEach lowers the bar. Fix the code, or ask the owner for an exception row in CONSTRAINTS.md.' +
    '\nA test deleted on purpose passes when the commit that removes it says why, in a line of' +
    ' its message: `Tests removed from <file>: <reason>`, ten characters or more of reason.' +
    ` A change to the checks' pins (${PINS_DATA} or ${PINS}) passes the same way, with` +
    ' `Pins changed: <reason>` in the message of the commit that makes it.',
);
process.exit(1);
