import { clock } from "./queue.ts";
import type { TgMessage, TgMessageOrigin } from "./telegram.ts";

// When the owner answers one of the bot's messages with Telegram's Reply ("너 추천대로 ㄱㄱ 하자"),
// the seat cannot tell which message is meant on its own. The bridge puts one line before the text
// naming and quoting the replied message (or the part selected with a quote reply).

export const REPLY_SNIPPET_CHARS = 300;

function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
}

export function originName(origin: TgMessageOrigin | undefined): string | null {
  if (!origin) return null;
  return (
    origin.sender_user?.first_name ??
    origin.sender_user?.username ??
    origin.sender_user_name ??
    origin.sender_chat?.title ??
    origin.chat?.title ??
    null
  );
}

/** "[사진] caption", "[파일 brief.pdf]", plain text, … for the replied message; "" when there is nothing to quote. */
export function describeMessage(message: Partial<TgMessage>): string {
  const kind = message.photo?.length
    ? "[사진]"
    : message.document
      ? `[파일 ${message.document.file_name ?? ""}]`.replace(" ]", "]")
      : message.voice
        ? "[음성]"
        : message.video
          ? "[영상]"
          : message.audio
            ? "[오디오]"
            : "";
  const body = (message.text ?? message.caption ?? "").trim();
  return [kind, body].filter(Boolean).join(" ");
}

/**
 * `↩ 답장 대상 (오케 15:12): "…"` for a message the owner sent as a Telegram Reply; null when it isn't one.
 * `who` names the replied message's sender (the bridge knows which session a bot message came from).
 * A quote reply wins over the whole message: it is exactly the part the owner meant.
 */
export function replyContextLine(message: TgMessage, who: string | null, limit = REPLY_SNIPPET_CHARS): string | null {
  const replied = message.reply_to_message;
  const external = message.external_reply;
  if (!replied && !external) return null;
  const forwarded = originName(replied?.forward_origin);
  const source = replied
    ? forwarded
      ? `전달된 메시지 · ${forwarded}`
      : (who ?? "메시지")
    : `다른 대화${originName(external?.origin) ? ` · ${originName(external?.origin)}` : ""}`;
  const date = replied?.date ?? external?.origin?.date;
  const when = date ? ` ${clock(date * 1000)}` : "";
  const quote = message.quote?.text?.trim();
  if (quote) return `↩ 답장 대상 (${source}${when}) 중 인용: "${oneLine(quote, limit)}"`;
  // Nothing quotable (a sticker, or a bare id in a test payload): no line rather than an empty quote.
  const said = describeMessage(replied ?? external ?? {});
  return said ? `↩ 답장 대상 (${source}${when}): "${oneLine(said, limit)}"` : null;
}
