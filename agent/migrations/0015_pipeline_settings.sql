-- The pipeline follows Settings > Agent: what to do with a verified fix, and the time limit.

-- open_pr: Rox opens the pull request and a human merges (the default).
-- merge_pr: Rox merges its own verified pull request, then reports. Chosen by the user, never by a model.
ALTER TABLE agent_config
  ADD COLUMN pr_action text NOT NULL DEFAULT 'open_pr' CHECK (pr_action IN ('open_pr', 'merge_pr'));

-- A pipeline run needs more than a chat turn: 20 minutes unless the user chose otherwise.
ALTER TABLE agent_config ALTER COLUMN max_minutes SET DEFAULT 20;

-- What each run used and whether Rox merged its pull request.
ALTER TABLE runs
  ADD COLUMN model         text,
  ADD COLUMN pr_action     text,
  ADD COLUMN pr_merged_at  timestamptz,
  -- The day's budget when the run started, and what was left of it.
  ADD COLUMN day_budget_usd numeric(8, 2),
  ADD COLUMN budget_left_usd numeric(12, 6);

-- The chat agent's own reads of spending include pipeline runs.
CREATE INDEX runs_user_day ON runs (user_id, started_at);
