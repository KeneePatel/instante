# ADR-009: Strict tailoring in one call, checked by code; Typst renders; the downloaded PDF is what gets frozen

## Status
Accepted 2026-11-13 at the phase 1 gate. Proposed 2026-11-12 and revised after three adversarial review cycles the same day. The tailoring model is chosen in the `tailoring` slice, from its eval ([ADR-010](ADR-010-claude-models-are-configuration.md)).

## Date
2026-11-12

## Context
- Invented details are the most common complaint about AI resume tools, and recruiters catch them at the phone screen ([prior-art note](../research/prior-art.md)).
- An earlier prototype's strict mode traced every bullet to the master, and a verifier rejected new numbers, technologies and another role's facts. Its 6 to 12 calls per build and rewrite loops made sections thinner. Measuring real PDF line heights fitted the page reliably ([resume note](../research/resume.md)).
- What ATS vendors' guidance has in common (Greenhouse, Lever and Textkernel each cover parts of it):
  - a text-based file and one column;
  - headings on their own lines;
  - contact details in the body;
  - month and year on dates;
  - no tables, text boxes or graphics.
- Typst renders from JSON in well under a second, with no escaping layer, and writes tagged PDFs. It's one binary with no runtime dependencies.

## Decision
- **One structured-output call per resume, in the interactive lane.** It never sees the raw posting. The input:
  - the job's requirement list and facts from screening. If the job has no analysis yet, the tailoring job makes one first, exempt from the daily limit and the screening pause but counted towards the budget;
  - the master's AI view ([ADR-008](ADR-008-master-resume-document.md));
  - the person's rules.

  It returns entries and lines, each with `sourceIds`, plus `skillIds`. If the analysis is refused, the build makes a plain one-page version of the master and says why.
- **Checks in code:**
  - ids exist, have the right type, and belong to the line's own entry;
  - employers, titles and dates are copied from the master;
  - numbers appear in the cited sources, including number words, multipliers and magnitudes ("doubled", "a dozen", "hundreds", "first", "only");
  - capitalized names and other proper nouns appear in the cited sources;
  - terms (from a curated tech lexicon, the master's skill names and the job's requirement terms) appear in the cited sources;
  - skills come from the master, and Familiar skills never become bullet claims;
  - the never-claim list blocks a line, and avoid-phrases are flagged;
  - required sections (the most recent role, education) are present;
  - placeholders come back exactly as the line's sources had them, and then code puts back the master's real values. A leftover, unknown or duplicated placeholder fails the line.
- **Fallback:** a failing line goes back to its first cited source that belongs to its own entry and passes the same checks; otherwise it's dropped and listed as "couldn't verify".
- **Render:** `harvard-1`, a Harvard-style Typst template written for Instante:
  - Letter, Liberation Serif 11 pt (OFL) with a Noto fallback for names in other scripts;
  - ¾-inch margins, one column, the contact line in the body;
  - dates as "Month Year", years alone as years;
  - ligatures off, tagged PDF, fixed timestamp.

  The data goes in as a JSON file, through a fixed command line, in the document service ([ADR-001](ADR-001-separate-backend.md), [limits table](../architecture.md#limits-and-windows)). The Typst version is pinned and installed by a checksummed script on the Mac, in CI and in the image.
- **Fit:**
  - one Typst pass reports each line's height;
  - code drops the lines with the lowest value per line saved, using the model's order within an entry as the rank, while keeping the most recent role and two lines per role;
  - if it still doesn't fit, older roles go, then projects, and if even that fails, the build stops and says how many lines to remove;
  - one final compile confirms the page. It never ships two pages.
- **Previews** render on demand, cached by content hash and renderer version (`GET .../preview`). A tailored resume has a version and answers `409` on a conflict.
- **The review screen in v1:**
  - each line with its source above it, and one badge (rewritten, copied, dropped, flagged);
  - toggle or edit a line, which re-runs the checks as warnings;
  - regenerate the whole resume, after confirming that edits will be lost;
  - a read-only list of requirements covered and not covered;
  - the preview, refreshed once changes settle.
- **Download and freezing:**
  - **Download** (`POST .../download`) renders the current draft, stores those exact bytes as a new download file (with SHA-256, draft version, renderer version and time), and returns them. Every download is kept until the resume is frozen or the draft expires.
  - **Mark applied** asks which resume and which download was sent (the newest by default), freezes that file and deletes the draft's other downloads. If there was no download, it renders, stores, freezes and says so.
  - Editing a frozen resume copies it to a new draft.
  - No stored or frozen PDF may contain a placeholder token; a test checks it.
- **v1 limits:** strict only, one template, one page, PDF only, spelling as written in the master. Instante never claims a resume is "ATS-proof".

## Alternatives considered

| Option | Why not |
|---|---|
| Section writers plus rewrite loops | 6 to 12 calls; the rewrite loop made sections worse |
| The raw posting in the tailoring prompt | Third-party text beside the resume; the requirement list carries the terms the checks need |
| Freezing a fresh render at Mark applied | Could differ from the file the person downloaded and sent |
| Per-entry regeneration, word diffs, instructions, respelling | Later, with triggers |
| HTML to PDF in headless Chromium; @react-pdf/renderer; LaTeX; DOCX | A browser on the server; another layout engine; escaping and installs; Word reflows text |

## Consequences
- One or two calls per resume. Employers, titles and dates can't be invented, and numbers, names and terms must trace to sources.
- Code checks don't catch changed meaning ("helped build" becoming "led"). The source above each line covers it now; an AI judge for meaning drift waits for the eval.
- Typst runs can hang, so the timeout, the kill and the build deadline are required.
- **The tailoring eval** comes first in the `tailoring` slice: fixture resumes from the Jordan Rivera persona, with targets of zero invented facts in a graded sample of 50 lines, at least 30% of lines rewritten and at least 95% passing the verifier on the first try. The model is chosen from it ([ADR-010](ADR-010-claude-models-are-configuration.md)).

## Doubts raised
Single-model reviews; the owner chose to skip a cross-model second opinion.
- **Cycle 1:**
  - "The terms check had no data; number words and proper nouns passed": valid. Lexicon, requirement terms, number words and proper nouns.
  - "The fallback could cross employers": valid. Same entry only.
  - "Fitting underspecified": valid. A measured fit planner and a defined no-fit case.
  - "Drafts had no process; a download finalized": valid. Previews and freezing separated.
  - "The review screen was too big": valid. Cut.
  - "The raw posting beside the resume": valid. The requirement list only.
  - "Polish after the checks": valid. Respelling left v1.
  - "Template origin and licence; ATS agreement overstated": valid. Stated. Since 2026-11-13 the template is written fresh for Instante.
- **Cycle 2:**
  - "Tailoring depended on a screening run that pauses, limits and queues can block": valid. It analyses in its own lane, with a plain fallback.
  - "Freezing re-rendered, so the stored PDF could differ from the sent one": valid. Downloads store bytes, and Mark applied freezes them.
  - "The no-fit order differed between documents": valid. One order, here.
- **Cycle 3:**
  - "A second download overwrote the one actually sent": valid. Every download is kept, and Mark applied asks which one.
  - "Placeholders could reach the PDF": valid. Numbered placeholders, restored and checked.

## Revisit when
Evals show meaning drift the code checks miss (an AI judge), people ask for Word, more templates, two pages or Stretch mode, or fitting drops lines on most builds (a shortening call).
