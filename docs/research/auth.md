# Accounts and sign-in

> **Phase 1 review, 2026-11-12:** an adversarial review changed some recommendations in this note. Where they differ, the ADRs in `docs/decisions/` and `docs/architecture.md` are authoritative; each ADR's "Doubts raised" section says what changed and why.

**Owner's decisions, 2026-11-13:** the owner chose Supabase Auth; ADR-004 records it. The emailed-codes design on our own backend, the email provider choice (Resend or SES) and the domain are superseded or deferred. Instante is a personal project for the owner, not a launch; multi-user, beta and 50-person estimates in this note describe the earlier framing and are now upper bounds.

Checked on 2026-11-12. The question: how do people get an account, sign in and stay signed in, given a Next.js frontend, a separate backend, an invite-only beta of at most 50 users, and the rule that the frontend never touches the database or holds secrets? Recommendation: the backend owns all of it. People sign in with an 8-character code sent by email. There are no passwords in v1, and the code also proves the address. The backend keeps opaque sessions in the database and sets an HttpOnly `__Host-` cookie. The browser reaches the backend only through a Next.js rewrite, so every call is same-origin and nothing needs CORS. Invites are an email allowlist that only the owner edits. Passkeys and Google sign-in come later. No auth library or hosted vendor is needed: each language's standard library has the crypto.

## Question

Who owns accounts and sessions, and which sign-in method does v1 use? How does the session reach the backend through Next.js? How do sign-up, the invite gate, the hand-off to onboarding, sign-out, deletion and export work? Which service sends the codes, and which abuse limits apply? Constraints: the rules in `AGENTS.md` (no secrets or database access in the frontend; ask before adding a third party), at most 50 users, Canada first.

## Options compared

| Option | Verdict | Why |
|---|---|---|
| Backend-owned sessions, emailed one-time codes | recommended | No passwords to store, reset or check against breach lists. The code verifies the email too. Standard-library crypto only. Keeps secrets out of Next.js. |
| Backend-owned sessions, email and password (Argon2id) | runner-up | More code: hashing, a reset flow that needs email anyway, and a common-password check (ASVS 6.2.4, L1). NIST now asks for 15+ characters when a password is the only factor. |
| Backend-owned sessions, magic links | rejected | Mail scanners open links and use up the token. A link also signs in whatever device opens the mail. |
| Better Auth inside a TypeScript backend | runner-up (TypeScript backend only) | Email OTP, rate limits and sessions come ready-made, under MIT. But it's a big surface: five pages of advisories since 2024-12, including an OTP attempt race fixed on 2026-11-03. |
| Better Auth or Auth.js inside Next.js, with the backend checking sessions or JWTs | rejected | Next.js would hold the auth secret and query the database, which `AGENTS.md` forbids. Auth.js now gets only security patches and urgent fixes. |
| Supabase Auth | runner-up (hosted) | Free up to 50,000 MAU, with a Canada region and JWTs the backend can check against a JWKS. Worth it only if the database note also picks Supabase. Free projects pause after a week with no activity. |
| Clerk | rejected | Quickest to wire up. But data stays in the US, the free plan has no passkeys and fixes sessions at 7 days, and its Next.js SDK keeps a secret key in the Next.js app. |
| WorkOS AuthKit | rejected | Free up to 1M MAU, but a custom domain costs $99 a month and the pages checked don't say where data is stored. |
| Kinde | rejected | Offers a Quebec data region, but the free plan has no passkeys, and it adds a vendor to serve 50 users. |
| Stytch, Auth0, Firebase Auth | rejected | Stytch keeps data in the US only. Auth0's first paid plan covers just 500 MAU. Firebase offers no region choice (UNVERIFIED). |
| Passkeys | later | Phishing-resistant and widely supported, but email codes are still needed underneath for recovery. |
| Google sign-in | later | Makes Google a party to every sign-in and adds an OAuth client to manage. |
| JWT sessions | rejected | With a single backend they gain nothing and make revocation harder (ASVS 7.4.1). |
| Cross-origin API on an `api.` subdomain with CORS | rejected | Needs CORS with credentials and still needs cookie forwarding for server rendering. The rewrite avoids both. |

## Findings

