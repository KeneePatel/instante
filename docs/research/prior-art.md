# Products and open-source prior art

> **Phase 1 review, 2026-11-12:** an adversarial review changed some recommendations in this note. Where they differ, the ADRs in `docs/decisions/` and `docs/architecture.md` are authoritative; each ADR's "Doubts raised" section says what changed and why.

**Owner's decisions, 2026-11-13:** Opus is excluded by the owner; Sonnet 5.5 first, Haiku 5.5 where its eval passes. Instante is a personal project for the owner, not a launch; multi-user, beta and 50-person estimates in this note describe the earlier framing and are now upper bounds.

Checked on 2026-11-12. The question: how do existing job-search products and open-source projects handle the master resume, job collection, match scores, tailoring and tracking, what do their users praise and complain about, and what should Instante v1 take, defer or avoid? Recommendation: build the narrow loop that an earlier prototype tested and that the most-starred open-source tool checked (career-ops) mostly shares (its AI gives the score, and it can fill ATS forms; see Fact-check). That loop is one structured master resume, a shared pool of full postings, screening where the AI finds evidence and code computes the verdict, an inbox to decide, strict tailoring that cites the master resume line by line, and an Applied table. Leave out auto-apply, autofill and a browser extension. They draw many of the worst complaints (wrong answers on forms, invented details, jobs already closed) and clash with platform terms. Don't make a keyword match percentage the headline; show each requirement with its evidence. Keep Instante free for job seekers: Nova Scotia and British Columbia ban charging job seekers for finding work or for information about employers who are hiring, and Ontario bars recruiters from charging foreign nationals on immigration or temporary worker programs and licenses recruiters who charge a fee. This is not legal advice.

## Question

- How do products store a profile or master resume, collect jobs, score matches, tailor and track? What do they cost?
- What do users praise and complain about, especially invented facts, spammy auto-apply and opaque scores?
- Which open-source projects are worth learning from (stack, data model, storage, PDF rendering, licence, activity)?
- What did an earlier prototype show, and what carries over to a hosted app with accounts?
- Which provincial laws matter if Instante ever charges job seekers?

## Options compared

