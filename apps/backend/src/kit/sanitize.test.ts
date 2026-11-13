import { request as httpRequest, createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { AppError } from './errors.ts';
import { MAX_DEPTH, MAX_FRAMES, MAX_STRING, REDACTED, UNREADABLE, sanitize } from './sanitize.ts';

/** An error shaped as `pg` raises one for a duplicate key, with personal data in it. */
function uniqueViolation(): Error {
  return Object.assign(
    new Error('duplicate key value violates unique constraint "users_email_key"'),
    {
      length: 214,
      severity: 'ERROR',
      code: '23505',
      detail: 'Key (email)=(jordan@example.com) already exists.',
      hint: undefined,
      where: 'SQL statement "INSERT INTO users VALUES (\'jordan@example.com\')"',
      schema: 'public',
      table: 'users',
      column: undefined,
      constraint: 'users_email_key',
      file: 'nbtinsert.c',
      line: '666',
      routine: '_bt_check_unique',
    },
  );
}

const SUMMARY = {
  name: 'DatabaseError',
  code: '23505',
  constraint: 'users_email_key',
  table: 'users',
};

/** Drizzle's wrapper: its message spells out the query's parameters. */
class QueryError extends Error {
  readonly query: string;
  readonly params: unknown[];

  constructor(query: string, params: unknown[], cause?: unknown) {
    super(`Failed query: ${query}\nparams: ${params.join(',')}`, { cause });
    this.query = query;
    this.params = params;
  }
}

const json = (value: unknown) => JSON.stringify(sanitize(value));
const anyFrames: unknown = expect.arrayContaining([expect.stringMatching(/^at .*:\d+:\d+\)?$/)]);

