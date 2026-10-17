import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { AgentPermissionRequest, AgentPermissionResponse, AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { Bridge } from "../server/bridge.ts";
import { botCommands, helpText } from "../server/commands.ts";
import { dueDigestSlot, renderDigest } from "../server/digest.ts";
import { timeAgo } from "../server/format.ts";
import { currentLanguage, josa, owner, ownerWith, setLanguage, setOwner, t } from "../server/i18n.ts";
import type { AgentSummary, CreateAgentInput, ImageInput, PaseoPort, ProfileSummary } from "../server/paseo-port.ts";
import { actionButtons, actionResponse, actionsOf, denyWithMessage, questionHtml } from "../server/permissions.ts";
import { correctionPrompt, formatBatch, isCorrectionText, QueueStore } from "../server/queue.ts";
import { handoffToBackup, timelineDigest } from "../server/seats.ts";
import { StateStore } from "../server/state.ts";
import type { SendOptions, TelegramPort, TgMessage } from "../server/telegram.ts";
import { renderUsageCard, usageButtons } from "../server/usage-card.ts";

const HANGUL = /[\u3131-\u318E\uAC00-\uD7A3]/;
// The owner and language from tests/fixtures/settings.json, restored after every test.
const FIXTURE_OWNER = owner();
const FIXTURE_LANGUAGE = currentLanguage();
const OWNER = 777;
const home = mkdtempSync(join(tmpdir(), "tg-i18n-"));
const clock = Date.parse("2026-09-25T10:00:00Z");

class FakeTelegram implements TelegramPort {
  sent: Array<{ text: string; options: SendOptions }> = [];
  callbacks: Array<string | undefined> = [];
  private nextId = 1000;
  async sendMessage(text: string, options: SendOptions = {}) {
    this.sent.push({ text, options });
    return this.nextId++;
  }
  async editMessage() {}
  async pinMessage() {}
  async answerCallback(_id: string, text?: string) {
    this.callbacks.push(text);
  }
  async sendTyping() {}
  async react() {}
  async downloadFile() {
    return Buffer.from("x");
  }
  async sendFile() {
    return this.nextId++;
  }
  last() {
    return this.sent[this.sent.length - 1];
  }
}

function agent(id: string, title: string | null, extra: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id, title, status: "idle", provider: "claude", model: "claude-opus-5-5", cwd: "/x",
    updatedAt: new Date(clock).toISOString(), labels: {}, attentionReason: null, attentionAt: null,
    lastUserMessageAt: null, lastError: null, archivedAt: null, ...extra,
  };
}

class FakePaseo implements PaseoPort {
  agents = new Map<string, AgentSummary>();
  sent: Array<{ id: string; text: string }> = [];
  created: CreateAgentInput[] = [];
  private counter = 0;
  async listAgents(limit: number) {
    return [...this.agents.values()].slice(0, limit);
  }
  async getAgent(id: string) {
    return this.agents.get(id) ?? null;
  }
  async send(id: string, text: string, _images: ImageInput[]) {
    this.sent.push({ id, text });
    (this.agents.get(id) as AgentSummary).status = "running";
  }
  async create(input: CreateAgentInput) {
    this.created.push(input);
    const id = `0rch${++this.counter}00-0000`;
    this.agents.set(id, agent(id, input.title, { labels: input.labels, status: "running" }));
    return id;
  }
  async respond(_id: string, _requestId: string, _response: AgentPermissionResponse) {}
  async timeline(): Promise<AgentTimelineItem[]> {
    return [];
  }
  async profiles(): Promise<ProfileSummary[]> {
    return [];
  }
  async stop() {}
  async archive() {}
  async setModel() {}
}

let bridges: Bridge[] = [];

function setup() {
  const telegram = new FakeTelegram();
  const paseo = new FakePaseo();
  const state = new StateStore(null);
  const bridge = new Bridge({
    telegram, paseo, state, chatId: OWNER, orchestratorCwd: "/x", downloadDir: join(home, "dl"), homeDir: home,
    transcribe: null, log: () => {}, now: () => clock, queue: new QueueStore(null), handoffDir: join(home, "handoffs"),
    debounceMs: 0, debounceCapMs: 30_000,
  });
  bridges.push(bridge);
  let updateId = 1;
  const send = (message: Partial<TgMessage>) =>
    bridge.handleUpdate({
      update_id: updateId,
      message: { message_id: updateId++, chat: { id: OWNER, type: "private" }, from: { id: OWNER }, date: 0, ...message },
    });
  return { telegram, paseo, state, bridge, send };
}

