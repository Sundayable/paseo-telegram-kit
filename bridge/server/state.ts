import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_ORCHESTRATOR_MODEL } from "./config.ts";

export interface PendingAction {
  label: string;
  behavior: "allow" | "deny";
  selectedActionId?: string;
}

export interface PendingQuestion {
  question: string;
  header?: string;
  options: string[];
}

export interface PendingRequest {
  agentId: string;
  requestId: string;
  kind: "question" | "permission";
  messageIds: number[];
  /** HTML of the latest prompt message, so it can be edited to show the outcome. */
  html: string;
  actions?: PendingAction[];
  questions?: PendingQuestion[];
  answers?: Record<string, string>;
  index?: number;
  createdAt: number;
}

export interface FallbackState {
  /** When the chain left the main seat. */
  since: number;
  reason: string;
  /** Earliest time to probe the main seat again. */
  retryAt: number;
  attempts: number;
  /** A probe sent to the main seat and not answered yet. */
  probeSentAt: number | null;
}

export interface StallRecord {
  agentId: string;
  title: string;
  provider: string;
  /** When the limit error happened; one resume per (agent, errorAt). */
  errorAt: number;
  resetAt: number | null;
  message: string;
  status: "waiting" | "resuming" | "done" | "skipped";
  resumedAt?: number;
  reason?: string;
}

export interface WakeRecord {
  agentId: string;
  title: string;
  /** End of the turn that stopped while waiting; null when nothing is pending. */
  pendingSince: number | null;
  /** Turn ends already judged, so a rescan does not count the same turn twice. */
  lastEndedAt: number;
  reason: string;
  toolStillRunning: boolean;
  count: number;
  lastWakeAt: number;
}

export interface BridgeStateData {
  offset: number;
  /** One owner-only usage message, updated in place across plugin reloads. */
  usagePanelMessageId: number | null;
  usagePanelPinned: boolean;
  usagePanelSendPending: boolean;
  usageLastRefreshAt: number;
  /** The seat currently answering Telegram (an index into SEAT_CHAIN). */
  seat: number;
  /** Agent id of the active seat. */
  orchestratorId: string | null;
  /** Agent id per seat key, kept so a seat is reused rather than recreated. */
  seats: Record<string, string>;
  fallback: FallbackState | null;
  /** The owner's latest message to the orchestrator; resent to a backup seat if still unanswered. */
  lastPrompt: { text: string; at: number; answered: boolean } | null;
  /** Context from a backup seat, prefixed to the next message after returning to main. */
  pendingHandoff: string | null;
  /** Claude model for the main seat; null = the profile's own. */
  model: string | null;
  /** Agents the seat delegated to (id → since), whose results the bridge reports back. */
  workers: Record<string, number>;
  /** Agents stopped by a provider limit, waiting to be resumed. */
  stalls: Record<string, StallRecord>;
  lastStallScanAt: number;
  lastDigestSlot: string | null;
  lastDigestAt: number;
  /** A seat whose next reply is bridge-internal (rotation ack) and not for the owner. */
  silentTurn: string | null;
  lastRotationDay: string | null;
  /** /rotate arrived while the seat was busy: rotate at the next idle moment. */
  pendingRotate: boolean;
  /** Earlier main seats; their child agents are still the seat's workers. */
  retiredSeats: string[];
  /** Workers that ended a turn "waiting" on their own job. */
  wakes: Record<string, WakeRecord>;
  wakeLog: Array<{ agentId: string; title: string; at: number; count: number }>;
  lastWaitScanAt: number;
  follow: string[];
  alertsAll: boolean;
  lastListing: string[];
  /** [telegram message id, agent id], newest last. */
  messages: Array<[number, string]>;
  pending: Record<string, PendingRequest>;
}

const MESSAGE_MAP_LIMIT = 2000;
const PENDING_TTL_MS = 3 * 24 * 60 * 60 * 1000;

function emptyState(): BridgeStateData {
  return {
    offset: 0,
    usagePanelMessageId: null,
    usagePanelPinned: false,
    usagePanelSendPending: false,
    usageLastRefreshAt: 0,
    seat: 0,
    orchestratorId: null,
    seats: {},
    fallback: null,
    lastPrompt: null,
    pendingHandoff: null,
    model: DEFAULT_ORCHESTRATOR_MODEL,
    workers: {},
    stalls: {},
    lastStallScanAt: 0,
    lastDigestSlot: null,
    lastDigestAt: 0,
    silentTurn: null,
    lastRotationDay: null,
    pendingRotate: false,
    retiredSeats: [],
    wakes: {},
    wakeLog: [],
    lastWaitScanAt: 0,
    follow: [],
    alertsAll: false,
    lastListing: [],
    messages: [],
    pending: {},
  };
}

/** Small JSON state, written atomically after every change. `file: null` keeps it in memory (tests). */
export class StateStore {
  readonly data: BridgeStateData;
  private readonly file: string | null;

  constructor(file: string | null) {
    this.file = file;
    this.data = emptyState();
    if (!file) return;
    try {
      const loaded = JSON.parse(readFileSync(file, "utf8")) as Partial<BridgeStateData> & { profile?: string };
      // v0.1 kept one orchestrator and a main/backup profile flag instead of seats.
      if (!loaded.seats && loaded.orchestratorId) {
        loaded.seats = { [loaded.profile === "backup" ? "codex" : "main"]: loaded.orchestratorId };
        loaded.seat = loaded.profile === "backup" ? 2 : 0;
      }
      delete loaded.profile;
      Object.assign(this.data, loaded);
    } catch {
      // first run or unreadable: start empty
    }
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [token, pending] of Object.entries(this.data.pending)) {
      if (pending.createdAt < cutoff) delete this.data.pending[token];
    }
  }

  save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.data, null, 1));
    renameSync(temp, this.file);
  }

  rememberMessage(messageId: number, agentId: string): void {
    this.data.messages.push([messageId, agentId]);
    if (this.data.messages.length > MESSAGE_MAP_LIMIT) {
      this.data.messages.splice(0, this.data.messages.length - MESSAGE_MAP_LIMIT);
    }
    this.save();
  }

  agentForMessage(messageId: number): string | null {
    for (let index = this.data.messages.length - 1; index >= 0; index -= 1) {
      if (this.data.messages[index][0] === messageId) return this.data.messages[index][1];
    }
    return null;
  }

  isFollowed(agentId: string): boolean {
    return this.data.follow.includes(agentId);
  }

  setFollow(agentId: string, on: boolean): void {
    const has = this.isFollowed(agentId);
    if (on && !has) this.data.follow.push(agentId);
    if (!on && has) this.data.follow = this.data.follow.filter((id) => id !== agentId);
    this.save();
  }

  addPending(token: string, pending: PendingRequest): void {
    this.data.pending[token] = pending;
    this.save();
  }

  pendingByMessage(messageId: number): [string, PendingRequest] | null {
    for (const entry of Object.entries(this.data.pending)) {
      if (entry[1].messageIds.includes(messageId)) return entry;
    }
    return null;
  }

  pendingByRequest(agentId: string, requestId: string): [string, PendingRequest] | null {
    for (const entry of Object.entries(this.data.pending)) {
      if (entry[1].agentId === agentId && entry[1].requestId === requestId) return entry;
    }
    return null;
  }

  dropPending(token: string): void {
    delete this.data.pending[token];
    this.save();
  }
}
