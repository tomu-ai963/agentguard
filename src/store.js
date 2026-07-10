// store.js
// Thin wrapper over Workers KV. Centralizes key naming so the data model
// lives in one place (easy to evolve / export for audit later).

import { DEFAULT_RULES } from "./rules.default.js";

const LOG_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days of audit trail

const K = {
  state: (id) => `agent:${id}:state`,
  log: (id, ts) => `agent:${id}:log:${ts}`,
  rules: () => `rules:global`,
  approval: (rid) => `approval:${rid}`,
  killswitch: (id) => `killswitch:${id}`,
};

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

export async function appendLog(env, agentId, entry) {
  const ts = Date.now();
  // Random suffix so two entries in the same millisecond can't overwrite
  // each other (audit-trail integrity).
  const key = `${K.log(agentId, ts)}:${crypto.randomUUID().slice(0, 8)}`;
  await env.GUARD_KV.put(
    key,
    JSON.stringify({ ts, ...entry }),
    { expirationTtl: LOG_TTL_SECONDS }
  );
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
