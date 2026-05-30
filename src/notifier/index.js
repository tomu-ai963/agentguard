// notifier/index.js
// Channel-agnostic notification layer.
// Add a new channel by writing an adapter with the same shape and registering it here.
//
// An adapter is: async function send(payload, env) -> void
// payload: { level, title, message, agentId, action, verdict, approvalId?, fields? }

import { send as discordSend } from "./discord.js";
// import { send as slackSend } from "./slack.js"; // v2: uncomment when needed

const ADAPTERS = {
  discord: discordSend,
  // slack: slackSend,
};

/**
 * Dispatch a notification to the configured channel(s).
 * @param {object} payload  normalized event payload
 * @param {object} env      Worker env (holds webhook URLs etc.)
 * @param {string[]} [channels]  defaults to ["discord"]
 */
export async function notify(payload, env, channels = ["discord"]) {
  const results = await Promise.allSettled(
    channels.map((ch) => {
      const adapter = ADAPTERS[ch];
      if (!adapter) {
        return Promise.reject(new Error(`Unknown notify channel: ${ch}`));
      }
      return adapter(payload, env);
    })
  );
  // Notification failures must never block the judge engine.
  for (const r of results) {
    if (r.status === "rejected") console.error("notify failed:", r.reason);
  }
}
