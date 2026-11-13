# How Instante gets built

**Now:** phase 3, *Build in slices*, starts with the owner's ruleset on `main` and task T1 of [`tasks/todo.md`](../tasks/todo.md). Phase 2 was signed off on 2026-11-13, with the plan and task list for `platform` and `accounts` approved; phase 1 was signed off the same day.

Instante is built in five phases. Each version goes round them again: version 1 is the smallest product that's useful for one job search, and complexity comes in later versions, only when a trigger in [`architecture.md`](architecture.md#later-and-what-triggers-it) is measured. A phase ends at a gate that only the owner can sign off, and the next phase never starts in the same turn ([`AGENTS.md`](../AGENTS.md)).

The phases follow the owner's installed agent skills, and the practices (not the paperwork) of NIST's Secure Software Development Framework, SP 800-218. Inside a phase, work moves in small changes merged daily, in line with DORA's research on small batches and trunk-based development ([delivery note](research/delivery.md)). Design happens just before it's needed: each module is specified right before it's built, and the risky assumptions about the Mac are acceptance tests of the first module, not throwaway spikes.

## The phases

| # | Phase | Produces | Gate: the owner signs off when | Timebox |
|---|---|---|---|---|
| 1 | Discover and decide | Research notes; the spec ([`product.md`](product.md)); [`architecture.md`](architecture.md); ADRs reviewed in two adversarial cycles; a draft [`CONSTRAINTS.md`](../CONSTRAINTS.md); agent rules; this plan | the gate questions in `product.md` are answered and the ADRs accepted or changed | done |
| 2 | Foundations | Where Instante runs, including the database (ADR-012); the threat model; the retention windows; the final success-criteria numbers; the constraints interview; specs, screens and dependencies for `platform` and `accounts` | each item in the phase 2 list below is approved | about 2 weeks |
| 3 | Build in slices | Module by module: spec, tasks, owner approval, build, demo. The walking skeleton runs on the owner's Mac; the alpha (the owner's real search) runs before `tailoring` | each module meets the Definition of Done, the alpha has run, and the owner has seen the whole loop work | about 10 to 12 weeks |
| 4 | Verify and release | The release gates in `product.md` checked; a restore drill. Release means the owner starts relying on Instante for the search | every release gate passes, or has an approved exception with a date, and the owner says go | about 2 weeks |
| 5 | Operate and learn | A weekly check; the quarterly terms review; a feedback log; incident notes; the iteration review | the next version's scope is approved, which starts phase 1 again for whatever changes | ongoing |

