// test-notifier.mjs — unit tests for the notification adapters and the
// channel-agnostic notify() dispatcher. Covers what the /check integration
// test does not: the exact Discord webhook payload, and how missing config /
// HTTP failures are surfaced (adapters must throw, never silently drop).
// Run:  node test-notifier.mjs
import { send as discordSend } from "./src/notifier/discord.js";
import { notify, configuredChannels } from "./src/notifier/index.js";

let pass = 0, fail = 0;
function check(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  cond ? pass++ : fail++;
}
async function throws(name, fn) {
  let threw = false;
  try { await fn(); } catch { threw = true; }
  check(name, threw);
}

// Swap globalThis.fetch for the duration of `fn`, capturing calls.
async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return impl(url, opts); };
  try { await fn(calls); } finally { globalThis.fetch = original; }
}

const ok = () => new Response("ok", { status: 200 });
const payload = {
  level: "stop", title: "AgentGuard: STOP", message: "Cost hard cap reached",
  agentId: "tomu-cli/collect-a1b2", verdict: "stop", action: "wrangler_deploy",
  approvalId: "abc-123",
};

async function run() {
  // The notifier logs delivery failures via console.error by design; we assert
  // on return values, so quiet it to keep the suite output readable.
  console.error = () => {};

  // --- Discord adapter: payload shape ---
  await withFetch(ok, async (calls) => {
    await discordSend(payload, { DISCORD_WEBHOOK_URL: "https://discord.test/hook" });
    check("discord: posts to the configured webhook url", calls[0].url === "https://discord.test/hook");
    check("discord: uses POST + JSON content-type",
      calls[0].opts.method === "POST" && calls[0].opts.headers["Content-Type"] === "application/json");

    const body = JSON.parse(calls[0].opts.body);
    const embed = body.embeds[0];
    check("discord: embed title is the payload title", embed.title === "AgentGuard: STOP");
    check("discord: embed description is the message", embed.description === "Cost hard cap reached");
    check("discord: stop level -> red color", embed.color === 0xe74c3c);
    const byName = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
    check("discord: Agent field carries agentId", byName.Agent === "tomu-cli/collect-a1b2");
    check("discord: Verdict field carries verdict", byName.Verdict === "stop");
    check("discord: Action field present", byName.Action === "wrangler_deploy");
    check("discord: approvalId included for pause/approval flows",
      String(byName["Approval ID"]).includes("abc-123"));
  });

  // --- Discord adapter: failure surfaces as a throw ---
  await throws("discord: missing DISCORD_WEBHOOK_URL throws", () => discordSend(payload, {}));
  await withFetch(() => new Response("boom", { status: 500 }), async () => {
    await throws("discord: non-2xx webhook response throws",
      () => discordSend(payload, { DISCORD_WEBHOOK_URL: "https://discord.test/hook" }));
  });

  // --- notify() dispatcher aggregation ---
  check("configuredChannels: defaults to discord",
    configuredChannels({}).length === 1 && configuredChannels({})[0] === "discord");
  check("configuredChannels: parses comma list",
    JSON.stringify(configuredChannels({ NOTIFY_CHANNELS: "discord, slack" })) === JSON.stringify(["discord", "slack"]));

  await withFetch(ok, async () => {
    const res = await notify(payload, { DISCORD_WEBHOOK_URL: "https://discord.test/hook" }, ["discord"]);
    check("notify: all-ok returns ok=true, no failures", res.ok === true && res.failed.length === 0);
  });

  {
    // discord webhook not configured -> adapter throws -> reported as failed.
    const res = await notify(payload, {}, ["discord"]);
    check("notify: missing config reported in failed[], never silently dropped",
      res.ok === false && res.failed.includes("discord"));
  }

  {
    const res = await notify(payload, {}, ["telegram"]);
    check("notify: unknown channel reported as failed", res.ok === false && res.failed.includes("telegram"));
  }

  await withFetch(
    (url) => (url.includes("discord") ? ok() : Promise.reject(new Error("x"))),
    async () => {
      // one good channel + one misconfigured: partial failure is precise.
      const res = await notify(payload,
        { DISCORD_WEBHOOK_URL: "https://discord.test/hook" }, ["discord", "slack"]);
      check("notify: partial failure lists only the failed channel",
        res.ok === false && res.failed.length === 1 && res.failed[0] === "slack");
    }
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run();
