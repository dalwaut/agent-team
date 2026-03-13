# Email Migration Workflow

> Migrate email accounts between IMAP providers (GoDaddy M365 → Hostinger, or any IMAP-to-IMAP).

**Tool**: `tools/opai-email-migration/`
**Worker**: `email-migration` (registered in `config/workers.json`)
**State**: SQLite at `tools/opai-email-migration/data/migration.db`

---

## Quick Start

```bash
# 1. Install dependencies
pip install -r tools/opai-email-migration/requirements.txt

# 2. Set credentials as env vars (or use vault-env.sh)
export SOURCE_PASS="source-app-password"
export TARGET_PASS="target-password"

# 3. Dry run (validates config, connects to both servers, shows what would migrate)
python3 tools/opai-email-migration/migrate.py --job tools/opai-email-migration/jobs/my-job.json --dry-run

# 4. Real migration
python3 tools/opai-email-migration/migrate.py --job tools/opai-email-migration/jobs/my-job.json

# 5. Check progress
python3 tools/opai-email-migration/migrate.py --status <job-id>

# 6. Verify results
python3 tools/opai-email-migration/migrate.py --verify <job-id>

# 7. Generate DNS cutover guide
python3 tools/opai-email-migration/migrate.py --dns-guide m365 hostinger domain.com
```

---

## Migration Modes

### Full Migration (active accounts)

1:1 account mapping. Every folder and message migrated with flags preserved.

```json
{
  "job_id": "migrate-acme-001",
  "source": {
    "provider": "m365",
    "host": "outlook.office365.com",
    "port": 993,
    "auth": "app_password",
    "accounts": [
      { "email": "user@acme.com", "password_env": "SRC_PASS" }
    ]
  },
  "target": {
    "provider": "hostinger",
    "host": "imap.hostinger.com",
    "port": 993,
    "accounts": [
      { "email": "user@acme.com", "password_env": "TGT_PASS" }
    ]
  },
  "options": {
    "mode": "full",
    "batch_size": 50,
    "skip_folders": ["Junk Email", "Deleted Items"],
    "verify_after": true
  }
}
```

### Archive Consolidation (inactive accounts)

N source accounts → 1 target archive account. Folders prefixed with `Archive/{email}/`.

```json
{
  "options": {
    "mode": "archive",
    "folder_prefix": "Archive/{source_email}",
    "batch_size": 100
  }
}
```

---

## Workflow Phases

### Phase 1: Preparation

- [ ] Inventory source accounts (active vs inactive)
- [ ] Create target accounts on Hostinger
- [ ] Get app passwords or OAuth2 tokens for source
- [ ] Get passwords for target accounts
- [ ] Store credentials in Vault under `opai-email-migration`
- [ ] Create job config JSON

### Phase 2: Test Migration

- [ ] Dry run: `--dry-run` to validate config and preview
- [ ] Migrate 1 internal test account first
- [ ] Verify: `--verify` to check counts and integrity
- [ ] Test resume: kill mid-batch, resume with `--resume`

### Phase 3: Client Migration

- [ ] Migrate active accounts (full mode)
- [ ] Migrate inactive accounts (archive mode)
- [ ] Run verification on all accounts
- [ ] Review verification report

### Phase 4: DNS Cutover

- [ ] Generate DNS guide: `--dns-guide m365 hostinger domain.com`
- [ ] Lower MX TTL to 300 (48 hours before)
- [ ] Update MX records
- [ ] Update SPF record
- [ ] Add DKIM record
- [ ] Send/receive test emails
- [ ] Monitor for 48 hours

### Phase 5: Cleanup

- [ ] Verify all email clients reconfigured
- [ ] Confirm no bounced emails
- [ ] Raise TTL back to normal
- [ ] Decommission old provider (after 7-day safety period)

---

## Resume on Failure

The tool tracks every message individually in SQLite. If it crashes or loses connection:

```bash
# Just re-run — it picks up from the last checkpoint
python3 tools/opai-email-migration/migrate.py --job jobs/my-job.json
```

Already-migrated messages are skipped via Message-ID dedup.

---

## HITL Gates

| Gate | When | Approval |
|------|------|----------|
| `start_migration` | Before first IMAP connection | Interactive prompt (CLI) |
| `dns_cutover` | After verification passes | Manual DNS changes |
| `delete_source` | If source cleanup requested | Explicit confirmation |

---

## Folder Mapping

Built-in provider maps handle common renames:

| M365 → Hostinger |
|---|
| `Sent Items` → `Sent` |
| `Deleted Items` → `Trash` |
| `Junk Email` → `Junk` |
| `Outbox` → *(skipped)* |

Custom overrides via `custom_folder_map` in job config:
```json
"options": {
  "custom_folder_map": {
    "My Custom Folder": "Renamed Folder",
    "Old Folder": null
  }
}
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| M365 blocks app password | Enable via Azure AD → Security → Auth methods. Or use OAuth2 (`"auth": "oauth2"`) |
| Hostinger quota exceeded | Check quota before migration. Pre-clean junk/deleted on source |
| Connection drops mid-batch | Automatic: reconnects and resumes from checkpoint |
| Duplicate messages on target | Dedup via Message-ID header prevents this |
| Wrong folder names on target | Adjust `custom_folder_map` in job config and re-run |
| `--status` shows pending messages | Re-run the job — it will pick up pending messages |

---

## Engine Worker Usage

Dispatchable via Engine API:

```bash
# Via Engine
curl -X POST http://localhost:8080/api/workers/email-migration/run \
  -H "Content-Type: application/json" \
  -d '{"action": "migrate", "job_config": "tools/opai-email-migration/jobs/my-job.json"}'
```
