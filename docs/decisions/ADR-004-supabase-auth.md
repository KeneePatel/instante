# ADR-004: Sign-in through Supabase Auth with two factors; the backend verifies its tokens and owns accounts

## Status
Accepted 2026-11-13. At the phase 1 gate the owner chose Supabase Auth over the proposed emailed codes on our own backend. The same day, a fresh-context review led to these changes:
- accounts are linked by Supabase user id, not by email;
- an authenticator app is required as a second factor;
- the key cache keeps working through a Supabase outage;
- production can't be pointed at the test sign-in.

## Date
2026-11-13

## Context
- **The owner's decisions:**
  - sign-in through Supabase Auth;
  - Instante is a personal project, so the owner is the only person signing in for now;
  - no domain yet;
  - the repository is public.
- **Email** ([SMTP](https://supabase.com/docs/guides/auth/auth-smtp), [rate limits](https://supabase.com/docs/guides/auth/rate-limits)):
  - Supabase's built-in email reaches only the organization's team members, at 2 emails an hour per project, with no SLA;
  - custom SMTP reaches any address, starting at 30 an hour, and needs a sending domain.
- **Plans** ([pricing](https://supabase.com/pricing), [pausing](https://supabase.com/docs/guides/platform/free-project-pausing), [billing](https://supabase.com/docs/guides/platform/billing-on-supabase)):
  - Free: no automatic backups, and a project pauses after 7 days of low activity (Supabase emails a warning first, and a paused project can be restored);
  - one person may have at most 2 active Free projects across all their organizations; paused projects don't count;
  - Pro: $25 a month, with daily backups kept 7 days, and it never pauses;
  - a Canada (Central) region is offered.
- **Tokens** ([signing keys](https://supabase.com/docs/guides/auth/signing-keys), [JWT fields](https://supabase.com/docs/guides/auth/jwt-fields), [sessions](https://supabase.com/docs/guides/auth/sessions)):
  - access tokens are signed with asymmetric keys (ES256 recommended), published at `https://<project>.supabase.co/auth/v1/.well-known/jwks.json`;
  - they carry `iss`, `aud`, `exp`, `sub`, `role`, `aal`, `session_id`, `email` and `is_anonymous`;
  - they last 1 hour by default, and 5 minutes to 1 hour is advised;
  - refresh tokens never expire and are single use, apart from a 10-second reuse interval; reusing one revokes the session.
- **Email codes:** checked in the docs and in the open-source auth server.
  - 6 digits by default, settable from 6 to 10;
  - valid 1 hour by default;
  - one request a minute per user, and a new code cancels the old one;
  - 30 verifications per 5 minutes per IP address;
  - a wrong guess doesn't use up the code, and there's no per-code attempt limit.

  A 6-digit code is therefore guessable by an attacker spread over many addresses.
- **Passwords exist anyway:**
  - the dashboard's "Create new user" requires a password, and the server gives every other user a random one;
  - with the email provider on, password sign-in works, and no setting turns it off while keeping codes.
- **Two factors** ([MFA](https://supabase.com/docs/guides/auth/auth-mfa), [TOTP](https://supabase.com/docs/guides/auth/auth-mfa/totp)):
  - authenticator-app (TOTP) factors are free and on in every project;
  - a successful challenge raises the session's `aal` claim to `aal2`, and Supabase tells backends to check that claim;
  - challenges and verifications are limited to 15 a minute per IP address.
- **Sign-ups off:** only existing users can sign in. The auth server sends codes to an existing, confirmed user without checking the sign-up setting; an unconfirmed user counts as new and is refused.
- **The Next.js helper** (`@supabase/ssr`, [guide](https://supabase.com/docs/guides/auth/server-side/nextjs)):
  - it keeps the session in `sb-<project>-auth-token` cookies, which scripts can read because the browser client needs the refresh token;
  - `proxy.ts` refreshes the session on each navigation;
  - `getClaims()` is the call to trust, and `getSession()` isn't for authorization.
- **jose's remote key set** ([source](https://github.com/panva/jose/blob/v6.2.17/src/jwks/remote.ts)):
  - it refetches after 10 minutes by default;
  - if that refetch fails, verification fails rather than using the old keys.
- **Our rule:** `AGENTS.md` keeps secrets out of the web app. Supabase's publishable key is public by design. Its secret key bypasses every check and stays out of both apps.

## Decision
- **Supabase Auth holds identities; Instante's backend holds accounts.**
  - Instante never reads Supabase's `auth` schema, and a person's account and data live in Instante's database under our own ids.
  - The backend trusts nothing from Supabase but a verified token whose `sub` it already knows.
- **Two Supabase projects, both on Free while only the owner signs in:** production (Canada Central) and development. Together they use the owner's two free projects.
  - Where Instante's own database runs is decided with the host in phase 2 ([ADR-003](ADR-003-one-postgres-database.md)). The recommendation is the host.
- **Project settings:**
  - sign-ups off; anonymous sign-ins off; email the only provider;
  - the magic-link email template shows the code (`{{ .Token }}`) instead of a link, so no callback route exists;
  - codes of 8 digits, valid 10 minutes;
  - TOTP factors on (the default);
  - asymmetric (ES256) signing keys;
  - access tokens of 1 hour, the default.
- **Adding a person:** two owner steps.
  1. **In the Supabase dashboard:** create the user with the email confirmed and a long random password that's never written down, then copy the user id.
  2. **In Instante:** run `users add <email> <user-id>`, which creates the account with `auth_subject` set to that id.

  Until custom SMTP exists, built-in email reaches only team members, so in practice only the owner can receive a code.
- **Signing in** on the `/sign-in` page, a Client Component:
  1. `signInWithOtp({ email, options: { shouldCreateUser: false } })` sends the code.
  2. `verifyOtp({ email, token, type: 'email' })` checks it, which gives a session at `aal1`.
  3. **The first time,** the page enrols an authenticator app (`mfa.enroll`, a QR code, then a first verify).
  4. **Every time,** it asks for the authenticator code (`mfa.challengeAndVerify`), which raises the session to `aal2`.

  A password, or an email code alone, never gets past the backend, because the backend requires `aal2`.
- **Keeping the session fresh:**
  - `proxy.ts` makes Supabase's server client and calls `getClaims()` on each navigation;
  - its matcher covers every page except `/sign-in`, static assets and `/api`;
  - without claims, or below `aal2`, it redirects to the matching step of `/sign-in`;
  - it's the only server code that writes Supabase's cookies, and Server Components only read the token.
- **Calling the backend:** every request carries `Authorization: Bearer <access token>`.
  - Server Components send it straight to `BACKEND_INTERNAL_URL`. Client Components send it to `/api/...`, which the rewrite forwards.
  - One typed fetch helper is the only code that reads the token, through `getSession()`, and the web app makes no authorization decision from it.
  - The helper sends `credentials: 'omit'`, so Supabase's cookies never reach the backend, and the backend drops any `Cookie` header before its first middleware.
  - After a 401, the helper lets Supabase's browser client refresh once, then retries once.
  - Files can't travel by link with a bearer token, so previews and downloads are fetched into a `Blob` ([ADR-005](ADR-005-same-origin-rewrite-and-typed-contract.md)).
- **Verifying a token:** the backend checks each token with `jose`:
  - algorithm `ES256` only, so no shared-secret path exists;
  - the issuer equal to `<SUPABASE_URL>/auth/v1`, and the audience `authenticated`;
  - `exp` with 30 seconds of clock tolerance;
  - `role` `authenticated`, `is_anonymous` false, and `aal` equal to `aal2`;
  - then a known `sub` (below).
- **Keys:** our own small key cache.
  - It fetches the JWKS at start and every hour, keeping the last good set when a fetch fails.
  - An unknown key id fetches again at most once a minute.
  - Verification runs against the cached set with `createLocalJWKSet`, so a Supabase outage or pause doesn't reject valid tokens, and a revoked key drops out within the hour.
- **Accounts:** `app_user` holds our own id, `auth_subject` (Supabase's user id, unique), the email, the time it was disabled, and whether onboarding is finished.
  - **Unknown `sub`:** a verified token whose `sub` matches no account gets `403 unknown_account`. Linking never trusts the email claim.
  - **Changed email:** a known `sub` whose email changed updates the stored copy.
  - **Disabled accounts:** a disabled account gets `403` on every request, read fresh each time. That's the immediate stop, since issued access tokens stay valid for up to an hour.
  - **A re-created identity:** after the Supabase user or project is re-created, `users relink <email> <new-user-id>` sets the new `sub` and writes an audit event. The data is kept.
- **Production can't be pointed at the test sign-in:**
  - the backend takes one setting, `SUPABASE_URL`, and derives both the issuer and the JWKS address from it;
  - a separate `INSTANTE_ENV=production`, set only in the host's settings, makes the backend refuse to start unless `SUPABASE_URL` matches `^https://[a-z0-9]{20}\.supabase\.co$`;
  - the fake Supabase and its test key live under `apps/backend/test/` and never enter the production image. The image smoke test checks this;
  - a CI test starts the production image with `INSTANTE_ENV=production` and the fake's address, and expects it to exit.

  End-to-end tests run production builds with `INSTANTE_ENV=test`.
- **Development, CI and agents never sign in through Supabase:**
  - integration tests sign tokens with the test key and serve its key set;
  - end-to-end runs and agents' local runs use a small fake of the endpoints the web app calls (code request and verify, factor enrol and verify, refresh, key set, sign-out), with the Jordan Rivera fixture user;
  - the owner signs in locally through the development project.
- **Signing out:**
  - `signOut({ scope: 'local' })` signs out this browser, and "Sign out everywhere" uses `scope: 'global'`;
  - issued access tokens last up to an hour, so a stolen session is stopped by the steps below.
- **If a session may be stolen:**
  1. `users disable`, which takes effect at once;
  2. sign out everywhere (or revoke the user's sessions in the dashboard);
  3. remove and re-enrol the authenticator if it may be exposed;
  4. wait an hour, so every issued access token has expired, before `users enable`.
- **Lost authenticator:** the owner removes the factor in the Supabase dashboard and enrols a new one at the next sign-in.
- **Caching and CSRF:**
  - every `/api` reply sends `Cache-Control: private, no-store` and `Vary: Authorization`;
  - the backend reads no cookies, and a cross-site page can't send `Authorization` without a preflight the backend never grants, so CSRF has nothing to forge;
  - JSON bodies still need a JSON media type, and `GET` never changes state.
- **Owner commands:** `users add|disable|enable|delete|relink`. Creating Supabase users, removing factors and revoking sessions happen in the Supabase dashboard.
- **Deleting an account:** `users delete` removes the person's rows in one transaction, files included, and the owner then deletes the user in Supabase. Self-serve export and deletion wait until someone besides the owner uses Instante.

## Alternatives considered

| Option | Why not |
|---|---|
| Emailed codes and sessions on our own backend (the phase 1 proposal) | `HttpOnly` sessions and browser-bound codes, but about 20 security mechanisms to own and review, an email provider, and a domain before the first sign-in. The owner chose Supabase Auth |
| Email codes alone, without an authenticator | A wrong guess doesn't use up a code, and the dashboard's user has a password. Either becomes a way in for an attacker who knows the address, and the address may be public |
| An invite list, linked to the account by the token's email at first sign-in | Trusts the email claim and needs a third branch for relinking. Linking by Supabase user id is simpler for one person |
| The backend reads Supabase's session cookies | Needs chunked-cookie parsing in the backend and brings CSRF back |
| `HttpOnly` Supabase cookies, with every auth call on the server | Sign-in would need a server endpoint (a Route Handler or Server Action, both outside v1), or the backend re-implementing Supabase's session client. Revisit before anyone else uses Instante |
| Magic links | Need a callback route, and mail scanners can use them up |
| Google or GitHub sign-in through Supabase | Needs no email, but adds Google or GitHub as a third party. Later, if codes become tedious |
| jose's remote key set with its defaults | After 10 minutes a failed refetch rejects every token, so a Supabase outage would stop Instante |
| `getUser()` on every request | A network call per request; asymmetric keys make local verification the documented path |

## Consequences
- **Much less security code of our own:** no codes, HMACs, email sending, per-address limits, sessions table or invite list. The `accounts` module is token verification, the key cache, account rows, the sign-in page and owner commands.
- **Two factors on every sign-in.** The authenticator code arrives once per new session, and sessions last until sign-out. Guessing email codes, or a password from the dashboard, gets an attacker only `aal1`, which the backend refuses.
- **No domain or email provider is needed** while only the owner signs in. Inviting anyone else needs custom SMTP, and with it a domain.
- **Scripts can read the session cookie,** and its refresh token never expires. An XSS bug would hand an attacker the session, which then holds `aal2`.
  - The defences: no raw HTML (a floor rule), React's escaping, Markdown without raw HTML, no third-party scripts, and a nonce-based CSP once Cache Components is off, which phase 2 recommends ([ADR-005](ADR-005-same-origin-rewrite-and-typed-contract.md)).
  - Accepted for one person; revisited before anyone else uses Instante.
- **Lockout:** anyone who knows the sign-in address can use up the project's 2 emails an hour, and each request cancels the previous code. Existing sessions keep working, so this blocks only new sign-ins.
  - The defence is to sign in with an address that isn't in the repository or its commits.
  - Waiting an hour recovers.
- **Free-plan pausing:** after a week of low activity the auth project pauses. Sign-in then fails until the owner restores it, though the key cache keeps existing sessions verifiable. If it pauses more than once a quarter, the answer is Pro or a keep-alive request.
- **Losing the auth project loses only identities:** accounts and data are in Instante's database, and `users relink` reconnects them. Re-creating a project while two Free projects are active means pausing or deleting one first.
- **Supabase is a processor** of the owner's email address, authenticator enrolment and sign-in metadata, kept in its auth logs.
- **Supabase's reply to an unknown address may differ from its reply to a known one.** Sign-ups are off and only the owner can receive codes, so that's accepted.

## Doubts raised
- **Phase 1, 2026-11-12:** the three review cycles covered the emailed-codes design this ADR replaces. Its lessons that carry over:
  - a credential a cross-site page can't send;
  - `no-store` on every reply;
  - a disabled flag checked on every request;
  - test-only auth that production refuses.
- **Fresh-context review, 2026-11-13** (15 findings, none blockers). Several Supabase pages carried text addressed to AI agents asking for feedback reports; it was ignored and nothing was sent.
  - "Production refusing test auth was circular, and the fake's key will be public": valid. One URL setting, a separate environment flag only the host sets, a pattern check, and the fake kept out of the image and tested.
  - "`users relink` didn't fit the linking rule, and linking trusted the email claim": valid. Accounts are created and relinked by Supabase user id; the invite list is gone.
  - "Codes can be guessed (no per-code attempt limit), the dashboard's user has a password, and the 2-an-hour email limit allows a lockout": valid, each checked in the docs or the auth server's source. Two factors (`aal2`) are required, codes are 8 digits, and the lockout is accepted with its defence stated.
  - "The listed CSP can't stop injected scripts while Cache Components is on": valid. The nonce-based CSP depends on turning it off, which phase 2 now recommends, and the response steps are written above.
  - "The refresh token reached the backend in every request's cookies": valid. `credentials: 'omit'`, the backend drops `Cookie`, and logs redact both headers.
  - "`proxy.ts`'s matcher wasn't specified": valid. Specified, with one refresh and retry after a 401.
  - "Bearer tokens break file links": valid. Files go through a `Blob` ([ADR-005](ADR-005-same-origin-rewrite-and-typed-contract.md)).
  - "jose's default key set rejects every token if a refetch fails after 10 minutes": valid, confirmed in jose's source. Our own cache keeps the last good set.

## Revisit when
- Someone besides the owner will use Instante: custom SMTP and a domain, `HttpOnly` sessions on the server, the privacy notice, and self-serve export and deletion ([`product.md`](../product.md#before-anyone-else-uses-it)).
- The auth project pauses more than once a quarter: Pro, or a keep-alive.
- Codes become tedious: Google or GitHub sign-in, still requiring `aal2`.
- Supabase changes its keys, cookies, limits or prices.
