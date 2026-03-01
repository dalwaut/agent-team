/**
 * OPAI Dev — Workspace Manager + IDE Reverse Proxy
 *
 * Manages Theia IDE containers and proxies HTTP/WebSocket traffic to them.
 *
 * Routes:
 *   /health                     Health check
 *   /dev/api/workspaces/*       Workspace CRUD (auth via Bearer token)
 *   /dev/ide/:workspaceId/*     IDE reverse proxy (auth via Bearer token + cookie for WS)
 */

require('dotenv').config();

const http = require('http');
const express = require('express');
const httpProxy = require('http-proxy');
const morgan = require('morgan');
const cookie = require('cookie');

const { requireAuth, authenticateToken, AUTH_DISABLED, DEV_USER } = require('./middleware/auth');
const healthRoutes = require('./routes/health');
const workspaceRoutes = require('./routes/workspaces');
const projectRoutes = require('./routes/projects');
const extensionRoutes = require('./routes/extensions');
const db = require('./services/supabase');
const docker = require('./services/docker-manager');
const ports = require('./services/port-allocator');
const lifecycle = require('./services/lifecycle');
const claudeBridge = require('./services/claude-bridge');

const PORT = parseInt(process.env.PORT || '8085', 10);

// ── Express App ──────────────────────────────────────────

const app = express();
app.use(morgan('short'));
app.use(express.json());

// Health (no auth)
app.use(healthRoutes);

// Workspace API
app.use('/dev/api/workspaces', workspaceRoutes);

// Project API
app.use('/dev/api/projects', projectRoutes);

// Extensions API
app.use('/dev/api/extensions', extensionRoutes);

// ── IDE HTTP Proxy ───────────────────────────────────────

const proxy = httpProxy.createProxyServer({
  ws: true,
  changeOrigin: true,
  xfwd: true,
});

proxy.on('error', (err, req, res) => {
  console.error(`[proxy] Error on ${req.method} ${req.url}: ${err.message}`);
  if (res && res.writeHead) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'IDE container unavailable' }));
  }
});

/**
 * Debounced activity tracking — max 1 DB update per workspace per minute.
 */
const activityTimers = new Map();
function trackActivity(workspaceId) {
  if (activityTimers.has(workspaceId)) return;
  activityTimers.set(workspaceId, true);
  db.updateLastActive(workspaceId).catch(() => {});
  setTimeout(() => activityTimers.delete(workspaceId), 60_000);
}

/**
 * Look up workspace and validate ownership. Returns { workspace, port } or null.
 */
async function resolveWorkspace(workspaceId, userId) {
  const ws = await db.getWorkspace(workspaceId);
  if (!ws) return null;
  if (ws.user_id !== userId && userId !== DEV_USER.id) return null;
  if (ws.status !== 'running') return null;
  if (!ws.container_port) return null;
  return { workspace: ws, port: ws.container_port };
}

