/**
 * OPAI Email Agent — Inbox-Style UI with Multi-Account + Controls
 */

let _modalCallback = null;
let _expandedEmail = null;
let _expandedActivity = null;
let _emailGroups = [];
let _editingQueue = {};
let _expandedQueueDraft = {};
let _currentDate = null;   // null = "recent" (default cross-day view)
let _availableDates = [];  // populated from /api/logs/dates

// Account state
let _accounts = [];
let _activeAccountId = null;
let _accountDropdownOpen = false;
let _onboardingStep = 0;

// ── API helpers ──────────────────────────────────────────

const BASE = location.pathname.replace(/\/(?:index\.html)?$/, '');

async function api(method, endpoint, body = null) {
  const opts = { method, headers: {} };
  // Auto-inject accountId for account isolation
  if (_activeAccountId) {
    if (method === 'GET') {
      const sep = endpoint.includes('?') ? '&' : '?';
      endpoint += sep + 'accountId=' + encodeURIComponent(_activeAccountId);
    } else if (body && typeof body === 'object') {
      if (!body.accountId) body.accountId = _activeAccountId;
    }
  }
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(BASE + endpoint, opts);
  return resp.json();
}

// ── Init ─────────────────────────────────────────────────

async function init() {
  await loadAccounts();
  await refreshStatus();
  await loadDateNav();
  await Promise.all([loadEmails(), loadQueue(), loadActivity(), loadFeedback(), loadAlerts(), loadClassifications()]);

  // SSE — refresh data when a cycle completes
  initSSE();

  // Fallback polling (in case SSE drops)
  setInterval(refreshStatus, 15000);
  setInterval(() => { if (_expandedEmail === null) loadEmails(); }, 60000);
  setInterval(loadQueue, 60000);

  // Close account dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (_accountDropdownOpen && !e.target.closest('#account-picker')) {
      _accountDropdownOpen = false;
      document.getElementById('account-dropdown').classList.remove('open');
    }
  });
}

// ── SSE Client ───────────────────────────────────────────

function initSSE() {
  try {
    const evtSource = new EventSource(BASE + '/api/events');
    evtSource.addEventListener('cycle', () => {
      Promise.all([loadEmails(), loadQueue(), loadActivity(), loadAlerts(), refreshStatus()]);
    });
    evtSource.onerror = () => {
      // SSE reconnects automatically — no action needed
    };
  } catch (e) {
    console.warn('SSE not available, falling back to polling');
  }
}

// ── Account Management ───────────────────────────────────

async function loadAccounts() {
  try {
    const data = await api('GET', '/api/accounts');
    _accounts = data.accounts || [];
    _activeAccountId = data.activeId;
    renderAccountBadge();
  } catch (e) {
    console.error('Load accounts failed:', e);
  }
}

function renderAccountBadge() {
  const badge = document.getElementById('account-badge');
  const active = _accounts.find(a => a.id === _activeAccountId);
  if (active) {
    badge.textContent = active.email;
  }
}

function toggleAccountPicker() {
  _accountDropdownOpen = !_accountDropdownOpen;
  const dropdown = document.getElementById('account-dropdown');
  dropdown.classList.toggle('open', _accountDropdownOpen);
  if (_accountDropdownOpen) renderAccountList();
}

function renderAccountList() {
  const list = document.getElementById('account-list-items');
  list.innerHTML = _accounts.map(a => {
    const isActive = a.id === _activeAccountId;
    const needsSetup = a.needsSetup;
    return '<div class="account-item' + (isActive ? ' active' : '') + '" onclick="switchAccount(\'' + a.id + '\')">' +
      '<div class="account-item-info">' +
        '<span class="account-item-name">' + esc(a.name) + '</span>' +
        '<span class="account-item-email">' + esc(a.email) + '</span>' +
      '</div>' +
      '<div class="account-item-right">' +
        (needsSetup ? '<span class="account-setup-badge">Setup</span>' : '') +
        '<span class="account-mode-badge account-mode-' + (a.mode || 'suggestion') + '">' + esc(a.mode || 'suggestion') + '</span>' +
      '</div>' +
    '</div>';
  }).join('');
}

async function switchAccount(accountId) {
  if (accountId === _activeAccountId) {
    _accountDropdownOpen = false;
    document.getElementById('account-dropdown').classList.remove('open');
    return;
  }

  await api('POST', '/api/accounts/active', { accountId });
  _activeAccountId = accountId;
  _accountDropdownOpen = false;
  _credsVisible = false; // Reset creds visibility on account switch
  document.getElementById('account-dropdown').classList.remove('open');

  // Refresh everything for new account
  await loadAccounts();
  await refreshStatus();
  _expandedEmail = null;
  _expandedActivity = null;
  await Promise.all([loadEmails(), loadQueue(), loadActivity(), loadFeedback(), loadAlerts(), loadClassifications()]);
  updateControlsSidebar();
}

// ── Onboarding ───────────────────────────────────────────

function openOnboarding() {
  _onboardingStep = 0;
  _accountDropdownOpen = false;
  document.getElementById('account-dropdown').classList.remove('open');
  document.getElementById('onboarding-overlay').classList.add('open');

  // Reset form fields
  const fields = ['ob-name', 'ob-email', 'ob-voice', 'ob-imap-user', 'ob-imap-pass', 'ob-smtp-user', 'ob-smtp-pass'];
  fields.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('ob-imap-host').value = 'imap.gmail.com';
  document.getElementById('ob-imap-port').value = '993';
  document.getElementById('ob-smtp-host').value = 'smtp.gmail.com';
  document.getElementById('ob-smtp-port').value = '465';

  renderOnboardingStep();
}

function closeOnboarding() {
  document.getElementById('onboarding-overlay').classList.remove('open');
  _onboardingStep = 0;
}

function nextOnboardingStep() {
  if (_onboardingStep === 1) {
    const name = document.getElementById('ob-name').value.trim();
    const email = document.getElementById('ob-email').value.trim();
    if (!name || !email) { alert('Name and email are required.'); return; }
    // Auto-fill IMAP/SMTP user from email if blank
    if (!document.getElementById('ob-imap-user').value) document.getElementById('ob-imap-user').value = email;
    if (!document.getElementById('ob-smtp-user').value) document.getElementById('ob-smtp-user').value = email;
  }

  if (_onboardingStep === 2) {
    // Build review summary
    renderOnboardingReview();
  }

  _onboardingStep++;
  renderOnboardingStep();
}

function prevOnboardingStep() {
  if (_onboardingStep > 0) _onboardingStep--;
  renderOnboardingStep();
}

function renderOnboardingStep() {
  document.querySelectorAll('.ob-step').forEach((s, i) => s.classList.toggle('active', i === _onboardingStep));
  document.querySelectorAll('.ob-dot').forEach((d, i) => {
    d.classList.toggle('active', i === _onboardingStep);
    d.classList.toggle('completed', i < _onboardingStep);
  });
  document.getElementById('ob-prev').style.display = _onboardingStep === 0 ? 'none' : '';
  document.getElementById('ob-next').style.display = _onboardingStep === 3 ? 'none' : '';
  document.getElementById('ob-create').style.display = _onboardingStep === 3 ? '' : 'none';
}

function renderOnboardingReview() {
  const name = document.getElementById('ob-name').value.trim();
  const email = document.getElementById('ob-email').value.trim();
  const imapHost = document.getElementById('ob-imap-host').value;
  const imapUser = document.getElementById('ob-imap-user').value;
  const hasImapPass = !!document.getElementById('ob-imap-pass').value;
  const smtpHost = document.getElementById('ob-smtp-host').value;
  const hasSmtpPass = !!document.getElementById('ob-smtp-pass').value;

  document.getElementById('ob-review').innerHTML =
    '<div style="margin-bottom:0.5rem"><strong>' + esc(name) + '</strong></div>' +
    '<div style="color:var(--text-muted);margin-bottom:0.75rem">' + esc(email) + '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;font-size:0.78rem">' +
      '<div><span style="color:var(--text-dim)">IMAP:</span> ' + esc(imapHost) + '</div>' +
      '<div><span style="color:var(--text-dim)">User:</span> ' + esc(imapUser) + '</div>' +
      '<div><span style="color:var(--text-dim)">SMTP:</span> ' + esc(smtpHost) + '</div>' +
      '<div><span style="color:var(--text-dim)">Creds:</span> ' +
        (hasImapPass ? '<span style="color:var(--green)">Configured</span>' : '<span style="color:var(--orange)">Not set</span>') +
      '</div>' +
    '</div>';
}

async function createAccountFromOnboarding() {
  const btn = document.getElementById('ob-create');
  btn.disabled = true;
  btn.textContent = 'Creating...';

  try {
    const account = {
      name: document.getElementById('ob-name').value.trim(),
      email: document.getElementById('ob-email').value.trim(),
      voiceProfile: document.getElementById('ob-voice').value.trim(),
      imap: {
        host: document.getElementById('ob-imap-host').value.trim() || 'imap.gmail.com',
        port: parseInt(document.getElementById('ob-imap-port').value, 10) || 993,
        user: document.getElementById('ob-imap-user').value.trim(),
        pass: document.getElementById('ob-imap-pass').value.trim(),
      },
      smtp: {
        host: document.getElementById('ob-smtp-host').value.trim() || 'smtp.gmail.com',
        port: parseInt(document.getElementById('ob-smtp-port').value, 10) || 465,
        user: document.getElementById('ob-smtp-user').value.trim(),
        pass: document.getElementById('ob-smtp-pass').value.trim(),
      },
    };

    const result = await api('POST', '/api/accounts', account);
    if (result.success) {
      closeOnboarding();
      await loadAccounts();
      await switchAccount(result.account.id);
    } else {
      alert('Failed to create account: ' + (result.error || 'Unknown error'));
    }
  } catch (e) {
    alert('Error creating account: ' + e.message);
  }

  btn.disabled = false;
  btn.textContent = 'Create Account';
}

// ── Controls Sidebar ─────────────────────────────────────

function openControls() {
  document.getElementById('controls-overlay').classList.add('open');
  document.getElementById('controls-sidebar').classList.add('open');
  updateControlsSidebar();
}

function closeControls() {
  document.getElementById('controls-overlay').classList.remove('open');
  document.getElementById('controls-sidebar').classList.remove('open');
}

function updateControlsSidebar() {
  const active = _accounts.find(a => a.id === _activeAccountId);
  if (!active) return;

  // Account info
  document.getElementById('ctrl-account-name').textContent = active.name;
  document.getElementById('ctrl-account-email').textContent = active.email;

  const statusEl = document.getElementById('ctrl-account-status');
  if (active.needsSetup) {
    statusEl.innerHTML = '<span class="dot pending"></span> <span>Needs setup — enter credentials below</span>';
  } else {
    statusEl.innerHTML = '<span class="dot connected"></span> <span>Connected</span>';
  }

  // Mode buttons
  document.querySelectorAll('.ctrl-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === active.mode);
  });

  // Mode description
  const modeDescs = {
    suggestion: 'Classify and label only. No drafting or sending. Safe observation mode.',
    internal: 'Classify, tag, organize, and draft responses. All drafts queued for your approval.',
    auto: 'Full autonomy: classify, tag, organize, draft, and send (rate-limited). Use with caution.',
  };
  document.getElementById('ctrl-mode-desc').textContent = modeDescs[active.mode] || modeDescs.suggestion;

  // Permissions
  renderPermissionToggles(active);

  // Whitelist sidebar
  renderWhitelistSection();

  // Blacklist sidebar
  renderBlacklistSection();

  // Pending trash
  loadPendingTrash();

  // Classifications
  loadClassifications();

  // Credentials section
  updateCredsSection();

  // Settings inputs (only update when not focused)
  const settingsDrawer = document.getElementById('controls-sidebar');
  if (settingsDrawer.classList.contains('open')) {
    const interval = document.getElementById('set-interval');
    const rate = document.getElementById('set-rate');
    const voice = document.getElementById('set-voice');
    const lookback = document.getElementById('set-lookback');
    if (document.activeElement !== interval) interval.value = active._settings?.checkIntervalMinutes || interval.value;
    if (document.activeElement !== voice) voice.value = active.voiceProfile || '';
  }
}

const MODE_CAPS = {
  suggestion: { classify: true, tag: true, organize: false, draft: false, send: false, moveEmails: false },
  internal:   { classify: true, tag: true, organize: true,  draft: true,  send: false, moveEmails: true },
  auto:       { classify: true, tag: true, organize: true,  draft: true,  send: true,  moveEmails: true },
};

