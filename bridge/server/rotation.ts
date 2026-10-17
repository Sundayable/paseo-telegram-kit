// Nightly seat rotation: a fresh orchestrator session gets a handoff written from
// Paseo's own records (no model call), and the old one is archived.
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { decisionLine } from "./digest.ts";
import { shortId } from "./format.ts";
import type { AgentSummary } from "./paseo-port.ts";
import { timelineDigest } from "./seats.ts";
import { localDate, zonedTime } from "./stalls.ts";
import { LONG_JOB_RULE } from "./wake.ts";

export const ROTATION_WINDOW = { startHour: 3, startMinute: 30, endHour: 5 };

/** "2026-09-26" when `now` falls inside tonight's 03:30–05:00 window (configured time zone), else null. */
export function rotationWindowDay(now: number): string | null {
  const day = localDate(now);
  const start = zonedTime(day.year, day.month, day.day, ROTATION_WINDOW.startHour, ROTATION_WINDOW.startMinute);
  const end = zonedTime(day.year, day.month, day.day, ROTATION_WINDOW.endHour, 0);
  if (now < start || now >= end) return null;
  return `${day.year}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
}

/** Each turn's final reply, oldest first. */
export function turnReplies(items: readonly AgentTimelineItem[]): string[] {
  const replies: string[] = [];
  let segment = "";
  let reply = "";
  let inTurn = false;
  const close = () => {
    if (segment.trim()) reply = segment;
    if (inTurn && reply.trim()) replies.push(reply.trim());
  };
  for (const item of items) {
    if (item.type === "user_message") {
      close();
      inTurn = true;
      segment = "";
      reply = "";
    } else if (item.type === "assistant_message") {
      segment += item.text;
    } else if (item.type !== "reasoning") {
      if (segment.trim()) reply = segment;
      segment = "";
    }
  }
  close();
  return replies;
}

export interface HandoffInput {
  seatId: string;
  now: number;
  timeline: readonly AgentTimelineItem[];
  workers: AgentSummary[];
}

export function buildHandoff(input: HandoffInput): string {
  const replies = turnReplies(input.timeline);
  const decisions = [...new Set(replies.slice(-6).map(decisionLine).filter((line): line is string => Boolean(line)))];
  const links = [...new Set(replies.slice(-12).flatMap((reply) => reply.match(/https?:\/\/[^\s)>\]"'`]+/g) ?? []))].slice(-10);
  const active = input.workers.filter((worker) => !worker.archivedAt);
  const lines = [
    `# 텔레그램 오케 인수인계 — ${new Date(input.now).toISOString()}`,
    "",
    `이전 좌석: ${input.seatId}`,
    "",
    "## 결정·확인 대기 (이전 좌석의 최근 답에서)",
    ...(decisions.length ? decisions.map((line) => `- ${line}`) : ["- 없음"]),
    "",
    "## 맡겨 둔 워커",
    ...(active.length
      ? active.map(
          (worker) =>
            `- ${shortId(worker.id)} ${worker.title ?? ""} — ${worker.status}${worker.attentionReason === "permission" ? ", 승인 대기" : ""} (${worker.id})`,
        )
      : ["- 없음"]),
    "",
    "## 최근 링크",
    ...(links.length ? links.map((link) => `- ${link}`) : ["- 없음"]),
    "",
    "## 최근 대화 발췌",
    timelineDigest(input.timeline, 3500) || "(없음)",
  ];
  return lines.join("\n");
}

export function rotationPrompt(handoff: string, file: string): string {
  return [
    "[텔레그램 · 오케 교대 인수인계]",
    `이전 오케 세션은 교대로 보관됐고, 너는 새 텔레그램 오케 좌석이다. 아래 인수인계(파일: ${file})를 이어받아라. 맡겨 둔 워커는 계속 네 워커다.`,
    `상시 규칙: 워커에게 보내는 모든 지시 끝에 이 문장을 넣는다 — "${LONG_JOB_RULE}"`,
    "도구를 쓰지 말고 '인수인계 확인'이라고만 답해라.",
    "",
    handoff,
  ].join("\n");
}
