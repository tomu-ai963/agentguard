// test-engine.mjs — verify all four verdicts without any network/KV.
// Run:  node test-engine.mjs
import { judge } from "./src/engine.js";
import { DEFAULT_RULES } from "./src/rules.default.js";

let pass = 0, fail = 0;
function check(name, ctx, expected) {
  const r = judge(DEFAULT_RULES, ctx);
  const ok = r.verdict === expected;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  -> ${r.verdict} (${r.reason})`);
  ok ? pass++ : fail++;
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
