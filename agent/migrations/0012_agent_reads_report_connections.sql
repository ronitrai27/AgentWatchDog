-- The agent reads which report apps (Slack, later Telegram) the user connected, so it can answer
-- "what am I connected to?" truthfully and send reports. Read only, one user per transaction.

GRANT SELECT ON report_connections TO rox_agent;

CREATE POLICY report_connections_agent ON report_connections
  FOR SELECT TO rox_agent
  USING (user_id = nullif(current_setting('rox.user_id', true), '')::uuid);
