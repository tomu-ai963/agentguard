// test-routing.mjs — routing + request-parsing layer of index.js.
// Covers the gaps the /check integration test doesn't: unknown paths, method
// mismatches, malformed/oversized bodies, the public root, and input rejects.
// Run:  node test-routing.mjs
import worker from "./src/index.js";
import { makeKV, makeD1, makeExecutionCtx } from "./test-helpers.mjs";

let pass = 0, fail = 0;
function check(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  cond ? pass++ : fail++;
}

const ADMIN_TOKEN = "test-admin-token";
const AGENT_TOKEN = "test-agent-token";
const env = () => ({ GUARD_KV: makeKV(), GUARD_DB: makeD1(), ADMIN_TOKEN, AGENT_TOKEN });
const execCtx = makeExecutionCtx();

function request(path, { method = "GET", body, token = AGENT_TOKEN, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (raw !== undefined) { headers["Content-Type"] = "application/json"; payload = raw; }
  else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  return new Request(`https://guard.test${path}`, { method, headers, body: payload });
}
const call = (path, opts) => worker.fetch(request(path, opts), env(), execCtx);

async function run() {
  // --- public root needs no auth ---
  {
    const r = await worker.fetch(new Request("https://guard.test/"), env(), execCtx);
    const b = await r.json();
    check("GET / -> 200 service banner (no auth required)", r.status === 200 && b.service === "AgentGuard");
  }

  // --- unknown path falls through to 404 (after passing auth) ---
  {
    const r = await call("/does-not-exist");
    check("GET /unknown with valid token -> 404", r.status === 404);
  }

  // --- method mismatch: no handler matches -> 404 ---
  {
    const r = await call("/check", { method: "GET" });
    check("GET /check (POST-only route) -> 404 not found", r.status === 404);
    const r2 = await call("/heartbeat", { method: "GET" });
    check("GET /heartbeat (POST-only route) -> 404 not found", r2.status === 404);
  }

  // --- auth gate runs before routing for everything except GET / ---
  {
    const r = await call("/does-not-exist", { token: null });
    check("unknown path without token -> 401 (auth gate first)", r.status === 401);
  }

  // --- malformed JSON body -> 400 ---
  {
    const r = await call("/check", { method: "POST", raw: "{ not json" });
    check("POST /check with invalid JSON -> 400", r.status === 400);
  }

  // --- oversized body -> 413 (declared Content-Length over the cap) ---
  {
    const big = "x".repeat(64 * 1024 + 10);
    const r = await call("/check", { method: "POST", raw: JSON.stringify({ agentId: "a", pad: big }) });
    check("POST /check with body over 64KB -> 413", r.status === 413);
  }

  // --- input validation: bad agentId -> 400 ---
  {
    const r = await call("/check", { method: "POST", body: { agentId: "../evil", action: "run" } });
    check("POST /check with traversal agentId -> 400", r.status === 400);
    const r2 = await call("/heartbeat", { method: "POST", body: { agentId: "a:b" } });
    check("POST /heartbeat with colon agentId -> 400", r2.status === 400);
  }

  // --- admin-only route rejects an agent token ---
  {
    const r = await call("/rules", { method: "POST", body: [], token: AGENT_TOKEN });
    check("POST /rules with agent token -> 401 (admin required)", r.status === 401);
  }

  // --- invalid rule set on POST /rules (admin) -> 400 ---
  {
    const r = await call("/rules", { method: "POST", body: { not: "an array" }, token: ADMIN_TOKEN });
    check("POST /rules with non-array -> 400", r.status === 400);
  }

  // --- invalid approval id shape -> 400 ---
  {
    const r = await call("/approval/not-a-uuid", { method: "GET" });
    check("GET /approval/<bad-id> -> 400", r.status === 400);
  }

  await execCtx.drain();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run();
