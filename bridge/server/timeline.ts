import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

/**
 * The text an agent ended its latest turn with. Assistant text arrives in chunks
 * that are concatenated; a tool call or other item between chunks starts a new
 * segment, and only the last segment is the reply (earlier ones are narration
 * like "checking the logs…"). Reasoning never counts.
 */
export function finalAssistantText(timeline: readonly AgentTimelineItem[]): string {
  let start = 0;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index].type === "user_message") {
      start = index + 1;
      break;
    }
  }
  let last = "";
  let current = "";
  for (const item of timeline.slice(start)) {
    if (item.type === "assistant_message") {
      current += item.text;
    } else if (item.type !== "reasoning") {
      if (current.trim()) last = current;
      current = "";
    }
  }
  if (current.trim()) last = current;
  return last.trim();
}

/** Errors the provider reported during the latest turn. */
export function latestErrors(timeline: readonly AgentTimelineItem[]): string[] {
  const errors: string[] = [];
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (item.type === "user_message") break;
    if (item.type === "error") errors.unshift(item.message);
  }
  return errors;
}
