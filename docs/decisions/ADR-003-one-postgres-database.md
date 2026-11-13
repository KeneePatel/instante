# ADR-003: One PostgreSQL 18 database for data, the queue and files

## Status
Accepted 2026-11-13 at the phase 1 gate. At the phase 2 gate, production's database went onto the owner's Mac ([ADR-012](ADR-012-run-on-the-owners-mac.md)). Proposed 2026-11-12 and revised after the adversarial review the same day.

## Date
2026-11-12

## Context
- The core data is relational: people × jobs × verdicts, resumes per person, jobs shared by everyone. Some parts are documents: resumes, settings, analyses.
- Jobs need full-text search and filters. Background work needs a queue with schedules and retries. The files are small: uploads up to 5 MB, PDFs of tens of kilobytes.
- The owner's Mac has no Docker; Homebrew and mise are available.
- PostgreSQL 18.7 is current and supported until 2030-11-14, and 19 is due on 2026-11-19 ([database note](../research/database.md)).

## Decision
- **One PostgreSQL 18 database** for everything in v1:
  - relational tables;
  - `jsonb` documents validated by Zod before writing;
  - a generated `tsvector` with a GIN index for search;
  - pg-boss's queue and schedules in their own schema;
  - files as `bytea` in one `stored_file` table, referenced by the rows that own them.
- **Where it runs:** locally, Homebrew's `postgresql@18`, with tests on copies of a migrated template database. In CI, a `postgres:18` service container. In production, a separate PostgreSQL 18 cluster on the owner's Mac, reachable only through a Unix socket and only with a password ([ADR-012](ADR-012-run-on-the-owners-mac.md)). [ADR-011](ADR-011-host.md)'s managed database needed a server. Another alternative is the production Supabase project's own database ([ADR-004](ADR-004-supabase-auth.md)): it would need Pro ($25 a month) for daily backups, point-in-time restore as an add-on (about $100 a month for 7 days, and the plan asks for it from the alpha), its Data API turned off, and a direct or session-mode connection for pg-boss.
- **Portability:** no SQL that only runs on 18, so hosts still on 17 stay possible. Ids are UUIDv7 made in the backend.
- **Migrations:** numbered SQL files and our own runner ([ADR-002](ADR-002-typescript-backend.md)). They change freely until the first real use with data, the start of the owner-only alpha. Just before it they're squashed into a baseline, and the real-use database is recreated from it; after it, they only expand.
- **Access:** two roles, `instante_owner` (migrations and pg-boss's schema) and `instante_app` (rows only). On the Mac, a superuser used only by `instante setup` joins them ([ADR-012](ADR-012-run-on-the-owners-mac.md)).
- **Isolation without row-level security in v1:**
  - `user_id NOT NULL` on every per-user table;
  - composite keys `(user_id, id)` between per-user tables;
  - one store function for every read of `job`, with one visibility rule: shared catalog jobs, the person's own pasted postings, and any job the person has a row for (read-only);
  - an isolation matrix generated from the contract's route table, covering routes, lists, search and queue jobs.
- **Indexes:** every foreign-key column is indexed.
- **Foreign-key actions** are written into the schema for every reference: cascade, set null or restrict, as listed in [`architecture.md`](../architecture.md#deleting-an-account-the-inventory).

## Alternatives considered

| Option | Why not |
|---|---|
| SQLite with Litestream | The least to operate, but one writer at a time, no `SKIP LOCKED` or `LISTEN`, and a dialect migration later |
| libSQL / Turso | Its new engine hasn't reached 1.0, and Supabase announced it is buying Turso on 2026-10-02 |
| MySQL | No `LISTEN/NOTIFY`, fewer queue libraries, weaker JSON |
| MongoDB | The core is relational; `jsonb` already gives documents |
| Redis for the queue | A second stateful service for no v1 need |
| Object storage for files | A second system to secure, back up and delete from; Cloudflare R2 can't keep data in Canada |
| Row-level security now | Needs a per-transaction user id and a bypass role for the worker, while the backend is the only client. The composite keys and the generated isolation matrix are the v1 guard |
| `pg_trgm` for fuzzy de-duplication | Not needed while v1 reads only company boards, which de-duplicate by (board kind, external id) |

## Consequences
- One stateful service to run, back up, secure and delete from. An account deletion is one transaction, files included. Backups and providers' logs are listed in the deletion inventory.
- Without RLS, a missing visibility rule is the main way data could leak. The composite keys catch cross-user references in the database, and the generated matrix catches missing routes.
- Files sit in their own table, so list queries never pull PDF bytes.
- On the Mac the database costs nothing. If Instante moves to a server, expect US$15 to US$25 a month for a managed database ([ADR-011](ADR-011-host.md)).

## Doubts raised (adversarial review, 2026-11-12)
A single-model review; the owner chose to skip a cross-model second opinion.
- **"Isolation without RLS is weaker than claimed; private pasted postings sit in the shared job table":** valid. Composite keys, one job-visibility function and a generated isolation matrix.
- **"The cascades couldn't work as the tables were written; what survives deletion was undecided":** valid. Columns added and an inventory written. The retention windows go to the owner as one question in phase 2.
- **"Retention could delete evidence that saved or applied jobs show; a gone board's deletion would wipe applied jobs":** valid. Jobs referenced by people are kept, `job.source_id` is `RESTRICT`, applied rows keep a snapshot, and the analysis now lives on the person's own `screening` row.
- **"Files inside the owning tables bloat list queries":** valid. They moved to `stored_file`.
- **"The ledger and the queue rules don't hold as written"** (pg-boss's own migrations; plaintext codes in job payloads, which have since left with Supabase Auth): valid. Fixed in [ADR-002](ADR-002-typescript-backend.md) and [ADR-004](ADR-004-supabase-auth.md).
- **"No index plan":** valid. Every foreign key is indexed, and the rest come with the module specs.

## Revisit when
- Stored files pass about 1 GB or a quarter of the database: object storage.
- Any client besides the store layer gets database access, or sign-up opens: RLS.
- p95 search passes about 300 ms on the real pool: a trigram index, then a search engine.
- The chosen host offers 19 and pgvector supports it: PostgreSQL 19.
