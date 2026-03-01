/**
 * Marq — App Store Publisher Agent — SPA core
 */
(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────
  window.marqState = {
    apps: [],
    currentApp: null,
    currentTab: 'dashboard',
    loading: false,
    supabase: null,
    user: null,
    token: null,
  };

  var API = '/marq/api';

  // ── API helpers ──────────────────────────────────────────
  window.marqFetch = async function (path, opts) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});

    if (window.marqState.token) {
      headers['Authorization'] = 'Bearer ' + window.marqState.token;
    }

    if (!headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    opts.headers = headers;
    var res = await fetch(API + path, opts);

    if (res.status === 401) {
      window.location.href = '/auth/login?redirect=' + encodeURIComponent('/marq/');
      throw new Error('Unauthorized');
    }
    if (!res.ok) {
      var errMsg = 'API error: ' + res.status;
      try {
        var errBody = await res.json();
        if (errBody.detail) errMsg = errBody.detail;
        else if (errBody.error) errMsg = errBody.error;
      } catch (_) {}
      throw new Error(errMsg);
    }
    return res.json();
  };

  // ── Tab switching ────────────────────────────────────────
  window.switchTab = function (tab) {
    window.marqState.currentTab = tab;
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === tab);
    });
    renderContent();
  };

  // ── Content router ───────────────────────────────────────
  function renderContent() {
    const el = document.getElementById('content');
    const tab = window.marqState.currentTab;

    switch (tab) {
      case 'dashboard':
        renderDashboard(el);
        break;
      case 'submissions':
        renderSubmissionsTab(el);
        break;
      case 'checks':
        renderChecksTab(el);
        break;
      case 'assets':
        renderAssetsTab(el);
        break;
      case 'metadata':
        renderMetadataTab(el);
        break;
      case 'reviews':
        renderReviewsTab(el);
        break;
      default:
        el.innerHTML = '<div class="empty-state"><p>Tab not found</p></div>';
    }
  }

  // ── Modal helpers ────────────────────────────────────────
  window.showNewAppModal = function () {
    document.getElementById('new-app-modal').style.display = 'flex';
    document.getElementById('new-app-name').focus();
  };

  window.hideNewAppModal = function () {
    document.getElementById('new-app-modal').style.display = 'none';
  };

  window.createApp = async function () {
    var name = document.getElementById('new-app-name').value.trim();
    if (!name) { showToast('App name is required', 'error'); return; }

    var body = { name: name, platform: document.getElementById('new-app-platform').value };

    var bundle = document.getElementById('new-app-bundle').value.trim();
    if (bundle) body.bundle_id_ios = bundle;

    var pkg = document.getElementById('new-app-package').value.trim();
    if (pkg) body.package_name_android = pkg;

    var projPath = document.getElementById('new-app-project-path').value.trim();
    if (projPath) body.project_path = projPath;

    var docFolder = document.getElementById('new-app-doc-folder').value.trim();
    if (docFolder) body.doc_folder = docFolder;

    var privacy = document.getElementById('new-app-privacy').value.trim();
    if (privacy) body.privacy_policy_url = privacy;

    var support = document.getElementById('new-app-support').value.trim();
    if (support) body.support_url = support;

    try {
      var app = await marqFetch('/apps', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      showToast('App created: ' + app.name, 'success');
      hideNewAppModal();
      loadApps();
    } catch (e) {
      showToast('Failed to create app: ' + e.message, 'error');
    }
  };

  // ── Toast ────────────────────────────────────────────────
  window.showToast = function (msg, type) {
    const el = document.createElement('div');
    el.className = 'toast toast-' + (type || 'success');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  };

  // ── Load apps ────────────────────────────────────────────
  window.loadApps = async function () {
    try {
      window.marqState.apps = await marqFetch('/apps');
    } catch (e) {
      console.error('Failed to load apps:', e);
      window.marqState.apps = [];
    }
    renderContent();
  };

  // ── Status helpers ───────────────────────────────────────
  window.statusBadge = function (status) {
    const map = {
      draft:      'badge-gray',
      active:     'badge-blue',
      submitted:  'badge-yellow',
      in_review:  'badge-yellow',
      live:       'badge-green',
      released:   'badge-green',
      approved:   'badge-green',
      rejected:   'badge-red',
      suspended:  'badge-red',
      removed:    'badge-red',
      preparing:  'badge-gray',
      ready:      'badge-blue',
    };
    return '<span class="badge ' + (map[status] || 'badge-gray') + '">' + (status || 'unknown').replace(/_/g, ' ') + '</span>';
  };

  window.platformBadges = function (platform) {
    let html = '';
    if (platform === 'ios' || platform === 'both') html += '<span class="badge badge-ios">iOS</span> ';
    if (platform === 'android' || platform === 'both') html += '<span class="badge badge-android">Android</span>';
    return html;
  };

  // ── Shared helpers (used by all tabs) ────────────────────
  window.esc = function (s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };

  window.formatDate = function (iso) {
    if (!iso) return '-';
    var d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  window.emptyState = function (icon, title, msg) {
    return '<div class="empty-state"><div class="icon">' + icon + '</div><h3>' + title + '</h3><p>' + msg + '</p></div>';
  };

  // ── File Explorer Modal ─────────────────────────────────
  // Opens a folder picker. onSelect(absolutePath) fires when user picks.
  // mode: 'dirs' (folders only) or 'all' (folders + files)
  window.openFilePicker = function (opts) {
    opts = opts || {};
    var mode = opts.mode || 'dirs';
    var title = opts.title || 'Select Folder';
    var onSelect = opts.onSelect || function () {};
    var startPath = opts.startPath || '';

    // Create overlay
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';
    overlay.id = 'file-picker-modal';
    overlay.onclick = function (e) { if (e.target === overlay) overlay.remove(); };

    overlay.innerHTML =
      '<div class="modal file-picker-modal">' +
        '<div class="fp-header">' +
          '<h2>' + esc(title) + '</h2>' +
          '<button class="btn btn-sm fp-close" onclick="document.getElementById(\'file-picker-modal\').remove()">&times;</button>' +
        '</div>' +
        '<div class="fp-breadcrumb" id="fp-breadcrumb"></div>' +
        '<div class="fp-list" id="fp-list"><div class="fp-loading">Loading...</div></div>' +
        '<div class="fp-selected" id="fp-selected-display"></div>' +
        '<div class="modal-actions">' +
          '<button class="btn" onclick="document.getElementById(\'file-picker-modal\').remove()">Cancel</button>' +
          '<button class="btn btn-primary" id="fp-select-btn" disabled>Select This Folder</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    var currentPath = startPath;
    var selectedPath = '';

    function renderBreadcrumb(relPath) {
      var bc = document.getElementById('fp-breadcrumb');
      if (!bc) return;
      var parts = relPath ? relPath.split('/') : [];
      var html = '<span class="fp-crumb fp-crumb-link" data-path="">Root</span>';
      var built = '';
      for (var i = 0; i < parts.length; i++) {
        built += (i > 0 ? '/' : '') + parts[i];
        html += ' <span class="fp-crumb-sep">/</span> ';
        if (i === parts.length - 1) {
          html += '<span class="fp-crumb fp-crumb-current">' + esc(parts[i]) + '</span>';
        } else {
          html += '<span class="fp-crumb fp-crumb-link" data-path="' + esc(built) + '">' + esc(parts[i]) + '</span>';
        }
      }
      bc.innerHTML = html;

      // Bind breadcrumb clicks
      bc.querySelectorAll('.fp-crumb-link').forEach(function (el) {
        el.onclick = function () { navigate(el.getAttribute('data-path')); };
      });
    }

    function navigate(path) {
      currentPath = path || '';
      selectedPath = currentPath;
      loadDir(currentPath);
    }

    async function loadDir(relPath) {
      var list = document.getElementById('fp-list');
      if (!list) return;
      list.innerHTML = '<div class="fp-loading">Loading...</div>';

      try {
        var data = await marqFetch('/browse?path=' + encodeURIComponent(relPath || '') + '&mode=' + mode);
        renderBreadcrumb(data.path);
        currentPath = data.path;
        selectedPath = currentPath;
        updateSelectedDisplay();

        var html = '';

        // Up button
        if (data.parent !== null && data.parent !== undefined) {
          html += '<div class="fp-item fp-item-up" data-path="' + esc(data.parent) + '">' +
            '<span class="fp-icon">&#8617;</span> <span class="fp-name">..</span>' +
          '</div>';
        }

        if (data.items.length === 0 && data.parent === null) {
          html += '<div class="fp-empty">No items found</div>';
        }

        for (var i = 0; i < data.items.length; i++) {
          var item = data.items[i];
          var icon = item.is_dir ? '&#128193;' : '&#128196;';
          var sizeStr = item.is_dir ? '' : formatFileSize(item.size);
          html += '<div class="fp-item' + (item.is_dir ? ' fp-item-dir' : ' fp-item-file') + '" ' +
            'data-path="' + esc(item.path) + '" data-isdir="' + item.is_dir + '">' +
            '<span class="fp-icon">' + icon + '</span> ' +
            '<span class="fp-name">' + esc(item.name) + '</span>' +
            (sizeStr ? '<span class="fp-size">' + sizeStr + '</span>' : '') +
          '</div>';
        }

        list.innerHTML = html;

        // Bind clicks
        list.querySelectorAll('.fp-item-up').forEach(function (el) {
          el.onclick = function () { navigate(el.getAttribute('data-path')); };
        });
        list.querySelectorAll('.fp-item-dir').forEach(function (el) {
          el.ondblclick = function () { navigate(el.getAttribute('data-path')); };
          el.onclick = function () {
            list.querySelectorAll('.fp-item').forEach(function (x) { x.classList.remove('fp-selected-item'); });
            el.classList.add('fp-selected-item');
            selectedPath = el.getAttribute('data-path');
            updateSelectedDisplay();
          };
        });
        if (mode === 'all') {
          list.querySelectorAll('.fp-item-file').forEach(function (el) {
            el.onclick = function () {
              list.querySelectorAll('.fp-item').forEach(function (x) { x.classList.remove('fp-selected-item'); });
              el.classList.add('fp-selected-item');
              selectedPath = el.getAttribute('data-path');
              updateSelectedDisplay();
            };
          });
        }
      } catch (e) {
        list.innerHTML = '<div class="fp-empty">Failed to load: ' + esc(e.message) + '</div>';
      }
    }

    function updateSelectedDisplay() {
      var disp = document.getElementById('fp-selected-display');
      var btn = document.getElementById('fp-select-btn');
      if (disp) {
        disp.innerHTML = selectedPath
          ? '<span class="fp-selected-label">Selected:</span> <code>' + esc(selectedPath) + '</code>'
          : '<span class="fp-selected-label text-muted">Navigate to a folder and select it</span>';
      }
      if (btn) btn.disabled = !selectedPath;
    }

    // Bind select button
    var selectBtn = document.getElementById('fp-select-btn');
    if (selectBtn) {
      selectBtn.onclick = function () {
        onSelect(selectedPath);
        overlay.remove();
      };
    }

    // Initial load
    loadDir(startPath);
  };

  function formatFileSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(1) + ' GB';
  }

  // ── Init ─────────────────────────────────────────────────
  async function initMarq() {
    try {
      // Load Supabase config from our own backend
      var configResp = await fetch('/marq/api/auth/config');
      var cfg = await configResp.json();
      window.marqState.supabase = window.supabase.createClient(cfg.supabase_url, cfg.supabase_anon_key);

      // Check session — redirect to login if not authenticated
      var sessionResult = await window.marqState.supabase.auth.getSession();
      var session = sessionResult.data.session;
      if (!session) {
        window.location.href = '/auth/login?redirect=' + encodeURIComponent('/marq/');
        return;
      }

      window.marqState.user = session.user;
      window.marqState.token = session.access_token;

      // Listen for auth changes (token refresh, sign out)
      window.marqState.supabase.auth.onAuthStateChange(function (event, sess) {
        if (event === 'SIGNED_OUT' || !sess) {
          window.location.href = '/auth/login?redirect=' + encodeURIComponent('/marq/');
        } else {
          window.marqState.token = sess.access_token;
        }
      });

      // Load apps
      await loadApps();
    } catch (err) {
      console.error('[Marq] Init failed:', err);
      showToast('Failed to initialize: ' + err.message, 'error');
    }
  }

  document.addEventListener('DOMContentLoaded', initMarq);

})();
