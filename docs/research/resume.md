# Master resume, tailored resumes and resume storage

> **Phase 1 review, 2026-11-12:** an adversarial review changed some recommendations in this note. Where they differ, the ADRs in `docs/decisions/` and `docs/architecture.md` are authoritative; each ADR's "Doubts raised" section says what changed and why.

**Owner's decisions, 2026-11-13:** resume import sends the whole file (option A). Models: Sonnet 5.5 or Haiku 5.5 only, never Opus. Instante is a personal project for the owner, not a launch; multi-user, beta and 50-person estimates in this note describe the earlier framing and are now upper bounds.

Checked on 2026-11-12. The question: how does a user get a master resume, edit it safely, and turn it into a one-page resume for one job without invented facts, and how are resumes rendered and stored? Recommendation: keep the master resume as one JSON document per user, in our own versioned schema, where every entry, bullet and skill has a short stable id. Import a PDF by sending it to Claude as a document, then check the draft against the file's own text layer; read DOCX with mammoth; the user reviews every line before anything is saved, and the uploaded file is deleted when the import ends. Edits save the whole document with a version check, and the server keeps one snapshot per editing session. Tailoring is one structured-output call that picks entries and rewrites bullets, each line citing the bullet ids it came from. Code fills in employers, titles and dates, checks every line against its sources and falls back to the user's own words. Typst renders a vendored one-column Harvard-style template, code fits one page by measuring the real PDF, the PDF itself is the preview, and PDF bytes are stored only once a resume is final.

## Question

How is a master resume created (import or form), edited and versioned? How does a tailored resume trace each line to the master and keep to facts the user stated? How is it rendered so people and applicant tracking systems (ATS) read it correctly? What is stored, where, and for how long? Constraints: the frontend never touches the database or holds secrets (`AGENTS.md`); at most 50 users in v1; the Claude API; nothing person-specific hard-coded; the backend language (Python, TypeScript or Go) and the database are being decided in other notes.

## Options compared

| Option | Verdict | Why |
|---|---|---|
| Schema: our own versioned JSON with short stable ids on every entry, bullet and skill | recommended | Tailored lines must cite bullets. Converters to JSON Resume can come later. |
| Schema: JSON Resume 1.7 as the stored format | rejected (later for import and export) | No ids anywhere, bullets (`highlights`) are plain strings, unknown properties allowed. |
| Schema: Reactive Resume's format | rejected | Items have ids, but each description is one HTML string, so single bullets can't be cited. Layout settings live in the same document. |
| Import: PDF sent to Claude as a document; draft checked against the file's text layer | recommended | Claude gets each page's text and image, so columns and sidebars keep their meaning. The check flags lines the file doesn't contain. One call. |
| Import: extract text ourselves, strip contact details, send text only | runner-up | Contact details never reach the AI provider. Text extraction scrambles multi-column layouts; OpenResume's parser only handles one column. |
| Import: rule-based parser (OpenResume style) or a parsing vendor (Textkernel) | rejected | Rules break on layouts and languages. A vendor is another paid third party holding resumes. |
| Import: DOCX through mammoth to text, then the same call | recommended | Claude's document block takes PDF and plain text only. |
| Edit: whole-document save with a version check, one snapshot per editing session | recommended | One endpoint, one validation path, no lost updates between tabs. Reactive Resume works this way. |
| Edit: small versioned operations | rejected for v1 | Built for syncing two machines; here the server holds the only copy. Versioning every save reached hundreds of versions in an earlier prototype. |
| Edit: JSON Patch (RFC 6902) | later | Fits AI-proposed changes to the master. |
| Tailor: one structured call that selects and rewrites; code checks, fits and falls back | recommended | 1 call per build, 2 with the optional shortening pass. The model never writes employers, titles or dates. |
| Tailor: section writers plus rewrite loops | rejected | 6 to 12 calls. An earlier prototype dropped the rewrite loop because it made sections worse. |
| Tailor: Stretch mode (flagged "gap" bullets beyond the master) | later, owner's call | If added, make it opt-in per user, since users who didn't choose it shouldn't get it. |
| Render: Typst with a vendored one-column template | recommended | Under 0.1 s per render, no escaping layer, tagged PDFs by default, one binary or an in-process Python binding. |
| Render: HTML to PDF in headless Chromium (Playwright, Gotenberg) | runner-up | The preview could reuse React components. It adds a browser to the server; Gotenberg's image is about 640 MB; Reactive Resume left this route in 2026-05. |
| Render: WeasyPrint | runner-up (Python only) | Good CSS paged media in one library, but needs Pango system libraries. |
| Render: @react-pdf/renderer or Forme | rejected | Their own JavaScript layout engines. In the browser the PDF sits away from the backend that fits pages and keeps the record; a Python or Go backend would need Node to run them. Forme's repo is nine months old. |
| Render: LaTeX | rejected | Escaping, compile failures and font work, and a large TeX install. |
| Output: DOCX (python-docx, docx, pandoc) | later | Word reflows text, so one page can't be promised. |
| PDFs: drafts rendered on demand, bytes stored once final | recommended | Drafts cost nothing to redo. A final PDF records what an employer received; a later Typst or template change must not alter it. |
| PDFs: object storage (S3, R2) | later | Another service and two-step deletes, for files of tens of kilobytes. |
| Uploaded file: deleted when the import ends | recommended | PIPEDA Principle 5. The reviewed master replaces it. |