// Landing page — file explorer (no server-side auth, client-side Supabase check)
app.get('/dev/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OPAI Dev — File Explorer</title>
  <script src="/auth/static/js/navbar.js" defer></script>
  <style>
    :root { --bg:#0a0a0f; --card:#12121a; --border:#2a2a3e; --text:#e0e0e8; --muted:#8888a0; --accent:#a855f7; --green:#10b981; --yellow:#f59e0b; --red:#ef4444; --hover:#1a1a2e; }
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Inter',-apple-system,sans-serif; background:var(--bg); color:var(--text); min-height:100vh; display:flex; flex-direction:column; align-items:center; padding:1.5rem; }
    h1 { font-size:1.5rem; margin-bottom:0.25rem; }
    .sub { color:var(--muted); font-size:0.85rem; margin-bottom:1.5rem; }
    .card { background:var(--card); border:1px solid var(--border); border-radius:12px; width:100%; max-width:800px; overflow:hidden; }

    /* Toolbar */
    .toolbar { display:flex; align-items:center; gap:0.5rem; padding:0.75rem 1rem; border-bottom:1px solid var(--border); flex-wrap:wrap; }
    .toolbar .btn-open { margin-left:auto; }

    /* Breadcrumbs */
    .breadcrumbs { display:flex; align-items:center; gap:0.25rem; flex:1; min-width:0; overflow-x:auto; white-space:nowrap; }
    .breadcrumbs a, .breadcrumbs span { font-size:0.85rem; padding:0.2rem 0.4rem; border-radius:4px; }
    .breadcrumbs a { color:var(--accent); text-decoration:none; cursor:pointer; }
    .breadcrumbs a:hover { background:var(--hover); }
    .breadcrumbs .sep { color:var(--muted); font-size:0.7rem; }
    .breadcrumbs .current { color:var(--text); font-weight:600; }

    /* File list */
    .file-list { max-height:60vh; overflow-y:auto; }
    .file-row { display:flex; align-items:center; padding:0.6rem 1rem; border-bottom:1px solid var(--border); cursor:default; transition:background 0.1s; }
    .file-row:last-child { border-bottom:none; }
    .file-row:hover { background:var(--hover); }
    .file-row.is-dir { cursor:pointer; }
    .file-icon { width:1.5rem; text-align:center; margin-right:0.75rem; font-size:1rem; flex-shrink:0; }
    .file-name { flex:1; font-size:0.85rem; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .file-meta { color:var(--muted); font-size:0.75rem; margin-left:1rem; white-space:nowrap; }
    .empty { text-align:center; color:var(--muted); padding:2.5rem 1rem; }

    /* Workspace status bar */
    .status-bar { display:flex; align-items:center; gap:0.75rem; padding:0.6rem 1rem; border-top:1px solid var(--border); background:#0e0e16; font-size:0.8rem; }
    .status-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
    .status-dot.running { background:var(--green); }
    .status-dot.stopped { background:var(--yellow); }
    .status-dot.none { background:var(--muted); }
    .status-text { color:var(--muted); flex:1; }

    /* Buttons */
    .btn { display:inline-flex; align-items:center; gap:0.35rem; background:var(--accent); color:#fff; text-decoration:none; padding:0.4rem 0.9rem; border-radius:6px; font-weight:600; font-size:0.8rem; border:none; cursor:pointer; }
    .btn:hover { opacity:0.9; }
    .btn-sm { padding:0.3rem 0.7rem; font-size:0.75rem; }
    .btn-muted { background:#333; color:var(--muted); }
    .btn-danger { background:var(--red); }
    .btn-green { background:var(--green); }
    .btn:disabled { opacity:0.5; cursor:not-allowed; }

    /* New folder form */
    .new-form { display:flex; gap:0.5rem; padding:0.75rem 1rem; border-top:1px solid var(--border); }
    .new-form input { flex:1; background:#1a1a2a; border:1px solid var(--border); border-radius:6px; padding:0.4rem 0.6rem; color:var(--text); font-size:0.8rem; outline:none; }
    .new-form input:focus { border-color:var(--accent); }

    a.back-link { color:var(--accent); text-decoration:none; margin-top:1rem; font-size:0.85rem; }
    .loading { color:var(--muted); text-align:center; padding:3rem 1rem; }

    /* Extensions panel */
    .ext-panel { width:100%; max-width:800px; margin-top:1rem; }
    .ext-header { display:flex; align-items:center; gap:0.5rem; cursor:pointer; padding:0.5rem 0; }
    .ext-header h2 { font-size:1rem; margin:0; }
    .ext-toggle { color:var(--muted); font-size:0.8rem; transition:transform 0.2s; }
    .ext-toggle.open { transform:rotate(90deg); }
    .ext-count { color:var(--muted); font-size:0.8rem; margin-left:auto; }
    .ext-list { max-height:50vh; overflow-y:auto; }
    .ext-row { display:flex; align-items:center; gap:0.75rem; padding:0.6rem 1rem; border-bottom:1px solid var(--border); }
    .ext-row:last-child { border-bottom:none; }
    .ext-info { flex:1; min-width:0; }
    .ext-name { font-size:0.85rem; font-weight:600; }
    .ext-pub { color:var(--muted); font-size:0.75rem; margin-left:0.5rem; font-weight:normal; }
    .ext-desc { color:var(--muted); font-size:0.75rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .ext-size { color:var(--muted); font-size:0.7rem; white-space:nowrap; }
    .ext-btn { padding:0.25rem 0.6rem; border-radius:4px; border:1px solid var(--border); background:transparent; color:var(--text); font-size:0.75rem; cursor:pointer; min-width:60px; }
    .ext-btn:hover { background:var(--hover); }
    .ext-btn.enabled { background:var(--accent); border-color:var(--accent); color:#fff; }
    .ext-missing { color:var(--yellow); font-size:0.7rem; }
    .ext-restart { display:none; padding:0.5rem 1rem; background:#1a1a0a; border-top:1px solid var(--yellow); font-size:0.8rem; color:var(--yellow); text-align:center; }
  </style>
</head>
<body>
  <h1>Dev IDE</h1>
  <p class="sub">Browse your projects and open the IDE at any folder</p>
  <div class="card">
    <div class="toolbar">
      <div class="breadcrumbs" id="breadcrumbs"></div>
      <button class="btn btn-open" id="btn-open" onclick="openHere()" disabled>Open IDE Here</button>
    </div>
    <div class="file-list" id="file-list">
      <div class="loading">Loading...</div>
    </div>
    <div id="status-bar"></div>
    <div class="new-form" id="new-form" style="display:none;">
      <input type="text" id="new-name" placeholder="new-folder-name" maxlength="64" />
      <button class="btn btn-sm" onclick="createFolder()">+ New Folder</button>
    </div>
  </div>
  <div class="ext-panel" id="ext-panel" style="display:none;">
    <div class="ext-header" onclick="toggleExtPanel()">
      <span class="ext-toggle" id="ext-toggle">&#9654;</span>
      <h2>Extensions</h2>
      <span class="ext-count" id="ext-count"></span>
    </div>
    <div class="card" id="ext-card" style="display:none;">
      <div class="ext-restart" id="ext-restart">Extensions changed. Restart your IDE for changes to take effect.</div>
      <div class="ext-list" id="ext-list"></div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
  <script>
    let _token = '';
    let _currentPath = '';
    let _wsMap = {};
    let _activeWs = null;
    let _isAdmin = false;
    const H = () => ({ 'Content-Type':'application/json', 'Authorization':'Bearer '+_token });

    function setAuthCookie(token) {
      document.cookie = 'opai_dev_token=' + encodeURIComponent(token) + ';path=/dev/;max-age=86400;SameSite=Strict';
    }

    function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    function formatSize(bytes) {
      if (bytes == null) return '';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
      if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
      return (bytes / 1073741824).toFixed(1) + ' GB';
    }

    function formatDate(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      const now = new Date();
      const diff = now - d;
      if (diff < 60000) return 'just now';
      if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
      if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
      if (diff < 2592000000) return Math.floor(diff / 86400000) + 'd ago';
      return d.toLocaleDateString();
    }

    (async () => {
      const cfgResp = await fetch('/auth/config');
      const cfg = await cfgResp.json();
      if (!cfg.supabase_url || !cfg.supabase_anon_key) {
        document.getElementById('file-list').innerHTML = '<div class="loading">Auth not configured</div>';
        return;
      }
      const sb = window.supabase.createClient(cfg.supabase_url, cfg.supabase_anon_key);
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { window.location.href = '/auth/login'; return; }
      // Check app access (non-admins only)
      if (session.user?.app_metadata?.role !== 'admin') {
        try {
          const ar = await fetch('/api/me/apps', { headers: { 'Authorization': 'Bearer ' + session.access_token } });
          if (ar.ok) { const ad = await ar.json(); if (!(ad.allowed_apps || []).includes('dev')) { window.location.href = '/'; return; } }
        } catch (e) { /* allow on failure */ }
      }
      _token = session.access_token;
      setAuthCookie(_token);
      try { _isAdmin = (session.user?.app_metadata?.role === 'admin'); } catch {}
      sb.auth.onAuthStateChange((_ev, sess) => { if (sess) { _token = sess.access_token; setAuthCookie(_token); } });

      await loadWorkspaces();

      // If redirected here from IDE with expired token, auto-redirect back
      const returnTo = new URLSearchParams(window.location.search).get('return');
      if (returnTo && _activeWs && _activeWs.ide_url) {
        setAuthCookie(_token);
        window.location.href = _activeWs.ide_url;
        return;
      }

      await browse('');
      loadExtensions();
    })();

    async function loadWorkspaces() {
      try {
        const resp = await fetch('/dev/api/workspaces', { headers: H() });
        if (!resp.ok) return;
        const workspaces = await resp.json();
        _wsMap = {};
        _activeWs = null;
        for (const ws of workspaces) {
          if (ws.project_name && ['running','creating','stopped'].includes(ws.status)) {
            _wsMap[ws.project_name] = ws;
            if (ws.status === 'running' || ws.status === 'creating') _activeWs = ws;
          }
        }
      } catch {}
    }

    function renderBreadcrumbs(browsePath) {
      const bc = document.getElementById('breadcrumbs');
      const parts = browsePath ? browsePath.split('/') : [];
      let html = '<a onclick="browse(\\'\\')">Projects</a>';
      let accum = '';
      for (let i = 0; i < parts.length; i++) {
        accum += (accum ? '/' : '') + parts[i];
        html += '<span class="sep">/</span>';
        if (i === parts.length - 1) {
          html += '<span class="current">' + esc(parts[i]) + '</span>';
        } else {
          const p = accum;
          html += '<a onclick="browse(\\'' + p.replace(/'/g, "\\\\'") + '\\')">' + esc(parts[i]) + '</a>';
        }
      }
      bc.innerHTML = html;
    }

    function renderStatusBar() {
      const bar = document.getElementById('status-bar');
      if (_activeWs) {
        const dotClass = _activeWs.status === 'running' ? 'running' : 'stopped';
        const destroyBtn = _isAdmin
          ? '<button class="btn btn-sm btn-danger" onclick="destroyIDE(\\'' + _activeWs.id + '\\')" title="Destroy container entirely">Destroy</button>'
          : '';
        bar.innerHTML = '<div class="status-bar">'
          + '<span class="status-dot ' + dotClass + '"></span>'
          + '<span class="status-text">IDE active: <strong>' + esc(_activeWs.project_name || 'Projects') + '</strong></span>'
          + '<a href="' + _activeWs.ide_url + '" class="btn btn-sm btn-green">Go to IDE</a>'
          + '<button class="btn btn-sm btn-muted" onclick="stopIDE(\\'' + _activeWs.id + '\\')">Stop</button>'
          + destroyBtn
          + '</div>';
      } else {
        bar.innerHTML = '<div class="status-bar"><span class="status-dot none"></span><span class="status-text">No IDE running</span></div>';
      }
    }

    async function browse(browsePath) {
      _currentPath = browsePath;
      const list = document.getElementById('file-list');
      list.innerHTML = '<div class="loading">Loading...</div>';

      renderBreadcrumbs(browsePath);
      renderStatusBar();

      // Enable/disable Open button
      document.getElementById('btn-open').disabled = false;
      document.getElementById('new-form').style.display = '';

      try {
        const resp = await fetch('/dev/api/projects/browse?path=' + encodeURIComponent(browsePath), { headers: H() });
        if (!resp.ok) throw new Error('Failed to browse');
        const { entries } = await resp.json();

        if (entries.length === 0) {
          list.innerHTML = '<div class="empty">Empty folder</div>';
          return;
        }

        let html = '';
        for (const e of entries) {
          const icon = e.type === 'dir' ? '\u{1F4C1}' : '\u{1F4C4}';
          const childPath = browsePath ? browsePath + '/' + e.name : e.name;
          const clickAttr = e.type === 'dir' ? ' onclick="browse(\\'' + childPath.replace(/'/g, "\\\\'") + '\\')"' : '';
          const dirClass = e.type === 'dir' ? ' is-dir' : '';
          const meta = e.type === 'file'
            ? '<span class="file-meta">' + esc(formatSize(e.size)) + '</span><span class="file-meta">' + esc(formatDate(e.modified)) + '</span>'
            : '<span class="file-meta">' + esc(formatDate(e.modified)) + '</span>';

          html += '<div class="file-row' + dirClass + '"' + clickAttr + '>'
            + '<span class="file-icon">' + icon + '</span>'
            + '<span class="file-name">' + esc(e.name) + '</span>'
            + meta
            + '</div>';
        }
        list.innerHTML = html;
      } catch (err) {
        list.innerHTML = '<div class="loading">Error: ' + esc(err.message) + '</div>';
      }
    }

    async function openHere() {
      const btn = document.getElementById('btn-open');
      btn.disabled = true;
      btn.textContent = 'Starting...';

      try {
        const body = _currentPath
          ? { project_path: _currentPath }
          : { project_path: '.' };

        const resp = await fetch('/dev/api/workspaces', { method:'POST', headers:H(), body:JSON.stringify(body) });
        const data = await resp.json();

        if (data.ide_url) {
          window.location.href = data.ide_url;
        } else if (data.workspace && data.workspace.ide_url) {
          window.location.href = data.workspace.ide_url;
        } else {
          alert(data.error || 'Failed to start workspace');
          await loadWorkspaces();
          btn.disabled = false;
          btn.textContent = 'Open IDE Here';
        }
      } catch (err) {
        alert('Error: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Open IDE Here';
      }
    }

    async function createFolder() {
      const input = document.getElementById('new-name');
      const name = input.value.trim();
      if (!name) return;
      const fullPath = _currentPath ? _currentPath + '/' + name : name;

      try {
        const resp = await fetch('/dev/api/projects/mkdir', {
          method:'POST', headers:H(), body:JSON.stringify({ path: fullPath })
        });
        const data = await resp.json();
        if (resp.ok) {
          input.value = '';
          await browse(_currentPath);
        } else {
          alert(data.error || 'Failed to create folder');
        }
      } catch (err) { alert('Error: ' + err.message); }
    }

    async function stopIDE(wsId) {
      if (!confirm('Stop the running IDE?')) return;
      try {
        const resp = await fetch('/dev/api/workspaces/' + wsId, { method:'DELETE', headers:H() });
        await resp.json();
        await loadWorkspaces();
        renderStatusBar();
      } catch (err) { alert('Error: ' + err.message); }
    }

    async function destroyIDE(wsId) {
      if (!confirm('Destroy this container entirely? This removes the container and frees the port.')) return;
      try {
        const resp = await fetch('/dev/api/workspaces/' + wsId + '?action=destroy', { method:'DELETE', headers:H() });
        await resp.json();
        await loadWorkspaces();
        renderStatusBar();
      } catch (err) { alert('Error: ' + err.message); }
    }

    document.getElementById('new-name')?.addEventListener('keydown', e => { if (e.key === 'Enter') createFolder(); });

    // ── Extensions Panel ─────────────────────────
    let _extOpen = false;
    let _extChanged = false;
    let _extData = [];

    async function loadExtensions() {
      try {
        const resp = await fetch('/dev/api/extensions/available', { headers: H() });
        if (!resp.ok) return;
        _extData = await resp.json();
        const enabledCount = _extData.filter(e => e.enabled).length;
        document.getElementById('ext-count').textContent = enabledCount + ' of ' + _extData.length + ' enabled';
        document.getElementById('ext-panel').style.display = '';
        if (_extOpen) renderExtensions();
      } catch {}
    }

    function toggleExtPanel() {
      _extOpen = !_extOpen;
      document.getElementById('ext-card').style.display = _extOpen ? '' : 'none';
      document.getElementById('ext-toggle').classList.toggle('open', _extOpen);
      if (_extOpen && _extData.length > 0) renderExtensions();
      else if (_extOpen) loadExtensions();
    }

    function renderExtensions() {
      const list = document.getElementById('ext-list');
      if (_extData.length === 0) {
        list.innerHTML = '<div class="empty">No extensions available</div>';
        return;
      }
      let html = '';
      for (const ext of _extData) {
        const btnClass = ext.enabled ? 'ext-btn enabled' : 'ext-btn';
        const btnText = ext.enabled ? 'Enabled' : 'Enable';
        const missing = !ext.vsix_exists ? '<span class="ext-missing"> (not downloaded)</span>' : '';
        html += '<div class="ext-row">'
          + '<div class="ext-info">'
          + '<div><span class="ext-name">' + esc(ext.name) + '</span><span class="ext-pub">' + esc(ext.publisher) + '</span>' + missing + '</div>'
          + '<div class="ext-desc">' + esc(ext.description) + '</div>'
          + '</div>'
          + '<span class="ext-size">' + formatSize(ext.size_bytes) + '</span>'
          + '<button class="' + btnClass + '" onclick="toggleExt(\\'' + ext.id + '\\', ' + (ext.enabled ? 'false' : 'true') + ')">' + btnText + '</button>'
          + '</div>';
      }
      list.innerHTML = html;
    }

    async function toggleExt(extId, enable) {
      const endpoint = enable ? '/dev/api/extensions/enable' : '/dev/api/extensions/disable';
      try {
        const resp = await fetch(endpoint, {
          method: 'POST', headers: H(), body: JSON.stringify({ extension_id: extId })
        });
        if (resp.ok) {
          _extChanged = true;
          document.getElementById('ext-restart').style.display = _activeWs ? '' : 'none';
          await loadExtensions();
        } else {
          const data = await resp.json();
          alert(data.error || 'Failed to toggle extension');
        }
      } catch (err) { alert('Error: ' + err.message); }
    }
  </script>
</body>
</html>`);
});

app.get('/dev', (req, res) => res.redirect(301, '/dev/'));

// IDE proxy route — serves the Theia UI
// Custom auth: cookie-based with redirect to /dev/ on expiry instead of JSON 401
app.use('/dev/ide/:workspaceId', async (req, res) => {
  const { workspaceId } = req.params;

  // --- Auth: extract token from header or cookie ---
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const [scheme, t] = authHeader.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && t) token = t;
  }
  if (!token && req.headers.cookie) {
    const match = req.headers.cookie.match(/(?:^|;\s*)opai_dev_token=([^;]+)/);
    if (match) token = decodeURIComponent(match[1]);
  }

  if (AUTH_DISABLED) {
    req.user = DEV_USER;
  } else if (!token) {
    const accept = req.headers.accept || '';
    if (accept.includes('text/html')) return res.redirect('/dev/?return=1');
    return res.status(401).json({ error: 'Authorization required' });
  } else {
    try {
      const { decodeToken } = require('./middleware/auth');
      req.user = await decodeToken(token);
    } catch {
      const accept = req.headers.accept || '';
      if (accept.includes('text/html')) return res.redirect('/dev/?return=1');
      return res.status(401).json({ error: 'Token expired' });
    }
  }

  // --- Resolve workspace ---
  const result = await resolveWorkspace(workspaceId, req.user.id);
  if (!result) {
    // Workspace not running — redirect HTML requests back to file explorer
    const accept = req.headers.accept || '';
    if (accept.includes('text/html')) return res.redirect('/dev/');
    return res.status(404).json({ error: 'Workspace not found or not running' });
  }

  // Wait for container HTTP server to be ready (Theia needs ~2s to boot)
  const portReady = await new Promise(resolve => {
    let attempts = 0;
    const check = () => {
      attempts++;
      const hreq = http.get(`http://127.0.0.1:${result.port}/`, (hres) => {
        hres.resume(); // drain response
        resolve(true);
      });
      hreq.setTimeout(1000);
      hreq.on('error', () => { if (attempts < 10) setTimeout(check, 500); else resolve(false); });
      hreq.on('timeout', () => { hreq.destroy(); if (attempts < 10) setTimeout(check, 500); else resolve(false); });
    };
    check();
  });

  if (!portReady) {
    return res.status(503).json({ error: 'IDE container is starting, please refresh in a moment' });
  }

  // Track activity
  trackActivity(workspaceId);

  // Strip /dev/ide/:workspaceId prefix before proxying
  const originalUrl = req.originalUrl;
  const prefixLen = `/dev/ide/${workspaceId}`.length;
  req.url = originalUrl.substring(prefixLen) || '/';

  proxy.web(req, res, { target: `http://127.0.0.1:${result.port}` });
});

