import { SETTINGS } from "./config.ts";
import { escapeHtml } from "./format.ts";
import { owner, t } from "./i18n.ts";

export interface UsageReading {
  id: string;
  label: string;
  remainingPct: number | null;
  resetIso: string | null;
  at: number | null;
  status: "available" | "unavailable" | "error";
  note?: string;
}

export interface UsageCardSnapshot {
  rows: UsageReading[];
  checkedAt: number;
  refreshFailed?: boolean;
  /** No answer and no cached values: the optional usage-remaining Paseo plugin is missing or not running. */
  unavailable?: boolean;
}

/** The refresh button, in the language in effect. */
export function usageButtons() {
  return [[{ text: t("🔄 새로고침", "🔄 Refresh"), callback_data: "usage:refresh" }]];
}
export const USAGE_BUTTONS = usageButtons();
const STALE_MS = 10 * 60_000;
const clock = new Intl.DateTimeFormat("en-US", {
  timeZone: SETTINGS.timeZone, month: "numeric", day: "numeric",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function validTime(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime());
}

function wall(value: number | null): string {
  if (!validTime(value)) return t("시각 없음", "no time");
  const parts = Object.fromEntries(clock.formatToParts(value).map((part) => [part.type, part.value]));
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

function duration(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return t(`${minutes}분`, `${minutes} min`);
  if (minutes < 1440) return t(`${Math.floor(minutes / 60)}시간`, `${Math.floor(minutes / 60)} h`);
  return t(`${Math.floor(minutes / 1440)}일`, `${Math.floor(minutes / 1440)} d`);
}

/** No I/O: checkedAt is the attempt time; each row retains its own observation time. */
export function renderUsageCard(snapshot: UsageCardSnapshot, now = Date.now()): string {
  if (snapshot.unavailable) {
    return [
      t("<b>📊 AI 사용량</b>", "<b>📊 AI usage</b>"),
      t("사용량 정보를 볼 수 없어요.", "Usage info isn't available."),
      t(
        "/usage는 Paseo에 usage-remaining 플러그인이 설치돼 있을 때만 동작해요. 이미 설치했다면 잠시 뒤 🔄 새로고침을 눌러 주세요.",
        "/usage only works when the usage-remaining Paseo plugin is installed. If it is, tap 🔄 Refresh in a moment.",
      ),
    ].join("\n");
  }
  const lines = [
    t("<b>📊 내 AI 사용량</b>", "<b>📊 My AI usage</b>"),
    t(`${owner()}님 전용 · ${SETTINGS.timeZone} 기준`, `${owner()} only · ${SETTINGS.timeZone} time`),
    t(`조회: ${wall(snapshot.checkedAt)}`, `Checked: ${wall(snapshot.checkedAt)}`),
  ];
  if (snapshot.refreshFailed) lines.push(t("⚠️ 새 조회 실패 · 아래 확인 시각을 확인해 주세요.", "⚠️ Refresh failed · check the times below."));
  if (!snapshot.rows.length) lines.push("", t("조회 불가 · 아직 수집된 값이 없어요.", "Unavailable · nothing collected yet."));

  for (const row of snapshot.rows) {
    const pct = row.remainingPct !== null && Number.isFinite(row.remainingPct)
      ? Math.round(Math.max(0, Math.min(100, row.remainingPct))) : null;
    const reset = row.resetIso ? Date.parse(row.resetIso) : NaN;
    const expired = Number.isFinite(reset) && reset <= now;
    const old = !validTime(row.at) || now - row.at > STALE_MS;
    const cached = pct !== null && (old || expired || row.status !== "available");
    lines.push("", `<b>${escapeHtml(row.label)}</b> · ${pct === null ? t("조회 불가", "unavailable") : t(`${pct}% 남음`, `${pct}% left`)}`);
    if (cached) {
      const reason = expired
        ? t("초기화 시각 경과", "reset time passed")
        : row.status !== "available" ? t("현재 조회 불가", "unavailable right now") : old ? t("갱신 필요", "needs a refresh") : "";
      lines.push(t(`⚠️ 이전 저장값 · ${reason}`, `⚠️ Saved earlier · ${reason}`));
    }
    const age = validTime(row.at) && now >= row.at
      ? now - row.at < 60_000 ? t(" · 방금", " · just now") : t(` · ${duration(now - row.at)} 전`, ` · ${duration(now - row.at)} ago`) : "";
    lines.push(t(`확인: ${wall(row.at)}${age}`, `Seen: ${wall(row.at)}${age}`));
    if (Number.isFinite(reset)) {
      lines.push(
        t(`초기화: ${wall(reset)}${expired ? " · 지남" : ` · ${duration(reset - now)} 후`}`, `Resets: ${wall(reset)}${expired ? " · passed" : ` · in ${duration(reset - now)}`}`),
      );
    }
    if (row.note) lines.push(escapeHtml(row.note));
  }

  lines.push(
    "",
    t("🔄 새로고침 또는 /usage · 자동 갱신 5분", "🔄 Refresh or /usage · auto-refresh every 5 min"),
    t("Claude는 최대 5분 간격으로 확인해요.", "Claude is checked at most every 5 minutes."),
    t("Mac이 잠들면 최신 조회가 늦어질 수 있어요.", "If the Mac sleeps, fresh numbers may lag."),
  );
  return lines.join("\n");
}
