-- Chat sessions: what a user said to Rox, what the agent did, and how long it took.
--
--   sessions        one row per chat: name, created and last-activity time, totals
--   session_turns   one row per agent run started by a user message: status, timing, tokens
--   session_events  append-only log of everything in a session (messages, model and tool calls)
--
-- Event types are free-form `area.name` strings. Planned ones:
--   user.message, assistant.message              data: {"text": "..."}
--   model.request, model.response                duration_ms, data: model, token counts
--   tool.requested, tool.completed               duration_ms, data: tool name, arguments, result
--   agent.error, system.note
--
-- Isolation: row-level security. A connection only sees rows of the user named in
-- the transaction setting `rox.user_id` (see src/lib/db.ts withUser). With no
-- setting it sees nothing. The table owner (migrations, backups) is not affected.
--
-- Grants: for now the web role is the only role, so it can write events. When the
-- agent service gets its own role, assistant, model and tool events move to that role.

------------------------------------------------------------------------
-- sessions
------------------------------------------------------------------------
CREATE TABLE sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users (id),
  name           text NOT NULL DEFAULT 'New chat'
                   CONSTRAINT sessions_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Last activity: bumped by renames and by every event or finished turn.
  updated_at     timestamptz NOT NULL DEFAULT now(),
  last_event_at  timestamptz,
  -- Maintained by triggers; callers cannot set them.
  next_seq       bigint NOT NULL DEFAULT 1,      -- events so far = next_seq - 1
  turn_count     integer NOT NULL DEFAULT 0,
  exec_ms        bigint NOT NULL DEFAULT 0       -- total agent execution time of finished turns
);

CREATE INDEX sessions_user_recent_idx ON sessions (user_id, updated_at DESC);

CREATE FUNCTION sessions_before_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'id, user_id and created_at of a session cannot change'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;

CREATE TRIGGER sessions_before_update
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION sessions_before_update();

------------------------------------------------------------------------
-- session_turns: one agent run per user message
------------------------------------------------------------------------
CREATE TABLE session_turns (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  n              integer NOT NULL,               -- 1, 2, 3 ... within the session
  status         text NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running', 'completed', 'failed', 'stopped')),
  model          text,
  started_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at    timestamptz,
  -- Execution time, derived from the two timestamps the database itself sets.
  duration_ms    integer GENERATED ALWAYS AS (
                   CASE WHEN finished_at IS NULL THEN NULL
                        ELSE round(extract(epoch FROM (finished_at - started_at)) * 1000)::integer
                   END) STORED,
  input_tokens   integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens  integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  error          text CHECK (error IS NULL OR char_length(error) <= 4000),
  UNIQUE (session_id, n),
  CHECK ((status = 'running') = (finished_at IS NULL)),
  CHECK (error IS NULL OR status = 'failed')
);

-- A chat runs one agent turn at a time.
CREATE UNIQUE INDEX session_turns_one_running ON session_turns (session_id) WHERE status = 'running';

CREATE FUNCTION session_turns_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE sessions SET turn_count = turn_count + 1
   WHERE id = NEW.session_id
  RETURNING turn_count INTO NEW.n;
  IF NEW.n IS NULL THEN
    RAISE EXCEPTION 'session % does not exist', NEW.session_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.status := 'running';
  NEW.started_at := clock_timestamp();
  NEW.finished_at := NULL;
  RETURN NEW;
END
$$;

CREATE TRIGGER session_turns_before_insert
  BEFORE INSERT ON session_turns
  FOR EACH ROW EXECUTE FUNCTION session_turns_before_insert();

-- Moving a turn out of 'running' stamps the finish time. A finished turn is frozen.
CREATE FUNCTION session_turns_before_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.session_id <> OLD.session_id
     OR NEW.n <> OLD.n OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION 'the identity and start time of a turn cannot change'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'turn % is finished and cannot change', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> 'running' THEN
    NEW.finished_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER session_turns_before_update
  BEFORE UPDATE ON session_turns
  FOR EACH ROW EXECUTE FUNCTION session_turns_before_update();

-- When a turn finishes, add its time to the session total.
CREATE FUNCTION session_turns_after_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.finished_at IS NULL AND NEW.finished_at IS NOT NULL THEN
    UPDATE sessions SET exec_ms = exec_ms + NEW.duration_ms
     WHERE id = NEW.session_id;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER session_turns_after_update
  AFTER UPDATE ON session_turns
  FOR EACH ROW EXECUTE FUNCTION session_turns_after_update();

