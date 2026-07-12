// store.js
// Thin wrapper over Workers KV. Centralizes key naming so the data model
// lives in one place (easy to evolve / export for audit later).

import { DEFAULT_RULES } from "./rules.default.js";

const K = {
  state: (id) => `agent:${id}:state`,
  rules: () => `rules:global`,
  approval: (rid) => `approval:${rid}`,
  killswitch: (id) => `killswitch:${id}`,
  notifyCooldown: (agentId, ruleId) => `notified:${agentId}:${ruleId}`,
};

// #7: fields that get their own audit_log columns; everything else on an entry
// is folded into the `detail` JSON blob.
const AUDIT_COLUMNS = new Set(["eventType", "actor", "source", "verdict", "ruleId"]);
const MAX_LOG_LIMIT = 500;

const NOTIFY_COOLDOWN_SECONDS = 600; // 10 minutes

export async function getRules(env) {
  const raw = await env.GUARD_KV.get(K.rules());
  if (!raw) {
    await env.GUARD_KV.put(K.rules(), JSON.stringify(DEFAULT_RULES));
    return DEFAULT_RULES;
  }
  try { return JSON.parse(raw); } catch { return DEFAULT_RULES; }
}

export async function setRules(env, rules) {
  await env.GUARD_KV.put(K.rules(), JSON.stringify(rules));
}

export async function getState(env, agentId) {
  const raw = await env.GUARD_KV.get(K.state(agentId));
  return raw ? JSON.parse(raw) : {
    agentId, status: "unknown", lastHeartbeat: null,
    tokensUsed: 0, costUSD: 0, loopCount: 0,
  };
}

export async function setState(env, agentId, patch) {
  const cur = await getState(env, agentId);
  const next = { ...cur, ...patch, agentId };
  await env.GUARD_KV.put(K.state(agentId), JSON.stringify(next));
  return next;
}

// Server-observed counters: independent from anything the caller self-reports.
// Called once per /check regardless of what the agent claims about itself.
export async function incrementCheckCounters(env, agentId) {
  const cur = await getState(env, agentId);
  const now = Date.now();
  const windowStart = cur.rateWindowStart ?? now;
  const withinWindow = now - windowStart < 60_000;

  const next = {
    ...cur,
    agentId,
    checkCount: (cur.checkCount ?? 0) + 1,
    rateWindowStart: withinWindow ? windowStart : now,
    apiCallsInWindow: (withinWindow ? (cur.apiCallsInWindow ?? 0) : 0) + 1,
  };
  await env.GUARD_KV.put(K.state(agentId), JSON.stringify(next));
  return next;
}

// #7: append one audit-trail entry to D1 (was write-only KV, now readable via
// queryLogs / GET /logs). Callers still pass a flat `entry`; we promote the
// audit columns and stash the rest as JSON `detail`.
//   eventType : approval | killswitch | rule_change | reset | check | ...
//               (falls back to entry.action, then "log")
//   actor     : admin | agent | guard | system  (from entry.actor|entry.source)
// Writes are invoked via executionCtx.waitUntil (#5), so they never block the
// judge response.
export async function appendLog(env, agentId, entry) {
  const ts = Date.now();
  const e = entry && typeof entry === "object" ? entry : {};
  const eventType = e.eventType ?? e.action ?? "log";
  const actor = e.actor ?? e.source ?? "system";
  const verdict = e.verdict ?? null;
  const ruleId = e.ruleId ?? null;

  const detailObj = {};
  for (const [k, v] of Object.entries(e)) {
    if (!AUDIT_COLUMNS.has(k) && v !== undefined) detailObj[k] = v;
  }
  const detail = JSON.stringify(detailObj);

  if (!env.GUARD_DB) {
    // Audit sink not bound (misconfig, or a harness that doesn't need it):
    // never let logging break the request path.
    console.error("appendLog: GUARD_DB not bound; dropping audit entry", { eventType, agentId });
    return;
  }

  await env.GUARD_DB
    .prepare(
      `INSERT INTO audit_log (ts, agent_id, event_type, actor, verdict, rule_id, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(ts, agentId, eventType, actor, verdict, ruleId, detail)
    .run();
}

// #7: read the audit trail (admin dashboard / GET /logs). Newest first,
// optionally filtered by agentId and/or eventType.
export async function queryLogs(env, { agentId, eventType, limit = 100 } = {}) {
  if (!env.GUARD_DB) return [];
  const clauses = [];
  const binds = [];
  if (agentId) { clauses.push("agent_id = ?"); binds.push(agentId); }
  if (eventType) { clauses.push("event_type = ?"); binds.push(eventType); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const cap = Math.min(Math.max(1, Number(limit) || 100), MAX_LOG_LIMIT);
  binds.push(cap);

  const { results } = await env.GUARD_DB
    .prepare(
      `SELECT id, ts, agent_id, event_type, actor, verdict, rule_id, detail
       FROM audit_log ${where} ORDER BY ts DESC, id DESC LIMIT ?`
    )
    .bind(...binds)
    .all();

  return (results ?? []).map((r) => ({
    id: r.id,
    ts: r.ts,
    agentId: r.agent_id,
    eventType: r.event_type,
    actor: r.actor,
    verdict: r.verdict ?? undefined,
    ruleId: r.rule_id ?? undefined,
    detail: safeParse(r.detail),
  }));
}

function safeParse(s) {
  if (typeof s !== "string" || s === "") return {};
  try { return JSON.parse(s); } catch { return {}; }
}

export async function isKillswitchActive(env, agentId) {
  return (await env.GUARD_KV.get(K.killswitch(agentId))) === "active";
}

export async function setKillswitch(env, agentId, active) {
  if (active) await env.GUARD_KV.put(K.killswitch(agentId), "active");
  else await env.GUARD_KV.delete(K.killswitch(agentId));
}

export async function createApproval(env, data) {
  const rid = crypto.randomUUID();
  const record = { requestId: rid, status: "pending", createdAt: Date.now(), ...data };
  // Approvals expire after 1h so stale pauses don't linger.
  await env.GUARD_KV.put(K.approval(rid), JSON.stringify(record), { expirationTtl: 3600 });
  return record;
}

export async function getApproval(env, rid) {
  const raw = await env.GUARD_KV.get(K.approval(rid));
  return raw ? JSON.parse(raw) : null;
}

export async function resolveApproval(env, rid, status) {
  const rec = await getApproval(env, rid);
  if (!rec) return null;
  // First decision wins; a resolved approval cannot be flipped afterwards.
  if (rec.status !== "pending") return { ...rec, alreadyResolved: true };
  rec.status = status;
  rec.resolvedAt = Date.now();
  await env.GUARD_KV.put(K.approval(rid), JSON.stringify(rec), { expirationTtl: 3600 });
  return rec;
}

// Notification cooldown: prevents a sustained stop/pause verdict from
// spamming the notify channel on every /check retry loop.
// Returns true if a notification is allowed to be sent right now, and
// atomically marks the cooldown as started (best-effort; KV has no CAS,
// so a rare double-send under high concurrency is an acceptable tradeoff
// vs. the alternative of a silent notify channel).
export async function shouldNotify(env, agentId, ruleId) {
  const key = K.notifyCooldown(agentId, ruleId);
  const existing = await env.GUARD_KV.get(key);
  if (existing) return false;
  await env.GUARD_KV.put(key, "1", { expirationTtl: NOTIFY_COOLDOWN_SECONDS });
  return true;
}
