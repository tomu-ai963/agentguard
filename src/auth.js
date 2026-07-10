// auth.js
// Token auth + brute-force lockout.
//
// Two credentials (both Worker secrets, both REQUIRED — routes fail closed
// with 503 until they are set):
//   ADMIN_TOKEN  full control: rules, approvals, killswitch, counter reset
//   AGENT_TOKEN  agents/wrappers: /check /heartbeat /log, polling /approval,
//                reading /state and /rules. The admin token also satisfies it.
//
// Set with:
//   npx wrangler secret put ADMIN_TOKEN
//   npx wrangler secret put AGENT_TOKEN

const MAX_FAILURES = 10;   // failed attempts per IP before lockout
const LOCKOUT_TTL = 600;   // lockout window in seconds

const enc = new TextEncoder();

// Hash both sides before comparing so comparison time does not depend on
// where the strings first differ (constant-time equality).
async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(a))),
    crypto.subtle.digest("SHA-256", enc.encode(String(b))),
  ]);
  const va = new Uint8Array(ha), vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

function bearerToken(req) {
  const auth = req.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : "";
}

function clientIp(req) {
  return req.headers.get("CF-Connecting-IP") || "unknown";
}

const lockKey = (ip) => `ratelimit:authfail:${ip}`;

async function isLockedOut(env, ip) {
  const raw = await env.GUARD_KV.get(lockKey(ip));
  return raw !== null && Number(raw) >= MAX_FAILURES;
}

// KV counters are racy under parallel requests; close enough for a lockout.
async function recordFailure(env, ip) {
  const key = lockKey(ip);
  const n = Number(await env.GUARD_KV.get(key)) || 0;
  await env.GUARD_KV.put(key, String(n + 1), { expirationTtl: LOCKOUT_TTL });
}

/**
 * @param {"admin"|"agent"} role  minimum required role
 * @returns {Promise<{ok:true, role:string}|{ok:false, status:number, error:string}>}
 */
export async function authorize(req, env, role) {
  if (!env.ADMIN_TOKEN || (role === "agent" && !env.AGENT_TOKEN)) {
    return { ok: false, status: 503, error: "auth not configured (set ADMIN_TOKEN / AGENT_TOKEN secrets)" };
  }
  const ip = clientIp(req);
  if (await isLockedOut(env, ip)) {
    return { ok: false, status: 429, error: "too many failed auth attempts; retry later" };
  }
  const token = bearerToken(req);
  if (token) {
    if (await safeEqual(token, env.ADMIN_TOKEN)) return { ok: true, role: "admin" };
    if (role === "agent" && env.AGENT_TOKEN && await safeEqual(token, env.AGENT_TOKEN)) {
      return { ok: true, role: "agent" };
    }
  }
  await recordFailure(env, ip);
  return { ok: false, status: 401, error: "unauthorized" };
}
