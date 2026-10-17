import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { AgentPermissionRequest, AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { helpText, parseCommand, resolveAgentRef, splitFirst, type ParsedCommand } from "./commands.ts";
import { MODEL_ALIASES, ORCHESTRATOR_LABEL, ORCHESTRATOR_TITLE, PATHS, SEAT_CHAIN, type SeatConfig, type SeatDefinition } from "./config.ts";
import { escapeHtml, extractFileMarkers, htmlToPlain, isSilentReply, renderMessages, shortId, timeAgo, type RenderedChunk } from "./format.ts";
import { BATCH_RULES, frameForOrchestrator, ORCHESTRATOR_SYSTEM_PROMPT } from "./orchestrator-prompt.ts";
import type { AgentSummary, ImageInput, PaseoPort, ProfileSummary } from "./paseo-port.ts";
import {
  actionButtons,
  actionResponse,
  actionsOf,
  answerResponse,
  denyWithMessage,
  describeRequest,
  optionButtons,
  questionHtml,
  questionsOf,
} from "./permissions.ts";
import type { PendingRequest, StateStore } from "./state.ts";
import { TelegramError, type InlineButton, type TelegramPort, type TgCallbackQuery, type TgMessage, type TgUpdate } from "./telegram.ts";
import { correctionPrompt, flushDueAt, formatBatch, isCorrectionText, stripNow, type QueuedItem, type QueueStore } from "./queue.ts";
import { handoffBackToMain, handoffToBackup, looksUnavailable, PROBE_TEXT, retryDelay, timelineDigest } from "./seats.ts";
import { decisionLine, DIGEST_LATE_LIMIT_MS, dueDigestSlot, renderDigest } from "./digest.ts";
import { buildHandoff, rotationPrompt, rotationWindowDay } from "./rotation.ts";
import { WAKE_AFTER_MS, WAKE_BACKOFF_MS, WAKE_MAX, WAKE_RUNNING_TOOL_LIMIT_MS, WAKE_TEXT, waitingVerdict, type WaitingVerdict } from "./wake.ts";
import { detectStall, RESUME_GRACE_MS, RESUME_TEXT, type UsageRows } from "./stalls.ts";
import { finalAssistantText, latestErrors } from "./timeline.ts";
import { renderUsageCard, usageButtons, type UsageCardSnapshot } from "./usage-card.ts";
import { ownerWith, t } from "./i18n.ts";
import { replyContextLine } from "./reply-context.ts";

export interface BridgeOptions {
  telegram: TelegramPort;
  paseo: PaseoPort;
  state: StateStore;
  chatId: number;
  orchestratorCwd: string;
  downloadDir: string;
  homeDir: string;
  transcribe: ((audio: Buffer, filename: string) => Promise<string>) | null;
  log: (line: string) => void;
  albumDelayMs?: number;
  now?: () => number;
  /** Title for seats this bridge creates; drills use their own so they stand out. */
  orchestratorTitle?: string;
  /** Messages waiting for the orchestrator seat; persisted on disk in production. */
  queue: QueueStore;
  /** Quiet time after the owner's last message before an idle seat gets the batch. */
  debounceMs?: number;
  /** Longest a batch waits for the owner to stop typing. */
  debounceCapMs?: number;
  /** Longest a worker's permission request waits for the seat to finish its turn. */
  permissionWaitMs?: number;
  /** usage-remaining numbers; tells when a prepaid balance or weekly limit is back. */
  usage?: () => UsageRows;
  usageReader?: { read(): Promise<UsageCardSnapshot> };
  /** Keep a pinned usage card edited every 5 min; false = /usage on demand only. */
  usagePanel?: boolean;
  /** Where rotation handoffs are written. */
  handoffDir?: string;
}

export interface HookAgent {
  id: string;
  title: string | null;
  parentAgentId?: string | null;
}

export type TurnOutcome =
  | { kind: "completed" }
  | { kind: "failed"; error: { message: string } }
  | { kind: "canceled"; reason: string };

interface Content {
  text: string;
  images: ImageInput[];
  /** Where the photos were saved, so a queued message can attach them later. */
  imagePaths: string[];
  /** `↩ 답장 대상 (…)` when the owner used Telegram's Reply; kept apart so command/correction checks see only their words. */
  replyContext?: string;
}

const TYPING_INTERVAL_MS = 4500;
const STEER_WINDOW_MS = 60_000;
const PROBE_TIMEOUT_MS = 10 * 60 * 1000;
const SEAT_LABEL_KEY = "telegram.seat";
/** Seats created with this label get worker notices from the bridge instead of Paseo. */
const NOTICES_LABEL_KEY = "telegram.notices";
const DELIVERY_GRACE_MS = 10_000;
const MAX_CONCURRENT_RESUMES = 2;
const STALL_SCAN_EVERY_MS = 10 * 60 * 1000;
const STALL_WINDOW_MS = 24 * 3600 * 1000;
const WORKER_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TYPING_MAX_MS = 20 * 60 * 1000;
const FILE_LIMIT = 50 * 1024 * 1024;
const DOWNLOAD_LIMIT = 20 * 1024 * 1024;
const IMAGE_MIME = /^image\/(png|jpe?g|webp|gif)$/;
// Files the orchestrator may attach leave the machine for Telegram's servers;
// never let credentials go that way.
const SECRET_PATH = /\/(\.ssh|\.gnupg|\.aws|\.paseo|\.config\/env|Library\/Keychains)(\/|$)/;
const SECRET_NAME = /^\.env|\.keys?(\.|$)|credential|secret|\.pem$|\.p12$|id_(rsa|ed25519)/i;

const STATUS_EMOJI: Record<string, string> = {
  running: "🟢",
  idle: "⚪",
  error: "🔴",
  initializing: "🟡",
  closed: "⚫",
};

function stamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function safeName(name: string): string {
  return name.replace(/[^\w.\-가-힣]+/g, "_").slice(-80) || "file";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Bridge {
  private readonly options: BridgeOptions;
  botUsername: string | undefined;
  private readonly running = new Set<string>();
  private typingTimer: ReturnType<typeof setInterval> | null = null;
  private typingSince = 0;
  private readonly albums = new Map<string, { messages: TgMessage[]; updateIds: number[]; timer: ReturnType<typeof setTimeout> }>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private permissionTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the bridge last handed the seat a batch; Paseo needs a moment to show it as running. */
  private deliveredAt = 0;
  private flushing = false;
  private readonly noticeSeats = new Map<string, boolean>();
  /** Tokens we are answering ourselves, so their `permission_resolved` echo is ignored. */
  private readonly resolving = new Set<string>();
  /**
   * When the bridge last sent to (or stopped) each agent. A message to a running
   * agent interrupts its turn; that cancel is the owner's own doing, not news.
   */
  private readonly lastPush = new Map<string, number>();
  private switching = false;
  private usagePanelWork: Promise<void> | null = null;
  private stopped = false;

  constructor(options: BridgeOptions) {
    this.options = options;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private get state() {
    return this.options.state;
  }

  private get telegram() {
    return this.options.telegram;
  }

  private get paseo() {
    return this.options.paseo;
  }

  // ---------------------------------------------------------------- inbound

  async handleUpdate(update: TgUpdate): Promise<void> {
    try {
      if (update.callback_query) await this.handleCallback(update.callback_query);
      else if (update.message) await this.handleMessage(update.message, update.update_id);
    } catch (error) {
      this.options.log(`update ${update.update_id} failed: ${errorText(error)}`);
      await this.say(t(`⚠️ 처리 중 오류가 났어요: ${escapeHtml(errorText(error))}`, `⚠️ Something went wrong: ${escapeHtml(errorText(error))}`)).catch(() => {});
    }
  }

  private authorized(userId: number | undefined, chatId: number | undefined): boolean {
    return userId === this.options.chatId && chatId === this.options.chatId;
  }

  private async handleMessage(message: TgMessage, updateId: number): Promise<void> {
    if (!this.authorized(message.from?.id, message.chat.id)) {
      this.options.log(`ignored message from unauthorized chat ${message.chat.id}`);
      return;
    }
    const text = message.text?.trim() ?? "";
    const replyTo = message.reply_to_message?.message_id;

    if (replyTo && text && !text.startsWith("/")) {
      const pending = this.state.pendingByMessage(replyTo);
      if (pending) {
        await this.answerPendingWithText(pending[0], pending[1], text);
        return;
      }
    }

    // "/now …" is an urgent message for the seat, not a bridge command.
    const command = message.text && !/^\s*\/now\b/i.test(message.text) ? parseCommand(message.text, this.botUsername) : null;
    if (command) {
      await this.handleCommand(command, message);
      return;
    }

    if (message.media_group_id) {
      this.bufferAlbum(message, updateId);
      return;
    }
    await this.dispatch([message], [updateId]);
  }

  // An album arrives as one message per item; wait briefly and send them together.
  private bufferAlbum(message: TgMessage, updateId: number): void {
    const key = message.media_group_id as string;
    const album = this.albums.get(key);
    if (album) clearTimeout(album.timer);
    const messages = [...(album?.messages ?? []), message];
    const updateIds = [...(album?.updateIds ?? []), updateId];
    const timer = setTimeout(() => {
      this.albums.delete(key);
      void this.dispatch(messages, updateIds).catch(async (error) => {
        this.options.log(`album dispatch failed: ${errorText(error)}`);
        await this.say(t(`⚠️ 사진 묶음을 전달하지 못했어요: ${escapeHtml(errorText(error))}`, `⚠️ Couldn't pass on the photo album: ${escapeHtml(errorText(error))}`)).catch(() => {});
      });
    }, this.options.albumDelayMs ?? 1500);
    this.albums.set(key, { messages, updateIds, timer });
  }

  private async dispatch(messages: TgMessage[], updateIds: number[]): Promise<void> {
    const content = await this.collectContent(messages);
    if (!content) return;
    const first = messages[0];
    const replyTo = messages.find((message) => message.reply_to_message)?.reply_to_message?.message_id;
    const target = replyTo ? this.state.agentForMessage(replyTo) : null;
    const replying = messages.find((message) => message.reply_to_message || message.external_reply);
    if (replying) content.replyContext = replyContextLine(replying, await this.replySender(replying, target)) ?? undefined;
    // A reply to any seat's message (also one from before a rotation or a backup switch) is for the current seat.
    if (target && !this.isSeatId(target)) {
      await this.sendToAgent(target, content, first.message_id);
    } else {
      await this.onOwnerMessage(content, messages.map((message) => message.message_id), updateIds, replyTo);
    }
  }

  private isSeatId(agentId: string): boolean {
    const data = this.state.data;
    return agentId === data.orchestratorId || Object.values(data.seats).includes(agentId) || data.retiredSeats.includes(agentId);
  }

  /** Who sent the message the owner replied to: the seat, a session (by title), the owner or a bridge notice. */
  private async replySender(message: TgMessage, agentId: string | null): Promise<string | null> {
    const replied = message.reply_to_message;
    if (!replied) return null;
    if (replied.from && !replied.from.is_bot && replied.from.id === this.options.chatId) return "내 메시지";
    if (agentId) {
      if (this.isSeatId(agentId)) return "오케";
      const agent = await this.paseo.getAgent(agentId).catch(() => null);
      return `세션 ${agent?.title ?? shortId(agentId)}`;
    }
    return replied.from?.is_bot ? "브리지 알림" : null;
  }

  private async saveDownload(fileId: string, name: string): Promise<{ path: string; bytes: Buffer }> {
    const bytes = await this.telegram.downloadFile(fileId);
    await mkdir(this.options.downloadDir, { recursive: true });
    const path = join(this.options.downloadDir, `${stamp()}-${safeName(name)}`);
    await writeFile(path, bytes);
    return { path, bytes };
  }

  private async collectContent(messages: TgMessage[]): Promise<Content | null> {
    const texts: string[] = [];
    const notes: string[] = [];
    const images: ImageInput[] = [];
    const imagePaths: string[] = [];

    for (const message of messages) {
      const body = (message.text ?? message.caption ?? "").trim();
      if (body) texts.push(body);

      const tooBig = (size?: number) => (size ?? 0) > DOWNLOAD_LIMIT;
      if (message.photo?.length) {
        const largest = message.photo[message.photo.length - 1];
        const saved = await this.saveDownload(largest.file_id, `photo-${message.message_id}.jpg`);
        images.push({ data: saved.bytes.toString("base64"), mimeType: "image/jpeg" });
        imagePaths.push(saved.path);
        notes.push(t(`사진: ${saved.path}`, `Photo: ${saved.path}`));
      }
      const file = message.document ?? message.video ?? message.audio;
      if (file) {
        const name = ("file_name" in file && file.file_name) || `file-${message.message_id}`;
        if (tooBig(file.file_size)) {
          await this.say(t(`⚠️ 20MB가 넘는 파일(${escapeHtml(name)})은 봇이 받을 수 없어요.`, `⚠️ Bots can't receive files over 20 MB (${escapeHtml(name)}).`), message.message_id);
        } else {
          const saved = await this.saveDownload(file.file_id, name);
          notes.push(t(`파일: ${saved.path}`, `File: ${saved.path}`));
          if (file.mime_type && IMAGE_MIME.test(file.mime_type)) {
            images.push({ data: saved.bytes.toString("base64"), mimeType: file.mime_type });
            imagePaths.push(saved.path);
          }
        }
      }
      if (message.voice) {
        if (!this.options.transcribe) {
          await this.say(t("⚠️ 음성 받아쓰기를 쓸 수 없어요 (OPENAI_API_KEY 없음). 글로 보내 주세요.", "⚠️ Voice transcription is off (no OPENAI_API_KEY). Please type it instead."), message.message_id);
          return null;
        }
        const audio = await this.telegram.downloadFile(message.voice.file_id);
        const transcript = await this.options.transcribe(audio, `voice-${message.message_id}.ogg`);
        if (!transcript) {
          await this.say(t("⚠️ 음성에서 말을 알아듣지 못했어요.", "⚠️ Couldn't make out any words in that voice note."), message.message_id);
          return null;
        }
        texts.push(transcript);
        await this.say(`🎙 ${escapeHtml(transcript)}`, message.message_id);
      }
    }

    if (!texts.length && !notes.length) return null;
    let text = texts.join("\n\n") || t("(첨부만 보냄)", "(attachment only)");
    if (notes.length) text += `\n\n${t("첨부:", "Attachments:")}\n${notes.map((note) => `- ${note}`).join("\n")}`;
    return { text, images, imagePaths };
  }

  private async acknowledge(messageId: number): Promise<void> {
    await this.telegram.react(messageId, "👀").catch(() => {});
  }

  // ---------------------------------------------------------------- orchestrator seats

  private seatLabel(index = this.state.data.seat): string {
    return SEAT_CHAIN[index]?.label ?? t("오케", "orchestrator");
  }

  private async seatConfig(definition: SeatDefinition): Promise<SeatConfig> {
    const profiles = await this.paseo.profiles().catch((): ProfileSummary[] => []);
    const profile =
      profiles.find((candidate) => candidate.id === definition.profileId) ??
      profiles.find((candidate) => candidate.name.includes(definition.nameHint));
    const config: SeatConfig = profile?.model
      ? {
          provider: profile.provider,
          model: profile.model,
          modeId: profile.modeId,
          thinkingOptionId: profile.thinkingOptionId,
          featureValues: profile.featureValues,
        }
      : { ...definition.fallback };
    if (definition.key === "main" && config.provider === "claude" && this.state.data.model) {
      config.model = this.state.data.model;
    }
    return config;
  }

  private async createSeat(index: number, prompt: string, images: ImageInput[]): Promise<{ id: string; model: string }> {
    const definition = SEAT_CHAIN[index];
    const config = await this.seatConfig(definition);
    const model = `${config.provider}/${config.model}`;
    const id = await this.paseo.create({
      provider: model,
      modeId: config.modeId,
      thinkingOptionId: config.thinkingOptionId,
      featureValues: config.featureValues,
      systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
      cwd: this.options.orchestratorCwd,
      title: `${this.options.orchestratorTitle ?? ORCHESTRATOR_TITLE}${index === 0 ? "" : ` · ${(index === 0 ? definition.label : definition.label.replace(/^백업 오케 · /, "백업 "))}`}`,
      labels: {
        [ORCHESTRATOR_LABEL.key]: ORCHESTRATOR_LABEL.orchestrator,
        [SEAT_LABEL_KEY]: definition.key,
        [NOTICES_LABEL_KEY]: "bridge",
      },
      prompt,
      images,
    });
    this.state.data.seats[definition.key] = id;
    this.state.save();
    this.options.log(`created ${definition.key} seat ${shortId(id)} (${model})`);
    return { id, model };
  }

  // ---------------------------------------------------------------- orchestrator queue

  /**
   * The owner's messages for the seat. Idle seat: wait until they stop typing, then send
   * everything as one prompt. Busy seat: queue it, unless it is a correction.
   */
  private async onOwnerMessage(content: Content, messageIds: number[], updateIds: number[], replyTo?: number): Promise<void> {
    const now = this.now();
    const busy = await this.isSeatBusy();
    const inFlight = this.options.queue.data.inFlight;
    const correction =
      busy && (isCorrectionText(content.text) || (replyTo !== undefined && Boolean(inFlight?.messageIds.includes(replyTo))));
    const urgent = /^\s*(\/now\b|급해)/i.test(content.text);
    const item: QueuedItem = {
      id: `tg:${updateIds[0]}`,
      kind: "owner",
      text: content.replyContext ? `${content.replyContext}\n${stripNow(content.text)}` : stripNow(content.text),
      imagePaths: content.imagePaths,
      at: now,
      messageIds,
    };
    if (!this.options.queue.push(item, updateIds)) return;
    if (correction) {
      await this.interrupt("correction");
      return;
    }
    if (busy) {
      await this.say(t("⏳ 대기열에 넣었어요 — 지금 일 끝나면 바로 볼게요", "⏳ Queued — I'll pick it up as soon as the current task is done"), messageIds[0]);
      return;
    }
    if (urgent) await this.flush();
    else await this.scheduleFlush();
  }

  /** Busy while a turn runs, and for a short grace after a send before Paseo reports it. */
  private async isSeatBusy(): Promise<boolean> {
    const id = this.state.data.orchestratorId;
    if (!id) return false;
    if (this.now() - this.deliveredAt < DELIVERY_GRACE_MS) return true;
    const agent = await this.paseo.getAgent(id);
    return agent?.status === "running" || agent?.status === "initializing";
  }

  /** When to hand the batch over: 8 s after the owner's last message, at most 30 s after the first. */
  private async scheduleFlush(): Promise<void> {
    const items = this.options.queue.data.items;
    if (!items.length) return;
    const now = this.now();
    const due = flushDueAt(items, now, this.options.debounceMs ?? 8000, this.options.debounceCapMs ?? 30_000);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (due <= now) {
      await this.flush();
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((error) => this.options.log(`flush failed: ${errorText(error)}`));
    }, due - now);
  }

  /** Delivers the whole queue as one prompt if the seat is free; a busy seat gets it at turn end. */
  async flush(force = false): Promise<void> {
    if (this.flushing || !this.options.queue.length) return;
    this.flushing = true;
    try {
      if (!force && (await this.isSeatBusy())) return;
      const items = [...this.options.queue.data.items];
      await this.deliverBatch(formatBatch(items, this.now()), items);
    } finally {
      this.flushing = false;
    }
  }

  /** A correction, or a permission that waited too long: interrupt the running turn. */
  private async interrupt(reason: "correction" | "permission"): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const items = [...this.options.queue.data.items];
    if (!items.length) return;
    const original = this.options.queue.data.inFlight?.text ?? null;
    const prompt =
      reason === "correction"
        ? correctionPrompt(original, items, this.now())
        : [
            "[텔레그램 · 워커 권한 요청으로 잠깐 끼어듦]",
            "하던 턴은 아래 권한 요청을 처리하느라 끊겼다. 처리한 뒤, 끊긴 턴에서 이미 한 일은 반복하지 말고 하던 일을 이어서 마쳐라.",
            ...(original ? ["", "하던 일:", original] : []),
            "",
            formatBatch(items, this.now()),
          ].join("\n");
    this.options.log(`interrupting the seat (${reason}) with ${items.length} queued item(s)`);
    await this.deliverBatch(prompt, items);
  }

  private async loadImages(paths: readonly string[]): Promise<ImageInput[]> {
    const images: ImageInput[] = [];
    for (const path of paths) {
      try {
        const mimeType = /\.png$/i.test(path) ? "image/png" : /\.webp$/i.test(path) ? "image/webp" : /\.gif$/i.test(path) ? "image/gif" : "image/jpeg";
        images.push({ data: (await readFile(path)).toString("base64"), mimeType });
      } catch {
        // a photo deleted while queued is simply not attached
      }
    }
    return images;
  }

  private async deliverBatch(batchText: string, items: QueuedItem[]): Promise<void> {
    const messageIds = items.flatMap((item) => item.messageIds);
    const images = await this.loadImages(items.flatMap((item) => item.imagePaths));
    this.state.data.lastPrompt = { text: batchText, at: this.now(), answered: false };
    this.state.save();
    const handoff = this.state.data.seat === 0 ? this.state.data.pendingHandoff : null;
    // Existing seats retain their creation-time prompt until rotation. Carry the current
    // routing with each batch so a config reload also updates an already-running seat.
    const routedBatch = `${BATCH_RULES}\n\n${batchText}`;
    const prompt = handoff ? `${handoff}\n\n${routedBatch}` : routedBatch;
    const current = this.state.data.orchestratorId;
    const agent = current ? await this.paseo.getAgent(current) : null;
    const content: Content = { text: batchText, images, imagePaths: [] };
    try {
      if (agent && !agent.archivedAt) {
        this.lastPush.set(agent.id, this.now());
        await this.paseo.send(agent.id, prompt, images);
        this.markRunning(agent.id);
      } else {
        const created = await this.createSeat(this.state.data.seat, prompt, images);
        this.state.data.orchestratorId = created.id;
        this.state.save();
        this.markRunning(created.id);
        await this.say(
          t(
            `🎛 새 오케 세션을 만들었어요: <code>${shortId(created.id)}</code> · ${escapeHtml(this.seatLabel())} · ${escapeHtml(created.model)}`,
            `🎛 Started a new orchestrator session: <code>${shortId(created.id)}</code> · ${escapeHtml(this.seatLabel())} · ${escapeHtml(created.model)}`,
          ),
        );
      }
      if (handoff) {
        this.state.data.pendingHandoff = null;
        this.state.save();
      }
    } catch (error) {
      this.options.log(`orchestrator send failed: ${errorText(error)}`);
      this.options.queue.remove(items.map((item) => item.id));
      await this.fallback(t(`전송 실패: ${errorText(error)}`, `send failed: ${errorText(error)}`), content);
      return;
    }
    this.deliveredAt = this.now();
    this.options.queue.remove(items.map((item) => item.id));
    this.options.queue.setInFlight({ text: batchText, messageIds, startedAt: this.now() });
    if (this.permissionTimer && !this.options.queue.data.items.some((item) => item.kind === "permission")) {
      clearTimeout(this.permissionTimer);
      this.permissionTimer = null;
    }
    for (const messageId of messageIds) await this.acknowledge(messageId);
  }

  // ---------------------------------------------------------------- worker notices

  /** Seats created by this version delegate with notifyOnFinish:false and hear about workers from the bridge. */
  private async seatOwnsNotices(seatId: string | null): Promise<boolean> {
    if (!seatId) return false;
    const cached = this.noticeSeats.get(seatId);
    if (cached !== undefined) return cached;
    const agent = await this.paseo.getAgent(seatId);
    const owns = agent?.labels[NOTICES_LABEL_KEY] === "bridge";
    this.noticeSeats.set(seatId, owns);
    return owns;
  }

  private isWorker(agent: HookAgent): boolean {
    const seat = this.state.data.orchestratorId;
    if (!seat || agent.id === seat || Object.values(this.state.data.seats).includes(agent.id)) return false;
    if (agent.parentAgentId && (agent.parentAgentId === seat || this.state.data.retiredSeats.includes(agent.parentAgentId))) return true;
    return agent.id in this.state.data.workers;
  }

  /** Agents the seat created or prompted this turn, read from its Paseo tool calls. */
  private trackWorkers(timeline: readonly AgentTimelineItem[]): void {
    let start = 0;
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      if (timeline[index].type === "user_message") {
        start = index + 1;
        break;
      }
    }
    const seats = new Set(Object.values(this.state.data.seats));
    let changed = false;
    for (const item of timeline.slice(start)) {
      if (item.type !== "tool_call" || !/create_agent|send_agent_prompt/.test(item.name)) continue;
      for (const id of JSON.stringify(item.detail ?? {}).match(WORKER_ID) ?? []) {
        if (seats.has(id) || id in this.state.data.workers) continue;
        this.state.data.workers[id] = this.now();
        changed = true;
      }
    }
    if (changed) this.state.save();
  }

  private async queueNotice(item: QueuedItem): Promise<void> {
    if (!this.options.queue.push(item)) return;
    if (item.kind === "permission" && !this.permissionTimer) {
      this.permissionTimer = setTimeout(() => {
        this.permissionTimer = null;
        void (async () => {
          if (!this.options.queue.data.items.some((queued) => queued.kind === "permission")) return;
          if (await this.isSeatBusy()) await this.interrupt("permission");
          else await this.flush();
        })().catch((error) => this.options.log(`permission delivery failed: ${errorText(error)}`));
      }, this.options.permissionWaitMs ?? 120_000);
    }
    if (!(await this.isSeatBusy())) await this.scheduleFlush();
  }

  /** Moves the Telegram seat down the configured chain: main, then each backup in order. */
  private async fallback(reason: string, content?: Content): Promise<void> {
    if (this.switching) return;
    this.switching = true;
    try {
      const fromIndex = this.state.data.seat;
      const fromId = this.state.data.orchestratorId;
      const digest = fromId ? timelineDigest(await this.paseo.timeline(fromId).catch((): AgentTimelineItem[] => [])) : "";
      const last = this.state.data.lastPrompt;
      const pending = content?.text ?? (last && !last.answered ? last.text : null);
      let lastError = reason;
      for (let next = fromIndex + 1; next < SEAT_CHAIN.length; next += 1) {
        const definition = SEAT_CHAIN[next];
        const prompt = handoffToBackup({
          fromLabel: this.seatLabel(fromIndex),
          toLabel: definition.label,
          reason: lastError,
          digest,
          pending,
        });
        try {
          const existingId = this.state.data.seats[definition.key];
          const existing = existingId ? await this.paseo.getAgent(existingId) : null;
          let id: string;
          if (existing && !existing.archivedAt) {
            this.lastPush.set(existing.id, this.now());
            await this.paseo.send(existing.id, prompt, content?.images ?? []);
            id = existing.id;
          } else {
            id = (await this.createSeat(next, prompt, content?.images ?? [])).id;
          }
          const now = this.now();
          this.state.data.seat = next;
          this.state.data.orchestratorId = id;
          this.state.data.fallback ??= { since: now, reason, retryAt: now + retryDelay(0), attempts: 0, probeSentAt: null };
          this.state.save();
          this.markRunning(id);
          this.options.log(`fell back from seat ${fromIndex} to ${definition.key} (${lastError})`);
          await this.say(
            t(
              `🔁 백업 오케로 전환됨: <b>${escapeHtml(definition.label)}</b> (사유: ${escapeHtml(lastError.slice(0, 160))})`,
              `🔁 Switched to backup seat: <b>${escapeHtml(definition.label)}</b> (reason: ${escapeHtml(lastError.slice(0, 160))})`,
            ),
          );
          return;
        } catch (error) {
          lastError = t(`${definition.label} 시작 실패: ${errorText(error)}`, `${definition.label} failed to start: ${errorText(error)}`);
          this.options.log(lastError);
        }
      }
      await this.say(
        t(
          `⚠️ 모든 오케 좌석이 응답하지 않아요 (${escapeHtml(lastError.slice(0, 160))}).\n/main 으로 메인 좌석을 다시 시도할 수 있어요.`,
          `⚠️ No orchestrator seat is answering (${escapeHtml(lastError.slice(0, 160))}).\nSend /main to try the main seat again.`,
        ),
      );
    } finally {
      this.switching = false;
    }
  }

  private async returnToMain(manual: boolean): Promise<void> {
    const fromIndex = this.state.data.seat;
    if (fromIndex === 0) {
      if (manual) await this.say(t("이미 메인 오케로 대화하고 있어요.", "Already on the main seat."));
      return;
    }
    const backupId = this.state.data.orchestratorId;
    const digest = backupId ? timelineDigest(await this.paseo.timeline(backupId).catch((): AgentTimelineItem[] => [])) : "";
    this.state.data.pendingHandoff = handoffBackToMain({ fromLabel: this.seatLabel(fromIndex), digest });
    this.state.data.seat = 0;
    this.state.data.orchestratorId = this.state.data.seats.main ?? null;
    this.state.data.fallback = null;
    this.state.save();
    this.options.log(`returned to main seat (${manual ? "manual" : "probe ok"})`);
    await this.say(
      manual
        ? t("↩️ 메인 오케로 돌아왔어요. 다음 메시지부터 메인이 받아요.", "↩️ Back on the main seat. It takes your next message.")
        : t(
            "↩️ 메인 오케가 다시 응답해서 메인으로 돌아왔어요. 백업에서 나눈 대화는 넘겨 둘게요.",
            "↩️ The main seat is answering again, so we're back on it. The backup conversation is handed over.",
          ),
    );
  }

  /** On startup: deliver what was queued before a restart, and re-arm the permission deadline. */
  async resume(): Promise<void> {
    const permissions = this.options.queue.data.items.filter((item) => item.kind === "permission");
    if (permissions.length) {
      const oldest = Math.min(...permissions.map((item) => item.at));
      const wait = Math.max(0, oldest + (this.options.permissionWaitMs ?? 120_000) - this.now());
      this.permissionTimer = setTimeout(() => {
        this.permissionTimer = null;
        void (async () => {
          if (await this.isSeatBusy()) await this.interrupt("permission");
          else await this.flush();
        })().catch((error) => this.options.log(`permission delivery failed: ${errorText(error)}`));
      }, wait);
    }
    if (this.options.queue.length) {
      this.options.log(`replaying ${this.options.queue.length} queued item(s) after restart`);
      if (!(await this.isSeatBusy())) await this.scheduleFlush();
    }
  }

  /** Every minute from the runtime. */
  async tick(): Promise<void> {
    for (const [name, job] of [
      ["probe", () => this.probeMain()],
      ["stall scan", () => this.scanStalls()],
      ["resume", () => this.processStalls()],
      ["wait scan", () => this.scanWaits()],
      ["wake", () => this.processWakes()],
      ["digest", () => this.maybeDigest()],
      ["rotate", () => this.maybeRotate()],
      ["usage panel", () => this.refreshUsagePanel()],
    ] as const) {
      try {
        await job();
      } catch (error) {
        this.options.log(`${name} failed: ${errorText(error)}`);
      }
    }
  }

  /** A single pinned card; normal messages and permission handling never use an LLM for usage. */
  async refreshUsagePanel(force = false): Promise<void> {
    if (this.stopped || !this.options.usageReader || this.options.usagePanel === false || this.state.data.usagePanelSendPending) return;
    if (this.usagePanelWork) return this.usagePanelWork;
    if (!force && this.now() - this.state.data.usageLastRefreshAt < 5 * 60_000) return;
    this.usagePanelWork = this.updateUsagePanel().finally(() => { this.usagePanelWork = null; });
    return this.usagePanelWork;
  }

  private async updateUsagePanel(): Promise<void> {
    const snapshot = await this.options.usageReader!.read();
    if (this.stopped) return;
    const text = renderUsageCard(snapshot, this.now());
    let id = this.state.data.usagePanelMessageId;
    if (id !== null) {
      try {
        await this.telegram.editMessage(id, text, { html: true, buttons: usageButtons() });
      } catch (error) {
        if (this.stopped) return;
        if (!(error instanceof TelegramError && error.code === 400 && /message to edit not found/i.test(error.message))) throw error;
        id = null;
        this.state.data.usagePanelMessageId = null;
        this.state.data.usagePanelPinned = false;
        this.state.save();
      }
    }
    if (this.stopped) return;
    if (id === null) {
      // If Telegram accepts a send but the connection drops before its reply,
      // don't blindly send a duplicate on the next timer or plugin reload.
      this.state.data.usagePanelSendPending = true;
      this.state.save();
      try {
        id = await this.telegram.sendMessage(text, { html: true, buttons: usageButtons(), silent: true });
      } catch (error) {
        if (error instanceof TelegramError && error.code >= 400 && error.code < 500) {
          this.state.data.usagePanelSendPending = false;
          this.state.save();
        }
        throw error;
      }
      this.state.data.usagePanelMessageId = id;
      this.state.data.usagePanelSendPending = false;
      this.state.save();
    }
    if (this.stopped) return;
    if (!this.state.data.usagePanelPinned && this.telegram.pinMessage) {
      await this.telegram.pinMessage(id);
      this.state.data.usagePanelPinned = true;
    }
    this.state.data.usageLastRefreshAt = this.now();
    this.state.save();
  }

  private async showUsage(messageId?: number): Promise<void> {
    if (!this.options.usageReader) {
      await this.say(t("사용량 연결을 확인 중이에요. 잠시 뒤 /usage로 다시 확인해 주세요.", "Still connecting to usage numbers. Try /usage again in a moment."));
      return;
    }
    const snapshot = await this.options.usageReader.read();
    if (this.stopped) return;
    const text = renderUsageCard(snapshot, this.now());
    if (messageId !== undefined) {
      await this.telegram.editMessage(messageId, text, { html: true, buttons: usageButtons() });
    } else {
      await this.telegram.sendMessage(text, { html: true, buttons: usageButtons(), silent: true });
    }
  }

  // ---------------------------------------------------------------- rotation

  private async maybeRotate(): Promise<void> {
    const day = rotationWindowDay(this.now());
    if (!day || this.state.data.lastRotationDay === day) return;
    if (await this.rotate("nightly")) {
      this.state.data.lastRotationDay = day;
      this.state.save();
    }
  }

  /** Replaces the main seat with a fresh session carrying a handoff; the old one is archived. */
  async rotate(reason: "nightly" | "manual"): Promise<boolean> {
    const manual = reason === "manual";
    const oldId = this.state.data.orchestratorId;
    if (this.state.data.seat !== 0 || this.state.data.fallback) {
      if (manual) await this.say(t("백업 좌석에서 일하는 중이라 교대하지 않아요. 메인으로 돌아온 뒤에 해 주세요.", "A backup seat is answering, so no rotation now. Try again once back on the main seat."));
      return false;
    }
    if (!oldId) {
      if (manual) await this.say(t("교대할 오케 세션이 아직 없어요.", "There is no orchestrator session to rotate yet."));
      return false;
    }
    const pendingPermission = this.options.queue.data.items.some((item) => item.kind === "permission");
    if (this.options.queue.length || pendingPermission || (await this.isSeatBusy())) {
      if (manual) {
        this.state.data.pendingRotate = true;
        this.state.save();
        await this.say(t("오케가 일하는 중이라 끝나면 교대할게요.", "The orchestrator is busy; I'll rotate once it finishes."));
      }
      return false;
    }
    this.state.data.pendingRotate = false;
    const timeline = await this.paseo.timeline(oldId).catch((): AgentTimelineItem[] => []);
    const workers: AgentSummary[] = [];
    for (const id of Object.keys(this.state.data.workers).slice(-20)) {
      const worker = await this.paseo.getAgent(id);
      if (worker && !worker.archivedAt) workers.push(worker);
    }
    const handoff = buildHandoff({ seatId: oldId, now: this.now(), timeline, workers });
    const dir = this.options.handoffDir ?? PATHS.handoffDir;
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${stamp(new Date(this.now()))}-${shortId(oldId)}.md`);
    await writeFile(file, handoff);

    const created = await this.createSeat(0, rotationPrompt(handoff, file), []);
    this.state.data.orchestratorId = created.id;
    this.state.data.silentTurn = created.id;
    this.state.data.retiredSeats = [...this.state.data.retiredSeats, oldId].slice(-5);
    this.state.save();
    this.deliveredAt = this.now();
    try {
      await this.paseo.archive(oldId);
    } catch (error) {
      this.options.log(`archiving the old seat failed: ${errorText(error)}`);
    }
    this.options.log(`rotated seat ${shortId(oldId)} → ${shortId(created.id)} (${reason})`);
    await this.say(
      t(
        `🔄 오케 세션을 새로 교대했어요: <code>${shortId(oldId)}</code> → <code>${shortId(created.id)}</code>. 이전 대화는 요약해서 넘겼어요.`,
        `🔄 Rotated the orchestrator session: <code>${shortId(oldId)}</code> → <code>${shortId(created.id)}</code>. The previous conversation was handed over as a summary.`,
      ),
      undefined,
      undefined,
      !manual,
    );
    return true;
  }

  // ---------------------------------------------------------------- digest

  private async maybeDigest(): Promise<void> {
    const now = this.now();
    const slot = dueDigestSlot(now, this.state.data.lastDigestSlot);
    if (!slot) return;
    this.state.data.lastDigestSlot = slot.id;
    this.state.save();
    if (now - slot.at > DIGEST_LATE_LIMIT_MS) {
      this.options.log(`digest ${slot.id} skipped (missed by ${Math.round((now - slot.at) / 60000)} min)`);
      return;
    }
    await this.say(await this.buildDigest(slot.label));
    this.state.data.lastDigestAt = now;
    this.state.save();
  }

  async buildDigest(label: string): Promise<string> {
    const now = this.now();
    const seats = new Set(Object.values(this.state.data.seats));
    const agents = (await this.paseo.listAgents(80)).filter(
      (agent) =>
        !agent.archivedAt &&
        !agent.labels["paseo.schedule-id"] &&
        agent.labels[ORCHESTRATOR_LABEL.key] !== ORCHESTRATOR_LABEL.orchestrator &&
        !seats.has(agent.id),
    );
    const since = this.state.data.lastDigestAt || now - 12 * 3600_000;
    const finishedAgents = agents.filter(
      (agent) => agent.status === "idle" && Date.parse(agent.attentionAt ?? agent.updatedAt) > since && !this.state.data.stalls[agent.id],
    );
    const finished = [];
    for (const [index, agent] of finishedAgents.entries()) {
      let decision: string | null = null;
      if (index < 8) {
        const timeline = await this.paseo.timeline(agent.id).catch((): AgentTimelineItem[] => []);
        decision = decisionLine(finalAssistantText(timeline));
      }
      finished.push({ agent, decision });
    }
    return renderDigest({
      now,
      slotLabel: label,
      running: agents.filter((agent) => agent.status === "running"),
      finished,
      waitingPermission: agents.filter((agent) => agent.attentionReason === "permission"),
      stalls: Object.values(this.state.data.stalls),
      usage: this.usage(),
      wakes: this.state.data.wakeLog.filter((wake) => wake.at > since),
    });
  }

  // ---------------------------------------------------------------- waiting workers

  /** Records one finished turn; a "waiting" ending becomes a pending wake. */
  private judgeWaiting(agent: AgentSummary, endedAt: number, finalText: string, waiting: WaitingVerdict): void {
    const known = this.state.data.wakes[agent.id];
    if (known && known.lastEndedAt >= endedAt - 5000) return;
    const verdict = detectStall(finalText, endedAt, this.usage()) ? null : waiting;
    const record = known ?? {
      agentId: agent.id,
      title: agent.title ?? shortId(agent.id),
      pendingSince: null,
      lastEndedAt: 0,
      reason: "",
      toolStillRunning: false,
      count: 0,
      lastWakeAt: 0,
    };
    record.lastEndedAt = endedAt;
    record.pendingSince = verdict?.waiting ? endedAt : null;
    record.reason = verdict?.reason ?? "한도 중단";
    record.toolStillRunning = verdict?.toolStillRunning ?? false;
    if (known || verdict?.waiting) this.state.data.wakes[agent.id] = record;
    this.state.save();
    if (verdict?.waiting) this.options.log(`waiting worker ${shortId(agent.id)}: ${verdict.reason}`);
  }

  private async noticeWaitingFromTurn(agent: HookAgent, outcome: TurnOutcome, finalText: string, timeline: readonly AgentTimelineItem[]): Promise<void> {
    const pending = this.state.data.wakes[agent.id];
    if (outcome.kind !== "completed") {
      if (pending) pending.pendingSince = null;
      return;
    }
    const verdict = waitingVerdict(finalText, timeline);
    if (!pending && !verdict.waiting) return;
    const summary = await this.paseo.getAgent(agent.id);
    if (this.resumable(summary)) this.judgeWaiting(summary, this.now(), finalText, verdict);
  }

  /** Catches waiting turns whose hook was missed. */
  async scanWaits(force = false): Promise<void> {
    const now = this.now();
    if (!force && now - this.state.data.lastWaitScanAt < 10 * 60 * 1000) return;
    this.state.data.lastWaitScanAt = now;
    this.state.save();
    let reads = 0;
    for (const agent of await this.paseo.listAgents(80)) {
      if (reads >= 12) break;
      if (!this.resumable(agent) || agent.status !== "idle") continue;
      const endedAt = Date.parse(agent.attentionAt ?? agent.updatedAt);
      if (!Number.isFinite(endedAt) || now - endedAt > 2 * 3600_000) continue;
      const known = this.state.data.wakes[agent.id];
      if (known && known.lastEndedAt >= endedAt - 5000) continue;
      if (agent.lastUserMessageAt && Date.parse(agent.lastUserMessageAt) > endedAt) continue;
      reads += 1;
      const timeline = await this.paseo.timeline(agent.id).catch((): AgentTimelineItem[] => []);
      const finalText = finalAssistantText(timeline);
      const verdict = waitingVerdict(finalText, timeline);
      if (verdict.waiting || known) this.judgeWaiting(agent, endedAt, finalText, verdict);
    }
  }

  async processWakes(): Promise<void> {
    const now = this.now();
    for (const record of Object.values(this.state.data.wakes)) {
      if (record.pendingSince === null || now - record.pendingSince < WAKE_AFTER_MS) continue;
      const agent = await this.paseo.getAgent(record.agentId);
      const drop = (why: string) => {
        record.pendingSince = null;
        this.options.log(`not waking ${shortId(record.agentId)}: ${why}`);
      };
      if (!this.resumable(agent)) {
        delete this.state.data.wakes[record.agentId];
        continue;
      }
      if (agent.status === "running" || agent.status === "initializing") {
        drop("it is running again");
        continue;
      }
      if (agent.lastUserMessageAt && Date.parse(agent.lastUserMessageAt) > record.pendingSince + 2000) {
        drop("someone prompted it");
        continue;
      }
      if (record.count >= WAKE_MAX) {
        drop(`already woken ${WAKE_MAX} times`);
        continue;
      }
      if (now - record.lastWakeAt < WAKE_BACKOFF_MS) continue;
      if (record.toolStillRunning && now - record.pendingSince < WAKE_RUNNING_TOOL_LIMIT_MS) {
        const still = (await this.paseo.timeline(record.agentId).catch((): AgentTimelineItem[] => [])).some(
          (item) => item.type === "tool_call" && item.status === "running",
        );
        if (still) continue;
      }
      try {
        this.lastPush.set(record.agentId, now);
        await this.paseo.send(record.agentId, WAKE_TEXT, []);
      } catch (error) {
        drop(errorText(error));
        continue;
      }
      record.count += 1;
      record.lastWakeAt = now;
      record.pendingSince = null;
      this.state.data.wakeLog = [...this.state.data.wakeLog, { agentId: record.agentId, title: record.title, at: now, count: record.count }].slice(-50);
      this.state.save();
      this.options.log(`woke waiting worker ${shortId(record.agentId)} (${record.count}/${WAKE_MAX})`);
      if (this.state.data.orchestratorId) {
        await this.queueNotice({
          id: `wake:${record.agentId}:${now}`,
          kind: "worker",
          text: `워커 ${shortId(record.agentId)} (${record.title})가 기다리다 멈춰서 깨웠어요 (${record.count}/${WAKE_MAX})`,
          imagePaths: [],
          at: now,
          messageIds: [],
        });
      }
    }
    for (const [id, record] of Object.entries(this.state.data.wakes)) {
      if (record.pendingSince === null && now - Math.max(record.lastEndedAt, record.lastWakeAt) > 3 * 24 * 3600_000) delete this.state.data.wakes[id];
    }
    this.state.save();
  }

  // ---------------------------------------------------------------- stalled sessions

  private usage(): UsageRows {
    try {
      return this.options.usage?.() ?? {};
    } catch {
      return {};
    }
  }

  /** Scheduled runs and the Telegram seats have their own recovery; everything else can be resumed. */
  private resumable(agent: AgentSummary | null): agent is AgentSummary {
    if (!agent || agent.archivedAt) return false;
    if (agent.labels["paseo.schedule-id"]) return false;
    if (agent.labels[ORCHESTRATOR_LABEL.key] === ORCHESTRATOR_LABEL.orchestrator) return false;
    return !Object.values(this.state.data.seats).includes(agent.id);
  }

  private recordStall(agent: AgentSummary, text: string, errorAt: number): boolean {
    const stall = detectStall(text, errorAt, this.usage());
    if (!stall) return false;
    const known = this.state.data.stalls[agent.id];
    if (known && known.errorAt >= errorAt - 5000) return true;
    if (agent.lastUserMessageAt && Date.parse(agent.lastUserMessageAt) > errorAt + 2000) return false;
    this.state.data.stalls[agent.id] = {
      agentId: agent.id,
      title: agent.title ?? shortId(agent.id),
      provider: agent.provider,
      errorAt,
      resetAt: stall.resetAt,
      message: stall.message,
      status: "waiting",
    };
    this.state.save();
    this.options.log(`stall recorded: ${shortId(agent.id)} resets ${stall.resetAt ? new Date(stall.resetAt).toISOString() : "unknown"}`);
    return true;
  }

  private async noticeStallFromTurn(agent: HookAgent, texts: string[]): Promise<void> {
    const text = texts.find((candidate) => detectStall(candidate, this.now(), this.usage()));
    if (!text) return;
    const summary = await this.paseo.getAgent(agent.id);
    if (this.resumable(summary)) this.recordStall(summary, text, this.now());
  }

  /** Catches stalls whose hook was missed (plugin restarts, older agents). */
  async scanStalls(force = false): Promise<void> {
    const now = this.now();
    if (!force && now - this.state.data.lastStallScanAt < STALL_SCAN_EVERY_MS) return;
    this.state.data.lastStallScanAt = now;
    this.state.save();
    let timelineReads = 0;
    for (const agent of await this.paseo.listAgents(80)) {
      if (!this.resumable(agent) || agent.status === "running" || agent.status === "initializing") continue;
      const at = Date.parse(agent.attentionAt ?? agent.updatedAt);
      if (!Number.isFinite(at) || now - at > STALL_WINDOW_MS) continue;
      const known = this.state.data.stalls[agent.id];
      if (known && known.errorAt >= at - 5000) continue;
      if (agent.lastError && this.recordStall(agent, agent.lastError, at)) continue;
      // Claude reports its limit as the turn's final text, not as an error.
      if (agent.provider === "claude" && timelineReads < 15) {
        timelineReads += 1;
        const timeline = await this.paseo.timeline(agent.id).catch((): AgentTimelineItem[] => []);
        for (const text of [finalAssistantText(timeline), ...latestErrors(timeline)]) {
          if (this.recordStall(agent, text, at)) break;
        }
      }
    }
  }

  async processStalls(): Promise<void> {
    const now = this.now();
    const records = Object.values(this.state.data.stalls);
    for (const record of records) {
      if (record.status === "waiting" && record.resetAt === null) {
        record.resetAt = detectStall(record.message, record.errorAt, this.usage())?.resetAt ?? null;
      }
      if (record.status === "resuming" && now - (record.resumedAt ?? 0) > 60_000) {
        const agent = await this.paseo.getAgent(record.agentId);
        if (!agent || (agent.status !== "running" && agent.status !== "initializing")) record.status = "done";
      }
      if ((record.status === "done" || record.status === "skipped") && now - record.errorAt > 3 * STALL_WINDOW_MS) {
        delete this.state.data.stalls[record.agentId];
      }
    }
    let active = records.filter((record) => record.status === "resuming").length;
    const due = records
      .filter((record) => record.status === "waiting" && record.resetAt !== null && now >= record.resetAt + RESUME_GRACE_MS)
      .sort((left, right) => (left.resetAt ?? 0) - (right.resetAt ?? 0));
    const started: string[] = [];
    for (const record of due) {
      if (active >= MAX_CONCURRENT_RESUMES) break;
      const agent = await this.paseo.getAgent(record.agentId);
      const skip = !this.resumable(agent)
        ? "보관됐거나 대상 아님"
        : agent.status === "running"
          ? "이미 실행 중"
          : agent.lastUserMessageAt && Date.parse(agent.lastUserMessageAt) > record.errorAt + 2000
            ? `${ownerWith("이", "가")} 이미 다시 지시함`
            : null;
      if (skip) {
        record.status = "skipped";
        record.reason = skip;
        continue;
      }
      try {
        this.lastPush.set(record.agentId, now);
        await this.paseo.send(record.agentId, RESUME_TEXT, []);
        record.status = "resuming";
        record.resumedAt = now;
        active += 1;
        started.push(`${record.title.slice(0, 30)}(${shortId(record.agentId)})`);
      } catch (error) {
        record.status = "skipped";
        record.reason = errorText(error).slice(0, 120);
      }
    }
    this.state.save();
    if (started.length) {
      const waiting = Object.values(this.state.data.stalls).filter((record) => record.status === "waiting").length;
      await this.say(
        t(
          `▶️ 한도가 풀려서 멈췄던 세션 ${started.length}개를 이어서 돌렸어요: ${escapeHtml(started.join(", "))}${waiting ? ` (대기 ${waiting}개)` : ""}`,
          `▶️ Limits reset, so I resumed ${started.length} stopped session(s): ${escapeHtml(started.join(", "))}${waiting ? ` (${waiting} still waiting)` : ""}`,
        ),
      );
    }
  }

  /** While a backup answers, probe the main seat on schedule. */
  private async probeMain(): Promise<void> {
    const fallback = this.state.data.fallback;
    const mainId = this.state.data.seats.main;
    if (this.state.data.seat === 0 || !fallback || !mainId) return;
    const now = this.now();
    if (fallback.probeSentAt) {
      if (now - fallback.probeSentAt > PROBE_TIMEOUT_MS) this.probeFailed("응답 없음");
      return;
    }
    if (now < fallback.retryAt) return;
    fallback.probeSentAt = now;
    this.state.save();
    try {
      await this.paseo.send(mainId, PROBE_TEXT, []);
      this.options.log("probing main seat");
    } catch (error) {
      this.probeFailed(errorText(error));
    }
  }

  private probeFailed(reason: string): void {
    const fallback = this.state.data.fallback;
    if (!fallback) return;
    fallback.attempts += 1;
    fallback.probeSentAt = null;
    fallback.retryAt = this.now() + retryDelay(fallback.attempts);
    this.state.save();
    this.options.log(`main seat still unavailable (${reason.slice(0, 120)}); next probe in ${Math.round(retryDelay(fallback.attempts) / 60000)} min`);
  }

  private async sendToAgent(agentId: string, content: Content, sourceMessageId: number): Promise<void> {
    this.lastPush.set(agentId, this.now());
    await this.paseo.send(agentId, content.replyContext ? `${content.replyContext}\n${content.text}` : content.text, content.images);
    this.state.setFollow(agentId, true);
    this.markRunning(agentId);
    await this.acknowledge(sourceMessageId);
  }

  // ---------------------------------------------------------------- commands

  private async resolve(ref: string): Promise<AgentSummary | null> {
    const agents = await this.paseo.listAgents(60);
    const result = resolveAgentRef(ref, agents, this.state.data.lastListing);
    if (result.kind === "found") {
      return agents.find((agent) => agent.id === result.agent.id) ?? (await this.paseo.getAgent(result.agent.id));
    }
    if (result.kind === "ambiguous") {
      const list = result.candidates.map((agent) => `• <code>${shortId(agent.id)}</code> ${escapeHtml(agent.title ?? "")}`);
      await this.say(t(`여러 세션이 맞아요. 더 길게 적어 주세요:\n${list.join("\n")}`, `Several sessions match. Type more of the id:\n${list.join("\n")}`));
    } else {
      await this.say(t(`세션을 못 찾았어요: <code>${escapeHtml(ref)}</code>\n/ls 로 번호를 확인하세요.`, `No session found: <code>${escapeHtml(ref)}</code>\nCheck the numbers with /ls.`));
    }
    return null;
  }

  private label(agent: AgentSummary): string {
    return escapeHtml(agent.title ?? shortId(agent.id));
  }

  private async handleCommand(command: ParsedCommand, message: TgMessage): Promise<void> {
    const { name, args } = command;
    switch (name) {
      case "start":
      case "help":
        await this.say(helpText());
        return;
      case "ls":
        await this.listAgents();
        return;
      case "to": {
        const [ref, rest] = splitFirst(args);
        if (!ref || !rest) {
          await this.say(t("사용법: <code>/to 번호 메시지</code>", "Usage: <code>/to number message</code>"));
          return;
        }
        const agent = await this.resolve(ref);
        if (agent) await this.sendToAgent(agent.id, { text: rest, images: [], imagePaths: [] }, message.message_id);
        return;
      }
      case "peek": {
        const agent = args ? await this.resolve(args) : null;
        if (!args) await this.say(t("사용법: <code>/peek 번호</code>", "Usage: <code>/peek number</code>"));
        if (agent) await this.peek(agent);
        return;
      }
      case "follow":
      case "unfollow": {
        const agent = args ? await this.resolve(args) : null;
        if (!args) await this.say(t(`사용법: <code>/${name} 번호</code>`, `Usage: <code>/${name} number</code>`));
        if (!agent) return;
        this.state.setFollow(agent.id, name === "follow");
        await this.say(
          name === "follow"
            ? t(`🔔 <b>${this.label(agent)}</b> 답을 텔레그램으로 받아요.`, `🔔 You'll get <b>${this.label(agent)}</b>'s replies here.`)
            : t(`🔕 <b>${this.label(agent)}</b> 따라가기를 끊었어요.`, `🔕 Stopped following <b>${this.label(agent)}</b>.`),
        );
        return;
      }
      case "stop": {
        const agent = args
          ? await this.resolve(args)
          : this.state.data.orchestratorId
            ? await this.paseo.getAgent(this.state.data.orchestratorId)
            : null;
        if (!agent) {
          if (!args) await this.say(t("멈출 오케 세션이 없어요.", "No orchestrator session to stop."));
          return;
        }
        this.lastPush.set(agent.id, this.now());
        await this.paseo.stop(agent.id);
        this.markStopped(agent.id);
        await this.say(t(`⏹ 중단 요청을 보냈어요: <b>${this.label(agent)}</b>`, `⏹ Stop requested: <b>${this.label(agent)}</b>`));
        return;
      }
      case "status":
        await this.status();
        return;
      case "new":
        delete this.state.data.seats[SEAT_CHAIN[this.state.data.seat].key];
        this.state.data.orchestratorId = null;
        this.state.save();
        await this.say(t("다음 메시지부터 새 오케 세션으로 시작해요. 이전 세션은 Paseo에 그대로 남아 있어요.", "Your next message starts a fresh orchestrator session. The old one stays in Paseo."));
        return;
      case "backup":
        if (this.state.data.seat >= SEAT_CHAIN.length - 1) await this.say(t("이미 마지막 백업 좌석이에요.", "Already on the last backup seat."));
        else await this.fallback(t("수동 전환", "manual switch"));
        return;
      case "main":
        await this.returnToMain(true);
        return;
      case "model":
        await this.switchModel(args);
        return;
      case "rotate":
        await this.rotate("manual");
        return;
      case "digest":
        await this.say(await this.buildDigest(t("지금 요약", "Digest now")));
        return;
      case "usage":
        // An explicit owner request can recover a send whose reply was lost.
        if (this.state.data.usagePanelSendPending && this.state.data.usagePanelMessageId === null) {
          this.state.data.usagePanelSendPending = false;
          this.state.save();
          await this.refreshUsagePanel(true);
          return;
        }
        await this.showUsage();
        return;
      case "alerts": {
        const on = /^(on|켜|켜기)$/i.test(args) ? true : /^(off|꺼|끄기)$/i.test(args) ? false : !this.state.data.alertsAll;
        this.state.data.alertsAll = on;
        this.state.save();
        await this.say(
          on
            ? t("🔔 모든 세션의 권한·질문 요청을 받아요.", "🔔 You'll get permission and question requests from every session.")
            : t("🔕 오케와 따라가는 세션의 요청만 받아요.", "🔕 Only requests from the orchestrator and followed sessions now."),
        );
        return;
      }
      default:
        await this.say(t("모르는 명령이에요. /help에서 명령어를 확인해 주세요.", "Unknown command. See /help."));
    }
  }

  private async switchModel(args: string): Promise<void> {
    const orchestrator = this.state.data.orchestratorId ? await this.paseo.getAgent(this.state.data.orchestratorId) : null;
    const wanted = args.trim().toLowerCase();
    if (!wanted) {
      const aliases = Object.keys(MODEL_ALIASES).join(" | ");
      await this.say(
        t(
          `지금 오케 모델: <b>${escapeHtml(orchestrator?.model ?? this.state.data.model ?? "프로필 기본값")}</b>\n바꾸기: <code>/model ${aliases}</code>`,
          `Orchestrator model: <b>${escapeHtml(orchestrator?.model ?? this.state.data.model ?? "profile default")}</b>\nSwitch: <code>/model ${aliases}</code>`,
        ),
      );
      return;
    }
    const model = MODEL_ALIASES[wanted] ?? (wanted.startsWith("claude-") ? wanted : null);
    if (!model) {
      const examples = Object.keys(MODEL_ALIASES).map((alias) => `<code>/model ${escapeHtml(alias)}</code>`);
      await this.say(
        t(
          `모르는 모델이에요: <code>${escapeHtml(args)}</code>\n${examples.join(" 또는 ")}`,
          `Unknown model: <code>${escapeHtml(args)}</code>\n${examples.join(" or ")}`,
        ),
      );
      return;
    }
    this.state.data.model = model;
    this.state.save();
    if (this.state.data.seat === 0 && orchestrator && !orchestrator.archivedAt && orchestrator.provider === "claude") {
      await this.paseo.setModel(orchestrator.id, model);
      await this.say(t(`🧠 오케 모델을 <b>${escapeHtml(model)}</b>로 바꿨어요. 대화는 그대로 이어져요.`, `🧠 Switched the orchestrator to <b>${escapeHtml(model)}</b>. The conversation continues.`));
    } else {
      await this.say(t(`🧠 메인 오케 좌석의 모델을 <b>${escapeHtml(model)}</b>로 정했어요. 메인 세션을 새로 만들 때부터 적용돼요.`, `🧠 Set the main seat's model to <b>${escapeHtml(model)}</b>. It applies when the main session is next created.`));
    }
  }

  private async listAgents(): Promise<void> {
    const agents = (await this.paseo.listAgents(15)).filter((agent) => agent.status !== "closed");
    this.state.data.lastListing = agents.map((agent) => agent.id);
    this.state.save();
    if (!agents.length) {
      await this.say(t("최근 세션이 없어요.", "No recent sessions."));
      return;
    }
    const lines = agents.map((agent, index) => {
      const marks = [
        agent.id === this.state.data.orchestratorId ? "🎛" : "",
        this.state.isFollowed(agent.id) ? "🔔" : "",
        agent.attentionReason === "permission" ? "✋" : "",
      ].join("");
      const model = agent.model ?? agent.provider;
      return `${index + 1}. ${STATUS_EMOJI[agent.status] ?? "•"} <b>${escapeHtml((agent.title ?? t("(제목 없음)", "(untitled)")).slice(0, 48))}</b> ${marks}\n    <code>${shortId(agent.id)}</code> · ${escapeHtml(model)} · ${timeAgo(agent.updatedAt)}`;
    });
    await this.say(`${lines.join("\n")}\n\n${t("<i>/to 번호 메시지 · /peek 번호</i>", "<i>/to number message · /peek number</i>")}`);
  }

  private async peek(agent: AgentSummary): Promise<void> {
    const text = finalAssistantText(await this.paseo.timeline(agent.id));
    const status = `${STATUS_EMOJI[agent.status] ?? ""} ${agent.status} · ${timeAgo(agent.updatedAt)}`;
    await this.deliver(agent.id, this.header(agent.id, agent.title, status), text || t("(아직 답이 없어요)", "(no reply yet)"));
  }

  private async status(): Promise<void> {
    const id = this.state.data.orchestratorId;
    const agent = id ? await this.paseo.getAgent(id) : null;
    const lines = [
      t("<b>텔레그램 오케 상태</b>", "<b>Orchestrator status</b>"),
      agent
        ? t("오케: ", "Orchestrator: ") +
          `<code>${shortId(agent.id)}</code> · ${STATUS_EMOJI[agent.status] ?? ""} ${agent.status} · ${escapeHtml(agent.model ?? agent.provider)}`
        : t("오케: 아직 없음 (다음 메시지에서 만들어요)", "Orchestrator: none yet (your next message creates it)"),
      t(
        `좌석: <b>${escapeHtml(this.seatLabel())}</b> (순서: ${SEAT_CHAIN.map((seat) => escapeHtml(seat.label)).join(" → ")})`,
        `Seat: <b>${escapeHtml(this.seatLabel())}</b> (order: ${SEAT_CHAIN.map((seat) => escapeHtml(seat.label)).join(" → ")})`,
      ),
      ...(this.state.data.fallback
        ? [
            t(
              `백업 전환: ${timeAgo(new Date(this.state.data.fallback.since).toISOString(), this.now())} · 사유: ${escapeHtml(this.state.data.fallback.reason.slice(0, 120))}`,
              `On backup since: ${timeAgo(new Date(this.state.data.fallback.since).toISOString(), this.now())} · reason: ${escapeHtml(this.state.data.fallback.reason.slice(0, 120))}`,
            ),
            t(
              `메인 복구 확인: ${this.state.data.fallback.probeSentAt ? "확인 중" : `${Math.max(0, Math.round((this.state.data.fallback.retryAt - this.now()) / 60000))}분 뒤`}`,
              `Main seat check: ${this.state.data.fallback.probeSentAt ? "in progress" : `in ${Math.max(0, Math.round((this.state.data.fallback.retryAt - this.now()) / 60000))} min`}`,
            ),
          ]
        : []),
      t(`따라가는 세션: ${this.state.data.follow.length}개`, `Followed sessions: ${this.state.data.follow.length}`),
      t(`모든 세션 요청 알림: ${this.state.data.alertsAll ? "켜짐" : "꺼짐"}`, `Requests from every session: ${this.state.data.alertsAll ? "on" : "off"}`),
    ];
    await this.say(lines.join("\n"));
  }

  // ---------------------------------------------------------------- permissions & questions

  private async handleCallback(query: TgCallbackQuery): Promise<void> {
    if (!this.authorized(query.from.id, query.message?.chat.id)) {
      await this.telegram.answerCallback(query.id).catch(() => {});
      return;
    }
    if (query.data === "usage:refresh") {
      await this.telegram.answerCallback(query.id, t("사용량을 확인하고 있어요", "Checking usage…"));
      if (this.state.data.usagePanelSendPending && this.state.data.usagePanelMessageId === null) {
        // The owner clicked the delivered card, proving which message Telegram accepted.
        this.state.data.usagePanelMessageId = query.message!.message_id;
        this.state.data.usagePanelSendPending = false;
        this.state.data.usagePanelPinned = false;
        this.state.save();
      }
      if (query.message!.message_id === this.state.data.usagePanelMessageId) await this.refreshUsagePanel(true);
      else await this.showUsage(query.message!.message_id);
      return;
    }
    const [kind, token, rawIndex] = (query.data ?? "").split(":");
    const pending = token ? this.state.data.pending[token] : undefined;
    if (!pending) {
      await this.telegram.answerCallback(query.id, t("이미 처리된 요청이에요", "Already handled"));
      return;
    }
    const index = Number(rawIndex);
    if (kind === "p") {
      const action = pending.actions?.[index];
      if (!action) return;
      await this.resolvePending(token, pending, actionResponse(action), `→ ${action.label}`);
      await this.telegram.answerCallback(query.id, action.label);
      return;
    }
    if (kind === "q") {
      const question = pending.questions?.[pending.index ?? 0];
      const option = question?.options[index];
      if (!option) return;
      await this.telegram.answerCallback(query.id, option);
      await this.answerQuestion(token, pending, option);
    }
  }

  private async answerPendingWithText(token: string, pending: PendingRequest, text: string): Promise<void> {
    if (pending.kind === "question") {
      await this.answerQuestion(token, pending, text);
    } else {
      await this.resolvePending(token, pending, denyWithMessage(text), t(`→ 거부: ${text}`, `→ Denied: ${text}`));
    }
  }

  private async closePrompt(pending: PendingRequest, outcome: string): Promise<void> {
    const messageId = pending.messageIds[pending.messageIds.length - 1];
    await this.telegram
      .editMessage(messageId, `${pending.html}\n\n<b>${escapeHtml(outcome)}</b>`, { html: true })
      .catch((error) => this.options.log(`edit prompt failed: ${errorText(error)}`));
  }

  private async resolvePending(
    token: string,
    pending: PendingRequest,
    response: Parameters<PaseoPort["respond"]>[2],
    outcome: string,
  ): Promise<void> {
    this.resolving.add(token);
    try {
      await this.paseo.respond(pending.agentId, pending.requestId, response);
    } finally {
      this.resolving.delete(token);
    }
    this.state.dropPending(token);
    await this.closePrompt(pending, outcome);
  }

  private async answerQuestion(token: string, pending: PendingRequest, answer: string): Promise<void> {
    const questions = pending.questions ?? [];
    const position = pending.index ?? 0;
    const question = questions[position];
    if (!question) return;
    pending.answers = { ...pending.answers, [question.question]: answer };
    pending.index = position + 1;

    const next = questions[pending.index];
    if (!next) {
      await this.resolvePending(token, pending, answerResponse(pending.answers), `→ ${answer}`);
      return;
    }
    await this.closePrompt(pending, `→ ${answer}`);
    const html = this.promptHeader(pending.agentId) + questionHtml(next, pending.index, questions.length);
    const messageId = await this.sendButtons(html, optionButtons(token, next));
    pending.messageIds.push(messageId);
    pending.html = html;
    this.state.save();
  }

  private promptHeader(agentId: string, title?: string | null): string {
    if (agentId === this.state.data.orchestratorId) return "";
    return `🔹 <b>${escapeHtml(title ?? shortId(agentId))}</b> <code>${shortId(agentId)}</code>\n`;
  }

  async onPermissionRequested(agent: HookAgent, request: AgentPermissionRequest): Promise<void> {
    if (this.isWorker(agent) && (await this.seatOwnsNotices(this.state.data.orchestratorId))) {
      const questions = request.kind === "question" ? questionsOf(request) : null;
      const what = questions
        ? `질문: ${questions.map((question) => question.question).join(" / ")}`
        : `${request.title ?? request.name}${request.description ? ` — ${request.description.slice(0, 200)}` : ""}`;
      await this.queueNotice({
        id: `perm:${agent.id}:${request.id}`,
        kind: "permission",
        text: `워커 ${shortId(agent.id)} (${agent.title ?? ""})가 승인을 기다려요 (request ${request.id}): ${what}`,
        imagePaths: [],
        at: this.now(),
        messageIds: [],
      });
    }
    if (!(await this.shouldForward(agent.id, true))) return;
    if (this.state.pendingByRequest(agent.id, request.id)) return;
    const token = randomBytes(5).toString("base64url");
    const header = this.promptHeader(agent.id, agent.title);
    const questions = request.kind === "question" ? questionsOf(request) : null;
    let html: string;
    let buttons: InlineButton[][];
    if (questions) {
      html = header + questionHtml(questions[0], 0, questions.length);
      buttons = optionButtons(token, questions[0]);
    } else {
      html = `${header}${t("✋ <b>승인 요청</b>", "✋ <b>Approval request</b>")}\n${describeRequest(request)}\n${t(
        "<i>거부하며 할 말은 이 메시지에 답장으로 보내세요.</i>",
        "<i>To deny with a note, reply to this message.</i>",
      )}`;
      buttons = actionButtons(token, actionsOf(request));
    }
    const messageId = await this.sendButtons(html, buttons);
    this.state.addPending(token, {
      agentId: agent.id,
      requestId: request.id,
      kind: questions ? "question" : "permission",
      messageIds: [messageId],
      html,
      actions: questions ? undefined : actionsOf(request),
      questions: questions ?? undefined,
      answers: questions ? {} : undefined,
      index: questions ? 0 : undefined,
      createdAt: this.now(),
    });
    this.state.rememberMessage(messageId, agent.id);
  }

  async onPermissionResolved(agentId: string, requestId: string): Promise<void> {
    const entry = this.state.pendingByRequest(agentId, requestId);
    if (!entry || this.resolving.has(entry[0])) return;
    this.state.dropPending(entry[0]);
    await this.closePrompt(entry[1], t("다른 곳에서 처리됨", "Handled elsewhere"));
  }

  // ---------------------------------------------------------------- turns

  private isTracked(agentId: string): boolean {
    return agentId === this.state.data.orchestratorId || this.state.isFollowed(agentId);
  }

  private async shouldForward(agentId: string, isPermission: boolean): Promise<boolean> {
    if (this.isTracked(agentId)) return true;
    if (isPermission && this.state.data.alertsAll) return true;
    const agent = await this.paseo.getAgent(agentId);
    return agent?.labels[ORCHESTRATOR_LABEL.key] === ORCHESTRATOR_LABEL.follow;
  }

  onTurnStarted(agentId: string): void {
    if (this.isTracked(agentId)) this.markRunning(agentId);
    const waiting = this.state.data.wakes[agentId];
    if (waiting?.pendingSince) {
      // It woke up by itself (its background job finished, or someone prompted it).
      waiting.pendingSince = null;
      this.state.save();
    }
  }

  /** The seat finished a turn: hand it what queued up meanwhile, or rotate if asked. */
  private async seatIdle(outcome: TurnOutcome): Promise<void> {
    // Our own interrupt cancels the old turn while the new one starts: still busy.
    const selfInterrupt =
      outcome.kind === "canceled" && this.now() - (this.lastPush.get(this.state.data.orchestratorId ?? "") ?? 0) < STEER_WINDOW_MS;
    if (selfInterrupt) return;
    this.deliveredAt = 0;
    this.options.queue.setInFlight(null);
    if (this.options.queue.length) await this.scheduleFlush();
    else if (this.state.data.pendingRotate) await this.rotate("manual");
  }

  private async onWorkerTurnEnded(agent: HookAgent, outcome: TurnOutcome, finalText: string): Promise<void> {
    const name = agent.title ?? shortId(agent.id);
    const result =
      outcome.kind === "completed"
        ? `턴 완료: ${finalText.slice(0, 600) || "(텍스트 없음)"}`
        : outcome.kind === "failed"
          ? `실패: ${outcome.error.message.slice(0, 300)}`
          : "중단됨";
    await this.queueNotice({
      id: `worker:${agent.id}:${this.now()}`,
      kind: "worker",
      text: `워커 ${shortId(agent.id)} (${name}) ${result}`,
      imagePaths: [],
      at: this.now(),
      messageIds: [],
    });
  }

  async onTurnEnded(agent: HookAgent, outcome: TurnOutcome, timeline: readonly AgentTimelineItem[]): Promise<void> {
    this.markStopped(agent.id);
    const errors = latestErrors(timeline);
    const finalText = finalAssistantText(timeline);

    // The reply to a probe of the main seat decides whether to return to it; the owner never sees it.
    const probe = this.state.data.fallback?.probeSentAt;
    if (probe && this.state.data.seat !== 0 && agent.id === this.state.data.seats.main) {
      if (outcome.kind === "completed" && !looksUnavailable(finalText, errors)) await this.returnToMain(false);
      else this.probeFailed(outcome.kind === "failed" ? outcome.error.message : finalText || outcome.kind);
      return;
    }

    const isOrchestrator = agent.id === this.state.data.orchestratorId;
    if (!isOrchestrator && !Object.values(this.state.data.seats).includes(agent.id)) {
      await this.noticeStallFromTurn(agent, [finalText, ...errors, outcome.kind === "failed" ? outcome.error.message : ""]);
      await this.noticeWaitingFromTurn(agent, outcome, finalText, timeline);
    }
    if (!isOrchestrator && this.isWorker(agent) && (await this.seatOwnsNotices(this.state.data.orchestratorId))) {
      await this.onWorkerTurnEnded(agent, outcome, finalText);
    }
    if (isOrchestrator) {
      this.trackWorkers(timeline);
      if (agent.id === this.state.data.silentTurn) {
        // The rotation handoff ack is for the bridge, not for the owner.
        this.state.data.silentTurn = null;
        this.state.save();
        await this.seatIdle(outcome);
        return;
      }
      if (outcome.kind === "failed") {
        await this.fallback(outcome.error.message);
        return;
      }
      if (outcome.kind === "completed") {
        if (looksUnavailable(finalText, errors)) {
          await this.fallback(finalText || errors.join("; "));
          return;
        }
        if (this.state.data.lastPrompt) this.state.data.lastPrompt.answered = true;
        this.state.save();
      }
    }
    await this.forwardTurn(agent, outcome, finalText, errors, isOrchestrator);
    if (isOrchestrator) await this.seatIdle(outcome);
  }

  private async forwardTurn(agent: HookAgent, outcome: TurnOutcome, finalText: string, errors: string[], isOrchestrator: boolean): Promise<void> {
    if (!(await this.shouldForward(agent.id, false))) return;
    const name = escapeHtml(agent.title ?? shortId(agent.id));
    if (outcome.kind === "failed") {
      await this.say(t(`⚠️ <b>${name}</b> 턴 실패: ${escapeHtml(outcome.error.message)}`, `⚠️ <b>${name}</b> turn failed: ${escapeHtml(outcome.error.message)}`), undefined, agent.id);
      return;
    }
    if (outcome.kind === "canceled") {
      const pushedAt = this.lastPush.get(agent.id) ?? 0;
      if (this.now() - pushedAt > STEER_WINDOW_MS) await this.say(t(`⏹ <b>${name}</b> 중단됨`, `⏹ <b>${name}</b> stopped`), undefined, agent.id);
      return;
    }
    if (isOrchestrator && isSilentReply(finalText)) {
      this.options.log("orchestrator turn ended with a silent reply; nothing sent");
      return;
    }
    const text = finalText || (errors.length ? `⚠️ ${errors.join("\n")}` : t("(답변 텍스트 없이 턴이 끝났어요)", "(the turn ended without any reply text)"));
    await this.deliver(agent.id, isOrchestrator ? undefined : this.header(agent.id, agent.title), text);
  }

  private header(agentId: string, title: string | null, detail?: string): { html: string; plain: string } {
    const name = title ?? shortId(agentId);
    const extra = detail ? ` · ${detail}` : "";
    return {
      html: `🔹 <b>${escapeHtml(name)}</b> <code>${shortId(agentId)}</code>${escapeHtml(extra)}\n\n`,
      plain: `🔹 ${name} (${shortId(agentId)})${extra}\n\n`,
    };
  }

  private async checkFile(path: string): Promise<string | null> {
    if (!isAbsolute(path)) return t("절대 경로가 아님", "not an absolute path");
    const full = resolve(path);
    if (!full.startsWith(`${this.options.homeDir}/`)) return t("홈 폴더 밖", "outside the home folder");
    if (SECRET_PATH.test(full.slice(this.options.homeDir.length)) || SECRET_NAME.test(basename(full))) {
      return t("비밀 정보가 있을 수 있는 경로", "path may hold secrets");
    }
    try {
      const info = await stat(full);
      if (!info.isFile()) return t("파일이 아님", "not a file");
      if (info.size > FILE_LIMIT) return t("50MB 초과", "over 50 MB");
    } catch {
      return t("파일 없음", "file not found");
    }
    return null;
  }

  private async deliver(agentId: string, header: { html: string; plain: string } | undefined, markdown: string): Promise<void> {
    const { text, files } = extractFileMarkers(markdown);
    if (text || !files.length) {
      for (const chunk of renderMessages(text || " ", header)) {
        this.state.rememberMessage(await this.sendRendered(chunk), agentId);
      }
    }
    for (const file of files) {
      const problem = await this.checkFile(file);
      if (problem) {
        await this.say(t(`⚠️ 파일을 보낼 수 없어요 (${problem}): <code>${escapeHtml(file)}</code>`, `⚠️ Can't send the file (${problem}): <code>${escapeHtml(file)}</code>`), undefined, agentId);
        continue;
      }
      try {
        this.state.rememberMessage(await this.telegram.sendFile(resolve(file)), agentId);
      } catch (error) {
        await this.say(t(`⚠️ 파일 전송 실패: ${escapeHtml(errorText(error))}`, `⚠️ File upload failed: ${escapeHtml(errorText(error))}`), undefined, agentId);
      }
    }
  }

  // ---------------------------------------------------------------- typing indicator

  private markRunning(agentId: string): void {
    this.running.add(agentId);
    if (this.typingTimer) return;
    this.typingSince = this.now();
    void this.telegram.sendTyping().catch(() => {});
    this.typingTimer = setInterval(() => {
      if (this.now() - this.typingSince > TYPING_MAX_MS) {
        this.clearTyping();
        return;
      }
      void this.telegram.sendTyping().catch(() => {});
    }, TYPING_INTERVAL_MS);
  }

  private markStopped(agentId: string): void {
    this.running.delete(agentId);
    if (!this.running.size) this.clearTyping();
  }

  private clearTyping(): void {
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.typingTimer = null;
  }

  // ---------------------------------------------------------------- sending

  private async sendRendered(chunk: RenderedChunk, replyTo?: number, silent = false): Promise<number> {
    try {
      return await this.telegram.sendMessage(chunk.html, { html: true, replyTo, silent: silent || undefined });
    } catch (error) {
      if (error instanceof TelegramError && error.isParseError) {
        this.options.log("HTML rejected by Telegram; sent as plain text");
        return this.telegram.sendMessage(chunk.plain, { replyTo, silent: silent || undefined });
      }
      throw error;
    }
  }

  private async sendButtons(html: string, buttons: InlineButton[][]): Promise<number> {
    try {
      return await this.telegram.sendMessage(html, { html: true, buttons });
    } catch (error) {
      if (!(error instanceof TelegramError && error.isParseError)) throw error;
      return this.telegram.sendMessage(htmlToPlain(html), { buttons });
    }
  }

  /** Short HTML status line from the bridge itself; mapped to an agent when given. */
  private async say(html: string, replyTo?: number, agentId?: string, silent = false): Promise<void> {
    const messageId = await this.sendRendered({ html, plain: htmlToPlain(html) }, replyTo, silent);
    if (agentId) this.state.rememberMessage(messageId, agentId);
  }

  stop(): void {
    this.stopped = true;
    this.clearTyping();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.permissionTimer) clearTimeout(this.permissionTimer);
    for (const album of this.albums.values()) clearTimeout(album.timer);
    this.albums.clear();
  }
}
