import assert from "node:assert/strict";
import { test } from "node:test";
import { UsageReader } from "../server/usage-reader.ts";

const NOW = Date.parse("2026-09-30T19:00:00Z");
const RESET = "2026-10-01T01:00:00Z";
const row = (id: string, remainingPct: unknown = 67, extra: Record<string, unknown> = {}) => ({
  id, label: "untrusted label", remainingPct, resetIso: RESET, status: "available", detail: "SECRET", ...extra,
});
const settle = async () => {};
const byId = (snapshot: Awaited<ReturnType<UsageReader["read"]>>, id: string) => snapshot.rows.find((r) => r.id === id)!;

test("matches cache observations and uses controlled IDs and labels", async () => {
  const codex = row("codex_week");
  const reader = new UsageReader({
    fetch: async () => ({ fetchedAt: new Date(NOW).toISOString(), rows: [codex, row("secret_provider"), row("grok_week", 12)] }),
    readCache: () => ({ codex_week: { row: codex, at: NOW - 15 * 60_000 } }), now: () => NOW, settle,
  });
  const snapshot = await reader.read();
  assert.equal(byId(snapshot, "codex_week").at, NOW - 15 * 60_000);
  assert.equal(byId(snapshot, "codex_week").label, "Codex · 주간");
  assert.equal(byId(snapshot, "grok_week").at, null);
  assert.equal(snapshot.checkedAt, NOW);
  assert.equal(snapshot.refreshFailed, undefined);
  assert.equal(snapshot.rows.length, 4);
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|untrusted|secret_provider|fetchedAt/);
});

test("coalesces concurrent requests and throttles attempts for 60 seconds without changing observation or attempt times", async () => {
  let now = NOW, fetches = 0, settles = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reader = new UsageReader({
    fetch: async () => { fetches++; await gate; return { rows: [row("codex_week")] }; },
    readCache: () => ({}), now: () => now, settle: async () => { settles++; },
  });
  const first = reader.read(), second = reader.read();
  assert.strictEqual(first, second);
  release();
  const result = await first;
  now += 59_999;
  assert.strictEqual(await reader.read(), result);
  assert.equal(result.checkedAt, NOW);
  assert.equal(fetches, 1);
  now++;
  assert.equal((await reader.read()).checkedAt, now);
  assert.equal(fetches, 2);
  assert.equal(settles, 2);
});

test("settles before reading cache written after the RPC returns", async () => {
  const codex = row("codex_week");
  const events: string[] = [];
  let cache = {};
  const snapshot = await new UsageReader({
    fetch: async () => { events.push("fetch"); return { rows: [codex] }; },
    settle: async () => { events.push("settle"); cache = { codex_week: { row: codex, at: NOW - 1 } }; },
    readCache: () => { events.push("cache"); return cache; }, now: () => NOW,
  }).read();
  assert.deepEqual(events, ["fetch", "settle", "cache"]);
  assert.equal(byId(snapshot, "codex_week").at, NOW - 1);
});

test("RPC failure returns cache observations marked error and never exposes exception contents", async () => {
  const codex = row("codex_week", 0);
  const claude = row("claude_session", 20);
  const snapshot = await new UsageReader({
    fetch: async () => { throw new Error("Bearer SECRET_TOKEN"); },
    readCache: () => ({ codex_week: { row: codex, at: NOW - 90_000 }, claude_session: { row: claude, at: NOW - 50_000 }, _claude: { lastAt: NOW - 100_000 } }),
    now: () => NOW, settle: async () => { assert.fail("failed RPC does not need settling"); },
  }).read();
  assert.equal(snapshot.refreshFailed, true);
  assert.equal(byId(snapshot, "codex_week").remainingPct, 0);
  assert.equal(byId(snapshot, "codex_week").at, NOW - 90_000);
  assert.equal(byId(snapshot, "claude_session").at, NOW - 100_000);
  assert.ok(snapshot.rows.every((r) => r.status === "error"));
  assert.doesNotMatch(JSON.stringify(snapshot), /Bearer|SECRET_TOKEN/);
});

