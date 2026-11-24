-- The per-run cap goes away (the day cap and the time limit stay), and there are three tones.

ALTER TABLE agent_config DROP COLUMN run_budget_usd;

ALTER TABLE agent_config DROP CONSTRAINT agent_config_tone_check;
UPDATE agent_config SET tone = 'strict' WHERE tone IN ('balanced', 'mentor');
ALTER TABLE agent_config ALTER COLUMN tone SET DEFAULT 'strict';
ALTER TABLE agent_config ADD CONSTRAINT agent_config_tone_check
  CHECK (tone IN ('strict', 'friendly', 'savage'));