A later version doesn't repeat finished work. It researches only where a trigger fired, and writes an ADR that supersedes an old one only when a decision changes. Tunable numbers live in [`architecture.md`'s limits table](architecture.md#limits-and-windows) and change there, with the owner's yes, without a new ADR.

## Sizing

The estimates assume an AI agent writes the code and the owner reviews about 5 to 8 hours a week, which the owner confirmed at the phase 1 gate. A slice is a task of about five files and one pull request.

| Module | Slices | The owner reads line by line | Owner hours |
|---|---|---|---|
| `platform` (walking skeleton) | 11 ([its spec](specs/platform.md#sizing)) | the contract helper, store scoping, the migration runner, the document service's isolation, the request checks, the local stack's `setup`, home check, `release` and `restore` | 7 |
| `accounts` | 5: the Supabase checks; the fake Supabase; token verification and the key cache; the sign-in pages and `proxy.ts`; accounts, owner commands and deletion | the verifier and key cache, account linking, the `proxy.ts` session logic, deletion | 4 |
| `settings` | 2 | none | 0.5 |
| `ai` | 3 | the ledger and pauses | 1.5 |
| `job-pool` | 6 | fetch allowlist, places parser | 2 |
| `master-resume` | 5 | the AI view, the import prompt, plus the import eval | 4 |
| `screening` | 5 | the prompt and the verdict table, plus labelling the eval | 11 |
| `inbox` | 3 | none | 1 |
| `tailoring` | 5 | the prompt and the verifier, plus grading the eval | 5 |
| `applications` | 2 | none | 0.5 |
| Module specs and checkpoints (10 modules) | | | 9 |
| Isolation and prompt-privacy cases | | | 3 |
| Setup: repository, Anthropic workspaces, Supabase projects, the real-use stack on the Mac | | | 3 |
| The alpha: real use and its findings | | | 5 |
| **Phase 3 total** | **47** | | **about 57** |

At 6 hours a week, phase 3's owner time is about 9.5 weeks, so the timebox stays 10 to 12 weeks. Phase 2 is about 10 owner hours, and phase 4 about 8. The fresh-context review of `platform`'s spec found it about twice the size first estimated; running on the Mac then took it from 12 slices to 11. The other modules' slice counts are re-checked when each spec is written.

**Cut line:** three items are built as the last slices of phase 3, so they can still be cut when the time comes:
- the Applied list's status and notes (Mark applied stays);
- restoring the import snapshot;
- the review screen's coverage list.

If the projected end passes week 12 at a module's spec approval, the owner decides then which of them move to "Later", instead of the timebox stretching.

## Review policy

- **Read line by line by the owner** (this one list also sets the sizing above; each item sits in the module named):
  - the contract helper's fail-closed auth (`platform`);
  - the request checks in `proxy.ts` and the backend, and the local stack: `setup`'s database and folder settings, the home check, `release`'s checks, and `restore` (`platform`);
  - token verification, the key cache, account linking, the `proxy.ts` session logic, and the disabled and two-factor checks (`accounts`);
  - store-layer scoping and the job visibility rule (`platform`, then each module);
  - deletion (`accounts`);
  - the AI view, its patterns and placeholders;
  - the document service's isolation;
  - the ledger and pauses;
  - the fetch allowlist and the places parser;
  - the verdict table;
  - the tailoring verifier and placeholder restore;
  - every prompt;
  - the migration runner (`platform`);
  - migrations, once as the squashed baseline and individually after it.

  These slices merge after one of two fixed review sessions a week.
- **Everything else** merges on green CI plus an agent review pass (the code-review-and-quality skill). The owner sees it at the module's checkpoint demo.
- **Pushing and merging:** by fast-forward from the command line, after CI passes ([`AGENTS.md`](../AGENTS.md)). Since 2026-11-13 the owner allows everyday git work without asking each time; force pushes, deleting remote branches, rewriting published history and GitHub settings still need the owner's yes.

## Phase 1: Discover and decide (signed off 2026-11-13)

- [x] Project folder with git, committing as the owner, plus `AGENTS.md` and `CLAUDE.md`
- [x] Nine research notes, each fact-checked against primary sources ([`research/`](research/))
- [x] Backend language weighed by a three-way panel and a judge ([backend note](research/backend.md))
- [x] Spec, architecture, ten ADRs (all Proposed), a draft quality bar, and this plan
- [x] Review cycle 1: ten fresh-context critics (6 blockers, 123 majors), each finding checked against the documents. The owner chose to skip a cross-model second opinion.
- [x] Review cycle 2: three critics on the revised package, looking for new problems, inconsistencies and complexity (2 blockers, 35 majors). The outcomes are recorded under "Doubts raised" in each ADR. The reviews:
  - made screening one call per person and posting;
  - narrowed the job pool to catalog boards plus pasted postings;
  - put sandboxed parsing in one backend process (cycle 3 then moved it to a document service);
  - added a shared contract table;
  - decided the hosting model now;
  - fixed the AI view's redaction;
  - made the alpha the first production deploy;
  - added the sizing and review policy above.
- [x] Review cycle 3: two critics on the third version (1 blocker, 19 majors), each finding checked and fixed. It:
  - moved hostile parsing into a document service with no secrets, since Node's permission model isn't a security boundary;
  - kept every screening finding per person;
  - added the facts the eligibility rules need;
  - replaced literal status phrases with tested patterns, and placeholders with numbered ones that tailoring restores;
  - kept every download, so the sent one is frozen;
  - made pauses resumable;
  - corrected the eval gate's arithmetic.

  The doubt-driven skill stops at three cycles. Whether to run a fourth, perhaps with a second model, is the owner's call.
- [x] The owner's answers to the gate questions (2026-11-13), applied to every document ([`product.md`](product.md#the-owners-decisions-at-the-phase-1-gate)):
  - ADR-004 rewritten for Supabase Auth, and ADR-010 for Sonnet and Haiku with Opus ruled out;
  - every ADR accepted;
  - the scope made personal, with a checklist for ever inviting anyone else;
  - the catalog hand-curated;
  - no references to other projects, since the repository will be public.
- [x] A fresh-context review of the revised package (15 findings: 5 major, no blockers). Each was checked against Supabase's and Anthropic's documentation, Supabase's auth server source and jose's source, and fixed. The fixes:
  - two factors required at sign-in;
  - accounts linked by Supabase user id;
  - a key cache that survives outages;
  - a production guard against the test sign-in;
  - the model chosen on the tuning pairs;
  - the six model configurations written out.

  The outcomes are under "Doubts raised" in ADR-004 and ADR-010.
- [x] The owner's sign-off on the revised package (2026-11-13)

## Phase 2: Foundations (signed off 2026-11-13)

Entry: phase 1 signed off (2026-11-13). Started 2026-11-13. The owner answered every item on 2026-11-13, and the answers are recorded below.

1. **Machine setup:** done by the owner on 2026-11-13: pnpm 12.18.0, Node 26.13.1 through mise, and PostgreSQL 18.7 and gitleaks 8.30.1 from Homebrew. The `mise.toml` that pins Node comes with the `platform` scaffold, and Typst with `tailoring`.
2. **Where Instante runs:** the owner chose their own Mac, for now, over ADR-011's server. [ADR-012](decisions/ADR-012-run-on-the-owners-mac.md) records it, with defaults for how it runs, which the owner confirmed on 2026-11-13. [ADR-011](decisions/ADR-011-host.md) isn't adopted.
3. **Threat model:** [`threat-model.md`](threat-model.md), approved, then revised for the Mac: a new section, new actors and boundaries, and two new residual risks (R9, R10).
4. **Retention:** [the retention table](architecture.md#retention-with-purposes), approved, with the logs and the backups moved to the Mac. After the review, the deletion journal waits for the checklist in [`product.md`](product.md#before-anyone-else-uses-it). The privacy notice waits for the checklist in [`product.md`](product.md#before-anyone-else-uses-it).
5. **Owner decisions,** answered 2026-11-13:

   | # | Decision | The owner's answer | Recorded in |
   |---|---|---|---|
   | D1 | Success-criteria numbers and the eval's size | Accepted: the proposed targets and the 150-pair eval (100 tuning, 50 held out) | `product.md` |
   | D2 | The list-requirement rule | Accepted: [ADR-007](decisions/ADR-007-screening-one-call-verdict-in-code.md)'s rule 6 as written, met when every item is shown (any one, for "one of"), partly when some are | ADR-007 |
   | D3 | The eligibility rules offered | Accepted: all five (sponsorship, clearance, French, graduated, maximum years), each off until turned on | `product.md`, ADR-007 |
   | D4 | Whether a withheld line may be released | Accepted: no in v1; the line is rephrased instead. Trigger: withheld-line reports show the patterns hiding real evidence | ADR-008 |
   | D5 | A spend threshold for the Batch API | Not now: no budgeting options in v1 beyond the $100 monthly budget. Batch processing waits until the owner asks | `architecture.md`'s "Later" table |
   | D6 | Cache Components | Accepted: off, which allows the nonce-based CSP | ADR-005, `CONSTRAINTS.md` |
   | D7 | Error tracking | Accepted: none in v1, logs only. With Instante on the Mac, UptimeRobot and Healthchecks.io are dropped too: nothing is public, and the owner is at the Mac when Instante runs. Trigger: an error the logs couldn't explain, twice | `architecture.md`, ADR-012 |
   | D8 | A domain | No for now; nothing needs one while Instante runs only on the Mac, at `http://instante.localhost:4310` | ADR-012 |

6. **`CONSTRAINTS.md`:** the constraint-driven-development interview. The owner accepted all four defaults on 2026-11-13:
   - **Q1, which dimensions beyond the floor are enforced?** Default: coverage of changed lines; security (gitleaks, osv-scanner, Semgrep); accessibility (axe on every page); module boundaries (ESLint); and the project's own rows (isolation, unauthenticated access, tokens, caching, prompt privacy, the document service, placeholders, logs, the production build, the local stack, models). Performance is measured, not enforced, until there's a running URL to measure.
   - **Q2, block or warn when a check fails mid-task?** Default: the floor blocks from the first commit; each new numbered row warns for two weeks, then blocks.
   - **Q3, target numbers, or measure and hold?** Default: the skill's defaults where there's nothing to measure yet. Changed lines at least 80% covered; nothing high or above from osv-scanner; zero critical or serious axe findings. Project coverage is held at its first measured value, with 0.5% tolerance.
   - **Q4, the slowest check before work comes back?** Default: `check:fast` under 5 seconds after every edit, `check:task` under 90 seconds at the end of a task, and no limit in CI.
7. **Specs for `platform` and `accounts`:** [`docs/specs/platform.md`](specs/platform.md) and [`docs/specs/accounts.md`](specs/accounts.md), with the sign-in screens and the dependency lists. Approved 2026-11-13, then revised for the Mac; the revised parts were confirmed the same day.
8. **The plan and the task list:** [`tasks/plan.md`](../tasks/plan.md) and [`tasks/todo.md`](../tasks/todo.md), written 2026-11-13 after the owner confirmed the revised specs (the spec-driven-development skill never plans in the turn that writes or revises a spec). Approved by the owner on 2026-11-13.

**Reviews of these drafts, 2026-11-13:** two fresh-context critics read them, one for security and operations and one for the specs. Each finding was checked against Docker's, OpenSSH's, Next.js's, pg-boss's and Node's documentation or source, then fixed:
- **Security and operations:** 12 findings, 9 major. The fixes:
  - the deploy key restricted;
  - a domain before any real sign-in (D8);
  - the database fenced to the backend;
  - the document service's network gateway isolated;
  - rollback across migrations;
  - secrets moved to per-service files;
  - the document service hardened;
  - logs capped.
- **The specs:** 12 findings, 2 blockers and 9 major. The fixes:
  - the on-server checks run on a test-mode stack;
  - one build destination checked at start (now one per build, ADR-012);
  - the document service's read paths and probes;
  - the real queue pattern;
  - grants for pg-boss;
  - the sign-in pages keep the CSP;
  - early session refresh;
  - outage-safe `proxy.ts`;
  - the missing spec sections;
  - `platform` re-sized to 12 slices.

The outcomes are in ADR-011's "Doubts raised" and in the specs themselves. With ADR-011 not adopted, the findings about the server no longer apply; the spec findings still do.

**Review of the Mac design, 2026-11-13:** a fresh-context security review found 16 problems (1 blocker, 7 major, 7 minor, 1 over-built). Eight verifiers then tried to disprove each against primary sources and probes on the Mac: none was refuted, and nine were corrected in detail. The fixes, recorded in ADR-012's "Doubts raised":
- real use moved to `instante.localhost`, so development pages can't read its session cookie;
- `Host` checks on every request, plus `X-Forwarded-Host` and Fetch Metadata;
- the web app pinned to loopback and run under Node's permission model;
- a working `setup`, with a role for each job;
- a safe test-mode home;
- releases that check the exact commit's CI, built in their own folders;
- a lock;
- the pinned locale;
- rollbacks by restoring the pre-release dump;
- the deletion journal deferred.

The agents' access to `~/.instante` is left to the owner (R9).

A second review of the revised documents, one reviewer for consistency and one for buildability, then found the bootstrap couldn't create the real home, rollback mode contradicted other files, prefetches skipped the session refresh, and an open tab could reach a test on the real port. Each was fixed, with a dozen minor ones (ADR-012's "Doubts raised").

Gate: items 1 to 8 approved. Signed off by the owner on 2026-11-13, with the plan and task list approved, including the link check T25 adds to CI.

## Phase 3: Build in slices

Entry: phase 2 signed off.

**Per module:** spec (`docs/specs/<id>.md`, with its screens and dependencies), then tasks, then the owner's approval, then the build, then a demo. Each slice is written test-first and reviewed under the review policy.

**Order:**

1. **`platform`, the walking skeleton**, kept, not thrown away:
   - the scaffold, the contract package, the database and migration runner, CI with the floor and gates, the document service;
   - the real-use stack set up on the owner's Mac, without data. Its database is disposable, and the owner recreates it whenever an applied migration changes; the runner's checks are never loosened.

   Its acceptance criteria are the walking-skeleton checks in [its spec](specs/platform.md#acceptance-criteria): CI checks on Linux, the local stack on macOS in a scratch folder, then the owner's own set-up on the Mac with no data. A failure reopens ADR-001, ADR-002, ADR-005 or ADR-012 here, while the cost is one module.
2. **`accounts`:** the two Supabase projects and their settings, the sign-in page with the authenticator step, token verification and the key cache, accounts and owner commands for people, and the fake Supabase for tests ([ADR-004](decisions/ADR-004-supabase-auth.md)).
   - It starts by confirming on the development project what ADR-004 read from Supabase's source: a dashboard-created, confirmed user signs in by code with sign-ups off, and the token reaches `aal2` after the authenticator step.
   - Its session-refresh checks (a page near token expiry refreshes once in `proxy.ts`, on the fake and on the development project) are in [its spec](specs/accounts.md#acceptance-criteria).
   - It ends with the owner's review of the verifier, the key cache, account linking, the `proxy.ts` session logic and deletion.
3. **`settings`, then `ai` and `job-pool`.**
4. **`master-resume`.** It includes a small import eval (10 fixture resumes, including two-column layouts), from which the import model is chosen ([ADR-010](decisions/ADR-010-claude-models-are-configuration.md)).
5. **`screening`.** It includes the screening eval:
   - 50 anonymized postings × 3 personas, a third held out;
   - the agent drafts labels and the owner corrects them;
   - six model configurations, Haiku and Sonnet at three thinking settings each, compared pair by pair on the 100 tuning pairs.

   The configuration is chosen on the tuning pairs ([ADR-010](decisions/ADR-010-claude-models-are-configuration.md)), and only that one runs on the held-out pairs. The owner sees the numbers at the demo.
6. **`inbox`.**
7. **The owner-only alpha, the first real use with data.**
   - Migrations are squashed into a baseline. The owner drops and recreates the real-use database and pg-boss's schema from it, and checks that FileVault is on and that Time Machine copies `~/.instante/backups`.
   - Before it, the data terms of Anthropic and Supabase are accepted, because the alpha puts real data with them, and the owner decides whether to add Claude Code's sandbox or a separate macOS user for real use (R9).
   - The owner uses collection and screening for their real search for about a week, on the real-use database, the production Supabase project and the production AI workspace.
   - From here on, migrations only expand.
8. **`tailoring`.** It includes the tailoring eval, from which the model is chosen, then `applications`.

**The scaffold**, in the `platform` slice: the owner's own `create-next-app` and `shadcn init` commands, with versions pinned at least 7 days old, then the merges and replacements [its spec](specs/platform.md#the-workspace) lists.

Every command is checked against its docs again on the day, because versions move.

**Questions for the owner in this phase:**
- the eval labels;
- creating the public GitHub repository;
- creating the Anthropic workspaces and keys, and the two Supabase projects;
- setting up the real-use stack on the Mac (`instante setup`) and releasing to it.

## Phase 4: Verify and release

Entry: every module merged, the alpha's findings fixed or recorded.

- **Release gates:**
  - every release gate in [`product.md`](product.md#success-criteria-for-v1), with the eval numbers taken on the held-out set;
  - a short security re-check of what changed since the module reviews.
- **Operations:**
  - a release and a rollback rehearsed on the Mac;
  - a restore drill, run by the owner: in a scratch `INSTANTE_HOME`, `setup`, then `restore` with a recent dump, then `start` and a smoke test, then delete the folder;
  - `contract.json` committed, with two-step changes from here on.
- **Inviting anyone else** isn't part of v1; it follows the checklist in [`product.md`](product.md#before-anyone-else-uses-it).


## Phase 5: Operate and learn

- **Weekly:** AI spend against budget, refusal and "Not screened" rates, errors, fetch health, the queue backlog, dependency updates, and the feedback log.
- **Quarterly:** re-read each source's terms, `robots.txt` and content signals ([ADR-006](decisions/ADR-006-shared-pool-of-full-postings.md)).
- **Per incident:** a note.
- **Per iteration:** check every "Later" trigger against measured data, propose the next version's scope, and start phase 1 again for what changes.

## Definition of Done (every slice)

- The acceptance criteria are met and the behaviour has been checked at runtime.
- The tests fail without the change and pass with it.
- Every gate in [`CONSTRAINTS.md`](../CONSTRAINTS.md) is green, with changed lines at least 80% covered. A miss needs an exception row the owner approved, with an expiry.
- No new suppressions, skipped tests or weakened constraints.
- Until the alpha (the first real use with data), migrations and API shapes may change freely. After it, migrations only expand. From the release phase on, a removal or rename ships in a later release than the change that stopped using it.
- No personal data in logs or error reports.
- The module spec and `architecture.md`, including the limits table, describe the system as built. An ADR is superseded only when a decision changes.
- Commits are authored and committed as the owner, with no AI trailers, and merged by fast-forward.
- Slices in the review policy's line-by-line list were read by the owner before merging.
