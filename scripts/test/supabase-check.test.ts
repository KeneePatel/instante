import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// scripts/supabase-check.sh (A1) against a stub of Supabase's auth server and of Instante's
// `/api/me`, with a `curl` on PATH that logs its command line before running the real one.

const SCRIPT = fileURLToPath(new URL('../supabase-check.sh', import.meta.url));
const BASH = existsSync('/bin/bash') ? '/bin/bash' : 'bash';
const REAL_CURL = execFileSync(BASH, ['-c', 'command -v curl'], { encoding: 'utf8' }).trim();

const EMAIL = 'jordan@example.com';
const SUB = '6f1c2a90-0000-4000-8000-00000000a001';
const CODE = '12345678';
const TOTP = '123456';
const SECRET = 'JBSWY3DPEHPK3PXP';
const KEY = 'sb_publishable_test-key';

/** An unsigned token whose payload holds the claims; the script reads claims without verifying. */
function token(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'ES256', typ: 'JWT' })}.${part(claims)}.c2lnbmF0dXJl`;
}
const AAL1 = token({ sub: SUB, aal: 'aal1', role: 'authenticated', email: EMAIL });
const AAL2 = token({ sub: SUB, aal: 'aal2', role: 'authenticated', email: EMAIL });

type Factor = { id: string; factor_type: string; status: 'verified' | 'unverified' };
interface Stub {
  otp?: Reply;
  factors?: Factor[];
  /** The token the authenticator step returns. */
  afterTotp?: string;
  /** What `/api/me` answers to an `aal2` token. */
  me?: { status: number; body: unknown };
}
interface Seen {
  method: string;
  path: string;
  apikey: string | undefined;
  authorization: string | undefined;
  body: unknown;
}
interface Reply {
  status: number;
  body?: unknown;
  /** A reply that isn't JSON, sent as it is. */
  raw?: string;
}

const made: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

async function readBody(req: IncomingMessage): Promise<unknown> {
  let text = '';
  for await (const chunk of req) text += String(chunk);
  return text === '' ? undefined : JSON.parse(text);
}

const FACTOR = 'f0000000-0000-4000-8000-0000000000e1';
const CHALLENGE = 'c0000000-0000-4000-8000-0000000000c1';

/** What the stub answers: Supabase's auth server under `/auth/v1`, and Instante's `/api/me`. */
function answer(options: Stub, seen: Seen): Reply {
  const bearer = seen.authorization?.replace(/^Bearer /, '');
  const [route] = `${seen.method} ${seen.path}`.split('?');
  if (route === 'POST /auth/v1/otp') return options.otp ?? { status: 200, body: {} };
  if (route === 'POST /auth/v1/verify') {
    const { token: code } = seen.body as { token: string };
    if (code === CODE)
      return { status: 200, body: { access_token: AAL1, refresh_token: 'refresh-1' } };
    return {
      status: 403,
      body: { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' },
    };
  }
  if (route === 'POST /auth/v1/logout') return { status: 204 };
  if (route === 'GET /api/me') {
    if (bearer !== AAL2) {
      return {
        status: 401,
        body: { error: { code: 'unauthenticated', message: 'Sign in again.', details: {} } },
      };
    }
    return options.me ?? { status: 200, body: { id: 'acct-1', email: EMAIL } };
  }
  if (bearer !== AAL1) return { status: 401, body: { msg: 'not signed in' } };
  if (route === 'GET /auth/v1/user') {
    return { status: 200, body: { id: SUB, email: EMAIL, factors: options.factors ?? [] } };
  }
  if (route === 'POST /auth/v1/factors') {
    return {
      status: 200,
      body: {
        id: FACTOR,
        type: 'totp',
        friendly_name: 'Authenticator app',
        totp: {
          qr_code: 'data:image/svg+xml;...',
          secret: SECRET,
          uri: `otpauth://totp/Instante:${EMAIL}`,
        },
      },
    };
  }
  const factor = /^(DELETE|POST) \/auth\/v1\/factors\/([0-9a-f-]+)(\/challenge|\/verify)?$/.exec(
    route ?? '',
  );
  if (factor?.[1] === 'DELETE' && !factor[3]) return { status: 200, body: { id: factor[2] } };
  if (factor?.[3] === '/challenge') return { status: 200, body: { id: CHALLENGE, type: 'totp' } };
  if (factor?.[3] === '/verify') {
    const { challenge_id, code } = seen.body as { challenge_id: string; code: string };
    if (challenge_id === CHALLENGE && code === TOTP) {
      return {
        status: 200,
        body: { access_token: options.afterTotp ?? AAL2, refresh_token: 'refresh-2' },
      };
    }
    return {
      status: 422,
      body: { code: 422, error_code: 'mfa_verification_failed', msg: 'Invalid TOTP code entered' },
    };
  }
  return { status: 404, body: { msg: `no stub for ${route ?? ''}` } };
}

