-- Agent Config in Settings: the spending caps, how Rox should talk, extra instructions, and the
-- scheduled report (saved only; nothing runs it yet). A user without a row gets the defaults.

CREATE TABLE agent_config (
  user_id         uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  run_budget_usd  numeric(8, 2) NOT NULL DEFAULT 1.00 CHECK (run_budget_usd BETWEEN 0.05 AND 100),
  day_budget_usd  numeric(8, 2) NOT NULL DEFAULT 5.00 CHECK (day_budget_usd BETWEEN 0.05 AND 500),
  max_minutes     int NOT NULL DEFAULT 5 CHECK (max_minutes BETWEEN 1 AND 120),
  tone            text NOT NULL DEFAULT 'balanced'
                    CHECK (tone IN ('balanced', 'strict', 'friendly', 'mentor', 'savage')),
  instructions    text NOT NULL DEFAULT '' CHECK (length(instructions) <= 2000),
  report_schedule text NOT NULL DEFAULT 'off'
                    CHECK (report_schedule IN ('off', 'daily', 'every_3_days', 'weekly')),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (run_budget_usd <= day_budget_usd)
);

GRANT SELECT, INSERT, UPDATE ON agent_config TO rox_app;
-- The agent reads its limits and can never change them.
GRANT SELECT ON agent_config TO rox_agent;

ALTER TABLE agent_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY agent_config_web ON agent_config
  FOR ALL TO rox_app
  USING (user_id = nullif(current_setting('rox.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('rox.user_id', true), '')::uuid);

CREATE POLICY agent_config_agent ON agent_config
  FOR SELECT TO rox_agent
  USING (user_id = nullif(current_setting('rox.user_id', true), '')::uuid);