function renderPermissionToggles(account) {
  const mode = account.mode || 'suggestion';
  const caps = MODE_CAPS[mode];
  const perms = account.permissions || {};

  const permDefs = [
    { key: 'classify', label: 'Classify Emails', desc: 'AI reads and categorizes incoming emails', icon: '&#128270;' },
    { key: 'label', label: 'Label Emails', desc: 'Apply Gmail labels and priority', icon: '&#127991;' },
    { key: 'organize', label: 'Organize Inbox', desc: 'Sort emails into folders automatically', icon: '&#128193;' },
    { key: 'draft', label: 'Draft Responses', desc: 'AI writes reply drafts for your review', icon: '&#9997;' },
    { key: 'send', label: 'Send Emails', desc: 'Auto-send responses (rate limited)', icon: '&#128228;' },
    { key: 'moveEmails', label: 'Move Emails', desc: 'Archive, star, or move to folders', icon: '&#128194;' },
  ];

  const container = document.getElementById('ctrl-permissions');
  container.innerHTML = permDefs.map(p => {
    const modeAllows = caps[p.key] === true;
    const isEnabled = perms[p.key] !== false;
    const effective = modeAllows && isEnabled;
    const modeLabel = modeAllows ? '' : 'Requires ' + (p.key === 'send' ? 'Auto' : p.key === 'draft' || p.key === 'organize' || p.key === 'moveEmails' ? 'Internal' : 'Suggestion') + ' mode or higher';

    return '<div class="perm-toggle' + (!modeAllows ? ' disabled' : '') + '">' +
      '<div class="perm-info">' +
        '<span class="perm-label">' + p.icon + ' ' + esc(p.label) + '</span>' +
        '<span class="perm-desc">' + esc(p.desc) + '</span>' +
        (!modeAllows ? '<span class="perm-locked">' + esc(modeLabel) + '</span>' : '') +
      '</div>' +
      '<label class="toggle-switch' + (!modeAllows ? ' disabled' : '') + '">' +
        '<input type="checkbox"' + (effective ? ' checked' : '') + (modeAllows ? '' : ' disabled') +
          ' onchange="togglePermission(\'' + p.key + '\', this.checked)">' +
        '<span class="toggle-slider"></span>' +
      '</label>' +
    '</div>';
  }).join('');
}

async function togglePermission(key, value) {
  const active = _accounts.find(a => a.id === _activeAccountId);
  if (!active) return;

  const perms = { ...(active.permissions || {}), [key]: value };
  const result = await api('PATCH', '/api/accounts/' + _activeAccountId + '/permissions', perms);
  if (result.success) {
    active.permissions = result.account.permissions;
    renderPermissionToggles(active);
  }
}

async function setControlsMode(mode) {
  if (mode === 'auto') {
    showModal(
      'Enable Auto Mode?',
      'Auto mode enables autonomous email sending (rate-limited). The agent will respond to whitelisted senders without approval.',
      async () => {
        await api('POST', '/api/mode', { mode });
        const active = _accounts.find(a => a.id === _activeAccountId);
        if (active) active.mode = mode;
        updateControlsSidebar();
        await refreshStatus();
      }
    );
  } else {
    await api('POST', '/api/mode', { mode });
    const active = _accounts.find(a => a.id === _activeAccountId);
    if (active) active.mode = mode;
    updateControlsSidebar();
    await refreshStatus();
  }
}

async function testAccountConnection() {
  const btn = document.getElementById('ctrl-test-btn');
  btn.disabled = true;
  btn.textContent = 'Testing...';

  try {
    const result = await api('POST', '/api/accounts/' + _activeAccountId + '/test-connection');
    if (result.success) {
      btn.textContent = 'Connected!';
      btn.style.borderColor = 'var(--green)';
      btn.style.color = 'var(--green)';
      // Refresh account list to update needsSetup
      await loadAccounts();
      updateControlsSidebar();
    } else {
      btn.textContent = 'Failed: ' + (result.error || 'Unknown');
      btn.style.borderColor = 'var(--red)';
      btn.style.color = 'var(--red)';
    }
  } catch (e) {
    btn.textContent = 'Error: ' + e.message;
    btn.style.borderColor = 'var(--red)';
    btn.style.color = 'var(--red)';
  }

  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = 'Test Connection';
    btn.style.borderColor = '';
    btn.style.color = '';
  }, 3000);
}

async function deleteActiveAccount() {
  const active = _accounts.find(a => a.id === _activeAccountId);
  if (!active) return;

  if (_accounts.length <= 1) {
    alert('Cannot delete the last account.');
    return;
  }

  showModal(
    'Delete Account?',
    'Permanently remove "' + (active.name || active.email) + '"? This cannot be undone.',
    async () => {
      const result = await api('DELETE', '/api/accounts/' + _activeAccountId);
      if (result.success) {
        closeControls();
        await loadAccounts();
        await refreshStatus();
        await Promise.all([loadEmails(), loadQueue(), loadActivity(), loadFeedback(), loadAlerts(), loadClassifications()]);
      } else {
        alert('Delete failed: ' + (result.error || 'Unknown error'));
      }
    }
  );
}

// ── Credentials Setup ────────────────────────────────────

let _credsVisible = false;

function updateCredsSection() {
  const active = _accounts.find(a => a.id === _activeAccountId);
  if (!active) return;

  const wrapper = document.getElementById('ctrl-creds-wrapper');
  const box = document.getElementById('ctrl-creds-box');
  const fields = document.getElementById('ctrl-creds-fields');
  const toggleBtn = document.getElementById('ctrl-creds-toggle-btn');

  // Always show the section — needs-setup accounts get it expanded + highlighted
  wrapper.style.display = '';

  if (active.needsSetup) {
    box.classList.add('needs-setup');
    _credsVisible = true;
    fields.style.display = '';
    toggleBtn.textContent = 'Hide';
  } else {
    box.classList.remove('needs-setup');
    if (!_credsVisible) {
      fields.style.display = 'none';
      toggleBtn.textContent = 'Edit';
    } else {
      fields.style.display = '';
      toggleBtn.textContent = 'Hide';
    }
  }

  // Populate fields from account config
  const imap = active.imap || {};
  const smtp = active.smtp || {};
  document.getElementById('cred-imap-host').value = imap.host || 'imap.gmail.com';
  document.getElementById('cred-imap-port').value = imap.port || 993;
  document.getElementById('cred-imap-user').value = imap.user || active.email || '';
  // Only populate password if it's not a sanitized bullet string
  const imapPass = document.getElementById('cred-imap-pass');
  if (!imap.pass || /^[\u2022]+$/.test(imap.pass)) {
    imapPass.value = '';
    imapPass.placeholder = active.needsSetup ? 'Enter app password' : 'Leave blank to keep current';
  } else {
    imapPass.value = '';
    imapPass.placeholder = 'Leave blank to keep current';
  }

  document.getElementById('cred-smtp-host').value = smtp.host || 'smtp.gmail.com';
  document.getElementById('cred-smtp-port').value = smtp.port || 465;
  document.getElementById('cred-smtp-user').value = smtp.user || active.email || '';
  const smtpPass = document.getElementById('cred-smtp-pass');
  if (!smtp.pass || /^[\u2022]+$/.test(smtp.pass)) {
    smtpPass.value = '';
    smtpPass.placeholder = active.needsSetup ? 'Enter app password' : 'Leave blank to keep current';
  } else {
    smtpPass.value = '';
    smtpPass.placeholder = 'Leave blank to keep current';
  }

  // Show hint for Gmail accounts
  const hint = document.getElementById('ctrl-creds-hint');
  const email = (active.email || '').toLowerCase();
  if (email.includes('gmail.com') || email.includes('googlemail.com')) {
    hint.style.display = '';
  } else {
    hint.style.display = 'none';
  }
}

function toggleCredsSection() {
  _credsVisible = !_credsVisible;
  const fields = document.getElementById('ctrl-creds-fields');
  const toggleBtn = document.getElementById('ctrl-creds-toggle-btn');
  fields.style.display = _credsVisible ? '' : 'none';
  toggleBtn.textContent = _credsVisible ? 'Hide' : 'Edit';
}

function _gatherCredFields() {
  const data = {};
  const imapPass = document.getElementById('cred-imap-pass').value.trim();
  const smtpPass = document.getElementById('cred-smtp-pass').value.trim();

  data.imap = {
    host: document.getElementById('cred-imap-host').value.trim(),
    port: parseInt(document.getElementById('cred-imap-port').value, 10) || 993,
    user: document.getElementById('cred-imap-user').value.trim(),
  };
  if (imapPass) data.imap.pass = imapPass;

  data.smtp = {
    host: document.getElementById('cred-smtp-host').value.trim(),
    port: parseInt(document.getElementById('cred-smtp-port').value, 10) || 465,
    user: document.getElementById('cred-smtp-user').value.trim(),
  };
  if (smtpPass) data.smtp.pass = smtpPass;

  return data;
}

async function saveAccountCredentials() {
  const btn = document.getElementById('ctrl-creds-save');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const creds = _gatherCredFields();
    const result = await api('PATCH', '/api/accounts/' + _activeAccountId, creds);
    if (result.success) {
      btn.textContent = 'Saved!';
      btn.style.borderColor = 'var(--green)';
      btn.style.color = 'var(--green)';
      await loadAccounts();
      updateControlsSidebar();
    } else {
      btn.textContent = 'Failed';
      btn.style.borderColor = 'var(--red)';
      btn.style.color = 'var(--red)';
    }
  } catch (e) {
    btn.textContent = 'Error';
    btn.style.borderColor = 'var(--red)';
    btn.style.color = 'var(--red)';
  }

  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = 'Save Credentials';
    btn.style.borderColor = '';
    btn.style.color = '';
  }, 2000);
}

async function saveAndTestCredentials() {
  const btn = document.getElementById('ctrl-creds-save-test');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const creds = _gatherCredFields();
    const saveResult = await api('PATCH', '/api/accounts/' + _activeAccountId, creds);
    if (!saveResult.success) {
      btn.textContent = 'Save failed';
      btn.style.background = 'var(--red)';
      setTimeout(() => { btn.disabled = false; btn.textContent = 'Save & Test'; btn.style.background = ''; }, 2000);
      return;
    }

    btn.textContent = 'Testing...';
    const testResult = await api('POST', '/api/accounts/' + _activeAccountId + '/test-connection');
    if (testResult.success) {
      btn.textContent = 'Connected!';
      btn.style.background = 'var(--green)';
      await loadAccounts();
      updateControlsSidebar();
    } else {
      btn.textContent = 'Test failed: ' + (testResult.error || 'Unknown');
      btn.style.background = 'var(--red)';
    }
  } catch (e) {
    btn.textContent = 'Error: ' + e.message;
    btn.style.background = 'var(--red)';
  }

  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = 'Save & Test';
    btn.style.background = '';
  }, 3000);
}

// ── Alert Banner ─────────────────────────────────────────

async function loadAlerts() {
  try {
    const data = await api('GET', '/api/alerts');
    renderAlertBanner(data.alerts || []);
  } catch (e) {
    // non-fatal
  }
}

function renderAlertBanner(alerts) {
  const banner = document.getElementById('alert-banner');
  if (!banner) return;
  if (!alerts.length) { banner.style.display = 'none'; banner.innerHTML = ''; return; }

  banner.style.display = 'flex';
  banner.className = 'alert-banner';
  banner.innerHTML =
    '<span class="alert-banner-title">&#9888; Alerts</span>' +
    '<div class="alert-items">' +
      alerts.map(a =>
        '<div class="alert-item">' +
          '<span class="alert-subject" title="' + esc(a.subject) + '">' + esc(a.subject || '(no subject)') + '</span>' +
          '<span class="alert-reason">' + esc(a.reason || '') + '</span>' +
          '<button class="alert-dismiss" onclick="dismissAlert(\'' + a.id + '\')" title="Dismiss">&times;</button>' +
        '</div>'
      ).join('') +
    '</div>';
}

async function dismissAlert(id) {
  await api('POST', '/api/alerts/' + id + '/dismiss');
  await loadAlerts();
}

// ── Date Navigator ───────────────────────────────────────

async function loadDateNav() {
  try {
    const data = await api('GET', '/api/logs/dates');
    _availableDates = data.dates || [];
    const today = data.today || '';
    if (!_currentDate) _currentDate = today;
    renderDateNav();
  } catch (e) {
    console.error('Date nav failed:', e);
  }
}

