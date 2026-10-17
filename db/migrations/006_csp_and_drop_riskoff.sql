-- Cash-secured put paper recorder and shadow-exit log. MockBroker only.
-- Also deletes rows tagged with the retired sleeve id `riskoff`.
-- The sleeve token is matched so "RISK OFF" / "risk on" regime lines stay.

CREATE TABLE IF NOT EXISTS csp_option_snapshots (
  id               bigserial PRIMARY KEY,
  snapshot_ts      timestamptz NOT NULL,
  underlying       text NOT NULL,
  underlying_last  double precision,
  expiration       date NOT NULL,
  strike           double precision NOT NULL,
  bid              double precision,
  ask              double precision,
  last             double precision,
  volume           double precision,
  open_interest    double precision,
  iv               double precision,
  delta            double precision
);

CREATE INDEX IF NOT EXISTS idx_csp_option_snapshots_ts
  ON csp_option_snapshots (snapshot_ts DESC);

CREATE TABLE IF NOT EXISTS csp_shadow_exits (
  id                bigserial PRIMARY KEY,
  position_id       text NOT NULL,
  rule_id           text NOT NULL,
  triggered_at      timestamptz,
  underlying_px     double precision,
  put_bid           double precision,
  put_ask           double precision,
  put_mid           double precision,
  fill              double precision,
  pnl               double precision,
  final_actual_pnl  double precision
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_csp_shadow_exits_position
  ON csp_shadow_exits (position_id, rule_id);

DELETE FROM gate_log
 WHERE line ~ '(^|[^A-Za-z])riskoff([^A-Za-z]|$)';

DELETE FROM session_logs
 WHERE COALESCE(notes, '') ~ '(^|[^A-Za-z])riskoff([^A-Za-z]|$)'
    OR COALESCE(event_type, '') ~ '(^|[^A-Za-z])riskoff([^A-Za-z]|$)';

DELETE FROM notification_alert_dedupe
 WHERE dedupe_key ~ '(^|[^A-Za-z])riskoff([^A-Za-z]|$)';