// ── HTTP Server + WebSocket Upgrade ──────────────────────

const server = http.createServer(app);

server.on('upgrade', async (req, socket, head) => {
  // Parse workspace ID from URL: /dev/ide/:workspaceId/...
  const match = req.url.match(/^\/dev\/ide\/([a-f0-9-]+)(\/.*)?$/);
  if (!match) {
    socket.destroy();
    return;
  }

  const workspaceId = match[1];

  let userId;

  if (AUTH_DISABLED) {
    userId = DEV_USER.id;
  } else {
    // Authenticate via JWT from opai_dev_token cookie (set by landing page)
    const cookies = cookie.parse(req.headers.cookie || '');
    const token = cookies.opai_dev_token;
    if (!token) {
      console.log('[ws] No opai_dev_token cookie for upgrade');
      socket.destroy();
      return;
    }

    try {
      const { decodeToken } = require('./middleware/auth');
      const user = await decodeToken(token);
      userId = user.id;
    } catch (err) {
      console.log('[ws] Token decode failed:', err.message);
      socket.destroy();
      return;
    }
  }

  const result = await resolveWorkspace(workspaceId, userId);
  if (!result) {
    socket.destroy();
    return;
  }

  trackActivity(workspaceId);

  // Strip prefix before proxying WebSocket
  const prefixLen = `/dev/ide/${workspaceId}`.length;
  req.url = req.url.substring(prefixLen) || '/';

  console.log(`[ws] Proxying upgrade: ${req.url} → 127.0.0.1:${result.port}`);

  proxy.ws(req, socket, head, { target: `http://127.0.0.1:${result.port}` });

  socket.on('close', () => console.log(`[ws] Socket closed for workspace ${workspaceId.substring(0, 8)}`));
  socket.on('error', (err) => console.error(`[ws] Socket error for workspace ${workspaceId.substring(0, 8)}:`, err.message));
});

