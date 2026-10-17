import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { escapeHtml, markdownToTelegramHtml } from "./format.ts";
import { owner, ownerWith, t } from "./i18n.ts";
import type { PendingAction, PendingQuestion } from "./state.ts";
import type { InlineButton } from "./telegram.ts";

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/** Claude's AskUserQuestion shape: `{ questions: [{ question, header, options: [{ label }] }] }`. */
export function questionsOf(request: AgentPermissionRequest): PendingQuestion[] | null {
  const raw = (request.input as Record<string, unknown> | undefined)?.questions;
  if (!Array.isArray(raw)) return null;
  const questions: PendingQuestion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const question = stringField(record, "question") ?? stringField(record, "header");
    if (!question) continue;
    const options = (Array.isArray(record.options) ? record.options : [])
      .map((option) =>
        typeof option === "string" ? option : stringField(option as Record<string, unknown>, "label"),
      )
      .filter((label): label is string => Boolean(label));
    questions.push({ question, header: stringField(record, "header") ?? undefined, options });
  }
  return questions.length ? questions : null;
}

export function actionsOf(request: AgentPermissionRequest): PendingAction[] {
  if (request.actions?.length) {
    return request.actions.map((action) => ({
      label: action.label,
      behavior: action.behavior,
      selectedActionId: action.id,
    }));
  }
  return [
    { label: t("허용", "Allow"), behavior: "allow" },
    { label: t("거부", "Deny"), behavior: "deny" },
  ];
}

export function describeRequest(request: AgentPermissionRequest): string {
  const input = request.input as Record<string, unknown> | undefined;
  const lines = [`<b>${escapeHtml(request.title ?? request.name)}</b>`];
  if (request.description) lines.push(escapeHtml(truncate(request.description, 600)));
  const command = stringField(input, "command") ?? stringField(input, "cmd");
  const plan = stringField(input, "plan");
  if (command) lines.push(`<pre>${escapeHtml(truncate(command, 1500))}</pre>`);
  else if (plan) lines.push(markdownToTelegramHtml(truncate(plan, 2500)));
  else if (input && Object.keys(input).length) {
    lines.push(`<pre>${escapeHtml(truncate(JSON.stringify(input, null, 1), 800))}</pre>`);
  }
  return lines.join("\n");
}

export function questionHtml(question: PendingQuestion, position: number, total: number): string {
  const counter = total > 1 ? ` (${position + 1}/${total})` : "";
  const lines = [`❓${counter} <b>${escapeHtml(question.question)}</b>`];
  lines.push(
    question.options.length
      ? t("<i>버튼을 누르거나, 다른 답은 이 메시지에 답장으로 보내세요.</i>", "<i>Tap a button, or reply to this message with a different answer.</i>")
      : t("<i>이 메시지에 답장으로 답을 보내세요.</i>", "<i>Reply to this message with your answer.</i>"),
  );
  return lines.join("\n");
}

export function optionButtons(token: string, question: PendingQuestion): InlineButton[][] {
  return question.options.slice(0, 10).map((label, index) => [
    { text: truncate(label, 60), callback_data: `q:${token}:${index}` },
  ]);
}

export function actionButtons(token: string, actions: readonly PendingAction[]): InlineButton[][] {
  const buttons = actions.map((action, index) => ({
    text: truncate(action.label, 40),
    callback_data: `p:${token}:${index}`,
  }));
  const compact = buttons.length <= 3 && buttons.every((button) => button.text.length <= 12);
  return compact ? [buttons] : buttons.map((button) => [button]);
}

export function answerResponse(answers: Record<string, string>): AgentPermissionResponse {
  return { behavior: "allow", updatedInput: { answers } };
}

export function actionResponse(action: PendingAction): AgentPermissionResponse {
  return action.behavior === "allow"
    ? { behavior: "allow", selectedActionId: action.selectedActionId }
    : { behavior: "deny", selectedActionId: action.selectedActionId, message: t(`${ownerWith("이", "가")} 텔레그램에서 거부했습니다.`, `${owner()} denied this from Telegram.`) };
}

export function denyWithMessage(message: string): AgentPermissionResponse {
  return { behavior: "deny", message: t(`${ownerWith("이", "가")} 텔레그램에서 거부하며 남긴 말: ${message}`, `${owner()} denied this from Telegram and said: ${message}`) };
}
