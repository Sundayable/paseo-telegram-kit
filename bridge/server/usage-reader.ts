import { t } from "./i18n.ts";
import type { UsageCardSnapshot, UsageReading } from "./usage-card.ts";

export interface UsageReaderOptions {
  fetch: () => Promise<unknown>;
  readCache: () => unknown | Promise<unknown>;
  now?: () => number;
  settle?: () => Promise<void>;
}

const THROTTLE_MS = 60_000;
const ROWS = [
  ["claude_session", () => t("Claude · 5시간", "Claude · 5 hours"), true],
  ["claude_week", () => t("Claude · 주간", "Claude · week"), true],
  ["codex_session", () => t("Codex · 5시간", "Codex · 5 hours"), false],
  ["codex_week", () => t("Codex · 주간", "Codex · week"), true],
  ["fable_week", () => t("Fable · 주간", "Fable · week"), false],
  ["grok_week", () => t("Grok · 주간", "Grok · week"), false],
  ["cursor_month", () => t("Cursor · 월간", "Cursor · month"), false],
] as const;
const IDS = new Set<string>(ROWS.map(([id]) => id));

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function percentage(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function resetTime(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function observationTime(value: unknown, now: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= now
    && Number.isFinite(new Date(value).getTime()) ? value : null;
}

function cachedRow(cache: Record<string, unknown>, id: string): Record<string, unknown> | null {
  const row = record(record(cache[id])?.row);
  return row && (row.id === undefined || row.id === id) ? row : null;
}

function observedAt(id: string, row: Record<string, unknown>, cache: Record<string, unknown>, now: number): number | null {
  const cached = cachedRow(cache, id);
  const pct = percentage(row.remainingPct);
  if (!cached || pct === null || cached.remainingPct !== pct
    || (cached.resetIso ?? null) !== (row.resetIso ?? null)) return null;
  // Invalid reset data must not accidentally match after normalization to null.
  if (row.resetIso != null && resetTime(row.resetIso) === null) return null;
  const at = observationTime(record(cache[id])?.at, now);
  if (at === null) return null;
  if (id.startsWith("claude_") || id === "fable_week") {
    const claudeAt = observationTime(record(cache._claude)?.lastAt, now);
    // The provider collector can re-stamp a reused Claude row. Its last real
    // response time is the upper bound, even if lastGood's `at` is newer.
    return claudeAt === null ? null : Math.min(at, claudeAt);
  }
  return at;
}

function readings(source: Map<string, Record<string, unknown>>, cache: Record<string, unknown>, now: number, failed: boolean): UsageReading[] {
  const result: UsageReading[] = [];
  for (const [id, label, required] of ROWS) {
    const row = source.get(id);
    const remainingPct = percentage(row?.remainingPct);
    if (id === "codex_session" && remainingPct === null && row?.detail === "no 5-hour window on this plan") continue;
    if (!required && remainingPct === null) continue;
    const status = failed ? "error" : row?.status === "available" && remainingPct !== null
      ? "available" : row?.status === "error" ? "error" : "unavailable";
    result.push({
      id, label: label(), remainingPct,
      resetIso: resetTime(row?.resetIso),
      at: row ? observedAt(id, row, cache, now) : null,
      status,
    });
  }
  return result;
}

/** Read-only adapter; neither error messages nor provider-controlled labels leave it. */
export class UsageReader {
  private readonly options: UsageReaderOptions;
  private readonly now: () => number;
  private readonly settle: () => Promise<void>;
  private inFlight: Promise<UsageCardSnapshot> | null = null;
  private last: UsageCardSnapshot | null = null;
  private lastStartedAt: number | null = null;

  constructor(options: UsageReaderOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    // The existing collector persists its lastGood cache after a 500 ms delay.
    this.settle = options.settle ?? (() => new Promise((resolve) => setTimeout(resolve, 800)));
  }

  read(): Promise<UsageCardSnapshot> {
    if (this.inFlight) return this.inFlight;
    const checkedAt = this.now();
    if (this.last && this.lastStartedAt !== null && checkedAt - this.lastStartedAt < THROTTLE_MS) {
      return Promise.resolve(this.last);
    }
    this.lastStartedAt = checkedAt;
    this.inFlight = this.collect(checkedAt).then((snapshot) => {
      this.last = snapshot;
      return snapshot;
    }).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async collect(checkedAt: number): Promise<UsageCardSnapshot> {
    let source = new Map<string, Record<string, unknown>>();
    let failed = false;
    try {
      const response = record(await this.options.fetch());
      if (!response || !Array.isArray(response.rows)) throw new Error("Invalid usage response");
      for (const candidate of response.rows) {
        const row = record(candidate);
        if (row && typeof row.id === "string" && IDS.has(row.id) && !source.has(row.id)) source.set(row.id, row);
      }
      await this.settle();
    } catch {
      failed = true;
    }

    let cache: Record<string, unknown> = {};
    try { cache = record(await this.options.readCache()) ?? {}; } catch { /* No observation time is safer than a fabricated one. */ }
    if (failed) {
      source = new Map();
      for (const [id] of ROWS) {
        const row = cachedRow(cache, id);
        if (row) source.set(id, row);
      }
    }
    return {
      rows: readings(source, cache, this.now(), failed),
      checkedAt,
      ...(failed ? { refreshFailed: true } : {}),
      // Neither the plugin answered nor anything was ever cached: usage-remaining is most likely not installed.
      ...(failed && !source.size ? { unavailable: true } : {}),
    };
  }
}
