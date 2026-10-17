---
name: telegram-orchestrator-setup
description: Sets up a personal "Telegram → Paseo orchestrator" on the user's own Mac, end to end — prerequisites, a new Telegram bot via BotFather, the bridge plugin, an orchestrator seat with worker profiles, and a round-trip test from the phone. Also troubleshoots and uninstalls it. Use when the user asks to "set up the Telegram orchestrator", "텔레그램 오케 설치", "텔레그램으로 Paseo 쓰고 싶어", "텔레그램 봇 연결", or pastes the kit's setup line.
---

# Telegram orchestrator setup

You are setting up a Telegram bot that lets the user run their Paseo agents from their phone. When it is done, the user messages their bot, one "orchestrator" agent in Paseo reads it, hands the work to worker agents, and replies in Telegram.

The user is probably **not a developer**. You do every step a computer can do. The user only does what needs their hands: taps in Telegram's BotFather, logins, an admin password, copying the token.

## How to talk to the user

- **Language.** If the user wrote to you in Korean, use Korean; in English, English. If unclear, ask once: "한국어로 할까요, English?". Korean must sound natural and friendly (해요체), never like a translation. The ready-made lines below come in both languages; adapt them, don't paste both.
- One step at a time. Say what you're about to do in one plain sentence, do it, then say what happened. No jargon: say "봇 비밀번호(토큰)" / "the bot's password (token)", "백그라운드 프로그램" / "background service".
- After each step, tell them where they are: "(3/8 끝)" / "(step 3 of 8 done)".
- When the user must do something, give numbered taps with the exact button names, then wait for them to say it's done.

## Rules you must keep

1. **Never ask the user to paste the bot token into this chat** and never print it. The scripts read it from the clipboard and store it in a private file. If the user pastes it into the chat anyway, still save it with `set-token.sh --stdin` (pipe it in without echoing it in any reply), then tell them it is safer to revoke it later in BotFather (`/revoke`) and set the new one the same way.
2. Never print the contents of the secrets file, `TELEGRAM_*` values or the chat id. The scripts never print them; do not work around that.
3. Run the scripts in this folder; do not hand-edit Paseo's `config.json` (the installer backs it up and edits it safely).
4. If `doctor.sh` reports `BRIDGE FAIL ... a different 'telegram-orchestrator' plugin`, stop: the user already has another Telegram bridge. Do not remove or replace it. Explain and ask what they want.
5. Nothing here sends, posts or pays for anything. If a step seems to need that, stop and ask.

## 0. Find the kit

The kit is the folder that contains this `SKILL.md` (`scripts/`, `bridge/`). Call it `KIT`. Use its absolute path in every command, for example:

```bash
KIT="$HOME/paseo-telegram-kit"   # the folder this SKILL.md is in
bash "$KIT/scripts/doctor.sh"
```

If the folder isn't on the Mac yet, download it (from https://github.com/Sundayable/paseo-telegram-kit). Use git only when the developer tools are already installed — on a fresh Mac, `git` opens an install pop-up — otherwise take the ZIP:

```bash
if [ -d "$HOME/paseo-telegram-kit" ]; then echo "already here"
elif xcode-select -p >/dev/null 2>&1; then
  git clone --depth 1 https://github.com/Sundayable/paseo-telegram-kit.git "$HOME/paseo-telegram-kit"
else
  curl -fsSL https://github.com/Sundayable/paseo-telegram-kit/archive/refs/heads/main.zip -o /tmp/paseo-telegram-kit.zip \
    && rm -rf /tmp/paseo-telegram-kit-src && unzip -q /tmp/paseo-telegram-kit.zip -d /tmp/paseo-telegram-kit-src \
    && mv /tmp/paseo-telegram-kit-src/paseo-telegram-kit-main "$HOME/paseo-telegram-kit"
fi
```

## 1. Check the Mac — `doctor.sh`

Run `bash "$KIT/scripts/doctor.sh"`. Each line is `CHECK STATUS detail`. Fix every `MISSING`/`FAIL` in step 2, then run it again. `WARN` lines are optional.

