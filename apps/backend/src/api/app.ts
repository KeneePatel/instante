import { routes, testRoutes } from '@instante/contract';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { AppError, errorReply } from '../kit/errors.ts';
import { routeHandlers } from './handlers/ping.ts';
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
  deps: Deps;
};

export function createApp(options: AppOptions): Hono<AppEnv> {
  const { authenticate, deps } = options;
  const app = new Hono<AppEnv>();
  app.use('*', replyHeaders, requestContext(deps), hostCheck(options), fetchMetadata, dropCookie);

  app.get('/healthz', (c) => c.json({ ok: true }));
  registerRoutes(app, routes, routeHandlers, { authenticate, deps });
  if (options.testRoutes)
    registerRoutes(app, testRoutes, testRouteHandlers, { authenticate, deps });

  // A path no route matches, in any spelling (a trailing slash, a changed case, a suffix),
  // asks for sign-in first: only a signed-in caller learns that it doesn't exist.
  app.notFound(async (c) => {
    const user = await authenticate(c.req.header('authorization'));
    const { status, body } = errorReply(
      new AppError(user === null ? 'unauthenticated' : 'not_found'),
    );
    return c.json(body, status as ContentfulStatusCode);
  });
  app.onError((error, c) => {
    const { status, body } = errorReply(error);
    // Logged with the request id when requestContext set one; the sanitizer drops it if not.
    if (status >= 500)
      deps.logger.error('request.failed', { requestId: c.get('requestId'), error });
    return c.json(body, status as ContentfulStatusCode);
  });
  return app;
}
