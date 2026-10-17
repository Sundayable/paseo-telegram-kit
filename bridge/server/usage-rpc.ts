import { randomUUID } from "node:crypto";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

/** Reuse the existing credential-owning plugin; no LLM turn or second Telegram poller. */
export async function fetchUsageSnapshot(url: string): Promise<unknown> {
  const client = new DaemonClient({
    url, clientId: `telegram-usage-${randomUUID()}`, clientType: "cli",
    connectTimeoutMs: 10_000, reconnect: { enabled: false },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await client.connect();
    return await Promise.race([
      client.invokePluginRpc("usage-remaining", "usage.list", { force: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("usage refresh timed out")), 25_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}
