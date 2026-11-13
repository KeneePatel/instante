import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import { untypedConfig } from './eslint.config.mjs';

// `check:fast`: the same rules without type information, so linting the changed
// files after an edit stays under 5 seconds. The typed rules run in `check:task`.
export default defineConfig([
  ...untypedConfig,
  ...tseslint.configs.strict.map((c) => ({ ...c, files: c.files ?? ['**/*.{ts,tsx,mts,cts}'] })),
]);
