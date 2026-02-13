# Discord Bot — OPAI Orchestrator

## Bot Application
- Client ID: `1470540768547700920`
- Invite URL: https://discord.com/oauth2/authorize?client_id=1470540768547700920&permissions=68608&integration_type=0&scope=bot
- Permissions: 68608 (Send Messages, Read Message History, View Channels)

## Bot Token
- Token: `MTQ3MDU0MDc2ODU0NzcwMDkyMA.GDf-14.7SHyZ8nSK0nMcJ20aYfwL8kpak9TgprUO6iqQ0`
- **WARNING**: Token was exposed in chat (2026-02-09). Regenerate at https://discord.com/developers/applications

## Server
- Guild/Server ID: `1470538456353734780`
- Server Name: (private server)

## Channel
- Channel ID: `1470538457024692369`
- Channel: #general
- Trigger Prefix: `!@`

---

## Architecture (v2 — Local Bridge)

The bot runs **locally** as a Discord.js bridge that relays messages to Claude Code CLI.
No API costs — uses Pro Max subscription via `claude -p`.

```
Discord message → Local Bot (discord.js) → Claude Code CLI (claude -p)
                                          → Claude has access to:
                                             - Local OPAI workspace files
                                             - n8n MCP (workflow execution)
                                             - Supabase MCP
                                             - Agent framework
                ← Bot edits reply ← Claude response (stdout)
```

### Local Bot
- Location: `tools/discord-bridge/`
- Launch: `OPAI Bot.bat` on Desktop (or `npm start` from the directory)
- Config: `tools/discord-bridge/.env`
- Timeout: 5 min (300s) per request
- Pattern: Acknowledge → Process in background → Reply when ready

### n8n Integration (Separate)
- n8n Discord-Orchestrator-Agent workflow: **DEACTIVATED** (replaced by local bridge)
- n8n workflows executed via MCP tool from Claude Code, not inline
- Discord Credential on n8n: `Discord App account` (n8n ID: `gJglxtqNq0anFWdI`)
- AI Model Credential on n8n: `[Pro] PAID - Dallas@PW` (Google Gemini)
- Local workflow file: `Library/n8n/Workflows/discord_orchestrator.json`
