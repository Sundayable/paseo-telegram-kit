import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { TELEGRAM_API_BASE } from "./config.ts";

export interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
  is_bot?: boolean;
}

/** Where a forwarded message (or an external reply) came from. */
export interface TgMessageOrigin {
  type: string;
  date: number;
  sender_user?: TgUser;
  sender_user_name?: string;
  sender_chat?: { title?: string };
  chat?: { title?: string };
}

export interface TgFileRef {
  file_id: string;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: TgUser;
  date: number;
  text?: string;
  caption?: string;
  media_group_id?: string;
  /** The message the owner answered with Telegram's Reply (Telegram sends it without its own reply). */
  reply_to_message?: Partial<Omit<TgMessage, "reply_to_message">> & { message_id: number };
  /** The part of the replied message the owner selected with Telegram's quote reply. */
  quote?: { text: string; is_manual?: boolean };
  /** A reply to a message from another chat. */
  external_reply?: Partial<Pick<TgMessage, "photo" | "document" | "voice" | "audio" | "video">> & { origin?: TgMessageOrigin };
  forward_origin?: TgMessageOrigin;
  photo?: Array<TgFileRef & { width: number; height: number }>;
  document?: TgFileRef & { file_name?: string; mime_type?: string };
  voice?: TgFileRef & { mime_type?: string; duration?: number };
  audio?: TgFileRef & { file_name?: string; mime_type?: string };
  video?: TgFileRef & { file_name?: string; mime_type?: string };
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  data?: string;
  message?: { message_id: number; chat: { id: number } };
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface SendOptions {
  html?: boolean;
  replyTo?: number;
  buttons?: InlineButton[][];
  /** Deliver without a sound or banner (night-time notices). */
  silent?: boolean;
}

export class TelegramError extends Error {
  readonly code: number;
  readonly retryAfter: number | null;

  constructor(code: number, description: string, retryAfter: number | null) {
    super(`Telegram ${code}: ${description}`);
    this.code = code;
    this.retryAfter = retryAfter;
  }

  get isParseError(): boolean {
    return this.code === 400 && /can't parse entities|unsupported start tag|can't find end tag/i.test(this.message);
  }
}

/** The subset of the Bot API the bridge uses; the tests substitute a fake. */
export interface TelegramPort {
  sendMessage(text: string, options?: SendOptions): Promise<number>;
  editMessage(messageId: number, text: string, options?: { html?: boolean; buttons?: InlineButton[][] }): Promise<void>;
  answerCallback(callbackId: string, text?: string): Promise<void>;
  sendTyping(): Promise<void>;
  react(messageId: number, emoji: string): Promise<void>;
  downloadFile(fileId: string): Promise<Buffer>;
  sendFile(path: string, caption?: string): Promise<number>;
  pinMessage?(messageId: number): Promise<void>;
}

interface ApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

const PHOTO_EXTENSIONS = /\.(png|jpe?g|webp)$/i;
const PHOTO_LIMIT = 10 * 1024 * 1024;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export class TelegramApi implements TelegramPort {
  private readonly token: string;
  readonly chatId: number;
  private readonly base: string;

  constructor(token: string, chatId: number, base = TELEGRAM_API_BASE) {
    this.token = token;
    this.chatId = chatId;
    this.base = base.replace(/\/$/, "");
  }

  // The URL contains the token, so it never appears in an error or log line.
  private async call<T>(method: string, body: Record<string, unknown> | FormData, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(`${this.base}/bot${this.token}/${method}`, {
          method: "POST",
          headers: body instanceof FormData ? undefined : { "content-type": "application/json" },
          body: body instanceof FormData ? body : JSON.stringify(body),
          signal,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.name : "error";
        throw new TelegramError(0, `${method} network ${reason}`, null);
      }
      const payload = (await response.json().catch(() => ({ ok: false }))) as ApiResponse<T>;
      if (payload.ok) return payload.result as T;
      const retryAfter = payload.parameters?.retry_after ?? null;
      if (response.status === 429 && retryAfter !== null && attempt < 2) {
        await sleep(retryAfter * 1000, signal);
        continue;
      }
      throw new TelegramError(payload.error_code ?? response.status, `${method}: ${payload.description ?? "failed"}`, retryAfter);
    }
  }

  getMe(): Promise<TgUser> {
    return this.call("getMe", {});
  }

  getUpdates(offset: number, timeoutSeconds: number, signal?: AbortSignal): Promise<TgUpdate[]> {
    return this.call(
      "getUpdates",
      { offset, timeout: timeoutSeconds, allowed_updates: ["message", "callback_query"] },
      signal,
    );
  }

  setCommands(commands: Array<{ command: string; description: string }>): Promise<boolean> {
    return this.call("setMyCommands", { commands, scope: { type: "chat", chat_id: this.chatId } });
  }

  async pinMessage(messageId: number): Promise<void> {
    await this.call("pinChatMessage", { chat_id: this.chatId, message_id: messageId, disable_notification: true });
  }

  async sendMessage(text: string, options: SendOptions = {}): Promise<number> {
    const message = await this.call<{ message_id: number }>("sendMessage", {
      chat_id: this.chatId,
      text,
      parse_mode: options.html ? "HTML" : undefined,
      link_preview_options: { is_disabled: true },
      reply_parameters: options.replyTo ? { message_id: options.replyTo, allow_sending_without_reply: true } : undefined,
      reply_markup: options.buttons ? { inline_keyboard: options.buttons } : undefined,
      disable_notification: options.silent || undefined,
    });
    return message.message_id;
  }

  async editMessage(messageId: number, text: string, options: { html?: boolean; buttons?: InlineButton[][] } = {}): Promise<void> {
    try {
      await this.call("editMessageText", {
        chat_id: this.chatId,
        message_id: messageId,
        text,
        parse_mode: options.html ? "HTML" : undefined,
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: options.buttons ?? [] },
      });
    } catch (error) {
      if (error instanceof TelegramError && /message is not modified/i.test(error.message)) return;
      throw error;
    }
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: callbackId, text });
  }

  async sendTyping(): Promise<void> {
    await this.call("sendChatAction", { chat_id: this.chatId, action: "typing" });
  }

  async react(messageId: number, emoji: string): Promise<void> {
    await this.call("setMessageReaction", {
      chat_id: this.chatId,
      message_id: messageId,
      reaction: [{ type: "emoji", emoji }],
    });
  }

  async downloadFile(fileId: string): Promise<Buffer> {
    const file = await this.call<{ file_path?: string }>("getFile", { file_id: fileId });
    if (!file.file_path) throw new TelegramError(400, "getFile: no file_path (file over 20 MB?)", null);
    const response = await fetch(`${this.base}/file/bot${this.token}/${file.file_path}`);
    if (!response.ok) throw new TelegramError(response.status, "file download failed", null);
    return Buffer.from(await response.arrayBuffer());
  }

  async sendFile(path: string, caption?: string): Promise<number> {
    const bytes = await readFile(path);
    const asPhoto = PHOTO_EXTENSIONS.test(path) && bytes.length <= PHOTO_LIMIT;
    const form = new FormData();
    form.set("chat_id", String(this.chatId));
    if (caption) form.set("caption", caption.slice(0, 1024));
    form.set(asPhoto ? "photo" : "document", new Blob([new Uint8Array(bytes)]), basename(path));
    const message = await this.call<{ message_id: number }>(asPhoto ? "sendPhoto" : "sendDocument", form);
    return message.message_id;
  }
}
