# Frontend stack and the frontend/backend split

> **Phase 1 review, 2026-11-12:** an adversarial review changed some recommendations in this note. Where they differ, the ADRs in `docs/decisions/` and `docs/architecture.md` are authoritative; each ADR's "Doubts raised" section says what changed and why.

**Owner's decisions, 2026-11-13:** `apps/web` is confirmed; the web app signs in through Supabase Auth (ADR-004). Instante is a personal project for the owner, not a launch; multi-user, beta and 50-person estimates in this note describe the earlier framing and are now upper bounds.

Checked on 2026-11-12. The owner fixed the frontend: Next.js (App Router) with shadcn/ui, TypeScript, Tailwind CSS, ESLint and pnpm, on create-next-app's defaults. The open question is how to set that up today and how it talks to a backend written in another language. Recommendation: upgrade to pnpm 12, scaffold `web/` with Next.js 16.4 and write every default out as a flag, then apply shadcn's defaults (Base UI, Nova preset). Next.js only draws screens and holds no secrets. The browser reaches the backend through a same-origin rewrite of `/api/*`. Server Components read from the backend's internal address and forward only the session cookie. v1 has no Server Actions, no Route Handlers and no `'use cache'` on user data. Long AI work runs as backend tasks that the page polls. Orval generates the API client and form schemas from the backend's OpenAPI file, and CI fails on drift. No client data library yet. Forms use shadcn's Field components with React Hook Form and zod.

## Question

1. What do create-next-app, shadcn and pnpm produce today, and which commands give that result without prompts in a subfolder of this repo?
2. How do the browser and the Next.js server reach a separate backend? How does the session cookie travel? What do caching, `proxy.ts`, long tasks, uploads and downloads change?
3. How do frontend types stay in step with the backend, for each candidate backend language?
4. Does v1 need a client data library? Which form pattern?
5. What belongs in the frontend and what in the backend?

## Options compared

| Option | Verdict | Why |
|---|---|---|
| Browser → same-origin rewrite of `/api/*` → backend | recommended | One origin, no CORS. The backend sees the browser's own `Origin`, `Sec-Fetch-Site` and cookie, and bodies stream. Matches auth.md. |
| Server Components → backend's internal URL, session cookie forwarded | recommended | The documented pattern for an existing API. No extra hop through our own rewrite. |
| `proxy.ts` rewriting `/api` to the backend | runner-up | Reads the backend URL at runtime, but sends API traffic through the file that also does sign-in redirects. |
| Route Handlers as a backend-for-frontend | later | Only for an endpoint that needs reshaping. The documented example buffers whole bodies. |
| Server Actions calling the backend | later | A second CSRF model and a 1 MB body limit. Server-to-server calls carry no `Sec-Fetch-Site`, so the backend check in auth.md would refuse them. |
| Cross-origin calls to an `api.` host | rejected | Needs CORS with credentials and cookie forwarding anyway. |
| Cache Components on (the new default), no `'use cache'` on user data | recommended | The scaffold default and the planned Next.js 17 default. We only need `<Suspense>` around backend reads. |
| Cache Components off (`--no-cache-components`) | runner-up | One less concept for an app where every page is per-user, but a migration later. |
| Polling a task endpoint | recommended | Works through any proxy; 50 users make the load trivial. |
| Server-sent events through the rewrite | later | Compression buffers them and the proxy has a 30 s idle timeout. |
| Orval: fetch client plus zod schemas | recommended | Released weekly, works on OpenAPI 3.1 internally, no runtime library, zod for forms now and TanStack Query hooks later from the same spec. |
| openapi-typescript + openapi-fetch | runner-up | Simplest: one types file and a 6 kB client, with OpenAPI 3.1 support. No release since 2026-02-11 and an open question about maintenance. |
| Hey API (`@hey-api/openapi-ts`) | later | FastAPI's docs use it, but it is pre-1.0, asks for exact pins and hasn't released since 2026-06-22. |
| Kubb | later | Active, but more plugins and config than v1 needs. |
| Hono RPC (TypeScript backend only) | runner-up | No generator, but types cross packages and the editor slows as routes grow. |
| tRPC | later | Couples every call to its TanStack Query package; RPC shape, no OpenAPI. |
| ts-rest | rejected | Archived and unmaintained. |
| TanStack Query or SWR in v1 | later | Server Components, `router.refresh()` and one polling hook cover v1. |
| shadcn Field + React Hook Form + zod | recommended | shadcn's current form guide; field arrays suit the master resume. |
| TanStack Form or Formisch | runner-up | Also in shadcn's guides; nothing in v1 needs them. |
| shadcn's old `Form` wrapper | rejected | Gone from the docs. |
| Base UI (shadcn default since 2026-07-02) | recommended | The default for new projects; Radix stays one flag away. |
| Radix (`-b radix`) | runner-up | Still supported; most older examples use it. |
| React Compiler | later | Off by default; it adds a Babel pass. No measured need. |
| pnpm 12 | recommended | Current. Release-age delay and strict build-script checks are on by default since pnpm 11. |
| pnpm 10.18 (installed now) | rejected | Those protections are off by default, and the scaffold would write pnpm 10 settings that pnpm 11 removed. |

