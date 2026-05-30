// notifier/discord.js
// Discord adapter: sends a rich embed via webhook.
// v0 sends plain notifications. For `pause` events it includes the approvalId
// so the operator can approve via the dashboard or (v1) Discord buttons.

const COLORS = {
  info: 0x3498db,    // blue
  warn: 0xf1c40f,    // yellow  (throttle)
  pause: 0xe67e22,   // orange  (needs approval)
  stop: 0xe74c3c,    // red     (runaway / hard stop)
};

export async function send(payload, env) {
  const url = env.DISCORD_WEBHOOK_URL;
  if (!url) {
    console.error("DISCORD_WEBHOOK_URL not set; skipping notification");
    return;
  }

  const color = COLORS[payload.level] ?? COLORS.info;

  const fields = [
    { name: "Agent", value: String(payload.agentId ?? "—"), inline: true },
    { name: "Verdict", value: String(payload.verdict ?? "—"), inline: true },
  ];
  if (payload.action) {
    fields.push({ name: "Action", value: String(payload.action), inline: true });
  }
  if (payload.approvalId) {
    fields.push({
      name: "Approval ID",
      value: `\`${payload.approvalId}\``,
      inline: false,
    });
  }
  if (Array.isArray(payload.fields)) fields.push(...payload.fields);

  const body = {
    username: "AgentGuard",
    embeds: [
      {
        title: payload.title ?? "AgentGuard alert",
        description: payload.message ?? "",
        color,
        fields,
        timestamp: new Date().toISOString(),
      },
    ],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Discord webhook ${res.status}: ${await res.text()}`);
  }
}
