import { z } from 'zod';

// Every error reply has one shape: { error: { code, message, details } }.
// The codes are a closed union; each has the HTTP status the backend answers with.
const STATUS = {
  validation_failed: 422,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  payload_too_large: 413,
  unsupported_media_type: 415,
  misdirected: 421,
  internal: 500,
  // The web app's own code, when the backend can't be reached or answers with no JSON.
  upstream_unavailable: 502,
} as const;

export type ErrorCode = keyof typeof STATUS;

export const ERROR_CODES = Object.keys(STATUS) as [ErrorCode, ...ErrorCode[]];

export const ErrorBodySchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type ErrorBody = z.infer<typeof ErrorBodySchema>;

export function statusOf(code: ErrorCode): number {
  return STATUS[code];
}
