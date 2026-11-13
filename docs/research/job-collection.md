# Job collection for Instante v1

> **Phase 1 review, 2026-11-12:** an adversarial review changed some recommendations in this note. Where they differ, the ADRs in `docs/decisions/` and `docs/architecture.md` are authoritative; each ADR's "Doubts raised" section says what changed and why.

**Owner's decisions, 2026-11-13:** the catalog is a hand-curated list of boards, not seeded from an earlier catalog. Instante is a personal project for the owner, not a launch; multi-user, beta and 50-person estimates in this note describe the earlier framing and are now upper bounds.

Checked on 2026-11-12. Instante is hosted: its servers fetch postings and show them to many signed-in users, so a source has to allow storing its jobs and showing them to other people, not only personal use. The recommendation is one shared pool that the backend fills on a schedule from two fetched source types: public company boards on Greenhouse, Ashby and Lever (a catalog seeded from Common Crawl's index, plus boards users add) and the Himalayas remote-jobs API. A user can also paste a posting, which stays private to them. A user's search is a filter over the pool, and screening runs on what passes. Only full postings become jobs. SerpApi Google Jobs is the runner-up and waits for the owner (cost and legal risk). Adzuna waits for a licence. Indeed, LinkedIn, Job Bank, Workday career sites, Remotive and We Work Remotely are ruled out by their terms.

## Question

- Which sources are legal and practical for a hosted, multi-user product in v1, and what changes compared with a local single-user app?
- One shared pool or per-user fetching? How does a user add a company? How is a catalog of Canadian boards seeded and refreshed?
- Cadence, conditional requests, politeness, failures, closing and retention.
- Canonical fields, description format, places, de-duplication, staffing agencies and aggregators.
- The smallest useful v1, what it stores, and what comes later.

## Options compared

| Option | Verdict | Why |
|---|---|---|
| Public boards: Greenhouse, Ashby, Lever | recommended | No key, documented, every job's full text in one call, 304 when unchanged. 468 of the 808 Canadian boards an earlier crawl found. |
| Himalayas API | recommended | Full HTML, free key (10,000 requests a day), commercial use allowed with credit and its apply link. About 8,000 jobs open to Canada. |
| Pasted posting, private to the user | recommended | Covers jobs the pool can't reach (LinkedIn, Workday) without fetching anything. |
| One shared pool filled on a schedule | recommended | One fetch serves every user; user settings never change what is fetched. |
| Per-user fetching | rejected for v1 | Requests grow with users. Only pasted postings are per-user. |
| SmartRecruiters, Workable, BambooHR, Recruitee, Personio, Teamtailor | later | Keyless feeds undocumented, or one extra call per job; low yield in an earlier prototype. |
| SerpApi Google Jobs | runner-up | Reaches employers on Workday, iCIMS and job boards. Starter ($25 a month) refreshes about 33 role-and-city pairs a day, Developer ($75) about 165. Google's suit against SerpApi isn't over; the text comes from sites whose terms forbid scraping. |
| Adzuna | later | 500-character snippets. A hosted service is outside its personal job search use, so it needs Adzuna's branded ads or a licence. |
| Jobicy, RemoteOK | later | Free, full text, commercial use with credit; remote only, mostly US or worldwide. |
| JSearch | later | Same Google for Jobs data as SerpApi; prices UNVERIFIED. |
| TheirStack, Coresignal | rejected for v1 | Pay per job ($49 for 1,500 at TheirStack). About 60% of TheirStack's jobs come from Indeed and LinkedIn; its terms bar products where its data is the main value. |
| Remotive | rejected | Its terms forbid showing its jobs to collect sign-ups, which an account-based app does; 24-hour delay. |
| We Work Remotely | rejected | API terms forbid storing its data (UNVERIFIED, see Findings). |
| The Muse, Arbeitnow | rejected | The Muse: mostly US companies, links to its own pages (measured 2026-10-26; its site refused our fetch). Arbeitnow: Europe. |
| Indeed, LinkedIn, Glassdoor, Job Bank, Workday career sites | rejected | Terms forbid automated access. |
| Description stored as Markdown | recommended | Renders safely with react-markdown and is compact for the AI. Sanitized HTML needs a sanitizer on every render path; plain text loses lists. |
| De-duplication by company in v1 | recommended | A company whose board Instante reads comes from that board only. Matching single postings across sources waits for a second search source. |

## Findings

### Company boards

- Greenhouse: GET endpoints need no authentication; `content=true` adds the full description; pay ranges need the single-job call with `pay_transparency=true`; no rate limits or terms are stated ([docs](https://docs.greenhouse.io/job-board.html); the old developers.greenhouse.io address now answers 301 to it, checked 2026-11-12). Measured on one 214-job board: 164 KB without content, 3.05 MB with it, a weak ETag, and `If-None-Match` answered 304 with 0 bytes. The list now carries `first_published` and `company_name`; `content` is entity-encoded HTML.
- Lever: "These jobs may be scraped by third parties." ([postings-api](https://github.com/lever/postings-api)). Global and EU hosts, `skip` and `limit`, `workplaceType` of `unspecified`, `on-site`, `remote` or `hybrid`, optional `salaryRange`. Measured: `api.lever.co/robots.txt` allows everything with `Crawl-delay: 1`; ETag and 304 work; one board was 5.9 MB; `createdAt` (ms) is present though undocumented.
- Ashby: `GET api.ashbyhq.com/posting-api/job-board/{name}`, no credentials, `includeCompensation=true`, `isListed=false` means direct link only, `publishedAt` is the last publication, no rate limits stated ([docs](https://developers.ashbyhq.com/docs/public-job-posting-api)). Measured: an 827-job board was 14.6 MB; ETag and 304 work; `Cache-Control: max-age=60`; each job carries `shouldDisplayCompensationOnJobPostings`.
- No board API grants a licence to aggregate; each posting is its employer's text. Greenhouse's docs state no terms, and a search found none.
- SmartRecruiters' docs describe its Posting API with an API key or OAuth ([docs](https://developers.smartrecruiters.com/docs/posting-api)), yet the per-company list still answered without one, with an ETag. Full text needs one call per posting.
- Recruitee's own pages disagree on whether its careers API needs a token (UNVERIFIED). Personio documents its XML feed for a company's own jobsite ([docs](https://developer.personio.de/docs/retrieving-open-job-positions)).

### Remote-job feeds

- Himalayas: 20 jobs a request; a free key gives 60 a minute and 10,000 a day; data refreshes every 24 hours; a single-job check answers 200, 410 (closed) or 404 ([API docs](https://himalayas.app/docs/remote-jobs-api)). Its API terms (current 2026-11-12) allow personal and commercial use, on sites and apps you operate only, with Himalayas named as the source, every Apply through `applicationLink`, caching, removing jobs once they expire, and no passing jobs to other boards, aggregators, Google Jobs or JobPosting markup ([terms, clause 113](https://himalayas.app/terms#api)). `pubDate` is the last update in Unix seconds; an empty `locationRestrictions` means worldwide ([data dictionary](https://himalayas.app/docs/data-dictionary)).
- Measured on Himalayas: `search?country=CA` holds 8,013 jobs of all occupations ("software engineer": 1,223); the whole feed holds 120,111. `applicationLink` now points at Himalayas's own job page, so it no longer names the employer's board. `locationRestrictions` came back as country names, not the objects the dictionary describes. 9 of the first 20 Canadian results came from talent marketplaces or aggregators. Responses send `Last-Modified` and no ETag.
- Remotive: 24-hour delay, about 4 calls a day, more than 2 a minute blocked, credit and link back, no submitting to other sites; showing its jobs to collect sign-ups or emails breaches its terms ([repo](https://github.com/remotive-com/remote-jobs-api)).
- Jobicy: no key, commercial use allowed, credit Jobicy, Apply links go to Jobicy, only the last 7 days, a status check for up to 100 jobs, sync at most hourly ([docs](https://jobicy.com/jobs-rss-feed)).
- RemoteOK: link back with a followed link and credit Remote OK ([API](https://remoteok.com/api)). Some descriptions were cut off or held template placeholders.
- We Work Remotely: its API terms forbid saving or storing its data and building a competing service ([terms](https://weworkremotely.com/api-terms-and-guidelines)). UNVERIFIED: the page refused our fetch; read through a search summary.

### Search APIs and paid data

- Adzuna returns only a snippet of each description ([search docs](https://developer.adzuna.com/docs/search)). Its free uses are personal job search, publishing Adzuna's ads, salary estimates and personal or academic research; commercial analysis, resale and lead generation need a written agreement; each ad is labelled Adzuna (at least 116 x 23 px, linked); all Adzuna data goes when access ends; limits now show only in the account ([terms](https://developer.adzuna.com/docs/terms_of_service)).
- SerpApi: Free 250 searches a month, Starter $25 for 1,000, Developer $75 for 5,000, Production $150 for 15,000; only successful searches count; its Legal Shield starts at Production ([pricing](https://serpapi.com/pricing)). Google Jobs gives 10 results a page, `next_page_token`, a 1-hour cache; `ltype` and `chips` are deprecated ([docs](https://serpapi.com/google-jobs-api)). Its terms forbid reproducing or reselling the service without permission; the Legal Shield covers collecting the data, not using it, and only in US courts ([terms](https://serpapi.com/legal), 2026-08-27). Google sued SerpApi on 2025-12-19; the DMCA claims were dismissed on 2026-07-20, partly with leave to amend ([PPC Land](https://ppc.land/google-loses-dmca-bid-to-treat-search-scraping-like-dvd-piracy/)).
- JSearch reads Google for Jobs, which draws on LinkedIn, Indeed, Glassdoor and ZipRecruiter ([OpenWeb Ninja](https://www.openwebninja.com/api/jsearch)). Third-party pages give 100 to 200 free requests a month and $25 for 10,000 (UNVERIFIED).
- TheirStack: 200 free credits a month, $49 for 1,500, 1 credit per job, 4 requests a second ([pricing](https://theirstack.com/en/pricing)); 40% of its jobs come from Indeed and 19% from LinkedIn ([sources](https://theirstack.com/en/docs/data/job/sources)); display is allowed, but not in a product where its data is the main value, and datasets go within 30 days of the contract ending ([terms](https://theirstack.com/en/docs/legal/terms-and-conditions)). Coresignal starts at $49 a month, 1 credit per posting ([pricing](https://coresignal.com/pricing/)).

### Closed by their terms

- LinkedIn bans software, scripts and robots that scrape or copy the service ([User Agreement 8.2](https://www.linkedin.com/legal/user-agreement), effective 2025-11-03).
- Indeed bans bots, scrapers, spiders and AI that access or data-mine the site, and licenses job seekers for personal, non-commercial use ([terms](https://www.indeed.com/legal), updated 2026-09-29).
- Job Bank bans scripts, robots, crawlers, scrapers, automated query programs and AI ([terms](https://www.jobbank.gc.ca/termsofuseseeker), modified 2026-09-24). Its XML partnership needs an active Canadian Business Number and a board with many Canadian postings ([network](https://www.jobbank.gc.ca/network)).
- Workday's site terms ban data mining and robots on its sites and APIs ([terms](https://www.workday.com/en-ca/legal/site-terms.html), 2026-08-13). They don't name `myworkdayjobs.com`, whose career-site API is undocumented. Instante keeps Workday out.

### Finding boards

- The newest Common Crawl index is CC-MAIN-2026-43 (2026-10-05 to 2026-10-18); crawls came monthly from June to October ([collinfo](https://index.commoncrawl.org/collinfo.json)). Its terms grant a limited licence, ask users to respect third parties' rights and not to disrupt the service, and advise legal counsel before any use, commercial included ([terms](https://commoncrawl.org/terms-of-use), 2024-03-07).
- `jobs.lever.co/robots.txt` blocks Common Crawl's CCBot (measured), so Lever boards are under-represented in the index.
- An earlier prototype (2026-10-24) checked 7,549 candidate boards from that crawl and kept 808 with Canadian jobs, holding 11,441 postings: Greenhouse 260, Ashby 164, SmartRecruiters 143, BambooHR 101, Workable 76, Lever 44, Recruitee 19, Personio 1.

### What hosting changes

- Permissions written for personal use (Adzuna's personal job search use, Indeed's job-seeker licence) don't cover a service run for others. Himalayas and Jobicy allow commercial display; Remotive forbids sign-up walls.
- One fetch serves every user, so requests don't grow with users and each board's ETag is shared.
- Credit and apply-link rules become UI rules (Himalayas, Jobicy, RemoteOK).
- Keys stay on the server. Himalayas sends no CORS headers anyway ([API page](https://himalayas.app/api)).
- A server that fetches a URL a user typed is open to server-side request forgery. Accepting only known board hosts avoids it.
- Retention becomes a duty: remove expired Himalayas jobs; delete Adzuna or TheirStack data when a contract ends.
- Costs move to the operator. Search queries built from users' settings would reach a third party (SerpApi); v1's global ingestion sends none.
- The pool holds employers' text, and postings can hold recruiters' names and emails.

## Lessons from earlier work

| Lesson (earlier prototype, 2026-10) | In Instante |
|---|---|
| Snippets can't be judged: of 2,353 stored jobs, 1,506 were Adzuna snippets, too short to hold the requirements; keep full postings only | Same rule |
| Public boards plus ETags make hundreds of boards cheap; quiet boards rest | Same, in a scheduled worker |
| Only a complete, successful answer closes, after two misses in a row; a 304 repeats the last answer | Same, per ADR-006 |
| The catalog comes from Common Crawl's index plus one live check per slug; retry the index's 504s; leave out boards that repost others' jobs | Superseded: the owner chose a hand-curated list of boards |
| Quality is a rule before screening: agencies and aggregators filtered, with a way back | Same, as a company kind plus a per-user switch |
| A job keeps its apply link apart from its identity, never a search page | Same |
| Log every fetch, so each source's yield can be measured | Same log, read as yield per source |
| Map source values exactly: Lever's `on-site` was silently lost | Each adapter tested on recorded answers |
| Adzuna used under its personal job search terms | Doesn't transfer: hosting needs ads or a licence |
| Boards rest when they have nothing for the user; every ETag is forgotten when settings change | Doesn't transfer: the pool keeps all occupations in served places, so user settings never change fetching |
| Himalayas `applicationLink` named the employer's board | No longer true |
| A personal SerpApi key | Becomes the operator's cost and terms |

## Recommendation for v1

### Sources and model

- Fetched: boards on Greenhouse, Ashby and Lever, and Himalayas. Not fetched: postings a user pastes (title, company, link, text), private to that user.
- Served places, a product setting: jobs in Canada, remote jobs open to Canada or worldwide, and jobs whose place can't be parsed. The rest is dropped at ingestion. All occupations are kept.
- One shared pool. A user's search (roles, titles, places, work type, age, agencies shown or not) lives in their settings and filters the pool; screening runs on what passes.
- Which model fits which source: boards and feeds that list jobs whoever asks go to the pool. Search APIs (SerpApi, later) also feed the pool, from one query plan built from the union of users' roles and places under a monthly budget. Per-user fits only pasted postings and any source licensed for personal use with the user's own key.
- Collection uses no AI. Every step is deterministic, so a posting costs nothing until screening picks it.
- Expected size, estimated from an earlier catalog of Canadian boards: about 470 boards and 8,000 Himalayas jobs, so 10,000 to 15,000 open postings, under 100 MB of text and about 2,300 requests a day.

### The flow

1. Seed: a backend command reads the newest Common Crawl index for the three board hosts, checks each slug once on its API and stores boards with postings in served places (`origin = catalog`). It runs after each new crawl, about monthly.
2. A worker wakes every minute and takes due sources (`next_fetch_at` passed), within per-host limits.
3. It sends a conditional GET with the stored ETag or Last-Modified. A 304 marks the source's open postings seen. *(Superseded in the phase 1 review: a 304 repeats the last complete answer, so postings missing from it get another miss; see ADR-006.)*
4. A 200 goes through the source's adapter into canonical postings. Postings outside served places are dropped; unlisted Ashby jobs are skipped.
5. Upsert by (source, external id). A new row gets `first_seen_at`; a seen row `last_seen_at`; a changed content hash updates the text and `changed_at`, so screening runs again for users who haven't acted on it.
6. Close: a complete answer that lacks an open posting for the second time in a row closes it. Himalayas postings also close at `expiryDate` or on a 410.
7. New companies get a kind (employer, agency, aggregator). A Himalayas job from a company whose board Instante reads is skipped.
8. Screening reads, per user, the postings first seen or changed since its last run.
9. A daily sweep applies retention.

### Adding a company

1. The user pastes a board or job link. The backend maps known hosts (`boards.greenhouse.io`, `job-boards.greenhouse.io`, `jobs.lever.co`, `jobs.eu.lever.co`, `jobs.ashbyhq.com`) to a kind and slug. Any other host gets a message naming the boards Instante reads. No other URL is ever fetched, so v1 has no request-forgery surface.
2. One request checks the board (Lever: the global host, then the EU one). An empty board is accepted: Lever and Ashby answer the same for "no jobs" and "not a customer".
3. The board joins the shared catalog (`origin = user`), the user follows it, and it is fetched at once.

### Schedule, politeness and failures

- Boards with postings in served places: every 6 hours, spread by jitter. Boards without: weekly. Himalayas: one walk of `search?country=CA` a day, about 400 requests at 1 per 1.5 s, with the key.
- At most 4 requests in flight per host and 16 in all; at most 1 a second to `api.lever.co`, its Crawl-delay.
- Timeouts of 10 s to connect and 60 s in all; bodies over 50 MB are refused.
- Up to 3 tries for network errors, 5xx and 429, honouring Retry-After; no retry on other 4xx. Repeated failures back off to daily and show on an admin page.
- Three 404s in a row mark a board gone and close its postings.
- User-Agent `Instante/<version>` with a project URL or role address, never a personal one.

### Lifecycle and retention

- Disappearing is the signal: employers expire a filled job by removing it (404 or 410) or giving it a past `validThrough` ([Google JobPosting](https://developers.google.com/search/docs/appearance/structured-data/job-posting)), and boards drop it from their list.
- States: open, changed, closed, reopened (a closed posting that comes back).
- Only a complete 200 can close. Failures, partial reads, 429s and 304s close nothing. *(Superseded in the phase 1 review: a 304 counts as a repeat of the last complete answer, and three 404s in a row mark a board gone and close its postings; see ADR-006.)*
- A closed posting leaves the pool at once. Its row goes 30 days later unless a user saved, applied to or built from it; then it stays while that user's record does. Only the latest raw payload is kept, and it goes at close.
- Fetch log: 30 days. Gone boards: deleted after 90 days. Pasted postings: until the user deletes them or the account.

### Normalization

| Canonical field | Greenhouse | Lever | Ashby | Himalayas |
|---|---|---|---|---|
| external id | `id` | `id` | `id` | `guid` |
| title | `title` | `text` | `title` | `title` |
| company | `company_name` | catalog | catalog | `companyName` |
| places | `location.name`, `offices` | `categories.allLocations`, `country` | `location`, `secondaryLocations`, `address` | `locationRestrictions` (empty = worldwide) |
| work type | parsed from the place | `workplaceType` | `workplaceType` | remote |
| pay | single-job call (later) | `salaryRange` | `compensation`, only if `shouldDisplay...` is true | `minSalary`, `maxSalary`, `currency`, `salaryPeriod` |
| posted | `first_published` | `createdAt` (ms) | `publishedAt` (last published) | `pubDate` (last update) |
| text | `content` (entity-encoded) | `description`, `lists`, `additional` | `descriptionHtml` | `description` |
| apply | `absolute_url` | `hostedUrl` | `jobUrl` | `applicationLink`, unchanged |

- Description: the HTML is converted once to Markdown and capped at about 50,000 characters. The frontend renders it with react-markdown, which shows no raw HTML by default; `rehype-raw` is for trusted input only ([README](https://github.com/remarkjs/react-markdown)). The same Markdown goes to the AI. A hash of it drives "changed".
- Places: a list of {country code, region code, city}, a work type (onsite, hybrid, remote, unknown) and remote countries (`*` for anywhere). Rules cover Canadian provinces and territories by name and code, country names and codes, and phrases such as `Remote`, `Anywhere` and `North America`. Anything else is kept raw and marked unknown.
- Pay: structured where the list gives it; text parsing later. Ontario has required the expected pay or a pay range in public postings from employers with 25 or more staff since 2026-01-01 ([Hicks Morley, law-firm summary](https://hicksmorley.com/2025/12/16/new-year-new-rules-ontario-job-posting-requirements-take-effect-january-1-2026/)), so Canadian text increasingly holds one.
- Dates: `posted_at` comes from the source when it means first publication (Greenhouse, Lever); otherwise it is the earlier of the source date and `first_seen_at`.

### De-duplication and quality

- Same source: unique (source, external id).
- Across sources in v1: a Himalayas job is skipped when its normalized company has a board Instante reads, since the board lists that company's jobs in full. Company names are normalized (case, punctuation, Inc, Ltd, LLC, Corp), with an alias table.
- Later, with a second search source: links mapped to (board kind, slug, job id) first, then the same company, titles at least 0.9 alike and a compatible place, confirmed by text overlap. The board's copy wins.
- Each company has a kind: employer, agency or aggregator. A seed list of known staffing firms and aggregators, plus a rule (staffing or recruiting words in the name with `our client` in the text), proposes the kind; the owner confirms it on the admin page. Users don't see agencies and aggregators unless they switch them on. Catalog boards that repost other companies' jobs are left out.

### What to store

| Table | Key fields | Retention |
|---|---|---|
| `company` | id, name, normalized_name (unique), kind, kind_set_by | while referenced |
| `source` | id, kind, slug (unique with kind), company_id, origin, added_by, status, etag, last_modified, next_fetch_at, last_ok_at, failures, not_found_count, served_count | gone boards: 90 days |
| `job_posting` | id, source_id (null when pasted), external_id (unique with source), owner_user_id (null = pool), company_id, title, canonical_url, apply_url, via, description_md, content_hash, places, work_type, remote_countries, employment_type, pay fields, language, posted_at, first_seen_at, last_seen_at, changed_at, closed_at, miss_count, raw | closed: 30 days unless referenced; raw until close; pasted: until deleted |
| `source_follow` | user_id, source_id, created_at | with the account |
| `fetch_log` | source_id, started_at, duration_ms, requests, status, not_modified, bytes, items, new, changed, closed, error | 30 days |

### Frontend and backend

- Backend API: list and read pool postings through the user's filters with server-side paging; paste a posting; add or unfollow a board; admin views of source health and company kinds.
- Backend worker: scheduler, adapters, normalizer, closer, retention and the catalog command. A run can take several minutes, so it needs a long-running process, or runs split by source; the hosting choice has to allow one.
- Frontend (Next.js with shadcn/ui): job list and detail, the "Add a company" dialog, the user's companies, the admin page, the Himalayas credit and the Apply link. It calls only the backend, never a source, and holds no key.

### Per backend language (versions checked on PyPI, npm and GitHub, 2026-11-12)

- Python: httpx 0.28.1 (last release 2024-12-06) with asyncio semaphores per host; markdownify 1.2.3; RapidFuzz 3.14.6.
- TypeScript: built-in fetch with a small per-host limiter; turndown 7.2.5 with a server-side DOM (which one UNVERIFIED); fastest-levenshtein 1.0.16 (no release since 2022-08) or a few lines of own code.
- Go: net/http with semaphores from golang.org/x/sync; JohannesKaufmann/html-to-markdown v2.5.2; Levenshtein in a few lines.

## Later, and what would trigger it

| Addition | Trigger |
|---|---|
| SerpApi Google Jobs, with board discovery from its links and matching of single postings | The owner approves the cost, or users' target employers sit on Workday, iCIMS or job boards |
| SmartRecruiters, Workable, BambooHR, Recruitee adapters | The catalog shows enough boards with postings at users' roles, or users paste such links often (logged) |
| Careers pages on company domains (find the embedded board) | Users paste company domains often; needs a fetcher safe against request forgery |
| Probing slugs for Himalayas companies without a known board | Many Himalayas jobs at users' roles come from companies whose board Instante doesn't read |
| Pay from Greenhouse's single-job call and from text | Users ask to filter or sort by pay |
| Event history per posting (found, changed, closed, reopened) | Someone needs to know where a posting came from and when it closed |
| Adaptive cadence per board | More than about 5,000 boards, or a cycle no longer fits in 6 hours |
| Jobicy or RemoteOK | Remote coverage open to Canada falls short |
| Adzuna under a licence | A use for counts of who is hiring, and a written agreement |
| A job queue or a second worker | One worker can't finish a cycle within its interval |

## Risks

- Board APIs publish no rate limits or third-party terms; one could add a key or block servers. Each source is a tested adapter, health shows on the admin page, and the pool keeps working with the rest.
- Terms and fields move: an earlier design (2026-10-26) read employers' boards from Himalayas's `applicationLink`, which now opens Himalayas's own page, and Remotive moved domains. Re-read each source's terms every quarter and before adding one.
- Coverage leans to tech companies on Greenhouse and Ashby. Banks, telecoms and governments hire through Workday and Job Bank, out of reach without SerpApi or a paid feed.
- Lever boards are hard to find through Common Crawl, because CCBot is blocked.
- Showing employers' full text to many users rests on no source forbidding it, not on a licence. A takedown address and quick removal reduce the exposure.
- Postings can carry recruiters' names and emails; retention limits how long Instante holds them.
- Aggregators and marketplaces fill about half of Himalayas's top Canadian results; a weak filter floods the pool.
- Skipping Himalayas jobs by company name can drop a job that the board places elsewhere or doesn't list, or keep a copy when the names differ.
- Closing lags by up to two cycles: 12 hours for boards, 2 days for Himalayas.
- Big boards (14.6 MB) and multi-minute runs break under a short serverless time limit.

## Questions for the owner

1. SerpApi Google Jobs: pay $25 a month (Starter, 1,000 searches) or $75 (Developer, 5,000) to reach employers on Workday, iCIMS and job boards, knowing its text comes through Google and Google's suit against SerpApi isn't over? Or leave it for a later version?
2. Himalayas: create a free API key for Instante and accept its API terms (credit on every job, Apply through its link, no passing jobs on)?
3. Show employers' full posting text to signed-in users, with the source, a link and a takedown address? The alternative is a summary and a link; screening would still read the full text.
4. Adzuna: leave it out of v1, or ask Adzuna for a licence? A hosted service needs its branded ads or a written agreement.
5. Pasted postings, private to the user: in v1?
6. Served places are Canada plus remote roles open to Canada or worldwide. Add on-site US jobs?
7. Boards a user adds join the shared catalog for everyone. Agreed?
8. Build the catalog with Instante's own run over Common Crawl, or import an earlier catalog of public board slugs once as a head start? Superseded: the owner chose a hand-curated list.

## Sources

- Company boards: https://docs.greenhouse.io/job-board.html, https://github.com/lever/postings-api, https://developers.ashbyhq.com/docs/public-job-posting-api, https://developers.smartrecruiters.com/docs/posting-api, https://developer.personio.de/docs/retrieving-open-job-positions
- Remote feeds: https://himalayas.app/api, https://himalayas.app/docs/remote-jobs-api, https://himalayas.app/docs/data-dictionary, https://himalayas.app/terms#api, https://github.com/remotive-com/remote-jobs-api, https://jobicy.com/jobs-rss-feed, https://remoteok.com/api, https://weworkremotely.com/api-terms-and-guidelines, https://www.arbeitnow.com/blog/job-board-api
- Search and paid data: https://developer.adzuna.com/docs/terms_of_service, https://developer.adzuna.com/docs/search, https://serpapi.com/pricing, https://serpapi.com/google-jobs-api, https://serpapi.com/legal, https://ppc.land/google-loses-dmca-bid-to-treat-search-scraping-like-dvd-piracy/, https://www.openwebninja.com/api/jsearch, https://theirstack.com/en/pricing, https://theirstack.com/en/docs/data/job/sources, https://theirstack.com/en/docs/legal/terms-and-conditions, https://coresignal.com/pricing/
- Terms that close sources: https://www.linkedin.com/legal/user-agreement, https://www.indeed.com/legal, https://www.jobbank.gc.ca/termsofuseseeker, https://www.jobbank.gc.ca/network, https://www.workday.com/en-ca/legal/site-terms.html
- Discovery, fields and display: https://index.commoncrawl.org/collinfo.json, https://commoncrawl.org/terms-of-use, https://developers.google.com/search/docs/appearance/structured-data/job-posting, https://hicksmorley.com/2025/12/16/new-year-new-rules-ontario-job-posting-requirements-take-effect-january-1-2026/, https://github.com/remarkjs/react-markdown
- Packages: https://pypi.org/project/httpx/, https://pypi.org/project/markdownify/, https://pypi.org/project/RapidFuzz/, https://www.npmjs.com/package/turndown, https://www.npmjs.com/package/fastest-levenshtein, https://github.com/JohannesKaufmann/html-to-markdown
- Live measurements on 2026-11-12: single requests from a terminal to public boards, Himalayas and robots.txt files (headers, sizes, conditional requests).