function renderDateNav() {
  const nav = document.getElementById('date-nav');
  if (!nav) return;

  const idx = _availableDates.indexOf(_currentDate);
  const hasPrev = idx < _availableDates.length - 1;
  const hasNext = idx > 0;
  const label = _currentDate || 'Recent';

  nav.innerHTML =
    '<button class="date-nav-btn" onclick="navDate(-1)" ' + (hasPrev ? '' : 'disabled') + '>&#8592;</button>' +
    '<span class="date-nav-label">' + esc(label) + '</span>' +
    '<button class="date-nav-btn" onclick="navDate(1)" ' + (hasNext ? '' : 'disabled') + '>&#8594;</button>';
}

function navDate(dir) {
  const idx = _availableDates.indexOf(_currentDate);
  const newIdx = idx - dir;
  if (newIdx < 0 || newIdx >= _availableDates.length) return;
  _currentDate = _availableDates[newIdx];
  _expandedEmail = null;
  renderDateNav();
  loadEmails();
  loadActivity();
}

// ── Status ───────────────────────────────────────────────

async function refreshStatus() {
  try {
    const data = await api('GET', '/api/status');
    updateModeControl(data.mode, data.killed);
    updateStats(data.stats, data.rateLimit);
    updateKillResumeButtons(data.killed);
    updateHeaderKilled(data.killed);

    if (data.stats?.lastAction) {
      const t = new Date(data.stats.lastAction);
      document.getElementById('last-check').textContent = 'Last action: ' + t.toLocaleTimeString();
    }

    // Update settings inputs when controls sidebar is closed
    if (data.settings && !document.getElementById('controls-sidebar').classList.contains('open')) {
      document.getElementById('set-interval').value = data.settings.checkIntervalMinutes || 5;
      document.getElementById('set-rate').value = data.settings.rateLimitPerHour || 5;
      document.getElementById('set-voice').value = data.settings.voiceProfile || '';
      document.getElementById('set-lookback').value = data.settings.lookbackMinutes || 60;
    }
  } catch (e) {
    console.error('Status fetch failed:', e);
  }
}

function updateModeControl(mode, killed) {
  document.querySelectorAll('.seg-btn').forEach(btn => {
    btn.className = 'seg-btn';
    if (!killed && btn.dataset.mode === mode) {
      btn.classList.add('active-' + mode);
    }
  });
}

function updateStats(stats, rateLimit) {
  if (!stats) return;
  const byAction = stats.byAction || {};
  document.getElementById('stat-emails').textContent = stats.total || 0;
  document.getElementById('stat-drafts').textContent = byAction.draft || 0;
  document.getElementById('stat-sends').textContent = byAction.send || 0;
  if (rateLimit) {
    document.getElementById('stat-rate').textContent = rateLimit.used + '/' + rateLimit.limit;
    const dot = document.getElementById('stat-rate-dot');
    const ratio = rateLimit.used / rateLimit.limit;
    dot.className = 'stat-dot ' + (ratio >= 1 ? 'red' : ratio >= 0.7 ? 'yellow' : 'green');
  }
}

function updateKillResumeButtons(killed) {
  document.getElementById('btn-kill').style.display = killed ? 'none' : '';
  document.getElementById('btn-resume').style.display = killed ? '' : 'none';
}

function updateHeaderKilled(killed) {
  document.getElementById('header').classList.toggle('killed', killed);
}

// ── Mode (header segmented control) ─────────────────────

async function setMode(mode) {
  if (mode === 'auto') {
    showModal(
      'Enable Auto Mode?',
      'Auto mode will send emails autonomously (rate-limited). The agent will respond to whitelisted senders without approval.',
      async () => {
        await api('POST', '/api/mode', { mode });
        await loadAccounts();
        await refreshStatus();
        updateControlsSidebar();
      }
    );
  } else {
    await api('POST', '/api/mode', { mode });
    await loadAccounts();
    await refreshStatus();
    updateControlsSidebar();
  }
}

// ── Kill / Resume ────────────────────────────────────────

async function killAgent() {
  showModal('Kill Agent?', 'This will immediately stop the agent loop. The audit UI will remain accessible.', async () => {
    await api('POST', '/api/kill');
    await refreshStatus();
  });
}

async function resumeAgent() {
  await api('POST', '/api/resume');
  await refreshStatus();
}

async function checkNow() {
  const btn = document.getElementById('btn-check-now');
  btn.classList.add('loading');
  btn.disabled = true;
  try {
    await api('POST', '/api/check-now');
    await Promise.all([loadEmails(), loadQueue(), loadActivity(), refreshStatus()]);
  } catch (e) {
    console.error('Check failed:', e);
  }
  btn.classList.remove('loading');
  btn.disabled = false;
}

// ── Settings (merged into controls sidebar) ──────────────

function openSettings() {
  openControls();
}

function closeSettings() {
  closeControls();
}

async function saveSettings() {
  await api('PATCH', '/api/settings', {
    checkIntervalMinutes: parseInt(document.getElementById('set-interval').value, 10),
    rateLimitPerHour: parseInt(document.getElementById('set-rate').value, 10),
    voiceProfile: document.getElementById('set-voice').value,
    lookbackMinutes: parseInt(document.getElementById('set-lookback').value, 10),
  });
  await refreshStatus();
  closeControls();
}

// ── Tabs ─────────────────────────────────────────────────

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + tab));
}

// ── Email Grouping ───────────────────────────────────────

function groupActionsByEmail(actions) {
  const map = new Map();

  for (const a of actions) {
    if (!a.emailId) continue;

    if (!map.has(a.emailId)) {
      map.set(a.emailId, {
        emailId: a.emailId,
        sender: a.sender || '--',
        subject: a.subject || '(no subject)',
        date: a.timestamp,
        actions: [],
        labels: [],
        outcome: 'classified',
        draft: null,
      });
    }

    const group = map.get(a.emailId);
    group.actions.push(a);

    if (a.timestamp < group.date) group.date = a.timestamp;

    // Fill in sender/subject from any action that has it
    if (a.sender && group.sender === '--') group.sender = a.sender;
    if (a.subject && group.subject === '(no subject)') group.subject = a.subject;

    if ((a.action === 'tag' || a.action === 'classify' || a.action === 'suggest') && a.details) {
      const d = a.details;
      const found = [];
      if (Array.isArray(d.labels)) d.labels.forEach(t => { if (typeof t === 'string') found.push(t); });
      if (Array.isArray(d.tags)) d.tags.forEach(t => { if (typeof t === 'string') found.push(t); }); // legacy compat
      if (Array.isArray(d.labels)) d.labels.forEach(t => { if (typeof t === 'string') found.push(t); });
      if (d.classification && typeof d.classification === 'object') {
        if (Array.isArray(d.classification.labels)) d.classification.labels.forEach(t => { if (typeof t === 'string') found.push(t); });
        if (Array.isArray(d.classification.tags)) d.classification.tags.forEach(t => { if (typeof t === 'string') found.push(t); }); // legacy compat
        if (typeof d.classification.priority === 'string' && d.classification.priority !== 'normal') found.push(d.classification.priority);
      }
      if (typeof d.category === 'string') found.push(d.category);
      if (typeof d.classification === 'string') found.push(d.classification);
      for (const t of found) {
        if (!group.labels.includes(t)) group.labels.push(t);
      }
    }

    const priority = { skip: 1, classify: 2, label: 3, tag: 3, suggest: 3, organize: 3, queue: 4, draft: 5, send: 6, 'arl-draft': 5, 'arl-respond': 6, error: 7, 'arl-respond-failed': 7 };
    const currentPri = priority[group.outcome] || 0;
    const newPri = priority[a.action] || 0;
    if (newPri > currentPri) {
      if (a.action === 'send' || a.action === 'arl-respond') group.outcome = 'sent';
      else if (a.action === 'draft' || a.action === 'queue' || a.action === 'arl-draft') group.outcome = 'draft';
      else if (a.action === 'label' || a.action === 'tag') group.outcome = 'labeled';
      else if (a.action === 'skip') group.outcome = 'skipped';
      else if (a.action === 'error' || a.action === 'arl-respond-failed') group.outcome = 'error';
      else group.outcome = 'classified';
    }

    if ((a.action === 'draft' || a.action === 'queue') && a.details?.draft) {
      group.draft = a.details.draft;
    }
  }

  for (const group of map.values()) {
    group.actions.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  }

  return Array.from(map.values()).sort((a, b) => new Date(b.date) - new Date(a.date));
}

// ── Action detail renderer ──

function renderActionDetails(a) {
  if (!a.details || !Object.keys(a.details).length) return '';

  if (a.action === 'classify' || a.action === 'suggest') {
    const cls = a.details.classification || {};
    const lbls = cls.labels || cls.tags || a.details.labels || a.details.tags || [];
    const pills = lbls.map(t => '<span class="label-pill ' + labelClass(t) + '">' + esc(t) + '</span>').join('');
    const decision = cls.summary || cls.reason || cls.decision || a.details.suggestion || '';

    let out = '';
    if (pills) out += '<div class="classify-tags">' + pills + '</div>';
    if (decision && a.action === 'suggest') {
      out += '<div class="classify-meta">' + esc(decision) + '</div>';
    }
    if (cls.priority && cls.priority !== 'normal') {
      out += '<div class="classify-meta">Priority: <strong>' + esc(cls.priority) + '</strong>';
      if (cls.urgency) out += ' &middot; Urgency: <strong>' + esc(cls.urgency) + '</strong>';
      if (typeof cls.requiresResponse === 'boolean') out += ' &middot; Requires response: <strong>' + (cls.requiresResponse ? 'yes' : 'no') + '</strong>';
      out += '</div>';
    }
    return out;
  }

  return '<div class="timeline-details">' + esc(JSON.stringify(a.details, null, 2)) + '</div>';
}

// ── Tag pill class mapping ───────────────────────────────

function labelClass(lbl) {
  const t = (lbl || '').toLowerCase();
  if (t.includes('urgent') || t.includes('priority')) return 'label-urgent';
  if (t.includes('client') || t.includes('customer')) return 'label-client';
  if (t.includes('internal') || t.includes('team')) return 'label-internal';
  if (t.includes('invoice') || t.includes('billing')) return 'label-invoice';
  if (t.includes('newsletter') || t.includes('marketing')) return 'label-newsletter';
  if (t.includes('task') || t.includes('action')) return 'label-task';
  if (t.includes('info')) return 'label-informational';
  return 'label-default';
}

function outcomeClass(outcome) {
  const map = {
    skipped: 'outcome-skipped',
    classified: 'outcome-classified',
    labeled: 'outcome-labeled',
    tagged: 'outcome-labeled',
    draft: 'outcome-draft',
    sent: 'outcome-sent',
    error: 'outcome-error',
    blacklisted: 'outcome-blacklisted',
    trashed: 'outcome-trashed',
    'auto-trash': 'outcome-auto-trash',
  };
  // Custom classification outcomes start with "cls:"
  if (outcome && outcome.startsWith('cls:')) return 'outcome-classified';
  return map[outcome] || 'outcome-classified';
}

function outcomeLabel(outcome) {
  const map = {
    skipped: 'Skipped',
    classified: 'Classified',
    labeled: 'Labeled',
    tagged: 'Labeled',
    draft: 'Draft Pending',
    sent: 'Sent',
    error: 'Error',
    blacklisted: 'Blacklisted',
    trashed: 'Trashed',
    'auto-trash': 'Auto-Trash',
  };
  // Custom classification outcomes start with "cls:"
  if (outcome && outcome.startsWith('cls:')) return outcome.slice(4);
  return map[outcome] || 'Processed';
}

function avatarInitial(sender) {
  if (!sender || sender === '--') return '?';
  const name = sender.split('@')[0].split(/[._-]/)[0];
  return name.charAt(0).toUpperCase();
}

