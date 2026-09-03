CREATE TABLE IF NOT EXISTS notification_device_tokens (
  id            bigserial PRIMARY KEY,
  user_id       text NOT NULL,
  platform      text NOT NULL,
  token         text NOT NULL,
  token_hash    text NOT NULL UNIQUE,
  device_label  text,
  enabled       boolean NOT NULL DEFAULT true,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_device_tokens_user_platform
  ON notification_device_tokens (user_id, platform);

CREATE TABLE IF NOT EXISTS notification_alert_dedupe (
  dedupe_key    text PRIMARY KEY,
  last_sent_at  timestamptz NOT NULL
);
