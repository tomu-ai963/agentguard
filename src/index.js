// index.js — AgentGuard v0 Worker
// Endpoints:
//   POST /check            judge an action before the agent runs it (the core)   [agent]
//   POST /heartbeat        liveness + metrics update                             [agent]
//   POST /log              append an audit-trail entry                           [agent]
//   GET  /state/:id        read agent state (dashboard / local daemon)           [agent]
//   POST /reset/:id        zero an agent's spend/loop counters                   [admin]
//   POST /killswitch/:id   set/clear manual emergency stop  { active: bool }     [admin]
//   GET  /approval/:rid    poll an approval decision (wrapper waits on this)     [agent]
//   POST /approval/:rid    resolve an approval { status: "approved"|"denied" }   [admin]
//   GET  /rules            list rules                                            [agent]
//   POST /rules            replace rules                                         [admin]
//
// Auth: every route except GET / requires
//   Authorization: Bearer <AGENT_TOKEN | ADMIN_TOKEN>
// [admin] routes accept only ADMIN_TOKEN. Comparison is constant-time and
// repeated failures lock the source IP out (see auth.js). Routes fail closed
// (503) until both secrets are set.

import { judge } from "./engine.js";
import { notify } from "./notifier/index.js";
import { authorize } from "./auth.js";
import {
  validAgentId, validRequestId, cleanString,
  sanitizeMetrics, sanitizeLogEntry, validateRules, MAX_BODY_BYTES,
} from "./validate.js";
import {
  getRules, setRules, getState, setState, appendLog,
  isKillswitchActive, setKillswitch,
  createApproval, getApproval, resolveApproval,
} from "./store.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json" },
  });

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readJson(req) {
  const declared = Number(req.headers.get("Content-Length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
  try { return JSON.parse(text); } catch { throw new HttpError(400, "invalid JSON body"); }
}

function levelFromVerdict(v) {
  return v === "stop" ? "stop" : v === "pause" ? "pause" : v === "throttle" ? "warn" : "info";
}

// Send a notification and record delivery failures in the audit trail so a
// missed pause/stop alert never fails silently.
async function notifyAndAudit(env, agentId, payload) {
  const res = await notify(payload, env);
  if (res.failed.length) {
    await appendLog(env, agentId, {
      action: "notify_failed",
      verdict: payload.verdict,
      reason: `notification failed on: ${res.failed.join(", ")}`,
      source: "guard",
    });
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method;

    try {
      if (method === "GET" && pathname === "/") {
        return json({ service: "AgentGuard", version: "0.2.0" });
      }

      // ---- auth gate: everything below requires a token ----
      const isAdminRoute =
        (method === "POST" && (pathname === "/rules" ||
          pathname.startsWith("/killswitch/") ||
          pathname.startsWith("/approval/") ||
          pathname.startsWith("/reset/")));
      const auth = await authorize(req, env, isAdminRoute ? "admin" : "agent");
      if (!auth.ok) return json({ error: auth.error }, auth.status);

      // ---- POST /check : the core judge path ----
      if (method === "POST" && pathname === "/check") {
        const ctx = await readJson(req);
        if (!validAgentId(ctx.agentId)) {
          return json({ error: "agentId must match [A-Za-z0-9][A-Za-z0-9_.-]{0,63}" }, 400);
        }
        const agentId = ctx.agentId;
        const action = cleanString(ctx.action, 256);
        const tool = cleanString(ctx.tool, 128);
        const params = ctx.params && typeof ctx.params === "object" ? ctx.params : {};
        const supplied = sanitizeMetrics(ctx.metrics);

        // Enrich metrics with derived facts the engine understands.
        // Spend counters are monotonic: an agent (or whoever holds its token)
        // can never lower its own recorded cost to slip under a cap.
        const state = await getState(env, agentId);
        const ksActive = await isKillswitchActive(env, agentId);
        const now = Date.now();
        const metrics = {
          ...supplied,
          loopCount: supplied.loopCount ?? state.loopCount ?? 0,
          costUSD: Math.max(supplied.costUSD ?? 0, state.costUSD ?? 0),
          tokensUsed: Math.max(supplied.tokensUsed ?? 0, state.tokensUsed ?? 0),
          secondsSinceHeartbeat: state.lastHeartbeat
            ? Math.floor((now - state.lastHeartbeat) / 1000)
            : 0,
          killswitch: ksActive ? 1 : 0,
        };

        const rules = await getRules(env);
        const result = judge(rules, { agentId, action, tool, params, metrics });

        // For pause verdicts, open an approval request the wrapper can poll.
        let approvalId;
        if (result.verdict === "pause") {
          const appr = await createApproval(env, {
            agentId, action, tool,
            reason: result.reason, ruleId: result.ruleId,
          });
          approvalId = appr.requestId;
        }

        await appendLog(env, agentId, {
          action, tool,
          verdict: result.verdict, reason: result.reason, ruleId: result.ruleId,
          source: "guard",
        });

        if (result.notify) {
          await notifyAndAudit(env, agentId, {
            level: levelFromVerdict(result.verdict),
            title: `AgentGuard: ${result.verdict.toUpperCase()}`,
            message: result.reason,
            agentId, action, verdict: result.verdict, approvalId,
          });
        }

        return json({
          verdict: result.verdict,
          reason: result.reason,
          waitMs: result.waitMs,
          ruleId: result.ruleId,
          matched: result.matched,
          ...(approvalId ? { approvalId } : {}),
        });
      }

      // ---- POST /heartbeat ----
      if (method === "POST" && pathname === "/heartbeat") {
        const body = await readJson(req);
        if (!validAgentId(body.agentId)) return json({ error: "invalid agentId" }, 400);
        const metrics = sanitizeMetrics(body.metrics);
        // Spend counters stay monotonic here too; reset only via POST /reset/:id.
        const cur = await getState(env, body.agentId);
        if (metrics.costUSD !== undefined) {
          metrics.costUSD = Math.max(metrics.costUSD, cur.costUSD ?? 0);
        }
        if (metrics.tokensUsed !== undefined) {
          metrics.tokensUsed = Math.max(metrics.tokensUsed, cur.tokensUsed ?? 0);
        }
        const next = await setState(env, body.agentId, {
          ...metrics,
          status: "alive",
          lastHeartbeat: Date.now(),
        });
        return json({ ok: true, state: next });
      }

      // ---- POST /log ----
      if (method === "POST" && pathname === "/log") {
        const body = await readJson(req);
        if (!validAgentId(body.agentId)) return json({ error: "invalid agentId" }, 400);
        const entry = sanitizeLogEntry(body);
        await appendLog(env, body.agentId, { ...entry, source: "agent" });
        return json({ ok: true });
      }

      // ---- GET /state/:id ----
      if (method === "GET" && pathname.startsWith("/state/")) {
        const agentId = decodeURIComponent(pathname.slice("/state/".length));
        if (!validAgentId(agentId)) return json({ error: "invalid agentId" }, 400);
        return json(await getState(env, agentId));
      }

      // ---- POST /reset/:id (admin) : zero spend/loop counters ----
      if (method === "POST" && pathname.startsWith("/reset/")) {
        const agentId = decodeURIComponent(pathname.slice("/reset/".length));
        if (!validAgentId(agentId)) return json({ error: "invalid agentId" }, 400);
        const next = await setState(env, agentId, {
          tokensUsed: 0, costUSD: 0, loopCount: 0,
        });
        await appendLog(env, agentId, {
          action: "counters_reset", verdict: "allow",
          reason: "spend/loop counters reset by admin", source: "admin",
        });
        return json({ ok: true, state: next });
      }

      // ---- POST /killswitch/:id (admin) ----
      if (method === "POST" && pathname.startsWith("/killswitch/")) {
        const agentId = decodeURIComponent(pathname.slice("/killswitch/".length));
        if (!validAgentId(agentId)) return json({ error: "invalid agentId" }, 400);
        const { active } = await readJson(req);
        await setKillswitch(env, agentId, !!active);
        await appendLog(env, agentId, {
          action: "killswitch", verdict: active ? "stop" : "allow",
          reason: `manual kill switch ${active ? "engaged" : "released"}`, source: "admin",
        });
        await notifyAndAudit(env, agentId, {
          level: active ? "stop" : "info",
          title: `AgentGuard: kill switch ${active ? "ENGAGED" : "released"}`,
          message: `Manual kill switch ${active ? "engaged" : "released"} for ${agentId}`,
          agentId, verdict: active ? "stop" : "allow",
        });
        return json({ ok: true, agentId, killswitch: !!active });
      }

      // ---- GET /approval/:rid (wrapper polls this) ----
      if (method === "GET" && pathname.startsWith("/approval/")) {
        const rid = decodeURIComponent(pathname.slice("/approval/".length));
        if (!validRequestId(rid)) return json({ error: "invalid approval id" }, 400);
        const rec = await getApproval(env, rid);
        if (!rec) return json({ error: "not found or expired" }, 404);
        return json(rec);
      }

      // ---- POST /approval/:rid (admin resolves) ----
      if (method === "POST" && pathname.startsWith("/approval/")) {
        const rid = decodeURIComponent(pathname.slice("/approval/".length));
        if (!validRequestId(rid)) return json({ error: "invalid approval id" }, 400);
        const { status } = await readJson(req);
        if (!["approved", "denied"].includes(status)) {
          return json({ error: "status must be approved|denied" }, 400);
        }
        const rec = await resolveApproval(env, rid, status);
        if (!rec) return json({ error: "not found or expired" }, 404);
        if (rec.alreadyResolved) {
          return json({ error: `already ${rec.status}`, approval: rec }, 409);
        }
        await appendLog(env, rec.agentId ?? "system", {
          action: "approval_resolved", verdict: status === "approved" ? "allow" : "stop",
          reason: `approval ${rid} ${status}`, ruleId: rec.ruleId, source: "admin",
        });
        return json({ ok: true, approval: rec });
      }

      // ---- GET /rules ----
      if (method === "GET" && pathname === "/rules") {
        return json(await getRules(env));
      }

      // ---- POST /rules (admin) ----
      if (method === "POST" && pathname === "/rules") {
        const rules = await readJson(req);
        const err = validateRules(rules);
        if (err) return json({ error: err }, 400);
        await setRules(env, rules);
        await appendLog(env, "system", {
          action: "rules_update", verdict: "allow",
          reason: `rule set replaced (${rules.length} rules)`, source: "admin",
        });
        return json({ ok: true, count: rules.length });
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      // Never echo internals to the client; details go to the Worker log only.
      console.error("unhandled error:", err);
      return json({ error: "internal error" }, 500);
    }
  },
};