function avatarColor(sender) {
  const colors = ['#6c5ce7', '#0984e3', '#00b894', '#e17055', '#f39c12', '#00cec9', '#fd79a8'];
  let hash = 0;
  for (let i = 0; i < (sender || '').length; i++) {
    hash = (sender || '').charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

function senderName(sender) {
  if (!sender || sender === '--') return 'Unknown';
  const local = sender.split('@')[0];
  return local.split(/[._-]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ── Inbox Rendering ──────────────────────────────────────

async function loadEmails() {
  if (_expandedEmail !== null) return;

  try {
    const dateParam = _currentDate ? '?date=' + _currentDate : '';
    const data = await api('GET', '/api/emails' + dateParam);
    _emailGroups = (data && data.emails) ? data.emails : [];
    clearLoadedMeta();
    applyInboxFilter();
  } catch (e) {
    console.error('Load emails failed:', e);
  }
}

const OUTCOME_FILTER_MAP = {
  classify: 'classified',
  label: 'labeled',
  tag: 'labeled',
  draft: 'draft',
  send: 'sent',
  skip: 'skipped',
  error: 'error',
};

function applyInboxFilter() {
  const outcomeFilter = (document.getElementById('inbox-filter')?.value || '');
  const search = (document.getElementById('inbox-search')?.value || '').toLowerCase();

  // Blacklisted emails never show in inbox
  let groups = _emailGroups.filter(g => g.outcome !== 'blacklisted');

  if (outcomeFilter) {
    const target = OUTCOME_FILTER_MAP[outcomeFilter] || outcomeFilter;
    groups = groups.filter(g => g.outcome === target);
  }

  if (search) {
    groups = groups.filter(g =>
      (g.sender || '').toLowerCase().includes(search) ||
      (g.subject || '').toLowerCase().includes(search)
    );
  }

  renderInbox(groups);
}

function renderInbox(groups) {
  const list = document.getElementById('inbox-list');
  const empty = document.getElementById('inbox-empty');

  document.getElementById('count-inbox').textContent = groups.length;
  empty.style.display = groups.length ? 'none' : '';
  if (!groups.length) { list.innerHTML = ''; return; }

  list.innerHTML = groups.map((g, i) => {
    const time = new Date(g.date);
    const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateStr = isToday(time) ? timeStr : time.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + timeStr;
    const lbls = (g.labels || []).map(t => '<span class="label-pill ' + labelClass(t) + '">' + esc(t) + '</span>').join('');
    const actionCount = g.actions ? g.actions.length : 0;

    return '<div class="email-card" id="email-' + i + '">' +
      '<div class="email-card-main" onclick="toggleEmailCard(' + i + ')">' +
        '<div class="email-avatar" style="background:' + avatarColor(g.sender) + '">' + avatarInitial(g.sender) + '</div>' +
        '<div class="email-body">' +
          '<div class="email-top">' +
            '<span class="email-sender">' + esc(senderName(g.sender)) + '</span>' +
            '<span class="email-address">' + esc(g.sender) + '</span>' +
          '</div>' +
          '<div class="email-subject">' + esc(g.subject) + '</div>' +
          '<div class="email-meta">' +
            lbls +
            (actionCount > 0 ? '<span style="font-size:0.7rem;color:var(--text-dim);margin-left:0.3rem">&#9654; ' + actionCount + ' action' + (actionCount !== 1 ? 's' : '') + '</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="email-right">' +
          buildOutcomeBadge(g, i) +
          '<span class="email-time">' + dateStr + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="email-detail">' + renderEmailDetail(g, i) + '</div>' +
    '</div>';
  }).join('');
}

function buildOutcomeBadge(g, idx) {
  const outcome = g.outcome || '';
  const cls = outcomeClass(outcome);
  const label = outcomeLabel(outcome);

  // Trashed — show hoverable "x" to undo
  if (outcome === 'trashed') {
    const encodedMsgId = encodeURIComponent(g.emailId || '');
    return '<span class="outcome-badge-wrap">' +
      '<span class="outcome-badge ' + cls + '">' + label + '</span>' +
      '<span class="badge-remove" onclick="event.stopPropagation();undoTrash(\'' + encodedMsgId + '\', ' + idx + ')" title="Undo trash">&times;</span>' +
    '</span>';
  }

  // Custom classification — show hoverable "x" to unassign
  if (outcome.startsWith('cls:') && g.classificationId) {
    const encodedMsgId = encodeURIComponent(g.emailId || '');
    const colorDot = g.classificationColor
      ? '<span class="cls-dot" style="background:' + esc(g.classificationColor) + ';width:6px;height:6px;border-radius:50%;display:inline-block"></span> '
      : '';
    return '<span class="outcome-badge-wrap">' +
      '<span class="outcome-badge ' + cls + '">' + colorDot + label + '</span>' +
      '<span class="badge-remove" onclick="event.stopPropagation();undoClassify(\'' + esc(g.classificationId) + '\', \'' + encodedMsgId + '\', ' + idx + ')" title="Remove classification">&times;</span>' +
    '</span>';
  }

  // Default — plain badge
  const colorDot = (outcome.startsWith('cls:') && g.classificationColor)
    ? '<span class="cls-dot" style="background:' + esc(g.classificationColor) + ';width:6px;height:6px;border-radius:50%;display:inline-block"></span> '
    : '';
  return '<span class="outcome-badge ' + cls + '">' + colorDot + label + '</span>';
}

function renderEmailDetail(group, idx) {
  const safeId = encodeURIComponent(group.emailId || '');
  let html =
    '<div class="email-content-panel">' +
      '<button class="email-content-toggle" id="ec-toggle-' + idx + '" onclick="toggleEmailContent(' + idx + ', \'' + safeId + '\')">' +
        'Email Content' +
        '<span class="chevron">&#8964;</span>' +
      '</button>' +
      '<div class="email-content-body" id="ec-body-' + idx + '">' +
        '<div class="email-content-loading" id="ec-loading-' + idx + '">Loading...</div>' +
      '</div>' +
    '</div>';

  html += '<div class="action-timeline">';

  for (const a of (group.actions || [])) {
    const time = new Date(a.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    html += '<div class="timeline-entry">' +
      '<div class="timeline-dot ' + a.action + '"></div>' +
      '<div class="timeline-content">' +
        '<div class="timeline-header">' +
          '<span class="timeline-action">' + esc(a.action) + '</span>' +
          '<span class="timeline-time">' + time + '</span>' +
        '</div>' +
        '<div class="timeline-reasoning">' + esc(a.reasoning || '') + '</div>' +
        renderActionDetails(a) +
      '</div>' +
    '</div>';
  }

  html += '</div>';

  if (group.draft) {
    html += '<div class="draft-preview">' +
      '<div class="draft-preview-header">Draft Response</div>' +
      '<div class="draft-preview-body">' + esc(group.draft) + '</div>' +
    '</div>';
  }

  // ── Action Bar: Blacklist / Trash / Classify ──
  const isClassified = group.outcome && group.outcome.startsWith('cls:');
  if (group.sender && group.sender !== '--' && group.outcome !== 'blacklisted' && group.outcome !== 'trashed' && !isClassified) {
    const addr = group.sender;
    const domain = addr.split('@')[1] || '';
    const escapedAddr = esc(addr).replace(/'/g, "\\'");
    const escapedSubject = esc(group.subject || '').replace(/'/g, "\\'");
    const encodedMsgId = encodeURIComponent(group.emailId || '');
    html += '<div class="email-actions-bar">';
    // Blacklist
    html += '<button class="btn btn-outline btn-sm btn-danger" onclick="blacklistSender(\'' + escapedAddr + '\', ' + idx + ')">&#128683; Blacklist</button>';
    // Trash
    html += '<button class="btn btn-outline btn-sm btn-danger" onclick="trashEmail(\'' + encodedMsgId + '\', \'' + escapedAddr + '\', \'' + escapedSubject + '\', ' + idx + ')">&#128465; Trash</button>';
    // Classify dropdown
    html += '<div class="classify-dropdown" id="cls-dd-' + idx + '">' +
      '<button class="btn btn-outline btn-sm" onclick="toggleClassifyDropdown(' + idx + ')">&#128196; Classify</button>' +
      '<div class="classify-dropdown-menu" id="cls-menu-' + idx + '"></div>' +
    '</div>';
    // Recompose
    html += '<button class="btn btn-outline btn-sm" style="color:var(--green);border-color:var(--green)" onclick="recomposeEmail(\'' + encodedMsgId + '\', \'' + escapedAddr + '\', \'' + escapedSubject + '\', ' + idx + ')">&#8635; Recompose</button>';
    html += '</div>';
  }

  // ── Classification suggestion pills ──
  if (group.classificationSuggestions && group.classificationSuggestions.length > 0) {
    html += '<div style="padding-top:0.5rem;display:flex;gap:0.3rem;flex-wrap:wrap">';
    for (const s of group.classificationSuggestions) {
      const encodedMsgId = encodeURIComponent(group.emailId || '');
      const escapedAddr = esc(group.sender || '').replace(/'/g, "\\'");
      const escapedSubject = esc(group.subject || '').replace(/'/g, "\\'");
      const clsMatch = _classifications.find(c => c.id === s.classificationId);
      const clsColor = clsMatch ? clsMatch.color : '#6c5ce7';
      html += '<span class="suggestion-pill" onclick="assignEmail(\'' + esc(s.classificationId) + '\', \'' + esc(s.name) + '\', \'' + esc(clsColor) + '\', \'' + encodedMsgId + '\', \'' + escapedAddr + '\', \'' + escapedSubject + '\', ' + idx + ')">' +
        esc(s.name) + ' (' + Math.round((s.confidence || 0) * 100) + '%)' +
      '</span>';
    }
    html += '</div>';
  }

  if (group.outcome === 'skipped' && group.sender && group.sender !== '--') {
    const addr = group.sender;
    const domain = addr.split('@')[1] || '';
    html += '<div class="card-feedback" style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;padding-top:0.75rem;margin-top:0.75rem;border-top:1px solid var(--border)">' +
      '<span style="font-size:0.78rem;color:var(--text-muted);flex:1">Whitelist this sender?</span>' +
      '<button class="btn btn-outline btn-sm" onclick="whitelistSender(\'' + esc(addr) + '\', null, ' + idx + ')">+ Address</button>' +
      (domain ? '<button class="btn btn-outline btn-sm" onclick="whitelistSender(null, \'' + esc(domain) + '\', ' + idx + ')">+ @' + esc(domain) + '</button>' : '') +
      '<button class="btn btn-outline btn-sm" style="color:var(--green);border-color:var(--green)" onclick="reprocessSender(\'' + esc(addr) + '\', null)">&#8635; Recompose</button>' +
    '</div>';
  }

  const firstAction = group.actions && group.actions[0];
  const feedbackOutcomes = ['classified', 'tagged', 'draft', 'sent', 'error'];
  if (firstAction && feedbackOutcomes.includes(group.outcome)) {
    const encodedMsgId = encodeURIComponent(group.emailId || '');
    const escapedAddr = esc(group.sender || '').replace(/'/g, "\\'");
    const escapedSubject = esc(group.subject || '').replace(/'/g, "\\'");
    html += '<div class="card-feedback" style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;padding-top:0.75rem;margin-top:0.75rem;border-top:1px solid var(--border)">' +
      '<div class="card-feedback-form" style="flex:1;flex-wrap:wrap;gap:0.4rem">' +
        '<select id="fb-type-' + idx + '" style="padding:0.3rem 0.5rem;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:inherit;font-size:0.75rem;flex-shrink:0">' +
          '<option value="general">General</option>' +
          '<option value="tone">Tone</option>' +
          '<option value="routing">Routing</option>' +
          '<option value="cc">CC</option>' +
          '<option value="always-respond">Always Respond</option>' +
          '<option value="never-respond">Never Respond</option>' +
        '</select>' +
        '<input type="text" id="fb-email-' + idx + '" placeholder="Add feedback..." style="flex:1;min-width:120px">' +
        '<button class="btn btn-primary btn-sm" onclick="submitEmailFeedback(' + idx + ')">Save</button>' +
      '</div>' +
      '<button class="btn btn-outline btn-sm" style="color:var(--green);border-color:var(--green);flex-shrink:0" onclick="recomposeEmail(\'' + encodedMsgId + '\', \'' + escapedAddr + '\', \'' + escapedSubject + '\', ' + idx + ')">&#8635; Recompose</button>' +
    '</div>';
  }

  // For trashed / custom classified — just show Recompose at bottom-right
  const isCls = group.outcome && group.outcome.startsWith('cls:');
  if ((group.outcome === 'trashed' || isCls) && group.sender && group.sender !== '--') {
    const encodedMsgId = encodeURIComponent(group.emailId || '');
    const escapedAddr = esc(group.sender || '').replace(/'/g, "\\'");
    const escapedSubject = esc(group.subject || '').replace(/'/g, "\\'");
    html += '<div style="display:flex;justify-content:flex-end;padding-top:0.75rem;margin-top:0.75rem;border-top:1px solid var(--border)">' +
      '<button class="btn btn-outline btn-sm" style="color:var(--green);border-color:var(--green)" onclick="recomposeEmail(\'' + encodedMsgId + '\', \'' + escapedAddr + '\', \'' + escapedSubject + '\', ' + idx + ')">&#8635; Recompose</button>' +
    '</div>';
  }

  return html;
}

// ── Email Content Panel ──────────────────────────────────

const _loadedMeta = {};

function clearLoadedMeta() {
  for (const k of Object.keys(_loadedMeta)) delete _loadedMeta[k];
}

async function toggleEmailContent(idx, encodedMsgId) {
  const toggle = document.getElementById('ec-toggle-' + idx);
  const body = document.getElementById('ec-body-' + idx);
  if (!toggle || !body) return;

  const isOpen = body.classList.contains('open');
  body.classList.toggle('open', !isOpen);
  toggle.classList.toggle('open', !isOpen);

  // Cache by emailId (not idx) to survive re-renders
  const cacheKey = decodeURIComponent(encodedMsgId);
  if (!isOpen && !_loadedMeta[cacheKey]) {
    _loadedMeta[cacheKey] = true;
    try {
      const meta = await api('GET', '/api/email-meta/' + encodedMsgId);
      renderEmailContentPanel(idx, meta);
    } catch {
      document.getElementById('ec-loading-' + idx).textContent = 'Content not available.';
    }
  }
}

function renderEmailContentPanel(idx, meta) {
  const loading = document.getElementById('ec-loading-' + idx);
  const body = document.getElementById('ec-body-' + idx);
  if (!loading || !body) return;

  const date = meta.date ? new Date(meta.date).toLocaleString() : '--';

  let html =
    '<div class="email-meta-row"><span class="email-meta-label">From</span><span class="email-meta-value">' + esc(meta.from || meta.fromAddress || '--') + '</span></div>' +
    '<div class="email-meta-row"><span class="email-meta-label">To</span><span class="email-meta-value">' + esc(meta.to || '--') + '</span></div>' +
    '<div class="email-meta-row"><span class="email-meta-label">Subject</span><span class="email-meta-value">' + esc(meta.subject || '(no subject)') + '</span></div>' +
    '<div class="email-meta-row"><span class="email-meta-label">Date</span><span class="email-meta-value">' + esc(date) + '</span></div>';

  if (meta.bodyPreview) {
    html += '<div class="email-body-preview">' + esc(meta.bodyPreview) + (meta.bodyPreview.length >= 600 ? '\n[truncated]' : '') + '</div>';
  }

  if (meta.attachments && meta.attachments.length > 0) {
    html += '<div class="email-attachments">';
    for (const name of meta.attachments) {
      html += '<span class="attachment-chip"><span class="clip">&#128206;</span>' + esc(name) + '</span>';
    }
    html += '</div>';
  }

  body.innerHTML = html;
}

function toggleEmailCard(idx) {
  const card = document.getElementById('email-' + idx);
  if (!card) return;

  if (_expandedEmail === idx) {
    card.classList.remove('expanded');
    _expandedEmail = null;
  } else {
    if (_expandedEmail !== null) {
      const prev = document.getElementById('email-' + _expandedEmail);
      if (prev) prev.classList.remove('expanded');
    }
    card.classList.add('expanded');
    _expandedEmail = idx;
  }
}

async function submitEmailFeedback(idx) {
  const input = document.getElementById('fb-email-' + idx);
  const typeEl = document.getElementById('fb-type-' + idx);
  if (!input) return;
  const comment = input.value.trim();
  if (!comment) return;

  const group = _emailGroups[idx];
  if (!group || !group.actions || !group.actions.length) return;

  const actionId = group.actions[0].id;
  await api('POST', '/api/actions/' + actionId + '/feedback', {
    comment,
    type: typeEl ? typeEl.value : 'general',
    sender: group.sender,
  });

  input.value = '';
  await loadFeedback();
}

async function whitelistSender(address, domain, cardIdx) {
  const label = domain ? '@' + domain : address;
  showModal(
    'Add to Whitelist?',
    'Add ' + label + ' to the whitelist. Future emails from this ' + (domain ? 'domain' : 'address') + ' will be processed by the agent.',
    async () => {
      const body = domain ? { domain } : { address };
      const result = await api('POST', '/api/whitelist/add', body);
      if (result.success) {
        const card = document.getElementById('email-' + cardIdx);
        if (card) {
          const btn = card.querySelector('.wl-added-badge');
          if (!btn) {
            const badge = document.createElement('span');
            badge.className = 'outcome-badge outcome-sent wl-added-badge';
            badge.style.marginLeft = '0.5rem';
            badge.textContent = 'Whitelisted';
            card.querySelector('.email-meta')?.appendChild(badge);
          }
        }
        renderWhitelistSection();
        await loadEmails();
        // Offer to reprocess skipped emails from this sender
        showModal(
          'Reprocess Skipped Emails?',
          'Reprocess previously skipped emails from ' + label + '? They will be re-fetched and run through the pipeline.',
          async () => {
            const rpBody = domain ? { domain } : { sender: address };
            await api('POST', '/api/reprocess', rpBody);
          }
        );
      }
    }
  );
}

// ── Whitelist Sidebar Management ─────────────────────────

async function renderWhitelistSection() {
  const wl = await api('GET', '/api/whitelist');
  const domContainer = document.getElementById('ctrl-wl-domains');
  const addrContainer = document.getElementById('ctrl-wl-addresses');
  if (!domContainer || !addrContainer) return;

  // Domains
  if (wl.domains && wl.domains.length > 0) {
    domContainer.innerHTML = '<div class="wl-label">Domains</div><div class="wl-chips">' +
      wl.domains.map(d =>
        '<span class="wl-chip domain">' + esc(d) +
        ' <button class="wl-chip-remove" onclick="removeWhitelistEntry(null,\'' + esc(d) + '\')">&times;</button>' +
        '</span>'
      ).join('') + '</div>';
  } else {
    domContainer.innerHTML = '';
  }

  // Addresses
  if (wl.addresses && wl.addresses.length > 0) {
    addrContainer.innerHTML = '<div class="wl-label">Addresses</div><div class="wl-chips">' +
      wl.addresses.map(a =>
        '<span class="wl-chip">' + esc(a) +
        ' <button class="wl-chip-remove" onclick="removeWhitelistEntry(\'' + esc(a) + '\',null)">&times;</button>' +
        '</span>'
      ).join('') + '</div>';
  } else {
    addrContainer.innerHTML = '';
  }

  if ((!wl.domains || wl.domains.length === 0) && (!wl.addresses || wl.addresses.length === 0)) {
    domContainer.innerHTML = '<div class="wl-empty">No senders whitelisted yet</div>';
  }
}

async function removeWhitelistEntry(address, domain) {
  const label = domain ? '@' + domain : address;
  showModal(
    'Remove from Whitelist?',
    'Remove ' + label + '? Emails from this ' + (domain ? 'domain' : 'address') + ' will be skipped until re-added.',
    async () => {
      const body = domain ? { domain } : { address };
      await api('POST', '/api/whitelist/remove', body);
      renderWhitelistSection();
    }
  );
}

async function addWhitelistDomain() {
  const input = document.getElementById('wl-add-domain');
  const val = (input.value || '').trim().toLowerCase();
  if (!val) return;
  const result = await api('POST', '/api/whitelist/add', { domain: val });
  if (result.success) { input.value = ''; renderWhitelistSection(); }
}

async function addWhitelistAddress() {
  const input = document.getElementById('wl-add-address');
  const val = (input.value || '').trim().toLowerCase();
  if (!val || !val.includes('@')) return;
  const result = await api('POST', '/api/whitelist/add', { address: val });
  if (result.success) { input.value = ''; renderWhitelistSection(); }
}

async function reprocessSender(sender, domain) {
  const label = domain ? '@' + domain : sender;
  showModal(
    'Recompose',
    'Re-fetch and process emails from ' + label + '. Add optional guidance to shape the draft response.',
    async () => {
      const guidance = (document.getElementById('modal-input')?.value || '').trim();
      const body = domain ? { domain } : { sender };
      if (guidance) body.draftGuidance = guidance;
      await api('POST', '/api/reprocess', body);
      await loadEmails();
    },
    { input: true, inputPlaceholder: 'Draft guidance — e.g. "Keep it brief, mention our Monday availability..."' }
  );
}

async function recomposeEmail(encodedEmailId, sender, subject, cardIdx) {
  showModal(
    'Recompose',
    'Reprocess this email with guidance to shape the draft response.',
    async () => {
      const guidance = (document.getElementById('modal-input')?.value || '').trim();
      const emailId = decodeURIComponent(encodedEmailId);
      await api('POST', '/api/recompose', { emailId, sender, subject, draftGuidance: guidance });
      await Promise.all([loadEmails(), loadQueue(), loadActivity()]);
      // Re-render detail section if this email is expanded
      if (_expandedEmail !== null && _emailGroups[cardIdx]) {
        const card = document.getElementById('email-' + cardIdx);
        if (card) {
          const detail = card.querySelector('.email-detail');
          if (detail) detail.innerHTML = renderEmailDetail(_emailGroups[cardIdx], cardIdx);
        }
      }
    },
    { input: true, inputPlaceholder: 'Draft guidance — e.g. "Politely decline, suggest next week instead..."' }
  );
}

// ── Blacklist Management ─────────────────────────────────

async function blacklistSender(address, cardIdx) {
  showModal(
    'Blacklist Sender?',
    'Blacklist ' + address + '? All future emails from this sender will be moved to trash automatically.',
    async () => {
      await api('POST', '/api/blacklist/add', { address });
      renderBlacklistSection();
      renderWhitelistSection();
      // Fade out and remove the card from inbox
      const card = document.getElementById('email-' + cardIdx);
      if (card) {
        card.style.transition = 'opacity 0.3s, max-height 0.3s';
        card.style.opacity = '0';
        card.style.maxHeight = card.scrollHeight + 'px';
        setTimeout(() => { card.style.maxHeight = '0'; card.style.overflow = 'hidden'; card.style.padding = '0'; card.style.margin = '0'; card.style.border = 'none'; }, 300);
        setTimeout(() => card.remove(), 600);
      }
    }
  );
}

async function renderBlacklistSection() {
  const bl = await api('GET', '/api/blacklist');
  const domContainer = document.getElementById('ctrl-bl-domains');
  const addrContainer = document.getElementById('ctrl-bl-addresses');
  if (!domContainer || !addrContainer) return;

  if (bl.domains && bl.domains.length > 0) {
    domContainer.innerHTML = '<div class="wl-label">Domains</div><div class="wl-chips">' +
      bl.domains.map(d =>
        '<span class="wl-chip bl-chip">' + esc(d) +
        ' <button class="wl-chip-remove" onclick="removeBlacklistEntry(null,\'' + esc(d) + '\')">&times;</button>' +
        '</span>'
      ).join('') + '</div>';
  } else {
    domContainer.innerHTML = '';
  }

  if (bl.addresses && bl.addresses.length > 0) {
    addrContainer.innerHTML = '<div class="wl-label">Addresses</div><div class="wl-chips">' +
      bl.addresses.map(a =>
        '<span class="wl-chip bl-chip">' + esc(a) +
        ' <button class="wl-chip-remove" onclick="removeBlacklistEntry(\'' + esc(a) + '\',null)">&times;</button>' +
        '</span>'
      ).join('') + '</div>';
  } else {
    addrContainer.innerHTML = '';
  }

  if ((!bl.domains || bl.domains.length === 0) && (!bl.addresses || bl.addresses.length === 0)) {
    domContainer.innerHTML = '<div class="wl-empty">No senders blacklisted</div>';
  }
}

async function removeBlacklistEntry(address, domain) {
  const label = domain ? '@' + domain : address;
  showModal(
    'Remove from Blacklist?',
    'Remove ' + label + ' from the blacklist?',
    async () => {
      const body = domain ? { domain } : { address };
      await api('POST', '/api/blacklist/remove', body);
      renderBlacklistSection();
    }
  );
}

async function addBlacklistDomain() {
  const input = document.getElementById('bl-add-domain');
  const val = (input.value || '').trim().toLowerCase();
  if (!val) return;
  const result = await api('POST', '/api/blacklist/add', { domain: val });
  if (result.success) { input.value = ''; renderBlacklistSection(); renderWhitelistSection(); }
}

async function addBlacklistAddress() {
  const input = document.getElementById('bl-add-address');
  const val = (input.value || '').trim().toLowerCase();
  if (!val || !val.includes('@')) return;
  const result = await api('POST', '/api/blacklist/add', { address: val });
  if (result.success) { input.value = ''; renderBlacklistSection(); renderWhitelistSection(); }
}

// ── Trash Management ─────────────────────────────────────

async function trashEmail(encodedEmailId, sender, subject, cardIdx) {
  showModal(
    'Move to Trash?',
    'Move this email to trash and record the pattern? The system will learn to auto-trash similar emails.',
    async () => {
      await api('POST', '/api/trash', {
        emailId: decodeURIComponent(encodedEmailId),
        sender,
        subject,
      });
      // Update badge and re-render detail section
      const card = document.getElementById('email-' + cardIdx);
      if (card) {
        const badge = card.querySelector('.outcome-badge');
        if (badge) {
          const wrap = document.createElement('span');
          wrap.className = 'outcome-badge-wrap';
          wrap.innerHTML = '<span class="outcome-badge outcome-trashed">Trashed</span>' +
            '<span class="badge-remove" onclick="undoTrash(\'' + encodedEmailId + '\', ' + cardIdx + ')" title="Undo trash">&times;</span>';
          badge.replaceWith(wrap);
        }
        if (_emailGroups[cardIdx]) {
          _emailGroups[cardIdx].outcome = 'trashed';
          const detail = card.querySelector('.email-detail');
          if (detail) detail.innerHTML = renderEmailDetail(_emailGroups[cardIdx], cardIdx);
        }
      }
      loadPendingTrash();
    }
  );
}

async function undoTrash(encodedEmailId, cardIdx) {
  const emailId = decodeURIComponent(encodedEmailId);
  await api('POST', '/api/trash/undo', { emailId });

  const card = document.getElementById('email-' + cardIdx);
  if (card) {
    // Restore badge
    const wrap = card.querySelector('.outcome-badge-wrap');
    if (wrap) {
      const badge = document.createElement('span');
      badge.className = 'outcome-badge outcome-skipped';
      badge.textContent = 'Skipped';
      wrap.replaceWith(badge);
    }
    // Update group data and re-render detail section
    if (_emailGroups[cardIdx]) {
      _emailGroups[cardIdx].outcome = 'skipped';
      const detail = card.querySelector('.email-detail');
      if (detail) detail.innerHTML = renderEmailDetail(_emailGroups[cardIdx], cardIdx);
    }
  }
  loadPendingTrash();
}

async function loadPendingTrash() {
  const result = await api('GET', '/api/trash/pending');
  const container = document.getElementById('ctrl-pending-trash');
  const badge = document.getElementById('pending-trash-count');
  if (!container) return;

  const items = result.items || [];
  if (items.length === 0) {
    container.innerHTML = '<div class="wl-empty">No pending auto-trash</div>';
    if (badge) badge.style.display = 'none';
    return;
  }

  if (badge) {
    badge.textContent = items.length;
    badge.style.display = 'inline';
  }

  container.innerHTML = items.map(item => {
    const moveAfter = new Date(item.moveAfter);
    const now = new Date();
    const hoursLeft = Math.max(0, Math.round((moveAfter - now) / 3600000));
    return '<div class="pending-trash-item">' +
      '<div style="flex:1;overflow:hidden">' +
        '<div style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(item.sender) + '</div>' +
        '<div style="color:var(--text-dim);font-size:0.7rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(item.subject || '') + '</div>' +
      '</div>' +
      '<span style="color:var(--yellow);font-size:0.7rem;flex-shrink:0">' + hoursLeft + 'h</span>' +
      '<button class="btn btn-outline btn-sm" style="flex-shrink:0;color:var(--green);border-color:var(--green);font-size:0.7rem;padding:0.2rem 0.4rem" onclick="overrideTrash(\'' + esc(item.id) + '\')">Rescue</button>' +
    '</div>';
  }).join('');
}

async function overrideTrash(entryId) {
  await api('POST', '/api/trash/' + encodeURIComponent(entryId) + '/override');
  loadPendingTrash();
}

// ── Classification Management ────────────────────────────

let _classifications = [];

async function loadClassifications() {
  const result = await api('GET', '/api/classifications');
  _classifications = result.classifications || result || [];
  renderClassificationsSection();
}

function renderClassificationsSection() {
  const container = document.getElementById('ctrl-classifications');
  if (!container) return;

  if (!_classifications.length) {
    container.innerHTML = '<div class="wl-empty">No custom classifications yet</div>';
    return;
  }

  container.innerHTML = _classifications.map(cls => {
    const assignCount = (cls.assignments || []).length;
    const understandingCount = (cls.understandings || []).length;
    return '<div class="cls-chip">' +
      '<span class="cls-dot" style="background:' + esc(cls.color || '#6c5ce7') + '"></span>' +
      '<span style="flex:1">' + esc(cls.name) + '</span>' +
      '<span style="color:var(--text-dim);font-size:0.7rem">' + assignCount + ' emails</span>' +
      (understandingCount > 0 ? '<span style="color:var(--text-dim);font-size:0.7rem">' + understandingCount + ' patterns</span>' : '') +
      '<button class="wl-chip-remove" onclick="deleteClassification(\'' + esc(cls.id) + '\')">&times;</button>' +
    '</div>';
  }).join('');
}

async function createClassification() {
  const input = document.getElementById('cls-add-name');
  const name = (input.value || '').trim();
  if (!name) return;
  const colors = ['#0984e3', '#6c5ce7', '#00b894', '#fdcb6e', '#e17055', '#00cec9', '#f39c12'];
  const color = colors[Math.floor(Math.random() * colors.length)];
  const result = await api('POST', '/api/classifications', { name, color });
  if (result.id || result.success) {
    input.value = '';
    await loadClassifications();
  }
}

async function deleteClassification(id) {
  showModal(
    'Delete Classification?',
    'This will remove the classification and all its assignments. Continue?',
    async () => {
      await api('DELETE', '/api/classifications/' + encodeURIComponent(id));
      await loadClassifications();
    }
  );
}

function toggleClassifyDropdown(idx) {
  const menu = document.getElementById('cls-menu-' + idx);
  if (!menu) return;

  const isOpen = menu.classList.contains('open');

  // Close all other dropdowns
  document.querySelectorAll('.classify-dropdown-menu.open').forEach(m => m.classList.remove('open'));

  if (!isOpen) {
    const group = _emailGroups[idx];
    const encodedMsgId = encodeURIComponent(group?.emailId || '');
    const escapedAddr = esc(group?.sender || '').replace(/'/g, "\\'");
    const escapedSubject = esc(group?.subject || '').replace(/'/g, "\\'");

    // Tag input at top
    let menuHtml = '<div style="padding:0.5rem 0.75rem;border-bottom:1px solid var(--border);display:flex;gap:0.3rem">' +
      '<input type="text" id="cls-input-' + idx + '" placeholder="New tag..." ' +
        'style="flex:1;background:var(--surface-3);border:1px solid var(--border);border-radius:var(--radius);padding:0.3rem 0.5rem;font-size:0.78rem;color:var(--text);outline:none" ' +
        'onkeydown="if(event.key===\'Enter\'){event.preventDefault();createAndAssignTag(' + idx + ')}">' +
      '<button class="btn btn-outline btn-sm" onclick="createAndAssignTag(' + idx + ')" style="padding:0.2rem 0.5rem;font-size:0.78rem">+</button>' +
    '</div>';

    // Existing classifications
    if (_classifications.length) {
      menuHtml += _classifications.map(cls =>
        '<div class="cls-option" onclick="assignEmail(\'' + esc(cls.id) + '\', \'' + esc(cls.name) + '\', \'' + esc(cls.color || '#6c5ce7') + '\', \'' + encodedMsgId + '\', \'' + escapedAddr + '\', \'' + escapedSubject + '\', ' + idx + ')">' +
          '<span class="cls-dot" style="background:' + esc(cls.color || '#6c5ce7') + '"></span>' +
          esc(cls.name) +
        '</div>'
      ).join('');
    }

    // Needs Reply checkbox
    menuHtml += '<div style="padding:0.5rem 0.75rem;border-top:1px solid var(--border);display:flex;align-items:center;gap:0.4rem">' +
      '<input type="checkbox" id="cls-needs-reply-' + idx + '" style="accent-color:var(--accent)">' +
      '<label for="cls-needs-reply-' + idx + '" style="font-size:0.75rem;color:var(--text-muted);cursor:pointer">Needs Reply</label>' +
    '</div>';

    // Needs Action checkbox + expandable panel
    menuHtml += '<div style="padding:0.5rem 0.75rem;border-top:1px solid var(--border)">' +
      '<div style="display:flex;align-items:center;gap:0.4rem">' +
        '<input type="checkbox" id="cls-needs-action-' + idx + '" style="accent-color:var(--accent)" onchange="toggleActionPanel(' + idx + ')">' +
        '<label for="cls-needs-action-' + idx + '" style="font-size:0.75rem;color:var(--text-muted);cursor:pointer">Needs Action</label>' +
      '</div>' +
      '<div id="cls-action-panel-' + idx + '" style="display:none;margin-top:0.5rem;font-size:0.75rem">' +
        // Mark as Spam
        '<div style="margin-bottom:0.4rem">' +
          '<label style="display:flex;align-items:center;gap:0.3rem;color:var(--text-muted);cursor:pointer">' +
            '<input type="checkbox" id="cls-act-spam-' + idx + '" style="accent-color:var(--red)">' +
            '<span style="color:var(--red)">Mark as Spam</span>' +
          '</label>' +
        '</div>' +
        // Move to folder
        '<div style="margin-bottom:0.4rem">' +
          '<label style="display:flex;align-items:center;gap:0.3rem;color:var(--text-muted);cursor:pointer">' +
            '<input type="checkbox" id="cls-act-folder-' + idx + '" style="accent-color:var(--accent)" onchange="toggleActionField(\'cls-act-folder-val-' + idx + '\', this.checked)">' +
            'Move to folder' +
          '</label>' +
          '<input type="text" id="cls-act-folder-val-' + idx + '" placeholder="Folder name..." style="display:none;margin-top:0.25rem;width:100%;background:var(--surface-3);border:1px solid var(--border);border-radius:var(--radius);padding:0.25rem 0.4rem;font-size:0.75rem;color:var(--text)">' +
        '</div>' +
        // Delete after
        '<div style="margin-bottom:0.4rem">' +
          '<label style="display:flex;align-items:center;gap:0.3rem;color:var(--text-muted);cursor:pointer">' +
            '<input type="checkbox" id="cls-act-delete-' + idx + '" style="accent-color:var(--accent)" onchange="toggleActionField(\'cls-act-delete-row-' + idx + '\', this.checked)">' +
            'Delete after' +
          '</label>' +
          '<div id="cls-act-delete-row-' + idx + '" style="display:none;margin-top:0.25rem;display:none;gap:0.3rem;align-items:center">' +
            '<input type="number" id="cls-act-delete-val-' + idx + '" min="1" value="30" style="width:50px;background:var(--surface-3);border:1px solid var(--border);border-radius:var(--radius);padding:0.25rem 0.4rem;font-size:0.75rem;color:var(--text)">' +
            '<select id="cls-act-delete-unit-' + idx + '" style="background:var(--surface-3);border:1px solid var(--border);border-radius:var(--radius);padding:0.25rem 0.4rem;font-size:0.75rem;color:var(--text)">' +
              '<option value="days">days</option><option value="weeks">weeks</option><option value="months">months</option>' +
            '</select>' +
          '</div>' +
        '</div>' +
        // Forward to
        '<div style="margin-bottom:0.4rem">' +
          '<label style="display:flex;align-items:center;gap:0.3rem;color:var(--text-muted);cursor:pointer">' +
            '<input type="checkbox" id="cls-act-fwd-' + idx + '" style="accent-color:var(--accent)" onchange="toggleActionField(\'cls-act-fwd-val-' + idx + '\', this.checked)">' +
            'Forward to' +
          '</label>' +
          '<input type="email" id="cls-act-fwd-val-' + idx + '" placeholder="email@example.com" style="display:none;margin-top:0.25rem;width:100%;background:var(--surface-3);border:1px solid var(--border);border-radius:var(--radius);padding:0.25rem 0.4rem;font-size:0.75rem;color:var(--text)">' +
        '</div>' +
        // Create TeamHub task
        '<div>' +
          '<label style="display:flex;align-items:center;gap:0.3rem;color:var(--text-muted);cursor:pointer">' +
            '<input type="checkbox" id="cls-act-task-' + idx + '" style="accent-color:var(--accent)">' +
            'Create TeamHub task' +
          '</label>' +
        '</div>' +
      '</div>' +
    '</div>';

    menu.innerHTML = menuHtml;
    menu.classList.add('open');

    // Focus the input
    setTimeout(() => {
      const inp = document.getElementById('cls-input-' + idx);
      if (inp) inp.focus();
    }, 50);
  }
}

function toggleActionPanel(idx) {
  const cb = document.getElementById('cls-needs-action-' + idx);
  const panel = document.getElementById('cls-action-panel-' + idx);
  if (panel) panel.style.display = cb?.checked ? 'block' : 'none';
}

function toggleActionField(elId, show) {
  const el = document.getElementById(elId);
  if (el) el.style.display = show ? (el.tagName === 'DIV' ? 'flex' : 'block') : 'none';
}

function collectActions(idx) {
  const needsAction = document.getElementById('cls-needs-action-' + idx)?.checked;
  if (!needsAction) return null;

  const actions = [];

  if (document.getElementById('cls-act-spam-' + idx)?.checked) {
    actions.push({ type: 'mark-spam' });
  }

  if (document.getElementById('cls-act-folder-' + idx)?.checked) {
    const folder = (document.getElementById('cls-act-folder-val-' + idx)?.value || '').trim();
    if (folder) actions.push({ type: 'move-to-folder', folder });
  }

  if (document.getElementById('cls-act-delete-' + idx)?.checked) {
    const val = parseInt(document.getElementById('cls-act-delete-val-' + idx)?.value || '30', 10);
    const unit = document.getElementById('cls-act-delete-unit-' + idx)?.value || 'days';
    actions.push({ type: 'delete-after', value: val, unit });
  }

  if (document.getElementById('cls-act-fwd-' + idx)?.checked) {
    const email = (document.getElementById('cls-act-fwd-val-' + idx)?.value || '').trim();
    if (email) actions.push({ type: 'forward-to', email });
  }

  if (document.getElementById('cls-act-task-' + idx)?.checked) {
    actions.push({ type: 'create-task' });
  }

  return actions.length ? actions : null;
}

async function createAndAssignTag(cardIdx) {
  const input = document.getElementById('cls-input-' + cardIdx);
  const name = (input?.value || '').trim();
  if (!name) return;

  const group = _emailGroups[cardIdx];
  if (!group) return;

  // Check if a classification with this name already exists (case-insensitive)
  const existing = _classifications.find(c => c.name.toLowerCase() === name.toLowerCase());
  let cls;
  if (existing) {
    cls = existing;
  } else {
    // Create it on the fly
    const colors = ['#0984e3', '#6c5ce7', '#00b894', '#fdcb6e', '#e17055', '#00cec9', '#f39c12'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    const result = await api('POST', '/api/classifications', { name, color });
    if (!result.id && !result.success) return;
    cls = { id: result.id, name, color };
    await loadClassifications();
  }

  const encodedMsgId = encodeURIComponent(group.emailId || '');
  const sender = group.sender || '';
  const subject = group.subject || '';
  await assignEmail(cls.id, cls.name, cls.color || '#6c5ce7', encodedMsgId, sender, subject, cardIdx);
}

async function assignEmail(clsId, clsName, clsColor, encodedEmailId, sender, subject, cardIdx) {
  const emailId = decodeURIComponent(encodedEmailId);
  const needsReply = document.getElementById('cls-needs-reply-' + cardIdx)?.checked || false;
  const actions = collectActions(cardIdx);
  const resp = await api('POST', '/api/classifications/' + encodeURIComponent(clsId) + '/assign', {
    emailId, sender, subject, labels: [], needsReply, actions,
  });
  // Close any open dropdowns
  document.querySelectorAll('.classify-dropdown-menu.open').forEach(m => m.classList.remove('open'));

  // Swap the outcome badge and re-render detail section
  const card = document.getElementById('email-' + cardIdx);
  if (card) {
    const badge = card.querySelector('.outcome-badge') || card.querySelector('.outcome-badge-wrap');
    if (badge) {
      const wrap = document.createElement('span');
      wrap.className = 'outcome-badge-wrap';
      wrap.innerHTML = '<span class="outcome-badge outcome-classified">' +
        '<span class="cls-dot" style="background:' + esc(clsColor) + ';width:6px;height:6px;border-radius:50%;display:inline-block"></span> ' +
        esc(clsName) + '</span>' +
        '<span class="badge-remove" onclick="undoClassify(\'' + esc(clsId) + '\', \'' + encodedEmailId + '\', ' + cardIdx + ')" title="Remove classification">&times;</span>';
      badge.replaceWith(wrap);
    }
    // Update group data and re-render detail section
    if (_emailGroups[cardIdx]) {
      _emailGroups[cardIdx].outcome = 'cls:' + clsName;
      _emailGroups[cardIdx].classificationId = clsId;
      _emailGroups[cardIdx].classificationColor = clsColor;
      const detail = card.querySelector('.email-detail');
      if (detail) detail.innerHTML = renderEmailDetail(_emailGroups[cardIdx], cardIdx);
    }
  }

  // Show action results toast if any actions were executed
  const executed = resp?.executedActions || [];
  if (executed.length > 0) {
    const msgs = executed.map(a => {
      if (a.type === 'label') return a.success ? 'Label applied to Gmail' : 'Label failed';
      if (a.type === 'mark-spam') return a.success ? 'Marked as spam + blacklisted' : 'Spam marking failed';
      if (a.type === 'move-to-folder') return a.success ? 'Moved to ' + a.folder : 'Move failed';
      if (a.type === 'forward-to') return a.success ? 'Forwarded to ' + a.email : 'Forward failed';
      if (a.type === 'delete-after') return a.success ? 'Scheduled for deletion' : 'Schedule failed';
      if (a.type === 'create-task') return a.success ? 'Task created' : 'Task creation failed';
      return a.type + (a.success ? ' done' : ' failed');
    });
    showToast(msgs.join(' | '), executed.every(a => a.success) ? 'success' : 'warning');
  } else {
    showToast('Classified as ' + clsName, 'success');
  }

  // Full reload to pick up new action timeline entries + updated state
  _expandedEmail = null; // allow loadEmails to run
  await Promise.all([loadEmails(), loadClassifications()]);
  // Re-expand the card we just classified
  const newIdx = _emailGroups.findIndex(g => g.emailId === emailId);
  if (newIdx !== -1) toggleEmailCard(newIdx);
}

async function undoClassify(clsId, encodedEmailId, cardIdx) {
  const emailId = decodeURIComponent(encodedEmailId);
  await api('POST', '/api/classifications/' + encodeURIComponent(clsId) + '/unassign', { emailId });

  // Full reload to get clean data — avoids stale DOM/group state
  _expandedEmail = null;
  await Promise.all([loadEmails(), loadClassifications(), loadActivity()]);
  await loadClassifications();
}

function filterInbox() {
  applyInboxFilter();
}

function isToday(date) {
  const now = new Date();
  return date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();
}

// ── Queue Rendering ──────────────────────────────────────

let _queueItems = [];   // cached items for re-render without fetch

async function loadQueue() {
  // Never touch the queue DOM while user is mid-edit
  if (Object.keys(_editingQueue).length > 0) return;

  const [pending, edited] = await Promise.all([
    api('GET', '/api/queue?status=pending'),
    api('GET', '/api/queue?status=edited'),
  ]);
  _queueItems = [...(pending.items || []), ...(edited.items || [])];
  renderQueue();
}

function renderQueue() {
  const items = _queueItems;
  const list = document.getElementById('queue-list');

  document.getElementById('count-queue').textContent = items.length;
  document.getElementById('queue-empty').style.display = items.length ? 'none' : '';

  list.innerHTML = items.map(item => {
    const isEditing = _editingQueue[item.id];
    const isExpanded = _expandedQueueDraft[item.id];
    const draftText = item.draft || '';
    const isLong = draftText.length > 300;
    const noDraft = !draftText;

    return '<div class="queue-card" id="qcard-' + item.id + '">' +
      '<div class="queue-left">' +
        '<h4>' + esc(item.subject) + '</h4>' +
        '<div class="queue-sender">From: ' + esc(item.sender) + ' &middot; ' + new Date(item.createdAt).toLocaleString() + '</div>' +
        (item.reason ? '<div class="queue-reason">' + esc(item.reason) + '</div>' : '') +
        (item.savedToGmail ? '<div class="queue-saved-badge">Saved to Gmail Drafts</div>' : '') +
      '</div>' +
      '<div class="queue-right">' +
        '<div class="queue-right-header">Draft Response' +
          (item.status === 'edited' ? ' <span class="queue-edited-badge">Edited</span>' : '') +
        '</div>' +
        (isEditing
          ? '<textarea class="queue-draft-edit" id="edit-' + item.id + '">' + esc(draftText) + '</textarea>'
          : noDraft
            ? '<div class="queue-draft-text expanded" style="color:var(--text-muted);font-style:italic">No draft generated yet. Use Regenerate to create one.</div>'
            : '<div class="queue-draft-text' + (isExpanded || !isLong ? ' expanded' : '') + '" id="draft-' + item.id + '">' + esc(draftText) + '</div>' +
              (isLong && !isExpanded ? '<button class="btn-link queue-expand-btn" onclick="toggleQueueDraft(\'' + item.id + '\')">Show full draft</button>' : '') +
              (isLong && isExpanded ? '<button class="btn-link queue-expand-btn" onclick="toggleQueueDraft(\'' + item.id + '\')">Show less</button>' : '')
        ) +
      '</div>' +
      '<div class="queue-actions">' +
        (isEditing
          ? '<button class="btn btn-green btn-sm" onclick="saveQueueEdit(\'' + item.id + '\')">Save &amp; Exit</button>' +
            '<button class="btn btn-outline btn-sm" onclick="cancelQueueEdit(\'' + item.id + '\')">Cancel</button>'
          : (draftText ? '<button class="btn btn-green btn-sm" onclick="approveQueue(\'' + item.id + '\')" id="approve-' + item.id + '">Approve &amp; Send</button>' : '') +
            (draftText ? '<button class="btn btn-outline btn-sm" onclick="saveDraftToGmail(\'' + item.id + '\')">Save to Drafts</button>' : '') +
            '<button class="btn btn-outline btn-sm" onclick="startQueueEdit(\'' + item.id + '\')">&#9998; Edit</button>' +
            '<button class="btn btn-outline btn-sm" style="color:var(--green);border-color:var(--green)" onclick="regenerateQueueDraft(\'' + item.id + '\', \'' + esc(item.sender || '').replace(/'/g, "\\'") + '\', \'' + esc(item.subject || '').replace(/'/g, "\\'") + '\')">&#8635; Regenerate</button>' +
            '<button class="btn btn-red btn-sm" onclick="rejectQueue(\'' + item.id + '\')">Reject</button>'
        ) +
      '</div>' +
    '</div>';
  }).join('');
}

async function approveQueue(id) {
  showModal('Approve and Send?', 'This will send the draft email as a reply from this account.', async () => {
    const btn = document.getElementById('modal-confirm');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }
    const result = await api('POST', '/api/queue/' + id + '/approve');
    if (result.error) {
      showToast('Send failed: ' + result.error, 'error');
      return;
    }
    showToast('Email sent successfully');
    _queueItems = _queueItems.filter(i => i.id !== id);
    renderQueue();
    loadActivity();
    refreshStatus();
  });
}

async function saveDraftToGmail(id) {
  const approveBtn = document.getElementById('approve-' + id);
  const card = document.getElementById('qcard-' + id);
  if (card) card.style.opacity = '0.6';
  try {
    const result = await api('POST', '/api/queue/' + id + '/save-draft');
    if (result.error) {
      showToast('Save failed: ' + result.error, 'error');
    } else {
      showToast('Draft saved to Gmail Drafts');
      const cached = _queueItems.find(i => i.id === id);
      if (cached) cached.savedToGmail = true;
    }
  } catch (err) {
    showToast('Save failed: ' + err.message, 'error');
  }
  if (card) card.style.opacity = '1';
  renderQueue();
}

function startQueueEdit(id) {
  _editingQueue[id] = true;
  renderQueue();  // renders from _queueItems cache, no fetch
  const ta = document.getElementById('edit-' + id);
  if (ta) ta.focus();
}

function cancelQueueEdit(id) {
  delete _editingQueue[id];
  renderQueue();  // re-renders read-only view from cache
}

async function saveQueueEdit(id) {
  const textarea = document.getElementById('edit-' + id);
  if (!textarea) return;
  const draft = textarea.value;
  await api('POST', '/api/queue/' + id + '/edit', { draft });
  delete _editingQueue[id];
  // Update cached item with new draft
  const item = _queueItems.find(i => i.id === id);
  if (item) { item.draft = draft; item.status = 'edited'; }
  renderQueue();
}

async function rejectQueue(id) {
  // Remove card immediately, call API in background
  const card = document.getElementById('qcard-' + id);
  if (card) card.style.opacity = '0.3';
  await api('POST', '/api/queue/' + id + '/reject', { reason: 'Rejected from UI' });
  _queueItems = _queueItems.filter(i => i.id !== id);
  renderQueue();
  loadActivity();
}

function toggleQueueDraft(id) {
  _expandedQueueDraft[id] = !_expandedQueueDraft[id];
  renderQueue();
}

async function regenerateQueueDraft(id, sender, subject) {
  showModal(
    'Regenerate Draft',
    '',
    async () => {
      const guidance = (document.getElementById('modal-input')?.value || '').trim();
      const model = document.getElementById('regen-model')?.value || 'haiku';
      const length = document.getElementById('regen-length')?.value || 'simple';
      const btn = document.getElementById('modal-confirm');
      if (btn) { btn.disabled = true; btn.textContent = 'Generating draft...'; }
      try {
        const result = await api('POST', '/api/queue/' + id + '/regenerate', {
          draftGuidance: guidance || undefined,
          model,
          length,
        });
        delete _expandedQueueDraft[id];
        if (result.error) {
          showToast('Draft generation failed: ' + result.error, 'error');
        } else if (result.item && result.item.draft) {
          const cached = _queueItems.find(i => i.id === id);
          if (cached) { cached.draft = result.item.draft; cached.status = 'pending'; }
          showToast('Draft generated successfully');
        }
      } catch (err) {
        showToast('Regenerate failed: ' + err.message, 'error');
      }
      renderQueue();
      loadActivity();
    },
    {
      input: true,
      inputPlaceholder: 'Optional guidance \u2014 e.g. "politely decline", "ask for a call"...',
      customBody: '<div class="regen-options">' +
        '<div class="regen-row">' +
          '<label>Model</label>' +
          '<select id="regen-model" class="regen-select">' +
            '<option value="haiku">Haiku (fast)</option>' +
            '<option value="sonnet">Sonnet (smarter)</option>' +
          '</select>' +
        '</div>' +
        '<div class="regen-row">' +
          '<label>Length</label>' +
          '<select id="regen-length" class="regen-select">' +
            '<option value="simple">Simple (1-2 paragraphs)</option>' +
            '<option value="long">Detailed (3-5 paragraphs)</option>' +
          '</select>' +
        '</div>' +
      '</div>',
    }
  );
}

function showToast(message, type) {
  let toast = document.getElementById('opai-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'opai-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = 'toast show' + (type === 'error' ? ' toast-error' : '');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.className = 'toast'; }, 4000);
}

// ── Activity Rendering ───────────────────────────────────

async function loadActivity() {
  if (_expandedActivity !== null) return;

  const filter = document.getElementById('activity-filter').value;
  const dateParam = _currentDate ? '&date=' + _currentDate : '';
  const data = await api('GET', '/api/actions?limit=100' + (filter ? '&filter=' + filter : '') + dateParam);
  const actions = data.actions || [];

  document.getElementById('count-activity').textContent = actions.length;
  document.getElementById('activity-empty').style.display = actions.length ? 'none' : '';

  const list = document.getElementById('activity-list');

  let lastDateStr = null;
  list.innerHTML = actions.map(a => {
    const ts = new Date(a.timestamp);
    const dateStr = ts.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    const time = ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const sender = a.sender || '--';
    const subject = a.subject ? trunc(a.subject, 50) : '--';
    const reasoning = a.reasoning ? trunc(a.reasoning, 60) : '';

    let divider = '';
    if (dateStr !== lastDateStr) {
      divider = '<div class="activity-date-divider">' + esc(dateStr) + '</div>';
      lastDateStr = dateStr;
    }

    return divider +
    '<div class="activity-row" onclick="toggleActivity(\'' + a.id + '\')">' +
      '<span class="activity-time">' + time + '</span>' +
      '<span class="activity-action"><span class="action-dot ' + a.action + '"></span><span class="action-label">' + esc(a.action) + '</span></span>' +
      '<span class="activity-sender">' + esc(sender) + '</span>' +
      '<span class="activity-subject">' + esc(subject) + '</span>' +
      '<span class="activity-reasoning">' + esc(reasoning) + '</span>' +
    '</div>' +
    '<div class="activity-detail" id="act-detail-' + a.id + '">' +
      '<h4>Reasoning</h4>' +
      '<div class="reasoning-text">' + esc(a.reasoning || 'No reasoning recorded') + '</div>' +
      (a.details && Object.keys(a.details).length > 0
        ? '<h4>Details</h4><pre>' + esc(JSON.stringify(a.details, null, 2)) + '</pre>'
        : '') +
      (a.feedback
        ? '<h4>Feedback</h4><p style="color:var(--accent-light);font-size:0.82rem">' + esc(a.feedback.comment || a.feedback) + '</p>'
        : '') +
      '<div class="card-feedback-form" style="margin-top:0.5rem">' +
        '<input type="text" id="fb-act-' + a.id + '" placeholder="Add feedback...">' +
        '<button class="btn btn-primary btn-xs" onclick="submitActivityFeedback(\'' + a.id + '\', \'' + esc(a.sender || '') + '\')">Feedback</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function toggleActivity(id) {
  const detail = document.getElementById('act-detail-' + id);
  if (!detail) return;

  if (_expandedActivity === id) {
    detail.classList.remove('open');
    _expandedActivity = null;
  } else {
    if (_expandedActivity) {
      const prev = document.getElementById('act-detail-' + _expandedActivity);
      if (prev) prev.classList.remove('open');
    }
    detail.classList.add('open');
    _expandedActivity = id;
  }
}

async function submitActivityFeedback(actionId, sender) {
  const input = document.getElementById('fb-act-' + actionId);
  if (!input) return;
  const comment = input.value.trim();
  if (!comment) return;
  await api('POST', '/api/actions/' + actionId + '/feedback', { comment, sender });
  input.value = '';
  await Promise.all([loadActivity(), loadFeedback()]);
}

// ── Feedback ─────────────────────────────────────────────

async function loadFeedback() {
  const data = await api('GET', '/api/feedback');
  const rules = data.rules || [];
  const list = document.getElementById('feedback-list');

  document.getElementById('count-feedback').textContent = rules.filter(r => r.active).length;
  document.getElementById('feedback-empty').style.display = rules.length ? 'none' : '';

  const ruleType = (r) => r.type || r.category || 'general';
  list.innerHTML = rules.map(r =>
    '<div class="feedback-rule ' + (r.active ? '' : 'inactive') + '">' +
      '<div style="min-width:0;flex:1">' +
        '<div class="feedback-comment">' +
          '<span class="rule-type-badge ' + esc(ruleType(r)) + '">' + esc(ruleType(r)) + '</span>' +
          esc(r.comment) +
        '</div>' +
        '<div class="feedback-meta">' +
          (r.sender ? esc(r.sender) + ' &middot; ' : '') +
          new Date(r.createdAt).toLocaleDateString() +
        '</div>' +
      '</div>' +
      '<div>' +
        (r.active
          ? '<button class="btn btn-outline btn-xs" onclick="deactivateRule(\'' + r.id + '\')">Deactivate</button>'
          : '<span style="color:var(--text-muted);font-size:0.72rem">Inactive</span>') +
      '</div>' +
    '</div>'
  ).join('');
}

async function addFeedback() {
  const input = document.getElementById('new-feedback');
  const typeEl = document.getElementById('new-feedback-type');
  const comment = input.value.trim();
  if (!comment) return;
  const type = typeEl ? typeEl.value : 'general';
  await api('POST', '/api/feedback', { comment, type });
  input.value = '';
  await loadFeedback();
}

async function deactivateRule(id) {
  await api('POST', '/api/feedback/' + id + '/deactivate');
  await loadFeedback();
}

// ── Modal ────────────────────────────────────────────────

function showModal(title, body, callback, opts) {
  document.getElementById('modal-title').textContent = title;
  const bodyEl = document.getElementById('modal-body');
  if (opts?.customBody) {
    bodyEl.innerHTML = (body ? '<p>' + esc(body) + '</p>' : '') + opts.customBody;
  } else {
    bodyEl.textContent = body;
  }
  const inputWrap = document.getElementById('modal-input-wrap');
  const inputEl = document.getElementById('modal-input');
  if (opts?.input) {
    inputEl.placeholder = opts.inputPlaceholder || '';
    inputEl.value = '';
    inputWrap.style.display = '';
  } else {
    inputWrap.style.display = 'none';
  }
  document.getElementById('modal-overlay').classList.add('open');
  _modalCallback = callback;
  if (opts?.input) setTimeout(() => inputEl.focus(), 50);
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  document.getElementById('modal-input-wrap').style.display = 'none';
  _modalCallback = null;
}

async function confirmModal() {
  const cb = _modalCallback;
  if (!cb) return;
  _modalCallback = null; // Prevent double-submit
  const btn = document.getElementById('modal-confirm');
  // Only set Working... if callback hasn't already set a custom message
  if (btn && !btn.disabled) { btn.disabled = true; btn.textContent = 'Working...'; }
  try {
    await cb();
  } catch (err) {
    console.error('Modal action failed:', err);
    showToast('Action failed: ' + err.message, 'error');
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Confirm'; }
  closeModal();
}

// ── Compose Modal ─────────────────────────────────────────

function openCompose() {
  document.getElementById('compose-overlay').classList.add('open');
  document.getElementById('compose-to').focus();
}

function closeCompose() {
  document.getElementById('compose-overlay').classList.remove('open');
}

async function sendCompose() {
  const to = document.getElementById('compose-to').value.trim();
  const subject = document.getElementById('compose-subject').value.trim();
  const body = document.getElementById('compose-body').value.trim();
  if (!to || !subject || !body) return alert('To, subject, and body are required.');

  const btn = document.getElementById('compose-send-btn');
  btn.disabled = true;
  btn.textContent = 'Sending...';

  try {
    const result = await api('POST', '/api/compose', { to, subject, body });
    if (result.success) {
      document.getElementById('compose-to').value = '';
      document.getElementById('compose-subject').value = '';
      document.getElementById('compose-body').value = '';
      closeCompose();
      await loadActivity();
    } else {
      alert('Send failed: ' + (result.error || 'Unknown error'));
    }
  } catch (e) {
    alert('Send failed: ' + e.message);
  }

  btn.disabled = false;
  btn.textContent = 'Send';
}

// ── Classify Test Modal ───────────────────────────────────

function openClassifyTest() {
  document.getElementById('classify-overlay').classList.add('open');
  document.getElementById('classify-result-box').style.display = 'none';
  document.getElementById('classify-from').focus();
}

function closeClassifyTest() {
  document.getElementById('classify-overlay').classList.remove('open');
}

async function runClassifyTest() {
  const from = document.getElementById('classify-from').value.trim();
  const subject = document.getElementById('classify-subject').value.trim();
  const body = document.getElementById('classify-body').value.trim();
  if (!from || !subject) return alert('From and subject are required.');

  const btn = document.getElementById('classify-run-btn');
  btn.disabled = true;
  btn.textContent = 'Classifying...';

  try {
    const result = await api('POST', '/api/classify-test', { from, subject, body });
    const box = document.getElementById('classify-result-box');
    const content = document.getElementById('classify-result-content');
    box.style.display = 'block';

    if (result.classification) {
      const cls = result.classification;
      const lbls = (cls.labels || cls.tags || []).map(t => '<span class="label-pill ' + labelClass(t) + '">' + esc(t) + '</span>').join('');
      content.innerHTML =
        (lbls ? '<div class="classify-labels" style="margin-bottom:0.5rem">' + lbls + '</div>' : '') +
        '<div class="classify-meta">Priority: <strong>' + esc(cls.priority || 'normal') + '</strong>' +
        (cls.urgency ? ' &middot; Urgency: <strong>' + esc(cls.urgency) + '</strong>' : '') +
        ' &middot; Requires response: <strong>' + (cls.requiresResponse ? 'yes' : 'no') + '</strong></div>' +
        (cls.summary ? '<div class="classify-meta" style="margin-top:0.35rem">' + esc(cls.summary) + '</div>' : '');
    } else {
      content.innerHTML = '<div style="color:var(--red)">' + esc(result.error || 'Classification failed') + '</div>';
    }
  } catch (e) {
    alert('Classification failed: ' + e.message);
  }

  btn.disabled = false;
  btn.textContent = 'Classify';
}

// ── Bulk Actions ──────────────────────────────────────────

function dismissAllSkipped() {
  const filtered = _emailGroups.filter(g => g.outcome !== 'skipped');
  _emailGroups = filtered;
  renderInbox(filtered);
}

async function clearQueue() {
  showModal('Clear All Pending?', 'This will reject all pending drafts in the queue. This cannot be undone.', async () => {
    const result = await api('POST', '/api/bulk/clear-queue');
    await Promise.all([loadQueue(), loadActivity()]);
    if (result.cleared != null) {
      console.log('[EMAIL-AGENT] Cleared ' + result.cleared + ' queue items');
    }
  });
}

// ── Utility ──────────────────────────────────────────────

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function trunc(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '...' : str;
}

// ── Boot ─────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
