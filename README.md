# AgentGuard

A Cloudflare Worker that judges an agent's actions before they run — circuit
breakers for runaway loops, spend caps, destructive-command approval, heartbeat
liveness, and a manual kill switch. Rules are **data**, not code: new runaway
patterns are added as rule objects (via `POST /rules` or `rules.default.js`)
without touching the engine.

See `src/index.js` for the full endpoint list and `CHANGES.md` for history.

## agentId format

Every request identifies its agent with an `agentId`. The structured format is:

```
{system}/{role}-{short-id}
        e.g.  claude-code/design-review-a3f9
```

| Part       | Meaning                                                                 |
|------------|-------------------------------------------------------------------------|
| `system`   | Fixed set: `claude-code`, `tomu-agent`, `tomu-cli`.                      |
| `role`     | Self-declared short task purpose, sanitized to `[a-z0-9-]` (e.g. `design-review`, `repo-scaffold`, `collect`). |
| `short-id` | Random suffix generated at startup for collision avoidance (e.g. 4 chars). |

Generating the id is the **caller's responsibility**. `guard-wrapper.ps1` builds
a default so it works standalone; override it with `$env:AGENTGUARD_AGENT_ID`
(whole id) or `$env:AGENTGUARD_ROLE` (just the role).

Validation (`src/validate.js`):

- Structured ids must name a **known system**; unknown systems are rejected.
- Legacy flat ids with no slash (e.g. `claude-code-local`) remain valid for
  backward compatibility.
- Each segment must start alphanumeric, so `../` traversal and a leading `.`
  are rejected. `:` is banned so an id can't break the `agent:<id>:state`
  KV-key layout.

> **Interception position:** today the guard is invoked from a shell wrapper
> (`guard-wrapper.ps1`). Moving interception into a shared **MCP middleware** is
> out of scope for now and tracked for the future integrated-MCP-server work.

## Rule scoping (`appliesTo`)

By default a rule applies to **every** agent. Add `appliesTo` to restrict it to
agents whose `agentId` matches one of its prefix patterns. Matching is
**boundary-aware prefix** matching:

| `appliesTo` entry      | Matches                                             |
|------------------------|-----------------------------------------------------|
| `["tomu-cli"]`         | any id starting with `tomu-cli/` (that whole system)|
| `["tomu-cli/collect"]` | any id starting with `tomu-cli/collect-`            |

The trailing separator (`/` after a bare system, `-` after a `system/role`)
prevents partial-segment matches — `tomu-cli` will not match `tomu-client/…`,
and `collect` will not match `collector-…`.

```jsonc
{
  "id": "cli-cost-cap",
  "appliesTo": ["tomu-cli/collect"],   // only the collect role of tomu-cli
  "when": { "metric": "costUSD", "op": ">=", "value": 1.0 },
  "verdict": "pause"
}
```

### System-tier rules

A rule marked `"tier": "system"` is **never scoped**: it applies to every agent
regardless of any `appliesTo`. The manual kill switch is system-tier so it can
never be accidentally narrowed away — the emergency stop must always work.

```jsonc
{ "id": "manual-killswitch", "tier": "system", /* ... */ }
```

Rules without `appliesTo` and without `tier` keep their original behavior
(global), so existing rule sets are unaffected.

## Audit trail (D1)

The audit trail lives in a **D1** database (binding `GUARD_DB`) — durable and,
unlike the old KV log, *readable*. Every approval, killswitch operation, rule
change, counter reset, `/check` verdict, agent `/log`, and notify failure is
recorded in the `audit_log` table with `ts`, `agent_id`, `event_type`, `actor`
(admin / agent / guard / system), `verdict`, `rule_id`, and a JSON `detail`.
Writes go through `executionCtx.waitUntil` so they never block a response.

Read it (admin token required):

```
GET /logs                                  # latest 100
GET /logs?agentId=tomu-cli/collect-a1b2    # filter by agent
GET /logs?eventType=killswitch&limit=50    # filter by event type
```

Set up the database (one-time), then apply the schema:

```
npx wrangler d1 create agentguard-audit    # paste the id into wrangler.toml
npm run db:migrate:local                   # local dev / tests
npm run db:migrate:remote                  # production
```

> Storage is **D1 only** — Analytics Engine / Supabase are intentionally out of
> scope until a concrete need appears.

## Tests

Run every suite (this is what CI runs, via `.github/workflows/ci.yml`):

```
npm test
```

| Suite                     | Covers                                                    |
|---------------------------|-----------------------------------------------------------|
| `test-engine.mjs`         | judge engine + validation (rule scoping, agentId format)  |
| `test-store.mjs`          | KV store helpers (counters, notify cooldown)              |
| `test-check-handler.mjs`  | `/check` integration (auth, monotonicity, spoofing)      |
| `test-notifier.mjs`       | Discord adapter payload + notify() failure aggregation    |
| `test-routing.mjs`        | routing/error handling (404, 400, 413, auth gate)         |
| `test-logs.mjs`           | D1 audit write/read + `GET /logs` (admin-gated)           |

The Node suites use in-memory KV/D1 mocks (`test-helpers.mjs`) to stay
dependency-free and cross-platform; migrating to `@cloudflare/vitest-pool-workers`
for real miniflare-backed KV/D1 is a possible future step.