/** Bridge text with config-provided seat labels (Korean in the default seat chain) taken out. */
const withoutSeatLabels = (text: string) => text.replace(/<b>[^<]*오케[^<]*<\/b>/g, "<b>seat</b>");

beforeEach(() => {
  setLanguage("en");
  setOwner("Alex");
});

afterEach(() => {
  for (const bridge of bridges) bridge.stop();
  bridges = [];
  setLanguage(FIXTURE_LANGUAGE);
  setOwner(FIXTURE_OWNER);
});

test("t() and owner helpers follow the active language and owner", () => {
  assert.equal(t("한국어", "English"), "English");
  assert.equal(owner(), "Alex");
  assert.equal(ownerWith("이", "가"), "Alex이");
  assert.equal(josa("Mia", "이", "가"), "가");
  assert.equal(josa("미림", "이", "가"), "이");
  assert.equal(josa("수지", "이", "가"), "가");
  setLanguage("ko");
  assert.equal(t("한국어", "English"), "한국어");
});

test("a message to a busy seat gets an English queue ack; the batch keeps its Korean markers with the owner's name", async () => {
  const { telegram, paseo, state, bridge, send } = setup();
  await send({ text: "draft the report" });
  const seatId = state.data.orchestratorId as string;
  assert.ok(seatId);
  await send({ text: "also check the calendar" });
  await send({ text: "and the invoices" });
  const acks = telegram.sent.filter((message) => message.text.startsWith("⏳"));
  assert.equal(acks.length, 2);
  assert.equal(acks[0].text, "⏳ Queued — I'll pick it up as soon as the current task is done");
  assert.doesNotMatch(acks[0].text, HANGUL);

  (paseo.agents.get(seatId) as AgentSummary).status = "idle";
  await bridge.onTurnEnded({ id: seatId, title: null }, { kind: "completed" }, [
    { type: "user_message", text: "[텔레그램] draft the report" },
    { type: "assistant_message", text: "Done." },
  ] as AgentTimelineItem[]);
  const batch = paseo.sent.at(-1)?.text ?? "";
  assert.match(batch, /\[텔레그램\] 메시지 2개, 순서대로:\n\[\d\d:\d\d Alex\] also check the calendar\n\[\d\d:\d\d Alex\] and the invoices$/);
});

test("English interrupt keywords count as corrections; Korean ones still do", () => {
  for (const text of ["cancel that", "stop, wrong file", "wait, use the other deck", "hold on\nnot that one", "취소", "잠깐, 그거 말고"]) {
    assert.ok(isCorrectionText(text), text);
  }
  for (const text of ["waiting room photos", "cancellation policy draft", "아니 근데 이것도"]) {
    assert.ok(!isCorrectionText(text), text);
  }
});

test("fallback, return-to-main and seat commands speak English", async () => {
  const { telegram, state, bridge, send } = setup();
  await send({ text: "status?" });
  const mainId = state.data.orchestratorId as string;
  await bridge.onTurnEnded({ id: mainId, title: null }, { kind: "failed", error: { message: "Claude usage limit reached" } }, []);
  const notice = telegram.last().text;
  assert.match(notice, /^🔁 Switched to backup seat: <b>.+<\/b> \(reason: Claude usage limit reached\)$/);
  assert.doesNotMatch(withoutSeatLabels(notice), HANGUL);

  await send({ text: "/main" });
  assert.equal(telegram.last().text, "↩️ Back on the main seat. It takes your next message.");
  await send({ text: "/main" });
  assert.equal(telegram.last().text, "Already on the main seat.");
  await send({ text: "/nonsense" });
  assert.equal(telegram.last().text, "Unknown command. See /help.");
  await send({ text: "/ls" });
  // Session titles come from config (the default orchestrator title is Korean); the rest is English.
  assert.doesNotMatch(telegram.last().text.replace(/<b>[^<]*<\/b>/g, ""), HANGUL);
  assert.match(telegram.last().text, /<i>\/to number message · \/peek number<\/i>$/);
  await send({ text: "/to" });
  assert.equal(telegram.last().text, "Usage: <code>/to number message</code>");
  await send({ text: "/model gpt" });
  assert.match(telegram.last().text, /^Unknown model: <code>gpt<\/code>\n<code>\/model opus<\/code> or <code>\/model fable<\/code>$/);
  await send({ text: "/status" });
  const status = telegram.last().text;
  assert.match(status, /^<b>Orchestrator status<\/b>\nOrchestrator: /);
  assert.doesNotMatch(status.replace(/(Seat|order): [^\n]*/g, ""), HANGUL);
});

