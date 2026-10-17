import { SETTINGS } from "./config.ts";
import { owner } from "./i18n.ts";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Messages for the orchestrator seat wait here instead of interrupting its turn.
// Kept on disk so a plugin or daemon restart never loses one.

export type QueueKind = "owner" | "worker" | "permission";

export interface QueuedItem {
  /** Stable id: "tg:<update_id>", "worker:<agent>:<turn>", "perm:<agent>:<request>". */
  id: string;
  kind: QueueKind;
  /** Overrides the kind's label in the batch line. */
  label?: string;
  text: string;
  /** Saved photos to attach again at delivery time (paths, not bytes). */
  imagePaths: string[];
  at: number;
  /** The owner's Telegram message ids this item came from. */
  messageIds: number[];
}

export interface InFlightBatch {
  text: string;
  messageIds: number[];
  startedAt: number;
}

export interface QueueData {
  items: QueuedItem[];
  /** The batch the seat is working on, kept so a correction can quote it. */
  inFlight: InFlightBatch | null;
  /** Recent Telegram update ids, so a replayed update is not queued twice. */
  seenUpdates: number[];
}

const SEEN_LIMIT = 500;

export class QueueStore {
  readonly data: QueueData = { items: [], inFlight: null, seenUpdates: [] };
  private readonly file: string | null;

  constructor(file: string | null) {
    this.file = file;
    if (!file) return;
    try {
      Object.assign(this.data, JSON.parse(readFileSync(file, "utf8")) as Partial<QueueData>);
    } catch {
      // first run or unreadable: start empty
    }
  }

  save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data));
    renameSync(`${this.file}.tmp`, this.file);
  }

  /** False when the id (or any of its Telegram updates) was already queued. */
  push(item: QueuedItem, updateIds: readonly number[] = []): boolean {
    if (updateIds.some((id) => this.data.seenUpdates.includes(id))) return false;
    if (this.data.items.some((existing) => existing.id === item.id)) return false;
    this.data.seenUpdates.push(...updateIds);
    if (this.data.seenUpdates.length > SEEN_LIMIT) this.data.seenUpdates.splice(0, this.data.seenUpdates.length - SEEN_LIMIT);
    this.data.items.push(item);
    this.save();
    return true;
  }

  /** Drops delivered items only after the send succeeded, so a crash re-delivers instead of losing. */
  remove(ids: readonly string[]): void {
    this.data.items = this.data.items.filter((item) => !ids.includes(item.id));
    this.save();
  }

  setInFlight(batch: InFlightBatch | null): void {
    this.data.inFlight = batch;
    this.save();
  }

  get length(): number {
    return this.data.items.length;
  }
}

// ---------------------------------------------------------------- corrections

// Unambiguous "stop, I meant something else" openers. "아니"/"잠깐" count only
// with a comma or a line break after them: "아니 근데 이것도…" is a new thought.
const CORRECTION = /^\s*(취소|멈춰|급해|stop\b|cancel\b|\/now\b)|^\s*(아니|잠깐|wait|hold on)\s*(,|\n)/i;

export function isCorrectionText(text: string): boolean {
  return CORRECTION.test(text);
}

/** "/now 이거 먼저" → "이거 먼저"; everything else is kept as typed. */
export function stripNow(text: string): string {
  return text.replace(/^\s*\/now\b\s*/i, "");
}

/** When an idle seat should get the batch: `debounce` after the owner's last message, at most `cap` after the first. */
export function flushDueAt(items: readonly QueuedItem[], now: number, debounce: number, cap: number): number {
  const typed = items.filter((item) => item.kind === "owner").map((item) => item.at);
  if (!typed.length) return now;
  return Math.min(Math.max(...typed) + debounce, Math.min(...typed) + cap);
}

// ---------------------------------------------------------------- prompts

export const STALE_BATCH_MS = 15 * 60 * 1000;

export function clock(ms: number, timeZone = SETTINGS.timeZone): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);
}

const LABEL: Record<Exclude<QueueKind, "owner">, string> = { worker: "Paseo 알림", permission: "Paseo 권한 요청" };

/** The batch-line label; the owner's own messages carry their name. */
function kindLabel(kind: QueueKind): string {
  return kind === "owner" ? owner() : LABEL[kind];
}

/** One prompt for everything queued, oldest first. A single owner message keeps the plain framing. */
export function formatBatch(items: readonly QueuedItem[], now: number): string {
  if (items.length === 1 && items[0].kind === "owner") return `[텔레그램] ${items[0].text}`;
  const oldest = Math.min(...items.map((item) => item.at));
  const stale = now - oldest > STALE_BATCH_MS ? ` (대기 중 쌓인 메시지 ${items.length}개)` : "";
  const lines = items.map((item) => `[${clock(item.at)} ${item.label ?? kindLabel(item.kind)}] ${item.text}`);
  return [`[텔레그램] 메시지 ${items.length}개, 순서대로${stale}:`, ...lines].join("\n");
}

/** Sent when a correction interrupts the running turn. */
export function correctionPrompt(original: string | null, items: readonly QueuedItem[], now: number): string {
  return [
    "[텔레그램 · 수정 지시로 이전 턴 중단]",
    `방금 하던 턴은 ${owner()}의 수정 지시로 끊겼다. 다시 하기 전에 끊긴 턴에서 이미 한 일(만든 초안, 띄운 워커, 커밋, 발송)을 먼저 확인하고, 같은 일을 반복하지 말고 이어서 하거나 고쳐라.`,
    "",
    "원래 요청:",
    original ?? "(원래 요청 기록 없음)",
    "",
    "수정·추가:",
    ...items.map((item) => `[${clock(item.at)} ${item.label ?? kindLabel(item.kind)}] ${item.text}`),
    ...(now - Math.min(...items.map((item) => item.at)) > STALE_BATCH_MS ? ["(일부는 대기 중 쌓인 메시지라 이미 지난 내용일 수 있다)"] : []),
  ].join("\n");
}
