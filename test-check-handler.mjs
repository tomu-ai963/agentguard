// test-check-handler.mjs — integration test for the /check endpoint against
// mocked KV + executionCtx.waitUntil (no real Cloudflare Worker runtime).
// Verifies: auth gate (401/503), #2 server-observed counters,
// #3 costUSD persistence + monotonicity, #4 notify cooldown,
// #5 parallel reads + deferred side effects.
// Run:  node test-check-handler.mjs
import worker from "./src/index.js";

let pass = 0, fail = 0;
function check(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  cond ? pass++ : fail++;
}

function makeKV() {
  const map = new Map();
  return {
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
    _dump() { return map; },
  };
}

function makeExecutionCtx() {
  const pending = [];
  return {
    waitUntil(p) { pending.push(p); },
    async drain() { await Promise.all(pending); pending.length = 0; },
  };
}

const ADMIN_TOKEN = "test-admin-token";
const AGENT_TOKEN = "test-agent-token";

function makeEnv(extra = {}) {
  return { GUARD_KV: makeKV(), ADMIN_TOKEN, AGENT_TOKEN, ...extra };
}

function req(path, body, token = AGENT_TOKEN) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request(`https://guard.test${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function run() {
  const execCtx = makeExecutionCtx();

  // --- auth gate ---
  {
    const env = makeEnv();
    const noAuth = await worker.fetch(
      req("/check", { agentId: "a0", action: "run", tool: "x" }, null),
      env, execCtx
    );
    check("auth: /check without Authorization -> 401", noAuth.status === 401);

    const badToken = await worker.fetch(
      req("/check", { agentId: "a0", action: "run", tool: "x" }, "wrong-token"),
      env, execCtx
    );
    check("auth: /check with wrong token -> 401", badToken.status === 401);

    const envNoSecrets = { GUARD_KV: makeKV() };
    const unconfigured = await worker.fetch(
      req("/check", { agentId: "a0", action: "run", tool: "x" }),
      envNoSecrets, execCtx
    );
    check("auth: secrets not configured -> 503 (fail closed)", unconfigured.status === 503);

    const adminOk = await worker.fetch(
      req("/check", { agentId: "a0", action: "run", tool: "read_file" }, ADMIN_TOKEN),
      env, execCtx
    );
    check("auth: admin token also satisfies agent routes", adminOk.status === 200);
    await execCtx.drain();
  }

  // --- #3: costUSD persists across /check calls without /heartbeat ---
  {
    const env = makeEnv();
    const r1 = await worker.fetch(
      req("/check", { agentId: "a1", action: "run", tool: "read_file", metrics: { costUSD: 3.5 } }),
      env, execCtx
    );
    const body1 = await r1.json();
    check("first /check with costUSD=3.5 -> pause (soft cap)", body1.verdict === "pause");
    await execCtx.drain();

    const raw = await env.GUARD_KV.get("agent:a1:state");
    const state = JSON.parse(raw);
    check("#3: costUSD persisted to state after /check (no /heartbeat call)", state.costUSD === 3.5);

    // Second call omits costUSD entirely — should fall back to persisted state, not reset to 0.
    const r2 = await worker.fetch(
      req("/check", { agentId: "a1", action: "run", tool: "read_file", metrics: {} }),
      env, execCtx
    );
    const body2 = await r2.json();
    check("#3: second /check without costUSD still sees pause (state carried over)", body2.verdict === "pause");
    await execCtx.drain();

    // Third call tries to self-report a LOWER cost — monotonic Math.max must win.
    const r3 = await worker.fetch(
      req("/check", { agentId: "a1", action: "run", tool: "read_file", metrics: { costUSD: 0.01 } }),
      env, execCtx
    );
    const body3 = await r3.json();
    check("#3: self-reported lower costUSD cannot slip under the cap (monotonic)", body3.verdict === "pause");
    await execCtx.drain();
    const state3 = JSON.parse(await env.GUARD_KV.get("agent:a1:state"));
    check("#3: persisted costUSD stays at 3.5 after lowball report", state3.costUSD === 3.5);
  }

  // --- #2: server-observed apiCallsPerMin increments regardless of self-report ---
  {
    const envB = makeEnv();
    for (let i = 0; i < 3; i++) {
      await worker.fetch(
        req("/check", { agentId: "b1", action: "run", tool: "x", metrics: {} }),
        envB, execCtx
      );
      await execCtx.drain();
    }
    const raw = await envB.GUARD_KV.get("agent:b1:state");
    const state = JSON.parse(raw);
    check("#2: server-observed checkCount reaches 3 after 3 calls", state.checkCount === 3);
    check("#2: apiCallsInWindow reaches 3 within the same minute", state.apiCallsInWindow === 3);

    // Self-reported apiCallsPerMin must be ignored (whitelist drops it,
    // server-observed value always wins).
    const rSpoof = await worker.fetch(
      req("/check", { agentId: "b1", action: "run", tool: "x", metrics: { apiCallsPerMin: 0 } }),
      envB, execCtx
    );
    check("#2: spoofed apiCallsPerMin=0 does not error", rSpoof.status === 200);
    await execCtx.drain();
    const state2 = JSON.parse(await envB.GUARD_KV.get("agent:b1:state"));
    check("#2: spoofed apiCallsPerMin ignored; server counter reaches 4", state2.apiCallsInWindow === 4);
  }

  // --- #4: notify cooldown suppresses repeated notify on sustained stop ---
  {
    const envC = makeEnv({ DISCORD_WEBHOOK_URL: "https://discord.test/webhook" });
    await envC.GUARD_KV.put("killswitch:c1", "active"); // force a sustained "stop" verdict

    let notifyCalls = 0;
    // Patch global fetch used by the discord notifier so we can count dispatch attempts.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      notifyCalls++;
      return new Response("ok", { status: 200 });
    };

    for (let i = 0; i < 3; i++) {
      await worker.fetch(
        req("/check", { agentId: "c1", action: "run", tool: "x", metrics: {} }),
        envC, execCtx
      );
      await execCtx.drain();
    }
    globalThis.fetch = originalFetch;

    check("#4: notify dispatched only once across 3 sustained-stop /check calls", notifyCalls === 1);
  }

  // --- #5: response returns even if we never manually awaited side effects (they're deferred) ---
  {
    const envD = makeEnv();
    const r = await worker.fetch(
      req("/check", { agentId: "d1", action: "run", tool: "x", metrics: {} }),
      envD, execCtx
    );
    check("#5: /check responds without throwing", r.status === 200);
    await execCtx.drain();
    check("#5: state eventually persisted after drain", (await envD.GUARD_KV.get("agent:d1:state")) !== null);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run();