### Libraries and frameworks
- Lucia was deprecated in 2025-03. Its repo now ships a single reference file. The token is an 80-bit id plus a 256-bit secret, and only the SHA-256 of the secret is stored. Sessions expire after 10 days of inactivity, refreshed at most hourly. The CSRF rule rejects non-GET requests unless `Sec-Fetch-Site` is `same-origin` ([repo](https://github.com/lucia-auth/lucia), [auth_session.ts](https://raw.githubusercontent.com/lucia-auth/lucia/main/code/auth_session.ts)).
- The Better Auth team has maintained Auth.js since 2025-09-22, with security patches and urgent fixes only. It advises new projects to start with Better Auth ([post](https://better-auth.com/blog/authjs-joins-better-auth)).
- Better Auth is MIT-licensed and joined Vercel on 2026-07-07. Its latest release is 1.7.22, from 2026-11-12 ([repo](https://github.com/better-auth/better-auth), [Vercel post](https://better-auth.com/blog/better-auth-joins-vercel), [releases](https://github.com/better-auth/better-auth/releases)). Its email-OTP plugin defaults to 6 digits, a 300-second life and 3 attempts. By default it stores codes as plain text and signs up unknown emails automatically ([docs](https://www.better-auth.com/docs/plugins/email-otp)). Its advisories run to five pages since 2024-12. On 2026-11-03 it fixed concurrent guesses beating the attempt limit and accent-insensitive email lookups ([GHSA-2f9c-7xj7-gh55](https://github.com/better-auth/better-auth/security/advisories/GHSA-2f9c-7xj7-gh55)). On 2026-09-30 a Critical advisory let OAuth state work as a magic link ([list](https://github.com/better-auth/better-auth/security/advisories)).
- fastapi-users is in maintenance mode, with security fixes only ([repo](https://github.com/fastapi-users/fastapi-users)).
- Next.js is at 16.4 (2026-10-06). Since 2026-07 it has shipped scheduled security releases about once a month ([blog](https://nextjs.org/blog)). Its auth guide says `proxy.ts` (formerly middleware) runs on every route, prefetches included, so it should only read the cookie. Real checks belong in a server-only data access layer ([guide](https://nextjs.org/docs/app/guides/authentication)). CVE-2025-29927 let requests skip auth checks in middleware (CVSS 9.1) ([advisory](https://github.com/advisories/GHSA-f82v-jwr5-mffw)).

### Hosted providers, 2026-11-12

| Provider | Free | First paid | Where user data lives |
|---|---|---|---|
| Clerk | 50,000 retained users; no passkeys, MFA or branding removal; sessions fixed at 7 days ([pricing](https://clerk.com/pricing)) | Pro $25/month | US only, no region choice ([security](https://clerk.com/security.md)) |
| WorkOS AuthKit | 1M MAU ([pricing](https://workos.com/pricing)) | custom domain $99/month | not stated (UNVERIFIED) |
| Supabase Auth | 50,000 MAU, 2 active projects, pauses after 1 idle week ([pricing](https://supabase.com/pricing)) | Pro $25/month, 100,000 MAU | chosen region, including `ca-central-1` ([regions](https://supabase.com/docs/guides/platform/regions)) |
| Kinde | 10,500 MAU, no passkeys ([pricing](https://kinde.com/pricing/)) | Pro $25/month | picked once at sign-up; options include Quebec ([regions](https://docs.kinde.com/get-started/learn-about-kinde/supported-data-regions)) |
| Stytch | 10,000 MAU ([pricing](https://stytch.com/pricing)) | usage-based | US servers only ([compliance](https://stytch.com/docs/resources/policies/security-and-trust/compliance/data-compliance)); owned by Twilio since 2025-11-14 ([changelog](https://stytch.com/docs/resources/changelog)) |
| Auth0 | 25,000 MAU, no MFA ([pricing](https://auth0.com/pricing)) | Essentials $35/month for 500 MAU | regions include Canada ([endpoints](https://auth0.com/docs/troubleshoot/customer-support/operational-policies/public-cloud-service-endpoints.md)) |
| Firebase Auth | 50,000 MAU with Identity Platform ([pricing](https://firebase.google.com/pricing)) | per MAU above that | no region choice found (UNVERIFIED) |

Every hosted option holds users' emails, IP addresses and sign-in history. User IDs belong to the vendor, so leaving means a migration.

### Standards that set the numbers
- OWASP ASVS 5.0.0 came out on 2025-05-30 ([site](https://asvs.owasp.org/)). These Level 1 items apply here:
  - tokens are verified by a trusted backend (7.2.1) and are dynamic, with 128+ bits from a CSPRNG (7.2.2, 7.2.3);
  - a new token at every sign-in (7.2.4), and server-side invalidation on logout and on account deletion (7.4.1, 7.4.2);
  - documented, working anti-automation (6.1.1, 6.3.1), no default accounts (6.3.2), random expiring activation codes (6.4.1), and no hints or secret questions (6.4.2);
  - `Secure` cookies with a `__Host-` or `__Secure-` prefix (3.3.1), and HSTS of at least a year (3.4.1);
  - a check that each state-changing request comes from the app (3.5.1 to 3.5.3).

  Sources: [V6](https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/en/0x15-V6-Authentication.md), [V7](https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/en/0x16-V7-Session-Management.md), [V3](https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/en/0x12-V3-Web-Frontend-Security.md).
- Level 2 rules for emailed codes: each code is single-use, carries at least 20 bits, lives at most 10 minutes, is bound to the request that asked for it, and is protected from brute force (6.5.1, 6.5.4, 6.5.5, 6.6.2, 6.6.3). Level 3 bans email as an authentication factor entirely (6.3.6).
- NIST SP 800-63B-4 was finalized on 2025-07-31 ([CSRC](https://csrc.nist.gov/pubs/sp/800/63/b/4/final)). It bans email for out-of-band authentication (§3.1.3.1), though codes that confirm an address don't count as authentication. At AAL1, re-authentication should happen at least every 30 days, and an inactivity timeout is optional (§2.1.3). After 100 consecutive failures an authenticator is disabled (§3.2.2). Single-factor passwords need 15+ characters and a blocklist check (§3.1.1.2) ([text](https://pages.nist.gov/800-63-4/sp800-63b.html)).
- OWASP's session guidance: IDs need at least 64 bits of entropy, should use the `__Host-` prefix and must be invalidated on the server ([session cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)). Its CSRF guidance: Fetch Metadata makes a good first check but needs an `Origin` fallback, and SameSite is only defence in depth ([CSRF cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)). `Sec-Fetch-Site` has been Baseline since 2023-03, and scripts can't set it ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-Fetch-Site)).
- The Auth Book, by Lucia's author, prefers codes to links. It suggests 8 characters from a 32-symbol alphabet (40 bits), a life of at most an hour, and binding each code to the browser attempt that asked for it ([email codes](https://auth.pilcrowonpaper.com/email-code-authentication), [CSRF](https://auth.pilcrowonpaper.com/csrf)).
- Mail security scanners open links in emails and use up one-time tokens ([Supabase troubleshooting](https://supabase.com/docs/guides/troubleshooting/otp-verification-failures-token-has-expired-or-otp_expired-errors-5ee4d0)).

### Next.js plumbing
- `cookies()` is async. Server Components can read cookies but can't set them; only Server Functions and Route Handlers can ([cookies](https://nextjs.org/docs/app/api-reference/functions/cookies)).
- A rewrite to an external URL works as a proxy. The backend-for-frontend guide recommends rewrites for forwarding to another backend, and warns to pass on only the headers the backend needs ([rewrites](https://nextjs.org/docs/app/api-reference/config/next-config-js/rewrites), [BFF guide](https://nextjs.org/docs/app/guides/backend-for-frontend)). The docs don't say whether a backend's `Set-Cookie` comes back through a rewrite. Community reports say it works same-origin (UNVERIFIED).
- Server Actions accept only POST and compare `Origin` with `Host` ([data security](https://nextjs.org/docs/app/guides/data-security)).

### Email delivery

| Service | Free | Paid entry | Regions |
|---|---|---|---|
| Resend | 3,000 a month, 100 a day, 30-day logs | Pro $20/month for 50,000 ([pricing](https://resend.com/pricing)) | us-east-1, eu-west-1, sa-east-1, ap-northeast-1, set per domain; no Canada ([regions](https://resend.com/docs/dashboard/domains/regions)) |
| Amazon SES | up to $200 in credits for new AWS customers | $0.10 per 1,000 without a plan ([pricing](https://aws.amazon.com/ses/pricing/)) | includes `ca-central-1` ([endpoints](https://docs.aws.amazon.com/general/latest/gr/ses.html)). New accounts start in a sandbox: verified recipients only, 200 a day, first reply to a production request within 96 hours ([sandbox](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)) |
| Postmark | 100 a month | Basic $15/month for 10,000, 45-day history ([pricing](https://postmarkapp.com/pricing)) | not checked |
| Brevo | 300 a day, per third-party reviews; Brevo's own page didn't render (UNVERIFIED) | about $9/month (UNVERIFIED) | not checked |

- Expected v1 volume: about 50 users × 1 to 3 codes a month, so under 200 emails a month (estimate). Every free tier except Postmark's covers it.
- Gmail requires every sender to have SPF or DKIM, valid PTR records and TLS, and to keep spam below 0.3%. DMARC is required only from 5,000 messages a day ([Google](https://support.google.com/a/answer/81126)). Since 2025-05-05, Outlook routes mail to Junk if a sender of 5,000+ a day lacks SPF, DKIM and DMARC ([Microsoft](https://techcommunity.microsoft.com/blog/outlook/strengthening-email-ecosystem-outlook%E2%80%99s-new-requirements-for-high%E2%80%90volume-senders/4399730)). All of this needs a domain we own.
- Resend also takes SMTP at `smtp.resend.com` on ports 465 and 587 ([docs](https://resend.com/docs/send-with-smtp)). Mailpit (MIT) catches mail locally, with SMTP on port 1025 and a web UI on 8025 ([repo](https://github.com/axllent/mailpit)).

### Privacy law
- PIPEDA covers personal information handled in commercial activity, and any transfer across provincial borders. Its 10 principles include accountability, consent, limited retention, safeguards and individual access ([OPC brief](https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/pipeda_brief/)). Access requests must be answered within 30 days, extendable once by 30 ([OPC access](https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/p_principle/principles/p_access/)). Breaches with a real risk of significant harm must be reported to the OPC and the people affected, and every breach is recorded for 24 months ([OPC breaches](https://www.priv.gc.ca/en/privacy-topics/business-privacy/breaches-and-safeguards/privacy-breaches-at-your-business/gd_pb_201810/)).
- Bill C-36, the Protecting Privacy and Consumer Data Act, was tabled on 2026-06-15 to replace PIPEDA's privacy part. It is at second reading ([LEGISinfo](https://www.parl.ca/LegisInfo/en/bill/45-1/C-36)).
- Quebec's Law 25 applies if any user lives in Quebec ([CAI](https://www.cai.gouv.qc.ca/protection-renseignements-personnels/sujets-et-domaines-dinteret/principaux-changements-loi-25)):
  - the head of the enterprise is responsible for personal information unless they delegate it in writing, and the role's title and contact must be published;
  - a plain-language privacy policy is required;
  - before personal information leaves Quebec, a privacy impact assessment and a written agreement are required;
  - products must ship with the highest privacy settings by default;
  - incidents are reported and kept in a register;
  - since 2024-09, people can get their data in a structured, common format;
  - penalties reach $10M or 2% of worldwide turnover.

## Lessons from earlier work

An earlier prototype planned accounts but never built them. No measured findings carry over, only design lessons.

What transfers:
- Enforce the invite on the server at the moment an account is created, for every sign-in method. A before-user-created hook covers OAuth sign-ups for the same reason.
- Use a real email provider from day one. Supabase's built-in mail still reaches only team members, at 2 messages an hour ([Supabase SMTP](https://supabase.com/docs/guides/auth/auth-smtp)).
- Delete files first, then rows, in one server-side operation. Before any release, test that deletion leaves nothing behind and that no user can read another's rows.
- Export JSON per table plus the PDFs, and keep data in Canada where that costs nothing.

What doesn't:
- Keychain storage, `ASWebAuthenticationSession` with PKCE, and custom URL scheme links are native-app tools. The web uses HttpOnly cookies.
- Row-level security as the isolation layer. Instante's store layer scopes every query by `user_id`, unless the database note picks Supabase.
- Ruling out writing our own auth makes sense for a native client with no server of its own. Instante has a backend anyway, and passwordless auth inside it is small.
- Local-only sensitive fields such as work authorization can't stay local in a web app. The profile note must decide how to hold them, and export and deletion must include them.

## Recommendation for v1

### Who does what
- **Backend**: owns all of it. That covers invites, codes, sessions, CSRF checks, rate limits, sending email, export and deletion. It also gets an owner-only CLI: `invite add|list|revoke` and `sessions revoke <email>`. Only its store layer knows the tables below.
- **Next.js**: draws the screens. In `proxy.ts` it redirects when the session cookie is missing; leave `/api` out of the matcher. A `server-only` data access layer calls `GET /api/me`, forwarding only the session cookie, with `cache: 'no-store'`. Next.js holds no secret, and JavaScript never sees a token.
- **Wiring**: `rewrites()` maps `/api/:path*` to the backend's internal URL. Server Components make only GET calls, and every change goes from the browser through the rewrite. Skip Server Actions in v1, because they would need the browser's `Origin` forwarded to pass the CSRF check.
- **Per backend language** (roughly 300 to 500 lines plus tests in any of them, estimate):
  - Python (FastAPI): `secrets`, `hashlib`, `hmac` and `smtplib`, with a `current_user` dependency.
  - TypeScript (Hono or Fastify): `node:crypto` and an SMTP client, with Better Auth as the fallback.
  - Go (`net/http`): `crypto/rand`, `crypto/sha256`, `crypto/hmac` and `crypto/subtle`, plus an SMTP client.

### Flows
1. **Invite.** The owner runs `invite add <email>`. The invite lasts 30 days.
2. **Ask for a code.** The form has one field, "Email", which posts to `POST /api/auth/code`. The backend trims and lower-cases the address, checks the limits and writes an `email_code` row. It sets `__Host-instante_signin` (random, 10 minutes) and returns 202 with the same body every time. It emails the code only if the address has an account or a live invite. The email goes out in the background, so response timing doesn't reveal which case applied.
3. **Enter the code.** `POST /api/auth/verify` finds the live row for that address, purpose and pending cookie. It adds one to `attempts` in the same statement that checks the limit, then compares HMACs in constant time. On success it:
   - consumes the code;
   - creates the user if new, after re-checking the invite (`email_verified_at` is set to now and the invite is marked used);
   - deletes any session the browser already had and creates a fresh one;
   - sets the cookie and returns the next page.
4. **Onboarding.** New users land on `/onboarding`. Step 1 is the privacy notice; accepting it stores `privacy_version` and the time. Other notes own the resume and preference steps; the last step sets `onboarded_at`. Until then, the data access layer keeps routing the user back to onboarding.
5. **Sign out.** `POST /api/auth/sign-out` deletes this session and clears the cookie. "Sign out everywhere" deletes all of the user's sessions.
6. **Export.** `GET /api/account/export` returns a ZIP. It holds JSON files for the account, settings, master resume, jobs, screenings and resumes, plus the resume files.
7. **Delete.** The user requests a code with purpose `delete_account`, bound to the current session, and types it in. The backend deletes the user's stored files, then the user row. Foreign keys cascade to sessions, codes, the invite and all content. The cookie is cleared. Nothing is soft-deleted.

### Sessions and cookies
- The token is 32 random bytes in base64url. The session row's key is the token's SHA-256; the raw token lives only in the cookie.
- The cookie: `__Host-instante_session=<token>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000`.
- Lifetimes: sessions end after 30 days regardless (NIST AAL1), or after 14 days without use. The idle check reads `last_seen_at`, which is written at most once an hour. The cookie's Max-Age equals the 30-day maximum, so the backend never has to re-set it. That matters because Server Components can't set cookies.
- CSRF: every POST, PUT, PATCH or DELETE passes only if `Sec-Fetch-Site` is `same-origin`. If that header is missing, it passes only when `Origin` equals the configured app origin. Anything else gets a 403. JSON endpoints also require `Content-Type: application/json`. GET handlers never change state.
- Send HSTS for one year on every response. Development on `http://localhost` keeps the same cookie names, since MDN says `Secure` is honoured on localhost ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)). Add a flag to drop the prefix if one browser refuses.

### Codes and limits
- A code is 8 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (40 bits), shown as `ABCD-EFGH`. Input ignores case, spaces and dashes. It lives 10 minutes and works once. The stored value is an HMAC-SHA-256, keyed by a server secret, of the purpose, address and code. A leaked table can't be brute-forced without the key.

| Limit | Value |
|---|---|
| Codes per address | 5 an hour, 10 a day |
| Codes per client IP | 20 an hour |
| Wrong guesses per code | 5, then the code is dead |
| All emails per day | stop at 80 and alert the owner (Resend's free cap is 100) |
| Exports per user | 3 a day |

- The code limits come from counting `email_code` rows, so no separate limiter is needed. Every request writes a row, even when no email goes out.
- The arithmetic: at 50 guesses a day for a year, the chance of hitting a 40-bit code is about 2 in 100 million. A 6-digit code would fall about 2% of the time, which is why the codes aren't 6 digits.
- Unknown, invited and existing addresses all get the same reply. Every failure reads "wrong or expired code". No endpoint reveals whether an address exists. Codes and tokens are never logged.

### Email
- Default: Resend's free tier over SMTP, sending from a subdomain of a domain we own. Set up SPF, DKIM and DMARC `p=none` from day one.
- Alternative: Amazon SES in `ca-central-1`, if mail should be sent from Canada. It costs pennies a month but needs an AWS account and a sandbox review.
- One `EmailSender` with two transports. The console transport prints the code and is the default in development and tests. SMTP goes to Mailpit locally when templates matter, and to the provider in production.
- Code emails are plain text plus simple HTML, with no links and no open or click tracking.

### Privacy basics
- The privacy notice names the owner as the accountable person. It lists what is stored, which services receive data (hosting, email, AI) and where they are, the retention periods below, and how to export or delete.
- Retention:
  - sessions: 30 days at most;
  - codes: 48 hours;
  - unused invites: 30 days;
  - app logs: 30 days at most, with user IDs but never emails or codes;
  - backups: as the database note sets them;
  - Resend's sending logs: 30 days.
- Requests the buttons don't cover get an answer within 30 days. Keep a private breach and incident register for 24 months.

### What to store

| Table | Key fields | Retention |
|---|---|---|
| user | id, email (normalized, unique), email_verified_at, created_at, onboarded_at, privacy_version, privacy_accepted_at | until the user deletes the account |
| session | id (SHA-256 of the token), user_id, created_at, last_seen_at, expires_at | until sign-out, expiry or account deletion; expired rows purged daily |
| email_code | id, email, purpose, code_hmac, binding_hash, ip_hmac, sent, attempts, created_at, expires_at, consumed_at | each code lives 10 minutes; rows deleted after 48 hours |
| invite | email (unique), created_at, expires_at, used_at, user_id | unused: 30 days; used: deleted with the user |

Emails match exactly, apart from case: lower-case them on write, and never use an accent-insensitive collation. Better Auth's 2026-11-03 advisory shows what goes wrong otherwise.

## Later, and what would trigger it

| Addition | Trigger |
|---|---|
| Passkeys | Users find codes tedious, or sign-up opens beyond friends |
| Google sign-in | Friends ask, or email delivery keeps failing, and the owner approves Google as a third party |
| Invite links, and invites sent by users | Someone other than the owner needs to invite |
| Device list with per-session sign-out (ASVS 7.5.2) | More than about 20 users, or a report of an odd sign-in |
| CAPTCHA (for example Turnstile) on the code form | Logs show abuse of the code endpoint |
| Owner-issued sign-in code from the CLI | The first real email delivery failure |
| Changing the email address | The first request |
| Sign-in history table | Users want to see it, or an incident needs more than logs |
| Public sign-up | Leaving the beta; needs a CAPTCHA, terms, and a fresh look at passwords and passkeys |
| PPCDA review | Bill C-36 passes |

Passkey libraries are current in all three languages: py_webauthn 3.0.1 from 2026-09-25 ([PyPI](https://pypi.org/project/webauthn/)), SimpleWebAuthn v14.1.0 ([releases](https://github.com/MasterKale/SimpleWebAuthn/releases)) and go-webauthn v0.18.2 from 2026-09-19 ([releases](https://github.com/go-webauthn/webauthn/releases)). Synced passkeys work on iOS 16+, macOS 13+ and Android 9+ ([passkeys.dev](https://passkeys.dev/device-support/)).

## Risks
- **Our own auth code can have bugs.** Keep it small, test every ASVS item listed above, and review it before the first invite. Libraries have bugs too, as Better Auth's advisories show.
- **Email is the only way in.** If the provider or deliverability fails, nobody can sign in. Mitigations: long sessions, the owner-issued code later, and a second provider ready to swap in.
- **Email codes can be phished.** They also fall short of NIST's rules and ASVS Level 3. That's accepted for a 50-person beta, and passkeys fix it later.
- **The rewrite is unverified on four points:** whether `Set-Cookie` comes back, whether the browser's `Origin` and `Sec-Fetch-Site` reach the backend, and whether the client IP does. The first build task is a spike on the chosen host. If cookies don't come back, Route Handlers for `/api/auth/*` can copy `Set-Cookie`. Per-IP limits stay secondary to per-address limits either way.
- **Job postings are third-party HTML.** A script hidden in one would act as the signed-in user, and XSS defeats every CSRF defence. Render postings as sanitized text and add a CSP.
- **Long requests through the rewrite may hit proxy timeouts.** Run AI work as jobs that the page polls.
- **Deleted data survives in backups and provider logs** until they expire. The privacy notice must say for how long.
- **Legal change.** Quebec users would bring Law 25 duties, including an assessment for every provider outside Quebec. Bill C-36 may change the federal rules.

## Questions for the owner
1. Do you approve passwordless sign-in owned by our backend? The alternative is a hosted service, which would hold every user's email and sign-in history: Supabase Auth in Canada if the database note picks Supabase, otherwise Clerk in the US.
2. Which email service may receive users' addresses and send their codes? Resend is free, but its nearest region is US East. Amazon SES in Canada costs pennies a month but needs an AWS account and a sandbox review.
3. Will you buy a domain for the app and its email? Deliverability needs one. It's a yearly cost; I didn't check prices.
4. Does any beta user live in Quebec, and do you plan to charge? A Quebec user triggers Law 25 duties. Charging makes PIPEDA apply for certain. This plan follows PIPEDA either way.
5. In v1, only you can invite, using a command on the server. Is that right?

## Sources
- Libraries: [Lucia](https://github.com/lucia-auth/lucia) · [Auth Book](https://auth.pilcrowonpaper.com) · [Auth.js joins Better Auth](https://better-auth.com/blog/authjs-joins-better-auth) · [Better Auth joins Vercel](https://better-auth.com/blog/better-auth-joins-vercel) · [Better Auth email OTP](https://www.better-auth.com/docs/plugins/email-otp) · [Better Auth advisories](https://github.com/better-auth/better-auth/security/advisories) · [fastapi-users](https://github.com/fastapi-users/fastapi-users)
- Next.js: [authentication](https://nextjs.org/docs/app/guides/authentication) · [data security](https://nextjs.org/docs/app/guides/data-security) · [backend for frontend](https://nextjs.org/docs/app/guides/backend-for-frontend) · [rewrites](https://nextjs.org/docs/app/api-reference/config/next-config-js/rewrites) · [cookies](https://nextjs.org/docs/app/api-reference/functions/cookies) · [blog](https://nextjs.org/blog) · [CVE-2025-29927](https://github.com/advisories/GHSA-f82v-jwr5-mffw)
- Hosted: [Clerk pricing](https://clerk.com/pricing) · [Clerk security](https://clerk.com/security.md) · [Clerk Next.js quickstart](https://clerk.com/docs/nextjs/getting-started/quickstart) · [WorkOS pricing](https://workos.com/pricing) · [Supabase pricing](https://supabase.com/pricing) · [Supabase signing keys](https://supabase.com/docs/guides/auth/signing-keys) · [Kinde pricing](https://kinde.com/pricing/) · [Stytch pricing](https://stytch.com/pricing) · [Auth0 pricing](https://auth0.com/pricing) · [Firebase pricing](https://firebase.google.com/pricing)
- Standards: [ASVS 5.0](https://asvs.owasp.org/) · [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html) · [OWASP sessions](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) · [OWASP CSRF](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) · [MDN Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)
- Email: [Resend pricing](https://resend.com/pricing) · [Postmark pricing](https://postmarkapp.com/pricing) · [SES pricing](https://aws.amazon.com/ses/pricing/) · [Gmail sender rules](https://support.google.com/a/answer/81126) · [Mailpit](https://github.com/axllent/mailpit)
- Privacy: [PIPEDA brief](https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/pipeda_brief/) · [PIPEDA breaches](https://www.priv.gc.ca/en/privacy-topics/business-privacy/breaches-and-safeguards/privacy-breaches-at-your-business/gd_pb_201810/) · [Bill C-36](https://www.parl.ca/LegisInfo/en/bill/45-1/C-36) · [Law 25 (CAI)](https://www.cai.gouv.qc.ca/protection-renseignements-personnels/sujets-et-domaines-dinteret/principaux-changements-loi-25)