async function stub(options: Stub = {}): Promise<{ base: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    void readBody(req).then((body) => {
      const request: Seen = {
        method: req.method ?? '',
        path: req.url ?? '/',
        apikey: typeof req.headers.apikey === 'string' ? req.headers.apikey : undefined,
        authorization: req.headers.authorization,
        body,
      };
      seen.push(request);
      const reply = answer(options, request);
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(reply.raw ?? (reply.body === undefined ? '' : JSON.stringify(reply.body)));
    });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${String(port)}`, seen };
}

/** Runs the script with these lines on its standard input. */
async function run(lines: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), 'instante-supabase-'));
  made.push(dir);
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const argv = path.join(dir, 'curl-argv.log');
  writeFileSync(
    path.join(bin, 'curl'),
    `#!/bin/bash\nprintf '%s\\n' "$*" >> '${argv}'\nexec '${REAL_CURL}' "$@"\n`,
  );
  chmodSync(path.join(bin, 'curl'), 0o755);
  const child = spawn(BASH, [SCRIPT], {
    env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => (stdout += String(d)));
  child.stderr.on('data', (d: Buffer) => (stderr += String(d)));
  child.stdin.end(lines.map((line) => `${line}\n`).join(''));
  const status = await new Promise<number | null>((done) => child.on('close', done));
  const curlArgv = existsSync(argv) ? readFileSync(argv, 'utf8') : '';
  return { status, stdout, stderr, output: stdout + stderr, curlArgv };
}

const answers = (base: string, instante = '') => [base, KEY, EMAIL, instante, CODE, TOTP];

