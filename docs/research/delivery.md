# Delivery process, quality gates and operations

> **Phase 1 review, 2026-11-12:** an adversarial review changed some recommendations in this note. Where they differ, the ADRs in `docs/decisions/` and `docs/architecture.md` are authoritative; each ADR's "Doubts raised" section says what changed and why.

**Owner's decisions, 2026-11-13:** hosting model (a) is chosen: the web app and backend on one host, backend private. The repository will be public on GitHub. Opus is never used. Instante is a personal project for the owner, not a launch; multi-user, beta and 50-person estimates in this note describe the earlier framing and are now upper bounds.

Checked on 2026-11-12. The question: how does one developer, with AI agents writing most of the code, take Instante from research to an invite-only beta of at most 50 users, and keep it correct, private and running? Recommendation: six gated phases (research, specify, plan, build in slices, release, operate) that repeat each iteration. Work is trunk-based, in slices merged daily, and checks run at three speeds: after an edit, at task end and in CI. Every test layer uses a real Postgres: Homebrew's `postgresql@18` on the Mac, cloned from a template, and a `postgres:18` service container in CI. A committed `openapi.json` plus generated TypeScript types catch contract drift. GitHub Actions runs five jobs, mostly in parallel, in about 6–8 minutes (estimate). The default host is Vercel for Next.js plus DigitalOcean Toronto (App Platform for the API and worker, Managed PostgreSQL), about US$35–40 a month. The host is chosen at the release gate. Logs carry ids and counts only, Sentry gets a locked-down config, and every LLM call is costed per user. The privacy notice says resumes go to Anthropic in the US. CONSTRAINTS.md starts from the constraint skill's floor and defaults.

## Question

- What lifecycle suits one developer plus agents: phases, outputs, gates, definition of done, and how the design is revisited for v2 and later?
- How is each layer tested in Python, TypeScript or Go, with no Docker on the Mac? How are LLM features tested?
- What does CI run, what blocks a merge, and how long does it take?
- Where do Next.js, an API, a worker and Postgres run for ≤ 50 users, Canada preferred? What does that cost, and who does the backups?
- What do we log, track and alert on, including LLM cost per user, without leaking resumes?
- What do PIPEDA, Quebec's Law 25 and GDPR require of a service holding resumes, and what do users need to be told about Anthropic and the hosts?
- Which CONSTRAINTS.md defaults fit this stack?

## Options compared

| Option | Verdict | Why |
|---|---|---|
| Six gated phases, repeated per iteration, with small slices inside Build | recommended | Matches the installed skills' gates and DORA's small-batch findings. Each gate is one owner sign-off. |
| Full SSDF programme or a formal SDLC with roles and boards | rejected | Built for organisations. One person keeps the practices that apply, mapped below. |
| Trunk-based: short branches, one PR per slice, merged the same day | recommended | DORA: ≤ 3 active branches, merge at least daily. An earlier prototype ended with 35 stale branches. |
| GitFlow or long-lived feature branches | rejected | Big merges and slow feedback. |
| Homebrew `postgresql@18` + template clones for tests | recommended | Real engine, no Docker, the same major version as CI. |
| Postgres.app | runner-up | Same engine as a Mac app (bundles 14–18). Fine if the owner prefers a GUI. |
| Testcontainers | rejected | Needs Docker. |
| PGlite (Postgres in WASM) | rejected | Runs in-process. Queue tests need several real connections (UNVERIFIED whether PGlite can serve them). |
| Code-first OpenAPI, committed `openapi.json`, generated TS types, diff check + `oasdiff breaking` | recommended | Works for all three languages. Drift fails CI. Breaking changes are split into two deploys. |
| tRPC or hand-written shared types | rejected | tRPC ties the backend to TypeScript. Hand-written types drift. |
| Playwright on Chromium only, LLM replaced by recorded replies | recommended | Deterministic and free. Covers async Server Components, which Vitest can't render. |
| LLM evals: recorded replies replayed on every run + live runs on prompt or model change | recommended | Proven in an earlier prototype. |
| GitHub Actions, five parallel jobs on `ubuntu-latest` | recommended | Service containers need Linux. Fits the free allowance. |
| Vercel (yul1) + DigitalOcean Toronto (App Platform + Managed PostgreSQL) | recommended default | Backend and data in Toronto, managed backups with 7-day point-in-time restore, low ops, about US$35–40/month. |
| Vercel + Fly.io Toronto (Machines + Managed Postgres) | runner-up | Good deploy tooling and a Toronto region, but about US$55–60/month. |
| One VPS (DO Toronto, OVHcloud Beauharnois or Lightsail ca-central-1) with Docker Compose and Caddy | runner-up (cost) | US$12–30/month, but the owner patches the OS, runs Postgres, backs it up and drills restores. |
| Railway, Render | rejected | No Canadian region. |
| Hetzner | rejected | No Canadian location. |
| Vercel Daemons for the worker | later | Beta; examples don't show `yul1`. |
| Sentry free tier with data collection switched off | recommended (owner approves) | Catches browser and server errors. Needs explicit config, because SDK v11 collects bodies and AI content by default. |
| Logs only, no error tracker | runner-up | One less third party, but browser errors go unseen. |
| UptimeRobot free + Healthchecks.io free | recommended | 50 monitors at 5-minute checks, commercial use allowed. A dead-man switch for the worker. |
| Better Stack free | rejected | Its free plan is for personal projects. |
| Anthropic zero data retention (ZDR) | later | Needs a sales arrangement. The Batch API isn't covered. |

