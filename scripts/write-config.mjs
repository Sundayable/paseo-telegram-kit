// Called by install.sh. Adds this kit's profiles to Paseo's config.json (by id, so a re-run
// updates them and never touches anyone else's), turns on plugins and Paseo's agent tools,
// and writes the seat chain into the bridge settings. Inputs come from the environment.
import { readFileSync, renameSync, writeFileSync } from "node:fs";

const env = process.env;
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) => {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
};

const settings = readJson(env.SETTINGS);
const ko = settings.language !== "en";
const codex = env.CODEX === "1";
const claude = env.CLAUDE === "1";
const claudeModel = env.CLAUDE_MODEL;
const codexModel = env.CODEX_MODEL;

const ids = {
  main: "agent_profile_tgk_orchestrator",
  backup: "agent_profile_tgk_orchestrator_codex",
  writer: "agent_profile_tgk_worker_claude",
  coder: "agent_profile_tgk_worker_codex",
};
const names = ko
  ? { main: "텔레그램 오케 · Claude", backup: "텔레그램 오케 백업 · Codex", writer: "작업자 · Claude", coder: "작업자 · Codex" }
  : { main: "Telegram orchestrator · Claude", backup: "Telegram orchestrator backup · Codex", writer: "Worker · Claude", coder: "Worker · Codex" };
const routing = !claude
  ? ko
    ? `모든 작업은 '${names.coder}'.`
    : `All work → '${names.coder}'.`
  : codex
  ? ko
    ? `코딩·코드 리뷰·브라우저 작업·리서치는 '${names.coder}', 글쓰기·기획·디자인은 '${names.writer}'.`
    : `Coding, code review, browser work and research → '${names.coder}'; writing, planning and design → '${names.writer}'.`
  : ko
    ? `모든 작업은 '${names.writer}'.`
    : `All work → '${names.writer}'.`;
const notes = {
  main: ko
    ? `텔레그램에서 ${settings.ownerName}님과 대화하는 단 하나의 좌석. 일을 나누고 작업자에게 맡기고 결과를 확인한다. 텔레그램 브리지가 id로 찾으니 id는 바꾸지 않는다. ${routing}`
    : `The one seat ${settings.ownerName} talks to from Telegram. Splits work, delegates to workers, checks results. The Telegram bridge finds it by id; keep the id. ${routing}`,
  backup: ko
    ? `Claude가 한도에 걸리거나 오류일 때 대신 대화하는 백업 좌석. ${routing}`
    : `Backup seat used when Claude hits a limit or fails. ${routing}`,
  writer: ko
    ? `글쓰기·기획·디자인·정리 작업${codex ? "" : "과 그 밖의 모든 작업"}. 발송·게시·결제·삭제·main 푸시는 ${settings.ownerName}님 승인 후에만.`
    : `Writing, planning, design and summaries${codex ? "" : ", and everything else"}. Send, publish, pay, delete or push to main only after ${settings.ownerName} approves.`,
  coder: ko
    ? `코딩·코드 리뷰·브라우저 작업·리서치. 발송·게시·결제·삭제·main 푸시는 ${settings.ownerName}님 승인 후에만.`
    : `Coding, code review, browser work and research. Send, publish, pay, delete or push to main only after ${settings.ownerName} approves.`,
};

// Claude leads when it is logged in; a Codex-only Mac gets a Codex orchestrator and worker.
const mainSeat = claude
  ? { provider: "claude", model: claudeModel, modeId: "bypassPermissions", thinkingOptionId: "medium" }
  : { provider: "codex", model: codexModel, modeId: "full-access", thinkingOptionId: "medium" };
const backupSeat = { provider: "codex", model: codexModel, modeId: "full-access", thinkingOptionId: "medium" };
const profiles = claude
  ? [
      { id: ids.main, name: names.main, color: "orange", ...mainSeat, notes: notes.main },
      ...(codex ? [{ id: ids.backup, name: names.backup, color: "orange", ...backupSeat, notes: notes.backup }] : []),
      { id: ids.writer, name: names.writer, color: "purple", provider: "claude", model: claudeModel, modeId: env.WORKER_MODE || "acceptEdits", thinkingOptionId: "high", notes: notes.writer },
      ...(codex ? [{ id: ids.coder, name: names.coder, color: "purple", provider: "codex", model: codexModel, modeId: "auto-review", thinkingOptionId: "high", notes: notes.coder }] : []),
    ]
  : [
      { id: ids.main, name: names.main.replace("Claude", "Codex"), color: "orange", ...mainSeat, notes: notes.main },
      { id: ids.coder, name: names.coder, color: "purple", provider: "codex", model: codexModel, modeId: "auto-review", thinkingOptionId: "high", notes: notes.coder },
    ];

const config = readJson(env.PASEO_CONFIG);
config.daemon ??= {};
config.daemon.mcp = { ...(config.daemon.mcp ?? {}), enabled: true, injectIntoAgents: true };
const others = (config.daemon.agentProfiles ?? []).filter((profile) => !String(profile.id).startsWith("agent_profile_tgk_"));
config.daemon.agentProfiles = [...others, ...profiles];
config.pluginsEnabled = true;
writeJson(env.PASEO_CONFIG, config);

if (claude) {
  settings.defaultModel = claudeModel;
  settings.modelAliases = { ...(settings.modelAliases ?? {}), opus: claudeModel };
}
settings.workerRouting = ko
  ? `작업자 고르기: 맡기기 전에 list_profiles를 읽고 notes에 맞는 프로필을 고른다. ${routing} provider, model, modeId, thinkingOptionId, featureValues를 그대로 복사한다.`
  : `Choosing a worker: read list_profiles before delegating and pick the profile whose notes fit. ${routing} Copy provider, model, modeId, thinkingOptionId and featureValues exactly.`;
settings.seats = [
  {
    key: "main",
    label: ko ? "메인 오케" : "Main orchestrator",
    profileId: ids.main,
    nameHint: profiles[0].name,
    fallback: mainSeat,
  },
  ...(claude && codex
    ? [{
        key: "codex",
        label: ko ? "백업 오케 · Codex" : "Backup orchestrator · Codex",
        profileId: ids.backup,
        nameHint: names.backup,
        fallback: backupSeat,
      }]
    : []),
];
settings.usagePanel = false;
writeJson(env.SETTINGS, settings);
console.log(`OK: ${profiles.length} profiles, ${settings.seats.length} seat(s)`);
