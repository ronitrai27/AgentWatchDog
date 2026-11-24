-- The agent service gets its own database role, rox_agent (created by scripts/migrate.mjs).
--
--   rox_agent  writes chat events and agent turns, and can read the model keys of the
--              user it is serving (and only that user).
--   rox_app    (the web app) becomes read-only for events and turns. It still creates,
--              renames and deletes chats. It can never read stored model keys.
--
-- Both roles are scoped to one user per transaction with `rox.user_id`; see src/lib/db.ts
-- (web) and agent/src/db.ts (agent).

------------------------------------------------------------------------
-- Web role: read-only for events and turns
------------------------------------------------------------------------
REVOKE INSERT (session_id, turn_id, type, data, duration_ms) ON session_events FROM rox_app;
REVOKE INSERT (session_id, model) ON session_turns FROM rox_app;
REVOKE UPDATE (status, model, input_tokens, output_tokens, error) ON session_turns FROM rox_app;

------------------------------------------------------------------------
-- Agent role
------------------------------------------------------------------------
GRANT SELECT ON sessions TO rox_agent;
GRANT INSERT (user_id, name) ON sessions TO rox_agent;
GRANT UPDATE (name) ON sessions TO rox_agent;

GRANT SELECT ON session_turns TO rox_agent;
GRANT INSERT (session_id, model) ON session_turns TO rox_agent;
GRANT UPDATE (status, model, input_tokens, output_tokens, error) ON session_turns TO rox_agent;

GRANT SELECT ON session_events TO rox_agent;
GRANT INSERT (session_id, turn_id, type, data, duration_ms) ON session_events TO rox_agent;

GRANT SELECT (id, login, name, is_demo, github_id) ON users TO rox_agent;
GRANT SELECT ON user_setup TO rox_agent;
GRANT SELECT ON provider_keys TO rox_agent;   -- includes the encrypted key, see the policy below

-- The agent records its own security-relevant moments in the audit log.
GRANT SELECT, INSERT ON audit_events TO rox_agent;
GRANT USAGE ON SEQUENCE audit_events_seq TO rox_agent;

-- Row-level security for the agent, same rule as the web role: one user per transaction.
CREATE POLICY sessions_agent ON sessions
  FOR ALL TO rox_agent
  USING (user_id = nullif(current_setting('rox.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('rox.user_id', true), '')::uuid);

CREATE POLICY session_turns_agent ON session_turns
  FOR ALL TO rox_agent
  USING (EXISTS (SELECT 1 FROM sessions s WHERE s.id = session_turns.session_id))
  WITH CHECK (EXISTS (SELECT 1 FROM sessions s WHERE s.id = session_turns.session_id));

CREATE POLICY session_events_agent ON session_events
  FOR ALL TO rox_agent
  USING (EXISTS (SELECT 1 FROM sessions s WHERE s.id = session_events.session_id))
  WITH CHECK (EXISTS (SELECT 1 FROM sessions s WHERE s.id = session_events.session_id));

------------------------------------------------------------------------
-- Stored keys and setup: the agent sees only the user it serves.
-- Turning on row-level security needs a policy for the web role too, which keeps
-- its existing behaviour (its column grants already stop it reading the key).
------------------------------------------------------------------------
ALTER TABLE provider_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_setup ENABLE ROW LEVEL SECURITY;

CREATE POLICY provider_keys_web ON provider_keys
  FOR ALL TO rox_app USING (true) WITH CHECK (true);
CREATE POLICY user_setup_web ON user_setup
  FOR ALL TO rox_app USING (true) WITH CHECK (true);

CREATE POLICY provider_keys_agent ON provider_keys
  FOR SELECT TO rox_agent
  USING (user_id = nullif(current_setting('rox.user_id', true), '')::uuid);
CREATE POLICY user_setup_agent ON user_setup
  FOR SELECT TO rox_agent
  USING (user_id = nullif(current_setting('rox.user_id', true), '')::uuid);
