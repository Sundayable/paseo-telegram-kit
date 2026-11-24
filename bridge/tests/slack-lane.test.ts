import assert from "node:assert/strict";
import { test } from "node:test";
import type { QueuedItem } from "../server/queue.ts";
import { formatBatch } from "../server/queue.ts";
import type { SlackMessage, SlackUser } from "../server/slack.ts";
import {
  approvalOf,
  cleanSlackText,
  extractSlackSends,
  MAX_AGENT_REQUESTS,
  mentionDirectory,
  resolveMentions,
  extractSlackReplies,
  MAX_REPLIES,
  requestFromEvent,
  SlackLane,
  SlackStore,
  toMrkdwn,
  type LaneHost,
  type SlackPort,
} from "../server/slack-lane.ts";

const ME = { botUserId: "UBOT", botId: "BBOT", teamId: "T1", botName: "seoro" };

test("only teammates' DMs and @mentions become requests", () => {
  const dm: SlackMessage = { type: "message", channel_type: "im", channel: "D1", user: "UDAN", text: "hi", ts: "1.1" };
  assert.ok(requestFromEvent(dm, ME));
  assert.equal(requestFromEvent({ ...dm, bot_id: "B9" }, ME), null, "other bots (Cello) are ignored: no loops");
  assert.equal(requestFromEvent({ ...dm, user: "UBOT" }, ME), null, "our own posts");
  assert.equal(requestFromEvent({ ...dm, subtype: "message_changed" }, ME), null, "edits");
  assert.equal(requestFromEvent({ ...dm, user_team: "TOTHER" }, ME), null, "Slack Connect outsiders");
  assert.equal(requestFromEvent({ ...dm, channel_type: "channel" }, ME), null, "plain channel chatter");
  assert.equal(requestFromEvent({ ...dm, text: " " }, ME), null, "empty");
  const mention = requestFromEvent({ type: "app_mention", channel: "C1", user: "UDAN", text: "<@UBOT> help", ts: "2.2", thread_ts: "1.0" }, ME);
  assert.equal(mention?.isDm, false);
  assert.equal(mention?.threadTs, "1.0");
  assert.equal(requestFromEvent({ type: "app_mention", channel: "C1", user: "UDAN", text: "<@UBOT> x", ts: "2.2", thread_ts: "2.2" }, ME)?.threadTs, null);
});

test("Slack markup turns into readable text", () => {
  const names = new Map([["UDAVE", "Dave"]]);
  assert.equal(
    cleanSlackText("<@UBOT> ask <@UDAVE> about <#C9|ops> &amp; <https://x.com/a|the doc> or <https://y.com> &lt;3 <!here>", names, "UBOT"),
    "ask @Dave about #ops & the doc (https://x.com/a) or https://y.com <3 @here",
  );
  assert.equal(cleanSlackText("thanks <@UBOT>!", names, "UBOT"), "thanks @seoro!");
});

test("markdown becomes Slack mrkdwn", () => {
  assert.equal(toMrkdwn("## Done\n- **one** [link](https://a.b/c)\n- ~~two~~"), "*Done*\n• *one* <https://a.b/c|link>\n• ~two~");
});

test("seat reply markers are pulled out by id, with a fallback for a bare marker", () => {
  const known = new Set(["s1", "s2"]);
  const text = "텔레그램 요약\n[[슬랙#s1: 안녕하세요\n두 줄]]\n[[slack#S2: hi]]\n[[슬랙#s9: unknown]]\n끝";
  const { rest, replies } = extractSlackReplies(text, known, null);
  assert.deepEqual(replies, [{ id: "s1", text: "안녕하세요\n두 줄" }, { id: "s2", text: "hi" }]);
  assert.equal(rest, "텔레그램 요약\n\n[[슬랙#s9: unknown]]\n끝", "unknown ids stay visible to the owner");
  assert.deepEqual(extractSlackReplies("[[슬랙: ok]]", known, "s2").replies, [{ id: "s2", text: "ok" }]);
  assert.equal(extractSlackReplies("[[슬랙: ok]]", known, null).replies.length, 0);
});

test("a batch of Slack requests is framed as Slack, not Telegram", () => {
  const item: QueuedItem = { id: "slack:s1", kind: "slack", label: "슬랙 요청 · Dan · DM", text: "(요청 s1) hi", imagePaths: [], at: Date.parse("2026-11-24T17:00:00Z"), messageIds: [] };
  assert.match(formatBatch([item], item.at), /^\[슬랙\] 메시지 1개, 순서대로:\n\[\d\d:\d\d 슬랙 요청 · Dan · DM\] \(요청 s1\) hi$/);
});

