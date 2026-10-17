import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { createPaseoClient, type PaseoAgent, type PaseoApi, type PaseoClient } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentPermissionResponse, AgentTimelineItem } from "@getpaseo/protocol/agent-types";

const execFileAsync = promisify(execFile);

export interface AgentSummary {
  id: string;
  title: string | null;
  status: string;
  provider: string;
  model: string | null;
  cwd: string;
  updatedAt: string;
  labels: Record<string, string>;
  attentionReason: string | null;
  /** When the agent last asked for attention (finished, error, permission). */
  attentionAt: string | null;
  lastUserMessageAt: string | null;
  lastError: string | null;
  archivedAt: string | null;
}

export interface ProfileSummary {
  id: string;
  name: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
}

export interface ImageInput {
  data: string;
  mimeType: string;
}

export interface CreateAgentInput {
  provider: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  systemPrompt: string;
  cwd: string;
  title: string;
  labels: Record<string, string>;
  prompt: string;
  images: ImageInput[];
}

/** What the bridge needs from Paseo; the tests substitute a fake. */
export interface PaseoPort {
  listAgents(limit: number): Promise<AgentSummary[]>;
  getAgent(id: string): Promise<AgentSummary | null>;
  send(id: string, text: string, images: ImageInput[]): Promise<void>;
  create(input: CreateAgentInput): Promise<string>;
  respond(id: string, requestId: string, response: AgentPermissionResponse): Promise<void>;
  timeline(id: string): Promise<AgentTimelineItem[]>;
  profiles(): Promise<ProfileSummary[]>;
  stop(id: string): Promise<void>;
  setModel(id: string, model: string): Promise<void>;
  archive(id: string): Promise<void>;
}

function summarize(agent: PaseoAgent): AgentSummary {
  return {
    id: agent.id,
    title: agent.title,
    status: agent.status,
    provider: agent.provider,
    model: agent.model,
    cwd: agent.cwd,
    updatedAt: agent.updatedAt,
    labels: agent.labels ?? {},
    attentionReason: agent.requiresAttention ? agent.attentionReason ?? null : null,
    attentionAt: agent.attentionTimestamp ?? null,
    lastUserMessageAt: agent.lastUserMessageAt ?? null,
    lastError: agent.lastError ?? null,
    archivedAt: agent.archivedAt ?? null,
  };
}

/**
 * Hook callbacks hand the plugin the runtime's own IPC API; the Telegram poller
 * runs outside any hook, so until one fires it uses its own websocket client.
 */
export class PaseoConnection {
  private hookApi: PaseoApi | null = null;
  private client: PaseoClient | null = null;
  private connecting: Promise<PaseoApi> | null = null;
  private readonly url: () => string;

  constructor(url: () => string) {
    this.url = url;
  }

  adopt(api: PaseoApi): void {
    this.hookApi ??= api;
  }

  get = async (): Promise<PaseoApi> => {
    if (this.hookApi) return this.hookApi;
    if (this.client) return this.client;
    this.connecting ??= (async () => {
      const client = createPaseoClient({ url: this.url(), connectTimeoutMs: 10_000, reconnect: { enabled: true } });
      await client.connect();
      this.client = client;
      return client;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  };

  async close(): Promise<void> {
    await this.client?.close().catch(() => {});
    this.client = null;
  }
}

function paseoBinary(): string {
  return ["/opt/homebrew/bin/paseo", "/usr/local/bin/paseo"].find((path) => existsSync(path)) ?? "paseo";
}

export function createPaseoPort(getApi: () => Promise<PaseoApi>, daemonUrl: () => string): PaseoPort {
  return {
    async listAgents(limit) {
      const api = await getApi();
      const result = await api.agents.list({
        filter: { includeArchived: false },
        sort: [{ key: "updated_at", direction: "desc" }],
        page: { limit },
      });
      return result.entries.map((entry) => summarize(entry.agent));
    },
    async getAgent(id) {
      const api = await getApi();
      try {
        const result = await api.agents.ref(id).refresh();
        return result ? summarize(result.agent) : null;
      } catch {
        return null;
      }
    },
    async send(id, text, images) {
      const api = await getApi();
      await api.agents.ref(id).send(text, images.length ? { images } : undefined);
    },
    async create(input) {
      const api = await getApi();
      const handle = await api.agents.create({
        config: {
          provider: input.provider,
          modeId: input.modeId,
          thinkingOptionId: input.thinkingOptionId,
          featureValues: input.featureValues,
          systemPrompt: input.systemPrompt,
        },
        cwd: input.cwd,
        title: input.title,
        labels: input.labels,
        prompt: input.prompt,
        images: input.images.length ? input.images : undefined,
      });
      return handle.id;
    },
    async respond(id, requestId, response) {
      const api = await getApi();
      await api.agents.ref(id).respondToPermission({ requestId, response });
    },
    async timeline(id) {
      const api = await getApi();
      const page = await api.agents.ref(id).timeline.refetch({ direction: "tail", limit: 200 });
      return page.entries.map((entry) => entry.item);
    },
    async profiles() {
      const api = await getApi();
      const { config } = await api.config.get();
      return ((config as { agentProfiles?: ProfileSummary[] }).agentProfiles ?? []).slice();
    },
    async stop(id) {
      // The SDK has no interrupt call; the CLI does.
      await execFileAsync(paseoBinary(), ["stop", id], { timeout: 30_000 });
    },
    async archive(id) {
      const api = await getApi();
      await api.agents.ref(id).archive();
    },
    async setModel(id, model) {
      // Neither the public SDK nor the CLI can change a live agent's model; the
      // daemon client the SDK is built on can. Short-lived connection, rare call.
      const client = new DaemonClient({
        url: daemonUrl(),
        clientId: `telegram-orchestrator-${randomUUID()}`,
        clientType: "cli",
        connectTimeoutMs: 10_000,
        reconnect: { enabled: false },
      });
      await client.connect();
      try {
        await client.setAgentModel(id, model);
      } finally {
        await client.close().catch(() => {});
      }
    },
  };
}
