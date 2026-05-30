// rules.default.js
// Starter set of runaway-pattern rules. Loaded into KV (rules:global) on first run.
// To handle a NEW pattern later: add a rule object here or POST /rules — no engine change.

export const DEFAULT_RULES = [
  {
    id: "manual-killswitch",
    type: "policy",
    // The /check handler injects metrics.killswitch=1 when the flag is set in KV.
    when: { metric: "killswitch", op: "==", value: 1 },
    verdict: "stop",
    notify: true,
    message: "Manual kill switch is active for this agent",
  },
  {
    id: "loop-guard",
    type: "circuit_breaker",
    when: { metric: "loopCount", op: ">=", value: 10 },
    verdict: "stop",
    notify: true,
    message: "Repeated-action loop detected (loopCount >= 10)",
  },
  {
    id: "loop-warn",
    type: "circuit_breaker",
    when: { all: [
      { metric: "loopCount", op: ">=", value: 5 },
      { metric: "loopCount", op: "<", value: 10 },
    ] },
    verdict: "throttle",
    waitMs: 3000,
    notify: false,
    message: "Action repeating; throttling",
  },
  {
    id: "cost-hard-cap",
    type: "limit",
    when: { metric: "costUSD", op: ">=", value: 5.0 },
    verdict: "stop",
    notify: true,
    message: "Cost hard cap reached (>= $5.00)",
  },
  {
    id: "cost-soft-cap",
    type: "limit",
    when: { all: [
      { metric: "costUSD", op: ">=", value: 2.0 },
      { metric: "costUSD", op: "<", value: 5.0 },
    ] },
    verdict: "pause",
    notify: true,
    message: "Cost soft cap reached (>= $2.00); awaiting approval to continue",
  },
  {
    id: "api-rate-burst",
    type: "circuit_breaker",
    when: { metric: "apiCallsPerMin", op: ">", value: 120 },
    verdict: "throttle",
    waitMs: 5000,
    notify: false,
    message: "API call burst; throttling",
  },
  {
    id: "destructive-command",
    type: "policy",
    // High-consequence ops always require a human, regardless of metrics.
    when: { any: [
      { field: "paramsText", op: "matches", value: "rm\\s+-rf" },
      { field: "paramsText", op: "matches", value: "DROP\\s+TABLE" },
      { field: "paramsText", op: "matches", value: "git\\s+push\\s+--force" },
      { field: "tool", op: "in", value: ["wrangler_deploy", "stripe_charge", "kv_bulk_delete", "git_push", "npm_publish", "remove_item_recurse"] },
    ] },
    verdict: "pause",
    notify: true,
    message: "Destructive/high-consequence action requires approval",
  },
  {
    id: "heartbeat-lost",
    type: "heartbeat",
    when: { metric: "secondsSinceHeartbeat", op: ">", value: 120 },
    verdict: "stop",
    notify: true,
    message: "Agent heartbeat lost (> 120s); possible hang",
  },
];
