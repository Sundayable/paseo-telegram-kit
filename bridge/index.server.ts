import type { PluginServerContext } from "@getpaseo/plugin/server";
import { startRuntime } from "./server/main.ts";

export default function contribute(server: PluginServerContext) {
  const runtime = startRuntime((line) => console.log(`[telegram] ${line}`));
  const { bridge } = runtime;

  // Hooks time out after 30 s; Telegram delivery runs in the background instead.
  const background = (label: string, work: Promise<unknown>) => {
    work.catch((error) => console.error(`[telegram] ${label} failed: ${error instanceof Error ? error.message : error}`));
  };

  server.on("agent.turn_started", (event, context) => {
    runtime.adopt(context.paseo);
    bridge?.onTurnStarted(event.agent.id);
  });

  server.on("agent.turn_ended", (event, context) => {
    runtime.adopt(context.paseo);
    if (bridge) background("turn_ended", bridge.onTurnEnded(event.agent, event.outcome, event.timeline));
  });

  server.on("agent.permission_requested", (event, context) => {
    runtime.adopt(context.paseo);
    if (bridge) background("permission_requested", bridge.onPermissionRequested(event.agent, event.request));
  });

  server.on("agent.permission_resolved", (event, context) => {
    runtime.adopt(context.paseo);
    if (bridge) background("permission_resolved", bridge.onPermissionResolved(event.agent.id, event.requestId));
  });

  return () => runtime.stop();
}
