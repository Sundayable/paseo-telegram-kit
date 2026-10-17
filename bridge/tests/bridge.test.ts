import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { AgentPermissionRequest, AgentPermissionResponse, AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { Bridge } from "../server/bridge.ts";
import { BATCH_RULES, WORKER_ROUTING } from "../server/orchestrator-prompt.ts";

// Keep existing message-content assertions independent of the versioned routing header.
function contentOnly(text: string | undefined): string {
  return (text ?? "").replace(BATCH_RULES + "\n\n", "");
}
import type { AgentSummary, CreateAgentInput, ImageInput, PaseoPort, ProfileSummary } from "../server/paseo-port.ts";
import { QueueStore } from "../server/queue.ts";
import { StateStore } from "../server/state.ts";
import type { UsageCardSnapshot } from "../server/usage-card.ts";
import { TelegramError, type InlineButton, type SendOptions, type TelegramPort, type TgMessage } from "../server/telegram.ts";

const OWNER = 777;
const home = mkdtempSync(join(tmpdir(), "tg-bridge-"));

class FakeTelegram implements TelegramPort {
  sent: Array<{ id: number; text: string; options: SendOptions }> = [];
  edits: Array<{ messageId: number; text: string }> = [];
  reactions: number[] = [];
  callbacks: Array<string | undefined> = [];
  files: string[] = [];
  pins: number[] = [];
  editError: Error | null = null;
  rejectNextHtml = false;
  private nextId = 1000;

  async sendMessage(text: string, options: SendOptions = {}) {
    if (options.html && this.rejectNextHtml) {
      this.rejectNextHtml = false;
      throw new TelegramError(400, "sendMessage: Bad Request: can't parse entities", null);
    }
    const id = this.nextId++;
    this.sent.push({ id, text, options });
    return id;
  }
  async editMessage(messageId: number, text: string) {
    if (this.editError) throw this.editError;
    this.edits.push({ messageId, text });
  }
  async pinMessage(messageId: number) { this.pins.push(messageId); }
  async answerCallback(_id: string, text?: string) {
    this.callbacks.push(text);
  }
  async sendTyping() {}
  async react(messageId: number) {
    this.reactions.push(messageId);
  }
  async downloadFile() {
    return Buffer.from("fake-bytes");
  }
  async sendFile(path: string) {
    this.files.push(path);
    return this.nextId++;
  }
  last() {
    return this.sent[this.sent.length - 1];
  }
  buttons(): InlineButton[] {
    return (this.last().options.buttons ?? []).flat();
  }
}

function agent(id: string, title: string, extra: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id,
    title,
    status: "idle",
    provider: "claude",
    model: "claude-opus-5-5",
    cwd: "/x",
    updatedAt: new Date().toISOString(),
    labels: {},
    attentionReason: null,
    attentionAt: null,
    lastUserMessageAt: null,
    lastError: null,
    archivedAt: null,
    ...extra,
  };
}

const PROFILES: ProfileSummary[] = [
  { id: "agent_profile_fixture_main", name: "메인 오케 · Fable 5.1", provider: "claude", model: "claude-fable-5-1", modeId: "bypassPermissions", thinkingOptionId: "medium" },
  { id: "agent_profile_fixture_codex", name: "백업 오케 · Codex Astra", provider: "codex", model: "gpt-6-astra", modeId: "full-access", thinkingOptionId: "medium" },
];

class FakePaseo implements PaseoPort {
  agents = new Map<string, AgentSummary>();
  sent: Array<{ id: string; text: string; images: ImageInput[] }> = [];
  created: CreateAgentInput[] = [];
  responses: Array<{ id: string; requestId: string; response: AgentPermissionResponse }> = [];
  stopped: string[] = [];
  models: Array<{ id: string; model: string }> = [];
  timelines = new Map<string, AgentTimelineItem[]>();
  private counter = 0;

  add(summary: AgentSummary) {
    this.agents.set(summary.id, summary);
    return summary;
  }
  async listAgents(limit: number) {
    return [...this.agents.values()].slice(0, limit);
  }
  async getAgent(id: string) {
    return this.agents.get(id) ?? null;
  }
  failSend = new Set<string>();
  failCreate = new Set<string>();
  async send(id: string, text: string, images: ImageInput[]) {
    if (!this.agents.has(id)) throw new Error("agent not found");
    if (this.failSend.has(id)) throw new Error("provider unavailable");
    this.sent.push({ id, text, images });
    (this.agents.get(id) as AgentSummary).status = "running";
  }
  async create(input: CreateAgentInput) {
    if (this.failCreate.has(input.provider.split("/")[0])) throw new Error(`${input.provider} is not available`);
    this.created.push(input);
    const id = `0rch${++this.counter}00-0000`;
    this.add(agent(id, input.title, { labels: input.labels, status: "running" }));
    return id;
  }
  async respond(id: string, requestId: string, response: AgentPermissionResponse) {
    this.responses.push({ id, requestId, response });
  }
  async timeline(id: string) {
    return this.timelines.get(id) ?? [];
  }
  async profiles() {
    return PROFILES;
  }
  async stop(id: string) {
    this.stopped.push(id);
  }
  archived: string[] = [];
  async archive(id: string) {
    this.archived.push(id);
    const current = this.agents.get(id);
    if (current) current.archivedAt = new Date(clock).toISOString();
  }
  async setModel(id: string, model: string) {
    this.models.push({ id, model });
    const current = this.agents.get(id);
    if (current) current.model = model;
  }
}

let bridges: Bridge[] = [];
afterEach(() => {
  for (const bridge of bridges) bridge.stop();
  bridges = [];
});

let clock = Date.parse("2026-09-25T10:00:00Z");

function setup(
  options: {
    queueFile?: string;
    debounceMs?: number;
    permissionWaitMs?: number;
    paseo?: FakePaseo;
    state?: StateStore;
    usageReader?: { read(): Promise<UsageCardSnapshot> };
  } = {},
) {
  const telegram = new FakeTelegram();
  const paseo = options.paseo ?? new FakePaseo();
  const state = options.state ?? new StateStore(null);
  const queue = new QueueStore(options.queueFile ?? null);
  const logs: string[] = [];
  const bridge = new Bridge({
    telegram,
    paseo,
    state,
    chatId: OWNER,
    orchestratorCwd: "/tmp/paseo-work",
    downloadDir: join(home, "downloads"),
    homeDir: home,
    transcribe: async () => "음성으로 보낸 말",
    log: (line) => logs.push(line),
    albumDelayMs: 20,
    now: () => clock,
    queue,
    handoffDir: join(home, "handoffs"),
    debounceMs: options.debounceMs ?? 0,
    debounceCapMs: 30_000,
    permissionWaitMs: options.permissionWaitMs ?? 120_000,
    usageReader: options.usageReader,
  });
  bridges.push(bridge);
  // A finished turn leaves the agent idle, as Paseo does before the hook fires.
  const hookTurnEnded = bridge.onTurnEnded.bind(bridge);
  bridge.onTurnEnded = async (hookAgent, outcome, timeline) => {
    const current = paseo.agents.get(hookAgent.id);
    if (current && outcome.kind !== "canceled") current.status = "idle";
    return hookTurnEnded(hookAgent, outcome, timeline);
  };
  let updateId = 1;
  let messageId = 1;
  const send = (message: Partial<TgMessage>) =>
    bridge.handleUpdate({
      update_id: updateId++,
      message: { message_id: messageId++, chat: { id: OWNER, type: "private" }, from: { id: OWNER }, date: 0, ...message },
    });
  const click = (data: string) =>
    bridge.handleUpdate({
      update_id: updateId++,
      callback_query: { id: `cb${updateId}`, from: { id: OWNER }, data, message: { message_id: 1, chat: { id: OWNER } } },
    });
  return { telegram, paseo, state, queue, bridge, logs, send, click };
}

const reply = (text: string): AgentTimelineItem[] =>
  [
    { type: "user_message", text: "[텔레그램] q" },
    { type: "assistant_message", text },
  ] as AgentTimelineItem[];

test("messages from anyone but the owner are ignored", async () => {
  const { telegram, paseo, bridge } = setup();
  await bridge.handleUpdate({
    update_id: 1,
    message: { message_id: 1, chat: { id: 5 }, from: { id: 5 }, date: 0, text: "hi" } as TgMessage,
  });
  await bridge.handleUpdate({ update_id: 2, callback_query: { id: "c", from: { id: 5 }, data: "p:x:0" } });
  assert.equal(telegram.sent.length, 0);
  assert.equal(paseo.created.length + paseo.sent.length, 0);
});

test("the first message creates the orchestrator from the main profile on Opus 5.5; later ones reuse it", async () => {
  const { telegram, paseo, state, bridge, send } = setup();
  await send({ text: "오늘 진행 중인 세션 알려줘" });
  assert.equal(paseo.created.length, 1);
  const created = paseo.created[0];
  assert.equal(created.provider, "claude/claude-opus-5-5", "Opus 5.5 is the default model for the Telegram seat");
  assert.equal(created.modeId, "bypassPermissions");
  assert.equal(contentOnly(created.prompt), "[텔레그램] 오늘 진행 중인 세션 알려줘");
  assert.equal(created.labels.telegram, "orchestrator");
  assert.match(created.systemPrompt, /텔레그램 오케/);
  assert.equal(state.data.orchestratorId, "0rch100-0000");
  assert.deepEqual(telegram.reactions, [1]);
  assert.match(telegram.last().text, /새 오케 세션을 만들었어요/);

  await bridge.onTurnEnded({ id: "0rch100-0000", title: null }, { kind: "completed" }, reply("세션 3개예요."));
  await send({ text: "고마워" });
  assert.equal(paseo.created.length, 1);
  assert.deepEqual(paseo.sent.at(-1), { id: "0rch100-0000", text: BATCH_RULES + "\n\n[텔레그램] 고마워", images: [] });
});

