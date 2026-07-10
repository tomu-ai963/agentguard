// engine.js
// The declarative judge engine. This file is intentionally generic:
// new runaway patterns are added as DATA (rule objects), not code.
//
// A rule:
// {
//   id: "loop-guard",
//   type: "circuit_breaker" | "limit" | "policy" | "heartbeat",
//   when: <Condition>,
//   verdict: "allow" | "throttle" | "pause" | "stop",
//   waitMs?: number,          // for throttle
//   notify?: boolean,
//   message?: string
// }
//
// Condition grammar (composable):
//   { metric, op, value }                     leaf comparison
//   { field, op, value }                      compare a string field (e.g. tool, action)
//   { all: [Condition, ...] }                 logical AND
//   { any: [Condition, ...] }                 logical OR
//   { not: Condition }                        negation
//
// op ∈  >  >=  <  <=  ==  !=  in  contains  matches
//
// Verdict precedence (highest wins): stop > pause > throttle > allow
// So if several rules match, the most restrictive verdict is returned.

const VERDICT_RANK = { allow: 0, throttle: 1, pause: 2, stop: 3 };

// Cap the text fed to user-defined `matches` regexes so a pathological
// pattern can't be driven into catastrophic backtracking by a huge payload.
const MAX_PARAMS_TEXT = 10_000;

const OPS = {
  ">":  (a, b) => Number(a) >  Number(b),
  ">=": (a, b) => Number(a) >= Number(b),
  "<":  (a, b) => Number(a) <  Number(b),
  "<=": (a, b) => Number(a) <= Number(b),
  "==": (a, b) => a === b,
  "!=": (a, b) => a !== b,
  "in": (a, b) => Array.isArray(b) && b.includes(a),
  "contains": (a, b) => typeof a === "string" && a.includes(b),
  "matches": (a, b) => {
    try { return new RegExp(b).test(String(a)); }
    catch { return false; }
  },
};

/**
 * Build the fact object a condition is evaluated against.
 * Merges live metrics with request context (tool, action, params...).
 */
function buildFacts(ctx) {
  const m = ctx.metrics ?? {};
  return {
    // metrics namespace
    loopCount: m.loopCount ?? 0,
    tokensUsed: m.tokensUsed ?? 0,
    costUSD: m.costUSD ?? 0,
    apiCallsPerMin: m.apiCallsPerMin ?? 0,
    tokenBurnRate: m.tokenBurnRate ?? 0,
    secondsSinceHeartbeat: m.secondsSinceHeartbeat ?? 0,
    killswitch: m.killswitch ?? 0,
    // context fields
    action: ctx.action ?? "",
    tool: ctx.tool ?? "",
    params: ctx.params ?? {},
    paramsText: JSON.stringify(ctx.params ?? {}).slice(0, MAX_PARAMS_TEXT),
  };
}

function evalCondition(cond, facts) {
  if (!cond || typeof cond !== "object") return false;

  if (cond.all) return cond.all.every((c) => evalCondition(c, facts));
  if (cond.any) return cond.any.some((c) => evalCondition(c, facts));
  if (cond.not) return !evalCondition(cond.not, facts);

  const op = OPS[cond.op];
  if (!op) return false;

  // metric leaf vs field leaf. Own-property check only: `in` would also
  // match inherited keys like "constructor" and compare against built-ins.
  const key = cond.metric ?? cond.field;
  if (key === undefined) return false;
  const left = Object.hasOwn(facts, key) ? facts[key] : undefined;
  return op(left, cond.value);
}

/**
 * Evaluate all rules against the request context.
 * @returns {{ verdict, reason, waitMs, matched: Rule[], notify: boolean }}
 */
export function judge(rules, ctx) {
  const facts = buildFacts(ctx);
  const matched = [];
  let best = { verdict: "allow", rank: 0, waitMs: 0, reason: "no rule matched", notify: false };

  for (const rule of rules ?? []) {
    if (!evalCondition(rule.when, facts)) continue;
    matched.push(rule);
    const rank = VERDICT_RANK[rule.verdict] ?? 0;
    if (rank > best.rank) {
      best = {
        verdict: rule.verdict,
        rank,
        waitMs: rule.waitMs ?? 0,
        reason: rule.message ?? rule.id,
        notify: rule.notify ?? rank >= VERDICT_RANK.pause, // pause/stop notify by default
        ruleId: rule.id,
      };
    } else if (rank === best.rank && rank === VERDICT_RANK.throttle) {
      // Several throttle rules matched: honor the longest requested wait
      // instead of whichever rule happened to come first.
      best.waitMs = Math.max(best.waitMs, rule.waitMs ?? 0);
    }
  }

  return {
    verdict: best.verdict,
    reason: best.reason,
    waitMs: best.waitMs,
    ruleId: best.ruleId ?? null,
    notify: best.notify,
    matched: matched.map((r) => r.id),
  };
}

export { VERDICT_RANK };
