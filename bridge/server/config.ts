import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
// Overrides exist so a throwaway daemon can run this plugin against a fake
// Telegram server and a temp state dir (see scripts/restart-check.ts).
const STATE_DIR = process.env.PASEO_TELEGRAM_STATE_DIR ?? join(HOME, ".paseo/telegram-orchestrator");

export const PATHS = {
  home: HOME,
  keysFile: process.env.PASEO_TELEGRAM_KEYS_FILE ?? join(STATE_DIR, "secrets.env"),
  paseoConfig: join(process.env.PASEO_HOME ?? join(HOME, ".paseo"), "config.json"),
  stateFile: join(STATE_DIR, "state.json"),
  /** Messages waiting for the orchestrator seat. */
  queueFile: join(STATE_DIR, "queue.json"),
  /** Handoffs written when the seat rotates. */
  handoffDir: join(STATE_DIR, "handoffs"),
  /** Written after every successful poll; the launchd watchdog reads it. */
  heartbeatFile: join(STATE_DIR, "heartbeat.json"),
  downloadDir: join(HOME, "Downloads/telegram"),
  /** Written by the usage-remaining Paseo plugin. */
  usageCache: join(process.env.PASEO_HOME ?? join(HOME, ".paseo"), "usage-remaining.cache.json"),
  /** Per-person settings written by the setup skill (see loadSettings). */
  configFile: process.env.PASEO_TELEGRAM_CONFIG ?? join(STATE_DIR, "config.json"),
};

export const TELEGRAM_API_BASE = process.env.PASEO_TELEGRAM_API_BASE ?? "https://api.telegram.org";

export interface SeatConfig {
  provider: string;
  model: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
}

export interface SeatDefinition {
  /** "main" for the first seat; any short id for backups ("codex", "cursor"). */
  key: string;
  label: string;
  /** Paseo profile to read the launch settings from, by id and then by name fragment. */
  profileId: string;
  nameHint: string;
  /** Used when the profile is missing from Paseo settings. */
  fallback: SeatConfig;
}

/**
 * Per-person settings, written by the telegram-orchestrator-setup skill's installer to
 * `<state dir>/config.json` (or `PASEO_TELEGRAM_CONFIG`). Every field is optional: a missing
 * file keeps the built-in defaults, which the test suite relies on.
 */
export interface OrchestratorSettings {
  /** First name the orchestrator uses for its human ("Mina"). */
  ownerName: string;
  /** Bridge notices: "ko" or "en". */
  language: "ko" | "en";
  /** Language the orchestrator writes its replies in ("English", "Korean"). */
  replyLanguage: string;
  /** IANA zone for the digest, the nightly rotation and message timestamps. */
  timeZone: string;
  orchestratorTitle: string;
  orchestratorCwd: string;
  defaultModel: string;
  modelAliases: Record<string, string>;
  seats: SeatDefinition[];
  /** Pin a usage card that is edited every 5 minutes (needs the usage-remaining plugin). */
  usagePanel: boolean;
  /** One line of worker routing carried with every batch; empty = read list_profiles notes. */
  workerRouting: string;
}

const DEFAULT_SEATS: SeatDefinition[] = [
  {
    key: "main",
    label: "메인 오케",
    profileId: "agent_profile_tgk_orchestrator",
    nameHint: "메인 오케",
    fallback: { provider: "claude", model: "claude-opus-5-5", modeId: "bypassPermissions", thinkingOptionId: "medium" },
  },
  {
    key: "codex",
    label: "백업 오케 · Codex",
    profileId: "agent_profile_tgk_orchestrator_codex",
    nameHint: "백업 오케 · Codex",
    fallback: { provider: "codex", model: "gpt-6-astra", modeId: "full-access", thinkingOptionId: "medium" },
  },
];

