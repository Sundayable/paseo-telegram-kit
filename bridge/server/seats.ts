import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { PRIMARY_RETRY_MAX_MS, PRIMARY_RETRY_MS, SETTINGS } from "./config.ts";
import { owner, ownerWith } from "./i18n.ts";
import { LONG_JOB_RULE } from "./wake.ts";

// Provider messages that mean "this seat cannot answer right now". Kept narrow:
// a normal reply that merely mentions a rate limit must not trigger a switch.
const LIMIT_PATTERN =
  /(usage|session|weekly|5-hour|opus|fable) limit (reached|hit|exceeded)|you('ve| have) (hit|reached) your ([\w.]+ ){0,3}limit|402 Payment Required|usage balance exhausted|limit reached\W+.*reset|rate_limit_error|overloaded_error|credit balance is too low|API Error:\s*(429|5\d\d)|too many requests|quota exceeded|insufficient_quota|out of (credits|usage)/i;
// A seat whose CLI login died answers with its own error text instead of failing the
// turn (Codex, for example: "[System Error] ... refresh token was revoked").
const AUTH_PATTERN =
  /^\s*\[System Error\]|refresh token (was|has been) revoked|access token could not be refreshed|authentication_error|invalid x-api-key|OAuth token (has )?expired|please run \/login/i;

// Cursor returns this as a successful turn, rather than a structured error.
const PLAN_REQUIRED_PATTERN = /^\s*Upgrade your plan to continue[.!]?\s*$/i;

/** A completed turn whose only output is a provider limit, overload or login-failure notice. */
export function looksUnavailable(finalText: string, errors: readonly string[]): boolean {
  if (errors.some((error) => LIMIT_PATTERN.test(error) || AUTH_PATTERN.test(error) || PLAN_REQUIRED_PATTERN.test(error))) return true;
  return finalText.length > 0 && finalText.length < 400 && (LIMIT_PATTERN.test(finalText) || AUTH_PATTERN.test(finalText) || PLAN_REQUIRED_PATTERN.test(finalText));
}

export function retryDelay(attempts: number): number {
  return Math.min(PRIMARY_RETRY_MS * 2 ** attempts, PRIMARY_RETRY_MAX_MS);
}

function clip(text: string, max: number): string {
  const flat = text.trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const TELEGRAM_PREFIX = /^\[텔레그램[^\]]*\]\s*/;

/**
 * The recent conversation of a seat as plain lines, newest kept when trimming.
 * Only the owner's messages and each turn's final reply; tool calls and reasoning are dropped.
 */
export function timelineDigest(items: readonly AgentTimelineItem[], maxChars = 6000): string {
  const exchanges: string[] = [];
  let user: string | null = null;
  let segment = "";
  let reply = "";
  const flush = () => {
    if (segment.trim()) reply = segment;
    if (user === null && !reply.trim()) return;
    const who = user !== null && TELEGRAM_PREFIX.test(user) ? owner() : "알림";
    const lines: string[] = [];
    if (user !== null) lines.push(`${who}: ${clip(user.replace(TELEGRAM_PREFIX, ""), 400)}`);
    if (reply.trim()) lines.push(`오케: ${clip(reply, 700)}`);
    exchanges.push(lines.join("\n"));
  };
  for (const item of items) {
    if (item.type === "user_message") {
      flush();
      user = item.text;
      segment = "";
      reply = "";
    } else if (item.type === "assistant_message") {
      segment += item.text;
    } else if (item.type !== "reasoning") {
      if (segment.trim()) reply = segment;
      segment = "";
    }
  }
  flush();

  const kept: string[] = [];
  let used = 0;
  for (let index = exchanges.length - 1; index >= 0; index -= 1) {
    const entry = exchanges[index];
    if (used + entry.length + 2 > maxChars) break;
    kept.unshift(entry);
    used += entry.length + 2;
  }
  return kept.join("\n\n");
}

function roleReminder(): string {
  const who = owner();
  const language = SETTINGS.replyLanguage === "Korean" ? "한국어" : SETTINGS.replyLanguage;
  return `역할: 너는 ${ownerWith("이", "가")} 텔레그램으로 대화하는 오케스트레이터다. Paseo MCP 도구(list_agents, get_agent_activity, send_agent_prompt, list_profiles, create_agent)로 세션들에 일을 나누고, 직접 구현하지 않는다. 턴의 마지막 답변만 ${who}의 텔레그램으로 가니 결론을 마지막에 ${language}로 짧게 쓴다. 발송·게시·결제·삭제·main 머지는 ${who}에게 묻는다. 워커를 띄울 때는 notifyOnFinish:false로 두고, 모든 워커 지시 끝에 다음 문장을 넣는다: "${LONG_JOB_RULE}"`;
}

export function handoffToBackup(input: { fromLabel: string; toLabel: string; reason: string; digest: string; pending: string | null }): string {
  return [
    `[텔레그램 · 백업 오케 인수인계]`,
    `${input.fromLabel} 좌석이 응답하지 못해서(${clip(input.reason, 200)}) ${input.toLabel} 좌석인 네가 이어받는다.`,
    roleReminder(),
    "",
    "직전 대화 발췌 (필요한 맥락만 이어받아라):",
    "---",
    input.digest || "(발췌할 대화 없음)",
    "---",
    input.pending
      ? `${owner()}의 마지막 메시지 (아직 답을 못 받음):\n${input.pending.startsWith("[텔레그램") ? "" : "[텔레그램] "}${input.pending}`
      : `${ownerWith("이", "가")} 기다리는 메시지는 없다. 이어받았다고 한 줄로만 답해라.`,
  ].join("\n");
}

export function handoffBackToMain(input: { fromLabel: string; digest: string }): string {
  return [
    "[텔레그램 · 메인 좌석 복귀 인수인계]",
    `네가 응답하지 못하는 동안 ${input.fromLabel} 좌석이 ${ownerWith("과", "와")} 대화했다. 아래 내용을 이어받고, 이어지는 ${owner()}의 메시지에 답해라.`,
    "---",
    input.digest || "(백업 좌석에서 나눈 대화 없음)",
    "---",
  ].join("\n");
}

export const PROBE_TEXT =
  "[텔레그램 · 좌석 점검] 백업 오케로 넘어간 뒤 이 메인 좌석이 다시 응답하는지 확인하는 메시지입니다. 도구를 쓰지 말고 '준비됨'이라고만 답하세요.";