## Findings

### Next.js 16.4 and create-next-app
- `next` 16.4.6 is the latest release (2026-11-09) and needs Node 20.9 or later ([npm](https://www.npmjs.com/package/next)). 16.4 (2026-10-06) ships React 19.3. It recommends Cache Components for every app, enables them in new apps, and plans them as the Next.js 17 default ([16.4](https://nextjs.org/blog/next-16-4)).
- Security: scheduled releases about monthly since the program started on 2026-07-13 ([program](https://nextjs.org/blog/next-security-release-program)). On 2026-10-14, 16.4.1 fixed a critical RCE in `use cache` functions returning typed arrays, a critical RCE in SVG image optimization, and a Server Actions DoS ([post](https://nextjs.org/blog/nextjs-security-update-october-14-2026)). On 2026-11-03, 16.4.5 fixed seven advisories: three cross-tenant or cross-user leaks and a shell-poisoning bug in Cache Components, a cookie leak in Edge routes, and two more ([post](https://nextjs.org/blog/november-2026-security-release)).
- The recommended defaults are TypeScript, ESLint, no React Compiler, Tailwind CSS, no `src/`, App Router, Cache Components, AGENTS.md, agent feedback, alias `@/*`. Biome or no linter are the alternatives ([docs](https://nextjs.org/docs/app/api-reference/cli/create-next-app)).
- From the source: any `--` flag skips every prompt and fills the rest with the built-in recommended defaults. `--yes`, or a CI environment, fills them from preferences saved by earlier runs instead. Agent feedback stays off unless chosen in the prompt or passed as a flag ([index.ts](https://github.com/vercel/next.js/blob/v16.4.6/packages/create-next-app/index.ts)). So the owner's three-flag command already runs unattended; naming every flag also makes it immune to saved preferences.
- Git: inside an existing repo it skips `git init`. Elsewhere it initialises a repo and commits the scaffold ([git.ts](https://github.com/vercel/next.js/blob/v16.4.6/packages/create-next-app/helpers/git.ts)).
- It writes `AGENTS.md` only, no `CLAUDE.md`. The file holds a managed block telling agents to read the docs bundled in `node_modules/next/dist/docs/`. `next dev` re-adds the block when it detects a coding agent; `agentRules: false` turns that off ([generator](https://github.com/vercel/next.js/blob/v16.4.6/packages/create-next-app/helpers/generate-agent-files.ts), [16.3 AI](https://nextjs.org/blog/next-16-3-ai-improvements)). With a `CLAUDE.md` at the repo root, Claude Code by default reads a subfolder's `AGENTS.md` only through a `CLAUDE.md` in that folder that imports it ([Claude Code](https://code.claude.com/docs/en/memory)).
- The template ([templates/index.ts](https://github.com/vercel/next.js/blob/v16.4.6/packages/create-next-app/templates/index.ts)):
  - pins `react` and `react-dom` 19.3.0, and pins `tailwindcss` 4.3.3 because 4.3.4 breaks on Node without `require(esm)`;
  - wires Tailwind through the `@tailwindcss/turbopack` loader in `next.config.ts`, with no `postcss.config.mjs`, and adds `cacheComponents: true` and `partialPrefetching: true`;
  - uses `eslint ^9`, `typescript ^5` and `@types/node ^20`, with scripts `dev`, `build`, `start` and `lint` (plain `eslint`), and Turbopack for dev and build;
  - with pnpm 11 or later writes `pnpm-workspace.yaml` with `allowBuilds: { sharp: false, unrs-resolver: false }` (pnpm 10 gets `ignoredBuiltDependencies`), and sets `packageManager` to the pnpm that ran it.
- The scaffold lags: React is at 19.3.1, Tailwind 4.3.5 and TypeScript 7.0.2 ([npm](https://www.npmjs.com/package/react)). ESLint 9 reached end of life on 2026-08-06 and 10.x is current ([ESLint](https://eslint.org/version-support/)); `eslint-config-next` 16.4.6 accepts ESLint 9 or later ([npm](https://www.npmjs.com/package/eslint-config-next)). Node 20 ended on 2026-04-30 ([schedule](https://github.com/nodejs/Release/blob/main/schedule.json)).
- React Compiler has been stable since 16.0. It runs as a Babel plugin, so builds get slightly slower ([docs](https://nextjs.org/docs/app/api-reference/config/next-config-js/reactCompiler)).

### shadcn/ui
- `shadcn` 4.23.0 (2026-10-27) ([npm](https://www.npmjs.com/package/shadcn)). `create` is an alias of `init`. `-b` picks `base`, `radix` or `aria`; `-p` a preset; `-d` means template `next` plus the Nova preset; `--monorepo` exists; `-y` is on by default for `init` ([CLI](https://ui.shadcn.com/docs/cli)).
- Base UI became the default on 2026-07-02. Radix stays supported, new components ship for both, and `-b radix` keeps Radix ([changelog](https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default)). Without flags, `init` asks for the library (Base UI listed first, as recommended) and a preset ([presets.ts](https://github.com/shadcn-ui/ui/blob/shadcn@4.23.0/packages/shadcn/src/preset/presets.ts)). Nova means Lucide icons, the Geist font and a neutral base colour ([defaults.ts](https://github.com/shadcn-ui/ui/blob/shadcn@4.23.0/packages/shadcn/src/preset/defaults.ts)).
- Tailwind v4 is detected from `tailwindcss` in `package.json` plus a CSS file that imports it, so the Turbopack-loader scaffold qualifies ([get-project-info.ts](https://github.com/shadcn-ui/ui/blob/shadcn@4.23.0/packages/registry/src/get-project-info.ts)).
- The Base UI Nova style adds `@base-ui/react`, `lucide-react`, `class-variance-authority` and `cn`, plus dev dependencies `tw-animate-css` and `shadcn` itself ([registry item](https://ui.shadcn.com/r/styles/base-nova/index.json)). `cn` 0.5.2 is shadcn's replacement for clsx plus tailwind-merge ([npm](https://www.npmjs.com/package/cn)).
- In `components.json`, the style, base colour and CSS-variable mode are fixed at init ([docs](https://ui.shadcn.com/docs/components-json)). `--monorepo` scaffolds `apps/web` plus `packages/ui`; an existing app runs `init` in its own folder ([install](https://ui.shadcn.com/docs/installation/next)).
- Forms: shadcn's `Field` components wrap React Hook Form's `Controller`, with zod through `zodResolver`; any Standard Schema library works. TanStack Form and Formisch have guides too ([forms](https://ui.shadcn.com/docs/forms), [RHF guide](https://ui.shadcn.com/docs/forms/react-hook-form)).

### pnpm and Node
- pnpm 12.18.0 is the latest (2026-11-05). 11.0.0 came out on 2026-04-28 and 12.0.0 on 2026-08-26; 10.x still gets patches ([npm](https://www.npmjs.com/package/pnpm)).
- pnpm 11 changed the defaults ([11.0](https://pnpm.io/blog/releases/11.0)):
  - `minimumReleaseAge` is 1440 minutes (one day), and `strictDepBuilds` and `blockExoticSubdeps` are on;
  - `allowBuilds` (a name-to-boolean map) replaces `onlyBuiltDependencies`, `ignoredBuiltDependencies` and `neverBuiltDependencies`;
  - `.npmrc` keeps only registry and auth settings, Node 22 or later is required, and `pmOnFail: download` handles the `packageManager` pin.
- pnpm 12 reports unknown keys in `pnpm-workspace.yaml` ([12.0](https://pnpm.io/blog/releases/12.0)). `trustPolicy: no-downgrade` blocks a package whose trust level dropped ([supply chain](https://pnpm.io/supply-chain-security)). `pnpm self-update 12` installs a 12.x globally into `PNPM_HOME`; the page doesn't say it picks the newest 12.x (UNVERIFIED), and it fails for a Homebrew or Corepack install ([CLI](https://pnpm.io/cli/self-update)).
- Corepack is no longer shipped from Node 25 ([Node 25 docs](https://nodejs.org/download/release/v25.8.0/docs/api/corepack.html)); pnpm reads `packageManager` itself. Node 26 has been Active LTS since 2026-10-28 ([schedule](https://github.com/nodejs/Release/blob/main/schedule.json)).

### Next.js in front of a separate backend
- The backend-for-frontend guide: forward with `rewrites`; use a Route Handler only to validate, authenticate or reshape; send the backend only the headers it needs. Its handler example buffers bodies, so large or streamed payloads should use rewrites. Server Components should fetch from the source, Server Actions run one at a time, and serverless handlers time out ([BFF](https://nextjs.org/docs/app/guides/backend-for-frontend)).
- The data security guide: treat an existing API as zero trust and set the cookie on `fetch` yourself. Keep a server-only data access layer that returns minimal objects; Next.js handles `server-only` imports itself. Server Actions are public POST endpoints guarded by an `Origin`-versus-host check ([guide](https://nextjs.org/docs/app/guides/data-security)). They cap bodies at 1 MB and let requests with no `Origin` through with a warning ([serverActions](https://nextjs.org/docs/app/api-reference/config/next-config-js/serverActions)).
- `proxy.ts` replaced `middleware.ts` in 16.0 and runs on Node. It runs on every request unless the matcher excludes paths, and must not be the only auth check ([proxy](https://nextjs.org/docs/app/api-reference/file-conventions/proxy)).
- How `next start` forwards an external rewrite, read from the v16.4.6 source and not yet tested:
  - in production, rewrites come from `routes-manifest.json`, which `next build` writes, so the destination URL is fixed at build time ([filesystem.ts](https://github.com/vercel/next.js/blob/v16.4.6/packages/next/src/server/lib/router-utils/filesystem.ts));
  - it proxies with httpxy and `changeOrigin`, so the backend sees its own `Host`. It adds only `x-forwarded-host` and drops the request after 30 s without activity, set by `experimental.proxyTimeout` ([proxy-request.ts](https://github.com/vercel/next.js/blob/v16.4.6/packages/next/src/server/lib/router-utils/proxy-request.ts));
  - httpxy copies every request header (so `Origin`, `Sec-Fetch-Site` and `Cookie` arrive) and every response header (so `Set-Cookie` comes back unchanged). It adds no `X-Forwarded-For`, and passes one sent by the client through unchanged ([_utils.ts](https://github.com/unjs/httpxy/blob/main/src/_utils.ts), [web-outgoing.ts](https://github.com/unjs/httpxy/blob/main/src/middleware/web-outgoing.ts); read on `main`, while Next bundles 0.5.5);
  - the request body passes through a clone capped by `proxyClientMaxBodySize`, 10 MB by default. Past the cap the body is cut short with only a logged warning ([body-streams.ts](https://github.com/vercel/next.js/blob/v16.4.6/packages/next/src/server/body-streams.ts), [resolve-routes.ts](https://github.com/vercel/next.js/blob/v16.4.6/packages/next/src/server/lib/router-utils/resolve-routes.ts)). The docs describe the cap for `proxy` only ([docs](https://nextjs.org/docs/app/api-reference/config/next-config-js/proxyClientMaxBodySize));
  - gzip applies to every response, proxied ones too ([router-server.ts](https://github.com/vercel/next.js/blob/v16.4.6/packages/next/src/server/lib/router-server.ts)). The compression library holds event-stream data until flushed, and skips responses marked `Cache-Control: no-transform` ([compression](https://github.com/expressjs/compression)).
- Self-hosting: put a reverse proxy in front, and turn off buffering on every hop for streaming. Server-side env vars are read at runtime; `NEXT_PUBLIC_` ones are inlined at build ([self-hosting](https://nextjs.org/docs/app/guides/self-hosting)).

### Caching and the CSP
- With Cache Components, uncached reads and `cookies()` must sit inside `<Suspense>`. Otherwise the dev overlay raises a blocking-route error with three fixes: stream, cache, or `export const instant = false`. A link prefetch fetches the route's shell, and a shell that reads cookies is cached per session in the browser ([caching](https://nextjs.org/docs/app/getting-started/caching)).
- `fetch` is not cached unless asked. `force-cache` caches even requests that carry cookies. Identical GETs are deduplicated within one render ([fetch](https://nextjs.org/docs/app/api-reference/functions/fetch)).
- A nonce-based CSP needs dynamic rendering and doesn't work with Partial Prerendering. The documented alternative sets the header in `next.config` and allows inline scripts; hash-based SRI is experimental ([CSP](https://nextjs.org/docs/app/guides/content-security-policy)).

### Typed client from OpenAPI
- openapi-typescript 7.13.0 and openapi-fetch 0.17.0 both shipped on 2026-02-11 ([releases](https://github.com/openapi-ts/openapi-typescript/releases)). The client is 6 kB, and the generator supports OpenAPI 3.0 and 3.1 ([openapi-fetch](https://openapi-ts.dev/openapi-fetch/), [intro](https://openapi-ts.dev/introduction)). Since then the repo shows only dependency bumps. Issue #2843 (2026-07-15) asks whether it is still maintained ([issue](https://github.com/openapi-ts/openapi-typescript/issues/2843)).
- Orval 8.47.0 came out on 2026-11-07, with weekly releases ([releases](https://github.com/orval-labs/orval/releases)). Its outputs include `fetch`, `react-query`, `swr`, `zod`, `hono` and `mcp` ([config](https://orval.dev/docs/reference/configuration/output)). The fetch client returns `{ status, data }`, typed per status, and takes a custom mutator ([fetch](https://orval.dev/docs/guides/fetch-client)). Orval upgrades every input spec to OpenAPI 3.1 before generating; the work to make all generators assume 3.1 closed on 2026-09-19 ([#4113](https://github.com/orval-labs/orval/issues/4113)), and the v8 notes list a zod fix for nullable `$ref` ([v8 notes](https://github.com/orval-labs/orval/blob/master/docs/content/docs/versions/v8.mdx)). Not yet tested on our own spec.
- Hey API 0.99.0 (2026-06-22) calls itself early-stage and asks for exact pins ([docs](https://heyapi.dev/openapi-ts/get-started)). FastAPI's client guide uses it ([FastAPI](https://fastapi.tiangolo.com/advanced/generate-clients/)). Its repo has 675 open issues and pull requests, and its last commit was on 2026-09-30 ([repo](https://github.com/hey-api/hey-api)). Kubb is at 5.18.7 (2026-11-12) ([npm](https://www.npmjs.com/package/@kubb/core)).
- FastAPI emits OpenAPI 3.1. Its default operation IDs are long, and `generate_unique_id_function` shortens them ([FastAPI](https://fastapi.tiangolo.com/advanced/generate-clients/)). oasdiff v1.37.0 (2026-11-08) can flag breaking spec changes ([repo](https://github.com/oasdiff/oasdiff)).
- TypeScript backends: Hono RPC shares types through `hc<AppType>`. It needs `strict` on both sides and matching Hono versions, slows the editor as routes grow, and produces no OpenAPI ([Hono](https://hono.dev/docs/guides/rpc)). tRPC v11's App Router setup goes through its TanStack Query package ([tRPC](https://trpc.io/docs/client/nextjs)). ts-rest says it is no longer maintained ([repo](https://github.com/ts-rest/ts-rest)).

### Data fetching and forms
- The 16.3 guidance: Server Components own most fetching. A client library (SWR or TanStack Query) is for polling, refetching on focus and shared client state. Optimistic updates use `useOptimistic` inside a transition ([post](https://nextjs.org/blog/building-app-like-experiences-with-nextjs-16-3)).
- Current versions: TanStack Query 5.107.1, SWR 2.5.1, React Hook Form 7.92.0, @hookform/resolvers 7.0.6, zod 4.6.7, TanStack Form 1.33.5, react-markdown 10.1.0 ([npm](https://www.npmjs.com/package/@tanstack/react-query)).

## Lessons from earlier work

What transfers:
- An earlier prototype reported fetch, screening and build progress in three places until it gave them one status line. Instante gets one task model and one status area.
- Code computes the verdict; the model only extracts. Here the backend computes, and the frontend shows the verdict and its reasons.
- A plain web client should use `textContent`, never `innerHTML`, for server data and job text. Here: React's escaping, and react-markdown without `rehype-raw` as job-collection.md says. No `dangerouslySetInnerHTML`.
- Design rules that double as accessibility rules: a verdict always shows colour, icon and word together; text contrast is at least 4.5:1; phone targets are at least 44 px.

What doesn't: native components such as the system sidebar and menu-bar item, local-first offline work, and a framework-free web app that talks to Supabase straight from the browser.

## Recommendation for v1

### Scaffold (build phase, from the repo root)
```bash
pnpm self-update 12            # global pnpm 10.18 -> newest 12.x, before scaffolding
mise use node@26               # pins Node 26 LTS for this repo in mise.toml
pnpm create next-app@latest web --ts --tailwind --eslint --app --no-src-dir \
  --import-alias "@/*" --no-react-compiler --cache-components --agents-md \
  --no-agent-feedback --use-pnpm --disable-git
cd web
pnpm dlx shadcn@latest init -b base -p nova      # what --defaults picks, written out
pnpm dlx shadcn@latest add button card field input label textarea badge table dialog sheet sonner skeleton
```
Then:
1. Add `web/CLAUDE.md` containing `@AGENTS.md`, so Claude Code reads the Next.js block.
2. In `web/pnpm-workspace.yaml`, keep the scaffold's `allowBuilds` and add `minimumReleaseAge: 1440` (the default, written down) and `trustPolicy: no-downgrade`. When a new dependency has a build script, the install stops until someone allows or denies it there.
3. Try ESLint 10 in place of the end-of-life ESLint 9, and keep it if `pnpm lint` passes.

### Wiring
- `next.config.ts`: `rewrites()` sends `/api/:path*` to `${BACKEND_INTERNAL_URL}/api/:path*`. The build fails if the variable is unset, since the value is fixed at build. Set security headers, including the documented CSP without nonces, and `poweredByHeader: false`. No `images.remotePatterns`.
- No `app/api` routes: `/api` belongs to the backend.
- `lib/api/`: Orval output from the backend's committed `openapi.json`, with a fetch client and zod schemas. A small mutator adds the base URL: relative in the browser, `BACKEND_INTERNAL_URL` on the server.
- `lib/server/dal.ts` (`import 'server-only'`): `getMe` wrapped in React `cache` calls `GET /api/me` with only `__Host-instante_session` in the `Cookie` header and `cache: 'no-store'`. A 401 redirects to `/sign-in`, and a user who hasn't finished onboarding goes to `/onboarding`.
- `proxy.ts`: redirects to `/sign-in` when the cookie is missing. The matcher leaves out `api`, `_next/static`, `_next/image`, metadata files and the public pages.
- Routes: `(public)` holds sign-in and the privacy notice. `(app)` holds everything else under one layout with the navigation and the task status area.
- Reads happen in Server Components, each backend read inside `<Suspense>` with a skeleton. Lists keep filters and paging in the URL.
- Writes happen in Client Components that call the generated functions, then `router.refresh()` or `router.push()`. The backend's 422 field errors map onto form fields with `setError`.
- Forms: shadcn `Field` with React Hook Form and `zodResolver`, using the generated schemas.
- Long work: the backend answers `202` with a task id. `<TaskStatus>` polls `GET /api/tasks/{id}` every 2 s, every 5 s after a minute, stops on `done` or `failed`, then calls `router.refresh()`.
- Uploads: a file input for PDF and DOCX, with the 5 MB cap checked in the browser. `FormData` goes through the rewrite. The backend checks size and magic bytes; this multipart POST still passes its `Sec-Fetch-Site` check.
- Downloads: plain links to `/api/.../pdf`, so the cookie goes along. The backend sets `Content-Disposition` (`attachment` to download, `inline` to preview) and allows framing from `'self'` only. The preview opens in a new tab; desktop may embed it in an `<iframe>`.
- Job text: render `description_md` with react-markdown.

### Who does what

| Concern | Frontend (Next.js) | Backend |
|---|---|---|
| Rendering | All HTML, layout, formatting of dates and numbers | JSON and files only |
| Input validation | Instant feedback, from generated schemas | The only check that counts |
| Sign-in | Redirect without a cookie; ask `/api/me` | Codes, sessions, cookies, CSRF, rate limits (auth.md) |
| Authorization | Hides controls only | Every query scoped by `user_id`, ownership checks |
| Business rules | None: shows verdicts, reasons, tasks | Collection, screening, verdicts, resume rules |
| Secrets | None, and nothing secret in `NEXT_PUBLIC_` | AI key, SMTP, signing keys |
| LLM calls | Never | All of them, as tasks |
| Files | Pick, pre-check, link | Validate, store, render the PDF |
| Database | Never | Only its store layer |

### Guardrails
- CI for `web/` runs `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm exec tsc --noEmit` and `pnpm build`, and regenerates the client, failing if `git diff --exit-code` shows changes. The backend job exports `openapi.json` and fails if it differs from the committed copy.
- A check script fails on `'use server'`, `'use cache'`, `dangerouslySetInnerHTML`, `rehype-raw` or files under `app/api/`, until an ADR allows one.
- Patch Next.js within a week of each security release. `experimental.agentUpgrade` reminds agents about security upgrades by default ([16.4](https://nextjs.org/blog/next-16-4)).
- First build task, a spike on the chosen host. Check that `Set-Cookie` returns, and that `Origin` and `Sec-Fetch-Site` arrive. Check that the backend refuses a 6 MB upload rather than receiving a cut-off body, and that a 35 s silent request fails. Generate a client from a sample 3.1 spec with nullable fields; if Orval gets them wrong, switch to openapi-typescript.

### Per backend language
- Python (FastAPI): OpenAPI 3.1 comes from the Pydantic models. Set `generate_unique_id_function` so generated names read well, and export the spec with a script.
- Go: a code-first router that emits OpenAPI, or spec-first codegen (the backend note picks). The binary exports the spec.
- TypeScript (Hono): either Hono RPC through a root pnpm workspace, with no generator, or `@hono/zod-openapi` into the same Orval pipeline. The workspace settings then move to the root `pnpm-workspace.yaml`.

### What to store

| Table | Key fields | Retention |
|---|---|---|
| `task` | id, user_id, kind, subject_id, status (queued, running, done, failed), progress, result_id, error_code, created_at, started_at, finished_at; at most one queued or running task per (user_id, kind, subject_id) | 30 days after it finishes; deleted with the user |
| `file` (owned by database.md) | id, user_id, kind, filename, media_type, size_bytes, sha256, bytes | until the user deletes it or the account |

The frontend stores nothing of its own. Per-browser conveniences, such as a collapsed sidebar, may use `localStorage`.

## Later, and what would trigger it

| Addition | Trigger |
|---|---|
| TanStack Query (Orval can generate the hooks) | Three or more views poll or share client state, or optimistic updates span components |
| Server-sent events for progress or streamed text | The owner wants streamed text. Needs `Cache-Control: no-cache, no-transform`, a heartbeat under 30 s and a host check |
| Server Actions | Forms must work without JavaScript, or `useOptimistic` flows; needs an ADR on server-to-server CSRF |
| `'use cache'` on public, non-user data | A public page is slow; never with user arguments |
| Route Handlers under `/bff` | One endpoint needs reshaping the backend shouldn't do |
| React Compiler | Profiling shows re-render cost |
| TypeScript 7 | `tsc` and `next build` pass on it |
| Prettier with Tailwind class sorting | CONSTRAINTS.md asks for a formatter; create-next-app adds none with ESLint |
| Strict CSP through SRI | Next.js marks SRI stable |
| pdf.js preview | The `<iframe>` preview fails on phones |
| Dark mode toggle | The design work asks for it |
| oasdiff gate on breaking changes | A second API client appears |
| French interface | Quebec users join, or the app goes public |

## Risks
- **The rewrite findings come from reading source.** Another host, for example Vercel, runs external rewrites in its own network with its own limits (UNVERIFIED). The spike above comes first.
- **Bodies over 10 MB are cut silently.** The backend caps uploads at 5 MB and refuses any body shorter than its `Content-Length`.
- **A slow synchronous call dies at 30 s.** All AI work runs as tasks.
- **Client IP:** Next.js adds no `X-Forwarded-For` and passes a client's own through. Per-IP limits may trust only a proxy we run; per-address limits in auth.md stay primary.
- **Security cadence:** 2026's critical Next.js bugs sat in `use cache`, image optimization and Server Actions, all avoided in v1. The 2026-10-14 post still says to upgrade even without such `use cache` functions ([post](https://nextjs.org/blog/nextjs-security-update-october-14-2026)). Patching is still monthly work.
- **Cache Components is new.** Agents trained on the older model may add `'use cache'` or `force-cache`; the check script catches it.
- **Scaffold pins:** ESLint 9 (end of life), TypeScript 5, `@types/node` 20, React 19.3.0 and Tailwind 4.3.3. Mostly dev tools, but they need bumping with checks.
- **Base UI has fewer public examples than Radix.** shadcn's docs cover both libraries. Switching later means re-adding components.
- **New small dependencies:** `cn` is 0.x, and the `shadcn` CLI becomes a dev dependency.
- **The CSP allows inline scripts,** because nonces don't work with Partial Prerendering. XSS defence rests on React's escaping and Markdown without raw HTML.
- **PDF previews in an `<iframe>` on phones are UNVERIFIED,** so the new-tab link is the main path.

## Questions for the owner
1. Where should the Next.js server run? A frontend host such as Vercel would see every page request, the session cookie and rendered resume content. `next start` next to the backend keeps all of that on one machine. The hosting choice also sets cost.
2. For tailored resumes in v1, is a status line plus the finished resume enough, or should the text stream in as it's written? Streaming adds server-sent events through the proxy.
3. Is v1 English only? French matters once Quebec users join or the app goes public. Quebec's language rules weren't checked here.
4. Do you approve these frontend dependencies (AGENTS.md asks first)? They are the scaffold's own; shadcn's (`@base-ui/react`, `cn`, `class-variance-authority`, `lucide-react`, `tw-animate-css`, `shadcn`); and `react-hook-form`, `@hookform/resolvers`, `zod`, `react-markdown` and, as a dev tool, `orval`.

## Sources
- Next.js: [blog](https://nextjs.org/blog) · [16.4](https://nextjs.org/blog/next-16-4) · [16.3 AI](https://nextjs.org/blog/next-16-3-ai-improvements) · [16.3 app-like](https://nextjs.org/blog/building-app-like-experiences-with-nextjs-16-3) · [security program](https://nextjs.org/blog/next-security-release-program) · [2026-10-14](https://nextjs.org/blog/nextjs-security-update-october-14-2026) · [2026-11-03](https://nextjs.org/blog/november-2026-security-release) · [create-next-app](https://nextjs.org/docs/app/api-reference/cli/create-next-app) · [BFF](https://nextjs.org/docs/app/guides/backend-for-frontend) · [rewrites](https://nextjs.org/docs/app/api-reference/config/next-config-js/rewrites) · [proxy](https://nextjs.org/docs/app/api-reference/file-conventions/proxy) · [proxyClientMaxBodySize](https://nextjs.org/docs/app/api-reference/config/next-config-js/proxyClientMaxBodySize) · [data security](https://nextjs.org/docs/app/guides/data-security) · [serverActions](https://nextjs.org/docs/app/api-reference/config/next-config-js/serverActions) · [caching](https://nextjs.org/docs/app/getting-started/caching) · [fetch](https://nextjs.org/docs/app/api-reference/functions/fetch) · [CSP](https://nextjs.org/docs/app/guides/content-security-policy) · [self-hosting](https://nextjs.org/docs/app/guides/self-hosting) · [reactCompiler](https://nextjs.org/docs/app/api-reference/config/next-config-js/reactCompiler)
- Next.js source (v16.4.6): [create-next-app](https://github.com/vercel/next.js/blob/v16.4.6/packages/create-next-app/index.ts) · [git.ts](https://github.com/vercel/next.js/blob/v16.4.6/packages/create-next-app/helpers/git.ts) · [agent files](https://github.com/vercel/next.js/blob/v16.4.6/packages/create-next-app/helpers/generate-agent-files.ts) · [template](https://github.com/vercel/next.js/blob/v16.4.6/packages/create-next-app/templates/index.ts) · [proxy-request.ts](https://github.com/vercel/next.js/blob/v16.4.6/packages/next/src/server/lib/router-utils/proxy-request.ts) · [filesystem.ts](https://github.com/vercel/next.js/blob/v16.4.6/packages/next/src/server/lib/router-utils/filesystem.ts) · [resolve-routes.ts](https://github.com/vercel/next.js/blob/v16.4.6/packages/next/src/server/lib/router-utils/resolve-routes.ts) · [body-streams.ts](https://github.com/vercel/next.js/blob/v16.4.6/packages/next/src/server/body-streams.ts) · [router-server.ts](https://github.com/vercel/next.js/blob/v16.4.6/packages/next/src/server/lib/router-server.ts) · [httpxy](https://github.com/unjs/httpxy) · [compression](https://github.com/expressjs/compression)
- shadcn/ui: [CLI](https://ui.shadcn.com/docs/cli) · [Next.js install](https://ui.shadcn.com/docs/installation/next) · [components.json](https://ui.shadcn.com/docs/components-json) · [Base UI default](https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default) · [forms](https://ui.shadcn.com/docs/forms) · [RHF guide](https://ui.shadcn.com/docs/forms/react-hook-form) · [init.ts](https://github.com/shadcn-ui/ui/blob/shadcn@4.23.0/packages/shadcn/src/commands/init.ts) · [presets](https://github.com/shadcn-ui/ui/blob/shadcn@4.23.0/packages/shadcn/src/preset/defaults.ts) · [base-nova style](https://ui.shadcn.com/r/styles/base-nova/index.json) · [cn](https://www.npmjs.com/package/cn)
- pnpm and Node: [11.0](https://pnpm.io/blog/releases/11.0) · [12.0](https://pnpm.io/blog/releases/12.0) · [supply chain](https://pnpm.io/supply-chain-security) · [self-update](https://pnpm.io/cli/self-update) · [npm](https://www.npmjs.com/package/pnpm) · [Corepack in Node 25](https://nodejs.org/download/release/v25.8.0/docs/api/corepack.html) · [Node schedule](https://github.com/nodejs/Release/blob/main/schedule.json) · [ESLint versions](https://eslint.org/version-support/)
- API clients: [openapi-fetch](https://openapi-ts.dev/openapi-fetch/) · [openapi-typescript](https://openapi-ts.dev/introduction) · [issue #2843](https://github.com/openapi-ts/openapi-typescript/issues/2843) · [Orval output](https://orval.dev/docs/reference/configuration/output) · [Orval fetch](https://orval.dev/docs/guides/fetch-client) · [Orval releases](https://github.com/orval-labs/orval/releases) · [Orval #4113](https://github.com/orval-labs/orval/issues/4113) · [Orval v8 notes](https://github.com/orval-labs/orval/blob/master/docs/content/docs/versions/v8.mdx) · [Hey API](https://heyapi.dev/openapi-ts/get-started) · [FastAPI clients](https://fastapi.tiangolo.com/advanced/generate-clients/) · [oasdiff](https://github.com/oasdiff/oasdiff) · [Hono RPC](https://hono.dev/docs/guides/rpc) · [tRPC](https://trpc.io/docs/client/nextjs) · [ts-rest](https://github.com/ts-rest/ts-rest)
- Tooling: [Claude Code memory](https://code.claude.com/docs/en/memory)
