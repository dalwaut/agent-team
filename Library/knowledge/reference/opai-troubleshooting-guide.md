# OPAI Troubleshooting Guide

> **Purpose:** Common issues, symptoms, and fixes for OPAI services and infrastructure.
> For agents (incident_responder, tools_monitor) and human operators.
> Consolidates hard-won fixes from `memory/troubleshooting.md`, `memory/gotchas.md`, and wiki plans/troubleshooting.
> **Last updated:** 2026-03-05

---

## Quick Diagnosis Checklist

When something is broken, run through this first:

```
1. Is the service running?     → ./scripts/opai-control.sh status
2. What do the logs say?       → journalctl --user -u opai-<service> -n 50
3. Is the port responding?     → curl -s http://localhost:<port>/health
4. Did vault inject env vars?  → systemctl --user show opai-<service> | grep Environment
5. Is Supabase reachable?      → scripts/supabase-sql.sh "SELECT 1"
6. Is Caddy routing correctly? → curl -I https://opai.boutabyte.com/<path>/
7. Recent changes?             → git log --oneline -10
```

---

## Service Issues

### Service Will Not Start

**Symptoms:** `systemctl --user start opai-<service>` fails, status shows `failed` or `inactive`.

| Cause | Fix |
|-------|-----|
| Missing environment variables | Check vault injection: `systemctl --user show opai-<service> \| grep Environment`. Re-run vault inject: `./tools/opai-vault/scripts/import-env.py` |
| Port already in use | `lsof -i :<port>` to find the process, kill it, restart service |
| Python dependency missing | `cd tools/<service> && pip install -r requirements.txt` |
| Node dependency missing | `cd tools/<service> && npm install` |
| systemd PATH issue | systemd does not inherit shell PATH. Ensure service file uses absolute paths for python/node binaries. Check `ExecStart` in service file. |
| Permission denied | Check file ownership: `ls -la tools/<service>/`. Services run as user `dallas`. |

### Service Starts but Crashes Immediately

**Symptoms:** Status shows `activating` then `failed` in a loop.

