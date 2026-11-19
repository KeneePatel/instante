import { z } from 'zod';

// Zod tests whether it may compile its parsers by calling `Function('')` when it builds an
// object schema. In the browser, under the web app's policy (no 'unsafe-eval' in production),
// that test is a CSP violation: zod catches the error, but the browser still reports it. So
// the contract turns compiled parsers off for every schema it builds. index.ts imports this
// first, before any schema exists.
z.config({ jitless: true });
