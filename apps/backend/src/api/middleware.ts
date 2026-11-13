import type { MiddlewareHandler } from 'hono';
import { AppError } from '../kit/errors.ts';
import type { AppEnv, Deps } from './register-routes.ts';

// The checks every request passes before any route (docs/specs/platform.md, "apps/backend"):
// the reply's headers, a request id, then Host, Fetch Metadata and the Cookie drop, in order.

/** On every reply, errors included: nothing is cached, and replies vary by who asks. */
export const replyHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header('Cache-Control', 'private, no-store');
  c.header('Vary', 'Authorization');
  c.header('X-Content-Type-Options', 'nosniff');
};

/** Comes before the refusals below, so each refusal is logged with its id too. */
export function requestContext(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = deps.ids.uuid();
    const logger = deps.logger.child({ requestId });
    c.set('requestId', requestId);
    c.set('logger', logger);
    const started = deps.clock.now().getTime();
    await next();
    c.header('X-Request-Id', requestId);
    logger.info('request', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: deps.clock.now().getTime() - started,
    });
  };
}

/** The backend answers only to its own loopback address, and only to the web app's one host
 * when a request was forwarded; anything else is misdirected. */
export function hostCheck(options: {
  port: number;
  allowedHost: string;
}): MiddlewareHandler<AppEnv> {
  const own = `127.0.0.1:${String(options.port)}`;
  return async (c, next) => {
    const forwarded = c.req.header('x-forwarded-host');
    if (c.req.header('host') !== own) throw new AppError('misdirected');
    if (forwarded !== undefined && forwarded !== options.allowedHost) {
      throw new AppError('misdirected');
    }
    await next();
  };
}

/** A request another site's page started is refused. Requests without the header (Server
 * Components, tools) pass; the backend serves no pages, so there are no navigations to allow. */
export const fetchMetadata: MiddlewareHandler<AppEnv> = async (c, next) => {
  const site = c.req.header('sec-fetch-site')?.toLowerCase();
  if (site === 'cross-site' || site === 'same-site') throw new AppError('forbidden');
  await next();
};

/** The backend never reads cookies: sessions travel only as bearer tokens. */
export const dropCookie: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('cookieArrived', c.req.raw.headers.has('cookie'));
  c.req.raw.headers.delete('cookie');
  await next();
};
