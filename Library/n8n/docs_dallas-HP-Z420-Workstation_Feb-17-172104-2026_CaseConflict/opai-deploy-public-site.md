# OPAI Deploy Public Site — n8n Workflow

## Purpose

Deploys HTML page updates to `opai.boutabyte.com` via an n8n webhook on the BB VPS. The OPAI Pages Manager POSTs file content to this webhook, and n8n writes it to `/var/www/opai-landing/` on the VPS host filesystem.

This eliminates the need for SSH keys between OPAI Server and BB VPS.

## Architecture

```
OPAI Server (Pages Manager)
    │
    │  POST /webhook/opai-deploy
    │  { "filename": "index.html", "content": "<html>..." }
    │
    ▼
n8n on BB VPS (https://n8n.boutabyte.com)
    │
    │  Code node writes file
    │
    ▼
/var/www/opai-landing/index.html
    │
    │  Served by Caddy
    │
    ▼
https://opai.boutabyte.com
```

## Workflow File

**Location**: `Library/n8n/Workflows/OPAI_Deploy_Public_Site.json`

## Setup Instructions

### 1. Import the workflow into n8n

1. Open https://n8n.boutabyte.com
2. Go to **Workflows** > **Import from file**
3. Select `OPAI_Deploy_Public_Site.json`
4. The workflow will appear as "OPAI Deploy Public Site"

### 2. Mount the host filesystem volume

The n8n Docker container needs access to `/var/www/opai-landing/` on the host. In Coolify:

1. Go to the n8n service configuration
2. Under **Volumes** or **Persistent Storage**, add:
   ```
   /var/www/opai-landing:/var/www/opai-landing
   ```
3. Redeploy the n8n container

**Alternative**: If Coolify doesn't support custom volume mounts, SSH into the VPS and edit the Docker Compose file directly:
```bash
ssh dallas@bb-vps
# Find the n8n compose file (usually in /data/coolify/services/...)
# Add the volume mount under the n8n service:
#   volumes:
#     - /var/www/opai-landing:/var/www/opai-landing
docker compose up -d
```

### 3. Activate the workflow

1. In n8n, open "OPAI Deploy Public Site"
2. Toggle it to **Active**
3. Note the production webhook URL — it will be:
   ```
   https://n8n.boutabyte.com/webhook/opai-deploy
   ```

### 4. Configure the OPAI Portal

Update the deploy endpoint in `tools/opai-portal/app.py` to POST to the n8n webhook instead of using SCP:

```python
N8N_DEPLOY_WEBHOOK = "https://n8n.boutabyte.com/webhook/opai-deploy"

@app.post("/api/archive/deploy")
async def archive_deploy(request: Request):
    import httpx
    body = await request.json()
    page = body.get("page", "landing")
    info = _page_info(page)
    if not info:
        return JSONResponse({"error": "Unknown page"}, status_code=400)

    src = info["dir"] / info["file"]
    if not src.exists():
        return JSONResponse({"error": f"Source file not found: {info['file']}"}, status_code=404)

    content = src.read_text()
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(N8N_DEPLOY_WEBHOOK, json={
            "filename": info["file"],
            "content": content,
        })
    if resp.status_code != 200:
        return JSONResponse({"error": f"Deploy failed: {resp.text}"}, status_code=500)
    return resp.json()
```

### 5. Test

```bash
# From OPAI server, test the webhook directly:
curl -X POST https://n8n.boutabyte.com/webhook/opai-deploy \
  -H "Content-Type: application/json" \
  -d '{"filename": "index.html", "content": "<html><body>Test</body></html>"}'
```

Expected response:
```json
{
  "success": true,
  "filename": "index.html",
  "size_bytes": 42,
  "deployed_at": "2026-02-17T12:00:00.000Z"
}
```

## Workflow Details

### Nodes

| Node | Type | Purpose |
|------|------|---------|
| Webhook Trigger | Webhook | Accepts POST with `{filename, content}` |
| Validate Input | IF | Checks filename and content are present |
| Write File to Disk | Code | Writes content to `/var/www/opai-landing/`, auto-backs up previous version |
| Success Response | Respond to Webhook | Returns success JSON |
| Validation Error | Respond to Webhook | Returns 400 for missing fields |

### Security

- **Allowed filenames**: Only `index.html` and `welcome.html` are accepted (hardcoded allowlist in the Code node)
- **Auto-backup**: Before overwriting, the current file is copied to `/var/www/opai-landing/backups/` with a timestamp
- **No auth**: The webhook has no authentication. If security is needed, add an API key check in the Validate Input node or use n8n's built-in webhook auth

### Adding Authentication (Recommended)

To add API key auth to the webhook:

1. In the Webhook Trigger node, enable **Header Auth**
2. Set the header name to `X-Deploy-Key`
3. Set the expected value to a random secret
4. Update the OPAI Portal deploy endpoint to include the header:
   ```python
   headers={"X-Deploy-Key": "your-secret-here"}
   ```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "ENOENT: no such file or directory" | Volume mount missing — add `/var/www/opai-landing:/var/www/opai-landing` to Docker |
| "EACCES: permission denied" | Fix ownership: `chown -R 1000:1000 /var/www/opai-landing` on VPS host |
| Webhook returns 404 | Workflow not active — toggle it on in n8n |
| Content not updating on site | Caddy cache — try `curl -I https://opai.boutabyte.com` to check headers |