## Findings

### Process sources
- NIST SSDF 1.1 (SP 800-218, final 2022-02-03) groups practices into Prepare the Organization (PO.1–PO.5), Protect the Software (PS.1–PS.3), Produce Well-Secured Software (PW.1–PW.9; PW.3 moved into PW.4) and Respond to Vulnerabilities (RV.1–RV.3) ([CSRC](https://csrc.nist.gov/pubs/sp/800/218/final), [PDF](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-218.pdf)). SSDF 1.2 (SP 800-218 Rev. 1) is still an initial public draft (2025-12-17; comments closed 2026-01-30) ([draft](https://csrc.nist.gov/pubs/sp/800/218/r1/ipd)). A NIST talk lists PO.6 Continuous Improvement and PW.10 Robust and Reliable Updates as additions ([slides](https://csrc.nist.gov/csrc/media/presentations/2026/ssdf-update-and-devsecops-project/20260520-ogata-ssdf-devsecops.pdf)).
- DORA, small batches (updated 2025-12-08): a batch that takes over a week to finish and check is too big. Merge releasable changes to trunk at least daily. Small batches amplify AI's benefit and guard against the instability AI can bring ([page](https://dora.dev/capabilities/working-in-small-batches/)).
- DORA, trunk-based development: three or fewer active branches, branches that live hours, merges at least daily, no code freezes, and builds and tests that finish in a few minutes ([page](https://dora.dev/capabilities/trunk-based-development/)). The 2025 DORA report found AI adoption now raises throughput but still lowers stability. Version control, automated tests and fast feedback are the controls ([post](https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report)).
- What the installed skills set as gates. Spec: stop after the spec until the owner approves. Planning: tasks of ≤ 5 files, a checkpoint every 2–3 tasks. Incremental: test before ~100 lines. TDD: a pyramid of about 80/15/5, real implementations over mocks. Constraints: a floor, a 90 s task-end budget, ratchets. CI: under 10 minutes. Shipping: a rollback plan and first-hour checks (`~/.agents/skills/*/SKILL.md`).

### Testing tools (latest versions, 2026-11-12)
- Next.js 16.4's guide pairs Vitest with Testing Library and jsdom. Vitest can't render async Server Components, so those are tested end to end ([Vitest guide](https://nextjs.org/docs/app/guides/testing/vitest)). The Playwright guide tests against a production build ([guide](https://nextjs.org/docs/app/guides/testing/playwright)). Next.js 16 removed `next lint`, and `next build` no longer lints, so CI runs ESLint itself ([v16 upgrade](https://nextjs.org/docs/app/guides/upgrading/version-16)).
- Playwright 1.65. Its CI docs advise `workers: 1` and say caching browser binaries isn't worth it ([CI](https://playwright.dev/docs/ci)). Vitest 5.1, Testing Library 16.3, MSW 3.0, @axe-core/playwright 4.14 (npm registry).
- Homebrew `postgresql@18` is 18.7, and Postgres.app 2.9.7 bundles 14–18 ([formula API](https://formulae.brew.sh/api/formula/postgresql@18.json)). `CREATE DATABASE … TEMPLATE` fails while anyone else is connected to the template ([templates](https://www.postgresql.org/docs/current/manage-ag-templatedbs.html)). In PG 18, `file_copy_method = CLONE` makes `STRATEGY FILE_COPY` use macOS `copyfile` or Linux `copy_file_range` ([PG 18 docs](https://www.postgresql.org/docs/18/runtime-config-resource.html)). Turning off `fsync`, `synchronous_commit` and `full_page_writes` speeds up a throwaway cluster ([non-durability](https://www.postgresql.org/docs/current/non-durability.html)).
- pytest-postgresql 10.0.0 (2026-11-04) loads the schema into a template once per session and clones it for each test. `postgresql_noproc` attaches to a server that's already running, such as a CI service ([README](https://github.com/dbfixtures/pytest-postgresql)). Go has embedded-postgres 2.0.1 (2026-10-19).
- Contract tools: openapi-typescript 7.13 and openapi-fetch 0.17 (MIT); oasdiff 1.37 (Apache-2.0) has a `breaking` command and a GitHub Action ([repo](https://github.com/oasdiff/oasdiff)). Generators: FastAPI 0.162, @hono/zod-openapi 1.6, @fastify/swagger 9.9, huma 2.40 (OpenAPI 3.1, code-first), oapi-codegen 2.8 (spec-first).
- diff-cover 11.0.1 reads Cobertura, Clover, JaCoCo and LCov reports and takes `--fail-under=80` ([README](https://github.com/Bachmann1234/diff_cover)). Go's coverprofile needs a converter (gocover-cobertura, active 2026-05).
- Anthropic's eval guidance: make evals task-specific, grade automatically, prefer volume over hand grading, and grade with a different model from the one tested ([guide](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests.md)).

### CI
- GitHub Free personal accounts get US$12/month of Actions compute, about 2,000 Linux 2-core minutes at $0.006/min. Standard runners are free on public repos ([billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)). Service containers need Linux runners ([Postgres service](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers)).
- Rulesets and protected branches are free on public repos only. Private repos need a paid plan, US$4 per user per month on the pricing page ([rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets), [pricing](https://github.com/pricing)).
- Current majors: checkout v7, setup-node v7 (pnpm caching needs pnpm installed first), pnpm/action-setup v6, setup-python v7, setup-uv v10, setup-go v7, cache v6 ([setup-node](https://github.com/actions/setup-node)). Hosted runners dropped Node 20 on 2026-09-16 ([gitleaks-action README](https://github.com/gitleaks/gitleaks-action)). GitHub says to pin actions to commit SHAs and give `GITHUB_TOKEN` read-only scope by default ([secure use](https://docs.github.com/en/actions/reference/security/secure-use)).
- gitleaks 8.30.1: `gitleaks git` and `gitleaks dir` replaced the deprecated `detect` and `protect` in 8.19. `--redact` masks values. gitleaks-action v3 needs a licence for organisation accounts only ([gitleaks](https://github.com/gitleaks/gitleaks)).
- osv-scanner 2.7.1: the PR workflow fails only on vulnerabilities a PR introduces, and the scheduled one reports everything ([action](https://google.github.io/osv-scanner/github-action/)).
- Semgrep 1.185. Its rules licence allows internal use. `semgrep scan` needs no account and has `--baseline-commit` and `--error`. `--config auto` logs in to the registry, and registry configs send metrics by default ([CLI](https://docs.semgrep.dev/cli-reference), [licensing](https://docs.semgrep.dev/licensing)). Opengrep 1.33 is a fork that uses the same rule format.
- Node 26 has been Active LTS since 2026-10-28 ([schedule](https://github.com/nodejs/Release)). pnpm's latest is 12.18; the owner's Mac has 10.18.

### Hosting (monthly, USD, 2026-11-12)

| Option | Pieces and prices | Total (est.) | Region | Backups |
|---|---|---|---|---|
| Vercel + DO Toronto | Vercel Hobby $0 (personal, non-commercial) or Pro $20 ([pricing](https://vercel.com/pricing)); App Platform containers $5 (512 MB) or $10–12 (1 GB), workers supported ([pricing](https://www.digitalocean.com/pricing/app-platform)); Managed PostgreSQL from $15.15 ([pricing](https://www.digitalocean.com/pricing/managed-databases)) | 35–40 (+20 for Vercel Pro) | Vercel yul1 Montréal; Hobby gets one function region ([regions](https://vercel.com/docs/regions), [config](https://vercel.com/docs/functions/configuring-functions/region)); all DO products in TOR1 ([availability](https://docs.digitalocean.com/platform/regional-availability/)) | daily backups + 7-day point-in-time restore ([features](https://docs.digitalocean.com/products/databases/postgresql/details/features/)); app rollback to any of the last 10 deploys, data untouched ([deployments](https://docs.digitalocean.com/products/app-platform/how-to/manage-deployments/)) |
| Vercel + Fly.io Toronto | shared-cpu-1x 256 MB $2.19 + $6/GB RAM, ×1.115 in yyz; Managed Postgres Basic $38 + $0.28/GB ([pricing](https://fly.io/pricing/)) | 55–60 | yyz has Managed Postgres ([regions](https://docs.fly.io/reference/regions)) | automated backups ([pricing](https://fly.io/pricing/)) |
| One VPS + Compose + Caddy | DO 4 GB $24 + weekly backups 20% ([droplets](https://www.digitalocean.com/pricing/droplets)); OVHcloud VPS-1 (2 vCore, 4 GB) from $6.20 (currency not stated), daily backups kept 7 days ([VPS](https://www.ovhcloud.com/en-ca/vps/), [Canada](https://www.ovhcloud.com/fr-ca/vps/vps-canada/)); Lightsail 2 GB $12, 4 GB $24 ([pricing](https://aws.amazon.com/lightsail/pricing/)) | 12–30 + own time | Toronto, Beauharnois (QC), ca-central-1 | DIY `pg_dump` + provider snapshots. Caddy gets and renews certificates ([docs](https://caddyserver.com/docs/automatic-https)) |
| Railway / Render | Railway Hobby $5 including $5 of usage ([pricing](https://railway.com/pricing)); Render free Postgres expires after 30 days ([free](https://render.com/docs/free)) | 10–30 | none in Canada ([Railway](https://docs.railway.com/reference/deployment-regions), [Render](https://render.com/docs/regions)) | see `database.md` |

Hetzner Cloud has no Canadian location ([locations](https://docs.hetzner.com/cloud/general/locations/)). Managed Postgres alone is compared in [`database.md`](database.md): Crunchy Bridge $9, PlanetScale $5 and Supabase $25 all have ca-central-1. Next.js self-hosting suggests a reverse proxy in front, and one `next start` instance with a persistent disk needs no shared cache ([self-hosting](https://nextjs.org/docs/app/guides/self-hosting)).

### Observability
- Sentry's free Developer plan: 1 user, 5k errors, 5M spans, 5 GB logs, 1 cron monitor, 1 uptime monitor, a 30-day lookback. Team costs $29/month ([pricing](https://sentry.io/pricing/)). Data lives in the US (Iowa) or EU (Frankfurt) only. The choice is permanent, and some data is always stored in the US ([location](https://docs.sentry.io/organization/data-storage-location/)).
- In `@sentry/nextjs` 11.12, `sendDefaultPii` is deprecated. `dataCollection` defaults always apply, and they collect user email and IP, headers, every HTTP body, gen-AI inputs and outputs, database query data and stack locals. Each can be switched off, for example `httpBodies: []` ([options](https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/)).
- Python `sentry-sdk` 2.75 sends no PII by default. But `max_request_body_size="medium"` captures bodies up to 10 KB, `include_local_variables=True` captures stack locals ([options](https://docs.sentry.io/platforms/python/configuration/options/)), and the Anthropic integration switches itself on, recording prompts only when PII is enabled ([integration](https://docs.sentry.io/platforms/python/integrations/anthropic/)). Server-side scrubbing is on by default ([scrubbing](https://docs.sentry.io/security-legal-pii/scrubbing/server-side-scrubbing/)).
- UptimeRobot free: 50 monitors, 5-minute checks, personal and commercial use ([pricing](https://uptimerobot.com/pricing/)). Healthchecks.io free: 20 checks ([pricing](https://healthchecks.io/pricing/)). Better Stack free: 10 monitors, for personal projects ([pricing](https://betterstack.com/pricing)).
- Every Anthropic reply's `usage` reports `input_tokens`, `output_tokens`, `cache_creation_input_tokens` (5-minute and 1-hour), `cache_read_input_tokens`, `output_tokens_details.thinking_tokens`, `service_tier`, `inference_geo` and `speed`. Total input is the sum of the three input counts. `metadata.user_id` takes an opaque id and must not be a name or email ([API](https://platform.claude.com/docs/en/api/messages/create.md)). Each Console workspace can have a monthly spend limit with alerts, except the Default Workspace ([workspaces](https://platform.claude.com/docs/en/manage-claude/workspaces.md)).
- Prices per million tokens ([pricing](https://platform.claude.com/docs/en/about-claude/pricing.md)). Cache hits on Opus and Sonnet 5.5 cost 0.05× input, not the 0.1× in our cached notes.

| Model | Input | Output | Cache hit | Batch in / out |
|---|---|---|---|---|
| claude-opus-5-5 | $4 | $20 | $0.20 | $2 / $10 |
| claude-sonnet-5-5 | $2 | $10 | $0.10 | $1 / $5 |
| claude-haiku-5-5 (prompt ≤ 100K) | $0.10 | $0.50 | $0.01 | $0.05 / $0.25 |

### Privacy
- PIPEDA covers personal information handled in commercial activity, under ten principles that include limited retention and safeguards ([principles](https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/p_principle/), [scope](https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/pipeda_brief/)). Access requests must be answered within 30 days, extendable once by up to 30 ([s. 8](https://laws-lois.justice.gc.ca/eng/acts/P-8.6/page-2.html)).
- Breaches that pose a real risk of significant harm go to the OPC, and affected people are told as soon as feasible. A record of every breach is kept for two years ([OPC](https://www.priv.gc.ca/en/privacy-topics/business-privacy/breaches-and-safeguards/privacy-breaches-at-your-business/gd_pb_201810/)).
- Sending data to a processor, even abroad, is a use and needs no new consent. But people must be told it may be processed in another country and reached by that country's authorities, and the organisation stays accountable through contracts ([OPC, 2009](https://www.priv.gc.ca/en/privacy-topics/airports-and-borders/gl_dab_090127/)).
- Bill C-36 (Protecting Privacy and Consumer Data Act) would replace PIPEDA Part 1. It has had first reading only (2026-06-15) ([LEGISinfo](https://www.parl.ca/legisinfo/en/bill/45-1/c-36)).
- Quebec. The person with the highest authority is the default person in charge of personal information, and that person's title and contact go on the website (statute summaries; LégisQuébec blocked our fetch) ([BLG guide](https://www.blg.com/-/media/insights/documents/blg-quebec-bill-64-guide-en-upd.pdf)). The CAI's assessment guide requires an assessment before personal information leaves Quebec. It weighs sensitivity, purpose, protections including contracts, and the destination's laws, and a written agreement must follow. A new information system handling personal information also needs an assessment ([CAI guide, French](https://www.cai.gouv.qc.ca/uploads/pdfs/CAI_GU_EFVP.pdf)). Incident notices and a register are required (secondary sources).
- GDPR reaches organisations outside the EU that offer services to people in the EU (Art. 3(2)). Most of them must also name an EU representative (Art. 27) ([text](https://eur-lex.europa.eu/eli/reg/2016/679/oj)).
- Anthropic. Commercial API inputs and outputs are deleted within 30 days. Flagged content is kept up to 2 years and classifier scores up to 7 ([privacy center, 2026-07-01](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)). The docs say retained data is never used for training without permission, and also that conversation content isn't retained by default. The two pages read differently, so plan for 30 days. ZDR needs a sales arrangement per organisation. Batches are kept 29 days and aren't ZDR-eligible ([retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)). Data at rest (workspace geo) is US only. Inference runs `global` (any geography) by default, or `us` at 1.1× the price; there's no Canada option ([residency](https://platform.claude.com/docs/en/manage-claude/data-residency.md)).

## Lessons from earlier work
- **Transfers.** CONSTRAINTS.md with a floor, numbers, ratchets and exceptions that have an owner and an expiry. The floor guard, the changed-line coverage script, the commit-identity check, `gitleaks --redact`. Tests never touch the network: a fake HTTP client refuses unscripted calls, and recorded replies stand in for models and boards. Prompt evals on 30 labelled fixtures, replayed offline every run, live after prompt or model changes. Thresholds: requirement extraction ≥ 0.85 precision and ≥ 0.80 recall, verifier first-pass rate ≥ 95%. A test that fails if any prompt contains a contact value. Logs with ids and counts only. A two-user isolation test.
- **Transfers, sharpened.** Docs describe the system as it is. An earlier prototype's spec grew to 96 KB and its task log to 185 KB, and both had to be archived. Columns for features never built (sync) were dead weight. Limits come from what providers actually refuse, not from their published tables.
- **Doesn't transfer.** macOS runners, Xcode and the size and launch-time budgets. Keychain secrets and a single user's local file: Instante holds other people's data, so authorisation, backups, restores and privacy law become the operator's job. Supabase row-level security as the authorisation layer: Instante's backend is the database's only client, so the isolation test runs against our own API in CI on every PR.

## Recommendation for v1

**1. Lifecycle.** Write `docs/sdlc.md` from this table. Only the owner signs a gate.

| Phase | Produces | Exit gate | Skills | SSDF |
|---|---|---|---|---|
| 1 Research & decide (now) | research notes; ADRs for language, database, auth and hosting criteria | owner accepts the ADRs and answers the questions | source-driven-development, documentation-and-adrs | PO.1, PO.3, PW.1 |
| 2 Specify | `docs/product.md` (capability map, module specs), `docs/architecture.md`, CONSTRAINTS.md, API sketch, data-flow and threat list, privacy notice draft | owner approves spec, constraints and notice | spec-driven-development, constraint-driven-development, api-and-interface-design, security-and-hardening | PO.1, PO.4, PW.1, PW.2 |
| 3 Plan | `tasks/plan.md`, `tasks/todo.md`: a walking skeleton first (web, API, worker, DB, CI, deploy), then vertical slices; the dependency list | owner approves the plan and dependencies | planning-and-task-breakdown | PO.3, PW.4 |
| 4 Build, per slice | one PR per slice, tests first, merged the same day | Definition of Done; a checkpoint review every 2–3 slices | incremental-implementation, test-driven-development, ci-cd-and-automation, code-review-and-quality, git-workflow-and-versioning; doubt-driven-development for auth, deletion, migrations and prompts | PS.1, PW.5–PW.9 |
| 5 Release (beta) | production deploy, runbook (deploy, rollback, restore, incident), monitors, published notice, invites | shipping checklist green, a restore drill done, owner go | shipping-and-launch, observability-and-instrumentation | PS.2, PS.3, PW.9 |
| 6 Operate & learn | weekly ops check, dependency PRs, incident notes, feedback log, iteration review | owner signs the review and the next scope | debugging-and-error-recovery, deprecation-and-migration, documentation-and-adrs | RV.1–RV.3, PO.6 (draft) |

- **Each new iteration** goes back to Phase 2. Check every research note's "Later" table against measured data. Write ADRs that supersede old ones; never edit accepted ones. Update product and architecture docs to the current state. Move the last plan and task list to `docs/archive/vN/`.
- **Definition of Done** for every slice:
  - the acceptance criteria are met and the behaviour has been checked at runtime;
  - the tests fail without the change and pass with it;
  - every CI gate is green, with changed lines ≥ 80% covered;
  - no new suppressions or skipped tests;
  - API types are regenerated, and nothing breaks in one step;
  - migrations only expand;
  - no personal data in logs or error reports;
  - docs and ADRs are current;
  - the owner has reviewed it if it touches auth, deletion, export, migrations, prompts or a third party.
- **Agents** get one task at a time: the spec section, acceptance criteria, files and verify command. They run `check:task` before handing back. Unfinished work stays behind an env-var flag.

**2. Testing.** Fixtures use the Jordan Rivera persona and synthetic postings. Tests reach only localhost.

| Layer | Python | TypeScript | Go |
|---|---|---|---|
| Unit (screening rules, resume model, normalisers) | pytest 9.2 | Vitest 5.1 | `go test` |
| Integration (store, queue, handlers, real PG) | pytest-postgresql template clones; `postgresql_noproc` in CI; httpx ASGI client | Vitest global setup migrates a template, clones one per worker; Hono `app.request` or Fastify `inject` | pgx + `httptest`, one clone per package |
| Contract | FastAPI → `openapi.json` | @hono/zod-openapi or @fastify/swagger | huma (code-first) or oapi-codegen |
| Coverage for diff-cover | pytest-cov (Cobertura) | @vitest/coverage-v8 (LCov) | coverprofile → gocover-cobertura |

- **Frontend:** Vitest, Testing Library and jsdom for client and synchronous components. MSW mocks typed from `openapi-typescript`.
- **End to end:** Playwright on Chromium against `next build && next start`, the API in fake-LLM mode, and PG. Config refuses fake mode in production. Six flows: sign in with an emailed code, build the master resume, browse jobs, screen, tailor and download the PDF, export and delete the account. Run axe on every page.
- **Isolation:** two seeded users. Every route in `openapi.json` must appear in an isolation matrix, and user B gets 404 on user A's ids.
- **LLM:** the code calls models through one AI module. Recorded replies, keyed by prompt version and fixture, replay in every run. A live eval script runs after any prompt or model change, in a separate "evals" workspace with a spend limit, on the Batch API. Graders are code first (verdict match, requirement precision and recall); a model from another tier judges resume faithfulness.

**3. CI.** One workflow on PRs and pushes to `main`, `permissions: contents: read`, actions pinned by SHA, tool versions read from the repo. The times are estimates to measure in week one.

| Job | Runs | Est. |
|---|---|---|
| web | pnpm install (cached), ESLint, `tsc --noEmit`, `prettier --check`, Vitest with coverage, `next build` | 2–3 min |
| api | `postgres:18` service; migrate from empty; lint, format, types; tests with coverage; export `openapi.json`, regenerate TS types, `git diff --exit-code`; `oasdiff breaking` against the base | 2–4 min |
| e2e | `postgres:18`; build web, start the API in fake-LLM mode; Playwright + axe; upload the report on failure | 4–6 min |
| security | `gitleaks git --redact`, `osv-scanner scan source -r .`, `semgrep scan --config p/default --baseline-commit <base> --error --metrics=off` | 1–2 min |
| guards (after web, api) | floor guard, `diff-cover --fail-under=80`, commit identity | < 1 min |

The PR run takes about 6–8 minutes of wall time and 12–16 billed minutes. At about 80 runs a month that is about 1,000–1,300 minutes, which fits the free private allowance (or costs nothing on a public repo). A weekly schedule runs full osv-scanner and Semgrep scans, and Dependabot opens PRs for npm, the backend ecosystem and Actions. All five jobs are required checks on `main`, and GitHub enforces that only on a public repo or a paid plan.

**4. Deployment.** Choose at the release gate against these criteria: data location, monthly cost, ops hours, backups and point-in-time restore, long-running worker support, deploy and rollback from Actions, the PG major version, log retention, the number of vendors to disclose, and the cost of leaving.
- **Default:** Vercel (functions in `yul1`) and DO TOR1: App Platform for the API and worker (1 GB each), Managed PostgreSQL 18.
- **Deploy order:** CI green on `main` → build an image tagged with the git SHA → run expand-only migrations → deploy the API and worker → smoke-test `/readyz` → deploy the web app → first-hour checks.
- **Rollback:** the previous image or Vercel deploy. Data is never rolled back; contract changes ship in a later deploy.
- **Environments:** local, CI and production. No staging in v1. A monthly restore drill forks a cluster from a backup, applies pending migrations, runs smoke checks and deletes the fork, so production data never lands on the Mac.
- **Secrets:** production secrets live in the host's settings, CI holds deploy tokens only, and Anthropic gets dev, evals and prod workspaces with separate keys and spend limits. Every vendor account uses two-factor sign-in.

**5. Observability.**
- **Logs:** JSON to stdout with `request_id`, opaque `user_id`, route, status, `duration_ms`, job and counts (structlog / pino / `log/slog`). Never resume, posting or prompt text, emails or tokens.
- **Health:** `/healthz` and `/readyz` checked by UptimeRobot; the worker pings Healthchecks.io after each scheduled run.
- **Sentry (if approved):** in JS, `dataCollection` with `userInfo: false`, `httpBodies: []`, `genAI: {inputs: false, outputs: false}`, `databaseQueryData: false`, `stackFrameVariables: false`. In Python, `max_request_body_size="never"`, `include_local_variables=False`, no `data_collection` dict. Turn on IP-storage prevention, and test the init options.
- **LLM cost:** every call writes an `llm_call` row costed from a dated price table in code. Check the user's daily cap before each call. Set the workspace spend limit and alerts as the hard stop, and reconcile with the Console monthly.
- **Illustrative cost per active user per month.** Assumes 200 screenings (6K tokens in, 800 out) and 15 tailored resumes (12K in, 4K out). Opus 5.5 about $9.90, Sonnet 5.5 about $5.00, Haiku 5.5 about $0.25. Batch screening cuts the Opus figure to about $5.90. The owner picks the model.

**6. Privacy, v1.**
- **Data minimisation:** the beta is invite-only and limited to people in Canada. Comply with PIPEDA's principles now. Strip contact details before any prompt, re-attach them at render time, and test that they stay out.
- **Privacy notice, accepted at sign-up:** purposes; processors and their locations (Anthropic in the US, with inference global or US; DO Toronto; Vercel; Sentry; email); retention (account life; backups gone within 7 days of deletion; Anthropic up to 30 days, flagged content 2 years); self-serve export and delete; requests answered within 30 days; the owner named as privacy contact.
- **Incidents:** a private incident register, kept ≥ 24 months, and a breach runbook (assess the risk, tell the OPC and the people affected).
- **Quebec:** if Quebec users are allowed, add the assessment (EFVP) and publish the person in charge.

**7. CONSTRAINTS.md defaults.** Block on the floor; warn on the rest for two weeks (the skill's default). Hold the measured values (ratchet tolerance 0.5%). Exceptions need an owner and expire within 90 days. Budgets: under 5 s after an edit, under 90 s at task end.

| Dimension | Rule | Checked by | Runs at |
|---|---|---|---|
| Floor | no new suppressions (`@ts-ignore`, `eslint-disable`, `# noqa`, `# type: ignore`, `//nolint`, coverage ignores, `nosemgrep`, `gitleaks:allow`); no stubs or empty catches; no skipped, `.only` or deleted tests without a reason; no secrets or real people's data; this file not weakened | floor guard adapted from the skill's reference | task end, CI |
| Types / lint / format | zero errors and diffs | `tsc --noEmit`, ESLint, Prettier; backend: mypy + ruff / tsc + ESLint / `go vet` + golangci-lint + gofmt | every edit |
| Tests | all pass with no outside network | Vitest; pytest / Vitest / `go test` | task end, CI |
| Coverage | changed lines ≥ 80% | diff-cover | task end, CI |
| Contract | generated files committed; no one-step breaking change | `git diff --exit-code`, `oasdiff breaking` | CI |
| Isolation, prompt privacy | no cross-user access; no contact values in prompts | owner-specified suites | CI |
| E2E + accessibility | six flows pass; zero critical or serious axe findings | Playwright + axe | CI |
| Secrets / deps / code | no findings / nothing high or above / no ERROR findings introduced | gitleaks, osv-scanner, Semgrep | before push, CI |
| Commits | owner identity, no AI trailers | `scripts/check-commits.sh` | before push, CI |
| Measured, not enforced | project coverage, CI minutes, p95 API latency, LCP ≤ 2.5 s and CLS ≤ 0.1 on production, LLM $/user/month, eval scores | as named | weekly |

## Later, and what would trigger it

| Addition | Trigger |
|---|---|
| Staging backend | a deploy breaks production twice, or users beyond the invite list |
| Encrypted weekly `pg_dump` to Canadian object storage, off the DB vendor | paying users, or more than 50 users |
| Mutation testing on changed files | a bug escapes a green suite |
| Enforced Lighthouse budget | public launch, or users report slow pages |
| Log search, OpenTelemetry traces | host log retention too short for an incident, or latency across services |
| HA database, more instances | an uptime promise, or about 500 users |
| Anthropic ZDR | a user or partner requires it |
| Legal review, full privacy assessment | opening beyond friends, charging, or Quebec or EU users |
| Build provenance and SBOM (SSDF PS.2) | containers or code shipped to others |
| One vendor for the worker (Vercel Daemons) | it reaches GA with `yul1` |

## Risks
- Gates can turn into ceremony for one person. Keep artifacts short, script the checks, and have the owner sign only phase gates and high-stakes PRs.
- The agent writes both code and tests, so the checks are partly circular. Keep external checks (osv-scanner, gitleaks, Semgrep, axe), and have the owner set the isolation and prompt-privacy suites.
- Sentry v11's defaults would send resumes, AI content and IPs to a US processor unless they're switched off.
- LLM spend: Opus at the assumed volume costs about $500/month for 50 users. Caps and spend limits are needed from day one.
- A private repo on GitHub Free can't enforce required checks.
- The legal picture is unsettled: PIPEDA's "commercial activity", Quebec's reach, Bill C-36, and Anthropic's two retention statements.
- Version drift: local pnpm 10.18 against 12.18 latest, and PG 18 locally against 17 at some hosts. Pin versions in the repo and run CI on the host's major.
- One region and one database instance: outages are accepted for the beta. Backups count only once a restore has been drilled.

## Questions for the owner
1. Public or private repository? A public repo gets free CI and enforced checks. A private one needs about US$4/month to enforce them.
2. Hosting: approve the default (about US$35–40/month), Fly.io (about US$55–60), or one VPS (about US$12–30 plus your time)? Is the beta non-commercial for Vercel Hobby, or budget $20/month for Pro?
3. Must user data stay in Canada at rest? Anthropic stores data only in the US. Should inference be pinned to `us` at 1.1× the price?
4. Which third parties may receive users' data? Anthropic gets resumes and postings; Sentry gets error events, in the US or EU; DigitalOcean and Vercel host; UptimeRobot and Healthchecks.io get URLs only. Or start without Sentry?
5. LLM money: the monthly Console spend limit, the per-user daily cap, and the model for each feature.
6. Scope: allow Quebec users in v1 (an assessment and a published privacy contact) or EU users (GDPR), or limit the beta to the rest of Canada?
7. Get a short legal review before opening beyond friends?
8. Staging: none in v1, or about US$25/month for one?
9. Budget per live eval run, and who triggers it?
10. Skip asking Anthropic for ZDR in v1?

## Sources
- Process: [SSDF 1.1](https://csrc.nist.gov/pubs/sp/800/218/final) · [SSDF 1.2 draft](https://csrc.nist.gov/pubs/sp/800/218/r1/ipd) · [DORA small batches](https://dora.dev/capabilities/working-in-small-batches/) · [DORA trunk-based](https://dora.dev/capabilities/trunk-based-development/) · [DORA 2025](https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report) · installed skills in `~/.agents/skills/`
- Testing: [Next.js Vitest](https://nextjs.org/docs/app/guides/testing/vitest) · [Next.js Playwright](https://nextjs.org/docs/app/guides/testing/playwright) · [Next.js 16](https://nextjs.org/docs/app/guides/upgrading/version-16) · [Playwright CI](https://playwright.dev/docs/ci) · [PG templates](https://www.postgresql.org/docs/current/manage-ag-templatedbs.html) · [PG 18 file_copy_method](https://www.postgresql.org/docs/18/runtime-config-resource.html) · [pytest-postgresql](https://github.com/dbfixtures/pytest-postgresql) · [diff-cover](https://github.com/Bachmann1234/diff_cover) · [oasdiff](https://github.com/oasdiff/oasdiff) · [Anthropic evals](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests.md)
- CI: [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) · [Postgres service](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers) · [secure use](https://docs.github.com/en/actions/reference/security/secure-use) · [gitleaks](https://github.com/gitleaks/gitleaks) · [osv-scanner action](https://google.github.io/osv-scanner/github-action/) · [Semgrep CLI](https://docs.semgrep.dev/cli-reference)
- Hosting and observability: links in the tables above · [Sentry Next.js options](https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/) · [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing.md) · [workspaces](https://platform.claude.com/docs/en/manage-claude/workspaces.md)
- Privacy: [OPC principles](https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/p_principle/) · [breaches](https://www.priv.gc.ca/en/privacy-topics/business-privacy/breaches-and-safeguards/privacy-breaches-at-your-business/gd_pb_201810/) · [cross-border](https://www.priv.gc.ca/en/privacy-topics/airports-and-borders/gl_dab_090127/) · [PIPEDA s. 8](https://laws-lois.justice.gc.ca/eng/acts/P-8.6/page-2.html) · [C-36](https://www.parl.ca/legisinfo/en/bill/45-1/c-36) · [CAI PIA guide](https://www.cai.gouv.qc.ca/uploads/pdfs/CAI_GU_EFVP.pdf) · [GDPR](https://eur-lex.europa.eu/eli/reg/2016/679/oj) · [Anthropic retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention) · [privacy center](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data) · [data residency](https://platform.claude.com/docs/en/manage-claude/data-residency.md)
