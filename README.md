# claude-home-bot

Discord bot that gives each of your directories a channel with its own [Claude Code](https://claude.com/claude-code) session.

## Permissions

Claude can only do what its [permission mode](https://code.claude.com/docs/en/permissions) allows; everything else is denied. Sessions start in `manual`, where Claude mostly reads. Pick a looser mode globally or per path in the config.

> **⚠️ SESSIONS RUN ON YOUR MACHINE ⚠️**<br>With a permissive mode (`auto`, `acceptEdits`, `bypassPermissions`), **anyone who can write in a bot channel can change your files**.<br>Keep `admin-only: true` unless only people you trust can write in the server.

## Setup

Needs [bun](https://bun.com) and the `claude` CLI on `PATH`.

1. Create a bot in the [Developer Portal](https://discord.com/developers/applications).<br>Turn on **Message Content Intent**. <br>Invite it with the `bot` and `applications.commands` scopes and the View Channels, Send Messages, Read Message History, Manage Channels, Manage Messages and Manage Roles permissions.<br>Keep the bot's role above its `<name>-usage` role, or it can't give that role to itself.
2. Configure and run:

   ```bash
   bun install
   mkdir data && cp config.example.yaml data/config.yaml  # then edit it
   bun run index.ts --data ./data
   ```

On first run the bot DMs the admins a link to log claude in.

Every config key can also come from the environment: `DISCORD_TOKEN`, `DISCORD_SERVER_ID`, `PATHS`, …

## Commands

Claude's slash commands work as Discord commands. The bot adds three, for admins only:

- `/clean`: delete every message in the channel and clear the conversation
- `/restart session|bot`: restart the channel's Claude process, or the whole bot
- `/stop`: stop the whole bot, after a confirmation button

## Trimmed sessions

To keep each request small, sessions run with less than a plain `claude` (`src/claude.ts`):

- No claude.ai connectors (`ENABLE_CLAUDEAI_MCP_SERVERS=false`)
- No skills or plugins synced from claude.ai
- Tools a Discord chat has no use for are disabled: `ReportFindings`, `ListAgents`, `ScheduleWakeup`
- Built-in skills hidden from Claude, still runnable as slash commands: `dataviz`, `claude-api`, `run`, `plugin-authoring`, `security-review`, `keybindings-help`, `fewer-permission-prompts`, `update-config`, `loop`

This is currently not configurable.

## License

[WTFPL](LICENSE)
