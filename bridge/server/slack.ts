import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Slack transport for the optional Slack lane: Web API calls with the bot token, and a
// Socket Mode connection with the app-level token. Socket Mode means Slack pushes events
// over a websocket this Mac opens itself, so no public server is needed.

export const SLACK_API_BASE = process.env.PASEO_SLACK_API_BASE ?? "https://slack.com/api";

export class SlackError extends Error {
  readonly method: string;
  readonly code: string;
  constructor(method: string, code: string) {
    super(`slack ${method}: ${code}`);
    this.method = method;
    this.code = code;
  }
}

export interface SlackFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  mode?: string;
  url_private_download?: string;
}

export interface SlackMessage {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  channel?: string;
  channel_type?: string;
  files?: SlackFile[];
  user_team?: string;
  team?: string;
}

export interface SlackUser {
  id: string;
  name: string;
  isBot: boolean;
  deleted: boolean;
  teamId: string | null;
}

export interface SlackMember {
  id?: string;
  name?: string;
  real_name?: string;
  profile?: { real_name?: string; display_name?: string };
  deleted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
}

export interface SlackIdentity {
  botUserId: string;
  botId: string;
  teamId: string;
  botName: string;
}

type Fetch = typeof fetch;
type Params = Record<string, string | number | boolean | undefined>;

async function slackCall<T>(fetcher: Fetch, base: string, token: string, method: string, params: Params = {}): Promise<T> {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) form.set(key, String(value));
  const response = await fetcher(`${base}/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 429) throw new SlackError(method, `ratelimited (retry after ${response.headers.get("retry-after") ?? "?"} s)`);
  const json = (await response.json()) as { ok?: boolean; error?: string } & T;
  if (!json.ok) throw new SlackError(method, json.error ?? `http_${response.status}`);
  return json;
}

export class SlackApi {
  private readonly token: string;
  private readonly fetcher: Fetch;
  private readonly base: string;
  private readonly users = new Map<string, SlackUser>();
  private readonly channels = new Map<string, string | null>();

  constructor(token: string, fetcher: Fetch = fetch, base = SLACK_API_BASE) {
    this.token = token;
    this.fetcher = fetcher;
    this.base = base;
  }

  call<T = Record<string, unknown>>(method: string, params: Params = {}): Promise<T> {
    return slackCall<T>(this.fetcher, this.base, this.token, method, params);
  }

  async identity(): Promise<SlackIdentity> {
    const me = await this.call<{ user_id: string; bot_id: string; team_id: string; user: string }>("auth.test");
    return { botUserId: me.user_id, botId: me.bot_id, teamId: me.team_id, botName: me.user };
  }

  async postMessage(channel: string, text: string, threadTs?: string): Promise<string> {
    const sent = await this.call<{ ts: string }>("chat.postMessage", {
      channel,
      text,
      thread_ts: threadTs,
      unfurl_links: false,
      unfurl_media: false,
    });
    return sent.ts;
  }

  async react(channel: string, ts: string, name: string): Promise<void> {
    try {
      await this.call("reactions.add", { channel, timestamp: ts, name });
    } catch {
      // already_reacted, or the message is gone: a missing 👀 is not worth an error
    }
  }

  async user(id: string): Promise<SlackUser> {
    const cached = this.users.get(id);
    if (cached) return cached;
    try {
      const { user } = await this.call<{
        user: { id: string; name?: string; real_name?: string; is_bot?: boolean; deleted?: boolean; team_id?: string; profile?: { display_name?: string; real_name?: string } };
      }>("users.info", { user: id });
      const name = user.profile?.display_name || user.profile?.real_name || user.real_name || user.name || id;
      const found = { id, name, isBot: Boolean(user.is_bot) || id === "USLACKBOT", deleted: Boolean(user.deleted), teamId: user.team_id ?? null };
      this.users.set(id, found);
      return found;
    } catch {
      return { id, name: id, isBot: false, deleted: false, teamId: null };
    }
  }

  /** Channel name without `#`; null for DMs and group DMs. */
  async channelName(id: string): Promise<string | null> {
    if (this.channels.has(id)) return this.channels.get(id) ?? null;
    let name: string | null = null;
    if (id.startsWith("C") || id.startsWith("G")) {
      try {
        const { channel } = await this.call<{ channel: { name?: string; is_mpim?: boolean } }>("conversations.info", { channel: id });
        name = channel.is_mpim ? null : (channel.name ?? null);
      } catch {
        name = null;
      }
    }
    this.channels.set(id, name);
    return name;
  }

  async replies(channel: string, threadTs: string, limit = 30): Promise<SlackMessage[]> {
    const out = await this.call<{ messages?: SlackMessage[] }>("conversations.replies", { channel, ts: threadTs, limit });
    return out.messages ?? [];
  }

  /** Newest first, as Slack returns it. */
  async history(channel: string, options: { oldest?: string; latest?: string; limit?: number }): Promise<SlackMessage[]> {
    const out = await this.call<{ messages?: SlackMessage[] }>("conversations.history", {
      channel,
      oldest: options.oldest,
      latest: options.latest,
      limit: options.limit ?? 50,
    });
    return out.messages ?? [];
  }

  /** Conversations the bot is a member of. */
  async memberOf(types: string): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const out = await this.call<{ channels?: Array<{ id: string }>; response_metadata?: { next_cursor?: string } }>("users.conversations", {
        types,
        limit: 200,
        exclude_archived: true,
        cursor,
      });
      ids.push(...(out.channels ?? []).map((channel) => channel.id));
      cursor = out.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    return ids;
  }

  /** Everyone in the workspace, for turning @Name into a real mention. */
  async members(): Promise<SlackMember[]> {
    const out: SlackMember[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const res = await this.call<{ members?: SlackMember[]; response_metadata?: { next_cursor?: string } }>("users.list", { limit: 200, cursor });
      out.push(...(res.members ?? []));
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    return out;
  }

  /** The DM channel with one person (opens it if needed). */
  async openDm(userId: string): Promise<string> {
    const res = await this.call<{ channel: { id: string } }>("conversations.open", { users: userId });
    return res.channel.id;
  }

  /** Saves a file teammates attached; refuses Slack's HTML login page and anything over `limit`. */
  async download(url: string, dir: string, name: string, limit: number): Promise<string> {
    const response = await this.fetcher(url, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
    if ((response.headers.get("content-type") ?? "").startsWith("text/html")) throw new Error("download failed: Slack returned a web page (files:read missing?)");
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > limit) throw new Error("file too large");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) throw new Error("file too large");
    await mkdir(dir, { recursive: true });
    const path = join(dir, name);
    await writeFile(path, bytes);
    return path;
  }
}