test("Claude and Fable use the earlier lastAt and cache timestamp; missing or invalid metadata is unknown", async () => {
  for (const lastAt of [NOW - 120_000, NOW - 1_000, undefined, NaN, 0, NOW + 1]) {
    const rows = [row("claude_session"), row("claude_week"), row("fable_week")];
    const cache = { ...Object.fromEntries(rows.map((r) => [r.id, { row: r, at: NOW - 60_000 }])), _claude: { lastAt } };
    const snapshot = await new UsageReader({ fetch: async () => ({ rows }), readCache: () => cache, now: () => NOW, settle }).read();
    const expected = typeof lastAt === "number" && Number.isFinite(lastAt) && lastAt > 0 && lastAt <= NOW
      ? Math.min(NOW - 60_000, lastAt) : null;
    for (const r of rows) assert.equal(byId(snapshot, r.id).at, expected);
  }
});

test("does not attach observation times to mismatched values, reset times, identities or future timestamps", async () => {
  const codex = row("codex_week");
  for (const entry of [
    { row: row("codex_week", 68), at: NOW - 1 },
    { row: row("codex_week", 67, { resetIso: "2026-10-02T01:00:00Z" }), at: NOW - 1 },
    { row: row("claude_week"), at: NOW - 1 },
    { row: codex, at: NOW + 1 },
    { row: codex, at: Infinity },
  ]) {
    const snapshot = await new UsageReader({ fetch: async () => ({ rows: [codex] }), readCache: () => ({ codex_week: entry }), now: () => NOW, settle }).read();
    assert.equal(byId(snapshot, "codex_week").at, null);
  }
});

test("no-five-hour plan omits the empty Codex session while a valid value stays visible", async () => {
  for (const pct of [null, 36]) {
    const snapshot = await new UsageReader({
      fetch: async () => ({ rows: [row("codex_session", pct, { detail: "no 5-hour window on this plan" })] }),
      readCache: () => ({}), now: () => NOW, settle,
    }).read();
    assert.equal(snapshot.rows.some((r) => r.id === "codex_session"), pct !== null);
  }
});

test("missing and malformed rows preserve the three core windows but never invent numeric values", async () => {
  for (const pct of [null, undefined, -1, 101, Infinity, NaN, "50"]) {
    const snapshot = await new UsageReader({
      fetch: async () => ({ rows: [null, [], 5, row("claude_session", null, { remainingPct: pct }), row("grok_week", null, { remainingPct: pct }), row("cursor_month", null, { remainingPct: pct })] }),
      readCache: () => null, now: () => NOW, settle,
    }).read();
    assert.deepEqual(snapshot.rows.map((r) => r.id), ["claude_session", "claude_week", "codex_week"]);
    assert.ok(snapshot.rows.every((r) => r.remainingPct === null && r.at === null && r.status === "unavailable"));
  }
});

test("malformed RPC and cache failure produce a safe failed snapshot; cache read failure alone leaves time unknown", async () => {
  for (const response of [undefined, {}, { rows: "SECRET" }]) {
    const snapshot = await new UsageReader({
      fetch: async () => response, readCache: () => { throw new Error("secret path"); }, now: () => NOW, settle,
    }).read();
    assert.equal(snapshot.refreshFailed, true);
    assert.equal(snapshot.rows.length, 3);
    assert.ok(snapshot.rows.every((r) => r.status === "error" && r.at === null));
  }
  const snapshot = await new UsageReader({
    fetch: async () => ({ rows: [row("codex_week", 100, { resetIso: "invalid" })] }),
    readCache: () => { throw new Error("secret path"); }, now: () => NOW, settle,
  }).read();
  assert.equal(byId(snapshot, "codex_week").at, null);
  assert.equal(byId(snapshot, "codex_week").resetIso, null);
  assert.equal(byId(snapshot, "codex_week").remainingPct, 100);
  assert.equal(snapshot.refreshFailed, undefined);
});

test("no plugin answer and no cache marks the snapshot unavailable; a cached value does not", async () => {
  const missing = await new UsageReader({
    fetch: async () => { throw new Error("plugin not found"); }, readCache: () => { throw new Error("ENOENT"); }, now: () => NOW, settle,
  }).read();
  assert.equal(missing.unavailable, true);
  const cached = await new UsageReader({
    fetch: async () => { throw new Error("timeout"); }, readCache: () => ({ codex_week: { row: row("codex_week"), at: NOW - 1 } }), now: () => NOW, settle,
  }).read();
  assert.equal(cached.unavailable, undefined);
});
