#!/bin/bash
# Saves the bot token from BotFather without ever printing it.
#   scripts/set-token.sh --clipboard   # the token was copied in Telegram (usual path)
#   scripts/set-token.sh --stdin       # the token is piped in
#   scripts/set-token.sh               # hidden prompt (run it in your own Terminal)
#   add --replace to overwrite a different token that is already saved
#   add --clear-webhook if the bot was used by another service before
set -euo pipefail
source "$(dirname "$0")/lib.sh"
refuse_if_foreign

mode=prompt replace=0 clear_webhook=0
for arg in "$@"; do
  case "$arg" in
    --clipboard) mode=clipboard ;;
    --stdin) mode=stdin ;;
    --replace) replace=1 ;;
    --clear-webhook) clear_webhook=1 ;;
    *) die "unknown option: $arg" ;;
  esac
done

case "$mode" in
  clipboard) token="$(pbpaste 2>/dev/null || true)" ;;
  stdin) token="$(cat)" ;;
  prompt)
    [[ -t 0 ]] || die "no terminal for a hidden prompt; use --clipboard or --stdin"
    printf 'Paste the bot token (input hidden): '
    IFS= read -rs token
    printf '\n'
    ;;
esac
clipboard_text="$token"
# BotFather's whole message may have been copied: take the first token-shaped word.
# (Search the raw text; stripping spaces first would glue the next word onto it.)
found="$(printf '%s' "$token" | grep -oE '[0-9]{5,15}:[A-Za-z0-9_-]{30,}' | head -n1 || true)"
token="${found:-$(printf '%s' "$token" | tr -d '[:space:]')}"
unset found
valid_token_shape "$token" || die "NOT_A_TOKEN: that does not look like a bot token (123456789:ABC...). Copy the token from BotFather again."

reply="$(tg "$token" getMe)"
[[ "$(printf '%s' "$reply" | json_get 'j.ok')" == "true" ]] || die "TOKEN_REJECTED: Telegram did not accept this token. In BotFather: /mybots → your bot → API Token, copy it again."
username="$(printf '%s' "$reply" | json_get 'j.result.username')"

if existing="$(key_get TELEGRAM_BOT_TOKEN 2>/dev/null)" && [[ "$existing" != "$token" ]]; then
  [[ $replace == 1 ]] || die "OTHER_TOKEN_SAVED: a different bot token is already saved. Re-run with --replace to switch to @$username."
  key_remove TELEGRAM_CHAT_ID  # the saved chat belonged to the old bot
fi
printf '%s' "$token" | key_set TELEGRAM_BOT_TOKEN

webhook="$(tg "$token" getWebhookInfo | json_get 'j.result.url')"
if [[ -n "$webhook" && $clear_webhook == 1 ]]; then
  tg "$token" deleteWebhook >/dev/null && webhook="" && say "OK: webhook removed; the bridge can read this bot's messages now."
fi
[[ -z "$webhook" ]] || say "WARNING WEBHOOK_SET: this bot sends its messages to a webhook, so the bridge cannot read them. See troubleshooting in SKILL.md."

if [[ $mode == clipboard ]] && [[ "$(pbpaste 2>/dev/null || true)" == "$clipboard_text" ]]; then
  printf '' | pbcopy  # do not leave the token on the clipboard
fi
unset token existing clipboard_text
say "OK: token saved for @$username (value not shown; the secrets file is private, mode 600)."