test("/help and the command menu are English", async () => {
  const help = helpText();
  assert.match(help, /^<b>Telegram orchestrator<\/b>/);
  assert.match(help, /switches to Cursor Opus 5\.5 → Codex Astra automatically/);
  assert.match(help, /\/model opus\|fable/);
  assert.doesNotMatch(help, HANGUL);
  const commands = botCommands();
  assert.equal(commands.find((command) => command.command === "help")?.description, "How to use");
  assert.equal(commands.find((command) => command.command === "status")?.description, "Orchestrator status");
  for (const command of commands) assert.doesNotMatch(command.description, HANGUL, command.command);

  const { telegram, send } = setup();
  await send({ text: "/help" });
  assert.equal(telegram.last().text, help);
});

test("the digest is English and addresses the owner as 'Your turn'", () => {
  const slot = dueDigestSlot(Date.parse("2026-09-25T18:31:00-07:00"), null);
  assert.equal(slot?.label, "Evening digest");
  const now = Date.parse("2026-09-25T18:30:00-07:00");
  const html = renderDigest({
    now,
    slotLabel: slot?.label as string,
    running: [agent("e4c81fdc-1", "Tenerife video", { status: "running", lastUserMessageAt: new Date(now - 3600_000).toISOString() })],
    finished: [{ agent: agent("da66eaa0-1", null), decision: "Post it to Indeed?" }],
    waitingPermission: [agent("1cc06d7c-1", "Webinar platform")],
    stalls: [{ agentId: "dddd0001-1", title: "Astra design", provider: "codex", errorAt: now - 3600_000, resetAt: null, message: "", status: "waiting" }],
    usage: { claude_session: { remainingPct: 50, resetIso: new Date(now + 3600_000).toISOString(), at: now } },
  });
  assert.match(html, /^🗞 <b>Evening digest<\/b> · 9\/25 18:30/);
  assert.match(html, /<b>🟢 Running 1<\/b>\n• Tenerife video <code>e4c81fd<\/code> · 1 h\n/);
  assert.match(html, /<b>✋ Your turn 2<\/b>\n• Webinar platform <code>1cc06d7<\/code> waiting for approval\n• \(untitled\) <code>da66eaa<\/code> “Post it to Indeed\?”/);
  assert.match(html, /Claude session 50%\(1h\)/);
  assert.doesNotMatch(html, HANGUL);
  const quiet = renderDigest({ now, slotLabel: "Digest now", running: [], finished: [], waitingPermission: [], stalls: [], usage: {} });
  assert.match(quiet, /All quiet\./);
  assert.doesNotMatch(quiet, HANGUL);
});

test("permission and question prompts, buttons and deny messages are English and name the owner", async () => {
  const request = { id: "r1", name: "Bash", title: "Run a command", input: { command: "ls" } } as unknown as AgentPermissionRequest;
  const actions = actionsOf(request);
  assert.deepEqual(actions.map((action) => action.label), ["Allow", "Deny"]);
  assert.deepEqual(actionButtons("tok", actions).flat().map((button) => button.text), ["Allow", "Deny"]);
  assert.deepEqual(actionResponse(actions[1]), { behavior: "deny", selectedActionId: undefined, message: "Alex denied this from Telegram." });
  assert.equal((denyWithMessage("not now") as { message: string }).message, "Alex denied this from Telegram and said: not now");
  assert.doesNotMatch(questionHtml({ question: "Which deck?", options: ["A", "B"] }, 0, 2), HANGUL);

  const { telegram, state, send, bridge } = setup();
  await send({ text: "go" });
  const seatId = state.data.orchestratorId as string;
  await bridge.onPermissionRequested({ id: seatId, title: null }, request);
  const prompt = telegram.last();
  assert.match(prompt.text, /^✋ <b>Approval request<\/b>\n/);
  assert.match(prompt.text, /<i>To deny with a note, reply to this message\.<\/i>$/);
  assert.doesNotMatch(prompt.text, HANGUL);
  assert.deepEqual((prompt.options.buttons ?? []).flat().map((button) => button.text), ["Allow", "Deny"]);
  await bridge.handleUpdate({ update_id: 99, callback_query: { id: "cb", from: { id: OWNER }, data: "p:missing:0", message: { message_id: 1, chat: { id: OWNER } } } });
  assert.equal(telegram.callbacks.at(-1), "Already handled");
});

