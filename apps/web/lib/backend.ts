// The backend's address, as the web app is built and started with it (docs/specs/platform.md,
// "next.config.ts" and "instrumentation.ts"): the /api rewrite is fixed at build time, and a
// server started with another address stops.

/** Why `url` can't be the backend's address, if it can't: http on 127.0.0.1 with a port, since
 * the backend listens on loopback only and /api carries the session's token. Unset is allowed
 * here (`next typegen` loads the config without it); the build then has no rewrite, and
 * `backendMismatch` stops a server started with an address. */
export function backendUrlProblem(url: string | undefined): string | undefined {
  if (url === undefined || url === '') return undefined;
  const port = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(url)?.[1];
  if (port === undefined || Number(port) < 1 || Number(port) > 65_535) {
    return `BACKEND_INTERNAL_URL must be http://127.0.0.1:<port>, not ${url}`;
  }
  return undefined;
}

/** Why a server built with the address `built` (empty for none) can't start with `current`, if
 * it can't: only the address it was built with will do. */
export function backendMismatch(built: string, current: string | undefined): string | undefined {
  if (built === (current ?? '')) return undefined;
  const was = built === '' ? 'no backend' : built;
  const now = current === undefined || current === '' ? 'unset' : current;
  return `This build sends /api to ${was}, but BACKEND_INTERNAL_URL is ${now}: build again with it, or set it back.`;
}

/** Stops this server if it was built for another backend address than BACKEND_INTERNAL_URL.
 * Node only: instrumentation.ts imports it on the Node.js runtime. */
export function stopOnMismatch(): void {
  // Inlined at build time from next.config.ts's `env`: the address this build has.
  const built = process.env.INSTANTE_BUILT_BACKEND ?? '';
  const problem = backendMismatch(built, process.env['BACKEND_INTERNAL_URL']);
  if (problem !== undefined) {
    console.error(problem);
    process.exit(1);
  }
}