// ── Startup ──────────────────────────────────────────────

async function startup() {
  console.log('[opai-dev] Starting workspace manager...');

  // Ensure Docker network exists
  try {
    await docker.ensureNetwork();
  } catch (err) {
    console.error('[opai-dev] Warning: Could not ensure Docker network:', err.message);
  }

  // Rebuild port allocator from DB
  try {
    const active = await db.getActiveWorkspaces();
    ports.rebuildFromRecords(active);
    console.log(`[opai-dev] Rebuilt port allocator: ${active.length} active workspace(s)`);
  } catch (err) {
    console.error('[opai-dev] Warning: Could not rebuild ports from DB:', err.message);
  }

  // Start lifecycle manager
  lifecycle.start();

  // Start Claude Code bridge (WebSocket server for AI integration)
  try {
    claudeBridge.start();
  } catch (err) {
    console.error('[opai-dev] Warning: Claude bridge failed to start:', err.message);
  }

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[opai-dev] Listening on 127.0.0.1:${PORT}`);
    console.log(`[opai-dev] API: /dev/api/workspaces`);
    console.log(`[opai-dev] IDE: /dev/ide/:workspaceId/`);
  });
}

startup().catch(err => {
  console.error('[opai-dev] Fatal startup error:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[opai-dev] SIGTERM received, shutting down...');
  lifecycle.stop();
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('[opai-dev] SIGINT received, shutting down...');
  lifecycle.stop();
  server.close(() => process.exit(0));
});