describe('supabase-check.sh', () => {
  it('signs in by email code at aal1, enrols an authenticator, and reaches aal2', async () => {
    const unfinished = 'a0000000-0000-4000-8000-0000000000b1';
    const { base, seen } = await stub({
      factors: [{ id: unfinished, factor_type: 'totp', status: 'unverified' }],
    });
    const result = await run(answers(base));
    expect(result.stderr).not.toContain('supabase-check:');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      `user id: ${SUB}\nafter the email code: aal1\nafter the authenticator: aal2\n`,
    );
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /auth/v1/otp',
      'POST /auth/v1/verify',
      'GET /auth/v1/user',
      `DELETE /auth/v1/factors/${unfinished}`,
      'POST /auth/v1/factors',
      `POST /auth/v1/factors/${FACTOR}/challenge`,
      `POST /auth/v1/factors/${FACTOR}/verify`,
      'POST /auth/v1/logout?scope=local',
    ]);
    // A code goes only to an existing user, and the email code is verified as one.
    expect(seen[0]?.body).toEqual({ email: EMAIL, create_user: false });
    expect(seen[1]?.body).toEqual({ type: 'email', email: EMAIL, token: CODE });
    expect(seen[4]?.body).toEqual({
      factor_type: 'totp',
      friendly_name: 'Authenticator app',
      issuer: 'Instante',
    });
    expect(seen[6]?.body).toEqual({
      challenge_id: CHALLENGE,
      code: TOTP,
    });
    expect(seen.every((r) => r.apikey === KEY)).toBe(true);
    expect(seen.at(-1)?.authorization).toBe(`Bearer ${AAL2}`);
    // The authenticator's key is shown once, for the owner to add.
    expect(result.stderr).toContain(SECRET);
  });

  it('never prints a token, and puts no token or code on a command line', async () => {
    const { base } = await stub();
    const result = await run(answers(base, ''));
    expect(result.status).toBe(0);
    for (const secret of [AAL1, AAL2, 'refresh-1', 'refresh-2'])
      expect(result.output).not.toContain(secret);
    expect(result.curlArgv.trim().split('\n')).toHaveLength(7);
    for (const secret of [AAL1, AAL2, CODE, TOTP, EMAIL, KEY])
      expect(result.curlArgv).not.toContain(secret);
  });

  it('uses a verified authenticator without enrolling another', async () => {
    const verified = 'b0000000-0000-4000-8000-0000000000a2';
    const { base, seen } = await stub({
      factors: [{ id: verified, factor_type: 'totp', status: 'verified' }],
    });
    const result = await run(answers(base));
    expect(result.status).toBe(0);
    expect(seen.some((r) => r.method === 'POST' && r.path === '/auth/v1/factors')).toBe(false);
    expect(seen.map((r) => r.path)).toContain(`/auth/v1/factors/${verified}/verify`);
    expect(result.stderr).not.toContain(SECRET);
  });

  it('refuses the secret key, a service-role key and other keys before any request', async () => {
    const { base, seen } = await stub();
    const serviceRole = token({ role: 'service_role', iss: 'supabase' });
    for (const [key, said] of [
      ['sb_secret_abc', "that's the secret key"],
      [serviceRole, "that key's role is 'service_role'"],
      ['abc', "doesn't look like a publishable key"],
    ] as const) {
      const result = await run([base, key, EMAIL, '', CODE, TOTP]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(said);
    }
    const anon = token({ role: 'anon', iss: 'supabase' });
    expect((await run([base, anon, EMAIL, '', CODE, TOTP])).status).toBe(0);
    expect(seen.filter((r) => r.path === '/auth/v1/otp')).toHaveLength(1);
  });

  it('refuses plain http to another machine, an address with a path, and a malformed email', async () => {
    for (const [lines, said] of [
      [['http://example.com', KEY, EMAIL, ''], "isn't an https:// address"],
      [['https://abc.supabase.co/rest/v1', KEY, EMAIL, ''], 'should be just the address'],
      [['https://abc.supabase.co', KEY, 'jordan', ''], "isn't an email address"],
      [
        ['https://abc.supabase.co', KEY, EMAIL, 'http://192.168.1.4:4310'],
        "isn't an https:// address",
      ],
    ] as const) {
      const result = await run([...lines]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(said);
      expect(result.curlArgv).toBe('');
    }
  });

  it("stops with Supabase's own message when it refuses", async () => {
    const limited = await stub({
      otp: { status: 429, body: { code: 429, msg: 'email rate limit exceeded' } },
    });
    const tooMany = await run(answers(limited.base));
    expect(tooMany.status).toBe(1);
    expect(tooMany.stderr).toContain('email rate limit exceeded');
    expect(tooMany.stderr).toContain('2 an hour');

    const proxy = await stub({ otp: { status: 502, raw: '<html>Bad gateway</html>' } });
    const notJson = await run(answers(proxy.base));
    expect(notJson.status).toBe(1);
    expect(notJson.stderr).toContain("didn't send a code (HTTP 502): <html>Bad gateway</html>");

    const { base } = await stub();
    const wrong = await run([base, KEY, EMAIL, '', '87654321', TOTP]);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain(
      "didn't take the code (HTTP 403): Token has expired or is invalid",
    );

    const badTotp = await run([base, KEY, EMAIL, '', CODE, '654321']);
    expect(badTotp.status).toBe(1);
    expect(badTotp.stderr).toContain('(HTTP 422): Invalid TOTP code entered');
  });

  it("checks the codes' lengths before sending them", async () => {
    const { base, seen } = await stub();
    const short = await run([base, KEY, EMAIL, '', '123456', TOTP]);
    expect(short.status).toBe(1);
    expect(short.stderr).toContain('should be 8 digits');
    expect(seen.some((r) => r.path === '/auth/v1/verify')).toBe(false);
    const totp = await run([base, KEY, EMAIL, '', CODE, '12345']);
    expect(totp.status).toBe(1);
    expect(totp.stderr).toContain("authenticator's code is 6 digits");
  });

  it("prints Instante's answer to each token, without Supabase's key", async () => {
    const { base, seen } = await stub();
    const known = await run(answers(base, base));
    expect(known.status).toBe(0);
    expect(known.stdout).toContain('Instante, an aal1 token: HTTP 401 unauthenticated\n');
    expect(known.stdout).toContain('Instante, an aal2 token: HTTP 200 account acct-1\n');
    const asked = seen.filter((r) => r.path === '/api/me');
    expect(asked.map((r) => r.authorization)).toEqual([`Bearer ${AAL1}`, `Bearer ${AAL2}`]);
    expect(asked.every((r) => r.apikey === undefined)).toBe(true);

    const unknown = await stub({
      me: { status: 403, body: { error: { code: 'unknown_account', message: '', details: {} } } },
    });
    const refused = await run(answers(unknown.base, unknown.base));
    expect(refused.stdout).toContain('Instante, an aal2 token: HTTP 403 unknown_account\n');
  });

  it("fails when the authenticator step doesn't reach aal2", async () => {
    const { base } = await stub({ afterTotp: AAL1 });
    const result = await run(answers(base));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('after the authenticator: aal1');
    expect(result.stderr).toContain("didn't reach aal2");
  });
});
