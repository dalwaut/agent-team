/**
 * OPAI Shared Navigation Bar — self-injecting module.
 * Add <script src="/auth/static/js/navbar.js" defer></script> to any tool page.
 */
(function () {
  'use strict';

  // ── Tool registry ──────────────────────────────────────
  const TOOLS = {
    chat:      { abbr: 'CH', color: '#a855f7', label: 'Chat',      path: '/chat/' },
    monitor:   { abbr: 'MN', color: '#3b82f6', label: 'Monitor',   path: '/tasks/#health' },
    tasks:     { abbr: 'TK', color: '#f59e0b', label: 'Tasks',     path: '/tasks/' },
    terminal:  { abbr: 'TM', color: '#f59e0b', label: 'Terminal',  path: '/terminal/' },
    claude:    { abbr: 'CL', color: '#6366f1', label: 'Claude',    path: '/terminal/claude' },
    messenger: { abbr: 'MS', color: '#10b981', label: 'Messenger', path: '/messenger/' },
    users:     { abbr: 'US', color: '#ec4899', label: 'Users',     path: '/users/' },
    dev:       { abbr: 'OP', color: '#06b6d4', label: 'OP IDE',    path: '/dev/' },
    files:     { abbr: 'FL', color: '#8b5cf6', label: 'Files',     path: '/files/' },
    forum:     { abbr: 'FM', color: '#f97316', label: 'Forum',     path: '/forum/' },
    docs:      { abbr: 'DC', color: '#22d3ee', label: 'Docs',      path: '/docs/' },
    agents:    { abbr: 'AS', color: '#f43f5e', label: 'Agents',    path: '/agents/' },
    'team-hub':{ abbr: 'TH', color: '#6c5ce7', label: 'Team Hub', path: '/team-hub/' },
    billing:   { abbr: 'BL', color: '#22c55e', label: 'Billing',  path: '/billing/' },
    wordpress:     { abbr: 'WP', color: '#0073aa', label: 'WordPress',  path: '/wordpress/' },
    'bot-space':   { abbr: 'BS', color: '#f59e0b', label: 'Bot Space',  path: '/bot-space/' },
    orchestra:     { abbr: 'OR', color: '#d4a017', label: 'Orchestra',  path: '/orchestra/' },
    prd:           { abbr: 'PR', color: '#14b8a6', label: 'PRD',        path: '/prd/' },
    forumbot:      { abbr: 'FB', color: '#8b5cf6', label: 'Forum Bot',  path: '/forumbot/' },
    'email-agent': { abbr: 'EA', color: '#0984e3', label: 'Email Agent',path: '/email-agent/' },
    brain:         { abbr: 'BR', color: '#8b5cf6', label: '2nd Brain',  path: '/brain/' },
    bx4:           { abbr: 'B4', color: '#10b981', label: 'Bx4',        path: '/bx4/' },
    helm:          { abbr: 'HL', color: '#e11d48', label: 'HELM',       path: '/helm/' },
    marq:          { abbr: 'MQ', color: '#7c3aed', label: 'Marq',       path: '/marq/' },
    dam:           { abbr: 'DM', color: '#f59e0b', label: 'DAM Bot',   path: '/dam/' },
    vault:         { abbr: 'VT', color: '#22c55e', label: 'Vault',     path: '/vault/' },
    studio:        { abbr: 'ST', color: '#ec4899', label: 'Studio',   path: '/studio/' },
    'eliza-hub':   { abbr: 'EH', color: '#00d4aa', label: 'Eliza Hub', path: '/eliza-hub/' },
  };

  const MAX_RECENT = 4;
  const LS_KEY = 'opai_recent_tools';
  const SS_KEY = 'opai_allowed_apps';
  const SS_TTL = 5 * 60 * 1000; // 5 min

  // Full-height tools that need flex layout adjustment
  const FULL_HEIGHT_TOOLS = ['terminal', 'claude', 'chat', 'bx4', 'brain', 'bot-space', 'orchestra', 'helm', 'marq', 'dam', 'engine', 'files', 'vault', 'studio', 'eliza-hub'];

  // ── Detect current tool from URL ───────────────────────
  function detectCurrentTool() {
    const p = window.location.pathname;
    if (p.startsWith('/terminal/claude')) return 'claude';
    for (const [key, tool] of Object.entries(TOOLS)) {
      if (key === 'claude') continue; // handled above
      if (p.startsWith(tool.path) || p === tool.path.replace(/\/$/, '')) return key;
    }
    return null;
  }

  // ── Recent tools (localStorage) ────────────────────────
  function getRecent() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; }
    catch { return []; }
  }

  function updateRecent(current) {
    let recent = getRecent().filter(t => t !== current);
    if (current) recent.unshift(current);
    recent = recent.slice(0, MAX_RECENT);
    try { localStorage.setItem(LS_KEY, JSON.stringify(recent)); } catch {}
    return recent;
  }

  // ── Permissions ────────────────────────────────────────
  async function getAllowedApps() {
    // Check sessionStorage cache
    try {
      const cached = JSON.parse(sessionStorage.getItem(SS_KEY));
      if (cached && Date.now() - cached.ts < SS_TTL) return cached.apps;
    } catch {}

    // Try to get session from existing Supabase client or init one
    let session = null;
    try {
      // auth-v3.js exposes window.opaiAuth
      if (window.opaiAuth) {
        const s = await window.opaiAuth.getSession();
        session = s;
      }
    } catch {}

    if (!session) return null; // no session = can't check, show all

    const role = session.user?.app_metadata?.role;
    if (role === 'admin') return null; // null = show all

    // Fetch allowed apps
    try {
      const resp = await fetch('/api/me/apps', {
        headers: { 'Authorization': 'Bearer ' + session.access_token },
      });
      if (resp.ok) {
        const data = await resp.json();
        const apps = data.allowed_apps || [];
        try {
          sessionStorage.setItem(SS_KEY, JSON.stringify({ apps, ts: Date.now() }));
        } catch {}
        return apps;
      }
    } catch {}
    return null; // on error, show all
  }

  // ── Inject CSS ─────────────────────────────────────────
  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .opai-navbar {
        position: sticky; top: 0; z-index: 99999;
        height: 44px; display: flex; align-items: center;
        padding: 0 12px; gap: 8px;
        background: rgba(10,10,15,0.92);
        backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
        border-bottom: 1px solid rgba(255,255,255,0.06);
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        box-sizing: border-box;
        flex-shrink: 0;
      }
      .opai-navbar * { box-sizing: border-box; }
      .opai-navbar-back {
        display: flex; align-items: center; justify-content: center;
        width: 32px; height: 32px; border-radius: 8px;
        color: #a0a0b8; text-decoration: none;
        transition: background 0.15s, color 0.15s;
      }
      .opai-navbar-back:hover { background: rgba(255,255,255,0.08); color: #e0e0e8; }
      .opai-navbar-back svg { width: 18px; height: 18px; }
      .opai-navbar-divider {
        width: 1px; height: 20px; background: rgba(255,255,255,0.1);
        margin: 0 4px;
      }
      .opai-navbar-tools { display: flex; align-items: center; gap: 6px; }
      .opai-navbar-icon {
        display: flex; align-items: center; justify-content: center;
        width: 28px; height: 28px; border-radius: 50%;
        font-size: 10px; font-weight: 700; letter-spacing: 0.5px;
        text-decoration: none; color: #fff;
        transition: transform 0.15s, filter 0.15s;
        position: relative;
      }
      .opai-navbar-icon:hover { transform: scale(1.12); filter: brightness(1.2); }
      .opai-navbar-icon.active {
        box-shadow: 0 0 0 2px rgba(255,255,255,0.15), 0 0 8px var(--glow);
      }
      .opai-navbar-spacer { flex: 1; }
      .opai-navbar-feedback {
        display: flex; align-items: center; justify-content: center;
        width: 32px; height: 32px; border-radius: 8px;
        color: #a0a0b8; background: none; border: none; cursor: pointer;
        transition: background 0.15s, color 0.15s;
        padding: 0;
      }
      .opai-navbar-feedback:hover { background: rgba(255,255,255,0.08); color: #e0e0e8; }
      .opai-navbar-feedback svg { width: 18px; height: 18px; }
      .opai-fb-overlay {
        position: fixed; inset: 0; z-index: 100000;
        background: rgba(0,0,0,0.6); backdrop-filter: blur(4px);
        display: flex; align-items: center; justify-content: center;
        opacity: 0; transition: opacity 0.2s;
      }
      .opai-fb-overlay.open { opacity: 1; }
      .opai-fb-modal {
        background: #1a1a2e; border: 1px solid rgba(255,255,255,0.1);
        border-radius: 12px; padding: 24px; width: 400px; max-width: 90vw;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        color: #e0e0e8;
      }
      .opai-fb-modal h3 { margin: 0 0 4px; font-size: 16px; font-weight: 600; }
      .opai-fb-modal .opai-fb-tool { color: #a0a0b8; font-size: 12px; margin-bottom: 16px; }
      .opai-fb-modal textarea {
        width: 100%; height: 100px; background: #0a0a0f; border: 1px solid rgba(255,255,255,0.1);
        border-radius: 8px; color: #e0e0e8; padding: 10px; font-size: 14px;
        font-family: inherit; resize: vertical; outline: none;
        box-sizing: border-box;
      }
      .opai-fb-modal textarea:focus { border-color: rgba(168,85,247,0.5); }
      .opai-fb-modal textarea::placeholder { color: #555; }
      .opai-fb-attach-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
      .opai-fb-attach-btn {
        display: flex; align-items: center; gap: 4px; padding: 4px 10px; border-radius: 6px;
        background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
        color: #a0a0b8; font-size: 12px; cursor: pointer; font-family: inherit;
      }
      .opai-fb-attach-btn:hover { background: rgba(255,255,255,0.1); color: #e0e0e8; }
      .opai-fb-attach-hint { font-size: 11px; color: #555; }
      .opai-fb-previews { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
      .opai-fb-preview-item {
        position: relative; width: 64px; height: 64px; border-radius: 6px; overflow: hidden;
        border: 1px solid rgba(255,255,255,0.1);
      }
      .opai-fb-preview-item img { width: 100%; height: 100%; object-fit: cover; }
      .opai-fb-preview-remove {
        position: absolute; top: 0; right: 0; background: rgba(0,0,0,0.7); color: #fff;
        border: none; cursor: pointer; font-size: 14px; line-height: 1; padding: 2px 5px;
        border-radius: 0 0 0 4px;
      }
      .opai-fb-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
      .opai-fb-actions button {
        padding: 8px 16px; border-radius: 8px; border: none; cursor: pointer;
        font-size: 13px; font-weight: 500; font-family: inherit;
      }
      .opai-fb-cancel { background: rgba(255,255,255,0.08); color: #a0a0b8; }
      .opai-fb-cancel:hover { background: rgba(255,255,255,0.12); }
      .opai-fb-submit { background: #a855f7; color: #fff; }
      .opai-fb-submit:hover { background: #9333ea; }
      .opai-fb-submit:disabled { opacity: 0.5; cursor: not-allowed; }
      .opai-fb-flash {
        position: fixed; top: 56px; left: 50%; transform: translateX(-50%);
        background: #22c55e; color: #fff; padding: 8px 20px; border-radius: 8px;
        font-size: 13px; font-weight: 500; z-index: 100001;
        opacity: 0; transition: opacity 0.3s;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      }
      .opai-fb-flash.show { opacity: 1; }
    `;
    document.head.appendChild(style);
  }

  // ── Full-height layout fix ─────────────────────────────
  function applyFullHeightFix() {
    const style = document.createElement('style');
    style.textContent = `
      html, body { height: 100vh; margin: 0; overflow: hidden; }
      body { display: flex !important; flex-direction: column !important; }
      .opai-navbar { flex-shrink: 0; }
    `;
    document.head.appendChild(style);
  }

  // ── Build DOM ──────────────────────────────────────────
  function buildNavbar(current, recentKeys) {
    const nav = document.createElement('nav');
    nav.className = 'opai-navbar';

    // Back button
    const back = document.createElement('a');
    back.className = 'opai-navbar-back';
    back.href = '/';
    back.title = 'Back to Portal';
    back.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>';
    nav.appendChild(back);

    // Divider
    if (recentKeys.length > 0) {
      const div = document.createElement('div');
      div.className = 'opai-navbar-divider';
      nav.appendChild(div);
    }

    // Recent tools
    const toolsWrap = document.createElement('div');
    toolsWrap.className = 'opai-navbar-tools';

    for (const key of recentKeys) {
      const tool = TOOLS[key];
      if (!tool) continue;
      const a = document.createElement('a');
      a.className = 'opai-navbar-icon' + (key === current ? ' active' : '');
      a.href = tool.path;
      a.title = tool.label;
      a.textContent = tool.abbr;
      a.style.background = tool.color;
      if (key === current) a.style.setProperty('--glow', tool.color);
      toolsWrap.appendChild(a);
    }

    nav.appendChild(toolsWrap);

    // Spacer pushes feedback button to the right
    const spacer = document.createElement('div');
    spacer.className = 'opai-navbar-spacer';
    nav.appendChild(spacer);

    // Feedback button
    const fbBtn = document.createElement('button');
    fbBtn.className = 'opai-navbar-feedback';
    fbBtn.title = 'Send Feedback';
    fbBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    fbBtn.addEventListener('click', () => openFeedbackModal(current));
    nav.appendChild(fbBtn);

    return nav;
  }

  // ── Feedback modal ─────────────────────────────────────
  function openFeedbackModal(currentTool) {
    // Don't open twice
    if (document.querySelector('.opai-fb-overlay')) return;

    const toolLabel = (TOOLS[currentTool] || {}).label || currentTool || 'OPAI';

    const overlay = document.createElement('div');
    overlay.className = 'opai-fb-overlay';
    overlay.innerHTML = `
      <div class="opai-fb-modal">
        <h3>Send Feedback</h3>
        <div class="opai-fb-tool">${toolLabel} &mdash; ${window.location.pathname}</div>
        <textarea class="opai-fb-text" placeholder="I wish this app/page..."></textarea>
        <div class="opai-fb-attach-row">
          <button class="opai-fb-attach-btn" type="button">&#128247; Attach Image</button>
          <span class="opai-fb-attach-hint">or paste from clipboard</span>
          <input type="file" class="opai-fb-file-input" accept="image/*" multiple style="display:none;">
        </div>
        <div class="opai-fb-previews"></div>
        <div class="opai-fb-actions">
          <button class="opai-fb-cancel">Cancel</button>
          <button class="opai-fb-submit">Submit</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('open'));

    const textarea = overlay.querySelector('.opai-fb-text');
    const submitBtn = overlay.querySelector('.opai-fb-submit');
    const cancelBtn = overlay.querySelector('.opai-fb-cancel');
    const attachBtn = overlay.querySelector('.opai-fb-attach-btn');
    const fileInput = overlay.querySelector('.opai-fb-file-input');
    const previewsEl = overlay.querySelector('.opai-fb-previews');
    textarea.focus();

    // Image attachment state
    const pendingImages = []; // [{name, type, base64}]
    const MAX_IMAGES = 5;
    const MAX_SIZE_MB = 5;

    function addImageFile(file) {
      if (pendingImages.length >= MAX_IMAGES) return;
      if (file.size > MAX_SIZE_MB * 1024 * 1024) {
        showFlash('Image too large (max 5MB)');
        return;
      }
      if (!file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = () => {
        pendingImages.push({ name: file.name || 'screenshot.png', type: file.type, base64: reader.result });
        renderPreviews();
      };
      reader.readAsDataURL(file);
    }

    function renderPreviews() {
      previewsEl.innerHTML = pendingImages.map((img, i) =>
        '<div class="opai-fb-preview-item">' +
          '<img src="' + img.base64 + '" alt="' + img.name + '">' +
          '<button class="opai-fb-preview-remove" data-idx="' + i + '">&times;</button>' +
        '</div>'
      ).join('');
      previewsEl.querySelectorAll('.opai-fb-preview-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          pendingImages.splice(parseInt(btn.dataset.idx), 1);
          renderPreviews();
        });
      });
    }

    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      for (const f of fileInput.files) addImageFile(f);
      fileInput.value = '';
    });

    // Clipboard paste on textarea or modal
    overlay.querySelector('.opai-fb-modal').addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          addImageFile(item.getAsFile());
        }
      }
    });

    function close() {
      overlay.classList.remove('open');
      setTimeout(() => overlay.remove(), 200);
    }

    function guardedClose() {
      if ((textarea.value.trim() || pendingImages.length) && !confirm('You have unsaved input. Are you sure you want to close?')) return;
      close();
    }

    cancelBtn.addEventListener('click', guardedClose);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) guardedClose(); });

    submitBtn.addEventListener('click', async () => {
      const text = textarea.value.trim();
      if (!text) return;

      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending...';

      // Gather optional user identity
      let userId = null, userEmail = null;
      try {
        if (window.opaiAuth) {
          const s = await window.opaiAuth.getSession();
          userId = s?.user?.id || null;
          userEmail = s?.user?.email || null;
        }
      } catch {}

      // Build attachments array (strip data:image/...;base64, prefix for smaller payload)
      const attachments = pendingImages.map(img => ({
        name: img.name,
        type: img.type,
        data: img.base64.split(',')[1] || img.base64,
      }));

      try {
        const resp = await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tool: currentTool || 'unknown',
            page_path: window.location.pathname,
            user_text: text,
            user_id: userId,
            user_email: userEmail,
            attachments: attachments.length > 0 ? attachments : undefined,
          }),
        });

        if (resp.ok) {
          close();
          showFlash('Thanks for your feedback!');
        } else {
          const data = await resp.json().catch(() => ({}));
          submitBtn.textContent = data.error || 'Error — try again';
          submitBtn.disabled = false;
        }
      } catch {
        submitBtn.textContent = 'Network error';
        submitBtn.disabled = false;
      }
    });
  }

  function showFlash(msg) {
    const flash = document.createElement('div');
    flash.className = 'opai-fb-flash';
    flash.textContent = msg;
    document.body.appendChild(flash);
    requestAnimationFrame(() => flash.classList.add('show'));
    setTimeout(() => {
      flash.classList.remove('show');
      setTimeout(() => flash.remove(), 300);
    }, 2500);
  }

  // ── Main ───────────────────────────────────────────────
  async function init() {
    const current = detectCurrentTool();
    const recent = updateRecent(current);

    injectStyles();

    if (FULL_HEIGHT_TOOLS.includes(current)) {
      applyFullHeightFix();
    }

    // Build with all recent tools first (fast render)
    const nav = buildNavbar(current, recent);

    // If body has padding, stretch navbar edge-to-edge with negative margins
    const cs = getComputedStyle(document.body);
    const pt = parseFloat(cs.paddingTop) || 0;
    const pl = parseFloat(cs.paddingLeft) || 0;
    const pr = parseFloat(cs.paddingRight) || 0;
    if (pt > 0 || pl > 0 || pr > 0) {
      nav.style.marginTop = -pt + 'px';
      nav.style.marginLeft = -pl + 'px';
      nav.style.marginRight = -pr + 'px';
      nav.style.width = 'calc(100% + ' + (pl + pr) + 'px)';
      nav.style.paddingLeft = (12 + pl) + 'px';
    }

    document.body.prepend(nav);

    // Then async filter by permissions
    const allowed = await getAllowedApps();
    if (allowed !== null) {
      const filtered = recent.filter(t => allowed.includes(t));
      // Rebuild tools section if permissions changed the list
      if (filtered.length !== recent.length) {
        const toolsWrap = nav.querySelector('.opai-navbar-tools');
        toolsWrap.innerHTML = '';
        for (const key of filtered) {
          const tool = TOOLS[key];
          if (!tool) continue;
          const a = document.createElement('a');
          a.className = 'opai-navbar-icon' + (key === current ? ' active' : '');
          a.href = tool.path;
          a.title = tool.label;
          a.textContent = tool.abbr;
          a.style.background = tool.color;
          if (key === current) a.style.setProperty('--glow', tool.color);
          toolsWrap.appendChild(a);
        }
        // Hide divider if no tools
        const divider = nav.querySelector('.opai-navbar-divider');
        if (divider && filtered.length === 0) divider.style.display = 'none';
      }
    }
  }

  // Run after DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
