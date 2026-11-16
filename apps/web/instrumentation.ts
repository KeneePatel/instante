// Next calls register() once as a server starts (docs/specs/platform.md, "instrumentation.ts"):
// a server built to send /api to one backend address won't start with another. The check is
// imported on the Node.js runtime only, as Next's guide does, since it can stop the process.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { stopOnMismatch } = await import('./lib/backend.ts');
    stopOnMismatch();
  }
}