test("an archived orchestrator is replaced on the same seat", async () => {
  const { paseo, state, send } = setup();
  paseo.add(agent("old0000-x", "텔레그램 오케", { archivedAt: "2026-09-24T00:00:00Z" }));
  state.data.orchestratorId = "old0000-x";
  await send({ text: "hi" });
  assert.equal(paseo.created.length, 1);
  assert.equal(paseo.created[0].provider, "claude/claude-opus-5-5");
  assert.equal(state.data.seats.main, state.data.orchestratorId);
});

test("orchestrator turn output goes to Telegram and replies to it go back to the orchestrator", async () => {
  const { telegram, paseo, state, bridge, send } = setup();
  await send({ text: "상태?" });
  const orchestrator = { id: state.data.orchestratorId as string, title: "텔레그램 오케" };
  await bridge.onTurnEnded(orchestrator, { kind: "completed" }, reply("**3개** 돌고 있어요."));
  const out = telegram.last();
  assert.equal(out.text, "<b>3개</b> 돌고 있어요.");
  assert.equal(out.options.html, true);
  await send({ text: "자세히", reply_to_message: { message_id: out.id } });
  assert.equal(paseo.sent.at(-1)?.id, orchestrator.id);
});

test("unfollowed agents stay silent; a reply to a session message talks to that session and follows it", async () => {
  const { telegram, paseo, state, bridge, send } = setup();
  const worker = paseo.add(agent("244d361a-cccc", "채용 공고"));
  const before = telegram.sent.length;
  await bridge.onTurnEnded(worker, { kind: "completed" }, reply("done"));
  assert.equal(telegram.sent.length, before, "not tracked, nothing sent");

  await send({ text: "/ls" });
  await send({ text: "/peek 1" });
  const peekMessage = telegram.last();
  assert.match(peekMessage.text, /채용 공고/);

  await send({ text: "마감일 추가해줘", reply_to_message: { message_id: peekMessage.id } });
  assert.deepEqual(paseo.sent.at(-1), { id: worker.id, text: "마감일 추가해줘", images: [] });
  assert.ok(state.isFollowed(worker.id));

  await bridge.onTurnEnded(worker, { kind: "completed" }, reply("마감일 넣었어요."));
  assert.match(telegram.last().text, /^🔹 <b>채용 공고<\/b> <code>244d361<\/code>/);
  assert.match(telegram.last().text, /마감일 넣었어요\./);
});

test("an agent labelled telegram=follow is forwarded without being in the follow list", async () => {
  const { telegram, paseo, bridge } = setup();
  const worker = paseo.add(agent("abcd1234-x", "리서치", { labels: { telegram: "follow" } }));
  await bridge.onTurnEnded(worker, { kind: "completed" }, reply("결과 요약"));
  assert.match(telegram.last().text, /결과 요약/);
});

test("/to with a listing number sends straight to that session", async () => {
  const { paseo, send } = setup();
  paseo.add(agent("11111111-a", "첫째"));
  paseo.add(agent("22222222-b", "둘째"));
  await send({ text: "/ls" });
  await send({ text: "/to 2 이거 확인해줘" });
  assert.deepEqual(paseo.sent.at(-1), { id: "22222222-b", text: "이거 확인해줘", images: [] });
});

test("questions are asked one at a time with buttons, then answered together", async () => {
  const { telegram, paseo, state, bridge, send, click } = setup();
  await send({ text: "시작" });
  const orchestrator = { id: state.data.orchestratorId as string, title: "텔레그램 오케" };
  const request = {
    id: "req-1",
    provider: "claude",
    name: "AskUserQuestion",
    kind: "question",
    input: {
      questions: [
        { question: "어느 안으로 갈까요?", header: "방향", options: [{ label: "A안" }, { label: "B안" }] },
        { question: "오늘 배포할까요?", header: "배포", options: [{ label: "예" }, { label: "아니요" }] },
      ],
    },
  } as unknown as AgentPermissionRequest;
  await bridge.onPermissionRequested(orchestrator, request);
  assert.match(telegram.last().text, /어느 안으로 갈까요\?/);
  const [first] = telegram.buttons();
  await click(first.callback_data.replace(/:0$/, ":1"));
  assert.match(telegram.last().text, /오늘 배포할까요\?/);
  const firstQuestion = telegram.sent.at(-2) as { id: number };
  assert.match(telegram.edits.at(-1)?.text ?? "", /→ B안/);
  assert.equal(telegram.edits.at(-1)?.messageId, firstQuestion.id);

  // Free-text answer by replying to the second question.
  await send({ text: "내일 할게요", reply_to_message: { message_id: telegram.last().id } });
  assert.deepEqual(paseo.responses, [
    {
      id: orchestrator.id,
      requestId: "req-1",
      response: { behavior: "allow", updatedInput: { answers: { "어느 안으로 갈까요?": "B안", "오늘 배포할까요?": "내일 할게요" } } },
    },
  ]);
  assert.deepEqual(state.data.pending, {});
  assert.equal(paseo.sent.length, 0, "the answer did not also go out as a prompt");
});

test("tool permissions get allow/deny buttons; resolving elsewhere closes the prompt", async () => {
  const { telegram, paseo, state, bridge, click } = setup();
  const worker = paseo.add(agent("33333333-c", "잡일 코딩"));
  state.setFollow(worker.id, true);
  const request = { id: "p1", provider: "grok", name: "Bash", kind: "tool", input: { command: "rm -rf dist" } } as AgentPermissionRequest;

  await bridge.onPermissionRequested(worker, request);
  assert.match(telegram.last().text, /rm -rf dist/);
  const deny = telegram.buttons().find((button) => button.text === "거부") as InlineButton;
  await click(deny.callback_data);
  assert.equal(paseo.responses.at(-1)?.response.behavior, "deny");
  assert.equal(telegram.callbacks.at(-1), "거부");

  // A stale button press after the request is gone.
  await click(deny.callback_data);
  assert.equal(telegram.callbacks.at(-1), "이미 처리된 요청이에요");

  await bridge.onPermissionRequested(worker, { ...request, id: "p2" });
  const prompt = telegram.last();
  await bridge.onPermissionResolved(worker.id, "p2");
  assert.equal(telegram.edits.at(-1)?.messageId, prompt.id);
  assert.match(telegram.edits.at(-1)?.text ?? "", /다른 곳에서 처리됨/);
  assert.deepEqual(state.data.pending, {});
});

test("permission requests from untracked agents are skipped unless /alerts is on", async () => {
  const { telegram, paseo, bridge, send } = setup();
  const worker = paseo.add(agent("44444444-d", "워커"));
  const request = { id: "p9", provider: "grok", name: "Bash", kind: "tool" } as AgentPermissionRequest;
  const before = telegram.sent.length;
  await bridge.onPermissionRequested(worker, request);
  assert.equal(telegram.sent.length, before);
  await send({ text: "/alerts on" });
  await bridge.onPermissionRequested(worker, request);
  assert.match(telegram.last().text, /승인 요청/);
});

test("file markers send the file; paths outside home are refused", async () => {
  const { telegram, state, bridge, send } = setup();
  await send({ text: "스샷" });
  const shot = join(home, "shot.png");
  writeFileSync(shot, "png");
  const orchestrator = { id: state.data.orchestratorId as string, title: null };
  await bridge.onTurnEnded(
    orchestrator,
    { kind: "completed" },
    reply(`여기요.\n[[telegram-file: ${shot}]]\n[[telegram-file: /etc/hosts]]`),
  );
  assert.deepEqual(telegram.files, [shot]);
  assert.ok(telegram.sent.some((message) => message.text === "여기요."));
  assert.match(telegram.last().text, /홈 폴더 밖/);
});

test("credential files are never attached, even inside home", async () => {
  const { telegram, state, bridge, send } = setup();
  await send({ text: "키 보내줘" });
  mkdirSync(join(home, ".config/env"), { recursive: true });
  mkdirSync(join(home, "app"), { recursive: true });
  const secrets = [join(home, ".config/env/.keys.txt"), join(home, "app/.env.local"), join(home, "app/aws-credentials.json")];
  for (const file of secrets) writeFileSync(file, "secret");
  const markers = secrets.map((file) => `[[telegram-file: ${file}]]`).join("\n");
  await bridge.onTurnEnded({ id: state.data.orchestratorId as string, title: null }, { kind: "completed" }, reply(markers));
  assert.deepEqual(telegram.files, []);
  assert.equal(telegram.sent.filter((message) => /비밀 정보가 있을 수 있는 경로/.test(message.text)).length, 3);
});

test("HTML that Telegram rejects is resent as plain text", async () => {
  const { telegram, state, bridge, send } = setup();
  await send({ text: "x" });
  telegram.rejectNextHtml = true;
  await bridge.onTurnEnded({ id: state.data.orchestratorId as string, title: null }, { kind: "completed" }, reply("**굵게**"));
  assert.equal(telegram.last().text, "**굵게**");
  assert.equal(telegram.last().options.html, undefined);
});

