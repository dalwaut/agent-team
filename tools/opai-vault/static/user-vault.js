/**
 * OPAI User Vault — Standalone SPA
 * Auth: Supabase JWT + per-user PIN session cookie
 * State machine: loading → no-session → setup-pin → locked → browser
 */
(function () {
  'use strict';

  const API = '/vault/api/user';
  const PIN_API = '/vault/api/user/pin';
  const REVEAL_TIMEOUT = 10000;
  const INACTIVITY_WARNING = 29 * 60 * 1000;
  const INACTIVITY_LOCK = 30 * 60 * 1000;

  let state = {
    screen: 'loading',
    sbClient: null,
    session: null,
    userEmail: '',
    secrets: null,
    searchQuery: '',
    revealTimers: {},
  };

  let lastActivity = Date.now();
  let inactivityTimer = null;
  let warningTimer = null;

  const $app = document.getElementById('app');
  const $toast = document.getElementById('toast');
  const $inactivityBar = document.getElementById('inactivity-bar');

  // ── SVG Icons ─────────────────────────────────────────

  const ICONS = {
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  };

  // ── Helpers ──────────────────────────────────────────

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function toast(msg) {
    $toast.textContent = msg;
    $toast.classList.add('show');
    setTimeout(() => $toast.classList.remove('show'), 2500);
  }

  function getToken() {
    return state.session ? state.session.access_token : '';
  }

  async function apiFetch(path, opts = {}) {
    const token = getToken();
    if (!token) throw { status: 401, detail: 'Not authenticated' };
    const resp = await fetch(API + path, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await resp.json();
    if (!resp.ok) throw { status: resp.status, detail: data.detail || 'Request failed' };
    return data;
  }

  async function pinFetch(path, opts = {}) {
    const token = getToken();
    if (!token) throw { status: 401, detail: 'Not authenticated' };
    const resp = await fetch(PIN_API + path, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await resp.json();
    if (!resp.ok) throw { status: resp.status, detail: data.detail || 'Request failed' };
    return data;
  }

  // ── Inactivity Tracking ──────────────────────────────

  function resetActivity() {
    lastActivity = Date.now();
    if ($inactivityBar) $inactivityBar.classList.remove('visible');
  }

  function startInactivityTracking() {
    resetActivity();
    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'].forEach(evt => {
      document.addEventListener(evt, resetActivity, { passive: true });
    });
    clearInterval(inactivityTimer);
    clearTimeout(warningTimer);
    inactivityTimer = setInterval(() => {
      const idle = Date.now() - lastActivity;
      if (idle >= INACTIVITY_LOCK) {
        doLock();
      } else if (idle >= INACTIVITY_WARNING) {
        if ($inactivityBar) $inactivityBar.classList.add('visible');
      }
    }, 5000);
  }

  function stopInactivityTracking() {
    clearInterval(inactivityTimer);
    if ($inactivityBar) $inactivityBar.classList.remove('visible');
  }

  // ── PIN Input Helper ─────────────────────────────────

  function setupPinInputs(containerId, onComplete) {
    const inputs = document.querySelectorAll('#' + containerId + ' input');
    inputs.forEach((inp, i) => {
      inp.addEventListener('input', () => {
        inp.value = inp.value.replace(/\D/g, '').slice(0, 1);
        if (inp.value && i < inputs.length - 1) {
          inputs[i + 1].focus();
        }
        // Auto-submit when all filled
        const pin = getPinValue(containerId);
        if (pin.length === inputs.length && onComplete) {
          onComplete(pin);
        }
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !inp.value && i > 0) {
          inputs[i - 1].focus();
        }
      });
      inp.addEventListener('paste', (e) => {
        e.preventDefault();
        const pasted = (e.clipboardData.getData('text') || '').replace(/\D/g, '');
        for (let j = 0; j < Math.min(pasted.length, inputs.length); j++) {
          inputs[j].value = pasted[j];
        }
        const focusIdx = Math.min(pasted.length, inputs.length - 1);
        inputs[focusIdx].focus();
        const pin = getPinValue(containerId);
        if (pin.length === inputs.length && onComplete) {
          onComplete(pin);
        }
      });
    });
    inputs[0].focus();
  }

  function getPinValue(containerId) {
    const inputs = document.querySelectorAll('#' + containerId + ' input');
    let pin = '';
    inputs.forEach(inp => { pin += inp.value; });
    return pin;
  }

  // ── Render: Loading ──────────────────────────────────

  function renderLoading() {
    $app.innerHTML = '<div class="auth-screen"><div class="spinner"></div></div>';
  }

  // ── Render: Setup PIN ────────────────────────────────

  function renderSetupPin() {
    $app.innerHTML = '<div class="auth-screen"><div class="auth-card">' +
      '<div class="auth-badge">MV</div>' +
      '<div class="auth-title">Set Up Your Vault PIN</div>' +
      '<div class="auth-subtitle">Choose a 4-6 digit PIN to secure your personal vault</div>' +
      '<div class="pin-setup-form">' +
        '<div class="pin-setup-label">Enter PIN</div>' +
        '<div class="pin-inputs" id="setup-pin">' +
          '<input type="password" inputmode="numeric" maxlength="1">' +
          '<input type="password" inputmode="numeric" maxlength="1">' +
          '<input type="password" inputmode="numeric" maxlength="1">' +
          '<input type="password" inputmode="numeric" maxlength="1">' +
          '<input type="password" inputmode="numeric" maxlength="1">' +
          '<input type="password" inputmode="numeric" maxlength="1">' +
        '</div>' +
        '<div class="pin-setup-label">Confirm PIN</div>' +
        '<div class="pin-inputs" id="confirm-pin">' +
          '<input type="password" inputmode="numeric" maxlength="1">' +
          '<input type="password" inputmode="numeric" maxlength="1">' +
          '<input type="password" inputmode="numeric" maxlength="1">' +
          '<input type="password" inputmode="numeric" maxlength="1">' +
          '<input type="password" inputmode="numeric" maxlength="1">' +
          '<input type="password" inputmode="numeric" maxlength="1">' +
        '</div>' +
        '<div class="auth-error" id="setup-error"></div>' +
        '<button class="auth-btn primary" id="setup-btn">Set PIN</button>' +
      '</div>' +
    '</div></div>';

    setupPinInputs('setup-pin');
    setupPinInputs('confirm-pin');

    document.getElementById('setup-btn').addEventListener('click', async () => {
      const pin = getPinValue('setup-pin');
      const confirm = getPinValue('confirm-pin');
      const errEl = document.getElementById('setup-error');
      errEl.textContent = '';

      if (pin.length < 4) {
        errEl.textContent = 'PIN must be at least 4 digits';
        return;
      }
      if (pin !== confirm) {
        errEl.textContent = 'PINs do not match';
        return;
      }

      try {
        await pinFetch('/setup', { method: 'POST', body: { pin } });
        state.screen = 'browser';
        await loadSecrets();
        startInactivityTracking();
        render();
      } catch (e) {
        errEl.textContent = e.detail || 'Setup failed';
      }
    });
  }

  // ── Render: Locked (PIN entry) ───────────────────────

  function renderLocked(lockedSeconds) {
    const isLocked = lockedSeconds > 0;
    $app.innerHTML = '<div class="auth-screen"><div class="auth-card">' +
      '<div class="auth-badge">MV</div>' +
      '<div class="auth-title">My Vault</div>' +
      '<div class="auth-subtitle">Enter your PIN to unlock</div>' +
      (isLocked ? '<div class="auth-error">Too many attempts. Wait ' + lockedSeconds + 's.</div>' : '') +
      '<div class="pin-inputs" id="login-pin">' +
        '<input type="password" inputmode="numeric" maxlength="1"' + (isLocked ? ' disabled' : '') + '>' +
        '<input type="password" inputmode="numeric" maxlength="1"' + (isLocked ? ' disabled' : '') + '>' +
        '<input type="password" inputmode="numeric" maxlength="1"' + (isLocked ? ' disabled' : '') + '>' +
        '<input type="password" inputmode="numeric" maxlength="1"' + (isLocked ? ' disabled' : '') + '>' +
        '<input type="password" inputmode="numeric" maxlength="1"' + (isLocked ? ' disabled' : '') + '>' +
        '<input type="password" inputmode="numeric" maxlength="1"' + (isLocked ? ' disabled' : '') + '>' +
      '</div>' +
      '<div class="auth-error" id="login-error"></div>' +
    '</div></div>';

    if (!isLocked) {
      setupPinInputs('login-pin', async (pin) => {
        const errEl = document.getElementById('login-error');
        try {
          await pinFetch('/verify', { method: 'POST', body: { pin } });
          state.screen = 'browser';
          await loadSecrets();
          startInactivityTracking();
          render();
        } catch (e) {
          errEl.textContent = e.detail || 'Invalid PIN';
          document.querySelectorAll('#login-pin input').forEach(inp => {
            inp.classList.add('error');
            inp.value = '';
            setTimeout(() => inp.classList.remove('error'), 300);
          });
          document.querySelector('#login-pin input').focus();
        }
      });
    }
  }

  // ── Render: Browser ──────────────────────────────────

  function renderBrowser() {
    const secrets = state.secrets || [];
    const count = secrets.length;

    $app.innerHTML = '<div class="vault-app">' +
      '<div class="vault-topbar">' +
        '<div class="vault-topbar-badge">MV</div>' +
        '<div>' +
          '<div class="vault-topbar-title">My Vault</div>' +
          '<div class="vault-topbar-stats">' + count + ' secret' + (count !== 1 ? 's' : '') + ' &mdash; ' + escapeHtml(state.userEmail) + '</div>' +
        '</div>' +
        '<div class="vault-topbar-spacer"></div>' +
        '<button class="vault-topbar-btn" id="add-secret-btn">' +
          ICONS.plus + ' Add Secret' +
        '</button>' +
        '<button class="vault-topbar-btn" id="audit-btn">Audit Log</button>' +
        '<button class="vault-topbar-btn danger" id="lock-btn">' +
          ICONS.lock + ' Lock' +
        '</button>' +
      '</div>' +
      '<div class="vault-search">' +
        '<input type="text" id="search-input" placeholder="Search secrets..." value="' + escapeHtml(state.searchQuery) + '">' +
      '</div>' +
      '<div class="vault-sections" id="sections"></div>' +
    '</div>';

    renderSecretsList();

    document.getElementById('add-secret-btn').addEventListener('click', openAddSecretModal);
    document.getElementById('audit-btn').addEventListener('click', showAuditLog);
    document.getElementById('lock-btn').addEventListener('click', doLock);

    const searchInput = document.getElementById('search-input');
    searchInput.addEventListener('input', () => {
      state.searchQuery = searchInput.value;
      renderSecretsList();
    });
    searchInput.focus();
  }

  function renderSecretsList() {
    const $sections = document.getElementById('sections');
    if (!$sections) return;

    const secrets = state.secrets || [];
    const q = (state.searchQuery || '').toLowerCase().trim();
    const filtered = q
      ? secrets.filter(s =>
          s.name.toLowerCase().includes(q) ||
          (s.category || '').toLowerCase().includes(q) ||
          (s.description || '').toLowerCase().includes(q))
      : secrets;

    if (filtered.length === 0) {
      $sections.innerHTML = '<div class="vault-empty">' +
        (secrets.length === 0
          ? 'No secrets yet. Click "Add Secret" to store your first one.'
          : 'No secrets match your search.') +
        '</div>';
      return;
    }

    // Group by category
    const groups = {};
    for (const s of filtered) {
      const cat = s.category || 'general';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(s);
    }

    const chevronSvg = '<svg class="vault-category-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>';

    let html = '';
    for (const [cat, items] of Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]))) {
      const isOpen = q ? true : false;
      html += '<div class="vault-category' + (isOpen ? ' open' : '') + '">' +
        '<div class="vault-category-header">' +
          chevronSvg +
          '<span class="vault-category-name">' + escapeHtml(cat) + '</span>' +
          '<span class="vault-category-count">' + items.length + '</span>' +
        '</div>' +
        '<div class="vault-category-body">' +
          items.map(s => secretRowHTML(s)).join('') +
        '</div>' +
      '</div>';
    }

    $sections.innerHTML = html;

    // Bind toggle
    $sections.querySelectorAll('.vault-category-header').forEach(el => {
      el.addEventListener('click', () => el.parentElement.classList.toggle('open'));
    });

    // Bind actions
    $sections.querySelectorAll('.secret-btn[data-action="reveal"]').forEach(btn => {
      btn.addEventListener('click', () => doReveal(btn));
    });
    $sections.querySelectorAll('.secret-btn[data-action="copy"]').forEach(btn => {
      btn.addEventListener('click', () => doCopy(btn));
    });
    $sections.querySelectorAll('.secret-btn[data-action="delete"]').forEach(btn => {
      btn.addEventListener('click', () => doDelete(btn));
    });
  }

  function secretRowHTML(s) {
    const catClass = (s.category || 'general').replace(/[^a-z-]/g, '');
    return '<div class="secret-row">' +
      '<span class="secret-name">' + escapeHtml(s.name) + '</span>' +
      '<span class="category-badge ' + catClass + '">' + escapeHtml(s.category || 'general') + '</span>' +
      (s.description ? '<span class="secret-desc" title="' + escapeHtml(s.description) + '">' + escapeHtml(s.description) + '</span>' : '') +
      '<span class="secret-value" data-name="' + escapeHtml(s.name) + '">\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022</span>' +
      '<div class="secret-actions">' +
        '<button class="secret-btn" data-action="reveal" data-name="' + escapeHtml(s.name) + '" title="Reveal">' + ICONS.eye + '</button>' +
        '<button class="secret-btn" data-action="copy" data-name="' + escapeHtml(s.name) + '" title="Copy">' + ICONS.copy + '</button>' +
        '<button class="secret-btn" data-action="delete" data-name="' + escapeHtml(s.name) + '" title="Delete">' + ICONS.trash + '</button>' +
      '</div>' +
    '</div>';
  }

  // ── Secret Actions ───────────────────────────────────

  async function doReveal(btn) {
    const name = btn.dataset.name;
    const row = btn.closest('.secret-row');
    const valueEl = row.querySelector('.secret-value');

    if (valueEl.classList.contains('revealed')) {
      valueEl.textContent = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
      valueEl.classList.remove('revealed');
      btn.innerHTML = ICONS.eye;
      return;
    }

    try {
      const data = await apiFetch('/secrets/' + encodeURIComponent(name));
      valueEl.textContent = data.value;
      valueEl.classList.add('revealed');
      btn.innerHTML = ICONS.eyeOff;

      clearTimeout(state.revealTimers[name]);
      state.revealTimers[name] = setTimeout(() => {
        valueEl.textContent = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
        valueEl.classList.remove('revealed');
        btn.innerHTML = ICONS.eye;
      }, REVEAL_TIMEOUT);
    } catch (e) {
      if (e.status === 403) {
        // PIN session expired
        toast('Session expired — re-enter PIN');
        state.screen = 'locked';
        stopInactivityTracking();
        render();
        return;
      }
      toast(e.detail || 'Reveal failed');
    }
  }

  async function doCopy(btn) {
    const name = btn.dataset.name;
    try {
      const data = await apiFetch('/secrets/' + encodeURIComponent(name));
      await navigator.clipboard.writeText(data.value);
      toast('Copied!');
    } catch (e) {
      if (e.status === 403) {
        toast('Session expired — re-enter PIN');
        state.screen = 'locked';
        stopInactivityTracking();
        render();
        return;
      }
      toast(e.detail || 'Copy failed');
    }
  }

  async function doDelete(btn) {
    const name = btn.dataset.name;
    if (!confirm('Delete secret "' + name + '"?')) return;
    try {
      await apiFetch('/secrets/' + encodeURIComponent(name), { method: 'DELETE' });
      toast('Secret deleted');
      await loadSecrets();
      renderSecretsList();
    } catch (e) {
      if (e.status === 403) {
        toast('Session expired — re-enter PIN');
        state.screen = 'locked';
        stopInactivityTracking();
        render();
        return;
      }
      toast(e.detail || 'Delete failed');
    }
  }

  async function doLock() {
    try {
      await pinFetch('/lock', { method: 'POST' });
    } catch (e) {
      // ignore errors on lock
    }
    state.screen = 'locked';
    state.secrets = null;
    state.searchQuery = '';
    stopInactivityTracking();
    render();
  }

  // ── Add Secret Modal ─────────────────────────────────

  function openAddSecretModal() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = '<div class="modal-card">' +
      '<div class="modal-header">' +
        '<span class="modal-title">Add Secret</span>' +
        '<button class="modal-close" id="modal-close">&times;</button>' +
      '</div>' +
      '<div class="modal-body">' +
        '<label class="modal-label">Name</label>' +
        '<input type="text" class="modal-input" id="add-name" placeholder="e.g. my-api-key" autocomplete="off">' +
        '<label class="modal-label">Value</label>' +
        '<textarea class="modal-input modal-textarea" id="add-value" placeholder="Secret value..." autocomplete="off"></textarea>' +
        '<label class="modal-label">Category</label>' +
        '<select class="modal-input" id="add-category">' +
          '<option value="general">General</option>' +
          '<option value="api-key">API Key</option>' +
          '<option value="password">Password</option>' +
          '<option value="token">Token</option>' +
          '<option value="certificate">Certificate</option>' +
        '</select>' +
        '<label class="modal-label">Description (optional)</label>' +
        '<input type="text" class="modal-input" id="add-desc" placeholder="What this secret is for..." autocomplete="off">' +
        '<div class="modal-error hidden" id="add-error"></div>' +
      '</div>' +
      '<div class="modal-footer">' +
        '<button class="auth-btn" id="add-cancel">Cancel</button>' +
        '<button class="auth-btn primary" id="add-submit">Add Secret</button>' +
      '</div>' +
    '</div>';
    document.body.appendChild(overlay);

    const closeModal = () => overlay.remove();
    document.getElementById('modal-close').addEventListener('click', closeModal);
    document.getElementById('add-cancel').addEventListener('click', closeModal);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });

    document.getElementById('add-submit').addEventListener('click', async () => {
      const errEl = document.getElementById('add-error');
      errEl.classList.add('hidden');
      const name = document.getElementById('add-name').value.trim();
      const value = document.getElementById('add-value').value;
      const category = document.getElementById('add-category').value;
      const description = document.getElementById('add-desc').value.trim() || null;

      if (!name) { errEl.textContent = 'Name is required'; errEl.classList.remove('hidden'); return; }
      if (!value) { errEl.textContent = 'Value is required'; errEl.classList.remove('hidden'); return; }

      const submitBtn = document.getElementById('add-submit');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Adding...';

      try {
        await apiFetch('/secrets/' + encodeURIComponent(name), {
          method: 'PUT',
          body: { value, category, description },
        });
        closeModal();
        toast('Secret added!');
        await loadSecrets();
        renderSecretsList();
      } catch (e) {
        errEl.textContent = e.detail || 'Failed to add secret';
        errEl.classList.remove('hidden');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Add Secret';
      }
    });

    document.getElementById('add-name').focus();
  }

  // ── Audit Log Modal ──────────────────────────────────

  async function showAuditLog() {
    try {
      const data = await apiFetch('/audit?limit=30');
      const entries = data.entries || [];

      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = '<div class="modal-card" style="width: 600px;">' +
        '<div class="modal-header">' +
          '<span class="modal-title">Audit Log</span>' +
          '<button class="modal-close" id="audit-close">&times;</button>' +
        '</div>' +
        '<div class="modal-body" style="max-height: 400px; overflow-y: auto; padding: 12px 24px;">' +
          (entries.length === 0 ? '<div class="vault-empty">No audit entries yet.</div>' :
            entries.map(function(e) {
              return '<div class="audit-entry">' +
                '<span class="audit-action">' + escapeHtml(e.action) + '</span>' +
                '<span class="audit-name">' + escapeHtml(e.secret_name || '-') + '</span>' +
                '<span class="audit-time">' + new Date(e.created_at).toLocaleString() + '</span>' +
              '</div>';
            }).join('')) +
        '</div>' +
        '<div class="modal-footer">' +
          '<button class="auth-btn" id="audit-ok">Close</button>' +
        '</div>' +
      '</div>';
      document.body.appendChild(overlay);
      document.getElementById('audit-close').addEventListener('click', () => overlay.remove());
      document.getElementById('audit-ok').addEventListener('click', () => overlay.remove());
      overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    } catch (e) {
      toast(e.detail || 'Failed to load audit log');
    }
  }

  // ── Load Secrets ─────────────────────────────────────

  async function loadSecrets() {
    try {
      const data = await apiFetch('/secrets');
      state.secrets = data.secrets;
    } catch (e) {
      if (e.status === 403) {
        state.screen = 'locked';
        stopInactivityTracking();
      }
    }
  }

  // ── Render Dispatcher ────────────────────────────────

  function render() {
    switch (state.screen) {
      case 'loading': renderLoading(); break;
      case 'setup-pin': renderSetupPin(); break;
      case 'locked': renderLocked(0); break;
      case 'locked-out': renderLocked(state._lockedSeconds || 60); break;
      case 'browser': renderBrowser(); break;
    }
  }

  // ── Init ─────────────────────────────────────────────

  async function init() {
    render(); // show loading

    // 1. Fetch auth config
    let cfg;
    try {
      const resp = await fetch('/vault/api/user/auth/config');
      cfg = await resp.json();
    } catch (e) {
      $app.innerHTML = '<div class="auth-screen"><div class="auth-card"><div class="auth-title">Configuration Error</div><div class="auth-subtitle">Could not load auth configuration.</div></div></div>';
      return;
    }

    if (!cfg.supabase_url || !cfg.supabase_anon_key) {
      $app.innerHTML = '<div class="auth-screen"><div class="auth-card"><div class="auth-title">Auth Not Configured</div><div class="auth-subtitle">Supabase credentials missing.</div></div></div>';
      return;
    }

    // 2. Create Supabase client and check session
    const sb = window.supabase.createClient(cfg.supabase_url, cfg.supabase_anon_key);
    state.sbClient = sb;

    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
      window.location.href = '/auth/login?return=/vault/my/';
      return;
    }

    state.session = session;
    state.userEmail = session.user.email || '';

    // Keep token fresh
    sb.auth.onAuthStateChange((_event, sess) => {
      if (sess) {
        state.session = sess;
      } else {
        window.location.href = '/auth/login?return=/vault/my/';
      }
    });

    // 3. Check PIN status
    try {
      const pinStatus = await pinFetch('/status');

      if (!pinStatus.pin_configured) {
        state.screen = 'setup-pin';
      } else if (pinStatus.locked) {
        state._lockedSeconds = pinStatus.locked_seconds;
        state.screen = 'locked-out';
      } else {
        // Try to load secrets (if session cookie still valid)
        try {
          await loadSecrets();
          if (state.secrets) {
            state.screen = 'browser';
            startInactivityTracking();
          } else {
            state.screen = 'locked';
          }
        } catch (e) {
          state.screen = 'locked';
        }
      }
    } catch (e) {
      // PIN status fetch failed — show locked screen
      state.screen = 'locked';
    }

    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
