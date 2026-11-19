// The dependency bar (CONSTRAINTS.md, "Dependencies": nothing at high or above), judged from
// osv-scanner's report, since osv-scanner has no threshold of its own and exits 1 on any
// advisory at all:
//
//   node scripts/check-osv.ts <report>   the JSON of `osv-scanner scan source -r --all-packages --format json`
//
// osv-scanner joins the advisories for one flaw by their aliases into a group. A group fails
// when any of these holds (the owner's bar, 2026-11-19):
//   - its CVSS base score (max_severity) is 7.0 or more;
//   - one of its advisories rates it HIGH or CRITICAL in words (database_specific.severity, as
//     GitHub's advisories do, some of them with no CVSS vector, or one osv-scanner can't parse);
//   - it's a malicious package (an id or alias starting MAL-), whatever its score;
//   - it has no severity at all: unknown counts as high.
// It also checks the scan read pnpm-lock.yaml whole. pnpm 12 writes it as two YAML documents,
// pnpm's own packages and then the project's, and a reader that stops at the first sees only
// pnpm: both `pnpm` and `next` must be among the packages the report lists.
// Findings go to stdout, and to the job's summary when GITHUB_STEP_SUMMARY is set.
// Exit codes: 0 nothing at high or above, 1 a group at high or above or the lockfile not read
// whole, 2 no report it can read.
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
if (file === undefined) {
  console.error('usage: node scripts/check-osv.ts <osv-scanner JSON report>');
  process.exit(2);
}
let report: unknown;
try {
  report = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
  console.error(`check-osv: no report to read in ${file}: ${String(error)}`);
  process.exit(2);
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

const results = isObject(report) ? report['results'] : undefined;
if (!Array.isArray(results)) {
  console.error(`check-osv: ${file} has no results list, so it isn't osv-scanner's JSON report`);
  process.exit(2);
}

const HIGH_WORDS = new Set(['HIGH', 'CRITICAL']);
const BELOW_WORDS = new Set(['MODERATE', 'MEDIUM', 'LOW']);

interface Judged {
  ids: string[];
  where: string;
  verdict: string;
  high: boolean;
}
const judged: Judged[] = [];
const lockfilePackages = new Set<string>();
let lockfileSeen = false;

for (const result of results) {
  if (!isObject(result)) continue;
  const source = isObject(result['source']) ? text(result['source']['path']) : '';
  const isLockfile = path.basename(source) === 'pnpm-lock.yaml';
  if (isLockfile) lockfileSeen = true;
  for (const entry of list(result['packages'])) {
    if (!isObject(entry)) continue;
    const pkg = isObject(entry['package']) ? entry['package'] : {};
    const name = text(pkg['name']);
    if (isLockfile) lockfilePackages.add(name);
    const where = `${name}@${text(pkg['version'])} (${text(pkg['ecosystem'])}, ${path.basename(source)})`;
    const advisories = list(entry['vulnerabilities']).filter(isObject);
    const byId = new Map(advisories.map((a) => [text(a['id']), a]));
    // Each advisory osv-scanner didn't group is a group of its own, with no score.
    const groups = list(entry['groups']).filter(isObject);
    const grouped = new Set(groups.flatMap((g) => list(g['ids']).map(text)));
    const all = [
      ...groups.map((g) => ({
        ids: list(g['ids']).map(text),
        aliases: list(g['aliases']).map(text),
        score: text(g['max_severity']),
      })),
      ...[...byId.keys()]
        .filter((id) => !grouped.has(id))
        .map((id) => ({ ids: [id], aliases: [], score: '' })),
    ];
    for (const group of all) {
      const members = group.ids.map((id) => byId.get(id)).filter((a) => a !== undefined);
      const words = members.map((a) => {
        const specific = a['database_specific'] ?? a['databaseSpecific'];
        return isObject(specific) ? text(specific['severity']).toUpperCase() : '';
      });
      const named = [...group.ids, ...group.aliases, ...members.flatMap((a) => list(a['aliases']))];
      const score = /^\d+(\.\d+)?$/.test(group.score) ? Number(group.score) : undefined;
      const reasons: string[] = [];
      if (named.some((id) => text(id).startsWith('MAL-'))) reasons.push('a malicious package');
      if (score !== undefined && score >= 7) reasons.push(`CVSS ${group.score}`);
      for (const word of words) if (HIGH_WORDS.has(word)) reasons.push(`rated ${word}`);
      if (score === undefined && !words.some((w) => HIGH_WORDS.has(w) || BELOW_WORDS.has(w))) {
        reasons.push('no severity given, which counts as high');
      }
      const high = reasons.length > 0;
      const below = [
        ...(score === undefined ? [] : [`CVSS ${group.score}`]),
        ...words.filter((w) => BELOW_WORDS.has(w)).map((w) => `rated ${w}`),
      ];
      judged.push({
        ids: group.ids,
        where,
        verdict: high ? [...new Set(reasons)].join(', ') : below.join(', '),
        high,
      });
    }
  }
}

const problems: string[] = [];
if (!lockfileSeen) problems.push('the report has no pnpm-lock.yaml: was the lockfile scanned?');
else {
  for (const needed of ['pnpm', 'next']) {
    if (!lockfilePackages.has(needed)) {
      problems.push(
        `pnpm-lock.yaml's packages don't include ${needed}: its two documents weren't both read`,
      );
    }
  }
}

const highs = judged.filter((j) => j.high);
const lines = [
  `check-osv: ${String(lockfilePackages.size)} packages in pnpm-lock.yaml, ${String(judged.length)} advisory group(s), ${String(highs.length)} at high or above`,
  ...highs.map((j) => `  HIGH   ${j.ids.join(' / ')}  ${j.where}: ${j.verdict}`),
  ...judged
    .filter((j) => !j.high)
    .map((j) => `  below  ${j.ids.join(' / ')}  ${j.where}: ${j.verdict}`),
  ...problems.map((p) => `  ${p}`),
];
for (const line of lines) console.log(line);
const summary = process.env['GITHUB_STEP_SUMMARY'];
if (summary !== undefined && summary !== '') {
  appendFileSync(summary, `### osv-scanner\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`);
}
if (highs.length > 0 || problems.length > 0) {
  console.error(
    'check-osv: fix it by updating the dependency, or ask the owner for an exception row in CONSTRAINTS.md',
  );
  process.exit(1);
}