## Findings

### Claude API, checked 2026-11-12
- A PDF goes in a `document` block. Limits: 128 MB per request on the first-party API, 600 pages (100 below a 1M context), no passwords or encryption. Each page is sent as its extracted text plus an image of the page; text costs about 1,500 to 3,000 tokens a page, plus image tokens ([PDF support](https://platform.claude.com/docs/en/build-with-claude/pdf-support)).
- An image costs ⌈width/28⌉ × ⌈height/28⌉ visual tokens, capped at 4,784 on Claude 4.7 and later ([Vision](https://platform.claude.com/docs/en/build-with-claude/vision)). The size of the page images made from a PDF isn't stated (UNVERIFIED).
- DOCX isn't a document type; the docs say to convert it to text. Files API uploads stay until deleted, or until an optional expiry set at upload (1 hour to 90 days), and every key in the workspace can read them ([Files API](https://platform.claude.com/docs/en/build-with-claude/files)). So files go inline as base64.
- Prompts and outputs aren't retained by default except for Covered Models (the Fable and Mythos families, not Opus, Sonnet or Haiku 5.5), and retained data isn't used for training without permission ([API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)). The commercial help page says inputs and outputs are deleted within 30 days ([privacy center](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)).
- Inference runs `global` (default) or `us` (1.1× price); stored data is US-only. There is no Canadian option ([Data residency](https://platform.claude.com/docs/en/manage-claude/data-residency)).
- Structured outputs (`output_config.format`): no recursion, no string-length or number bounds, `minItems` only 0 or 1; at most 24 optional and 16 union-typed parameters per request; very complex schemas get a 400 and compiling times out after 180 s. Required properties come first. A refusal or `max_tokens` stop can break the schema, enum casing isn't guaranteed, and citations can't be combined with it ([Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)).
- Prices per million tokens, input / output (cache hit): Opus 5.5 $4 / $20 ($0.20); Sonnet 5.5 $2 / $10 ($0.10); Haiku 5.5 $0.10 / $0.50 ($0.01) for prompts up to 100K. Batch is 50% off. Cache hits on Opus and Sonnet 5.5 cost 0.05× input, not the usual 0.1× ([Pricing](https://platform.claude.com/docs/en/about-claude/pricing)). Opus 5.5 can't turn thinking off and defaults to `medium` effort, so thinking adds output tokens ([Opus 5.5 overview](https://platform.claude.com/docs/en/models/opus-5-5/overview), checked 2026-11-12).

### Reading uploaded files

| Library | Version (date) | Licence | Use |
|---|---|---|---|
| pypdf | 7.0.1 (2026-11-10) | BSD-3-Clause | Python: page count, encryption check, text layer ([PyPI](https://pypi.org/project/pypdf/)) |
| pdfplumber | 0.11.10 (2026-06-15) | MIT | Python: layout-aware text ([PyPI](https://pypi.org/project/pdfplumber/)) |
| PyMuPDF | 2.1 (2026-11-02) | AGPL-3.0 or commercial | rejected: licence ([PyPI](https://pypi.org/project/PyMuPDF/)) |
| mammoth | 1.13.0 (2026-09-26) | BSD-2-Clause | DOCX to text or HTML, Python and Node ([PyPI](https://pypi.org/project/mammoth/), [npm](https://www.npmjs.com/package/mammoth)) |
| unpdf / pdfjs-dist | 2.1.0 (2026-10-30) / 6.5.438 (2026-11-01) | MIT / Apache-2.0 | Node: text layer ([unpdf](https://www.npmjs.com/package/unpdf), [pdfjs-dist](https://www.npmjs.com/package/pdfjs-dist)) |
| ledongthuc/pdf | no releases; pushed 2026-10-20 | BSD-3-Clause | Go: plain text ([repo](https://github.com/ledongthuc/pdf)) |

- OpenResume's parser reads pdf.js text items, joins them into lines, treats a bold all-caps line as a section heading, then scores features to pick each field. It is built for single-column, English resumes ([parser page](https://www.open-resume.com/resume-parser)). The repo is AGPL-3.0 and was last pushed 2024-10-29 ([repo](https://github.com/xitanggg/open-resume)).
- Reactive Resume 6.1.0 stops PDF and Word imports at a "check what was found" step before creating a resume; v6.0.5 fixed text lost from multi-column PDFs; Word imports need an AI provider ([changelog](https://docs.rxresu.me/changelog), [README](https://github.com/reactive-resume/reactive-resume)).

### Schemas
- JSON Resume's schema moved into the jsonresume.org monorepo. `@jsonresume/schema` 1.7.1 came out on 2026-11-06 after releases 1.4.0 to 1.7.0 on 2026-10-22 and 2026-10-23 ([npm](https://www.npmjs.com/package/@jsonresume/schema), [changelog](https://github.com/jsonresume/jsonresume.org/blob/master/packages/schema/CHANGELOG.md)). It is draft-07 and allows unknown properties. Dates are `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. No object has an `id`, and `work.highlights` is an array of strings; 1.4.0 added optional `custom` objects and made a missing `endDate` mean current ([schema.json](https://github.com/jsonresume/jsonresume.org/blob/master/packages/schema/schema.json)). MIT.
- Reactive Resume v6.1.0 (2026-11-05, MIT, TypeScript, Postgres with Drizzle) stores each resume as one `jsonb` `data` column, and uses `updated_at` as the concurrency check. A `resume_version` table holds full snapshots by kind: created, import, one autosave row per editing session, named, before-restore, restored, AI, sent ([resume.ts](https://github.com/reactive-resume/reactive-resume/blob/main/packages/db/src/schema/resume.ts)). Items carry an `id` and `hidden`; descriptions are HTML strings. Dates are `{start, end, present, expected, raw}`, where `start` and `end` are `YYYY` or `YYYY-MM`, so a year alone stays exact ([dates.ts](https://github.com/reactive-resume/reactive-resume/blob/main/packages/schema/src/resume/dates.ts)). Trash is purged after 30 days ([changelog](https://docs.rxresu.me/changelog)).

### Rendering
- Typst 0.15.1 (2026-07-17), Apache-2.0 ([releases](https://github.com/typst/typst/releases)). Since 0.14.0 (2025-10-24) it writes tagged PDFs by default, with fixes to text extraction and hyphenation mapping ([0.14.0](https://typst.app/docs/changelog/0.14.0/)). 0.15.0 (2026-06-15) minifies PDFs and makes `json()` take bytes ([0.15.0](https://typst.app/docs/changelog/0.15.0/)). It embeds Libertinus Serif (the default), New Computer Modern and DejaVu Sans Mono, and turns ligatures on by default ([text](https://typst.app/docs/reference/text/text/)).
- typst-py 0.15.2 (PyPI, 2026-11-05), Apache-2.0, compiles in-process from bytes. It takes `sys_inputs`, `font_paths`, `ignore_system_fonts`, a fixed `timestamp` for reproducible output, and `pdf_standards` such as `ua-1` ([README](https://github.com/messense/typst-py)).
- typst.ts: npm 0.7.0 (2026-06-01) bundles Typst 0.14.2; the Typst 0.15 line is still at 0.8.0-rc4 (2026-11-09) ([releases](https://github.com/Myriad-Dreamin/typst.ts/releases)). A Node backend would call the CLI.
- Playwright 1.65.0 (2026-11-05): `page.pdf()` prints with print CSS, and tagged output and the outline are off by default ([API](https://playwright.dev/docs/api/class-page#page-pdf)). Gotenberg 9.4.1 (2026-11-12, MIT) bundles Chromium and LibreOffice in an image of about 640 MB compressed ([releases](https://github.com/gotenberg/gotenberg/releases), [Docker Hub](https://hub.docker.com/r/gotenberg/gotenberg/tags)).
- WeasyPrint 70.0 (2026-09-08), BSD-3-Clause, Python 3.10+, needs Pango 1.44+ ([docs](https://doc.courtbouillon.org/weasyprint/stable/first_steps.html)).
- @react-pdf/renderer 4.9.0 (2026-08-27, MIT) lays out with Yoga in the browser or Node ([site](https://react-pdf.org/)). Forme 0.31.0 (2026-11-05, MIT) is a Rust and WASM engine whose repo was created on 2026-02-17 ([repo](https://github.com/danmolitor/forme)).
- Reactive Resume's path: a Browserless printer service until v5.1.0 (2026-05-07), which moved to @react-pdf/renderer, dropped the service and aimed to end PDFs that differ from the preview. v6.0.0 (2026-10-04) moved to Forme. Four of the ten releases since then (6.0.1, 6.0.3, 6.0.4, 6.1.0) fixed font or missing-glyph problems ([changelog](https://docs.rxresu.me/changelog), [releases](https://github.com/reactive-resume/reactive-resume/releases)).
- DOCX writers: python-docx 1.2.0 (2025-06-16, MIT), docx 9.15.3 (2026-11-06, MIT), pandoc 3.14 (2026-11-12, GPL-2.0) ([PyPI](https://pypi.org/project/python-docx/), [npm](https://www.npmjs.com/package/docx), [pandoc](https://github.com/jgm/pandoc/releases)).
- Fonts under SIL OFL 1.1: Liberation 2.1.5 (Times New Roman metrics), Libertinus, Source Serif 4 ([Liberation](https://github.com/liberationfonts/liberation-fonts), [Libertinus](https://github.com/alerque/libertinus), [Source Serif](https://github.com/adobe-fonts/source-serif)).

### What ATS parsing needs
- Greenhouse takes .doc, .docx, .pdf, .rtf and .txt up to 100 MB, but can't parse files over 2.5 MB. It lists these causes of failed or partial parses: image-only files, graphics, letter spacing, tables, headers, footers, text boxes, columns, unclear sections and abbreviated titles. Its candidate FAQ recommends PDF and says to check parsed fields ([formats](https://support.greenhouse.io/hc/en-us/articles/360052218132), [failures](https://support.greenhouse.io/hc/en-us/articles/200989175-Unsuccessful-resume-parse), [FAQ](https://support.greenhouse.io/hc/en-us/articles/43418495049499-MyGreenhouse-FAQ-for-Candidates)).
- Textkernel, the parser behind many ATS, stores dates as `yyyy-MM-dd` with `FoundMonth` and `FoundDay` flags. A missing month or day becomes 01, except a job's end date, which becomes 12-31 ([Parse API](https://developer.textkernel.com/tx-platform/v10/resume-parser/api/)). So "2023 – 2024" reads as 24 months.
- Textkernel's Resume Quality findings ask for one top-to-bottom column (433), each header on its own line (151), contact details only at the top (311), one email and one phone (131 to 133), dates for every job (419, 224, 225) and date ranges on one line (418). The page says these tiers don't mean parsing failed. Finding 233 advises no dates in education, against Harvard's samples ([Resume Quality](https://developer.textkernel.com/tx-platform/v10/resume-parser/overview/parser-output/)). Images and scanned PDFs need its optional, slower OCR add-on ([formats](https://developer.textkernel.com/TKPlatform/master/file-formats/)).
- Lever uploads image files without parsing them. A parse can fill name, headline, emails, phones, location, company and links, with nothing guaranteed ([API](https://hire.lever.co/developer/documentation)).
- Harvard's Mignone Center: 10 to 12 pt held constant, equal margins of at least ¾ in, no text boxes, colour or shading, one page for BA, MA and MBA candidates ([master's guide](https://careerservices.fas.harvard.edu/resources/gsas-masters-resume-cover-letter/)); no photo, age or gender, and check the PDF conversion ([college guide](https://careerservices.fas.harvard.edu/resources/create-a-strong-resume/)).

### Storage and retention
- PostgreSQL 18.7 compresses or moves large values out of line when a row is wider than about 2 kB (TOAST); a single value can reach 1 GB ([TOAST](https://www.postgresql.org/docs/current/storage-toast.html)).
- PIPEDA Principle 5: keep personal information only as long as its purpose needs, then dispose of it ([OPC](https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/p_principle/principles/p_use/)).
- Resume-Matcher 1.4.0 (2026-10-21, Apache-2.0; FastAPI, Next.js 16, SQLite or Postgres) renders PDFs with Playwright. It scores keyword, skill, title, section and date matches in plain code, and its ATS check shows the text extracted from the rendered PDF ([repo](https://github.com/srbhr/Resume-Matcher)).

## Lessons from earlier work

What transfers:
- One master resume per user is the only source builders read. The verifier is the single enforcement point, so its tests matter most.
- Code fills in contact details, so they never pass through the model. The verifier's hard limits hold in every mode: employers, titles, dates, degrees, certifications and total years never change, and the hiring company's products and personal fields such as a photo or date of birth never appear. Instante goes one step further: code fills the entry headers too.
- Typst from JSON input removed the LaTeX escaping layer; markup inside data prints literally, and the same input gives the same bytes. Renders took under 0.1 s. A runner that missed Typst's exit left builds "running" for hours, so the runner needs a timeout, a kill, and a deadline on the whole build.
- The Harvard template: Liberation Serif at 11 pt, ¾ in margins, one size throughout, Education then Skills first for tech, no summary (one call saved), and every date as month and year with a year on both ends. "(Expected)" goes after the range so parsers still read two dates.
- A year alone must stay a year. An early import prompt turned "2025" into January, and because the schema stores months, review can only flag such dates.
- Page fitting measures the real PDF and cuts what costs least per line saved, never the most recent role, keeping at least two bullets per kept role.
- A writer that fails falls back to the user's words, and copied words skip polish. Polish swaps AI-sounding phrases ("spearheaded" to "led", "leveraging" to "using") and spells en-CA or en-US by the job's country.
- In an earlier prototype a cheap model barely tailored: 129 of 141 bullets came back word for word, which also inflated the pass rate. The rewrite loop made sections thinner and was dropped; the match score stays a report.
- Contact details and work-status phrases are removed before any AI call. Imports are shown for review and never saved silently.
- Providers reject schema features differently (Gemini refused `maxItems`), so counts and lengths are checked in code.

What doesn't:
- Small per-operation edits with tombstones served sync between two machines. One server copy can take whole-document saves, and tailored resumes copy their cited sources, so no tombstones are needed.
- A version per save grew to hundreds of versions in days. Instante keeps one snapshot per editing session.
- Per-user API keys, provider chains and free-tier budgets give way to one server-side key with per-user limits (the AI note).
- PDFs written to a local folder become stored bytes for final resumes only.
- Required LinkedIn and phone fields suit one person's resume. Instante requires only a name and an email.
- Lite becomes the fallback behaviour, not a mode, and Stretch waits for the owner. A pipeline of 6 to 12 calls becomes 1 or 2.

## Recommendation for v1

### Who does what
- **Next.js**: the master-resume editor, the import upload and review screens, the tailoring review screen, and writing-rule settings. It shows PDFs the backend made, in an iframe (pdf.js if phones need it). It never renders PDFs, parses files or calls the AI.
- **Backend**: validation, versions, imports, tailoring, checks, rendering, storage and retention jobs. Imports and builds take tens of seconds, so they run as background jobs the page polls; long requests through the rewrite may time out (auth note).
- **Contract**: the backend publishes the master resume's JSON Schema, and the frontend generates its types from it. A TypeScript backend shares its Zod schemas instead.

### Flows
1. **Create.** Onboarding offers "Import a PDF or Word file", "Paste text" or "Start blank". Blank opens the editor with empty sections.
2. **Import.** The backend checks the type by magic bytes (PDF or DOCX), at most 5 MB and 4 pages, and rejects encrypted PDFs. It keeps the bytes in `resume_import` and runs a job: read the text layer (pypdf, unpdf or mammoth); call Claude with the PDF inline, or the DOCX or pasted text as text, against the import schema; assign ids in code; compare each imported line with the text layer; then delete the file bytes. The review screen lists each entry with a checkbox, an edit button and flags: "not found in your file" (under 90% of words or any number missing; threshold to tune), "your file gives only the year", "no dates", and inferred skills, unticked by default. Accepting saves the master and an `import` snapshot. Replacing an existing master snapshots it first.
3. **Edit.** The editor autosaves one second after typing stops: `PUT /api/master-resume` with the whole document and its `version`. The store runs `UPDATE … SET data = $1, version = version + 1 WHERE user_id = $2 AND version = $3`. No row means 409, and the page offers to reload. One `session` snapshot per editing session is overwritten until 30 idle minutes pass. History lists snapshots; restoring saves a `before_restore` snapshot and then writes the old data as a normal save. Undo inside a session lives in the client. "Preview" renders the whole master with no page budget.
4. **Tailor.** From a job, `POST /api/jobs/{id}/tailored-resumes` queues a build. The prompt holds the posting, the requirement list if screening made one, the master without contact details or work status, and the user's rules. One structured call returns entries and lines with `source_ids`. Code checks the lines, polishes them, fits the page and sets the status to `draft`.
5. **Review.** Each line shows its source text and a word diff, a badge (rewritten, your words, edited by you) and any failed check. The user can toggle lines, edit them (checks run again as warnings, since the words are now theirs), and regenerate everything or one entry with an optional instruction. A coverage report lists the posting's terms shown, those in the master but left out (the user can add them back), and those not in the master (an honest gap, never added). One primary button: "Download PDF".
6. **Export and mark applied.** Downloading makes the resume final: the PDF bytes, SHA-256 and renderer version are stored. Marking applied links it to the application (application note). The account export ZIP holds the master as JSON in our schema (auth note).

### Data model sketch
```
master_resume.data  (ids: a type letter + "_" + 8 random base32 characters, unique within the document;
                     short ids keep prompts small and are easy to copy exactly; ids are never reused)
{ "schema_version": 1,
  "contact":    { "name": "Jordan Rivera", "email": "", "phone": "", "location": { "city": "", "region": "", "country": "CA" },
                  "links": [ { "id": "l_…", "label": "", "url": "https://…" } ] },
  "experience": [ { "id": "x_…", "employer": "", "title": "", "location": "", "type": "full_time", "hidden": false,
                    "dates": { "start": "2024-01", "end": "", "present": true, "expected": false, "raw": "" },
                    "bullets": [ { "id": "b_…", "text": "", "skill_ids": ["s_…"] } ] } ],
  "projects":   [ { "id": "p_…", "name": "", "role": "", "url": "", "dates": {…}, "skill_ids": [], "bullets": […] } ],
  "education":  [ { "id": "e_…", "institution": "", "credential": "", "field": "", "location": "", "dates": {…}, "honours": "", "bullets": […] } ],
  "skills":     [ { "id": "s_…", "name": "", "category": "language|framework|tool|platform|other", "level": "proven|familiar" } ],
  "certifications": [ { "id": "c_…", "name": "", "issuer": "", "date": "2025-06", "url": "" } ],
  "languages":  [ { "id": "g_…", "name": "", "proficiency": "" } ],
  "sections":   [ { "id": "z_…", "title": "", "items": [ { "id": "b_…", "text": "" } ] } ] }

tailored_resume.content
{ "schema_version": 1, "master_version": 42, "template": "harvard-1", "locale": "en-CA", "page_budget": 1,
  "sections": [ { "kind": "experience", "entries": [ { "entry_id": "x_…",
      "lines": [ { "id": "t_…", "text": "", "source_ids": ["b_…"], "origin": "rewritten|verbatim|edited", "flags": [] } ] } ] } ],
  "skill_ids": ["s_…"], "dropped_ids": ["b_…"],
  "sources": { "b_…": "the cited bullet's text at build time", "x_…": { "employer": "", "title": "", "dates": {…} } } }
```
- Dates are `YYYY`, `YYYY-MM` or empty, with `raw` for text that can't be read (Reactive Resume's rule). Text is plain, with no HTML or Markdown.
- Validation on every save: the schema, plus end not before start, `present` meaning no end, `https` links, an email format, unique ids, and limits (bullet 300 characters, 30 bullets per entry, 300 skills, 256 KB per document). Ready to tailor means a name, an email and at least one experience or project bullet.
- `schema_version` changes go through pure upgrade functions run on read, tested with fixtures. Stored snapshots are never rewritten.
- The AI's tailoring output: `{"entries":[{"entry_id","bullets":[{"text","source_ids":[…]}]}],"skill_ids":[…]}`. Every field is required and there are no nulls, which keeps it under the 24-optional and 16-union limits. The import schema uses `""` instead of null for the same reason.

### Checks on every tailored line (code)
1. Each line cites at least one id that exists, has the right type, and belongs to the entry it sits under.
2. Employers, titles, dates, places, schools and credentials come from the master by id; the model never writes them.
3. Every number in the line (40%, $5k, 3x, 1,000) appears in its sources after normalising forms.
4. The posting's requirement terms, company name and product names appear in a line only if its sources contain them. This is the main way invented skills get in. The skills line lists only master skills, and `familiar` skills never appear inside bullets.
5. The user's "never claim" list blocks a line. The "avoid" list (seeded from a polish list, such as spearheaded, leveraging and in order to, and [Wikipedia's list](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing), such as delve, pivotal, showcase and heavy use of the em dash) is replaced where a plain word exists and flagged otherwise.
6. A line fits in two lines at the template's width.

A failing line becomes its source text word for word, flagged "kept your words". Store the rewrite rate, the fallback rate and the number of lines dropped in fitting, and use them in the evals.

### Rendering
- One template, `harvard-1`: Letter size, Liberation Serif 11 pt, ¾ in margins, one column. Headings sit on their own lines, the contact line in the body at the top. Dates read "January 2024 – August 2025" or "September 2024 – May 2026 (Expected)". No icons, colour, tables or text boxes; ligatures off; tagged PDF; a fixed timestamp. The default section order is Education, Skills, Experience, Projects, and users can change it.
- The template and fonts are vendored, with no `@preview` packages fetched at compile time. Data goes in as JSON through `sys.inputs` and is never spliced into markup. Each render has a 10 s timeout and a kill.
- Fitting: render and count pages. Over the budget, drop the lowest-ranked line, keeping the most recent role and two lines per kept role, and render again, at most 15 times (about 1.5 s). After the final render, extract the PDF's text and check every line is there in reading order; this check also runs in CI.

### What to store

| Table | Key fields | Retention |
|---|---|---|
| master_resume | user_id (PK), version, schema_version, data (JSON), updated_at | until account deletion |
| master_resume_version | id, user_id, version, kind (import, session, ai, before_restore), session_id, data, created_at | the latest 50; older pruned nightly |
| resume_import | id, user_id, status, source_kind (pdf, docx, text), file_name, file_bytes (nullable), text_layer, draft (JSON), flags, model, input_tokens, output_tokens, created_at | file bytes deleted when extraction ends (24 h at most); row deleted on accept or discard, or after 7 days |
| tailored_resume | id, user_id, job_id (set null if the job goes), job_title, company, posting_hash, master_version, status (queued, running, draft, final, failed), content (JSON), model, prompt_version, input_tokens, output_tokens, created_at, updated_at, finalized_at | drafts: 90 days after the last change, at most 3 per job; finals: until the user deletes them or the account |
| resume_file | tailored_resume_id (PK), sha256, bytes, pages, renderer (Typst and template versions), created_at | with its tailored resume |
| resume_settings | user_id, section_order, page_budget, spelling (auto, en-CA, en-US), avoid_phrases, never_claim | until account deletion |

In Postgres that means `jsonb` and `bytea`; in SQLite, JSON text checked with `json_valid` and a BLOB. Estimated sizes: a master or snapshot 10 to 40 KB, a tailored resume 5 to 15 KB, a PDF 15 to 60 KB (an earlier prototype's one-page test was 12.7 KB). So up to about 2 MB of history per user, and about 15 to 60 MB a month of final PDFs at 50 users × 20 applications.

### Cost per call (estimates)

| | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 |
|---|---|---|---|
| Import, 2-page PDF (about 12K in, 8K out with thinking) | $0.21 | $0.10 | $0.005 |
| Tailored resume (about 9K in, 4K out) | $0.12 | $0.06 | $0.003 |
| Month: 50 users × 20 builds, plus 30% regenerations | about $150 | about $75 | about $4 |

US-only inference adds 10%. Caching the prompt and master saves little, because output dominates.

### Per backend language
- **Python**: Pydantic models produce the JSON Schema and validate replies through the SDK's `messages.parse()`. typst-py renders in-process; pypdf and mammoth read uploads; python-docx comes later.
- **TypeScript**: Zod 4.6 schemas are shared with the Next.js app. The Typst 0.15.1 CLI runs as a subprocess, since typst.ts is a minor version behind. unpdf and mammoth read uploads; docx comes later.
- **Go**: structs with a generated JSON Schema. The Typst CLI runs through `os/exec`, ledongthuc/pdf reads the text layer, and DOCX is read with `archive/zip` and `encoding/xml`. DOCX output would need pandoc (GPL-2.0, run as a separate program); Go writers weren't checked (UNVERIFIED).

## Later, and what would trigger it

| Addition | Trigger |
|---|---|
| DOCX export | A user needs Word for an application |
| JSON Resume 1.7 import and export | A user arrives with one or wants to leave with one |
| More templates (sans serif, experience first) | Users ask; each must pass the text-order check |
| Stretch mode, gap bullets listed as "be ready to discuss" | The owner approves |
| Cover letters under the same checks | The owner adds them to scope |
| Shortening bullets that spill onto a new line (one call) | Fitting drops lines on most builds |
| A second model judging meaning drift ("helped" becoming "led") | Evals show changes that code checks miss |
| JSON Patch edits and AI suggestions for the master | The first AI feature that edits the master |
| Object storage for final PDFs | PDF bytes pass about 1 GB or the database plan's limit |
| Overnight drafts for every Yes job through the Batch API (50% off) | Users want drafts ready before they look |
| OCR for scanned PDFs | Scanned imports keep failing or getting flagged |
| French resumes (fr-CA) | A user applies in French |
| Merging a re-import into an existing master | Users re-import after big changes |
| LinkedIn export and GitHub project import | Onboarding takes too long |

## Risks
- **Code checks catch invented numbers, names and terms, not changed meaning.** "Helped build" can become "led". Mitigation: the diff on the review screen, the never-claim list, evals on fixture resumes, and a judge later.
- **Job postings are third-party text and can carry instructions.** Mitigation: postings go in as data, the model has no tools, and check 4 blocks terms the sources lack.
- **Import mistakes become facts.** A bullet put under the wrong employer would spread to every build. Mitigation: native PDF input, the text-layer check, and review before saving.
- **The import schema may hit structured-output limits** (24 optional fields, 16 unions, "too complex"). Mitigation: all fields required, `""` instead of null, and splitting into two calls if needed.
- **Typst can hang or fail.** Mitigation: timeouts, a kill, a build deadline, and Typst's own error text in the log.
- **Fonts can lack glyphs** for some names. Four of Reactive Resume's ten releases since 6.0.0 fixed such problems. Mitigation: test names with accents; add a Noto fallback when a user needs one.
- **Renderer drift.** A Typst or template upgrade changes output, so finals keep their bytes and drafts carry the renderer version.
- **Data leaves Canada.** Claude inference runs globally or in the US. The privacy notice must say so.
- **ATS vary.** Advice conflicts (Textkernel on education dates), so never promise an "ATS-proof" resume.

## Questions for the owner
1. Which model for import and tailoring? Default Opus 5.5: about $0.21 per import and $0.12 per tailored resume. Sonnet 5.5 is about half that, and Haiku 5.5 about $0.005 and $0.003. At 50 users × 20 builds a month that comes to about $150, $75 or $4.
2. May each uploaded resume, contact details included, go to Anthropic for import, with processing outside Canada (global or US only)? The alternative strips contact details and sends extracted text, and is less accurate on multi-column files.
3. Is v1 strict only: every line traced to the master, no Stretch mode, and no claim that a resume is "ATS-proof"?
4. Retention: delete uploaded files when the import ends, delete unapproved drafts after 90 days, and keep final PDFs until the user deletes the application or the account. Do you agree?
5. Scope: one Harvard-style template, PDF only (no Word), Letter size. Is that enough for v1?

## Sources
- Claude API: [PDF support](https://platform.claude.com/docs/en/build-with-claude/pdf-support) · [Vision](https://platform.claude.com/docs/en/build-with-claude/vision) · [Files API](https://platform.claude.com/docs/en/build-with-claude/files) · [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) · [Pricing](https://platform.claude.com/docs/en/about-claude/pricing) · [Data residency](https://platform.claude.com/docs/en/manage-claude/data-residency) · [API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention) · [Commercial retention](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)
- Typst: [releases](https://github.com/typst/typst/releases) · [0.14.0](https://typst.app/docs/changelog/0.14.0/) · [0.15.0](https://typst.app/docs/changelog/0.15.0/) · [text](https://typst.app/docs/reference/text/text/) · [typst-py](https://github.com/messense/typst-py) · [typst.ts](https://github.com/Myriad-Dreamin/typst.ts/releases)
- Other renderers: [Playwright page.pdf](https://playwright.dev/docs/api/class-page#page-pdf) · [Gotenberg](https://github.com/gotenberg/gotenberg/releases) · [WeasyPrint](https://doc.courtbouillon.org/weasyprint/stable/first_steps.html) · [react-pdf](https://react-pdf.org/) · [Forme](https://github.com/danmolitor/forme) · [pandoc](https://github.com/jgm/pandoc/releases) · [docx](https://www.npmjs.com/package/docx) · [python-docx](https://pypi.org/project/python-docx/)
- Parsing libraries: [pypdf](https://pypi.org/project/pypdf/) · [pdfplumber](https://pypi.org/project/pdfplumber/) · [PyMuPDF](https://pypi.org/project/PyMuPDF/) · [mammoth](https://pypi.org/project/mammoth/) · [unpdf](https://www.npmjs.com/package/unpdf) · [pdfjs-dist](https://www.npmjs.com/package/pdfjs-dist) · [ledongthuc/pdf](https://github.com/ledongthuc/pdf)
- ATS and guides: [Greenhouse formats](https://support.greenhouse.io/hc/en-us/articles/360052218132) · [Greenhouse failures](https://support.greenhouse.io/hc/en-us/articles/200989175-Unsuccessful-resume-parse) · [Greenhouse FAQ](https://support.greenhouse.io/hc/en-us/articles/43418495049499-MyGreenhouse-FAQ-for-Candidates) · [Textkernel Parse API](https://developer.textkernel.com/tx-platform/v10/resume-parser/api/) · [Textkernel Resume Quality](https://developer.textkernel.com/tx-platform/v10/resume-parser/overview/parser-output/) · [Textkernel formats](https://developer.textkernel.com/TKPlatform/master/file-formats/) · [Lever API](https://hire.lever.co/developer/documentation) · [Harvard master's guide](https://careerservices.fas.harvard.edu/resources/gsas-masters-resume-cover-letter/) · [Harvard college guide](https://careerservices.fas.harvard.edu/resources/create-a-strong-resume/) · [Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)
- Prior art: [Reactive Resume](https://github.com/reactive-resume/reactive-resume) · [its changelog](https://docs.rxresu.me/changelog) · [OpenResume](https://github.com/xitanggg/open-resume) · [its parser](https://www.open-resume.com/resume-parser) · [Resume-Matcher](https://github.com/srbhr/Resume-Matcher) · [JSON Resume schema](https://github.com/jsonresume/jsonresume.org/tree/master/packages/schema) · [@jsonresume/schema](https://www.npmjs.com/package/@jsonresume/schema)
- Storage and law: [PostgreSQL TOAST](https://www.postgresql.org/docs/current/storage-toast.html) · [PIPEDA Principle 5](https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/p_principle/principles/p_use/) · [RFC 6902 JSON Patch](https://www.rfc-editor.org/rfc/rfc6902)
