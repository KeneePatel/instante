# Constraints

**Status: accepted by the owner on 2026-11-13 at the phase 2 interview, which kept every default (Q1 to Q4 in [`docs/sdlc.md`](docs/sdlc.md#phase-2-foundations)).** There's no code yet, so nothing here runs. In phase 3 every row gets its tool, installed and run on the first commit that has code. Until then this file states the bar. Anyone may tighten it; loosening it needs the owner.

## Floor (always enforced, from the first commit with code)

- **No new suppression comments:** `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error` without a reason, `eslint-disable` in any form, ESLint inline configuration comments, `istanbul ignore`, `c8 ignore` and `v8 ignore` in any form, `nosemgrep`, `gitleaks:allow`. ESLint runs with `linterOptions.noInlineConfig` and `reportUnusedDisableDirectives`.
- **No unfinished work:** stubs that throw "not implemented", empty `catch {}` blocks, `TODO` standing where the implementation should be.
- **No skipped tests:** no skipped, `.only` or deleted tests without a reason in the commit message.
- **No secrets and no real people's data:** no secrets in source. No real person's data in fixtures, tests, screenshots or docs: use the Jordan Rivera persona and anonymized postings.
- **In the web app, without an ADR,** none of these ([ADR-005](docs/decisions/ADR-005-same-origin-rewrite-and-typed-contract.md)), matched with single or double quotes:
  - `'use server'`, `'use cache'` or `force-cache`;
  - any `route.ts` or `route.js` under `apps/web/app`;
  - `dangerouslySetInnerHTML` or `rehype-raw`;
  - `partialPrefetching` turned off while `cacheComponents` is on.
- **Models:** no model id other than `claude-sonnet-5-5`, `claude-haiku-5-5` or `claude-sonnet-5` in `apps/*/src`, `packages/*/src` or configuration; Opus is never used ([ADR-010](docs/decisions/ADR-010-claude-models-are-configuration.md)). One named fixture under `apps/backend/test/` may hold a refused id, for the test that proves the start-up check works.
- **Auth:** the backend never reads a cookie, and in the web app only the typed fetch helper calls `getSession()` ([ADR-004](docs/decisions/ADR-004-supabase-auth.md)).
- **This bar isn't weakened to make a change pass.** Weakening includes editing this file, the coverage exclude list, the `diff-cover` threshold, `tsconfig` strictness flags, ESLint rule severities, or the migration runner's checks.

A floor guard, adapted from the constraint-driven-development skill's reference and scoped to the diff, checks all of this.

## Enforced with numbers (planned)

| Dimension | Rule | Checked by | Runs at |
|---|---|---|---|
| Lint and format (fast) | Zero errors and diffs on changed files | untyped ESLint and Prettier on the changed files | every edit (`check:fast`, under 5 s) |
| Secrets | No findings, values never printed | `gitleaks git --redact` | every edit, CI |
| Types | Zero type errors across the workspace | each package's `typecheck` (`tsc --noEmit -p .`) | task end (`check:task`), CI |
| Lint (typed) | Zero errors from typescript-eslint `strictTypeChecked`, including `no-floating-promises` and the module-direction rules | ESLint | task end, CI |
| Tests | All pass, reaching only localhost | Vitest (unit, and integration on real Postgres 18) | task end, CI |
| Coverage | Changed lines ≥ 80% covered in `apps/backend/src`, `packages/contract/src` and `apps/web/lib`; pages and components are covered by the end-to-end and axe rows instead. This scope is fixed now and changing it counts as weakening | `@vitest/coverage-v8` LCov + `diff-cover --fail-under=80` | task end, CI |
| Contract | Every route's reply parses against its response schema; the web app type-checks against the table; from the release phase, `contract.json` is current | route tests, `tsc`, snapshot diff | CI |
| Isolation | Generated from the contract's route table, failing on any route without an entry or a `public` marker. B gets 404 on A's path ids; B's requests with A's ids in the body are refused with no side effect; A's private rows never appear in B's lists or search; B's queue jobs against A's objects do nothing | isolation matrix (cases the owner specifies) | CI |
| Unauthenticated access | Every non-public route returns 401, including encoded-path and trailing-slash variants, and a request with a valid Supabase cookie but no bearer header | unauthenticated matrix from the route table | CI |
| Tokens | Wrong algorithm (`HS256`, `none`), issuer or audience, expired, anonymous, `aal1` or unknown-key tokens are refused; an unknown user id gives `403 unknown_account` even when the email matches; a disabled account gives `403`; cached keys verify while the key endpoint is down | token tests | CI |
| Caching | Every `/api` reply sends `Cache-Control: private, no-store` and `Vary: Authorization` | route tests | CI |
| Prompt privacy, both directions | No contact value, status statement or home city from a fixture master reaches any prompt, even inside bullets and custom sections. The status patterns are checked against a corpus of real phrasings, such as "Requires sponsorship", "PGWP" and "Indian citizen". Listed evidence (such as "Visa payments", "sponsorship outreach", a home-city university's degree, "ASP.NET") survives into the AI view. The one exception is the whole-file PDF import the owner chose (option A), and only `importResume` may send a file | AI-view and prompt-privacy tests | CI |
| Document service | Its environment holds no secret or database URL; its children can't reach the network, write, start a process or read the secrets folder; no Instante process opens an inspector on `SIGUSR1` | `selftest` and its positive control on the production build | CI: `selftest` on Linux; it and the `SIGUSR1` check in the macOS job |
| Placeholders | No stored or frozen PDF contains a placeholder token; a line with a leftover, unknown or duplicated placeholder fails the verifier | verifier tests, end-to-end check | CI |
| Logs | A forced failure on a resume write and on a job leaves nothing personal in logs or pg-boss rows; a request carrying a bearer token and a Supabase cookie leaves neither in logs or error reports | sanitizer test | CI |
| End to end | The flows in `docs/architecture.md` pass | Playwright on Chromium, fake-AI mode | CI |
| Accessibility | Zero critical or serious findings | axe through Playwright, every page | CI |
| Production build | It starts and `/readyz` answers; `src/` imports nothing from `test/`; with `INSTANTE_ENV=production`, the fake's address, a TCP database URL or a non-loopback listen address stops it; the reserved ports are refused outside real use; the web app's launch flags deny reading a secret | production-build test | CI |
| Local stack | `instante setup`, `release`, `start`, `backup` and `restore` work end to end in a scratch home whose path contains a space; the real-use cluster has no TCP listener and refuses a connection without a password; every listener is on loopback; secret files are `0600` in a `0700` folder; `release` refuses anything but a full id that `main` contains with its own CI jobs passed; `rollback` restores the pre-release dump; a second copy is refused; the default home is refused under any spelling | the macOS job | CI |
| Request checks | A foreign `Host` gets `421` on pages, prefetches, `/api` and the backend; `Sec-Fetch-Site: cross-site` or `same-site` gets `403`, except page navigations | route and end-to-end tests | CI |
| Agent settings | No committed `.claude/` settings file has a `sandbox` key, an `allowRead`, or a rule naming `~/.instante` that isn't a deny | a check in CI | CI |
| Shell scripts | No findings | ShellCheck over `scripts/` | CI |
| Dependencies | Nothing at high or above | `osv-scanner scan source -r .` | CI, weekly |
| Code security | No new ERROR findings | `semgrep scan --config p/default --baseline-commit <base> --error --metrics=off` | CI |
| Commits | Authored and committed as the owner, no AI trailers | `scripts/check-commits.sh` | before push, CI |
| AI evals | Recorded replies replay on every run; a public repository replays synthetic fixtures only and keeps the real eval set outside it. The release gates in `docs/product.md` are checked on the held-out set before release (phase 4) | replay test; live eval from `evals/` | CI (replay), each slice and after prompt or model changes (live) |

Three external opinions keep the bar honest, because the agent can't argue with them: osv-scanner reads a vulnerability database, axe encodes WCAG, and gitleaks matches known secret shapes. Everything else is judged by this project's own code and tests, and the owner specifies the isolation and prompt-privacy cases rather than the agent alone.

**Mode:** the floor blocks from the first commit with code. A new numbered row warns for its first two weeks, then blocks.

## Measured, not yet enforced

| Metric | Today | Direction |
|---|---|---|
| Project coverage | no code yet | must not fall (0.5% tolerance) once measured |
| p95 API read latency | not measured | aim under 300 ms |
| LCP and CLS for real use | not measured | aim LCP ≤ 2.5 s, CLS ≤ 0.1 |
| AI cost per active person per month | not measured | within the owner's budget |
| "Not screened" rate | not measured | down |
| CI minutes per month | not measured | within the free allowance |

## Exceptions

An exception needs a row approved by the owner, with an expiry of at most 90 days.

| ID | Rule | Path | Reason | Owner | Expires |
|---|---|---|---|---|---|
| — | — | — | None | — | — |
