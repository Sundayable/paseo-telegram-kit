#!/bin/bash
# Waits for the owner's first message to the bot (Start or "hi"), then saves that private
# chat as the only chat the bridge will answer. Run it BEFORE the plugin starts.
#   scripts/find-chat-id.sh [--wait SECONDS] [--pick N]
set -euo pipefail
source "$(dirname "$0")/lib.sh"
refuse_if_foreign

wait_s=180 pick=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --wait) wait_s="$2"; shift 2 ;;
    --pick) pick="$2"; shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done

token="$(key_get TELEGRAM_BOT_TOKEN)" || die "NO_TOKEN: save the bot token first (scripts/set-token.sh)."

deadline=$(( $(date +%s) + wait_s ))
while :; do
  reply="$(tg "$token" "getUpdates?timeout=20")"
  if [[ "$(printf '%s' "$reply" | json_get 'j.ok')" != "true" ]]; then
    code="$(printf '%s' "$reply" | json_get 'j.error_code')"
    [[ "$code" == "409" ]] && die "BOT_BUSY: another program is reading this bot's messages (maybe the bridge is already running). See troubleshooting."
    die "TELEGRAM_ERROR: getUpdates failed (${code:-no response}). Check the internet connection."
  fi
  # Private chats only, where the sender is a person and the chat is that person.
  chats="$(printf '%s' "$reply" | json_get '[...new Map(j.result.filter((u) => u.message && u.message.chat.type === "private" && u.message.from && !u.message.from.is_bot && u.message.from.id === u.message.chat.id).map((u) => [u.message.chat.id, { id: u.message.chat.id, name: [u.message.from.first_name, u.message.from.last_name].filter(Boolean).join(" "), username: u.message.from.username || "" }])).values()]')"
  last="$(printf '%s' "$reply" | json_get 'j.result.length ? j.result[j.result.length - 1].update_id : ""')"
  count="$(printf '%s' "$chats" | json_get 'j.length')"
  [[ "${count:-0}" -gt 0 ]] && break
  [[ $(date +%s) -lt $deadline ]] || die "NO_MESSAGE: nothing reached the bot in ${wait_s}s. Open the bot in Telegram, tap Start (or send hi), then run this again."
done

if [[ "$count" -gt 1 && -z "$pick" ]]; then
  say "MANY_CHATS: more than one person messaged this bot. Re-run with --pick N:"
  printf '%s' "$chats" | json_get 'j.map((c, i) => `${i + 1}. ${c.name}${c.username ? " (@" + c.username + ")" : ""}`).join("\n")'
  echo
  exit 2
fi
index=$(( ${pick:-1} - 1 ))
chat_id="$(printf '%s' "$chats" | json_get "j[$index] && String(j[$index].id)")"
name="$(printf '%s' "$chats" | json_get "j[$index] && j[$index].name")"
[[ -n "$chat_id" ]] || die "no chat number ${pick}"

printf '%s' "$chat_id" | key_set TELEGRAM_CHAT_ID
# Mark these messages read so the bridge does not treat "/start" as a request later.
[[ -n "$last" ]] && tg "$token" "getUpdates?offset=$((last + 1))&timeout=0" >/dev/null
lang="$(cat "$STATE_DIR/config.json" 2>/dev/null | json_get 'j.language' || true)"
if [[ "$lang" == "en" ]]; then text="✅ This chat is now linked to your Mac. Finish the setup there; I'll reply here once it's running."
else text="✅ 이 채팅이 Mac과 연결됐어요. Mac에서 설치를 마치면 여기로 답장이 옵니다."; fi
body="$(CHAT="$chat_id" TEXT="$text" node -e 'process.stdout.write(JSON.stringify({ chat_id: Number(process.env.CHAT), text: process.env.TEXT }))')"
tg "$token" sendMessage "$body" >/dev/null || true
unset token
say "OK: linked to ${name}'s private chat (chat id saved, not shown)."