| Cause | Fix |
|-------|-----|
| Supabase connection failure | Check `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in vault. Verify Supabase project is not paused. |
| Import error in Python | Check `journalctl --user -u opai-<service> -n 20` for the traceback. Usually a missing module or wrong Python version. |
| Config file missing/corrupt | Verify `config.py` or `config.json` exists and is valid JSON/Python. |
| Database migration needed | New tables or columns required. Check `config/supabase-migrations/` for pending SQL. |

### Service Running but Not Responding

**Symptoms:** `systemctl --user status` shows `active (running)` but `curl` to port times out.

| Cause | Fix |
|-------|-----|
| Binding to wrong interface | Ensure service binds to `0.0.0.0`, not `127.0.0.1`, if accessed via Caddy |
| Caddy path routing wrong | Check `config/Caddyfile` for the correct `reverse_proxy` entry |
| CORS blocking frontend | Check browser console for CORS errors. Add appropriate headers in the backend. |
| Async startup not complete | Some services (Engine, HELM) have background init tasks. Wait 10-30 seconds after start. |

---

## Authentication Issues

### "Unauthorized" or 401 Errors

| Cause | Fix |
|-------|-----|
| JWT expired | Re-login at Portal. Tokens expire per Supabase settings. |
| Wrong JWT algorithm | OPAI uses both ES256 (user) and HS256 (service). Ensure the right key is used for the context. Service-to-service calls use `SUPABASE_SERVICE_KEY`. |
| Missing `Authorization` header | Frontend must send `Bearer <token>` on every API call. Check `auth.js` for the tool. |
| RLS policy blocking | Supabase RLS may block queries. Service key bypasses RLS. For user queries, ensure `get_my_role()` returns the correct role. |
| AI Lock active | User's `ai_locked` flag is set. Admin must clear via Users tool. |

### Session/Login Issues

| Cause | Fix |
|-------|-----|
| Infinite redirect loop at login | Clear browser cookies for the domain. Check Portal's auth redirect logic. |
| "Invalid login credentials" | User may not exist in Supabase. Check `profiles` table. |
| Onboarding not completing | Check `onboarding_status` in `profiles` table. May need manual update. |

---

## Database Issues

### Supabase Connection Failures

| Cause | Fix |
|-------|-----|
| Project paused | Go to Supabase dashboard, restore the project. Or: `scripts/supabase-sql.sh "SELECT 1"` to test. |
| Service key expired/rotated | Get new key from Supabase dashboard, update in Vault. |
| RLS recursion | Supabase RLS policies that call functions which query the same table = infinite loop. The fix: use `security definer` functions. See wiki `plans/troubleshooting.md`. |
| Connection pool exhausted | Too many concurrent connections. Restart the service. Check for connection leaks (unclosed DB sessions). |

### Migration Issues

| Cause | Fix |
|-------|-----|
| Migration fails with existing objects | Add `IF NOT EXISTS` to CREATE statements. Check if the migration was partially applied. |
| Missing table/column | Run the migration: `scripts/supabase-sql.sh < config/supabase-migrations/<file>.sql` |
| Type mismatch | Check column types against what the code expects. Common: `text` vs `varchar`, `timestamptz` vs `timestamp`. |

---

## Caddy / Reverse Proxy Issues

### Page Not Loading

| Cause | Fix |
|-------|-----|
| Caddy not running | `sudo systemctl status caddy`. Restart: `sudo systemctl restart caddy`. |
| Caddyfile syntax error | `caddy validate --config config/Caddyfile`. Fix errors, then `caddy reload`. |
| Wrong path routing | Check `config/Caddyfile` for the path. Must match the tool's route. |
| TLS certificate issue | Caddy auto-manages TLS. If failing, check DNS records. Force renew: restart Caddy. |
| HTTP to HTTPS redirect loop | Ensure Caddy is the only TLS terminator. No other proxy in front. |

---

## Telegram Bot Issues

### Bot Not Responding

| Cause | Fix |
|-------|-----|
| Webhook not set | Run `node tools/opai-telegram/set-webhook.js` |
| Service crashed | Check `journalctl --user -u opai-telegram -n 50` |
| Rate limited by Telegram | Wait 30 seconds, retry. Bot auto-recovers. |
| Wrong bot token | Verify `TELEGRAM_BOT_TOKEN` in vault matches @BotFather. |

### HITL Gate Not Working

| Cause | Fix |
|-------|-----|
| Callback query not handled | Check `handlers/callbacks.js` for the button callback pattern |
| Team Hub item not found | Verify UUID routing in callback data. Check Team Hub API. |
| 15-min escalation not firing | Check heartbeat background loop is running in Engine. |

---

## Email Agent Issues

### Email Not Being Fetched

| Cause | Fix |
|-------|-----|
| IMAP credentials expired | Update in vault. Gmail app passwords expire if account security changes. |
| Whitelist/blacklist misconfigured | Check `tools/opai-email-agent/config.json` |
| Rate limited by mail server | Increase polling interval in `config.json` |
| DNS resolution failure | Check if the IMAP host is reachable: `dig <imap_host>` |

### Email Classification Wrong

| Cause | Fix |
|-------|-----|
| New sender pattern | Add to custom classifications in `config.json` |
| Classification prompt needs update | Edit agent-core.js classification logic |
| Trash misclassification | Check blacklist patterns, may be too aggressive |

---

## WordPress Integration Issues

### Site Not Connecting

| Cause | Fix |
|-------|-----|
| Connector plugin not installed | Deploy via "Push OP" from OP WordPress UI |
| Application password invalid | Generate new app password in WordPress admin. Update in vault. |
| Site behind Cloudflare/WAF | May need to whitelist OPAI's IP or use API key auth |
| REST API disabled | Check WordPress permalink settings. REST API requires pretty permalinks. |

### Self-Healing Retry Agent

The WordPress manager has a self-healing connection retry. If a site goes offline:
1. Agent detects connection failure
2. Tries alternative connection methods (app password, API key, basic auth)
3. Logs result to registry/audit
4. Telegram alert if all methods fail

---

## Engine / Heartbeat Issues

### Heartbeat Not Running

| Cause | Fix |
|-------|-----|
| Engine not started | `./scripts/opai-control.sh restart` |
| Background task crashed | Check Engine logs: `journalctl --user -u opai-engine -n 100` |
| Worker stall detection false positive | Heartbeat may flag workers that are legitimately long-running. Check worker status manually. |

### Fleet Coordinator Issues

| Cause | Fix |
|-------|-----|
| Workers not being dispatched | Check `config/workers.json` for correct entries. Verify Engine startup loaded all workers. |
| Worker mail not delivering | Check SQLite DB in Engine data directory. Worker mail uses SQLite, not Supabase. |
| NFS dispatcher not finding files | Verify NFS mount: `ls /workspace/users/_clawbots/`. Check mount: `mount \| grep nfs`. |

---

## Common Python Gotchas

| Issue | Fix |
|-------|-----|
| `ModuleNotFoundError` | Wrong Python environment. Check which `python3` the service uses. May need `pip install` in the correct venv. |
| UTC timestamp issues | Always use `datetime.utcnow()` or `datetime.now(timezone.utc)`. Never use `datetime.now()` in server code — timezone drift causes issues. |
| `asyncio` event loop errors | Cannot call `asyncio.run()` inside an already-running loop. Use `await` or `loop.run_in_executor()`. |
| Import path issues | Ensure `sys.path` includes the project root. Check `__init__.py` files. |

## Common Node.js Gotchas

| Issue | Fix |
|-------|-----|
| `EADDRINUSE` | Another process on the port. `lsof -i :<port>` to find it. |
| `ECONNREFUSED` | Target service not running. Check dependent services. |
| Unhandled promise rejection | Add `.catch()` to all promises, or use `async/await` with try/catch. |
| `node_modules` out of date | Delete `node_modules` and `package-lock.json`, re-run `npm install`. |

---

## Emergency Procedures

### All Services Down
```bash
# Check system resources
free -h
df -h
top -bn1 | head -20

# Restart all services
./scripts/opai-control.sh restart

# Check what came back
./scripts/opai-control.sh status
```

### Disk Full
```bash
# Find large files
du -sh /workspace/synced/opai/* | sort -rh | head -20

# Clear logs (safe)
journalctl --user --vacuum-time=7d

# Check for large data files in tools
find /workspace/synced/opai/tools -name "*.db" -o -name "*.sqlite" -o -name "*.log" | xargs ls -lh
```

### Credential Compromise
1. Immediately rotate the compromised credential in the source system
2. Update in Vault: `tools/opai-vault/scripts/import-env.py`
3. Restart affected services: `./scripts/opai-control.sh restart`
4. Audit recent activity in the affected service logs
5. Document the incident in Team Hub

---

## References

| Document | Path |
|----------|------|
| Service Control | `scripts/opai-control.sh` |
| Services & systemd wiki | `Library/opai-wiki/core/services-systemd.md` |
| Vault wiki | `Library/opai-wiki/infra/vault.md` |
| Memory troubleshooting | `memory/troubleshooting.md` |
| Memory gotchas | `memory/gotchas.md` |
| Wiki troubleshooting | `Library/opai-wiki/plans/troubleshooting.md` |
