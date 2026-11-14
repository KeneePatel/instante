# How Instante is built

**Status:** proposed in phase 1, 2026-11-12, and revised after three adversarial review cycles the same day. Updated 2026-11-13 with the owner's gate answers: Supabase Auth, Sonnet and Haiku only, and a personal project. Updated again the same day with the phase 2 answers: Instante runs on the owner's Mac ([ADR-012](decisions/ADR-012-run-on-the-owners-mac.md)). Nothing is built yet. [`product.md`](product.md) says what Instante does, and [`decisions/`](decisions/) records why each choice was made. The [research notes](research/) are the evidence as of 2026-11-12. Where a note's recommendation differs from an ADR or from this document (for example on Himalayas, followed boards, OpenAPI code generation, shared extraction or admin pages), the ADR and this document win. The [limits table](#limits-and-windows) is the only place tunable numbers are kept, and the [per-task list](#what-reaches-the-model) is the only place that says what reaches the AI.

## The shape

Hosting model **(a): one machine**, chosen by the owner at the phase 1 gate ([ADR-005](decisions/ADR-005-same-origin-rewrite-and-typed-contract.md)). At the phase 2 gate the owner chose their own Mac for it, for now ([ADR-012](decisions/ADR-012-run-on-the-owners-mac.md)). Sign-in is Supabase Auth ([ADR-004](decisions/ADR-004-supabase-auth.md)).

```
 browser ──HTTPS──► Supabase Auth (sign-in by code, session refresh)
    │
    └──http://instante.localhost:4310──┐ everything below runs on the owner's Mac
                              ▼
          Next.js  (apps/web, 127.0.0.1)      pages, forms; no secrets, no SQL
                         │  rewrite /api/*  and  Server Component reads,
                         ▼  each with a bearer token (loopback)
          Backend  (apps/backend, ROLE=all,  HTTP API + pg-boss worker; holds the secrets
                    127.0.0.1)
             │                 │
             │                 └──► Document service (same code, ROLE=documents, a Unix socket)
             │                      parses uploads and posting HTML, renders PDFs;
             │                      no secrets, no database password, children under a seat belt
             ▼
          PostgreSQL 18 (its own cluster: a Unix socket only, passwords required)
                                              data, queue, schedules, files

 The backend calls out to: the catalog's job-board APIs · Claude API (Anthropic) · Supabase's JWKS (cached)
```

- **Web** (`apps/web`): Next.js 16 with shadcn/ui, created with `create-next-app`'s defaults. It draws pages and forms. It holds no secrets (Supabase's publishable key is public by design), runs no SQL, calls no model and fetches no job board. It does hold people's Supabase sessions and renders their data, so it's part of the threat model.
- **Backend** (`apps/backend`, `ROLE=all`): TypeScript on Node 26 with Hono and pg-boss. It serves the HTTP API and runs the worker in one process. The same code can run as separate API and worker processes once measurements say so.
- **Document service** (`apps/backend`, `ROLE=documents`): the same code, run as its own process with no secret and no database password in its environment. It listens only on a Unix socket in the data folder, receives bytes from the backend, and returns text, structured JSON or a PDF. Inside it, each parse or render runs in a child process under Node's permission model, with no network and with time and memory limits, as a seat belt against bugs. On the Mac nothing sandboxes the service itself ([threat model](threat-model.md), R2).
- **PostgreSQL 18:** the only stateful service Instante runs. For real use it's a cluster of its own on the Mac, with no TCP listener, reached through its socket with passwords that only the backend and the owner's commands hold. Supabase holds identities, and `proxy.ts` on the web server refreshes sessions with it.

## Who does what

| Concern | Frontend (Next.js) | Backend | Document service |
|---|---|---|---|
| Pages, forms, navigation | Yes | No | No |
| Input validation | For messages, with the same contract schemas | On every request, from the route table; the only check that counts | Its own input caps |
| Response shape | Typed from the contract | Every reply parsed through its response schema; unknown fields dropped | — |
| Sign-in and sessions | Supabase's client: sign-in by email code and authenticator, session refresh in `proxy.ts`; sends the access token as a bearer token | Verifies every token, requiring two factors; owns accounts and the disabled flag | — |
| Authorization | Never | Every route declares public or signed-in; every store call is scoped to the person | — |
| Business rules (filters, verdicts, checks, limits) | Never | Yes | Never |
| Database | Never | Only through the store layer | Never (no password) |
| Secrets (database, Anthropic) | Never | Yes | Never |
| AI calls | Never | Only through the `ai` module | Never |
| Job boards | Never | The catalog's API hosts only | Never |
| Parsing uploads and posting HTML | Never | Sends bytes, receives text | Yes |
| PDF rendering (Typst) | Shows the backend's PDF | Sends data, receives the PDF | Yes |
| Long work (import, tailoring, screening) | Polls the subject's status | pg-boss jobs; the subject's row holds the status | — |

## Repository

A pnpm workspace with three packages:

```
instante/
  AGENTS.md  CLAUDE.md  CONSTRAINTS.md  README.md  mise.toml (Node 26)
  package.json  pnpm-workspace.yaml   root scripts: check:fast, check:task, check:full
  apps/
    web/        Next.js app from create-next-app with its defaults, plus shadcn/ui
    backend/    src/ (api, worker, documents and cli entry points), migrations/ (NNNN_name.sql),
                templates/ (Typst), test/
  packages/
    contract/   the route table: Zod request, response and error schemas, plus the id rules
  docs/         product, architecture, sdlc, decisions/, research/, specs/
  evals/        eval sets (anonymized) and the eval runner, run locally with the eval key
  scripts/      check-commits.ts, floor-guard.ts, check-agent-settings.ts, dev-db.sh, local/ (the owner's `instante` command),
                and from `tailoring` install-typst.sh (pinned, checksummed)
  .github/workflows/
```

- **No build step:** the backend runs its `.ts` files through Node 26's type stripping, with `erasableSyntaxOnly` and `verbatimModuleSyntax` set.
- **Stripping and `node_modules`:** stripping refuses files under `node_modules`. `packages/contract` therefore stays a workspace symlink, releases build the whole workspace and never use `pnpm deploy`, and CI starts the production build.
- **Local development:** `pnpm dev` starts the web app, the backend and the document service. Real use runs from its own release folders in `~/.instante`, never from the working checkout ([ADR-012](decisions/ADR-012-run-on-the-owners-mac.md)).
- **The scaffold's own pnpm files:** `create-next-app` writes its own `pnpm-workspace.yaml` and lockfile into `apps/web`. They are merged into the root's and deleted.

## Backend modules

A module imports only from the layers above it, and ESLint enforces the direction. A higher module may declare an interface that a lower module implements; `engine` wires them together. For example, `ai` declares an `AiLedger` (check before a call, record each attempt) and `store` implements it.

