import assert from "node:assert/strict";
import { test } from "node:test";
import { decisionLine, dueDigestSlot, renderDigest } from "../server/digest.ts";
import type { AgentSummary } from "../server/paseo-port.ts";

const at = (iso: string) => Date.parse(iso);

function agent(id: string, title: string, extra: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id, title, status: "idle", provider: "claude", model: "claude-opus-5-5", cwd: "/x", updatedAt: "2026-09-25T15:00:00Z",
    labels: {}, attentionReason: null, attentionAt: null, lastUserMessageAt: null, lastError: null, archivedAt: null, ...extra,
  };
}

test("digest slots: 08:30 and 18:30 Vancouver, each once", () => {
  assert.equal(dueDigestSlot(at("2026-09-26T08:29:00-07:00"), "2026-09-25T18:30")?.id, undefined);
  assert.deepEqual(dueDigestSlot(at("2026-09-26T08:31:00-07:00"), "2026-09-25T18:30"), {
    id: "2026-09-26T08:30",
    at: at("2026-09-26T08:30:00-07:00"),
    label: "아침 요약",
  });
  assert.equal(dueDigestSlot(at("2026-09-26T09:00:00-07:00"), "2026-09-26T08:30"), null);
  assert.equal(dueDigestSlot(at("2026-09-26T18:30:00-07:00"), "2026-09-26T08:30")?.label, "저녁 요약");
  assert.equal(dueDigestSlot(at("2026-09-26T02:00:00-07:00"), null)?.id, "2026-09-25T18:30", "after midnight, yesterday evening is the latest");
});

test("decisionLine picks the last line that asks the owner for something", () => {
  assert.equal(decisionLine("초안 끝났어요.\n- 검토 페이지: https://x\n**인디드에 올릴까요?**"), "인디드에 올릴까요?");
  assert.equal(decisionLine("A안과 B안 중 골라 주세요.\n나머지는 끝났어요."), "A안과 B안 중 골라 주세요.");
  assert.equal(decisionLine("배포 끝. 확인 완료."), null);
});

test("renderDigest is short, grouped, and marks stale usage", () => {
  const now = at("2026-09-25T18:30:00-07:00");
  const html = renderDigest({
    now,
    slotLabel: "저녁 요약",
    running: [agent("e4c81fdc-1", "테네리페 영상", { status: "running", lastUserMessageAt: "2026-09-26T00:30:00Z" })],
    finished: [
      { agent: agent("fd08261b-1", "웨비나 유튜브"), decision: null },
      { agent: agent("da66eaa0-1", "Indeed 공고"), decision: "인디드에 올릴까요?" },
    ],
    waitingPermission: [agent("1cc06d7c-1", "웨비나 플랫폼")],
    stalls: [{ agentId: "dddd0001-1", title: "Astra 설계", provider: "codex", errorAt: now - 3600_000, resetAt: at("2026-09-26T01:20:00-07:00"), message: "", status: "waiting" }],
    usage: {
      claude_session: { remainingPct: 50, resetIso: "2026-09-26T02:55:00Z", at: now - 60_000 },
      codex_week: { remainingPct: 0, resetIso: "2026-09-26T08:20:00Z", at: now - 8 * 3600_000 },
    },
  });
  assert.equal(
    html,
    [
      "🗞 <b>저녁 요약</b> · 9/25 18:30",
      "",
      "<b>🟢 진행 중 1</b>",
      "• 테네리페 영상 <code>e4c81fd</code> · 1시간째",
      "",
      "<b>✅ 끝남 2 (지난 요약 이후)</b>",
      "• 웨비나 유튜브 <code>fd08261</code>",
      "• Indeed 공고 <code>da66eaa</code>",
      "",
      "<b>⏸ 한도로 멈춤 1</b>",
      "• Astra 설계 <code>dddd000</code> · 9/26 01:25 재개 예정",
      "",
      "<b>✋ Mina님 차례 2</b>",
      "• 웨비나 플랫폼 <code>1cc06d7</code> 승인 요청 대기",
      "• Indeed 공고 <code>da66eaa</code> “인디드에 올릴까요?”",
      "",
      "<b>📊 남은 사용량</b>",
      "Claude 세션 50%(1시간) · Codex 0%(6시간)*",
      "<i>* 6시간 넘은 값</i>",
    ].join("\n"),
  );
  assert.ok(html.length < 1200, "fits one phone screen or so");
});

test("an empty digest says so", () => {
  const html = renderDigest({ now: 0, slotLabel: "아침 요약", running: [], finished: [], waitingPermission: [], stalls: [], usage: {} });
  assert.match(html, /조용해요/);
});