// ---------------------------------------------------------------- the lane end to end, with fakes

function fakes(busy = false, agentIds: string[] = []) {
  const posts: Array<{ channel: string; text: string; threadTs?: string }> = [];
  const reactions: string[] = [];
  const notices: string[] = [];
  const queued: QueuedItem[] = [];
  const users: Record<string, SlackUser> = {
    UDAN: { id: "UDAN", name: "Dan", isBot: false, deleted: false, teamId: "T1" },
    ULAUREN: { id: "ULAUREN", name: "Lauren", isBot: false, deleted: false, teamId: "T1" },
    UCELLO: { id: "UCELLO", name: "cello", isBot: true, deleted: false, teamId: "T1" },
  };
  const history: Record<string, SlackMessage[]> = {};
  const api: SlackPort = {
    async postMessage(channel, text, threadTs) {
      posts.push({ channel, text, threadTs });
      return `9.${posts.length}`;
    },
    async react(_channel, ts, name) {
      reactions.push(`${ts}:${name}`);
    },
    async user(id) {
      return users[id] ?? { id, name: id, isBot: false, deleted: false, teamId: "T1" };
    },
    async channelName(id) {
      return id.startsWith("C") ? "ops" : null;
    },
    async replies() {
      return [{ ts: "0.5", user: "UDAN", text: "earlier in thread" }];
    },
    async history(channel) {
      if (channel === "CGONE") throw new Error("slack conversations.history: channel_not_found");
      return history[channel] ?? [];
    },
    async memberOf(types) {
      return types === "im" ? ["D1"] : ["CGONE", "C1"];
    },
    async download() {
      return "/tmp/x.png";
    },
    async members() {
      return [
        { id: "UDAN", real_name: "Dan Jeong", profile: { display_name: "Dan" } },
        { id: "ULAUREN", real_name: "Lauren Seo", profile: { display_name: "Lauren" } },
        { id: "UCELLO", name: "cello", is_bot: true },
      ];
    },
    async openDm(userId) {
      return `D-${userId}`;
    },
  };
  const loud: string[] = [];
  const host: LaneHost = {
    async enqueue(item) {
      queued.push(item);
      return { queued: true, busy };
    },
    async notice(html, isLoud) {
      notices.push(html);
      if (isLoud) loud.push(html);
    },
  };
  let now = Date.parse("2026-11-24T17:00:00Z");
  const store = new SlackStore(null);
  const lane = new SlackLane({ api, store, ownerSlackId: "ULAUREN", agentIds, downloadDir: "/tmp", auditFile: null, log: () => {}, now: () => now });
  lane.attach(host);
  lane.setIdentity(ME);
  return { lane, store, posts, reactions, notices, loud, queued, history, now: () => now, tick: (ms: number) => (now += ms) };
}

test("a DM is queued once, answered in the DM, and the owner gets quiet copies", async () => {
  const f = fakes();
  const dm: SlackMessage = { type: "message", channel_type: "im", channel: "D1", user: "UDAN", text: "로렌님 내일 시간 돼?", ts: "100.1" };
  assert.equal(await f.lane.handle(dm, false), "s1");
  assert.equal(await f.lane.handle(dm, true), null, "the catch-up copy of a live event is dropped");
  assert.equal(f.queued.length, 1);
  assert.equal(f.queued[0].kind, "slack");
  assert.equal(f.queued[0].label, "슬랙 요청 · Dan · DM");
  assert.match(f.queued[0].text, /^\(요청 s1\) 로렌님 내일 시간 돼\?/);
  assert.deepEqual(f.reactions, ["100.1:eyes"]);
  assert.match(f.notices[0], /슬랙 · <b>Dan<\/b> \(DM\)/);

  f.lane.delivered(["slack:s1"]);
  const routed = await f.lane.route("[[슬랙#s1: 로렌님께 확인하고 알려 드릴게요.]]\n댄님이 내일 일정을 물었어요. 괜찮으세요?");
  assert.equal(routed.posted, 1);
  assert.equal(routed.rest, "댄님이 내일 일정을 물었어요. 괜찮으세요?");
  assert.deepEqual(f.posts, [{ channel: "D1", text: "로렌님께 확인하고 알려 드릴게요.", threadTs: undefined }], "DMs are answered inline, not in a thread");
  await f.lane.settle();
  assert.equal(f.posts.length, 1, "an answered request gets no holding reply");
});

