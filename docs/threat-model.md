# Threat model

**Status:** phase 2 draft, 2026-11-13, for the owner's approval at the phase 2 gate. It covers v1 as a personal project: one real user (the owner), a public repository, and the design in [`architecture.md`](architecture.md) and the ADRs. The host-specific controls point to [ADR-011](decisions/ADR-011-host.md).

## What we protect

| Id | Asset | Why it matters |
|---|---|---|
| A1 | The owner's resume data: contact details, the master resume, import files, tailored resumes, the Applied history | Personal information; a leak exposes name, phone, history and work status |
| A2 | The owner's signed-in session (Supabase's refresh token, at `aal2`) | Whoever holds it reads and changes A1 and spends A4 |
| A3 | Secrets: the Anthropic key, database credentials, host and GitHub deploy credentials | Each one opens a door to A1 or A4 |
| A4 | The AI budget | Real money; a stolen key or session can spend it |
| A5 | The integrity of verdicts and tailored resumes | An invented fact on a resume sent to an employer harms the owner |
| A6 | Availability | Moderate: it's a personal tool, but a long outage misses postings |
| A7 | The public repository: its contents and its supply chain | Personal data must never land in it; a poisoned dependency runs with A3 |
| A8 | Employers' posting text | Third-party content, shown only to the owner in v1 |

## Who might attack

