// Floor guard: diff-scoped checks for the floor in CONSTRAINTS.md, adapted from the
// constraint-driven-development skill's reference (references/floor-guard.md).
//
//   node scripts/floor-guard.ts [--base <ref>]      default base: origin/main
//
// It reads the diff from the merge base to the working tree, untracked files included.
// Exit codes: 0 clean, 1 at least one floor violation, 2 the guard could not run.
// It reports the rule, the file and the line, and only ever flags moves that lower the bar.
//
// The patterns spell their own keywords with a character class (for example "TOD[O]"),
// so this file never matches itself.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

interface Line {
  file: string;
  text: string;
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

// Walk the diff. `---` and `+++` are headers only between a file's `diff` line and its first
// hunk; inside a hunk every line is content. A deleted file keeps its old name.
const added: Line[] = [];
const removed: Line[] = [];
const deleted: string[] = [];
const newFiles: string[] = [];
const pathOf = (s: string): string => s.replace(/^[ab]\//, '');
let file = '';
let oldFile = '';
let inHeader = false;
for (const line of `${tracked}\n${untracked}`.split('\n')) {
  if (line.startsWith('diff ')) {
    inHeader = true;
  } else if (line.startsWith('@@')) {
    inHeader = false;
  } else if (inHeader) {
    if (line.startsWith('--- ')) oldFile = pathOf(line.slice(4));
    else if (line.startsWith('+++ ')) {
      const newFile = pathOf(line.slice(4));
      file = newFile === '/dev/null' ? oldFile : newFile;
      if (newFile === '/dev/null') deleted.push(file);
      if (oldFile === '/dev/null') newFiles.push(file);
    }
  } else if (line.startsWith('+')) {
    added.push({ file, text: line.slice(1) });
  } else if (line.startsWith('-')) {
    removed.push({ file, text: line.slice(1) });
  }
}

const findings: Finding[] = [];
const flag = (rule: string, where: string, text: string): void => {
  findings.push({ rule, file: where, text: text.trim().slice(0, 120) });
};

const isCode = (f: string): boolean => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|sh|ya?ml|css)$/.test(f);
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
  /nosemgre[p]/,
  /gitleaks:allo[w]/,
];
// 2. Unfinished work.
const STUBS: RegExp[] = [
  /throw new [\w.]*\(.*not implemente[d]/i,
  /catc[h]\s*(\([^)]*\))?\s*\{\s*\}/,
  /\bTOD[O]\b/,
];
// 3. A test made easier.
const SKIPS: RegExp[] = [/\.(ski[p]|onl[y]|tod[o])\(/, /\b(xi[t]|xdescrib[e]|xtes[t])\(/];

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

// 6. Tests deleted, or assertions removed from a test that stays (moved lines don't count).
for (const f of deleted) if (isTest(f)) flag('test-deleted', f, 'file deleted');
for (const { file: f, text } of removed) {
  if (!isTest(f) || deleted.includes(f) || !/\b(expect|assert)\b/.test(text)) continue;
  const moved = added.some((a) => a.file === f && a.text.trim() === text.trim());
  if (!moved) flag('assertion-removed', f, text);
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
type Direction = 'min' | 'max' | null;
const thresholds = (t: string): { n: number; dir: Direction }[] => {
  const out: { n: number; dir: Direction }[] = [];
  for (const m of t.matchAll(/\d+(?:\.\d+)?/g)) {
    const before = t.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 40).toLowerCase();
    const dir: Direction =
      MIN_BEFORE.test(before) || MIN_AFTER.test(after)
        ? 'min'
        : MAX_BEFORE.test(before) || MAX_AFTER.test(after)
          ? 'max'
          : null;
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

if (findings.length === 0) {
  console.log('floor-guard: clean');
  process.exit(0);
}
console.error(`floor-guard: ${String(findings.length)} floor violation(s):`);
for (const f of findings) console.error(`  [${f.rule}] ${f.file}: ${f.text}`);
console.error(
  '\nEach lowers the bar. Fix the code, or ask the owner for an exception row in CONSTRAINTS.md.',
);
process.exit(1);
