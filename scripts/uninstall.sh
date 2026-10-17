#!/bin/bash
# Removes the Telegram orchestrator again. Everything moved goes to the macOS Trash, so it
# can be put back; Paseo's config.json is backed up before the kit's profiles are removed.
#   scripts/uninstall.sh [--keep-data]
#   --keep-data  keep settings, secrets and history (a later install.sh picks them up again)
# Not touched: your Paseo sessions (archive them in Paseo if you like) and the bot itself
# (delete it in BotFather with /deletebot, or /revoke to cancel the token).
set -euo pipefail
source "$(dirname "$0")/lib.sh"

keep=0
for arg in "$@"; do
  case "$arg" in
    --keep-data) keep=1 ;;
    *) die "unknown option: $arg" ;;
  esac
done
stamp="$(date +%Y%m%d-%H%M%S)"
trash="${TGO_TRASH:-$HOME/.Trash}"

plugins="$(paseo_cli plugin ls --json 2>/dev/null || echo '[]')"
path="$(printf '%s' "$plugins" | json_get "(j.find((p) => p.id === '$PLUGIN_ID') || {}).path")"
if [[ -n "$path" && "$path" != "$PLUGIN_DEST" ]]; then
  die "FOREIGN_PLUGIN: the installed '$PLUGIN_ID' plugin was not installed by this kit; leaving it alone."
fi
if [[ -n "$path" ]]; then
  paseo_cli plugin remove "$PLUGIN_ID" >/dev/null && say "OK: bridge stopped and removed from Paseo"
fi

config="$PASEO_HOME_DIR/config.json"
if [[ -f "$config" ]] && grep -q 'agent_profile_tgk_' "$config"; then
  cp "$config" "$config.bak-telegram-kit-uninstall-$stamp"
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    const before = (c.daemon?.agentProfiles ?? []).length;
    if (c.daemon?.agentProfiles) c.daemon.agentProfiles = c.daemon.agentProfiles.filter((p) => !String(p.id).startsWith("agent_profile_tgk_"));
    fs.writeFileSync(file + ".tmp", JSON.stringify(c, null, 2) + "\n");
    fs.renameSync(file + ".tmp", file);
    console.log(`OK: removed ${before - c.daemon.agentProfiles.length} profiles (backup kept next to config.json)`);
  ' "$config"
  paseo_cli reload >/dev/null || true
fi

if [[ -d "$PLUGIN_DEST" ]]; then
  mv "$PLUGIN_DEST" "$trash/telegram-orchestrator-bridge-$stamp" && say "OK: bridge files moved to the Trash"
fi
if [[ $keep == 0 && -d "$STATE_DIR" ]]; then
  mv "$STATE_DIR" "$trash/telegram-orchestrator-data-$stamp" && say "OK: settings, secrets and history moved to the Trash (empty the Trash to delete the bot token for good)"
fi
say "Done. Last step by hand: in Telegram, open @BotFather and send /deletebot (or /revoke) for this bot."
