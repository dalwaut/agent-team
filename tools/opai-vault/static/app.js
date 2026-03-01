/**
 * OPAI Vault — Web UI
 * Auth state machine, secret browser, search, copy, reveal, WebAuthn.
 */
(function () {
  'use strict';

  const API = '/vault/api';
  const REVEAL_TIMEOUT = 10000; // 10s auto-mask
  const INACTIVITY_WARNING = 29 * 60 * 1000; // 29 min
  const INACTIVITY_LOCK = 30 * 60 * 1000; // 30 min

  let state = {
    screen: 'loading', // loading | setup | login | browser
    ageKeyPresent: false,
    pinConfigured: false,
    webauthnConfigured: false,
    webauthnAvailable: false,
    secrets: null,
    stats: null,
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
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  };

  // ── API Helpers ────────────────────────────────────────

  async function api(path, opts = {}) {
    const resp = await fetch(API + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    const data = await resp.json();
    if (!resp.ok) throw { status: resp.status, detail: data.detail || 'Request failed' };
    return data;
  }

  // ── Toast ─────────────────────────────────────────────

  function toast(msg, duration = 2000) {
    $toast.textContent = msg;
    $toast.classList.add('show');
    setTimeout(() => $toast.classList.remove('show'), duration);
  }

  // ── Inactivity Tracking ──────────────────────────────

  function resetInactivity() {
    lastActivity = Date.now();
    $inactivityBar.classList.remove('visible');
    clearTimeout(inactivityTimer);
    clearTimeout(warningTimer);

    if (state.screen !== 'browser') return;

    warningTimer = setTimeout(() => {
      $inactivityBar.classList.add('visible');
    }, INACTIVITY_WARNING);

    inactivityTimer = setTimeout(() => {
      doLock();
    }, INACTIVITY_LOCK);
  }

  function startInactivityTracking() {
    document.addEventListener('mousemove', resetInactivity);
    document.addEventListener('keydown', resetInactivity);
    document.addEventListener('click', resetInactivity);
    resetInactivity();
  }

  function stopInactivityTracking() {
    document.removeEventListener('mousemove', resetInactivity);
    document.removeEventListener('keydown', resetInactivity);
    document.removeEventListener('click', resetInactivity);
    clearTimeout(inactivityTimer);
    clearTimeout(warningTimer);
    $inactivityBar.classList.remove('visible');
  }

  // ── Lock ──────────────────────────────────────────────

  async function doLock() {
    stopInactivityTracking();
    // Clear all revealed values
    state.revealTimers = {};
    try { await api('/auth/lock', { method: 'POST' }); } catch {}
    state.screen = 'login';
    state.secrets = null;
    render();
  }

  // ── Render: Loading ──────────────────────────────────

  function renderLoading() {
    $app.innerHTML = `
      <div class="auth-screen">
        <div class="auth-card">
          <div class="auth-badge">VT</div>
          <div class="auth-title">OPAI Vault</div>
          <div class="auth-subtitle"><span class="spinner"></span></div>
        </div>
      </div>
    `;
  }

  // ── Render: No Age Key ──────────────────────────────

  function renderNoKey() {
    $app.innerHTML = `
      <div class="auth-screen">
        <div class="auth-card">
          <div class="auth-badge">VT</div>
          <div class="auth-title">OPAI Vault</div>
          <div class="auth-subtitle">
            <span class="status-dot red"></span>Age key not found
          </div>
          <p style="font-size:12px;color:var(--text-muted);margin-top:16px">
            This machine does not have the vault encryption key.<br>
            Copy <code style="color:var(--accent)">~/.opai-vault/vault.key</code> from the OPAI server.
          </p>
        </div>
      </div>
    `;
  }

  // ── Render: PIN Setup ────────────────────────────────

  function renderSetup() {
    $app.innerHTML = `
      <div class="auth-screen">
        <div class="auth-card">
          <div class="auth-badge">VT</div>
          <div class="auth-title">Set Your PIN</div>
          <div class="auth-subtitle">
            <span class="status-dot green"></span>Age key present &mdash; First-time setup
          </div>
          <div class="pin-setup-form">
            <div class="pin-setup-label">Choose a 4-6 digit PIN</div>
            <div class="pin-inputs" id="setup-pin">${pinInputsHTML(6)}</div>
            <div class="auth-error" id="setup-error"></div>
            <button class="auth-btn primary" id="setup-btn" disabled>Set PIN</button>
          </div>
        </div>
      </div>
    `;
    setupPinInputs('setup-pin', async (pin) => {
      document.getElementById('setup-btn').disabled = pin.length < 4;
    });
    document.getElementById('setup-btn').addEventListener('click', async () => {
      const pin = getPinValue('setup-pin');
      if (pin.length < 4) return;
      const errEl = document.getElementById('setup-error');
      try {
        await api('/auth/pin/setup', { method: 'POST', body: { pin } });
        state.screen = 'browser';
        await loadSecrets();
        startInactivityTracking();
        render();
      } catch (e) {
        errEl.textContent = e.detail || 'Setup failed';
      }
    });
  }

  // ── Render: PIN Login ────────────────────────────────

  function renderLogin() {
    const hasWebAuthn = state.webauthnConfigured && state.webauthnAvailable;
    $app.innerHTML = `
      <div class="auth-screen">
        <div class="auth-card">
          <div class="auth-badge">VT</div>
          <div class="auth-title">OPAI Vault</div>
          <div class="auth-subtitle">
            <span class="status-dot green"></span>Enter your PIN to unlock
          </div>
          <div class="pin-inputs" id="login-pin">${pinInputsHTML(6)}</div>
          <div class="auth-error" id="login-error"></div>
          ${hasWebAuthn ? `
            <div class="auth-divider">or</div>
            <button class="auth-btn" id="webauthn-btn">
              ${ICONS.key} Use Security Key
            </button>
          ` : ''}
        </div>
      </div>
    `;
    setupPinInputs('login-pin', async (pin, isSubmit) => {
      // Only auto-submit when all 6 boxes filled or user pressed Enter with 4+
      if (!isSubmit && pin.length < 6) return;
      if (pin.length < 4) return;
      const errEl = document.getElementById('login-error');
      try {
        await api('/auth/pin/verify', { method: 'POST', body: { pin } });
        state.screen = 'browser';
        await loadSecrets();
        startInactivityTracking();
        render();
      } catch (e) {
        errEl.textContent = e.detail || 'Invalid PIN';
        // Shake inputs
        document.querySelectorAll('#login-pin input').forEach(inp => {
          inp.classList.add('error');
          inp.value = '';
          setTimeout(() => inp.classList.remove('error'), 300);
        });
        document.querySelector('#login-pin input').focus();
      }
    });
    if (hasWebAuthn) {
      document.getElementById('webauthn-btn').addEventListener('click', doWebAuthnLogin);
    }
  }

  // ── Render: Browser ──────────────────────────────────

  function renderBrowser() {
    if (!state.secrets || !state.stats) {
      renderLoading();
      return;
    }

    const { secrets, stats, searchQuery } = state;
    const totalSecrets = stats.total_secrets;
    const totalServices = stats.services ? stats.services.length : 0;

    $app.innerHTML = `
      <div class="vault-app">
        <div class="vault-topbar">
          <div class="vault-topbar-badge">VT</div>
          <div>
            <div class="vault-topbar-title">OPAI Vault</div>
            <div class="vault-topbar-stats">${totalSecrets} secrets / ${totalServices} services</div>
          </div>
          <div class="vault-topbar-spacer"></div>
          <button class="vault-topbar-btn" id="add-secret-btn">
            ${ICONS.plus} Add Secret
          </button>
          ${state.webauthnAvailable ? `
            <button class="vault-topbar-btn" id="register-key-btn">
              ${ICONS.key} Register Key
            </button>
          ` : ''}
          <button class="vault-topbar-btn danger" id="lock-btn">
            ${ICONS.lock} Lock
          </button>
        </div>
        <div class="vault-search">
          <input type="text" id="search-input" placeholder="Search secrets..." value="${escapeHtml(searchQuery)}">
        </div>
        <div class="vault-sections" id="sections"></div>
      </div>
    `;

    document.getElementById('lock-btn').addEventListener('click', doLock);
    renderSections(secrets, searchQuery);
    document.getElementById('add-secret-btn').addEventListener('click', openAddSecretModal);
    const regBtn = document.getElementById('register-key-btn');
    if (regBtn) regBtn.addEventListener('click', doWebAuthnRegister);
    const searchInput = document.getElementById('search-input');
    searchInput.addEventListener('input', () => {
      state.searchQuery = searchInput.value;
      renderSections(secrets, searchInput.value);
    });
    searchInput.focus();
  }

  function renderSections(secrets, query) {
    const $sections = document.getElementById('sections');
    if (!$sections) return;
    const q = (query || '').toLowerCase().trim();
    let html = '';
    let hasResults = false;

    // Shared
    const shared = secrets.shared || {};
    const sharedKeys = Object.keys(shared).filter(k => !q || k.toLowerCase().includes(q));
    if (sharedKeys.length > 0) {
      hasResults = true;
      html += sectionHTML('Shared', sharedKeys.length, sharedKeys.map(k =>
        secretRowHTML(k, 'shared', null)
      ).join(''), q);
    }

    // Services
    const services = secrets.services || {};
    const serviceNames = Object.keys(services).sort();
    let servicesBody = '';
    let servicesTotal = 0;
    for (const svc of serviceNames) {
      const svcSecrets = services[svc] || {};
      const svcKeys = Object.keys(svcSecrets).filter(k => !q || k.toLowerCase().includes(q) || svc.toLowerCase().includes(q));
      if (svcKeys.length === 0) continue;
      servicesTotal += svcKeys.length;
      servicesBody += serviceHTML(svc, svcKeys.length, svcKeys.map(k =>
        secretRowHTML(k, 'services', svc)
      ).join(''), q);
    }
    if (servicesTotal > 0) {
      hasResults = true;
      html += sectionHTML('Services', servicesTotal, servicesBody, q);
    }

    // Credentials
    const creds = secrets.credentials || {};
    const credKeys = Object.keys(creds).filter(k => !q || k.toLowerCase().includes(q));
    if (credKeys.length > 0) {
      hasResults = true;
      html += sectionHTML('Credentials', credKeys.length, credKeys.map(k =>
        secretRowHTML(k, 'credentials', null)
      ).join(''), q);
    }

    if (!hasResults) {
      html = '<div class="vault-empty">No secrets match your search.</div>';
    }

    $sections.innerHTML = html;

    // Bind toggle events
    $sections.querySelectorAll('.vault-section-header').forEach(el => {
      el.addEventListener('click', () => el.parentElement.classList.toggle('open'));
    });
    $sections.querySelectorAll('.vault-service-header').forEach(el => {
      el.addEventListener('click', () => el.parentElement.classList.toggle('open'));
    });

    // Bind reveal/copy events
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

  function sectionHTML(name, count, body, query) {
    const isOpen = query ? true : false;
    return `
      <div class="vault-section${isOpen ? ' open' : ''}">
        <div class="vault-section-header">
          <svg class="vault-section-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
          <span class="vault-section-name">${escapeHtml(name)}</span>
          <span class="vault-section-count">${count}</span>
        </div>
        <div class="vault-section-body">${body}</div>
      </div>
    `;
  }

  function serviceHTML(svc, count, body, query) {
    const isOpen = query ? true : false;
    return `
      <div class="vault-service${isOpen ? ' open' : ''}">
        <div class="vault-service-header">
          <svg class="vault-section-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
          <span class="vault-service-name">${escapeHtml(svc)}</span>
          <span class="vault-service-count">${count}</span>
        </div>
        <div class="vault-service-body">${body}</div>
      </div>
    `;
  }

  function secretRowHTML(name, section, service) {
    const dataAttrs = `data-name="${escapeHtml(name)}" data-section="${escapeHtml(section)}" ${service ? `data-service="${escapeHtml(service)}"` : ''}`;
    return `
      <div class="secret-row">
        <span class="secret-name">${escapeHtml(name)}</span>
        <span class="secret-value" ${dataAttrs}>&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;</span>
        <div class="secret-actions">
          <button class="secret-btn" data-action="reveal" ${dataAttrs} title="Reveal">
            ${ICONS.eye}
          </button>
          <button class="secret-btn" data-action="copy" ${dataAttrs} title="Copy">
            ${ICONS.copy}
          </button>
          <button class="secret-btn" data-action="delete" ${dataAttrs} title="Delete">
            ${ICONS.trash}
          </button>
        </div>
      </div>
    `;
  }

  // ── Secret Actions ───────────────────────────────────

  async function doReveal(btn) {
    const name = btn.dataset.name;
    const section = btn.dataset.section;
    const service = btn.dataset.service || null;
    const row = btn.closest('.secret-row');
    const valueEl = row.querySelector('.secret-value');

    // If already revealed, mask it
    if (valueEl.classList.contains('revealed')) {
      maskSecret(valueEl, btn);
      return;
    }

    try {
      const body = { name };
      if (service) body.service = service;
      else if (section !== 'services') body.section = section;
      const data = await api('/ui/reveal', { method: 'POST', body });
      valueEl.textContent = data.value;
      valueEl.classList.add('revealed');
      btn.innerHTML = ICONS.eyeOff;

      // Auto-mask after 10s
      const timerKey = `${section}:${service || ''}:${name}`;
      clearTimeout(state.revealTimers[timerKey]);
      state.revealTimers[timerKey] = setTimeout(() => {
        maskSecret(valueEl, btn);
      }, REVEAL_TIMEOUT);
    } catch (e) {
      if (e.status === 401) {
        doLock();
        return;
      }
      toast(e.detail || 'Reveal failed');
    }
  }

  function maskSecret(valueEl, btn) {
    valueEl.textContent = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
    valueEl.classList.remove('revealed');
    if (btn) btn.innerHTML = ICONS.eye;
  }

  async function doCopy(btn) {
    const name = btn.dataset.name;
    const section = btn.dataset.section;
    const service = btn.dataset.service || null;

    try {
      const body = { name };
      if (service) body.service = service;
      else if (section !== 'services') body.section = section;
      const data = await api('/ui/reveal', { method: 'POST', body });
      await navigator.clipboard.writeText(data.value);
      toast('Copied!');
    } catch (e) {
      if (e.status === 401) {
        doLock();
        return;
      }
      toast(e.detail || 'Copy failed');
    }
  }

  // ── Add Secret Modal ────────────────────────────────

  function openAddSecretModal() {
    // Gather existing service names for the dropdown
    const services = state.secrets ? Object.keys(state.secrets.services || {}).sort() : [];

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card">
        <div class="modal-header">
          <span class="modal-title">Add Secret</span>
          <button class="modal-close" id="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          <label class="modal-label">Section</label>
          <select class="modal-input" id="add-section">
            <option value="credentials">Credentials</option>
            <option value="shared">Shared</option>
            <option value="service">Service-specific</option>
          </select>
          <div id="service-picker" class="hidden">
            <label class="modal-label">Service</label>
            <select class="modal-input" id="add-service-select">
              ${services.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('')}
              <option value="__new__">+ New service...</option>
            </select>
            <input type="text" class="modal-input hidden" id="add-service-new" placeholder="e.g. opai-myservice">
          </div>
          <label class="modal-label">Key Name</label>
          <input type="text" class="modal-input" id="add-name" placeholder="e.g. API_KEY or stripe-live-key" autocomplete="off">
          <label class="modal-label">Value</label>
          <textarea class="modal-input modal-textarea" id="add-value" placeholder="Secret value..." autocomplete="off"></textarea>
          <div class="modal-error hidden" id="add-error"></div>
        </div>
        <div class="modal-footer">
          <button class="auth-btn" id="add-cancel">Cancel</button>
          <button class="auth-btn primary" id="add-submit">Add Secret</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    // Section toggle
    const sectionSelect = document.getElementById('add-section');
    const servicePicker = document.getElementById('service-picker');
    const serviceSelect = document.getElementById('add-service-select');
    const serviceNew = document.getElementById('add-service-new');

    sectionSelect.addEventListener('change', () => {
      servicePicker.classList.toggle('hidden', sectionSelect.value !== 'service');
    });
    serviceSelect.addEventListener('change', () => {
      serviceNew.classList.toggle('hidden', serviceSelect.value !== '__new__');
      if (serviceSelect.value === '__new__') serviceNew.focus();
    });

    // Close
    const closeModal = () => overlay.remove();
    document.getElementById('modal-close').addEventListener('click', closeModal);
    document.getElementById('add-cancel').addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

    // Submit
    document.getElementById('add-submit').addEventListener('click', async () => {
      const errEl = document.getElementById('add-error');
      errEl.classList.add('hidden');

      const name = document.getElementById('add-name').value.trim();
      const value = document.getElementById('add-value').value;
      const sectionVal = sectionSelect.value;

      if (!name) { errEl.textContent = 'Key name is required'; errEl.classList.remove('hidden'); return; }
      if (!value) { errEl.textContent = 'Value is required'; errEl.classList.remove('hidden'); return; }

      const body = { name, value };
      if (sectionVal === 'service') {
        const svc = serviceSelect.value === '__new__' ? serviceNew.value.trim() : serviceSelect.value;
        if (!svc) { errEl.textContent = 'Service name is required'; errEl.classList.remove('hidden'); return; }
        body.service = svc;
      } else {
        body.section = sectionVal;
      }

      const submitBtn = document.getElementById('add-submit');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Adding...';

      try {
        await api('/ui/secrets/add', { method: 'POST', body });
        closeModal();
        toast('Secret added!');
        await loadSecrets();
        renderSections(state.secrets, state.searchQuery);
        // Update stats in topbar
        const statsEl = document.querySelector('.vault-topbar-stats');
        if (statsEl && state.stats) {
          const totalServices = state.stats.services ? state.stats.services.length : 0;
          statsEl.textContent = `${state.stats.total_secrets} secrets / ${totalServices} services`;
        }
      } catch (e) {
        if (e.status === 401) { closeModal(); doLock(); return; }
        errEl.textContent = e.detail || 'Failed to add secret';
        errEl.classList.remove('hidden');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Add Secret';
      }
    });

    // Focus the name input
    document.getElementById('add-name').focus();
  }

  // ── Delete Secret ──────────────────────────────────

  async function doDelete(btn) {
    const name = btn.dataset.name;
    const section = btn.dataset.section;
    const service = btn.dataset.service || null;

    if (!confirm(`Delete secret "${name}"?`)) return;

    try {
      const body = { name };
      if (service) body.service = service;
      else if (section !== 'services') body.section = section;
      await api('/ui/secrets/delete', { method: 'POST', body });
      toast('Secret deleted');
      await loadSecrets();
      renderSections(state.secrets, state.searchQuery);
      // Update stats in topbar
      const statsEl = document.querySelector('.vault-topbar-stats');
      if (statsEl && state.stats) {
        const totalServices = state.stats.services ? state.stats.services.length : 0;
        statsEl.textContent = `${state.stats.total_secrets} secrets / ${totalServices} services`;
      }
    } catch (e) {
      if (e.status === 401) { doLock(); return; }
      toast(e.detail || 'Delete failed');
    }
  }

  // ── WebAuthn ─────────────────────────────────────────

  async function doWebAuthnRegister() {
    try {
      const optionsResp = await api('/auth/webauthn/register/options', { method: 'POST' });

      // Convert challenge and user.id from base64url to ArrayBuffer
      optionsResp.challenge = base64urlToBuffer(optionsResp.challenge);
      optionsResp.user.id = base64urlToBuffer(optionsResp.user.id);
      if (optionsResp.excludeCredentials) {
        optionsResp.excludeCredentials = optionsResp.excludeCredentials.map(c => ({
          ...c, id: base64urlToBuffer(c.id),
        }));
      }

      const credential = await navigator.credentials.create({ publicKey: optionsResp });
      const credJSON = {
        id: credential.id,
        rawId: bufferToBase64url(credential.rawId),
        type: credential.type,
        response: {
          attestationObject: bufferToBase64url(credential.response.attestationObject),
          clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
        },
      };
      if (credential.response.getTransports) {
        credJSON.response.transports = credential.response.getTransports();
      }

      await api('/auth/webauthn/register/verify', { method: 'POST', body: { credential: credJSON } });
      state.webauthnConfigured = true;
      toast('Security key registered!');
    } catch (e) {
      if (e.name === 'NotAllowedError') return; // user cancelled
      console.error('WebAuthn register error:', e);
      toast(e.detail || e.message || 'Registration failed');
    }
  }

  async function doWebAuthnLogin() {
    try {
      const optionsResp = await api('/auth/webauthn/login/options', { method: 'POST' });

      optionsResp.challenge = base64urlToBuffer(optionsResp.challenge);
      if (optionsResp.allowCredentials) {
        optionsResp.allowCredentials = optionsResp.allowCredentials.map(c => ({
          ...c, id: base64urlToBuffer(c.id),
        }));
      }

      const assertion = await navigator.credentials.get({ publicKey: optionsResp });
      const assertJSON = {
        id: assertion.id,
        rawId: bufferToBase64url(assertion.rawId),
        type: assertion.type,
        response: {
          authenticatorData: bufferToBase64url(assertion.response.authenticatorData),
          clientDataJSON: bufferToBase64url(assertion.response.clientDataJSON),
          signature: bufferToBase64url(assertion.response.signature),
        },
      };
      if (assertion.response.userHandle) {
        assertJSON.response.userHandle = bufferToBase64url(assertion.response.userHandle);
      }

      await api('/auth/webauthn/login/verify', { method: 'POST', body: { credential: assertJSON } });
      state.screen = 'browser';
      await loadSecrets();
      startInactivityTracking();
      render();
    } catch (e) {
      if (e.name === 'NotAllowedError') return;
      console.error('WebAuthn login error:', e);
      toast(e.detail || e.message || 'Authentication failed');
    }
  }

  // ── Base64url helpers ────────────────────────────────

  function base64urlToBuffer(base64url) {
    const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
    const pad = base64.length % 4;
    const padded = pad ? base64 + '='.repeat(4 - pad) : base64;
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function bufferToBase64url(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // ── PIN Input Helpers ────────────────────────────────

  function pinInputsHTML(count) {
    let html = '';
    for (let i = 0; i < count; i++) {
      html += `<input type="password" inputmode="numeric" maxlength="1" data-idx="${i}" autocomplete="off">`;
    }
    return html;
  }

  function setupPinInputs(containerId, onComplete) {
    const container = document.getElementById(containerId);
    const inputs = container.querySelectorAll('input');
    inputs[0].focus();

    inputs.forEach((inp, i) => {
      inp.addEventListener('input', () => {
        if (inp.value && i < inputs.length - 1) {
          inputs[i + 1].focus();
        }
        const pin = getPinValue(containerId);
        // isSubmit=true only when last box is filled (all 6 entered)
        const allFilled = i === inputs.length - 1 && inp.value;
        onComplete(pin, allFilled);
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !inp.value && i > 0) {
          inputs[i - 1].focus();
          inputs[i - 1].value = '';
        }
        if (e.key === 'Enter') {
          const pin = getPinValue(containerId);
          onComplete(pin, true);
        }
      });
      // Paste support
      inp.addEventListener('paste', (e) => {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
        for (let j = 0; j < Math.min(text.length, inputs.length - i); j++) {
          inputs[i + j].value = text[j];
        }
        const nextIdx = Math.min(i + text.length, inputs.length - 1);
        inputs[nextIdx].focus();
        onComplete(getPinValue(containerId), true);
      });
    });
  }

  function getPinValue(containerId) {
    const inputs = document.querySelectorAll(`#${containerId} input`);
    let pin = '';
    inputs.forEach(inp => { pin += inp.value; });
    return pin;
  }

  // ── Load Secrets ─────────────────────────────────────

  async function loadSecrets() {
    try {
      const data = await api('/ui/secrets');
      state.secrets = data.secrets;
      state.stats = data.stats;
    } catch (e) {
      if (e.status === 401) {
        state.screen = 'login';
      }
    }
  }

  // ── Render Dispatcher ────────────────────────────────

  function render() {
    switch (state.screen) {
      case 'loading': renderLoading(); break;
      case 'no-key': renderNoKey(); break;
      case 'setup': renderSetup(); break;
      case 'login': renderLogin(); break;
      case 'browser': renderBrowser(); break;
    }
  }

  // ── Helpers ──────────────────────────────────────────

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // ── Init ─────────────────────────────────────────────

  async function init() {
    render(); // show loading

    try {
      const status = await api('/auth/status', { method: 'POST' });
      state.ageKeyPresent = status.age_key_present;
      state.pinConfigured = status.pin_configured;
      state.webauthnConfigured = status.webauthn_configured;
      state.webauthnAvailable = status.webauthn_available;

      if (!status.age_key_present) {
        state.screen = 'no-key';
      } else if (status.session_valid) {
        state.screen = 'browser';
        await loadSecrets();
        startInactivityTracking();
      } else if (!status.pin_configured) {
        state.screen = 'setup';
      } else {
        state.screen = 'login';
      }
    } catch {
      state.screen = 'no-key';
    }

    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
