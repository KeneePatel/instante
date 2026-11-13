# Database and storage for v1

> **Phase 1 review, 2026-11-12:** an adversarial review changed some recommendations in this note. Where they differ, the ADRs in `docs/decisions/` and `docs/architecture.md` are authoritative; each ADR's "Doubts raised" section says what changed and why.

**Owner's decisions, 2026-11-13:** PostgreSQL is confirmed. Where it runs (on the app's host or in the Supabase project) is decided with the host in phase 2. Instante is a personal project for the owner, not a launch; multi-user, beta and 50-person estimates in this note describe the earlier framing and are now upper bounds.

Checked on 2026-11-12. Instante needs one place for accounts, a shared pool of tens of thousands of public job postings, each user's screening results, master resume and tailored resumes, a job queue for scheduled ingestion, and a few files. Recommendation: one PostgreSQL 18 database holds all of it in v1. That includes the queue and schedules (a Postgres-backed library in whichever backend language is chosen), full-text search, trigram matching for de-duplication, and uploaded and generated files stored as `bytea`. No Redis, object store, search engine or vector store yet. Local development uses Homebrew's `postgresql@18` (no Docker). Tests run against a real database cloned from a template, and CI uses a Postgres service container. Every managed host compared below runs standard Postgres, so picking one later means a `pg_dump` and a restore.

## Question

Which database, and where do files live, for a multi-user web app with:

- a separate backend API and a background worker, both writing;
- scheduled ingestion into one shared pool of tens of thousands of postings, with fuzzy de-duplication across sources;
- per-user screening results, resumes as structured JSON documents, and generated PDFs;
- full-text search and filters over jobs, and maybe embeddings later;
- at most 50 invited users in v1, one developer, no Docker on the Mac, Canada first.

Sub-questions: is row-level security worth it when only the backend talks to the database? How do tests and CI get a real database? Which queue library fits each candidate language? Which hosts keep doors open? `bytea` or object storage?

## Options compared

| Option | Verdict | Why |
|---|---|---|
| PostgreSQL 18 | recommended | One engine gives relational tables, `jsonb` documents, full-text search, `pg_trgm` similarity, `SKIP LOCKED` queues, `LISTEN/NOTIFY`, and pgvector when embeddings come. Python, TypeScript and Go each have a maintained Postgres queue library. Every host below offers it. |
| SQLite 3.54 + Litestream 0.5 | runner-up | The least to run on one machine. But only one writer at a time, the file must sit on a disk next to both the API and the worker, there's no `SKIP LOCKED` or `LISTEN`, and none of the queue libraries below support it (except River). Moving to Postgres later means a dialect migration. |
| libSQL / Turso Cloud | rejected | Has a Canada region and a 5 GB free tier. But its new engine hasn't reached 1.0, Supabase announced it is buying Turso (2026-10-02), and queue and ORM support is thin. |
| MySQL 9.7 LTS | rejected | No trigram similarity, no `LISTEN/NOTIFY`, `VECTOR` columns can't be keys, and fewer queue libraries. It does nothing better than Postgres for this workload. |
| MongoDB 9.0 / Atlas | rejected | Resumes fit documents, but users × jobs × screenings is relational data. Its SSPL licence isn't OSI-approved, and the Atlas free tier is 512 MB. `jsonb` gives us documents anyway. |
| CockroachDB, PocketBase, Firebase, DuckDB | rejected | Built for multi-region scale, as a second backend, or for analytics. v1 has none of those problems. |
| Files as `bytea` in Postgres | recommended | Files are small and few. One transaction, one backup and one delete cover data and files together. |
| S3 (ca-central-1) or Cloudflare R2 | later | Cheaper per GB, but it's a second system to back up, secure and delete from. |
| MinIO for local object storage | rejected | Its GitHub repository was archived (checked 2026-11-12 through the GitHub API). |
| Anthropic Files API as the file store | rejected | Files belong to the whole API workspace, not to one end user, and stay until someone deletes them. |

## Findings

### PostgreSQL now

