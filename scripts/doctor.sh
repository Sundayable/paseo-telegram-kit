#!/bin/bash
# Read-only check of everything the Telegram orchestrator needs. Prints one line per check:
#   <CHECK> <OK|MISSING|WARN|FAIL> <detail>
# and never prints a secret. Safe to run any time.
set -uo pipefail
source "$(dirname "$0")/lib.sh"

line() { printf '%-14s %-8s %s\n' "$1" "$2" "$3"; }

[[ "$(uname -s)" == "Darwin" ]] && line MAC OK "$(sw_vers -productVersion 2>/dev/null)" || line MAC FAIL "this kit supports macOS only"

if [[ -d /Applications/Paseo.app ]]; then line PASEO_APP OK "installed"
else line PASEO_APP MISSING "install Paseo from https://paseo.sh and open it once"; fi

status_json=""
if [[ -n "$PASEO_BIN" ]]; then status_json="$(paseo_cli status --json 2>/dev/null || true)"; fi
if [[ "$(printf '%s' "$status_json" | json_get 'j.localDaemon')" == "running" ]]; then
  line PASEO_DAEMON OK "version $(printf '%s' "$status_json" | json_get 'j.daemonVersion')"
else
  line PASEO_DAEMON MISSING "open the Paseo app (it starts the background service)"
fi
for provider in claude codex; do
  available="$(printf '%s' "$status_json" | json_get "(j.providers || []).some((p) => p.provider === '$provider' && p.available)")"
  name="$(printf '%s' "$provider" | tr '[:lower:]' '[:upper:]')"
  if [[ "$available" == "true" ]]; then line "AI_$name" OK "available in Paseo"
  elif [[ $provider == claude ]]; then line "AI_$name" MISSING "install Claude Code and log in (claude, then /login)"
  else line "AI_$name" WARN "optional backup; install Codex and log in to enable it"; fi
done

if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [[ "$major" -ge 20 ]]; then line NODE OK "$(node --version)"; else line NODE MISSING "Node.js 20 or newer needed (found $(node --version))"; fi
else
  line NODE MISSING "Node.js 20 or newer needed"
fi
command -v npm >/dev/null 2>&1 && line NPM OK "$(npm --version)" || line NPM MISSING "comes with Node.js"
command -v brew >/dev/null 2>&1 && line HOMEBREW OK "available" || line HOMEBREW WARN "not installed (only needed to install Node.js the easy way)"

[[ -f "$STATE_DIR/config.json" ]] && line SETTINGS OK "name=$(json_get 'j.ownerName' < "$STATE_DIR/config.json") language=$(json_get 'j.language' < "$STATE_DIR/config.json")" || line SETTINGS MISSING "run scripts/configure.sh"
key_has TELEGRAM_BOT_TOKEN && line BOT_TOKEN OK "saved (not shown)" || line BOT_TOKEN MISSING "create a bot with BotFather, then scripts/set-token.sh --clipboard"
key_has TELEGRAM_CHAT_ID && line CHAT OK "linked (not shown)" || line CHAT MISSING "tap Start in your bot, then scripts/find-chat-id.sh"
if [[ -f "$KEYS_FILE" ]]; then
  mode="$(stat -f '%Lp' "$KEYS_FILE")"
  [[ "$mode" == "600" ]] && line SECRETS_FILE OK "private (600)" || line SECRETS_FILE WARN "permissions are $mode; run: chmod 600 on the secrets file"
fi

config="$PASEO_HOME_DIR/config.json"
if [[ -f "$config" ]]; then
  mcp="$(json_get '!!(j.daemon && j.daemon.mcp && j.daemon.mcp.enabled && j.daemon.mcp.injectIntoAgents)' < "$config")"
  [[ "$mcp" == "true" ]] && line PASEO_TOOLS OK "agents get Paseo's tools" || line PASEO_TOOLS MISSING "install.sh turns this on"
fi

plugins="$(paseo_cli plugin ls --json 2>/dev/null || echo '[]')"
path="$(printf '%s' "$plugins" | json_get "(j.find((p) => p.id === '$PLUGIN_ID') || {}).path")"
state="$(printf '%s' "$plugins" | json_get "(j.find((p) => p.id === '$PLUGIN_ID') || {}).status")"
if [[ -z "$path" ]]; then line BRIDGE MISSING "run scripts/install.sh"
elif [[ "$path" != "$PLUGIN_DEST" ]]; then line BRIDGE FAIL "a different '$PLUGIN_ID' plugin is installed from another folder; this kit will not touch it"
elif [[ "$state" == "running" ]]; then line BRIDGE OK "running"
else line BRIDGE FAIL "installed but $state; see troubleshooting"; fi

beat="$STATE_DIR/heartbeat.json"
if [[ -f "$beat" ]]; then
  age=$(( $(date +%s) - $(json_get 'Math.floor(j.atMs / 1000)' < "$beat") ))
  bot="$(json_get 'j.bot' < "$beat")"
  if [[ $age -lt 180 ]]; then line TELEGRAM OK "listening as @$bot (last check ${age}s ago)"
  else line TELEGRAM FAIL "no contact with Telegram for ${age}s; see troubleshooting"; fi
else
  line TELEGRAM MISSING "the bridge has not connected yet"
fi
