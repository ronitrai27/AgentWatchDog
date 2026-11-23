-- The setup guide on /home: one row per user with what they chose, and their
-- encrypted model provider keys.

CREATE TABLE user_setup (
  user_id               uuid PRIMARY KEY REFERENCES users (id),
  repo                  text,
  repo_installation_id  bigint,
  orchestrator_model    text,
  -- {"fixer": "gpt-6-sol"}; an agent that is missing uses the orchestrator's model.
  subagent_models       jsonb NOT NULL DEFAULT '{}'::jsonb,
  sandbox               text CHECK (sandbox IN ('docker', 'daytona', 'e2b')),
  sandbox_checked_at    timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON user_setup TO rox_app;

CREATE TABLE provider_keys (
  user_id      uuid NOT NULL REFERENCES users (id),
  provider     text NOT NULL CHECK (provider IN ('openai', 'anthropic', 'google')),
  -- AES-256-GCM, bound to the user and provider. See src/lib/vault.ts.
  iv           bytea NOT NULL,
  ciphertext   bytea NOT NULL,
  tag          bytea NOT NULL,
  last4        text NOT NULL,
  -- Which of Rox's listed models this key can use, as the provider reported.
  models       text[] NOT NULL DEFAULT '{}',
  verified_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);

-- Write-only for the web app: it can add, replace and remove a key and show
-- its last four characters, but it can never read the encrypted key back. The
-- agent service gets its own role with that access when it exists.
GRANT SELECT (user_id, provider, last4, models, verified_at) ON provider_keys TO rox_app;
GRANT INSERT, DELETE ON provider_keys TO rox_app;
