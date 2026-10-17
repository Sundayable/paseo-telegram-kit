#!/bin/bash
# Round-trip test helper: after the owner sends a message from the phone, waits until the
# orchestrator seat exists and has finished answering.
#   scripts/check-reply.sh [--wait SECONDS]
set -euo pipefail
source "$(dirname "$0")/lib.sh"

wait_s=240
[[ "${1:-}" == "--wait" ]] && wait_s="$2"
deadline=$(( $(date +%s) + wait_s ))
state="$STATE_DIR/state.json"

id=""
while [[ $(date +%s) -lt $deadline ]]; do
  [[ -f "$state" ]] && id="$(json_get 'j.orchestratorId' < "$state")"
  if [[ -n "$id" ]]; then
    status="$(paseo_cli inspect "$id" --json 2>/dev/null | json_get 'String(j.Status || j.status || "").toLowerCase()')"
    if [[ "$status" == "idle" ]]; then
      say "OK: the orchestrator (${id:0:7}) answered. Check your phone for the reply."
      exit 0
    fi
    [[ "$status" == "error" ]] && { say "FAIL: the orchestrator ${id:0:7} stopped with an error:"; paseo_cli logs "$id" 2>/dev/null | tail -n 15; exit 1; }
  fi
  sleep 3
done
if [[ -z "$id" ]]; then
  say "FAIL: no message arrived from Telegram. Was it sent to the right bot, from the linked account? Last bridge log lines:"
else
  say "STILL_WORKING: the orchestrator ${id:0:7} is still busy after ${wait_s}s (the first answer can be slow). Bridge log:"
fi
paseo_cli plugin logs "$PLUGIN_ID" 2>/dev/null | tail -n 15
exit 1
