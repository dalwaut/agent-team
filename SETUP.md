# OPAI System — Setup & Credentials Guide

> This document lists every credential, config file, and environment variable needed to run the OPAI system on a new machine. Follow this when migrating to the Ubuntu server or any fresh install.

---

## Prerequisites

| Requirement | Install Command (Ubuntu) |
|-------------|--------------------------|
| Node.js 20 LTS | `curl -fsSL https://deb.nodesource.com/setup_20.x \| sudo -E bash - && sudo apt install -y nodejs` |
| Python 3.12+ | `sudo apt install python3 python3-pip python3-venv` |
| Claude CLI | `npm install -g @anthropic-ai/claude-code` then `claude auth login` |
| PowerShell Core (optional) | `sudo snap install powershell --classic` |
| Git | `sudo apt install git` |

---

## Credential Locations

### 1. Discord Bot — `tools/discord-bridge/.env`

| Variable | Description | Where to Get It |
|----------|-------------|-----------------|
| `DISCORD_BOT_TOKEN` | Bot authentication token | [Discord Developer Portal](https://discord.com/developers/applications) → Bot → Reset Token |
| `DISCORD_CHANNEL_ID` | Channel the bot listens on | Right-click channel in Discord → Copy Channel ID (enable Developer Mode) |
| `TRIGGER_PREFIX` | Message prefix to activate bot | Default: `!@` |
| `CLAUDE_TIMEOUT` | CLI timeout in ms | Default: `900000` (15 min) |

### 2. Email Manager — `tools/email-checker/.env`

4 email accounts configured. Each uses IMAP for reading and SMTP for sending.

**Account 1 — Gmail Personal (`dalwaut@gmail.com`)**

| Variable | Value/Description |
|----------|-------------------|
| `IMAP_HOST` | `imap.gmail.com` |
| `IMAP_PORT` | `993` |
| `IMAP_USER` | `dalwaut@gmail.com` |
| `IMAP_PASS` | Gmail App Password (16 chars, spaces). Generate at [Google App Passwords](https://myaccount.google.com/apppasswords) (requires 2FA) |

**Account 2 — Paradise Web (`dallas@paradisewebfl.com`)**

| Variable | Value/Description |
|----------|-------------------|
| `IMAP_HOST_PW` | `imap.gmail.com` (Google Workspace) |
| `IMAP_PORT_PW` | `993` |
| `IMAP_USER_PW` | `dallas@paradisewebfl.com` |
| `IMAP_PASS_PW` | Google Workspace App Password |

**Account 3 — BoutaByte (`dallas@boutabyte.com`)**

| Variable | Value/Description |
|----------|-------------------|
| `IMAP_HOST_BB` | `imap.hostinger.com` |
| `IMAP_PORT_BB` | `993` |
| `IMAP_USER_BB` | `dallas@boutabyte.com` |
| `IMAP_PASS_BB` | Hostinger email password |

**Account 4 — BoutaCare (`dallas@boutacare.com`)**

| Variable | Value/Description |
|----------|-------------------|
| `IMAP_HOST_BC` | `imap.hostinger.com` |
| `IMAP_PORT_BC` | `993` |
| `IMAP_USER_BC` | `dallas@boutacare.com` |
| `IMAP_PASS_BC` | Hostinger email password |

**Optional — Supabase**

| Variable | Value/Description |
|----------|-------------------|
| `SUPABASE_URL` | Supabase project URL (e.g., `https://xxx.supabase.co`) |
| `SUPABASE_SERVICE_KEY` | Service role key from Supabase dashboard → Settings → API |

### 3. Email Manager — `tools/email-checker/config.json`

No credentials here — accounts reference `.env` via `env_prefix` suffixes (`""`, `_PW`, `_BB`, `_BC`). Config controls behavior: check interval, classification toggles, voice profile, storage paths.

### 4. WordPress Agent — `tools/wp-agent/`

Credentials are per-project. When working on a WordPress site, create a `wp-credentials.yaml` in the project root using the template at `Templates/wp-credentials.template.yaml`.

### 5. MCP Servers — `mcps/`

MCP configs may contain API keys for Hostinger, Supabase, or WordPress instances. Check each subdirectory for `.env` or config files.

---

## Post-Clone Setup

After cloning the OPAI branch to the server:

```bash
# 1. Clone
git clone -b OPAI https://github.com/dalwaut/agent-team.git ~/opai
cd ~/opai

# 2. Install Node.js dependencies for each tool
cd tools/discord-bridge && npm install && cd ../..
cd tools/email-checker && npm install && cd ../..
cd tools/work-companion && npm install && cd ../..

# 3. Install Python dependencies for wp-agent (if needed)
cd tools/wp-agent && pip install -r requirements.txt && cd ../..

# 4. Authenticate Claude CLI
claude auth login

# 5. Verify .env files have correct values
cat tools/discord-bridge/.env
cat tools/email-checker/.env

# 6. Test Discord bot
cd tools/discord-bridge && npm start
# Ctrl+C after confirming "Ready!" message

# 7. Test email checker
cd tools/email-checker && node index.js --dry-run

# 8. Run framework preflight
pwsh scripts/preflight.ps1
# OR (if using bash):
# claude -p < scripts/prompt_familiarizer.txt
```

---

## systemd Service Setup

After verifying everything works manually, create persistent services:

```bash
# Example: Discord bot service
sudo tee /etc/systemd/system/opai-discord.service << 'EOF'
[Unit]
Description=OPAI Discord Bot
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER/opai/tools/discord-bridge
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable opai-discord
sudo systemctl start opai-discord
```

Repeat for: `opai-email` (email checker on timer), `opai-approval` (approval server).

---

## Directory Structure on Server

```
~/opai/                          # Cloned from OPAI branch
├── scripts/                     # Agent framework runners + prompts
├── tools/
│   ├── discord-bridge/          # Bot — runs as systemd service
│   ├── email-checker/           # Email manager — runs on timer
│   ├── work-companion/          # Task classifier/router
│   └── wp-agent/                # WordPress agent (Python)
├── mcps/                        # MCP server configs
├── tasks/                       # Task registry + queue
├── Library/                     # Knowledge base
├── Templates/                   # Agent + project templates
├── workflows/                   # Workflow documentation
├── reports/                     # Agent report output (generated)
├── notes/Improvements/          # Roadmap
├── config/                      # User personas (future)
├── team.json                    # Agent roster
├── CLAUDE.md                    # OPAI workspace instructions
├── CONVENTIONS.md               # Naming/structure rules
├── SETUP.md                     # This file
└── README.md                    # Documentation
```

---

## Security Notes

- This repo is **private**. `.env` files contain real credentials for smooth migration.
- If the repo is ever made public, **rotate ALL credentials immediately**:
  - Discord bot token (Developer Portal → Reset Token)
  - Gmail app passwords (revoke old, generate new)
  - Hostinger email passwords (change via Hostinger panel)
  - Supabase keys (regenerate via Supabase dashboard)
- On the server, restrict `.env` file permissions: `chmod 600 tools/*/.env`
