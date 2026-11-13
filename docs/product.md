# What Instante does

Instante is a personal web app for a job search. It keeps a pool of full job postings from companies' own job boards, says which ones fit you and shows why, and writes a one-page resume for a job you pick, using only what your master resume already says. You decide what to apply to; Instante never applies for you.

**Status:**
- Proposed in phase 1 on 2026-11-12, and revised three times the same day after adversarial reviews.
- The owner answered the gate questions and signed off phase 1 on 2026-11-13. This document reflects those answers ([below](#the-owners-decisions-at-the-phase-1-gate)).
- Nothing is built yet.

Where to look:
- [`architecture.md`](architecture.md) says how it will be built. Its [limits table](architecture.md#limits-and-windows) is the one place numbers like caps and windows are kept, and the numbers below are initial values copied from it.
- [`decisions/`](decisions/) says why each choice was made.
- [`sdlc.md`](sdlc.md) says how we get there.
- Each choice rests on a note in [`research/`](research/).

## Who it's for

The owner. Instante is a personal project, not a product launch.
- Accounts and data are kept per person, so a friend could use it later. Nobody else does until the checklist in [Before anyone else uses it](#before-anyone-else-uses-it) is done.
- The sources are companies' public job boards, which lean towards tech.
- Anything person-specific is a setting, never code.

## The loop

1. **Find.** A worker refreshes a pool of full postings every few hours from a hand-curated catalog of companies' public job boards on Greenhouse, Ashby and Lever. For any other job, you paste the posting.
2. **Screen.** Free filters on your settings run first. Then an AI reads each remaining posting with your master resume and lists its requirements. For each one it says whether your resume shows it, citing the lines. Code, not the model, turns that into **Yes**, **Maybe** or **No**.
3. **Decide.** An inbox of screened jobs, best first. Save, Skip, Make a resume, Open the posting, Mark applied, or give your own verdict, which always wins.
4. **Make a resume.** A one-page resume for that job, written only from your master resume. Every line points to the bullets it came from, and code rejects anything it can't trace. You review it, then download the PDF.
5. **Track.** Marking a job applied records the exact PDF you downloaded and sent. The Applied list keeps the status you set and a note.

## Principles

- **Full postings only.** A 500-character snippet doesn't hold a posting's requirements, so it can't be screened ([job-collection note](research/job-collection.md)).
- **Evidence, not scores.** Every verdict shows each requirement next to the resume line that meets it. There's no keyword match percentage.
- **Code decides.** The AI extracts and matches; fixed rules compute the verdict. Recomputing existing verdicts after a settings change costs no AI calls. Postings that newly pass a widened search still need screening.
- **Evidence-based and lenient**, the owner's standing screening rules:
  - a requirement counts as met only with evidence from the resume;
  - work-authorization, location, availability and "willingness to learn" requirements count as met: they're shown, never counted;
  - soft skills are never judged;
  - a partial match counts half;
  - Yes at 75% of must-haves shown, Maybe at 50%; both are settings.
- **The screener never sees** your contact details, work authorization or home location. Code builds what the AI reads, and the master-resume page shows you anything it withheld and why.
- **Nothing invented.** A tailored resume selects, orders and rewords what the master resume says. It can't add an employer, title, date, number, skill, product or technology.
- **Causes are proven, not asserted.** When a verdict looks wrong, the fix comes after an experiment shows why: the model, the resume or the prompt.
- **You decide.** No auto-apply, no form filling, no browser extension.
- **Your data stays yours.** It lives in Instante's own database and reaches only the processors that [`architecture.md`](architecture.md#security-and-privacy) lists.
- **Small first.** v1 is one loop done well. Each addition waits for a trigger that can be measured ([`architecture.md`](architecture.md#later-and-what-triggers-it)).

## Modules (capability map)

Each module gets its own spec (`docs/specs/<id>.md`) just before it's built ([`sdlc.md`](sdlc.md)). The ids are fixed from here on.

| Id | Responsibility | Depends on |
|---|---|---|
| `platform` | Repo, CI, configuration, logging, the contract package, the document service, the web app's shell, the walking skeleton running on the owner's Mac | none |
| `accounts` | Sign-in through Supabase Auth with two factors, token verification, account rows, owner commands for people | `platform` |
| `settings` | Search preferences, eligibility rules you opt into, screening and resume options | `accounts` |
| `ai` | The one door to Claude: model and effort per task, structured outputs, refusals, the spend ledger, pauses | `platform` |
| `master-resume` | Contact details, import, editing, the AI view of the resume | `accounts`, `ai` |
| `job-pool` | The catalog, fetching, normalizing, places, closing, pasted postings, blocking a board | `platform` |
| `screening` | Filters, the per-person analysis call, verdict rules, runs and lanes, verdict reports | `settings`, `master-resume`, `job-pool`, `ai` |
| `inbox` | Job lists, the job page, decisions, your own verdict | `screening`, `job-pool` |
| `tailoring` | Building, checking and fitting a resume; rendering; the review screen; download and freezing | `master-resume`, `job-pool`, `screening`, `settings`, `ai` |
| `applications` | Mark applied, the Applied list | `inbox`, `tailoring` |

Build order:
1. `platform` → `accounts` → `settings` → `ai` and `job-pool` (independent) → `master-resume` → `screening` → `inbox`;
2. **the alpha:** the owner's real search on the real-use stack on the Mac, the first with data;
3. `tailoring` → `applications`.

## Flows in v1

### Account creation and sign-in

Sign-in is Supabase Auth ([ADR-004](decisions/ADR-004-supabase-auth.md)).
1. **Adding a person:** the owner creates the user in Supabase, where sign-ups are turned off, then adds the same user to Instante with a command. There's no public sign-up.
2. **The email code:** you enter your email, and Supabase emails you an 8-digit code. It works once, for 10 minutes.
3. **The authenticator:** the first time, you add Instante to an authenticator app by scanning a QR code. Each sign-in then asks for the app's code too, so a guessed or intercepted email code isn't enough.
4. **Staying signed in:** you stay signed in until you sign out, and the session renews itself while you use the app. "Sign out everywhere" ends every session.

There are no passwords to remember. Until Instante has a domain and its own mail settings, Supabase's built-in email reaches only the owner, which is all a personal project needs.

### Onboarding

1. **Contact details:** your name, email, phone, city and links. They're printed on resumes and never sent to the AI, except inside a whole-file import (below). Because Instante knows them first, it can redact them from text imports.
2. **Master resume:** import a file or paste text, or start from a blank form. Nothing is saved until you've reviewed the draft.
3. **Search:** the roles and titles you want, the levels (intern, junior, mid, senior and so on), the places (cities, provinces, remote), how recent a posting must be, and companies to hide.
4. **Eligibility rules**, all off by default and never sent to the AI:
   - you need sponsorship;
   - you hold no security clearance;
   - you don't work in French;
   - you've graduated and aren't enrolled;
   - the most years of experience a posting may ask for.

   Each rule you turn on filters a posting out or makes it a No, with the reason shown. The rules are checked after the AI has read the posting, so they don't save AI calls.
5. Instante shows how many open postings match your search before you finish. When the count is low, it says so: the catalog may not cover your field yet.
6. The first screening runs at once on your newest matching postings, and the inbox fills as results arrive.

### The master resume

- **What it holds:**
  - a summary, stored but not printed by the v1 template;
  - experience, where one employer can hold several positions, such as repeated co-op terms;
  - projects, education and certifications;
  - languages with their level;
  - skills, marked **Proven** or **Familiar**;
  - custom sections.

  Contact details are kept apart. Every entry, position, bullet and skill has a short permanent id, so a tailored line can say exactly where it came from.
- **Import:** a PDF or DOCX of at most 5 MB (4 pages for a PDF), or pasted text.
  - The AI drafts the entries. A PDF goes to Anthropic whole, once, with everything in it, which reads two-column layouts best. DOCX and pasted text go as text, with your contact details and status lines removed.
  - Code checks both ways: drafted lines it can't find in your file are flagged, and so are lines in your file that the draft left out.
  - Year-only dates, missing dates and inferred skills are flagged too.
  - Statements about work status, citizenship, date of birth, home address or a photo never go into the master. You can move them into settings or discard them.
  - The uploaded file is deleted when the import ends.
- **Editing:** a form per section with a **Save** button. Each save carries the version it started from, so two tabs can't overwrite each other silently.
- **Safety net:** importing over an existing master keeps one snapshot of the old one, which you can restore.
- **What the AI reads:**
  - an allowlisted view built by code: your summary, employers, positions, dates and bullets, projects, degrees and fields (without schools), certifications, languages, skills with levels, and custom sections;
  - no contact details, schools, entry locations or links;
  - your contact values, home city and any URL, email or phone inside a line are replaced by numbered placeholders, which tailored resumes turn back into the real text;
  - lines that state work status are withheld, wherever they sit. That covers phrasings like "Canadian citizen", "PGWP", "requires sponsorship" or "authorized to work in Canada", matched by tested patterns rather than single words.

  The page lists everything withheld or replaced, so you can rephrase it.

### Job collection

- **The catalog:** a hand-curated list of about 50 to 100 company boards on Greenhouse, Ashby and Lever, chosen for the owner's search. The agent proposes candidates in the `job-pool` slice and the owner approves the list. The owner adds more boards later with a command.
- **Pasted postings:** for any other job, including those on LinkedIn or Workday career sites, paste the title, company, link and text. A pasted posting is private to you, and Instante never fetches it.
- **Places:**
  - The pool keeps on-site and hybrid jobs in Canada, remote jobs open to Canada or worldwide, remote jobs whose region isn't stated, and jobs whose place can't be read. Jobs clearly elsewhere are dropped.
  - A Canadian city name such as "Toronto", or "Toronto, CA", counts as Canada unless it's a name shared with places abroad, such as London or Victoria.
  - Unclear places are labelled and shown only if you include them.
  - When the AI reads a remote posting and finds it's limited to another country, it's filtered out for you, with the reason and Bring back. Nobody else's view changes.
- **Freshness:**
  - A posting closes when two complete answers from its board in a row leave it out. A "not modified" answer repeats the last complete one.
  - If one answer would close more than half of a board's postings at once, Instante waits for the next read before closing any.
  - A board that answers "not found" three times in a row is marked gone, and its postings close.
  - Closed postings leave the pool at once.
- **What each job shows:** where it came from, when it was posted, the employer's Apply link, and the full posting text as safe Markdown, with no images or embedded content.
- **Blocking a board:** a blocked board is never read again, and its postings leave the pool.

### Screening

- **When it runs:**
  - after collection, at most every 3 hours per person, or sooner once 10 new postings are waiting;
  - at once for a pasted posting, a single re-screen, or the end of onboarding.
- **After your master resume changes:** your open No and Maybe jobs, saved ones included, are marked stale, and so are Yes jobs whose cited lines changed. They're screened again when you press "Re-screen N jobs", or automatically once your resume has been unchanged for 6 hours, at most once a day. New postings go first.
- **Filters first, in code, at no cost:**
  - places, work type, roles and titles, level;
  - posting age, keywords and hidden companies.

  An unknown value passes, except an unclear location (above). Postings that fail land under **Filtered out**, with the reason and a **Bring back** button.
- **One AI call per posting and person:** the posting and the AI view of your resume. It returns:
  - the posting's requirements, each must-have or nice-to-have, with a category;
  - a few facts, each with the posting's own words as support: the level named, the minimum years for must-haves, whether current enrolment is required, the remote region, whether sponsorship is offered, and whether a clearance or French is required;
  - for each skill, experience, education, certification and spoken-language requirement: **met**, **partly met** or **not met**, citing your resume's line ids.
- **Checks in code:**
  - a "met" or "partly met" with no valid evidence gets one retry, then counts as not met and is flagged;
  - evidence citing only Familiar skills counts as partly met at most;
  - a requirement whose words aren't in the posting is dropped and flagged;
  - the job title alone is never a requirement.
- **After the AI call, for you only:**
  - remote jobs limited to another country are filtered out;
  - so are postings asking for more years than your limit, a level you turned off, or current enrolment once you've graduated;
  - the eligibility rules you turned on (sponsorship, clearance, French, graduation, maximum years) give a No, with the posting's own words as the reason.
- **The verdict, in code** ([ADR-007](decisions/ADR-007-screening-one-call-verdict-in-code.md) has the full table):
  - met counts 1 and partly met ½, over the must-haves, or the nice-to-haves when there are none;
  - Yes at 75% or more, Maybe at 50% or more, otherwise No;
  - a posting with no countable requirement is a Maybe;
  - conditions are listed and never counted.
- **The model:** Sonnet 5.5 to start. Each task moves to Haiku 5.5 when its eval shows Haiku passes at lower cost. Opus is never used ([ADR-010](decisions/ADR-010-claude-models-are-configuration.md)).
- **Limits:**
  - up to 1,000 postings a day per person go to the screening AI, counting pasted postings and re-screens: the longest-waiting first, then the newest posted;
  - imports (5 a day) and resume builds (20 a day) have their own limits;
  - imports, resumes, pasted postings and single re-screens have their own lane and never wait behind scheduled screening;
  - a monthly AI budget, $100 to start, pauses scheduled screening at 90% and all AI work at 100%. Paused work waits and resumes; nothing is lost.
- **Refusals:** a posting the AI declines is tried once more on Sonnet when Haiku declined it. If it's still declined, it shows as **Not screened**, never as No.
- **Report this verdict:** Instante keeps a copy of exactly what the AI saw, for 90 days, so the owner can find the cause by experiment.

### Deciding (the inbox)

- **Lists:** To decide (Yes and Maybe, best first), No from the screener, Not screened (the AI declined), Saved, Skipped, Applied, and Filtered out. A count shows how many jobs are still waiting to be screened.
- **Verdicts:** every verdict shows its colour, icon and word together, and "N of M must-haves shown" (or nice-to-haves, when those were the basis).
- **The job page:** the verdict, each requirement beside the line from your resume that meets it, the conditions, any requirements left unassessed, the posting, and the actions.
- **Actions:** Save, Skip, Make resume, Open posting, Mark applied, your own verdict, and Paste a posting. Each can be undone.
- Jobs you saved, applied to or made a resume for stay visible to you even after they leave the pool.

### Making a resume

1. **Make resume** on a job starts a background build in the interactive lane. If the job hasn't been screened yet, the build analyses it first. That analysis isn't held back by the screening limit or the 90% pause; it counts towards your build limit and the budget.
2. One AI call picks and rewrites lines for this job. It sees:
   - the job's requirement list and facts (not the raw posting);
   - the AI view of your master resume;
   - your writing rules.

   Each line it returns cites the master-resume ids it came from. If the posting couldn't be analysed, you get a plain one-page version of your master instead, and the page says why.
3. Code checks every line:
   - employers, titles and dates are copied from the master, never written by the AI;
   - numbers, including words such as "doubled" or "hundreds", must appear in the cited lines;
   - names, products and technologies must appear in the cited lines;
   - skills come from the master only;
   - your "never claim" list blocks a line, and your "avoid" phrases are flagged.

   A line that fails falls back to its own source bullet if that passes the same checks; otherwise it's dropped and listed as "couldn't verify".
4. **Fitting:** Typst renders one ATS-friendly template, and code fits it to one page by measuring each line and dropping the lowest-value ones. It keeps the most recent role and two lines per role. If that still doesn't fit, it drops older roles, then projects. If even that fails, the build stops and says how many lines to remove.
5. **The review screen:**
   - each line with its source above it, and a badge when it was rewritten, dropped or flagged;
   - turn lines off, edit them, or regenerate the whole resume (which discards your edits, after asking);
   - a read-only list of the requirements the resume covers;
   - a PDF preview that refreshes once your changes settle.
6. **Download PDF** gives you the current version and keeps a copy of exactly what it gave you, every time. **Mark applied** asks which resume and which download you sent (the newest by default) and freezes that one; the others are deleted. Editing a frozen resume starts a new draft.

v1 has one template (Harvard-style, Letter size, written for Instante), PDF only, strict mode only, one page, and spelling as written in the master resume. Instante never claims a resume is "ATS-proof".

### Applied

A list of the jobs you applied to: company, role, applied date, status (Applied, Interviewing, Offer, Closed) set by you, a note, and the frozen resume you sent. An entry keeps its own copy of the company, title and link, so it survives the posting closing.

### Account and data

- **Deleting a person:** `users delete` removes their rows at once, files included, and the owner deletes the matching user in Supabase. Database dumps expire after 14 days, and Anthropic and Supabase keep their own logs for their stated windows.
- **Self-serve export and deletion** wait until someone besides the owner uses Instante.

## Screens in v1

Sign in (email code, then authenticator) · Onboarding · Inbox (with the lists above, and Paste a posting) · Job page · Master resume (contact details, editor, import review, what the AI can't see) · Resumes (list, review screen) · Applied · Settings (search, eligibility, screening, resume, account).

## Not in v1

| Feature | Why it waits | Trigger to reconsider |
|---|---|---|
| Other people using Instante | A personal project; each extra person needs the checklist [below](#before-anyone-else-uses-it) | The owner wants to invite someone |
| Following boards yourself (adding a company by link) | The owner adds boards by command; pasting covers single jobs | More than 5 boards added in a month |
| Himalayas and other remote-job feeds | Aggregators fill about half of its top results, and its terms add duties | Fewer than 5 remote Yes or Maybe jobs a week |
| Google Jobs through SerpApi, other ATS systems, careers pages | Paid or legally uncertain; fetching arbitrary URLs needs request-forgery defences | Many pasted links from one system, or the owner approves SerpApi's cost and risk |
| Salary and posting-language filters | Most boards give no pay in their list call; language needs a detector | The owner asks, or pay is fetched per job |
| Agency and aggregator classification | The curated catalog excludes them | Agencies above 10% of Yes verdicts |
| Cover letters | The owner named resumes only | The owner adds them to scope |
| Stretch mode, more templates, two pages, DOCX, respelling | Strict, one page and one template are enough to test the loop | The owner asks; each template must pass the reading-order check |
| Per-entry regeneration, word diffs, editing instructions | The review screen is the most complex in v1 | Whole resumes are often regenerated to change one entry |
| Autosave and master-resume history beyond the import snapshot | Save buttons and the snapshot cover the loop | Work is lost that was wanted back |
| Shared extraction across people | It saves money only when several people screen the same postings | Measured: at least 2 people per screened posting, and AI spend over the owner's threshold |
| Auto-apply, autofill, browser extension | Worst-rated tools; terms risks; a second codebase | Never auto-apply; the others only on demand and after reviewing terms |
| Google or GitHub sign-in, passkeys | Email codes through Supabase are enough for one person | Codes become tedious |
| Admin pages, a usage page | Owner tasks are commands in v1 | The owner wants screens |
| Embeddings and semantic ranking | Rules plus matching are enough at this size | Postings regularly wait behind the daily limit |
| Interview board, follow-up reminders, email digests | The Applied list covers v1 | Several interviews at once |

## Before anyone else uses it

Instante is built so more people can use it, but inviting anyone besides the owner waits until these are done:
1. **Email:** custom SMTP for Supabase, which needs a domain with SPF, DKIM and DMARC.
2. **A privacy notice**, accepted before any processing. It names each processor (Supabase, Anthropic, and the host Instante moves to), what each keeps and for how long.
3. **Self-serve export and deletion,** with a deletion journal that every restore re-applies, so a restored dump can't bring deleted data back.
4. **Sessions:** `HttpOnly` sessions handled on the server, in place of Supabase's script-readable cookies ([ADR-004](decisions/ADR-004-supabase-auth.md)).
5. **Employers' text:** a takedown address in the footer, and Lever postings shown as an excerpt and a link, unless a review says otherwise ([ADR-006](decisions/ADR-006-shared-pool-of-full-postings.md)).
6. **Where people live:** Canada outside Quebec, unless the Law 25 work is done.
7. **Money:** it stays free, because Nova Scotia (s. 89B) and British Columbia (s. 10) ban charging job seekers for finding work. The per-person AI limits are checked against the budget.
8. **A short security re-check** of sign-in, isolation and the document service.
9. **A server:** Instante moves off the owner's Mac, with a domain ([ADR-011](decisions/ADR-011-host.md) is the starting point).

The isolation and unauthenticated test matrices run from the first module, so they're already in place.

## Success criteria for v1

The owner accepted these numbers at the phase 2 gate (decision D1). **Release gates** must pass before the owner relies on Instante for the search (phase 4); **tracked** metrics are measured and reported.

| Criterion | Proposed target | Kind | Checked by |
|---|---|---|---|
| Screening: false No on the held-out pairs (labelled Yes or Maybe called No, filters included) | at most 1 of about 25 | Release gate | Eval: 150 pairs from 50 anonymized postings × 3 personas; prompts tuned on 100, 50 held out |
| Screening: false Yes on the held-out pairs (labelled No called Yes) | at most 3 of about 25 | Release gate | Same eval |
| Screening: false No and false Yes rates over all 150 pairs | ≤ 5% and ≤ 10%, with intervals | Tracked | Same eval |
| Tailoring: lines with a fact not in the master | 0 in the graded sample | Release gate | Verifier, plus 50 lines graded each eval run |
| Tailoring: lines rewritten, not copied | ≥ 30% | Release gate | Tailoring eval |
| Frozen resumes on one page | 100% | Release gate | Page count of the stored PDF |
| Cross-user access | 0 leaks across every route, list and queue job | Release gate | Isolation matrix in CI |
| Contact details, status lines or home city in a prompt; evidence wrongly withheld | 0 | Release gate | Prompt-privacy test, both directions |
| Accessibility | zero critical or serious axe findings | Release gate | End-to-end tests |
| Time from first sign-in to the first screened jobs, with the resume imported | ≤ 15 minutes | Release gate | Timed run with the sample persona |
| Exact verdict agreement | ≥ 75% | Tracked | Eval |
| Tailoring: lines passing the verifier on the first try | ≥ 95% | Tracked | Tailoring eval |
| Matching open postings for the owner's search | ≥ 30 | Tracked | Count shown at onboarding |
| Collection: every due board read within its window | within 6 h for 6-hour boards | Tracked | Fetch log |
| AI spend | within the monthly budget | Tracked | Call ledger, Console spend limit |
| Does it help? | Yes and Maybe jobs found per week that the owner wouldn't have seen; applications sent per week with an Instante resume; minutes per application | Tracked | Owner's log |

An eval this size can catch a bad screener but can't prove a 5% error rate: with about 25 held-out pairs on each side, one error is already 4%. So the gate counts errors on the held-out pairs, and the rates are tracked with their intervals rather than gated. A tighter gate needs about three times the labelling, and the owner kept this size (decision D1).

## Assumptions

1. Instante is a personal project for the owner, built so others could be added later ([checklist](#before-anyone-else-uses-it)).
2. The AI provider is Anthropic's Claude API, with the data described in [`architecture.md`](architecture.md#the-ai-layer).
3. Jobs are collected only through public, documented job-board APIs whose terms don't forbid it. Nothing evades bot checks or signs in on anyone's behalf.
4. The owner pays for AI. Instante runs on the owner's Mac, so hosting costs nothing in v1.
5. English only in v1.
6. One developer, the owner, reviews what an AI agent writes, for about 5 to 8 hours a week. [`sdlc.md`](sdlc.md) shows the sizing and the review policy behind the timeboxes.

## The owner's decisions at the phase 1 gate

Answered on 2026-11-13.

| # | Question | Decision | Recorded in |
|---|---|---|---|
| 1 | Backend language | TypeScript | [ADR-002](decisions/ADR-002-typescript-backend.md) |
| 2 | Hosting model | (a): the web app and backend on one host, the backend private | [ADR-005](decisions/ADR-005-same-origin-rewrite-and-typed-contract.md) |
| 3 | AI | Anthropic approved; global inference; a generous monthly budget ($100 to start); 1,000 postings a day per person; a Haiku refusal retried once on Sonnet; Sonnet first, Haiku where its eval shows a better cost for the quality; never Opus | [ADR-010](decisions/ADR-010-claude-models-are-configuration.md) |
| 4 | Data sent to third parties | Resume import sends the whole file (option A). A domain maybe later, so no email provider for now | [ADR-008](decisions/ADR-008-master-resume-document.md), [ADR-004](decisions/ADR-004-supabase-auth.md) |
| 5 | Sign-in | Supabase Auth, replacing the proposed emailed codes on our backend | [ADR-004](decisions/ADR-004-supabase-auth.md) |
| 6 | Sources | A hand-curated list of boards | [ADR-006](decisions/ADR-006-shared-pool-of-full-postings.md) |
| 7 | Scope | As listed: no cover letters, no Himalayas, no following boards yourself; the Applied list and pasted postings in | this document |
| 8 | Repository and process | `apps/web` as the Next.js folder; a public GitHub repository; no standing approval to push or merge (changed on 2026-11-13: everyday git work is approved, [`AGENTS.md`](../AGENTS.md)), and no relation to any other project; the review policy as written | [`sdlc.md`](sdlc.md), [`AGENTS.md`](../AGENTS.md) |
| 9 | Time | 5 to 8 hours a week of review | [`sdlc.md`](sdlc.md#sizing) |

The owner also made Instante a personal project rather than a product launch. That settled the earlier sub-questions on served places (the owner's own search), showing full posting text (the owner is the only reader) and inviting friends (later, [with a checklist](#before-anyone-else-uses-it)).

## Decide later

[`sdlc.md`](sdlc.md) lists these with their phases:
- **Phase 2,** answered 2026-11-13 ([`sdlc.md`](sdlc.md#phase-2-foundations-signed-off-2026-11-13)):
  - Instante runs on the owner's Mac for now ([ADR-012](decisions/ADR-012-run-on-the-owners-mac.md)), with no domain;
  - the success-criteria numbers and the eval's size, as proposed;
  - the retention windows, as proposed;
  - the list-requirement rule as written, and all five eligibility rules, each off until turned on;
  - no release of withheld lines in v1;
  - no Batch API for now;
  - Cache Components off;
  - no error tracking.
- **Phase 3:** the eval labels. Each task's model and effort come from its eval ([ADR-010](decisions/ADR-010-claude-models-are-configuration.md)), and the owner sees the result at the module's demo.

