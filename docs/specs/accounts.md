# Spec: `accounts`, sign-in and people

**Status:** approved by the owner at the phase 2 gate, 2026-11-13, then revised the same day for running on the owner's Mac ([ADR-012](../decisions/ADR-012-run-on-the-owners-mac.md)): the site URLs, where the keys live, the fake's address, the owner commands, and criteria 2, 3, 7 and 8. A fresh-context review then moved real use to its own host name, `instante.localhost`, so no other local page shares the session cookie. Those parts wait for the owner's confirmation. Module id `accounts`; it depends on `platform`. It implements [ADR-004](../decisions/ADR-004-supabase-auth.md), which holds the reasons and sources; this spec says what gets built.

## Objective

The owner signs in with an emailed code and an authenticator app. Once signed in, the backend accepts only verified, two-factor tokens for people it already knows. The owner manages people with commands.

When `accounts` is done:
- the owner signs in on the real-use stack, at `http://instante.localhost:4310`;
- `GET /api/me` returns the owner's account;
- every later module can declare `auth: 'user'` routes and receive the signed-in person.

**Out of scope:**
- onboarding's steps (`settings`, `master-resume`);
- self-serve export and deletion, the privacy notice, and other people ([`product.md`](../product.md#before-anyone-else-uses-it));
- Google or GitHub sign-in.

## Assumptions

1. The owner creates two Supabase projects on the Free plan: development, and production in Canada (Central).
2. Built-in email, which reaches only the owner, is enough.
3. `platform` is done: `registerRoutes` takes an injected `authenticate`, the fetch helper takes a token provider, and `proxy.ts` builds the CSP.
4. Real use is at `http://instante.localhost:4310` on the owner's Mac ([ADR-012](../decisions/ADR-012-run-on-the-owners-mac.md)), with no domain (decision D8: not now).

## The Supabase set-up (owner steps, written up as `docs/runbooks/supabase.md`)

For each project, in the dashboard:
- **Sign In / Providers:**
  - "Allow new users to sign up" off, and anonymous sign-ins off;
  - Email on, with "Email OTP length" 8 and "Email OTP expiration" 600 seconds;
  - no other provider.
- **Email templates:** the Magic Link template shows only the code (`{{ .Token }}`), with no link.
- **Multi-factor:** authenticator-app (TOTP) factors on, the default.
- **JWT signing keys:** asymmetric ES256, with the access-token expiry left at 3,600 seconds.
- **The site URL:** `http://localhost:3000` for development, and `http://instante.localhost:4310` for production. Neither is ever opened at another address, because cookies don't separate by port and only a host name of its own keeps the production session apart.
- **Keys:**
  - the project URL and the publishable key go into `.env` for development and `~/.instante/config.env` for production (the owner types them into `instante config`), read at run time;
  - the project URL also goes into the backend's settings, from the same files;
  - the secret key is never copied anywhere.
- **Users:**
  1. Create the owner with "Auto confirm" on and a long random password that isn't saved.
  2. Copy the user id.
  3. Run `users add <email> <user-id>` in Instante.

## Dependencies (owner approval with this spec)

| Where | Package | Version line | Why |
|---|---|---|---|
| web | `@supabase/ssr` | 0.12.7 | session cookies for Next.js, server and browser clients |
| web | `@supabase/supabase-js` | 2.119 | sign-in by code, authenticator factors |
| backend | `jose` | 6.2 | token verification against our cached key set; also signs the fake's tokens in tests |

The authenticator's QR code comes from Supabase as an SVG data URL, so no QR library is needed.

## Configuration

| Name | Read by | Notes |
|---|---|---|
| `SUPABASE_URL` | web (server), backend | read at run time; with `INSTANTE_ENV=production` the backend refuses anything but `^https://[a-z0-9]{20}\.supabase\.co$` |
| `SUPABASE_PUBLISHABLE_KEY` | web (server) | public by design; the root layout passes it to the browser client with the URL |

Neither is a `NEXT_PUBLIC_` value: those are frozen into the build, and a build never carries an environment's settings.

## What gets built

### Web
- **Supabase clients** in `lib/supabase/`:
  - `server.ts` uses `createServerClient` with `getAll` and `setAll`. In Server Components `setAll` does nothing, because only `proxy.ts` writes the cookies.
  - `browser.ts` uses `createBrowserClient` with the URL and key the root layout passes down through a small client provider.
- **`proxy.ts`,** on pages and prefetches, after `platform`'s `Host`, Fetch Metadata and (for pages) CSP steps, so the sign-in pages get the CSP too; `/api` has already passed through. On a prefetch it refreshes the session as below but never redirects, so a Server Component rendered for a prefetch never meets an expired token. Per request it makes a new server client, whose `setAll` writes cookies to the request and the response and copies the cache headers Supabase passes. Then:
  - **The sign-in pages,** `/sign-in` and `/sign-in/authenticator`, skip the redirects below.
  - **Refreshing early:** if the access token expires within 5 minutes, it refreshes the session here. Rendering then never meets supabase-js's 90-second refresh margin, and a Server Component never refreshes a token it can't store.
  - **Checking the session:** it calls `getClaims()`.
    - With no session, it redirects to `/sign-in?next=<path>`.
    - Below `aal2`, it redirects to `/sign-in/authenticator`.
    - If the key set can't be fetched (Supabase down or paused), it lets the request through. The backend still verifies every call with its own key cache, so a signed-in person keeps working.
  - **`next`:** accepted only when it matches `^/(?![/\\])` and a known route; otherwise sign-in returns to `/`.
  - **The CSP:** the Supabase project's address joins `connect-src`.
- **The token provider** for `apiFetch`, the only code that calls `getSession()`:
  - in the browser, it takes the session's access token, and after a 401 lets the client refresh once and retries once;
  - in Server Components, it reads the token `proxy.ts` just checked, and a 401 redirects to `/sign-in`.
- **Pages:**
  - `/sign-in`, which takes the email, then the code;
  - `/sign-in/authenticator`, which enrols an authenticator the first time, with `issuer: 'Instante'` (`'Instante dev'` on the development project) so the authenticator app doesn't label it with a host and port, and asks for its code every time;
  - `/unknown-account`;
  - the Account section of Settings.

### Backend
- **`kit/auth/key-cache.ts`:**
  - it fetches `<SUPABASE_URL>/auth/v1/.well-known/jwks.json` at start and every hour;
  - after a failed fetch it keeps the last good set and logs the failure;
  - it gives `jose` a `createLocalJWKSet` over the current set;
  - when no key matches, it fetches again at most once a minute and retries the verification once.
- **`kit/auth/verify.ts`:**
  - `jwtVerify` with `algorithms: ['ES256']`, `issuer: <SUPABASE_URL>/auth/v1`, `audience: 'authenticated'` and `clockTolerance: 30`;
  - then the claims must have `role` `authenticated`, `is_anonymous` false, `aal` `aal2`, and `sub` a UUID.

  It returns the Supabase user id, email and session id.
- **`authenticate`,** given to `registerRoutes`:
  - it reads `Authorization: Bearer …` and verifies it;
  - it finds `app_user` by `auth_subject`. A person with no account gets `403 unknown_account`, and a disabled one gets `403 account_disabled`;
  - when the email in the token differs from the stored one, it updates it and writes an audit event;
  - it passes the person to the handler.
- **Migration `0003_accounts.sql`:**
  - `app_user (id uuid primary key, auth_subject uuid not null unique, email text not null unique check (email = lower(email)), disabled_at timestamptz, onboarding_finished_at timestamptz, created_at timestamptz not null)`;
  - `audit_event (id uuid primary key, at timestamptz not null, actor text not null check (actor in ('owner','user','system')), action text not null, user_id uuid references app_user on delete set null, request_id text, detail jsonb)`.

  `detail` holds ids and counts, never personal text. Every foreign key is indexed.
- **The route:** `GET /api/me` (`user`) returns `{ id, email, onboardingFinished, createdAt }`.
- **Owner commands** in `cli`, each writing an audit event:
  - `users add <email> <user-id>`;
  - `users list`;
  - `users disable <email>` and `users enable <email>`;
  - `users relink <email> <new-user-id>`;
  - `users delete <email>`, which:
    - removes the person's rows in one transaction and cancels their queued jobs;
    - writes one "account deleted" event with no email;
    - reminds the owner to delete the user in Supabase.
- **The deletion use case** in `engine`. Later modules add their tables to the deletion test's fixture.

### The fake Supabase (tests and agents only)
`apps/backend/test/fake-supabase/` is a small Hono app, which `src/` never imports. In end-to-end runs Playwright's `webServer` starts it on `127.0.0.1`, at one address that both the browser and the web server use.
- **Endpoints,** the ones supabase-js calls for these flows:
  - `/auth/v1/otp` and `/auth/v1/verify`;
  - `/auth/v1/factors`, `/auth/v1/factors/{id}/challenge` and `/auth/v1/factors/{id}/verify`;
  - `/auth/v1/token?grant_type=refresh_token`;
  - `/auth/v1/user`;
  - `/auth/v1/logout?scope=`;
  - `/auth/v1/.well-known/jwks.json`.
- **Browser requests:** it answers CORS preflights for the browser client's headers (`apikey`, `authorization`, `x-client-info`).
- **Tokens:**
  - it signs ES256 tokens with a key it generates at start, so no key is ever committed;
  - the claims are `iss`, `aud`, `exp`, `iat`, `sub`, `email`, `role`, `aal`, `amr`, `session_id` and `is_anonymous`;
  - the `/user` and `/verify` replies carry `user.factors`;
  - a setting gives tokens a short life (120 seconds) for the refresh tests.
- **Codes:**
  - authenticator codes are checked with RFC 6238 on `node:crypto`, and the helper is tested against the RFC's Appendix B vectors;
  - emailed codes can be read by the tests from `GET /__test/last-code?email=`.
- **Users:** two:
  - the Jordan Rivera fixture, whose `app_user` row the seed creates;
  - a second fixture user with no account, for the unknown-account and isolation cases.
- **What it catches:** a test runs the real `@supabase/supabase-js` against it. That catches drift between supabase-js and the fake; drift in Supabase's own server is caught by acceptance criterion 1, on the development project.

## Screens (low fidelity)

shadcn components, one primary button per view, and targets of at least 44 px on phones. The wording is final unless the owner changes it.

```
┌─ Sign in ───────────────────────────────┐   ┌─ Check your email ──────────────────────┐
│ Instante                                │   │ We sent an 8-digit code to              │
│                                         │   │ j•••@example.com. It works for          │
│ Email                                   │   │ 10 minutes.                             │
│ [ you@example.com                    ]  │   │                                         │
│                                         │   │ Code                                    │
│ [        Email me a code        ]       │   │ [ ________ ]                            │
│                                         │   │                                         │
│                                         │   │ [           Continue           ]        │
│                                         │   │ Send a new code · Use another email     │
└─────────────────────────────────────────┘   └─────────────────────────────────────────┘

┌─ Add your authenticator (first time) ───┐   ┌─ Authenticator code ────────────────────┐
│ Scan this with your authenticator app.  │   │ Enter the 6-digit code from your        │
│                                         │   │ authenticator app.                      │
│        [ QR code ]                      │   │                                         │
│ Can't scan? Enter this key instead:     │   │ Code                                    │
│ ABCD EFGH IJKL MNOP  (Copy)             │   │ [ ______ ]                              │
│                                         │   │                                         │
│ Code from the app                       │   │ [            Sign in           ]        │
│ [ ______ ]                              │   │ Lost your authenticator? Ask the owner  │
│ [      Finish setting up      ]         │   │ to remove it in Supabase.               │
└─────────────────────────────────────────┘   └─────────────────────────────────────────┘

┌─ Unknown account ───────────────────────┐   ┌─ Settings › Account ────────────────────┐
│ This sign-in worked, but Instante has   │   │ Email        jordan@example.com         │
│ no account for it. Ask the owner to add │   │ Authenticator  added 13 Nov 2026        │
│ you.                                    │   │                                         │
│                                         │   │ [ Sign out ]  [ Sign out everywhere ]   │
│ [           Sign out           ]        │   │ "Sign out" is the primary button.       │
└─────────────────────────────────────────┘   └─────────────────────────────────────────┘
```

Messages, shown inline under the field (never as a toast):
- **A wrong code:** "That code didn't work. Check it and try again."
- **An expired code:** "That code has expired. Send a new one."
- **Too many tries** (Supabase's `429`): "Too many tries. Wait a minute, then try again."
- **Sign-in is unreachable** (the project is paused or down): "Sign-in isn't available right now. If you're already signed in elsewhere, that session still works."
- **A disabled account:** "This account is turned off. Ask the owner."

## Commands

The commands are `platform`'s, plus:

```bash
pnpm --filter @instante/backend cli users add jordan@example.com <user-id>
```
```bash
pnpm --filter @instante/backend test -- auth
```
```bash
pnpm --filter @instante/web test:e2e -- sign-in
```

For real use, the owner runs them as `instante cli users …` in their own terminal ([ADR-012](../decisions/ADR-012-run-on-the-owners-mac.md)); agents never do.

## Project structure

```
apps/web/
  proxy.ts                         CSP (platform) + session refresh and redirects (accounts)
  lib/supabase/{server,browser}.ts
  lib/auth/{token-provider.ts,next-path.ts}
  app/sign-in/page.tsx  app/sign-in/authenticator/page.tsx  app/unknown-account/page.tsx
  app/(shell)/settings/account/page.tsx
  e2e/sign-in.spec.ts
apps/backend/
  src/kit/auth/{key-cache.ts,verify.ts}
  src/api/authenticate.ts
  src/store/users.ts  src/engine/delete-user.ts  src/cli/users.ts
  migrations/0003_accounts.sql
  test/fake-supabase/{app.ts,totp.ts,keys.ts}  test/seed.ts
packages/contract/src/routes.ts    adds GET /api/me
docs/runbooks/supabase.md
```

## Code style

`platform`'s conventions apply. Verification shows the shape: every check is explicit, and nothing about the token is trusted before `jwtVerify` returns.

```ts
// apps/backend/src/kit/auth/verify.ts
export async function verifyAccessToken(token: string, deps: VerifyDeps): Promise<VerifiedToken> {
  const { payload } = await jwtVerify(token, deps.keys.resolver(), {
    algorithms: ['ES256'],
    issuer: `${deps.supabaseUrl}/auth/v1`,
    audience: 'authenticated',
    clockTolerance: 30,
  });
  const claims = ClaimsSchema.parse(payload); // role, aal, is_anonymous, sub, email, session_id
  if (claims.role !== 'authenticated' || claims.is_anonymous || claims.aal !== 'aal2') {
    throw new AppError('unauthenticated');
  }
  return { subject: claims.sub, email: claims.email, sessionId: claims.session_id };
}
```

## Testing strategy

| Level | What |
|---|---|
| Unit | The verifier: a wrong algorithm (`HS256`, `none`), a wrong issuer or audience, an expired token, an anonymous token, `aal1`, a non-UUID `sub` — each refused, a good token accepted. The key cache: verifying through an outage; a new key id fetched again, but not twice a minute; a removed key dropped at the hourly refresh. `next` validation. `proxy.ts`'s three outcomes, including a failed key-set fetch letting the request through. The TOTP helper against RFC 6238's vectors |
| Integration | `authenticate` against Postgres: an unknown `sub` with a matching email gets `403 unknown_account`; disabled gets `403`; a changed email is updated and audited. The owner commands, including `relink` and `delete` (rows gone, jobs cancelled, one event without an email). The production guard |
| Unauthenticated matrix | every `user` route: 401 with no token, with an `aal1` token, and with a valid Supabase cookie but no bearer header |
| Logs | a request carrying a bearer token and a Supabase cookie leaves neither in logs or error reports |
| End to end, against the fake | sign in with a code and enrol an authenticator, reach the shell, reload; an `aal1` session goes to the authenticator step; with 120-second tokens, a page rendered near expiry, and a prefetch made near expiry, each refresh once in `proxy.ts` and stay signed in; sign out; sign out everywhere; the unknown-account page; `next=//elsewhere` returns to `/`; the sign-in pages carry the CSP; axe on every sign-in page |
| Production build | started with `INSTANTE_ENV=production` and the fake's address, the backend exits; `src/` can't import the fake |

## Acceptance criteria

1. On the development project, a dashboard-created, confirmed user signs in by code with sign-ups off, and the token reaches `aal2` after the authenticator step. This confirms what ADR-004 read from Supabase's source, and comes first: the slice runs before anything else is built.
2. On the development project, in the owner's browser at `http://localhost:3000`, `proxy.ts` refreshes a session whose token is about to expire, once, and the person stays signed in.
3. On the real-use stack at `http://instante.localhost:4310`, the owner signs in with a code and the authenticator; the session survives a reload and a browser restart in each browser the owner uses (Supabase's cookie over plain `http`); a page at `http://localhost:3000` can't see its cookies; and `GET /api/me` returns their account.
4. A token at `aal1`, a token for an unknown user id, and a disabled account are all refused there.
5. With the fake Supabase stopped, a signed-in session keeps working through the backend's key cache, and `proxy.ts` doesn't redirect it to sign-in (CI).
6. Every test above passes, with changed lines at least 80% covered.
7. The owner commands work as `instante cli users …` against the real-use stack.
8. The production build refuses the fake's address, and `src/` can't import the fake (CI).
9. The sign-in screens match the wireframes, carry the CSP, and axe finds nothing critical or serious.
10. The owner has reviewed, line by line ([`sdlc.md`](../sdlc.md#review-policy)):
    - the verifier and the key cache;
    - account linking;
    - the `proxy.ts` session logic;
    - deletion.

## Boundaries

- **Always:**
  - `ES256` only, and the issuer derived from `SUPABASE_URL`;
  - link accounts by Supabase user id, never by email;
  - call `getSession()` only in the token provider;
  - never log or store a token.
- **Ask first:**
  - any change to the Supabase settings above, or to session lengths;
  - adding a sign-in method;
  - storing anything new about a person.
- **Never:**
  - put Supabase's secret key in either app, in CI or on the Mac;
  - read Supabase's `auth` schema;
  - add a sign-up path, or accept `aal1`;
  - read `~/.instante` or run `instante` (the owner's command for real use).

## Sizing

5 slices, in this order:
1. The Supabase checks (criterion 1).
2. The fake Supabase, because the test-first sign-in slices need it.
3. Token verification and the key cache.
4. The sign-in pages and `proxy.ts`.
5. Accounts, owner commands and deletion.

## Open questions

None that block the spec.
