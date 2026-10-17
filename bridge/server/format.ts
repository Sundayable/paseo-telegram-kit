// Agent replies are Markdown. Telegram renders a small HTML subset, rejects the
// whole message on any malformed tag, and caps a message at 4096 characters.
import { t } from "./i18n.ts";

export const TELEGRAM_LIMIT = 4096;
const CHUNK_BUDGET = 3500;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function inlineToHtml(text: string): string {
  // Code spans first, so nothing inside them is formatted.
  return text
    .split(/(`[^`\n]+`)/g)
    .map((part, index) => {
      if (index % 2 === 1) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      return escapeHtml(part)
        .replace(
          /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
          (_match, label: string, url: string) => `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`,
        )
        .replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>")
        .replace(/~~([^~\n]+?)~~/g, "<s>$1</s>");
    })
    .join("");
}

const FENCE = /^\s*```\s*([\w+#.-]*)\s*$/;
const FENCE_END = /^\s*```\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|[\s:|-]+\|\s*$/;

function tableCells(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

// Tables are unreadable on a phone as a grid; render the header in bold and each
// row as one bullet line.
function tableToHtml(rows: string[]): string {
  const [header, ...body] = rows.map(tableCells);
  const lines = [`<b>${header.map(inlineToHtml).join(" · ")}</b>`];
  for (const cells of body) lines.push(`• ${cells.map(inlineToHtml).join(" · ")}`);
  return lines.join("\n");
}

export function markdownToTelegramHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(FENCE);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_END.test(lines[i])) body.push(lines[i++]);
      i += 1;
      const code = escapeHtml(body.join("\n"));
      out.push(fence[1] ? `<pre><code class="language-${fence[1]}">${code}</code></pre>` : `<pre>${code}</pre>`);
      continue;
    }

    if (TABLE_ROW.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i])) {
        if (!TABLE_RULE.test(lines[i])) rows.push(lines[i]);
        i += 1;
      }
      if (rows.length) out.push(tableToHtml(rows));
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${quoted.map(inlineToHtml).join("\n")}</blockquote>`);
      continue;
    }

    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (heading) out.push(`<b>${inlineToHtml(heading[1])}</b>`);
    else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) out.push("──────");
    else if (bullet) out.push(`${bullet[1]}• ${inlineToHtml(bullet[2])}`);
    else out.push(inlineToHtml(line));
    i += 1;
  }
  return out.join("\n");
}

/** Paragraph blocks; a fenced code block is one block even if it contains blank lines. */
function splitBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (inFence) {
      current.push(line);
      if (FENCE_END.test(line)) inFence = false;
      continue;
    }
    if (FENCE.test(line)) {
      inFence = true;
      current.push(line);
      continue;
    }
    if (!line.trim()) {
      if (current.length) blocks.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks;
}

function splitLines(text: string, budget: number): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    for (let start = 0; start < Math.max(line.length, 1); start += budget) {
      const slice = line.slice(start, start + budget);
      if (current && current.length + 1 + slice.length > budget) {
        pieces.push(current);
        current = slice;
      } else {
        current = current ? `${current}\n${slice}` : slice;
      }
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

function splitOversized(block: string, budget: number): string[] {
  const lines = block.split("\n");
  const fence = lines[0].match(FENCE);
  if (fence && lines.length > 1) {
    const open = lines[0].trim();
    const body = lines.slice(1, FENCE_END.test(lines[lines.length - 1]) ? -1 : undefined).join("\n");
    return splitLines(body, budget - open.length - 8).map((part) => `${open}\n${part}\n\`\`\``);
  }
  return splitLines(block, budget);
}

export function chunkMarkdown(markdown: string, budget = CHUNK_BUDGET): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const block of splitBlocks(markdown)) {
    for (const piece of block.length > budget ? splitOversized(block, budget) : [block]) {
      if (current && current.length + 2 + piece.length > budget) {
        chunks.push(current);
        current = piece;
      } else {
        current = current ? `${current}\n\n${piece}` : piece;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export interface RenderedChunk {
  html: string;
  /** Plain-text fallback for when Telegram rejects the HTML. */
  plain: string;
}

function fit(markdown: string, prefixHtml: string, prefixPlain: string): RenderedChunk[] {
  const html = prefixHtml + markdownToTelegramHtml(markdown);
  if (html.length <= TELEGRAM_LIMIT) return [{ html, plain: prefixPlain + markdown }];
  const lines = markdown.split("\n");
  if (lines.length < 2) {
    // One enormous line: give up on formatting and hard-split escaped text.
    return splitLines(markdown, Math.floor((TELEGRAM_LIMIT - prefixHtml.length) / 5)).map((part, index) => ({
      html: (index === 0 ? prefixHtml : "") + escapeHtml(part),
      plain: (index === 0 ? prefixPlain : "") + part,
    }));
  }
  const middle = Math.ceil(lines.length / 2);
  return [
    ...fit(lines.slice(0, middle).join("\n"), prefixHtml, prefixPlain),
    ...fit(lines.slice(middle).join("\n"), "", ""),
  ];
}

/** Telegram-ready messages, each within the limit; the header goes on the first one. */
export function renderMessages(markdown: string, header?: { html: string; plain: string }): RenderedChunk[] {
  const chunks = chunkMarkdown(markdown.trim() || " ");
  return chunks.flatMap((chunk, index) =>
    fit(chunk, index === 0 && header ? header.html : "", index === 0 && header ? header.plain : ""),
  );
}

const FILE_MARKER = /^[ \t]*\[\[telegram-file:\s*(.+?)\s*\]\][ \t]*$/gm;

/** Pulls `[[telegram-file: /abs/path]]` lines out of a reply. */
export function extractFileMarkers(text: string): { text: string; files: string[] } {
  const files: string[] = [];
  const stripped = text.replace(FILE_MARKER, (_match, path: string) => {
    files.push(path);
    return "";
  });
  return { text: stripped.replace(/\n{3,}/g, "\n\n").trim(), files };
}

export function shortId(id: string): string {
  return id.slice(0, 7);
}

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return t("방금", "just now");
  if (minutes < 60) return t(`${minutes}분 전`, `${minutes} min ago`);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t(`${hours}시간 전`, `${hours} h ago`);
  return t(`${Math.floor(hours / 24)}일 전`, `${Math.floor(hours / 24)} d ago`);
}

export function htmlToPlain(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/** The orchestrator ends a turn with exactly this when the owner needs no message (e.g. a quiet recovery). */
export const SILENT_REPLY = "[[무음]]";

export function isSilentReply(text: string): boolean {
  return text.trim() === SILENT_REPLY;
}