test("a followed session's failure is reported; a cancel caused by the owner's own new message is not", async () => {
  const { telegram, paseo, state, bridge, send } = setup();
  await send({ text: "보고서 초안 써줘" });
  const orchestrator = { id: state.data.orchestratorId as string, title: "텔레그램 오케" };
  const helper = paseo.add(agent("66666666-f", "도우미"));
  state.setFollow(helper.id, true);
  await bridge.onTurnEnded(helper, { kind: "failed", error: { message: "tool crashed" } }, []);
  assert.match(telegram.last().text, /도우미<\/b> 턴 실패: tool crashed/);

  // A plain follow-up while the seat works waits in the queue.
  await send({ text: "페이블말고 opus5.5랑 할래" });
  assert.match(telegram.last().text, /대기열에 넣었어요/);
  assert.equal(paseo.sent.length, 0, "nothing interrupted the running turn");

  // A correction interrupts; the cancel it causes is not announced.
  await send({ text: "취소, 요약만 해줘" });
  const redo = contentOnly(paseo.sent.at(-1)?.text);
  assert.match(redo, /수정 지시로 이전 턴 중단/);
  assert.match(redo, /원래 요청:\n\[텔레그램\] 보고서 초안 써줘/);
  assert.match(redo, /Mina\] 페이블말고 opus5\.5랑 할래\n\[\d\d:\d\d Mina\] 취소, 요약만 해줘/);
  const before = telegram.sent.length;
  await bridge.onTurnEnded(orchestrator, { kind: "canceled", reason: "interrupted" }, []);
  assert.equal(telegram.sent.length, before, "no '중단됨' for our own interrupt");

  // A cancel nobody on Telegram caused (e.g. stopped in the desktop app) is reported.
  const worker = paseo.add(agent("55555555-e", "워커"));
  state.setFollow(worker.id, true);
  await bridge.onTurnEnded(worker, { kind: "canceled", reason: "user" }, []);
  assert.match(telegram.last().text, /워커<\/b> 중단됨/);
});

test("/model switches the live orchestrator in place and sets the model for new ones", async () => {
  const { telegram, paseo, state, send } = setup();
  await send({ text: "/model fable" });
  assert.match(telegram.last().text, /메인 세션을 새로 만들 때부터/);
  await send({ text: "hi" });
  assert.equal(paseo.created[0].provider, "claude/claude-fable-5-1");

  await send({ text: "/model opus" });
  assert.deepEqual(paseo.models, [{ id: state.data.orchestratorId, model: "claude-opus-5-5" }]);
  assert.equal(state.data.model, "claude-opus-5-5");
  assert.match(telegram.last().text, /대화는 그대로 이어져요/);

  await send({ text: "/model" });
  assert.match(telegram.last().text, /claude-opus-5-5/);
  await send({ text: "/model gpt" });
  assert.match(telegram.last().text, /모르는 모델/);
  assert.equal(paseo.created.length, 1);
});

test("voice is transcribed, echoed, and forwarded; photos are saved and attached", async () => {
  const { telegram, paseo, bridge, send } = setup();
  await send({ voice: { file_id: "v1", duration: 3 } });
  assert.ok(telegram.sent.some((message) => message.text === "🎙 음성으로 보낸 말"));
  assert.equal(contentOnly(paseo.created[0].prompt), "[텔레그램] 음성으로 보낸 말");
  await bridge.onTurnEnded({ id: paseo.created.length ? "0rch100-0000" : "", title: null }, { kind: "completed" }, reply("네"));

  await send({ caption: "이거 봐줘", photo: [{ file_id: "small", width: 10, height: 10 }, { file_id: "big", width: 99, height: 99 }] });
  const last = paseo.sent.at(-1);
  assert.ok(last);
  assert.match(contentOnly(last.text), /^\[텔레그램\] 이거 봐줘\n\n첨부:\n- 사진: .*photo-\d+\.jpg$/);
  assert.equal(last.images.length, 1);
  assert.equal(last.images[0].mimeType, "image/jpeg");
});

test("an album is delivered as one prompt", async () => {
  const { paseo, state, bridge, send } = setup();
  await send({ text: "시작" });
  await bridge.onTurnEnded({ id: state.data.orchestratorId as string, title: null }, { kind: "completed" }, reply("네"));
  const photo = (id: string) => [{ file_id: id, width: 1, height: 1 }];
  await send({ media_group_id: "g1", caption: "두 장", photo: photo("a") });
  await send({ media_group_id: "g1", photo: photo("b") });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const last = paseo.sent.at(-1);
  assert.ok(last);
  assert.equal(last.images.length, 2);
  assert.equal((last.text.match(/사진:/g) ?? []).length, 2);
  assert.equal(paseo.created.length, 1, "the first text created the orchestrator");
  assert.equal(paseo.sent.length, 1, "both photos went out as one prompt");
});

test("/stop without an argument stops the orchestrator", async () => {
  const { paseo, state, send } = setup();
  await send({ text: "x" });
  await send({ text: "/stop" });
  assert.deepEqual(paseo.stopped, [state.data.orchestratorId]);
});

// ---------------------------------------------------------------- seat fallback chain

const limitTurn = (text: string): AgentTimelineItem[] =>
  [
    { type: "user_message", text: "[텔레그램] 상태?" },
    { type: "assistant_message", text },
  ] as AgentTimelineItem[];

async function onMainSeat() {
  const env = setup();
  await env.send({ text: "어제 만든 웨비나 영상 어디까지 됐어?" });
  const mainId = env.state.data.orchestratorId as string;
  env.paseo.timelines.set(mainId, [
    { type: "user_message", text: "[텔레그램] 어제 만든 웨비나 영상 어디까지 됐어?" },
    { type: "assistant_message", text: "쇼츠 6개 예약 끝났어요." },
  ] as AgentTimelineItem[]);
  await env.bridge.onTurnEnded({ id: mainId, title: "텔레그램 오케" }, { kind: "completed" }, reply("쇼츠 6개 예약 끝났어요."));
  return { ...env, mainId };
}

test("a failed main turn hands over to Cursor Opus 5.5 with a digest and the unanswered message", async () => {
  const { telegram, paseo, state, bridge, send, mainId } = await onMainSeat();
  await send({ text: "본편 업로드 시간 바꿔줘" });
  await bridge.onTurnEnded({ id: mainId, title: "텔레그램 오케" }, { kind: "failed", error: { message: "Claude usage limit reached · resets 3pm" } }, []);

  const seat = paseo.created.at(-1) as CreateAgentInput;
  assert.equal(seat.provider, "cursor/claude-opus-5-5");
  assert.equal(seat.modeId, "agent");
  assert.equal(seat.thinkingOptionId, "medium");
  assert.deepEqual(seat.featureValues, { auto_accept: true });
  assert.equal(seat.labels["telegram.seat"], "cursor");
  assert.match(seat.prompt, /백업 오케 인수인계/);
  assert.match(seat.prompt, /Mina: 어제 만든 웨비나 영상 어디까지 됐어\?/);
  assert.match(seat.prompt, /오케: 쇼츠 6개 예약 끝났어요\./);
  assert.match(seat.prompt, /아직 답을 못 받음\):\n\[텔레그램\] 본편 업로드 시간 바꿔줘/);
  assert.equal(state.data.seat, 1);
  assert.equal(state.data.orchestratorId, state.data.seats.cursor);
  assert.equal(state.data.seats.main, mainId);
  assert.match(telegram.last().text, /^🔁 백업 오케로 전환됨: <b>백업 오케 · Cursor Opus 5\.5<\/b> \(사유: Claude usage limit reached/);

  // The backup seat's replies reach Telegram without a session header.
  await bridge.onTurnEnded({ id: state.data.orchestratorId as string, title: "x" }, { kind: "completed" }, reply("업로드 시간 바꿨어요."));
  assert.equal(telegram.last().text, "업로드 시간 바꿨어요.");
});

test("an answered last message is not resent to the backup seat", async () => {
  const { paseo, bridge, mainId } = await onMainSeat();
  clock += 60_000;
  await bridge.onTurnEnded({ id: mainId, title: null }, { kind: "failed", error: { message: "overloaded_error" } }, []);
  assert.match((paseo.created.at(-1) as CreateAgentInput).prompt, /기다리는 메시지는 없다/);
});

test("the chain continues to Codex Astra, then reports when every seat is down", async () => {
  const { telegram, paseo, state, bridge, mainId } = await onMainSeat();
  await bridge.onTurnEnded({ id: mainId, title: null }, { kind: "failed", error: { message: "usage limit reached" } }, []);
  const since = state.data.fallback?.since;
  await bridge.onTurnEnded({ id: state.data.orchestratorId as string, title: null }, { kind: "failed", error: { message: "cursor quota exceeded" } }, []);
  assert.equal((paseo.created.at(-1) as CreateAgentInput).provider, "codex/gpt-6-astra");
  assert.equal((paseo.created.at(-1) as CreateAgentInput).modeId, "full-access");
  assert.equal(state.data.seat, 2);
  assert.equal(state.data.fallback?.since, since, "the outage start is kept");
  assert.match(telegram.last().text, /백업 오케 · Codex Astra/);

  await bridge.onTurnEnded({ id: state.data.orchestratorId as string, title: null }, { kind: "failed", error: { message: "boom" } }, []);
  assert.match(telegram.last().text, /모든 오케 좌석이 응답하지 않아요/);
  assert.equal(state.data.seat, 2);
});