Say something like:
- KO: "먼저 이 Mac에 필요한 게 다 있는지 확인해 볼게요."
- EN: "First I'll check that this Mac has everything it needs."

## 2. Install what's missing

| Line | What to do |
| --- | --- |
| `MAC FAIL` | This kit is macOS-only. Stop and explain. |
| `PASEO_APP` / `PASEO_DAEMON MISSING` | Paseo must be installed and open. They are probably talking to you inside Paseo, so ask them to keep the Paseo app open. If not installed: open https://paseo.sh, they download and drag it to Applications, open it once. |
| `AI_CLAUDE MISSING` and `AI_CODEX` not OK | At least one AI is needed (Claude is recommended for the orchestrator). Claude Code: in Terminal `curl -fsSL https://claude.ai/install.sh \| bash`, then the user runs `claude` once and logs in with their Claude account in the browser window that opens. Then reopen Paseo. |
| `AI_CODEX WARN` | Optional. With Codex logged in, the bridge gets a backup seat when Claude hits its usage limit, and a coding/browser worker. Offer it once; skip if they don't use ChatGPT. |
| `NODE MISSING` | If `HOMEBREW OK`: run `brew install node`. Otherwise open https://nodejs.org/en/download and tell them: KO "‘macOS Installer (.pkg)’를 눌러 받아서 더블클릭하고, 계속 → 동의 → 설치를 누르세요. Mac 암호를 물어보면 입력하면 돼요." EN "Click 'macOS Installer (.pkg)', open it, then Continue → Agree → Install, and enter your Mac password when asked." |

They also need **Telegram on their phone** (and an account). That's all.

Tip to share: the bot only works while this Mac is awake and Paseo is open. KO: "Mac이 잠들면 봇이 답을 못 해요. 충전기에 꽂아 두고, 시스템 설정 → 배터리 → 옵션에서 ‘전원 어댑터 연결 시 디스플레이가 꺼져도 자동으로 잠자기 방지’를 켜 두면 좋아요." EN: "The bot can only answer while this Mac is awake. Keep it plugged in and turn on System Settings → Battery → Options → 'Prevent automatic sleeping on power adapter when the display is off'."

## 3. Personal settings — `configure.sh`

Ask what the orchestrator should call them (KO: "오케가 뭐라고 부르면 될까요? 이름이나 닉네임이면 돼요." EN: "What should the orchestrator call you?"). Then:

```bash
bash "$KIT/scripts/configure.sh" --name "<name>" --language ko   # or en
```

Time zone comes from the Mac. The orchestrator's working folder defaults to `~/paseo-work`; pass `--folder <path>` if they want another one.

## 4. Create the bot — BotFather (user's taps)

Send them these steps (adapt the example names):

KO:
1. 휴대폰 텔레그램에서 위쪽 검색창에 **BotFather**를 검색하세요. 이름 옆에 파란 체크가 있는 **@BotFather**를 열고 **시작**(또는 START)을 누르세요.
2. `/newbot` 을 보내세요.
3. 봇 이름을 물어보면 아무 이름이나 보내세요. 예: `지영의 오케`
4. 봇 아이디를 물어보면 영어로, 끝이 `bot`으로 끝나게 보내세요. 예: `jiyoung_orche_bot` (이미 있는 이름이면 다른 걸로 다시)
5. "Done! Congratulations…" 메시지가 오면 끝이에요. 그 안의 `123456789:AA…` 같은 긴 줄이 봇 비밀번호(토큰)예요. **이 채팅에 붙여넣지 마세요.** 다음 단계에서 안전하게 옮길게요.

EN:
1. In Telegram on your phone, search for **BotFather**. Open **@BotFather** (blue check mark) and tap **Start**.
2. Send `/newbot`.
3. When it asks for a name, send any name, e.g. `Jiyoung's orchestrator`.
4. When it asks for a username, send one in English that ends in `bot`, e.g. `jiyoung_orche_bot` (if taken, try another).
5. When "Done! Congratulations…" arrives, the long line like `123456789:AA…` is the bot's password (token). **Don't paste it here.** The next step moves it safely.

