-- The runner's own record, and what the app role may do (docs/specs/platform.md, "store").
-- Run by `cli db migrate` as instante_owner, which owns the database and every object in it.

CREATE TABLE schema_migrations (
  name text PRIMARY KEY CHECK (name ~ '^[0-9]{4}_[a-z0-9]+(_[a-z0-9]+)*$'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- instante_app reads and writes rows, and creates or changes nothing. It may read which
-- migrations ran (for /readyz), but not write that record.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO instante_app;
GRANT SELECT ON schema_migrations TO instante_app;

ALTER DEFAULT PRIVILEGES FOR ROLE instante_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO instante_app;
ALTER DEFAULT PRIVILEGES FOR ROLE instante_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO instante_app;