test("Cursor's completed upgrade notice hands the unanswered request to Astra", async () => {
  const { telegram, paseo, state, bridge, send, mainId } = await onMainSeat();
  await send({ text: "Astra 오케로 이어서 진행해" });
  await bridge.onTurnEnded({ id: mainId, title: null }, { kind: "failed", error: { message: "usage limit reached" } }, []);
  await bridge.onTurnEnded({ id: state.data.orchestratorId as string, title: null }, { kind: "completed" }, limitTurn("Upgrade your plan to continue"));
  assert.equal(state.data.seat, 2);
  assert.equal((paseo.created.at(-1) as CreateAgentInput).provider, "codex/gpt-6-astra");
  assert.match((paseo.created.at(-1) as CreateAgentInput).prompt, /Astra 오케로 이어서 진행해/);
  assert.equal(state.data.lastPrompt?.answered, false);
  assert.ok(!telegram.sent.some((entry) => entry.text === "Upgrade your plan to continue"));
});

test("explaining Cursor's upgrade notice does not switch seats", async () => {
  const { state, bridge, mainId } = await onMainSeat();
  await bridge.onTurnEnded({ id: mainId, title: null }, { kind: "completed" }, limitTurn('Cursor displayed "Upgrade your plan to continue". I switched the worker to Astra.'));
  assert.equal(state.data.seat, 0);
});

test("a seat that cannot even start is skipped", async () => {
  const { paseo, state, bridge, mainId } = await onMainSeat();
  paseo.failCreate.add("cursor");
  await bridge.onTurnEnded({ id: mainId, title: null }, { kind: "failed", error: { message: "usage limit reached" } }, []);
  assert.equal(state.data.seat, 2);
  assert.match((paseo.created.at(-1) as CreateAgentInput).prompt, /Cursor Opus 5\.5 시작 실패/);
});

test("a completed turn that is only a limit notice switches seats; a normal reply mentioning limits does not", async () => {
  const { telegram, paseo, state, bridge, mainId } = await onMainSeat();
  const normal = "Instantly는 도메인별 발송 한도(rate limit) 안쪽이라 괜찮아요. 오늘 보낸 건 38통이고 오픈율은 41%예요.";
  await bridge.onTurnEnded({ id: mainId, title: null }, { kind: "completed" }, limitTurn(normal));
  assert.equal(state.data.seat, 0);
  assert.equal(telegram.last().text, normal);

  await bridge.onTurnEnded({ id: mainId, title: null }, { kind: "completed" }, limitTurn("You've hit your limit · resets 3pm (America/Vancouver)"));
  assert.equal(state.data.seat, 1);
  assert.equal(paseo.created.length, 2);
});

test("when sending to the main seat fails, the message goes straight to the backup", async () => {
  const { telegram, paseo, state, send, mainId } = await onMainSeat();
  paseo.failSend.add(mainId);
  await send({ text: "급한 거 하나만" });
  assert.equal(state.data.seat, 1);
  assert.match((paseo.created.at(-1) as CreateAgentInput).prompt, /전송 실패: provider unavailable/);
  assert.match((paseo.created.at(-1) as CreateAgentInput).prompt, /\[텔레그램\] 급한 거 하나만/);
  assert.ok(telegram.reactions.length > 0, "the owner's message still gets 👀");
});

test("after the retry time the main seat is probed; a good reply returns there with the backup's context", async () => {
  const { telegram, paseo, state, bridge, send, mainId } = await onMainSeat();
  await bridge.onTurnEnded({ id: mainId, title: null }, { kind: "failed", error: { message: "usage limit reached" } }, []);
  const backupId = state.data.orchestratorId as string;
  paseo.timelines.set(backupId, [
    { type: "user_message", text: "[텔레그램 · 백업 오케 인수인계] ..." },
    { type: "assistant_message", text: "이어받았어요." },
    { type: "user_message", text: "[텔레그램] 인디드 공고 올려" },
    { type: "assistant_message", text: "인디드 게시 직전 화면까지 준비했어요." },
  ] as AgentTimelineItem[]);

  await bridge.tick();
  assert.equal(paseo.sent.filter((entry) => entry.id === mainId && /좌석 점검/.test(entry.text)).length, 0, "too early");

  clock += 31 * 60_000;
  await bridge.tick();
  const probe = paseo.sent.at(-1);
  assert.equal(probe?.id, mainId);
  assert.match(probe?.text ?? "", /좌석 점검/);
  await bridge.tick();
  assert.equal(paseo.sent.filter((entry) => /좌석 점검/.test(entry.text)).length, 1, "one probe at a time");

  const before = telegram.sent.length;
  await bridge.onTurnEnded({ id: mainId, title: null }, { kind: "completed" }, limitTurn("준비됨"));
  assert.equal(state.data.seat, 0);
  assert.equal(state.data.orchestratorId, mainId);
  assert.equal(state.data.fallback, null);
  assert.equal(telegram.sent.length, before + 1, "only the return notice, not the probe reply");
  assert.match(telegram.last().text, /메인으로 돌아왔어요/);

  await send({ text: "고마워" });
  const next = paseo.sent.at(-1);
  assert.equal(next?.id, mainId);
  assert.match(next?.text ?? "", /^\[텔레그램 · 메인 좌석 복귀 인수인계\]/);
  assert.match(next?.text ?? "", /Mina: 인디드 공고 올려\n오케: 인디드 게시 직전 화면까지 준비했어요\./);
  assert.match(next?.text ?? "", /\[텔레그램\] 고마워$/);
  assert.equal(state.data.pendingHandoff, null);
});

test("a failed probe stays on the backup quietly and backs off", async () => {
  const { telegram, paseo, state, bridge, mainId } = await onMainSeat();
  await bridge.onTurnEnded({ id: mainId, title: null }, { kind: "failed", error: { message: "usage limit reached" } }, []);
  clock += 31 * 60_000;
  await bridge.tick();
  const before = telegram.sent.length;
  await bridge.onTurnEnded({ id: mainId, title: null }, { kind: "failed", error: { message: "usage limit reached" } }, []);
  assert.equal(state.data.seat, 1);
  assert.equal(telegram.sent.length, before, "no message to the owner");
  assert.equal(state.data.fallback?.attempts, 1);
  assert.equal(state.data.fallback?.retryAt, clock + 60 * 60_000);
  assert.equal(paseo.created.length, 2, "the failed probe did not create another seat");
});

test("/backup and /main move between seats by hand", async () => {
  const { telegram, paseo, state, send, mainId } = await onMainSeat();
  await send({ text: "/backup" });
  assert.equal(state.data.seat, 1);
  assert.match((paseo.created.at(-1) as CreateAgentInput).prompt, /수동 전환/);
  await send({ text: "/main" });
  assert.equal(state.data.seat, 0);
  assert.equal(state.data.orchestratorId, mainId);
  assert.match(telegram.last().text, /메인 오케로 돌아왔어요/);
  await send({ text: "/backup" });
  assert.equal(paseo.created.length, 2, "the Cursor seat is reused, not recreated");
  assert.equal(state.data.seat, 1);
});

test("v0.1 state files migrate to seats", () => {
  const file = join(home, "old-state.json");
  writeFileSync(file, JSON.stringify({ offset: 9, orchestratorId: "cef848ca-x", profile: "main", follow: [], messages: [], pending: {} }));
  const state = new StateStore(file);
  assert.equal(state.data.seat, 0);
  assert.deepEqual(state.data.seats, { main: "cef848ca-x" });
  assert.equal(state.data.orchestratorId, "cef848ca-x");
  assert.equal(state.data.model, "claude-opus-5-5");
  assert.equal((state.data as unknown as { profile?: string }).profile, undefined);
});

// ---------------------------------------------------------------- orchestrator queue

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function busySeat(options: Parameters<typeof setup>[0] = {}) {
  const env = setup(options);
  await env.send({ text: "보고서 초안 써줘" }); // message_id 1 starts the running turn
  const seatId = env.state.data.orchestratorId as string;
  const finishSeat = (text = "끝났어요") =>
    env.bridge.onTurnEnded({ id: seatId, title: null }, { kind: "completed" }, reply(text));
  return { ...env, seatId, finishSeat };
}

test("two quick messages to an idle seat go out as one prompt, without an ack", async () => {
  const { telegram, paseo, send } = setup({ debounceMs: 40 });
  await send({ text: "메일 초안 써줘" });
  await send({ text: "아, 톤은 짧게" });
  assert.equal(paseo.created.length, 0, "still waiting for the owner to stop typing");
  await sleep(90);
  assert.equal(paseo.created.length, 1);
  assert.match(contentOnly(paseo.created[0].prompt), /^\[텔레그램\] 메시지 2개, 순서대로:\n\[\d\d:\d\d Mina\] 메일 초안 써줘\n\[\d\d:\d\d Mina\] 아, 톤은 짧게$/);
  assert.ok(!telegram.sent.some((message) => /대기열/.test(message.text)));
  assert.deepEqual(telegram.reactions, [1, 2], "both messages get 👀 when delivered");
});

test("a normal message while the seat works is queued with an ack and delivered at turn end", async () => {
  const { telegram, paseo, send, finishSeat, seatId } = await busySeat();
  await send({ text: "아니 근데 이것도 해줘: 캘린더 확인" });
  await send({ text: "그리고 인보이스도" });
  assert.equal(paseo.sent.length, 0, "the running turn was not interrupted");
  assert.equal(telegram.sent.filter((message) => /^⏳ 대기열에 넣었어요/.test(message.text)).length, 2);
  await finishSeat();
  const batch = paseo.sent.at(-1);
  assert.equal(batch?.id, seatId);
  assert.match(batch?.text ?? "", /메시지 2개, 순서대로:\n\[\d\d:\d\d Mina\] 아니 근데 이것도 해줘: 캘린더 확인\n\[\d\d:\d\d Mina\] 그리고 인보이스도$/);
});

