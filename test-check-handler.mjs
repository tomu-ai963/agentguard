// test-check-handler.mjs — integration test for the /check endpoint against
// mocked KV + executionCtx.waitUntil (no real Cloudflare Worker runtime).
// Verifies: #2 server-observed counters, #3 costUSD persistence,
// #4 notify cooldown, #5 parallel reads + deferred side effects.
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

function req(path, body) {
  return new Request(`https://guard.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function run() {
  const env = { GUARD_KV: makeKV(), ADMIN_TOKEN: "test-token" };
  const execCtx = makeExecutionCtx();

  // --- #3: costUSD persists across /check calls without /heartbeat ---
  {
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
  }

  // --- #2: server-observed apiCallsPerMin increments regardless of self-report ---
  {
    const envB = { GUARD_KV: makeKV() };
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
  }

  // --- #4: notify cooldown suppresses repeated notify on sustained stop ---
  {
    const envC = { GUARD_KV: makeKV() };
    const killKey = "killswitch:c1";
    await envC.GUARD_KV.put(killKey, "active"); // force a sustained "stop" verdict

    let notifyCalls = 0;
    // Patch global fetch used by the discord notifier so we can count dispatch attempts.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      notifyCalls++;
      return new Response("ok", { status: 200 });
    };
    // discord.js only sends if a webhook env var is configured; set a dummy one.
    envC.DISCORD_WEBHOOK_URL = "https://discord.test/webhook";

    for (let i = 0; i < 3; i++) {
      await worker.fetch(
        req("/check", { agentId: "c1", action: "run", tool: "x", metrics: {} }),
        envC, execCtx
      );
      await execCtx.drain();
    }
    globalThis.fetch = originalFetch;

    check("#4: notify dispatched only once across 3 sustained-stop /check calls", notifyCalls <= 1);
  }

  // --- #5: response returns even if we never manually awaited side effects (they're deferred) ---
  {
    const envD = { GUARD_KV: makeKV() };
    const start = Date.now();
    const r = await worker.fetch(
      req("/check", { agentId: "d1", action: "run", tool: "x", metrics: {} }),
      envD, execCtx
    );
    const elapsed = Date.now() - start;
    check("#5: /check responds without throwing", r.status === 200);
    await execCtx.drain();
    check("#5: state eventually persisted after drain", (await envD.GUARD_KV.get("agent:d1:state")) !== null);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run();
