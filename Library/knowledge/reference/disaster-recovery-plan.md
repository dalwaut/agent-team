# Disaster Recovery Plan

> **Last updated:** 2026-03-05
> **Purpose:** Step-by-step procedures for recovering OPAI services from various failure scenarios.
> **Location:** All services run on `dallas-HP-Z420-Workstation` (192.168.1.191). BB VPS (72.60.115.74) is reverse proxy only.

---

## Recovery Targets

| Metric | Target | Notes |
|--------|--------|-------|
| **RTO** (Recovery Time Objective) | 2 hours | Full service restoration |
| **RPO** (Recovery Point Objective) | 24 hours | Last git commit + Supabase point-in-time |
| **Priority Order** | Core > Comms > Tools > Integrations | See tiers below |

---

## Data Recovery Priorities

### Tier 1 — Critical (restore first)

| Data | Location | Backup Method | Recovery |
|------|----------|--------------|----------|
| Supabase database | Cloud (Supabase-hosted) | Automatic daily backups (Supabase Pro) | Dashboard > Database > Backups > Restore |
| OPAI codebase | `/workspace/synced/opai` | Git (GitHub) + Synology Drive | `git clone` from GitHub |
| Vault secrets | `tools/opai-vault/data/` | SOPS+age encrypted (in git) | `git checkout` + age key from secure backup |
| Caddy config | `config/Caddyfile` | In git | `git checkout` |
| systemd service files | `config/service-templates/` | In git | `./scripts/install-services.sh` |

### Tier 2 — Important (restore second)

| Data | Location | Backup Method | Recovery |
|------|----------|--------------|----------|
| Engine state files | `tools/opai-engine/data/` | Synology Drive sync | Restore from NAS or recreate (self-healing) |
| Team Hub data | Supabase tables | Supabase backup | Part of Supabase restore |
| WordPress backups | `/home/dallas/WautersEdge/WPBackups` | Synology Drive sync | Restore from NAS |
| Brain data | Supabase tables + `tools/opai-brain/data/` | Mixed | Supabase restore + Synology |

### Tier 3 — Recoverable (restore last)

| Data | Location | Backup Method | Recovery |
|------|----------|--------------|----------|
| Reports | `reports/` | Git + Synology Drive | `git checkout` or NAS |
| Logs | `/workspace/logs/` | Synology Drive sync | Restore from NAS (or accept loss) |
| Agent workspaces | `/workspace/local/agent-workspaces/` | Ephemeral | Recreated automatically by workers |
| NFS ClawBot folders | `/workspace/users/_clawbots/` | NFS mount | Re-mount NFS share |

---

## Scenario 1: Service Crash (Single Service Down)

**Symptoms:** One service returns 502/503, health check fails, Telegram alert fires.

1. Check service status: `systemctl --user status opai-<service>`
2. Check logs: `journalctl --user -u opai-<service> -n 50`
3. Restart: `systemctl --user restart opai-<service>`
4. If restart fails, check port conflict: `ss -tlnp | grep <port>`
5. If port occupied, kill stale process: `kill $(lsof -t -i:<port>)`
6. Restart again
7. Verify via health endpoint: `curl http://127.0.0.1:<port>/health`

**Self-healing:** The Engine heartbeat auto-restarts crashed managed workers every 30 minutes.

---

## Scenario 2: Full System Reboot (Workstation Power Loss)

1. System boots, user auto-login activates
2. Start all services: `./scripts/opai-control.sh start`
3. Verify: `./scripts/opai-control.sh status`
4. Check Caddy: `systemctl --user status opai-caddy`
5. Verify Supabase connectivity: `./scripts/supabase-sql.sh "SELECT 1"`
6. Check Telegram bot: send `/status` in Telegram
7. Engine heartbeat will auto-detect and restart any missing workers

---

## Scenario 3: Supabase Outage

**Symptoms:** All services return auth errors, database queries fail.

1. Check Supabase status: https://status.supabase.com/
2. If planned maintenance: services degrade gracefully (cached data continues)
3. If unplanned:
   - Services with local state files continue operating (Engine, Brain)
   - Auth-dependent services will reject new logins
   - Wait for Supabase recovery
4. After recovery: restart all services to clear stale connections
   ```bash
   ./scripts/opai-control.sh restart
   ```

**If Supabase project is lost:**
1. Create new project in Supabase dashboard
2. Run migrations: `config/supabase-migrations/*.sql` in order
3. Update env vars (new URL, keys) in Vault
4. Restart all services

---

## Scenario 4: Disk Failure / Data Loss

1. **If boot drive fails:**
   - Reinstall Ubuntu 24.04 LTS
   - Install dependencies: Node.js 20 (nvm), Python 3.12, Caddy, age, sops
   - Clone repo: `git clone <repo-url> /workspace/synced/opai`
   - Restore Vault age key from secure backup (USB / password manager)
   - Install services: `./scripts/install-services.sh`
   - Start: `./scripts/opai-control.sh start`

2. **If data drive fails:**
   - Restore `/workspace/` from Synology NAS backup
   - Re-mount NFS shares for user sandboxes
   - Verify Synology Drive sync reconnects

---

## Scenario 5: Caddy / SSL Issues

1. Check Caddy: `systemctl --user status opai-caddy`
2. Validate config: `caddy validate --config /workspace/synced/opai/config/Caddyfile`
3. Reload: `caddy reload --config /workspace/synced/opai/config/Caddyfile`
4. If self-signed certs expired: Caddy regenerates automatically on restart
5. For BB VPS (public domain): check Caddy on VPS separately

---

## Scenario 6: Git Repository Corruption

1. Check repo health: `git fsck`
2. If corrupted locally: delete and re-clone from GitHub
3. Synology Drive sync preserves a second copy — check NAS if GitHub is unavailable
4. After re-clone: restore local-only files (`.env` files from Vault, `data/` dirs from NAS)

---

## Scenario 7: Security Incident (Compromised Credentials)

1. **Immediate:** Activate network lockdown via Telegram `/lockdown <PIN>` or Engine API
2. Rotate all Supabase keys in dashboard
3. Rotate Vault age key: generate new key, re-encrypt store
4. Rotate Telegram bot token
5. Rotate all `.env` secrets via `tools/opai-vault/scripts/import-env.py`
6. Audit access logs: `./scripts/supabase-sql.sh "SELECT * FROM auth.audit_log_entries ORDER BY created_at DESC LIMIT 50"`
7. Restart all services with new credentials

---

## Recovery Checklist (Post-Incident)

- [ ] All 12 systemd services running (`opai-control.sh status`)
- [ ] Caddy serving HTTPS (test via browser)
- [ ] Supabase connected (run test query)
- [ ] Telegram bot responsive (`/status` command)
- [ ] Engine heartbeat producing snapshots (check dashboard)
- [ ] Vault accessible (`vault-cli.sh list`)
- [ ] Synology Drive sync active
- [ ] NFS mounts healthy (`df -h | grep nfs`)
- [ ] No stale processes (`ps aux | grep claude | wc -l`)

---

## Secure Backup Locations

| Item | Primary | Secondary |
|------|---------|-----------|
| Git repo | GitHub (private) | Synology NAS (Drive sync) |
| Age key (Vault master) | Password manager | USB drive (physical safe) |
| Supabase credentials | Supabase dashboard | Vault encrypted store |
| Telegram bot token | BotFather | Vault encrypted store |
| SSH keys | `~/.ssh/` | Password manager |
