# Spec: `platform`, the walking skeleton

**Status:** approved by the owner at the phase 2 gate, 2026-11-13, then revised the same day for the owner's host answer: Instante runs on the owner's Mac ([ADR-012](../decisions/ADR-012-run-on-the-owners-mac.md)), not on a server. A fresh-context review of that design, checked by eight verifiers, changed it again the same day, and a second review of the result (consistency and buildability) changed the bootstrap, rollbacks, the lock and the tests. The revised parts (assumptions, configuration, the request checks, the document service, the local stack, CI, the acceptance criteria and the sizing) were confirmed by the owner on 2026-11-13. Module id `platform`, the first in the build order ([`product.md`](../product.md#modules-capability-map)); it depends on nothing. It's built at the start of phase 3, and its plan and tasks are in [`tasks/plan.md`](../../tasks/plan.md) and [`tasks/todo.md`](../../tasks/todo.md).

## Objective

Give every later module a working base, and prove the riskiest assumptions on the owner's Mac before any feature exists.

When `platform` is done:
- the pnpm workspace, the web app, the backend, the document service and the contract package exist, with their checks;
- CI runs the floor and the numbered constraints that already apply, on Linux, and runs the local stack end to end on macOS;
- the owner has set up the real-use stack on the Mac with `instante setup`, released a commit, and started it, with no data;
- the walking-skeleton checks below pass.

A failure reopens ADR-001, ADR-002, ADR-005 or ADR-012 while the cost is one module.

**Who it's for:** the owner, and the agents that build the next modules.

**Out of scope:**
- sign-in, the token verifier and `GET /api/me` (`accounts`);
- every feature table;
- AI calls (`ai`), fetching job boards (`job-pool`), parsing resumes (`master-resume`), rendering resumes and installing Typst (`tailoring`);
- the deletion journal (the checklist in [`product.md`](../product.md#before-anyone-else-uses-it)).

## Assumptions

1. Instante runs on the owner's Mac as [ADR-012](../decisions/ADR-012-run-on-the-owners-mac.md) describes: local processes on loopback and sockets, a database cluster of its own, started by hand with `instante start`, and opened at `http://instante.localhost:4310`. Nothing is reachable from another machine.
2. Cache Components is off (decision D6, approved). The root layout awaits `headers()`, so every page renders dynamically and gets a fresh nonce, and CI checks that `next build` reports no static page.
3. There's no Docker anywhere except CI's `postgres:18` service on Linux.
4. Real use gets no sign-in or data in this module. The real-use database is disposable until the alpha ([`sdlc.md`](../sdlc.md#phase-3-build-in-slices)).
5. The Mac runs macOS 27 with `/bin/bash` 3.2, and has `lockf`, `lsof` and `realpath`. The CI job checks the same on its runner.

## Tech stack and dependencies

Versions are the latest stable on 2026-11-13. Each is pinned exactly when the scaffold runs, and nothing younger than 7 days is installed (`minimumReleaseAge: 10080` minutes, which makes `minimumReleaseAgeStrict` true). The owner approved these dependencies with this spec; later modules list their own.

| Where | Package | Version line | Why |
|---|---|---|---|
| tools | Node.js | 26.13 (Active LTS) | runtime, through `mise.toml`, which lists tools only |
| tools | pnpm | 12.18 | package manager, pinned in `packageManager` |
| tools | PostgreSQL | 18 everywhere: Homebrew 18.7 on the Mac (a development cluster and a separate real-use cluster), `postgres:18` in CI on Linux, Homebrew's in the macOS job | one major version to test |
| web | `next`, `react`, `react-dom` | 16.4, 19.3 | from `create-next-app` |
| web | `tailwindcss`, `@tailwindcss/turbopack` | 4.3 | from `create-next-app` |
| web | the components `shadcn init` adds (Base UI, the Nova preset's utilities, icons) | as written by `shadcn` 4.23 | the owner's chosen UI kit; the list is shown before it's committed |
| contract | `zod` | 4.6 | the shared schemas |
| backend | `hono`, `@hono/node-server` | 4.13, 2.1 | HTTP |
| backend | `pg`, `@types/pg` | 8.23 | the PostgreSQL driver |
| backend | `drizzle-orm` | 0.45 | the query builder (the 1.0 release candidate waits) |
| backend | `pg-boss` | 12.38, pinned exactly | the queue and schedules; an upgrade changes its schema, so it's its own release |
| dev | `typescript`, `@types/node` | 6.0.3, 26 | replacing the scaffold's `^5` and `^20`; typescript-eslint 8.72 accepts below 6.1 |
| dev | `eslint`, `typescript-eslint`, `eslint-config-next` | as the scaffold pins, 8.72 | one root config, plus a fast untyped one |
| dev | `prettier` | 3.10 | formatting |
| dev | `drizzle-kit` | 0.31 | drafts SQL only; never applies it |
| dev | `vitest`, `@vitest/coverage-v8` | 5.1 | unit and integration tests, coverage |
| dev | `@playwright/test`, `@axe-core/playwright` | 1.65, 4.14 | end-to-end and accessibility |
| CI only | gitleaks, osv-scanner, Semgrep, diff-cover, ShellCheck | pinned versions | secrets, advisories, code findings, coverage of changed lines, shell scripts |

ShellCheck was approved with the revised spec on 2026-11-13. No logger, HTTP client or utility library is added: Node's `console` with our sanitizer, the built-in `fetch`, and `node:http` for the document service's socket are enough.

**Security releases younger than 7 days:**
1. The owner approves one exception row in `CONSTRAINTS.md`.
2. A version-pinned `minimumReleaseAgeExclude` entry (`next@<the fixed version>`) lets that one version in.
3. The row is removed once the version is 7 days old.

That keeps "patched the day it lands" possible without loosening the setting.

## Configuration

`.env.example` lists every name. Development values live in git-ignored `.env` files. For real use, `instante start` reads `~/.instante/config.env` and passes each secret as a file path from `~/.instante/secrets/`.

| Name | Read by | Secret | Notes |
|---|---|---|---|
| `INSTANTE_ENV` | backend, web, scripts | no | `development`, `test` or `production`; only `instante start` sets `production` |
| `INSTANTE_HOME` | scripts | no | see "The local stack" for when the default `~/.instante` may be used |
| `ROLE` | backend | no | `all`, `documents` or `cli` |
| `LISTEN_ADDRESS`, `PORT` | backend | no | `127.0.0.1`; with `INSTANTE_ENV=production`, anything but loopback refuses to start |
| `ALLOWED_HOST` | web, backend | no | the one `Host` the web app answers: `instante.localhost:4310` for real use, `localhost:3000` in development, `localhost:4320` in test mode |
| `DATABASE_URL_FILE` | backend (app role) | yes | in production, parsed with `pg`'s own parser; any host but `$INSTANTE_HOME/run` refuses to start |
| `OWNER_DATABASE_URL_FILE` | `cli db migrate`, `pg-boss migrate`, dumps and `restore` only | yes | the owner role |
| `DOCUMENTS_SOCKET` | backend, document service | no | the document service's socket path, checked against macOS's 104-byte limit |
| `BACKEND_INTERNAL_URL` | web | no | `http://127.0.0.1:8080` in development, `http://127.0.0.1:4311` for real use; fixed at build time and checked at start |

`accounts` adds `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`, read at run time.

**Reserved for real use:** ports 4310 and 4311 and the name `instante.localhost`. With any other `INSTANTE_ENV`, or any home but the default, the configuration and the launcher refuse them. A tab the owner left open on real use can then never reach another Instante run, such as a test, while the real stack is stopped. Test mode uses `127.0.0.1:4320` (opened as `localhost:4320`) and `127.0.0.1:4321`.

## What gets built

### The workspace
- **Root files:**
  - `package.json` with `packageManager: pnpm@12.18.0`, `engines.node: ">=26.13 <27"` and the scripts below;
  - `pnpm-workspace.yaml`, with the packages and the settings: `minimumReleaseAge`, lifecycle scripts blocked unless named, exact versions, and `enableGlobalVirtualStore: false`, so every package link stays inside the checkout, which the web app's and the document service's read grants rely on;
  - `mise.toml` pinning Node 26.13.1, with tools only (no `[env]`, tasks or templates, which would need `mise trust`), and `.env.example`;
  - `.claude/settings.json`, denying `Read` and `Edit` of `~/.instante/**`. A CI check fails if any committed `.claude/` settings file has a `sandbox` key, an `allowRead`, or a rule naming `~/.instante` that isn't a deny. The sandbox, if the owner turns it on, lives only in the owner's user settings.
- **TypeScript, one config per package:**
  - `tsconfig.base.json` holds the strict flags: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`;
  - the backend and the contract add `module: nodenext`, `erasableSyntaxOnly`, `allowImportingTsExtensions` and `noEmit`, because Node runs their `.ts` files;
  - the web app keeps the scaffold's `module: esnext`, `moduleResolution: bundler` and `@/*` paths, extends the base, and adds `allowImportingTsExtensions` so it can type-check the contract's imports.

  Every package has a `typecheck` script, `tsc --noEmit -p .`.
- **ESLint, one root config** that includes `eslint-config-next` for `apps/web`, replacing the scaffold's own file:
  - `check:fast` uses its untyped rules;
  - `check:task` and CI add the typed `strictTypeChecked` rules and the module-direction rules, including "`src/` never imports `test/`" and "the document service never uses `exec`, `execFile` with a shell, or `fork`";
  - `noInlineConfig` and `reportUnusedDisableDirectives` are on.
- **The scaffold,** in the owner's command shape, with versions pinned at least 7 days old:
  ```bash
  pnpm create next-app@16.4.N apps/web --typescript --tailwind --eslint
  ```
  ```bash
  cd apps/web && pnpm dlx shadcn@4.23.N init -b base -p nova
  ```
  Then:
  - the nested `pnpm-workspace.yaml` and lockfile merge into the root's;
  - the scaffold's `typescript` and `@types/node` versions and its ESLint file are replaced as above;
  - `apps/web/CLAUDE.md` gets `@AGENTS.md`;
  - `next.config.ts` turns Cache Components off.

  Whether shadcn's generated components pass `exactOptionalPropertyTypes` and the typed rules without suppressions is checked on the day. If they don't, the owner approves either an edited copy of the component or a narrower flag for `components/ui`, recorded as an exception.

### `packages/contract`
- **`defineRoute`:** method, path, `auth: 'public' | 'user'`, request schemas (params, query, body), the response schema and error codes. The table is one exported object.
- **One error shape:** `{ error: { code, message, details } }`, with codes as a string union, including `upstream_unavailable` for the web side.
- **The id generator:** a prefix and 8 lowercase Crockford base32 characters ([ADR-008](../decisions/ADR-008-master-resume-document.md)).
- **Routes in `platform`:**
  - `GET /api/ping` (`public`);
  - a separate `testRoutes` table, registered only when `INSTANTE_ENV=test`:
    - `GET /api/test/user-only` (`user`), for the unauthenticated matrix;
    - `POST /api/test/echo`, which reports a SHA-256 of `Authorization`, whether a `Cookie` arrived before it was dropped, and the body's size, under a 5 MB limit;
    - `GET /api/test/slow?seconds=35`, which sends nothing at all, not even headers, for that long;
    - `GET /api/test/file.pdf`, a fixture PDF.

### `apps/backend`
- **`src/main.ts`** reads `ROLE`.
- **`kit`:**
  - **configuration,** parsed with Zod at start: `*_FILE` values read from files, and a production guard. With `INSTANTE_ENV=production`:
    - test routes and fake-AI mode refuse to start;
    - the database URL, parsed with `pg-connection-string` (the parser `pg` uses), must name `$INSTANTE_HOME/run` as its host;
    - the listen address must be loopback;
    - `process.version` must be the pinned Node, and `--disable-sigusr1` must be in `process.execArgv`;
  - **a JSON logger** on `console` with one sanitizer: database errors keep only code, constraint and table, and `Authorization` and `Cookie` headers are redacted;
  - **`AppError`** with a contract error code;
  - **the clock and ids;**
  - **the document-service client,** over `node:http` to `DOCUMENTS_SOCKET`, with a total 25-second deadline, under the rewrite's 30.
- **`api`:**
  - a Hono app built from the contract by `registerRoutes(table, handlers, authenticate)`. A route without an `auth` value, or without a handler, fails to register;
  - **before any route,** in this order:
    1. `Host` must be the backend's own `127.0.0.1:<port>`, and `X-Forwarded-Host`, when present, must equal `ALLOWED_HOST`; otherwise `421`;
    2. a `Sec-Fetch-Site` of `cross-site` or `same-site` gets `403`; requests without the header (Server Components, tools) pass;
    3. `Cookie` is dropped;
    4. body limits per route, checked on `Content-Length` before reading, since the rewrite cuts bodies over 10 MB without an error;
    5. our own JSON media-type check;
    6. a request id;
  - after every route, the reply is parsed through its response schema (unknown fields dropped), and `Cache-Control: private, no-store` and `Vary: Authorization` are added;
  - `authenticate` is injected. Until `accounts` supplies the real one, it refuses every token;
  - `GET /healthz` (the process is up) and `GET /readyz` (the database answers, migrations and pg-boss's schema are current, the document service answers), both outside `/api`.
- **`store`:**
  - a `pg` pool for `instante_app`, and Drizzle over it;
  - **the migration runner:** numbered `migrations/NNNN_name.sql` files and a `schema_migrations(name, sha256, applied_at)` table. It fails on a gap, an unknown applied name or a changed file, and has no mode that relaxes this; a rollback restores a dump instead ("The local stack"). It also fails if the database's encoding, locale provider or collation isn't the pinned `UTF8` and builtin `C.UTF-8`;
  - `0001_baseline.sql`: the `schema_migrations` table and the app role's grants;
  - `0002_skeleton.sql`: a `skeleton_ping` table, used by the queue check below.
- **`cli db migrate`,** run as `instante_owner` (by a release on the Mac, or by `scripts/dev-db.sh` and the tests), in this order:
  1. our runner;
  2. pg-boss's own `pg-boss migrate` command, with the owner's URL in `PGBOSS_DATABASE_URL`, never on the command line. It builds pg-boss's indexes in the same run, which a process started with `migrate: false` never would;
  3. idempotent grants letting `instante_app` use pg-boss's schema, its tables and its functions;
  4. the queues, created as the owner, since the app role can't create their partitions.

  The app starts pg-boss with `migrate: false` and `persistQueueStats: false`, and `/readyz` fails if pg-boss's schema version isn't the one the code expects.
- **The queue pattern every module uses,** proved here with `skeleton_ping`:
  - slow work (AI calls, fetches, parsing) happens outside any transaction;
  - then one short Drizzle transaction writes the result through `store` and completes the job with `complete(name, id, data, { db: fromDrizzle(tx, sql) })`;
  - jobs created by a request are sent inside the request's own transaction with `send(name, data, { db: fromDrizzle(tx, sql) })`.

  A rollback leaves neither the row nor the job's completion.
- **`documents`** (`ROLE=documents`): a Hono app on the Unix socket `DOCUMENTS_SOCKET`, with no TCP port and one route, `POST /run/:task`. It's started with only its own environment names, and no secret or database URL.
  - **At start,** it walks the code it will grant to its children (the backend source, `packages/contract` and `node_modules/.pnpm`, by real path) and refuses to run if any symlink there points outside them.
  - **Each job** gets a folder from `fs.mkdtemp`. The service writes the input bytes itself, never unpacks an archive to disk, and refuses anything in the folder that isn't a regular file with one link.
  - **Each task runs in a child process,** started with `child_process.spawn(process.execPath, [...])`, never through a shell or `fork`:
    - `--permission`, `--disable-sigusr1`, `--max-old-space-size=256`, and `--allow-fs-read` for the job's folder and the granted code's real paths only;
    - no writes, child processes, workers or network;
    - its own minimal environment, with no `NODE_OPTIONS`;
    - piped standard streams only, with no other file descriptors and no IPC channel;
    - a 30-second timeout and a kill.
  - **Tasks in `platform`:**
    - `echo`, which returns the input's length and SHA-256;
    - `selftest`:
      - the service's own process reports whether its environment holds anything beyond the allowed names, a database URL or a secret file path, and whether `--disable-sigusr1` is in its `execArgv`;
      - a child reports whether its `execArgv` is exactly the expected list; whether `NODE_OPTIONS` is set; and whether it can open a TCP connection to the backend's port, connect to the database's socket, look up `localhost`, write a file, start a process, or read `$INSTANTE_HOME/secrets`;
      - the service lists the child's open files with `lsof -p` and fails on any regular file, socket or lock file beyond its own pipes and Node's internal descriptors.

      The backend runs the same TCP and `localhost` lookup probes as a positive control, and they must succeed there. Every probe stays on this machine.
- **`cli`:** `db migrate` and `db status`. Later modules add their owner commands here.

Every Instante process, the web server included, starts with `--disable-sigusr1` on its own command line, not through `NODE_OPTIONS`.

### `apps/web`
- **`next.config.ts`:**
  - the rewrite of `/api/:path*` to `${BACKEND_INTERNAL_URL}/api/:path*`, fixed at build time, so each build (development, CI, a release on the Mac) carries its own loopback address;
  - `experimental.proxyTimeout: 30000`, written out so a change of Next's default is visible; it's an idle timeout;
  - image optimization off.

  If `next start` needs a native addon to load `next.config.ts` under the permission model, the slice may rename it to `next.config.mjs`, with the owner's yes.
- **`instrumentation.ts`:** `register()` compares the built-in destination with `BACKEND_INTERNAL_URL`, and exits the process when they differ.
- **`proxy.ts`** (Next.js 16's name for middleware). Its matcher leaves out only `_next/static`, `_next/image` and `favicon.ico`, with no header conditions, so `/api` and prefetches reach it too. Per request:
  1. **`Host`,** read from `request.headers.get('host')` (never `nextUrl.host`, which is the server's own address), must equal `ALLOWED_HOST`; otherwise `421`;
  2. **Fetch Metadata:** a `Sec-Fetch-Site` of `cross-site` or `same-site` gets `403`, unless the request is a top-level `GET` navigation (`Sec-Fetch-Mode: navigate`) to a page;
  3. **`/api`** stops here and passes through, so API calls get the backend's 401, never a redirect. **Prefetches** (`next-router-prefetch` or `Purpose: prefetch`) skip step 4, but still go through `accounts`' session refresh, without redirects, so a Server Component rendered for a prefetch never meets an expired token;
  4. **pages** get a nonce per request and the `Content-Security-Policy` on the request and the response, following Next's CSP guide:
     - `default-src 'self'`;
     - `script-src 'self' 'nonce-…' 'strict-dynamic'`;
     - `style-src 'self' 'nonce-…'`;
     - `img-src 'self' data: blob:`;
     - `connect-src 'self'`, plus the Supabase address that `accounts` adds;
     - `frame-src blob:`;
     - `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'self'`.

     In development the policy also allows what Next's CSP guide lists for `next dev` (`'unsafe-eval'`), keyed on `NODE_ENV`, and a test checks that production's has none of it. `accounts` adds the session logic after this step.

  The `Host`, Fetch Metadata and CSP rules are pure functions in `lib/`, unit-tested.
- **The root layout** awaits `headers()`, reads `x-nonce`, and renders dynamically.
- **The typed fetch helper,** `lib/api.ts`:
  - it builds the request from the contract, with `credentials: 'omit'`, and takes a token provider that `accounts` fills in;
  - it parses the reply with the route's response schema;
  - it turns a non-JSON or 5xx reply into the typed error `upstream_unavailable`, which the page shows as "Instante can't reach its server right now";
  - it can return a `Blob` for file routes, shown or saved through an object URL.
- **The shell:**
  - a layout with the app's name;
  - navigation entries for Inbox, Resumes, Applied and Settings, each showing an empty state until its module exists;
  - error and not-found pages;
  - one page that calls `GET /api/ping` from a Server Component and from a Client Component.

### The local stack ([ADR-012](../decisions/ADR-012-run-on-the-owners-mac.md))
`scripts/local/` holds the owner's `instante` command. Every subcommand:
- is written for macOS's `/bin/bash` 3.2 (no `wait -n`, no `timeout` command) and passes ShellCheck;
- works on `INSTANTE_HOME`, reads secrets only from files, takes values it can't generate from the terminal (never from arguments), and never evaluates its input;
- finds Node with `mise where node@<the pinned version>` from `/`, never `mise exec`, and refuses to run unless that Node prints the pinned version;
- uses PostgreSQL from `/opt/homebrew/opt/postgresql@18/bin`, with `LC_ALL=C`;
- **chooses its home safely:** it uses the default `~/.instante` only when the script's own real path is inside `~/.instante/releases/`, or when `setup` creates that home for the first time (it mustn't exist yet, and the owner types a confirmation). Any other run must set `INSTANTE_HOME`, which is created if missing and refused if it's the same folder as `~/.instante`, compared with `stat -L -f %d:%i` (APFS ignores case, and paths can differ by a slash, `..` or a link);
- checks that `run/documents.sock` fits in 104 bytes and the database's socket path in 103, and stops with a clear message if not;
- passes passwords to `psql`, `pg_dump` and `pg_restore` through each role's `PGPASSFILE`, never on a command line, and sets passwords with SQL on standard input carrying a SCRAM verifier it computes, so no plain password reaches `ps` or the server's log;
- runs every `git` command with `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1` and `core.hooksPath=/dev/null`, so the owner's git settings and hooks play no part.

| Subcommand | The lock | The cluster |
|---|---|---|
| `setup` | takes it | creates and starts it, then stops it |
| `start` | holds it while Instante runs | starts it, and stops it on exit |
| `release`, `rollback`, `restore` | take it, so Instante must be stopped | start it with the lock's descriptor closed, and stop it on exit |
| `stop` | | stops a running Instante and its cluster |
| `backup`, `cli` | | need Instante running, and refuse otherwise |
| `status`, `config` | | work either way |

The subcommands:
- **`instante setup`,** run once from a fresh clone, only while `~/.instante` doesn't exist, after the owner types a confirmation:
  - creates the folders with mode `0700` (secret files `0600`) and `repo.git`;
  - generates hex passwords for `instante_admin`, `instante_owner` and `instante_app`, and writes one `PGPASSFILE` and one connection-URL file per role into `secrets/`;
  - creates the cluster in `postgres/` with `initdb -U instante_admin --pwfile=secrets/<admin> --auth=scram-sha-256 -E UTF8 --locale-provider=builtin --builtin-locale=C.UTF-8 --locale=C`, then sets `listen_addresses = ''`, `unix_socket_directories` to `run/`, `unix_socket_permissions = 0700`, `timezone` and `log_timezone` to `UTC`, a single `local all all scram-sha-256` rule, and log rotation by weekday;
  - creates `instante_owner` with `CREATEDB`, `instante_app`, and the `instante` database owned by `instante_owner`, from `template0` with the pinned locale;
  - pins `postgresql@18` in Homebrew (`brew pin`), so installing something else can't upgrade it underneath a running cluster; the runbook unpins it for a planned upgrade;
  - then releases the clone's own commit (release steps 2 to 7, below), which creates `releases/<commit>/`, `current` and the `bin/instante` link. Nothing runs from the clone after that.
- **`instante config`:** sets the values in `config.env` that aren't secret, typed at the terminal: Supabase's URL and publishable key, once `accounts` needs them.
- **`instante start`:**
  - takes the lock: `exec 9>>run/instante.lock` and `lockf -s -t 0 9`, refusing to start a second copy. The three Instante processes inherit descriptor 9, so one left behind by a killed launcher still blocks a second start, and their process ids go into `run/`. The cluster is started with descriptor 9 closed, so it never holds the lock;
  - in production, refuses unless `instante.localhost` resolves to `127.0.0.1` and `::1` only;
  - starts the cluster if it's stopped, and waits until it answers;
  - refuses to continue if our migrations or pg-boss's schema aren't current;
  - dumps the database as `instante_owner` when the newest dump is more than 24 hours old, at start and then from its poll loop, so a start left running for weeks still dumps daily. It deletes dumps older than 14 days, but always keeps the newest 3 and the dump taken before each of the last 3 releases;
  - starts each process from `current`, with `env -i` plus its allowed names, the absolute Node path, `--disable-sigusr1` on its command line, and output to `logs/<start>-<process>.log`, keeping the last 10 starts and starting a new file when one passes 20 MB:
    - the document service on its socket;
    - the backend on `127.0.0.1:4311`;
    - the web app as `node --disable-sigusr1 --permission --allow-fs-read=<the release folder> --allow-net <the release>/apps/web/node_modules/next/dist/bin/next start -H 127.0.0.1 -p 4310`. If Next also needs `--allow-addons`, the slice records why; if it can't run under the permission model at all, the owner decides between a wider grant and accepting the risk;
  - checks with `lsof` that every listener is on loopback;
  - traps `HUP`, `INT` and `TERM`, and polls its children: on any of them, or when one process exits, it stops the others, then the cluster with `pg_ctl -m fast stop`.
- **`instante release <commit>`:** the seven steps in ADR-012:
  1. the lock;
  2. the id must be 40 hex characters;
  3. with `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`, `git fetch` of `main` from the repository's fixed GitHub address into `repo.git`, then `git merge-base --is-ancestor`, accepting only exit 0;
  4. GitHub's public API, with no token: the commit's check runs, every page of them, must include each required CI job by name, completed with `success`. Any 403, 429 or missing job is a refusal. It prints the commit's subject;
  5. `git worktree add releases/<commit>`, then `pnpm install --frozen-lockfile` and `pnpm build`, running that commit's scripts;
  6. a dump, then `cli db migrate` as `instante_owner`;
  7. `current` switches, `releases.log` gets the commit, time, dump, last migration and pg-boss's schema version, and releases beyond the last 3 are removed with `git worktree remove`.

  `release` refuses the current commit and older ones; going back is `rollback`'s job. A folder kept from an earlier release of the same commit, as after a rollback, is reused once a check shows it's clean and at that commit.
- **`instante rollback`:** with the lock held, it restores the dump taken just before the current release, points `current` back at the previous release's folder (kept, and already built), and records it in `releases.log`. Code and schema, pg-boss's included, then always match. The work done since that release is lost, which is acceptable for one person.
- **`instante backup`:** a dump on demand, as `instante_owner`.
- **`instante restore <dump>`,** with the lock held:
  1. `pg_restore -1 --exit-on-error` into a new database, `instante_restore`, created from `template0` with the pinned locale;
  2. a check that it answers and its migrations are known;
  3. with connections to `instante` turned off and none open, `instante` is renamed to `instante_old`, and `instante_restore` to `instante`. A leftover `instante_old` stops the next restore with a clear message;
  4. the database's grants and settings from `setup` are applied again, then `ANALYZE` runs;
  5. `instante_old` is dropped at the next successful start.

  On a new Mac, `instante setup` runs first, because a dump holds no roles.
- **`instante stop`:** stops the processes recorded in `run/` and the cluster, for when the launcher's terminal is gone.
- **`instante status`:** which processes run, every listener (all must be loopback), the current release, migrations, pg-boss's schema version, and the newest dump's age.
- **`instante cli …`:** passes owner commands to the backend's `cli` from `current`, as `instante_app`.

**Test mode** (`INSTANTE_ENV=test`): every subcommand needs an explicit `INSTANTE_HOME` that isn't `~/.instante`, and uses the test ports and host above. `release` keeps every check, but against a local bare repository standing in for GitHub and a local stub of GitHub's API with fixture answers. CI can then run the whole stack, and every refusal, in a scratch folder.

### What the owner sets up in this module
- the public GitHub repository, and one ruleset on `main`:
  - active, with an empty bypass list;
  - deletions restricted and force pushes blocked;
  - every CI job required, the macOS one included.

  `release` doesn't rely on the ruleset: it checks the exact commit's own CI runs itself;
- `instante setup` on the Mac, from a clone at the walking skeleton's commit, which also releases it;
- done on 2026-11-13: deny rules for `~/.instante` in the owner's Claude Code user settings ([ADR-012](../decisions/ADR-012-run-on-the-owners-mac.md), R9).

### Scripts, CI and runbooks
- **Scripts:**
  - `scripts/check-commits.sh`;
  - `scripts/floor-guard.sh`, adapted from the constraint-driven-development skill's reference;
  - `scripts/dev-db.sh`, which creates the development roles on Homebrew's cluster, giving the owner role `CREATEDB` for template databases. It creates the `instante_dev` and `instante_test` databases from `template0` with the pinned locale;
  - `scripts/local/`, above, with its tests and the GitHub stub.
- **`.github/workflows/ci.yml`,** on pushes and pull requests. It holds no secrets, because nothing deploys from CI. Its jobs, mostly in parallel:
  - format, lint and types;
  - unit and integration tests on a `postgres:18` service, started with `POSTGRES_INITDB_ARGS` for the pinned locale, with coverage of changed lines;
  - the floor guard, and the check on committed `.claude/` settings;
  - gitleaks over git;
  - osv-scanner, Semgrep and ShellCheck;
  - end-to-end tests with axe, against a production build started the way `instante start` starts it. Playwright waits on the backend's `/readyz` rather than a page, since a page needs the right `Host`, and the slow-route test gets its own 45-second timeout;
  - **the local stack, on a GitHub-hosted macOS runner** with a pinned label, a timeout well under 6 hours, and older runs of the same branch cancelled:
    - it checks for `lockf`, `lsof` and `realpath`;
    - then Homebrew's `postgresql@18`;
    - then `setup`, a second `release`, `start`, the checks below, `backup`, `restore`, `rollback` and `stop`, in a short scratch `INSTANTE_HOME` whose path contains a space.

  Actions are pinned by commit SHA, and each workflow has least-privilege `permissions`.
- **Docs:**
  - `docs/guides/development.md` (set-up, commands, the development roles, opening development at `http://localhost:3000`);
  - `docs/runbooks/local.md` (set up, start, release, roll back, change a secret, a Homebrew or macOS upgrade, a lost or broken Mac and a new one, the ruleset);
  - `docs/runbooks/database.md` (roles, migrations, pg-boss, backup, restore and rollback);
  - the everyday commands in `AGENTS.md` §6.

## Local development and end-to-end runs
- **On the Mac:** `scripts/dev-db.sh` makes the roles and the `instante_dev` and `instante_test` databases on Homebrew's Postgres 18. `pnpm dev` runs from source with `INSTANTE_ENV=development`:
  - web on `127.0.0.1:3000`, opened at `http://localhost:3000`, its `ALLOWED_HOST`;
  - the backend (`ROLE=all`) on `127.0.0.1:8080`;
  - the document service on a socket in a short folder of its own under `$TMPDIR`, mode `0700`, because a checkout in a deep worktree can pass macOS's socket-path limit.
- **Integration tests:** each test worker copies a migrated template database.
- **End-to-end tests:** Playwright's `webServer` starts the production build (web, backend, document service) on loopback with `INSTANTE_ENV=test`, in CI and on the Mac alike. `accounts` adds the fake Supabase as one more test-only server.

## Commands

```bash
pnpm install --frozen-lockfile
```
```bash
scripts/dev-db.sh
```
```bash
pnpm dev
```
```bash
pnpm check:fast
```
```bash
pnpm check:task
```
```bash
pnpm check:full
```
```bash
pnpm --filter @instante/backend cli db migrate
```

- `check:fast` runs Prettier, untyped ESLint and gitleaks on the changed files, in under 5 seconds.
- `check:task` adds each package's `typecheck`, typed ESLint, Vitest with coverage, and the floor guard, in under 90 seconds.
- `check:full` adds the end-to-end tests, osv-scanner, Semgrep and ShellCheck, as CI runs them.

The owner's own commands for real use (`instante setup`, `start`, `release`, `backup`, `restore`, `status`, `cli`) run only in the owner's terminal, from `~/.instante/bin/instante`. Agents never run them.

## Project structure

```
instante/
  package.json  pnpm-workspace.yaml  pnpm-lock.yaml  mise.toml  .env.example
  tsconfig.base.json  eslint.config.mjs  eslint.fast.config.mjs  prettier.config.mjs
  .claude/settings.json
  .github/workflows/ci.yml   .github/dependabot.yml
  apps/
    web/                    the create-next-app scaffold (no src/ folder), plus:
      proxy.ts  instrumentation.ts  lib/{api.ts,csp.ts,host.ts,fetch-metadata.ts}  app/(shell)/…  e2e/
    backend/
      src/{main.ts,kit/,api/,store/,engine/,documents/,cli/}
      migrations/           0001_baseline.sql, 0002_skeleton.sql
      test/                 integration tests, fixtures, fakes; src/ never imports them
  packages/contract/src/    routes.ts, test-routes.ts, errors.ts, ids.ts
  scripts/                  check-commits.sh, floor-guard.sh, dev-db.sh
    local/                  instante (setup, start, release, backup, restore, status, cli),
                            its tests, and the GitHub stub for test mode
  docs/guides/  docs/runbooks/
```

## Code style

```ts
// packages/contract/src/routes.ts
import { z } from 'zod';

export const PingResponseSchema = z.object({ ok: z.literal(true), at: z.iso.datetime() });

export const routes = {
  ping: defineRoute({
    method: 'GET',
    path: '/api/ping',
    auth: 'public',
    response: PingResponseSchema,
    errors: [],
  }),
} as const;

// apps/backend/src/api/handlers/ping.ts
import type { Handler } from '../register-routes.ts';
import { routes } from '@instante/contract';

export const ping: Handler<typeof routes.ping> = ({ clock }) => ({
  ok: true,
  at: clock.now().toISOString(),
});
```

- Named exports only, except where Next.js requires a default (pages, layouts, `proxy.ts`).
- Files in kebab-case, types and Zod schemas in PascalCase (`XxxSchema`), functions in camelCase.
- No `any`, no non-null assertions, no enums or namespaces (they aren't erasable syntax); use `as const` unions.
- Backend imports keep their `.ts` extension, since Node runs the source.
- SQL lives only in `store`, and every store function takes the person's id when the table is per person.
- Errors are `AppError(code)`; nothing else reaches a reply.
- Unit tests sit next to the code (`*.test.ts`); integration tests live in `apps/backend/test/`.
- Shell scripts use `set -u` and `pipefail`, quote every expansion, run on bash 3.2, and pass ShellCheck.

## Testing strategy

| Level | Tool | What it covers in `platform` |
|---|---|---|
| Unit | Vitest | `defineRoute` and `registerRoutes`; the id generator; the configuration parser and production guard (including a socket URL whose `host=` points elsewhere, and the reserved ports outside real use); the sanitizer; the migration runner's checks and its locale check; the CSP (development and production variants), `Host` and Fetch Metadata rules; `lib/api.ts`'s parsing and its `upstream_unavailable` mapping |
| Integration | Vitest on Postgres 18, each worker on a copy of a migrated template database | migrations, grants and `pg-boss migrate`; the queue pattern (commit creates the row and completes the job, rollback leaves neither); routes through `app.request`, including the backend's `Host`, `X-Forwarded-Host` and Fetch Metadata checks; the document service over a socket, including `selftest`, the job-folder checks and the backend's positive control |
| Contract | `tsc`, route tests | every reply parses; a route without auth or a handler fails to register; `Cache-Control` and `Vary` on every reply; test routes absent in production mode |
| Unauthenticated matrix | generated from the route tables | every `user` route answers 401, including encoded paths and trailing slashes |
| Production build | CI on Linux | it starts and `/readyz` answers; `src/` imports nothing from `test/`; with `INSTANTE_ENV=production`, a database URL off the socket, a non-loopback address or the wrong Node refuses to start; the web app's permission flags deny reading a secret |
| End to end | Playwright on Chromium against the production build | the ping page; a PDF through a `Blob`; a fresh CSP nonce on every page and no violations; `next build` lists no static page; the `Host` and Fetch Metadata refusals on a page, on a prefetch and on `/api`; `/api/test/slow` shows the typed message; axe finds nothing critical or serious |
| The local stack | CI on macOS, scratch `INSTANTE_HOME` with a space in its path | the acceptance criteria marked "macOS" below |

**Coverage scope,** decided now so it's never edited later: changed lines in `apps/backend/src`, `packages/contract/src` and `apps/web/lib` must be at least 80% covered ([`CONSTRAINTS.md`](../../CONSTRAINTS.md)). Pages and components are covered by the end-to-end and axe tests instead, and `scripts/local/` by the macOS job. Tests reach only this machine.

## Acceptance criteria

**In CI on Linux:**
1. A clean `pnpm install --frozen-lockfile` with pnpm 12 runs no lifecycle scripts, and installs nothing younger than 7 days.
2. `check:fast` takes under 5 seconds after a one-file change, and `check:task` under 90 seconds.
3. Every job above passes on the first pull request.
4. A route without auth or a handler fails to register, and test routes don't register with `INSTANTE_ENV=production`.
5. The queue pattern: a committed transaction writes the row and completes the job; a rolled-back one leaves neither.
6. The migration runner refuses a gap, an unknown name, a changed file and the wrong locale.
7. The production build starts and `/readyz` answers; `src/` imports nothing from `test/`; the production guard refuses a database URL off the socket, a non-loopback listen address, the wrong Node and the reserved ports outside real use; the web app's launch flags deny reading a file in `secrets/`; production's CSP has nothing from the development variant.
8. The end-to-end tests above pass, including the PDF shown through a `Blob`.

**In CI on macOS,** the local stack in a scratch home, with `INSTANTE_ENV=test`:

9. `setup`, `release` and `start` work from nothing. The cluster has no TCP listener (`lsof` shows none), and refuses a connection without a password. The data folder is `0700`, with `0600` secret files, and the databases use the pinned locale.
10. `GET /api/ping` works from a Server Component and from a plain request through the rewrite.
11. `POST /api/test/echo` shows the `Authorization` header arriving unchanged and no `Cookie`, and every `/api` reply carries `Cache-Control: private, no-store` and `Vary: Authorization`. A 6 MB body gets `413`. `GET /api/test/slow?seconds=35` fails with a 500 at about 30 seconds.
12. A foreign `Host` gets `421` on a page, on a page requested with `next-router-prefetch: 1`, on `/api` through the rewrite, and on the backend directly. A request with `Sec-Fetch-Site: cross-site` gets `403`, except a top-level navigation to a page. `lsof` shows every listener on loopback, with nothing on `*` or `::`.
13. Isolation:
    - `selftest` shows the document service with only its allowed environment names and `--disable-sigusr1`;
    - its child has exactly the expected flags, no `NODE_OPTIONS`, and no open file, socket or lock beyond its pipes;
    - its child can't open a TCP connection, connect to the database's socket, look up `localhost`, write, start a process or read the secrets folder;
    - the backend's positive control succeeds;
    - a symlink placed in a job folder is refused;
    - `SIGUSR1` sent to each Instante process opens no inspector.
14. Releases:
    - `release` refuses a short id, a commit `main` doesn't contain, a commit whose check runs are missing, failed or unreadable (a 403 or 429 from the stub), the current or an older commit, and any run while Instante is running;
    - a failed build leaves `current` unchanged;
    - after a release that adds `0002_skeleton.sql`, `rollback` restores the dump taken before it and returns `current` to the previous release, which then starts.
15. `backup`, then `restore`, gives back the same rows with the grants and settings in place. A second `start` is refused while the first runs. Sending the launcher `HUP` stops every process and the cluster, and `stop` cleans up after a killed launcher. Logs keep only the last 10 starts. A run with `INSTANTE_HOME` spelled as `~/.INSTANTE` or with a trailing `/..` is refused, as are ports 4310 and 4311 in test mode, and `setup` when the home already exists.

**On the owner's Mac,** with no data, after the owner runs `instante setup` from a clone at the walking skeleton's commit:

16. `instante start` brings the stack up in production mode, `/readyz` answers, and the ping page loads at `http://instante.localhost:4310` in each browser the owner uses.
17. `instante status` shows every listener on loopback, the released commit, current migrations and a fresh dump.

## Boundaries

- **Always:**
  - follow [`AGENTS.md`](../../AGENTS.md) and [`CONSTRAINTS.md`](../../CONSTRAINTS.md);
  - write tests first;
  - pin exact versions;
  - keep secrets out of the web app and the document service;
  - run `check:task` before handing work back;
  - test `scripts/local/` only against a scratch `INSTANTE_HOME`.
- **Ask first:**
  - any dependency not in the table above;
  - any change to a CI gate, the floor, the coverage scope or the migration runner's checks;
  - GitHub settings, Supabase settings, or anything the owner sets up;
  - any change to an applied migration once the real-use database has data.
- **Never:**
  - read `~/.instante`, run `instante`, or connect to the real-use cluster;
  - change GitHub's rules for `main`, or add `sandbox` or `allowRead` settings to the repository's `.claude/` files;
  - give the document service or the web app a secret or a database password;
  - listen on anything but loopback or a socket in `INSTANTE_HOME` or the development socket folder;
  - use ports 4310 or 4311 or the name `instante.localhost` outside real use;
  - start a document task through a shell or `fork`;
  - use `pnpm deploy`;
  - put the owner role's credentials anywhere but `secrets/`, read only by `cli db migrate`, `pg-boss migrate`, the dumps and `restore`;
  - add Server Actions, Route Handlers, `'use cache'` or raw HTML;
  - loosen a check to get a pass.

## Sizing

About 11 slices:
1. the workspace and its checks;
2. the contract;
3. the backend's API and kit, with the request checks;
4. the store and migration runner;
5. the queue pattern and `pg-boss migrate`;
6. the document service;
7. the web shell with its CSP, `Host` and Fetch Metadata checks;
8. CI on Linux;
9. the local stack's `setup` and `start`;
10. `release` and `rollback`, with the GitHub checks and the stub;
11. backup, restore and the macOS job.

Then comes the owner's own set-up on the Mac. The owner reads these line by line:
- the contract helper;
- store scoping;
- the migration runner;
- the document service's isolation;
- the request checks in `proxy.ts` and the backend;
- the local stack: `setup`'s database and folder settings, the home check, `release`'s checks, and `restore`.

That's about 7 hours ([`sdlc.md`](../sdlc.md#sizing)).

## Open questions

- **The agents' access to `~/.instante`** (residual risk R9): Claude Code deny rules in the owner's user settings since 2026-11-13. Whether to add its sandbox, or a separate macOS user for real use, is decided before the alpha ([ADR-012](../decisions/ADR-012-run-on-the-owners-mac.md)).
- Starting Instante at login (a LaunchAgent) stays out of v1 unless the owner asks.
