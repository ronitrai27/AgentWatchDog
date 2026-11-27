-- Every run of the pipeline agent (pipeline/), and every step of it. The pipeline writes both;
-- the web reads them for the live view (SSE) and the chat agent reads them to answer
-- "how far is PR 8?" or "how many PRs did you fix this week?".

CREATE TABLE runs (
  -- Temporal's run id. Also the key of every event of the run.
  run_id       text PRIMARY KEY,
  workflow_id  text NOT NULL,
  -- Whose run it is (the Rox user whose repository or project it is). Null for lab runs.
  user_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  -- What woke it: github, sentry, vercel, grafana, betterstack, cli, chat.
  source       text NOT NULL,
  -- The exact trigger, as in Settings > Workflow: 'github:pr_main', 'sentry:new_issue', ...
  trigger      text,
  -- How it was started: webhook (an event), chat (the user asked Rox), cli (pnpm lab).
  invoked_by   text NOT NULL CHECK (invoked_by IN ('webhook', 'chat', 'cli')),
  -- The event that started it: the webhook delivery id, or null.
  event_id     text,
  repo         text,
  pr_number    int,
  head_sha     text,
  base_sha     text,
  title        text,
  status       text NOT NULL DEFAULT 'running'
               CHECK (status IN ('running', 'paused', 'succeeded', 'failed', 'cancelled', 'aborted')),
  -- What the agent concluded: fixed, nothing_to_fix, gave_up, infra; null until it says.
  outcome      text,
  pr_url       text,
  -- Why it failed, was cancelled or aborted.
  reason       text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  duration_ms  bigint,
  tokens_in    bigint NOT NULL DEFAULT 0,
  tokens_out   bigint NOT NULL DEFAULT 0,
  cost_usd     numeric(12, 6) NOT NULL DEFAULT 0,
  model_calls  int NOT NULL DEFAULT 0,
  -- The highest event seq written, so a live view knows where it stands.
  last_seq     int NOT NULL DEFAULT 0
);

CREATE INDEX runs_user_recent ON runs (user_id, started_at DESC);
CREATE INDEX runs_subject ON runs (repo, pr_number);
CREATE INDEX runs_active ON runs (status) WHERE status IN ('running', 'paused');

-- One row per step of a run, in order. This is what the live view streams.
CREATE TABLE run_events (
  run_id   text NOT NULL REFERENCES runs (run_id) ON DELETE CASCADE,
  seq      int NOT NULL,
  at       timestamptz NOT NULL DEFAULT now(),
  step     text NOT NULL,
  kind     text NOT NULL,
  title    text NOT NULL,
  status   text,
  ms       int,
  attempt  int,
  data     jsonb,
  PRIMARY KEY (run_id, seq)
);

-- Live view: every new event is announced, so an SSE route can LISTEN instead of polling.
CREATE FUNCTION run_events_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('run_events', json_build_object('run', NEW.run_id, 'seq', NEW.seq)::text);
  RETURN NEW;
END $$;

CREATE TRIGGER run_events_notify AFTER INSERT ON run_events
  FOR EACH ROW EXECUTE FUNCTION run_events_notify();

-- The pipeline worker and the web both connect as rox_app.
GRANT SELECT, INSERT, UPDATE ON runs, run_events TO rox_app;
GRANT SELECT ON runs, run_events TO rox_agent;

ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY runs_web ON runs FOR ALL TO rox_app USING (true) WITH CHECK (true);
CREATE POLICY run_events_web ON run_events FOR ALL TO rox_app USING (true) WITH CHECK (true);

-- The chat agent sees only its user's runs.
CREATE POLICY runs_agent ON runs FOR SELECT TO rox_agent
  USING (user_id = nullif(current_setting('rox.user_id', true), '')::uuid);
CREATE POLICY run_events_agent ON run_events FOR SELECT TO rox_agent
  USING (EXISTS (SELECT 1 FROM runs r WHERE r.run_id = run_events.run_id
                 AND r.user_id = nullif(current_setting('rox.user_id', true), '')::uuid));