## 5. Save the token — `set-token.sh`

The token must reach the Mac's clipboard without going through this chat. Ask which fits:

- **iPhone with the same Apple ID as this Mac** (Universal Clipboard): in BotFather's message, tap the token once (Telegram copies it) — it is now on the Mac's clipboard too, for about two minutes.
- **Otherwise:** open Telegram on the Mac (Telegram app, or https://web.telegram.org and log in with the phone), open the BotFather chat, and copy the token there (double-click it, ⌘C).

When they say it's copied, run:

```bash
bash "$KIT/scripts/set-token.sh" --clipboard
```

It checks the token with Telegram, saves it in a private file, clears the clipboard and prints only the bot's @name. Errors:
- `NOT_A_TOKEN` — the clipboard held something else; copy again.
- `TOKEN_REJECTED` — copied incompletely or revoked; copy again (BotFather → `/mybots` → the bot → **API Token**).
- `OTHER_TOKEN_SAVED` — a different bot is already saved; ask before re-running with `--replace`.
- Last resort if the clipboard path won't work: ask them to open the **Terminal** app and paste-run `bash "$KIT/scripts/set-token.sh"` (give the full path); it asks for the token with hidden input.

## 6. Link their chat — `find-chat-id.sh`

KO: "이제 방금 만든 봇과 대화를 시작해 주세요. BotFather 메시지에 있는 `t.me/…` 링크를 누르거나 봇 아이디를 검색해서 열고 **시작**을 누르면 돼요."
EN: "Now open your new bot: tap the `t.me/…` link in BotFather's message (or search its username) and tap **Start**."

Then run (it waits up to 3 minutes):

```bash
bash "$KIT/scripts/find-chat-id.sh"
```

It saves that chat as the **only** chat the bot will ever answer, and the bot replies "✅ …연결됐어요". `MANY_CHATS` = someone else also messaged the bot: show the list and re-run with `--pick N` after the user tells you which one is them.

## 7. Install the bridge — `install.sh`

```bash
bash "$KIT/scripts/install.sh"
```

What it does (tell the user in one or two sentences): copies the bridge into Paseo, downloads its parts with npm, adds Paseo profiles (`텔레그램 오케 · Claude`, `작업자 · Claude`, and Codex ones if Codex is logged in), turns on Paseo's plugins and agent tools (after backing up Paseo's settings), then waits until the bridge is listening. Success ends with `OK: bridge is listening as @…`.

Use `--dry-run` first if the user wants to see the plan. On failure see Troubleshooting.

## 8. Test from the phone

KO: "마지막으로 휴대폰에서 봇에게 `핑` 이라고 보내 보세요. 처음 답은 30초~1분쯤 걸릴 수 있어요."
EN: "Last step: send `ping` to your bot from your phone. The first answer can take 30–60 seconds."

Then run `bash "$KIT/scripts/check-reply.sh"` and ask whether the reply arrived on the phone. Only call the setup done when the user confirms the reply arrived. If `STILL_WORKING`, wait and run it again once.

Finish with the cheat sheet below in their language.

## Cheat sheet for the user

KO:
- 그냥 말하듯 보내면 돼요. 예: "어제 만든 보고서 요약해서 메일 초안 써 줘". 오케가 작업자에게 일을 맡기고, 끝나면 텔레그램으로 알려 줘요.
- 오케가 일하는 중에 보낸 메시지는 순서대로 모아 두었다가 처리해요. 급하게 멈추려면 `멈춰` 또는 `/now`로 시작하세요.
- 봇의 메시지에 **답장**하면 그 메시지에 대한 답으로 알아들어요.
- 발송·게시·결제·삭제처럼 되돌리기 어려운 일은 오케가 먼저 물어봐요. "응/아니"로 답하면 돼요.
- `/help` 명령 목록 · `/status` 상태 · `/ls` 세션 목록 · `/to 3 메시지` 3번 세션에 바로 보내기 · `/model` 모델 바꾸기 · `/new` 새 대화
- 사진·파일도 보낼 수 있어요. 음성 메시지는 OpenAI 키를 따로 넣어야 돼요(아래 '선택: 음성').