-- Turns go away only with their session.
CREATE FUNCTION session_turns_block_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;  -- cascade from a deleted session
  END IF;
  RAISE EXCEPTION 'a turn can only be removed by deleting its session'
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER session_turns_block_delete
  BEFORE DELETE ON session_turns
  FOR EACH ROW EXECUTE FUNCTION session_turns_block_delete();

------------------------------------------------------------------------
-- session_events: append-only
------------------------------------------------------------------------
CREATE TABLE session_events (
  session_id   uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  seq          bigint NOT NULL,                  -- 1, 2, 3 ... assigned by the database
  id           uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  occurred_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  turn_id      uuid REFERENCES session_turns (id) ON DELETE CASCADE,
  type         text NOT NULL
                 CHECK (type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' AND char_length(type) <= 64),
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
                 CHECK (pg_column_size(data) <= 1048576),
  duration_ms  integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  PRIMARY KEY (session_id, seq)
);

CREATE INDEX session_events_turn_idx ON session_events (turn_id) WHERE turn_id IS NOT NULL;
CREATE INDEX session_events_messages_idx ON session_events (session_id, seq)
  WHERE type IN ('user.message', 'assistant.message');

-- Gives each event the next number in its session. The session row is locked for
-- the moment of the insert, so numbers never repeat and never skip, and chats do
-- not wait for each other.
CREATE FUNCTION session_events_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  assigned bigint;
BEGIN
  IF NEW.turn_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM session_turns t
        WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id) THEN
    RAISE EXCEPTION 'turn % does not belong to session %', NEW.turn_id, NEW.session_id
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE sessions
     SET next_seq = next_seq + 1,
         last_event_at = clock_timestamp()
   WHERE id = NEW.session_id
  RETURNING next_seq - 1 INTO assigned;

  IF assigned IS NULL THEN
    RAISE EXCEPTION 'session % does not exist', NEW.session_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  NEW.seq := assigned;
  NEW.occurred_at := clock_timestamp();
  RETURN NEW;
END
$$;

CREATE TRIGGER session_events_before_insert
  BEFORE INSERT ON session_events
  FOR EACH ROW EXECUTE FUNCTION session_events_before_insert();

-- No edits, and no deletes except the cascade from deleting the whole session.
CREATE FUNCTION session_events_block_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;  -- cascade from a deleted session
  END IF;
  RAISE EXCEPTION 'session_events is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER session_events_no_update_delete
  BEFORE UPDATE OR DELETE ON session_events
  FOR EACH ROW EXECUTE FUNCTION session_events_block_change();

CREATE FUNCTION session_events_block_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'session_events is append-only: TRUNCATE is not allowed'
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER session_events_no_truncate
  BEFORE TRUNCATE ON session_events
  FOR EACH STATEMENT EXECUTE FUNCTION session_events_block_truncate();

------------------------------------------------------------------------
-- Row-level security: a user sees only their own sessions
------------------------------------------------------------------------
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY sessions_owner ON sessions
  FOR ALL TO rox_app
  USING (user_id = nullif(current_setting('rox.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('rox.user_id', true), '')::uuid);

-- Turns and events follow the session: visible only if the session is.
CREATE POLICY session_turns_owner ON session_turns
  FOR ALL TO rox_app
  USING (EXISTS (SELECT 1 FROM sessions s WHERE s.id = session_turns.session_id))
  WITH CHECK (EXISTS (SELECT 1 FROM sessions s WHERE s.id = session_turns.session_id));

CREATE POLICY session_events_owner ON session_events
  FOR ALL TO rox_app
  USING (EXISTS (SELECT 1 FROM sessions s WHERE s.id = session_events.session_id))
  WITH CHECK (EXISTS (SELECT 1 FROM sessions s WHERE s.id = session_events.session_id));

------------------------------------------------------------------------
-- Least privilege for the web role. Column lists keep it from setting
-- counters, timestamps, sequence numbers or the owner.
------------------------------------------------------------------------
GRANT SELECT, DELETE ON sessions TO rox_app;
GRANT INSERT (user_id, name) ON sessions TO rox_app;
GRANT UPDATE (name) ON sessions TO rox_app;

GRANT SELECT ON session_turns TO rox_app;
GRANT INSERT (session_id, model) ON session_turns TO rox_app;
GRANT UPDATE (status, model, input_tokens, output_tokens, error) ON session_turns TO rox_app;

GRANT SELECT ON session_events TO rox_app;
GRANT INSERT (session_id, turn_id, type, data, duration_ms) ON session_events TO rox_app;
