#!/bin/bash
# Optional: saves an OpenAI API key so voice notes can be transcribed. Never prints it.
#   scripts/set-voice-key.sh --clipboard | --stdin | (hidden prompt)
#   scripts/set-voice-key.sh --remove
set -euo pipefail
source "$(dirname "$0")/lib.sh"
refuse_if_foreign

mode=prompt
case "${1:-}" in
  --clipboard) mode=clipboard ;;
  --stdin) mode=stdin ;;
  --remove) key_remove OPENAI_API_KEY; say "OK: voice key removed. Run install.sh again to reload the bridge."; exit 0 ;;
  "") ;;
  *) die "unknown option: $1" ;;
esac
case "$mode" in
  clipboard) key="$(pbpaste 2>/dev/null || true)" ;;
  stdin) key="$(cat)" ;;
  prompt)
    [[ -t 0 ]] || die "no terminal for a hidden prompt; use --clipboard or --stdin"
    printf 'Paste the OpenAI API key (input hidden): '
    IFS= read -rs key
    printf '\n'
    ;;
esac
copied="$key"
key="$(printf '%s' "$key" | tr -d '[:space:]')"
[[ "$key" =~ ^sk-[A-Za-z0-9_-]{20,}$ ]] || die "NOT_A_KEY: that does not look like an OpenAI API key (sk-...)."
code="$(printf 'url = "https://api.openai.com/v1/models"\nheader = "Authorization: Bearer %s"\n' "$key" \
  | curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -K - 2>/dev/null || true)"
[[ "$code" == "200" ]] || die "KEY_REJECTED: OpenAI did not accept this key (HTTP ${code:-none})."
printf '%s' "$key" | key_set OPENAI_API_KEY
if [[ $mode == clipboard ]] && [[ "$(pbpaste 2>/dev/null || true)" == "$copied" ]]; then printf '' | pbcopy; fi
unset key copied
say "OK: voice key saved (not shown). Run install.sh again to reload the bridge."
