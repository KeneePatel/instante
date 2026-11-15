import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import tseslint from 'typescript-eslint';

// One config for the whole workspace. `check:task` and CI use this file, with the
// typed rules; `check:fast` uses eslint.fast.config.mjs, which takes the untyped part.

const TS_FILES = ['**/*.{ts,tsx,mts,cts}'];
const WEB_FILES = ['apps/web/**/*.{js,jsx,mjs,ts,tsx}'];

const NO_TEST_IMPORTS = {
  regex: '(^|/)test/',
  message: 'Application code never imports test/: fixtures and fakes stay out of the app.',
};

// The backend's layers, highest first ("Backend modules" in docs/architecture.md):
// a module imports only from the layers above it, never from the entry points.
const LAYERS = ['kit', 'domain', 'ai', 'documents', 'sources', 'store', 'engine'];
const ENTRY_POINTS = ['api', 'worker', 'cli'];

// The document service starts processes with spawn or execFile, never exec, a shell or fork
// (docs/specs/platform.md, "documents"). Only those two may be imported: a default or
// namespace import, or a re-export, is refused as well, and so are the other ways in that an
// author might reach for: node:module's createRequire and node:cluster's fork. No lint rule can
// see every way round it; these are the plain ones.
const SPAWN_ONLY = 'The document service starts processes with spawn or execFile only.';
const DOCUMENTS_PATHS = [
  ...['node:child_process', 'child_process'].map((name) => ({
    name,
    allowImportNames: ['spawn', 'execFile'],
    message: SPAWN_ONLY,
  })),
  ...['node:module', 'module', 'node:cluster', 'cluster'].map((name) => ({
    name,
    message: `${SPAWN_ONLY} It loads no module by a name it builds, and forks nothing.`,
  })),
];
// The names that load a built-in module from a string, round an import: refused on any object,
// and however they're named, so an alias or a destructuring is caught too.
const LOADERS = '/^(getBuiltinModule|binding|_linkedBinding)$/';
// A shell, named as the program to start.
const SHELLS = '/(^|\\/)(env|sh|bash|dash|zsh|ksh|csh|tcsh|fish)$/';

const layerRules = LAYERS.map((layer, i) => ({
  files: [`apps/backend/src/${layer}/**/*.ts`],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        // One rule entry per file set: a later entry would replace these patterns, not add to them.
        paths: layer === 'documents' ? DOCUMENTS_PATHS : [],
        patterns: [
          {
            regex: `(^|/)(${[...LAYERS.slice(i + 1), ...ENTRY_POINTS].join('|')})/`,
            message: `${layer} imports only from the layers above it (docs/architecture.md).`,
          },
          NO_TEST_IMPORTS,
        ],
      },
    ],
  },
}));

// eslint-config-next's settings apply to the web app only. Entries that hold nothing
// but `ignores` are global ignores and stay as they are.
const forWeb = (configs) =>
  configs.map((c) => (Object.keys(c).length === 1 && c.ignores ? c : { ...c, files: WEB_FILES }));

export const untypedConfig = defineConfig([
  globalIgnores([
    '**/.next/**',
    '**/out/**',
    '**/build/**',
    '**/coverage/**',
    'apps/web/next-env.d.ts',
  ]),
  {
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: 'error',
    },
  },
  ...forWeb(nextVitals),
  ...forWeb(nextTs),
  { files: WEB_FILES, settings: { next: { rootDir: 'apps/web/' } } },
  {
    files: [
      'apps/*/src/**/*.{ts,tsx}',
      'packages/*/src/**/*.ts',
      'apps/web/{app,lib,components}/**/*.{ts,tsx}',
    ],
    rules: { 'no-restricted-imports': ['error', { patterns: [NO_TEST_IMPORTS] }] },
  },
  ...layerRules,
  {
    files: ['apps/backend/src/documents/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "Property:matches([key.name='shell'], [key.value='shell']):not([value.value=false])",
          message: `${SPAWN_ONLY} Never through a shell: \`shell\` may only be false.`,
        },
        // `shell` set any other way: as a member, or by a string or template naming it.
        {
          selector:
            "MemberExpression[property.name='shell'], Literal[value='shell']:not(Property[value.value=false] > Literal.key), TemplateElement[value.cooked='shell']",
          message: `${SPAWN_ONLY} Never through a shell: \`shell\` is only ever written as \`shell: false\`.`,
        },
        {
          selector:
            "ImportExpression[source.value=/^(node:)?(child_process|module|cluster)$/], ImportExpression:not([source.type='Literal'])",
          message: `${SPAWN_ONLY} No dynamic import of child_process, node:module or node:cluster, or of a name built at run time.`,
        },
        {
          selector: `Identifier[name=${LOADERS}], Literal[value=${LOADERS}], TemplateElement[value.cooked=${LOADERS}]`,
          message: `${SPAWN_ONLY} No built-in module loaded by name either.`,
        },
        {
          selector: `CallExpression[callee.name=/^(spawn|execFile)$/][arguments.0.value=${SHELLS}]`,
          message: `${SPAWN_ONLY} Never a shell as the program: it starts process.execPath, or a tool by its full path.`,
        },
      ],
    },
  },
]);

export default defineConfig([
  ...untypedConfig,
  ...tseslint.configs.strictTypeChecked.map((c) => ({ ...c, files: c.files ?? TS_FILES })),
  {
    files: TS_FILES,
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
]);