| Option | Verdict | Why |
|---|---|---|
| Evidence per requirement, verdict computed by code (career-ops labels each requirement's weight, but its AI gives the 1 to 5 score from rules in its prompts, [ARCHITECTURE.md](https://github.com/career-ops-hq/career-ops/blob/main/ARCHITECTURE.md)) | recommended | Users can check it. Fixed rules give the same answer every time. |
| Strict tailoring from a structured master resume, verified in code, shown as a diff (Tsenta's Honest level, Resume-Matcher) | recommended | Invented details recur in reviews, and recruiters catch them at the phone screen. |
| Inbox of jobs to decide, then build, then mark applied | recommended | One action per decision keeps a daily inbox quick to work through. |
| Applied as a sortable table (Simplify list, Teal grid) | recommended | Over 90% of applications never move past Applied. A board of cards becomes unwieldy as they pile up. |
| Paste a job link or text (Reactive Resume, career-ops, Resume-Matcher) | recommended | Covers boards the pool can't read without fetching them (see `job-collection.md`). |
| Keyword match percentage as the headline score (Jobscan, Teal, Simplify, Huntr) | rejected | Simplify and Teal say it isn't an ATS score, and ignoring keywords raises Teal's. Recruiters say keyword-stuffed AI resumes have made it a weak signal. |
| Browser extension that saves the page you're on (Teal, Huntr, Simplify) | later | A second codebase to maintain, and LinkedIn's rules ban extensions that scrape. Pasting covers v1. |
| Autofill on employer forms (Simplify, Huntr, Careerflow) | later | Reviewers report wrong answers, blank fields and sites where it fails. |
| Auto-apply (LazyApply, JobCopilot, AIApply, Simplify Autopilot, Tsenta Power, AIHawk) | rejected | The two lowest Trustpilot scores in the set. It sends eligibility answers the user never saw, and adds to the flood recruiters complain about. |
| Scraping LinkedIn or Indeed (JobSpy, JobFunnel) | rejected | Terms forbid it. hiQ had a $500,000 judgment entered against it. JobFunnel was archived when boards added bot defences. |
| Fork Reactive Resume | rejected | MIT, but React SPA plus Hono, not Next.js plus a separate backend, and far more scope than v1. Borrow ideas only. |
| JSON Resume as the export and import format | recommended | Reactive Resume imports it. As the storage format it falls short: bullets have no ids to cite. |
| Many templates and a design editor (Reactive Resume, Kickresume, Enhancv) | later | One ATS-safe template is enough to test the loop. |
| Paid plan (weekly plans, credits) | later | Billing and refund complaints are common, and provincial fee bans apply. See legal flags. |

## Findings

### Products: builders and trackers

| Product | Master resume or profile | Collection | Match score | Tailoring | Tracking | Price (USD) |
|---|---|---|---|---|---|---|
| [Teal](https://intercom.help/tealhq-9a9274919b13/en/articles/9530153-teal-vs-teal) | One work history shared by all resumes; each resume shows or hides bullets (UNVERIFIED: help site blocks fetching) | Extension saves a job from any page since 2025-05 ([help](https://intercom.help/tealhq-9a9274919b13/en/articles/11266917-new-chrome-extension-updates-may-2025)) | Keyword match; free shows the top 5 keywords | AI bullets, summaries and letters on credits (5, 2 and 2 free) | Unlimited, free | Free; Teal+ $13/wk, $29/mo, $79/qtr, $179/yr |
| [Huntr](https://huntr.co/pricing) | Unlimited base resumes; 2 job-tailored resumes free | Job clipper extension; autofill free | Keyword match score ([help](https://help.huntr.co/en/articles/11030569-keyword-extraction-matching)) | AI tailoring on Pro | Board, list and map; 100 jobs free | Pro $40/mo, $90/qtr, $160/6 mo |
| [Simplify](https://help.simplify.jobs/articles/5623502-whats-included-in-simplify-features-and-pricing) | Profile plus uploaded resumes; each tailored copy is kept apart from its source ([help](https://help.simplify.jobs/articles/0515607-tailor-your-resume-with-copilot)) | Autofill on 100,000+ career sites, free ([site](https://simplify.jobs/)) | Resume Score plus Keyword Match | AI rewrites need Simplify+ | Free tracker; Gmail integration | Simplify+ $19.99/wk, $39.99/mo, $89.99/3 mo |
| [Careerflow](https://www.careerflow.ai/pricing-page) | 1 resume free | Extension and autofill, limited free | ATS score and keyword analyzer, paid | AI resumes, paid | Board | Premium $8.99/wk, $23.99/mo, $54.99/qtr, $172.99/yr; Plus $44.99/mo |
| [Jobscan](https://www.jobscan.co/blog/jobscan-vs-teal/) | Upload a resume, paste a posting | Not checked | Match rate; Jobscan says aim for 75%+ | AI Optimize, limited free | Not checked | A few free scans a month; $49.95/mo or $89.95/qtr (UNVERIFIED: [review](https://www.weekday.works/post/jobscan-review), plan page needs JavaScript) |
| [Rezi](https://www.rezi.ai/pricing) | 1 resume free | None listed | Rezi Score, keyword targeting | AI writer | None listed | Pro $29/mo; lifetime $149 |
| [Kickresume](https://www.kickresume.com/en/pricing/) | Builder | Job board and tracker listed, plan unclear | ATS checker compares against resumes in its own database | AI writer from a job title and job ad | Listed | Premium $24/mo, $54/qtr, $96/yr; free for verified students |
| [Enhancv](https://help.enhancv.com/other/why-upgrade-to-pro) | Up to 300 resumes and letters on Pro | Extension and tracker listed, plan unclear | ATS check against a posting | Content suggestions | Listed | Pro about $24.99/mo (UNVERIFIED: [listing](https://frontdeskreview.com/software/resume-builders/enhancv), pricing page rendered no numbers) |

### Products: agents that apply for you

| Product | Collection | Review before sending | Tailoring | Price (USD) | Trustpilot |
|---|---|---|---|---|---|
| [Tsenta](https://tsenta.com/) | Watches 50,000+ career pages on 30+ ATSs; paste a URL; extension, chat apps, MCP | Per role, except Auto Apply on the Power plan | Off, Honest or Aggressive; diff review unless auto-approved | 25 applications free; $19, $39 or $99 for 600, 1,500 or 4,500 per 30 days | Not checked |
| [JobCopilot](https://jobcopilot.com/pricing) | Up to 20 or 50 matches a day | Optional, by saving applications for review | On the Elite plan | About $0.93 or $1.05 a day | 1.7 of 5, 100 reviews ([page](https://ca.trustpilot.com/review/jobcopilot.com)) |
| [AIApply](https://aiapply.co/pricing) | Job board | Not stated | AI resume and letters on Premium | Premium about $29/mo; 100 apply credits about $49 (UNVERIFIED: [review](https://careery.pro/blog/ai-job-search/aiapply-review)) | 4.3 of 5, 2,210 ([page](https://ca.trustpilot.com/review/aiapply.co)) |
| [LazyApply](https://lazyapply.com/pricing) | Greenhouse, Dice, Indeed, ZipRecruiter | Not stated | None stated | $99, $149, $999 a year for 15, 150, 1,500 a day; Gmail account required | 2.1 of 5, 110 ([page](https://ca.trustpilot.com/review/lazyapply.com)) |
| Simplify Autopilot | Not checked | No; Copilot is the reviewed path | As Simplify+ | 20 credits a week in Simplify+ | 2.7 of 5, 22 ([page](https://ca.trustpilot.com/review/simplify.jobs)) |
| [Jobright](https://jobright.ai/) | Claims 8M+ jobs and 400K new a day; sources not named | Not stated | Tailored resume in seconds (own claim) | Not shown | Not checked |

- Every product checked meters AI writing through a paid plan or credits (tables above). The open-source tools instead make users bring their own model key: Reactive Resume, Resume-Matcher, career-ops, JobSync, AIHawk (sources below).

### What users praise and complain about

- Praise is for organisation and speed: one place for applications, the extension that saves a job, and per-job keyword breakdowns (Teal 4.3 of 5, 120 reviews, [page](https://ca.trustpilot.com/review/tealhq.com); Huntr 4.6, 22, [page](https://ca.trustpilot.com/review/huntr.co); Jobscan 4.3, 347, [page](https://ca.trustpilot.com/review/jobscan.co)).
- Invented facts: a JobCopilot reviewer reported fabricated details in their applications (2026-10-12). A recruiter told SHRM that resumes echoing every keyword stand out, and that phone screens expose experience that doesn't match ([SHRM, 2024-07-02](https://www.shrm.org/topics-tools/news/talent-acquisition/ai-written-resumes--use-a-discerning-eye--hiring-managers-advise)).
- Wrong form answers: LazyApply reviewers report yes answers filled in by default on visa and veteran questions, and blank fields. Simplify reviewers report irrelevant text in autofilled fields (Trustpilot pages above).
- Closed or irrelevant jobs: JobCopilot reviewers got roles outside their field and a listing from 2020. AIApply reviewers say credits were spent on removed jobs. A Teal reviewer called its listings mostly ghost jobs.
- Billing: refused refunds, renewals after cancelling and hard cancellation recur at Jobscan, Simplify, JobCopilot, LazyApply and AIApply.
- Stiff AI text: Teal's cover letters and Jobscan's bullets need heavy editing, reviewers say.
- Volume: LinkedIn applications were reported up 45% to about 11,000 a minute, and recruiters say keyword-stuffed AI resumes weaken keyword screening ([Semafor, 2025-06-24](https://www.semafor.com/article/06/24/2025/recruiters-swamped-with-ai-generated-job-applications); the New York Times original not read).
- AIHawk let one person apply to 2,843 roles. The bot answered eligibility questions and wrote generic letters ([404 Media, 2024-10-10](https://404media.co/i-applied-to-2-843-roles-the-rise-of-ai-powered-job-application-bots)). LinkedIn bans third-party software that scrapes or automates its site ([help](https://www.linkedin.com/help/linkedin/answer/a1341387)).
- Lock-in: Sonara shut down on 2024-02-01 and users reportedly lost their application history (UNVERIFIED: competitors' blogs, [example](https://blog.loopcv.pro/what-happened-to-sonara/)). A Huntr reviewer noted tailoring works only on resumes built in Huntr.
- Trustpilot scores are self-selected, and some companies invite reviews, so they compare poorly across products.

### Match scores

- Simplify calls its score "not an employer's ATS score or a prediction of an interview", and warns against adding skills you can't support ([help](https://help.simplify.jobs/articles/2175778-understand-resume-score-and-keyword-matching)).
- Teal's Match Score counts keywords from the posting ([Jobscan's comparison](https://www.jobscan.co/blog/jobscan-vs-teal/)). Ignoring keywords raises it (UNVERIFIED: Teal's help, read through search results).
- Targets differ by vendor: Huntr suggests about 70% keyword coverage ([help](https://help.huntr.co/en/articles/11030569-keyword-extraction-matching)), and Jobscan says to aim for 75% or more (comparison above).
- Resume-Matcher publishes its weights: keywords 40%, skills 20%, title 15%, sections 15%, dates 10%, all in plain code ([README](https://github.com/srbhr/Resume-Matcher)).
- Enhancv asked 25 US recruiters: 92% said their ATS doesn't auto-reject on formatting or content, and about 8% auto-reject on match scores. Knockout questions such as work authorization or location are the common automatic rejections. It's a small vendor study ([Enhancv](https://enhancv.com/blog/does-ats-reject-resumes/)).
- Rewrite-until-it-scores loops make resumes worse, so a match score should be a report, not a target.

### Open source

| Project | What and stack | Resume storage and PDF | Licence and activity | Lesson |
|---|---|---|---|---|
| [Reactive Resume](https://github.com/reactive-resume/reactive-resume) 6.1.0 (2026-11-05) | Builder, tracker and AI assistant. React 19 SPA, Hono on Node 24, Postgres with Drizzle, Better Auth | Each resume is one `jsonb` document. Immutable version rows include AI edits and sent copies. A fact table keeps sources and revisions, and generated text records the fact ids it used. PDFs drawn by Forme; v4 used NestJS, Prisma, MinIO and Browserless (headless Chrome) | MIT; 45.7k stars; pushed 2026-11-12 | A document plus snapshots is enough. Keep sharing and access fields outside the document so an import or restore can't change them. |
| [Resume-Matcher](https://github.com/srbhr/Resume-Matcher) 1.4.0 | Tailoring from a master resume. FastAPI, Next.js, SQLite or Postgres, LiteLLM | markitdown and pdfminer read uploads; Playwright prints PDFs | Apache-2.0; 29.3k; 2026-11-11 | Prompts forbid adding skills, employers or metrics not in the master resume. |
| [career-ops](https://github.com/career-ops-hq/career-ops) | Local agent run from AI CLIs; markdown files, Node scripts | `cv.md` is the master; HTML plus Playwright PDFs | MIT; 82.2k; 2026-11-12 | The AI scores 1 to 5, says when not to apply, checks the posting is still live, never submits, and blocks a PDF whose numbers or facts aren't in the CV. It does have an `apply` mode that fills Ashby, Greenhouse, Lever and Workable forms in Playwright, leaving Submit to the user ([APPLY_AUTOFILL.md](https://github.com/career-ops-hq/career-ops/blob/main/docs/APPLY_AUTOFILL.md)). |
| [OpenResume](https://github.com/xitanggg/open-resume) | Browser-only builder and parser. Next.js 13 | No server; react-pdf; PDF.js parser | AGPL-3.0; 9.0k; last push 2024-10-29 | AGPL code can't go into a closed hosted service without sharing source. |
| [JobSync](https://github.com/Gsync/jobsync) | Self-hosted tracker with AI matching. Next.js 15, shadcn, Prisma | Postgres; pgvector planned | MIT; 1.5k; 2026-11-12 | Started on SQLite and moved to Postgres one way. |
| [RenderCV](https://github.com/rendercv/rendercv) 2.8 | YAML to PDF. Python, Pydantic, Jinja2 | Typst through the `typst` Python package | MIT; 17.9k; 2026-10-31 | Typst renders in-process, no external binary. |
| [JSON Resume](https://github.com/jsonresume/jsonresume.org) schema 1.7.1 | Open resume format, plus a job schema | Bullets (`highlights`) are plain strings without ids | MIT; active 2026-11-07 | Good for export and import, not for citing bullets. |
| [JobSpy](https://github.com/speedyapply/JobSpy) | Scraper for LinkedIn, Indeed, Glassdoor, ZipRecruiter and others. Python | None | MIT; 4.7k; 2026-10-27 | Its README offers proxies to get past blocking. LinkedIn and Indeed terms forbid it (`job-collection.md`). |
| [AIHawk](https://github.com/feder-cr/Jobs_Applier_AI_Agent) | Began as a LinkedIn Easy Apply bot. Now searches 37 public sources, scores 1 to 5, and fills and sends each company's form in Firefox after the user picks. Python | Not checked | MIT; 32.5k; 2026-11-12 | The bot behind the 2024 press coverage now has the user pick jobs before it sends. |
| [JobFunnel](https://github.com/PaulMcInnis/JobFunnel) | Scraped boards into a CSV. Python | None | MIT; archived 2025-12-10 | Archived because boards added anti-bot defences. |

- hiQ lost its scraping fight with LinkedIn on contract: a $500,000 judgment, a permanent injunction, and deletion of its code and data (2022-12-08, [Proskauer](https://newmedialaw.proskauer.com/2022/12/08/hiq-and-linkedin-reach-proposed-settlement-in-landmark-scraping-case/)).
- PDF rendering in prior art comes in three kinds: headless Chrome (Reactive Resume v4, Resume-Matcher, career-ops), a JavaScript PDF library (OpenResume, Reactive Resume v6) and Typst (RenderCV). Per backend language:
  - Python: the `typst` package as RenderCV does, or Playwright.
  - TypeScript: `@react-pdf/renderer`, or Playwright.
  - Go: the Typst CLI as a subprocess, or headless Chrome (UNVERIFIED for resumes).

### What AI costs per unit

Assumed token counts, not measured. Prices from [Anthropic's pricing page](https://platform.claude.com/docs/en/about-claude/pricing) on 2026-11-12. Opus 5.5 can't turn thinking off, and thinking is billed as output ([thinking troubleshooting](https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting), read 2026-11-12: Opus 5.5 rejects `"disabled"`), so the output counts include it.

| Unit | Tokens in / out | claude-opus-5-5 ($4 / $20) | claude-sonnet-5-5 ($2 / $10) | claude-haiku-5-5 ($0.10 / $0.50) |
|---|---|---|---|---|
| Extract one posting's requirements, shared by all users | 2,500 / 1,500 | $0.040 | $0.020 | $0.001 |
| Match one posting to one user | 4,000 / 1,000 | $0.036 | $0.018 | $0.001 |
| Tailor one resume | 8,000 / 4,000 | $0.112 | $0.056 | $0.003 |

- Batch halves input and output prices. Cache hits on Opus 5.5 and Sonnet 5.5 cost 0.05 times the input price (same page).
- Example: 50 active users with 20 matches and 1 build a day, plus 500 new postings extracted, comes to about $62 a day on Opus 5.5 before batch or caching, or about $34 with batch for extraction and matching. Model choice is the owner's.

### Legal flags (not legal advice)

- **Nova Scotia, Labour Standards Code s. 89B** ([statute](https://nslegislature.ca/sites/default/files/legc/statutes/labour%20standards%20code.pdf), consolidated 2025-01-01). No one may charge an individual a fee for finding or trying to find them work in the province, or for information about employers there who are hiring. Assisting is banned too, and s. 89D voids such a fee term. It applies to everyone, not only foreign workers. While Instante is free, it isn't triggered.
- **British Columbia, Employment Standards Act s. 10** ([statute](https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/00_96113_01), current to 2026-11-10). No one may request, charge or receive payment from a person seeking work for obtaining employment or for information about employers seeking employees. Advertisers may be charged, and a payment taken is recoverable as wages. While free, it isn't triggered.
- **Ontario, Employment Protection for Foreign Nationals Act, 2009** ([statute](https://www.ontario.ca/laws/statute/09e32), consolidation from 2023-10-26). Anyone who finds or tries to find employment for an individual acts as a recruiter (s. 2). The Act covers foreign nationals working or seeking work in Ontario under an immigration or temporary foreign worker program (s. 3). Recruiters may not charge them any fee (s. 7). Separately, the Employment Standards Act s. 74.1.2 has required a licence to act as a recruiter since 2024-07-01, and a recruiter is someone who does this for a fee, which Ontario's guide says includes a subscription ([guide](https://www.ontario.ca/document/your-guide-employment-standards-act-0/licensing-temporary-help-agencies-and-recruiters), updated 2026-06-18). While free, neither is triggered.
- What these mean for design: Instante's job feed is information about employers who are hiring, the plainest case the Nova Scotia and BC sections cover. Whether a fee for resume tailoring alone counts as finding work is UNVERIFIED. Other provinces may have similar rules (UNVERIFIED).

## Lessons from earlier work

What transfers to a hosted app with accounts:
- **An inbox of jobs to decide:** one action per decision, and each decision moves the job somewhere visible and reversible (Saved, Skipped). The verdict is a label and a filter, not a tab: a Yes tab sits empty once every Yes has been acted on.
- **Full postings only; links go where the posting lives:** 1,506 of 2,353 stored jobs in an earlier prototype were Adzuna snippets, and they made up most of the Maybes.
- **The AI extracts, code decides.** Profile rules (sponsorship, clearance, languages, level, years) apply before coverage, and the user's own verdict always wins (`product.md`).
- **Strict by default:** one structured master resume with ids, versioned. A verifier rejects claims it can't trace. Stretch is opt-in and flagged.
- **Applied is a table and the board is for interviews.** Silent applications close only after the user confirms.
- **The match score is a report, not a target.** Name, contact details, links and work status are removed before any AI call (`product.md`).
- **Don't build ahead:** sync columns that nothing used and three generations of UI led to a ground-up rebuild. Untouched jobs were archived at 60 days but stayed known, so the same posting wasn't new again.

What doesn't transfer:
- Everything on one machine with the user's own keys. Hosted means the owner pays for AI, keys live on the server, and every row belongs to a user.
- Per-user fetching of about 800 boards, most of which never produce a match. Instante fetches once into a shared pool (`job-collection.md`).
- Single-key desktop shortcuts. On the web, buttons come first, with 44 px targets on phones; keys are an extra on desktop.
- Sidebar sections that grow task by task. Start with five pages.

## Recommendation for v1

Pages:
1. **Master resume.** Import a PDF, DOCX or pasted text. The AI drafts the entries, and the user reviews each one before saving. Every entry and bullet gets a stable id, and skills are Proven or Can discuss. Export as JSON Resume and PDF.
2. **Inbox.** Screened jobs, best first. Each shows the verdict as colour, icon and word, "N of M must-haves shown", each requirement beside the master-resume line that shows it (or "not shown"), and where the job is posted. Actions: Save, Skip, Build, Open posting, Mark applied, and your own verdict. All are reversible. Paste a job link or text from here.
3. **Resumes.** Builds by job: status, PDF preview, each line beside the master bullet it came from, verifier findings, download.
4. **Applied.** A table of company, role, applied date, status, last change, follow-up and notes, scoped Waiting, In progress, Closed and All. After 30 days of silence, offer to close applications as No reply, only after the user confirms.
5. **Settings.** Search (countries, cities, remote, roles, titles, levels, most years asked), eligibility (work authorization, sponsorship, languages, clearance), resume (pages, spelling), and your data (export, delete account). The owner also gets an admin view of sources, fetch health and AI spend.

Flow:
1. **Collect** into the shared pool, full postings only, keeping `apply_url` and `via` (`job-collection.md`).
2. **Filter** in code, per user, at no cost: place, level, title, age, eligibility, agencies, already applied.
3. **Extract** each posting's must-haves and nice-to-haves once, for postings that pass at least one user's filters (`job_analysis`, shared). Batch fits.
4. **Match** per user. The AI maps each requirement to master-resume ids with a short quote, or to none. Code checks the ids exist and the quote appears in them, then computes Yes, Maybe or No (defaults 75% and 50%, set per user). Eligibility facts and contact details never reach the AI.
5. **Build** on request. The AI picks and rewrites bullets, citing ids. Code rejects a line whose numbers, technologies, employers or dates aren't in its cited items, and falls back to the original bullet. The backend renders one ATS-safe template, measures the pages and trims.
6. **Track.** The user applies on the employer's site. Mark applied links the build that was sent. Statuses change by hand.

Split: the Next.js frontend renders pages, forms and previews, and calls only the backend. The backend does fetching, filters, AI calls, the verifier, verdicts, PDF rendering, budgets and storage.

Storage, using the tables in `database.md`:
- Add to `user_job`: evidence per requirement, coverage counts, the user's verdict and decision time.
- Add to `build`: the source ids behind each line, the verifier report, and the template version.
- Add new `application` and `application_event` tables.
- Keep the build JSON as the source of truth, and keep the PDF the user downloaded so the sent file survives template changes.

## Later, and what would trigger it

| Addition | Trigger |
|---|---|
| Extension that saves the page you're on | Users paste many postings from sites the pool can't read, and LinkedIn's rules have been checked |
| Interviews board | Users have several applications at Screen or later at once |
| Cover letters | Users ask, or the jobs they save often require one |
| Stretch mode, opt-in and flagged | Users ask for bullets on Can discuss skills |
| Improve report (what keeps Maybes from Yes) | A user has about 50 Maybe or No verdicts |
| More templates | Users ask; ATS-safe only |
| Status updates from email | Users lose track of many applications; Google's review of mail scopes costs time (UNVERIFIED) |
| Bring your own AI key | AI spend passes what the owner will fund |
| Paid plan | Only after legal advice for Nova Scotia, British Columbia and Ontario |
| Ranking with embeddings | The pool is large enough that per-user AI matching costs too much |

## Risks

- AI spend grows with users times postings. Free filters, shared extraction, batch, caching and a per-user daily cap keep it in bounds.
- The verifier can miss an invented claim that is only reworded. Users see the diff before they download.
- Import mistakes (wrong dates, merged roles) poison screening. Every entry is reviewed before the first screening.
- Users who know tools that apply for them may expect volume. Instante offers fit instead, and the app has to say so.
- Any scraping, extension or autofill risks breaking LinkedIn, Indeed or Workday terms.
- Product prices change often, and several here come from reviews (UNVERIFIED).
- Charging job seekers later could break provincial law or require an Ontario recruiter licence.

## Questions for the owner

1. Scope: leave auto-apply, autofill and the browser extension out of v1?
2. Scope: cover letters in v1, or later?
3. Money: who pays for AI during the beta, which model for each task (table above), and what daily cap per user?
4. Legal and money: keep Instante free for job seekers until a lawyer has reviewed Nova Scotia s. 89B, BC s. 10 and Ontario's foreign nationals and recruiter licensing rules?
5. Third parties: may postings and resume text, without contact details or eligibility facts, go to Anthropic's API? Pasted links outside known boards would need the text pasted, since no page-reading service (Firecrawl, Tavily or Exa, as Reactive Resume uses) is added.

## Sources

- Teal: https://intercom.help/tealhq-9a9274919b13/en/articles/9530153-teal-vs-teal, https://intercom.help/tealhq-9a9274919b13/en/articles/11266917-new-chrome-extension-updates-may-2025, https://ca.trustpilot.com/review/tealhq.com
- Huntr: https://huntr.co/pricing, https://help.huntr.co/en/articles/11030569-keyword-extraction-matching, https://ca.trustpilot.com/review/huntr.co
- Simplify: https://simplify.jobs/, https://help.simplify.jobs/articles/5623502-whats-included-in-simplify-features-and-pricing, https://help.simplify.jobs/articles/0515607-tailor-your-resume-with-copilot, https://help.simplify.jobs/articles/2175778-understand-resume-score-and-keyword-matching, https://ca.trustpilot.com/review/simplify.jobs
- Jobscan: https://www.jobscan.co/blog/jobscan-vs-teal/, https://www.weekday.works/post/jobscan-review, https://ca.trustpilot.com/review/jobscan.co
- Others: https://www.careerflow.ai/pricing-page, https://www.rezi.ai/pricing, https://www.kickresume.com/en/pricing/, https://help.enhancv.com/other/why-upgrade-to-pro, https://frontdeskreview.com/software/resume-builders/enhancv, https://tsenta.com/, https://jobcopilot.com/pricing, https://aiapply.co/pricing, https://careery.pro/blog/ai-job-search/aiapply-review, https://lazyapply.com/pricing, https://jobright.ai/, https://blog.loopcv.pro/what-happened-to-sonara/
- Reviews: https://ca.trustpilot.com/review/jobcopilot.com, https://ca.trustpilot.com/review/aiapply.co, https://ca.trustpilot.com/review/lazyapply.com
- Context: https://www.semafor.com/article/06/24/2025/recruiters-swamped-with-ai-generated-job-applications, https://www.shrm.org/topics-tools/news/talent-acquisition/ai-written-resumes--use-a-discerning-eye--hiring-managers-advise, https://404media.co/i-applied-to-2-843-roles-the-rise-of-ai-powered-job-application-bots, https://enhancv.com/blog/does-ats-reject-resumes/, https://www.linkedin.com/help/linkedin/answer/a1341387, https://newmedialaw.proskauer.com/2022/12/08/hiq-and-linkedin-reach-proposed-settlement-in-landmark-scraping-case/
- Open source (metadata through the GitHub API, 2026-11-12): https://github.com/reactive-resume/reactive-resume, https://github.com/srbhr/Resume-Matcher, https://github.com/career-ops-hq/career-ops, https://github.com/xitanggg/open-resume, https://github.com/Gsync/jobsync, https://github.com/rendercv/rendercv, https://github.com/jsonresume/jsonresume.org, https://github.com/speedyapply/JobSpy, https://github.com/feder-cr/Jobs_Applier_AI_Agent, https://github.com/PaulMcInnis/JobFunnel
- AI prices: https://platform.claude.com/docs/en/about-claude/pricing
- Statutes: https://nslegislature.ca/sites/default/files/legc/statutes/labour%20standards%20code.pdf, https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/00_96113_01, https://www.ontario.ca/laws/statute/09e32, https://www.ontario.ca/laws/statute/00e41, https://www.ontario.ca/document/your-guide-employment-standards-act-0/licensing-temporary-help-agencies-and-recruiters

## Fact-check (2026-11-12)

- career-ops does not fully match the loop. Its AI gives the 1 to 5 score from rules in its prompts, not code ([ARCHITECTURE.md](https://github.com/career-ops-hq/career-ops/blob/main/ARCHITECTURE.md)). It also has an `apply` mode that fills ATS forms and leaves Submit to the user ([APPLY_AUTOFILL.md](https://github.com/career-ops-hq/career-ops/blob/main/docs/APPLY_AUTOFILL.md)). What it shares: paste a link or text, liveness check, never submits, a code check on facts before the PDF, and a tracker. So "career-ops also chose this loop" is only partly true. The recommendation still rests on an earlier prototype's results and on the complaints about auto-apply and autofill, so it holds. Autofill that never submits is a real option others use, which fits its "later" verdict.
- Checked and right: GitHub stars, licences, push dates and releases (GitHub API); JSON Resume `@jsonresume/schema` 1.7.1 with `highlights` as plain strings; Anthropic prices, the 0.05x cache hit rate on Opus 5.5 and Sonnet 5.5, batch at half price, and the cost table's arithmetic; LinkedIn's ban on scraping extensions; the hiQ $500,000 consent judgment; the Trustpilot scores for JobCopilot and LazyApply; Simplify's score wording; Nova Scotia s. 89B and 89D; BC s. 10; Ontario EPFNA s. 7 and ESA recruiter licensing from 2024-07-01, subscription fees included.
