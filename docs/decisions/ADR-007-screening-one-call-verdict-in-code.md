# ADR-007: Screening: free filters, then one AI call per person and posting; the verdict in code

## Status
Accepted 2026-11-13 at the phase 1 gate. Proposed 2026-11-12 and revised after three adversarial review cycles the same day: the shared-extraction design was replaced in cycle 1. At the phase 2 gate the owner accepted the list-requirement rule as written (rule 6) and all five eligibility rules, each off until turned on; the screening model is chosen in the `screening` slice, from its eval.

## Date
2026-11-12

## Context
- The owner's standing screening rules:
  - evidence-based and lenient;
  - the screener never sees contact details, work authorization or home location;
  - work-authorization, location, availability and "willingness to learn" requirements count as met (shown, never counted);
  - soft skills are never judged;
  - partial counts half;
  - Yes at 75%, Maybe at 50%;
  - person-specific facts are settings;
  - causes are proven by experiment.
- One call per person and posting that lists the requirements and judges each against the resume, with code computing the verdict, worked in daily use in an earlier prototype ([screening note](../research/screening.md)). Instante writes its own prompt, schema and verdict code.
- The first proposal shared extraction across people. It loses the posting's context in matching, spreads one bad extraction to everyone, and saves money only from about 2 people per posting. For the same reason, no person's screening may change what others see.

## Decision
1. **Free filters in code, before any call:** places, work type, roles and titles, level from the title, posting age, keywords, hidden companies. An unknown value passes, except an unclear location, which passes only when the person includes those. The first failing rule is stored as `filtered` with its reason.
2. **One structured-output call per person and posting,** with the posting and the AI view of the master ([ADR-008](ADR-008-master-resume-document.md)). It returns:
   - **requirements:** each with a kind (must, nice) and a category. The countable categories are skill, experience, education, certification and language (spoken). The conditions, never counted, are authorization, location, availability, enrolment, clearance and soft;
   - **facts, each with the words from the posting that support it:**
     - whether the posting names a level;
     - the minimum years among must-haves (taking the lowest alternative);
     - whether current enrolment is required (yes, no, unclear);
     - the remote region;
     - sponsorship (offered, not offered, unstated);
     - whether a security clearance is required (yes, no, unstated);
     - whether French is required (yes, no, unstated);
   - **matches:** for each countable requirement, met, partly met or not met, with the master's permanent ids for the lines that show it. A posting can't guess those ids.
