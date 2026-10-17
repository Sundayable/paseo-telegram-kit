# Paseo Telegram Kit

[한국어](README.md) · Guide page: https://proof.getsundayable.com/telegram-kit/?lang=en

Run the AI agents on your Mac from Telegram on your phone. You message your own bot; an "orchestrator" agent in Paseo reads it, hands the work to worker agents, and replies in Telegram when it's done.

```
Telegram on your phone  ⇄  your bot  ⇄  Paseo on your Mac  →  orchestrator  →  worker agents
```

## What it does

- Write as you would to an assistant; the orchestrator delegates and reports back.
- Messages sent while it's busy are queued and handled in order.
- **Reply** to one of its messages and it knows what you're answering.
- Anything hard to undo (sending, posting, paying, deleting) — it asks first.
- Workers' permission requests show up as buttons in Telegram.
- When Claude's usage runs out it switches to a Codex backup and comes back later (if Codex is logged in).
- Commands like `/ls`, `/to`, `/model`, `/status`, `/help`; photos and files both ways; voice notes (optional).

## Setup (about 5 minutes)

You need: a Mac, the [Paseo](https://paseo.sh) app, Claude Code (or Codex) logged in, Telegram on your phone.

Open a new agent (Claude Code) in Paseo and paste this line:

```
Set up my Telegram orchestrator: download the kit from https://github.com/Sundayable/paseo-telegram-kit into ~/paseo-telegram-kit, then follow its SKILL.md from start to finish.
```

The agent does the rest. Your part:

1. Create a bot with **@BotFather** in Telegram (`/newbot`; the agent tells you what to tap)
2. Copy the bot's password (token). **Don't paste it into the agent chat.**
3. Open your new bot and tap **Start**
4. At the end, send `ping` to the bot and check that a reply arrives

You may be asked to install Node.js once (Mac password) or log in to Claude.

## Safety

- The bot only answers the one Telegram account you linked.
- The token is stored only in a private file on your Mac (`~/.paseo/telegram-orchestrator/secrets.env`, mode 600) and is never printed.
- It works while your Mac is awake and Paseo is open.

## Uninstall

Ask a Paseo agent to "remove the Telegram orchestrator", or run `bash ~/paseo-telegram-kit/scripts/uninstall.sh`. Files go to the Trash. Finally, delete the bot in @BotFather with `/deletebot`.

## What's inside

| Path | Contents |
| --- | --- |
| `SKILL.md` | Setup, troubleshooting and uninstall steps the agent follows |
| `scripts/` | Check (`doctor.sh`), settings, token, chat link, install, test, uninstall |
| `bridge/` | The Paseo plugin (Telegram ↔ Paseo) |
| `docs/` | Guide page and its preview-image source |

## License

MIT · © 2026 [Sundayable](https://sundayable.com). Paseo and Telegram are trademarks of their respective owners.

## Development

```bash
cd bridge && npm ci && npm run check   # typecheck + 137 unit tests
dev/selftest.sh                        # whole kit against a fake Telegram + throwaway Paseo daemon
dev/selftest.sh --roundtrip            # also a real "ping" → AI reply (one short agent run)
```

The self-test never touches your real `~/.paseo`, bots or clipboard.
