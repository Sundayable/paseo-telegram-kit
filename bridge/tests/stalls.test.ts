import assert from "node:assert/strict";
import { test } from "node:test";
import { detectStall, parseUsageCache, zonedTime } from "../server/stalls.ts";

const pt = (iso: string) => Date.parse(iso); // pass explicit offsets

test("zonedTime converts Vancouver wall time across both DST states", () => {
  assert.equal(new Date(zonedTime(2026, 9, 25, 17, 40)).toISOString(), "2026-09-26T00:40:00.000Z");
  assert.equal(new Date(zonedTime(2026, 12, 1, 9, 0)).toISOString(), "2026-12-01T17:00:00.000Z");
});

test("Claude session limits reset at the stated local time, rolling to tomorrow when needed", () => {
  const afternoon = detectStall("You've hit your session limit · resets 5:40pm (America/Vancouver)", pt("2026-09-25T16:00:00-07:00"));
  assert.equal(afternoon?.kind, "limit");
  assert.equal(new Date(afternoon?.resetAt ?? 0).toISOString(), "2026-09-26T00:40:00.000Z");
  const lateNight = detectStall("You've hit your session limit · resets 2:10am (America/Vancouver)", pt("2026-09-25T23:30:00-07:00"));
  assert.equal(new Date(lateNight?.resetAt ?? 0).toISOString(), "2026-09-26T09:10:00.000Z");
});

test("Codex gives a full date", () => {
  const stall = detectStall(
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 26th, 2026 1:20 AM.",
    pt("2026-09-24T12:00:00-07:00"),
  );
  assert.equal(new Date(stall?.resetAt ?? 0).toISOString(), "2026-09-26T08:20:00.000Z", "matches the usage cache's codex resetIso");
  assert.equal(detectStall("You've hit your usage limit. Try again in 2 hours 15 minutes.", 0)?.resetAt, (2 * 60 + 15) * 60_000);
});

test("Grok balance and Fable weekly limits wait for the usage cache", () => {
  const stalledAt = pt("2026-09-25T10:00:00-07:00");
  const grokText = "Internal error: API error (status 402 Payment Required): Grok Build usage balance exhausted";
  const refreshed = parseUsageCache({ grok_week: { row: { remainingPct: 93, resetIso: "2026-09-27T18:57:40Z" }, at: stalledAt + 60_000 } });
  assert.deepEqual(detectStall(grokText, stalledAt, refreshed), { kind: "balance", resetAt: stalledAt + 60_000, message: grokText });
  const stale = parseUsageCache({ grok_week: { row: { remainingPct: 0, resetIso: "2026-09-27T18:57:40Z" }, at: stalledAt - 60_000 } });
  assert.equal(detectStall(grokText, stalledAt, stale)?.resetAt, Date.parse("2026-09-27T18:57:40Z"));
  assert.equal(detectStall(grokText, stalledAt, {})?.resetAt, null, "no signal yet: keep waiting");

  const fable = parseUsageCache({ fable_week: { row: { remainingPct: 0, resetIso: "2026-10-01T01:59:59Z" }, at: stalledAt - 1 }, _claude: { lastAt: 1 } });
  assert.equal(detectStall("You've reached your Fable limit. Switch to another model", stalledAt, fable)?.resetAt, Date.parse("2026-10-01T01:59:59Z"));
});

test("ordinary replies and other errors are not stalls", () => {
  assert.equal(detectStall("발송 한도(rate limit)는 여유 있어요.", 0), null);
  assert.equal(detectStall("Failed to authenticate: OAuth session expired and could not be refreshed", 0), null);
  assert.equal(detectStall("", 0), null);
});
