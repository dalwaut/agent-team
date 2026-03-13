# Troubleshooting Guide
> **🔒 Admin Only** — Internal debugging reference. Not surfaced to general users.
> Last updated: 2026-02-21

Hard-won fixes for recurring or frustrating problems. Check here before spending cycles on repeated investigation.

---

## electron-vite: Edits to `.ts` have no effect after rebuild

**Symptom:** You edit `src/main/index.ts` or `src/preload/index.ts`, run `npm run build`, the build succeeds, but the running app shows no change. Grepping the output bundle reveals old hardcoded values.

**Root cause:** Stale compiled `.js` files sitting *next to* the `.ts` source files (e.g. `src/main/index.js`, `src/preload/index.js`). electron-vite resolves `.js` before `.ts` in module lookup, so it compiles the old artifact and ignores your edited source entirely.

**Fix:**
```bash
rm src/main/index.js src/main/index.d.ts
rm src/preload/index.js src/preload/index.d.ts
npm run build
```

**Always verify the fix landed in the bundle:**
```bash
grep -o "yourChangedKeyword.\{1,60\}" out/main/index.js
```

**Prevention:** Never commit or leave `*.js` / `*.d.ts` artifacts alongside `*.ts` source files in `src/main/` or `src/preload/`. Add them to `.gitignore`.

---

## Electron: Relaunch shows old code — new instance exits immediately

**Symptom:** After rebuilding, you relaunch the app and nothing changes. The new process exits almost instantly.

**Root cause:** `app.requestSingleInstanceLock()` is active. The new instance detects the old process, focuses it, and quits — so the old binary keeps running.

**Fix:** Kill the old process first:
```bash
pkill -f "electron.*scc-ide" || pkill -f "npx electron"
# Then relaunch
bash tools/scc-ide/launch.sh
```

---

## General: "Nothing changed" after code edits

Run through this checklist in order before making more edits:

| # | Check | Command |
|---|-------|---------|
| 1 | Is your change actually in the build output? | `grep "yourChange" out/main/index.js` |
| 2 | Is the old process still running? | `pgrep -fa electron` |
| 3 | Is a stale `.js` next to your `.ts`? | `ls src/main/` |
| 4 | Is a build cache serving old assets? | Clear `.cache/` or `out/`, rebuild |
| 5 | Is the app loading from the right path? | Check `launch.sh` — AppImage → built → dev fallback |

**Rule:** Before concluding "nothing changed", always grep the *build output* for your specific change. Never assume the build used the source you edited.

---

## Claude Code CLI: `--cwd` is not a valid flag

**Symptom:** SCC IDE spawns Claude Code but gets no response at all. Process exits immediately with code 1.

**Root cause:** `--cwd <dir>` is not a Claude Code CLI flag. Passing it causes `error: unknown option '--cwd'` and immediate exit. The working directory is already set correctly via Node's `spawn(bin, args, { cwd: dir })` option — no CLI flag needed.

**Correct spawn args:**
```javascript
// WRONG — kills the process immediately:
const args = ['--cwd', opts.cwd, '--output-format', 'stream-json', '--verbose', '-p', prompt]

// CORRECT — cwd is set via spawn option, not a CLI flag:
const args = ['--output-format', 'stream-json', '--verbose', '-p', prompt]
spawn(claudeBin, args, { cwd: opts.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
```

**Also:** When resuming a session, `-p <prompt>` is still required alongside `--resume <session_id>`.

**Quick test to verify spawn args before building:**
```bash
node -e "
const {spawnSync} = require('child_process')
const r = spawnSync('/path/to/claude', ['--output-format','stream-json','-p','hi'], {cwd:'/workspace/synced/opai', encoding:'utf8'})
console.log('status:', r.status, 'stderr:', r.stderr?.slice(0,200))
"
```

---

## Python services: Timestamps display wrong (5–6 hours off)

**Symptom:** Timestamps in the UI appear 5–6 hours too early.

**Root cause:** OPAI Server runs in `America/Chicago`. Using `datetime.now().isoformat() + "Z"` appends a fake UTC marker on local time.

**Fix:** Always use `datetime.now(timezone.utc).isoformat()` for any ISO timestamp stored in JSON.

---

## Supabase RLS: Infinite recursion on `profiles` table

**Symptom:** Queries against `profiles` hang or return a recursion error.

**Root cause:** A policy on `profiles` uses `EXISTS (SELECT FROM profiles WHERE ...)` — self-referencing causes infinite recursion.

**Fix:** Use the `get_my_role()` SECURITY DEFINER function instead. Never query `FROM profiles` inside a policy ON `profiles`. See `auth-network.md` for the full pattern.

---

## Email Agent: IMAP fetch misses old unread emails

**Symptom:** Unread emails older than today aren't being fetched.

**Root cause:** Using a `SINCE` date filter silently skips older unread mail. Two-step `client.search()` + `client.fetch()` causes EPIPE crash.

**Fix:** Pass `{ seen: false }` criteria directly to `client.fetch({ seen: false }, ...)` — single call, no date filter.

---

## systemd services: `claude` CLI not found

**Symptom:** A service that spawns `claude` fails with "command not found" even though it works in your shell.

**Root cause:** systemd doesn't source `.bashrc`, so nvm's PATH isn't set.

**Fix:** Add to the `[Service]` section:
```ini
Environment="PATH=/home/dallas/.nvm/versions/node/v20.19.5/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
```

---

## Email Delivery Failure: No MX records on Hostinger-hosted domains

