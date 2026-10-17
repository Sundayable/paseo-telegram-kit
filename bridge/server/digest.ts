// Twice-daily status digest for the owner's phone. Template only, no model calls.
import { escapeHtml, shortId } from "./format.ts";
import type { AgentSummary } from "./paseo-port.ts";
import { localDate, TIME_ZONE, zonedTime, type UsageRows } from "./stalls.ts";
import type { StallRecord } from "./state.ts";
import { ownerNim, t } from "./i18n.ts";

export const DIGEST_SLOTS = [
  { hour: 8, minute: 30, label: () => t("아침 요약", "Morning digest") },
  { hour: 18, minute: 30, label: () => t("저녁 요약", "Evening digest") },
];
/** A slot missed by more than this (Mac asleep) is skipped instead of sent late. */
export const DIGEST_LATE_LIMIT_MS = 2 * 3600 * 1000;
const PER_SECTION = 5;

export interface DigestSlot {
  id: string;
  at: number;
  label: string;
}

/** The slot to send now, if any: the latest one at or before `now`, not sent yet, and not too late. */
export function dueDigestSlot(now: number, lastSlotId: string | null): DigestSlot | null {
  const candidates: DigestSlot[] = [];
  for (const offsetDays of [-1, 0]) {
    const day = localDate(now + offsetDays * 24 * 3600_000);
    for (const slot of DIGEST_SLOTS) {
      const at = zonedTime(day.year, day.month, day.day, slot.hour, slot.minute);
      const id = `${day.year}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}T${String(slot.hour).padStart(2, "0")}:${String(slot.minute).padStart(2, "0")}`;
      if (at <= now) candidates.push({ id, at, label: slot.label() });
    }
  }
  const latest = candidates.sort((left, right) => right.at - left.at)[0];
  if (!latest || latest.id === lastSlotId) return null;
  return latest;
}

const DECISION_CUE =
  /\?$|할까요|원하시면|결정|승인|골라|선택해|말씀해 주세요|알려 주세요|확인해 주세요|해 주시면|\b(should I|shall I|want me to|let me know|please (confirm|choose|decide|approve|pick))\b/i;

function reportLines(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.replace(/^[\s>*•\-\d.)]+/, "").replace(/\*\*/g, "").trim())
    .filter(Boolean);
}

const clip = (line: string) => (line.length > 90 ? `${line.slice(0, 90)}…` : line);

/** The last line of a worker's report that asks the owner for something. */
export function decisionLine(text: string): string | null {
  const lines = reportLines(text);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (DECISION_CUE.test(lines[index])) return clip(lines[index]);
  }
  return null;
}

/** The report's last line, shortened the same way. */
export function lastLine(text: string): string | null {
  const line = reportLines(text).at(-1);
  return line ? clip(line) : null;
}

function since(iso: string | null, now: number): string {
  if (!iso) return "";
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  return minutes < 60 ? t(`${minutes}분째`, `${minutes} min`) : t(`${Math.round(minutes / 60)}시간째`, `${Math.round(minutes / 60)} h`);
}

/** "9/25 18:30" in the configured time zone. */
function wall(ms: number): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(ms)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

function left(resetIso: string | null, now: number): string {
  if (!resetIso) return "";
  const minutes = Math.round((Date.parse(resetIso) - now) / 60000);
  if (!Number.isFinite(minutes) || minutes <= 0) return "";
  if (minutes < 60) return t(`${minutes}분`, `${minutes}m`);
  if (minutes < 48 * 60) return t(`${Math.floor(minutes / 60)}시간`, `${Math.floor(minutes / 60)}h`);
  return t(`${Math.floor(minutes / 1440)}일`, `${Math.floor(minutes / 1440)}d`);
}

function section(title: string, lines: string[]): string[] {
  if (!lines.length) return [];
  const shown = lines.slice(0, PER_SECTION);
  const more = lines.length > PER_SECTION ? [t(`  …외 ${lines.length - PER_SECTION}개`, `  …and ${lines.length - PER_SECTION} more`)] : [];
  return ["", `<b>${title}</b>`, ...shown, ...more];
}

