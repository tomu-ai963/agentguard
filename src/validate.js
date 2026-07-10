// validate.js
// Input validation for everything that crosses the network boundary.
// Pure module (no Workers APIs) so it is unit-testable with plain node.

export const MAX_BODY_BYTES = 64 * 1024;  // request body cap
export const MAX_PARAMS_TEXT = 10_000;    // chars of params text fed to regex rules
const MAX_METRIC = 1e12;

const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const RULE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Only these metric keys are ever accepted from the network. Everything else
// (lastHeartbeat, status, killswitch, apiCallsPerMin, ...) is server-derived
// and must not be spoofable via /heartbeat or /check. In particular
// apiCallsPerMin is computed from server-observed check counters
// (incrementCheckCounters) — a self-reported value would defeat the point.
const NUMERIC_METRICS = [
  "loopCount", "tokensUsed", "costUSD", "tokenBurnRate",
];

// Audit-log entries are consumed downstream (JSONL -> detchi -> pgvector),
// so they are field-whitelisted and length-capped to limit injection surface.
const LOG_FIELDS = ["action", "tool", "verdict", "reason", "ruleId", "message", "level"];

export function validAgentId(id) {
  return typeof id === "string" && AGENT_ID_RE.test(id);
}

export function validRequestId(rid) {
  return typeof rid === "string" && UUID_RE.test(rid);
}

export function cleanString(v, max = 256) {
  return typeof v === "string" ? v.slice(0, max) : "";
}

/** Keep only known, finite, non-negative numeric metrics. */
export function sanitizeMetrics(m) {
  const out = {};
  if (!m || typeof m !== "object" || Array.isArray(m)) return out;
  for (const key of NUMERIC_METRICS) {
    const n = Number(m[key]);
    if (Number.isFinite(n) && n >= 0) out[key] = Math.min(n, MAX_METRIC);
  }
  return out;
}

/** Whitelist + cap audit-log entry fields. */
export function sanitizeLogEntry(entry) {
  const e = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
  const out = {};
  for (const k of LOG_FIELDS) {
    if (e[k] !== undefined) out[k] = cleanString(e[k], 2048);
  }
  return out;
}

const VERDICTS = ["allow", "throttle", "pause", "stop"];
const OPS = [">", ">=", "<", "<=", "==", "!=", "in", "contains", "matches"];

function validateCondition(cond, depth = 0) {
  if (depth > 10) return "condition nesting too deep (max 10)";
  if (!cond || typeof cond !== "object" || Array.isArray(cond)) {
    return "condition must be an object";
  }
  for (const k of ["all", "any"]) {
    if (cond[k] !== undefined) {
      if (!Array.isArray(cond[k]) || cond[k].length === 0 || cond[k].length > 20) {
        return `${k} must be a non-empty array (max 20)`;
      }
      for (const c of cond[k]) {
        const err = validateCondition(c, depth + 1);
        if (err) return err;
      }
      return null;
    }
  }
  if (cond.not !== undefined) return validateCondition(cond.not, depth + 1);

  if (!OPS.includes(cond.op)) return `unknown op: ${String(cond.op)}`;
  const key = cond.metric ?? cond.field;
  if (typeof key !== "string" || key.length === 0 || key.length > 64) {
    return "metric/field must be a string (max 64 chars)";
  }
  if (cond.op === "matches") {
    if (typeof cond.value !== "string" || cond.value.length > 200) {
      return "matches pattern must be a string (max 200 chars)";
    }
    try { new RegExp(cond.value); } catch { return `invalid regex: ${cond.value}`; }
  }
  if (cond.op === "in" && (!Array.isArray(cond.value) || cond.value.length > 50)) {
    return "in value must be an array (max 50 items)";
  }
  return null;
}

/** @returns {string|null} error message, or null when the rule set is valid */
export function validateRules(rules) {
  if (!Array.isArray(rules)) return "expected an array of rules";
  if (rules.length === 0) return "rule set must not be empty";
  if (rules.length > 100) return "too many rules (max 100)";
  const seen = new Set();
  for (const r of rules) {
    if (!r || typeof r !== "object" || Array.isArray(r)) return "rule must be an object";
    if (!RULE_ID_RE.test(String(r.id))) return "rule id must be 1-64 chars of [A-Za-z0-9_-]";
    if (seen.has(r.id)) return `duplicate rule id: ${r.id}`;
    seen.add(r.id);
    if (!VERDICTS.includes(r.verdict)) return `rule ${r.id}: verdict must be one of ${VERDICTS.join("|")}`;
    if (r.waitMs !== undefined && (!Number.isFinite(r.waitMs) || r.waitMs < 0 || r.waitMs > 600_000)) {
      return `rule ${r.id}: waitMs must be 0-600000`;
    }
    if (r.message !== undefined && (typeof r.message !== "string" || r.message.length > 500)) {
      return `rule ${r.id}: message must be a string (max 500 chars)`;
    }
    const err = validateCondition(r.when);
    if (err) return `rule ${r.id}: ${err}`;
  }
  return null;
}
