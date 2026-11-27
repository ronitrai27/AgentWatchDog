-- Sentry as a real connection, and the invocation triggers the user turned on.
-- The Sentry token and webhook secret stay in .env; a user only records which Sentry project
-- is theirs. The webhook route (no signed-in user) finds the user by the project id.

ALTER TABLE user_setup
  ADD COLUMN sentry_org          text,
  ADD COLUMN sentry_project      text,
  ADD COLUMN sentry_project_id   text,
  ADD COLUMN sentry_connected_at timestamptz,
  -- Which events wake Rox, as the Settings > Workflow ids ("sentry:new_issue", ...).
  ADD COLUMN triggers text[] NOT NULL DEFAULT '{github:failed_ci,github:pr_main}';

CREATE UNIQUE INDEX user_setup_sentry_project ON user_setup (sentry_project_id)
  WHERE sentry_project_id IS NOT NULL;

-- Sentry events go into the same webhook ledger as GitHub's.
ALTER TABLE webhook_events DROP CONSTRAINT webhook_events_kind_check;
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_kind_check
  CHECK (kind IN ('pr_to_default', 'ci_failed', 'sentry_new_issue', 'sentry_error_spike',
                  'sentry_regression'));
