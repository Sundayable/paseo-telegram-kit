#!/bin/bash
# Saves a Slack token for the optional Slack lane without ever printing it.
# The prefix decides where it goes: xoxb-… = bot token (SLACK_BOT_TOKEN),
# xapp-… = app-level token with connections:write (SLACK_APP_TOKEN).
#   scripts/set-slack-token.sh --clipboard   # copied from the Slack app settings page
#   scripts/set-slack-token.sh --stdin       # piped in
#   scripts/set-slack-token.sh               # hidden prompt (run it in your own Terminal)
set -euo pipefail
source "$(dirname "$0")/lib.sh"
refuse_if_foreign

SLACK_API="${PASEO_SLACK_API_BASE:-https://slack.com/api}"
mode=prompt
for arg in "$@"; do
  case "$arg" in
    --clipboard) mode=clipboard ;;
    --stdin) mode=stdin ;;
    *) die "unknown option: $arg" ;;
  esac
done

case "$mode" in
  clipboard) token="$(pbpaste 2>/dev/null || true)" ;;
  stdin) token="$(cat)" ;;
  prompt)
    [[ -t 0 ]] || die "no terminal for a hidden prompt; use --clipboard or --stdin"
    printf 'Paste the Slack token (input hidden): '
    IFS= read -rs token
    printf '\n'
    ;;
esac
clipboard_text="$token"
token="$(printf '%s' "$token" | grep -oE 'xox[bp]-[A-Za-z0-9-]{20,}|xapp-[A-Za-z0-9-]{20,}' | head -n1 || true)"
[[ -n "$token" ]] || die "NOT_A_TOKEN: copy the Bot User OAuth Token (xoxb-…) or the app-level token (xapp-…) again."

# slack METHOD → raw JSON; the token travels in curl's config on stdin, never in argv.
slack() {
  printf 'url = "%s/%s"\nrequest = "POST"\nheader = "authorization: Bearer %s"\nheader = "content-type: application/x-www-form-urlencoded"\n' \
    "$SLACK_API" "$1" "$token" | curl -sS --max-time 30 -K - 2>/dev/null
}

case "$token" in
  xoxb-*)
    reply="$(slack auth.test)"
    [[ "$(printf '%s' "$reply" | json_get 'j.ok')" == "true" ]] || die "TOKEN_REJECTED: Slack did not accept this bot token ($(printf '%s' "$reply" | json_get 'j.error'))."
    printf '%s' "$token" | key_set SLACK_BOT_TOKEN
    say "OK: bot token saved for @$(printf '%s' "$reply" | json_get 'j.user') in $(printf '%s' "$reply" | json_get 'j.team') (value not shown)."
    ;;
  xapp-*)
    reply="$(slack apps.connections.open)"
    [[ "$(printf '%s' "$reply" | json_get 'j.ok')" == "true" ]] || die "TOKEN_REJECTED: Slack did not accept this app-level token ($(printf '%s' "$reply" | json_get 'j.error')). It needs the connections:write scope and Socket Mode switched on."
    printf '%s' "$token" | key_set SLACK_APP_TOKEN
    say "OK: app-level token saved; Socket Mode answers (value not shown)."
    ;;
  *) die "NOT_A_BOT_TOKEN: that is a user token (xoxp-…). Copy the Bot User OAuth Token (xoxb-…) instead." ;;
esac

if [[ $mode == clipboard ]] && [[ "$(pbpaste 2>/dev/null || true)" == "$clipboard_text" ]]; then
  printf '' | pbcopy
fi
unset token clipboard_text reply