test("replying to the message that started the turn interrupts with the original and a no-repeat rule", async () => {
  const { paseo, send } = await busySeat();
  await send({ text: "영어로 써줘", reply_to_message: { message_id: 1 } });
  const redo = contentOnly(paseo.sent.at(-1)?.text);
  assert.match(redo, /^\[텔레그램 · 수정 지시로 이전 턴 중단\]/);
  assert.match(redo, /이미 한 일\(만든 초안, 띄운 워커, 커밋, 발송\)을 먼저 확인/);
  assert.match(redo, /원래 요청:\n\[텔레그램\] 보고서 초안 써줘/);
  assert.match(redo, /Mina\] 영어로 써줘$/);
});

test("a keyword correction interrupts; '아니 근데' and a reply to a bot message do not", async () => {
  const { paseo, send, telegram } = await busySeat();
  await send({ text: "아니 근데 표도 넣어줘" });
  assert.equal(paseo.sent.length, 0);
  await send({ text: "잠깐,\n표 말고 목록으로" });
  const redo = contentOnly(paseo.sent.at(-1)?.text);
  assert.match(redo, /수정 지시로 이전 턴 중단/);
  assert.match(redo, /Mina\] 아니 근데 표도 넣어줘\n\[\d\d:\d\d Mina\] 잠깐,\n표 말고 목록으로/, "queued messages ride along, in order");
  assert.ok(telegram.sent.some((message) => /대기열/.test(message.text)));
});

test("/now interrupts a busy seat and skips the debounce when idle", async () => {
  const busy = await busySeat();
  await busy.send({ text: "/now 이것부터 해줘" });
  assert.match(busy.paseo.sent.at(-1)?.text ?? "", /Mina\] 이것부터 해줘$/);

  const idle = setup({ debounceMs: 5000 });
  await idle.send({ text: "/now 바로" });
  assert.equal(contentOnly(idle.paseo.created[0]?.prompt), "[텔레그램] 바로");
});

test("a batch older than 15 minutes is flagged as possibly stale", async () => {
  const { paseo, send, finishSeat } = await busySeat();
  await send({ text: "이거 봐줘" });
  await send({ text: "저것도" });
  clock += 16 * 60_000;
  await finishSeat();
  assert.match(contentOnly(paseo.sent.at(-1)?.text), /^\[텔레그램\] 메시지 2개, 순서대로 \(대기 중 쌓인 메시지 2개\):/);
});

test("queued messages survive a restart, are replayed once, and a re-sent update is ignored", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "tg-replay-")), "queue.json");
  const before = await busySeat({ queueFile: file });
  await before.send({ text: "재시작 전에 보낸 말" }); // update_id 2, queued
  before.bridge.stop();

  (before.paseo.agents.get(before.seatId) as AgentSummary).status = "idle";
  const after = setup({ queueFile: file, paseo: before.paseo, state: before.state });
  await after.bridge.resume();
  const replayed = after.paseo.sent.filter((entry) => /재시작 전에 보낸 말/.test(entry.text));
  assert.equal(replayed.length, 1);
  assert.equal(contentOnly(replayed[0].text), "[텔레그램] 재시작 전에 보낸 말");

  // Telegram re-sends update 2 because the offset was not saved before the crash.
  await after.bridge.handleUpdate({
    update_id: 2,
    message: { message_id: 2, chat: { id: OWNER, type: "private" }, from: { id: OWNER }, date: 0, text: "재시작 전에 보낸 말" },
  });
  assert.equal(after.paseo.sent.filter((entry) => /재시작 전에 보낸 말/.test(entry.text)).length, 1);
});

test("a worker's finish waits in the queue; its permission request cuts in after the wait", async () => {
  const { paseo, bridge, seatId, finishSeat } = await busySeat({ permissionWaitMs: 40 });
  const worker = { id: "77777777-0000-4000-8000-000000000001", title: "영상 워커", parentAgentId: seatId };
  paseo.add(agent(worker.id, worker.title));
  await bridge.onTurnEnded(worker, { kind: "completed" }, reply("씬 3개 렌더 끝"));
  assert.equal(paseo.sent.length, 0, "finish notices do not interrupt");

  await bridge.onPermissionRequested(worker, {
    id: "req-9",
    provider: "grok",
    name: "Bash",
    kind: "tool",
    title: "ffmpeg 실행",
  } as AgentPermissionRequest);
  assert.equal(paseo.sent.length, 0, "not yet");
  await sleep(80);
  const cut = contentOnly(paseo.sent.at(-1)?.text);
  assert.match(cut, /^\[텔레그램 · 워커 권한 요청으로 잠깐 끼어듦\]/);
  assert.match(cut, /하던 일:\n\[텔레그램\] 보고서 초안 써줘/);
  assert.match(cut, /Paseo 알림\] 워커 7777777 \(영상 워커\) 턴 완료: 씬 3개 렌더 끝/);
  assert.match(cut, /Paseo 권한 요청\] 워커 7777777 \(영상 워커\)가 승인을 기다려요 \(request req-9\): ffmpeg 실행/);
  void finishSeat;
});

test("a permission request is delivered at turn end if that comes first", async () => {
  const { paseo, bridge, seatId, finishSeat } = await busySeat({ permissionWaitMs: 5000 });
  const worker = { id: "77777777-0000-4000-8000-000000000002", title: "워커", parentAgentId: seatId };
  paseo.add(agent(worker.id, worker.title));
  await bridge.onPermissionRequested(worker, { id: "req-1", provider: "grok", name: "Bash", kind: "tool" } as AgentPermissionRequest);
  await finishSeat();
  assert.match(contentOnly(paseo.sent.at(-1)?.text), /^\[텔레그램\] 메시지 1개, 순서대로:\n\[\d\d:\d\d Paseo 권한 요청\]/);
});

test("workers prompted through Paseo tools are tracked; seats without the notices label are left to Paseo", async () => {
  const { paseo, state, bridge, seatId } = await busySeat();
  const prompted = "88888888-0000-4000-8000-000000000003";
  paseo.add(agent(prompted, "기존 세션"));
  await bridge.onTurnEnded({ id: seatId, title: null }, { kind: "completed" }, [
    { type: "user_message", text: "[텔레그램] 보고서 초안 써줘" },
    { type: "tool_call", callId: "c1", name: "mcp__paseo__send_agent_prompt", status: "completed", error: null, detail: { type: "unknown", input: { agentId: prompted, prompt: "써줘" }, output: null } },
    { type: "assistant_message", text: "맡겼어요." },
  ] as AgentTimelineItem[]);
  assert.ok(prompted in state.data.workers);
  await bridge.onTurnEnded({ id: prompted, title: "기존 세션" }, { kind: "completed" }, reply("초안 완료"));
  assert.match(paseo.sent.at(-1)?.text ?? "", /Paseo 알림\] 워커 8888888 \(기존 세션\) 턴 완료: 초안 완료/);

  // An older seat (no telegram.notices label) still gets Paseo's own notifications.
  const legacy = paseo.add(agent("99999999-0000-4000-8000-000000000004", "텔레그램 오케", { labels: { telegram: "orchestrator" } }));
  state.data.orchestratorId = legacy.id;
  const sentBefore = paseo.sent.length;
  await bridge.onTurnEnded({ id: "abababab-0000-4000-8000-000000000005", title: "워커", parentAgentId: legacy.id }, { kind: "completed" }, reply("끝"));
  assert.equal(paseo.sent.length, sentBefore);
});

// ---------------------------------------------------------------- stalled sessions

const SESSION_LIMIT = "You've hit your session limit · resets 5:40pm (America/Vancouver)";

test("a session-limit stall is resumed once, 5 minutes after the stated reset", async () => {
  clock = Date.parse("2026-09-25T16:00:00-07:00");
  const { telegram, paseo, state, bridge } = setup();
  const worker = paseo.add(agent("aaaa0001-0000-4000-8000-000000000001", "테네리페 영상", { lastUserMessageAt: "2026-09-25T22:30:00Z" }));
  await bridge.onTurnEnded(worker, { kind: "completed" }, reply(SESSION_LIMIT));
  assert.equal(new Date(state.data.stalls[worker.id].resetAt ?? 0).toISOString(), "2026-09-26T00:40:00.000Z");

  clock = Date.parse("2026-09-25T17:44:00-07:00");
  await bridge.processStalls();
  assert.equal(paseo.sent.length, 0, "reset + 5 min not reached");

  clock = Date.parse("2026-09-25T17:46:00-07:00");
  await bridge.processStalls();
  assert.deepEqual(paseo.sent.at(-1), { id: worker.id, text: "세션 한도로 중단됐던 작업이에요. 멈춘 지점부터 이어서 끝까지 해 주세요.", images: [] });
  assert.equal(telegram.last().text, "▶️ 한도가 풀려서 멈췄던 세션 1개를 이어서 돌렸어요: 테네리페 영상(aaaa000)");

  // It finishes; the same stall is never resumed again, even after a rescan.
  (paseo.agents.get(worker.id) as AgentSummary).status = "idle";
  clock += 2 * 60_000;
  await bridge.processStalls();
  assert.equal(state.data.stalls[worker.id].status, "done");
  await bridge.scanStalls(true);
  await bridge.processStalls();
  assert.equal(paseo.sent.length, 1);
});

