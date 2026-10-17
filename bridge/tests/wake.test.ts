import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { waitingVerdict } from "../server/wake.ts";

const turn = (tools: Array<{ name: string; status?: string; detail?: unknown }> = []): AgentTimelineItem[] =>
  [
    { type: "user_message", text: "작업해줘" },
    ...tools.map((tool, index) => ({ type: "tool_call", callId: String(index), name: tool.name, status: tool.status ?? "completed", error: null, detail: tool.detail ?? { type: "plain_text" } })),
  ] as unknown as AgentTimelineItem[];

test("replies that stop to wait for the worker's own job count as waiting", () => {
  for (const text of [
    "렌더링 진행 중입니다. 끝나면 알림이 와서 이어서 마무리할게요.",
    "씬 7·8·9 생성 중이에요. 모니터로 기다리는 중입니다.",
    "업로드는 백그라운드에서 돌아가요. 완료되면 이어서 예약까지 할게요.",
    "I'm waiting on the monitor and will carry on once it finishes.",
    "The export is running. I'll report back when it completes.",
    "Kicked off the build; once it finishes I'll deploy.",
  ]) {
    assert.equal(waitingVerdict(text, turn()).waiting, true, text);
  }
});

test("waiting for a person, questions, and finished reports are left alone", () => {
  for (const text of [
    "Mina님 승인 기다리는 중이에요.",
    "초안 끝났어요. 결정 기다리고 있을게요.",
    "인디드에 올릴까요?",
    "끝나면 확인해 주세요.",
    "세션이 끝나면 자동으로 사라집니다. 테스트 206개와 빌드가 통과했습니다.",
    "I'm waiting for your approval before sending.",
    "배포 완료. 모두 확인했어요.",
    "",
  ]) {
    assert.equal(waitingVerdict(text, turn()).waiting, false, text);
  }
});

test("a detached job plus a progress note counts; a live tool is flagged", () => {
  const bg = [{ name: "Bash", detail: { type: "shell", command: "nohup ffmpeg -i a.mp4 out.mp4 > log 2>&1 &" } }];
  assert.equal(waitingVerdict("최종 렌더 시작했어요.", turn(bg)).waiting, true);
  assert.equal(waitingVerdict("최종 렌더 시작했어요.", turn()).waiting, false, "no job was started this turn");
  const live = waitingVerdict("렌더링 진행 중입니다. 끝나면 이어서 할게요.", turn([{ name: "Monitor", status: "running" }]));
  assert.deepEqual([live.waiting, live.toolStillRunning], [true, true]);
});
