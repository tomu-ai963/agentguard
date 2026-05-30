// notifier/slack.js
// v2 stub. Same shape as discord.js so notifier/index.js can register it with
// one line. Fill in when a user actually needs Slack — no engine changes needed.

export async function send(payload, env) {
  const url = env.SLACK_WEBHOOK_URL;
  if (!url) {
    console.error("SLACK_WEBHOOK_URL not set; skipping notification");
    return;
  }
  // Slack incoming-webhook payload. Block Kit buttons (approval) come in v2.
  const emoji = { stop: ":red_circle:", pause: ":large_orange_circle:",
                  warn: ":large_yellow_circle:", info: ":large_blue_circle:" }[payload.level] ?? "";
  const lines = [
    `${emoji} *${payload.title ?? "AgentGuard alert"}*`,
    payload.message ?? "",
    `agent: \`${payload.agentId ?? "—"}\`  verdict: \`${payload.verdict ?? "—"}\``,
    payload.approvalId ? `approvalId: \`${payload.approvalId}\`` : "",
  ].filter(Boolean);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: lines.join("\n") }),
  });
  if (!res.ok) throw new Error(`Slack webhook ${res.status}: ${await res.text()}`);
}
