# Implementation plan: `platform` and `accounts`

**Status:** written 2026-11-13, after the owner confirmed the revised specs, and revised the same day after two fresh-context reviews (coverage against the specs; order, size and verifiability). Approved by the owner on 2026-11-13, at the phase 2 sign-off. It covers the first two modules of phase 3 ([`docs/sdlc.md`](../docs/sdlc.md#phase-3-build-in-slices)). Each later module gets its own spec, then its own plan, when its turn comes. The tasks are in [`todo.md`](todo.md).

## Overview

`platform` builds the walking skeleton:
- the pnpm workspace, the contract, the backend with its store, queue and migration runner, the document service and the web shell;
- CI on Linux, growing from the first task on;
- the owner's local stack (`instante setup`, `start`, `release`, `rollback`, `backup`, `restore`, `cli`), tested end to end on macOS.

It ends with the owner setting the stack up on the Mac with no data ([spec](../docs/specs/platform.md)).

`accounts` then adds sign-in through Supabase Auth with an emailed code and an authenticator app, the backend's token checks, accounts and owner commands, and the fake Supabase for tests. It ends with the owner's first real sign-in at `http://instante.localhost:4310` ([spec](../docs/specs/accounts.md)).

## Decisions this plan rests on

All of them are already made; the plan only orders the work.
- **Hosting model (a), on the owner's Mac:** web, backend and document service as local processes, a database cluster of its own, releases built from GitHub's `main` ([ADR-005](../docs/decisions/ADR-005-same-origin-rewrite-and-typed-contract.md), [ADR-012](../docs/decisions/ADR-012-run-on-the-owners-mac.md)).
- **The stack:** TypeScript on Node 26 with Hono, pg-boss, Drizzle as a query builder, our own migration runner ([ADR-001](../docs/decisions/ADR-001-separate-backend.md), [ADR-002](../docs/decisions/ADR-002-typescript-backend.md), [ADR-003](../docs/decisions/ADR-003-one-postgres-database.md)).
- **Sign-in:** Supabase Auth, verified by the backend against its own key cache, two factors required ([ADR-004](../docs/decisions/ADR-004-supabase-auth.md)).
- **The quality bar:** [`CONSTRAINTS.md`](../CONSTRAINTS.md), accepted 2026-11-13. The floor blocks from the first commit with code; each numbered row warns for its first two weeks, then blocks.
- **Every task** meets the [Definition of Done](../docs/sdlc.md#definition-of-done-every-slice): test first, `check:task` green, CI green on its branch, changed lines at least 80% covered, no weakened checks, commits as the owner with no trailers.

## How the work is ordered

```
O0: repository, ruleset, main = phase-2
 └─ workspace with CI's first job, scaffold, checks, guards (T1–T4)
      ├─ contract (T5) ─ backend config, kit, API (T6–T8) ─ runner (T9) ─ harness (T10) ─ queue (T11)
      │                                                                                   │
      │                    document service and its isolation (T12–T13) ──────────────────┤
      ├─ web request rules, configuration, fetch helper (T14–T16) ────────────────────────┤
      │                       shell (T17a), ping page and pnpm dev (T17b) ─────────────────┤
      │                                          CI scanners, production build (T18) ─────┤
      │                                                          end to end (T19) ────────┘
      │                                                             └─ setup (T20) ─ release (T21) ─ start (T22)
      │                                                                 ─ rollback, backup, restore (T23) ─ cli and macOS checks (T24)
      │                                                                 ─ guides and runbooks (T25) ─ owner's set-up (O1)
      └─ A1: Supabase check on the development project (owner-led, any time after T4)
                                                                            │
           fake Supabase (A2) ─ verifier and key cache (A3) ─ accounts and authenticate (A4) ─┬─ /api/me and matrices (A5)
                                                                                              │    ─ the fake in every stack (A6) ─ Supabase clients (A7)
                                                                                              │    ─ proxy.ts session, tests signed in (A8) ─ sign-in pages (A9) ─ sign-in end to end (A10)
                                                                                              └─ owner commands and deletion (A11)
                                                                                                     └─ the owner's checks, then the first real sign-in (O2)
```

- **Foundations first:** CI's first job lands with T1 and grows with each task, so every pull request is checked on its own branch before any feature code exists.
- **Risky things early:**
  - T2 tries `next start` under the Node permission model on the bare scaffold, so `next.config.ts` can change before anything is built on it;
  - T2 and T3 find out on day one whether shadcn's components pass the strict TypeScript flags;
  - A1 checks on the development project what ADR-004 read from Supabase's source, any time from T4 on;
  - T19 runs the production build under the same flags `instante start` will use, before the local stack is written.
- **Release before start:** `start` runs from the release `current` points at, refuses stale migrations, and keeps the dumps `releases.log` names, so `release` (T21) is built before `start` (T22).
- **Accounts keeps platform green:** A6 puts the fake into every test stack before any page needs a session, and A8 signs platform's tests in (by setting the session cookies from the fake) in the same task that starts redirecting.

## Phases and checkpoints

| Phase | Tasks | Ends with |
|---|---|---|
| A. Foundation | T1–T4 | Checkpoint 1: a clean install runs no lifecycle scripts; `check:fast` under 5 seconds; CI's first jobs green on a pull request |
| B. Backend core | T5–T11 | Checkpoint 2: `check:task` green; integration tests on Postgres 18 with the pinned locale, locally and in CI; review session (contract helper, request checks, runner, store scoping) |
| C. Document service, web and CI | T12–T19 | Checkpoint 3: every Linux job green on one pull request; review session (the document service, `proxy.ts`'s checks) |
| D. Local stack | T20–T25, then O1 | Checkpoint 4: every job green, the macOS one included; review session (`setup` and the home check, `release`'s checks, `restore`); the owner's set-up on the Mac; **`platform` demo** |
| E. Accounts | A1–A11, then O2 | Checkpoint 5: CI green; review session (verifier and key cache, linking with the disabled and two-factor checks, `proxy.ts`'s session logic, deletion); the owner's checks on the development project; the first real sign-in; **`accounts` demo** |

## Who does what

- **The agent:** every `T` and `A` task, test first, on a branch of its own, one pull request per task.
- **The owner:**
  - approves this plan;
  - signs off phase 2;
  - in O0, before T1 (the repository and `main` were done on 2026-11-13):
    - adds the repository's ruleset: deletions restricted, force pushes blocked, nobody may bypass, and each CI job added as a required check once it has first run;
  - creates the two Supabase projects and runs A1's script;
  - runs O1 and O2 on the Mac, and the development-project check before O2;
  - reviews the line-by-line tasks in the two weekly sessions.
- **Pushes and merges** follow the owner's standing approval of 2026-11-13 ([`AGENTS.md`](../AGENTS.md)): a merge is a fast-forward after CI passes on the branch, and force pushes or GitHub settings still need the owner's yes.
- **Line-by-line reviews:** T5, T8, T9, T10, T12, T13, T14, T20, T21, T23, A3, A4, A8 and A11 ([review policy](../docs/sdlc.md#review-policy)). A task built on one of them may be written on top of its branch, but merges after it. Everything else merges on green CI plus an agent review pass.

## Sizing

The specs' 16 slices (11 for `platform`, 5 for `accounts`) become 37 tasks here (26 and 11), because the planning skill caps a task at about five hand-written files. The owner's review time follows the line-by-line list, not the task count, so it stays at about 7 hours for `platform` and 4 for `accounts` ([`sdlc.md`](../docs/sdlc.md#sizing)). The pull requests are smaller, so each review session can take several. Phase 3's timebox stays 10 to 12 weeks.

## Parallel work

- A1 belongs to the owner, in the Supabase dashboard and a terminal, and can happen any time after T4.
- After T5:
  - the web tasks T14 to T16 can run beside the backend tasks T6 to T11;
  - T12 and T13 (the document service) need T11.
- A11 (owner commands and deletion) can run beside A5 to A10 once A4 is in.
- A2 to A10 run one after the other: each adds to the backend's manifest, the auth code or the test stacks the next one uses.
- Everything touching `schema_migrations`, `cli db migrate`, `ci.yml` or `scripts/local/` is sequential.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| shadcn's generated components fail `exactOptionalPropertyTypes` or the typed lint rules | Med | Found in T2–T3; the owner approves an edited copy or a narrower flag for `components/ui`, recorded as an exception ([spec](../docs/specs/platform.md#the-workspace)) |
| `next start` won't run under `--permission` with reads limited to its folder, or needs `--allow-addons` | Med | Tried in T2 on the bare scaffold; the options are `next.config.mjs`, `--allow-addons`, or the owner accepting the risk; T19 confirms it on the production build |
| A version we need is younger than 7 days | Low | The security-release exception in the spec; otherwise wait out the 7 days |
| A dashboard-created user can't sign in by code with sign-ups off, or doesn't reach `aal2` | High | A1 runs before any `accounts` code, and can run during `platform`; a failure reopens ADR-004 |
| Supabase's cookie doesn't survive on plain `http://instante.localhost` in the owner's browser | Med | The review's WebKit and Chrome probes passed; O2 confirms it; the fallback is `127.0.0.1:4310`, opened by nothing else |
| Node's permission model behaves differently from the probes (the `lsof` check, Unix sockets with `--allow-net`) | Med | T13 tests each probe on Linux, and T24 on the macOS job; the spec says which behaviours are relied on |
| New pages break the end-to-end tests once sign-in redirects | Med | A6 runs the fake in every stack first, and A8 signs the tests in within the task that adds the redirects |
| A test of `scripts/local` touches the owner's real home | High | Every such test sets `HOME` and `INSTANTE_HOME` to scratch folders (keeping only the tool and package caches), test mode skips `brew pin`, agents never follow the runbook for real, and Claude Code denies `~/.instante` in the owner's user settings |
| The macOS runner lacks `lockf` or behaves differently from macOS 27 | Low | T20's job checks the tools first; a `mkdir` lock is the fallback, with the owner's yes |
| A pg-boss upgrade lands with a schema change mid-module | Low | pg-boss is pinned exactly; an upgrade is its own release |
| Review-marked pull requests queue up behind the two weekly sessions | Med | Tasks within a phase are often independent, and several can be ready for one session; others merge on green CI |

## Open questions

None block the plan. The owner's approval included one check the specs don't list: T25's link check in CI (`scripts/check-links.mjs`, Node, no dependency). Before the alpha, not now, the owner decides whether to add Claude Code's sandbox or a separate macOS user for real use (R9).
