// Every commit since the base is authored and committed as the owner, with no trailers
// and no AI attribution (AGENTS.md §3).
//
//   node scripts/check-commits.ts [--base <ref>]      default base: origin/main
//
// Merge commits are skipped: GitHub makes one to test a pull request. Exit codes:
// 0 clean, 1 a commit breaks the rule, 2 the check could not run.
import { execFileSync } from 'node:child_process';

const OWNER = 'Kenee Patel <patelkenee2804@gmail.com>';
const ATTRIBUTION = /^co-authored-by:|generated with \[?claude|🤖/im;

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
}

function bail(message: string): never {
  console.error(`check-commits: ${message}`);
  process.exit(2);
}

const baseFlag = process.argv.indexOf('--base');
const base = baseFlag === -1 ? 'origin/main' : process.argv[baseFlag + 1];
if (base === undefined || base === '') bail('--base needs a ref');

const mergeBase = git(['merge-base', base, 'HEAD'])?.trim();
if (mergeBase === undefined || mergeBase === '') bail(`no merge base against ${base}`);

const FIELD = '\x1f';
const RECORD = '\x1e';
const log = git([
  'log',
  '--no-merges',
  `--format=%h${FIELD}%an <%ae>${FIELD}%cn <%ce>${FIELD}%(trailers:only,unfold)${FIELD}%B${RECORD}`,
  `${mergeBase}..HEAD`,
]);
if (log === null) bail(`could not read the commits since ${mergeBase}`);

const problems: string[] = [];
for (const record of log.split(RECORD)) {
  const [hash, author, committer, trailers, message] = record.replace(/^\n/, '').split(FIELD);
  if (hash === undefined || hash === '') continue;
  if (author !== OWNER) problems.push(`${hash}: author is ${author ?? '(none)'}`);
  if (committer !== OWNER) problems.push(`${hash}: committer is ${committer ?? '(none)'}`);
  if ((trailers ?? '').trim() !== '') problems.push(`${hash}: has trailers`);
  if (ATTRIBUTION.test(message ?? '')) problems.push(`${hash}: mentions AI attribution`);
}

if (problems.length === 0) {
  console.log('check-commits: clean');
  process.exit(0);
}
console.error(`check-commits: ${String(problems.length)} problem(s):`);
for (const p of problems) console.error(`  ${p}`);
console.error(`\nEvery commit is authored and committed as ${OWNER}, with no trailers.`);
process.exit(1);