```
contract     route table and schemas (shared with the web app)
kit          HTTP seam (fetch injected; manual redirects; host allowlist; byte caps), clock, ids,
             logger with the redaction sanitizer, errors, the document-service client
domain       jobs (places parser, normalizer), resume (model, ids, the AI view and placeholders),
             screening (filters, verdict table, ranking), tailoring (verifier, placeholder restore, fit plan)
ai           typed AI tasks over the Anthropic SDK; refusal handling; pauses; declares AiLedger
documents    the document service: parsers and the Typst runner, each in a child process
sources      readers for Greenhouse, Ashby and Lever (US and EU hosts)
store        Drizzle schema and repositories; implements AiLedger; the only code that knows tables
engine       use cases: collection, screening run, import, tailoring, download and freeze,
             deletion, retention, pause and resume
api · worker · documents · cli   entry points: Hono routes from the contract table, pg-boss handlers,
             the document service, owner commands
```

## How a request travels

- **The contract:** `packages/contract` holds one table entry per route. Each has a method, path, auth (`public` or `user`), request schemas, response schema and error codes.
  - The backend registers handlers only through a helper that reads the table. It fails closed (no auth declared means no route), validates the request, parses the reply through the response schema, and sets `Cache-Control: private, no-store` and `Vary: Authorization`.
  - The web app calls the backend through a small typed fetch built on the same table. It never imports `apps/backend`.
  - From the release phase on, a JSON Schema snapshot of the table (`contract.json`) is committed, and removals or renames ship in two releases.
- **A page:** `proxy.ts` first checks `Host` and Fetch Metadata on every request but static files, then sets the nonce CSP on pages and refreshes the Supabase session, early enough (within 5 minutes of expiry) that a render never needs to. `/api` passes through after the first two checks, so an API call gets a 401, never a redirect, and prefetches skip only the CSP; the sign-in pages skip the session redirects, so sign-in can't loop. Next.js then renders the page dynamically; Server Components read the token without refreshing it, because only `proxy.ts` may write the session cookies. Each Server Component read calls `GET {BACKEND_INTERNAL_URL}/api/...` with the person's access token as a bearer token, `cache: 'no-store'`, inside Suspense.
  - The backend never reads or sets cookies.
  - A 401 redirects to sign-in, a `403 unknown_account` to a page that says so, and unfinished onboarding to onboarding.
- **An action:** a Client Component calls `/api/...` on the same origin with the bearer token, and `next.config.ts` rewrites it to the backend. v1 has no Server Actions and no Route Handlers.
- **The token:** one typed fetch helper is the only code that reads it, and the web app makes no authorization decision from it.
  - The helper sends `credentials: 'omit'`, so Supabase's cookies, which hold the refresh token, never travel to the backend. The backend also drops any `Cookie` header before its first middleware.
  - After a 401, the helper lets Supabase's browser client refresh the session once, then retries once.
- **The backend address:** the rewrite destination is fixed at build time, so each build carries its own loopback address: `http://127.0.0.1:8080` in development, `http://127.0.0.1:4311` for real use. At start, `instrumentation.ts` exits if `BACKEND_INTERNAL_URL` differs from the built-in destination. Supabase's URL and key are read at run time, not as `NEXT_PUBLIC_` values.
- **Other sites' pages:** real use is at `http://instante.localhost:4310`, a name nothing else is opened at, so no other local page shares its cookies. `proxy.ts` answers `421` to any other `Host`, the backend checks its own `Host` and the forwarded one, and both refuse cross-site requests by Fetch Metadata, except page navigations ([ADR-012](decisions/ADR-012-run-on-the-owners-mac.md)).
- **Errors:** one shape, `{ "error": { "code", "message", "details" } }`. Validation failures are 422 with field details.
- **Long work:** the API answers `202` with the subject's id. The page polls the subject (`GET resume-imports/{id}`, `GET tailored-resumes/{id}`, or `GET jobs/counts` for screening) every 2 seconds, then every 5. After 10 minutes it shows "taking longer than expected".

## Limits and windows

The single home of every tunable number. Values are initial; the module spec where a value acts may change it with the owner's yes, and this table changes with it.

| Limit | Initial value | Module |
|---|---|---|
| Sign-in (Supabase settings) | email codes of 8 digits, valid 10 minutes; an authenticator app as the second factor; access tokens 1 hour. Supabase's own limits apply: one code request a minute per user, 30 code verifications per 5 minutes and 15 authenticator checks a minute per IP address, and built-in email at 2 an hour to team members only | `accounts` |
| Key cache | the JWKS fetched at start and hourly, keeping the last good set; an unknown key id fetches again at most once a minute | `accounts` |
| Upload | 5 MB; a PDF at most 4 pages; a DOCX at most 50,000 characters of text | `master-resume` |
| Imports per person | 5 a day | `master-resume` |
| Board read cadence | every 6 hours, with jitter, for boards with at least one job in Canada, remote-open-to-Canada, or unclear but possibly Canadian; weekly for the rest | `job-pool` |
| Fetch concurrency | 4 per host, 16 in all; Lever 1 request a second; a `429` backs off the whole host | `job-pool` |
| Board answer | 50 MB, counted on decompressed bytes | `job-pool` |
| Posting text | about 50,000 characters of Markdown | `job-pool` |
| Closing | after 2 complete answers in a row without the job; held for one read if more than half of a board's open jobs (and at least 5) would close; a board is gone after 3 `404`s in a row | `job-pool` |
| Screening run | coalesced per person: at most every 3 hours, or sooner once 10 candidates wait | `screening` |
| Re-screen after a resume change | when the person asks, or after 6 hours without a save, at most once a day | `screening` |
| Postings sent to the screening AI per person | 1,000 a day, counting scheduled runs, stale re-screens, pasted postings and single re-screens; a new person's first 20 go first | `screening` |
| Requirements per posting | at most 30, each at most 200 characters | `screening` |
| Verdict thresholds | Yes at 0.75, Maybe at 0.50 (per-person settings) | `screening` |
| Tailored builds and regenerations per person | 20 a day, each including its analysis when one is missing | `tailoring` |
| Tailored drafts | at most 3 per job | `tailoring` |
| Typst | 10 seconds per render; a 15-minute deadline per build; its memory cap on macOS is set in `tailoring`'s spec | `tailoring` |
| AI calls in flight | 4, with 1 reserved for the interactive lane | `ai` |
| Monthly AI budget | $100 to start, set by the owner; scheduled screening pauses at 90%; all AI work pauses at 100%; the production Console limit, set just above the budget, is the backstop | `ai` |
| Document service children | 30 seconds; Node heap 256 MB | `platform` |
| Retention windows | in the "Kept" column of the tables below | all |

## Data

One PostgreSQL 18 database ([ADR-003](decisions/ADR-003-one-postgres-database.md)). For real use it runs in a cluster of its own on the owner's Mac ([ADR-012](decisions/ADR-012-run-on-the-owners-mac.md)). Instante never reads Supabase's `auth` schema.

- **Conventions:**
  - ids are UUIDv7 made in the backend;
  - times are `timestamptz`;
  - enum-like columns are `text` with a `CHECK`;
  - documents are `jsonb`, validated by Zod before every write;
  - every foreign-key column is indexed;
  - no SQL that only runs on 18.
