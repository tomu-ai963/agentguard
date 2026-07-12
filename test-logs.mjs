// test-logs.mjs — #7 audit trail: D1 writes (appendLog) and reads (queryLogs +
// GET /logs). Verifies the write-only-log problem is actually solved: what we
// write is readable, filterable, admin-gated, and correctly attributed.
// Run:  node test-logs.mjs
import worker from "./src/index.js";
import { appendLog, queryLogs } from "./src/store.js";
import { makeKV, makeD1, makeExecutionCtx } from "./test-helpers.mjs";

let pass = 0, fail = 0;
function check(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  cond ? pass++ : fail++;
}

const ADMIN_TOKEN = "test-admin-token";
const AGENT_TOKEN = "test-agent-token";

function req(path, { method = "GET", body, token = ADMIN_TOKEN } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(`https://guard.test${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function run() {
  // Negative cases below intentionally hit the unbound-D1 and failed-notify
  // paths, which log via console.error by design; quiet it for a clean suite.
  console.error = () => {};

  // ============ store-level: appendLog -> queryLogs ============
  {
    const env = { GUARD_DB: makeD1() };

    await appendLog(env, "tomu-cli/collect-a1b2", {
      eventType: "killswitch", verdict: "stop", ruleId: "manual-killswitch",
      reason: "engaged", source: "admin",
    });
    await appendLog(env, "claude-code/x-9z9z", {
      eventType: "check", verdict: "allow", action: "run", tool: "read_file", source: "guard",
    });

    const all = await queryLogs(env, {});
    check("appendLog -> queryLogs returns both rows", all.length === 2);

    const ks = all.find((r) => r.eventType === "killswitch");
    check("row: eventType promoted to column", ks && ks.eventType === "killswitch");
    check("row: actor derived from source (admin)", ks.actor === "admin");
    check("row: verdict + ruleId promoted", ks.verdict === "stop" && ks.ruleId === "manual-killswitch");
    check("row: extra fields land in detail JSON", ks.detail && ks.detail.reason === "engaged");
    check("row: promoted fields not duplicated into detail",
      ks.detail.verdict === undefined && ks.detail.source === undefined);

    const filtered = await queryLogs(env, { agentId: "tomu-cli/collect-a1b2" });
    check("queryLogs filters by agentId", filtered.length === 1 && filtered[0].eventType === "killswitch");

    const byEvent = await queryLogs(env, { eventType: "check" });
    check("queryLogs filters by eventType", byEvent.length === 1 && byEvent[0].agentId === "claude-code/x-9z9z");

    // ordering + limit
    for (let i = 0; i < 5; i++) {
      await appendLog(env, "agent-seq", { eventType: "check", action: `a${i}` });
    }
    const limited = await queryLogs(env, { agentId: "agent-seq", limit: 3 });
    check("queryLogs honors limit", limited.length === 3);
    check("queryLogs newest-first ordering", limited[0].detail.action === "a4");
  }

  // appendLog must never throw when the audit sink is unbound.
  {
    let threw = false;
    try { await appendLog({}, "a", { eventType: "check" }); } catch { threw = true; }
    check("appendLog: no GUARD_DB -> no throw (logging never breaks requests)", !threw);
    const none = await queryLogs({}, {});
    check("queryLogs: no GUARD_DB -> empty list", Array.isArray(none) && none.length === 0);
  }

  // ============ endpoint-level: mutations audit -> GET /logs ============
  {
    const env = { GUARD_KV: makeKV(), GUARD_DB: makeD1(), ADMIN_TOKEN, AGENT_TOKEN };
    const execCtx = makeExecutionCtx();

    // an admin killswitch op (audit write is deferred via waitUntil)
    await worker.fetch(req("/killswitch/tomu-cli/collect-a1b2", { method: "POST", body: { active: true } }), env, execCtx);
    // a rules replacement
    await worker.fetch(req("/rules", { method: "POST", body: [
      { id: "r1", verdict: "stop", when: { metric: "loopCount", op: ">=", value: 10 } },
    ] }), env, execCtx);
    // an agent /check (deferred "check" audit write)
    await worker.fetch(req("/check", { method: "POST", token: AGENT_TOKEN,
      body: { agentId: "tomu-cli/collect-a1b2", action: "run", tool: "x" } }), env, execCtx);

    await execCtx.drain(); // flush all deferred audit writes

    // admin can read the trail
    const r = await worker.fetch(req("/logs"), env, execCtx);
    const body = await r.json();
    check("GET /logs (admin) -> 200", r.status === 200);
    check("GET /logs returns the deferred audit writes", body.count >= 3);
    const types = new Set(body.logs.map((l) => l.eventType));
    check("GET /logs includes killswitch event", types.has("killswitch"));
    check("GET /logs includes rule_change event", types.has("rule_change"));
    check("GET /logs includes check event", types.has("check"));

    // filter by agentId via query string
    const rFilt = await worker.fetch(req("/logs?agentId=tomu-cli/collect-a1b2"), env, execCtx);
    const bFilt = await rFilt.json();
    check("GET /logs?agentId= filters to that agent",
      bFilt.logs.length >= 1 && bFilt.logs.every((l) => l.agentId === "tomu-cli/collect-a1b2"));

    // filter by eventType
    const rType = await worker.fetch(req("/logs?eventType=rule_change"), env, execCtx);
    const bType = await rType.json();
    check("GET /logs?eventType= filters by event",
      bType.logs.length === 1 && bType.logs[0].eventType === "rule_change");

    // --- admin gate + input validation ---
    const rAgent = await worker.fetch(req("/logs", { token: AGENT_TOKEN }), env, execCtx);
    check("GET /logs with agent token -> 401 (admin only)", rAgent.status === 401);

    const rNoAuth = await worker.fetch(req("/logs", { token: null }), env, execCtx);
    check("GET /logs without token -> 401", rNoAuth.status === 401);

    const rBadAgent = await worker.fetch(req("/logs?agentId=a:b"), env, execCtx);
    check("GET /logs?agentId=<invalid> -> 400", rBadAgent.status === 400);

    const rBadEvent = await worker.fetch(req("/logs?eventType=DROP TABLE"), env, execCtx);
    check("GET /logs?eventType=<invalid> -> 400", rBadEvent.status === 400);

    await execCtx.drain();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run();
