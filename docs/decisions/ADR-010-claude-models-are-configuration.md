# ADR-010: Claude through one AI module; Sonnet 5.5 or Haiku 5.5 per task, chosen by eval; spend is checked, recorded and paused

## Status
Accepted 2026-11-13. At the phase 1 gate the owner:
- approved Anthropic as the processor and global inference;
- asked for a generous monthly budget and set the daily screening limit at 1,000 postings a person;
- approved one retry on Sonnet;
- ruled out Opus: Sonnet first, Haiku where it holds up, each task's configuration chosen for the best cost against quality.

## Date
2026-11-12, revised 2026-11-13

## Context
- Three AI tasks: screening a posting, importing a resume and tailoring a resume.
- Every reliability rule belongs in one place: check every reply, version prompts, budget calls, and log calls without their text.
- Prices per million input/output tokens (the `claude-api` reference, 2026-11-03; re-read from the pricing page in each slice):
  - `claude-sonnet-5-5`: $2/$10, cache reads $0.10;
  - `claude-haiku-5-5`: $0.10/$0.50 for prompts up to 100K tokens ($0.50/$2.50 beyond), cache reads $0.01.

  The Batch API halves both.
- **Thinking and effort:**
  - Sonnet 5.5 runs adaptive thinking by default at effort `high`, with recalibrated levels. `thinking: {type: "between_tools"}` turns thinking off at effort `high` or below.
  - Haiku 5.5 runs adaptive thinking by default at effort `medium`, and can turn it off at `high` or below.
- **Refusals** ([refusals and fallback](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback)):
  - Sonnet 5.5 has a server-side fallback, a beta parameter, so calls use `client.beta.messages.parse`.
  - Its `"default"` form retries only `cyber` and `frontier_llm` declines. The list form names models from the requested model's `allowed_fallback_models`, which `/v1/models` publishes at runtime.
  - Under `server-side-fallback-2026-07-01`, a `between_tools` request that falls back runs on Sonnet 5 with thinking disabled.
  - Haiku 5.5 has none: a fallback list on a Haiku request is a `400`.
  - Batch items can't carry a fallback.
  - `usage.iterations` is the per-attempt billing record.

Estimated costs, with caching, at typical token counts ([screening note](../research/screening.md), [resume note](../research/resume.md)). Each range runs from no thinking tokens to 500 per call.

| | Sonnet 5.5 | Haiku 5.5 |
|---|---|---|
| Screening one posting | $0.006–0.011 | $0.0003–0.0006 |
| 50 postings a day for a month | $9–17 | $0.50–0.85 |
| 1,000 postings a day (the limit) for a month | $185–335 | $10–17 |
| One resume import | ~$0.10 | ~$0.005 |
| One tailored resume | ~$0.06 and up | ~$0.003 and up |

These are estimates, and probably low: they assume about 375 output tokens a posting, while the schema allows up to 30 requirements with quotes and cited ids, and adaptive thinking at `medium` thinks before almost every reply. The `ai` slice measures 10 fixture postings with `count_tokens` and one live call per configuration, then restates the numbers here.

## Decision
- **One `ai` module:**
  - typed tasks over the official SDK (`client.beta.messages.parse` with the Zod schema as the output format), each with an output schema, a prompt version and its own code checks;
  - one retry, on the same model, when a reply passes the schema but fails a check;
  - nothing else in the codebase calls the API.
- **Models:** only `claude-sonnet-5-5` and `claude-haiku-5-5`, plus `claude-sonnet-5` as Sonnet's server-side refusal fallback. Never Opus.
  - Configuration naming any other model fails at start, and a test checks it.
  - At start, the module also checks that `claude-sonnet-5` is in Sonnet 5.5's `allowed_fallback_models`; if not, it refuses to start rather than fall back to a model we didn't name.
