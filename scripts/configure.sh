#!/bin/bash
# Saves the personal settings: what the orchestrator calls you, its language, your time
# zone and the folder it works in. Re-run any time; unspecified values are kept.
#   scripts/configure.sh --name "Jiyoung" --language ko [--timezone Asia/Seoul] [--folder ~/paseo-work]
set -euo pipefail
source "$(dirname "$0")/lib.sh"
refuse_if_foreign

name="" language="" timezone="" folder=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) name="$2"; shift 2 ;;
    --language) language="$2"; shift 2 ;;
    --timezone) timezone="$2"; shift 2 ;;
    --folder) folder="$2"; shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done
[[ -z "$language" || "$language" == ko || "$language" == en ]] || die "--language must be ko or en"

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
file="$STATE_DIR/config.json"
[[ -f "$file" ]] || printf '{}\n' > "$file"

# Defaults for a first run: the Mac's own time zone and ~/paseo-work.
[[ -n "$timezone" ]] || timezone="$(json_get 'j.timeZone' < "$file")"
[[ -n "$timezone" ]] || timezone="$(readlink /etc/localtime 2>/dev/null | sed 's#.*/zoneinfo/##')"
[[ -n "$folder" ]] || folder="$(json_get 'j.orchestratorCwd' < "$file")"
[[ -n "$folder" ]] || folder="$HOME/paseo-work"
folder="${folder/#\~/$HOME}"
mkdir -p "$folder"

NAME="$name" LANGUAGE="$language" TZ_NAME="$timezone" FOLDER="$folder" node -e '
  const fs = require("fs");
  const file = process.argv[1];
  const c = JSON.parse(fs.readFileSync(file, "utf8"));
  const e = process.env;
  if (e.NAME) c.ownerName = e.NAME;
  if (e.LANGUAGE) {
    c.language = e.LANGUAGE;
    c.replyLanguage = e.LANGUAGE === "ko" ? "Korean (natural, friendly 존댓말)" : "English";
    c.orchestratorTitle = e.LANGUAGE === "ko" ? "텔레그램 오케" : "Telegram orchestrator";
  }
  try { new Intl.DateTimeFormat("en", { timeZone: e.TZ_NAME }); c.timeZone = e.TZ_NAME; } catch {}
  c.orchestratorCwd = e.FOLDER;
  if (!c.ownerName) { console.error("ERROR: --name is required the first time"); process.exit(1); }
  if (!c.language) { c.language = "ko"; c.replyLanguage = "Korean (natural, friendly 존댓말)"; c.orchestratorTitle = "텔레그램 오케"; }
  fs.writeFileSync(file + ".tmp", JSON.stringify(c, null, 2) + "\n");
  fs.renameSync(file + ".tmp", file);
  console.log(`OK: name=${c.ownerName} language=${c.language} timeZone=${c.timeZone} folder=${c.orchestratorCwd}`);
' "$file"
