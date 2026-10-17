import { MODEL_ALIASES, SEAT_CHAIN } from "./config.ts";
import { t } from "./i18n.ts";

export interface ParsedCommand {
  name: string;
  args: string;
}

/** `/name args` or `/name@bot args`; commands addressed to another bot are ignored. */
export function parseCommand(text: string, botUsername?: string): ParsedCommand | null {
  const match = text.trim().match(/^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  if (match[2] && botUsername && match[2].toLowerCase() !== botUsername.toLowerCase()) return null;
  return { name: match[1].toLowerCase(), args: (match[3] ?? "").trim() };
}

export function splitFirst(args: string): [string, string] {
  const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  return match ? [match[1], (match[2] ?? "").trim()] : ["", ""];
}

export interface AgentRef {
  id: string;
  title: string | null;
}

export type ResolveResult =
  | { kind: "found"; agent: AgentRef }
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: AgentRef[] };

/**
 * An agent reference typed on a phone: a number from the last `/ls` listing,
 * a full id, or an id prefix of at least 4 characters.
 */
export function resolveAgentRef(ref: string, agents: readonly AgentRef[], lastListing: readonly string[]): ResolveResult {
  const needle = ref.trim().toLowerCase();
  if (!needle) return { kind: "none" };
  if (/^\d{1,2}$/.test(needle)) {
    const id = lastListing[Number(needle) - 1];
    const agent = id ? agents.find((candidate) => candidate.id === id) ?? { id, title: null } : undefined;
    return agent ? { kind: "found", agent } : { kind: "none" };
  }
  const exact = agents.find((agent) => agent.id.toLowerCase() === needle);
  if (exact) return { kind: "found", agent: exact };
  if (needle.length < 4) return { kind: "none" };
  const matches = agents.filter((agent) => agent.id.toLowerCase().startsWith(needle));
  if (matches.length === 1) return { kind: "found", agent: matches[0] };
  return matches.length ? { kind: "ambiguous", candidates: matches } : { kind: "none" };
}

/** "백업 오케 · Codex Astra" → "Codex Astra"; labels without a backup prefix are kept. */
export function seatShortName(label: string): string {
  return label.replace(/^(백업 오케|백업|backup( seat| orchestrator)?)\s*·\s*/i, "");
}

/** The /help text, in the bridge language, naming this install's backup seats and model aliases. */
export function helpText(): string {
  const backups = SEAT_CHAIN.slice(1).map((seat) => seatShortName(seat.label)).join(" → ");
  const aliases = Object.keys(MODEL_ALIASES).join("|");
  return [
    t("<b>텔레그램 오케</b>", "<b>Telegram orchestrator</b>"),
    t("그냥 메시지를 보내면 오케스트레이터가 받아서 Paseo 세션들에 일을 나눠요.", "Just send a message: the orchestrator picks it up and hands the work to your Paseo sessions."),
    t(
      "오케가 일하는 중에 보낸 메시지는 모아 뒀다가 순서대로 처리해요. 바로 멈추려면 '멈춰'나 /now로 시작하세요.",
      "Messages sent while it is working are queued and handled in order. To interrupt, start with \"stop\" or /now.",
    ),
    "",
    t("<b>세션과 직접 대화</b>", "<b>Talk to a session directly</b>"),
    t("• 세션이 보낸 메시지에 <b>답장</b>하면 그 세션으로 바로 가요.", "• <b>Reply</b> to a session's message and it goes straight to that session."),
    t("• /ls — 최근 세션 목록 (번호로 지정 가능)", "• /ls — recent sessions (refer to them by number)"),
    t("• /to 3 할 말 — 3번 세션에 바로 보내기", "• /to 3 message — send straight to session 3"),
    t("• /peek 3 — 3번 세션의 마지막 답 보기", "• /peek 3 — show session 3's last reply"),
    t("• /follow 3, /unfollow 3 — 그 세션 답을 텔레그램으로 받기/끊기", "• /follow 3, /unfollow 3 — get that session's replies in Telegram, or stop"),
    t("• /stop 3 — 세션 중단 (번호 없으면 오케)", "• /stop 3 — stop a session (no number: the orchestrator)"),
    "",
    t("<b>오케 관리</b>", "<b>Orchestrator</b>"),
    t("• /usage — 내 AI 잔여량 · 새로고침 (고정 메시지는 5분마다 갱신)", "• /usage — AI usage left · refresh (the pinned card updates every 5 min)"),
    t("• /status — 오케 상태", "• /status — orchestrator status"),
    t("• /digest — 지금 상황 요약 (08:30·18:30에는 자동)", "• /digest — summary right now (automatic at 08:30 and 18:30)"),
    t("• /new — 다음 메시지부터 새 오케 세션", "• /new — start a fresh orchestrator session with the next message"),
    t(`• /model ${aliases} — 오케 모델 바꾸기 (대화는 이어짐)`, `• /model ${aliases} — switch the orchestrator model (the conversation continues)`),
    ...(backups
      ? [
          t("• /backup — 다음 백업 좌석으로 넘기기, /main — 메인 오케로 복귀", "• /backup — move to the next backup seat, /main — back to the main seat"),
          t(
            `  (메인이 한도·오류로 멈추면 ${backups} 순서로 자동 전환되고, 메인이 살아나면 자동으로 돌아와요.)`,
            `  (If the main seat stops on a limit or error, it switches to ${backups} automatically and comes back once the main seat answers again.)`,
          ),
        ]
      : []),
    t("• /alerts on|off — 모든 세션의 권한·질문 요청 받기", "• /alerts on|off — get permission and question requests from every session"),
    "",
    t("사진·파일·음성도 보낼 수 있어요. 음성은 받아쓴 뒤 전달해요.", "Photos, files and voice notes work too. Voice is transcribed first."),
  ].join("\n");
}

/** Telegram's command menu; built on call so the language in effect is used. */
export function botCommands(): Array<{ command: string; description: string }> {
  return [
    { command: "usage", description: t("📊 내 AI 잔여량 · 초기화 시각 · 새로고침", "📊 AI usage left · reset times · refresh") },
    { command: "ls", description: t("최근 Paseo 세션 목록", "Recent Paseo sessions") },
    { command: "to", description: t("세션에 바로 보내기: /to 번호 메시지", "Send to a session: /to number message") },
    { command: "peek", description: t("세션의 마지막 답 보기", "Show a session's last reply") },
    { command: "follow", description: t("세션 답을 텔레그램으로 받기", "Get a session's replies here") },
    { command: "unfollow", description: t("세션 따라가기 끊기", "Stop following a session") },
    { command: "stop", description: t("세션 중단 (기본: 오케)", "Stop a session (default: orchestrator)") },
    { command: "status", description: t("오케 상태", "Orchestrator status") },
    { command: "digest", description: t("지금 상황 요약", "Summary right now") },
    { command: "new", description: t("새 오케 세션 시작", "Start a fresh orchestrator session") },
    { command: "model", description: t("오케 모델 바꾸기: /model opus|fable", "Switch model: /model opus|fable").replace("opus|fable", Object.keys(MODEL_ALIASES).join("|")) },
    { command: "backup", description: t("다음 백업 좌석으로 넘기기", "Move to the next backup seat") },
    { command: "main", description: t("메인 오케로 복귀", "Back to the main seat") },
    { command: "alerts", description: t("모든 세션 권한 요청 받기 on/off", "Permission requests from every session on/off") },
    { command: "help", description: t("사용법", "How to use") },
  ];
}