test("resumes are staggered two at a time", async () => {
  clock = Date.parse("2026-09-25T16:00:00-07:00");
  const { telegram, paseo, bridge } = setup();
  const ids = ["b1", "b2", "b3"].map((suffix, index) =>
    paseo.add(agent(`bbbb000${index}-0000-4000-8000-00000000000${index}`, `작업 ${suffix}`)),
  );
  for (const worker of ids) await bridge.onTurnEnded(worker, { kind: "completed" }, reply(SESSION_LIMIT));
  clock = Date.parse("2026-09-25T17:50:00-07:00");
  await bridge.processStalls();
  assert.equal(paseo.sent.length, 2);
  assert.match(telegram.last().text, /세션 2개를 이어서 돌렸어요: .*\(대기 1개\)$/);
  await bridge.processStalls();
  assert.equal(paseo.sent.length, 2, "still two running");
  (paseo.agents.get(ids[0].id) as AgentSummary).status = "idle";
  clock += 2 * 60_000;
  await bridge.processStalls();
  assert.equal(paseo.sent.length, 3);
  assert.equal(paseo.sent.at(-1)?.id, ids[2].id);
});

test("archived, scheduled and already re-prompted agents are left alone", async () => {
  clock = Date.parse("2026-09-25T16:00:00-07:00");
  const { paseo, state, bridge } = setup();
  const scheduled = paseo.add(agent("cccc0001-0000-4000-8000-000000000001", "booking watcher", { labels: { "paseo.schedule-id": "ec539c15" } }));
  await bridge.onTurnEnded(scheduled, { kind: "completed" }, reply(SESSION_LIMIT));
  assert.equal(state.data.stalls[scheduled.id], undefined);

  const archived = paseo.add(agent("cccc0002-0000-4000-8000-000000000002", "보관될 것"));
  const reprompted = paseo.add(agent("cccc0003-0000-4000-8000-000000000003", "다시 지시함"));
  await bridge.onTurnEnded(archived, { kind: "completed" }, reply(SESSION_LIMIT));
  await bridge.onTurnEnded(reprompted, { kind: "completed" }, reply(SESSION_LIMIT));
  (paseo.agents.get(archived.id) as AgentSummary).archivedAt = "2026-09-25T23:10:00Z";
  (paseo.agents.get(reprompted.id) as AgentSummary).lastUserMessageAt = "2026-09-25T23:30:00Z"; // owner: 16:30 PT
  clock = Date.parse("2026-09-25T17:50:00-07:00");
  await bridge.processStalls();
  assert.equal(paseo.sent.length, 0);
  assert.equal(state.data.stalls[archived.id].status, "skipped");
  assert.equal(state.data.stalls[reprompted.id].reason, "Mina가 이미 다시 지시함");
});

test("the periodic scan finds stalls from lastError and from Claude's final text, within 24 hours", async () => {
  clock = Date.parse("2026-09-25T12:00:00-07:00");
  const { paseo, state, bridge } = setup();
  const codex = paseo.add(agent("dddd0001-0000-4000-8000-000000000001", "Astra 설계", {
    provider: "codex",
    attentionAt: "2026-09-25T18:00:00Z",
    lastError: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 26th, 2026 1:20 AM.",
  }));
  const claude = paseo.add(agent("dddd0002-0000-4000-8000-000000000002", "Opus 구현", { attentionAt: "2026-09-25T18:30:00Z" }));
  paseo.timelines.set(claude.id, reply(SESSION_LIMIT));
  const old = paseo.add(agent("dddd0003-0000-4000-8000-000000000003", "그저께 것", {
    attentionAt: "2026-09-23T18:00:00Z",
    lastError: "You've hit your usage limit. try again at Sep 24th, 2026 1:20 AM.",
  }));
  await bridge.scanStalls(true);
  assert.equal(new Date(state.data.stalls[codex.id].resetAt ?? 0).toISOString(), "2026-09-26T08:20:00.000Z");
  assert.ok(state.data.stalls[claude.id]);
  assert.equal(state.data.stalls[old.id], undefined);
});

test("a Grok balance stall waits until the usage cache shows credit again", async () => {
  clock = Date.parse("2026-09-25T10:00:00-07:00");
  let usage = {};
  const env = setup();
  const bridge = new Bridge({ ...(env.bridge as unknown as { options: ConstructorParameters<typeof Bridge>[0] }).options, usage: () => usage });
  const grok = env.paseo.add(agent("eeee0001-0000-4000-8000-000000000001", "리서치", { provider: "grok" }));
  await bridge.onTurnEnded(grok, { kind: "failed", error: { message: "Internal error: API error (status 402 Payment Required): Grok Build usage balance exhausted" } }, []);
  clock += 3 * 3600_000;
  await bridge.processStalls();
  assert.equal(env.paseo.sent.length, 0, "no reset signal yet");
  usage = { grok_week: { remainingPct: 80, resetIso: null, at: clock } };
  clock += 6 * 60_000;
  await bridge.processStalls();
  assert.equal(env.paseo.sent.at(-1)?.id, grok.id);
  bridge.stop();
});

// ---------------------------------------------------------------- rotation

test("nightly rotation hands off to a fresh seat, archives the old one, and says so quietly", async () => {
  clock = Date.parse("2026-09-26T03:20:00-07:00");
  const { telegram, paseo, state, bridge, send } = setup();
  await send({ text: "인디드 공고 초안 봐줘" });
  const oldId = state.data.orchestratorId as string;
  const worker = paseo.add(agent("f0f0f0f0-0000-4000-8000-000000000001", "영상 워커", { status: "running" }));
  state.data.workers[worker.id] = clock;
  paseo.timelines.set(oldId, [
    { type: "user_message", text: "[텔레그램] 인디드 공고 초안 봐줘" },
    { type: "assistant_message", text: "초안: https://example.com/drafts/20260925-indeed-posting\n인디드에 올릴까요?" },
  ] as AgentTimelineItem[]);
  await bridge.onTurnEnded({ id: oldId, title: null }, { kind: "completed" }, reply("인디드에 올릴까요?"));

  await bridge.tick();
  assert.equal(paseo.created.length, 1, "03:20 is before the window");

  clock = Date.parse("2026-09-26T03:31:00-07:00");
  await bridge.tick();
  const seat = paseo.created.at(-1) as CreateAgentInput;
  assert.equal(paseo.created.length, 2);
  assert.equal(seat.provider, "claude/claude-opus-5-5");
  assert.deepEqual(seat.labels, { telegram: "orchestrator", "telegram.seat": "main", "telegram.notices": "bridge" });
  assert.match(seat.prompt, /^\[텔레그램 · 오케 교대 인수인계\]/);
  assert.match(seat.prompt, /- 인디드에 올릴까요\?/);
  assert.match(seat.prompt, /- f0f0f0f 영상 워커 — running/);
  assert.match(seat.prompt, /- https:\/\/example\.com\/drafts\/20260925-indeed-posting/);
  const newId = state.data.orchestratorId as string;
  assert.notEqual(newId, oldId);
  assert.equal(state.data.seats.main, newId);
  assert.deepEqual(paseo.archived, [oldId]);
  assert.equal(state.data.lastRotationDay, "2026-09-26");
  const notice = telegram.last();
  assert.match(notice.text, /오케 세션을 새로 교대했어요/);
  assert.equal(notice.options.silent, true, "no buzz at 3:30am");

  // The new seat's handoff ack is not forwarded; later replies are.
  const before = telegram.sent.length;
  await bridge.onTurnEnded({ id: newId, title: null }, { kind: "completed" }, reply("인수인계 확인"));
  assert.equal(telegram.sent.length, before);
  await bridge.tick();
  assert.equal(paseo.created.length, 2, "once a night");

  // Workers of the retired seat still report to the new one.
  await bridge.onTurnEnded({ id: "abcdabcd-0000-4000-8000-000000000009", title: "옛 자식", parentAgentId: oldId }, { kind: "completed" }, reply("끝"));
  assert.match(paseo.sent.at(-1)?.text ?? "", /Paseo 알림\] 워커 abcdabc \(옛 자식\) 턴 완료: 끝/);
});

test("nightly rotation waits for an idle seat and an empty queue, and gives up after 05:00", async () => {
  clock = Date.parse("2026-09-26T03:25:00-07:00");
  const { paseo, bridge, send } = setup();
  await send({ text: "긴 작업" }); // seat busy
  clock = Date.parse("2026-09-26T03:35:00-07:00");
  await bridge.tick();
  assert.equal(paseo.created.length, 1, "busy: no rotation");
  clock = Date.parse("2026-09-26T05:01:00-07:00");
  const seatId = paseo.created.length ? (await paseo.listAgents(1))[0].id : "";
  await bridge.onTurnEnded({ id: seatId, title: null }, { kind: "completed" }, reply("끝"));
  await bridge.tick();
  assert.equal(paseo.created.length, 1, "outside the window");
});

test("/rotate while busy rotates as soon as the turn ends", async () => {
  clock = Date.parse("2026-09-26T14:00:00-07:00");
  const { telegram, paseo, state, bridge, send } = setup();
  await send({ text: "보고서" });
  const oldId = state.data.orchestratorId as string;
  await send({ text: "/rotate" });
  assert.match(telegram.last().text, /끝나면 교대할게요/);
  await bridge.onTurnEnded({ id: oldId, title: null }, { kind: "completed" }, reply("보고서 끝"));
  assert.equal(paseo.created.length, 2);
  assert.deepEqual(paseo.archived, [oldId]);
  assert.notEqual(telegram.last().options.silent, true, "a manual rotation notifies normally");
});