3. **Code checks:**
   - **Size:** a reply over the size limits ([limits table](../architecture.md#limits-and-windows)) is rejected and retried once, asking it to merge requirements. If it's still over, the must-haves are kept first, the rest are shown as "not assessed" and left out of the count, and the job is flagged.
   - **Grounding:** a requirement whose content words aren't in the posting is dropped and flagged. A fact whose supporting words aren't in the posting is treated as unstated. The job title alone is never a requirement.
   - **Evidence:** a met or partly met citing no valid id gets one retry, then counts as not met, flagged. Evidence citing only Familiar skills counts as partly met at most.
   - **Languages:** code can upgrade a spoken-language requirement to met from the master's languages. A basic level doesn't count, and "bilingual" or "French and English" is left to the model when French isn't listed.
4. **After the call, for this person only.** Nothing here changes the shared job or what anyone else sees.
   - **Remote region:** a grounded remote region that excludes Canada files the job as `filtered` ("Remote, limited to the US"), with Bring back.
   - **Facts filters:** minimum must-have years above the person's limit; a level the posting names and the person turned off; current enrolment required while the person turned on "graduated".
   - **The eligibility rules the person opted into**, all off by default. They run after the call, so each costs one call:

     | Rule | Effect |
     |---|---|
     | Needs sponsorship | A No when the posting doesn't offer it |
     | No security clearance | A No when one is required |
     | Doesn't work in French | A No when French is required |
     | Graduated, not enrolled | Filtered when current enrolment is required |
     | Most years a posting may ask for | Filtered when the must-have minimum is higher |

5. **The verdict, in code:**

   | Step | Rule |
   |---|---|
   | Points | met = 2 half-points, partly met = 1, not met = 0; compared in integers |
   | Basis | the countable must-haves; if none, the countable nice-to-haves; if neither, **Maybe** (rule `no_countable_requirements`) |
   | Share | points ÷ (2 × assessed requirements in the basis). A requirement missing its evidence counts as not met, never left out; only "not assessed" requirements are outside the count |
   | Verdict | **Yes** if share ≥ `yes_at` (0.75); **Maybe** if ≥ `maybe_at` (0.50); else **No**. Settings require 0 < `maybe_at` ≤ `yes_at` ≤ 1 |
   | Conditions | listed, never counted |
   | Label | "N of M must-haves shown", or "nice-to-haves" when those were the basis |
   | Rank | within a verdict, share, then place priority, then newest |

6. **List requirements**, confirmed by the owner at the phase 2 gate: a list in one sentence ("Go, PostgreSQL and Kafka") stays one requirement. It's met when every item is shown (or any one, for "one of"), partly met when some are, and not met when none are.
7. **When it runs:**
   - **Scheduled:** `screen:user` runs per person, coalesced as the limits table says.
   - **Interactive:** `screen:job` handles a pasted posting or a single re-screen in the interactive lane.
   - **Changed postings:** a changed posting (by its normalized hash) is screened again for people who haven't acted on it.
   - **After a resume change** (the AI view's hash changes): the person's open No and Maybe rows, saved ones included, become stale. Yes rows become stale only when a line they cite was removed or changed (compared after normalizing whitespace, punctuation and case). Stale rows are re-screened when the person presses "Re-screen N jobs", or automatically after 6 hours without a save, at most once a day. New postings go first.
   - **Daily limit:** everything above counts against the person's daily screening limit.
   - **Version changes:** a prompt or model change bumps the version, and `screen rescreen --since-version <v> --estimate` shows the cost before anything runs.
8. **States and lanes:**
   - A screening row is `queued`, `running`, `judged`, `filtered`, `paused`, `failed` (with an error code), or `not screened`, which means a refusal only. The inbox shows how many are waiting.
   - Scheduled runs: oldest waiting first, then newest posted, round-robin in chunks of 10. A new person's first 20 go first, through `POST me/onboarding/finish`.
   - Refusals are handled as [ADR-010](ADR-010-claude-models-are-configuration.md) says, and pauses never fail a posting.
9. **Provenance and overrides:** every verdict records the requested and serving model, prompt version, effort, inference location, the AI view's hash, the settings hash and the rules version. The person's own verdict always wins.
10. **Proving causes:** "Report this verdict" keeps, for 90 days, the posting text, the analysis and the exact AI view sent.
    - `verdict list` and `verdict show <report>` are read-only.
    - `verdict replay <report>` runs the owner's experiments (rerun, another model, a line removed) with the eval workspace's key and budget, and prints verdicts and differences only.

## Alternatives considered

| Option | Why not, for v1 |
|---|---|
| Shared extraction once per posting, then a per-person match | Matching loses the posting's context; one extraction error reaches everyone; cheaper only above about 2 people per posting. Later, after an eval comparison and a measured overlap |
| One person's finding updates the shared job (for example, marking US-only remote jobs as elsewhere for everyone) | Brings back the shared-error problem for one field, and hides jobs with no Bring back |
| Eligibility rules as free filters | They need facts only the call can read |
| The model gives the verdict | Opaque; the rules would live in a prompt; settings changes would cost calls |
| Code-only matching against skill names; embeddings as the verdict | Can't judge degrees or experience; can't show evidence |
| Salary and posting-language filters | Later, when people ask |
| The Batch API now | Later, when spend passes the owner's threshold |

## Consequences
- **Cost:** with caching and typical tokens, about $0.006 to $0.011 a posting on Sonnet 5.5 and $0.0003 to $0.0006 on Haiku 5.5, from no thinking tokens to 500. At 50 postings a day that's $9 to $17 a month on Sonnet ([ADR-010](ADR-010-claude-models-are-configuration.md)). Nothing is shared between people, so the daily limit and the monthly budget bound it.
- **Settings changes** recompute existing verdicts with no calls; a widened search brings postings that do need calls.
- **Every verdict** is explainable from stored evidence and recomputable from the stored analysis. Fully replayable verdicts are the reported ones, which is a deliberate privacy trade-off.
- **The eval**, in the `screening` slice:
  - 50 anonymized postings (company and people's names replaced) × 3 synthetic Jordan Rivera personas = 150 pairs;
  - long stack lines, certification and clearance postings, sponsorship wording and "if you are an AI" postings included;
  - prompts are tuned on 100 pairs; 50 are held out for the release gate, about 25 Yes or Maybe and 25 No;
  - the gate counts errors on the held-out pairs: at most 1 false No and at most 3 false Yes. Counts this small can catch a bad screener but can't prove a 5% rate, and [`product.md`](../product.md#success-criteria-for-v1) says so;
  - rates with intervals over all 150 pairs are tracked;
  - the model configuration is chosen on the 100 tuning pairs, comparing Haiku 5.5 and Sonnet 5.5 pair by pair; only the chosen configuration then runs, once, on the held-out pairs ([ADR-010](ADR-010-claude-models-are-configuration.md)).

## Doubts raised
Single-model reviews; the owner chose to skip a cross-model second opinion.
- **Cycle 1:**
  - "An unevidenced partly met still earned half a point" (blocker): valid. One retry, then not met, flagged.
  - "Nothing kept work-status lines from the model" (blocker): valid. The AI view.
  - "The split judged requirements out of context": valid. The single call.
  - "The verdict's edge cases were undefined": valid. The table.
  - "A long stack line swamps the degree": valid. The list rule.
  - "Second filters stricter than the verdict": valid. Minimum must-have years, levels only when named, three-way enrolment.
  - "Two sources of languages": valid. One source.
  - "The digest left out certifications": valid. Included.
  - "Length limits unenforceable": valid. Reject and retry.
  - "Cross-user poisoning": valid. No shared extraction, unguessable ids.
  - "The eval was one-sided": valid. Redefined.
  - "Costs without thinking tokens": valid. Ranges.
  - "Four of the owner's earlier rules dropped silently": valid. Opt-in settings.
- **Cycle 2:**
  - "The re-screen 'daily batch' was undefined": valid. Rule 7.
  - "'Not assessed' contradicted 'never left out'": valid. Defined.
  - "US-only remote jobs screened per person": valid at first fixed with a shared move, which cycle 3 reversed.
  - "Same pairs tune and gate": valid. A held-out set.
  - "`verdict replay` isn't read-only": valid. Split.
  - "Pasted postings waited behind the coalesced run": valid. `screen:job`.
  - "Eligibility rules listed differently in three places": valid. One list.
- **Cycle 3:**
  - "One person's screening could remove a job for everyone": valid. The remote-region finding now filters for that person only, with Bring back.
  - "Eligibility rules needed facts the call never returned, and ran both before and after it": valid. The sponsorship, clearance and French facts are grounded by quotes, the rules run after the call, and clearance is a condition.
  - "Adding evidence never triggered a re-screen": valid. Any change to the AI view makes No and Maybe rows stale.
  - "The held-out arithmetic was wrong": valid. Corrected to counts, with the precision stated.
  - "Screening states had no home": valid. Rule 8.

## Revisit when
- People measurably share screened postings (at least 2 per posting) and spend passes the owner's threshold: shared extraction, after the eval comparison.
- Spend passes the owner's threshold: the Batch API for scheduled runs.
- Postings regularly wait behind the daily limit: an embedding pre-ranker.
- People ask: salary and language filters.
