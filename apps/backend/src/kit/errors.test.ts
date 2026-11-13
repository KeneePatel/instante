import { ERROR_CODES, ErrorBodySchema, statusOf } from '@instante/contract';
import { describe, expect, it } from 'vitest';
import { AppError, errorReply } from './errors.ts';

describe('AppError', () => {
  it.each(ERROR_CODES)('gives %s its status and a plain message', (code) => {
    const error = new AppError(code);
    expect(error.status).toBe(statusOf(code));
    expect(error.message).toMatch(/^[A-Z].*\.$/);
    expect(ErrorBodySchema.parse(error.toBody())).toStrictEqual({
      error: { code, message: error.message },
    });
    expect(error.toBody().error).not.toHaveProperty('details');
  });

  it('takes its own message, details and cause', () => {
    const cause = new Error('row missing');
    const error = new AppError('not_found', {
      message: 'No such job.',
      details: { id: 'j_8k2m4q7r' },
      cause,
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AppError');
    expect(error.cause).toBe(cause);
    expect(error.toBody()).toEqual({
      error: { code: 'not_found', message: 'No such job.', details: { id: 'j_8k2m4q7r' } },
    });
  });
});

describe('errorReply', () => {
  it('answers an AppError with its own status and body', () => {
    expect(errorReply(new AppError('forbidden'))).toEqual({
      status: 403,
      body: { error: { code: 'forbidden', message: 'This is not allowed.' } },
    });
  });

  it.each([
    ['an Error', new Error('duplicate key value: jordan@example.com')],
    [
      'a look-alike of an AppError',
      Object.assign(new Error('jordan@example.com'), {
        code: 'forbidden',
        status: 403,
        toBody: () => ({ error: { code: 'forbidden', message: 'jordan@example.com' } }),
      }),
    ],
    ['a string', 'boom'],
    ['undefined', undefined],
  ])('answers %s with a plain 500 that repeats nothing of it', (_case, thrown) => {
    const reply = errorReply(thrown);
    expect(reply).toEqual({
      status: 500,
      body: { error: { code: 'internal', message: 'Something went wrong.' } },
    });
  });
});
