-- Apps Rox reports to after a run (Slack today, Telegram later), and which one gets the final
-- report. The tokens stay in .env on the server; a row only says the user connected the app and
-- where the report goes. One row per user and app.

CREATE TABLE report_connections (
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider IN ('slack', 'telegram')),
  -- Slack: the workspace and the bot, as auth.test reported them when the user connected.
  workspace     text,
  workspace_id  text,
  bot_user      text,
  -- Where the report is posted: a Slack channel id (or a Telegram chat id later).
  channel_id    text NOT NULL,
  channel_name  text,
  connected_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);

-- Which connected app gets the final report after every run. Null: none.
ALTER TABLE user_setup
  ADD COLUMN report_to text CHECK (report_to IN ('slack', 'telegram'));

GRANT SELECT, INSERT, UPDATE, DELETE ON report_connections TO rox_app;
GRANT UPDATE (report_to) ON user_setup TO rox_app;

ALTER TABLE report_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY report_connections_web ON report_connections
  FOR ALL TO rox_app
  USING (user_id = nullif(current_setting('rox.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('rox.user_id', true), '')::uuid);
