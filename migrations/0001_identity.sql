CREATE TABLE IF NOT EXISTS app_users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('practice_admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);

CREATE TABLE IF NOT EXISTS app_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS identity_audit_events (
  id text PRIMARY KEY,
  event_type text NOT NULL CHECK (event_type IN ('practice_admin_bootstrapped', 'account_created')),
  actor_user_id text REFERENCES app_users(id),
  subject_user_id text NOT NULL REFERENCES app_users(id),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_ci_idx ON app_users (lower(email));

CREATE INDEX IF NOT EXISTS app_sessions_active_idx ON app_sessions (token_hash, expires_at)
WHERE revoked_at IS NULL;
