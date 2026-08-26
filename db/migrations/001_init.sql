CREATE TABLE IF NOT EXISTS events (
  id            bigserial PRIMARY KEY,
  event_time_utc timestamptz NOT NULL,
  type          text NOT NULL,
  flatten_et    time NOT NULL,
  UNIQUE (event_time_utc, type)
);

CREATE TABLE IF NOT EXISTS freeze_snapshots (
  id              bigserial PRIMARY KEY,
  frozen_at       timestamptz,
  consensus       jsonb NOT NULL DEFAULT '{}'::jsonb,
  source          text,
  fedwatch        text,
  contracts       jsonb NOT NULL DEFAULT '{}'::jsonb,
  knowledge_time  timestamptz
);

CREATE TABLE IF NOT EXISTS session_logs (
  id          bigserial PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  event_type  text NOT NULL,
  checklist   jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes       text
);

CREATE TABLE IF NOT EXISTS gate_log (
  id    bigserial PRIMARY KEY,
  ts    timestamptz NOT NULL DEFAULT now(),
  line  text NOT NULL
);

INSERT INTO events (event_time_utc, type, flatten_et) VALUES
  ('2026-09-04T12:30:00Z', 'NFP',            '15:45'),
  ('2026-09-11T12:30:00Z', 'CPI',            '15:45'),
  ('2026-09-16T18:00:00Z', 'FOMC_STATEMENT', '15:30'),
  ('2026-09-16T18:30:00Z', 'FOMC_PC',        '15:30')
ON CONFLICT (event_time_utc, type) DO NOTHING;
