# Backend language and framework

> **Phase 1 review, 2026-11-12:** an adversarial review changed some recommendations in this note. Where they differ, the ADRs in `docs/decisions/` and `docs/architecture.md` are authoritative; each ADR's "Doubts raised" section says what changed and why.

**Owner's decisions, 2026-11-13:** TypeScript confirmed (ADR-002 accepted). Instante is a personal project for the owner, not a launch; multi-user, beta and 50-person estimates in this note describe the earlier framing and are now upper bounds.

Checked on 2026-11-12. The Next.js frontend needs something behind it that owns the data, the secrets, the job pool, the AI calls and the PDF builds. Does that have to be a separate backend, and which language and framework suit an AI agent writing most of the code and one developer reviewing it? Recommendation: a separate backend, written in TypeScript on Node.js 26 LTS and kept in the same pnpm workspace as the Next.js app. One codebase runs two processes, a Hono HTTP API and a pg-boss worker, both on Postgres through Drizzle. Zod schemas are shared with the frontend, and Hono's typed client means no generated client. Python with FastAPI is the runner-up: it fits the workload best and agents score higher in Python, but it adds a second language, a second toolchain and a generated client. Go is for later, if ingestion outgrows one small instance. Weighted scores out of 5: TypeScript 4.30, Python 3.80, Go 3.35.

## Question

- Does Instante need a backend apart from Next.js, or would Route Handlers and Server Actions plus a worker do?
- Which language and framework balance development speed, runtime speed, efficiency and simplicity best, given that Claude writes most of the code?
- Which data-access layer, migrations, queue and scheduler, validation, tooling and test runner, at which versions?

Fixed inputs: Next.js with shadcn/ui and pnpm. The rules in `AGENTS.md`: the frontend never touches the database or holds secrets, only the backend's store layer knows the schema, and dependencies need the owner's approval. PostgreSQL 18 holds the queue, and migrations are plain SQL files ([database note](database.md)). Sessions belong to the backend, behind a Next.js rewrite ([auth note](auth.md)). At most 50 users, one small instance. The Mac has Node 26.13.0, pnpm 10.18.2 and Python 3.12.16, and no Go or Docker.

## Options compared

| Option | Verdict | Why |
|---|---|---|
| TypeScript on Node 26: Hono 4, Drizzle 0.45, pg-boss 12, Zod 4 | recommended | One language, runtime, package manager and lint setup for the whole repo. Types and schemas cross the API boundary without code generation. Weakest on npm supply-chain risk and on 2025 agent benchmarks. |
| Python 3.12+: FastAPI, Pydantic 2, SQLAlchemy 2.1, Alembic, Procrastinate | runner-up | Best library fit (Pydantic checks every request and model reply, Typst runs in process) and the best agent benchmark results. Adds a second language and toolchain, an OpenAPI-to-TypeScript step, async traps and fast 0.x churn. |
| Go 1.27: Huma 2 on chi 5, pgx 5, sqlc, goose, River | later | Smallest footprint, most stable APIs, one static binary. The owner doesn't read Go yet, typed structured outputs are beta in its SDK, and there is no maintained DOCX reader under a permissive licence. |
| Next.js Route Handlers and Server Actions plus a worker | rejected | Puts the database credentials and the Anthropic key in the internet-facing process, which `AGENTS.md` forbids. A separate long-running worker is still needed. |
| Django 6.1 with Django Ninja | rejected | Admin, sessions and a strict deprecation policy come built in. It still adds a second language, and its ORM is mainly synchronous while the worker mostly waits on the network. Revisit only if Python is chosen. |
| Fastify 5.12 instead of Hono | later | Older and widely used, with logging and schema validation built in. It has its own request API and no typed client without code generation. The fallback if Hono causes trouble. |
| NestJS 12 | rejected | Built on decorators, which Node's type stripping doesn't support. Adds modules and dependency injection that v1 doesn't need. |

## Findings

### A separate backend is justified