| Id | Actor | What they know or hold |
|---|---|---|
| T1 | A stranger on the internet | The public repository (the whole design, the commit email), and, once they find the deployed site, its Supabase project address and publishable key, which are public by design |
| T2 | Hostile content | A posting written by anyone who controls an employer's job board: HTML, links and text aimed at the parser or at the AI. A hostile upload is unlikely while only the owner uploads |
| T3 | A compromised dependency or GitHub Action | Code that runs in CI, in the image, or on the owner's Mac |
| T4 | A compromised or failing third party: the processors (Supabase, Anthropic, DigitalOcean), and services that hold no personal data but can change what runs or where traffic goes (the domain's registrar and DNS, the certificate authorities, GitHub and its container registry, Docker Hub's base images, UptimeRobot, Healthchecks.io) | Out of our control; we limit what each holds, pin what we pull, and plan for outages |
| T5 | The AI agent that writes the code | Honest mistakes and the cheapest road to a green check; governed by [`CONSTRAINTS.md`](../CONSTRAINTS.md) and the review policy in [`sdlc.md`](sdlc.md#review-policy) |
| T6 | Someone with the owner's laptop, email or phone | A local session, email codes, the authenticator |

## Trust boundaries

```
 [browser] ──(1)──► Supabase Auth                      email codes, authenticator, session refresh
     │
     └──(2)──► host edge ──► Next.js (public) ──(3)──► backend (private) ──(4)──► PostgreSQL (private)
                                                         │      │
                                                         │      └──(5)──► document service (private, no secrets)
                                                         ├──(6)──► job-board APIs (4 hosts, replies untrusted)
                                                         └──(7)──► Anthropic API (replies untrusted)

 GitHub Actions ──(8)──► host deploy        owner ──(9)──► host console (2FA)        agent shell ──(10)──► repository only
```

1. **Browser to Supabase:** the session is born here; nothing else trusts the browser.
2. **Browser to the web app:** everything from the browser is untrusted.
3. **Web app to backend:** a bearer token on every call, verified by the backend. The web app is trusted with nothing but passing it on.
4. **Backend to database:** the only route to data, through the store layer.
5. **Backend to document service:** bytes in, text, JSON or a PDF out. The document service is treated as compromised.
6. **Backend to job boards:** answers are hostile input, parsed in the document service.
7. **Backend to Anthropic:** replies are data, checked by schema and code, never executed.
8. **CI to host:** deploy credentials in a protected environment, used only from `main`.
9. **Owner to host console:** behind the host account's two-factor sign-in.
10. **Agents:** work in the repository and local databases only, never with production credentials.

## Abuse cases by flow

S, T, R, I, D and E are STRIDE's spoofing, tampering, repudiation, information disclosure, denial of service and elevation of privilege.

### Sign-in ([ADR-004](decisions/ADR-004-supabase-auth.md))

| Abuse | Kind | Control | Proved by |
|---|---|---|---|
| Guess an email code from many addresses (a wrong guess doesn't use one up) | S | Two factors: the backend requires `aal2`; 8-digit codes valid 10 minutes; Supabase's per-IP limits | token test: `aal1` refused |
| Sign in with the password the dashboard gave the user | S | A long random password, never recorded; `aal2` required anyway | same test |
| Someone re-enables sign-ups by mistake and creates a user | E | The backend accepts only a known Supabase user id; an unknown one gets `403 unknown_account` | token test: unknown `sub` with a matching email refused |
| Mint a token with the fake's public test key | S | `ES256` only; issuer derived from `SUPABASE_URL`; with `INSTANTE_ENV=production` the URL must be a `*.supabase.co` project; the fake never enters the image | image smoke test and production-guard test |
| Use Supabase's legacy shared-secret tokens or anon key | S | `HS256` refused; `role` must be `authenticated` | token test |
| Use up the 2 sign-in emails an hour to lock the owner out | D | Sign in with an address that isn't in the repository; existing sessions keep working | accepted (R3) |
| Phish the email code and authenticator code in real time | S | Accepted for one person; passkeys are a later option | accepted (R4) |

### The session in the browser

| Abuse | Kind | Control | Proved by |
|---|---|---|---|
| An XSS bug reads Supabase's cookie and its refresh token | I, E | No raw HTML anywhere (floor); React's escaping; Markdown without raw HTML; no third-party scripts; a nonce-based CSP on every page, sign-in pages included, once the owner approves D6 (recommended); the response steps in ADR-004 | floor guard; CSP test on every page; accepted (R1) |
| A malicious link in a posting (`javascript:` or a look-alike) | S, E | Only `https` and `http` links render as links, with `rel="noopener noreferrer"`; anything else is plain text | rendering test |
| The refresh token reaches backend logs through cookies | I | The fetch helper sends `credentials: 'omit'`; the backend drops `Cookie`; logs redact `Authorization` and `Cookie` | log test |
| A cross-site page makes the browser call the backend | T | No cookie authentication: a page elsewhere can't attach a bearer token without a preflight the backend never grants | CSRF reasoning in ADR-004; unauthenticated matrix |
| A shared cache stores a private reply | I | `Cache-Control: private, no-store` and `Vary: Authorization`; no `'use cache'` (floor) | caching route tests |

### The web app

| Abuse | Kind | Control | Proved by |
|---|---|---|---|
| A Next.js remote-code bug | E | The web app holds no secrets and runs no SQL; it handles sessions in flight, so security releases are applied the day they land; no image optimization or `next/og` | dependency monitoring (osv-scanner) |
| `proxy.ts` misses a route, or a Server Component refreshes the token and triggers reuse detection | D | The matcher covers every page, sign-in included; `proxy.ts` refreshes with 5 minutes to spare and is the only writer of the cookies | end-to-end refresh test with 120-second tokens; the development-project check |
| A crafted `next` parameter sends the person off-site after sign-in | S | `next` accepted only as a single-slash path naming a known route | unit and end-to-end tests |
| The rewrite points at the wrong backend | T | The destination is the Compose name `backend` in every environment, and `instrumentation.ts` exits at start if `BACKEND_INTERNAL_URL` differs | start-up test |

### The backend API

| Abuse | Kind | Control | Proved by |
|---|---|---|---|
| Call a route without signing in | I, E | Every route declares public or signed-in in the contract, and registration fails closed | unauthenticated matrix, including encoded paths and trailing slashes |
| Reach another person's rows by id (no one else exists today, but friends may later) | I | Composite keys `(user_id, id)`; one job-visibility function; store calls scoped to the person | isolation matrix |
| Huge bodies or uploads | D | Body limits per route; uploads 5 MB with `413`; our own media-type parsing | route tests |
| Burn the AI budget with a stolen session or key | D | Per-person daily limits, the monthly budget's pauses, and the Console's spend limit as a backstop | ledger tests; Console setting |

### Resume import

| Abuse | Kind | Control | Proved by |
|---|---|---|---|
| A crafted PDF or DOCX exploits the parser | E | Parsed only in the document service: no secrets, no database route, a child process with memory, time and input limits; outbound network closed where the host allows ([ADR-011](decisions/ADR-011-host.md)) | document-service acceptance tests; accepted (R2) |
| A zip bomb in a DOCX | D | Entry and expansion-ratio limits before mammoth reads it | parser tests |
| The whole PDF goes to Anthropic, status statements included | I | The owner's choice (option A), stated on the import screen; nothing of it is stored after the import | accepted (R5) |

### Job collection

| Abuse | Kind | Control | Proved by |
|---|---|---|---|
| Make the backend fetch an internal address | S, I | Only four API hosts; slugs pattern-checked and encoded; manual redirects, off-host ones refused; no URL a person types is ever fetched | fetch tests |
| A huge or compressed answer | D | A cap counted on decompressed bytes | fetch tests |
| Hostile HTML in a posting | E, I | Turned into Markdown in the document service; images and raw HTML removed | rendering tests |

### Screening and tailoring

| Abuse | Kind | Control | Proved by |
|---|---|---|---|
| A posting tells the AI to change its verdict or reveal the resume | T, I | Postings are data blocks; the model has no tools; replies are schema-checked; every fact needs a quote found in the posting; the verdict is computed in code; the reply goes only to the owner's screen | eval postings with "if you are an AI" text |
| A tailored resume gains an invented fact | T | The verifier traces employers, titles, dates, numbers, names and terms to the cited master lines; the review screen shows each source | verifier tests; tailoring eval |
| Contact details, home city or status lines reach a prompt | I | The allowlisted AI view, numbered placeholders, status-pattern families | prompt-privacy tests, both directions |

### Owner commands, data at rest and operations

| Abuse | Kind | Control | Proved by |
|---|---|---|---|
| Someone takes over the host, GitHub, Supabase, Anthropic or registrar account | E | Two-factor sign-in on all five, with recovery codes kept offline; no production credentials on the Mac or in agents' shells | owner checklist before the alpha |
| Backups leak or can't be restored | I, D | The host's encrypted backups; a restore drill in phase 4 | restore drill |
| A deletion is undone by a restore | I | Deletions are logged by id, and the restore runbook re-applies them | restore drill |

### The repository and supply chain

| Abuse | Kind | Control | Proved by |
|---|---|---|---|
| A malicious npm release | E | pnpm blocks install scripts; `minimumReleaseAge`; exact versions pinned; few dependencies, each approved by the owner; osv-scanner | CI |
| A malicious or hijacked GitHub Action | E | Actions pinned by commit SHA; least-privilege `permissions` per workflow | workflow review |
| A pull request from a fork steals CI secrets | E | Pull-request workflows run with no secrets; deploys run only from `main` in a protected environment | workflow review |
| Personal data or a secret lands in the public repository | I | The floor (no real people's data, no secrets), gitleaks with `--redact`, the real eval set kept outside the repository, review | gitleaks; floor guard |
| The agent weakens a check to get to green | T | The floor guard and the review policy | floor guard |

### Host and deploy ([ADR-011](decisions/ADR-011-host.md))

| Abuse | Kind | Control | Proved by |
|---|---|---|---|
| A stolen deploy key opens tunnels to the database or the containers, or becomes root through Docker | E | `restrict` plus a forced command; the script accepts only a 40-character commit and a digest; the deploy user isn't in the `docker` group and has one sudo rule | tests: `ssh -N -L` refused; a malformed argument exits non-zero |
| A stolen deploy key rolls production back to a vulnerable release | T | Images are pulled by digest after their attestation is checked against `deploy.yml` on `main`; rollback accepts only the last 5 deployed commits | deploy-script tests |
| Someone controls the app's hostname (the sslip.io operators, or a hijacked registrar account), gets a valid certificate and collects sessions | S, I | sslip.io only for the data-free skeleton; a domain with CAA records naming our ACME account and method, and two-factor sign-in at the registrar, before any real sign-in (D8); a Reserved IP | owner checklist before the end of `accounts` |
| A remote-code bug in `web` or `caddy` reaches the database | E, I | `DOCKER-USER` rules admit only the backend's fixed address to the database's ports | test: connections from `web`, `caddy` and `documents` refused |
| The document service reaches the host's SSH, Docker's DNS or the backend's API | E | An `internal` network with an isolated gateway (Engine 28+); the backend's API listens only on `app` | `selftest`: gateway port 22, an external lookup and the backend's port all refused |
| A container escape from the document service (a runc, Docker or kernel bug) | E | Docker updates through unattended-upgrades with `live-restore`; `cap_drop: ALL`, `no-new-privileges`, read-only root, process and memory limits | accepted (R2) |
| Secrets read through `docker inspect`, or the owner role's credentials used by a compromised backend | I, E | Compose `secrets` per service; only the one-off `migrate` service holds the owner role's credentials | test: `docker inspect` shows no secret values; the backend has no owner credentials |
| Logs fill the disk and stop the only server | D | Docker's `local` log driver capped per container | config check in the server's runbook |
| A public image ships a secret or a personal file | I | An allowlist `.dockerignore`; gitleaks over each image's files before pushing | CI |
| A tampered base image | E | Caddy and Node base images pinned by digest, updated by Dependabot | review of the update pull requests |
| A rebuilt server's new host key is spoofed during a deploy | S | The host key is pinned from the fingerprint read in the Droplet Console, and re-pinned only that way | rebuild runbook |

### Outages

| Abuse or failure | Kind | Control |
|---|---|---|
| The Supabase project pauses or is down | D | The key cache keeps existing sessions verifiable; restore the project from the dashboard |
| Anthropic is down or limits us | D | Work waits as `paused` or `failed` with a code and resumes; nothing is lost |
| A job board changes its API | D | Isolated adapters tested on recorded answers; `sources report` shows failures; failures close nothing |

## Residual risks, accepted for a personal project

| Id | Risk | Why accepted | Revisit when |
|---|---|---|---|
| R1 | Supabase's session cookie is readable by scripts, so an XSS bug hands over an `aal2` session | One user; strong XSS defences; `HttpOnly` sessions need a server endpoint v1 doesn't have | Anyone else uses Instante |
| R2 | A parser exploit sees the document in flight. On an internal network with an isolated gateway it can't reach the internet, the host or the database ([ADR-011](decisions/ADR-011-host.md)); doing more needs a container escape through a Docker or kernel bug | Only the owner uploads; postings come through four known APIs; the container is hardened and Docker updates automatically | The host changes, or others upload |
| R3 | Anyone who knows the sign-in address can block new sign-ins for an hour at a time | Existing sessions keep working; the sign-in address stays out of the repository | It happens |
| R4 | Real-time phishing of both codes | Rare and targeted; one user | Passkeys become easy |
| R5 | The whole resume PDF goes to Anthropic in the US | The owner's choice, for accuracy | The owner changes it |
| R6 | A crafted posting can skew its own verdict | The harm stays within that one posting | The eval shows it happens |
| R7 | Taking over the host account means taking over everything | Two-factor sign-in everywhere | Never fully removable |
| R8 | The free auth project can pause | The owner restores it; Pro if it recurs | It pauses more than once a quarter |

## Response steps

- **A session may be stolen:** the steps in [ADR-004](decisions/ADR-004-supabase-auth.md): disable, sign out everywhere, re-enrol the authenticator, wait an hour, enable.
- **The Anthropic key leaks:** revoke it in the Console, put a new one in the host's settings, redeploy, and check the usage page and the ledger.
- **Database credentials leak:** rotate them at the host, redeploy, and read the database's connection logs.
- **A secret is committed:** revoke it first, because the repository is public and rotation is what helps. Clean the history afterwards.
- **A dependency advisory lands:** pin the fixed version, redeploy the same day, and check the advisory's indicators.

## Revisit when
- someone besides the owner will use Instante ([`product.md`](product.md#before-anyone-else-uses-it));
- a new flow, a new third party, or a new source of postings is added;
- the host changes;
- any residual risk above happens.
