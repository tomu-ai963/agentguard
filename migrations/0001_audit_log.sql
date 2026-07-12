-- 0001_audit_log.sql
-- #7: durable, *readable* audit trail. Replaces the old write-only KV log path.
-- Scope: approvals, killswitch operations, rule changes, plus /check verdicts.
-- Everything goes to D1 only (Analytics Engine / Supabase are out of scope).

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,          -- epoch milliseconds
  agent_id   TEXT    NOT NULL,
  event_type TEXT    NOT NULL,          -- approval | killswitch | rule_change | reset | check | agent_log | notify_failed
  actor      TEXT    NOT NULL,          -- who acted: admin | agent | guard | system
  verdict    TEXT,                      -- allow | throttle | pause | stop (nullable)
  rule_id    TEXT,                      -- matched rule id, when relevant (nullable)
  detail     TEXT                       -- JSON blob with the remaining fields
);

-- Reads are "latest first, optionally filtered by agent" — index both axes.
CREATE INDEX IF NOT EXISTS idx_audit_agent_ts ON audit_log (agent_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_ts       ON audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_event    ON audit_log (event_type, ts DESC);
