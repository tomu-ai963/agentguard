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

// Discord rejects the whole webhook call when any embed field exceeds its
// length limit, so clip everything (title 256, description 4096, value 1024).
const trunc = (v, n) => String(v ?? "—").slice(0, n) || "—";

export async function send(payload, env) {
  const url = env.DISCORD_WEBHOOK_URL;
  if (!url) {
    // Throw so notifier/index.js counts this as a delivery failure instead
    // of silently dropping the alert.
    throw new Error("DISCORD_WEBHOOK_URL not set");
  }

  const color = COLORS[payload.level] ?? COLORS.info;

  const fields = [
    { name: "Agent", value: trunc(payload.agentId, 1024), inline: true },
    { name: "Verdict", value: trunc(payload.verdict, 1024), inline: true },
  ];
  if (payload.action) {
    fields.push({ name: "Action", value: trunc(payload.action, 1024), inline: true });
  }
  if (payload.approvalId) {
    fields.push({
      name: "Approval ID",
      value: `\`${trunc(payload.approvalId, 100)}\``,
      inline: false,
    });
  }
  if (Array.isArray(payload.fields)) {
    fields.push(...payload.fields.slice(0, 20).map((f) => ({
      name: trunc(f?.name, 256), value: trunc(f?.value, 1024), inline: !!f?.inline,
    })));
  }

  const body = {
    username: "AgentGuard",
    embeds: [
      {
        title: trunc(payload.title ?? "AgentGuard alert", 256),
        description: String(payload.message ?? "").slice(0, 4096),
        color,
        fields: fields.slice(0, 25),
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
