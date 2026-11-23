-- All sub agents run on one model, chosen next to the orchestrator's.
ALTER TABLE user_setup DROP COLUMN subagent_models;
ALTER TABLE user_setup ADD COLUMN subagent_model text;
