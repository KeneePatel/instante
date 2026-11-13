# ADR-008: The master resume is one versioned JSON document with permanent ids, and the AI reads only an allowlisted view of it

## Status
Accepted 2026-11-13. At the phase 1 gate the owner chose import option A: the whole file goes to Anthropic. At the phase 2 gate the owner decided a withheld line isn't released in v1; the person rephrases it instead (D4). Proposed 2026-11-12 and revised after three adversarial review cycles the same day.

## Date
2026-11-12

## Context
- Tailored lines and screening evidence must say which master lines they came from, so code can check them and the review screen can show the source ([resume note](../research/resume.md)).
- JSON Resume 1.7.1 has no ids, and Reactive Resume stores each description as one HTML string.
- One master resume per person keeps every tailored line traceable to a single source.
- The owner's standing rule: the screener never sees contact details, work authorization or home location. Early-career applicants on permits often state their status on the resume. But the same words appear in ordinary evidence ("Visa payments", "sponsorship outreach", "University of Waterloo"), so a crude filter would hide real evidence and cause false Nos.

## Decision
- **Storage:** one master per person.
  - Contact details (name, email, phone, city, links) are entered in onboarding and sit in their own column, `master_resume.contact`.
  - The rest is a `jsonb` document, `master_resume.doc`, with a `schemaVersion`:
    - a summary, stored but not printed by `harvard-1`;
    - experience: an employer with one or more positions, each with a title, dates and bullets;
    - projects, education, certifications;
    - languages with a level;
    - skills, Proven or Familiar;
    - custom sections.
- **Ids:** a prefix and 8 lowercase Crockford base32 characters, from one generator in `packages/contract`. The prefixes are `x` experience, `p` position, `b` bullet, `j` project, `e` education, `c` certification, `l` language, `s` skill, `u` custom section and `i` custom item. On save, ids must be well formed and unique, and an existing id keeps its type.
- **Dates** are `{start, end, present, expected, raw}`, with YYYY or YYYY-MM. A year alone prints as a year and is flagged in the editor, and comparisons treat it as any month of that year.
- **Validation:** the Zod schema in `packages/contract`, with size limits, on every save. Scheme-less links get `https://`. Pure upgrade functions run on read when the schema version changes.
- **Saving:** a **Save** button per section sends the whole document with the version it started from: `UPDATE … WHERE version = $expected`, or `409`. There's no autosave in v1.
- **Safety net:** one snapshot of the old master when an import replaces it, which can be restored.
- **The AI view,** one function in `domain/resume`, used by screening and tailoring:
  - **The allowlist:** the summary; each employer with its positions' titles, dates and bullets; projects; education as degree, field and dates, without the school; certifications; languages; skills with levels; custom sections. Never contact details, schools, entry locations or links.
  - **Numbered placeholders:** inside the remaining text, every occurrence of the person's contact values or home city, and any email, phone number or URL, is replaced by a numbered placeholder recorded per line (`[city1]`, `[link1]`, `[email1]`). The rest of the line is kept. Tailoring puts the real values back after its checks ([ADR-009](ADR-009-strict-tailoring-and-typst.md)).
  - **Status statements:** a line matching a work-status pattern is withheld whole, in every section including custom ones. The patterns are tested against a corpus of real phrasings in both directions. The families:
    - authorized, eligible, entitled or able to work;
    - work or study permit or visa;
    - PR, PGWP, OWP, LMIA, H-1B, TN, IEC;
    - permanent residen(t, cy, ce);
    - a nationality with "citizen", "citizen of", "citizenship", "nationality:";
    - needs, requires, without or no sponsorship, and sponsorship (not) required;
    - refugee, protected person, landed immigrant;
    - security clearance and its levels.

    A single word such as "visa", "citizen" or "sponsorship" doesn't count on its own.
  - **Shown to the person:** the master-resume page lists every withheld line and replaced value, with the reason, so the person can rephrase.
  - **If the person wants their status printed,** it lives in settings and code prints it, like contact details.
