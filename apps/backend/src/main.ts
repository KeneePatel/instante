import { ConfigError } from './kit/config.ts';
import { sanitize } from './kit/sanitize.ts';
import { start } from './start.ts';

// The backend's entry point: `node --disable-sigusr1 apps/backend/src/main.ts`, with ROLE and
// the rest of the configuration in the environment (docs/specs/platform.md).

try {
  const running = await start({ env: process.env });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void running.close().then(() => process.exit(0));
    });
  }
} catch (error) {
  if (error instanceof ConfigError) {
    // It names each problem and never a secret's value.
    console.error(error.message);
    process.exitCode = 78;
  } else {
    console.error(
      JSON.stringify({ level: 'error', event: 'start.failed', error: sanitize(error) }),
    );
    process.exitCode = 1;
  }
}
