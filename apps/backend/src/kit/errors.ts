import { statusOf, type ErrorBody, type ErrorCode } from '@instante/contract';

// Errors are AppError(code); nothing else reaches a reply (docs/specs/platform.md).
// Any other thrown value answers 500 with the generic message, never its own.

const MESSAGES: Record<ErrorCode, string> = {
  validation_failed: 'The request is not valid.',
  unauthenticated: 'Sign in to continue.',
  forbidden: 'This is not allowed.',
  not_found: 'Not found.',
  payload_too_large: 'The request is too large.',
  unsupported_media_type: 'The request must be JSON.',
  misdirected: 'This request reached the wrong host.',
  internal: 'Something went wrong.',
  upstream_unavailable: 'Instante could not be reached.',
};

export type AppErrorOptions = {
  /** Shown to the person: never personal data, a secret or a database message. */
  message?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    super(options.message ?? MESSAGES[code], { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = statusOf(code);
    this.details = options.details;
  }

  toBody(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

/** The reply for anything thrown: an AppError's own, or a plain 500. */
export function errorReply(error: unknown): { status: number; body: ErrorBody } {
  const appError = error instanceof AppError ? error : new AppError('internal');
  return { status: appError.status, body: appError.toBody() };
}
