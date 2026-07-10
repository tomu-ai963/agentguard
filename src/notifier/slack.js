// notifier/slack.js
// Slack incoming-webhook adapter. Registered in notifier/index.js; enable by
// adding "slack" to NOTIFY_CHANNELS and setting the SLACK_WEBHOOK_URL secret.

export async function send(payload, env) {
  const url = env.SLACK_WEBHOOK_URL;
  if (!url) {
    // Throw so notifier/index.js counts this as a delivery failure instead
    // of silently dropping the alert (e.g. channel enabled but secret unset).
    throw new Error("SLACK_WEBHOOK_URL not set");
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
