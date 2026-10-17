// Workers that end a turn "waiting" for a job they started never come back on
// their own. Detect that from the final reply and the turn's tool calls and nudge
// them once in a while.
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { decisionLine } from "./digest.ts";
import { owner } from "./i18n.ts";

// The second sentence keeps a worker with no job of its own from adopting another
// session's work (otherwise an idle worker can latch onto someone else's live job).
export const WAKE_TEXT =
  "기다리다 턴이 끝났어요. 진행 중인 작업을 백그라운드 until-loop로 직접 기다렸다가 원래 작업을 끝까지 마무리해 주세요. 이 세션에서 네가 직접 시작한 작업만 기다리고, 그런 작업이 없으면 다른 세션 일은 건드리지 말고 상태만 한 줄로 보고해.";
export const WAKE_AFTER_MS = 3 * 60 * 1000;
export const WAKE_BACKOFF_MS = 30 * 60 * 1000;
export const WAKE_MAX = 3;
/** A tool still shown as running keeps the worker asleep, but not forever. */
export const WAKE_RUNNING_TOOL_LIMIT_MS = 2 * 3600 * 1000;

/** The standing rule every worker prompt carries (orchestrator prompt and handoffs). */
export const LONG_JOB_RULE =
  "If you start a long job, wait for it yourself with a background until-loop and finish the task in the same run.";

// "I am waiting for my own job": the reply says it is waiting, or that it will carry on
// when something it started finishes.
const WAITING = [
  /기다리(는 ?중|고 ?있|는 동안|면서|며 )|기다릴게|기다리겠|대기 ?중(입니다|이에요|이고|이라)/,
  /(끝나면|완료되면|마치면|끝나는 대로|완료되는 대로|나오면|도착하면)\s*(알림|알려|이어서|이어가|계속|마무리|마저|조립|보고|다시 확인|확인하고|정리)/,
  /알림이\s*(오면|와서|올 때|오는 대로)/,
  /waiting (on|for) (the |my |this |that |a )?(monitor|job|render|build|process|task|background|upload|download|export|run|script|pipeline|it)\b/i,
  /\b(will|i'll|i will) (carry on|continue|resume|pick (it|this|things) (back )?up|finish|wrap (it |this )?up|report back|follow up|check back)\b[^.\n]{0,50}\b(once|when|after)\b/i,
  /\bonce (it|the [\w-]+|this|that) (finishes|completes|is done|lands|returns|comes back)\b/i,
];

// Waiting for a person is not this problem.
const WAITING_FOR_HUMAN =
  /(님|사용자|승인|결정|답변|회신|피드백|말씀|지시|선택|컨펌)[^.\n]{0,15}(기다|대기)|(기다|대기)[^.\n]{0,12}(승인|결정|답변|회신|말씀|컨펌)|waiting (for|on) (your|you|approval|confirmation|input|feedback|a decision)\b/i;

/** The fixed pattern, plus the owner's own name ("Mina님의 확인을 기다리는 중"). */
function waitsForHuman(text: string): boolean {
  if (WAITING_FOR_HUMAN.test(text)) return true;
  const name = owner();
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}[^.\\n]{0,15}(기다|대기)|(기다|대기)[^.\\n]{0,12}${escaped}|waiting (for|on) ${escaped}\\b`, "i").test(text);
}

// A job the turn left running: a detached shell command, a monitor, or a background task.
const BACKGROUND_START = /nohup|run_in_background|\bdisown\b|setsid|screen -dm|tmux new(-session)? -d|&\s*("|$)|--background|\bMonitor\b/i;
const PROGRESS = /진행 ?중|돌아가(고|는)|렌더링? ?중|업로드 ?중|빌드 ?중|시작했|걸어 ?(두|놨)|started|kicked off|is running|are running|in progress/i;

export interface WaitingVerdict {
  waiting: boolean;
  reason: string;
  /** A tool call the turn left in "running" state (a live background task). */
  toolStillRunning: boolean;
}

function lastTurn(items: readonly AgentTimelineItem[]): AgentTimelineItem[] {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].type === "user_message") return items.slice(index + 1);
  }
  return [...items];
}

export function waitingVerdict(finalText: string, timeline: readonly AgentTimelineItem[]): WaitingVerdict {
  const turn = lastTurn(timeline);
  const tools = turn.filter((item): item is Extract<AgentTimelineItem, { type: "tool_call" }> => item.type === "tool_call");
  const toolStillRunning = tools.some((tool) => tool.status === "running");
  const tail = finalText.trim().slice(-700);
  const no = (reason: string): WaitingVerdict => ({ waiting: false, reason, toolStillRunning });
  if (!tail) return no("빈 답");
  if (waitsForHuman(tail)) return no("사람을 기다림");
  const lastLine = tail.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
  if (/\?\s*\**$/.test(lastLine) || decisionLine(lastLine)) return no("사용자에게 묻는 중");
  const said = WAITING.find((pattern) => pattern.test(tail));
  if (said) return { waiting: true, reason: "기다린다고 하고 턴을 끝냄", toolStillRunning };
  const started = tools.some((tool) => BACKGROUND_START.test(`${tool.name} ${JSON.stringify(tool.detail ?? {})}`));
  if (started && PROGRESS.test(tail)) return { waiting: true, reason: "긴 작업을 걸어 두고 턴을 끝냄", toolStillRunning };
  return no("대기 표현 없음");
}
