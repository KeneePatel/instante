import { runCli } from './cli/db.ts';
import { systemClock } from './kit/clock.ts';
import { ConfigError, loadConfig, processRuntime } from './kit/config.ts';
import { createLogger } from './kit/logger.ts';
import { startDocuments } from './documents/server.ts';
import { start } from './start.ts';

// The backend's entry point: `node --disable-sigusr1 apps/backend/src/main.ts`, with ROLE and
// the rest of the configuration in the environment (docs/specs/platform.md). ROLE=cli runs
// the command in its arguments, ROLE=documents starts the document service, and any other role
// starts the backend; each loads and checks the configuration itself.

try {
  if (process.env['ROLE'] === 'cli') {
    const config = loadConfig(process.env, processRuntime());
    if (config.role !== 'cli') throw new Error('ROLE=cli loaded as another role');
    process.exitCode = await runCli(config, process.argv.slice(2), (line) => {
      console.log(line);
    });
  } else {
    // The stop handlers come before the server listens, so a stop sent as it starts isn't lost.
    const running =
      process.env['ROLE'] === 'documents'
        ? startDocuments({ env: process.env })
        : start({ env: process.env });
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        void running
          .then((server) => server.close())
          .then(
            () => process.exit(0),
            () => process.exit(1),
          );
      });
    }
    await running;
  }
} catch (error) {
  if (error instanceof ConfigError) {
    // It names each problem and never a secret's value.
    console.error(error.message);
    process.exitCode = 78;
  } else {
    createLogger({ clock: systemClock }).error('start.failed', { error });
    process.exitCode = 1;
  }
}
