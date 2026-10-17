#!/bin/bash
# End-to-end dry run of the whole kit with a fake Telegram and a throwaway Paseo daemon.
# Nothing touches your real ~/.paseo, your real bots or your clipboard.
#   dev/selftest.sh              # setup scripts + install + doctor + uninstall
#   dev/selftest.sh --roundtrip  # also sends "ping" and waits for a real AI reply
#                                  (starts one short agent run on your Claude/Codex account)
set -euo pipefail
kit="$(cd "$(dirname "$0")/.." && pwd)"
roundtrip=0
[[ "${1:-}" == "--roundtrip" ]] && roundtrip=1

work="$(mktemp -d /tmp/tgkit-selftest.XXXX)"
fake_port=18766 daemon_port=6899
export FAKE_TOKEN="123456789:AAFakeTokenForSelfTestOnly_abcdefghijk"
export TGO_PASEO_HOME="$work/paseo-home" PASEO_HOME="$work/paseo-home"
export PASEO_TELEGRAM_STATE_DIR="$work/state" TGO_PLUGIN_DIR="$work/paseo-home/plugins/telegram-orchestrator"
export PASEO_TELEGRAM_API_BASE="http://127.0.0.1:$fake_port" TGO_TRASH="$work/trash"
mkdir -p "$TGO_PASEO_HOME" "$TGO_TRASH"
out="$work/output.log"
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; printf '(work dir kept: %s)\n' "$work"; exit 1; }

paseo_bin=/Applications/Paseo.app/Contents/Resources/bin/paseo
[[ -x $paseo_bin ]] || paseo_bin="$(command -v paseo)"
cat > "$TGO_PASEO_HOME/config.json" <<JSON
{
  "\$schema": "https://paseo.sh/schemas/paseo.config.v1.json",
  "version": 1,
  "daemon": { "listen": "127.0.0.1:$daemon_port", "relay": { "enabled": false }, "mcp": { "enabled": false } }
}
JSON

node "$kit/dev/fake-telegram.mjs" $fake_port "$work" &
fake=$!
cleanup() {
  "$paseo_bin" daemon stop --home "$TGO_PASEO_HOME" >/dev/null 2>&1 || true
  kill $fake 2>/dev/null || true
}
trap cleanup EXIT
sleep 1

step() { printf '\n$ %s\n' "$*" >> "$out"; "$@" >> "$out" 2>&1; }

# 1. settings, token, chat link
step bash "$kit/scripts/configure.sh" --name "Tester" --language ko --folder "$work/paseo-work" || fail "configure.sh"
pass "configure.sh wrote settings"
printf 'not a token' | step bash "$kit/scripts/set-token.sh" --stdin && fail "set-token accepted garbage"
grep -q NOT_A_TOKEN "$out" && pass "set-token.sh rejects a non-token" || fail "no NOT_A_TOKEN"
printf '123456789:AAWrongTokenWrongTokenWrongToken_xyz' | step bash "$kit/scripts/set-token.sh" --stdin && fail "set-token accepted a token Telegram rejects"
grep -q TOKEN_REJECTED "$out" && pass "set-token.sh rejects a token Telegram refuses" || fail "no TOKEN_REJECTED"
printf 'Use this token to access the HTTP API:\n%s\nKeep it secure' "$FAKE_TOKEN" | step bash "$kit/scripts/set-token.sh" --stdin || fail "set-token.sh"
pass "set-token.sh saved a token pasted inside BotFather's whole message"
step bash "$kit/scripts/find-chat-id.sh" --wait 15 || fail "find-chat-id.sh"
pass "find-chat-id.sh linked the chat"
[[ "$(stat -f '%Lp' "$work/state/secrets.env")" == 600 ]] && pass "secrets.env is mode 600" || fail "secrets.env mode"
grep -q '^TELEGRAM_CHAT_ID=4242$' "$work/state/secrets.env" && pass "chat id stored" || fail "chat id not stored"
grep -q '연결됐어요' "$work/sent.jsonl" && pass "bot confirmed the link in Korean" || fail "no link confirmation"

# 2. throwaway daemon + install
"$paseo_bin" daemon start --home "$TGO_PASEO_HOME" --timeout 120 >/dev/null || fail "throwaway daemon did not start"
step bash "$kit/scripts/install.sh" --dry-run || fail "install.sh --dry-run"
pass "install.sh --dry-run"
step bash "$kit/scripts/install.sh" || fail "install.sh (see $out)"
pass "install.sh: bridge listening as @kit_test_bot"
node -e '
  const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const ids = (c.daemon.agentProfiles || []).map((p) => p.id);
  if (!ids.includes("agent_profile_tgk_orchestrator") || !c.pluginsEnabled || !c.daemon.mcp.injectIntoAgents) process.exit(1);
' "$TGO_PASEO_HOME/config.json" && pass "profiles + plugin + agent tools configured" || fail "Paseo config not updated"
ls "$TGO_PASEO_HOME"/config.json.bak-telegram-kit-* >/dev/null 2>&1 && pass "Paseo config backed up first" || fail "no config backup"
step bash "$kit/scripts/install.sh" || fail "second install.sh (update path)"
pass "install.sh is safe to re-run"
step bash "$kit/scripts/doctor.sh"
grep -q 'BRIDGE         OK' "$out" && grep -q 'TELEGRAM       OK' "$out" && pass "doctor.sh: bridge + Telegram OK" || fail "doctor.sh"

# 3. optional real round trip
if [[ $roundtrip == 1 ]]; then
  touch "$work/send-ping"
  step bash "$kit/scripts/check-reply.sh" --wait 300 || fail "no reply to ping"
  node -e '
    const lines = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map(JSON.parse);
    const reply = lines.filter((l) => l.text && !/연결됐어요/.test(l.text)).pop();
    if (!reply) process.exit(1);
    console.log("      reply: " + reply.text.replace(/\s+/g, " ").slice(0, 160));
  ' "$work/sent.jsonl" || fail "orchestrator reply not delivered to Telegram"
  pass "round trip: ping from phone → orchestrator → reply in Telegram"
fi

# 4. secrets never printed
if grep -qF "$FAKE_TOKEN" "$out" || grep -q 'AAFakeToken' "$out"; then fail "the token appeared in script output"; fi
pass "token never printed by any script"
logs="$("$paseo_bin" plugin logs telegram-orchestrator --home "$TGO_PASEO_HOME" 2>/dev/null || true)"
printf '%s' "$logs" | grep -q 'AAFakeToken' && fail "the token appeared in the bridge log"
pass "token not in the bridge log"

# 5. uninstall
step bash "$kit/scripts/uninstall.sh" || fail "uninstall.sh"
[[ ! -d "$TGO_PLUGIN_DIR" && ! -d "$work/state" ]] && pass "uninstall.sh moved bridge + data to the Trash" || fail "uninstall left files"
grep -q agent_profile_tgk_ "$TGO_PASEO_HOME/config.json" && fail "profiles left behind"
pass "uninstall.sh removed only the kit's profiles"
printf '\nALL PASS (log: %s)\n' "$out"
