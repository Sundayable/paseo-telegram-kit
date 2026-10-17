import assert from "node:assert/strict";
import { test } from "node:test";
import { renderUsageCard, USAGE_BUTTONS } from "../server/usage-card.ts";
import type { UsageReading } from "../server/usage-card.ts";

const now = Date.parse("2026-09-30T17:00:00Z");
function row(extra: Partial<UsageReading> = {}): UsageReading {
  return { id: "claude_session", label: "Claude 5시간", remainingPct: 67,
    resetIso: "2026-09-30T19:00:00Z", at: now, status: "available", ...extra };
}
function render(rows: UsageReading[], refreshFailed = false): string {
  return renderUsageCard({ rows, checkedAt: now, refreshFailed }, now);
}

test("fresh card uses Vancouver time and preserves optional provider rows", () => {
  const html = render([row(), row({ id: "codex_week", label: "Codex 주간" }), row({ id: "grok_week", label: "Grok" })]);
  assert.match(html, /^<b>📊 내 AI 사용량<\/b>\nMina님 전용 · America\/Vancouver 기준/);
  assert.match(html, /Claude 5시간<\/b> · 67% 남음/);
  assert.match(html, /확인: 9\/30 10:00 · 방금/);
  assert.match(html, /초기화: 9\/30 12:00 · 2시간 후/);
  assert.match(html, /Codex 주간/);
  assert.match(html, /<b>Grok<\/b>/);
  assert.doesNotMatch(html, /이전 저장값/);
  assert.deepEqual(USAGE_BUTTONS, [[{ text: "🔄 새로고침", callback_data: "usage:refresh" }]]);
});

test("unknown and non-finite values are unavailable, never zero", () => {
  for (const value of [null, NaN, Infinity, -Infinity]) {
    const html = render([row({ remainingPct: value, status: "unavailable", at: null, resetIso: null })]);
    assert.match(html, /조회 불가/);
    assert.match(html, /확인: 시각 없음/);
    assert.doesNotMatch(html, /0%|NaN|Infinity/);
  }
  assert.match(render([]), /조회 불가 · 아직 수집된 값이 없어요/);
});

test("real zero is shown and finite percentages are clamped", () => {
  assert.match(render([row({ remainingPct: 0 })]), /0% 남음/);
  assert.match(render([row({ remainingPct: -1 })]), /0% 남음/);
  assert.match(render([row({ remainingPct: 101 })]), /100% 남음/);
});

test("stale data retains observation time instead of fresh check time", () => {
  const html = render([row({ at: now - 11 * 60_000 })]);
  assert.match(html, /조회: 9\/30 10:00/);
  assert.match(html, /확인: 9\/30 09:49 · 11분 전/);
  assert.match(html, /이전 저장값 · 갱신 필요/);
  assert.doesNotMatch(render([row({ at: now - 10 * 60_000 })]), /이전 저장값/);
  assert.match(render([row({ at: null })]), /이전 저장값/);
});

test("expired reset marks even freshly observed percentages as old", () => {
  const html = render([row({ resetIso: "2026-09-30T17:00:00Z" })]);
  assert.match(html, /이전 저장값 · 초기화 시각 경과/);
  assert.match(html, /초기화: 9\/30 10:00 · 지남/);
  assert.doesNotMatch(html, /초기화:.*후/);
});

test("failed refresh preserves prior values with an explicit warning", () => {
  const html = render([row({ status: "error" })], true);
  assert.match(html, /새 조회 실패/);
  assert.match(html, /67% 남음/);
  assert.match(html, /이전 저장값 · 현재 조회 불가/);
  assert.match(render([row({ status: "error", remainingPct: null })]), /조회 불가/);
});

test("dynamic labels and notes are escaped and invalid dates do not throw", () => {
  const html = render([row({ label: '<i>Claude & Codex</i>', note: '<a href="x">x & y</a>', resetIso: "not a date", at: Infinity })]);
  assert.match(html, /&lt;i&gt;Claude &amp; Codex&lt;\/i&gt;/);
  assert.match(html, /&lt;a href="x"&gt;x &amp; y&lt;\/a&gt;/);
  assert.doesNotMatch(html, /<i>|<a |Invalid Date|NaN/);
});
