# Tasks: `platform` and `accounts`

**Status:** written 2026-11-13 and revised the same day after two fresh-context reviews (coverage against the specs; order, size and verifiability). Approved by the owner on 2026-11-13, with [`plan.md`](plan.md).

**Rules for every task:**
- One task is one branch and one pull request, written test first. It meets the [Definition of Done](../docs/sdlc.md#definition-of-done-every-slice), and CI on its branch passes before it merges.
- "Spec n" points to that spec's numbered acceptance criterion.
- A **review** task waits for the owner's line-by-line reading. Tasks that build on it may be written on top of its branch, but merge after it.
- Pushes and fast-forward merges after CI follow the owner's standing approval in [`AGENTS.md`](../AGENTS.md); force pushes and GitHub settings still need the owner's yes.
- "Files" lists hand-written files. A package's manifest, `tsconfig.json` and the lockfile come with it.

## Before T1: the owner (O0)

- [x] Sign off phase 2 (2026-11-13).
- [x] Create the public GitHub repository and add it as `origin` (2026-11-13).
- [x] Make `main` the fast-forward of `phase-2`, and push it (the agent, 2026-11-13).
- [ ] Add one ruleset on `main`:
  - active, with an empty bypass list;
  - deletions restricted and force pushes blocked;
  - the required checks, each CI job added once it has first run (T1, T3, T4, T5, T9, T18, T19, T20, T24 and T25 add jobs).

## Phase A: Foundation ([platform spec](../docs/specs/platform.md))

- [x] **T1: The root workspace**
  - **Does:**
    - the root `package.json`, with `packageManager: pnpm@12.18.0` and `engines.node`;
    - `pnpm-workspace.yaml`: `minimumReleaseAge: 10080`, lifecycle scripts blocked unless named, exact versions, `enableGlobalVirtualStore: false`;
    - `mise.toml`, Node 26.13.1, with tools only;
    - `.gitignore` and `.env.example`;
    - `.github/workflows/ci.yml` with its first job (install with `--frozen-lockfile`, and gitleaks), actions pinned by SHA, least-privilege `permissions` and no secrets. Every later task adds to it, so each pull request has CI.
  - **Acceptance:** the settings are in place, `pnpm install` at the root works, and CI's first job passes on this pull request.
  - **Verify:** `pnpm install`; `pnpm config list`; the pull request's checks.
  - **Depends on:** O0. **Files:** `package.json`, `pnpm-workspace.yaml`, `mise.toml`, `.gitignore`, `.env.example`, `.github/workflows/ci.yml`. **Size:** S.

- [x] **T2: The web scaffold, the install rules, and `next start` under the permission model**
  - **Does:**
    - `pnpm create next-app@16.4.N apps/web --typescript --tailwind --eslint` and `pnpm dlx shadcn@4.23.N init -b base -p nova`, each pinned at least 7 days old;
    - the nested `pnpm-workspace.yaml` and lockfile merged into the root's;
    - the package renamed `@instante/web`, its `typescript` and `@types/node` replaced, `apps/web/CLAUDE.md` added, Cache Components off;
    - a first try of `next start` under `--permission` with `--allow-net`, reading only the checkout (the release folder's stand-in: pnpm links `apps/web/node_modules/next` into the root `node_modules/.pnpm`).
  - **Acceptance:**
    - a clean `pnpm install --frozen-lockfile` runs no lifecycle scripts, and a pin younger than 7 days is refused (tried, then reverted) (platform spec 1);
    - the owner has seen the list of components `shadcn init` added;
    - the PR records whether `next start` ran under the permission model, and what it needed.
  - **Verify:** `pnpm install --frozen-lockfile` from a fresh clone; `pnpm --filter @instante/web build`.
  - **Depends on:** T1. **Files:** `apps/web/**` (generated), `pnpm-workspace.yaml`. **Size:** M (mostly generated).

- [x] **T3: Types, lint, format and tests**
  - **Does:**
    - `tsconfig.base.json` with the strict flags, and the web app's `tsconfig.json` extending it;
    - one root `eslint.config.mjs` replacing the scaffold's file: typed `strictTypeChecked`, the module-direction rules for `kit`, `domain`, `ai`, `documents`, `sources`, `store`, `engine` and the entry points, "`src/` never imports `test/`", `noInlineConfig` and `reportUnusedDisableDirectives`;
    - `eslint.fast.config.mjs` and `prettier.config.mjs`;
    - the root `vitest.config.ts`: one project per package, `@vitest/coverage-v8` writing LCov over the fixed scope (`apps/backend/src`, `packages/contract/src`, `apps/web/lib`);
    - the `check:fast` and `check:task` scripts;
    - CI's format, lint and types jobs.
  - **Acceptance:**
    - `check:fast` takes under 5 seconds after a one-file change (the first half of platform spec 2);
    - the scaffold passes every rule with no suppression, or the owner has approved an exception row.
  - **Verify:** `time pnpm check:fast` after touching one file; `pnpm check:task`.
  - **Depends on:** T2. **Files:** `tsconfig.base.json`, `eslint.config.mjs`, `eslint.fast.config.mjs`, `prettier.config.mjs`, `vitest.config.ts`, `.github/workflows/ci.yml`. **Size:** M.

- [x] **T4: The guards**
  - **Does:**
    - `scripts/floor-guard.ts`, adapted from the constraint-driven-development skill's reference (TypeScript run by Node, as the reference is a Node script). It covers every floor rule in [`CONSTRAINTS.md`](../CONSTRAINTS.md):
      - the suppression comments and ESLint inline configuration;
      - stubs, empty `catch {}` and standing `TODO`s;
      - skipped, `.only` or deleted tests;
      - the web-app bans: `'use server'`, `'use cache'`, `force-cache`, `route.ts`/`route.js` under `apps/web/app`, `dangerouslySetInnerHTML`, `rehype-raw`, `partialPrefetching` off with `cacheComponents` on;
      - the model allowlist;
      - the backend reading a cookie;
      - `getSession()` outside `apps/web/lib/auth/token-provider.ts`;
      - edits that weaken the bar;
    - `scripts/check-commits.ts`;
    - `scripts/check-agent-settings.ts`, which fails on a `sandbox` key, an `allowRead`, or a non-deny rule naming `~/.instante` in committed `.claude/` files;
    - `.claude/settings.json`, denying `Read` and `Edit` of `~/.instante/**`;
    - gitleaks added to `check:fast`, the floor guard to `check:task`, and a `test` script;
    - CI's guard job: the three guards and their tests.
  - **Acceptance:** each guard fails on a planted case of every rule, and passes on a clean tree. The plants are made in temporary repositories by the tests, never committed. CI's first jobs pass on this pull request.
  - **Verify:** `pnpm test -- guards`; the pull request's checks.
  - **Depends on:** T3. **Files:** `scripts/{floor-guard,check-commits,check-agent-settings}.ts`, `scripts/test/guards.test.ts`, `.claude/settings.json`, plus edits to `package.json`, `vitest.config.ts` and `ci.yml`. **Size:** M.

### Checkpoint 1
- [x] A clean install, `check:fast` under 5 seconds, and CI's first jobs green on a pull request.

## Phase B: Backend core

- [x] **T5: The contract package** (**review:** the contract helper)
  - **Does:**
    - `packages/contract`, with `module: nodenext`, `erasableSyntaxOnly`, `allowImportingTsExtensions` and `noEmit`;
    - `defineRoute`, the one error shape (with `upstream_unavailable`), the id generator, `GET /api/ping`, and the separate `testRoutes` table;
    - CI's test job, with `diff-cover --fail-under=80` over the fixed scope.
  - **Acceptance:** a route without `auth` fails to type-check; ids follow ADR-008's format; the test job and coverage gate run on this pull request.
  - **Verify:** `pnpm --filter @instante/contract test`; the pull request's checks.
  - **Depends on:** T4. **Files:** `packages/contract/src/{define-route,routes,test-routes,errors,ids}.ts`, `.github/workflows/ci.yml`. **Size:** M.

- [x] **T6: The backend package and its configuration**
  - **Does:**
    - `apps/backend` (its tsconfig as the contract's). `src/main.ts`, reading `ROLE`, moved to T8, the first task with something to start;
    - `src/kit/config.ts`: Zod, `*_FILE` values read from files, and the production guard. The guard refuses:
      - test routes and fake AI (test routes exist only with `INSTANTE_ENV=test`; the fake-AI setting and its refusal arrive with the `ai` module);
      - a database URL, parsed with `pg-connection-string`, whose host isn't `$INSTANTE_HOME/run`;
      - a non-loopback address and the wrong Node;
      - a missing `--disable-sigusr1`;
      - ports 4310 and 4311 or the name `instante.localhost` outside real use;
      - a `DOCUMENTS_SOCKET` over 104 bytes.
  - **Acceptance:** each refusal has a test, including a URL whose `host=` points elsewhere.
  - **Verify:** `pnpm --filter @instante/backend test -- config`.
  - **Depends on:** T5. **Files:** `src/kit/config.ts`, `src/kit/config.test.ts`. **Size:** S.

- [x] **T7: The logger, errors, clock and ids**
  - **Does:** the JSON logger with one sanitizer, `AppError`, the clock and ids (UUIDv7 rows from Node's `crypto.randomUUIDv7`, and the contract's resume ids).
  - **Acceptance:** the sanitizer redacts `Authorization` and `Cookie`, and keeps only code, constraint and table from a database error.
  - **Verify:** `pnpm --filter @instante/backend test -- kit`.
  - **Depends on:** T6. **Files:** `src/kit/{sanitize,logger,errors,clock,ids}.ts` and their tests. **Size:** S.

- [ ] **T8: The API and its request checks** (**review:** fail-closed routes; the `Host`, `X-Forwarded-Host` and Fetch Metadata checks)
  - **Does:**
    - `src/main.ts`, reading `ROLE` and the configuration (moved from T6), through `src/start.ts` so tests can start it in-process;
    - `registerRoutes`, failing closed;
    - the middleware in the spec's order, with the request id first so each refusal is logged with one, and per route: sign-in, then the body limit, the JSON check and validation;
    - reply parsing with `Cache-Control` and `Vary`;
    - `/healthz`, the ping handler, and the test-route handlers (`echo`, `slow` sending nothing at all, `user-only`, and the fixture PDF);
    - the unauthenticated matrix, generated from the tables, with an `authenticate` that refuses every token. A path no route matches asks for sign-in first, so no spelling of a `user` route's path gets past it.
  - **Acceptance:**
    - a route without `auth` or a handler fails to register, and test routes don't register in production (platform spec 4);
    - every `user` route answers 401, including encoded paths and trailing slashes;
    - each request check refuses its case.
  - **Verify:** `pnpm --filter @instante/backend test -- api unauthenticated`.
  - **Depends on:** T7. **Files:** `src/{main,start}.ts`, `src/api/{app,register-routes,middleware}.ts`, `src/api/handlers/{ping,test-routes}.ts` (the fixture PDF is built there, since `src/` takes nothing from `test/`), `test/{api,unauthenticated-matrix,start}.test.ts`. **Size:** M.

- [x] **T9: The migration runner** (**review:** the runner)
  - **Does:**
    - the `pg` pool for `instante_app`, given `{ connectionString }` (a bare string is parsed twice), with `pg-connection-string` pinned to the version `pg` itself depends on, so the configuration's guard parses as `pg` does;
    - the runner with `schema_migrations`, failing on a gap, an unknown name, a changed file and the wrong locale;
    - `0001_baseline.sql` and `0002_skeleton.sql`;
    - `cli db migrate` (step 1) and `db status`, run through `src/main.ts` with `ROLE=cli`;
    - `scripts/dev-db.sh`, creating the development roles on Homebrew's cluster (the owner role with `CREATEDB`) and `instante_dev` and `instante_test` from `template0` with the builtin `C.UTF-8` locale. The runner's tests use `instante_test` until T10's harness arrives;
    - CI's Postgres service, `postgres:18` started with `POSTGRES_INITDB_ARGS` for the pinned locale, and the integration-test job.
  - **Acceptance:** the runner refuses each case (platform spec 6), on Homebrew's Postgres 18 with the pinned locale.
  - **Verify:** `scripts/dev-db.sh`; `pnpm --filter @instante/backend test -- migrate`.
  - **Depends on:** T7. **Files:** `src/store/{pool,migrate}.ts`, `migrations/{0001_baseline,0002_skeleton}.sql`, `src/cli/db.ts`, `scripts/dev-db.sh`, `test/db.ts` (each test's scratch database, until T10's harness) and `test/migrate.test.ts`, plus edits to `src/main.ts` and `ci.yml`. **Size:** M (two of the files are short SQL).

- [x] **T10: The development database and the integration harness** (**review:** store scoping)
  - **Does:**
    - the harness: one migrated template per run, copied by each integration test file (`test/global-setup.ts`, `test/db-harness.ts`); unit tests in `src/` run without a database;
    - each copy gets the database-level rights 0001 sets (no `TEMPORARY` or `CONNECT` for `PUBLIC`, `CONNECT` for `instante_app`), since `CREATE DATABASE … TEMPLATE` doesn't copy them;
    - Drizzle over the pool, with the person-scoped store rule (every per-person store function takes the person's id, as a branded `PersonId`), held by a static check over `src/store/` and a database check (`user_id` NOT NULL and first in the primary key).
  - **Acceptance:** integration tests run on copies of the template, on Homebrew's Postgres 18 and in CI, with the pinned locale; T9's runner tests move onto the harness.
  - **Verify:** `pnpm --filter @instante/backend test -- store`.
  - **Depends on:** T9. **Files:** `test/{global-setup,db-harness,store-scoping}.ts`, `src/store/{db,schema,person,skeleton}.ts`, `test/store.test.ts`, plus edits to `vitest.config.ts` and `test/migrate.test.ts`. **Size:** S.

- [ ] **T11: The queue pattern**
  - **Does:**
    - `cli db migrate` steps 2 to 4: `pg-boss migrate` with the URL in `PGBOSS_DATABASE_URL`, the grants, and the queues as the owner;
    - pg-boss started with `migrate: false` and `persistQueueStats: false`;
    - `/readyz` checking the database, our migrations and pg-boss's schema version;
    - `skeleton_ping` with `send` and `complete` through `fromDrizzle`.
  - **Acceptance:** a committed transaction writes the row and completes the job, and a rolled-back one leaves neither (platform spec 5); `/readyz` fails on a pg-boss schema mismatch.
  - **Verify:** `pnpm --filter @instante/backend test -- queue`.
  - **Depends on:** T8, T10. **Files:** `src/cli/db.ts`, `src/store/queue.ts`, `src/api/handlers/readyz.ts`, `test/queue.test.ts`. **Size:** M.

### Checkpoint 2
- [ ] `check:task` green; integration tests on Postgres 18 with the pinned locale, locally and in CI.
- [ ] Review session: the contract helper (T5), the request checks (T8), the runner (T9), store scoping (T10).

## Phase C: Document service, web and CI

- [ ] **T12: The document service** (**review:** the children's flags, environment and streams)
  - **Does:**
    - `ROLE=documents`: Hono on `DOCUMENTS_SOCKET`, with no TCP port, started with only its allowed names;
    - `POST /run/:task`;
    - children started with `spawn(process.execPath, [...])`:
      - `--permission`, `--disable-sigusr1`, `--max-old-space-size=256`, reads only from the job folder and the granted code;
      - a minimal environment with no `NODE_OPTIONS`, and piped streams only, with no IPC;
      - a 30-second kill;
    - job folders from `mkdtemp`;
    - `echo`;
    - the backend's client over `node:http`, with a total 25-second deadline;
    - `/readyz` failing when the document service doesn't answer.
  - **Acceptance:** `echo` returns the input's length and SHA-256 through the client; a child past 30 seconds is killed; `/readyz` fails with the socket down.
  - **Verify:** `pnpm --filter @instante/backend test -- documents`.
  - **Depends on:** T11. **Files:** `src/documents/{server,run-child,tasks/echo}.ts`, `src/kit/documents-client.ts`, `test/documents.test.ts`, plus an edit to `src/api/handlers/readyz.ts`. **Size:** M.

- [ ] **T13: The document service's isolation checks** (**review**)
  - **Does:**
    - the start-up walk refusing symlinks that point outside the granted code;
    - the job-folder check, refusing symlinks, hard links and non-regular files;
    - `selftest` in the service and in a child, the `lsof -p` check of the child's files, and the backend's positive control (a TCP connection to its own port, and a `localhost` lookup);
    - the ESLint ban on `exec`, shell `execFile` and `fork` in `src/documents/`.
  - **Acceptance:** each probe gives the expected answer; a planted symlink is refused; the positive control succeeds (the Linux half of platform spec 13).
  - **Verify:** `pnpm --filter @instante/backend test -- selftest`.
  - **Depends on:** T12. **Files:** `src/documents/{guards,tasks/selftest}.ts`, `eslint.config.mjs`, `test/selftest.test.ts`. **Size:** M.

- [ ] **T14: The web app's request rules** (**review:** `proxy.ts`'s checks)
  - **Does:**
    - `proxy.ts`:
      - its matcher leaving out only `_next/static`, `_next/image` and `favicon.ico`;
      - `Host` read from `request.headers.get('host')`, with `421` for anything but `ALLOWED_HOST`;
      - Fetch Metadata, with `403` except top-level navigations;
      - `/api` passing through;
      - prefetches skipping the CSP;
      - the nonce CSP;
    - `lib/{host,fetch-metadata,csp}.ts` as pure functions, the CSP with its development variant.
  - **Acceptance:** each rule is unit-tested; production's CSP has nothing from the development variant (part of platform spec 7).
  - **Verify:** `pnpm --filter @instante/web test`.
  - **Depends on:** T5. **Files:** `apps/web/proxy.ts`, `apps/web/lib/{host,fetch-metadata,csp}.ts`, `apps/web/lib/rules.test.ts`. **Size:** M.

- [ ] **T15: The web app's configuration**
  - **Does:**
    - `next.config.ts`: the rewrite to `BACKEND_INTERNAL_URL`, `experimental.proxyTimeout: 30000`, image optimization off (or `next.config.mjs`, if T2 found the permission model needs it, with the owner's yes);
    - `instrumentation.ts`, which exits on a mismatched `BACKEND_INTERNAL_URL`;
    - the root layout awaiting `headers()` and reading `x-nonce`.
  - **Acceptance:** `next build` lists no static page, checked by `scripts/check-no-static.sh` (which T18 runs in CI); a wrong `BACKEND_INTERNAL_URL` stops the server.
  - **Verify:** `pnpm --filter @instante/web build`; the start-up test.
  - **Depends on:** T14. **Files:** `apps/web/{next.config.ts,instrumentation.ts}`, `apps/web/app/layout.tsx`, `scripts/check-no-static.sh`. **Size:** S.

- [ ] **T16: The typed fetch helper**
  - **Does:** `lib/api.ts`: requests built from the contract, `credentials: 'omit'`, an injected token provider, replies parsed, `upstream_unavailable`, and `Blob` replies.
  - **Acceptance:** the parsing and the `upstream_unavailable` mapping are unit-tested.
  - **Verify:** `pnpm --filter @instante/web test -- api`.
  - **Depends on:** T5. **Files:** `apps/web/lib/api.ts`, `apps/web/lib/api.test.ts`. **Size:** S.

- [ ] **T17a: The shell**
  - **Does:** the shell's layout and navigation, with empty Inbox, Resumes, Applied and Settings pages, and the error and not-found pages.
  - **Acceptance:** each page renders in development with the nonce and no CSP violation; axe checks them in T19.
  - **Verify:** `pnpm dev`, then each page at `http://localhost:3000`.
  - **Depends on:** T15. **Files:** `apps/web/app/(shell)/layout.tsx`, the four small `page.tsx` files, `apps/web/app/{error,not-found}.tsx`. **Size:** M (small pages).

- [ ] **T17b: The ping page and `pnpm dev`**
  - **Does:**
    - the ping page, calling the API from a Server Component and a Client Component, and a PDF shown through a `Blob`;
    - the root `pnpm dev`: web on `127.0.0.1:3000` (`ALLOWED_HOST=localhost:3000`), the backend on `127.0.0.1:8080`, and the document service on a socket in its own `0700` folder under `$TMPDIR`.
  - **Acceptance:** `pnpm dev` brings all three up; `http://localhost:3000` shows the shell and the ping page with no CSP violation; `127.0.0.1:3000` gets `421`.
  - **Verify:** `pnpm dev`, then a browser at `http://localhost:3000`.
  - **Depends on:** T12, T16, T17a. **Files:** `apps/web/app/(shell)/ping/page.tsx`, `apps/web/app/(shell)/ping/pdf-preview.tsx`, `scripts/dev.sh`, plus an edit to `package.json`. **Size:** S.

- [ ] **T18: CI's scanners and the production build**
  - **Does:** in `ci.yml`:
    - osv-scanner, on every run and weekly on a schedule;
    - Semgrep with `--baseline-commit`;
    - ShellCheck over `scripts/`;
    - the production-build job: the build starts, `/readyz` answers, `src/` imports nothing from `test/`, the guard refuses each case, `selftest` passes on the production build, and `scripts/check-no-static.sh` passes;
    - `.github/dependabot.yml`, for npm and GitHub Actions.
  - **Acceptance:** platform spec 7, apart from the web app's launch flags (T19).
  - **Verify:** the pull request's checks.
  - **Depends on:** T13, T15. **Files:** `.github/workflows/ci.yml`, `.github/dependabot.yml`, `scripts/prod-build-check.sh`. **Size:** S.

- [ ] **T19: End-to-end tests**
  - **Does:**
    - Playwright's config, whose `webServer` starts the production build the way `instante start` will:
      - ports `4320` and `4321`, with `ALLOWED_HOST=localhost:4320`;
      - absolute Node and `--disable-sigusr1`;
      - the web app under `--permission`, reading only the checkout it runs from, as `instante start` grants the release folder;
      - readiness on the backend's `/readyz`;
    - the tests:
      - the ping page and a PDF through a `Blob`;
      - a fresh nonce and no violations on every page, and no static page;
      - the `Host` and Fetch Metadata refusals on a page, a prefetch and `/api`;
      - the slow route's message, with its own 45-second timeout;
      - axe on every page;
      - a planted secret the flagged web process can't read;
    - CI's end-to-end job;
    - `check:full`;
    - `check:task` timed.
  - **Acceptance:** the end-to-end tests pass in CI (platform spec 8), the web app's launch flags deny reading a secret (the rest of spec 7), and `check:task` runs in under 90 seconds (the rest of spec 2).
  - **Verify:** `pnpm --filter @instante/web test:e2e`; `time pnpm check:task`; the pull request's checks.
  - **Depends on:** T17b, T18. **Files:** `apps/web/playwright.config.ts`, `apps/web/e2e/{skeleton,request-checks,a11y}.spec.ts`, `.github/workflows/ci.yml`. **Size:** M.

### Checkpoint 3
- [ ] Every Linux job passes on one pull request (platform spec 3).
- [ ] Review session: the document service (T12, T13) and `proxy.ts`'s checks (T14).

## Phase D: The local stack

All `scripts/local` tests run under the root Vitest project `local` (`pnpm test:local`). Each test sets `HOME` and `INSTANTE_HOME` to scratch folders, so nothing ever touches the owner's real home, and test mode skips `brew pin`. The tests keep `PATH`, `MISE_DATA_DIR` and pnpm's store directory pointing at the real ones, which hold tools and package caches only, so `mise where` and `pnpm install` still work.

- [ ] **T20: The `instante` command and `setup`** (**review:** `setup`'s settings; the home check)
  - **Does:**
    - `scripts/local/instante` and its library:
      - bash 3.2, `set -u` and `pipefail`;
      - the home check, using `stat -L -f %d:%i`, with the default home only from inside `releases/` or for the first `setup`;
      - Node found with `mise where` from `/`, its version checked;
      - PostgreSQL from `/opt/homebrew/opt/postgresql@18/bin` with `LC_ALL=C`;
      - the socket-path limits;
      - a `PGPASSFILE` per role, and SCRAM verifiers sent on standard input;
      - git with no user configuration or hooks;
      - test mode and the reserved ports;
    - `setup`:
      - takes the lock;
      - creates the folders and their modes, `repo.git` and the passwords;
      - runs `initdb` with the spec's flags, and writes the configuration and `pg_hba.conf`;
      - creates the roles and the database;
      - runs `brew pin`, except in test mode;
      - its final release step comes in T21;
    - `config`;
    - the macOS job: a pinned runner label, a timeout, superseded runs cancelled, a check for `lockf`, `lsof` and `realpath`, then `setup` in a short scratch home whose path contains a space.
  - **Acceptance:**
    - `setup` works from nothing;
    - the cluster has no TCP listener and refuses a connection without a password;
    - the modes are `0700` and `0600`, and the locale is pinned (part of platform spec 9);
    - `setup` is refused when the home exists, and the default home is refused under other spellings.
  - **Verify:** `pnpm test:local -- setup`; the macOS job.
  - **Depends on:** T10, T19. **Files:** `scripts/local/{instante,lib.sh,setup.sh}`, `scripts/local/test/setup.test.ts`, plus edits to `vitest.config.ts`, `package.json` and `ci.yml`. **Size:** M.

- [ ] **T21: `release`** (**review:** `release`'s checks)
  - **Does:**
    - the seven steps:
      1. the lock;
      2. the id check;
      3. a fetch from the fixed address, then `merge-base --is-ancestor`;
      4. the exact commit's check runs from GitHub's public API, every page, refusing on 403, 429 or a missing job;
      5. `git worktree add`, or reuse of a clean kept folder;
      6. install and build, then a dump and `cli db migrate`, with the cluster started with the lock's descriptor closed;
      7. `current` and `releases.log`, with releases beyond the last 3 removed through `git worktree remove`;
    - refusal of the current commit and older ones;
    - `setup`'s final step, releasing the clone's own commit;
    - the local bare repository and the GitHub API stub for test mode.
  - **Acceptance:** each refusal in platform spec 14 (the "Instante is running" case tested by holding the lock), and a failed build leaves `current` unchanged.
  - **Verify:** `pnpm test:local -- release`.
  - **Depends on:** T20. **Files:** `scripts/local/release.sh`, `scripts/local/setup.sh`, `scripts/local/test/{github-stub,release.test}.ts`. **Size:** M.

- [ ] **T22: `start`, `stop` and `status`**
  - **Does:**
    - the `lockf` lock, inherited by the three processes, their ids in `run/`, the cluster started with the descriptor closed;
    - `config.env` read and each secret passed as a `*_FILE` path;
    - in production, the `instante.localhost` resolution check;
    - the migrations and pg-boss checks;
    - the daily dumps, at start and from the poll loop, keeping the newest 3 and those before the last 3 releases (from `releases.log`);
    - each process from `current` with `env -i`, absolute Node and `--disable-sigusr1`, the web app under `--permission`;
    - logs opened in append mode, copied and truncated past 20 MB by the poll loop, the last 10 starts kept;
    - the `lsof` loopback check;
    - the traps and the poll loop;
    - `stop` and `status`.
  - **Acceptance** (in the macOS job):
    - `GET /api/ping` works from a Server Component and a plain request (platform spec 10);
    - every listener is on loopback;
    - a second `start` is refused, `HUP` stops everything, and `stop` cleans up after a killed launcher;
    - logs keep 10 starts.
  - **Verify:** `pnpm test:local -- start`; the macOS job.
  - **Depends on:** T21. **Files:** `scripts/local/{start,stop,status}.sh`, `scripts/local/test/start.test.ts`. **Size:** M.

- [ ] **T23: `rollback`, `backup` and `restore`** (**review:** `restore`)
  - **Does:**
    - `rollback`: restores the dump taken before the current release, and moves `current` back;
    - `backup`, as `instante_owner`;
    - `restore`, with the lock held:
      - into `instante_restore` with `pg_restore -1 --exit-on-error`, then a check;
      - the swap with connections turned off, refused while `instante_old` remains;
      - grants and settings applied again, then `ANALYZE`;
    - `start` dropping `instante_old` after the swap.
  - **Acceptance:** a `backup` then `restore` gives back the same rows, grants and settings; after a release that adds `0002_skeleton.sql`, `rollback` returns to a release that starts (the rest of platform spec 14, and part of 15).
  - **Verify:** `pnpm test:local -- restore`.
  - **Depends on:** T22. **Files:** `scripts/local/{rollback,backup,restore}.sh`, `scripts/local/start.sh`, `scripts/local/test/restore.test.ts`. **Size:** M.

- [ ] **T24: `instante cli` and the macOS job's full checks**
  - **Does:**
    - `instante cli …`: the backend's `cli` from `current` as `instante_app`, refused unless Instante runs;
    - the macOS job's remaining checks, platform spec 9 to 15:
      - `echo`, cookies and headers, `413`, the slow route;
      - the `Host` and Fetch Metadata refusals;
      - `selftest` and `SIGUSR1`;
      - the home spellings and the reserved ports in test mode.
  - **Acceptance:** platform spec 9 to 15 all pass in the macOS job.
  - **Verify:** the macOS job on the pull request.
  - **Depends on:** T23. **Files:** `scripts/local/cli.sh`, `scripts/local/test/macos-criteria.test.ts`, `.github/workflows/ci.yml`. **Size:** M.

- [ ] **T25: Guides, runbooks and the link check**
  - **Does:**
    - `docs/guides/development.md`;
    - `docs/runbooks/local.md`: set up, start, release, roll back, change a secret, Homebrew and macOS upgrades, a lost Mac, a new Mac, the ruleset;
    - `docs/runbooks/database.md`;
    - the everyday commands in `AGENTS.md` §6;
    - `scripts/check-links.mjs` (Node, no dependency) and its CI step, a check the owner approves with this plan.
  - **Acceptance:** each command in the runbooks is the one the scripts implement; the link check passes.
  - **Verify:** `node scripts/check-links.mjs`; every runbook command checked against the scripts' usage text. Only the owner follows the runbook for real, in O1.
  - **Depends on:** T24. **Files:** `docs/guides/development.md`, `docs/runbooks/{local,database}.md`, `AGENTS.md`, `scripts/check-links.mjs`. **Size:** M.

### Checkpoint 4: `platform` done
- [ ] Every job green, the macOS one included; the owner adds the remaining jobs as required checks.
- [ ] Review session: `setup` and the home check (T20), `release`'s checks (T21), `restore` (T23).
- [ ] **O1, the owner:**
  - clones the repository at the walking skeleton's commit and runs `instante setup`;
  - runs `instante start`: the stack comes up in production mode, `/readyz` answers, and the ping page loads at `http://instante.localhost:4310` in each browser the owner uses (platform spec 16);
  - checks that `instante status` shows loopback only, the commit, current migrations and a fresh dump (platform spec 17).
- [ ] The `platform` demo.

## Phase E: Accounts ([accounts spec](../docs/specs/accounts.md))

From A6 on, every test stack (`pnpm dev`, Playwright, the macOS job) runs the fake Supabase, so platform's tests stay green as sign-in arrives.

- [ ] **A1: Supabase's own behaviour, on the development project** (owner-led; any time after T4)
  - **Does:**
    - the agent writes:
      - `docs/runbooks/supabase.md` (the spec's settings, and the steps O2 uses to check refusals);
      - `scripts/supabase-check.sh`, which uses only `curl` and Node, and takes the project URL, key and codes at the terminal;
    - the owner:
      - creates the development and production projects and applies the settings;
      - creates the owner's user with "Auto confirm" and a random password that isn't saved;
      - runs the script.
  - **Acceptance:** with sign-ups off, the user signs in by emailed code, and the token reaches `aal2` after the authenticator step (accounts spec 1). A failure reopens ADR-004 before any sign-in code exists.
  - **Verify:** the script prints the token's `aal` claim.
  - **Depends on:** T4. **Files:** `docs/runbooks/supabase.md`, `scripts/supabase-check.sh`. **Size:** S.

- [ ] **A2: The fake Supabase**
  - **Does:** `test/fake-supabase/{app,totp,keys}.ts`, plus a runnable entry point, `main.ts`:
    - the endpoints supabase-js calls, and CORS for its headers;
    - an ES256 key made at start, and the spec's claims;
    - `user.factors` and the 120-second token option;
    - TOTP tested against RFC 6238's Appendix B;
    - `GET /__test/last-code`, and `POST /__test/outage` to make its key endpoint fail on demand;
    - two fixture users: Jordan Rivera, and one with no account;
    - a drift test running the real `@supabase/supabase-js` against it.
  - **Acceptance:** supabase-js completes code sign-in, authenticator enrolment and verification, and refresh against the fake; the vectors pass.
  - **Verify:** `pnpm --filter @instante/backend test -- fake-supabase`.
  - **Depends on:** A1, Checkpoint 4. **Files:** `test/fake-supabase/{app,totp,keys,main}.ts`, `test/fake-supabase/fake.test.ts`. **Size:** M.

- [ ] **A3: Token verification and the key cache** (**review**)
  - **Does:**
    - `src/kit/auth/verify.ts`, with `jose`: `ES256` only, the issuer from `SUPABASE_URL`, the audience, 30-second tolerance, `role`, `is_anonymous`, `aal2` and a UUID `sub`;
    - `src/kit/auth/key-cache.ts`:
      - fetched at start and hourly;
      - the last good set kept after a failed fetch, with the failure logged;
      - an unknown key id fetched again at most once a minute, then the verification retried once;
    - the production guard's `SUPABASE_URL` pattern.
  - **Acceptance:**
    - every bad token in the spec is refused, a good one accepted, and a token with an unknown key refused after one fetch;
    - cached keys verify while the key endpoint is down;
    - a removed key is dropped at the hourly refresh.
  - **Verify:** `pnpm --filter @instante/backend test -- kit/auth`.
  - **Depends on:** A2. **Files:** `src/kit/auth/{verify,key-cache}.ts`, `src/kit/auth/auth.test.ts`, plus an edit to `src/kit/config.ts`. **Size:** M.

- [ ] **A4: Accounts and `authenticate`** (**review:** account linking, and the disabled and two-factor checks)
  - **Does:**
    - `0003_accounts.sql` (`app_user`, `audit_event`) and `src/store/users.ts`;
    - `test/seed.ts`, creating Jordan Rivera's `app_user` row linked to the fake's user;
    - `src/api/authenticate.ts`:
      - `403 unknown_account` and `403 account_disabled`;
      - a changed email stored and audited;
      - wired into `main.ts` with the key cache, in place of the one that refuses every token.
  - **Acceptance:** an unknown `sub` with a matching email gets `403 unknown_account`; a disabled account gets `403`; a changed email is updated and audited.
  - **Verify:** `pnpm --filter @instante/backend test -- authenticate`.
  - **Depends on:** A3. **Files:** `migrations/0003_accounts.sql`, `src/store/users.ts`, `src/api/authenticate.ts`, `test/{seed,authenticate.test}.ts`, plus an edit to `src/main.ts`. **Size:** M.

- [ ] **A5: `GET /api/me` and the matrices**
  - **Does:**
    - `GET /api/me` in the contract and its handler;
    - the isolation matrix generator, which fails on any route without an entry, with `/api/me`'s entry;
    - the unauthenticated matrix extended with `aal1` and with "a Supabase cookie but no bearer";
    - the log test for tokens and cookies.
  - **Acceptance:** `/api/me` returns `{ id, email, onboardingFinished, createdAt }`; both matrices pass; the production build refuses the fake's address, and `src/` can't import it (accounts spec 8).
  - **Verify:** `pnpm --filter @instante/backend test -- me isolation unauthenticated logs`.
  - **Depends on:** A4. **Files:** `packages/contract/src/routes.ts`, `src/api/handlers/me.ts`, `test/{isolation-matrix,logs}.test.ts`, plus an edit to `test/unauthenticated-matrix.test.ts`. **Size:** M.

- [ ] **A6: The fake in every stack**
  - **Does:**
    - the fake added to Playwright's `webServer`, the macOS job's test-mode stack and `pnpm dev` (`scripts/dev.sh --fake-supabase`);
    - `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` in each one's settings and `.env.example`;
    - both names added to `start`'s allowed list, read from `config.env`.
  - **Acceptance:** every existing end-to-end and macOS check still passes with the real `authenticate` and the fake.
  - **Verify:** `pnpm --filter @instante/web test:e2e`; `pnpm test:local`; the macOS job.
  - **Depends on:** A5. **Files:** `apps/web/playwright.config.ts`, `scripts/dev.sh`, `scripts/local/start.sh`, `.env.example`, `scripts/local/test/macos-criteria.test.ts`. **Size:** M.

- [ ] **A7: Supabase's clients and the token provider**
  - **Does:**
    - `lib/supabase/{server,browser}.ts`, reading the URL and publishable key at run time;
    - the root layout passing them to the browser client;
    - `lib/auth/token-provider.ts`, the only caller of `getSession()`, retrying once after a 401;
    - `connect-src` with the Supabase address.
  - **Acceptance:** the token provider's outcomes are unit-tested; the floor guard accepts `getSession()` there and nowhere else.
  - **Verify:** `pnpm --filter @instante/web test -- supabase token-provider`.
  - **Depends on:** A6. **Files:** `apps/web/lib/supabase/{server,browser}.ts`, `apps/web/lib/auth/token-provider.ts`, `apps/web/lib/auth/token-provider.test.ts`, plus edits to `apps/web/app/layout.tsx` and `lib/csp.ts`. **Size:** M.

- [ ] **A8: `proxy.ts`'s session step, with the tests signed in** (**review:** `proxy.ts`'s session logic)
  - **Does:**
    - the session step on pages and prefetches:
      - a refresh when under 5 minutes are left;
      - no redirect on a prefetch;
      - the request let through when the key set can't be fetched;
      - redirects to the right sign-in step;
    - `lib/auth/next-path.ts`;
    - an end-to-end helper that signs a test in by taking a session from the fake and setting Supabase's cookies on the browser context, with no sign-in page needed;
    - the existing end-to-end tests and the macOS job's Server Component ping signed in with it.
  - **Acceptance:**
    - the session step's outcomes are unit-tested, including a failed key-set fetch letting the request through;
    - `next=//elsewhere` returns to `/`;
    - every platform test still passes, signed in.
  - **Verify:** `pnpm --filter @instante/web test -- proxy next-path`; `pnpm --filter @instante/web test:e2e`; the macOS job.
  - **Depends on:** A7. **Files:** `apps/web/proxy.ts`, `apps/web/lib/auth/next-path.ts`, `apps/web/lib/auth/session.test.ts`, `apps/web/e2e/helpers/sign-in.ts`, plus edits to the existing end-to-end specs and `macos-criteria.test.ts`. **Size:** M.

- [ ] **A9: The sign-in pages**
  - **Does:**
    - `/sign-in` and `/sign-in/authenticator` (enrolment with `issuer: 'Instante'`, or `'Instante dev'`);
    - `/unknown-account`;
    - Settings › Account, with sign out and sign out everywhere;
    - the wireframes' wording.
  - **Acceptance:** the pages render from the wireframes, with the CSP, under `pnpm dev` with the fake.
  - **Verify:** `scripts/dev.sh --fake-supabase`, then each page at `http://localhost:3000`.
  - **Depends on:** A8. **Files:** `apps/web/app/sign-in/{page,authenticator/page}.tsx`, `apps/web/app/unknown-account/page.tsx`, `apps/web/app/(shell)/settings/account/page.tsx`. **Size:** M.

- [ ] **A10: Sign-in end to end**
  - **Does:** `e2e/sign-in.spec.ts`, against the fake:
    - sign in and enrol, then reload;
    - `aal1` sent to the authenticator step;
    - a page and a prefetch near expiry each refreshing once with 120-second tokens;
    - both sign-outs;
    - the unknown-account page;
    - the CSP on the sign-in pages, and axe;
    - with the fake's key endpoint failing (`POST /__test/outage`), a signed-in session keeps working and isn't redirected.
  - **Acceptance:** accounts spec 5 and 9 pass in CI.
  - **Verify:** `pnpm --filter @instante/web test:e2e -- sign-in`.
  - **Depends on:** A9. **Files:** `apps/web/e2e/sign-in.spec.ts`. **Size:** S.

- [ ] **A11: Owner commands and deletion** (**review:** deletion)
  - **Does:**
    - `cli users add`, `list`, `disable`, `enable`, `relink` and `delete`;
    - `src/engine/delete-user.ts`: rows removed in one transaction, queued jobs cancelled, one "account deleted" event with no email, a reminder to delete the user in Supabase;
    - the deletion test's fixture, which later modules extend.
  - **Acceptance:** each command works against the test database; after `delete`, none of the person's rows remain and their jobs are cancelled.
  - **Verify:** `pnpm --filter @instante/backend test -- users`.
  - **Depends on:** A4 (can run beside A5 to A10). **Files:** `src/cli/users.ts`, `src/engine/delete-user.ts`, `test/users.test.ts`. **Size:** M.

### Checkpoint 5: `accounts` done
- [ ] CI green, with changed lines at least 80% covered (accounts spec 6).
- [ ] Review session (accounts spec 10):
  - the verifier and key cache (A3);
  - account linking, and the disabled and two-factor checks (A4);
  - `proxy.ts`'s session logic (A8);
  - deletion (A11).
- [ ] **The owner, on the development project:**
  - adds their development user with `pnpm --filter @instante/backend cli users add` against the development database;
  - signs in at `http://localhost:3000`;
  - checks that a page near token expiry refreshes once and stays signed in (accounts spec 2). Getting near expiry means either waiting about 55 minutes, or lowering the development project's token expiry for the check and setting it back, which is the owner's call.
- [ ] **O2, the owner:**
  - runs `instante config` with the production project's URL and key, releases the current `main`, and starts Instante;
  - runs `instante cli users add` (accounts spec 7);
  - signs in at `http://instante.localhost:4310` with a code and the authenticator, in each browser the owner uses: the session survives a reload and a browser restart, a page at `http://localhost:3000` can't see its cookies, and `GET /api/me` returns the account (accounts spec 3);
  - checks, with the runbook's steps, that an `aal1` token, an unknown user id and a disabled account are refused (accounts spec 4).
- [ ] The `accounts` demo.
