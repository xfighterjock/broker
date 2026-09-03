-- Event Gate application users + opaque session tokens.
-- Passwords are argon2id hashes only. Never store plaintext.

CREATE TABLE IF NOT EXISTS users (
  id            bigserial PRIMARY KEY,
  username      text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  disabled_at   timestamptz
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id            bigserial PRIMARY KEY,
  user_id       bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  user_agent    text
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user
  ON user_sessions (user_id);

CREATE INDEX IF NOT EXISTS idx_user_sessions_active
  ON user_sessions (token_hash)
  WHERE revoked_at IS NULL;
