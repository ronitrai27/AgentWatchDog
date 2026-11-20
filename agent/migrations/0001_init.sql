-- Rox schema, step 1: users and the audit log. Nothing else yet.
-- The role rox_app is created by scripts/migrate.mjs before this file runs.

------------------------------------------------------------------------
-- users: one row per person. GitHub sign-ins and the shared Judge user.
------------------------------------------------------------------------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id     bigint UNIQUE,
  login         text NOT NULL,
  name          text,
  avatar_url    text,
  is_demo       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_identity CHECK (is_demo OR github_id IS NOT NULL)
);

-- At most one demo user.
CREATE UNIQUE INDEX users_one_demo ON users ((true)) WHERE is_demo;

INSERT INTO users (id, login, name, is_demo)
VALUES ('00000000-0000-0000-0000-00000000d3a0', 'judge', 'Judge', true);

------------------------------------------------------------------------
-- audit_events: append-only, tamper-evident.
-- Every row stores the hash of the row before it, so changing or removing
-- any past row breaks the chain and audit_chain_status() reports where.
------------------------------------------------------------------------
CREATE SEQUENCE audit_events_seq AS bigint;

CREATE TABLE audit_events (
  seq          bigint PRIMARY KEY,
  id           uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  occurred_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  user_id      uuid REFERENCES users (id),
  run_id       uuid,
  actor        text NOT NULL,
  type         text NOT NULL,
  verdict      text CHECK (verdict IN ('ALLOW', 'DENY', 'PASS', 'FAIL', 'INFO')),
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash    bytea,
  hash         bytea NOT NULL
);

CREATE INDEX audit_events_user_idx ON audit_events (user_id, seq DESC);
CREATE INDEX audit_events_run_idx ON audit_events (run_id, seq) WHERE run_id IS NOT NULL;
CREATE INDEX audit_events_type_idx ON audit_events (type, seq DESC);
CREATE INDEX audit_events_time_idx ON audit_events (occurred_at);

-- The canonical text that is hashed. Fixed format, UTC time, so it is stable.
CREATE FUNCTION audit_compute_hash(prev bytea, e audit_events)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT sha256(convert_to(
    coalesce(encode(prev, 'hex'), '') || '|' ||
    e.seq || '|' || e.id || '|' ||
    to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' ||
    coalesce(e.user_id::text, '') || '|' ||
    coalesce(e.run_id::text, '') || '|' ||
    e.actor || '|' || e.type || '|' || coalesce(e.verdict, '') || '|' ||
    e.data::text,
    'UTF8'))
$$;

-- Fills seq, prev_hash and hash. The advisory lock makes inserts take turns,
-- so the order of the chain always equals the order of seq.
CREATE FUNCTION audit_events_before_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  last_hash bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(7240001);
  SELECT hash INTO last_hash FROM audit_events ORDER BY seq DESC LIMIT 1;
  NEW.seq := nextval('audit_events_seq');
  NEW.occurred_at := clock_timestamp();
  NEW.prev_hash := last_hash;
  NEW.hash := audit_compute_hash(NEW.prev_hash, NEW);
  RETURN NEW;
END
$$;

CREATE TRIGGER audit_events_chain
  BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_before_insert();

-- Append-only: no edits, no deletes, no truncate, for any role.
CREATE FUNCTION audit_events_block_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_block_change();

CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_block_change();

-- Recomputes every hash and link. ok = false means history was altered;
-- first_bad_seq is the earliest row that does not check out.
CREATE FUNCTION audit_chain_status()
RETURNS TABLE (ok boolean, checked bigint, first_bad_seq bigint)
LANGUAGE sql
STABLE
AS $$
  WITH chk AS (
    SELECT
      e.seq,
      e.prev_hash IS DISTINCT FROM lag(e.hash) OVER (ORDER BY e.seq) AS bad_link,
      e.hash <> audit_compute_hash(e.prev_hash, e) AS bad_hash
    FROM audit_events e
  )
  SELECT
    NOT EXISTS (SELECT 1 FROM chk WHERE bad_link OR bad_hash),
    (SELECT count(*) FROM chk),
    (SELECT min(seq) FROM chk WHERE bad_link OR bad_hash)
$$;

------------------------------------------------------------------------
-- Least privilege for the service role. It can add and read audit rows,
-- never change or remove them, and it can never delete users.
------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON users TO rox_app;
GRANT SELECT, INSERT ON audit_events TO rox_app;
GRANT USAGE ON SEQUENCE audit_events_seq TO rox_app;
GRANT EXECUTE ON FUNCTION audit_chain_status() TO rox_app;