- **Migrations:** numbered SQL files, applied in order as `instante_owner` by a small runner. It records each file's name and SHA-256 and fails on a gap, an unknown applied name or a changed file; its checks are never loosened. drizzle-kit only drafts the SQL.
  - Before the alpha, the real-use stack holds no data. Its database is disposable: the owner recreates it whenever an applied migration changes.
  - The alpha is the first real use with data. Just before it, the migrations are squashed into one baseline, and the owner drops and recreates the real-use database and pg-boss's schema from that baseline.
  - From then until release, migrations only expand. From release on, a removal ships in a later release than the change that stopped using it.
- **pg-boss:** its schema is installed and upgraded by the same owner step, and the app starts it with `migrate: false`.
- **Roles:** `instante_owner` runs migrations; `instante_app` can only read and write rows. For real use, a superuser used only by `instante setup` joins them, every password lives only in `~/.instante/secrets`, and the cluster listens only on its socket.
- **Isolation:** there's no row-level security in v1.
  - Every per-user table has `user_id NOT NULL`, and references between per-user tables use composite keys `(user_id, id)`.
  - Every read of `job` goes through one store function with one visibility rule: shared catalog jobs, the person's own pasted postings, and any job the person has a `user_job`, `screening`, `tailored_resume` or `verdict_report` row for (read-only).
  - The isolation matrix covers routes, lists and queue jobs.
- **Connections:** a pool of 5 for the app and 3 for pg-boss.

### Shared tables (the pool)

These hold no user ids, apart from a pasted posting's owner.

| Table | Holds | Kept |
|---|---|---|
| `company` | display name (not unique), hidden flag (owner-set) | while referenced |
| `source` | a catalog board: kind (greenhouse, ashby, lever), region (us, eu), slug (lowercased, pattern-checked), company, status (active, gone), ETag and Last-Modified, the external ids of its last complete answer, next read time, failure and `404` counts, added at | a gone board is deleted only when none of its jobs remain |
| `source_block` | boards or companies removed on request; seeding, adding and fetching all honour it | permanent |
| `job` | board kind and external id (unique together), or for pasted postings the owner and a client key (unique together). Also: company, title, canonical URL, apply URL, description as Markdown, a hash of its normalized text, places, place status (Canada, remote open to Canada, remote region not stated, unclear, elsewhere), work type, posted, first seen, last seen, changed, closed, miss count, a generated `tsvector` | while open; once closed, 30 days, or longer while a `user_job` in the saved or applied state, a `tailored_resume` or a `verdict_report` references it |
| `fetch_log` | one read of one source: requests, status, 304 or not, bytes, items, new, changed, closed, held, error | 30 days |

### Per-user tables