- **The six configurations, exactly:**

  | | Thinking off | Adaptive `low` | Adaptive `medium` |
  |---|---|---|---|
  | Haiku 5.5 | `thinking: {type: "disabled"}`, effort `low` | `{type: "adaptive"}`, effort `low` | `{type: "adaptive"}`, effort `medium` |
  | Sonnet 5.5 | `thinking: {type: "between_tools"}`, effort `low` | `{type: "adaptive"}`, effort `low` | `{type: "adaptive"}`, effort `medium` |

  Sonnet requests carry `fallbacks: [{"model": "claude-sonnet-5"}]` under the `server-side-fallback-2026-07-01` header; Haiku requests carry none. Output schemas have no free-text "reasoning" field, which invites `reasoning_extraction` declines.
- **Until a task's eval has run:** Sonnet 5.5 at effort `medium`, with adaptive thinking.
- **Choosing each task's configuration** in its own slice: import in `master-resume`, screening in `screening`, tailoring in `tailoring`.
  - **What's compared:** the eval runs Haiku 5.5 and Sonnet 5.5, each with thinking off, adaptive at `low`, and adaptive at `medium`. That's six configurations, each run with its refusal path (Sonnet's fallback, Haiku's retry on Sonnet).
  - **Where the choice is made:** on the tuning pairs only, comparing configurations pair by pair (false Nos, false Yeses, and disagreements with Sonnet's best, with intervals).
  - **What wins:** the configuration with the lowest cost per completed task, counting retries and fallbacks, among those that meet the targets on the tuning pairs and aren't measurably worse than Sonnet's best on false Nos. Haiku wins when it qualifies.
  - **The held-out check:** only the chosen configuration then runs, once, on the held-out pairs. If it fails there, work goes back to the prompt and the tuning pairs; the next configuration doesn't get a try at the same held-out set.
  - **If none qualifies:** the prompt is revisited and the grid runs again. Nothing ships that the eval didn't run, and Opus isn't an option.
  - **Where it's recorded:** the choice and its numbers go into the slice's spec, and the owner sees them at the checkpoint demo.
- **Re-checking a choice:** the eval runs again when a new Sonnet or Haiku arrives or prices change, or when monthly spend passes half the budget two months running.
- **Inference location:** global, the default; no location is sent. Each call records where inference ran.
- **Refusals and failures:**
  - Sonnet 5.5 calls carry the server-side fallback in its list form, naming only `claude-sonnet-5`, so no model we didn't choose can serve a request. Which refusal categories it rescues is measured in each eval.
  - On Haiku 5.5, a refusal, or a reply that still fails its checks after the retry, is tried once more with the task's best Sonnet configuration from its eval, fallback included, at Sonnet's price.
  - What's still refused after that shows as "Not screened".
  - The serving model is recorded on each result, fallbacks are part of each eval, and `ai report` shows refusals by category.
- **Spend:**
  - **Limits per person** ([limits table](../architecture.md#limits-and-windows)): 1,000 screening postings, 5 imports, and 20 tailored builds and regenerations a day.
  - **The monthly budget:** $100 to start. It's configuration, and the owner changes it at will.
  - **Before every call,** `AiLedger.check` refuses it if the limit for that kind of work is used up or an AI pause is active.
  - **After every call,** `record` writes one ledger row per attempt (from `usage.iterations`), priced at the serving model's rate. With at most 4 calls in flight, the overshoot is under a dollar, and there are no reservations to expire.
  - **Budget pauses:** at 90% of the monthly budget, scheduled screening pauses (reason "90% budget"); at 100%, all AI work pauses (reason "budget used").
  - **Anthropic's spend-limit responses** (`429 enforced_spend_limit_reached`, or the workspace limit's `400`) also pause everything and alert the owner, with the SDK's retries off for those errors.
  - **Pause and resume are queue operations:** a handler that meets a pause sets its subject to `paused` and completes its job, so nothing retries or fails. `ai resume` re-enqueues every paused subject in one transaction, and so does the month rollover for budget pauses.
  - **Backstop:** the production Console limit sits just above the budget.
  - **Workspaces:** dev, eval and production each have a key and a spend limit, and the limits add up to less than the organization's monthly cap. Live evals and `verdict replay` use the eval workspace.
- **Data sent:** exactly the per-task list in [`architecture.md`](../architecture.md#what-reaches-the-model). Opaque ids go in `metadata.user_id`. Anthropic keeps inputs and outputs for 30 days by default, longer for flagged content.

## Alternatives considered

| Option | Why not |
|---|---|
| Opus 5.5 | Ruled out by the owner |
| Haiku for every task from the start | Untested on these tasks. Sonnet runs until each eval shows whether Haiku holds up |
| The server-side fallback's `"default"` form | Retries only two refusal categories, on a model Anthropic picks; the list form names the model ourselves |
| A provider-neutral layer | A hosted service with one paid provider gains nothing and loses SDK features. Swapping providers later is one module |
| Reserving spend before each call | Guards under a dollar of overshoot and needs expiry and reconciliation. The check, per-attempt rows and the Console limit are enough |
| Local models | No GPU host in the budget |
| Zero data retention | Needs a sales arrangement and doesn't cover the Batch API |

## Consequences
- **At the daily limit on Sonnet,** one person could spend $6 to $11 a day, and the $100 budget would pause scheduled screening after 8 to 15 days. That's the intended order: the daily limit caps volume, and the budget caps money.
- **Expected use,** tens of new postings a day after the first run over the pool, is about $10 to $20 a month on Sonnet and under $1 on Haiku.
- **One module** makes the Batch API, a different model or another provider a contained change.
- **Resume text leaves Canada** for the AI call.

## Doubts raised
Single-model reviews in phase 1; the owner chose to skip a cross-model second opinion.
- **Cycle 1:**
  - "Costs assumed no thinking tokens; effort was chosen silently": valid. Ranges, and effort is configuration.
  - "The model decision waited on an eval phase 2 couldn't run": valid. In cycle 2 each decision moved into its slice.
  - "The ledger undercounts fallbacks": valid. Per-attempt rows.
  - "The hard stop was undefined; workspace limits ignore the organization cap": valid. Defined, with limits that sum below the cap.
  - "Inference location misdescribed; model choice affects retention": valid. Stated, and since decided: global.
  - "No fallback on Haiku": valid. A retry on Sonnet, now approved.
- **Cycle 2:**
  - "Reservations never expire and the pause had no way to end": valid. Reservations removed, and the pause is an explicit state with `ai resume` and a month rollover.
  - "The Haiku fallback model, price and retention weren't named": valid. Sonnet 5.5.
  - "Phase 2 decided models from an eval that only covered screening and needed phase 3 code": valid. Each task decides in its own slice.
- **Cycle 3:**
  - "The daily limit and the budget stop contradicted the lanes; paused work never restarted; interactive work was uncapped": valid. Limits for each kind of work, a 100% pause, and pause and resume as queue operations.
- **Owner's decisions, 2026-11-13:**
  - The starting model moved from Opus 5.5 to Sonnet 5.5.
  - The comparison grid became Haiku against Sonnet.
  - The server-side fallback uses its list form, so Opus can't serve.
  - The daily screening limit went from 100 to 1,000.
- **Fresh-context review, 2026-11-13:**
  - "Choosing the cheapest configuration that passes the small held-out set favours a worse Haiku and uses up the held-out set": valid. The choice is made on the tuning pairs, pair by pair, and only the chosen configuration meets the held-out set, once.
  - "The thinking-off cells had no effort; the fallback header, Haiku's no-fallback rule and the retry's configuration were unstated; `fallbacks` needs the beta endpoint": valid, each checked in Anthropic's documentation. The six cells are written out, the header is pinned, Haiku requests carry no fallback, the retry uses the task's best Sonnet configuration, and calls use `client.beta.messages.parse`. The review's claim that the list may name only `claude-sonnet-5` isn't in the documentation; the list comes from `allowed_fallback_models`, checked at start.
  - "The floor rule on model ids blocks the test that proves the rule": valid. One named fixture under `test/` is allowed.
  - "Cost estimates are probably low": valid. Marked as such, and the `ai` slice measures and restates them.

## Revisit when
A slice's eval reports its results, a new Sonnet or Haiku arrives, monthly spend passes half the budget two months running, someone requires zero retention, or Anthropic's prices change.
