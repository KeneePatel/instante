import { z } from 'zod';
import { defineRoute, fileResponse, rawBody } from './define-route.ts';

// Registered only with INSTANTE_ENV=test, to prove the walking skeleton's checks
// (docs/specs/platform.md). Production refuses to start with them.

export const EchoResponseSchema = z.object({
  /** A SHA-256 of the Authorization header as it arrived, or null without one. */
  authorizationSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  /** Whether a Cookie header reached the backend before it was dropped. */
  cookieArrived: z.boolean(),
  bodyBytes: z.number().int().nonnegative(),
});

const ok = z.object({ ok: z.literal(true) });

export const testRoutes = {
  userOnly: defineRoute({
    method: 'GET',
    path: '/api/test/user-only',
    auth: 'user',
    response: ok,
    errors: ['unauthenticated'],
  }),
  echo: defineRoute({
    method: 'POST',
    path: '/api/test/echo',
    auth: 'public',
    body: rawBody,
    maxBodyBytes: 5 * 1024 * 1024,
    response: EchoResponseSchema,
    errors: ['payload_too_large'],
  }),
  slow: defineRoute({
    method: 'GET',
    path: '/api/test/slow',
    auth: 'public',
    query: z.object({ seconds: z.coerce.number().int().min(0).max(60) }),
    response: ok,
    errors: [],
  }),
  filePdf: defineRoute({
    method: 'GET',
    path: '/api/test/file.pdf',
    auth: 'public',
    response: fileResponse('application/pdf'),
    errors: [],
  }),
} as const;
