/**
 * Marq — Dashboard view (app list with status cards)
 */
(function () {
  'use strict';

  window.renderDashboard = function (el) {
    const apps = window.marqState.apps;

    if (!apps || apps.length === 0) {
      el.innerHTML =
        '<div class="empty-state">' +
          '<div class="icon">📱</div>' +
          '<h3>No apps registered</h3>' +
          '<p>Register your first app to start managing store submissions.</p>' +
          '<button class="btn btn-primary" onclick="showNewAppModal()">+ Register App</button>' +
        '</div>';
      return;
    }

    let html = '<div class="app-grid">';
    for (const app of apps) {
      const latestSub = (app.recent_submissions || [])[0];
      const scoreHtml = latestSub ? renderScore(latestSub.pre_check_score) : '';
      const dotClass = appStatusDotClass(app.status, latestSub);

      html +=
        '<div class="card app-card" onclick="selectApp(\'' + app.id + '\')">' +
          '<div class="app-card-header">' +
            '<div class="app-icon">' + getAppEmoji(app) + '<span class="app-status-dot ' + dotClass + '"></span></div>' +
            '<div class="app-info">' +
              '<h3>' + esc(app.name) + '</h3>' +
              '<div class="app-meta">' +
                (app.current_version ? 'v' + esc(app.current_version) + ' · ' : '') +
                (app.bundle_id_ios || app.package_name_android || app.slug) +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="app-card-footer">' +
            platformBadges(app.platform) +
            statusBadge(app.status) +
            (latestSub ? statusBadge(latestSub.status) : '') +
          '</div>' +
          scoreHtml +
        '</div>';
    }
    html += '</div>';
    el.innerHTML = html;
  };

  window.selectApp = async function (appId) {
    try {
      const app = await marqFetch('/apps/' + appId);
      window.marqState.currentApp = app;
      showToast('Selected: ' + app.name, 'success');
      // Show app detail view
      renderAppDetail(document.getElementById('content'), app);
    } catch (e) {
      showToast('Failed to load app: ' + e.message, 'error');
    }
  };

  function renderAppDetail(el, app) {
    const subs = app.recent_submissions || [];

    let subsHtml = '';
    if (subs.length > 0) {
      subsHtml =
        '<h3 style="margin:20px 0 12px">Recent Submissions</h3>' +
        '<table class="data-table">' +
          '<thead><tr><th>Store</th><th>Version</th><th>Build</th><th>Status</th><th>Score</th><th>Date</th></tr></thead>' +
          '<tbody>';
      for (const s of subs) {
        subsHtml +=
          '<tr>' +
            '<td><span class="badge ' + (s.store === 'apple' ? 'badge-ios' : 'badge-android') + '">' + s.store + '</span></td>' +
            '<td>' + esc(s.version) + '</td>' +
            '<td>' + esc(s.build_number || '-') + '</td>' +
            '<td>' + statusBadge(s.status) + '</td>' +
            '<td>' + (s.pre_check_score || '-') + '</td>' +
            '<td>' + formatDate(s.created_at) + '</td>' +
          '</tr>';
      }
      subsHtml += '</tbody></table>';
    }

    el.innerHTML =
      '<div style="margin-bottom:16px">' +
        '<button class="btn btn-sm" onclick="loadApps()">&larr; Back to Apps</button>' +
      '</div>' +
      '<div class="card" style="margin-bottom:16px">' +
        '<div class="app-card-header">' +
          '<div class="app-icon" style="width:64px;height:64px;font-size:32px;border-radius:14px">' + getAppEmoji(app) + '</div>' +
          '<div class="app-info">' +
            '<h3 style="font-size:20px">' + esc(app.name) + '</h3>' +
            '<div class="app-meta">' +
              platformBadges(app.platform) + ' ' + statusBadge(app.status) +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div style="margin-top:16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;font-size:13px">' +
          infoField('Version', app.current_version) +
          infoField('iOS Bundle', app.bundle_id_ios) +
          infoField('Android Package', app.package_name_android) +
          infoField('Project Folder', app.project_path) +
          infoField('Docs Folder', app.doc_folder) +
          infoField('Privacy Policy', app.privacy_policy_url ? '<a href="' + esc(app.privacy_policy_url) + '" target="_blank" style="color:var(--accent)">' + esc(app.privacy_policy_url) + '</a>' : null) +
          infoField('Support URL', app.support_url ? '<a href="' + esc(app.support_url) + '" target="_blank" style="color:var(--accent)">' + esc(app.support_url) + '</a>' : null) +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">' +
        '<button class="btn btn-primary" onclick="runChecksForApp(\'' + app.id + '\')">Run Pre-Checks</button>' +
        '<button class="btn" onclick="newSubmission(\'' + app.id + '\')">New Submission</button>' +
        '<button class="btn" onclick="checkStoreStatus(\'' + app.id + '\')">Check Store Status</button>' +
        '<button class="btn" onclick="showAuditLog(\'' + app.id + '\')">Audit Log</button>' +
        '<button class="btn" onclick="showEditAppForm(marqState.currentApp)">Edit App</button>' +
      '</div>' +
      '<div id="store-status-area"></div>' +
      subsHtml +
      '<h3 style="margin:24px 0 12px">Store Credentials</h3>' +
      '<div id="creds-area"><div class="loading">Loading credentials...</div></div>';

    loadCredentials(app.id);
  }

  // ── Store Status ──────────────────────────────────────────

  window.checkStoreStatus = async function (appId) {
    var area = document.getElementById('store-status-area');
    if (!area) return;
    var app = window.marqState.currentApp;
    if (!app) return;

    area.innerHTML = '<div class="loading">Checking store status...</div>';

    var stores = [];
    if (app.platform === 'android' || app.platform === 'both') stores.push('google');
    if (app.platform === 'ios' || app.platform === 'both') stores.push('apple');

    var html = '<div class="store-status-cards">';
    for (var i = 0; i < stores.length; i++) {
      try {
        var result = await marqFetch('/apps/' + appId + '/store-status?store=' + stores[i]);
        if (!result.configured) {
          html += storeStatusCard(stores[i], 'not_configured', result.error || 'No credentials configured');
        } else if (result.error) {
          html += storeStatusCard(stores[i], 'error', result.error);
        } else if (stores[i] === 'google' && result.status) {
          var releases = (result.status.releases || []);
          var latest = releases[0];
          var info = latest ? esc(latest.status || 'unknown') + (latest.versionCodes ? ' (build ' + latest.versionCodes.join(', ') + ')' : '') : 'No releases';
          html += storeStatusCard(stores[i], latest ? latest.status : 'empty', info);
        } else if (stores[i] === 'apple' && result.versions) {
          var v = result.versions[0];
          var info = v ? esc(v.versionString || '?') + ' — ' + esc(v.appStoreState || 'unknown') : 'No versions';
          html += storeStatusCard(stores[i], v ? v.appStoreState : 'empty', info);
        } else {
          html += storeStatusCard(stores[i], 'ok', 'Connected');
        }
      } catch (e) {
        html += storeStatusCard(stores[i], 'error', e.message);
      }
    }
    html += '</div>';
    area.innerHTML = html;
  };

  function storeStatusCard(store, status, info) {
    var colorMap = {
      completed: 'var(--green)', READY_FOR_SALE: 'var(--green)',
      inProgress: 'var(--yellow)', IN_REVIEW: 'var(--yellow)', WAITING_FOR_REVIEW: 'var(--yellow)',
      halted: 'var(--red)', REJECTED: 'var(--red)',
      not_configured: 'var(--text-dim)', error: 'var(--red)',
    };
    var color = colorMap[status] || 'var(--accent)';
    var icon = store === 'apple' ? '\uD83C\uDF4E' : '\uD83E\uDD16';
    return '<div class="card store-status-card">' +
      '<div class="store-status-header">' +
        '<span style="font-size:20px">' + icon + '</span>' +
        '<span class="badge ' + (store === 'apple' ? 'badge-ios' : 'badge-android') + '">' + store + '</span>' +
        '<span class="store-status-dot" style="background:' + color + '"></span>' +
      '</div>' +
      '<div class="store-status-info">' + info + '</div>' +
    '</div>';
  }

  // ── Credential Management ─────────────────────────────────

  async function loadCredentials(appId) {
    var area = document.getElementById('creds-area');
    if (!area) return;

    try {
      var creds = await marqFetch('/apps/' + appId + '/credentials');
      window.marqState._credentials = creds;

      if (!creds || creds.length === 0) {
        area.innerHTML = '<div class="card" style="padding:20px">' +
          '<p class="text-muted" style="margin-bottom:12px">No store credentials configured. Add credentials to enable store integrations.</p>' +
          '<button class="btn btn-primary" onclick="showCredentialForm(\'' + appId + '\')">+ Add Credential</button>' +
        '</div>';
        return;
      }

      var html = '<div class="cred-grid">';
      for (var i = 0; i < creds.length; i++) {
        var c = creds[i];
        var icon = c.store === 'apple' ? '\uD83C\uDF4E' : '\uD83E\uDD16';
        var activeClass = c.is_active ? 'cred-active' : 'cred-inactive';
        html += '<div class="card cred-card ' + activeClass + '">' +
          '<div class="cred-card-header">' +
            '<span style="font-size:18px">' + icon + '</span>' +
            '<span class="badge ' + (c.store === 'apple' ? 'badge-ios' : 'badge-android') + '">' + c.store + '</span>' +
            '<span class="badge badge-gray">' + esc(c.credential_type) + '</span>' +
            (c.is_active ? '<span class="badge badge-green">active</span>' : '<span class="badge badge-red">inactive</span>') +
          '</div>' +
          '<div style="font-size:12px;color:var(--text-muted);margin:8px 0">' +
            (c.issuer_id ? 'Issuer: ' + esc(c.issuer_id.slice(0, 12)) + '... ' : '') +
            (c.key_id ? 'Key: ' + esc(c.key_id.slice(0, 12)) + '...' : '') +
          '</div>' +
          '<div style="font-size:11px;color:var(--text-dim)">' +
            'Added ' + formatDate(c.created_at) +
            (c.last_verified_at ? ' &middot; Verified ' + formatDate(c.last_verified_at) : '') +
          '</div>' +
          '<div style="margin-top:8px;display:flex;gap:6px">' +
            '<button class="btn btn-sm btn-danger" onclick="event.stopPropagation();deleteCredential(\'' + c.id + '\',\'' + appId + '\')">Remove</button>' +
          '</div>' +
        '</div>';
      }
      html += '</div>' +
        '<div style="margin-top:12px"><button class="btn" onclick="showCredentialForm(\'' + appId + '\')">+ Add Credential</button></div>';
      area.innerHTML = html;
    } catch (e) {
      area.innerHTML = '<div class="text-muted">Failed to load credentials: ' + esc(e.message) + '</div>';
    }
  }

  window.showCredentialForm = function (appId) {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';
    overlay.id = 'cred-modal';
    overlay.onclick = function (e) { if (e.target === overlay) overlay.remove(); };

    overlay.innerHTML = '<div class="modal" style="max-width:560px">' +
      '<h2>Add Store Credential</h2>' +
      '<div class="form-group">' +
        '<label>Store</label>' +
        '<select id="cred-store" onchange="updateCredTypeOptions()">' +
          '<option value="google">Google Play</option>' +
          '<option value="apple">Apple App Store</option>' +
        '</select>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Credential Type</label>' +
        '<select id="cred-type">' +
          '<option value="service_account">Service Account (JSON)</option>' +
        '</select>' +
      '</div>' +
      '<div id="cred-fields-google">' +
        '<div class="form-group">' +
          '<label>Service Account JSON</label>' +
          '<textarea id="cred-json" rows="6" placeholder="Paste your Google service account JSON here..."></textarea>' +
          '<span style="font-size:11px;color:var(--text-muted)">From Google Cloud Console &rarr; Service Accounts &rarr; Keys &rarr; Create Key (JSON)</span>' +
        '</div>' +
      '</div>' +
      '<div id="cred-fields-apple" style="display:none">' +
        '<div class="form-group">' +
          '<label>Issuer ID</label>' +
          '<input id="cred-issuer" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx">' +
          '<span style="font-size:11px;color:var(--text-muted)">From App Store Connect &rarr; Users and Access &rarr; Integrations &rarr; App Store Connect API</span>' +
        '</div>' +
        '<div class="form-group">' +
          '<label>Key ID</label>' +
          '<input id="cred-keyid" placeholder="XXXXXXXXXX">' +
        '</div>' +
        '<div class="form-group">' +
          '<label>Private Key (.p8 contents)</label>' +
          '<textarea id="cred-p8" rows="6" placeholder="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"></textarea>' +
        '</div>' +
      '</div>' +
      '<div class="modal-actions">' +
        '<button class="btn" onclick="document.getElementById(\'cred-modal\').remove()">Cancel</button>' +
        '<button class="btn btn-primary" onclick="saveCredential(\'' + appId + '\')">Save Credential</button>' +
      '</div>' +
    '</div>';

    document.body.appendChild(overlay);
  };

  window.updateCredTypeOptions = function () {
    var store = document.getElementById('cred-store').value;
    var typeEl = document.getElementById('cred-type');
    var googleFields = document.getElementById('cred-fields-google');
    var appleFields = document.getElementById('cred-fields-apple');

    if (store === 'google') {
      typeEl.innerHTML = '<option value="service_account">Service Account (JSON)</option>';
      googleFields.style.display = '';
      appleFields.style.display = 'none';
    } else {
      typeEl.innerHTML = '<option value="p8_key">API Key (.p8)</option>';
      googleFields.style.display = 'none';
      appleFields.style.display = '';
    }
  };

  window.saveCredential = async function (appId) {
    var store = document.getElementById('cred-store').value;
    var credType = document.getElementById('cred-type').value;
    var payload = { store: store, credential_type: credType };

    if (store === 'google') {
      var jsonStr = document.getElementById('cred-json').value.trim();
      if (!jsonStr) { showToast('Paste the service account JSON', 'error'); return; }
      try {
        payload.credential_data = JSON.parse(jsonStr);
      } catch (e) {
        showToast('Invalid JSON: ' + e.message, 'error');
        return;
      }
    } else {
      var issuerId = document.getElementById('cred-issuer').value.trim();
      var keyId = document.getElementById('cred-keyid').value.trim();
      var p8 = document.getElementById('cred-p8').value.trim();
      if (!issuerId || !keyId || !p8) {
        showToast('All Apple fields are required', 'error');
        return;
      }
      payload.issuer_id = issuerId;
      payload.key_id = keyId;
      payload.credential_data = { private_key: p8 };
    }

    try {
      await marqFetch('/apps/' + appId + '/credentials', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      showToast('Credential saved and encrypted', 'success');
      document.getElementById('cred-modal').remove();
      loadCredentials(appId);
    } catch (e) {
      showToast('Failed: ' + e.message, 'error');
    }
  };

  window.deleteCredential = async function (credId, appId) {
    if (!confirm('Remove this credential? The encrypted key will be deleted.')) return;
    try {
      await marqFetch('/credentials/' + credId, { method: 'DELETE' });
      showToast('Credential removed', 'success');
      loadCredentials(appId);
    } catch (e) {
      showToast('Failed: ' + e.message, 'error');
    }
  };

  window.runChecksForApp = async function (appId) {
    showToast('Running 31 pre-submission checks...', 'success');
    try {
      const result = await marqFetch('/apps/' + appId + '/run-checks', { method: 'POST' });
      window.marqState.lastCheckResults = result;
      showToast('Score: ' + result.score + '/100 — ' + result.passed + ' passed, ' + result.failed + ' failed', result.has_blockers ? 'error' : 'success');
      switchTab('checks');
    } catch (e) {
      showToast('Check failed: ' + e.message, 'error');
    }
  };

  window.newSubmission = function (appId) {
    if (typeof showNewSubmissionForm === 'function') {
      showNewSubmissionForm(appId);
    } else {
      showToast('Submission form not loaded', 'error');
    }
  };

  // ── Edit App ──────────────────────────────────────────────

  window.showEditAppForm = function (app) {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';
    overlay.id = 'edit-app-modal';
    overlay.onclick = function (e) { if (e.target === overlay) overlay.remove(); };

    overlay.innerHTML = '<div class="modal" style="max-width:520px">' +
      '<h2>Edit App</h2>' +
      '<div class="form-group"><label>App Name</label><input id="edit-app-name" value="' + esc(app.name) + '"></div>' +
      '<div class="form-row">' +
        '<div class="form-group"><label>Platform</label><select id="edit-app-platform">' +
          '<option value="both"' + (app.platform === 'both' ? ' selected' : '') + '>iOS + Android</option>' +
          '<option value="ios"' + (app.platform === 'ios' ? ' selected' : '') + '>iOS Only</option>' +
          '<option value="android"' + (app.platform === 'android' ? ' selected' : '') + '>Android Only</option>' +
        '</select></div>' +
        '<div class="form-group"><label>Current Version</label><input id="edit-app-version" value="' + esc(app.current_version || '') + '" placeholder="1.0.0"></div>' +
      '</div>' +
      '<div class="form-group"><label>iOS Bundle ID</label><input id="edit-app-bundle" value="' + esc(app.bundle_id_ios || '') + '" placeholder="com.example.myapp"></div>' +
      '<div class="form-group"><label>Android Package Name</label><input id="edit-app-package" value="' + esc(app.package_name_android || '') + '" placeholder="com.example.myapp"></div>' +
      '<div class="form-group"><label>Project Folder</label><div class="input-with-browse"><input id="edit-app-projectpath" value="' + esc(app.project_path || '') + '" placeholder="Select project folder" readonly><button type="button" class="btn btn-sm btn-browse" onclick="openFilePicker({ title: \'Select Project Folder\', mode: \'dirs\', startPath: \'' + esc(app.project_path || '') + '\', onSelect: function(p){ document.getElementById(\'edit-app-projectpath\').value = p; } })">Browse</button></div><span class="form-hint">Root folder of your app project (source, build files, APK/IPA)</span></div>' +
      '<div class="form-group"><label>Docs Folder</label><div class="input-with-browse"><input id="edit-app-docfolder" value="' + esc(app.doc_folder || '') + '" placeholder="Select docs folder" readonly><button type="button" class="btn btn-sm btn-browse" onclick="openFilePicker({ title: \'Select Docs Folder\', mode: \'dirs\', startPath: \'' + esc(app.doc_folder || '') + '\', onSelect: function(p){ document.getElementById(\'edit-app-docfolder\').value = p; } })">Browse</button></div><span class="form-hint">README, PRD, CHANGELOG — used for AI metadata generation</span></div>' +
      '<div class="form-group"><label>Privacy Policy URL</label><input id="edit-app-privacy" value="' + esc(app.privacy_policy_url || '') + '"></div>' +
      '<div class="form-group"><label>Support URL</label><input id="edit-app-support" value="' + esc(app.support_url || '') + '"></div>' +
      '<div class="form-group"><label>Status</label><select id="edit-app-status">' +
        '<option value="draft"' + (app.status === 'draft' ? ' selected' : '') + '>Draft</option>' +
        '<option value="active"' + (app.status === 'active' ? ' selected' : '') + '>Active</option>' +
        '<option value="live"' + (app.status === 'live' ? ' selected' : '') + '>Live</option>' +
        '<option value="suspended"' + (app.status === 'suspended' ? ' selected' : '') + '>Suspended</option>' +
      '</select></div>' +
      '<div class="modal-actions">' +
        '<button class="btn btn-danger" onclick="deleteApp(\'' + app.id + '\')">Delete App</button>' +
        '<button class="btn" onclick="document.getElementById(\'edit-app-modal\').remove()">Cancel</button>' +
        '<button class="btn btn-primary" onclick="saveAppEdit(\'' + app.id + '\')">Save</button>' +
      '</div>' +
    '</div>';

    document.body.appendChild(overlay);
  };

  window.saveAppEdit = async function (appId) {
    var payload = {
      name: document.getElementById('edit-app-name').value.trim() || undefined,
      platform: document.getElementById('edit-app-platform').value,
      current_version: document.getElementById('edit-app-version').value.trim() || undefined,
      bundle_id_ios: document.getElementById('edit-app-bundle').value.trim() || undefined,
      package_name_android: document.getElementById('edit-app-package').value.trim() || undefined,
      project_path: document.getElementById('edit-app-projectpath').value.trim() || undefined,
      doc_folder: document.getElementById('edit-app-docfolder').value.trim() || undefined,
      privacy_policy_url: document.getElementById('edit-app-privacy').value.trim() || undefined,
      support_url: document.getElementById('edit-app-support').value.trim() || undefined,
      status: document.getElementById('edit-app-status').value,
    };

    try {
      await marqFetch('/apps/' + appId, { method: 'PATCH', body: JSON.stringify(payload) });
      showToast('App updated', 'success');
      document.getElementById('edit-app-modal').remove();
      selectApp(appId);
    } catch (e) {
      showToast('Update failed: ' + e.message, 'error');
    }
  };

  window.deleteApp = async function (appId) {
    if (!confirm('Delete this app? This will remove all submissions, metadata, and credentials.')) return;
    if (!confirm('Are you sure? This cannot be undone.')) return;
    try {
      await marqFetch('/apps/' + appId, { method: 'DELETE' });
      showToast('App deleted', 'success');
      var modal = document.getElementById('edit-app-modal');
      if (modal) modal.remove();
      window.marqState.currentApp = null;
      loadApps();
    } catch (e) {
      showToast('Delete failed: ' + e.message, 'error');
    }
  };

  // ── Audit Log ─────────────────────────────────────────────

  window.showAuditLog = async function (appId) {
    try {
      var logs = await marqFetch('/apps/' + appId + '/audit?limit=50');
      var overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.style.display = 'flex';
      overlay.onclick = function (e) { if (e.target === overlay) overlay.remove(); };

      var html = '<div class="modal" style="max-width:640px">' +
        '<h2>Audit Log</h2>';

      if (!logs || logs.length === 0) {
        html += '<div class="text-muted" style="padding:20px;text-align:center">No audit events yet</div>';
      } else {
        html += '<div style="max-height:400px;overflow-y:auto">';
        for (var i = 0; i < logs.length; i++) {
          var log = logs[i];
          html += '<div class="audit-row">' +
            '<div class="audit-row-main">' +
              '<span class="badge badge-gray">' + esc(log.action) + '</span> ' +
              '<span>' + esc(log.summary) + '</span>' +
            '</div>' +
            '<div class="audit-row-meta text-muted">' +
              formatDate(log.created_at) +
              ' &middot; ' + esc(log.actor_type || 'user') +
            '</div>' +
          '</div>';
        }
        html += '</div>';
      }

      html += '<div class="modal-actions"><button class="btn" onclick="this.closest(\'.modal-overlay\').remove()">Close</button></div></div>';
      overlay.innerHTML = html;
      document.body.appendChild(overlay);
    } catch (e) {
      showToast('Failed to load audit log: ' + e.message, 'error');
    }
  };

  // ── Helpers ──────────────────────────────────────────────

  function appStatusDotClass(status, latestSub) {
    // Determine dot color based on app status and latest submission
    if (latestSub) {
      var s = latestSub.status;
      if (s === 'released' || s === 'approved') return 'dot-green';
      if (s === 'in_review' || s === 'submitted') return 'dot-yellow';
      if (s === 'rejected') return 'dot-red';
    }
    if (status === 'live') return 'dot-green';
    if (status === 'active') return 'dot-blue';
    if (status === 'suspended') return 'dot-red';
    return 'dot-gray';
  }

  function getAppEmoji(app) {
    if (app.platform === 'ios') return '\uD83C\uDF4E';     // apple
    if (app.platform === 'android') return '\uD83E\uDD16'; // robot
    return '\uD83D\uDCF1'; // phone
  }

  function renderScore(score) {
    if (score == null) return '';
    const color = score >= 80 ? 'var(--green)' : score >= 50 ? 'var(--yellow)' : 'var(--red)';
    return '<div class="score-meter" style="margin-top:8px">' +
      '<div class="score-bar"><div class="score-fill" style="width:' + score + '%;background:' + color + '"></div></div>' +
      '<div class="score-value" style="color:' + color + '">' + score + '</div>' +
    '</div>';
  }

  function infoField(label, value) {
    if (!value) return '';
    return '<div><span style="color:var(--text-muted)">' + label + ':</span> ' + value + '</div>';
  }

})();
