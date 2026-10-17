#!/bin/bash
# Installs (or updates) the Telegram bridge plugin into Paseo, adds the orchestrator and
# worker profiles, and waits until the bridge is listening to Telegram.
#   scripts/install.sh [--dry-run]
# Needs: scripts/configure.sh, set-token.sh and find-chat-id.sh done first.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

dry=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry=1 ;;
    *) die "unknown option: $arg" ;;
  esac
done
run() { if [[ $dry == 1 ]]; then say "DRY-RUN: $*"; else "$@"; fi; }

# ---------------------------------------------------------------- preflight
command -v node >/dev/null && command -v npm >/dev/null || die "NO_NODE: install Node.js 20+ first"
[[ -f "$STATE_DIR/config.json" ]] || die "NO_SETTINGS: run scripts/configure.sh first"
key_has TELEGRAM_BOT_TOKEN || die "NO_TOKEN: run scripts/set-token.sh first"
key_has TELEGRAM_CHAT_ID || die "NO_CHAT: run scripts/find-chat-id.sh first"
status_json="$(paseo_cli status --json 2>/dev/null || true)"
[[ "$(printf '%s' "$status_json" | json_get 'j.localDaemon')" == "running" ]] || die "NO_DAEMON: open the Paseo app first"
has_provider() { [[ "$(printf '%s' "$status_json" | json_get "(j.providers || []).some((p) => p.provider === '$1' && p.available)")" == "true" ]]; }
claude=0; has_provider claude && claude=1
codex=0; has_provider codex && codex=1
[[ $claude == 1 || $codex == 1 ]] || die "NO_AI: neither Claude Code nor Codex is available in Paseo (install one and log in)"

plugins="$(paseo_cli plugin ls --json 2>/dev/null || echo '[]')"
existing="$(printf '%s' "$plugins" | json_get "(j.find((p) => p.id === '$PLUGIN_ID') || {}).path")"
if [[ -n "$existing" && "$existing" != "$PLUGIN_DEST" ]]; then
  die "FOREIGN_PLUGIN: a '$PLUGIN_ID' plugin is already installed from another folder. This kit will not replace it."
fi

# Pick models that this Mac's Paseo actually offers (first choice, else the provider's first model).
pick_model() {  # provider preferred
  local list
  list="$(paseo_cli provider models "$1" --json 2>/dev/null || echo '[]')"
  printf '%s' "$list" | json_get "(j.find((m) => m.id === '$2') || j[0] || {}).id"
}
claude_model=""
[[ $claude == 1 ]] && claude_model="$(pick_model claude claude-opus-5-5)"
[[ -n "$claude_model" ]] || claude=0
codex_model=""
[[ $codex == 1 ]] && codex_model="$(pick_model codex gpt-6-astra)"
[[ -n "$codex_model" ]] || codex=0
[[ $claude == 1 || $codex == 1 ]] || die "NO_MODELS: Paseo lists no models (log in to Claude Code or Codex, then reopen Paseo)"
claude_modes="$(printf '%s' "$(paseo_cli provider ls --json 2>/dev/null || echo '[]')" | json_get "(j.find((p) => p.provider === 'claude') || {}).modes")"
worker_mode=acceptEdits
[[ "$claude_modes" == *"Auto mode"* ]] && worker_mode=auto

say "Plan:"
say "  bridge folder : $PLUGIN_DEST"
if [[ $claude == 1 ]]; then
  say "  orchestrator  : claude/$claude_model$([[ $codex == 1 ]] && printf ' (backup: codex/%s)' "$codex_model")"
  say "  workers       : claude/$claude_model ($worker_mode)$([[ $codex == 1 ]] && printf ', codex/%s' "$codex_model")"
else
  say "  orchestrator  : codex/$codex_model (Claude not available)"
  say "  workers       : codex/$codex_model"
fi

# ---------------------------------------------------------------- 1. bridge files
run mkdir -p "$PLUGIN_DEST"
run rsync -a --delete --exclude node_modules --exclude tests --exclude .gitignore "$SKILL_DIR/bridge/" "$PLUGIN_DEST/"
if [[ $dry == 0 ]]; then
  (cd "$PLUGIN_DEST" && npm ci --omit=dev --no-audit --no-fund --loglevel=error >/dev/null) || die "NPM_FAILED: could not download the bridge's parts (check the internet connection, then retry)"
fi

# ---------------------------------------------------------------- 2. settings + profiles
backup="$PASEO_HOME_DIR/config.json.bak-telegram-kit-$(date +%Y%m%d-%H%M%S)"
if [[ $dry == 0 ]]; then
  cp "$PASEO_HOME_DIR/config.json" "$backup"
  CLAUDE="$claude" CLAUDE_MODEL="$claude_model" CODEX_MODEL="$codex_model" CODEX="$codex" WORKER_MODE="$worker_mode" \
  PASEO_CONFIG="$PASEO_HOME_DIR/config.json" SETTINGS="$STATE_DIR/config.json" PLUGIN_DEST="$PLUGIN_DEST" \
  node "$SKILL_DIR/scripts/write-config.mjs"
  say "OK: Paseo settings updated (backup: $(basename "$backup"))"
else
  say "DRY-RUN: back up Paseo config.json, add 'agent_profile_tgk_*' profiles, turn on plugins + agent tools, write seats into settings"
fi
run paseo_cli reload >/dev/null

# ---------------------------------------------------------------- 3. start the bridge
started=$(date +%s)
if [[ -z "$existing" ]]; then
  run paseo_cli plugin install "$PLUGIN_DEST" >/dev/null
else
  run paseo_cli plugin reload "$PLUGIN_ID" >/dev/null
fi
[[ $dry == 1 ]] && { say "DRY-RUN: done (nothing changed)"; exit 0; }

for _ in $(seq 1 45); do
  if [[ -f "$STATE_DIR/heartbeat.json" ]]; then
    at=$(json_get 'Math.floor(j.atMs / 1000)' < "$STATE_DIR/heartbeat.json")
    bot="$(json_get 'j.bot' < "$STATE_DIR/heartbeat.json")"
    if [[ -n "$at" && $at -ge $started && -n "$bot" ]]; then
      say "OK: bridge is listening as @$bot. Send it a message from your phone to test."
      exit 0
    fi
  fi
  sleep 2
done
say "The bridge did not report in within 90 seconds. Last log lines:"
paseo_cli plugin logs "$PLUGIN_ID" 2>/dev/null | tail -n 15
exit 1
