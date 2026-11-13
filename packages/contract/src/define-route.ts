import type { z } from 'zod';
import type { ErrorCode } from './errors.ts';

// One entry per route: method, path, auth, request schemas, the reply's schema and the
// error codes it can answer with. The backend registers handlers only from these
// entries, and the web app calls the backend only through them (ADR-005).

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type Method = (typeof METHODS)[number];

/** Required on every route: `registerRoutes` fails closed without it. */
export type Auth = 'public' | 'user';
const AUTH: readonly string[] = ['public', 'user'];

/** A body taken as bytes, not parsed as JSON. */
export interface RawBody {
  readonly kind: 'raw';
}
/** A reply that is a file, which the web app reads as a `Blob`. */
export interface FileResponse {
  readonly kind: 'file';
  readonly contentType: string;
}

export const rawBody: RawBody = { kind: 'raw' };
export function fileResponse(contentType: string): FileResponse {
  return { kind: 'file', contentType };
}

export interface RouteSpec {
  readonly method: Method;
  readonly path: `/api/${string}`;
  readonly auth: Auth;
  readonly params?: z.ZodType;
  readonly query?: z.ZodType;
  readonly body?: z.ZodType | RawBody;
  /** The largest body this route accepts, checked before it's read. */
  readonly maxBodyBytes?: number;
  readonly response: z.ZodType | FileResponse;
  readonly errors: readonly ErrorCode[];
}

/**
 * Declares a route. The types make `auth`, the path's `/api/` prefix and the reply's
 * schema mandatory; the same rules are checked at run time, so nothing typed loosely
 * slips through.
 */
export function defineRoute<const S extends RouteSpec>(spec: S): S {
  if (!AUTH.includes(spec.auth)) {
    throw new Error(`defineRoute: ${spec.path} must declare auth as 'public' or 'user'`);
  }
  if (!(METHODS as readonly string[]).includes(spec.method)) {
    throw new Error(`defineRoute: ${spec.path} has an unknown method`);
  }
  if (!spec.path.startsWith('/api/')) {
    throw new Error(`defineRoute: ${spec.path} must start with /api/`);
  }
  if (
    spec.maxBodyBytes !== undefined &&
    !(Number.isInteger(spec.maxBodyBytes) && spec.maxBodyBytes > 0)
  ) {
    throw new Error(`defineRoute: ${spec.path} needs maxBodyBytes as a positive whole number`);
  }
  return spec;
}

type Infer<T> = T extends z.ZodType ? z.infer<T> : undefined;

export type ParamsOf<S extends RouteSpec> = Infer<S['params']>;
export type QueryOf<S extends RouteSpec> = Infer<S['query']>;
export type BodyOf<S extends RouteSpec> = S['body'] extends RawBody ? Uint8Array : Infer<S['body']>;
export type ResponseOf<S extends RouteSpec> = S['response'] extends FileResponse
  ? Blob
  : Infer<S['response']>;
