// test-helpers.mjs — shared in-memory mocks for the Node test suites.
// These emulate just enough of the Workers KV / D1 / executionCtx surface that
// src/ actually uses. (A future migration to @cloudflare/vitest-pool-workers
// would swap these for real miniflare-backed KV/D1; the Node mocks keep CI
// dependency-free and cross-platform in the meantime.)

// Minimal Workers KV mock.
export function makeKV() {
  const map = new Map();
  return {
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
    _dump() { return map; },
  };
}

// Minimal D1 mock. Faithful for the two statements store.js issues:
//   INSERT INTO audit_log (ts, agent_id, event_type, actor, verdict, rule_id, detail) VALUES (?,?,?,?,?,?,?)
//   SELECT ... FROM audit_log [WHERE agent_id = ? [AND event_type = ?]] ORDER BY ts DESC, id DESC LIMIT ?
// It reads the SQL text to learn the filter shape, so it stays in sync with the
// store without hard-coding a query interpreter.
export function makeD1() {
  const rows = [];
  let auto = 0;
  const COLS = ["ts", "agent_id", "event_type", "actor", "verdict", "rule_id", "detail"];

  function statement(sql) {
    let binds = [];
    const stmt = {
      bind(...args) { binds = args; return stmt; },
      async run() {
        if (/^\s*INSERT\s+INTO\s+audit_log/i.test(sql)) {
          const row = { id: ++auto };
          COLS.forEach((c, i) => { row[c] = binds[i] ?? null; });
          rows.push(row);
          return { success: true, meta: { last_row_id: auto, changes: 1 } };
        }
        return { success: true, meta: {} };
      },
      async all() {
        const b = [...binds];
        const limit = b.pop();
        let out = rows;
        let i = 0;
        if (/agent_id\s*=\s*\?/i.test(sql))   { const v = b[i++]; out = out.filter((r) => r.agent_id === v); }
        if (/event_type\s*=\s*\?/i.test(sql)) { const v = b[i++]; out = out.filter((r) => r.event_type === v); }
        out = out
          .slice()
          .sort((a, z) => (z.ts - a.ts) || (z.id - a.id))
          .slice(0, Number(limit) || out.length);
        return { results: out, success: true };
      },
      async first() {
        const { results } = await stmt.all();
        return results[0] ?? null;
      },
    };
    return stmt;
  }

  return {
    prepare(sql) { return statement(sql); },
    _rows() { return rows; },
  };
}

// Collects executionCtx.waitUntil promises so a test can await all deferred
// side effects with drain() before asserting on their results.
export function makeExecutionCtx() {
  const pending = [];
  return {
    waitUntil(p) { pending.push(p); },
    async drain() { await Promise.all(pending); pending.length = 0; },
  };
}
