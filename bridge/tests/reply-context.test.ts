import assert from "node:assert/strict";
import { test } from "node:test";
import { replyContextLine } from "../server/reply-context.ts";
import type { TgMessage } from "../server/telegram.ts";

// Shapes recorded from Telegram Bot API updates (ids and names changed).
const AT = Date.parse("2026-10-09T22:12:00Z") / 1000; // 15:12 PT
const bot = { id: 8000000001, is_bot: true, first_name: "Orchestrator", username: "my_orchestrator_bot" };
const owner = { id: 7000000001, is_bot: false, first_name: "Mina" };
const base = { message_id: 900, chat: { id: owner.id, type: "private" }, from: owner, date: AT + 60, text: "너 추천대로 ㄱㄱ 하자" };

test("a reply quotes the replied message as one line, cut at 300 chars", () => {
  const long = `추천: A안으로 가요.\n\n- 이유 하나\n- 이유 둘\n${"가".repeat(400)}`;
  const line = replyContextLine({ ...base, reply_to_message: { message_id: 812, from: bot, date: AT, text: long } } as TgMessage, "오케");
  assert.match(line ?? "", /^↩ 답장 대상 \(오케 15:12\): "추천: A안으로 가요\. - 이유 하나 - 이유 둘 가+…"$/);
  assert.ok(!(line ?? "").includes("\n"));
  assert.ok((line ?? "").length < 340);
});

test("Telegram's quote selection wins over the whole message", () => {
  const message = {
    ...base,
    reply_to_message: { message_id: 812, from: bot, date: AT, text: "A안: 지금 보내기\nB안: 내일 아침 예약" },
    quote: { text: "B안: 내일 아침 예약", position: 11, is_manual: true },
  } as TgMessage;
  assert.equal(replyContextLine(message, "오케"), '↩ 답장 대상 (오케 15:12) 중 인용: "B안: 내일 아침 예약"');
});

test("photos with captions, files, voice, forwarded and other-chat messages are named", () => {
  const photo = { ...base, reply_to_message: { message_id: 5, from: bot, date: AT, photo: [{ file_id: "x", width: 1, height: 1 }], caption: "썸네일 2안" } } as TgMessage;
  assert.equal(replyContextLine(photo, "세션 썸네일"), '↩ 답장 대상 (세션 썸네일 15:12): "[사진] 썸네일 2안"');
  const file = { ...base, reply_to_message: { message_id: 6, from: bot, date: AT, document: { file_id: "y", file_name: "brief.pdf" } } } as TgMessage;
  assert.equal(replyContextLine(file, "오케"), '↩ 답장 대상 (오케 15:12): "[파일 brief.pdf]"');
  const forwarded = {
    ...base,
    reply_to_message: { message_id: 7, from: owner, date: AT + 30, text: "견적 보내 주세요", forward_origin: { type: "user", date: AT, sender_user: { id: 1, first_name: "TJ" } } },
  } as TgMessage;
  assert.equal(replyContextLine(forwarded, "내 메시지"), '↩ 답장 대상 (전달된 메시지 · TJ 15:12): "견적 보내 주세요"');
  const external = { ...base, external_reply: { origin: { type: "channel", date: AT, chat: { title: "Studio news" } } }, quote: { text: "launch Friday" } } as TgMessage;
  assert.equal(replyContextLine(external, null), '↩ 답장 대상 (다른 대화 · Studio news 15:12) 중 인용: "launch Friday"');
});

test("not a reply, or nothing to quote → no line", () => {
  assert.equal(replyContextLine(base as TgMessage, "오케"), null);
  assert.equal(replyContextLine({ ...base, reply_to_message: { message_id: 3 } } as TgMessage, "오케"), null);
});
