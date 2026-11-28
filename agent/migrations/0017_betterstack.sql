-- Better Stack as a real connection, like Sentry: the API token and webhook secret stay in .env;
-- a user only records which heartbeat or monitor is theirs. The webhook route (no signed-in user)
-- reads the incident from Better Stack's API and finds the user by that heartbeat or monitor.

ALTER TABLE user_setup
  ADD COLUMN betterstack_source_kind  text CHECK (betterstack_source_kind IN ('heartbeat', 'monitor')),
  ADD COLUMN betterstack_source_id    text,
  ADD COLUMN betterstack_source_name  text,
  ADD COLUMN betterstack_connected_at timestamptz;

CREATE UNIQUE INDEX user_setup_betterstack_source
  ON user_setup (betterstack_source_kind, betterstack_source_id)
  WHERE betterstack_source_id IS NOT NULL;
