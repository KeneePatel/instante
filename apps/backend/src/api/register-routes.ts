import type {
  BodyOf,
  FileResponse,
  ParamsOf,
  QueryOf,
  RawBody,
  RouteSpec,
} from '@instante/contract';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { z } from 'zod';
import type { Clock } from '../kit/clock.ts';
import { AppError } from '../kit/errors.ts';
import type { Ids } from '../kit/ids.ts';
import type { Logger } from '../kit/logger.ts';

// The Hono app is built only from the contract's tables (ADR-005). Registration fails closed:
// a table with a route that has no auth value or no handler, or a handler with no route,
// registers nothing at all.

export type Principal = { userId: string };

/** Reads the request's Authorization header; null for anything it doesn't accept. */
export type Authenticate = (authorization: string | undefined) => Promise<Principal | null>;

/** The only authenticate until `accounts` brings the real one. */
export const refuseEveryToken: Authenticate = () => Promise.resolve(null);

export type Deps = {
  clock: Clock;
  ids: Ids;
  logger: Logger;
  sleep: (ms: number) => Promise<void>;
};

/** What a handler may know of the request beyond its validated input. */
export type RequestFacts = {
  requestId: string;
  authorization: string | undefined;
  /** Whether a Cookie header arrived before the backend dropped it. */
  cookieArrived: boolean;
};

export type AppEnv = {
  Variables: {
    requestId: string;
    logger: Logger;
    cookieArrived: boolean;
    user: Principal | undefined;
  };
};

export type Reply<S extends RouteSpec> = S['response'] extends FileResponse
  ? Uint8Array
  : S['response'] extends z.ZodType
    ? z.input<S['response']>
    : never;

export type HandlerInput<S extends RouteSpec> = Deps & {
  params: ParamsOf<S>;
  query: QueryOf<S>;
  body: BodyOf<S>;
  user: S['auth'] extends 'user' ? Principal : undefined;
  request: RequestFacts;
};

export type Handler<S extends RouteSpec> = (input: HandlerInput<S>) => Reply<S> | Promise<Reply<S>>;
export type RouteTable = Readonly<Record<string, RouteSpec>>;
export type Handlers<T extends RouteTable> = { readonly [K in keyof T]: Handler<T[K]> };

/** For a JSON body when the route names no limit of its own. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

type LooseHandler = (input: Record<string, unknown>) => unknown;

export function registerRoutes<T extends RouteTable>(
  app: Hono<AppEnv>,
  table: T,
  handlers: Handlers<T>,
  options: { authenticate: Authenticate; deps: Deps },
): void {
  const names = Object.keys(table);
  for (const name of Object.keys(handlers)) {
    if (!names.includes(name))
      throw new Error(`registerRoutes: ${name} has a handler but no route`);
  }
  const entries = names.map((name) => {
    const spec = table[name] as RouteSpec;
    // Typed as required, but a table built loosely could still lack it.
    const auth: unknown = spec.auth;
    if (auth !== 'public' && auth !== 'user') {
      throw new Error(`registerRoutes: ${name} has no auth value`);
    }
    const handler: unknown = handlers[name];
    if (typeof handler !== 'function') throw new Error(`registerRoutes: ${name} has no handler`);
    return { spec, handler: handler as LooseHandler };
  });

  for (const { spec, handler } of entries) {
    const steps: MiddlewareHandler<AppEnv>[] = [];
    if (spec.auth === 'user') steps.push(requireUser(options.authenticate));
    if (spec.body !== undefined) {
      steps.push(limitBody(spec.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES));
      if (!isRaw(spec.body)) steps.push(requireJson);
    }
    app.on(spec.method, [spec.path], ...steps, async (c) => {
      const input = {
        ...options.deps,
        logger: c.get('logger'),
        user: c.get('user'),
        params: validate(spec.params, c.req.param()),
        query: validate(spec.query, c.req.query()),
        body: await readBody(c, spec.body),
        request: {
          requestId: c.get('requestId'),
          authorization: c.req.header('authorization'),
          cookieArrived: c.get('cookieArrived'),
        },
      };
      return reply(c, spec, await handler(input));
    });
  }
}

function requireUser(authenticate: Authenticate): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = await authenticate(c.req.header('authorization'));
    if (user === null) throw new AppError('unauthenticated');
    c.set('user', user);
    await next();
  };
}

/** Refused on Content-Length before any byte is read, and counted as a chunked body streams
 * in, since the web app's rewrite cuts bodies over 10 MB without an error. */
function limitBody(maxSize: number): MiddlewareHandler<AppEnv> {
  return bodyLimit({
    maxSize,
    onError: () => {
      throw new AppError('payload_too_large');
    },
  });
}

/** Our own media-type check: JSON bodies come as application/json, in UTF-8 if a charset is
 * named. */
const requireJson: MiddlewareHandler<AppEnv> = async (c, next) => {
  const [type = '', ...parameters] = (c.req.header('content-type') ?? '').split(';');
  const charset = parameters
    .map((p) => p.trim().toLowerCase())
    .find((p) => p.startsWith('charset='));
  if (type.trim().toLowerCase() !== 'application/json') {
    throw new AppError('unsupported_media_type');
  }
  if (charset !== undefined && charset !== 'charset=utf-8') {
    throw new AppError('unsupported_media_type');
  }
  await next();
};

/** A Zod schema parses; the contract's raw-body and file markers don't. */
function isRaw(body: z.ZodType | RawBody): body is RawBody {
  return !('safeParse' in body);
}

async function readBody(c: Context<AppEnv>, body: z.ZodType | RawBody | undefined) {
  if (body === undefined) return undefined;
  if (isRaw(body)) return new Uint8Array(await c.req.arrayBuffer());
  const text = await c.req.text();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new AppError('validation_failed', { message: 'The body is not valid JSON.', cause });
  }
  return validate(body, value);
}

function validate(schema: z.ZodType | undefined, value: unknown): unknown {
  if (schema === undefined) return undefined;
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new AppError('validation_failed', {
    details: {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    },
  });
}

function reply(c: Context<AppEnv>, spec: RouteSpec, result: unknown): Response {
  const { response } = spec;
  if (!('safeParse' in response)) {
    if (!(result instanceof Uint8Array)) throw new Error(`${spec.path} must reply with bytes`);
    // A copy, so the reply owns a plain ArrayBuffer whatever the handler's bytes sit on.
    return c.body(new Uint8Array(result), 200, { 'Content-Type': response.contentType });
  }
  // Unknown fields are dropped, and a reply that doesn't fit its schema never leaves.
  const parsed = response.safeParse(result);
  if (!parsed.success) {
    c.get('logger').error('reply.invalid', {
      route: `${spec.method} ${spec.path}`,
      issues: parsed.error.issues.map((issue) => issue.path.map(String).join('.')),
    });
    throw new AppError('internal');
  }
  return c.json(parsed.data as object);
}