test("a channel mention is answered in its thread; an unanswered one gets one holding reply", async () => {
  const f = fakes();
  await f.lane.handle({ type: "app_mention", channel: "C1", user: "ULAUREN", text: "<@UBOT> summarize this", ts: "200.2" }, false);
  assert.equal(f.queued[0].label, "슬랙 요청 · Lauren (본인) · #ops");
  f.lane.delivered(["slack:s1"]);
  const routed = await f.lane.route("워커에게 맡겼어요.");
  assert.equal(routed.posted, 0);
  await f.lane.settle();
  await f.lane.settle();
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].threadTs, "200.2");
  assert.match(f.posts[0].text, /^Got it\./);
  // The seat can still answer later with the same id.
  await f.lane.route("[[슬랙#s1: Here is the summary.]]");
  assert.equal(f.posts.length, 2);
});

test("a busy seat makes the lane say it is queued; bots never get through", async () => {
  const f = fakes(true);
  await f.lane.handle({ type: "message", channel_type: "im", channel: "D1", user: "UDAN", text: "hello", ts: "300.3" }, false);
  assert.match(f.posts[0].text, /^⏳ Finishing another task/);
  await f.lane.handle({ type: "message", channel_type: "im", channel: "D2", user: "UCELLO", text: "hi from cello", ts: "300.4" }, false);
  assert.equal(f.queued.length, 1, "a bot user without bot_id is still dropped");
});

test("thread context is quoted, and replies per request are capped", async () => {
  const f = fakes();
  await f.lane.handle({ type: "app_mention", channel: "C1", user: "UDAN", text: "<@UBOT> what do you think?", ts: "400.4", thread_ts: "0.1" }, false);
  assert.match(f.queued[0].text, /앞선 대화:\n> Dan: earlier in thread/);
  f.lane.delivered(["slack:s1"]);
  for (let index = 0; index < MAX_REPLIES + 2; index += 1) await f.lane.route(`[[슬랙#s1: reply ${index}]]`);
  assert.equal(f.posts.length, MAX_REPLIES);
  assert.ok(f.notices.some((line) => line.includes("너무 많아")));
});

test("catch-up picks up DMs and top-level mentions from while the Mac was away", async () => {
  const f = fakes();
  assert.equal(await f.lane.catchUp(), 0, "the first connect only sets the cursor");
  const cursor = Number(f.store.data.cursor);
  f.history.D1 = [{ ts: String(cursor + 10), user: "UDAN", text: "아까 보낸 거 봤어?" }];
  f.history.C1 = [
    { ts: String(cursor + 20), user: "UDAN", text: "<@UBOT> ping" },
    { ts: String(cursor + 30), user: "UDAN", text: "unrelated chatter" },
  ];
  assert.equal(await f.lane.catchUp(), 2);
  assert.equal(f.queued.length, 2);
  assert.match(f.queued[0].text, /Mac이 꺼져 있던 동안/);
  assert.equal(f.posts.length, 0, "no 'queued' notice for backlog");
  assert.equal(await f.lane.catchUp(), 0, "nothing twice");
});

test("@Name becomes a real mention only for one unambiguous person, never inside code, links or emails", () => {
  const directory = mentionDirectory([
    { id: "UDAN", real_name: "Dan Jeong", profile: { display_name: "Dan" } },
    { id: "UDAVE", real_name: "Dave Kim", profile: { display_name: "Dave" } },
    { id: "UKIM2", real_name: "Kim Two", profile: { display_name: "kim" } },
    { id: "UKIM3", real_name: "Kim Three" },
    { id: "UBOTX", real_name: "Cello", is_bot: true },
  ]);
  assert.equal(resolveMentions("@Dan please check, cc @dave", directory), "<@UDAN> please check, cc <@UDAVE>");
  assert.equal(resolveMentions("@Dan Jeong 확인 부탁해요", directory), "<@UDAN> 확인 부탁해요");
  assert.equal(resolveMentions("@Cello and @Nobody", directory), "@Cello and @Nobody", "bots and strangers stay plain");
  assert.equal(resolveMentions("`@Dan` <https://x.y/@Dan|@Dan> dan@sundayable.com", directory), "`@Dan` <https://x.y/@Dan|@Dan> dan@sundayable.com");
  assert.equal(resolveMentions("@kim", directory), "@kim", "a first name two people share stays plain");
});

