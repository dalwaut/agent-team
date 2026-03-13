# OPAI Services — Auth & Network Setup Guide

## Overview

All OPAI web services are gated behind **Supabase Auth** and served through a **Caddy reverse proxy**. Network access uses **Tailscale** for cross-subnet connectivity.

```
Devices (any subnet) → Tailscale VPN → Caddy (:80) on opai-server
  /              → Portal (login + dashboard)
  /auth/*        → Portal auth endpoints
  /chat/*        → OPAI Chat (user + admin)
  /monitor/*     → Monitor (admin only)
  /tasks/*       → Task Control (admin only)
  /terminal/*    → Web Terminal (admin only)
```

---

## Step 1: Tailscale (Network)

### Server
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --hostname=opai-server
tailscale ip -4   # Note this 100.x.x.x IP
```

### Synology NAS
Tailscale is already installed but not configured:
1. Open **Package Center** → Open **Tailscale** package
2. Sign in with same Tailscale account as server
3. Note the NAS's Tailscale IP for future sandbox storage mounts

### Client Devices
Install Tailscale on each phone/laptop/tablet from https://tailscale.com/download

### Verify
From any device: `ping opai-server` (MagicDNS) or `ping 100.x.x.x`

---

## Step 2: Supabase Auth Setup

### Apply Migrations
In the **Supabase Dashboard** for project `idorgloobxkmlnwnxbej`:

1. Go to **SQL Editor**
2. Paste and run `config/supabase-migrations/001_create_profiles_and_conversations.sql`
3. Paste and run `config/supabase-migrations/002_enable_rls.sql`
4. Follow `config/supabase-migrations/003_create_admin_user.md` to create admin user

### Get Credentials
From Supabase Dashboard → **Settings** → **API**:
- `SUPABASE_URL` — Project URL (e.g., `https://idorgloobxkmlnwnxbej.supabase.co`)
- `SUPABASE_ANON_KEY` — anon/public key
- `SUPABASE_JWT_SECRET` — JWT Secret (Settings → API → JWT Settings)

---

## Step 3: Environment Variables

Create `.env` files for each service:

### tools/opai-portal/.env
```
SUPABASE_URL=https://idorgloobxkmlnwnxbej.supabase.co
SUPABASE_ANON_KEY=eyJ...your-anon-key
```

### tools/opai-chat/.env (add to existing)
```
SUPABASE_URL=https://idorgloobxkmlnwnxbej.supabase.co
SUPABASE_ANON_KEY=eyJ...your-anon-key
SUPABASE_JWT_SECRET=your-jwt-secret
```

### tools/opai-monitor/.env
```
SUPABASE_URL=https://idorgloobxkmlnwnxbej.supabase.co
SUPABASE_ANON_KEY=eyJ...your-anon-key
SUPABASE_JWT_SECRET=your-jwt-secret
```

### tools/opai-tasks/.env
```
SUPABASE_URL=https://idorgloobxkmlnwnxbej.supabase.co
SUPABASE_ANON_KEY=eyJ...your-anon-key
SUPABASE_JWT_SECRET=your-jwt-secret
```

### tools/opai-terminal/.env
```
SUPABASE_URL=https://idorgloobxkmlnwnxbej.supabase.co
SUPABASE_JWT_SECRET=your-jwt-secret
```

---

## Step 4: Install Dependencies

```bash
pip install python-jose[cryptography] httpx

# Per service (if using venvs):
cd /workspace/synced/opai/tools/opai-portal && pip install -r requirements.txt
cd /workspace/synced/opai/tools/opai-terminal && pip install -r requirements.txt
```

---

## Step 5: Install Caddy

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
```

---

## Step 6: Firewall (Recommended)

```bash
sudo ufw allow in on tailscale0 to any port 80
sudo ufw allow in on tailscale0 to any port 443
sudo ufw deny 8080:8888/tcp
sudo ufw enable
```

---

## Step 7: Deploy Services

```bash
# Install systemd units
./scripts/opai-control.sh install

# Start everything
./scripts/opai-control.sh start

# Check status
./scripts/opai-control.sh status
```

---

## Step 8: Verify

| Test | Expected |
|------|----------|
| `http://opai-server/` | Login page |
| Login as admin | Admin dashboard with Chat, Monitor, Tasks, Terminal |
| `http://opai-server/chat` | Chat UI (requires login) |
| `http://opai-server/monitor` | Admin-only (403 for regular users) |
| `http://opai-server/terminal` | Web bash shell (admin-only) |
| `curl http://192.168.x.x:8888` | Connection refused (behind Caddy) |

---

## Dev Mode (Bypass Auth)

Set `OPAI_AUTH_DISABLED=1` in any service's environment to bypass auth.
All requests will be treated as admin. **Never use outside dev.**

---

## Architecture

| File | Purpose |
|------|---------|
| `tools/shared/auth.py` | Shared JWT validation (imported by all Python services) |
| `tools/opai-portal/` | Login page + role router + admin dashboard |
| `tools/opai-portal/static/js/auth.js` | Shared frontend auth client (loaded by all frontends) |
| `tools/opai-terminal/` | xterm.js + PTY backend (admin-only) |
| `config/Caddyfile` | Reverse proxy config |
| `config/network.json` | Network topology reference |
| `config/supabase-migrations/` | SQL migrations for auth schema |
| `config/service-templates/` | systemd unit files for all services |

---

## User Storage (Future — Synology NAS)

Each user will get personal storage linked to their Synology NAS account:
```
/workspace/users/<user-uuid>/
    files/          # Personal files (mounted from Synology)
    agents/         # Custom agent configs
    .opai-user.json # Metadata
```

The NAS already has Tailscale installed (pending configuration). Once configured,
user sandboxes will mount directly to their Synology Drive folder for persistent
cross-device file access.
