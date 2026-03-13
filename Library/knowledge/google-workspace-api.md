# Google Workspace API — Quick Reference

> Read this file when you need to interact with Google Drive, Gmail, Docs, or Sheets for agent@paradisewebfl.com.

## How To Use (Python, inline)

```python
import asyncio, sys, os
sys.path.insert(0, 'tools/shared')
os.environ['GOOGLE_AGENT_WORKSPACE_FOLDER_ID'] = '1i2usqWNFXQ03OyWOkqt2gNfuUpiu-lPA'

from google_workspace import GoogleWorkspace
ws = GoogleWorkspace()

# Then call any method below, e.g.:
# result = await ws.drive_list()
# await ws.close()
```

## IDs

| Resource | ID |
|----------|-----|
| Shared Drive (OPAI Agent-Space) | `0AI_12gJkvppNUk9PVA` |
| Agent Workspace folder | `1i2usqWNFXQ03OyWOkqt2gNfuUpiu-lPA` |
| OAuth Project | `opai-workspace-agent` (opai-487916) |

## Available Methods

### Drive

| Method | Args | Returns |
|--------|------|---------|
| `drive_list(folder_id?, page_size=50)` | folder_id: str or None for root | `{files: [{id, name, mimeType, modifiedTime, size}], nextPageToken?}` |
| `drive_read(file_id)` | file_id: str | `{metadata: {...}, content: str}` — Docs exported as text, Sheets as CSV |
| `drive_search(query, page_size=20)` | query: keyword or Drive syntax | `{files: [...]}` |
| `drive_write(name, content, mime_type='text/plain', folder_id?)` | Writes to Agent Workspace only | `{id, name, mimeType, webViewLink}` |
| `drive_get_metadata(file_id)` | file_id: str | Full metadata dict (permissions, owners, dates, etc.) |

### Doc Comments (Drive API)

| Method | Args | Returns |
|--------|------|---------|
| `docs_list_comments(file_id, include_resolved=False, modified_after?)` | file_id: str | `[{id, author, content, quotedFileContent, resolved, replies}]` |
| `docs_add_comment(file_id, content, quoted_text?)` | Anchors to text if quoted_text provided | `{id, author, content, createdTime}` |
| `docs_reply_comment(file_id, comment_id, content)` | Replies to existing thread | `{id, author, content, createdTime}` |
| `docs_resolve_comment(file_id, comment_id)` | Marks comment as resolved | `{id, resolved, modifiedTime}` |

### Gmail

| Method | Args | Returns |
|--------|------|---------|
| `gmail_search(query, max_results=10)` | query: Gmail search syntax | `[{id, threadId, subject, from, date, snippet}]` |
| `gmail_read(message_id)` | message_id from search results | `{subject, from, to, date, body, attachments}` |

## Drive Query Syntax

- Simple keywords: `"budget 2024"` → auto-wrapped in `fullText contains`
- Advanced: `"name contains 'proposal'"`, `"mimeType = 'application/pdf'"`
- Combined: `"name contains 'report' and modifiedTime > '2026-01-01'"`

## Gmail Search Syntax

- `subject:shared drive` — subject line
- `from:dallas@` — sender
- `is:unread` — unread only
- `has:attachment` — with attachments
- `newer_than:7d` — last 7 days

## Safety

- **Writes restricted** to Agent Workspace folder (parent chain verified via API)
- **Rate limits**: 60 reads/min, 10 writes/min, 5 sends/hour, 5 comments/min
- **All calls audited** in `tasks/audit.json`
- **Credentials** in opai-vault: `google-workspace-refresh-token`, `google-workspace-client-secret`

## @agent Mention System (Phase 2)

The workspace mention poller (`background/workspace_mentions.py`) runs every 2 minutes and scans Google Docs for `@agent` comments.

**Commands:** `review`, `summarize`, `fact-check`, `format`, `draft [x]`, `rewrite [x]`, `research [x]`

**Trust model:** All paradisewebfl.com users can use business commands. System/infra queries restricted to Dallas only.

**State:** `tools/opai-engine/data/workspace-mentions-state.json` (rolling 500 processed IDs)

**Google Chat webhook:** `POST /api/google-chat/webhook` — ready for when Chat app is registered in Cloud Console.

## Scopes (Phase 2 — 6 active)

Drive, Docs, Sheets, Gmail read, Gmail send, Calendar read-only.
Chat bot scope pending Cloud Console registration.