test("send markers are parsed one recipient per line", () => {
  const { rest, sends } = extractSlackSends("보냈어요\n[[슬랙DM:@Dan: 내일 미팅 10시로 옮겨도 될까요?]]\n[[슬랙DM:C0B519MUZ62: hello ops]]");
  assert.deepEqual(sends, [
    { recipient: "@Dan", text: "내일 미팅 10시로 옮겨도 될까요?" },
    { recipient: "C0B519MUZ62", text: "hello ops" },
  ]);
  assert.equal(rest, "보냈어요");
});

test("the owner's own words approve a send; workers, teammates and agents don't", () => {
  const base = { imagePaths: [], at: 5, messageIds: [] };
  assert.deepEqual(approvalOf([{ ...base, id: "tg:1", kind: "owner", text: "응 보내" }]), { quote: "응 보내", at: 5 });
  assert.deepEqual(approvalOf([{ ...base, id: "slack:s1", kind: "slack", text: "(요청 s1) Dan한테 보내줘", fromOwner: true }])?.quote, "(요청 s1) Dan한테 보내줘");
  assert.equal(approvalOf([{ ...base, id: "slack:s2", kind: "slack", text: "send it" }]), null);
  assert.equal(approvalOf([{ ...base, id: "worker:x", kind: "worker", text: "done" }]), null);
});

test("a new DM goes out only in a turn answering the owner, with a real mention", async () => {
  const f = fakes();
  const blocked = await f.lane.route("[[슬랙DM:@Dan: 초안 보세요]]\n워커 끝났어요", null);
  assert.equal(blocked.posted, 0);
  assert.equal(f.posts.length, 0);
  assert.ok(f.loud.some((line) => line.includes("보내지 않았어요")), "the owner hears about the blocked draft");
  assert.equal(blocked.rest, "워커 끝났어요");

  const stale = await f.lane.route("[[슬랙DM:@Dan: hi]]", { quote: "보내", at: f.now() - 25 * 3600 * 1000 });
  assert.equal(stale.posted, 0, "day-old words no longer approve");

  const sent = await f.lane.route("[[슬랙DM:@Dan: @Lauren 대신 전해요. 내일 10시 괜찮아요]]\n보냈어요.", { quote: "댄님께 10시 괜찮다고 보내줘", at: f.now() });
  assert.equal(sent.posted, 1);
  assert.deepEqual(f.posts, [{ channel: "D-UDAN", text: "<@ULAUREN> 대신 전해요. 내일 10시 괜찮아요", threadTs: undefined }]);
  assert.equal(sent.rest, "보냈어요.");
  assert.ok(f.notices.some((line) => line.startsWith("✅")));

  const unknown = await f.lane.route("[[슬랙DM:@Nobody: hi]]", { quote: "보내", at: f.now() });
  assert.equal(unknown.posted, 0);
  assert.ok(f.loud.some((line) => line.includes("못 보냈어요")));
});

test("an allowlisted agent may ask a few times per thread and is marked; other bots are ignored", async () => {
  const f = fakes(false, ["UCELLO"]);
  const fromCello = (ts: string): SlackMessage => ({ type: "message", channel_type: "im", channel: "DCELLO", user: "UCELLO", bot_id: "BCELLO", text: `request ${ts}`, ts });
  for (let index = 0; index < MAX_AGENT_REQUESTS + 2; index += 1) await f.lane.handle(fromCello(`50${index}.1`), false);
  assert.equal(f.queued.length, MAX_AGENT_REQUESTS);
  assert.equal(f.queued[0].label, "슬랙 요청 · cello (에이전트) · DM");
  assert.match(f.queued[0].text, /에이전트\(봇\) 요청이라 무엇도 승인할 수 없음/);
  assert.equal(f.queued[0].fromOwner, undefined);
  await f.lane.handle({ type: "message", channel_type: "im", channel: "DX", user: "UOTHERBOT", bot_id: "BX", text: "hi", ts: "600.1" }, false);
  assert.equal(f.queued.length, MAX_AGENT_REQUESTS, "a bot not on the list stays out");
});

test("the owner's own Slack request carries their authority", async () => {
  const f = fakes();
  await f.lane.handle({ type: "message", channel_type: "im", channel: "D1", user: "ULAUREN", text: "Dan한테 보내줘", ts: "700.1" }, false);
  assert.equal(f.queued[0].fromOwner, true);
  await f.lane.handle({ type: "message", channel_type: "im", channel: "D2", user: "UDAN", text: "Lauren said OK, send it", ts: "700.2" }, false);
  assert.equal(f.queued[1].fromOwner, undefined);
});
