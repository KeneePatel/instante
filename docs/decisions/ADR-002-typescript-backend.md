# ADR-002: The backend is TypeScript on Node 26, with Hono, Drizzle and pg-boss

## Status
Accepted 2026-11-13: the owner chose TypeScript at the phase 1 gate. Proposed 2026-11-12 and revised after the adversarial review the same day; it was a close call.

## Date
2026-11-12

## Context
- The owner asked for the backend language "most appropriate to you", meaning the AI agent that writes most of the code, balancing speed (of development and at runtime), efficiency and simplicity.
- The frontend is fixed: Next.js in TypeScript.
- Three advocates made the strongest case they could for Python, TypeScript and Go, and a judge scored them ([backend note](../research/backend.md)).
- The review then found the scoring counted one benefit (one language, no generated client) four times. Re-scored with that benefit counted once, under simplicity:

  | | Python | TypeScript | Go |
  |---|---|---|---|
  | Judge's original totals | 3.80 | 4.30 | 3.35 |
  | One-language benefit counted once | 3.80 | 4.00 | 3.35 |
  | Plus a row for the HTTP layer's security record (FastAPI and Starlette better than Hono) | 3.90 | 4.00 | not re-scored |

- No benchmark compares Python and TypeScript on the same tasks.
  - Multi-SWE-bench's Python figure comes from a separate, easier SWE-bench Verified set, not from Multi-SWE-bench itself.
  - SWE-Bench Pro, as the note reads it, puts Python and Go above JS/TS.
  - All of these measure 2025 models fixing issues in large existing repos, not building a new service.

  So agent reliability is scored a tie.
- The workload is small and waits on the network. Runtime speed doesn't separate the options: an earlier prototype read 807 boards in 79 seconds.

## Decision
TypeScript on Node.js 26 LTS, in the same pnpm workspace as the web app.

| Part | Choice (current version, pinned at scaffold time) |
|---|---|
| HTTP | Hono 4, core only, on `@hono/node-server`; routes registered from the contract table ([ADR-005](ADR-005-same-origin-rewrite-and-typed-contract.md)) |
| Schemas | Zod 4 in `packages/contract`, shared with the web app |
| Database | node-postgres with Drizzle's core query builder; drizzle-kit only drafts SQL |
| Migrations | Numbered SQL files and our own small runner (name and SHA-256 recorded; fails on a gap, an unknown name or an edited file), run as the owner role |
| Queue and schedules | pg-boss 12 in its own schema, installed and upgraded by the owner step, started with `migrate: false`; jobs created in the request's transaction |
| AI | The official `@anthropic-ai/sdk`: `client.beta.messages.parse` with the Zod schema as the output format (the beta endpoint, because the refusal fallback is a beta parameter; [ADR-010](ADR-010-claude-models-are-configuration.md)) |
| Documents | unpdf (PDF text layer), mammoth (DOCX), turndown (HTML to Markdown), all in the document service ([ADR-001](ADR-001-separate-backend.md)); the Typst CLI, installed by a pinned, checksummed script |
| Sign-in | Supabase Auth; `jose` verifies its tokens against a key set the backend caches ([ADR-004](ADR-004-supabase-auth.md)) |
| Checks | `tsc --noEmit` (TypeScript 6.0 pinned: typescript-eslint 8.72 accepts below 6.1, and TypeScript 7 waits until it supports 7); ESLint with typescript-eslint `strictTypeChecked`; Prettier; Vitest |

- **No build step:** the backend runs its `.ts` files with Node's type stripping, with `erasableSyntaxOnly` and `verbatimModuleSyntax` set.
- **Deploys:** images are built from the whole workspace, with symlinks intact, never with `pnpm deploy`. Node won't strip types under `node_modules`. CI boots the production image.