// ---------------------------------------------------------------- waiting workers

const WAITING_REPLY = "렌더링 진행 중입니다. 끝나면 알림이 와서 이어서 마무리할게요.";
const WAKE =
  "기다리다 턴이 끝났어요. 진행 중인 작업을 백그라운드 until-loop로 직접 기다렸다가 원래 작업을 끝까지 마무리해 주세요. 이 세션에서 네가 직접 시작한 작업만 기다리고, 그런 작업이 없으면 다른 세션 일은 건드리지 말고 상태만 한 줄로 보고해.";

test("a worker that stops 'waiting' is woken after 3 minutes, at most every 30 minutes and 3 times", async () => {
  clock = Date.parse("2026-09-26T10:00:00-07:00");
  const { paseo, state, bridge, send } = setup();
  await send({ text: "시작" }); // an orchestrator seat to receive the one-line log
  const seatId = state.data.orchestratorId as string;
  await bridge.onTurnEnded({ id: seatId, title: null }, { kind: "completed" }, reply("네"));
  const worker = paseo.add(agent("12121212-0000-4000-8000-000000000001", "테네리페 영상", { lastUserMessageAt: "2026-09-26T16:50:00Z" }));

  await bridge.onTurnEnded(worker, { kind: "completed" }, reply(WAITING_REPLY));
  clock += 2 * 60_000;
  await bridge.processWakes();
  assert.equal(paseo.sent.filter((entry) => entry.id === worker.id).length, 0, "not yet 3 minutes");

  clock += 2 * 60_000;
  await bridge.processWakes();
  assert.deepEqual(paseo.sent.find((entry) => entry.id === worker.id), { id: worker.id, text: WAKE, images: [] });
  assert.match(paseo.sent.at(-1)?.text ?? "", /Paseo 알림\] 워커 1212121 \(테네리페 영상\)가 기다리다 멈춰서 깨웠어요 \(1\/3\)/, "one line to the orchestrator");
  assert.equal(state.data.wakeLog.length, 1);

  // It stops waiting again 10 minutes later: the next wake waits for the 30-minute backoff.
  (paseo.agents.get(worker.id) as AgentSummary).status = "idle";
  clock += 10 * 60_000;
  await bridge.onTurnEnded(worker, { kind: "completed" }, reply(WAITING_REPLY));
  clock += 5 * 60_000;
  await bridge.processWakes();
  assert.equal(paseo.sent.filter((entry) => entry.id === worker.id).length, 1);
  clock += 16 * 60_000;
  await bridge.processWakes();
  assert.equal(paseo.sent.filter((entry) => entry.id === worker.id).length, 2);

  for (let round = 0; round < 3; round += 1) {
    (paseo.agents.get(worker.id) as AgentSummary).status = "idle";
    clock += 31 * 60_000;
    await bridge.onTurnEnded(worker, { kind: "completed" }, reply(WAITING_REPLY));
    clock += 4 * 60_000;
    await bridge.processWakes();
  }
  assert.equal(paseo.sent.filter((entry) => entry.id === worker.id).length, 3, "never more than 3");
});

test("no wake when the worker runs again, was re-prompted, is scheduled, archived, a seat, or still has a live tool", async () => {
  clock = Date.parse("2026-09-26T10:00:00-07:00");
  const { paseo, state, bridge } = setup();
  const again = paseo.add(agent("13131313-0000-4000-8000-000000000001", "다시 돈 것"));
  const prompted = paseo.add(agent("13131313-0000-4000-8000-000000000002", "사용자가 말 건 것"));
  const scheduled = paseo.add(agent("13131313-0000-4000-8000-000000000003", "예약 실행", { labels: { "paseo.schedule-id": "x" } }));
  const live = paseo.add(agent("13131313-0000-4000-8000-000000000004", "모니터 도는 중"));
  for (const worker of [again, prompted, scheduled]) await bridge.onTurnEnded(worker, { kind: "completed" }, reply(WAITING_REPLY));
  await bridge.onTurnEnded(live, { kind: "completed" }, [
    { type: "user_message", text: "x" },
    { type: "tool_call", callId: "1", name: "Monitor", status: "running", error: null, detail: { type: "plain_text" } },
    { type: "assistant_message", text: WAITING_REPLY },
  ] as AgentTimelineItem[]);
  paseo.timelines.set(live.id, [{ type: "tool_call", callId: "1", name: "Monitor", status: "running", error: null, detail: { type: "plain_text" } }] as AgentTimelineItem[]);
  assert.equal(state.data.wakes[scheduled.id], undefined);

  bridge.onTurnStarted(again.id); // its background job finished and re-invoked it
  (paseo.agents.get(prompted.id) as AgentSummary).lastUserMessageAt = new Date(clock + 60_000).toISOString();
  clock += 5 * 60_000;
  await bridge.processWakes();
  assert.equal(paseo.sent.length, 0);

  // The live tool keeps it asleep until it stops (or two hours pass).
  paseo.timelines.set(live.id, reply("끝"));
  clock += 60_000;
  await bridge.processWakes();
  assert.deepEqual(paseo.sent.map((entry) => entry.id), [live.id]);
});

test("the periodic scan catches a waiting turn whose hook was missed, and the digest lists wakes", async () => {
  clock = Date.parse("2026-09-26T10:00:00-07:00");
  const { paseo, state, bridge } = setup();
  const worker = paseo.add(agent("14141414-0000-4000-8000-000000000001", "업로드 워커", { attentionAt: new Date(clock - 60_000).toISOString() }));
  paseo.timelines.set(worker.id, reply("업로드는 백그라운드에서 돌아가요. 완료되면 이어서 예약까지 할게요."));
  await bridge.scanWaits(true);
  assert.equal(state.data.wakes[worker.id]?.pendingSince, clock - 60_000);
  clock += 3 * 60_000;
  await bridge.processWakes();
  assert.equal(paseo.sent.at(-1)?.text, WAKE);
  const digest = await bridge.buildDigest("지금 요약");
  assert.match(digest, /⏰ 기다리다 멈춰서 깨운 세션 1<\/b>\n• 업로드 워커 <code>1414141<\/code> · 9\/26 10:0\d \(1\/3\)/);
});

test("new seats and handoffs carry the long-job rule for worker prompts", async () => {
  clock = Date.parse("2026-09-26T14:00:00-07:00");
  const { paseo, state, bridge, send } = setup();
  await send({ text: "시작" });
  const rule = "If you start a long job, wait for it yourself with a background until-loop and finish the task in the same run.";
  assert.ok(paseo.created[0].systemPrompt.includes(rule));
  await bridge.onTurnEnded({ id: state.data.orchestratorId as string, title: null }, { kind: "completed" }, reply("네"));
  await send({ text: "/rotate" });
  assert.ok((paseo.created.at(-1) as CreateAgentInput).prompt.includes(rule));
});

test("an orchestrator turn that ends with [[무음]] sends the owner nothing", async () => {
  const { telegram, finishSeat } = await busySeat();
  const before = telegram.sent.length;
  await finishSeat("[[무음]]");
  assert.equal(telegram.sent.length, before);
});

const usageFixture = (): UsageCardSnapshot => ({checkedAt: clock, rows: [{id:'codex_week',label:'Codex · 주간',remainingPct:67,resetIso:new Date(clock+3600000).toISOString(),at:clock,status:'available'}]});

test('usage command and refresh stay outside the orchestrator and preserve buttons', async () => {
  let reads=0;
  const {send,click,telegram,paseo,queue}=setup({usageReader:{read:async()=>{reads++;return usageFixture();}}});
  await send({text:'/usage'});
  assert.match(telegram.last().text,/67% 남음/);
  assert.equal(telegram.buttons()[0].callback_data,'usage:refresh');
  await click('usage:refresh');
  assert.equal(reads,2);
  assert.equal(telegram.edits.length,1);
  assert.equal(paseo.created.length,0);
  assert.equal(paseo.sent.length,0);
  assert.equal(queue.length,0);
});

test('usage rejects wrong sender, wrong chat, groups and callbacks without reading data', async () => {
  let reads=0;
  const {bridge,telegram}=setup({usageReader:{read:async()=>{reads++;return usageFixture();}}});
  for(const [user,chat] of [[1,OWNER],[OWNER,1],[OWNER,-777]]) {
    await bridge.handleUpdate({update_id:1,message:{message_id:1,chat:{id:chat,type:chat<0?'group':'private'},from:{id:user},date:0,text:'/usage'}});
    await bridge.handleUpdate({update_id:2,callback_query:{id:'x',from:{id:user},data:'usage:refresh',message:{message_id:1,chat:{id:chat}}}});
  }
  assert.equal(reads,0);
  assert.equal(telegram.sent.length,0);
  assert.equal(telegram.edits.length,0);
});

test('one pinned usage card survives repeated refreshes and persisted state', async () => {
  const state=new StateStore(join(mkdtempSync(join(home,'usage-state-')),'state.json'));
  const a=setup({state,usageReader:{read:async()=>usageFixture()}});
  await a.bridge.refreshUsagePanel(true);
  const id=state.data.usagePanelMessageId;
  assert.ok(id);
  assert.deepEqual(a.telegram.pins,[id]);
  await a.bridge.refreshUsagePanel(true);
  assert.equal(a.telegram.sent.length,1);
  assert.equal(a.telegram.edits[0].messageId,id);
  const b=setup({state:new StateStore((state as any).file),usageReader:{read:async()=>usageFixture()}});
  await b.bridge.refreshUsagePanel(true);
  assert.equal(b.telegram.sent.length,0);
  assert.equal(b.telegram.edits[0].messageId,id);
  assert.equal(b.telegram.pins.length,0);
});

