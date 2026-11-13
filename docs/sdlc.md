# How Instante gets built

**Now:** phase 1, *Discover and decide*, signed off by the owner on 2026-11-13. Phase 2, *Foundations*, is next and starts in a new turn.

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
| `platform` (walking skeleton) | 6 | the contract helper, store scoping, the document service, the migration runner and the first migrations | 4.5 |
| `accounts` | 5: Supabase projects and checks; sign-in page with the authenticator step; token verification and the key cache; accounts and owner commands, deletion included; the fake Supabase for tests | token verification, account linking, the disabled and two-factor checks, deletion | 4 |
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
| **Phase 3 total** | **42** | | **about 54** |

At 6 hours a week, phase 3's owner time is about 9 weeks, so the timebox is 9 to 11 weeks. Phase 2 is about 10 owner hours, and phase 4 about 8.

**Cut line:** three items are built as the last slices of phase 3, so they can still be cut when the time comes:
- the Applied list's status and notes (Mark applied stays);
- restoring the import snapshot;
- the review screen's coverage list.

If the projected end passes week 11 at a module's spec approval, the owner decides then which of them move to "Later", instead of the timebox stretching.

## Review policy

- **Read line by line by the owner** (this one list also sets the sizing above; each item sits in the module named):
  - the contract helper's fail-closed auth (`platform`);
  - token verification, the key cache, account linking, and the disabled and two-factor checks (`accounts`);
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

Entry: phase 1 signed off.

1. **Machine setup, with the owner's yes:**
   - `pnpm self-update 12`, before any scaffold;
   - a `mise.toml` pinning Node 26 (already installed);
   - Homebrew `postgresql@18`;
   - Typst through `scripts/install-typst.sh`, with a pinned version and SHA-256.
2. **The host:** choose the vendor for hosting model (a), against the criteria in [`architecture.md`](architecture.md#environments), and record it as ADR-011. It also decides where the production database runs: on the host (recommended), or in the production Supabase project ([ADR-003](decisions/ADR-003-one-postgres-database.md)).
3. **Threat model:** trust boundaries and abuse cases per flow, with the Next.js process treated as a holder of live sessions, Supabase's script-readable session cookie, and the document service's residual risk stated.
4. **Retention:** the windows from [`architecture.md`](architecture.md#data) as proposals, each with its purpose. The privacy notice waits for the checklist in [`product.md`](product.md#before-anyone-else-uses-it).
5. **Owner decisions:**
   - the final success-criteria numbers, and the eval's size (a tighter screening gate needs about three times the labelling);
   - the list-requirement rule and the eligibility rules offered;
   - whether a withheld line may be released;
   - the spend threshold for the Batch API;
   - Cache Components on or off (off recommended, for a nonce-based CSP that guards Supabase's script-readable session);
   - error tracking or not.
6. **CONSTRAINTS.md:** the four questions of the constraint-driven-development interview, with defaults.
7. **For `platform` and `accounts` only:** the specs (`docs/specs/platform.md`, `docs/specs/accounts.md`), low-fidelity screens for sign-in, the dependency list, and `tasks/plan.md` and `tasks/todo.md`.

Gate: items 2 to 7 approved.

## Phase 3: Build in slices

Entry: phase 2 signed off.

**Per module:** spec (`docs/specs/<id>.md`, with its screens and dependencies), then tasks, then the owner's approval, then the build, then a demo. Each slice is written test-first and reviewed under the review policy.

**Order:**

1. **`platform`, the walking skeleton**, kept, not thrown away:
   - the scaffold, the contract package, the database and migration runner, CI with the floor and gates, the document service;
   - a production deploy without data. Its database is disposable, and the owner recreates it whenever an applied migration changes; the runner's checks are never loosened.

   Its acceptance criteria are the host and design checks:
   - the `Authorization` header passes through the rewrite unchanged, and no `Cookie` header reaches the backend;
   - a page rendered with an access token about to expire is refreshed once, in `proxy.ts`, and doesn't sign the person out;
   - `proxy.ts` refreshes a session from the development Supabase project on the host;
   - a cacheable reply isn't stored;
   - a 6 MB upload gets `413`;
   - a PDF preview and a download work through the typed helper, a `Blob` and an object URL, since links can't carry a bearer token;
   - a 35-second silent request fails cleanly;
   - web, backend and document service fit in 70% of the instance's memory at idle;
   - the document service holds no secrets and can't connect to the database, and its children can't start a process;
   - a route without declared auth fails to register;
   - a pg-boss job created in a request transaction completes in a handler transaction;
   - the production image boots.

   A failure reopens ADR-001, ADR-002 or ADR-005 here, while the cost is one module.
2. **`accounts`:** the two Supabase projects and their settings, the sign-in page with the authenticator step, token verification and the key cache, accounts and owner commands for people, and the fake Supabase for tests ([ADR-004](decisions/ADR-004-supabase-auth.md)).
   - It starts by confirming on the development project what ADR-004 read from Supabase's source: a dashboard-created, confirmed user signs in by code with sign-ups off, and the token reaches `aal2` after the authenticator step.
   - It ends with the owner's review of the verifier, the key cache, account linking and deletion.
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
