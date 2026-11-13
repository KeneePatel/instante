import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ErrorBodySchema, statusOf } from './errors.ts';

describe('the one error shape', () => {
  it('parses { error: { code, message, details } }', () => {
    const body = {
      error: {
        code: 'validation_failed',
        message: 'Check the form.',
        details: { name: 'required' },
      },
    };
    expect(ErrorBodySchema.parse(body)).toEqual(body);
  });

  it('allows details to be left out', () => {
    expect(
      ErrorBodySchema.safeParse({ error: { code: 'not_found', message: 'No.' } }).success,
    ).toBe(true);
  });

  it('refuses a code that is not in the union', () => {
    const result = ErrorBodySchema.safeParse({ error: { code: 'teapot', message: 'No.' } });
    expect(result.success).toBe(false);
  });

  it('includes upstream_unavailable, which the web app uses when the backend cannot answer', () => {
    expect(ERROR_CODES).toContain('upstream_unavailable');
  });
});

describe('statusOf', () => {
  it.each([
    ['validation_failed', 422],
    ['unauthenticated', 401],
    ['forbidden', 403],
    ['not_found', 404],
    ['payload_too_large', 413],
    ['unsupported_media_type', 415],
    ['misdirected', 421],
    ['internal', 500],
    ['upstream_unavailable', 502],
  ] as const)('maps %s to %i', (code, status) => {
    expect(statusOf(code)).toBe(status);
  });
});
