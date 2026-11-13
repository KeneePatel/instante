# Spec: `platform`, the walking skeleton

**Status:** draft for the owner's approval, phase 2, 2026-11-13, revised the same day after two fresh-context reviews. Module id `platform`, the first in the build order ([`product.md`](../product.md#modules-capability-map)); it depends on nothing. It's built at the start of phase 3, and its plan and tasks are written only after this spec is approved.

## Objective

Give every later module a working base, and prove the riskiest assumptions on the real server before any feature exists.

When `platform` is done:
- the pnpm workspace, the web app, the backend, the document service and the contract package exist, with their checks;
- CI runs the floor and the numbered constraints that already apply;
- one web image and one backend image are built and tested in CI, and the same images run on the server;
- the walking-skeleton checks below pass.

A failure reopens ADR-001, ADR-002, ADR-005 or ADR-011 while the cost is one module.

**Who it's for:** the owner, and the agents that build the next modules.

**Out of scope:**
- sign-in, the token verifier and `GET /api/me` (`accounts`);
- every feature table;
- AI calls (`ai`), fetching job boards (`job-pool`), parsing resumes (`master-resume`), rendering resumes (`tailoring`).

## Assumptions

1. The server is the one [ADR-011](../decisions/ADR-011-host.md) chooses.
2. Cache Components is off (decision D6). The root layout awaits `headers()`, so every page renders dynamically and gets a fresh nonce, and CI checks that `next build` reports no static page. If the owner keeps Cache Components on, the CSP section changes.
3. Images are built and run only in CI and on the server; the owner's Mac has no Docker.
4. Production gets no real sign-in or data in this module. Its database is disposable until the alpha ([`sdlc.md`](../sdlc.md#phase-3-build-in-slices)).

## Tech stack and dependencies

Versions are the latest stable on 2026-11-13. Each is pinned exactly when the scaffold runs, and nothing younger than 7 days is installed (`minimumReleaseAge: 10080` minutes, which makes `minimumReleaseAgeStrict` true). Every dependency below needs the owner's approval with this spec; later modules list their own.

| Where | Package | Version line | Why |
|---|---|---|---|
| tools | Node.js | 26.13 (Active LTS) | runtime, through `mise.toml` |
| tools | pnpm | 12.18 | package manager, pinned in `packageManager` |
| tools | PostgreSQL | 18 everywhere: Homebrew 18.7 on the Mac, `postgres:18` in CI, DigitalOcean's 18 in production | one major version to test |
| tools | Typst | 0.15.1 | installed in the backend image by `scripts/install-typst.sh`, checked by SHA-256; used from `tailoring` |
| tools | util-linux `prlimit` | from the image's base | caps Typst's memory |
| web | `next`, `react`, `react-dom` | 16.4, 19.3 | from `create-next-app` |
| web | `tailwindcss`, `@tailwindcss/turbopack` | 4.3 | from `create-next-app` |
| web | the components `shadcn init` adds (Base UI, the Nova preset's utilities, icons) | as written by `shadcn` 4.23 | the owner's chosen UI kit; the list is shown before it's committed |
| contract | `zod` | 4.6 | the shared schemas |
| backend | `hono`, `@hono/node-server` | 4.13, 2.1 | HTTP |
| backend | `pg`, `@types/pg` | 8.23 | the PostgreSQL driver |
| backend | `drizzle-orm` | 0.45 | the query builder (the 1.0 release candidate waits) |
| backend | `pg-boss` | 12.38 | the queue and schedules |
| dev | `typescript`, `@types/node` | 6.0.3, 26 | replacing the scaffold's `^5` and `^20`; typescript-eslint 8.72 accepts below 6.1 |
| dev | `eslint`, `typescript-eslint`, `eslint-config-next` | as the scaffold pins, 8.72 | one root config, plus a fast untyped one |
| dev | `prettier` | 3.10 | formatting |
| dev | `drizzle-kit` | 0.31 | drafts SQL only; never applies it |
| dev | `vitest`, `@vitest/coverage-v8` | 5.1 | unit and integration tests, coverage |
| dev | `@playwright/test`, `@axe-core/playwright` | 1.65, 4.14 | end-to-end and accessibility |
| CI only | gitleaks, osv-scanner, Semgrep, diff-cover | pinned versions | secrets (in git and in images), advisories, code findings, coverage of changed lines |

No logger, HTTP client or utility library is added: Node's `console` with our sanitizer and the built-in `fetch` are enough.

**Security releases younger than 7 days:**
1. The owner approves one exception row in `CONSTRAINTS.md`.
2. A version-pinned `minimumReleaseAgeExclude` entry (`next@16.4.9`, for example) lets that one version in.
3. The row is removed once the version is 7 days old.

That keeps "patched the day it lands" possible without loosening the setting.

## Configuration

`.env.example` lists every name; values live in git-ignored `.env` files locally and in Compose `secrets` on the server.

| Name | Read by | Secret | Notes |
|---|---|---|---|
| `INSTANTE_ENV` | backend, web | no | `development`, `test` or `production`; only the server sets `production` |
| `ROLE` | backend image | no | `all`, `api`, `worker`, `documents`, `migrate` or `cli` |
| `API_LISTEN_ADDRESS`, `PORT` | backend | no | the API listens only on its `app` address on the server |
| `DATABASE_URL_FILE` | backend (app role) | yes | `sslmode=verify-full` with DigitalOcean's CA in production |
| `OWNER_DATABASE_URL_FILE` | the `migrate` service only | yes | the owner role; no other service gets it |
| `DOCUMENTS_URL` | backend | no | the document service on the `docs` network |
| `BACKEND_INTERNAL_URL` | web | no | `http://backend:8080` in CI's Compose run and on the server alike |
| `HEALTHCHECKS_PING_URL_FILE` | backend | yes | decision D7 |

`accounts` adds `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`, read at run time.

## What gets built

### The workspace
- **Root files:**
  - `package.json` with `packageManager: pnpm@12.18.0`, `engines.node: ">=26.13 <27"` and the scripts below;
  - `pnpm-workspace.yaml`, with the packages and the settings: `minimumReleaseAge`, lifecycle scripts blocked unless named, exact versions;
  - `mise.toml` and `.env.example`.
- **TypeScript, one config per package:**
  - `tsconfig.base.json` holds the strict flags: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`;
  - the backend and the contract add `module: nodenext`, `erasableSyntaxOnly`, `allowImportingTsExtensions` and `noEmit`, because Node runs their `.ts` files;
  - the web app keeps the scaffold's `module: esnext`, `moduleResolution: bundler` and `@/*` paths, extends the base, and adds `allowImportingTsExtensions` so it can type-check the contract's imports.

  Every package has a `typecheck` script, `tsc --noEmit -p .`.
- **ESLint, one root config** that includes `eslint-config-next` for `apps/web`, replacing the scaffold's own file:
  - `check:fast` uses its untyped rules;
  - `check:task` and CI add the typed `strictTypeChecked` rules and the module-direction rules;
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
    - `GET /api/test/slow?seconds=35`;
    - `GET /api/test/file.pdf`, a fixture PDF.

### `apps/backend`
- **`src/main.ts`** reads `ROLE`.
- **`kit`:**
  - **configuration,** parsed with Zod at start: `*_FILE` values read from files, and a production guard. With `INSTANTE_ENV=production`, test routes and fake-AI mode refuse to start, and the database URL must use `verify-full`;
  - **a JSON logger** on `console` with one sanitizer: database errors keep only code, constraint and table, and `Authorization` and `Cookie` headers are redacted;
  - **`AppError`** with a contract error code;
  - **the clock and ids;**
  - **the document-service client,** with a 25-second timeout, under the rewrite's 30.
- **`api`:**
  - a Hono app built from the contract by `registerRoutes(table, handlers, authenticate)`. A route without an `auth` value, or without a handler, fails to register;
  - before any route, middleware drops `Cookie`, applies body limits per route, checks the JSON media type with our own parser, and adds a request id;
  - after every route, the reply is parsed through its response schema (unknown fields dropped), and `Cache-Control: private, no-store` and `Vary: Authorization` are added;
  - `authenticate` is injected. Until `accounts` supplies the real one, it refuses every token;
  - `GET /healthz` (the process is up) and `GET /readyz` (the database answers, migrations are current, the document service answers), both outside `/api`.
- **`store`:**
  - a `pg` pool for `instante_app`, and Drizzle over it;
  - **the migration runner:** numbered `migrations/NNNN_name.sql` files and a `schema_migrations(name, sha256, applied_at)` table. It fails on a gap, an unknown applied name or a changed file, except in rollback mode, where applied names newer than the image's last file are accepted (migrations only expand from the alpha on);
  - `0001_baseline.sql`: the `schema_migrations` table and the app role's grants;
  - `0002_skeleton.sql`: a `skeleton_ping` table, used by the queue check below.
- **`cli db migrate`,** run only by the one-off `migrate` service with the owner role's credentials, in this order:
  1. our runner;
  2. pg-boss's schema, applied through the library over our own `pg` connection, which verifies the database's certificate (never the CLI's `--ssl`, which skips verification);
  3. idempotent grants letting `instante_app` use pg-boss's schema, its tables and its functions;
  4. the queues, created as the owner.

  The app starts pg-boss with `migrate: false`.
- **The queue pattern every module uses,** proved here with `skeleton_ping`:
  - slow work (AI calls, fetches, parsing) happens outside any transaction;
  - then one short Drizzle transaction writes the result through `store` and completes the job with `complete(name, id, data, { db: fromDrizzle(tx, sql) })`;
  - jobs created by a request are sent inside the request's own transaction with `send(name, data, { db: fromDrizzle(tx, sql) })`.

  A rollback leaves neither the row nor the job's completion.
- **`documents`** (`ROLE=documents`): a Hono app on the `docs` network with one route, `POST /run/:task`.
  - **Each task runs in a child process** with `--permission`:
    - `--allow-fs-read` for the job's folder and the real paths of the backend source, `packages/contract` and `node_modules/.pnpm`;
    - no writes, child processes, workers or network;
    - `--max-old-space-size=256`, a 30-second timeout and a kill.
  - **Typst** is started by the document service itself under `prlimit --as=1073741824`, never by a child.
  - **Tasks in `platform`:**
    - `echo`, which returns the input's length and SHA-256;
    - `selftest`:
      - the document service's own process reports whether its environment holds anything beyond the allowed names, and whether it can reach the database's host and port, the network gateway's port 22, the backend's API port, or an outside name through DNS;
      - a child reports whether it can start a process.

      The backend runs the same network probes as a positive control, and they must succeed there.
- **`cli`:** `db migrate` and `db status`. Later modules add their owner commands here.

### `apps/web`
- **`next.config.ts`:**
  - `output: 'standalone'`, with `outputFileTracingRoot` at the workspace root; the image copies `public/` and `.next/static` into the standalone tree;
  - the rewrite of `/api/:path*` to `http://backend:8080/api/:path*`, the same in every environment, so one image serves CI and production;
  - image optimization off.
- **`instrumentation.ts`:** `register()` compares the built-in destination with `BACKEND_INTERNAL_URL`, and exits the process when they differ.
- **`proxy.ts`** (Next.js 16's name for middleware), following Next's CSP guide:
  - it makes a nonce per request and sets the `Content-Security-Policy` on the request and the response:
    - `default-src 'self'`;
    - `script-src 'self' 'nonce-…' 'strict-dynamic'`;
    - `style-src 'self' 'nonce-…'`;
    - `img-src 'self' data: blob:`;
    - `connect-src 'self'`, plus the Supabase address that `accounts` adds;
    - `frame-src blob:`;
    - `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'self'`;
  - its matcher covers every page, sign-in included, and leaves out only `/api`, `_next/static`, `_next/image`, the favicon and router prefetches;
  - the CSP builder is a pure function in `lib/`, unit-tested.
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

### The server ([ADR-011](../decisions/ADR-011-host.md))
`infra/` holds everything the server needs, and none of it holds a secret:
- **`cloud-init.yaml`:**
  - the admin and deploy users;
  - `sshd` with `AllowUsers`, key-only sign-in, and root, password and keyboard-interactive sign-in off;
  - unattended-upgrades, with Docker's repository allowed and a weekly reboot window;
  - Docker Engine 28 or later, with `daemon.json` (`live-restore`, the `local` log driver at 20 MB × 5, `no-new-privileges`);
  - the `DOCKER-USER` systemd unit;
  - the deletion-journal folder.
- **`compose.yaml`:**
  - the `edge`, `app`, `docs` and `egress` networks, with `docs` `internal` and its gateway mode `isolated`;
  - the services `caddy`, `web`, `backend`, `migrate` and `documents`;
  - per-service `secrets`;
  - the hardening on `documents`: `cap_drop: ALL`, a read-only root with a `tmpfs`, `pids_limit`, `mem_limit: 768m`, a non-root user;
  - the backend's fixed `egress` address.
- **The `Caddyfile`:** automatic HTTPS, HSTS, and the reverse proxy to `web`.
- **`instante-deploy` and its `sudoers` line:**
  - it accepts only `deploy <40-hex commit> <digest>` or `rollback <40-hex commit> <digest>`;
  - it verifies the images' attestations against `deploy.yml` on `main`, and pulls by digest;
  - `deploy` runs `migrate`, then restarts `web` and `backend`;
  - `rollback` accepts only the last 5 deployed commits, and skips `migrate`;
  - it never evaluates its input.
- **The deploy key's line:** `restrict,command="/usr/local/bin/instante-deploy"`.

### Scripts, CI and runbooks
- **Scripts:**
  - `scripts/check-commits.sh`;
  - `scripts/floor-guard.sh`, adapted from the constraint-driven-development skill's reference;
  - `scripts/install-typst.sh`, pinning 0.15.1 by the SHA-256 GitHub publishes per release file;
  - `scripts/dev-db.sh`, which creates the local and CI roles, giving the owner role `CREATEDB` for template databases, and the databases.
- **`.github/workflows/ci.yml`,** on pushes and pull requests, with no secrets in pull-request runs. Its jobs, mostly in parallel:
  - format, lint and types;
  - unit and integration tests on a `postgres:18` service, with coverage of changed lines;
  - the floor guard;
  - gitleaks over git;
  - osv-scanner and Semgrep;
  - both images built, then gitleaks over each image's files;
  - the image smoke tests;
  - end-to-end tests with axe, against the images.

  Actions are pinned by commit SHA, and each workflow has least-privilege `permissions`.
- **`.github/workflows/deploy.yml`,** on `main` after CI passes:
  - it pushes both images to GitHub Container Registry, tagged with the commit, with build-provenance attestations;
  - it connects through the protected `production` environment with the pinned host key;
  - it runs `deploy <commit> <digest>`.
- **Docs:**
  - `docs/guides/development.md` (set-up, commands, local roles);
  - `docs/runbooks/server.md` (build, harden, rebuild, re-pin the host key);
  - `docs/runbooks/deploy.md` (deploy, rollback);
  - `docs/runbooks/database.md` (roles, migrations, pg-boss, restore with the deletion journal);
  - the everyday commands in `AGENTS.md` §6.

## Local development and end-to-end runs
- **On the Mac:** `scripts/dev-db.sh` makes the roles and the `instante_dev` and `instante_test` databases on Homebrew's Postgres 18. `pnpm dev` runs web, the backend (`ROLE=all`) and the document service from source, with `INSTANTE_ENV=development`.
- **Integration tests:** each test worker copies a migrated template database.
- **End-to-end tests:**
  - **In CI,** Playwright runs against the built images in a Compose project: `postgres:18`, `migrate`, `backend`, `documents` and `web` with `INSTANTE_ENV=test`. `accounts` adds the fake Supabase as an extra test-only service.
  - **On the Mac,** Playwright's `webServer` starts the same processes from source.

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
- `check:full` adds the end-to-end tests, osv-scanner and Semgrep, as CI runs them.

## Project structure

```
instante/
  package.json  pnpm-workspace.yaml  pnpm-lock.yaml  mise.toml  .env.example
  tsconfig.base.json  eslint.config.mjs  eslint.fast.config.mjs  prettier.config.mjs
  .github/workflows/{ci,deploy}.yml   .github/dependabot.yml
  apps/
    web/                    the create-next-app scaffold (no src/ folder), plus:
      proxy.ts  instrumentation.ts  lib/{api.ts,csp.ts}  app/(shell)/…  e2e/  Dockerfile
    backend/
      src/{main.ts,kit/,api/,store/,engine/,documents/,cli/}
      migrations/           0001_baseline.sql, 0002_skeleton.sql
      test/                 integration tests, fixtures, fakes (never in the image)
      Dockerfile            the backend, migrate and document-service image
  packages/contract/src/    routes.ts, test-routes.ts, errors.ts, ids.ts
  infra/                    cloud-init.yaml, compose.yaml, compose.test.yaml, Caddyfile, instante-deploy
  scripts/                  check-commits.sh, floor-guard.sh, install-typst.sh, dev-db.sh
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

## Testing strategy

| Level | Tool | What it covers in `platform` |
|---|---|---|
| Unit | Vitest | `defineRoute` and `registerRoutes`; the id generator; the configuration parser and production guard; the sanitizer; the migration runner's checks and its rollback mode; the CSP builder; `lib/api.ts`'s parsing and its `upstream_unavailable` mapping |
| Integration | Vitest on Postgres 18, each worker on a copy of a migrated template database | migrations and grants; the queue pattern (commit creates the row and completes the job, rollback leaves neither); routes through `app.request` |
| Contract | `tsc`, route tests | every reply parses; a route without auth or a handler fails to register; `Cache-Control` and `Vary` on every reply; test routes absent in production mode |
| Unauthenticated matrix | generated from the route tables | every `user` route answers 401, including encoded paths and trailing slashes |
| Images | CI | both boot; `/readyz` answers; `typst --version` is 0.15.1; nothing from `test/` is inside; gitleaks finds nothing; `documents`' `selftest` and the backend's positive control |
| End to end | Playwright on Chromium against the images | the ping page; a PDF through a `Blob`; a fresh CSP nonce on every page and no violations; `next build` lists no static page; axe finds nothing critical or serious |

**Coverage scope,** decided now so it's never edited later: changed lines in `apps/backend/src`, `packages/contract/src` and `apps/web/lib` must be at least 80% covered ([`CONSTRAINTS.md`](../../CONSTRAINTS.md)). Pages and components are covered by the end-to-end and axe tests instead. Tests reach only localhost.

## Acceptance criteria

**In CI:**
1. A clean `pnpm install --frozen-lockfile` with pnpm 12 runs no lifecycle scripts, and installs nothing younger than 7 days.
2. `check:fast` takes under 5 seconds after a one-file change, and `check:task` under 90 seconds.
3. Every job above passes on the first pull request.
4. A route without auth or a handler fails to register, and test routes don't register with `INSTANTE_ENV=production`.
5. The queue pattern: a committed transaction writes the row and completes the job; a rolled-back one leaves neither.
6. The migration runner refuses a gap, an unknown name and a changed file, and in rollback mode accepts newer applied names.
7. The images: both boot; the backend image contains nothing from `test/`, and gitleaks finds nothing in either; `typst --version` prints 0.15.1.
8. The end-to-end tests above pass, including the PDF shown through a `Blob`.

**On the server,** with no data, running the same images with `INSTANTE_ENV=test` before production goes live:
9. `GET /api/ping` works from a Server Component and from the browser, through Caddy and the rewrite.
10. `POST /api/test/echo` shows the `Authorization` header arriving unchanged and no `Cookie`, and every `/api` reply carries `Cache-Control: private, no-store` and `Vary: Authorization`.
11. A 6 MB body gets `413`. `GET /api/test/slow?seconds=35` fails at the rewrite's 30 seconds, and the page shows the typed `upstream_unavailable` message.
12. Web, backend and document service use under 70% of the server's memory at idle. If not, the server is resized to 4 GB ([ADR-011](../decisions/ADR-011-host.md)).
13. Isolation:
    - `selftest` shows the document service with no secrets, unable to reach the database, the gateway's SSH, the backend's API or outside DNS, and with children unable to start a process;
    - the backend's positive control succeeds;
    - `web` and `caddy` can't connect to the database.
14. The deploy key: `ssh -N -L` is refused, and a malformed argument exits non-zero.
15. A deploy, then a rollback across `0002_skeleton.sql`, both from CI.

**Then** production switches to `INSTANTE_ENV=production`, and its first deploy passes `/readyz`.

## Boundaries

- **Always:**
  - follow [`AGENTS.md`](../../AGENTS.md) and [`CONSTRAINTS.md`](../../CONSTRAINTS.md);
  - write tests first;
  - pin exact versions;
  - keep secrets out of the web app and the document service;
  - run `check:task` before handing work back.
- **Ask first:**
  - any dependency not in the table above;
  - any change to a CI gate, the floor, the coverage scope or the migration runner's checks;
  - creating server resources, GitHub settings or secrets (the owner does these);
  - any change to an applied migration once production has data.
- **Never:**
  - hold production credentials or read production data;
  - give `documents`, `web` or `caddy` a route to the database;
  - use `pnpm deploy` for an image;
  - put the owner role's credentials anywhere but the `migrate` service;
  - add Server Actions, Route Handlers, `'use cache'` or raw HTML;
  - loosen a check to get a pass.

## Sizing

About 12 slices, not the 6 first estimated: the workspace and its checks, the contract, the backend's API and store, the migration runner, the queue pattern, the document service, the web shell and its CSP, the images, `infra/`, CI, the deploy, and the on-server checks. The owner reads these line by line:
- the contract helper;
- store scoping;
- the migration runner;
- the document service's isolation;
- `compose.yaml`;
- the `DOCKER-USER` unit;
- `cloud-init`'s `sshd` and firewall settings;
- the deploy script.

That's about 7 hours ([`sdlc.md`](../sdlc.md#sizing)).

## Open questions

- Decision D6 (Cache Components) changes the CSP section if the owner keeps it on.
- Decision D8 (a domain): the on-server checks use a sslip.io hostname, which is acceptable because no real sign-in happens in `platform`.
