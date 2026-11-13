# ADR-005: One host, a same-origin rewrite, and a contract table shared by web and backend

## Status
Accepted 2026-11-13: the owner chose hosting model (a) at the phase 1 gate. Proposed 2026-11-12 and revised after two adversarial review cycles the same day. Sign-in changed to Supabase Auth the same day, so the backend now takes a bearer token instead of a cookie.

## Date
2026-11-12

## Context
- Sign-in is Supabase Auth. The session lives in Supabase's cookies, and every call to the backend carries the access token as a bearer token ([ADR-004](ADR-004-supabase-auth.md)). The browser and Server Components both call the backend.
- How a rewrite behaves depends on where Next.js runs:
  - Under `next start`, the rewrite forwards `Origin`, `Sec-Fetch-Site` and `Cookie` and returns `Set-Cookie` unchanged. It drops requests silent for 30 seconds and cuts bodies over 10 MB ([frontend note](../research/frontend.md), read from source).
  - On Vercel, external rewrites run in Vercel's network. For projects created since 2026-04-06, Vercel caches upstream responses by default.
- Web and backend deploy at different moments, and old browser tabs keep calling the API, so a check on one commit isn't enough once there's a release.
- Next.js's November 2026 security release fixed seven advisories:
  - three involve `'use cache'` functions;
  - a fourth, shared-shell cache poisoning, hits self-hosted `next start` apps with Cache Components on and Partial Prefetching off or unset;
  - the other three are unrelated to caching.

  `create-next-app` 16.4.6 writes `cacheComponents: true` and `partialPrefetching: true` (as the review read the release post and the scaffold's template; checked again in phase 3).

## Decision
- **Hosting model (a), the owner's choice:** the web app (`next start`) and the backend run on one host. Only the web app is public; the backend and the database sit on the private network. The vendor is chosen in phase 2 against the criteria in [`architecture.md`](../architecture.md#environments), and the walking skeleton deploys there.
- **Wiring:**
  - `next.config.ts` rewrites `/api/:path*` to `${BACKEND_INTERNAL_URL}/api/:path*`. The destination is fixed at build time, so it's the same Compose name (`http://backend:8080`) everywhere and one web image serves CI and production; the server exits at start if the built-in destination differs from `BACKEND_INTERNAL_URL`.
  - Browser writes are Client Components calling `/api/...`.
  - Server Components read the backend directly with the person's access token as a bearer token, `cache: 'no-store'`, inside Suspense. The backend never reads or sets cookies.
  - `proxy.ts` refreshes the Supabase session with `getClaims()` and redirects to sign-in when there's none ([ADR-004](ADR-004-supabase-auth.md)). Its matcher covers every page, sign-in included, and leaves out `/api`, static assets and prefetches, so API calls get a 401 rather than a redirect; the sign-in pages skip only the session redirects.
  - The typed fetch helper sends `credentials: 'omit'`, so Supabase's cookies never reach the backend.
- **Not in v1:**
  - Server Actions;
  - Route Handlers: no `route.ts` or `route.js` anywhere under `apps/web/app`;
  - `'use cache'` or `force-cache`;
  - `dangerouslySetInnerHTML` and `rehype-raw`.

  The floor guard fails on any of these, matching either quote style. It also fails if `partialPrefetching` is turned off while Cache Components is on.
- **The contract**, a route table in `packages/contract`. Each entry holds method, path, auth (`public` or `user`), request schemas, response schema and error codes.
  - The backend registers handlers only through a helper that reads the table. It fails closed, validates the request, parses every reply through the response schema (dropping unknown fields), maps errors to one shape (422 for validation), and sets `Cache-Control: private, no-store` and `Vary: Authorization`.
  - The web app calls the backend with a small typed fetch built on the same table, and never imports `apps/backend`.
  - The isolation and unauthenticated test matrices are generated from the table.
  - From the release phase on, `contract.json` (a JSON Schema snapshot of the table) is committed, and CI fails when it's stale. A removal or rename then ships in two deploys. Before that, shapes change freely.
- **Long work:** the API answers `202`, and the page polls the subject's own row (the import, the tailored resume, or the inbox counts). The poll backs off to every 5 seconds and shows "taking longer than expected" after 10 minutes.
- **Files:** previews are `GET` and never change state. A download is `POST`: it stores the exact bytes it returns, and Mark applied freezes them ([ADR-009](ADR-009-strict-tailoring-and-typst.md)). Uploads are capped at 5 MB in the browser and enforced by the backend.
  - An `<iframe>`, `<a>` or `<img>` can't send a bearer token, so previews and downloads are fetched by the typed helper, turned into a `Blob`, and shown or saved through an object URL. The CSP allows `blob:` for frames and downloads, nothing more.
- **No client data library in v1:** Server Components, `router.refresh()` and one polling hook are enough.
- **Cache Components:** the scaffold's default stays on, with `partialPrefetching: true` as written. Turning Cache Components off instead (every page here is per-person, and it allows a nonce-based CSP) is a phase 2 question for the owner, and now the recommendation: Supabase's session can be read by scripts, and only a nonce-based CSP stops an injected one ([ADR-004](ADR-004-supabase-auth.md)).

## Alternatives considered

| Option | Why not |
|---|---|
| Hosting model (b): Vercel for the web app, a public backend elsewhere | Needs an origin secret stored in Vercel (an exception to `AGENTS.md`), an opt-out of Vercel's rewrite caching (`x-vercel-enable-rewrite-caching: 0`) and a public backend. Possible, but more to get right; the owner can still choose it |
| Hono's typed client (`hc<AppType>`) | The web app would type-check backend source, response types wouldn't be checked against schemas, and a check on one commit doesn't catch deploy skew |
| OpenAPI generated from the backend, with a generated client | Right for a Python or Go backend; the fallback here (`@hono/zod-openapi`) if a client outside TypeScript appears |
| tRPC | No plain HTTP contract; ties the API to TypeScript callers |
| A cross-origin `api.` subdomain with CORS | CORS preflights and a public backend for nothing |
| Server-sent events for progress | Buffering and the 30-second idle timeout need workarounds; polling is enough |

## Consequences
- **The contract helpers** are about 100 lines each on the backend and the web side; ts-rest, which did the same, is archived.
- **No CORS, a backend that reads no cookies,** and a backend that can't be called from the internet except through the rewrite.
- **The walking skeleton's acceptance tests** on the chosen host (listed in [`sdlc.md`](../sdlc.md#phase-3-build-in-slices)) check the bearer header, Supabase's session refresh, caching, upload limits and timeouts this design relies on. A failure reopens this ADR at the start of phase 3, while the cost is one module.

## Doubts raised
Single-model reviews; the owner chose to skip a cross-model second opinion.
- **Cycle 1:**
  - "The rewrite facts came from `next start` while the default host was Vercel": valid. The hosting model is decided now.
  - "No trustworthy client address": valid. Per-client limits left v1 ([ADR-004](ADR-004-supabase-auth.md)).
  - "Nothing kept replies out of shared caches": valid. `no-store` and `Vary`, tested.
  - "The built-in rewrite destination could split traffic": valid. Per-environment builds and a start check.
  - "Draft PDFs had no process; a GET would finalize": valid. On-demand previews; freezing through Mark applied.
  - "The advisory count was wrong": valid. Corrected, with a guard.
  - "Hono RPC couples the apps and misses deploy skew": valid. The contract table.
  - "Task state lived in three places": valid. The subject's row only.
  - "tRPC needs TanStack Query": a wrong claim, corrected; it doesn't change the decision.
- **Cycle 2:**
  - "The phase 2 spike ran on throwaway code": valid. The checks became the walking skeleton's acceptance criteria.
  - "The Route Handler guard covered only `app/api`": valid. It now covers any `route.ts` or `route.js`.
  - "A download that stores bytes can't be a GET": valid. It's a `POST`.
  - "`contract.json` churns before release": valid. It starts in the release phase.

- **Phase 2 spec review, 2026-11-13:**
  - "A web image with build-time values can't be the one CI tested": valid. The rewrite targets the same Compose name everywhere, and Supabase's values are read at run time.
  - "The sign-in pages lost the CSP": valid. One matcher covers every page.

## Revisit when
- A walking-skeleton acceptance test fails on the chosen host.
- A client outside TypeScript appears: generate OpenAPI from the table.
- Streamed text in the UI becomes a requirement.
