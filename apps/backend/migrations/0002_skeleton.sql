-- The walking skeleton's one table: the queue check writes a row here and completes its job in
-- the same transaction (docs/specs/platform.md, "The queue pattern"). Ids are UUIDv7, made in
-- the backend.

CREATE TABLE skeleton_ping (
  id uuid PRIMARY KEY,
  note text NOT NULL CHECK (length(note) <= 200),
  created_at timestamptz NOT NULL DEFAULT now()
);
