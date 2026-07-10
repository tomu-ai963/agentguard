// test-store.mjs — verify incrementCheckCounters and shouldNotify against a
// minimal in-memory KV mock (no real Cloudflare KV needed).
// Run:  node test-store.mjs
import {
  getState, incrementCheckCounters, shouldNotify,
} from "./src/store.js";

let pass = 0, fail = 0;
function check(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  cond ? pass++ : fail++;
}

// Minimal in-memory Workers KV mock: only what store.js touches.
function makeKV() {
  const map = new Map();
  return {
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
    _dump() { return map; },
  };
}

async function run() {
  // --- incrementCheckCounters ---
  {
    const env = { GUARD_KV: makeKV() };
    const s1 = await incrementCheckCounters(env, "agent-x");
    check("first check -> checkCount=1", s1.checkCount === 1);
    check("first check -> apiCallsInWindow=1", s1.apiCallsInWindow === 1);

    const s2 = await incrementCheckCounters(env, "agent-x");
    check("second check -> checkCount=2", s2.checkCount === 2);
    check("second check within window -> apiCallsInWindow=2", s2.apiCallsInWindow === 2);

    // Simulate window rollover by manually rewriting rateWindowStart into the past.
    const raw = await env.GUARD_KV.get("agent:agent-x:state");
    const state = JSON.parse(raw);
    state.rateWindowStart = Date.now() - 61_000;
    await env.GUARD_KV.put("agent:agent-x:state", JSON.stringify(state));

    const s3 = await incrementCheckCounters(env, "agent-x");
    check("after window rollover -> apiCallsInWindow resets to 1", s3.apiCallsInWindow === 1);
    check("after window rollover -> checkCount keeps accumulating (3)", s3.checkCount === 3);
  }

  // --- shouldNotify cooldown ---
  {
    const env = { GUARD_KV: makeKV() };
    const first = await shouldNotify(env, "agent-y", "cost-hard-cap");
    check("first notify for rule -> allowed", first === true);

    const second = await shouldNotify(env, "agent-y", "cost-hard-cap");
    check("immediate repeat -> blocked by cooldown", second === false);

    const otherRule = await shouldNotify(env, "agent-y", "loop-guard");
    check("different ruleId -> independent cooldown, allowed", otherRule === true);

    const otherAgent = await shouldNotify(env, "agent-z", "cost-hard-cap");
    check("different agentId -> independent cooldown, allowed", otherAgent === true);
  }

  // --- getState default shape unaffected ---
  {
    const env = { GUARD_KV: makeKV() };
    const s = await getState(env, "fresh-agent");
    check("getState default has costUSD=0", s.costUSD === 0);
    check("getState default has loopCount=0", s.loopCount === 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run();