function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export const DEFAULT_SETTINGS: OrchestratorSettings = {
  ownerName: "User",
  language: "ko",
  replyLanguage: "Korean",
  timeZone: systemTimeZone(),
  orchestratorTitle: "텔레그램 오케",
  orchestratorCwd: join(HOME, "paseo-work"),
  defaultModel: "claude-opus-5-5",
  modelAliases: { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5" },
  seats: DEFAULT_SEATS,
  usagePanel: false,
  workerRouting: "",
};

function isSeat(value: unknown): value is SeatDefinition {
  const seat = value as SeatDefinition;
  return Boolean(seat && typeof seat.key === "string" && typeof seat.label === "string" && seat.fallback?.provider && seat.fallback?.model);
}

/** Reads the settings file; anything missing or malformed keeps its default. */
export function loadSettings(file = PATHS.configFile): OrchestratorSettings {
  let raw: Partial<OrchestratorSettings> = {};
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  const text = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() ? value.trim() : fallback);
  const seats = Array.isArray(raw.seats) && raw.seats.length && raw.seats.every(isSeat)
    ? raw.seats.map((seat, index) => ({ ...seat, key: index === 0 ? "main" : seat.key, profileId: seat.profileId ?? "", nameHint: seat.nameHint ?? seat.label }))
    : DEFAULT_SETTINGS.seats;
  return {
    ownerName: text(raw.ownerName, DEFAULT_SETTINGS.ownerName),
    language: raw.language === "en" ? "en" : raw.language === "ko" ? "ko" : DEFAULT_SETTINGS.language,
    replyLanguage: text(raw.replyLanguage, raw.language === "en" ? "English" : DEFAULT_SETTINGS.replyLanguage),
    timeZone: text(raw.timeZone, DEFAULT_SETTINGS.timeZone),
    orchestratorTitle: text(raw.orchestratorTitle, DEFAULT_SETTINGS.orchestratorTitle),
    orchestratorCwd: text(raw.orchestratorCwd, DEFAULT_SETTINGS.orchestratorCwd),
    defaultModel: text(raw.defaultModel, DEFAULT_SETTINGS.defaultModel),
    modelAliases: raw.modelAliases && typeof raw.modelAliases === "object" ? raw.modelAliases : DEFAULT_SETTINGS.modelAliases,
    seats,
    usagePanel: typeof raw.usagePanel === "boolean" ? raw.usagePanel : DEFAULT_SETTINGS.usagePanel,
    workerRouting: typeof raw.workerRouting === "string" ? raw.workerRouting.trim() : DEFAULT_SETTINGS.workerRouting,
  };
}

export const SETTINGS = loadSettings();

/** Main seat first, then the backups in the order they take over. */
export const SEAT_CHAIN: readonly SeatDefinition[] = SETTINGS.seats;

/** A seat that stopped answering is retried this long after the switch, then with backoff. */
export const PRIMARY_RETRY_MS = 30 * 60 * 1000;
export const PRIMARY_RETRY_MAX_MS = 4 * 60 * 60 * 1000;

export const ORCHESTRATOR_TITLE = SETTINGS.orchestratorTitle;
export const DEFAULT_ORCHESTRATOR_MODEL = SETTINGS.defaultModel;
export const MODEL_ALIASES: Record<string, string> = SETTINGS.modelAliases;
export const ORCHESTRATOR_LABEL = { key: "telegram", orchestrator: "orchestrator", follow: "follow" };

/** Reads `NAME=value` lines (optionally `export`-prefixed and quoted). */
export function parseKeysFile(text: string, names: readonly string[]): Record<string, string> {
  const wanted = new Set(names);
  const found: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || !wanted.has(match[1])) continue;
    let value = match[2].trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    if (value) found[match[1]] = value;
  }
  return found;
}

export interface BridgeSecrets {
  telegramToken: string;
  chatId: number;
  openaiKey: string | null;
}


export function readSecrets(file = PATHS.keysFile): BridgeSecrets {
  // The Telegram pair is required; OPENAI_API_KEY is optional and only turns on voice transcription.
  const keys = parseKeysFile(readFileSync(file, "utf8"), ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "OPENAI_API_KEY"]);
  const chatId = Number(keys.TELEGRAM_CHAT_ID);
  if (!keys.TELEGRAM_BOT_TOKEN || !Number.isSafeInteger(chatId)) {
    throw new Error(`TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set in ${file}`);
  }
  return {
    telegramToken: keys.TELEGRAM_BOT_TOKEN,
    chatId,
    openaiKey: keys.OPENAI_API_KEY ?? null,
  };
}

/** The daemon's websocket URL, from `daemon.listen` in Paseo's config. */
export function daemonUrl(file = PATHS.paseoConfig): string {
  try {
    const config = JSON.parse(readFileSync(file, "utf8")) as { daemon?: { listen?: unknown } };
    const listen = config.daemon?.listen;
    if (typeof listen === "string" && /^[^/]+:\d+$/.test(listen)) return `ws://${listen}/ws`;
  } catch {
    // fall through to the documented default
  }
  return "ws://127.0.0.1:6767/ws";
}
