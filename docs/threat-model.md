# Threat model

**Status:** approved by the owner at the phase 2 gate, 2026-11-13, then revised the same day because Instante runs on the owner's Mac ([ADR-012](decisions/ADR-012-run-on-the-owners-mac.md)): the actors, the trust boundaries, "The Mac" in place of "Host and deploy", and residual risks R2, R7, R9 and R10. A fresh-context review of that design, checked by eight verifiers, changed it again the same day: the address, the request checks, the release checks and R9. The revised parts were confirmed by the owner on 2026-11-13. It covers v1 as a personal project: one real user (the owner), a public repository, and the design in [`architecture.md`](architecture.md) and the ADRs.

## What we protect

| Id | Asset | Why it matters |
|---|---|---|
| A1 | The owner's resume data: contact details, the master resume, import files, tailored resumes, the Applied history | Personal information; a leak exposes name, phone, history and work status |
| A2 | The owner's signed-in session (Supabase's refresh token, at `aal2`) | Whoever holds it reads and changes A1 and spends A4 |
| A3 | Secrets: the production Anthropic key and the real-use database's passwords, all in `~/.instante/secrets`; the owner's GitHub credentials | Each one opens a door to A1 or A4 |
| A4 | The AI budget | Real money; a stolen key or session can spend it |
| A5 | The integrity of verdicts and tailored resumes | An invented fact on a resume sent to an employer harms the owner |
| A6 | Availability | Low: Instante runs only while the Mac is on and Instante is started, and a missed day misses a few postings |
| A7 | The public repository: its contents and its supply chain | Personal data must never land in it; a poisoned dependency runs on the Mac that holds A1 and A3 |
| A8 | Employers' posting text | Third-party content, shown only to the owner in v1 |

## Who might attack

