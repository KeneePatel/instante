# How Instante gets built

**Now:** phase 2, *Foundations*, started 2026-11-13. Its drafts wait for the owner (the list under [Phase 2](#phase-2-foundations)). Phase 1 was signed off on 2026-11-13.

Instante is built in five phases. Each version goes round them again: version 1 is the smallest product that's useful for one job search, and complexity comes in later versions, only when a trigger in [`architecture.md`](architecture.md#later-and-what-triggers-it) is measured. A phase ends at a gate that only the owner can sign off, and the next phase never starts in the same turn ([`AGENTS.md`](../AGENTS.md)).

The phases follow the owner's installed agent skills, and the practices (not the paperwork) of NIST's Secure Software Development Framework, SP 800-218. Inside a phase, work moves in small changes merged daily, in line with DORA's research on small batches and trunk-based development ([delivery note](research/delivery.md)). Design happens just before it's needed: each module is specified right before it's built, and the risky host assumptions are acceptance tests of the first module, not throwaway spikes.

## The phases

| # | Phase | Produces | Gate: the owner signs off when | Timebox |
|---|---|---|---|---|
| 1 | Discover and decide | Research notes; the spec ([`product.md`](product.md)); [`architecture.md`](architecture.md); ADRs reviewed in two adversarial cycles; a draft [`CONSTRAINTS.md`](../CONSTRAINTS.md); agent rules; this plan | the gate questions in `product.md` are answered and the ADRs accepted or changed | done |
| 2 | Foundations | The host and ADR-011, including where the database runs; the threat model; the retention windows; the final success-criteria numbers; the constraints interview; specs, screens and dependencies for `platform` and `accounts` | each item in the phase 2 list below is approved | about 2 weeks |
| 3 | Build in slices | Module by module: spec, tasks, owner approval, build, demo. The walking skeleton deploys to the host; the alpha (the owner's real search) runs before `tailoring` | each module meets the Definition of Done, the alpha has run, and the owner has seen the whole loop work | about 9 to 11 weeks |
| 4 | Verify and release | The release gates in `product.md` checked; a restore drill; monitors. Release means the owner starts relying on Instante for the search | every release gate passes, or has an approved exception with a date, and the owner says go | about 2 weeks |
| 5 | Operate and learn | A weekly check; the quarterly terms review; a feedback log; incident notes; the iteration review | the next version's scope is approved, which starts phase 1 again for whatever changes | ongoing |

A later version doesn't repeat finished work. It researches only where a trigger fired, and writes an ADR that supersedes an old one only when a decision changes. Tunable numbers live in [`architecture.md`'s limits table](architecture.md#limits-and-windows) and change there, with the owner's yes, without a new ADR.

## Sizing

The estimates assume an AI agent writes the code and the owner reviews about 5 to 8 hours a week, which the owner confirmed at the phase 1 gate. A slice is a task of about five files and one pull request.

| Module | Slices | The owner reads line by line | Owner hours |
|---|---|---|---|
| `platform` (walking skeleton) | 12 ([its spec](specs/platform.md#sizing)) | the contract helper, store scoping, the migration runner, the document service's isolation, `compose.yaml`, the `DOCKER-USER` unit, `cloud-init`'s `sshd` and firewall, the deploy script | 7 |
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
| Setup: repository, Anthropic workspaces, Supabase projects, host | | | 3 |
| The alpha: real use and its findings | | | 5 |
| **Phase 3 total** | **48** | | **about 57** |

At 6 hours a week, phase 3's owner time is about 9.5 weeks, so the timebox is 10 to 12 weeks. Phase 2 is about 10 owner hours, and phase 4 about 8. The fresh-context review of `platform`'s spec found it about twice the size first estimated; the other modules' slice counts are re-checked when each spec is written.

**Cut line:** three items are built as the last slices of phase 3, so they can still be cut when the time comes:
- the Applied list's status and notes (Mark applied stays);
- restoring the import snapshot;
- the review screen's coverage list.

If the projected end passes week 12 at a module's spec approval, the owner decides then which of them move to "Later", instead of the timebox stretching.

## Review policy

- **Read line by line by the owner** (this one list also sets the sizing above; each item sits in the module named):
  - the contract helper's fail-closed auth (`platform`);
  - the server's isolation and deploy path: `compose.yaml`, the `DOCKER-USER` unit, `cloud-init`'s `sshd` and firewall settings, and the deploy script (`platform`);
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
  - migrations, once as the squashed baseline and individually after it.

  These slices merge after one of two fixed review sessions a week.
- **Everything else** merges on green CI plus an agent review pass (the code-review-and-quality skill). The owner sees it at the module's checkpoint demo.
- **Pushing and merging:** by fast-forward from the command line ([`AGENTS.md`](../AGENTS.md)), and only when the owner asks. There's no standing approval.

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

## Phase 2: Foundations

Entry: phase 1 signed off (2026-11-13). Started 2026-11-13. Drafts are linked below; each waits for the owner.

1. **Machine setup, with the owner's yes:**
   - `pnpm self-update 12.18.0`, before any scaffold. pnpm 12 has been stable since 2026-08-26; the Mac has 10.18.2;
   - a `mise.toml` pinning Node 26.13.1, the current Active LTS (the Mac has 26.13.0);
   - `brew install postgresql@18` (18.7);
   - `brew install gitleaks`, because it runs after every edit. osv-scanner and Semgrep run in CI only, which keeps the Mac clean;
   - Typst moves to the `platform` slice, where `scripts/install-typst.sh` is written and reviewed. It pins 0.15.1 by the SHA-256 digests GitHub publishes for each release file.
2. **The host:** [ADR-011](decisions/ADR-011-host.md), including where the production database runs.
3. **Threat model:** [`threat-model.md`](threat-model.md).
4. **Retention:** [the retention table](architecture.md#retention-with-purposes), each window with its purpose. The privacy notice waits for the checklist in [`product.md`](product.md#before-anyone-else-uses-it).
5. **Owner decisions,** each with a recommendation:

   | # | Decision | Recommendation | Recorded in |
   |---|---|---|---|
   | D1 | Success-criteria numbers and the eval's size | Keep the proposed targets and the 150-pair eval (100 tuning, 50 held out). A tighter screening gate needs about three times the labelling | `product.md` |
   | D2 | The list-requirement rule | Accept [ADR-007](decisions/ADR-007-screening-one-call-verdict-in-code.md)'s rule 6 as written: met when every item is shown (any one, for "one of"), partly when some are | ADR-007 |
   | D3 | The eligibility rules offered | All five (sponsorship, clearance, French, graduated, maximum years), each off until turned on | `product.md` |
   | D4 | Whether a withheld line may be released | No in v1: rephrase it instead. A release switch would let status statements reach the screener, which the standing rule forbids. Trigger: withheld-line reports show the patterns hiding real evidence | ADR-008 |
   | D5 | The spend threshold for the Batch API | AI spend above $50 a month, two months running | ADR-010, the limits table |
   | D6 | Cache Components | Off. Every page here is per-person anyway, and it allows a nonce-based CSP, the one CSP that stops an injected script from reading Supabase's session | ADR-005, `CONSTRAINTS.md` |
   | D7 | Error tracking | None in v1: the host's logs through the sanitizer, plus UptimeRobot and Healthchecks.io for liveness, which receive no personal data. Trigger: an error the logs couldn't explain, twice | `architecture.md` |
   | D8 | A domain | Buy one (about $15 a year) before the first real sign-in on production, the end of `accounts`, with DNS at DigitalOcean, CAA records and two-factor sign-in at the registrar. A shared sslip.io hostname lets its operators point the address elsewhere with a valid certificate and collect sessions, so it's only for the data-free walking skeleton | ADR-011 |

6. **`CONSTRAINTS.md`:** the constraint-driven-development interview. There's no code or CI yet; the stack (TypeScript, Vitest, ESLint, Prettier) is decided. The four questions, each with the draft's answer as its default:
   - **Q1, which dimensions beyond the floor are enforced?** Default: coverage of changed lines; security (gitleaks, osv-scanner, Semgrep); accessibility (axe on every page); module boundaries (ESLint); and the project's own rows (isolation, unauthenticated access, tokens, caching, prompt privacy, the document service, placeholders, logs, the image, models). Performance is measured, not enforced, until there's a deployed URL to measure.
   - **Q2, block or warn when a check fails mid-task?** Default: the floor blocks from the first commit; each new numbered row warns for two weeks, then blocks.
   - **Q3, target numbers, or measure and hold?** Default: the skill's defaults where there's nothing to measure yet. Changed lines at least 80% covered; nothing high or above from osv-scanner; zero critical or serious axe findings. Project coverage is held at its first measured value, with 0.5% tolerance.
   - **Q4, the slowest check before work comes back?** Default: `check:fast` under 5 seconds after every edit, `check:task` under 90 seconds at the end of a task, and no limit in CI.
7. **Specs for `platform` and `accounts`:** [`docs/specs/platform.md`](specs/platform.md) and [`docs/specs/accounts.md`](specs/accounts.md), with the sign-in screens and the dependency list.
8. **After the owner approves item 7, in a later turn:** `tasks/plan.md` and `tasks/todo.md`. The spec-driven-development skill never plans in the turn that writes the spec.

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
  - one web image for every environment;
  - the document service's read paths and probes;
  - the real queue pattern;
  - grants for pg-boss;
  - the sign-in pages keep the CSP;
  - early session refresh;
  - outage-safe `proxy.ts`;
  - the missing spec sections;
  - `platform` re-sized to 12 slices.

The outcomes are in ADR-011's "Doubts raised" and in the specs themselves.

Gate: items 1 to 8 approved.

## Phase 3: Build in slices

Entry: phase 2 signed off.

**Per module:** spec (`docs/specs/<id>.md`, with its screens and dependencies), then tasks, then the owner's approval, then the build, then a demo. Each slice is written test-first and reviewed under the review policy.

**Order:**

1. **`platform`, the walking skeleton**, kept, not thrown away:
   - the scaffold, the contract package, the database and migration runner, CI with the floor and gates, the document service;
   - a production deploy without data. Its database is disposable, and the owner recreates it whenever an applied migration changes; the runner's checks are never loosened.

   Its acceptance criteria are the walking-skeleton checks in [its spec](specs/platform.md#acceptance-criteria): CI checks, then checks on the server with the same images and no data. A failure reopens ADR-001, ADR-002, ADR-005 or ADR-011 here, while the cost is one module.
2. **`accounts`:** the two Supabase projects and their settings, the sign-in page with the authenticator step, token verification and the key cache, accounts and owner commands for people, and the fake Supabase for tests ([ADR-004](decisions/ADR-004-supabase-auth.md)).
   - It starts by confirming on the development project what ADR-004 read from Supabase's source: a dashboard-created, confirmed user signs in by code with sign-ups off, and the token reaches `aal2` after the authenticator step.
   - Its session-refresh checks (a page near token expiry refreshes once in `proxy.ts`, on the fake and on the development project) are in [its spec](specs/accounts.md#acceptance-criteria).
   - Before the first real sign-in on production, there's a domain with CAA records (decision D8).
   - It ends with the owner's review of the verifier, the key cache, account linking, the `proxy.ts` session logic and deletion.
3. **`settings`, then `ai` and `job-pool`.**
4. **`master-resume`.** It includes a small import eval (10 fixture resumes, including two-column layouts), from which the import model is chosen ([ADR-010](decisions/ADR-010-claude-models-are-configuration.md)).
5. **`screening`.** It includes the screening eval:
   - 50 anonymized postings × 3 personas, a third held out;
   - the agent drafts labels and the owner corrects them;
   - six model configurations, Haiku and Sonnet at three thinking settings each, compared pair by pair on the 100 tuning pairs.

   The configuration is chosen on the tuning pairs ([ADR-010](decisions/ADR-010-claude-models-are-configuration.md)), and only that one runs on the held-out pairs. The owner sees the numbers at the demo.
6. **`inbox`.**
7. **The owner-only alpha, the first production deploy with data.**
   - Migrations are squashed into a baseline. The owner drops and recreates the production database and pg-boss's schema from it, then turns on backups and point-in-time restore.
   - Before it, the data terms of Anthropic, Supabase and the host are accepted, because the alpha puts real data with them.
   - The owner uses collection and screening for their real search for about a week, on the production database, Supabase project and AI workspace.
   - From here on, migrations only expand.
8. **`tailoring`.** It includes the tailoring eval, from which the model is chosen, then `applications`.

**The scaffold**, in the `platform` slice:
- First, the owner's own command, in `apps/web`. With any flag, `create-next-app` skips its prompts and takes its built-in defaults for the rest; inside an existing repository it doesn't start a new one.
  ```bash
  pnpm create next-app@latest apps/web --typescript --tailwind --eslint
  ```
- Move the `pnpm-workspace.yaml` settings it wrote in `apps/web` into the root, then delete that file and the nested lockfile.
- Add `apps/web/CLAUDE.md` containing `@AGENTS.md`, so Claude Code reads the Next.js notes the scaffold writes there.
- Initialize shadcn/ui with its defaults (Base UI with the Nova preset, per the [frontend note](research/frontend.md)):
  ```bash
  cd apps/web && pnpm dlx shadcn@latest init -b base -p nova
  ```

Every command is checked against its docs again on the day, because versions move.

**Questions for the owner in this phase:**
- the eval labels;
- creating the public GitHub repository;
- creating the Anthropic workspaces and keys, and the two Supabase projects.

## Phase 4: Verify and release

Entry: every module merged, the alpha's findings fixed or recorded.

- **Release gates:**
  - every release gate in [`product.md`](product.md#success-criteria-for-v1), with the eval numbers taken on the held-out set;
  - a short security re-check of what changed since the module reviews.
- **Operations:**
  - deploys and rollback rehearsed from CI;
  - a restore drill: fork from a backup, apply migrations, smoke-test, re-apply logged deletions, delete the fork;
  - UptimeRobot on the web app, and a Healthchecks.io heartbeat and alert monitor from the backend;
  - `contract.json` committed, with two-step changes from here on.
- **Inviting anyone else** isn't part of v1; it follows the checklist in [`product.md`](product.md#before-anyone-else-uses-it).

**Question for the owner in this phase:** staging or not.

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
- Until the alpha (the first production deploy with data), migrations and API shapes may change freely. After it, migrations only expand. From the release phase on, a removal or rename ships in a later deploy than the change that stopped using it.
- No personal data in logs or error reports.
- The module spec and `architecture.md`, including the limits table, describe the system as built. An ADR is superseded only when a decision changes.
- Commits are authored and committed as the owner, with no AI trailers, and merged by fast-forward.
- Slices in the review policy's line-by-line list were read by the owner before merging.
