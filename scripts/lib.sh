#!/bin/bash
# Shared helpers for the telegram-orchestrator-setup scripts. Sourced, never run.
# Secrets rule: a token is only ever held in a shell variable and piped to curl/node on
# stdin. Nothing here echoes it, puts it in argv, or writes it anywhere but the keys file.

PASEO_HOME_DIR="${TGO_PASEO_HOME:-$HOME/.paseo}"
STATE_DIR="${PASEO_TELEGRAM_STATE_DIR:-$PASEO_HOME_DIR/telegram-orchestrator}"
# Private to this kit: the bot token and chat id live here (mode 600), nowhere else.
KEYS_FILE="${PASEO_TELEGRAM_KEYS_FILE:-$STATE_DIR/secrets.env}"
PLUGIN_ID="telegram-orchestrator"
PLUGIN_DEST="${TGO_PLUGIN_DIR:-$PASEO_HOME_DIR/plugins/$PLUGIN_ID}"
TELEGRAM_API="${PASEO_TELEGRAM_API_BASE:-https://api.telegram.org}"
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# The CLI bundled with Paseo.app matches the running daemon; a global `paseo` may be older.
if [[ -n "${TGO_PASEO_BIN:-}" ]]; then PASEO_BIN="$TGO_PASEO_BIN"
elif [[ -x /Applications/Paseo.app/Contents/Resources/bin/paseo ]]; then PASEO_BIN=/Applications/Paseo.app/Contents/Resources/bin/paseo
else PASEO_BIN="$(command -v paseo || true)"; fi
paseo_cli() { [[ -n "$PASEO_BIN" ]] || die "NO_PASEO: Paseo is not installed"; "$PASEO_BIN" "$@" --home "$PASEO_HOME_DIR"; }

# key_get NAME → value on stdout (callers capture it; never echo it).
key_get() {
  [[ -f "$KEYS_FILE" ]] || return 1
  KEY_NAME="$1" node -e '
    const fs = require("fs");
    const name = process.env.KEY_NAME;
    for (const raw of fs.readFileSync(process.argv[1], "utf8").split(/\r?\n/)) {
      const m = raw.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m || m[1] !== name) continue;
      let v = m[2].trim();
      if (v.length >= 2 && (v[0] === "\"" || v[0] === "\x27") && v.endsWith(v[0])) v = v.slice(1, -1);
      if (v) { process.stdout.write(v); process.exit(0); }
    }
    process.exit(1);
  ' "$KEYS_FILE"
}

key_has() { key_get "$1" >/dev/null 2>&1; }

# key_set NAME  (value on stdin) → replaces or appends NAME=value; file stays mode 600.
key_set() {
  mkdir -p "$(dirname "$KEYS_FILE")"
  chmod 700 "$(dirname "$KEYS_FILE")" 2>/dev/null || true
  [[ -f "$KEYS_FILE" ]] || : > "$KEYS_FILE"
  chmod 600 "$KEYS_FILE"
  KEY_NAME="$1" node -e '
    const fs = require("fs");
    const file = process.argv[1], name = process.env.KEY_NAME;
    const value = fs.readFileSync(0, "utf8").trim();
    if (!value) { console.error("empty value"); process.exit(1); }
    let done = false;
    const out = fs.readFileSync(file, "utf8").split(/\r?\n/).map((line) => {
      const m = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (m && m[1] === name) { if (done) return null; done = true; return `${name}=${value}`; }
      return line;
    }).filter((line) => line !== null);
    while (out.length && out[out.length - 1] === "") out.pop();
    if (!done) out.push(`${name}=${value}`);
    fs.writeFileSync(file + ".tmp", out.join("\n") + "\n", { mode: 0o600 });
    fs.renameSync(file + ".tmp", file);
  ' "$KEYS_FILE"
  chmod 600 "$KEYS_FILE"
}

# key_remove NAME
key_remove() {
  [[ -f "$KEYS_FILE" ]] || return 0
  KEY_NAME="$1" node -e '
    const fs = require("fs");
    const file = process.argv[1], name = process.env.KEY_NAME;
    const out = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((line) => {
      const m = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      return !(m && m[1] === name);
    });
    fs.writeFileSync(file + ".tmp", out.join("\n"), { mode: 0o600 });
    fs.renameSync(file + ".tmp", file);
  ' "$KEYS_FILE"
}

# tg TOKEN METHOD [JSON_BODY] → raw Bot API JSON. The token travels in curl's config on
# stdin, so it never shows up in `ps` and never reaches stdout.
tg() {
  local token="$1" method="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    printf 'url = "%s/bot%s/%s"\nheader = "content-type: application/json"\ndata = %s\n' \
      "$TELEGRAM_API" "$token" "$method" "$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$body")" \
      | curl -sS --max-time 40 -K - 2>/dev/null
  else
    printf 'url = "%s/bot%s/%s"\n' "$TELEGRAM_API" "$token" "$method" | curl -sS --max-time 40 -K - 2>/dev/null
  fi
}

# json_get EXPR  (JSON on stdin) → prints `(j => EXPR)(json)`; prints nothing if it throws.
json_get() {
  node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c)).on("end", () => {
      try {
        const v = (0, eval)("(j) => " + process.argv[1])(JSON.parse(raw));
        if (v !== undefined && v !== null) process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
      } catch {}
    });
  ' "$1"
}

valid_token_shape() { [[ "$1" =~ ^[0-9]{5,15}:[A-Za-z0-9_-]{30,}$ ]]; }

# Another bridge with the same plugin id shares the state folder; never write into it.
# Reads Paseo's config file, so it also works while the Paseo app is closed.
refuse_if_foreign() {
  local path=""
  if [[ -f "$PASEO_HOME_DIR/config.json" ]]; then
    path="$(json_get "((j.plugins || {})['$PLUGIN_ID'] || {}).path" < "$PASEO_HOME_DIR/config.json" || true)"
  fi
  if [[ -n "$path" && "$path" != "$PLUGIN_DEST" ]]; then
    die "FOREIGN_PLUGIN: a '$PLUGIN_ID' plugin from another folder is already installed on this Mac. This kit will not touch it or its data."
  fi
}
