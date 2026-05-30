// index.js — AgentGuard v0 Worker
// Endpoints:
//   POST /check            judge an action before the agent runs it (the core)
//   POST /heartbeat        liveness + metrics update
//   POST /log              append an audit-trail entry
//   GET  /state/:id        read agent state (dashboard / local daemon)
//   POST /killswitch/:id   set/clear manual emergency stop  { active: bool }
//   GET  /approval/:rid    poll an approval decision (wrapper waits on this)
//   POST /approval/:rid    resolve an approval { status: "approved"|"denied" } [admin]
//   GET  /rules            list rules
//   POST /rules            replace rules [admin]   (add new runaway patterns here)
//
// Auth (v0, intentionally simple): admin routes require header
//   Authorization: Bearer <ADMIN_TOKEN>

import { judge } from "./engine.js";
import { notify } from "./notifier/index.js";
import {
  getRules, setRules, getState, setState, appendLog,
  isKillswitchActive, setKillswitch,
  createApproval, getApproval, resolveApproval,
} from "./store.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json" },
  });

function requireAdmin(req, env) {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  return env.ADMIN_TOKEN && token === env.ADMIN_TOKEN;
}

function levelFromVerdict(v) {
  return v === "stop" ? "stop" : v === "pause" ? "pause" : v === "throttle" ? "warn" : "info";
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method;

    try {
      // ---- POST /check : the core judge path ----
      if (method === "POST" && pathname === "/check") {
        const ctx = await req.json();
        const { agentId } = ctx;
        if (!agentId) return json({ error: "agentId required" }, 400);

        // Enrich metrics with derived facts the engine understands.
        const state = await getState(env, agentId);
        const ksActive = await isKillswitchActive(env, agentId);
        const now = Date.now();
        const metrics = {
          ...(ctx.metrics ?? {}),
          loopCount: ctx.metrics?.loopCount ?? state.loopCount ?? 0,
          costUSD: ctx.metrics?.costUSD ?? state.costUSD ?? 0,
          tokensUsed: ctx.metrics?.tokensUsed ?? state.tokensUsed ?? 0,
          secondsSinceHeartbeat: state.lastHeartbeat
            ? Math.floor((now - state.lastHeartbeat) / 1000)
            : 0,
          killswitch: ksActive ? 1 : 0,
        };

        const rules = await getRules(env);
        const result = judge(rules, { ...ctx, metrics });

        // For pause verdicts, open an approval request the wrapper can poll.
        let approvalId;
        if (result.verdict === "pause") {
          const appr = await createApproval(env, {
            agentId, action: ctx.action, tool: ctx.tool,
            reason: result.reason, ruleId: result.ruleId,
          });
          approvalId = appr.requestId;
        }

        await appendLog(env, agentId, {
          action: ctx.action, tool: ctx.tool,
          verdict: result.verdict, reason: result.reason, ruleId: result.ruleId,
        });

        if (result.notify) {
          await notify({
            level: levelFromVerdict(result.verdict),
            title: `AgentGuard: ${result.verdict.toUpperCase()}`,
            message: result.reason,
            agentId, action: ctx.action, verdict: result.verdict, approvalId,
          }, env);
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
        const { agentId, metrics } = await req.json();
        if (!agentId) return json({ error: "agentId required" }, 400);
        const next = await setState(env, agentId, {
          status: "alive",
          lastHeartbeat: Date.now(),
          ...(metrics ?? {}),
        });
        return json({ ok: true, state: next });
      }

      // ---- POST /log ----
      if (method === "POST" && pathname === "/log") {
        const { agentId, ...entry } = await req.json();
        if (!agentId) return json({ error: "agentId required" }, 400);
        await appendLog(env, agentId, entry);
        return json({ ok: true });
      }

      // ---- GET /state/:id ----
      if (method === "GET" && pathname.startsWith("/state/")) {
        const agentId = decodeURIComponent(pathname.slice("/state/".length));
        return json(await getState(env, agentId));
      }

      // ---- POST /killswitch/:id ----
      if (method === "POST" && pathname.startsWith("/killswitch/")) {
        if (!requireAdmin(req, env)) return json({ error: "unauthorized" }, 401);
        const agentId = decodeURIComponent(pathname.slice("/killswitch/".length));
        const { active } = await req.json();
        await setKillswitch(env, agentId, !!active);
        await notify({
          level: active ? "stop" : "info",
          title: `AgentGuard: kill switch ${active ? "ENGAGED" : "released"}`,
          message: `Manual kill switch ${active ? "engaged" : "released"} for ${agentId}`,
          agentId, verdict: active ? "stop" : "allow",
        }, env);
        return json({ ok: true, agentId, killswitch: !!active });
      }

      // ---- GET /approval/:rid (wrapper polls this) ----
      if (method === "GET" && pathname.startsWith("/approval/")) {
        const rid = decodeURIComponent(pathname.slice("/approval/".length));
        const rec = await getApproval(env, rid);
        if (!rec) return json({ error: "not found or expired" }, 404);
        return json(rec);
      }

      // ---- POST /approval/:rid (admin resolves) ----
      if (method === "POST" && pathname.startsWith("/approval/")) {
        if (!requireAdmin(req, env)) return json({ error: "unauthorized" }, 401);
        const rid = decodeURIComponent(pathname.slice("/approval/".length));
        const { status } = await req.json();
        if (!["approved", "denied"].includes(status))
          return json({ error: "status must be approved|denied" }, 400);
        const rec = await resolveApproval(env, rid, status);
        if (!rec) return json({ error: "not found or expired" }, 404);
        return json({ ok: true, approval: rec });
      }

      // ---- GET /rules ----
      if (method === "GET" && pathname === "/rules") {
        return json(await getRules(env));
      }

      // ---- POST /rules (admin) ----
      if (method === "POST" && pathname === "/rules") {
        if (!requireAdmin(req, env)) return json({ error: "unauthorized" }, 401);
        const rules = await req.json();
        if (!Array.isArray(rules)) return json({ error: "expected an array of rules" }, 400);
        await setRules(env, rules);
        return json({ ok: true, count: rules.length });
      }

      if (pathname === "/" ) return json({ service: "AgentGuard", version: "0.1.0" });
      return json({ error: "not found" }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: String(err?.message ?? err) }, 500);
    }
  },
};