| Id | Actor | What they know or hold |
|---|---|---|
| T1 | A stranger on the internet | The public repository (the whole design, the commit email). Instante itself isn't reachable from the internet; only its Supabase project is |
| T2 | Hostile content | A posting written by anyone who controls an employer's job board: HTML, links and text aimed at the parser or at the AI. A hostile upload is unlikely while only the owner uploads |
| T3 | A compromised dependency or GitHub Action | Code that runs in CI, or on the owner's Mac, where the real data also lives |
| T4 | A compromised or failing third party: the processors (Supabase, Anthropic), and services that hold no personal data but change what runs (GitHub, the npm registry, Homebrew) | Out of our control; we limit what each holds, pin what we pull, and plan for outages |
| T5 | The AI agent that writes the code | Honest mistakes and the cheapest road to a green check, governed by [`CONSTRAINTS.md`](../CONSTRAINTS.md) and the review policy in [`sdlc.md`](sdlc.md#review-policy). It runs on the Mac as the owner, so only rules keep it out of the real data |
| T6 | Someone with the owner's Mac, email or phone | The Mac holds all of A1 and A3; email holds the codes; the phone holds the authenticator |
| T7 | A web page open in the owner's browser | It can send requests to `localhost` ports, and through DNS rebinding can try to read the replies |

## Trust boundaries

```
 [browser] ──(1)──► Supabase Auth                      email codes, authenticator, session refresh
     │
     └──(2)──► Next.js, instante.localhost:4310 ──(3)──► backend, 127.0.0.1:4311 ──(4)──► PostgreSQL (socket in ~/.instante/run)
                                                  │      │
                                                  │      └──(5)──► document service (socket in ~/.instante/run, no secrets)
                                                  ├──(6)──► job-board APIs (4 hosts, replies untrusted)
                                                  └──(7)──► Anthropic API (replies untrusted)

 GitHub main ──(8)──► ~/.instante/releases     owner's terminal ──(9)──► instante commands     agent shell ──(10)──► repository and dev databases only
```

1. **Browser to Supabase:** the session is born here; nothing else trusts the browser.
2. **Browser to the web app:** everything from the browser is untrusted, including requests other sites' pages make to local ports. A foreign `Host` header gets `421`, and a cross-site request that isn't a page navigation gets `403`.
3. **Web app to backend:** over loopback, with a bearer token on every call, verified by the backend. The web app is trusted with nothing but passing it on.
4. **Backend to database:** the only route to data, through the store layer. The cluster has no TCP listener and requires a password on its socket.
5. **Backend to document service:** bytes in, text, JSON or a PDF out, over a socket browsers can't reach. The document service is treated as compromised.
6. **Backend to job boards:** answers are hostile input, parsed in the document service.
7. **Backend to Anthropic:** replies are data, checked by schema and code, never executed.
8. **GitHub to the Mac:** a release takes only a commit that `main` contains and whose own CI jobs passed, checked against GitHub's fixed address and API, and builds it in its own folder, never from the working checkout.
9. **The owner's commands:** run by the owner in their own terminal, from the current release.
10. **Agents:** the repository, the development and test databases and the development Supabase project, never `~/.instante`. That's enforced by `AGENTS.md` and Claude Code's settings, not by the operating system (R9).

## Abuse cases by flow

S, T, R, I, D and E are STRIDE's spoofing, tampering, repudiation, information disclosure, denial of service and elevation of privilege.

### Sign-in ([ADR-004](decisions/ADR-004-supabase-auth.md))

| Abuse | Kind | Control | Proved by |
|---|---|---|---|
| Guess an email code from many addresses (a wrong guess doesn't use one up) | S | Two factors: the backend requires `aal2`; 8-digit codes valid 10 minutes; Supabase's per-IP limits | token test: `aal1` refused |
| Sign in with the password the dashboard gave the user | S | A long random password, never recorded; `aal2` required anyway | same test |
| Someone re-enables sign-ups by mistake and creates a user | E | The backend accepts only a known Supabase user id; an unknown one gets `403 unknown_account` | token test: unknown `sub` with a matching email refused |
| Mint a token with the fake's public test key | S | `ES256` only; issuer derived from `SUPABASE_URL`; with `INSTANTE_ENV=production` the URL must be a `*.supabase.co` project; the fake lives under `test/`, which `src/` can't import | production-guard test; ESLint rule |
| Use Supabase's legacy shared-secret tokens or anon key | S | `HS256` refused; `role` must be `authenticated` | token test |
| Use up the 2 sign-in emails an hour to lock the owner out | D | Sign in with an address that isn't in the repository; existing sessions keep working | accepted (R3) |
| Phish the email code and authenticator code in real time | S | Accepted for one person; passkeys are a later option | accepted (R4) |

### The session in the browser

| Abuse | Kind | Control | Proved by |
|---|---|---|---|
| An XSS bug reads Supabase's cookie and its refresh token | I, E | No raw HTML anywhere (floor); React's escaping; Markdown without raw HTML; no third-party scripts; a nonce-based CSP on every page, sign-in pages included, with Cache Components off (D6); the response steps in ADR-004 | floor guard; CSP test on every page; accepted (R1) |
| A malicious link in a posting (`javascript:` or a look-alike) | S, E | Only `https` and `http` links render as links, with `rel="noopener noreferrer"`; anything else is plain text | rendering test |
| The refresh token reaches backend logs through cookies | I | The fetch helper sends `credentials: 'omit'`; the backend drops `Cookie`; logs redact `Authorization` and `Cookie` | log test |
| A cross-site page makes the browser call the backend | T | No cookie authentication: a page elsewhere can't attach a bearer token, and a JSON body needs a preflight the backend never grants; `proxy.ts` and the backend refuse `Sec-Fetch-Site: cross-site` and `same-site` | CSRF reasoning in ADR-004; unauthenticated matrix; Fetch Metadata tests |
| A shared cache stores a private reply | I | `Cache-Control: private, no-store` and `Vary: Authorization`; no `'use cache'` (floor) | caching route tests |

### The web app

| Abuse | Kind | Control | Proved by |
|---|---|---|---|
| A Next.js remote-code bug | E | The web app holds no secrets and runs no SQL; it runs under Node's permission model, reading only its own release, so it can't read `~/.instante/secrets` directly (a seat belt, R2); other sites can't post to it (Fetch Metadata); it handles sessions in flight, so security releases are applied the day they land; no image optimization or `next/og` | dependency monitoring (osv-scanner); the flag-set test |
| `proxy.ts` misses a route, or a Server Component refreshes the token and triggers reuse detection | D | The matcher covers every page, sign-in included; `proxy.ts` refreshes with 5 minutes to spare and is the only writer of the cookies | end-to-end refresh test with 120-second tokens; the development-project check |
| A crafted `next` parameter sends the person off-site after sign-in | S | `next` accepted only as a single-slash path naming a known route | unit and end-to-end tests |
| The rewrite points at the wrong backend | T | The destination is built into each build, and `instrumentation.ts` exits at start if `BACKEND_INTERNAL_URL` differs | start-up test |

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
| A crafted PDF or DOCX exploits the parser | E | Parsed only in the document service: no secrets, no database password, a child under Node's permission model with no network, writes or processes, and memory, time and input limits | document-service acceptance tests; accepted (R2) |
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
| Someone takes over the owner's GitHub, Supabase or Anthropic account | E | Two-factor sign-in on all three, with recovery codes kept offline; no production secret in the repository, its `.env` files or CI | owner checklist before the alpha |
| Backups leak or can't be restored | I, D | Dumps in the `0700` data folder on a FileVault-encrypted disk; copies off the Mac through Time Machine; restore tested in CI on macOS, and drilled in phase 4 | macOS job; restore drill |
| A deletion is undone by a restore | I | Only the owner's own data exists in v1; the deletion journal that re-applies deletions comes with the checklist in [`product.md`](product.md#before-anyone-else-uses-it) | accepted until then |

### The repository and supply chain

| Abuse | Kind | Control | Proved by |
|---|---|---|---|
| A malicious npm release | E | pnpm blocks install scripts; `minimumReleaseAge`; exact versions pinned; few dependencies, each approved by the owner; osv-scanner | CI |
| A malicious or hijacked GitHub Action | E | Actions pinned by commit SHA; least-privilege `permissions` per workflow | workflow review |
| A pull request from a fork steals CI secrets | E | CI holds no secrets, since nothing deploys from it | workflow review |
| Personal data or a secret lands in the public repository | I | The floor (no real people's data, no secrets), gitleaks with `--redact`, the real eval set kept outside the repository, review | gitleaks; floor guard |
| The agent weakens a check to get to green | T | The floor guard and the review policy | floor guard |

### The Mac ([ADR-012](decisions/ADR-012-run-on-the-owners-mac.md))

| Abuse | Kind | Control | Proved by |
|---|---|---|---|
| Another local page (a development server, another project's tools, the agents' unreleased build) reads the production session cookie, since cookies ignore ports | I, E | Real use has a host name of its own, `instante.localhost`, that nothing else is opened at; the web server answers `421` to any other name, so the cookie is never set elsewhere; development stays on `localhost`; ports 4310 and 4311 and that name are refused to every other run, so a tab left open can't reach a test while the real stack is stopped | the review's browser probe; `accounts` criterion 3; `platform` criterion 15 |
| In Safari, a page on `localhost` plants a `Domain=localhost` cookie that shadows the session | D | Sign-ups are off, so a planted session can't be valid; the worst case is a sign-out | accepted |
| A web page uses DNS rebinding to reach Instante's local servers and read the replies | S, I | `proxy.ts` checks `Host` on every request but static files, `/api` and prefetches included; the backend checks its own `Host` and `X-Forwarded-Host`; the document service and the database are on sockets, which browsers can't reach | tests: a foreign `Host` gets 421 on a page, a prefetch, `/api` and the backend |
| A web page sends requests to local ports without rebinding, for example to deliver an exploit to Next.js | T, E | `Sec-Fetch-Site: cross-site` or `same-site` gets `403` except for top-level page navigations; no cookie authentication on the backend; JSON bodies need a preflight the backend never grants; no page changes state on `GET`; no Server Actions | Fetch Metadata tests; unauthenticated matrix |
| A local-network client reaches the web server | I | Every process listens on `127.0.0.1` or a socket, and `instante status` and the tests check with `lsof` | `platform` criteria 12 and 17 |
| A coding agent or other software running as the owner reads the real data, the dumps or the secrets | I | `~/.instante` is `0700` and the cluster has no TCP listener and needs passwords, which stops other macOS users. For the owner's own processes: `AGENTS.md`, Claude Code's deny rules (its own file tools and file commands such as `cat`), and, if the owner chooses, its sandbox (interpreters such as `node` and `psql` too). MCP servers fall outside both | accepted (R9) |
| An agent loosens the agent settings through the repository | T | CI fails on any committed `.claude/` setting that turns off the sandbox or allows reading `~/.instante`; deny rules in the owner's user settings can't be removed by a repository | CI check |
| A restricted child makes another Node process open its debugger (`process._debugProcess`) | E | Every Instante process starts with `--disable-sigusr1` on its own command line | test: `SIGUSR1` opens no inspector |
| A restricted child reads through a symlink or an inherited descriptor | I | Children are spawned without a shell, with piped streams only; job folders refuse symlinks and hard links; the service refuses to start if a symlink in its granted code points outside it | `selftest`; job-folder tests |
| A Homebrew-cluster connection reaches the real data | I | Real use has its own cluster, separate from Homebrew's, which trusts every local connection | macOS job: the real-use cluster refuses a connection without a password |
| A release builds code nobody reviewed, such as a commit pushed to `main` in a fast-forward without its own CI run | T | `instante release` takes only a full id that `main` contains, fetched from the fixed GitHub address with the owner's git configuration and hooks ignored, and requires every CI job to have passed on that exact commit; it builds in a folder of its own and runs that commit's scripts | script tests against a local repository and a stub of GitHub's API |
| Someone holding the owner's GitHub credentials (an agent, too) changes the ruleset on `main` | T | `release` doesn't rely on the ruleset; it checks the exact commit's own CI runs | script tests; accepted (R9) |
| A test or an agent's run touches the real home | I, T | The default home is used only by a script inside `~/.instante/releases/`; any other run must name a home, refused if it's the same folder by device and inode | script tests, including other spellings of the path |
| Two copies of Instante run at once, or a closed terminal leaves half of it running | D | A `lockf` lock in `run/`, inherited by the three processes; traps on `HUP`, `INT` and `TERM` stop every process and the cluster; `instante stop` cleans up after a killed launcher | `platform` criterion 15 |
| A rollback leaves older code on a newer schema | D | `instante rollback` restores the dump taken before the release it undoes, so code and schema always match; the work since that release is lost | `platform` criterion 14 |
| The owner's shell profile leaks other keys into Instante, or secrets into the document service | I | Every process starts from `env -i` with only its allowed names | `selftest` |
| The Mac is lost or stolen | I | FileVault and a login password (owner checklist); sessions revoked in Supabase; the Anthropic key revoked | owner checklist before the alpha |
| The disk fails, or the data folder is deleted | D | Daily dumps; Time Machine for a copy off the Mac (owner checklist); the restore runbook, with `setup` first on a new Mac | accepted (R10) |
| Logs fill the disk | D | The launcher keeps the last 10 starts; PostgreSQL's log rotates over a week | macOS job |

### Outages

| Abuse or failure | Kind | Control |
|---|---|---|
| The Supabase project pauses or is down | D | The key cache keeps existing sessions verifiable; restore the project from the dashboard |
| Anthropic is down or limits us | D | Work waits as `paused` or `failed` with a code and resumes; nothing is lost |
| A job board changes its API | D | Isolated adapters tested on recorded answers; `sources report` shows failures; failures close nothing |
| The Mac is off or Instante isn't running | D | Nothing runs; collection catches up at the next start, as `job-pool`'s spec says |

## Residual risks, accepted for a personal project

| Id | Risk | Why accepted | Revisit when |
|---|---|---|---|
| R1 | Supabase's session cookie is readable by scripts, so an XSS bug hands over an `aal2` session | One user; strong XSS defences; `HttpOnly` sessions need a server endpoint v1 doesn't have | Anyone else uses Instante |
| R2 | A parser exploit that escapes Node's permission model, which Node's docs call no guarantee against malicious code, runs as the owner and can reach what the owner's account can, including the real data. Even a contained one can kill or signal the owner's processes. The document service's own process isn't held by the model at all, because it starts children; the web app's flags are a seat belt too, and its `--allow-net` can't be narrowed | Only the owner uploads; postings come from a hand-curated list of boards on four known APIs; the children have no network, writes or processes; neither service holds secrets | Others upload, the sources widen, or a sandbox profile for the document service proves easy |
| R3 | Anyone who knows the sign-in address can block new sign-ins for an hour at a time | Existing sessions keep working; the sign-in address stays out of the repository | It happens |
| R4 | Real-time phishing of both codes | Rare and targeted; one user | Passkeys become easy |
| R5 | The whole resume PDF goes to Anthropic in the US | The owner's choice, for accuracy | The owner changes it |
| R6 | A crafted posting can skew its own verdict | The harm stays within that one posting | The eval shows it happens |
| R7 | Taking over the owner's Mac account means taking over everything | FileVault, a login password, and macOS's own updates | Never fully removable |
| R8 | The free auth project can pause | The owner restores it; Pro if it recurs | It pauses more than once a quarter |
| R9 | The coding agents, and any other software running as the owner, could read `~/.instante`. Deny rules stop Claude Code's own file tools and the file commands it recognises, not interpreters or MCP servers; its sandbox, if the owner turns it on, also stops interpreters, but not MCP servers; other agents have their own controls. The owner's GitHub credentials, which agents use too, can change the ruleset. Any software that binds Instante's ports while it's stopped would receive an open tab's cookies, which Instante's own runs are refused | One user's own tools on one user's own data; the agents follow `AGENTS.md`; nothing in the repository or CI holds production secrets; `release` checks the exact commit's CI itself | Before the alpha, when the owner decides on Claude Code's sandbox or a separate macOS user; or when anyone else's data is held |
| R10 | Without Time Machine or another copy off the Mac, a failed disk loses everything Instante holds | The owner's checklist asks for Time Machine before the alpha | Before the alpha, if no copy off the Mac exists |

## Response steps

- **A session may be stolen:** the steps in [ADR-004](decisions/ADR-004-supabase-auth.md): disable, sign out everywhere, re-enrol the authenticator, wait an hour, enable.
- **The Anthropic key leaks:** revoke it in the Console, replace `~/.instante/secrets/anthropic_api_key`, restart, and check the usage page and the ledger.
- **A database password leaks:** change the role's password, update its file in `~/.instante/secrets`, and restart.
- **The Mac is lost or stolen:** sign out everywhere in Supabase, revoke the Anthropic key, and change the GitHub password and keys. On a new Mac, run `instante setup`, then `instante restore` with the newest dump from Time Machine.
- **A secret is committed:** revoke it first, because the repository is public and rotation is what helps. Clean the history afterwards.
- **A dependency advisory lands:** pin the fixed version, release the same day, and check the advisory's indicators.

## Revisit when
- someone besides the owner will use Instante ([`product.md`](product.md#before-anyone-else-uses-it));
- a new flow, a new third party, or a new source of postings is added;
- Instante moves off the owner's Mac;
- any residual risk above happens.