// ---------------------------------------------------------------- Socket Mode

interface Envelope {
  envelope_id?: string;
  type?: string;
  reason?: string;
  payload?: { event?: SlackMessage };
}

export interface SocketModeOptions {
  appToken: string;
  onEvent: (event: SlackMessage) => void;
  /** Every (re)connect: the place to catch up on what arrived while away. */
  onConnected: () => void;
  log: (line: string) => void;
  fetcher?: Fetch;
  base?: string;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/** Keeps one Socket Mode connection open and reconnects after drops, refreshes and sleep. */
export class SocketMode {
  private readonly options: SocketModeOptions;
  private current: WebSocket | null = null;

  constructor(options: SocketModeOptions) {
    this.options = options;
  }

  start(signal: AbortSignal): void {
    // A Mac that slept leaves a dead socket that may never fire "close": a jump in the
    // wall clock between ticks means we slept, so drop the socket and dial again.
    let lastTick = Date.now();
    const watchdog = setInterval(() => {
      const now = Date.now();
      if (now - lastTick > 90_000 && this.current) {
        this.options.log("slack: clock jumped (sleep?); reconnecting");
        try {
          this.current.close();
        } catch {
          // already closed
        }
      }
      lastTick = now;
    }, 30_000);
    signal.addEventListener("abort", () => clearInterval(watchdog), { once: true });
    void this.loop(signal);
  }

  private async loop(signal: AbortSignal): Promise<void> {
    let backoff = 2000;
    while (!signal.aborted) {
      try {
        const { url } = await slackCall<{ url: string }>(
          this.options.fetcher ?? fetch,
          this.options.base ?? SLACK_API_BASE,
          this.options.appToken,
          "apps.connections.open",
        );
        const stayed = await this.connectOnce(url, signal);
        if (stayed > 60_000) backoff = 2000;
      } catch (error) {
        this.options.log(`slack: connect failed: ${error instanceof Error ? error.message : error}`);
      }
      if (signal.aborted) break;
      await sleep(backoff, signal);
      backoff = Math.min(backoff * 2, 60_000);
    }
  }

  /** Resolves when the socket closes, with how long it stayed open. */
  private connectOnce(url: string, signal: AbortSignal): Promise<number> {
    return new Promise((resolve) => {
      const opened = Date.now();
      const ws = new WebSocket(url);
      this.current = ws;
      const close = () => {
        try {
          ws.close();
        } catch {
          // already closed
        }
      };
      signal.addEventListener("abort", close, { once: true });
      ws.addEventListener("message", (message) => {
        let envelope: Envelope;
        try {
          envelope = JSON.parse(String(message.data)) as Envelope;
        } catch {
          return;
        }
        // Ack first: Slack resends anything not acked within 3 s.
        if (envelope.envelope_id) ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
        if (envelope.type === "hello") {
          this.options.log("slack: connected");
          this.options.onConnected();
        } else if (envelope.type === "disconnect") {
          this.options.log(`slack: server asked to reconnect (${envelope.reason ?? "?"})`);
          close();
        } else if (envelope.type === "events_api" && envelope.payload?.event) {
          this.options.onEvent(envelope.payload.event);
        }
      });
      ws.addEventListener("close", () => {
        signal.removeEventListener("abort", close);
        if (this.current === ws) this.current = null;
        resolve(Date.now() - opened);
      });
      ws.addEventListener("error", () => {
        // "close" follows and drives the reconnect
      });
    });
  }
}