export interface DigestInput {
  now: number;
  slotLabel: string;
  running: AgentSummary[];
  finished: Array<{ agent: AgentSummary; decision: string | null }>;
  waitingPermission: AgentSummary[];
  stalls: StallRecord[];
  usage: UsageRows;
  /** Waiting workers the bridge woke since the last digest. */
  wakes?: Array<{ agentId: string; title: string; at: number; count: number }>;
}

const USAGE_ROWS: Array<[string, () => string]> = [
  ["claude_session", () => t("Claude 세션", "Claude session")],
  ["claude_week", () => t("Claude 주간", "Claude week")],
  ["fable_week", () => "Fable"],
  ["codex_week", () => "Codex"],
  ["grok_week", () => "Grok"],
  ["cursor_month", () => "Cursor"],
];

export function renderDigest(input: DigestInput): string {
  const { now } = input;
  const name = (agent: { title: string | null; id: string }) =>
    `${escapeHtml((agent.title ?? t("(제목 없음)", "(untitled)")).slice(0, 36))} <code>${shortId(agent.id)}</code>`;
  const lines = [`🗞 <b>${input.slotLabel}</b> · ${wall(now)}`];
  lines.push(...section(t(`🟢 진행 중 ${input.running.length}`, `🟢 Running ${input.running.length}`), input.running.map((agent) => `• ${name(agent)} · ${since(agent.lastUserMessageAt ?? agent.updatedAt, now)}`)));
  lines.push(...section(t(`✅ 끝남 ${input.finished.length} (지난 요약 이후)`, `✅ Finished ${input.finished.length} (since the last digest)`), input.finished.map(({ agent }) => `• ${name(agent)}`)));
  const stalled = input.stalls.filter((stall) => stall.status === "waiting" || stall.status === "resuming");
  lines.push(
    ...section(
      t(`⏸ 한도로 멈춤 ${stalled.length}`, `⏸ Stopped on a limit ${stalled.length}`),
      stalled.map((stall) => {
        const when =
          stall.status === "resuming"
            ? t("다시 돌리는 중", "resuming now")
            : stall.resetAt
              ? t(`${wall(stall.resetAt + 5 * 60_000)} 재개 예정`, `resumes ${wall(stall.resetAt + 5 * 60_000)}`)
              : t("충전·리셋 대기", "waiting for a top-up or reset");
        return `• ${name({ title: stall.title, id: stall.agentId })} · ${when}`;
      }),
    ),
  );
  const wakes = input.wakes ?? [];
  lines.push(
    ...section(
      t(`⏰ 기다리다 멈춰서 깨운 세션 ${wakes.length}`, `⏰ Woken after stalling while waiting ${wakes.length}`),
      wakes.map((wake) => `• ${name({ title: wake.title, id: wake.agentId })} · ${wall(wake.at)} (${wake.count}/3)`),
    ),
  );
  const waiting = [
    ...input.waitingPermission.map((agent) => t(`• ${name(agent)} 승인 요청 대기`, `• ${name(agent)} waiting for approval`)),
    ...input.finished.filter(({ decision }) => decision).map(({ agent, decision }) => `• ${name(agent)} “${escapeHtml(decision as string)}”`),
  ];
  lines.push(...section(t(`✋ ${ownerNim()} 차례 ${waiting.length}`, `✋ Your turn ${waiting.length}`), waiting));

  const usage = USAGE_ROWS.filter(([key]) => input.usage[key]?.remainingPct !== null && input.usage[key] !== undefined).map(([key, label]) => {
    const row = input.usage[key];
    const resetIn = left(row.resetIso, now);
    const stale = now - row.at > 6 * 3600_000 ? "*" : "";
    return `${label()} ${row.remainingPct}%${resetIn ? `(${resetIn})` : ""}${stale}`;
  });
  if (usage.length) {
    lines.push("", t("<b>📊 남은 사용량</b>", "<b>📊 Usage left</b>"), usage.join(" · "));
    if (usage.some((entry) => entry.endsWith("*"))) lines.push(t("<i>* 6시간 넘은 값</i>", "<i>* older than 6 hours</i>"));
  }
  if (lines.length === 1) lines.push("", t("조용해요. 돌아가는 세션도 기다리는 일도 없어요.", "All quiet. Nothing running, nothing waiting."));
  return lines.join("\n");
}
