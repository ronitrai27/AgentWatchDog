-- Every verified GitHub webhook that reaches Rox, so there is a trace of what happened, when,
-- whether Rox listened to it, and which event replaced which. The delivery id is GitHub's own,
-- so the same delivery twice (a retry) is one row.
--
-- status: ignored    not something Rox acts on (the reason says why)
--         active     Rox should work on it (later: a workflow is running for it)
--         superseded a newer event of the same kind on the same repository replaced it

CREATE TABLE webhook_events (
  delivery_id      text PRIMARY KEY,
  received_at      timestamptz NOT NULL DEFAULT now(),
  event            text NOT NULL,
  action           text,
  repo             text,
  installation_id  bigint,
  sender           text,
  branch           text,
  sha              text,
  pr_number        int,
  title            text,
  listened         boolean NOT NULL,
  kind             text CHECK (kind IN ('pr_to_default', 'ci_failed')),
  reason           text NOT NULL,
  run_key          text,
  user_id          uuid REFERENCES users (id) ON DELETE SET NULL,
  status           text NOT NULL CHECK (status IN ('ignored', 'active', 'superseded')),
  superseded_by    text REFERENCES webhook_events (delivery_id),
  superseded_at    timestamptz,
  supersede_reason text,
  redeliveries     int NOT NULL DEFAULT 0
);

CREATE INDEX webhook_events_active ON webhook_events (repo, kind) WHERE status = 'active';
CREATE INDEX webhook_events_recent ON webhook_events (received_at DESC);

-- Written by the webhook route, which has no signed-in user. Not readable by the agent yet.
GRANT SELECT, INSERT, UPDATE ON webhook_events TO rox_app;