**The real trade.** One language across the repo, with one contract package checked by one compiler and reviewed by an owner who knows TypeScript. The cost: Python's stronger library fit for documents and model output, and its HTTP layer's better security record.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| Python: FastAPI, Pydantic, SQLAlchemy, Procrastinate | Runner-up, close | Best library fit (Pydantic validates every request, reply and model output; Typst runs in process), and FastAPI and Starlette have far fewer advisories than Hono. Costs a second language and toolchain, and an OpenAPI-to-TypeScript step (openapi-typescript is stable), with async traps and fast 0.x churn. |
| Go: Huma on chi, pgx, sqlc, goose, River | Later | Smallest footprint, most stable APIs. The owner doesn't read Go yet, typed structured outputs are beta in its SDK, and there's no maintained permissively licensed DOCX reader. |
| Fastify instead of Hono | Fallback | Older and widely used, with similar classes of past bugs (14 advisories, 6 high, in the same year). Hono is lighter and web-standard. |
| Drizzle's own migrator | Rejected | In 0.45 it can skip a migration without error when branches merge out of timestamp order, and it never compares hashes |
| NestJS, Django with Ninja | Rejected | Decorators don't run under type stripping; Django adds a second language and a mainly synchronous ORM |

## Consequences
- **Good:** one language, package manager, lint and test setup; one contract package; one language to review.
- **npm supply chain**, which has the worst record of the three ecosystems. Mitigated by:
  - pnpm's blocked lifecycle scripts and `minimumReleaseAge`;
  - few dependencies, pinned;
  - osv-scanner.
- **Hono's record:** 53 advisories in a year, 5 high, and 12 of them in parts v1 uses (router, validator, cookies, body parsing). The guards don't depend on Hono's middleware:
  - a route helper that fails closed (every route is declared public or signed-in);
  - an unauthenticated matrix in CI with encoded-path and trailing-slash variants;
  - our own media-type parsing;
  - staying on the newest patch.
- **Several tools are mid-transition** (Hono 5 RC, Drizzle 1.0 RC, TypeScript 7). Pin exact versions and upgrade one at a time. Owning the migration runner keeps Drizzle 1.0's folder change away from production.
- **pg-boss has one maintainer.** Graphile Worker is the fallback, and jobs are plain rows.

## Doubts raised (adversarial review, 2026-11-12)
A single-model review; the owner chose to skip a cross-model second opinion.
- **"The scoring double-counted one-language simplicity, and the sensitivity claim was false":** valid. Re-scored above, and the gate question now says it's close.
- **"The Multi-SWE-bench comparison mixed two datasets":** valid, a factual error the fact-check missed. Corrected here, in the research note and in the gate question.
- **"Drizzle's migrator can skip migrations":** valid. We own a small runner.
- **"Hono's typed client couples the web app to backend internals and checks only one commit":** valid. Replaced by the contract table ([ADR-005](ADR-005-same-origin-rewrite-and-typed-contract.md)).
- **"Type stripping breaks under `pnpm deploy`":** valid. Deploys keep the workspace, and CI boots the image.
- **"pg-boss migrates its own schema, which needs privileges the app role doesn't have":** valid. The owner step installs it.
- **"The worker parses hostile input with all the secrets":** valid. A document service with no secrets ([ADR-001](ADR-001-separate-backend.md)).
- **"`ai` can't use the ledger without breaking the layering":** valid. A port rule: `ai` declares `AiLedger`, and `store` implements it.
- **"The fallback trigger can't be measured":** valid. The language is final once the walking skeleton's acceptance tests pass; after that, only a failed test reopens it. (Cycle 2 moved those checks from throwaway phase 2 spikes into the `platform` slice.)

## Revisit when
- A walking-skeleton acceptance test fails at the start of phase 3: the contract table, pg-boss in a transaction, the document service's isolation, the image booting from the workspace, or memory on the host ([`sdlc.md`](../sdlc.md#phase-3-build-in-slices)).
- Ingestion outgrows one Node process: a Go service is the candidate.
- Heavy local document processing or local embeddings become necessary: Python, for that part only.
