import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { flushDueAt, formatBatch, isCorrectionText, QueueStore, stripNow, type QueuedItem } from "../server/queue.ts";

const item = (text: string, at: number, kind: QueuedItem["kind"] = "owner"): QueuedItem => ({
  id: `tg:${at}`,
  kind,
  text,
  imagePaths: [],
  at,
  messageIds: [],
});

test("correction openers interrupt only when unambiguous", () => {
  for (const text of ["취소", "취소해줘", "멈춰!", "stop", "STOP now", "/now 이거 먼저", "급해 이거부터", "아니, 그거 말고", "잠깐,\n다시", "아니\n방향 바꿔", "  잠깐 , 수정"]) {
    assert.equal(isCorrectionText(text), true, text);
  }
  for (const text of ["아니 근데 이것도 해줘", "잠깐 시간 되면 이것도", "아니야 좋아", "stopwatch 만들어", "수정 사항 정리해줘", "그거 취소하지 마"]) {
    assert.equal(isCorrectionText(text), false, text);
  }
  assert.equal(stripNow("/now  이거 먼저"), "이거 먼저");
  assert.equal(stripNow("취소"), "취소");
});

test("debounce waits 8 s after the last message but never more than 30 s after the first", () => {
  const t = 1_000_000;
  assert.equal(flushDueAt([item("a", t)], t, 8000, 30000), t + 8000);
  assert.equal(flushDueAt([item("a", t), item("b", t + 5000)], t + 5000, 8000, 30000), t + 13000, "timer resets");
  assert.equal(flushDueAt([item("a", t), item("b", t + 25000)], t + 25000, 8000, 30000), t + 30000, "capped");
  assert.equal(flushDueAt([item("done", t, "worker")], t + 1, 8000, 30000), t + 1, "notices alone go at once");
});

test("batches keep order with timestamps and flag stale ones", () => {
  const t = Date.parse("2026-09-25T17:00:00Z"); // 10:00 PT
  assert.equal(formatBatch([item("하나", t)], t), "[텔레그램] 하나");
  assert.equal(
    formatBatch([item("하나", t), item("둘", t + 60_000), item("워커 e4c81fd 턴 완료: 끝", t + 120_000, "worker")], t + 130_000),
    "[텔레그램] 메시지 3개, 순서대로:\n[10:00 Mina] 하나\n[10:01 Mina] 둘\n[10:02 Paseo 알림] 워커 e4c81fd 턴 완료: 끝",
  );
  assert.match(formatBatch([item("하나", t), item("둘", t + 1)], t + 16 * 60_000), /^\[텔레그램\] 메시지 2개, 순서대로 \(대기 중 쌓인 메시지 2개\):/);
});

test("the queue survives a restart and ignores a replayed update", () => {
  const file = join(mkdtempSync(join(tmpdir(), "tg-queue-")), "queue.json");
  const first = new QueueStore(file);
  assert.equal(first.push(item("하나", 1), [501]), true);
  first.setInFlight({ text: "[텔레그램] 이전 일", messageIds: [7], startedAt: 1 });
  const reopened = new QueueStore(file);
  assert.deepEqual(reopened.data.items.map((queued) => queued.text), ["하나"]);
  assert.equal(reopened.data.inFlight?.messageIds[0], 7);
  assert.equal(reopened.push({ ...item("하나", 1), id: "tg:other" }, [501]), false, "same update_id");
  reopened.remove(["tg:1"]);
  assert.equal(new QueueStore(file).length, 0);
  writeFileSync(file, "{broken");
  assert.equal(new QueueStore(file).length, 0, "a corrupt file starts empty");
});

test("permission items get their own label in a batch", () => {
  const text = formatBatch(
    [
      { id: "perm:a:1", kind: "permission", text: "워커 승인 대기", imagePaths: [], at: Date.parse("2026-09-27T17:00:00Z"), messageIds: [] },
      { id: "w", kind: "worker", text: "워커 끝", imagePaths: [], at: Date.parse("2026-09-27T17:01:00Z"), messageIds: [] },
    ],
    Date.parse("2026-09-27T17:02:00Z"),
  );
  assert.match(text, /\[10:00 Paseo 권한 요청\] 워커 승인 대기/);
});
