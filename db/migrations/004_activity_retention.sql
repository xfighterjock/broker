-- Indexes for 90-day activity-log retention (GET /api/activity pages gate_log).
CREATE INDEX IF NOT EXISTS idx_gate_log_ts ON gate_log (ts);
CREATE INDEX IF NOT EXISTS idx_session_logs_ts ON session_logs (ts);
