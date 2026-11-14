import { routes, testRoutes } from '@instante/contract';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { AppError, errorReply } from '../kit/errors.ts';
import { routeHandlers } from './handlers/ping.ts';
import { registerReadyz, type Ready } from './handlers/readyz.ts';
import { testRouteHandlers } from './handlers/test-routes.ts';
import {
  dropCookie,
  fetchMetadata,
  hostCheck,
  replyHeaders,
  requestContext,
} from './middleware.ts';
import { registerRoutes, type AppEnv, type Authenticate, type Deps } from './register-routes.ts';

export type AppOptions = {
  port: number;
  allowedHost: string;
  /** The test-only table, registered only with INSTANTE_ENV=test. */
  testRoutes: boolean;
  authenticate: Authenticate;
  /** The checks /readyz reports as failing, or none. */
  ready: Ready;
  deps: Deps;
};

export function createApp(options: AppOptions): Hono<AppEnv> {
  const { authenticate, deps } = options;
  const app = new Hono<AppEnv>();
  app.use('*', replyHeaders, requestContext(deps), hostCheck(options), fetchMetadata, dropCookie);

  app.get('/healthz', (c) => c.json({ ok: true }));
  registerReadyz(app, options.ready);
  registerRoutes(app, routes, routeHandlers, { authenticate, deps });
  if (options.testRoutes) {
    registerRoutes(app, testRoutes, testRouteHandlers, { authenticate, deps });
  }

  // A path no route matches, in any spelling (a trailing slash, a changed case, a suffix),
  // asks for sign-in first: only a signed-in caller learns that it doesn't exist.
  app.notFound(async (c) => {
    const user = await authenticate(c.req.header('authorization'));
    return send(c, new AppError(user === null ? 'unauthenticated' : 'not_found'));
  });

  app.onError((error, c) => {
    // With the request id when requestContext set one; the sanitizer drops it if not.
    const requestId = c.get('requestId');
    if (c.req.raw.signal.aborted) {
      // The caller left mid-request, say mid-upload: nobody gets this reply, and it's no fault.
      deps.logger.info('request.aborted', { requestId });
      return send(c, new AppError('validation_failed', { message: 'The request ended early.' }));
    }
    const reply = send(c, error);
    if (reply.status >= 500) deps.logger.error('request.failed', { requestId, error });
    return reply;
  });
  return app;
}

function send(c: Context<AppEnv>, error: unknown): Response {
  const { status, body } = errorReply(error);
  return c.json(body, status as ContentfulStatusCode);
}
