import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { Bridge } from "./bridge.ts";
import { botCommands } from "./commands.ts";
import { daemonUrl, PATHS, readSecrets, SETTINGS } from "./config.ts";
import { createPaseoPort, PaseoConnection } from "./paseo-port.ts";
import { QueueStore } from "./queue.ts";
import { parseUsageCache } from "./stalls.ts";
import { StateStore } from "./state.ts";
import { TelegramApi, TelegramError } from "./telegram.ts";
import { transcribe } from "./transcribe.ts";
import { UsageReader } from "./usage-reader.ts";
import { fetchUsageSnapshot } from "./usage-rpc.ts";

export interface Runtime {
  bridge: Bridge | null;
  adopt(api: PaseoApi): void;
  stop(): Promise<void>;
}

const POLL_TIMEOUT_SECONDS = 30;
const TICK_MS = 60_000;

/** Proof of life for the launchd watchdog: written after every successful poll. */
function writeHeartbeat(file: string, fields: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify({ ...fields, pid: process.pid, at: new Date().toISOString(), atMs: Date.now() }));
    renameSync(`${file}.tmp`, file);
  } catch {
    // the watchdog reports a missing heartbeat on its own
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function pollLoop(
  telegram: TelegramApi,
  bridge: Bridge,
  state: StateStore,
  signal: AbortSignal,
  log: (line: string) => void,
  heartbeat: () => void,
) {
  let backoff = 1000;
  while (!signal.aborted) {
    try {
      const updates = await telegram.getUpdates(state.data.offset, POLL_TIMEOUT_SECONDS, signal);
      backoff = 1000;
      heartbeat();
      for (const update of updates) {
        // handleUpdate never throws, so the offset moves on even for a bad message; if
        // the process dies mid-update, Telegram re-sends it and the queue dedupes it.
        await bridge.handleUpdate(update);
        state.data.offset = update.update_id + 1;
        state.save();
      }
    } catch (error) {
      if (signal.aborted) break;
      const conflict = error instanceof TelegramError && error.code === 409;
      log(`${conflict ? "another getUpdates consumer is running" : "poll failed"}: ${error instanceof Error ? error.message : error}`);
      await sleep(conflict ? 30_000 : backoff, signal);
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

export function startRuntime(log: (line: string) => void): Runtime {
  let secrets;
  try {
    secrets = readSecrets();
  } catch (error) {
    log(`disabled: ${error instanceof Error ? error.message : error}`);
    return { bridge: null, adopt() {}, async stop() {} };
  }

  const telegram = new TelegramApi(secrets.telegramToken, secrets.chatId);
  const state = new StateStore(PATHS.stateFile);
  const connection = new PaseoConnection(() => daemonUrl());
  const openaiKey = secrets.openaiKey;
  const paseo = createPaseoPort(connection.get, () => daemonUrl());
  const bridge = new Bridge({
    telegram,
    paseo,
    state,
    chatId: secrets.chatId,
    orchestratorCwd: SETTINGS.orchestratorCwd,
    downloadDir: PATHS.downloadDir,
    homeDir: PATHS.home,
    transcribe: openaiKey ? (audio, filename) => transcribe(openaiKey, audio, filename) : null,
    log,
    queue: new QueueStore(PATHS.queueFile),
    usage: () => parseUsageCache(JSON.parse(readFileSync(PATHS.usageCache, "utf8"))),
    usageReader: new UsageReader({
      fetch: () => fetchUsageSnapshot(daemonUrl()),
      readCache: () => JSON.parse(readFileSync(PATHS.usageCache, "utf8")),
    }),
    usagePanel: SETTINGS.usagePanel,
  });

  const controller = new AbortController();
  const startedAt = new Date().toISOString();
  let bot: string | undefined;
  const heartbeat = () => writeHeartbeat(PATHS.heartbeatFile, { startedAt, bot, seat: state.data.seat });
  const ticker = setInterval(() => {
    bridge.tick().catch((error) => log(`tick failed: ${error instanceof Error ? error.message : error}`));
  }, TICK_MS);
  void (async () => {
    try {
      const me = await telegram.getMe();
      bridge.botUsername = me.username;
      bot = me.username;
      heartbeat();
      await bridge.resume();
      await telegram.setCommands(botCommands());
      log(`polling as @${me.username}`);
      if (SETTINGS.usagePanel) void bridge.refreshUsagePanel(true).catch(() => log("usage panel refresh failed; /usage remains available"));
    } catch (error) {
      log(`startup check failed: ${error instanceof Error ? error.message : error}`);
    }
    await pollLoop(telegram, bridge, state, controller.signal, log, heartbeat);
  })();

  return {
    bridge,
    adopt: (api) => connection.adopt(api),
    async stop() {
      clearInterval(ticker);
      controller.abort();
      bridge.stop();
      await connection.close();
      log("stopped");
    },
  };
}
