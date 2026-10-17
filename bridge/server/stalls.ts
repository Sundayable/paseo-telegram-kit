import { SETTINGS } from "./config.ts";
// Agents that stopped on a provider limit, and when they can go again. Deterministic:
// the reset time comes from the provider's own message, else from the usage-remaining
// cache (~/.paseo/usage-remaining.cache.json), else a fixed wait.

export const TIME_ZONE = SETTINGS.timeZone;
export const RESUME_TEXT = "세션 한도로 중단됐던 작업이에요. 멈춘 지점부터 이어서 끝까지 해 주세요.";
export const RESUME_GRACE_MS = 5 * 60 * 1000;
export const DEFAULT_WAIT_MS = 60 * 60 * 1000;

export interface UsageRow {
  remainingPct: number | null;
  resetIso: string | null;
  at: number;
}
export type UsageRows = Record<string, UsageRow>;

export interface Stall {
  kind: "limit" | "balance";
  /** When the agent may be resumed (before the grace); null = wait for a usage signal. */
  resetAt: number | null;
  message: string;
}

/** UTC ms for a wall-clock time in `timeZone`. */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, timeZone = TIME_ZONE): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let result = guess;
  for (let pass = 0; pass < 2; pass += 1) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
      })
        .formatToParts(result)
        .map((part) => [part.type, part.value]),
    );
    const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    result -= wall - guess;
  }
  return result;
}

export function localDate(ms: number, timeZone = TIME_ZONE): { year: number; month: number; day: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" })
      .formatToParts(ms)
      .map((part) => [part.type, part.value]),
  );
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

function to24(hour: number, meridiem: string): number {
  const pm = meridiem.toLowerCase() === "pm";
  return (hour % 12) + (pm ? 12 : 0);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function usageReset(rows: UsageRows | undefined, keys: string[], observedAt: number): number | null {
  for (const key of keys) {
    const row = rows?.[key];
    if (!row) continue;
    // The cache was refreshed after the stall and shows room again: go now.
    if (row.at > observedAt && (row.remainingPct ?? 0) > 5) return row.at;
    const reset = row.resetIso ? Date.parse(row.resetIso) : NaN;
    if (Number.isFinite(reset) && reset > observedAt) return reset;
  }
  return null;
}

/**
 * Real formats seen in September 2026:
 *   Claude: "You've hit your session limit · resets 5:40pm (America/Vancouver)"
 *   Claude: "You've reached your Fable limit. Switch to another model, …"
 *   Codex:  "You've hit your usage limit. … try again at Sep 26th, 2026 1:20 AM."
 *   Grok:   "API error (status 402 Payment Required): Grok Build usage balance exhausted"
 */
export function detectStall(text: string, observedAt: number, usage?: UsageRows): Stall | null {
  if (!text) return null;
  const message = text.trim().slice(0, 300);

  const claude = text.match(/you('ve| have) hit your ([\w.]+ ){0,2}limit\s*[·∙-]\s*resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([^)]+)\))?/i);
  if (claude) {
    const zone = claude[6] ?? TIME_ZONE;
    const hour = to24(Number(claude[3]), claude[5]);
    const minute = Number(claude[4] ?? 0);
    const today = localDate(observedAt, zone);
    let resetAt = zonedTime(today.year, today.month, today.day, hour, minute, zone);
    if (resetAt <= observedAt - 60_000) {
      const tomorrow = localDate(observedAt + 24 * 3600_000, zone);
      resetAt = zonedTime(tomorrow.year, tomorrow.month, tomorrow.day, hour, minute, zone);
    }
    return { kind: "limit", resetAt, message };
  }

  const codexAt = text.match(/try again at (\w{3})\w* (\d{1,2})(?:st|nd|rd|th)?,? (\d{4}),? (\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (codexAt) {
    const month = MONTHS.indexOf(codexAt[1].toLowerCase()) + 1;
    if (month > 0) {
      const resetAt = zonedTime(Number(codexAt[3]), month, Number(codexAt[2]), to24(Number(codexAt[4]), codexAt[6]), Number(codexAt[5]));
      return { kind: "limit", resetAt, message };
    }
  }
  const codexIn = text.match(/try again in (?:(\d+)\s*(?:hours?|h))?\s*(?:(\d+)\s*(?:minutes?|mins?|m))?/i);
  if (codexIn && /limit/i.test(text) && (codexIn[1] || codexIn[2])) {
    const wait = (Number(codexIn[1] ?? 0) * 60 + Number(codexIn[2] ?? 0)) * 60_000;
    return { kind: "limit", resetAt: observedAt + wait, message };
  }

  if (/402 Payment Required|usage balance exhausted/i.test(text)) {
    return { kind: "balance", resetAt: usageReset(usage, ["grok_week"], observedAt), message };
  }

  const modelLimit = text.match(/you('ve| have) reached your ([\w.]+(?: [\d.]+)?) limit/i);
  if (modelLimit) {
    const model = modelLimit[2].toLowerCase();
    const keys = model.startsWith("fable") ? ["fable_week", "claude_week"] : ["claude_week", "claude_session"];
    return { kind: "limit", resetAt: usageReset(usage, keys, observedAt) ?? observedAt + DEFAULT_WAIT_MS, message };
  }

  if (/you('ve| have) hit your ([\w.]+ ){0,2}limit|rate_limit_error|usage limit reached/i.test(text)) {
    return { kind: "limit", resetAt: usageReset(usage, ["claude_session", "codex_week"], observedAt) ?? observedAt + DEFAULT_WAIT_MS, message };
  }
  return null;
}

/** usage-remaining's cache → rows keyed like "claude_session", "grok_week". */
export function parseUsageCache(raw: unknown): UsageRows {
  const rows: UsageRows = {};
  if (!raw || typeof raw !== "object") return rows;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = value as { row?: { remainingPct?: unknown; resetIso?: unknown }; at?: unknown } | null;
    if (!entry?.row || key.startsWith("_")) continue;
    rows[key] = {
      remainingPct: typeof entry.row.remainingPct === "number" ? entry.row.remainingPct : null,
      resetIso: typeof entry.row.resetIso === "string" ? entry.row.resetIso : null,
      at: typeof entry.at === "number" ? entry.at : 0,
    };
  }
  return rows;
}
