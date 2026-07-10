// test-engine.mjs — verify all four verdicts without any network/KV,
// plus the validation layer. Run:  node test-engine.mjs
import { judge } from "./src/engine.js";
import { DEFAULT_RULES } from "./src/rules.default.js";
import {
  validAgentId, sanitizeMetrics, sanitizeLogEntry, validateRules,
} from "./src/validate.js";

let pass = 0, fail = 0;
function check(name, ctx, expected) {
  const r = judge(DEFAULT_RULES, ctx);
  const ok = r.verdict === expected;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  -> ${r.verdict} (${r.reason})`);
  ok ? pass++ : fail++;
}
function assert(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  cond ? pass++ : fail++;
}

check("normal action", { agentId: "a", action: "read_file", metrics: { loopCount: 1, costUSD: 0.1 } }, "allow");
check("loop warning -> throttle", { agentId: "a", metrics: { loopCount: 6 } }, "throttle");
check("loop runaway -> stop", { agentId: "a", metrics: { loopCount: 12 } }, "stop");
check("cost soft cap -> pause", { agentId: "a", metrics: { costUSD: 3.0 } }, "pause");
check("cost hard cap -> stop", { agentId: "a", metrics: { costUSD: 6.0 } }, "stop");
check("destructive rm -rf -> pause", { agentId: "a", action: "run", tool: "shell", params: { cmd: "rm -rf /tmp/x" } }, "pause");
check("wrangler deploy -> pause", { agentId: "a", tool: "wrangler_deploy", params: {} }, "pause");
check("heartbeat lost -> stop", { agentId: "a", metrics: { secondsSinceHeartbeat: 200 } }, "stop");
check("manual killswitch -> stop", { agentId: "a", metrics: { killswitch: 1 } }, "stop");
check("precedence: stop beats pause", { agentId: "a", metrics: { costUSD: 3.0, loopCount: 12 } }, "stop");

// --- engine hardening ---
// Before the Object.hasOwn fix, "toString" resolved to the inherited
// function and String(fn) contains "native code", so this rule fired.
const protoProbe = [{ id: "p", verdict: "stop", when: { field: "toString", op: "matches", value: "native code" } }];
assert("prototype key does not leak into facts",
  judge(protoProbe, { agentId: "a" }).verdict === "allow");

const twoThrottles = [
  { id: "t1", verdict: "throttle", waitMs: 1000, when: { metric: "loopCount", op: ">=", value: 1 } },
  { id: "t2", verdict: "throttle", waitMs: 9000, when: { metric: "loopCount", op: ">=", value: 1 } },
];
assert("equal-rank throttles use the longest waitMs",
  judge(twoThrottles, { agentId: "a", metrics: { loopCount: 2 } }).waitMs === 9000);

// --- validation layer ---
assert("agentId: normal id ok", validAgentId("claude-code-local"));
assert("agentId: path traversal rejected", !validAgentId("../rules:global"));
assert("agentId: colon rejected (KV key safety)", !validAgentId("a:b"));
assert("agentId: non-string rejected", !validAgentId({ a: 1 }));

const m = sanitizeMetrics({ costUSD: 1.5, lastHeartbeat: 9999, status: "alive", tokensUsed: -5, loopCount: "3" });
assert("metrics: known numeric kept", m.costUSD === 1.5 && m.loopCount === 3);
assert("metrics: state fields stripped", !("lastHeartbeat" in m) && !("status" in m));
assert("metrics: negative dropped", !("tokensUsed" in m));

const e = sanitizeLogEntry({ action: "x".repeat(5000), evil: "payload", reason: "ok" });
assert("log entry: field whitelist + cap", e.action.length === 2048 && e.reason === "ok" && !("evil" in e));

assert("rules: valid default set accepted", validateRules(DEFAULT_RULES) === null);
assert("rules: non-array rejected", validateRules({}) !== null);
assert("rules: bad verdict rejected",
  validateRules([{ id: "x", verdict: "nuke", when: { metric: "costUSD", op: ">", value: 1 } }]) !== null);
assert("rules: bad regex rejected",
  validateRules([{ id: "x", verdict: "stop", when: { field: "paramsText", op: "matches", value: "([a-" } }]) !== null);
assert("rules: oversized regex rejected",
  validateRules([{ id: "x", verdict: "stop", when: { field: "paramsText", op: "matches", value: "a".repeat(201) } }]) !== null);
assert("rules: duplicate id rejected",
  validateRules([
    { id: "x", verdict: "stop", when: { metric: "costUSD", op: ">", value: 1 } },
    { id: "x", verdict: "stop", when: { metric: "costUSD", op: ">", value: 2 } },
  ]) !== null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