test('usage timer waits five minutes and coalesces concurrent refreshes', async () => {
  let done!:(v:UsageCardSnapshot)=>void;
  let reads=0;
  const {bridge,telegram}=setup({usageReader:{read:()=>{reads++;return new Promise(r=>{done=r;});}}});
  const a=bridge.refreshUsagePanel(true),b=bridge.refreshUsagePanel(true);
  assert.equal(reads,1);
  done(usageFixture());await Promise.all([a,b]);
  await bridge.refreshUsagePanel();
  assert.equal(reads,1);assert.equal(telegram.sent.length,1);
  clock+=5*60000;
  const c=bridge.refreshUsagePanel();assert.equal(reads,2);done(usageFixture());await c;
  assert.equal(telegram.edits.length,1);
});

test('uncertain Telegram send is not repeated automatically', async () => {
  const {bridge,telegram,state}=setup({usageReader:{read:async()=>usageFixture()}});
  let sends=0;
  telegram.sendMessage=async()=>{sends++;throw new TelegramError(0,'network timeout',null);};
  await assert.rejects(bridge.refreshUsagePanel(true));
  assert.equal(state.data.usagePanelSendPending,true);
  await bridge.refreshUsagePanel(true);
  assert.equal(sends,1);
});

test('only a definitive deleted message creates a replacement usage card', async () => {
  const {bridge,telegram,state}=setup({usageReader:{read:async()=>usageFixture()}});
  state.data.usagePanelMessageId=77;state.data.usagePanelPinned=true;
  telegram.editError=new TelegramError(0,'network timeout',null);
  await assert.rejects(bridge.refreshUsagePanel(true));assert.equal(telegram.sent.length,0);
  telegram.editError=new TelegramError(400,'message to edit not found',null);
  await bridge.refreshUsagePanel(true);
  assert.equal(telegram.sent.length,1);assert.notEqual(state.data.usagePanelMessageId,77);
});

test('stopping bridge suppresses an in-flight usage send', async () => {
  let done!:(v:UsageCardSnapshot)=>void;
  const {bridge,telegram}=setup({usageReader:{read:()=>new Promise(r=>{done=r;})}});
  const pending=bridge.refreshUsagePanel(true);bridge.stop();done(usageFixture());await pending;
  assert.equal(telegram.sent.length,0);
});

test('stop during edit or send never begins another Telegram operation', async () => {
  const a=setup({usageReader:{read:async()=>usageFixture()}});
  a.state.data.usagePanelMessageId=10;
  a.telegram.editMessage=async()=>{a.bridge.stop();throw new TelegramError(400,'message to edit not found',null);};
  await a.bridge.refreshUsagePanel(true);
  assert.equal(a.telegram.sent.length,0);assert.equal(a.telegram.pins.length,0);
  const b=setup({usageReader:{read:async()=>usageFixture()}});
  b.telegram.sendMessage=async()=>{b.bridge.stop();return 42;};
  await b.bridge.refreshUsagePanel(true);
  assert.equal(b.telegram.pins.length,0);
  assert.equal(b.state.data.usagePanelMessageId,42);
});

test('a Telegram server error preserves the uncertain-send guard', async () => {
  const {bridge,telegram,state}=setup({usageReader:{read:async()=>usageFixture()}});
  telegram.sendMessage=async()=>{throw new TelegramError(502,'upstream unavailable',null);};
  await assert.rejects(bridge.refreshUsagePanel(true));
  assert.equal(state.data.usagePanelSendPending,true);
});

test('an owner refresh recovers an accepted card after its send reply was lost', async () => {
  const {bridge,state,telegram}=setup({usageReader:{read:async()=>usageFixture()}});
  state.data.usagePanelSendPending=true;
  await bridge.handleUpdate({update_id:99,callback_query:{id:'owner',from:{id:OWNER},data:'usage:refresh',message:{message_id:55,chat:{id:OWNER}}}});
  assert.equal(state.data.usagePanelSendPending,false);
  assert.equal(state.data.usagePanelMessageId,55);
  assert.equal(telegram.sent.length,0);
  assert.deepEqual(telegram.pins,[55]);
  assert.equal(telegram.edits[0].messageId,55);
});

// ---------------------------------------------------------------- reply context (2026-10-09)

test("a Telegram Reply reaches the seat with a 답장 대상 line, alone and in a queued batch", async () => {
  const { telegram, paseo, state, bridge, send } = setup();
  await send({ text: "상태?" });
  const seat = { id: state.data.orchestratorId as string, title: "텔레그램 오케" };
  await bridge.onTurnEnded(seat, { kind: "completed" }, reply("추천: A안(지금 보내기). B안은 내일 아침 예약이에요."));
  const out = telegram.last();
  await send({ text: "너 추천대로 ㄱㄱ 하자", reply_to_message: { message_id: out.id, from: { id: 1, is_bot: true }, date: Math.floor(clock / 1000), text: htmlToPlainForTest(out.text) } });
  assert.match(contentOnly(paseo.sent.at(-1)?.text), /^\[텔레그램\] ↩ 답장 대상 \(오케 \d\d:\d\d\): "추천: A안\(지금 보내기\)\. B안은 내일 아침 예약이에요\."\n너 추천대로 ㄱㄱ 하자$/);

  // Busy seat: the line travels inside the batch.
  const busy = await busySeat();
  await busy.send({ text: "B로", reply_to_message: { message_id: 777, from: { id: OWNER, is_bot: false }, date: Math.floor(clock / 1000), text: "A안 B안" }, quote: { text: "B안" } });
  await busy.send({ text: "그리고 오늘 안에" });
  await busy.finishSeat("보고서 끝");
  assert.match(busy.paseo.sent.at(-1)?.text ?? "", /메시지 2개, 순서대로:\n\[\d\d:\d\d Mina\] ↩ 답장 대상 \(내 메시지 \d\d:\d\d\) 중 인용: "B안"\nB로\n\[\d\d:\d\d Mina\] 그리고 오늘 안에$/);
});

test("a reply to a session message still goes to that session, with the same context line; a correction still interrupts", async () => {
  const { telegram, paseo, send } = setup();
  const worker = paseo.add(agent("244d361a-dddd", "채용 공고"));
  await send({ text: "/ls" });
  await send({ text: "/peek 1" });
  const peek = telegram.last();
  await send({ text: "이걸로", reply_to_message: { message_id: peek.id, from: { id: 1, is_bot: true }, date: Math.floor(clock / 1000), text: "마감일 10/20로 할까요?" } });
  assert.equal(paseo.sent.at(-1)?.id, worker.id);
  assert.match(contentOnly(paseo.sent.at(-1)?.text), /^↩ 답장 대상 \(세션 채용 공고 \d\d:\d\d\): "마감일 10\/20로 할까요\?"\n이걸로$/);

  const busy = await busySeat();
  await busy.send({ text: "취소, 영어로", reply_to_message: { message_id: 1, from: { id: OWNER, is_bot: false }, date: Math.floor(clock / 1000), text: "보고서 초안 써줘" } });
  const redo = contentOnly(busy.paseo.sent.at(-1)?.text);
  assert.match(redo, /^\[텔레그램 · 수정 지시로 이전 턴 중단\]/, "the context line does not hide the correction keyword");
  assert.match(redo, /Mina\] ↩ 답장 대상 \(내 메시지 \d\d:\d\d\): "보고서 초안 써줘"\n취소, 영어로$/);
});

function htmlToPlainForTest(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

test("a reply to a message from a retired seat goes to the current seat, not the archived one", async () => {
  const { paseo, state, send } = setup();
  state.data.retiredSeats = ["0ld5eat0-0000-4000-8000-000000000001"];
  state.rememberMessage(500, "0ld5eat0-0000-4000-8000-000000000001");
  await send({ text: "너 추천대로 ㄱㄱ", reply_to_message: { message_id: 500, from: { id: 1, is_bot: true }, date: Math.floor(clock / 1000), text: "B안 추천" } });
  assert.equal(paseo.created.length, 1, "the current seat (new here) gets it");
  assert.match(contentOnly(paseo.created[0].prompt), /^\[텔레그램\] ↩ 답장 대상 \(오케 \d\d:\d\d\): "B안 추천"\n너 추천대로 ㄱㄱ$/);
  assert.ok(!paseo.sent.some((message) => message.id.startsWith("0ld5eat0")));
});


test("current worker routing reaches both new and existing orchestrator seats without changing seat identity", async () => {
  const { paseo, bridge, state, send } = setup();
  await send({ text: "코딩 작업" });
  const id = state.data.orchestratorId as string;
  assert.ok(paseo.created[0].systemPrompt.includes(WORKER_ROUTING));
  assert.ok(paseo.created[0].prompt.startsWith(WORKER_ROUTING));
  await bridge.onTurnEnded({ id, title: null }, { kind: "completed" }, reply("완료"));
  await send({ text: "디자인 작업" });
  assert.equal(paseo.created.length, 1);
  assert.equal(paseo.sent.at(-1)?.id, id);
  assert.ok(paseo.sent.at(-1)?.text.startsWith(WORKER_ROUTING));
  assert.ok(paseo.sent.at(-1)?.text.startsWith(BATCH_RULES));
  assert.equal(contentOnly(paseo.sent.at(-1)?.text), "[텔레그램] 디자인 작업");
});