test("the usage card and time-ago strings are English", () => {
  const now = Date.parse("2026-09-30T10:00:00-07:00");
  const html = renderUsageCard(
    { checkedAt: now, rows: [{ id: "claude_session", label: "Claude · 5 hours", remainingPct: 67, resetIso: new Date(now + 2 * 3600_000).toISOString(), at: now - 11 * 60_000, status: "available" }] },
    now,
  );
  assert.match(html, /^<b>📊 My AI usage<\/b>\nAlex only · America\/Vancouver time\nChecked: 9\/30 10:00/);
  assert.match(html, /Claude · 5 hours<\/b> · 67% left/);
  assert.match(html, /⚠️ Saved earlier · needs a refresh/);
  assert.match(html, /Resets: 9\/30 12:00 · in 2 h/);
  assert.doesNotMatch(html, HANGUL);
  assert.deepEqual(usageButtons(), [[{ text: "🔄 Refresh", callback_data: "usage:refresh" }]]);
  assert.equal(timeAgo(new Date(now - 5 * 60_000).toISOString(), now), "5 min ago");
});

test("without the usage-remaining plugin, /usage says plainly that usage info is unavailable", () => {
  const html = renderUsageCard({ checkedAt: clock, rows: [], refreshFailed: true, unavailable: true }, clock);
  assert.match(html, /Usage info isn't available\./);
  assert.match(html, /usage-remaining Paseo plugin/);
  assert.doesNotMatch(html, HANGUL);
  setLanguage("ko");
  assert.match(renderUsageCard({ checkedAt: clock, rows: [], refreshFailed: true, unavailable: true }, clock), /사용량 정보를 볼 수 없어요\./);
});

test("agent-facing prompts keep Korean markers but use the owner's name", () => {
  const items = [{ id: "a", kind: "owner" as const, text: "first", imagePaths: [], at: clock, messageIds: [] }, { id: "b", kind: "owner" as const, text: "second", imagePaths: [], at: clock, messageIds: [] }];
  assert.match(formatBatch(items, clock), /^\[텔레그램\] 메시지 2개, 순서대로:\n\[\d\d:\d\d Alex\] first/);
  const correction = correctionPrompt("old", items, clock);
  assert.match(correction, /^\[텔레그램 · 수정 지시로 이전 턴 중단\]\n방금 하던 턴은 Alex의 수정 지시로 끊겼다/);
  assert.doesNotMatch(correction, new RegExp(FIXTURE_OWNER));
  const digest = timelineDigest([{ type: "user_message", text: "[텔레그램] hi" }, { type: "assistant_message", text: "hello" }] as AgentTimelineItem[]);
  assert.match(digest, /^Alex: hi\n오케: hello$/);
  const handoff = handoffToBackup({ fromLabel: "main", toLabel: "backup", reason: "limit", digest, pending: null });
  assert.match(handoff, /^\[텔레그램 · 백업 오케 인수인계\]/);
  assert.match(handoff, /역할: 너는 Alex이 텔레그램으로/);
  assert.match(handoff, /Alex이 기다리는 메시지는 없다/);
  assert.doesNotMatch(handoff, new RegExp(FIXTURE_OWNER));
});

test("switching back to Korean restores the original wording", async () => {
  setLanguage("ko");
  setOwner(FIXTURE_OWNER);
  const { telegram, send } = setup();
  await send({ text: "보고서" });
  await send({ text: "이것도" });
  assert.equal(telegram.last().text, "⏳ 대기열에 넣었어요 — 지금 일 끝나면 바로 볼게요");
  assert.match(helpText(), /^<b>텔레그램 오케<\/b>/);
  assert.equal(botCommands().at(-1)?.description, "사용법");
  assert.deepEqual(usageButtons(), [[{ text: "🔄 새로고침", callback_data: "usage:refresh" }]]);
});
