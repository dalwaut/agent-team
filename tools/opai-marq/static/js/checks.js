/**
 * Marq — Pre-Submission Checks View
 *
 * Displays check results grouped by category with pass/fail/skip badges,
 * expandable details, recommendations, doc links, action links, auto-fix, and score meter.
 */
(function () {
  'use strict';

  // Category labels and order
  const CATEGORIES = [
    { id: 'legal',    label: 'Legal / Privacy',   icon: '\u2696' },
    { id: 'design',   label: 'Design / Assets',   icon: '\uD83C\uDFA8' },
    { id: 'metadata', label: 'Metadata',           icon: '\uD83D\uDCDD' },
    { id: 'technical',label: 'Technical',           icon: '\u2699' },
    { id: 'safety',   label: 'Safety / Compliance', icon: '\uD83D\uDEE1' },
  ];

  // Map check_id to an action: { label, tab } navigates to a tab, { label, action:'editApp' } opens Edit App
  var ACTION_MAP = {
    // Legal / settings -> Edit App modal
    privacy_policy_exists:    { label: 'Edit App',       action: 'editApp' },
    privacy_policy_content:   { label: 'Edit App',       action: 'editApp' },
    support_url_accessible:   { label: 'Edit App',       action: 'editApp' },
    contact_info_present:     { label: 'Edit App',       action: 'editApp' },
    account_deletion:         { label: 'Edit App',       action: 'editApp' },
    // Design / Assets -> Assets tab
    screenshots_count:            { label: 'Go to Assets',   action: 'tab', tab: 'assets' },
    screenshots_dimensions:       { label: 'Go to Assets',   action: 'tab', tab: 'assets' },
    screenshots_minimum_count:    { label: 'Go to Assets',   action: 'tab', tab: 'assets' },
    screenshots_format:           { label: 'Go to Assets',   action: 'tab', tab: 'assets' },
    screenshots_accuracy:         { label: 'Go to Assets',   action: 'tab', tab: 'assets' },
    feature_graphic_android:      { label: 'Go to Assets',   action: 'tab', tab: 'assets' },
    icon_specs:                   { label: 'Go to Assets',   action: 'tab', tab: 'assets' },
    // Metadata -> Metadata tab
    app_name_length:          { label: 'Go to Metadata', action: 'tab', tab: 'metadata' },
    description_quality:      { label: 'Go to Metadata', action: 'tab', tab: 'metadata' },
    keywords_optimization:    { label: 'Go to Metadata', action: 'tab', tab: 'metadata' },
    release_notes_present:    { label: 'Go to Metadata', action: 'tab', tab: 'metadata' },
    localization_completeness:{ label: 'Go to Metadata', action: 'tab', tab: 'metadata' },
    // Compliance -> Edit App
    export_compliance:        { label: 'Edit App',       action: 'editApp' },
    content_rating_complete:  { label: 'Edit App',       action: 'editApp' },
    iap_compliance:           { label: 'Edit App',       action: 'editApp' },
    subscription_disclosure:  { label: 'Go to Metadata', action: 'tab', tab: 'metadata' },
  };

  // Checks that can be auto-fixed via the backend
  var AUTO_FIXABLE_CHECKS = [
    'export_compliance',
    'keywords_optimization',
    'description_quality',
    'release_notes_present',
    'app_name_length',
    'localization_completeness',
    'screenshots_minimum_count',
    'feature_graphic_android',
    'icon_specs',
  ];

  window.renderChecksTab = function (el) {
    const app = window.marqState.currentApp;
    if (!app) {
      el.innerHTML = emptyState('\u2705', 'Select an app first', 'Go to Dashboard and click on an app to run pre-checks.');
      return;
    }

    const lastResults = window.marqState.lastCheckResults;

    let html = '<div class="checks-header">' +
      '<div class="checks-title">' +
        '<h2>Pre-Submission Checks</h2>' +
        '<span class="text-muted">31 automated checks for ' + esc(app.name) + '</span>' +
      '</div>' +
      '<div style="display:flex;gap:8px">' +
        (lastResults && lastResults.failed > 0
          ? '<button class="btn" id="btn-autofix-all" onclick="autoFixAll(\'' + app.id + '\')">\u2728 Auto-Fix All</button>'
          : '') +
        '<button class="btn btn-primary" id="btn-run-checks" onclick="runChecksUI(\'' + app.id + '\')">' +
          '\u25B6 Run All Checks' +
        '</button>' +
      '</div>' +
    '</div>';

    if (!lastResults) {
      html += emptyState('\u2705', 'No check results yet', 'Click "Run All Checks" to validate your app against Apple and Google store requirements.');
      el.innerHTML = html;
      return;
    }

    // Score summary
    html += renderScoreSummary(lastResults);

    // Group results by category
    html += renderGroupedResults(lastResults.results || []);

    el.innerHTML = html;
  };

  // ── Run checks ─────────────────────────────────────────────
  window.runChecksUI = async function (appId) {
    const btn = document.getElementById('btn-run-checks');
    if (btn) { btn.disabled = true; btn.textContent = 'Running...'; }

    try {
      const result = await marqFetch('/apps/' + appId + '/run-checks', { method: 'POST' });
      window.marqState.lastCheckResults = result;
      showToast('Score: ' + result.score + '/100 — ' + result.passed + ' passed, ' + result.failed + ' failed', result.has_blockers ? 'error' : 'success');
      renderChecksTab(document.getElementById('content'));
    } catch (e) {
      showToast('Check failed: ' + e.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = '\u25B6 Run All Checks'; }
    }
  };

  // ── Auto-fix single check ──────────────────────────────────
  window.autoFixCheck = async function (appId, checkId) {
    var btn = document.querySelector('[data-autofix="' + checkId + '"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Fixing...'; }

    try {
      var result = await marqFetch('/apps/' + appId + '/auto-fix/' + checkId, { method: 'POST' });
      if (result.fixed) {
        showToast('Fixed: ' + (result.message || checkId), 'success');
      } else {
        showToast(result.message || 'Could not auto-fix this check', 'error');
      }
      // Re-run checks to see updated results
      await runChecksUI(appId);
    } catch (e) {
      showToast('Auto-fix failed: ' + e.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = '\u2728 Auto Fix'; }
    }
  };

  // ── Auto-fix all fixable checks ────────────────────────────
  window.autoFixAll = async function (appId) {
    var btn = document.getElementById('btn-autofix-all');
    if (btn) { btn.disabled = true; btn.textContent = 'Fixing...'; }

    try {
      var result = await marqFetch('/apps/' + appId + '/auto-fix-all', { method: 'POST' });
      var fixedCount = (result.results || []).filter(function(r) { return r.fixed; }).length;
      showToast('Auto-fix complete: ' + fixedCount + ' issue(s) fixed', fixedCount > 0 ? 'success' : 'error');
      // Re-run checks
      await runChecksUI(appId);
    } catch (e) {
      showToast('Auto-fix failed: ' + e.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = '\u2728 Auto-Fix All'; }
    }
  };

  // ── Score Summary Card ─────────────────────────────────────
  function renderScoreSummary(r) {
    const score = r.score || 0;
    const color = score >= 80 ? 'var(--green)' : score >= 50 ? 'var(--yellow)' : 'var(--red)';
    const label = r.has_blockers ? 'BLOCKED — fix all blockers before submitting' : score >= 80 ? 'Ready to submit' : 'Needs attention';

    return '<div class="card checks-summary">' +
      '<div class="score-ring" style="--score-color:' + color + '">' +
        '<div class="score-ring-value" style="color:' + color + '">' + score + '</div>' +
        '<div class="score-ring-label">/ 100</div>' +
      '</div>' +
      '<div class="checks-summary-stats">' +
        '<div class="stat stat-pass"><span class="stat-num">' + r.passed + '</span><span class="stat-label">Passed</span></div>' +
        '<div class="stat stat-fail"><span class="stat-num">' + r.failed + '</span><span class="stat-label">Failed</span></div>' +
        '<div class="stat stat-skip"><span class="stat-num">' + r.skipped + '</span><span class="stat-label">Skipped</span></div>' +
        '<div class="stat stat-total"><span class="stat-num">' + r.total + '</span><span class="stat-label">Total</span></div>' +
      '</div>' +
      '<div class="checks-summary-label" style="color:' + color + '">' + label + '</div>' +
    '</div>';
  }

  // ── Grouped Results ────────────────────────────────────────
  function renderGroupedResults(results) {
    let html = '';
    for (const cat of CATEGORIES) {
      const catResults = results.filter(function(r) { return r.category === cat.id; });
      if (catResults.length === 0) continue;

      const catPassed = catResults.filter(function(r) { return r.status === 'passed'; }).length;
      const catFailed = catResults.filter(function(r) { return r.status === 'failed'; }).length;

      html += '<div class="check-category">' +
        '<div class="check-category-header" onclick="toggleCategory(\'' + cat.id + '\')">' +
          '<div class="check-category-title">' +
            '<span>' + cat.icon + '</span> ' + cat.label +
            '<span class="check-category-count">' + catPassed + '/' + catResults.length + ' passed</span>' +
          '</div>' +
          '<div class="check-category-badges">' +
            (catFailed > 0 ? '<span class="badge badge-red">' + catFailed + ' failed</span>' : '') +
            '<span class="chevron" id="chevron-' + cat.id + '">\u25BC</span>' +
          '</div>' +
        '</div>' +
        '<div class="check-category-body" id="cat-body-' + cat.id + '">';

      for (const r of catResults) {
        html += renderCheckRow(r);
      }

      html += '</div></div>';
    }
    return html;
  }

  // ── Single Check Row ───────────────────────────────────────
  function renderCheckRow(r) {
    var app = window.marqState.currentApp;
    var appId = app ? app.id : '';
    const statusClass = r.status === 'passed' ? 'check-pass' : r.status === 'failed' ? 'check-fail' : 'check-skip';
    const statusIcon = r.status === 'passed' ? '\u2705' : r.status === 'failed' ? '\u274C' : '\u23ED';

    // Only show severity badge on failed/skipped items
    var severityBadge = '';
    if (r.status !== 'passed') {
      severityBadge = r.severity === 'blocker'
        ? '<span class="badge badge-red">blocker</span>'
        : '<span class="badge badge-yellow">warning</span>';
    }

    // Build detail content for failed/skipped only
    let detailsHtml = '';
    if (r.status !== 'passed') {
      if (r.recommendation) {
        detailsHtml += '<div class="check-recommendation">' + esc(r.recommendation) + '</div>';
      }

      // Action buttons row
      var buttonsHtml = '';

      if (r.doc_url) {
        buttonsHtml += '<a class="btn btn-sm check-action-btn" href="' + esc(r.doc_url) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">View Guidelines \u2197</a>';
      }

      // Auto-fix button (for checks that support it)
      if (r.status === 'failed' && (r.auto_fixable || AUTO_FIXABLE_CHECKS.indexOf(r.check_id) !== -1)) {
        buttonsHtml += '<button class="btn btn-sm check-autofix-btn" data-autofix="' + esc(r.check_id) + '" onclick="event.stopPropagation(); autoFixCheck(\'' + appId + '\', \'' + esc(r.check_id) + '\')">\u2728 Auto Fix</button>';
      }

      // Navigation action link
      var act = ACTION_MAP[r.check_id];
      if (act) {
        if (act.action === 'tab') {
          buttonsHtml += '<button class="btn btn-sm check-action-btn" onclick="event.stopPropagation(); switchTab(\'' + act.tab + '\')">' + esc(act.label) + ' \u2192</button>';
        } else if (act.action === 'editApp') {
          buttonsHtml += '<button class="btn btn-sm check-action-btn" onclick="event.stopPropagation(); showEditAppForm(marqState.currentApp);">' + esc(act.label) + ' \u2192</button>';
        }
      }

      if (buttonsHtml) {
        detailsHtml += '<div class="check-action-row">' + buttonsHtml + '</div>';
      }

      // JSON details as a plain pre block
      if (r.details && Object.keys(r.details).length > 0) {
        detailsHtml += '<div class="check-details-label">Details</div>' +
          '<pre class="check-details-json">' + esc(JSON.stringify(r.details, null, 2)) + '</pre>';
      }
    }

    // Passed rows: no expandable detail, no severity badge
    var clickAttr = detailsHtml ? ' onclick="toggleCheckDetail(this)"' : '';
    var cursorClass = detailsHtml ? '' : ' check-no-expand';

    return '<div class="check-row ' + statusClass + cursorClass + '"' + clickAttr + '>' +
      '<div class="check-row-main">' +
        '<span class="check-status-icon">' + statusIcon + '</span>' +
        '<div class="check-info">' +
          '<div class="check-name">' + formatCheckId(r.check_id) + '</div>' +
          '<div class="check-description">' + esc(r.description || '') + '</div>' +
        '</div>' +
        (severityBadge ? '<div class="check-badges">' + severityBadge + '</div>' : '') +
      '</div>' +
      (detailsHtml ? '<div class="check-detail" style="display:none">' + detailsHtml + '</div>' : '') +
    '</div>';
  }

  // ── Toggle helpers ─────────────────────────────────────────
  window.toggleCategory = function (catId) {
    var body = document.getElementById('cat-body-' + catId);
    var chevron = document.getElementById('chevron-' + catId);
    if (body.style.display === 'none') {
      body.style.display = '';
      chevron.textContent = '\u25BC';
    } else {
      body.style.display = 'none';
      chevron.textContent = '\u25B6';
    }
  };

  window.toggleCheckDetail = function (row) {
    var detail = row.querySelector('.check-detail');
    if (detail) {
      detail.style.display = detail.style.display === 'none' ? '' : 'none';
    }
  };

  // ── Helpers ────────────────────────────────────────────────
  function formatCheckId(id) {
    if (!id) return '';
    return id.replace(/_/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
  }

})();