| Table | Holds | Kept |
|---|---|---|
| `app_user` | our id; `auth_subject` (Supabase's user id, unique, set by `users add` and `users relink`); email (normalized, unique); disabled at; onboarding finished | until the account is deleted |
| `settings` | one row: search, eligibility rules, screening and resume sections as validated `jsonb`, and a version | with the account |
| `master_resume` | `contact` (`jsonb`, its own column: name, email, phone, city, links), `doc` (`jsonb`), schema version, version for optimistic locking | with the account |
| `master_resume_snapshot` | the master as it was before an import replaced it | the latest one, for 30 days |
| `resume_import` | status, kind (PDF, DOCX, text), file reference, the draft, flags, the statements moved out (work status and similar) for review; the text layer only while the import runs | the text layer and the file at the end of the import (24 hours at most); the row on accept or discard, or after 7 days |
| `screening` | written by the worker: status (queued, running, judged, filtered, paused, not screened for refusals only, failed with an error code), the filter rule, verdict, the share and its basis, rank, the analysis (`jsonb`: requirements, facts with their quotes, matches with cited ids and their text, requirements not assessed), provenance (requested and serving model, prompt version, effort, inference location, AI-view hash, settings hash, rules version), stale, judged at | deleted with its job or the account |
| `user_job` | written by the person: state (saved, skipped, applied), own verdict, brought back, applied at, application status, note, the sent resume and the frozen download (composite keys, set to null on delete), and a snapshot of company, title and link taken when saved or applied | with the account; rows whose job is gone are deleted unless applied |
| `tailored_resume` | job, a job snapshot, the master version used, status (queued, running, paused, draft, frozen, failed), version, content (lines with source ids, numbered placeholders, copies of the source text), model, prompt version, tokens; once frozen, the frozen download | drafts 90 days after the last change; frozen ones until the person deletes them or the account |
| `stored_file` | kind (upload, download, frozen), the owning row, media type, size, SHA-256, bytes; for downloads also the draft version, renderer version, page count and time | uploads at the end of the import; downloads until the resume is frozen (the chosen one becomes frozen, the rest are deleted) or the draft expires; frozen files with their resume |
| `verdict_report` | the posting text, the analysis and the exact AI view sent, for the owner's experiments | 90 days |

### References to a job

| From | On job deletion | Note |
|---|---|---|
| `screening.job_id` | cascade | screening rows never keep a job alive |
| `user_job.job_id` | set null | saved and applied rows keep the job alive while it's referenced; the row's snapshot survives a takedown |
| `tailored_resume.job_id` | set null | keeps the job alive while it exists; its snapshot survives a takedown |
| `verdict_report.job_id` | set null | keeps the job alive for its 90 days; a takedown deletes the board's reports, because they copy posting text |
| `job.source_id` | restrict | a board is deleted only when none of its jobs remain |

Blocking a board (`sources block`) deletes the board's jobs and reports. `screening` rows cascade, and people's `user_job` and `tailored_resume` rows keep their snapshots.

### Operations tables

| Table | Holds | Kept |
|---|---|---|
| `ai_call` | one row per attempt (from the API's `usage.iterations`): user (set to null at account deletion), task, requested and serving model, effort, inference location, stop reason, refusal category, tokens (input, cache write, cache read, output), cost in micro-dollars, latency, request id. Never prompt or reply text | 90 days |
| `ai_pause` | the AI pause state: reason (90% budget, budget used, spend limit reached), since, lifted at | latest row |
| `audit_event` | account creation, relinking, disabling and deletion, email changes, settings changes: actor, action, request id, time. No IP addresses. The user link is removed at account deletion, except one "account deleted" event that names no email | 12 months |

pg-boss keeps its own tables. Payloads carry ids only, never email addresses or resume text. Finished jobs are kept 7 days and failed jobs 30.

### What is deliberately not stored

- Passwords, sign-in codes and session tokens: Supabase handles sign-in, and Instante stores none of them.
- Uploaded files and text layers after the import ends.
- Previews: rendered on demand and cached in memory by content hash and renderer version.
- Prompt or reply text in logs, the ledger or the queue. Reported verdicts are the exception, kept 90 days.
- IP addresses.
- Anything in the Anthropic Files API: files are sent inline.

### Retention, with purposes

Approved by the owner at the phase 2 gate, 2026-11-13. Each window has a purpose; data is kept no longer than the purpose needs. Every row is deleted by the daily `retention` job unless it says otherwise.

| Data | Kept | Purpose |
|---|---|---|
| Open jobs | while open | the pool people screen |
| Closed jobs | 30 days, or while a saved or applied `user_job`, a `tailored_resume` or a `verdict_report` references them | a board glitch can reopen them; jobs the person acted on stay readable |
| `fetch_log` | 30 days | collection health and `sources report` |
| `app_user`, `settings`, `master_resume` | until the account is deleted | the account itself |
| `master_resume_snapshot` | the latest one, for 30 days | undo an import |
| Uploaded files and text layers | until the import ends, 24 hours at most | build the draft; no copy of the file lingers |
| `resume_import` rows | until accepted or discarded, 7 days at most | review the draft |
| `screening` rows | with their job or the account | the verdict's evidence |
| `user_job` rows | with the account; rows whose job is gone are deleted unless applied | decisions and the Applied history |
| Tailored resume drafts | 90 days after the last change | come back to a draft |
| Frozen resumes and their PDFs | until deleted by the person, or with the account | proof of what was sent |
| Downloads not chosen at Mark applied | deleted at freezing, or when the draft expires | only the sent file matters |
| `verdict_report` | 90 days | find a wrong verdict's cause by experiment |
| `ai_call` | 90 days | budget, cost per task and refusal rates |
| `ai_pause` | the latest row | the current pause state |
| `audit_event` | 12 months | who changed an account, and when |
| pg-boss jobs | finished 7 days, failed 30 days | debugging the queue |
| App logs | the last 10 starts, in `~/.instante/logs`; PostgreSQL's own log rotates over a week | debugging; ids and counts only |
| Database backups | a daily dump and one before each release, in `~/.instante/backups`, kept 14 days; Time Machine's copies follow its own schedule | restore after a mistake or failure |
| Supabase auth logs; Anthropic's inputs and outputs | the processors' own windows (Anthropic: 30 days by default) | outside our control; listed so nothing is forgotten |

### Deleting an account: the inventory

| Store | At deletion |
|---|---|
| `app_user` and every per-user table | Deleted in one transaction (cascades), stored files included |
| `job` rows of pasted postings | Cascade through the owner |
| `ai_call` | `user_id` set to null; costs stay for the budget |
| `audit_event` | User link removed; one "account deleted" event with no email |
| pg-boss jobs | The person's queued jobs are cancelled in the transaction; handlers check the person still exists before any AI call |
| App logs | Ids only, capped and short-lived |
| Database backups | Dumps expire after 14 days, and Time Machine's copies on its own schedule. A restore brings back what was deleted after the dump; while only the owner's data exists that's accepted, and the deletion journal comes with the checklist in [`product.md`](product.md#before-anyone-else-uses-it) |
| Supabase | The owner deletes the user in its dashboard; its auth logs expire on its schedule |
| Anthropic | Its retention applies: 30 days by default, longer for flagged content |

## How resumes are stored

One master per person ([ADR-008](decisions/ADR-008-master-resume-document.md)). `contact` sits in its own column; everything else is in `doc`:

```json
{
  "schemaVersion": 1,
  "summary": "…",
  "experience": [{
    "id": "x_8k2m4q7r", "employer": "Northwind Labs", "location": "Halifax, NS",
    "positions": [{
      "id": "p_3h7c9w2d", "title": "Junior Developer",
      "dates": { "start": "2024-05", "end": null, "present": true, "expected": false, "raw": "May 2024 – Present" },
      "bullets": [{ "id": "b_3n7x1c9v", "text": "Cut nightly import time from 40 to 12 minutes by batching writes" }]
    }]
  }],
  "projects": [], "education": [], "certifications": [], "custom": [],
  "languages": [{ "id": "l_4f8g2k6m", "name": "English", "level": "fluent" }],
  "skills": [{ "id": "s_q2w8e4r6", "name": "TypeScript", "level": "proven" }]
}
```

- **Ids:** a prefix and 8 lowercase Crockford base32 characters, made by one generator in `packages/contract`. The prefixes are `x` experience, `p` position, `b` bullet, `j` project, `e` education, `c` certification, `l` language, `s` skill, `u` custom section and `i` custom item. Saving checks that ids are well formed and unique, and that an existing id keeps its type.
- **Dates** keep what the person wrote: a year alone stays a year. It prints as a year, the editor flags it, and comparisons treat it as any month of that year.
- **Saving:** each section has a **Save** button that sends the whole document with the version it started from: `UPDATE … WHERE version = $expected`, or `409`.
- **The AI view,** built in one function in `domain/resume`:
  - **The allowlist:** the summary; each employer with its positions' titles, dates and bullets; projects; education as degree, field and dates, without the school; certifications; languages; skills with their levels; custom sections. Never contact details, schools, entry locations or links.
  - **Numbered placeholders:** inside the remaining text, every occurrence of the person's contact values or home city, and any email, phone number or URL, is replaced by a numbered placeholder recorded per line (`[city1]`, `[link1]`, `[email1]`). The rest of the line is kept.
  - **Status statements:** a line that matches a work-status pattern is withheld whole, in every section including custom ones. The patterns are tested against a corpus of real phrasings in both directions. The families:
    - authorized, eligible, entitled or able to work;
    - work or study permit or visa;
    - PR, PGWP, OWP, LMIA, H-1B, TN, IEC;
    - permanent residen(t, cy, ce);
    - a nationality with "citizen", "citizen of", "citizenship", "nationality:";
    - needs, requires, without or no sponsorship, and sponsorship (not) required;
    - refugee, protected person, landed immigrant;
    - security clearance and its levels.

    A single word such as "visa", "citizen" or "sponsorship" doesn't count on its own.
  - **The person sees it all:** the master-resume page lists every withheld line and every replaced value, with the reason, so they can rephrase. Whether they may release a withheld line is the owner's call in phase 2.
- **A tailored resume** stores the lines it printed, each with the ids it came from, its placeholders and copies of the source text, so it stays readable after the master changes. Each download is kept as its own file until one is frozen.

## Flows in detail

### Sign-in and account creation

The details and their sources are in [ADR-004](decisions/ADR-004-supabase-auth.md).
1. **Adding a person:**
   - in the Supabase dashboard, the owner creates the user with the email confirmed and a long random password that's never written down, and copies the user id;
   - in Instante, `users add <email> <user-id>` creates the account with that id.

   Sign-ups are off in Supabase.
2. **The email code:** the `/sign-in` page calls `signInWithOtp({ email, options: { shouldCreateUser: false } })`. Supabase emails an 8-digit code, valid 10 minutes, and `verifyOtp({ email, token, type: 'email' })` checks it. The session is now at `aal1`.
3. **The authenticator:** the first time, the page enrols an authenticator app (`mfa.enroll`, a QR code, a first verify). Every time, it asks for the app's code (`mfa.challengeAndVerify`), which raises the session to `aal2`. Supabase's browser client keeps the session in its cookies.
4. **The first backend call** (`GET me`) carries the access token. The backend:
   - verifies it with `jose` against its key cache: `ES256` only, issuer `<SUPABASE_URL>/auth/v1`, audience `authenticated`, `exp` with 30 seconds of tolerance, role `authenticated`, not anonymous, and `aal2`;
   - finds `app_user` by `auth_subject`, or answers `403 unknown_account`. The email claim is never used to link;
   - refuses a disabled account with `403`, on this and every later request.
5. **Staying signed in:** `proxy.ts` refreshes the session with `getClaims()` on each navigation, and sends a missing session, or one below `aal2`, to the right step of `/sign-in`. Sign-out uses `signOut({ scope: 'local' })`, and "Sign out everywhere" uses `scope: 'global'`.
6. **CSRF:** the backend reads no cookies and a cross-site page can't set `Authorization`, so there's nothing to forge. JSON bodies need a JSON media type, checked by our own parser. `GET` never changes state.
7. **Development and tests:** agents, CI and end-to-end runs use a fake of the Supabase endpoints the web app calls, signed with a test key and seeded with the Jordan Rivera user. The fake and its key live under `apps/backend/test/`, which `src/` can't import. The owner signs in locally through the development Supabase project.
8. **Production's guard:** with `INSTANTE_ENV=production`, set only by `instante start` on the Mac, the backend refuses to start unless `SUPABASE_URL` is a `https://<20 letters and digits>.supabase.co` address. It also refuses to start with a TCP database URL, a non-loopback listen address, or in fake-AI mode. End-to-end runs use production builds with `INSTANTE_ENV=test`.

### Onboarding

- `PUT master-resume/contact` stores contact details before any import.
- `GET jobs/match-count` runs the code filters over the pool for the current search settings and returns the number of open postings that pass.
- `POST me/onboarding/finish` marks onboarding finished and enqueues the person's first screening run immediately, outside coalescing.

### Importing a resume

1. The API checks the type by content, the caps and the person's daily import limit. It stores the upload in `stored_file`, creates `resume_import` and enqueues `resume.import` (interactive lane).
2. The backend sends the file to the document service, which extracts the text layer in a child process: unpdf with `isEvalSupported: false`, or mammoth with external files off, within zip-entry and ratio limits.
3. **The call** ([what reaches the model](#what-reaches-the-model)): a PDF goes inline, whole (option A, the owner's choice). DOCX and pasted text go as the redacted text layer. The schema has separate outputs for work status, citizenship, date of birth, photo and home address, which never enter the master.
4. **Checks:** code assigns ids and normalizes ligatures, hyphens and quotes, then checks both ways:
   - every drafted line against the text layer;
   - every text-layer line of more than three words against the draft.

   An empty text layer shows one banner instead. The draft is checked against the save schema.
5. **Cleanup:** the file bytes and text layer are deleted. The person reviews and accepts, and a replaced master leaves its snapshot.

### A collection pass

1. **Due sources:** every minute, the worker takes the catalog boards that are due, never one on `source_block`. The cadence is in the limits table.
2. **The fetch:**
   - only `boards-api.greenhouse.io`, `api.lever.co`, `api.eu.lever.co` and `api.ashbyhq.com`;
   - paths built from a checked slug with `encodeURIComponent`;
   - `redirect: 'manual'`, where a redirect off the same host is a failure;
   - the body counted on decompressed bytes.
3. **Conditional requests:** each read sends the stored ETag or Last-Modified. A `304` repeats the last complete answer: jobs missing from that answer get another miss. A `404` adds to the board's not-found count; at the limit, the board is gone and its open jobs close.
4. **Parsing:** the backend sends each answer to the document service, which turns it into postings.
   - **On-site and hybrid jobs:** places come from structured fields first, such as Lever's `country` and Ashby's address. A remote job keeps "region not stated" unless its text narrows it.
   - **Free-text places** go through the parser:
     - country names and ISO codes are recognized;
     - a gazetteer of Canada's provinces, territories and cities is used;
     - an ambiguity list is made by crossing the gazetteer with a world place list above a population floor (London, Hamilton, Kingston, Victoria, Windsor, Richmond and others), and those names count as unclear;
     - `City, CA` means Canada when the city is in the Canadian gazetteer and isn't a California namesake;
     - every other US state code means the US;
     - a bare "Remote" means remote with the region not stated.
   - Images are stripped, HTML becomes Markdown, and the apply link is kept apart.
5. **Upserts:** on (board kind, external id). A changed hash of the normalized text (whitespace, links and dates removed) updates the posting and marks it for screening.
6. **Closing:** by the rule in the limits table. Failures, partial reads and `429`s close nothing.
7. **Re-reads:** when the parser's version or the served places change, stored ETags are cleared, so every board is read in full once.

The owner adds a requested board with `sources add <link>`. Only the five hosted-board hosts are accepted, and the link becomes (kind, region, slug), checked with one request.

### A screening run for one person

1. **Candidates:** visible open jobs that are new, changed or stale since the person's last run, and that they haven't acted on, plus stale saved jobs. Runs are coalesced as the limits table says. A pasted posting or a single re-screen goes to `screen.job` in the interactive lane instead. Each run counts against the person's daily screening limit.
2. **Filters in code:** places, work type, roles and titles, level from the title, posting age, keywords, hidden companies. The first failing rule is written as `filtered`. Unclear locations pass only when the person includes them.
3. **Order:** the longest-waiting first, then the newest posted. A new person's first 20 go first.
4. **The call:** one structured-output call with the posting and the AI view. Code then:
   - rejects a reply over the limits and retries once, asking it to merge requirements. If there are still more than 30, it keeps the must-haves first, shows the rest as "not assessed", leaves them out of the count, and flags the job;
   - drops requirements whose words aren't in the posting;
   - checks that every fact's supporting quote is in the posting, and treats a fact without a found quote as unstated;
   - re-checks evidence ids, retrying once and counting a requirement still unevidenced as not met;
   - caps Familiar-only evidence at partly met;
   - decides spoken-language requirements it can, upgrading only to met.
5. **After the call,** for this person only:
   - **Remote region:** a grounded region that excludes Canada files the job as `filtered` ("Remote, limited to the US"), with Bring back.
   - **Facts filters:** minimum must-have years above the limit, a level the posting names that the person turned off, and required enrolment for a graduate.
   - **Eligibility rules the person turned on:** sponsorship needed while the posting offers none, a required clearance, required French.
6. **The verdict and rank** in code, with full provenance. "Not screened" means a refusal only; errors are `failed` with a code, and pauses are `paused`.
7. **After a resume change** (the AI view's hash changes):
   - the person's open No and Maybe rows, saved ones included, are marked stale;
   - Yes rows are marked stale only when a line they cite was removed or changed (compared after normalizing whitespace, punctuation and case);
   - stale rows are re-screened by the rule in the limits table.

### Making a tailored resume

1. `POST /api/tailored-resumes {jobId}` checks the person's daily build limit, creates the row and enqueues `resume.tailor` in the interactive lane.
2. **The input:**
   - the job's stored requirement list and facts. If the job has no analysis for this person, the build makes one first, outside the screening limit and the 90% pause;
   - the AI view, with its numbered placeholders;
   - the person's writing rules.

   It never includes the raw posting. If the analysis is refused, the build makes a plain one-page version of the master and says why.
3. **The checks** in [ADR-009](decisions/ADR-009-strict-tailoring-and-typst.md):
   - Placeholders must come back exactly as the line's sources had them. Code then puts back the master's values.
   - A line with a leftover, unknown or duplicated placeholder fails.
   - A failing line falls back only to its own entry's source bullet that passes the same checks; otherwise it's dropped.
4. **Fit:** the document service reports line heights, code picks lines to drop, and one final compile confirms the page. The order in which things are dropped is in ADR-009.
5. **The draft is ready.** The preview renders on demand, cached by content hash. Edits use the draft's version and `409`.
6. **Downloads and freezing:**
   - `POST tailored-resumes/{id}/download` renders, stores the exact bytes as a new download file, and returns them.
   - `POST jobs/{id}/applied {resumeId, downloadId}` freezes the chosen download (the newest by default) and deletes the other downloads of that draft. If there's no download, it renders, stores, freezes and says so.
   - Editing a frozen resume copies it to a new draft.
   - No stored or frozen PDF may contain a placeholder token.

### Deleting a person

`users delete` follows the inventory above, and the owner then deletes the user in Supabase. Self-serve export and deletion wait for the checklist in [`product.md`](product.md#before-anyone-else-uses-it).

## Background work and lanes

Queue names use only letters, digits, `_`, `-`, `.` and `/`, as pg-boss requires.

| Queue | Does | When |
|---|---|---|
| `sources.due` | finds due boards and enqueues one read each, keyed by board | every minute |
| `sources.fetch` | reads one board | one at a time per board |
| `screen.user` | one person's coalesced run | as the limits table says; one at a time per person |
| `screen.job` | one pasted posting or single re-screen | on request (interactive lane) |
| `resume.import` | one import | on upload (interactive lane) |
| `resume.tailor` | one tailored resume, including its analysis if missing | on request (interactive lane) |
| `ai.resume` | re-enqueues every paused subject in one transaction | on `ai resume`, and at the month rollover for budget pauses |
| `retention` | the deletions in the tables above, and queue pruning | daily |

- **AI lanes:** the in-flight limit from the limits table, with one slot reserved for the interactive lane. Scheduled screening runs round-robin across people, in chunks of 10.
- **Job state:**
  - one source of truth per job: the subject's row;
  - slow work (AI calls, fetches, parsing) happens outside any transaction; then one short transaction writes the result through `store` and completes the job (`completeInTx`, fenced to the attempt that was fetched, with `{ db: fromDrizzle(tx, sql) }`), so a rollback leaves neither and a late attempt writes nothing;
  - each queue's dead-letter handler marks the row failed with an error code;
  - handlers are idempotent and reuse a stored AI reply on retry;
  - a handler that meets a pause sets its subject to `paused` and completes its pg-boss job, so nothing retries or fails;
  - a sweeper marks anything running past its deadline as failed.

## The AI layer

Every call goes through the `ai` module ([ADR-010](decisions/ADR-010-claude-models-are-configuration.md)).

- **Tasks:** `analyzePosting` (screening and the tailoring analysis), `importResume` and `tailorResume`. Each has a Zod output schema, a prompt version and its own code checks.
- **Calls:** the beta endpoint's `client.beta.messages.parse`, because the refusal fallback is a beta parameter, with each task's Zod schema as the output format, and `max_tokens` sized to the schema. Schemas have no free-text "reasoning" field, which invites reasoning-extraction refusals.
  - Only `claude-sonnet-5-5` and `claude-haiku-5-5` are allowed, plus `claude-sonnet-5` as Sonnet's refusal fallback; configuration naming any other model fails at start. Never Opus.
  - Every task starts on Sonnet 5.5 at effort `medium`. Each task's configuration then comes from its eval, in its own slice: six configurations (Haiku and Sonnet, each with thinking off, adaptive `low` or adaptive `medium`), chosen on the tuning pairs ([ADR-010](decisions/ADR-010-claude-models-are-configuration.md)).
  - Inference is global, the default. Each call records where it ran.
- **Refusals:**
  - Sonnet 5.5 calls use the server-side fallback (`server-side-fallback-2026-07-01`) in its list form, naming `claude-sonnet-5`, which the `ai` module checks at start against the model's `allowed_fallback_models`.
  - Haiku 5.5 calls carry no fallback. A refusal, or a reply that still fails its checks after the retry, is tried once more with the task's best Sonnet configuration, fallback included. What's still refused shows as "Not screened".
  - The serving model is recorded with every result.
- **Spend:**
  - Before a call, `AiLedger.check` refuses it if the person's limit for that kind of work is used up (screening postings, imports, or builds) or if an AI pause is active. Afterwards, `record` writes one row per attempt at its serving model's price. With at most 4 calls in flight, the overshoot is a few cents.
  - At 90% of the monthly budget, scheduled screening pauses (reason "90% budget"). At 100%, all AI work pauses (reason "budget used"). Anthropic's spend-limit responses (`429 enforced_spend_limit_reached`, or the workspace limit's `400`) also pause everything, with the owner alerted and the SDK's retries off for those errors.
  - Paused subjects wait in `paused`. `ai resume` re-enqueues them, and so does the month rollover for budget pauses.
  - The production Console limit sits just above the budget as a backstop. The dev, eval and production workspace limits add up to less than the organization's monthly cap.

### What reaches the model

| Task | What is sent |
|---|---|
| Screening (`analyzePosting`) | the posting text and the AI view of the resume |
| Tailoring (`analyzePosting` if missing, then `tailorResume`) | the analysis call as above; then the job's requirement list and facts, the AI view, and the person's writing rules |
| Import of a PDF (`importResume`, option A, the owner's choice) | the uploaded PDF, as it is: everything in it |
| Import of a DOCX or pasted text | the text layer, with the contact values entered at onboarding, the block above the first section heading, and status lines removed |
| `verdict replay` (owner only) | a reported verdict's stored posting text and AI view, in the eval workspace |

Never keys, session data, eligibility settings or other people's data. Postings and resumes are data blocks in the prompt, and the model has no tools. Replies are data: schema and code checks, never into HTML, SQL, a shell or a file path. Imperative text aimed at an AI is flagged, and such postings are in the eval.

## API outline

| Area | Routes (all under `/api`) |
|---|---|
| Me | `GET me` (the signed-in person's account; accounts are added with `users add`), `POST me/onboarding/finish`. Sign-in and sign-out happen between the browser and Supabase |
| Settings | `GET settings`, `PUT settings` |
| Master resume | `GET master-resume`, `PUT master-resume`, `PUT master-resume/contact`, `GET master-resume/ai-view`, `POST master-resume/restore-snapshot` |
| Imports | `POST resume-imports`, `GET resume-imports/{id}`, `POST resume-imports/{id}/accept`, `DELETE resume-imports/{id}` |
| Jobs | `GET jobs?view=&q=&page=`, `GET jobs/counts`, `GET jobs/match-count`, `GET jobs/{id}`, `PATCH jobs/{id}`, `POST jobs/{id}/rescreen`, `POST jobs/rescreen-stale`, `POST jobs/{id}/bring-back`, `POST jobs/{id}/report`, `POST jobs/pasted`, `DELETE jobs/pasted/{id}` |
| Tailored resumes | `POST tailored-resumes`, `GET tailored-resumes`, `GET tailored-resumes/{id}`, `PUT tailored-resumes/{id}`, `POST tailored-resumes/{id}/regenerate`, `GET tailored-resumes/{id}/preview`, `POST tailored-resumes/{id}/download`, `GET tailored-resumes/{id}/downloads`, `DELETE tailored-resumes/{id}` |
| Applications | `POST jobs/{id}/applied {resumeId, downloadId}`, `GET applications` |
| Health | `GET /healthz`, `GET /readyz` (outside `/api`, private) |

Owner commands run as `instante <command>` in the owner's own terminal, from the current release in `~/.instante`. Agents never run them, and production secrets never leave `~/.instante/secrets`.

| Area | Commands |
|---|---|
| People | `users add <email> <user-id>`, `users disable\|enable\|delete`, `users relink <email> <new-user-id>`. Creating Supabase users, removing authenticators and revoking sessions happen in Supabase's dashboard |
| Sources | `catalog import`, `sources add\|block\|report`, `companies hide\|show` |
| Screening and AI | `verdict list` (recent reports), `verdict show <report>` (read-only: ids, counts, requirement text, provenance), `verdict replay <report>` (runs experiments with the eval workspace's key and budget; prints verdicts and differences, never cited text or the AI view), `screen rescreen --since-version <v> --estimate`, `ai report`, `ai resume` |

Live evals run from `evals/` on the owner's Mac with the eval workspace's key, never against production.

## Security and privacy

| Boundary or asset | Control |
|---|---|
| Browser to backend | Same origin through the rewrite; everything on loopback, with a foreign `Host` refused; a bearer token on every call, and no cookies read by the backend; `Cache-Control: private, no-store` and `Vary: Authorization` on every `/api` response; a CSP |
| Next.js process | Holds live sessions and renders data: patched the day a security release lands; no image optimization or `next/og` without review; no `'use cache'` |
| Routes | Declared public or signed-in in the contract, failing closed; an unauthenticated matrix in CI covers every route, including encoded-path and trailing-slash variants |
| Sign-in | Supabase Auth with sign-ups off, an 8-digit email code (no links) and an authenticator app; the backend requires `aal2`, so a guessed code or the dashboard's password alone gets nowhere; `ES256` tokens checked against a cached key set, issuer and audience; accounts linked only by Supabase user id; a disabled flag read on every request; test auth only under `test/`, which `src/` can't import, and a production flag that refuses it |
| Session cookies | Supabase's cookies can be read by scripts and hold a refresh token that never expires, so XSS would hand over the session: no raw HTML, React's escaping, no third-party scripts, and a nonce-based CSP once Cache Components is off (phase 2). Accepted for one person; `HttpOnly` sessions come before anyone else uses Instante |
| Hostile documents (uploads, posting HTML) | Parsed only in the document service: a separate process with no secret or database password, listening only on a socket in the `0700` data folder. Inside it, each parse runs in a child under Node's permission model (a seat belt, not a sandbox), with no network, a heap limit, input caps, a timeout and a kill. Typst runs with `--root` set to the job's folder, packages offline and a time limit. On the Mac nothing sandboxes the service itself (R2) |
| Job postings shown to people | Markdown without images, rendered with `react-markdown` without raw HTML; no `dangerouslySetInnerHTML` |
| Fetching | The four API hosts only; manual redirects; checked slugs; decompressed byte caps. No URL a person types is ever fetched |
| AI | The allowlisted AI view with numbered placeholders and pattern-matched status lines withheld; untrusted text as data; no tools; schema and code checks; grounded facts |
| Other people's data | Composite keys, one visibility rule for jobs, an isolation matrix over every route, list and queue job, and no shared side-effects from one person's screening |
| Secrets and credentials | Backend only; Supabase's secret key is held by neither app. Production secrets live only in `~/.instante/secrets` (files `0600` in a `0700` folder), written by `instante setup`; owner commands run in the owner's own terminal; CI holds no secrets |
| The Mac | Real use at a host name of its own; every process on loopback or a socket, started with `--disable-sigusr1` and a clean environment; the web app under Node's permission model, reading only its release; releases only of commits whose own CI passed; FileVault and Time Machine on the owner's checklist; agents kept out of `~/.instante` by `AGENTS.md` and the repository's Claude Code settings, not by the operating system (R9) |
| Logs and errors | One sanitizer for logs, failed jobs and any error report: database errors keep only code, constraint and table, and `Authorization`, `Cookie` and other credentials are redacted (by field name, and bearer tokens, session cookies and URL passwords inside strings). A test forces a failure on a resume write and checks that nothing personal reaches the log or pg-boss |
| Dependencies | pnpm lifecycle scripts blocked; `minimumReleaseAge`; few dependencies with pinned versions; osv-scanner and Semgrep in CI; Typst installed by a pinned, checksummed script |

The CSP has to allow inline scripts while Cache Components and Partial Prerendering are on, so it can't stop an injected script. XSS defence then rests on React's escaping, Markdown without raw HTML, and no third-party scripts or images. Because Supabase's session can be read by scripts, the owner turned Cache Components off (decision D6), which allows a nonce-based `script-src` and `connect-src 'self' https://<project>.supabase.co`.

**Residual risks:**
- A code-execution bug in the parser stack (pdf.js inside unpdf, mammoth, turndown) meets Node's permission model in the child. An exploit that escapes it runs as the owner on the Mac (R2), accepted while only the owner uploads and the boards are hand-picked.
- Software running as the owner, the coding agents included, could read the real data in `~/.instante`; only rules keep the agents out (R9).
- An XSS bug in the web app gives an attacker the Supabase session (above).

**Privacy:** v1 holds only the owner's own data.
- **Processors:** Anthropic (AI calls) and Supabase (email address and sign-in logs). Everything else stays on the owner's Mac. Their data-processing terms are accepted before the alpha.
- **Before anyone else uses Instante:** a privacy notice naming each processor and what it keeps, residence rules, and self-serve export and deletion, as the checklist in [`product.md`](product.md#before-anyone-else-uses-it) says. PIPEDA applies from then on.

The threat model is in [`threat-model.md`](threat-model.md).

## Testing

- **Unit (Vitest):** no database and no network.
  - the places parser, with a fixture per collision: "Toronto", "Toronto, CA", "London, ON", "San Francisco, CA", "Vancouver, WA";
  - filters, the verdict table, the normalizer;
  - the AI view: the status-pattern corpus in both directions, and placeholders;
  - the verifier and placeholder restore, including a leftover-placeholder case;
  - the fit planner.
- **Integration:** a real Postgres 18 everywhere. Locally that's Homebrew's `postgresql@18`, with each test worker copying a migrated template database; in CI, a `postgres:18` service container. Routes run through Hono's `app.request`. Fakes stand in for `fetch` and the AI and refuse anything unscripted. Pause and resume are tested end to end: a paused tailoring build finishes after `ai resume`.
- **Contract:** `tsc` across the workspace; every route's reply parses against its response schema; a route without declared auth fails to register; `contract.json` is current, from the release phase on.
- **Isolation matrix,** generated from the contract's route table, which fails on any route without an entry. For people A and B, with A seeded with every kind of row:
  - B gets 404 on A's path ids;
  - B is refused, with no side effect, for A's ids in a body;
  - B never sees A's rows in lists or search;
  - B's queue jobs against A's objects do nothing;
  - A's screening never changes what B sees.
- **Unauthenticated matrix:** every non-public route returns 401, including path variants, and including a request that carries a valid Supabase session cookie but no bearer header.
- **Token checks:** a wrong algorithm (including `HS256` and `none`), issuer or audience, an expired or anonymous token, a token at `aal1`, and an unknown key id are all refused. A valid token whose user id has no account gets `403 unknown_account`, even when its email matches one. A disabled account gets `403`. With the key endpoint down, cached keys still verify.
- **Production guard:** `src/` can't import the fake Supabase or its test key, and the production build, started with `INSTANTE_ENV=production` and the fake's address, a TCP database URL or a non-loopback address, exits.
- **Prompt privacy, both directions:**
  - **Leaks:** contact values, status statements and the home city never reach a prompt, including when placed inside bullets and custom sections.
  - **Over-removal:** evidence such as "Integrated Visa payments", "Led sponsorship outreach", a degree from a home-city university (degree kept) and "ASP.NET" survives.
- **Document service:** on the production build, its environment holds no secret or database URL, and a child can't reach the network, write, start a process or read the secrets folder.
- **Collection:** recorded board answers, including the 200-then-304 closing case, the glitch hold, the 404-gone case, and a blocked board never fetched.
- **End to end:** Playwright on Chromium against production builds, with the AI and Supabase faked: sign in with an email code and an authenticator code, build the master resume, browse jobs, screen, tailor, download and freeze. Each page also gets an axe check, and no PDF contains a placeholder token.
- **AI evals:** recorded replies replayed on every run, from synthetic fixtures if the repository is public. Live runs happen in each task's slice and after any prompt or model change, from `evals/`, in the eval workspace.
- **The local stack:** on a macOS runner, `instante setup`, `release`, `start`, `backup` and `restore` run end to end in a scratch data folder whose path contains a space; `/readyz` answers, a foreign `Host` gets 421, and the cluster has no TCP listener.

Tests reach only localhost. The quality bar is in [`../CONSTRAINTS.md`](../CONSTRAINTS.md).

## Environments

| | Local | CI | Production |
|---|---|---|---|
| Database | Homebrew's `postgresql@18` cluster, no Docker | `postgres:18` service on Linux; Homebrew's in the macOS job | a PostgreSQL 18 cluster of its own on the owner's Mac, in `~/.instante`, on a Unix socket with passwords required ([ADR-012](decisions/ADR-012-run-on-the-owners-mac.md)). Disposable before the alpha; daily dumps kept 14 days |
| Sign-in | the fake Supabase for agents and tests; the owner uses the development Supabase project | the fake Supabase | the production Supabase project (Canada Central); built-in email, which reaches only the owner |
| AI | dev workspace key, or fake mode | fake mode and recorded replies | production workspace key with a spend limit |
| Processes | `pnpm dev` runs web, backend and document service | built, tested, the production build started; the local stack run end to end on macOS | `instante start` runs web, backend and the document service from the current release in `~/.instante`, on loopback and sockets |

The walking skeleton is set up on the owner's Mac in phase 3, without data. The alpha is the first real use with data: the owner's own search, on the real-use database, the production Supabase project and the production AI workspace, which no agent ever reads ([`AGENTS.md`](../AGENTS.md)).

**Where it runs:** at the phase 2 gate the owner chose their own Mac, for now ([ADR-012](decisions/ADR-012-run-on-the-owners-mac.md)). [ADR-011](decisions/ADR-011-host.md), a DigitalOcean server with a managed database, wasn't adopted. It's the reviewed starting point if Instante moves, and its comparison is in the [hosting note](research/hosting.md).

## Later, and what triggers it

| Addition | Trigger |
|---|---|
| Other people using Instante | The owner wants to invite someone: the checklist in [`product.md`](product.md#before-anyone-else-uses-it) |
| A server, or reaching Instante from the phone | The owner wants it away from the Mac or always on: [ADR-011](decisions/ADR-011-host.md) for a server, or a private network such as Tailscale for the phone |
| Starting Instante at login (a LaunchAgent) | The owner wants collection to run without starting Instante by hand |
| A sandbox for the document service (a macOS sandbox profile or a container) | Others upload, or the sources widen beyond the curated boards |
| A separate macOS user for real use | The agents' access to `~/.instante` becomes a worry |
| Following boards yourself (link parsing, private-until-shared boards) | More than 5 boards added in a month |
| Message Batches for scheduled screening (half price; batch items can't carry the refusal fallback, so refused items take the normal retry) | The owner asks (decision D5: not now) |
| Shared extraction once per posting, per-person matching after | At least 2 people per screened posting, measured, and spend over the owner's threshold; an eval compares it with the single call first |
| Himalayas, Jobicy or RemoteOK | Fewer than 5 remote Yes or Maybe jobs per person per week |
| SerpApi Google Jobs, with cross-source de-duplication (a `listing` table and `pg_trgm`) | The owner approves the cost and the legal risk |
| A Common Crawl catalog builder | The seed catalog goes stale, or the owner wants more boards than requests bring |
| SmartRecruiters, Workable, BambooHR and Recruitee readers; a safe fetcher for careers pages | Many pasted links from one system or company domain |
| Salary and posting-language filters | People ask, or pay is fetched per job |
| Agency and aggregator classification | Agencies above 10% of Yes verdicts |
| Cover letters, Stretch mode, more templates, two pages, DOCX, respelling | The owner adds them, or people ask |
| Autosave and master-resume history | Someone loses work they wanted back |
| Google or GitHub sign-in through Supabase | Codes become tedious |
| Row-level security | Any client besides the store layer gets database access, or sign-up opens |
| Object storage for files | Stored files pass about 1 GB or a quarter of the database |
| Embeddings (pgvector) to rank jobs waiting behind limits | Postings regularly wait behind the daily limit |
| A deletion journal, re-applied after every restore | Anyone else uses Instante |
| Splitting the backend into API and worker processes | The worker measurably slows API responses |
| OpenAPI generated from the contract | A client outside TypeScript appears |
| Owner commands for exporting for or re-addressing a person; admin pages; a usage page | The owner needs them more than once |
| A staging environment | A release breaks real use twice |
| A Go ingestion service | Thousands of boards an hour, measured not to fit one Node process |

The research notes keep longer "Later" tables. Each iteration checks these triggers against measured data ([`sdlc.md`](sdlc.md)).
