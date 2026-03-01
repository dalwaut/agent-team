# Email Checker
> Last updated: 2026-02-14 | Source: `tools/email-checker/`

## Overview

IMAP email fetcher that connects to multiple accounts, classifies emails via Claude Haiku, extracts actionable tasks, drafts responses using a 3-step improvement loop, and saves drafts to IMAP. Runs on a 30-minute systemd timer.

## Architecture

```
Timer trigger (every 30 min)
  └─ index.js --check
       ├─ Phase 1: IMAP fetch (imapflow) → raw emails
       ├─ Phase 2: Classify (claude -p --model haiku) → tags, priority, requiresResponse
       ├─ Phase 3: Apply IMAP tags (Gmail labels / IMAP keywords)
       ├─ Phase 4: System message filtering (skip automated emails)
       ├─ Phase 5: Task extraction (claude -p) → email-tasks.json
       └─ Phase 6: Response drafting (3-step Haiku loop) → email-responses.json → IMAP Drafts
```

- **4 email accounts**: Gmail Personal, Paradise Web, BoutaByte, BoutaCare
- **Zero API cost**: All Claude calls via `claude -p` (local CLI)
- **Dedup**: Tracks last 1000 Message-IDs in `processed.json`
- **Brand voice**: Loads voice profile from `voices/` for consistent tone

## Key Files

| File | Purpose |
|------|---------|
| `tools/email-checker/index.js` | Main pipeline: IMAP fetch, classify, extract tasks, draft responses |
| `tools/email-checker/classifier.js` | Email classification prompt (24 tag types, priority, urgency) |
| `tools/email-checker/response-drafter.js` | 3-step response loop: initial → self-critique → refinement |
| `tools/email-checker/sender.js` | SMTP send, IMAP draft saving, IMAP tag application |
| `tools/email-checker/approval-server.js` | Express API + web UI for draft approval (port 3847) |
| `tools/email-checker/supabase-sync.js` | Optional Supabase persistent storage sync |
| `tools/email-checker/config.json` | Account list, behavior settings, voice profile selection |
| `tools/email-checker/.env` | IMAP/SMTP credentials for all accounts |
| `tools/email-checker/voices/boutabyte-professional.txt` | Brand voice profile |
| `tools/email-checker/data/email-tasks.json` | Extracted tasks grouped by sender |
| `tools/email-checker/data/email-responses.json` | Draft responses (initial + critique + refined) |
| `tools/email-checker/data/processed.json` | Dedup tracker (last 1000 Message-IDs) |

## Configuration

**`config.json`** key settings:

| Setting | Default | Purpose |
|---------|---------|---------|
| `check_interval_minutes` | `15` | Timer interval |
| `lookback_hours` | `24` | How far back to fetch |
| `max_emails` per account | `20` | Limit per check |
| `classify_emails` | `true` | Enable Haiku classification |
| `extract_tasks` | `true` | Enable task extraction |
| `draft_responses` | `true` | Enable response drafting |
| `apply_tags_to_account` | `true` | Tag emails on IMAP server |
| `save_drafts_to_account` | `true` | Save drafts to IMAP Drafts folder |
| `voice_profile` | `boutabyte-professional` | Voice for response drafting |

**Credentials** (`.env`): Each account uses env prefix pattern:
- `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASS` (default account)
- `IMAP_HOST_PW`, `IMAP_HOST_BB`, `IMAP_HOST_BC` (additional accounts)

## Classification System

24 tag types across two categories:
- **Human**: urgent, action-required, informational, follow-up, scheduling, invoice, support, client-communication, approval-needed, time-sensitive, etc.
- **System**: automated, notification, newsletter, marketing, system-alert, security-alert, billing, password-reset, etc.

System messages (noreply@, notifications@, etc.) skip task extraction and response drafting. Security/billing alerts still flag user attention.

## Response Drafting (3-Step Loop)

1. **Initial draft**: Load voice profile → Claude Haiku → generate response
2. **Self-critique**: Critique prompt → Haiku → identify improvements
3. **Refinement**: Apply critique → Haiku → output final draft

Drafts saved to `email-responses.json` with status: `draft` → `approved` → `sent`

## How to Use

```bash
# Single check (used by systemd timer)
node tools/email-checker/index.js --check

# Start approval server
node tools/email-checker/approval-server.js

# View/manage via Discord bot
!@ check email          # trigger check
!@ email tasks          # show extracted tasks
!@ email drafts         # show pending drafts
!@ approve <id>         # approve and send draft
!@ reject <id>          # cancel draft

# systemd timer management
systemctl --user status opai-email.timer
systemctl --user start opai-email.timer
journalctl --user -u opai-email -f
```

## Dependencies

- **Runtime**: Node.js, imapflow, nodemailer, express, dotenv
- **CLI**: `claude` (classification + task extraction + drafting)
- **Integrated with**: [Discord Bridge](discord-bridge.md) (email commands), [Task Control Panel](task-control-panel.md) (email delegation), work-companion (task routing), task-manager (task registry)
- **Managed by**: [Services & systemd](services-systemd.md) (`opai-email.timer` + `opai-email.service`)
- **Triggered by**: [Orchestrator](orchestrator.md) (scheduled `email_check`)
