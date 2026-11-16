import {
  ErrorBodySchema,
  statusOf,
  type BodyOf,
  type ErrorCode,
  type FileResponse,
  type ParamsOf,
  type QueryOf,
  type RawBody,
  type ResponseOf,
  type RouteSpec,
} from '@instante/contract';

// The typed fetch helper (docs/specs/platform.md, "The typed fetch helper"; ADR-005): every call
// to the backend goes through the contract's route table. The browser calls its own origin's
// /api, which the web app rewrites to the backend; a Server Component calls the backend itself,
// at the address the build has. No cookie ever goes: the session travels as a bearer token.

/** What a page shows when the backend can't be reached or answers with no sense. */
export const UNREACHABLE = "Instante can't reach its server right now.";

/** A call that failed: one of the contract's error codes, with the reply's status for the
 * contract's own errors, and 502 for `upstream_unavailable`. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { status?: number; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = 'ApiError';
    this.code = code;
    this.status = options.status ?? statusOf(code);
    this.details = options.details;
  }
}

/** The person's access token, or null without a session: `accounts` fills it in. */
export type TokenProvider = () => Promise<string | null>;

/** A route's inputs: each one it declares, and none it doesn't. */
type Field<K extends string, T> = [T] extends [undefined] ? { [P in K]?: never } : { [P in K]: T };
export type CallInput<S extends RouteSpec> = Field<'params', ParamsOf<S>> &
  Field<'query', QueryOf<S>> &
  Field<'body', BodyOf<S>> & { signal?: AbortSignal };

/** Calls one route. The input may be left out when the route needs none. */
export type Api = <const S extends RouteSpec>(
  route: S,
  ...input: object extends CallInput<S> ? [input?: CallInput<S>] : [input: CallInput<S>]
) => Promise<ResponseOf<S>>;

/** The backend's address as this build has it (next.config.ts), for a Server Component's calls:
 * always the one the /api rewrite goes to. */
export function serverBase(): string {
  const base = process.env.INSTANTE_BUILT_BACKEND ?? '';
  if (base === '') throw new Error('This build has no backend address (BACKEND_INTERNAL_URL)');
  return base;
}

/** A helper that calls the backend at `base`: '' in the browser, its own origin, or
 * `serverBase()` on the server. */
export function createApi(options: {
  base: string;
  token?: TokenProvider;
  fetch?: typeof fetch;
}): Api {
  const send = options.fetch ?? fetch;
  return async (route, ...[input]) => {
    const { params, query, body, signal } = (input ?? {}) as {
      params?: Record<string, unknown>;
      query?: Record<string, unknown>;
      body?: unknown;
      signal?: AbortSignal;
    };
    const headers: Record<string, string> = {
      accept: isFile(route.response) ? route.response.contentType : 'application/json',
    };
    const token = (await options.token?.()) ?? null;
    if (token !== null) headers['authorization'] = `Bearer ${token}`;
    let payload: BodyInit | undefined;
    if (route.body !== undefined && body !== undefined) {
      if (isRaw(route.body)) {
        headers['content-type'] = 'application/octet-stream';
        payload = body as Uint8Array<ArrayBuffer>;
      } else {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(body);
      }
    }
    // Built before sending, so a mistake in the path or the query is thrown as itself, not as
    // "unreachable".
    const url = `${options.base}${pathOf(route, params)}${queryOf(query)}`;
    let reply: Response;
    try {
      reply = await send(url, {
        method: route.method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
        credentials: 'omit',
        cache: 'no-store',
        // The backend never redirects; a redirect would come from something else.
        redirect: 'error',
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (signal?.aborted === true) throw error;
      throw unreachable(error);
    }
    try {
      return (await settle(route, reply)) as ResponseOf<typeof route>;
    } catch (error) {
      // The reply's own errors stand. A body that stops part way is the caller's abort, which
      // comes through as itself, or the connection's, which is "unreachable".
      if (error instanceof ApiError || signal?.aborted === true) throw error;
      throw unreachable(error);
    }
  };
}

/** The route's path with its `:name` parameters filled in, each encoded. A parameter that is
 * empty, `.` or `..` is refused: encoding leaves the dots, and the URL would drop or climb a
 * segment, calling another route. Only plain `:name` parameters are filled in: Hono's other
 * forms (`:name?`, `:name{pattern}`, `*`) would be sent as they are, so a path holding one is
 * refused. */
function pathOf(route: RouteSpec, params: Record<string, unknown> | undefined): string {
  if (/[?{}*]/.test(route.path)) {
    throw new Error(`${route.path} has a path form only plain :name parameters stand in for`);
  }
  return route.path.replace(/:([A-Za-z_]\w*)/g, (_, name: string) => {
    const value = params?.[name];
    const what = `${route.path}'s ${name} parameter`;
    if (value === undefined) throw new Error(`${route.path} needs its ${name} parameter`);
    const text = textOf(value, what);
    if (text === '' || text === '.' || text === '..') {
      throw new Error(`${what} can't be empty, . or ..`);
    }
    return encodeURIComponent(text);
  });
}

/** A path parameter's or query value's text: only strings, numbers and booleans have one. */
function textOf(value: unknown, what: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new Error(`${what} must be a string, a number or a boolean`);
}

/** `?name=value&…` for the query's defined values, or nothing. */
function queryOf(query: Record<string, unknown> | undefined): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value !== undefined) search.append(name, textOf(value, `the query's ${name}`));
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

/** The reply as the route promises it, or the error it carries. A 5xx, a reply that isn't the
 * route's, or an error that isn't the contract's, is `upstream_unavailable`. */
async function settle(route: RouteSpec, reply: Response): Promise<unknown> {
  if (reply.status >= 500) throw unreachable();
  if (!reply.ok) {
    const error = ErrorBodySchema.safeParse(await jsonOf(reply));
    if (!error.success) throw unreachable();
    const { code, message, details } = error.data.error;
    throw new ApiError(code, message, {
      status: reply.status,
      ...(details === undefined ? {} : { details }),
    });
  }
  if (isFile(route.response)) {
    if (essence(reply.headers.get('content-type')) !== essence(route.response.contentType)) {
      throw unreachable();
    }
    return await reply.blob();
  }
  const parsed = route.response.safeParse(await jsonOf(reply));
  if (!parsed.success) throw unreachable();
  return parsed.data;
}

/** A media type without its parameters, in lower case: `Application/PDF; x=y` is
 * `application/pdf`. */
function essence(type: string | null): string {
  return (type ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/** The reply's JSON, or undefined when it isn't JSON. A body that stops part way is thrown, not
 * taken for one that isn't JSON. */
async function jsonOf(reply: Response): Promise<unknown> {
  if (essence(reply.headers.get('content-type')) !== 'application/json') return undefined;
  const text = await reply.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function unreachable(cause?: unknown): ApiError {
  return new ApiError('upstream_unavailable', UNREACHABLE, cause === undefined ? {} : { cause });
}

/** A Zod schema parses; the contract's file and raw-body markers don't (as the backend tells
 * them apart). */
function isFile(response: RouteSpec['response']): response is FileResponse {
  return !('safeParse' in response);
}

function isRaw(body: NonNullable<RouteSpec['body']>): body is RawBody {
  return !('safeParse' in body);
}
