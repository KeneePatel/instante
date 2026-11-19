// The web build holds nothing from a test folder (docs/specs/platform.md, criterion 7: `src/`
// imports nothing from `test/`), read from the build itself: the sources its server source maps
// list, which Turbopack writes for every server chunk.
//
//   node scripts/prod-build/web-sources.ts [<repository root>]   default: the current folder
//
// A source is a URL-encoded path relative to its map; this resolves each one, keeps those inside
// the repository and outside node_modules, and fails on any in a test or e2e folder, or named
// *.test.ts(x). It also fails unless the maps list files every build has (instrumentation.ts,
// proxy.ts, the root layout), so a Next.js that stops writing them can't pass by listing nothing.
// Exit codes: 0 nothing from a test folder, 1 something, or the maps missing those files, 2 no
// build to read.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '.');
const server = path.join(root, 'apps/web/.next/server');
const EVERY_BUILD = ['apps/web/instrumentation.ts', 'apps/web/proxy.ts', 'apps/web/app/layout.tsx'];
const FROM_TEST = /(^|\/)(test|e2e)\/|\.test\.tsx?$/;

let entries: string[];
try {
  entries = readdirSync(server, { recursive: true, encoding: 'utf8' });
} catch (error) {
  console.error(`web-sources: no build to read in ${server}: ${String(error)}`);
  process.exit(2);
}

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
// A map's own sources and those of its sections: Turbopack writes an index map as
// `{"sources":[],"sections":[...]}`, so either can be empty.
const listed = (map: unknown): string[] => {
  if (typeof map !== 'object' || map === null) return [];
  const { sources, sections } = map as { sources?: unknown; sections?: unknown };
  const direct = Array.isArray(sources)
    ? sources.filter((s): s is string => typeof s === 'string')
    : [];
  const nested = Array.isArray(sections)
    ? sections.flatMap((s) => listed((s as { map?: unknown } | null)?.map))
    : [];
  return [...direct, ...nested];
};

const own = new Set<string>();
let maps = 0;
for (const entry of entries) {
  if (!entry.endsWith('.map')) continue;
  const file = path.join(server, entry);
  let map: unknown;
  try {
    map = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`web-sources: ${file} isn't a source map: ${String(error)}`);
    process.exit(2);
  }
  maps += 1;
  for (const source of listed(map)) {
    const relative = path.relative(root, path.resolve(path.dirname(file), decode(source)));
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    if (relative.split(path.sep).includes('node_modules')) continue;
    own.add(relative.split(path.sep).join('/'));
  }
}

const missing = EVERY_BUILD.filter((f) => !own.has(f));
const fromTest = [...own].filter((f) => FROM_TEST.test(f)).sort();
console.log(
  `web-sources: ${String(maps)} server source maps list ${String(own.size)} of the repository's files`,
);
if (missing.length > 0) {
  console.error(`web-sources: the maps don't list ${missing.join(', ')}, which every build has`);
}
if (fromTest.length > 0) console.error(`web-sources: the build holds ${fromTest.join(', ')}`);
process.exit(missing.length > 0 || fromTest.length > 0 ? 1 : 0);
