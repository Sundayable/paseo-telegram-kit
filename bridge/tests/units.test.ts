import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentPermissionRequest, AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { parseCommand, resolveAgentRef, splitFirst } from "../server/commands.ts";
import { parseKeysFile } from "../server/config.ts";
import { actionButtons, actionsOf, answerResponse, questionsOf } from "../server/permissions.ts";
import { buildHandoff, rotationWindowDay, turnReplies } from "../server/rotation.ts";
import { looksUnavailable, retryDelay, timelineDigest } from "../server/seats.ts";
import { finalAssistantText, latestErrors } from "../server/timeline.ts";

test("parseCommand handles bot suffixes and ignores other bots", () => {
  assert.deepEqual(parseCommand("/to 3 안녕\n둘째 줄"), { name: "to", args: "3 안녕\n둘째 줄" });
  assert.deepEqual(parseCommand("/LS@my_orchestrator_bot", "my_orchestrator_bot"), { name: "ls", args: "" });
  assert.equal(parseCommand("/ls@other_bot", "my_orchestrator_bot"), null);
  assert.equal(parseCommand("그냥 메시지"), null);
  assert.deepEqual(splitFirst("  3   할 말  "), ["3", "할 말"]);
});

test("resolveAgentRef accepts listing numbers, full ids and unique prefixes", () => {
  const agents = [
    { id: "2e3f5202-aaaa", title: "캘린더" },
    { id: "2e3f9999-bbbb", title: "다른 것" },
    { id: "244d361a-cccc", title: "채용" },
  ];
  const listing = ["244d361a-cccc", "2e3f5202-aaaa"];
  assert.deepEqual(resolveAgentRef("1", agents, listing), { kind: "found", agent: agents[2] });
  assert.deepEqual(resolveAgentRef("244d", agents, listing), { kind: "found", agent: agents[2] });
  assert.equal(resolveAgentRef("2e3f", agents, listing).kind, "ambiguous");
  assert.deepEqual(resolveAgentRef("2e3f5", agents, listing), { kind: "found", agent: agents[0] });
  assert.equal(resolveAgentRef("7", agents, listing).kind, "none");
  assert.equal(resolveAgentRef("2e", agents, listing).kind, "none");
});

test("parseKeysFile reads only the named keys, with export and quotes", () => {
  const keys = parseKeysFile('# c\nexport TELEGRAM_BOT_TOKEN="123:abc"\nTELEGRAM_CHAT_ID=42\nOTHER=x\n', [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
  ]);
  assert.deepEqual(keys, { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "42" });
});

test("finalAssistantText keeps only the last text segment of the latest turn", () => {
  const timeline = [
    { type: "user_message", text: "old" },
    { type: "assistant_message", text: "old answer" },
    { type: "user_message", text: "[텔레그램] 상태?" },
    { type: "assistant_message", text: "확인해 볼게요." },
    { type: "tool_call", callId: "1", name: "list_agents", status: "completed" },
    { type: "reasoning", text: "thinking" },
    { type: "assistant_message", text: "세션 3개가 " },
    { type: "reasoning", text: "more" },
    { type: "assistant_message", text: "돌고 있어요." },
  ] as unknown as AgentTimelineItem[];
  assert.equal(finalAssistantText(timeline), "세션 3개가 돌고 있어요.");
});

test("finalAssistantText falls back to the last non-empty segment when a tool call ends the turn", () => {
  const timeline = [
    { type: "user_message", text: "go" },
    { type: "assistant_message", text: "끝났어요." },
    { type: "tool_call", callId: "1", name: "Write", status: "completed" },
  ] as unknown as AgentTimelineItem[];
  assert.equal(finalAssistantText(timeline), "끝났어요.");
  assert.deepEqual(
    latestErrors([{ type: "user_message", text: "x" }, { type: "error", message: "limit" }] as AgentTimelineItem[]),
    ["limit"],
  );
});

test("AskUserQuestion requests become questions with option labels", () => {
  const request = {
    id: "r1",
    provider: "claude",
    name: "AskUserQuestion",
    kind: "question",
    input: {
      questions: [
        { question: "어느 쪽으로 할까요?", header: "방향", options: [{ label: "A안" }, { label: "B안" }] },
        { question: "배포할까요?", options: ["예", "아니요"] },
      ],
    },
  } as unknown as AgentPermissionRequest;
  assert.deepEqual(questionsOf(request), [
    { question: "어느 쪽으로 할까요?", header: "방향", options: ["A안", "B안"] },
    { question: "배포할까요?", header: undefined, options: ["예", "아니요"] },
  ]);
  assert.deepEqual(answerResponse({ "어느 쪽으로 할까요?": "A안" }), {
    behavior: "allow",
    updatedInput: { answers: { "어느 쪽으로 할까요?": "A안" } },
  });
});

