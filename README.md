# Instante

A personal web app for a job search. Instante keeps a pool of full job postings from companies' own job boards and screens them against the master resume, showing the evidence and computing the verdict in code. For a chosen job, it writes a one-page resume using only facts the person already has.

**Status:** phase 2 of 5, *Foundations*. Phase 1 was signed off on 2026-11-13. The owner answered every phase 2 item the same day and chose to run Instante on their own Mac for now ([ADR-012](docs/decisions/ADR-012-run-on-the-owners-mac.md)); the parts of the specs and the threat model revised for that wait for the owner's confirmation. There's no code yet. The lifecycle is in [`docs/sdlc.md`](docs/sdlc.md).

## Read in this order

1. [`docs/product.md`](docs/product.md): what it does, the principles, modules, flows, success criteria, and **the owner's decisions**.
2. [`docs/architecture.md`](docs/architecture.md): how it's built, covering the processes, the frontend/backend split, data and deletion, flows, the AI layer and security.
3. [`docs/decisions/`](docs/decisions/): why, with one ADR per decision, each ending with the doubts the review raised and how they were settled.
4. [`docs/research/`](docs/research/): the evidence, with sources, as of 2026-11-12.
5. [`docs/sdlc.md`](docs/sdlc.md): how it gets built and what each phase must produce.

## The stack

| Part | Choice | Why |
|---|---|---|
| Frontend | Next.js 16 with shadcn/ui, TypeScript, Tailwind, ESLint, pnpm, `create-next-app` defaults (the owner's choice) | [ADR-005](docs/decisions/ADR-005-same-origin-rewrite-and-typed-contract.md) |
| Backend | TypeScript on Node 26: Hono and pg-boss in one process, Drizzle, Zod; a private document service with no secrets parses hostile files and renders PDFs | [ADR-001](docs/decisions/ADR-001-separate-backend.md), [ADR-002](docs/decisions/ADR-002-typescript-backend.md) |
| Contract | A route table in `packages/contract`, shared by web and backend | [ADR-005](docs/decisions/ADR-005-same-origin-rewrite-and-typed-contract.md) |
| Where it runs | The owner's Mac, for now: web app, backend and document service on loopback and sockets, started by hand; no server or domain | [ADR-012](docs/decisions/ADR-012-run-on-the-owners-mac.md), [ADR-005](docs/decisions/ADR-005-same-origin-rewrite-and-typed-contract.md) |
| Database | PostgreSQL 18 for data, queue and files; for real use, a cluster of its own on the Mac, on a Unix socket with passwords | [ADR-003](docs/decisions/ADR-003-one-postgres-database.md) |
| Accounts | Supabase Auth with an emailed code plus an authenticator app, and sign-ups off; the backend verifies its tokens, requires both factors and keeps its own accounts | [ADR-004](docs/decisions/ADR-004-supabase-auth.md) |
| Jobs | A hand-curated catalog of companies' public boards on Greenhouse, Ashby and Lever, plus pasted postings; full postings only | [ADR-006](docs/decisions/ADR-006-shared-pool-of-full-postings.md) |
| Screening | Filters, then one AI call per person and posting; the verdict in code | [ADR-007](docs/decisions/ADR-007-screening-one-call-verdict-in-code.md) |
| Resumes | A versioned JSON master with permanent ids and an allowlisted AI view; strict tailoring checked by code; Typst PDFs; the sent resume frozen | [ADR-008](docs/decisions/ADR-008-master-resume-document.md), [ADR-009](docs/decisions/ADR-009-strict-tailoring-and-typst.md) |
| AI | Claude through one module: Sonnet 5.5 first, Haiku 5.5 where its eval passes, never Opus; spend checked, recorded and paused | [ADR-010](docs/decisions/ADR-010-claude-models-are-configuration.md) |

## For agents

[`AGENTS.md`](AGENTS.md) holds the rules: check skills first, work only in the current phase, commit and merge as the owner, ask before adding dependencies or third parties, and never touch real people's data. [`CONSTRAINTS.md`](CONSTRAINTS.md) holds the quality bar.