**Symptom:** Emails to `info@yourdomain.com` bounce with "delivery failed" or "no mail server found." DNS lookups show no MX records.

**Our setup:** Domains purchased at **GoDaddy**, nameservers pointed to **Hostinger** (`ns1.dns-parking.com` / `ns2.dns-parking.com`), websites hosted at **Hostinger**, email on **Google Workspace**. This means **all DNS is managed at Hostinger**, not GoDaddy — GoDaddy's DNS editor is locked out when nameservers point elsewhere.

**Root cause:** Hostinger sets up the A record for the website automatically but does NOT add MX/SPF/DMARC records for email. If email is on Google Workspace (or any external provider), those records must be added manually.

**How to confirm the problem:**
```bash
# Check if MX records exist
dig yourdomain.com MX +short
# (empty = no mail routing)

# Verify nameservers are Hostinger's
dig yourdomain.com NS +short
# ns1.dns-parking.com / ns2.dns-parking.com = Hostinger

# Confirm via SOA (look for dns.hostinger.com)
dig yourdomain.com SOA +short
```

**How to confirm DNS is at Hostinger (not GoDaddy):**
```bash
dig yourdomain.com SOA +short
# If SOA admin shows dns.hostinger.com → DNS zone is at Hostinger
```

**Fix — add these records in Hostinger hPanel:**

1. Log in at `hpanel.hostinger.com`
2. **Websites** → find domain → **Manage**
3. Left sidebar → **Advanced** → **DNS Zone Editor**

**Google Workspace MX records (all 5):**

| Type | Name | Value | Priority | TTL |
|------|------|-------|----------|-----|
| MX | @ | `ASPMX.L.GOOGLE.COM` | 1 | 14400 |
| MX | @ | `ALT1.ASPMX.L.GOOGLE.COM` | 5 | 14400 |
| MX | @ | `ALT2.ASPMX.L.GOOGLE.COM` | 5 | 14400 |
| MX | @ | `ALT3.ASPMX.L.GOOGLE.COM` | 10 | 14400 |
| MX | @ | `ALT4.ASPMX.L.GOOGLE.COM` | 10 | 14400 |

**SPF record (authorizes Google to send):**

| Type | Name | Value | TTL |
|------|------|-------|-----|
| TXT | @ | `v=spf1 include:_spf.google.com ~all` | 14400 |

**DMARC record (email authentication policy):**

| Type | Name | Value | TTL |
|------|------|-------|-----|
| TXT | _dmarc | `v=DMARC1; p=none; rua=mailto:info@yourdomain.com` | 14400 |

**How to verify the fix:**
```bash
# Check records at Hostinger's nameserver directly (instant, no propagation wait)
dig @ns1.dns-parking.com yourdomain.com MX +short
dig @ns1.dns-parking.com yourdomain.com TXT +short
dig @ns1.dns-parking.com _dmarc.yourdomain.com TXT +short

# Check public propagation (may take 15-60 minutes)
dig yourdomain.com MX +short
dig yourdomain.com TXT +short
```

**How to test email delivery end-to-end:**
```bash
# Send a test email via the OPAI Email Agent API
python3 -c "
import httpx
resp = httpx.post('http://127.0.0.1:8093/api/compose', json={
    'to': 'info@yourdomain.com',
    'subject': 'Test - Email Delivery Verification',
    'body': 'Test email to verify delivery after DNS fix.'
}, timeout=30)
print(resp.status_code, resp.text)
"
```

**How to test SMTP port connectivity (if delivery still fails):**
```bash
# Test if the mail server accepts connections
dig yourdomain.com MX +short  # get the MX host
nc -zv ASPMX.L.GOOGLE.COM 25 -w 5  # should show "succeeded"
```

**Key lessons:**
- GoDaddy DNS editor is **locked** when nameservers point to Hostinger — you MUST edit DNS at Hostinger
- `dns-parking.com` nameservers = Hostinger (verify via `SOA` record showing `dns.hostinger.com`)
- Hostinger creates A records automatically for hosted sites but never creates MX/SPF/DMARC
- Query `@ns1.dns-parking.com` directly to verify records before waiting for propagation
- This applies to ALL our Hostinger-hosted domains with Google Workspace email

**Domains fixed with this pattern:**
- `visitevergladescity.com` (2026-02-24) — MX + SPF + DMARC added at Hostinger

---

## Auth redirect loop on remote access (Command Center)

**Symptom**: Accessing `/tasks/` or `/engine/` via Tailscale (remote) causes infinite redirect loop to `/auth/login` then back to portal. Localhost access works fine.

**Why**: `app.js` calls `loadCommandCenter()` → `fetchWithAuth()` before `opaiAuth.init()` has completed. On remote access, auth is enabled (not disabled), so `fetchWithAuth()` finds no token → redirects to login. On localhost, `auth_disabled: true` is returned by `/auth/config`, so a mock session is created synchronously.

**Fix**: Wrap data-loading calls in `window.OPAI_AUTH_INIT.then(...)` so they wait for auth to initialize. Also add any missing method exports to `auth-v3.js` (e.g., `getSession()` was missing).

**Pattern**: If adding a new frontend that uses `fetchWithAuth`, always await auth init before making API calls. See [Auth & Network](../core/auth-network.md) > "Auth Init Race Condition".

---

## Related

- `memory/troubleshooting.md` — condensed version for Claude Code session context
- `services-systemd.md` — service configs and control commands
- `auth-network.md` — RLS patterns and `get_my_role()` reference