test("permission actions come from the request, else allow/deny", () => {
  const plain = { id: "r", provider: "grok", name: "Bash", kind: "tool" } as AgentPermissionRequest;
  assert.deepEqual(actionsOf(plain).map((action) => action.behavior), ["allow", "deny"]);
  const plan = {
    ...plain,
    kind: "plan",
    actions: [
      { id: "implement", label: "Implement the plan", behavior: "allow" },
      { id: "dismiss", label: "Keep planning", behavior: "deny" },
    ],
  } as AgentPermissionRequest;
  assert.deepEqual(actionsOf(plan)[0], { label: "Implement the plan", behavior: "allow", selectedActionId: "implement" });
  assert.equal(actionButtons("tok", actionsOf(plain)).length, 1, "short labels share one row");
  assert.equal(actionButtons("tok", actionsOf(plan)).length, 2, "long labels get a row each");
  for (const row of actionButtons("tok", actionsOf(plan))) {
    for (const button of row) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
  }
});


test("looksUnavailable catches provider limit notices but not ordinary replies", () => {
  for (const text of [
    "Claude usage limit reached · resets 3pm",
    "You've hit your limit · resets 9pm (America/Vancouver)",
    "5-hour limit reached ∙ resets 3pm",
    "API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}",
    "Credit balance is too low",
    "[System Error] Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.",
    "OAuth token has expired · Please run /login",
    // Real texts from Paseo agents and Claude Code transcripts, 2026-09:
    "You've hit your session limit · resets 5:40pm (America/Vancouver)",
    "You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai/settings/usage",
    "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.",
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 26th, 2026 1:20 AM.",
    "Internal error: API error (status 402 Payment Required): Grok Build usage balance exhausted",
  ]) {
    assert.equal(looksUnavailable(text, []), true, text);
  }
  assert.equal(looksUnavailable("", ["rate_limit_error: 429"]), true);
  assert.equal(looksUnavailable("발송 한도(rate limit)는 여유 있어요. 오늘 38통 보냈어요.", []), false);
  assert.equal(looksUnavailable(`${"긴 답변 ".repeat(80)} usage limit reached`, []), false, "long real answers never count");
  assert.equal(looksUnavailable("", []), false);
  assert.equal(looksUnavailable("Twilio는 아직 로그인이 안 돼 있어요. 비밀번호 재설정 메일을 보냈어요.", []), false);
});

test("retryDelay doubles from 30 minutes and caps at 4 hours", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map((attempt) => retryDelay(attempt) / 60000), [30, 60, 120, 240, 240, 240]);
});

test("timelineDigest keeps the owner's messages and final replies, newest first when trimming", () => {
  const items = [
    { type: "user_message", text: "[텔레그램] 첫 질문" },
    { type: "assistant_message", text: "확인할게요." },
    { type: "tool_call", callId: "1", name: "list_agents", status: "completed" },
    { type: "assistant_message", text: "첫 답" },
    { type: "user_message", text: "<worker finished> e4c81fd done" },
    { type: "assistant_message", text: "영상 끝났어요" },
    { type: "user_message", text: "[텔레그램] 둘째 질문" },
    { type: "reasoning", text: "hmm" },
    { type: "assistant_message", text: "둘째 답" },
  ] as unknown as AgentTimelineItem[];
  assert.equal(
    timelineDigest(items),
    "Mina: 첫 질문\n오케: 첫 답\n\n알림: <worker finished> e4c81fd done\n오케: 영상 끝났어요\n\nMina: 둘째 질문\n오케: 둘째 답",
  );
  assert.equal(timelineDigest(items, 30), "Mina: 둘째 질문\n오케: 둘째 답");
});


test("the rotation window is 03:30–05:00 Vancouver", () => {
  assert.equal(rotationWindowDay(Date.parse("2026-09-26T03:29:00-07:00")), null);
  assert.equal(rotationWindowDay(Date.parse("2026-09-26T03:30:00-07:00")), "2026-09-26");
  assert.equal(rotationWindowDay(Date.parse("2026-09-26T04:59:00-07:00")), "2026-09-26");
  assert.equal(rotationWindowDay(Date.parse("2026-09-26T05:00:00-07:00")), null);
});

test("turnReplies and buildHandoff pull decisions, workers and links from the seat's own record", () => {
  const timeline = [
    { type: "user_message", text: "[텔레그램] a" },
    { type: "assistant_message", text: "확인 중" },
    { type: "tool_call", callId: "1", name: "x", status: "completed", error: null, detail: { type: "plain_text" } },
    { type: "assistant_message", text: "끝. https://a.example/x 참고" },
    { type: "user_message", text: "[텔레그램] b" },
    { type: "assistant_message", text: "B안으로 갈까요?" },
  ] as unknown as AgentTimelineItem[];
  assert.deepEqual(turnReplies(timeline), ["끝. https://a.example/x 참고", "B안으로 갈까요?"]);
  const handoff = buildHandoff({ seatId: "cef848ca", now: 0, timeline, workers: [] });
  assert.match(handoff, /## 결정·확인 대기[^\n]*\n- B안으로 갈까요\?/);
  assert.match(handoff, /## 맡겨 둔 워커\n- 없음/);
  assert.match(handoff, /## 최근 링크\n- https:\/\/a\.example\/x/);
  assert.match(handoff, /Mina: b\n오케: B안으로 갈까요\?/);
});