- **Import:**
  - a PDF or DOCX within the upload limits, or pasted text;
  - the document service extracts the text layer;
  - the call uses an all-required schema (`""` instead of null), with separate outputs for work status, citizenship, date of birth, photo and home address. These never enter the master; the review offers "move to settings" or "discard";
  - code assigns ids, normalizes ligatures, hyphens and quotes, and checks both ways. Drafted lines not in the file are flagged, and file lines of more than three words missing from the draft are flagged "not imported: add?". An empty text layer shows one banner;
  - the draft is checked against the save schema, and the person reviews it before anything is saved;
  - the file bytes and text layer are deleted when the import ends.
- **What the import sends to Anthropic** (the owner chose option A):
  - **Option A, chosen for accuracy:** the PDF inline, once, never through the Files API. Claude reads each page's text and image, so two-column layouts keep their meaning. It sends everything in the file: contact details, any work-status or citizenship statement, a date of birth, a home address, a photo. The import screen says so, and `AGENTS.md` names it as the one exception to the AI-view boundary.
  - **Option B, declined for PDFs:** the text layer with the contact values from onboarding, the block above the first section heading and status lines removed. Less accurate on multi-column layouts.
  - DOCX and pasted text always go as redacted text (option B's redaction).

## Alternatives considered

| Option | Why not |
|---|---|
| JSON Resume as the stored format | No ids; useful later for import and export |
| Reactive Resume's format | Descriptions are HTML strings, and layout settings sit inside the data |
| Small versioned operations with tombstones | Built for syncing devices; more endpoints |
| Autosave and session snapshots | Autosave fed re-screen churn and conflicts; Save buttons and the import snapshot cover the loop |
| Dropping any line with a status word, URL or city | Hides real evidence (cycle 2); placeholders and status constructions keep it |
| Contact details inside the document | One careless field in the AI view would leak them; a separate column makes the boundary physical |
| A rule-based parser or a parsing vendor | Rules break on layouts; a vendor is another paid third party |

## Consequences
- One save endpoint, one validation path, and a visible `409` instead of lost updates.
- An import mistake would become a "fact" in every later resume. The two-way check and the review step guard against it.
- **The AI view is the single place** where the privacy rule is enforced. Its tests run both ways: nothing forbidden gets through, and evidence such as "Integrated Visa payments", "Led sponsorship outreach", a degree from a home-city university, or "ASP.NET" survives.
- Large import schemas may hit structured-output limits; the schema can split into two calls if needed.

## Doubts raised
Single-model reviews; the owner chose to skip a cross-model second opinion.
- **Cycle 1:**
  - "Nothing kept work-authorization text away from the AI" (blocker): valid. The AI view.
  - "Documents contradicted each other on what import sends": valid. Two options.
  - "Schema gaps (several positions, summary, year-only dates, ids)": valid. Fixed.
  - "One-way import check": valid. Both ways.
  - "Snapshots and autosave": valid. Simplified.
  - "Hostile files beside the secrets": valid. The document service.
- **Cycle 2:**
  - "The scrub dropped whole lines on bare words, hiding evidence; schools came back and employers were missing" (blocker): valid. Placeholders, status constructions, degree without school, employers included, everything shown to the person, and tests both ways.
  - "Option B couldn't redact a first import's name and address": valid. Contact details are collected first.
  - "Option A was described as sending only contact details, and it breaks an `AGENTS.md` rule": valid. Option A is now described in full, and the exception is named in `AGENTS.md`.
- **Cycle 3:**
  - "Eight literal phrases leak common wordings ('Requires sponsorship', 'PGWP', 'Indian citizen') and skip custom sections": valid. Pattern families tested on a corpus, applied to every section.
  - "Generic placeholders could be printed in a PDF": valid. Numbered placeholders that tailoring restores, a verifier check, and a release-gate test.
  - "Accounts of what reaches Anthropic differed between documents": valid. One per-task list in [`architecture.md`](../architecture.md#what-reaches-the-model).

## Revisit when
The AI starts proposing edits to the master (JSON Patch), someone loses work they wanted back (autosave and history), people want JSON Resume import or export, scanned PDFs keep failing (OCR), or withheld-line reports show the construction list is wrong.
