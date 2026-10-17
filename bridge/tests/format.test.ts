import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chunkMarkdown,
  extractFileMarkers,
  htmlToPlain,
  markdownToTelegramHtml,
  renderMessages,
  TELEGRAM_LIMIT,
} from "../server/format.ts";

test("inline markdown becomes Telegram HTML and raw brackets are escaped", () => {
  const html = markdownToTelegramHtml("**결론:** `a<b>` 는 [링크](https://x.com/a?b=1&c=2) & <tag> ~~old~~");
  assert.equal(
    html,
    '<b>결론:</b> <code>a&lt;b&gt;</code> 는 <a href="https://x.com/a?b=1&amp;c=2">링크</a> &amp; &lt;tag&gt; <s>old</s>',
  );
});

test("headings, bullets, quotes and rules", () => {
  const html = markdownToTelegramHtml("## 요약\n- 하나\n  * 둘\n> 인용\n---\n1. 번호");
  assert.equal(html, "<b>요약</b>\n• 하나\n  • 둘\n<blockquote>인용</blockquote>\n──────\n1. 번호");
});

test("bold line starting with ** is not a bullet", () => {
  assert.equal(markdownToTelegramHtml("**중요** 내용"), "<b>중요</b> 내용");
});

test("fenced code keeps its content verbatim and escaped", () => {
  const html = markdownToTelegramHtml("```ts\nconst a = 1 < 2 && **b**;\n```");
  assert.equal(html, '<pre><code class="language-ts">const a = 1 &lt; 2 &amp;&amp; **b**;</code></pre>');
});

test("tables become a bold header and one bullet per row", () => {
  const html = markdownToTelegramHtml("| 이름 | 상태 |\n|---|:--:|\n| 예약 | **정상** |\n| HQ | 오류 |");
  assert.equal(html, "<b>이름 · 상태</b>\n• 예약 · <b>정상</b>\n• HQ · 오류");
});

test("chunking never splits inside a code fence and keeps chunks within budget", () => {
  const paragraph = "가".repeat(900);
  const code = "```\n" + Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n") + "\n```";
  const chunks = chunkMarkdown([paragraph, paragraph, code, paragraph].join("\n\n"), 3500);
  assert.ok(chunks.length > 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 3500, `chunk of ${chunk.length}`);
    const fences = chunk.split("\n").filter((line) => line.trim().startsWith("```")).length;
    assert.equal(fences % 2, 0, "every chunk has balanced fences");
  }
});

test("rendered messages fit Telegram's limit even when escaping expands text", () => {
  const nasty = Array.from({ length: 400 }, () => "<&> ".repeat(8)).join("\n");
  const messages = renderMessages(nasty, { html: "<b>헤더</b>\n\n", plain: "헤더\n\n" });
  assert.ok(messages.length > 1);
  for (const message of messages) assert.ok(message.html.length <= TELEGRAM_LIMIT);
  assert.ok(messages[0].html.startsWith("<b>헤더</b>"));
  assert.ok(!messages[1].html.startsWith("<b>헤더</b>"));
});

test("file markers are pulled out of the reply", () => {
  const { text, files } = extractFileMarkers("스크린샷 첨부해요.\n\n[[telegram-file: /Users/mina/shot.png]]\n\n끝.");
  assert.deepEqual(files, ["/Users/mina/shot.png"]);
  assert.equal(text, "스크린샷 첨부해요.\n\n끝.");
});

test("htmlToPlain strips tags and unescapes entities", () => {
  assert.equal(htmlToPlain('<b>a &lt; b</b> &amp; <a href="x">c</a>'), "a < b & c");
});
