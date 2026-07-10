// notifier/index.js
// Channel-agnostic notification layer.
// Add a new channel by writing an adapter with the same shape and registering it here.
//
// An adapter is: async function send(payload, env) -> void (throws on failure,
// including missing webhook config — silent drops hide real outages)
// payload: { level, title, message, agentId, action, verdict, approvalId?, fields? }
//
// Active channels come from env.NOTIFY_CHANNELS (comma-separated, e.g.
// "discord,slack"); defaults to "discord".

import { send as discordSend } from "./discord.js";
import { send as slackSend } from "./slack.js";

const ADAPTERS = {
  discord: discordSend,
  slack: slackSend,
};

export function configuredChannels(env) {
  return String(env.NOTIFY_CHANNELS ?? "discord")
    .split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Dispatch a notification to the configured channel(s).
 * Notification failures must never block the judge engine, but they are
 * reported back so callers can audit-log them.
 * @returns {Promise<{ok: boolean, failed: string[]}>}
 */
export async function notify(payload, env, channels) {
  channels = channels ?? configuredChannels(env);
  const results = await Promise.allSettled(
    channels.map((ch) => {
      const adapter = ADAPTERS[ch];
      if (!adapter) {
        return Promise.reject(new Error(`Unknown notify channel: ${ch}`));
      }
      return adapter(payload, env);
    })
  );
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      failed.push(channels[i]);
      console.error(`notify failed (${channels[i]}):`, r.reason);
    }
  });
  return { ok: failed.length === 0, failed };
}