EN:
- Just write as you would to an assistant, e.g. "summarize yesterday's report and draft an email". The orchestrator hands it to a worker and tells you in Telegram when it's done.
- Messages sent while it's working are queued and handled in order. To stop it right away, start with `stop` or `/now`.
- **Reply** to one of the bot's messages and it knows what you're answering.
- Anything hard to undo (sending, posting, paying, deleting) — it asks first. Answer yes or no.
- `/help` commands · `/status` · `/ls` sessions · `/to 3 message` straight to session 3 · `/model` switch model · `/new` fresh conversation
- Photos and files work. Voice notes need an OpenAI key (see "Optional: voice").

## Optional: voice notes

Voice notes are transcribed with OpenAI's API (paid by the user's own OpenAI account, a few cents per hour of audio). Only if they want it: they create a key at https://platform.openai.com/api-keys, copy it, and you run `bash "$KIT/scripts/set-voice-key.sh" --clipboard`, then `bash "$KIT/scripts/install.sh"` again to reload the bridge.

## Troubleshooting

Always start with `bash "$KIT/scripts/doctor.sh"`; the failing line says what's wrong. Bridge log: `"$PASEO_BIN" plugin logs telegram-orchestrator` (`/Applications/Paseo.app/Contents/Resources/bin/paseo`).

| Symptom | Cause and fix |
| --- | --- |
| No reply at all | Mac asleep, Paseo closed, or no internet. Open Paseo; `doctor.sh` should show `TELEGRAM OK`. |
| `TELEGRAM FAIL no contact` | Re-run `install.sh` (it reloads the bridge). Still failing: quit and reopen Paseo, then `doctor.sh`. |
| Bot ignores the user | Message sent from a different Telegram account than the linked one, or to a different bot. Re-link with `find-chat-id.sh` (stop the bridge first: `"$PASEO_BIN" plugin disable telegram-orchestrator`, then `install.sh` afterwards). |
| `BOT_BUSY` (409) | Something else is reading the bot (an old copy of the bridge or another tool using the same token). Stop it, or create a new bot. |
| `WEBHOOK_SET` | The bot was used with another service. Run `bash "$KIT/scripts/set-token.sh" --clipboard --clear-webhook` with the token copied again. |
| Reply says usage limit | Claude's usage window is full. With Codex logged in the bridge switches to the backup seat by itself and comes back later; otherwise wait for the reset time it states. |
| A worker waits for permission | The orchestrator approves routine steps itself and asks the user for risky ones; buttons appear in Telegram. |
| `npm` errors during install | Usually the network. Retry `install.sh`. |
| `FOREIGN_PLUGIN` | Another Telegram bridge is already installed. The kit won't touch it. |

## Update

Get the new version (`git -C ~/paseo-telegram-kit pull` for a clone; for a ZIP install, move the old folder to the Trash and download again as in step 0), then run `install.sh` again. Settings, secrets and history are kept (they live in `~/.paseo/telegram-orchestrator/`, not in the kit folder).

## Uninstall

```bash
bash "$KIT/scripts/uninstall.sh"            # removes everything (to the Trash, recoverable)
bash "$KIT/scripts/uninstall.sh" --keep-data  # keeps settings and the token for a later reinstall
```

It removes the bridge from Paseo, deletes only this kit's profiles (after a backup of Paseo's settings) and moves the files to the Trash. Paseo sessions stay (the user can archive them). Last step by hand: in BotFather send `/deletebot` and pick the bot (or `/revoke` to cancel the token only). Agent tools and plugin support in Paseo stay switched on, since other things may use them.

If you start a long job, wait for it yourself with a background until-loop and finish the task in the same run.