- Next.js describes its own server features as "not a full backend replacement". They form a public API layer. Where a host runs Route Handlers as functions, they keep no state between requests and long-running ones get cut off. Server Actions are meant for mutations and run one after another ([guide](https://nextjs.org/docs/app/guides/backend-for-frontend), updated 2026-11-06).
- The workload needs a long-running process anyway: schedules, batch polling, Typst renders and imports. That process holds the database connection, the Anthropic key and the domain code, so putting a small HTTP layer on the same code costs little.
- The internet-facing framework is a target. A Critical advisory in 2025-12 allowed remote code execution through React Server Components in Next.js 15.x and 16.x App Router apps, fixed in 16.0.7 and 15.5.7 ([GHSA-9qr9-h5gf-34mp](https://github.com/vercel/next.js/security/advisories/GHSA-9qr9-h5gf-34mp)). If the Next.js process holds no secrets, a bug like that can't reach the database directly.
- Rules in a plain Node service are tested without the Next.js runtime, and they don't move when Next.js changes how it caches.
- The cost is one more process and a rewrite hop. A TypeScript backend in the same workspace shares types with the frontend, which recovers most of the simplicity of one app.

### Claims checked

| # | Claim (made by) | Checked against | Result |
|---|---|---|---|
| 1 | Next.js server code alone would do (the brief) | Next.js guide, above | Not for this workload: a worker is needed regardless. |
| 2 | Python and TS SDKs check structured outputs locally; Go's typed path is beta (all three cases) | [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) | Confirmed. Python: `messages.parse` with a Pydantic model. TS: `zodOutputFormat` moves unsupported constraints into descriptions and validates the reply; `jsonSchemaOutputFormat` doesn't validate. Go: passing a struct is beta, and the stable call takes a raw schema map. Works with Batches. Per request: 20 strict tools, 24 optional and 16 union-typed parameters. Python and TS send map or record types as objects with no keys, so Claude can only return `{}` for them: any map in an output schema has to become an array of key-value pairs. |
| 3 | Each language has a maintained Postgres queue that can enqueue inside a transaction (all) | [PyPI](https://pypi.org/project/procrastinate/), [npm](https://www.npmjs.com/package/pg-boss), Go module proxy, [pg-boss adapters](https://pgboss.io/api/adapters), [Procrastinate docs](https://procrastinate.readthedocs.io/en/stable/) | Confirmed. Procrastinate 3.11.0 (2026-11-11) had 10 releases in a year, and its docs ask for more maintainers. pg-boss 12.38.2 (2026-11-10) has one npm maintainer and takes `db: fromDrizzle(tx, sql)`. River v0.51.2 (2026-11-09) is before 1.0. No language wins here. |
| 4 | Python can render Typst in process; Go has to call the CLI (Python, Go) | [typst wheels](https://pypi.org/project/typst/0.15.2/#files), [Typst releases](https://github.com/typst/typst/releases) | typst 0.15.2 (2026-11-05) has glibc and musl Linux wheels for x86_64 and aarch64, about 34 MB each; its repo has 366 stars. The newest Typst CLI is 0.15.1 (2026-07-17). Node has typst.ts 0.7.0 (2026-05-31). The CLI works from all three. |
| 5 | A TS backend gives the frontend types with no code generation (TS) | [Hono RPC](https://hono.dev/docs/guides/rpc), [transpilePackages](https://nextjs.org/docs/app/api-reference/config/next-config-js/transpilePackages), a local test | True, with conditions: strict mode in both apps, the same Hono version on both sides, and tsserver slows as routes grow (the fix is to compile the types with `tsc`). Turbopack compiles workspace packages with no config. Node 26.13.0 ran a `.ts` workspace package through a pnpm-style symlink; with `--preserve-symlinks` it failed with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. |
| 6 | Python or Go needs an OpenAPI-to-TypeScript step (all) | [Hey API](https://heyapi.dev/openapi-ts/get-started), [FastAPI clients](https://fastapi.tiangolo.com/advanced/generate-clients/), npm | FastAPI's docs recommend Hey API, which says it is in early development and asks users to pin an exact version (0.99.0, 2026-06-22). openapi-typescript 7.13.0 with openapi-fetch 0.17.0 (2026-02-11) is the stable, types-only choice. |
| 7 | Agents do best in Python (Python); TS is weakest (TS and Go cases) | [Multi-SWE-bench](https://arxiv.org/abs/2504.02605), [SWE-bench Multilingual](https://www.swebench.com/multilingual.html), [SWE-Bench Pro](https://scale.com/blog/swe-bench-pro) | Corrected in the phase 1 review: no benchmark compares Python and TypeScript on the same issues. Multi-SWE-bench covers seven languages and no Python; its paper reports a Python figure (45.8% with Claude 3.7 Sonnet) from a separate 500-issue SWE-bench Verified set with easier issues, beside TypeScript's 11.2% on Multi-SWE-bench itself. Multilingual: JS/TS 15 of 43 (34.9%), Go 13 of 42 (31.0%), no Python split. SWE-Bench Pro (2025-09-19): Go and Python higher, JS/TS lower and more varied. All three measure fixes in large existing repos with 2025 models. I found no 2026 per-language data. |
| 8 | The ecosystems churn (all) | PyPI and npm registries | FastAPI 0.162.5 had 123 releases in the year to 2026-11-12. The Python `anthropic` SDK reached 1.0.0 (2026-08-20) and 2.0.0 (2026-10-21) and now depends on `httpx2` ([pydantic/httpx2](https://github.com/pydantic/httpx2)). On npm: hono 5.0.0-rc.1 (2026-10-10); drizzle-orm stable 0.45.4 beside 1.0.0-rc.5; typescript latest is 7.0.2 while typescript-eslint 8.72.2 accepts only <6.1.0; create-next-app 16.4.6 installs typescript ^5. |
| 9 | Security record of the HTTP layer (my own check) | GitHub repository advisories ([Hono](https://github.com/honojs/hono/security/advisories)) | Published since 2025-11-12: Hono 53 (5 high), Fastify 14 (6 high), Starlette 5 (2 high), FastAPI none since 2021. Hono's high ones were in its JWT, CORS, static-file and connection-info middleware. 4.13.16 and 4.13.18 (2026-11) fixed a mount path bypass and a validator Content-Type bypass. Counts reflect disclosure habits as much as bugs. |

Also checked: Node 26 is LTS from 2026-10-28 until 2029-04-30, and type stripping is stable ([schedule](https://github.com/nodejs/Release/blob/main/schedule.json), [docs](https://nodejs.org/api/typescript.html)). pnpm stopped running dependencies' install scripts by default in 10.0 (2025-01-07), added `minimumReleaseAge` in 10.16.0, and made it one day by default in 11.0 (2026-04-28) ([10.0](https://github.com/pnpm/pnpm/releases/tag/v10.0.0), [10.16](https://github.com/pnpm/pnpm/releases/tag/v10.16.0), [11.0](https://pnpm.io/blog/releases/11.0)). Both registries had real attacks: the Shai-Hulud worm hit 500+ npm packages ([CISA, 2025-09-23](https://www.cisa.gov/news-events/alerts/2025/09/23/widespread-supply-chain-compromise-impacting-npm-ecosystem)) and PyPI had the LiteLLM and telnyx compromises ([PyPI, 2026-04-02](https://blog.pypi.org/posts/2026-04-02-incident-report-litellm-telnyx-supply-chain-attack/)). On the Mac, bare Node 26.13.0 peaked at 49.3 MB RSS and bare Python 3.12.16 at 15.0 MB.

### Weights and scores

The weights come from the owner's words (speed, efficiency, simplicity, the language best suited to the agent) and from the workload.

| Criterion | Weight | Why this weight |
|---|---|---|
| Agent reliability | 20 | The owner asked for the language best suited to the agent. |
| Simplicity of the whole system | 20 | The owner asked to keep v1 simple, and one person maintains it. Counts languages, toolchains, generated code and processes. |
| Development speed | 15 | Most of the effort is 30–50 endpoints and one worker. |
| Workload fit | 15 | Model outputs, fetching, documents, Typst, queues. |
| Owner can review it | 15 | The agent writes; the owner's review catches what tests miss. |
| Runtime speed and efficiency | 10 | Requested, but the load is small and I/O-bound, and Next.js runs on Node in every option. |
| Stability and supply chain | 5 | Lockfiles and pins contain most churn; the npm frontend carries npm risk in every option. |

| Criterion (weight) | Python | TypeScript | Go | Main reason |
|---|---|---|---|---|
| Agent reliability (20) | 4 | 4 | 4 | Python has the best benchmarks, Go the strictest compiler, and TS one type system shared with the frontend the agent writes anyway. |
| Simplicity (20) | 3 | 5 | 3 | Python and Go add a language, a toolchain and a generated client; Go also generates its data layer. |
| Development speed (15) | 4 | 5 | 3 | FastAPI and Hono are equally quick per endpoint; TS skips the client-generation loop; Go is verbose and hand-writes DOCX reading and output checks. |
| Workload fit (15) | 5 | 4 | 3 | Python: Pydantic parsing, in-process Typst, the most document tools. TS: Zod parsing, mammoth, turndown. Go: beta typed outputs, no DOCX reader. |
| Owner review (15) | 4 | 5 | 2 | The owner knows Python and TS; one language is easier to review than two; Go is new. |
| Runtime (10) | 3 | 3 | 5 | All three fit one small instance; Go uses the least memory and every core. |
| Stability, supply chain (5) | 3 | 2 | 5 | FastAPI 0.x churn; npm worms and several release candidates at once; Go's compatibility promise and checksum database. |
| **Weighted total (out of 5)** | **3.80** | **4.30** | **3.35** | |

Sensitivity: taking the benchmarks at face value (agent reliability Python 5, TS 3) gives TypeScript 4.10 and Python 4.00. The order flips only if the second language and the generated client are also judged cheap (Python simplicity 4): Python 4.20, TypeScript 4.10. Moving 10 points from simplicity to runtime keeps the order (4.10, 3.80, 3.55).

For reference, the runner-up stack: FastAPI 0.162.5, Pydantic 2.14.3, SQLAlchemy 2.1.8 (needs Python 3.11+), Alembic 1.20.1, psycopg 3.3.9, Procrastinate 3.11.0, anthropic 2.8.0, typst 0.15.2, uv 0.13.8, ruff 0.17.5, pyright 1.1.414 in strict mode, pytest 9.2.0, with openapi-typescript and openapi-fetch on the frontend. The Go stack for later: Go 1.27.4, Huma v2.40.0 on chi v5.5.0, pgx v5.13.0, sqlc v1.31.1, goose v3.30.1, River v0.51.2, anthropic-sdk-go v2.9.0 (all from PyPI and proxy.golang.org on 2026-11-12). For DOCX in Go, the MIT-licensed gomutex/godocx was last pushed on 2025-08-11 and fumiama/go-docx is AGPL-3.0 (GitHub, 2026-11-12).

## Lessons from earlier work

Design lessons from an earlier prototype that apply to a hosted app:

- Check every model reply locally, whatever the provider promises. The SDK's Zod helper checks the schema; each task adds its own semantic checks and a prompt version.
- The model extracts facts and code decides the verdict. Screening stays testable without the API, in any language.
- One HTTP seam serves the job readers and the AI, and its test fake refuses unscripted requests. In Node: pass `fetch` in, and record real board answers as fixtures.
- All AI reliability rules live in one module. The Anthropic SDK already retries 408, 409, 429 and 5xx twice by default (claude-api skill). Instante adds one repair for a reply that fails its checks, a daily budget and the call log.
- Typst runs as a timed subprocess and is tested end to end through the real binary. A subprocess can be killed when it overruns, so Python's in-process binding is less of an edge than it looks (UNVERIFIED for typst-py).
- The module direction is enforced by the build. Instante uses folders plus ESLint import rules.
- Fetching is I/O-bound. An earlier prototype read 807 boards in 79 s, so ingestion doesn't pick the language.

What doesn't transfer from a local, single-user app: a hosted service needs an HTTP framework, a Postgres driver and a queue. Per-user keys on a desktop become one server-side key with per-user budgets. One local user becomes per-user scoping on every query (database note). A one-off board-discovery script doesn't justify a Python backend; seeding can be a TypeScript script.

## Recommendation for v1

### Stack (versions checked 2026-11-12)

| Part | Choice | Version |
|---|---|---|
| Runtime | Node.js 26 LTS. Runs `.ts` files directly through type stripping, so the backend has no build step. | 26.13.x |
| Language | TypeScript with `strict`, `noUncheckedIndexedAccess`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `module: nodenext`, `noEmit`. `tsc --noEmit` checks types. | 5.9.3 in every package (create-next-app's ^5; typescript-eslint needs <6.1) |
| Workspace | pnpm workspace with `apps/web`, `apps/backend` and `packages/contract`. A pnpm catalog keeps one version of each shared library. | pnpm 10.18.2 installed (see questions) |
| HTTP | [Hono](https://hono.dev) on `@hono/node-server`: core and the Zod validator only, no Hono JWT, CORS or static middleware. The web app calls it through `hc<AppType>`. | hono 4.13.18, @hono/node-server 2.1.8, @hono/zod-validator 0.9.1 |
| Validation | Zod schemas in `packages/contract` for request and response bodies and the master resume document. The shadcn forms use the same schemas. | zod 4.6.7 |
| Postgres driver | node-postgres, shared by Drizzle and pg-boss | pg 8.23.1 |
| Data access | [Drizzle](https://orm.drizzle.team) core query builder only (select, insert, update, transaction), with `jsonb` typed through `$type`. Only `store/` imports it. | drizzle-orm 0.45.4 |
| Migrations | `drizzle-kit generate` writes numbered `.sql` files that are reviewed, committed and run forward only, at deploy, as the owner role | drizzle-kit 0.31.11 |
| Queue and schedules | [pg-boss](https://pgboss.io) in its own schema: cron schedules in the database, retries with backoff, dead-letter queues, and queue policies such as `exclusive` for one job per key. A job is created inside the request's transaction with `db: fromDrizzle(tx, sql)`. | pg-boss 12.38.2 |
| Claude API | Official SDK: `messages.parse` with `zodOutputFormat`, Message Batches for bulk screening, PDF document blocks for imports | @anthropic-ai/sdk 1.8.0 |
| Fetching | Built-in `fetch` with `If-None-Match`, `If-Modified-Since` and `AbortSignal.timeout`; a small in-house concurrency gate, global and per host | Node 26 |
| HTML to Markdown | turndown (as the job-collection note proposes) | 7.2.5 |
| Resume import | PDFs go straight to Claude; DOCX becomes text through mammoth first | mammoth 1.13.0 |
| PDF rendering | Typst CLI through `execFile` with a timeout. The resume JSON goes in as a data file the template reads, never spliced into markup. | typst 0.15.1 |
| Accounts | As the auth note says: emailed codes and opaque sessions built on `node:crypto`. Better Auth only as the fallback. | none (better-auth 1.7.22 if needed) |
| Tests | Vitest against a real Postgres cloned from a template (database note). `fetch` is passed in and faked, so tests never touch the network. | vitest 5.1.0 |
| Lint and format | The ESLint setup create-next-app writes, plus typescript-eslint `strictTypeChecked` (`no-floating-promises`, `no-misused-promises`, `no-unsafe-*`), plus Prettier | typescript-eslint 8.72.2, prettier 3.10.1 |
| Logs | JSON lines to stdout from a small helper, plus `ai_call` rows for cost | none |

These are the newest versions on 2026-11-12. With a one-day release-age rule, pnpm picks the previous patch of anything published that day; pin whatever resolves at scaffold time.

### Layout and boundaries

```
apps/web            Next.js 16 (create-next-app defaults) and shadcn/ui. No secrets, no SQL.
apps/backend/src
  api.ts            HTTP entrypoint (Hono routes, session middleware)
  worker.ts         pg-boss workers and schedules
  kit/              HTTP seam, clock, ids, concurrency gate, logger
  jobs/ screening/ resume/ tailoring/   domain logic and types, no SQL
  ai/               SDK client, typed tasks (prompt, Zod schema, own checks, version), budget, call log
  render/           Typst runner
  store/            Drizzle schema, repositories, migrations: the only code that knows tables
  engine/           use cases that combine the modules above; api.ts and worker.ts call only these
packages/contract   Zod schemas and inferred types shared by web and backend
```

A module imports only the ones above it in this list, and ESLint's `no-restricted-imports` fails any other import. The frontend renders pages, runs forms through the shared schemas, polls job status and shows PDFs. The backend owns sessions and invites, every read and write, screening rules and verdicts, model calls, fetching, rendering, files and retention, and it validates every request again. Server Components call the backend's internal URL with the user's cookie; the browser calls `/api/*` through the rewrite (auth note).

### Flows on the backend

1. **Work that waits on a model.** Validate the request. Insert the row as `queued` and create its pg-boss job in the same transaction. Answer 202 with the id; the page polls.
2. **Ingestion.** A schedule enqueues sources that are due, one job per source keyed by the source id on a queue with pg-boss's `exclusive` policy, so a board is never queued or fetched twice at once ([queues](https://pgboss.io/api/queues)). A 304 ends the job. A 200 is normalized and upserted, and new jobs are queued for screening.
3. **Bulk screening.** A job gathers pending pairs into one Message Batch and schedules a poll. Results are matched by `custom_id` and checked with the same Zod schema. Code decides the verdict.
4. **Tailoring.** `messages.parse` with the build's schema, then the task's own checks, then the content is stored. A render job runs Typst and stores the PDF.

### Phase 2 steps

1. Create the workspace and run create-next-app inside `apps/web`. It writes its own pnpm settings there; merge them into the root `pnpm-workspace.yaml` (check in phase 2).
2. Spike before building: Hono's `AppType` imported into `apps/web` (and tsserver speed at about 40 routes), the rewrite and `Set-Cookie` (auth note), a pg-boss send inside a Drizzle transaction, a Typst render with a data file and a timeout, and the memory of web, API and worker on the target host.
3. Then build the first slice: sign in, profile, master resume, one board fetched, the feed.

### What to store

No tables beyond the database note's list. The libraries add their own: `drizzle.__drizzle_migrations` (Drizzle's default, [config docs](https://orm.drizzle.team/docs/drizzle-config-file)) and pg-boss's schema, pruned as the database note says. `ai_call` holds counts and costs, never text.

## Later, and what would trigger it

| Add | Trigger |
|---|---|
| Hono 5 | Its GA release and a short migration guide |
| Drizzle 1.0 (`drizzle-kit up`) | 1.0 reaches GA |
| TypeScript 7 for faster checks | typescript-eslint supports it |
| OpenAPI from the same schemas (@hono/zod-openapi) | A client outside TypeScript, such as a mobile app or a partner |
| Worker on its own host | Ingestion or rendering competes with the API for CPU |
| A Go ingestion service on River | Thousands of boards an hour, measured not to fit |
| Python for evals or local document parsing | Prompt work needs notebooks, or Claude's PDF input costs too much |
| pino and OpenTelemetry | There is somewhere to send logs and traces |
| Better Auth | Passkeys or OAuth arrive, and its advisory rate settles |

## Risks

- **npm supply chain.** The worst record of the three registries. Commit the lockfile, set `minimumReleaseAge`, keep build scripts blocked, keep the dependency list short and patch quickly.
- **Hono's advisory rate.** 53 in a year. Stay on the newest patch, use only core and the Zod validator, and switch to Fastify if core paths keep failing.
- **Several pieces are mid-transition.** Hono 5, Drizzle 1.0 and TypeScript 7 are all close. Pin exact versions and upgrade one at a time.
- **Agents score lower on TypeScript issues** in 2025 benchmarks. Mitigate with strict types, type-aware lint, small modules and tests against a real database. If phase 2 shows the agent struggling, Python is the documented fallback.
- **One event loop per process.** CPU-heavy work (HTML conversion, large JSON) runs in the worker, never in the API.
- **Hono RPC type cost.** At 30–50 routes, compile `AppType` with `tsc` or split the client by area.
- **pg-boss has one maintainer.** Graphile Worker 0.18.0 is the fallback, and jobs are plain Postgres rows that can be drained.
- **Type stripping limits.** No enums, parameter properties, decorators or tsconfig `paths`. `erasableSyntaxOnly` makes tsc reject them; use package `imports` for aliases.
- **Memory on one small instance.** Next.js, API and worker are three Node processes; their total is UNVERIFIED until the phase-2 spike.
- **A second language may come anyway.** If evals or document work later need Python, the repo gains it then, on a narrow job.

## Questions for the owner

1. TypeScript for the backend (one language, the recommendation), or Python (agents benchmark better, at the cost of a second language)?
2. pnpm: keep 10.18 and set `minimumReleaseAge: 1440` yourself, or move to pnpm 11 or 12 first, which default to it? create-next-app writes different pnpm settings for 10 and for 11+.
3. Layout: create-next-app runs inside `apps/web` rather than making `instante/` the Next.js app. Is that acceptable?
4. Do you approve the v1 dependencies? Runtime: hono, @hono/node-server, @hono/zod-validator, zod, pg, drizzle-orm, pg-boss, @anthropic-ai/sdk, turndown, mammoth. Development: drizzle-kit, vitest, typescript-eslint, prettier.
5. Is the one instance meant to run Next.js, the API and the worker, and Postgres too? That sets the memory budget the spike must meet.

## Sources

- Next.js: [backend for frontend](https://nextjs.org/docs/app/guides/backend-for-frontend) · [transpilePackages](https://nextjs.org/docs/app/api-reference/config/next-config-js/transpilePackages) · [GHSA-9qr9-h5gf-34mp](https://github.com/vercel/next.js/security/advisories/GHSA-9qr9-h5gf-34mp) · [create-next-app template](https://github.com/vercel/next.js/blob/v16.4.6/packages/create-next-app/templates/index.ts)
- Claude API: [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) · [batch processing](https://platform.claude.com/docs/en/build-with-claude/batch-processing) · [@anthropic-ai/sdk](https://www.npmjs.com/package/@anthropic-ai/sdk) · [anthropic on PyPI](https://pypi.org/project/anthropic/) · [anthropic-sdk-go](https://github.com/anthropics/anthropic-sdk-go)
- Node and pnpm: [TypeScript in Node](https://nodejs.org/api/typescript.html) · [release schedule](https://github.com/nodejs/Release/blob/main/schedule.json) · [pnpm 10.0](https://github.com/pnpm/pnpm/releases/tag/v10.0.0) · [pnpm 10.16](https://github.com/pnpm/pnpm/releases/tag/v10.16.0) · [pnpm 11.0](https://pnpm.io/blog/releases/11.0)
- TypeScript stack: [Hono RPC](https://hono.dev/docs/guides/rpc) · [Hono advisories](https://github.com/honojs/hono/security/advisories) · [hono](https://www.npmjs.com/package/hono) · [drizzle-orm](https://www.npmjs.com/package/drizzle-orm) · [Drizzle config](https://orm.drizzle.team/docs/drizzle-config-file) · [pg-boss](https://github.com/timgit/pg-boss) · [pg-boss adapters](https://pgboss.io/api/adapters) · [typescript-eslint](https://www.npmjs.com/package/typescript-eslint) · [Fastify advisories](https://github.com/fastify/fastify/security/advisories)
- Python stack: [FastAPI](https://pypi.org/project/fastapi/) · [FastAPI clients](https://fastapi.tiangolo.com/advanced/generate-clients/) · [Starlette advisories](https://github.com/Kludex/starlette/security/advisories) · [Procrastinate](https://procrastinate.readthedocs.io/en/stable/) · [typst-py](https://github.com/messense/typst-py) · [httpx2](https://github.com/pydantic/httpx2) · [Django](https://pypi.org/project/Django/) · [SQLAlchemy asyncio](https://docs.sqlalchemy.org/en/21/orm/extensions/asyncio.html)
- Go stack: [Go releases](https://go.dev/doc/devel/release) · [River](https://github.com/riverqueue/river) · [Huma](https://github.com/danielgtaylor/huma) · [godocx](https://github.com/gomutex/godocx) · [go-docx](https://github.com/fumiama/go-docx)
- Clients: [Hey API](https://heyapi.dev/openapi-ts/get-started) · [openapi-typescript](https://openapi-ts.dev/introduction)
- Agent benchmarks: [Multi-SWE-bench](https://arxiv.org/abs/2504.02605) · [SWE-bench Multilingual](https://www.swebench.com/multilingual.html) · [SWE-Bench Pro](https://scale.com/blog/swe-bench-pro)
- Supply chain: [CISA npm alert](https://www.cisa.gov/news-events/alerts/2025/09/23/widespread-supply-chain-compromise-impacting-npm-ecosystem) · [PyPI incident report](https://blog.pypi.org/posts/2026-04-02-incident-report-litellm-telnyx-supply-chain-attack/)
- Typst: [releases](https://github.com/typst/typst/releases) · [typst on PyPI](https://pypi.org/project/typst/0.15.2/#files)