- 18.7 is current and supported until 2030-11-14. Version 14 reached end of life on 2026-11-12 ([versioning](https://www.postgresql.org/support/versioning/)). 19 RC 2 shipped on 2026-11-12, and 19 is planned for 2026-11-19 ([RC 2 news](https://www.postgresql.org/about/news/postgresql-187-1712-1616-1520-1425-and-19-rc-2-released-3442/)).
- 18 added `uuidv7()`, asynchronous I/O and skip scan. Generated columns are now virtual by default, so a stored `tsvector` has to say `STORED` ([18 release](https://www.postgresql.org/about/news/postgresql-18-released-3142/)).
- 19 updates the English and French stemmers, so some words get different stems, and makes text search and `pg_trgm` classify characters with the database's locale provider. The notes advise a reindex of text-search and `pg_trgm` indexes and recomputing stored `tsvector`s only after a `pg_upgrade` of a database whose locale provider isn't libc (ICU or builtin) and behaves differently from its `LC_CTYPE`. They give no reindex advice for the stemmer change, but stored `tsvector`s built with old stems can stop matching new query stems, so recomputing them is still the safe step. 19 also makes `NOTIFY` wake only the sessions that listen ([19 notes](https://www.postgresql.org/docs/19/release-19.html), checked 2026-11-12).
- `jsonb` is stored already parsed and can be GIN-indexed. Any update locks the whole row, so each document should be one unit of change ([JSON types](https://www.postgresql.org/docs/current/datatype-json.html)).
- Full-text search uses a GIN index over an expression or a stored generated column. The text search configuration can come from a column, which handles mixed English and French rows. `websearch_to_tsquery` takes raw user input and never raises a syntax error, and `setweight` ranks title matches above body matches ([tables](https://www.postgresql.org/docs/current/textsearch-tables.html), [controls](https://www.postgresql.org/docs/current/textsearch-controls.html)).
- `pg_trgm` gives `similarity()` from 0 to 1, with a default `%` threshold of 0.3, and works with GIN and GiST indexes. It is a trusted extension, so hosts let a normal role create it ([pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html)).
- The docs recommend `SKIP LOCKED` for queue-like tables ([SELECT](https://www.postgresql.org/docs/current/sql-select.html)). A `NOTIFY` payload must be under 8000 bytes. It arrives only after commit and only reaches sessions already listening ([NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html)). Transaction poolers support neither `LISTEN` nor session `SET` ([PgBouncer](https://www.pgbouncer.org/features.html), [Neon pooler](https://neon.com/docs/connect/connection-pooling)).
- pgvector 0.8.7 (2026-10-01) supports Postgres 13 and later. HNSW indexes go up to 2,000 dimensions for `vector` or 4,000 for `halfvec` ([pgvector](https://github.com/pgvector/pgvector), [changelog](https://github.com/pgvector/pgvector/blob/master/CHANGELOG.md)).
- Hosts lag on versions. Neon offers 14 to 18 ([Neon](https://neon.com/docs/postgresql/postgres-version-policy)), RDS has had 18 since 2025-11-14 ([RDS calendar](https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-release-calendar.html)), DigitalOcean offers 15 to 18 ([DO limits](https://docs.digitalocean.com/products/databases/postgresql/details/limits/)), and Fly Managed Postgres offers 16 or 17 ([Fly](https://docs.fly.io/mpg)). Hosted Supabase appears to be on 17, with no announcement of 18 found (UNVERIFIED, [discussion](https://github.com/orgs/supabase/discussions/42681)).

### Row-level security (RLS)

- With RLS on and no policy, no rows are visible. Superusers, `BYPASSRLS` roles and table owners skip policies, unless the table uses `FORCE` ([RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)).
- When everything connects as one backend role, each request has to set the user id inside its own transaction, because a session `SET` breaks behind a transaction pooler ([PgBouncer](https://www.pgbouncer.org/features.html)). The worker screens jobs for every user, so it would need a bypass role or a per-user switch.
- Broken access control is A01 in the OWASP Top 10:2025 ([OWASP](https://top10.owasp.org/2025)), so the risk is real. But when one store layer is the database's only client, a cheaper guard for v1 is a store API that demands a user id plus an isolation test suite.
- On Supabase, tables in exposed schemas can be reached through its Data API. New projects stopped exposing new tables automatically on 2026-05-30 and existing ones on 2026-10-30 ([changelog](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)). The Data API can also be switched off ([hardening](https://supabase.com/docs/guides/database/hardening-data-api)).

### SQLite, libSQL/Turso, Litestream

- SQLite 3.54.1 came out on 2026-10-16 ([sqlite.org](https://www.sqlite.org/index.html)). Its own guidance: one writer at a time, and a client/server engine is better when the data sits across a network from the app or when many writers can't take turns ([when to use](https://www.sqlite.org/whentouse.html)).
- Litestream v0.5.18 came out on 2026-11-03, and releases arrive every few weeks ([releases](https://github.com/benbjohnson/litestream/releases)).
- Turso Cloud's free plan gives 100 databases, 5 GB and a 1-day restore. Developer costs $4.99/month ([pricing](https://turso.tech/pricing)). It runs in aws-ca-central-1 ([regions](https://turso.tech/blog/turso-cloud-new-regions)). Its Rust engine runs in production but hasn't reached 1.0, and libSQL is the older fork ([repo](https://github.com/tursodatabase/turso)). Supabase announced the purchase on 2026-10-02 and says nothing changes for existing users ([Supabase](https://supabase.com/blog/supabase-is-acquiring-turso)).

### MySQL and MongoDB

- MySQL 9.7.0 LTS shipped on 2026-04-21 ([notes](https://dev.mysql.com/doc/relnotes/mysql/9.7/en/news-9-7-0.html)). InnoDB `FULLTEXT` has no similarity scoring ([full-text](https://dev.mysql.com/doc/refman/9.7/en/fulltext-search.html)). A `VECTOR` column can't be a primary, unique or foreign key ([VECTOR](https://dev.mysql.com/doc/refman/9.7/en/vector.html)).
- MongoDB 9.0 was announced on 2026-09-29 ([forum](https://www.mongodb.com/community/forums/t/mongodb-9-0-is-now-available/343864)). Community Server uses the SSPL licence, which isn't OSI-approved ([FAQ](https://www.mongodb.com/legal/licensing/server-side-public-license/faq)). Atlas has a free 512 MB tier, Flex at $8–30/month, and dedicated clusters from $56.94/month ([pricing](https://www.mongodb.com/pricing)).

### Local development, tests and CI without Docker

- Homebrew's `postgresql@18` formula is at 18.7, with Apple-silicon bottles, and `brew services start postgresql@18` starts it at login ([formula](https://formulae.brew.sh/formula/postgresql@18)). `brew install pgvector` adds pgvector for `@17` and `@18` ([pgvector](https://github.com/pgvector/pgvector)).
- Postgres.app 2.9.7 ships 18.7 (Universal, macOS 10.15 and later) with pgvector included. Its v3beta2 offers 19rc2 ([downloads](https://postgresapp.com/downloads.html), [extensions](https://postgresapp.com/extensions/)).
- mise can only install Postgres by compiling it from source, which needs Xcode tools, openssl and readline (vfox and asdf plugins), or from conda-forge ([registry](https://mise.jdx.dev/registry.html), [vfox-postgres](https://github.com/jdx/vfox-postgres)).
- `CREATE DATABASE … TEMPLATE` copies a migrated database. No one may be connected to the template during the copy, and the default `WAL_LOG` strategy suits small templates ([CREATE DATABASE](https://www.postgresql.org/docs/current/sql-createdatabase.html)).
- Python: pytest-postgresql 10.0.0 (2026-11-04) starts a throwaway server from local binaries, or uses a running one, and copies a template for each test ([PyPI](https://pypi.org/project/pytest-postgresql/)). TypeScript: PGlite runs Postgres inside the process but allows one connection, so it can't test two workers competing for jobs ([PGlite](https://github.com/electric-sql/pglite)). Go: embedded-postgres downloads binaries the first time it starts ([repo](https://github.com/fergusstrange/embedded-postgres)).
- GitHub Actions service containers need Linux runners. The documented setup uses the `postgres` image with a `pg_isready` health check ([GitHub](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers)). `ubuntu-latest` still points to 24.04. The `ubuntu-26.04` image ships PostgreSQL 18.6, stopped by default ([runner images](https://github.com/actions/runner-images), [26.04 readme](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2604-Readme.md)).

### Postgres-backed queues and schedulers, per language

| Language | Library | Schedules | Retries | Verdict |
|---|---|---|---|---|
| Python | Procrastinate 3.11.0 (2026-11-11), MIT, PG 13+ ([PyPI](https://pypi.org/project/procrastinate/)) | `@app.periodic` with cron syntax. The database ensures one run per period across workers ([cron](https://procrastinate.readthedocs.io/en/stable/howto/advanced/cron.html)) | built in | recommended |
| Python | PgQueuer 2.0.0 (2026-11-09), MIT, PG 14+ ([PyPI](https://pypi.org/project/pgqueuer/)) | cron-style | strategies, exponential backoff | runner-up (its major release is 3 days old) |
| Python | Chancy 0.26.0, oban 0.7.0 ([Chancy](https://pypi.org/project/chancy/), [oban](https://pypi.org/project/oban/)) | yes | yes | later (both before 1.0) |
| Python | dramatiq-pg 0.12.0 ([PyPI](https://pypi.org/project/dramatiq-pg/)) | not built in | n/a | rejected (no release since 2024-07-24) |
| TypeScript | pg-boss 12.38.2 (2026-11-10), MIT, Node 22.12+, PG 13+ ([repo](https://github.com/timgit/pg-boss)) | cron and RRULE | exponential backoff, dead-letter queues | recommended |
| TypeScript | Graphile Worker 0.18.0 (2026-09-08), MIT, Node 22.18+, PG 12+ ([docs](https://worker.graphile.org/docs)) | crontab with backfill | 25 attempts over about 3 days | runner-up |
| Go | River v0.51.2 (2026-11-09), MPL-2.0 ([repo](https://github.com/riverqueue/river)) | interval or cron, added by an elected leader. A change of leader can skip a run ([periodic](https://riverqueue.com/docs/periodic-jobs)) | 25 attempts, quartic backoff ([retries](https://riverqueue.com/docs/job-retries)) | recommended |

River documents transactional enqueue: a job inserted inside a transaction becomes visible only after commit ([River](https://riverqueue.com/docs/transactional-enqueueing)). Drivers, for reference (checked on PyPI, npm and GitHub on 2026-11-12): Python psycopg 3.3.9 or asyncpg 0.32.0. TypeScript `pg` 8.23.1 or `postgres` 4.1.1. Go pgx v5.11.0.

### Managed hosting, for later

| Host | Free tier | Cheapest paid (USD) | Canada | Backups and restore |
|---|---|---|---|---|
| Neon ([pricing](https://neon.com/pricing), [regions](https://neon.com/docs/introduction/regions)) | 1 GB per project, 100 CU-hours per project per month, sleeps after 5 min idle, 6 h restore | Launch: $0.106/CU-hour + $0.35/GB-month, no minimum | no | up to 7 days |
| Supabase ([pricing](https://supabase.com/pricing), [regions](https://supabase.com/docs/guides/platform/regions)) | 500 MB database, 1 GB files, paused after 1 idle week, no backups | Pro from $25/month: 8 GB database, 100 GB files | ca-central-1 | daily backups kept 7 days. Point-in-time restore is an add-on at $100/month per 7 days |
| AWS RDS ([free plan](https://aws.amazon.com/free/), [backups](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.BackupRetention.html)) | $200 credits for 6 months, new accounts | db.t4g.micro $0.018/hour (about $13/month) + gp3 $0.127/GB-month in ca-central-1 (AWS price list, 2026-11-12) | ca-central-1 | 0–35 days, point-in-time; backup storage free up to the provisioned size |
| DigitalOcean ([pricing](https://www.digitalocean.com/pricing/managed-databases), [features](https://docs.digitalocean.com/products/databases/postgresql/details/features/)) | none | $15.15/month: 1 vCPU, 1 GiB RAM, 10 GiB | TOR1 Toronto ([matrix](https://docs.digitalocean.com/products/platform/availability-matrix/)) | daily, point-in-time within 7 days |
| Railway ([pricing](https://railway.com/pricing), [backups](https://docs.railway.com/reference/backups)) | $5 trial credit for 30 days | Hobby $5/month including $5 of usage; volumes $0.15/GB-month | no ([regions](https://docs.railway.com/reference/regions)) | daily kept 6 days, weekly 27, monthly 89; no point-in-time restore documented |
| Render ([free](https://render.com/docs/free), [recovery](https://render.com/docs/postgresql-backups)) | expires after 30 days, 1 GB, no backups | from $6/month, storage $0.30/GB-month (UNVERIFIED: from Render articles, not its price table) | no ([regions](https://render.com/docs/regions)) | 3 days (Hobby), 7 days (Pro and up) |
| Fly Managed Postgres ([docs](https://docs.fly.io/mpg), [page](https://fly.io/mpg/)) | none | Basic $38/month (1 GB RAM, high availability) + $0.28/GB-month | yyz Toronto | kept 10 days, point-in-time restore into a new cluster |
| PlanetScale Postgres ([pricing](https://planetscale.com/pricing), [docs](https://planetscale.com/docs/postgres/pricing)) | none | PS-5 single node $5/month (us-east-1 price, varies by region), 10 GB included | aws-ca-central-1 ([changelog](https://planetscale.com/changelog/ca-central-1)) | 2 days by default ([PITR](https://planetscale.com/docs/postgres/backups/point-in-time-recovery)) |
| Crunchy Bridge ([pricing](https://www.crunchydata.com/pricing), [backups](https://docs.crunchybridge.com/concepts/backups)) | none | Hobby-0 $9/month (0.5 GB RAM) + $0.10/GB-month | AWS ca-central-1 ([plans](https://docs.crunchybridge.com/concepts/plans-pricing)) | 10 days of daily and WAL backups, point-in-time |

### Files

- A `bytea` value can be up to 1 GB. Values over about 2 kB are compressed or stored out of line ([TOAST](https://www.postgresql.org/docs/current/storage-toast.html)). The Postgres wiki lists the trade-off. Files in the database come with transactions, access control and backups. The cost is slower, larger backups and more server memory, and it advises against the approach for files around 100 MB and up ([wiki](https://wiki.postgresql.org/wiki/BinaryFilesInDB)).
- S3 Standard in ca-central-1 costs $0.025/GB-month (AWS price list, 2026-11-09). R2 gives 10 GB-month free, then charges $0.015/GB-month with no egress fees ([R2](https://developers.cloudflare.com/r2/pricing/)). R2 can't keep data in Canada, though: it offers only best-effort North America hints ([location](https://developers.cloudflare.com/r2/reference/data-location/)). Supabase Storage gives 1 GB free (50 MB per upload) and 100 GB on Pro ([pricing](https://supabase.com/pricing)).
- Claude reads PDFs directly, up to a 128 MB request and 600 pages (100 below a 1M-token context) ([PDF support](https://platform.claude.com/docs/en/build-with-claude/pdf-support)). The Files API keeps uploads, visible to the whole API workspace, until they are deleted or expire, and it isn't eligible for zero data retention ([Files API](https://platform.claude.com/docs/en/build-with-claude/files)). So resumes should be sent inline.
- Anthropic has no embedding model of its own. Its docs point to Voyage AI, sold through MongoDB Atlas ([embeddings](https://platform.claude.com/docs/en/build-with-claude/embeddings)).
- PIPEDA Principle 5 asks for retention limits and for secure deletion of personal data no longer needed ([OPC](https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/p_principle/principles/p_use/)).

### Sizing (estimates to check in the build phase)

- An earlier prototype measured one user's database at 24.2 MB. Greenhouse's Stripe board returned 713 jobs as 5.5 MB with descriptions, about 7 KB per posting.
- UNVERIFIED estimate: 50,000 postings come to about 350 MB of raw text. With TOAST compression and a GIN index, budget 0.3–0.6 GB for the pool. If screening rows are stored only for jobs that pass a user's prefilter, 50 users × 2,000 jobs gives 100,000 small rows. A one-page PDF is tens of KB.
- Year one fits any paid entry plan (8 GB or more). It outgrows the 0.5–1 GB free tiers within months unless retention is tight.

## Lessons from earlier work

- **Transfers:** a listing is identified by the source's own id, or else by its canonical URL, and a job groups its listings. Near-duplicates have to pass gates first (same company, compatible place, similar title), with text only as confirmation. Only a complete fetch closes a listing, and only after two misses. In Postgres that becomes a unique `(source_id, external_id)`, a B-tree on `company_key`, and `similarity()` run on the candidates. An earlier prototype's 0.9 title threshold came from its own measure, so it needs re-tuning for `pg_trgm`.
- **Transfers:** untouched jobs expire. Fetch and AI logs are trimmed at 30 days. Person-specific facts live in per-user JSON settings. Migrations are numbered, append-only SQL files, and only one module knows the schema.
- **Transfers:** don't add columns for features that don't exist yet. An earlier prototype had to remove sync columns that nothing used. Versioning the master resume on every save grew to hundreds of versions in days, so Instante saves a version only when a build uses it or an import replaces it.
- **Doesn't transfer:** one SQLite file per account and a generic row store with clocks and tombstones. Both exist when the logic runs on each user's machine. Instante's logic runs on the server, so it gets normal tables and one shared job pool stored once. An earlier free-tier estimate counted a copy of the jobs per user, about 26 MB each over 120 days.
- **Doesn't transfer:** Supabase row-level security as the only server-side authorization. That design suits clients that call Supabase directly. Instante's backend is the database's only client.

## Recommendation for v1

1. **Engine.** PostgreSQL 18 locally, in CI and when hosted. The backend generates UUIDv7 ids rather than calling SQL `uuidv7()`, so the schema also runs on 17 (Supabase, Fly). The only extension is `pg_trgm`. Times are `timestamptz`. Enum-like columns are `text` with a `CHECK`.
2. **Local.** `brew install postgresql@18`, then `brew services start postgresql@18`, with the databases `instante_dev` and `instante_test_template`. Postgres.app is the fallback.
3. **Access.** Two roles: `instante_owner` runs migrations, and `instante_app` (used by the API and the worker) can only read and write rows. No RLS. Only the store layer holds SQL, and every per-user function takes a user id. An isolation test runs each one as user A against user B's rows.
4. **Migrations.** Numbered plain SQL files, forward only, run by the backend language's migration tool.
5. **Queue and schedules.** Use the language's recommended library from the table above, in its own schema. Job payloads carry ids only, never resume text. Schedules: fetch sources that are due (every few hours), run retention daily, prune queue history.
6. **Tables.** Only the store layer knows them:

| Table | Scope | Key fields | Retention |
|---|---|---|---|
| `source` | shared | kind, key, config `jsonb`, enabled, etag, next_fetch_at, fail_streak | while enabled |
| `job` | shared | primary_listing_id, company, company_key, title, title_key, city, region, country, remote_scope, salary range, posted_at, first/last_seen_at, closed_at, lang, description_md, content_hash, `search` (stored `tsvector`) | deleted 30 days after closing unless a user saved it, applied or built a resume for it |
| `listing` | shared | job_id, source_id, external_id (unique per source), canonical_url (unique), last_seen_at, missing_runs, closed_at | with its job |
| `job_analysis` | shared | job_id, prompt_version, model, requirements `jsonb` | with its job; replaced when the prompt version changes (if the screening note keeps the extract-per-job, decide-in-code split) |
| `fetch_run` | shared | source_id, started/finished, status, http_status, counts, error | 30 days |
| `app_user` + the auth library's tables | per user | email, name, role, created_at; sessions | until the account is deleted; sessions until they expire |
| `invite` | admin | email, token_hash, invited_by, expires_at, used_at | 30 days after use or expiry |
| `profile` | per user | settings `jsonb` (roles, places, remote, work authorization, salary floor), version | for the account's lifetime |
| `master_resume` | per user | doc `jsonb` with stable entry and bullet ids, schema_version, version (optimistic lock) | for the account's lifetime |
| `master_resume_version` | per user | version, doc `jsonb`, content_hash | versions used by builds, plus the last 20 |
| `user_job` | per user | job_id, verdict, reasons `jsonb`, screened_with, state (saved, hidden, applied), note | deleted with the job; stored only for jobs that pass the user's prefilter |
| `build` | per user | job_id (set to null when the job is deleted), job_snapshot `jsonb`, master_version, status, content `jsonb`, error, timestamps | until the user deletes it |
| `stored_file` | per user | kind, content_type, byte_size (at most 10 MB), sha256, data `bytea`, expires_at | uploads: 7 days, or sooner once the import is accepted; PDFs: as long as their build |
| `resume_import` | per user | file_id, status, draft `jsonb`, error | 7 days |
| `ai_call` | both | user_id (nullable), task, model, token counts, cost, latency, outcome, never text | 90 days |
| queue tables | library | defined by the library | finished jobs 7 days, failed jobs 30 days |

7. **Search.** `job.search` is a stored generated `tsvector`: title (weight A), company (B) and description (C), built with the row's `lang` (`english` or `french`, set during analysis). It gets a GIN index. Queries run `websearch_to_tsquery` in both configurations, joined with OR, plus B-tree filters on country, remote and posted_at.
8. **De-duplication.** Exact copies are caught by the unique keys on `listing`. For near copies, compare `similarity(title_key, …)` against a tuned threshold among open jobs with the same `company_key` and a compatible place. At this size no trigram index is needed.
9. **Files.** `stored_file` holds the bytes. The API streams a file only after checking who owns it, and the frontend never sees where files are stored. A build's JSON stays the source of truth. Its PDF is kept with it so what the user sent stays the same.
10. **Retention.** A daily job applies the retention column above.
11. **Account deletion.** One transaction deletes the `app_user` row, and foreign keys cascade to every per-user row and file. Queued jobs for that user find nothing and finish. Host backups age out on their own schedule.
12. **Tests and CI.** Each test worker copies `instante_test_template` and rolls back after each test. Queue tests commit, then truncate. CI runs on `ubuntu-24.04` with a Postgres 18 service container.

## Later, and what would trigger it

| Add | Trigger | First step |
|---|---|---|
| Object storage (S3 ca-central-1, or R2 if Canadian placement isn't required) | stored files pass about 1 GB or a quarter of the database, files over 10 MB, or a need for direct browser uploads or a CDN | replace `stored_file.data` with an object key and signed URLs |
| Redis or Valkey | several API instances need shared rate limits or sessions, or a measured hot read path that Postgres can't serve | first try a Postgres table; add Redis only with measurements |
| Search engine (Meilisearch v1.56, Typesense v30.2) | users need typo-tolerant, faceted search that FTS plus `pg_trgm` can't give, or p95 search goes over about 300 ms on the real pool | first try a `pg_trgm` index on titles, then ParadeDB `pg_search` (AGPL-3.0) inside Postgres |
| pgvector embeddings | an eval shows keyword and rule screening missing good matches | a separate embeddings table with an HNSW index; needs an embedding provider (a new third party) |
| Separate vector database | millions of vectors, with pgvector latency or recall measured as too low | unlikely within this plan |
| Read replica | the primary's CPU stays high from reads, or reports slow down user requests | the host's managed replica |
| RLS | anything besides the store layer gets database access, or sign-up opens beyond invites | policies on per-user tables using a transaction-local user id |
| Partitioning or archive | `job` passes a few million rows, or retention deletes get slow | monthly partitions on first_seen_at, or export closed postings |
| Connection pooler | the host's connection limit is reached (several API instances, serverless) | pool the API's connections; keep the worker on a direct connection for `LISTEN` |

## Risks

- Free tiers run out: the job pool and the PDFs will pass 0.5–1 GB within months. Supabase Free pauses after an idle week, and it's UNVERIFIED whether the worker's queries count as activity.
- Without RLS, one missing `user_id` filter leaks one user's data to another. The store API and the isolation tests are the guard.
- The local version (18) and a host's version (17 on Supabase and Fly) can drift apart. Avoid SQL that only works on 18, and run CI on the host's version once one is chosen.
- Upgrading to 19: recompute stored `tsvector`s (stemmers changed). Text-search and trigram indexes need a reindex only if the database uses an ICU or builtin locale provider that differs from its `LC_CTYPE` ([19 notes](https://www.postgresql.org/docs/19/release-19.html)).
- Fuzzy de-duplication can merge distinct jobs, which hides postings. The threshold needs tuning on fixtures, and merges should stay reversible (listings keep their own rows).
- French postings searched with English stemming are missed. Per-row `lang` handles this, but it depends on detecting the language correctly.
- Files in the database make backups and restores larger. That's fine below a few GB.
- After deletion, data still survives in host backups (7–10 days on most plans) and at the AI provider under its retention. Logs must never contain resume text.
- The sizing numbers are estimates until the build phase measures them.

## Questions for the owner

1. When Instante goes online, should it stay on free tiers (Supabase Free: 500 MB, pauses after 7 idle days; Neon Free: 1 GB, US regions only), or pay about US$15–25/month (DigitalOcean Toronto $15.15, RDS ca-central-1 about $16 with 20 GB of storage, Supabase Pro $25)?
2. Must users' data stay in Canada? A yes rules out Neon, Railway, Render and R2.
3. Uploaded resume files: delete the original once the imported draft is accepted (7 days at most), or keep it for re-imports?
4. Retention: keep builds and their PDFs until the user deletes them, or auto-delete builds the user never applied with after a set number of days? Is 90 days of AI call logs (counts and costs, no text) acceptable?
5. Account deletion: a hard delete in the app right away, while host backups expire 7–10 days later. Can the privacy notice say exactly that?
6. Embeddings, if they come, would send resume and job text to a second AI provider. Anthropic has none; its docs suggest Voyage AI through MongoDB Atlas. Decide when we get there.

## Sources

- PostgreSQL: [versioning](https://www.postgresql.org/support/versioning/) · [19 RC 2 news](https://www.postgresql.org/about/news/postgresql-187-1712-1616-1520-1425-and-19-rc-2-released-3442/) · [18 release](https://www.postgresql.org/about/news/postgresql-18-released-3142/) · [19 notes](https://www.postgresql.org/docs/19/release-19.html) · [JSON](https://www.postgresql.org/docs/current/datatype-json.html) · [FTS tables](https://www.postgresql.org/docs/current/textsearch-tables.html) · [FTS controls](https://www.postgresql.org/docs/current/textsearch-controls.html) · [pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html) · [SELECT](https://www.postgresql.org/docs/current/sql-select.html) · [NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html) · [RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) · [TOAST](https://www.postgresql.org/docs/current/storage-toast.html) · [CREATE DATABASE](https://www.postgresql.org/docs/current/sql-createdatabase.html) · [wiki: binary files](https://wiki.postgresql.org/wiki/BinaryFilesInDB)
- Extensions and poolers: [pgvector](https://github.com/pgvector/pgvector) · [pgvector changelog](https://github.com/pgvector/pgvector/blob/master/CHANGELOG.md) · [PgBouncer](https://www.pgbouncer.org/features.html) · [ParadeDB](https://github.com/paradedb/paradedb)
- SQLite family: [SQLite](https://www.sqlite.org/index.html) · [when to use](https://www.sqlite.org/whentouse.html) · [Litestream](https://github.com/benbjohnson/litestream/releases) · [Turso pricing](https://turso.tech/pricing) · [Turso regions](https://turso.tech/blog/turso-cloud-new-regions) · [Turso repo](https://github.com/tursodatabase/turso) · [Supabase buys Turso](https://supabase.com/blog/supabase-is-acquiring-turso)
- MySQL and MongoDB: [MySQL 9.7.0](https://dev.mysql.com/doc/relnotes/mysql/9.7/en/news-9-7-0.html) · [full-text](https://dev.mysql.com/doc/refman/9.7/en/fulltext-search.html) · [VECTOR](https://dev.mysql.com/doc/refman/9.7/en/vector.html) · [MongoDB 9.0](https://www.mongodb.com/community/forums/t/mongodb-9-0-is-now-available/343864) · [SSPL FAQ](https://www.mongodb.com/legal/licensing/server-side-public-license/faq) · [Atlas pricing](https://www.mongodb.com/pricing)
- Local and CI: [Homebrew postgresql@18](https://formulae.brew.sh/formula/postgresql@18) · [Postgres.app downloads](https://postgresapp.com/downloads.html) · [Postgres.app extensions](https://postgresapp.com/extensions/) · [mise registry](https://mise.jdx.dev/registry.html) · [vfox-postgres](https://github.com/jdx/vfox-postgres) · [pytest-postgresql](https://pypi.org/project/pytest-postgresql/) · [PGlite](https://github.com/electric-sql/pglite) · [embedded-postgres](https://github.com/fergusstrange/embedded-postgres) · [GitHub service containers](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers) · [runner images](https://github.com/actions/runner-images) · [Ubuntu 26.04 image](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2604-Readme.md)
- Queues: [Procrastinate](https://pypi.org/project/procrastinate/) · [Procrastinate cron](https://procrastinate.readthedocs.io/en/stable/howto/advanced/cron.html) · [PgQueuer](https://pypi.org/project/pgqueuer/) · [Chancy](https://pypi.org/project/chancy/) · [oban](https://pypi.org/project/oban/) · [dramatiq-pg](https://pypi.org/project/dramatiq-pg/) · [pg-boss](https://github.com/timgit/pg-boss) · [Graphile Worker](https://worker.graphile.org/docs) · [River](https://github.com/riverqueue/river) · [River periodic](https://riverqueue.com/docs/periodic-jobs) · [River retries](https://riverqueue.com/docs/job-retries) · [River transactional enqueue](https://riverqueue.com/docs/transactional-enqueueing)
- Hosting: [Neon pricing](https://neon.com/pricing) · [Neon regions](https://neon.com/docs/introduction/regions) · [Neon versions](https://neon.com/docs/postgresql/postgres-version-policy) · [Neon pooling](https://neon.com/docs/connect/connection-pooling) · [Supabase pricing](https://supabase.com/pricing) · [Supabase regions](https://supabase.com/docs/guides/platform/regions) · [Supabase Data API change](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically) · [Supabase hardening](https://supabase.com/docs/guides/database/hardening-data-api) · [Supabase PG 18 discussion](https://github.com/orgs/supabase/discussions/42681) · [AWS free plan](https://aws.amazon.com/free/) · [RDS backup retention](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.BackupRetention.html) · [RDS calendar](https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-release-calendar.html) · AWS price lists: [RDS ca-central-1](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/ca-central-1/index.json), [S3 ca-central-1](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/ca-central-1/index.json) · [DO pricing](https://www.digitalocean.com/pricing/managed-databases) · [DO features](https://docs.digitalocean.com/products/databases/postgresql/details/features/) · [DO limits](https://docs.digitalocean.com/products/databases/postgresql/details/limits/) · [DO regions](https://docs.digitalocean.com/products/platform/availability-matrix/) · [Railway pricing](https://railway.com/pricing) · [Railway regions](https://docs.railway.com/reference/regions) · [Railway backups](https://docs.railway.com/reference/backups) · [Render free](https://render.com/docs/free) · [Render recovery](https://render.com/docs/postgresql-backups) · [Render regions](https://render.com/docs/regions) · [Fly MPG docs](https://docs.fly.io/mpg) · [Fly MPG page](https://fly.io/mpg/) · [PlanetScale pricing](https://planetscale.com/pricing) · [PlanetScale Postgres pricing](https://planetscale.com/docs/postgres/pricing) · [PlanetScale ca-central-1](https://planetscale.com/changelog/ca-central-1) · [PlanetScale PITR](https://planetscale.com/docs/postgres/backups/point-in-time-recovery) · [Crunchy pricing](https://www.crunchydata.com/pricing) · [Crunchy plans](https://docs.crunchybridge.com/concepts/plans-pricing) · [Crunchy backups](https://docs.crunchybridge.com/concepts/backups)
- Files, AI and privacy: [R2 pricing](https://developers.cloudflare.com/r2/pricing/) · [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/) · [Claude PDF support](https://platform.claude.com/docs/en/build-with-claude/pdf-support) · [Claude Files API](https://platform.claude.com/docs/en/build-with-claude/files) · [Claude embeddings](https://platform.claude.com/docs/en/build-with-claude/embeddings) · [OWASP Top 10:2025](https://top10.owasp.org/2025) · [PIPEDA Principle 5](https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/p_principle/principles/p_use/)