describe('sanitize', () => {
  describe('database errors', () => {
    it('keep only the code, constraint and table', () => {
      expect(sanitize(uniqueViolation())).toEqual(SUMMARY);
    });

    it('keep only the code when that is all there is', () => {
      const error = Object.assign(new Error('invalid input syntax for type uuid: "jordan"'), {
        severity: 'ERROR',
        code: '22P02',
      });
      expect(sanitize(error)).toEqual({ name: 'DatabaseError', code: '22P02' });
    });

    it('leave a wrapper its own name, code and stack, but withhold its message', () => {
      const wrapped = new QueryError(
        'insert into users values ($1)',
        ['jordan@example.com'],
        uniqueViolation(),
      );
      expect(sanitize(wrapped)).toEqual({
        name: 'Error',
        message: '[withheld: it quotes the query parameters]',
        stack: anyFrames,
        cause: SUMMARY,
      });
      const rethrown = new Error('saving failed: duplicate key "jordan@example.com"', {
        cause: wrapped,
      });
      expect(sanitize(rethrown)).toMatchObject({
        message: "[withheld: it can repeat the database's message]",
        cause: { cause: SUMMARY },
      });
      expect(json({ error: rethrown })).not.toMatch(/jordan/);
    });

    it('leave an AppError wrapping one its own code and message, which are ours', () => {
      const error = new AppError('internal', { cause: uniqueViolation() });
      expect(sanitize(error)).toEqual({
        name: 'AppError',
        message: 'Something went wrong.',
        code: 'internal',
        stack: anyFrames,
        cause: SUMMARY,
      });
    });

    it.each([
      ['a system error', { code: 'ECONNREFUSED' }],
      ['a four-character code', { code: '2350', severity: 'ERROR' }],
      ['a lower-case code', { code: 'abcde', severity: 'ERROR' }],
      ['a SQLSTATE without a severity', { code: '23505' }],
    ])('are told apart from %s', (_case, fields) => {
      const error = Object.assign(new Error('connect failed at /tmp/.s.PGSQL.5432'), fields);
      expect(sanitize(error)).toMatchObject({
        name: 'Error',
        message: 'connect failed at /tmp/.s.PGSQL.5432',
        code: fields.code,
      });
    });
  });

  describe('credentials, by name', () => {
    it('redacts Authorization and Cookie in any case, at any depth', () => {
      const request = {
        headers: {
          Authorization: 'Bearer abc.def.ghi',
          cookie: 'sb-x-auth-token=v',
          accept: '*/*',
        },
        nested: [{ 'set-cookie': 'a=b', 'PROXY-AUTHORIZATION': 'Basic Zm9v' }],
      };
      expect(sanitize(request)).toEqual({
        headers: { Authorization: REDACTED, cookie: REDACTED, accept: '*/*' },
        nested: [{ 'set-cookie': REDACTED, 'PROXY-AUTHORIZATION': REDACTED }],
      });
    });

    it('redacts them in Headers and Map objects', () => {
      const headers = new Headers({ authorization: 'Bearer t0ken', 'content-type': 'text/plain' });
      expect(sanitize(headers)).toEqual({ authorization: REDACTED, 'content-type': 'text/plain' });
      expect(sanitize(new Map([['Cookie', 'a=b']]))).toEqual({ Cookie: REDACTED });
    });

    it('redacts every other credential field, simple or compound', () => {
      const names = [
        'access_token',
        'refreshToken',
        'apiKey',
        'x-api-key',
        'anthropicApiKey',
        'ANTHROPIC_API_KEY',
        'password',
        'userPassword',
        'passwd',
        'secret',
        'client_secret',
        'private_key',
        'token_hash',
        'databaseUrl',
        'DATABASE_URL',
        'connectionString',
        'sb-abcd1234-auth-token',
        'sb-abcd1234-auth-token.0',
      ];
      const clean = sanitize(Object.fromEntries(names.map((n) => [n, 'value']))) as object;
      expect(Object.values(clean)).toEqual(names.map(() => REDACTED));
    });

    it('keeps fields that only resemble a credential', () => {
      const fields = { input_tokens: 812, tokens: 3, cookieArrived: true, author: 'me', key: 'k' };
      expect(sanitize(fields)).toEqual(fields);
    });

    it('redacts by name in name/value lists, such as rawHeaders and header pairs', () => {
      const rawHeaders = [
        'Authorization',
        'Bearer x',
        'X-Api-Key',
        'sk-ant-api03-ZZ',
        'Proxy-Authorization',
        'Basic dXNlcjpwYXNz',
        'Cookie',
        'app_session=s3cr3t',
        'Accept',
        '*/*',
      ];
      expect(sanitize(rawHeaders)).toEqual([
        'Authorization',
        REDACTED,
        'X-Api-Key',
        REDACTED,
        'Proxy-Authorization',
        REDACTED,
        'Cookie',
        REDACTED,
        'Accept',
        '*/*',
      ]);
      expect(
        sanitize([
          ['cookie', 'a=b'],
          ['accept', 'x'],
        ]),
      ).toEqual([
        ['cookie', REDACTED],
        ['accept', 'x'],
      ]);
      expect(sanitize(['Cookie', 'a=b', 'c'])).toEqual(['Cookie', 'a=b', 'c']);
      expect(sanitize(['the password', 'hunter2'])).toEqual(['the password', REDACTED]);
    });

    it("leaves nothing of a real request's credentials", async () => {
      const seen = new Promise<IncomingMessage>((resolve) => {
        const server = createServer((req, res) => {
          res.end();
          server.close();
          resolve(req);
        });
        server.listen(0, '127.0.0.1', () => {
          const { port } = server.address() as AddressInfo;
          httpRequest({
            host: '127.0.0.1',
            port,
            headers: {
              authorization: 'Bearer eyJhbGciOi.eyJzdWIi.c2ln',
              cookie: 'app_session=s3cr3t; sb-abcd-auth-token.0=base64-eyJ',
              'x-api-key': 'sk-ant-api03-ZZ',
            },
          }).end();
        });
      });
      const clean = json({ incoming: await seen });
      expect(clean).not.toMatch(/eyJ|s3cr3t|sk-ant/);
      expect(clean).toMatch(/"rawHeaders":\[/);
    });
  });

  describe('credentials, inside strings', () => {
    it('redacts every bearer and basic credential, whatever its characters', () => {
      const text = 'first Bearer a-b_c.d~e+f/g== then bearer XYZ.123 and Basic dXNlcjpwYXNz=, end';
      expect(sanitize(text)).toBe(
        `first Bearer ${REDACTED} then bearer ${REDACTED} and Basic ${REDACTED}, end`,
      );
    });

    it('redacts Supabase session cookies, chunked or not, and keeps the others', () => {
      const header =
        'theme=dark; sb-abcd1234-auth-token.0=base64-eyJhY2Nlc3M; sb-abcd1234-auth-token.1=Ym9i; ' +
        'sb-abcd1234-auth-token-code-verifier=dmVy';
      expect(sanitize({ header })).toEqual({
        header:
          `theme=dark; sb-abcd1234-auth-token.0=${REDACTED}; sb-abcd1234-auth-token.1=${REDACTED}; ` +
          `sb-abcd1234-auth-token-code-verifier=${REDACTED}`,
      });
    });

    it("redacts a URL's password, and token parameters", () => {
      const url = 'postgresql://instante_app:s3cret@/instante?host=%2Fx%2Frun';
      expect(sanitize(url)).toBe(`postgresql://instante_app:${REDACTED}@/instante?host=%2Fx%2Frun`);
      expect(sanitize(new URL('https://u:pw@example.com/a'))).toBe(
        `https://u:${REDACTED}@example.com/a`,
      );
      expect(
        sanitize('https://x.test/cb?access_token=a1&refresh_token=b2&state=ok#provider_token=c3'),
      ).toBe(
        `https://x.test/cb?access_token=${REDACTED}&refresh_token=${REDACTED}&state=ok#provider_token=${REDACTED}`,
      );
      expect(sanitize(new URL('https://example.com/?sb-ab-auth-token=v'))).toBe(
        `https://example.com/?sb-ab-auth-token=${REDACTED}`,
      );
    });
  });

  describe('errors', () => {
    it('keep their name, message, code, stack frames and cause, all sanitized', () => {
      const cause = Object.assign(new TypeError('x is undefined'), { headers: { cookie: 'a' } });
      const clean = sanitize(new AppError('not_found', { cause }));
      expect(clean).toEqual({
        name: 'AppError',
        message: 'Not found.',
        code: 'not_found',
        stack: anyFrames,
        cause: { name: 'TypeError', message: 'x is undefined', stack: anyFrames },
      });
      expect((clean as { cause: unknown }).cause).not.toBeInstanceOf(Error);
    });

    it('clean their message, name and code like any string', () => {
      const error = Object.assign(new Error(`sent Bearer abc ${'x'.repeat(MAX_STRING)}`), {
        code: 'E: Bearer tok',
      });
      error.name = 'Bearer eyJ.a.b';
      const clean = sanitize(error) as Record<string, string>;
      expect(clean['message']).toMatch(new RegExp(`^sent Bearer \\[redacted\\] x+… \\[\\d+ more`));
      expect(clean['name']).toBe(`Bearer ${REDACTED}`);
      expect(clean['code']).toBe(`E: Bearer ${REDACTED}`);
    });

    it("withhold JSON.parse's message, which quotes its input", () => {
      let thrown: unknown;
      try {
        JSON.parse('jordan@example.com');
      } catch (error) {
        thrown = error;
      }
      expect((thrown as Error).message).toMatch(/jordan/);
      expect(sanitize(thrown)).toMatchObject({
        name: 'SyntaxError',
        message: '[withheld: it can quote its input]',
      });
      expect(json(thrown)).not.toMatch(/jordan/);
    });

    it("withhold a failed query's message and drop its parameters, whatever the cause", () => {
      const lost = new QueryError(
        'select 1',
        ['jordan@example.com'],
        new Error('Connection ended'),
      );
      expect(sanitize(lost)).toEqual({
        name: 'Error',
        message: '[withheld: it quotes the query parameters]',
        stack: anyFrames,
        cause: { name: 'Error', message: 'Connection ended', stack: anyFrames },
      });
    });

    it('keep only real frames, so a withheld message never returns through the stack', () => {
      const lost = new QueryError('insert ($1)', ['Toronto\n    at Acme Corp, jordan@example.com']);
      expect(json(lost)).not.toMatch(/jordan|Acme/);
      const frames = (sanitize(lost) as { stack: string[] }).stack;
      for (const frame of frames) expect(frame).toMatch(/^at .*:\d+:\d+\)?$/);
      const lookalike = new QueryError('insert ($1)', ['x\n    at jordan@example.com (/a.ts:1:2)']);
      expect(json(lookalike)).not.toMatch(/jordan/);
    });

    it(`clean each frame and keep at most ${String(MAX_FRAMES)}`, () => {
      expect(MAX_FRAMES).toBe(10);
      const error = new Error('deep');
      error.stack = [
        'Error: deep',
        '    at Bearer abc (/app/a.ts:1:2)',
        ...Array.from({ length: 14 }, (_, i) => `    at f${String(i)} (/app/b.ts:${String(i)}:1)`),
      ].join('\n');
      const frames = (sanitize(error) as { stack: string[] }).stack;
      expect(frames).toHaveLength(10);
      expect(frames[0]).toBe(`at Bearer ${REDACTED} (/app/a.ts:1:2)`);
    });

    it('sanitize every error inside an AggregateError', () => {
      const error = new AggregateError(
        [new Error('a'), Object.assign(new Error('b'), { severity: 'ERROR', code: '23505' })],
        'both failed',
      );
      const clean = sanitize(error) as { errors: unknown[] };
      expect(clean.errors).toEqual([
        { name: 'Error', message: 'a', stack: anyFrames },
        { name: 'DatabaseError', code: '23505' },
      ]);
      expect(clean.errors[0]).not.toBeInstanceOf(Error);
    });
  });

  describe('everything else', () => {
    it('turns values into plain JSON data', () => {
      expect(
        sanitize({
          when: new Date('2026-11-13T16:00:00.000Z'),
          never: new Date(Number.NaN),
          big: 10n,
          url: new URL('https://example.com/a?b=c'),
          tags: new Set(['x']),
          skip: undefined,
          run: () => 1,
          n: null,
          ok: true,
        }),
      ).toEqual({
        when: '2026-11-13T16:00:00.000Z',
        never: 'Invalid Date',
        big: '10',
        url: 'https://example.com/a?b=c',
        tags: ['x'],
        skip: undefined,
        run: undefined,
        n: null,
        ok: true,
      });
    });

    it('keeps only the size of bytes, never their contents', () => {
      const bytes = new TextEncoder().encode('%PDF-1.7 Jordan Rivera');
      expect(sanitize({ upload: bytes, raw: bytes.buffer })).toEqual({
        upload: '[22 bytes]',
        raw: '[22 bytes]',
      });
    });

    it('cuts strings at 2000 characters', () => {
      expect(MAX_STRING).toBe(2000);
      expect(sanitize('a'.repeat(2005))).toBe(`${'a'.repeat(2000)}… [5 more characters]`);
      expect(sanitize('a'.repeat(2000))).toBe('a'.repeat(2000));
    });

    it('marks a circular reference, but writes a shared one in full', () => {
      const shared = { id: 1 };
      const loop: Record<string, unknown> = { shared, again: shared };
      loop['self'] = loop;
      expect(sanitize(loop)).toEqual({ shared: { id: 1 }, again: { id: 1 }, self: '[circular]' });
    });

    it('stops at a depth of 8, counting objects, arrays and causes alike', () => {
      expect(MAX_DEPTH).toBe(8);
      const objects = (levels: number): unknown =>
        levels === 0 ? 'bottom' : { d: objects(levels - 1) };
      const arrays = (levels: number): unknown => (levels === 0 ? 'bottom' : [arrays(levels - 1)]);
      const causes = (levels: number): unknown =>
        levels === 0 ? 'bottom' : new Error('e', { cause: causes(levels - 1) });
      for (const nest of [objects, arrays, causes]) {
        expect(json(nest(8))).toMatch(/bottom/);
        expect(json(nest(9))).toMatch(/\[too deep\]/);
        expect(json(nest(9))).not.toMatch(/bottom/);
      }
    });

    it('never throws, however odd the value', () => {
      const getter = {
        ok: 1,
        get boom(): never {
          throw new Error('boom');
        },
      };
      expect(sanitize(getter)).toEqual({ ok: 1, boom: UNREADABLE });
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      expect(sanitize({ proxy })).toEqual({ proxy: UNREADABLE });
      expect(sanitize(new Map([[Object.create(null) as object, 1]]))).toEqual({ [UNREADABLE]: 1 });
      const odd = new Error('x');
      Object.defineProperty(odd, 'message', { value: 42 });
      Object.defineProperty(odd, 'stack', { value: { not: 'a string' } });
      expect(sanitize(odd)).toEqual({ name: 'Error', message: UNREADABLE });
      const named = new Error('y');
      Object.defineProperty(named, 'name', { value: 10n });
      expect(sanitize(named)).toMatchObject({ name: 'Error', message: 'y' });
    });
  });
});
