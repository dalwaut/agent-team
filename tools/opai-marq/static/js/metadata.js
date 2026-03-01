/**
 * Marq — Metadata Editor + Screenshot Management
 *
 * Tab views for editing store listings and managing screenshots.
 */
(function () {
  'use strict';

  const STORES = ['apple', 'google'];
  const LOCALES = ['en-US', 'en-GB', 'es-ES', 'fr-FR', 'de-DE', 'ja-JP', 'ko-KR', 'zh-CN', 'pt-BR', 'it-IT'];

  // ═══════════════════════════════════════════════════════════
  // Metadata Tab
  // ═══════════════════════════════════════════════════════════

  window.renderMetadataTab = function (el) {
    var app = window.marqState.currentApp;
    if (!app) {
      el.innerHTML = emptyState('\uD83D\uDCDD', 'Select an app first', 'Go to Dashboard and click on an app to manage metadata.');
      return;
    }

    el.innerHTML = '<div class="metadata-header">' +
      '<h2>Store Metadata — ' + esc(app.name) + '</h2>' +
      '<div style="display:flex;gap:8px">' +
        '<button class="btn" onclick="showGenerateModal(\'' + app.id + '\')" title="Generate store listing from project docs using AI">\u2728 Generate from Docs</button>' +
        '<button class="btn btn-primary" onclick="showMetadataForm()">+ New Metadata</button>' +
      '</div>' +
    '</div>' +
    '<div id="metadata-list"><div class="loading">Loading...</div></div>' +
    '<div id="metadata-form-area"></div>';

    loadMetadata(app.id);
  };

  async function loadMetadata(appId) {
    var listEl = document.getElementById('metadata-list');
    try {
      var entries = await marqFetch('/apps/' + appId + '/metadata');
      window.marqState.metadataEntries = entries;

      if (!entries || entries.length === 0) {
        listEl.innerHTML = '<div class="empty-state" style="padding:30px"><p class="text-muted">No metadata entries yet. Create one to start managing your store listing.</p></div>';
        return;
      }

      var html = '<div class="metadata-grid">';
      for (var i = 0; i < entries.length; i++) {
        var m = entries[i];
        html += '<div class="card metadata-card" onclick="editMetadata(\'' + m.id + '\')">' +
          '<div class="metadata-card-top">' +
            '<span class="badge ' + (m.store === 'apple' ? 'badge-ios' : 'badge-android') + '">' + m.store + '</span>' +
            '<span class="badge badge-gray">' + esc(m.locale || 'en-US') + '</span>' +
            '<span class="badge badge-blue">v' + esc(m.version || '?') + '</span>' +
            statusBadgeMeta(m.status) +
          '</div>' +
          '<h3 class="metadata-app-name">' + esc(m.app_name || '(no name)') + '</h3>' +
          (m.subtitle ? '<div class="text-muted" style="font-size:12px">' + esc(m.subtitle) + '</div>' : '') +
          '<div class="metadata-desc">' + esc(truncate(m.full_description, 120)) + '</div>' +
          '<div class="metadata-card-footer text-muted" style="font-size:11px">' +
            'Updated ' + formatDate(m.updated_at || m.created_at) +
          '</div>' +
        '</div>';
      }
      html += '</div>';
      listEl.innerHTML = html;
    } catch (e) {
      listEl.innerHTML = '<div class="text-muted" style="padding:20px">Failed to load metadata: ' + esc(e.message) + '</div>';
    }
  }

  // ── Metadata Form ──────────────────────────────────────────
  window.showMetadataForm = function (existing) {
    var app = window.marqState.currentApp;
    if (!app) return;

    var m = existing || {};
    var isEdit = !!m.id;
    var area = document.getElementById('metadata-form-area');

    area.innerHTML = '<div class="modal-overlay" style="display:flex" onclick="if(event.target===this)hideMetadataForm()">' +
      '<div class="modal" style="max-width:640px">' +
        '<h2>' + (isEdit ? 'Edit' : 'New') + ' Store Metadata</h2>' +
        '<div class="form-row">' +
          formGroup('Store', selectHtml('meta-store', STORES, m.store || 'apple')) +
          formGroup('Locale', selectHtml('meta-locale', LOCALES, m.locale || 'en-US')) +
        '</div>' +
        '<div class="form-row">' +
          formGroup('Version', '<input id="meta-version" value="' + esc(m.version || app.current_version || '1.0.0') + '">') +
          formGroup('Status', selectHtml('meta-status', ['draft', 'ready', 'submitted'], m.status || 'draft')) +
        '</div>' +
        formGroup('App Name <span class="char-count" id="cc-name">' + (m.app_name || '').length + '/30</span>',
          '<input id="meta-app-name" value="' + esc(m.app_name || '') + '" maxlength="50" oninput="updateCharCount(\'cc-name\',this.value.length,30)">') +
        formGroup('Subtitle (Apple) <span class="char-count" id="cc-sub">' + (m.subtitle || '').length + '/30</span>',
          '<input id="meta-subtitle" value="' + esc(m.subtitle || '') + '" maxlength="30" oninput="updateCharCount(\'cc-sub\',this.value.length,30)">') +
        formGroup('Short Description (Google) <span class="char-count" id="cc-short">' + (m.short_description || '').length + '/80</span>',
          '<input id="meta-short-desc" value="' + esc(m.short_description || '') + '" maxlength="80" oninput="updateCharCount(\'cc-short\',this.value.length,80)">') +
        formGroup('Full Description <span class="char-count" id="cc-full">' + (m.full_description || '').length + '/4000</span>',
          '<textarea id="meta-full-desc" rows="6" maxlength="4000" oninput="updateCharCount(\'cc-full\',this.value.length,4000)">' + esc(m.full_description || '') + '</textarea>') +
        formGroup('Keywords (Apple, comma-separated) <span class="char-count" id="cc-kw">' + (m.keywords || '').length + '/100</span>',
          '<input id="meta-keywords" value="' + esc(m.keywords || '') + '" maxlength="100" oninput="updateCharCount(\'cc-kw\',this.value.length,100)">') +
        formGroup("What's New / Release Notes",
          '<textarea id="meta-whats-new" rows="3">' + esc(m.whats_new || '') + '</textarea>') +
        formGroup('Privacy Policy URL',
          '<input id="meta-privacy" value="' + esc(m.privacy_policy_url || '') + '">') +
        formGroup('Support URL',
          '<input id="meta-support" value="' + esc(m.support_url || '') + '">') +
        '<div class="modal-actions">' +
          (isEdit ? '<button class="btn btn-danger" onclick="deleteMetadata(\'' + m.id + '\')">Delete</button>' : '') +
          '<button class="btn" onclick="hideMetadataForm()">Cancel</button>' +
          '<button class="btn btn-primary" onclick="saveMetadata(\'' + (m.id || '') + '\')">' + (isEdit ? 'Save' : 'Create') + '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  };

  window.hideMetadataForm = function () {
    document.getElementById('metadata-form-area').innerHTML = '';
  };

  window.editMetadata = function (metaId) {
    var entries = window.marqState.metadataEntries || [];
    var found = entries.find(function(m) { return m.id === metaId; });
    if (found) showMetadataForm(found);
  };

  window.saveMetadata = async function (metaId) {
    var app = window.marqState.currentApp;
    if (!app) return;

    var payload = {
      store: val('meta-store'),
      locale: val('meta-locale'),
      version: val('meta-version'),
      status: val('meta-status'),
      app_name: val('meta-app-name'),
      subtitle: val('meta-subtitle'),
      short_description: val('meta-short-desc'),
      full_description: val('meta-full-desc'),
      keywords: val('meta-keywords'),
      whats_new: val('meta-whats-new'),
      privacy_policy_url: val('meta-privacy'),
      support_url: val('meta-support'),
    };

    try {
      if (metaId) {
        await marqFetch('/metadata/' + metaId, { method: 'PATCH', body: JSON.stringify(payload) });
        showToast('Metadata updated', 'success');
      } else {
        await marqFetch('/apps/' + app.id + '/metadata', { method: 'POST', body: JSON.stringify(payload) });
        showToast('Metadata created', 'success');
      }
      hideMetadataForm();
      loadMetadata(app.id);
    } catch (e) {
      showToast('Save failed: ' + e.message, 'error');
    }
  };

  window.deleteMetadata = async function (metaId) {
    if (!confirm('Delete this metadata entry?')) return;
    try {
      await marqFetch('/metadata/' + metaId, { method: 'DELETE' });
      showToast('Metadata deleted', 'success');
      hideMetadataForm();
      loadMetadata(window.marqState.currentApp.id);
    } catch (e) {
      showToast('Delete failed: ' + e.message, 'error');
    }
  };

  window.updateCharCount = function (elId, len, max) {
    var el = document.getElementById(elId);
    if (el) {
      el.textContent = len + '/' + max;
      el.style.color = len > max ? 'var(--red)' : len > max * 0.9 ? 'var(--yellow)' : 'var(--text-muted)';
    }
  };

  // ═══════════════════════════════════════════════════════════
  // Generate from Docs (Phase 3 — AI Metadata)
  // ═══════════════════════════════════════════════════════════

  window.showGenerateModal = function (appId) {
    var app = window.marqState.currentApp;
    if (!app) return;

    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';
    overlay.id = 'generate-modal';
    overlay.onclick = function (e) { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = '<div class="modal" style="max-width:520px">' +
      '<h2>Generate Metadata from Docs</h2>' +
      '<p style="color:var(--text-muted);font-size:13px;margin-bottom:16px">AI will read your project documentation and generate a store listing draft for review.</p>' +
      '<div class="form-row">' +
        formGroup('Target Store', selectHtml('gen-store', STORES, 'apple')) +
        formGroup('Locale', selectHtml('gen-locale', LOCALES, 'en-US')) +
      '</div>' +
      formGroup('Doc Folder Path (optional)', '<input id="gen-doc-folder" placeholder="' + esc(app.doc_folder || '/path/to/project/docs') + '" value="' + esc(app.doc_folder || '') + '">' +
        '<span style="font-size:11px;color:var(--text-muted)">Leave blank to use the app\'s configured doc_folder</span>') +
      '<div id="gen-result" style="display:none"></div>' +
      '<div class="modal-actions" id="gen-actions">' +
        '<button class="btn" onclick="document.getElementById(\'generate-modal\').remove()">Cancel</button>' +
        '<button class="btn btn-primary" id="gen-btn" onclick="runGenerate(\'' + appId + '\')">Generate</button>' +
      '</div>' +
    '</div>';
    document.body.appendChild(overlay);
  };

  window.runGenerate = async function (appId) {
    var btn = document.getElementById('gen-btn');
    var resultEl = document.getElementById('gen-result');
    btn.disabled = true;
    btn.textContent = 'Generating...';
    resultEl.style.display = 'none';

    var store = val('gen-store');
    var locale = val('gen-locale');
    var docFolder = val('gen-doc-folder');

    var params = '?store=' + encodeURIComponent(store) + '&locale=' + encodeURIComponent(locale);
    if (docFolder) params += '&doc_folder=' + encodeURIComponent(docFolder);

    try {
      var res = await marqFetch('/apps/' + appId + '/generate-metadata' + params, { method: 'POST' });

      if (!res.ok && res.error) {
        resultEl.innerHTML = '<div class="gen-error"><strong>Generation issue:</strong> ' + esc(res.error) + '</div>';
        resultEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Retry';
        return;
      }

      var draft = res.draft || {};
      window.marqState._generatedDraft = draft;
      window.marqState._generatedMeta = { store: store, locale: locale };

      resultEl.innerHTML = '<div class="gen-preview">' +
        '<h3 style="margin-bottom:12px;font-size:14px">Generated Draft</h3>' +
        genPreviewField('App Name', draft.app_name) +
        genPreviewField('Subtitle', draft.subtitle) +
        genPreviewField('Short Description', draft.short_description) +
        genPreviewField('Full Description', draft.full_description, true) +
        genPreviewField('Keywords', draft.keywords) +
        genPreviewField("What's New", draft.whats_new) +
      '</div>';
      resultEl.style.display = 'block';

      // Replace actions with save/edit options
      document.getElementById('gen-actions').innerHTML =
        '<button class="btn" onclick="document.getElementById(\'generate-modal\').remove()">Discard</button>' +
        '<button class="btn" onclick="editGeneratedDraft()">Edit Before Saving</button>' +
        '<button class="btn btn-primary" onclick="saveGeneratedDraft(\'' + appId + '\')">Save as Metadata</button>';

    } catch (e) {
      resultEl.innerHTML = '<div class="gen-error"><strong>Error:</strong> ' + esc(e.message) + '</div>';
      resultEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Retry';
    }
  };

  window.editGeneratedDraft = function () {
    var draft = window.marqState._generatedDraft || {};
    var meta = window.marqState._generatedMeta || {};
    document.getElementById('generate-modal').remove();
    showMetadataForm({
      store: meta.store || 'apple',
      locale: meta.locale || 'en-US',
      version: window.marqState.currentApp ? window.marqState.currentApp.current_version || '1.0.0' : '1.0.0',
      app_name: draft.app_name || '',
      subtitle: draft.subtitle || '',
      short_description: draft.short_description || '',
      full_description: draft.full_description || '',
      keywords: draft.keywords || '',
      whats_new: draft.whats_new || '',
    });
  };

  window.saveGeneratedDraft = async function (appId) {
    var draft = window.marqState._generatedDraft || {};
    var meta = window.marqState._generatedMeta || {};
    var app = window.marqState.currentApp;

    var payload = {
      store: meta.store || 'apple',
      locale: meta.locale || 'en-US',
      version: app ? app.current_version || '1.0.0' : '1.0.0',
      app_name: draft.app_name || '',
      subtitle: draft.subtitle || '',
      short_description: draft.short_description || '',
      full_description: draft.full_description || '',
      keywords: draft.keywords || '',
      whats_new: draft.whats_new || '',
    };

    try {
      await marqFetch('/apps/' + appId + '/metadata', { method: 'POST', body: JSON.stringify(payload) });
      showToast('Metadata saved from AI draft', 'success');
      document.getElementById('generate-modal').remove();
      loadMetadata(appId);
    } catch (e) {
      showToast('Save failed: ' + e.message, 'error');
    }
  };

  function genPreviewField(label, value, isLong) {
    if (!value) return '';
    var displayVal = isLong ? '<div style="white-space:pre-wrap;max-height:120px;overflow-y:auto">' + esc(value) + '</div>' : esc(value);
    return '<div class="gen-field">' +
      '<span class="gen-field-label">' + label + '</span>' +
      '<div class="gen-field-value">' + displayVal + '</div>' +
    '</div>';
  }

  // ═══════════════════════════════════════════════════════════
  // Submissions Tab (Phase 2+3 — with task relays)
  // ═══════════════════════════════════════════════════════════

  window.renderSubmissionsTab = function (el) {
    var app = window.marqState.currentApp;
    if (!app) {
      el.innerHTML = emptyState('\uD83D\uDCCB', 'Select an app first', 'Go to Dashboard and click on an app to view submissions.');
      return;
    }

    el.innerHTML = '<div class="metadata-header">' +
      '<h2>Submissions — ' + esc(app.name) + '</h2>' +
      '<button class="btn btn-primary" onclick="showNewSubmissionForm(\'' + app.id + '\')">+ New Submission</button>' +
    '</div>' +
    '<div id="submissions-list"><div class="loading">Loading...</div></div>';

    loadSubmissions(app.id);
  };

  async function loadSubmissions(appId) {
    var listEl = document.getElementById('submissions-list');
    try {
      var subs = await marqFetch('/apps/' + appId + '/submissions');

      if (!subs || subs.length === 0) {
        listEl.innerHTML = '<div class="empty-state" style="padding:30px"><p class="text-muted">No submissions yet. Create a submission to start the review process.</p></div>';
        return;
      }

      var html = '';
      for (var i = 0; i < subs.length; i++) {
        var s = subs[i];
        var scoreColor = s.pre_check_score >= 80 ? 'var(--green)' : s.pre_check_score >= 50 ? 'var(--yellow)' : 'var(--red)';
        var isRejected = s.status === 'rejected';

        html += '<div class="card submission-card" style="margin-bottom:12px">' +
          '<div class="submission-row">' +
            '<div class="submission-main">' +
              '<span class="badge ' + (s.store === 'apple' ? 'badge-ios' : 'badge-android') + '">' + esc(s.store) + '</span> ' +
              '<strong>v' + esc(s.version) + '</strong>' +
              (s.build_number ? ' <span class="text-muted">(build ' + esc(s.build_number) + ')</span>' : '') +
              ' ' + statusBadge(s.status) +
              (s.pre_check_score != null ? ' <span style="color:' + scoreColor + ';font-weight:600;font-size:12px">' + s.pre_check_score + '/100</span>' : '') +
            '</div>' +
            '<div class="submission-actions">' +
              '<button class="btn btn-sm" onclick="runChecksForSubmission(\'' + appId + '\',\'' + s.id + '\')">Run Checks</button>' +
              (canPushMeta(s.status) ? '<button class="btn btn-sm" onclick="pushMetadata(\'' + s.id + '\')" title="Push metadata to ' + esc(s.store) + '">Push Metadata</button>' : '') +
              (canSubmit(s.status) ? '<button class="btn btn-sm btn-primary" onclick="submitToStore(\'' + s.id + '\')" title="Submit for review on ' + esc(s.store) + '">Submit to Store</button>' : '') +
              '<button class="btn btn-sm" onclick="viewSubmissionDetail(\'' + s.id + '\')">Details</button>' +
              (isRejected ? '<button class="btn btn-sm btn-primary" onclick="checkResubmit(\'' + s.id + '\')">Check Resubmit</button>' : '') +
            '</div>' +
          '</div>' +
          '<div class="submission-meta text-muted" style="font-size:11px;margin-top:6px">' +
            'Created ' + formatDate(s.created_at) +
            (s.submitted_at ? ' &middot; Submitted ' + formatDate(s.submitted_at) : '') +
            (s.reviewed_at ? ' &middot; Reviewed ' + formatDate(s.reviewed_at) : '') +
          '</div>';

        // Rejection reason inline
        if (isRejected && s.rejection_reason) {
          html += '<div class="rejection-banner">' +
            '<strong>Rejection:</strong> ' + esc(s.rejection_reason) +
          '</div>';
        }

        // Task relay section (shown for rejected submissions)
        if (isRejected) {
          html += '<div class="task-relay-section" id="relay-' + s.id + '">' +
            '<div class="text-muted" style="font-size:12px;padding:4px 0">Loading linked tasks...</div>' +
          '</div>';
        }

        html += '</div>';
      }

      listEl.innerHTML = html;

      // Load task relays for rejected submissions
      for (var j = 0; j < subs.length; j++) {
        if (subs[j].status === 'rejected') {
          loadTaskRelays(appId, subs[j].id);
        }
      }
    } catch (e) {
      listEl.innerHTML = '<div class="text-muted" style="padding:20px">Failed to load submissions: ' + esc(e.message) + '</div>';
    }
  }

  async function loadTaskRelays(appId, subId) {
    var el = document.getElementById('relay-' + subId);
    if (!el) return;

    try {
      var relays = await marqFetch('/apps/' + appId + '/task-relays');
      // Filter to this submission
      var subRelays = relays.filter(function (r) { return r.submission_id === subId; });

      if (subRelays.length === 0) {
        el.innerHTML = '<div class="text-muted" style="font-size:12px;padding:4px 0">No fix tasks created yet. Update the submission status to \'rejected\' with rejection details to auto-generate tasks.</div>';
        return;
      }

      var html = '<div class="relay-header">Linked Fix Tasks (' + subRelays.length + ')</div>';
      for (var i = 0; i < subRelays.length; i++) {
        var r = subRelays[i];
        var taskStatusClass = r.status === 'completed' || r.status === 'closed' ? 'relay-done' : 'relay-open';
        var icon = r.status === 'completed' || r.status === 'closed' ? '\u2705' : '\u23F3';
        html += '<div class="relay-item ' + taskStatusClass + '">' +
          '<span class="relay-icon">' + icon + '</span>' +
          '<span class="relay-type badge badge-purple">' + esc(r.task_type || 'general') + '</span>' +
          '<span class="relay-status">' + statusBadge(r.status || 'open') + '</span>' +
          (r.teamhub_item_id ? '<span class="text-muted" style="font-size:11px">TeamHub: ' + esc(r.teamhub_item_id.slice(0, 8)) + '...</span>' : '') +
        '</div>';
      }

      var allDone = subRelays.every(function (r) { return r.status === 'completed' || r.status === 'closed'; });
      if (allDone) {
        html += '<div class="relay-ready"><span>\u2705</span> All tasks complete — ready for resubmission check</div>';
      }

      el.innerHTML = html;
    } catch (e) {
      el.innerHTML = '<div class="text-muted" style="font-size:12px">Failed to load tasks</div>';
    }
  }

  window.viewSubmissionDetail = async function (subId) {
    try {
      var sub = await marqFetch('/submissions/' + subId);
      var overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.style.display = 'flex';
      overlay.onclick = function (e) { if (e.target === overlay) overlay.remove(); };

      var html = '<div class="modal" style="max-width:640px">' +
        '<h2>Submission Detail</h2>' +
        '<div class="form-row" style="margin-bottom:12px">' +
          '<div><span class="text-muted">Store:</span> <span class="badge ' + (sub.store === 'apple' ? 'badge-ios' : 'badge-android') + '">' + esc(sub.store) + '</span></div>' +
          '<div><span class="text-muted">Version:</span> ' + esc(sub.version) + '</div>' +
        '</div>' +
        '<div class="form-row" style="margin-bottom:12px">' +
          '<div><span class="text-muted">Status:</span> ' + statusBadge(sub.status) + '</div>' +
          '<div><span class="text-muted">Score:</span> ' + (sub.pre_check_score != null ? sub.pre_check_score + '/100' : 'N/A') + '</div>' +
        '</div>';

      if (sub.rejection_reason) {
        html += '<div class="rejection-banner" style="margin-bottom:12px"><strong>Rejection:</strong> ' + esc(sub.rejection_reason) + '</div>';
      }

      // Pre-checks summary
      if (sub.pre_checks && sub.pre_checks.length > 0) {
        var passed = sub.pre_checks.filter(function (c) { return c.status === 'passed'; }).length;
        var failed = sub.pre_checks.filter(function (c) { return c.status === 'failed'; }).length;
        html += '<h3 style="font-size:14px;margin:12px 0 8px">Pre-Checks (' + passed + ' passed, ' + failed + ' failed)</h3>';
      }

      // Review events
      if (sub.review_events && sub.review_events.length > 0) {
        html += '<h3 style="font-size:14px;margin:12px 0 8px">Review Events</h3>';
        for (var i = 0; i < sub.review_events.length; i++) {
          var ev = sub.review_events[i];
          html += '<div style="font-size:12px;padding:4px 0;border-bottom:1px solid var(--border)">' +
            '<span class="text-muted">' + formatDate(ev.created_at) + '</span> ' +
            esc(ev.parsed_summary || ev.event_type) +
            ' <span class="badge badge-gray">' + esc(ev.source) + '</span>' +
          '</div>';
        }
      }

      // Task relays
      if (sub.task_relays && sub.task_relays.length > 0) {
        html += '<h3 style="font-size:14px;margin:12px 0 8px">Linked Tasks (' + sub.task_relays.length + ')</h3>';
        for (var j = 0; j < sub.task_relays.length; j++) {
          var r = sub.task_relays[j];
          var done = r.status === 'completed' || r.status === 'closed';
          html += '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px">' +
            (done ? '\u2705' : '\u23F3') +
            ' <span class="badge badge-purple">' + esc(r.task_type) + '</span> ' +
            statusBadge(r.status) +
          '</div>';
        }
      }

      // Store workflow actions
      html += '<div class="modal-actions" style="flex-wrap:wrap">';
      if (canPushMeta(sub.status)) {
        html += '<button class="btn btn-sm" onclick="this.closest(\'.modal-overlay\').remove();pushMetadata(\'' + sub.id + '\')">Push Metadata</button>';
      }
      if (canSubmit(sub.status)) {
        html += '<button class="btn btn-sm btn-primary" onclick="this.closest(\'.modal-overlay\').remove();submitToStore(\'' + sub.id + '\')">Submit to Store</button>';
      }
      html += '<button class="btn" onclick="this.closest(\'.modal-overlay\').remove()">Close</button>' +
      '</div></div>';

      overlay.innerHTML = html;
      document.body.appendChild(overlay);
    } catch (e) {
      showToast('Failed to load submission: ' + e.message, 'error');
    }
  };

  window.checkResubmit = async function (subId) {
    showToast('Checking resubmission readiness...', 'success');
    try {
      var result = await marqFetch('/submissions/' + subId + '/check-resubmit', { method: 'POST' });

      var overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.style.display = 'flex';
      overlay.onclick = function (e) { if (e.target === overlay) overlay.remove(); };

      var readyIcon = result.ready ? '\u2705' : '\u274C';
      var readyText = result.ready ? 'Ready to Resubmit!' : 'Not Ready';
      var readyColor = result.ready ? 'var(--green)' : 'var(--red)';

      var html = '<div class="modal" style="max-width:420px;text-align:center">' +
        '<div style="font-size:48px;margin-bottom:12px">' + readyIcon + '</div>' +
        '<h2 style="color:' + readyColor + '">' + readyText + '</h2>';

      if (result.ready) {
        html += '<p style="margin:12px 0;color:var(--text-muted)">All fix tasks are complete and pre-checks pass. Score: <strong style="color:var(--green)">' + (result.score || '?') + '/100</strong></p>' +
          '<p style="font-size:13px;color:var(--text-muted)">' + (result.passed || 0) + ' checks passed, ' + (result.failed || 0) + ' failed</p>';
      } else {
        html += '<p style="margin:12px 0;color:var(--text-muted)">' + esc(result.reason || 'Some tasks are still open or checks are failing.') + '</p>';
        if (result.open_tasks && result.open_tasks.length > 0) {
          html += '<div style="text-align:left;margin:12px 0"><strong style="font-size:13px">Open tasks:</strong>';
          for (var i = 0; i < result.open_tasks.length; i++) {
            html += '<div style="font-size:12px;color:var(--text-muted);padding:2px 0">\u23F3 ' + esc(result.open_tasks[i]) + '</div>';
          }
          html += '</div>';
        }
        if (result.score != null) {
          html += '<p style="font-size:13px;margin-top:8px">Score: ' + result.score + '/100 (' + (result.passed || 0) + ' passed, ' + (result.failed || 0) + ' failed)</p>';
        }
      }

      html += '<div class="modal-actions" style="justify-content:center">' +
        '<button class="btn" onclick="this.closest(\'.modal-overlay\').remove()">Close</button>' +
      '</div></div>';

      overlay.innerHTML = html;
      document.body.appendChild(overlay);

      // Reload submissions to reflect any status changes
      if (window.marqState.currentApp) loadSubmissions(window.marqState.currentApp.id);
    } catch (e) {
      showToast('Check failed: ' + e.message, 'error');
    }
  };

  // ── Store workflow helpers ──────────────────────────────────

  function canPushMeta(status) {
    return ['preparing', 'draft', 'ready', 'pre_check_failed'].indexOf(status) !== -1;
  }

  function canSubmit(status) {
    return ['preparing', 'ready'].indexOf(status) !== -1;
  }

  window.pushMetadata = async function (subId) {
    if (!confirm('Push metadata to the store? This will update the store listing.')) return;
    showToast('Pushing metadata to store...', 'success');
    try {
      var result = await marqFetch('/submissions/' + subId + '/push-metadata', { method: 'POST' });
      if (result.ok) {
        showToast('Metadata pushed successfully', 'success');
      } else {
        showToast('Push failed: ' + (result.error || 'Unknown error'), 'error');
      }
    } catch (e) {
      showToast('Push failed: ' + e.message, 'error');
    }
  };

  window.submitToStore = async function (subId) {
    if (!confirm('Submit this version for store review? This action cannot be undone.')) return;
    showToast('Submitting for review...', 'success');
    try {
      var result = await marqFetch('/submissions/' + subId + '/submit-to-store', { method: 'POST' });
      if (result.first_upload_required) {
        showToast('First upload must be done manually via Google Play Console', 'error');
        showFirstUploadGuide();
        return;
      }
      if (result.ok) {
        showToast('Submitted for review!', 'success');
        if (window.marqState.currentApp) loadSubmissions(window.marqState.currentApp.id);
      } else {
        showToast('Submit failed: ' + (result.error || 'Unknown error'), 'error');
      }
    } catch (e) {
      showToast('Submit failed: ' + e.message, 'error');
    }
  };

  function showFirstUploadGuide() {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';
    overlay.onclick = function (e) { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = '<div class="modal" style="max-width:480px">' +
      '<h2>First Upload Required</h2>' +
      '<div class="first-upload-guide">' +
        '<p style="margin-bottom:12px;color:var(--text-muted)">Google Play requires the first APK/AAB to be uploaded manually through the Play Console. After that, Marq can handle subsequent releases.</p>' +
        '<ol style="color:var(--text);font-size:13px;line-height:2;padding-left:20px">' +
          '<li>Go to <strong>Google Play Console</strong></li>' +
          '<li>Select your app</li>' +
          '<li>Go to <strong>Production &rarr; Create new release</strong></li>' +
          '<li>Upload your <strong>.aab</strong> or <strong>.apk</strong> file</li>' +
          '<li>Complete the release form and submit</li>' +
          '<li>Return to Marq for status monitoring</li>' +
        '</ol>' +
      '</div>' +
      '<div class="modal-actions"><button class="btn" onclick="this.closest(\'.modal-overlay\').remove()">Got it</button></div>' +
    '</div>';
    document.body.appendChild(overlay);
  }

  window.showNewSubmissionForm = function (appId) {
    var app = window.marqState.currentApp;
    var area = document.getElementById('metadata-form-area') || document.getElementById('content');

    // Insert form inline
    var formDiv = document.createElement('div');
    formDiv.id = 'new-sub-form';
    formDiv.className = 'modal-overlay';
    formDiv.style.display = 'flex';
    formDiv.onclick = function(e) { if (e.target === formDiv) formDiv.remove(); };
    formDiv.innerHTML = '<div class="modal" style="max-width:420px">' +
      '<h2>New Submission</h2>' +
      '<div class="form-row">' +
        formGroup('Store', selectHtml('sub-store', STORES, 'google')) +
        formGroup('Version', '<input id="sub-version" value="' + esc(app ? app.current_version || '1.0.0' : '1.0.0') + '">') +
      '</div>' +
      formGroup('Build Number', '<input id="sub-build" placeholder="42">') +
      formGroup('Review Notes', '<textarea id="sub-notes" rows="3" placeholder="Notes for the reviewer (demo account, etc.)"></textarea>') +
      '<div class="modal-actions">' +
        '<button class="btn" onclick="this.closest(\'.modal-overlay\').remove()">Cancel</button>' +
        '<button class="btn btn-primary" onclick="createSubmission(\'' + appId + '\')">Create</button>' +
      '</div>' +
    '</div>';
    document.body.appendChild(formDiv);
  };

  window.createSubmission = async function (appId) {
    try {
      await marqFetch('/apps/' + appId + '/submissions', {
        method: 'POST',
        body: JSON.stringify({
          store: val('sub-store'),
          version: val('sub-version'),
          build_number: val('sub-build') || undefined,
          notes: val('sub-notes') || undefined,
        }),
      });
      showToast('Submission created', 'success');
      var form = document.getElementById('new-sub-form');
      if (form) form.remove();
      loadSubmissions(appId);
    } catch (e) {
      showToast('Failed: ' + e.message, 'error');
    }
  };

  window.runChecksForSubmission = async function (appId, subId) {
    showToast('Running checks...', 'success');
    try {
      var result = await marqFetch('/apps/' + appId + '/run-checks?submission_id=' + subId, { method: 'POST' });
      window.marqState.lastCheckResults = result;
      showToast('Score: ' + result.score + '/100', result.has_blockers ? 'error' : 'success');
      loadSubmissions(appId);
    } catch (e) {
      showToast('Check failed: ' + e.message, 'error');
    }
  };

  // ═══════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════

  function statusBadgeMeta(status) {
    var map = { draft: 'badge-gray', ready: 'badge-blue', submitted: 'badge-yellow', published: 'badge-green' };
    return '<span class="badge ' + (map[status] || 'badge-gray') + '">' + (status || 'draft') + '</span>';
  }

  function formGroup(label, inputHtml) {
    return '<div class="form-group"><label>' + label + '</label>' + inputHtml + '</div>';
  }

  function selectHtml(id, options, selected) {
    var html = '<select id="' + id + '">';
    for (var i = 0; i < options.length; i++) {
      html += '<option value="' + options[i] + '"' + (options[i] === selected ? ' selected' : '') + '>' + options[i] + '</option>';
    }
    html += '</select>';
    return html;
  }

  function val(id) {
    var el = document.getElementById(id);
    return el ? el.value.trim() : '';
  }

  function truncate(s, n) {
    if (!s) return '';
    return s.length > n ? s.slice(0, n) + '...' : s;
  }

})();
