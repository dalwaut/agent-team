/**
 * HELM -- Autonomous Business Runner -- Dashboard, HITL, Actions
 * Renders the main per-business dashboard, HITL queue, and activity log.
 */

'use strict';

// ── Dashboard ────────────────────────────────────────────────────────────────
async function renderDashboard() {
    var el = document.getElementById('view-dashboard');
    if (!HELM.currentBusiness) {
        el.innerHTML = '<p style="padding:40px;text-align:center;color:var(--text-muted);">Select a business first.</p>';
        return;
    }

    el.innerHTML = '<div class="flex-center" style="padding:60px;"><div class="spinner spinner-lg"></div></div>';

    try {
        var data = await bizApi('/dashboard');
        renderDashboardContent(el, data);
    } catch (err) {
        el.innerHTML = '<div style="padding:40px;text-align:center;"><p style="color:var(--error);">Failed to load dashboard</p><p style="color:var(--text-muted);font-size:13px;">' + esc(err.message) + '</p><button class="btn" onclick="renderDashboard()" style="margin-top:12px;">Retry</button></div>';
    }
}

function renderDashboardContent(el, data) {
    var stats = data.stats || {};
    var social = data.social || [];
    var queue = data.content_queue || [];
    var actions = data.recent_actions || [];
    var hitlItems = data.hitl_pending || [];
    var goals = data.goals || [];
    var alerts = data.alerts || [];

    var html = '';

    // ── Alerts ───────────────────────────────────────────────
    if (alerts.length > 0) {
        html += '<div style="margin-bottom:16px;">';
        alerts.forEach(function(a) {
            var cls = a.level === 'error' ? 'alert-error' : (a.level === 'warning' ? 'alert-warning' : 'alert-info');
            html += '<div class="alert ' + cls + '">' + esc(a.message) + '</div>';
        });
        html += '</div>';
    }

    // ── Health Score + KPIs ──────────────────────────────────
    var score = stats.health_score != null ? stats.health_score : (HELM.currentBusiness.health_score || null);
    html += '<div class="stat-grid">';

    // Health score as first stat
    if (score != null) {
        html +=
            '<div class="stat-card">' +
                '<div class="stat-label">Health Score</div>' +
                '<div class="health-score">' +
                    '<span class="score-num ' + healthScoreClass(score) + '">' + score + '</span>' +
                    '<div class="health-bar"><div class="bar-fill ' + healthFillClass(score) + '" style="width:' + Math.min(score, 100) + '%"></div></div>' +
                '</div>' +
            '</div>';
    }

    // Revenue KPIs
    var kpis = [
        { label: 'MRR',        value: fmtCurrency(stats.mrr, true),          trend: stats.mrr_trend },
        { label: 'This Month', value: fmtCurrency(stats.revenue_month, true), trend: stats.revenue_trend },
        { label: 'New Subs',   value: fmtNum(stats.new_subs),                 trend: stats.subs_trend },
        { label: 'Churn',      value: stats.churn != null ? stats.churn + '%' : '--', trend: stats.churn_trend },
    ];

    kpis.forEach(function(kpi) {
        var trendHtml = '';
        if (kpi.trend != null) {
            var trendDir = kpi.trend > 0 ? 'up' : (kpi.trend < 0 ? 'down' : 'flat');
            var arrow = kpi.trend > 0 ? '\u2191' : (kpi.trend < 0 ? '\u2193' : '\u2192');
            trendHtml = '<div class="stat-trend ' + trendDir + '">' + arrow + ' ' + Math.abs(kpi.trend) + '%</div>';
        }
        html +=
            '<div class="stat-card">' +
                '<div class="stat-label">' + esc(kpi.label) + '</div>' +
                '<div class="stat-value">' + esc(kpi.value) + '</div>' +
                trendHtml +
            '</div>';
    });

    html += '</div>';

    // ── Grid Layout ──────────────────────────────────────────
    html += '<div class="dash-grid">';

    // ── Social Overview ──────────────────────────────────────
    html += '<div class="card">' +
        '<div class="card-header"><h3>Social Overview</h3></div>' +
        '<div class="card-body">';

    if (social.length > 0) {
        html += '<table class="data-table"><thead><tr>' +
            '<th>Platform</th><th>Followers</th><th>Last Post</th><th>Engagement</th><th>Status</th>' +
            '</tr></thead><tbody>';
        social.forEach(function(s) {
            var statusCls = s.status === 'connected' ? 'connected' : (s.status === 'error' ? 'error' : 'inactive');
            html += '<tr>' +
                '<td><span class="platform-icon ' + esc(s.platform) + '" style="width:24px;height:24px;font-size:11px;display:inline-flex;vertical-align:middle;margin-right:6px;">' + esc((s.platform || '').charAt(0).toUpperCase()) + '</span>' + esc(s.platform) + '</td>' +
                '<td>' + fmtNum(s.followers) + '</td>' +
                '<td>' + timeAgo(s.last_post_at) + '</td>' +
                '<td>' + (s.engagement != null ? s.engagement + '%' : '--') + '</td>' +
                '<td><span class="status-dot ' + statusCls + '"></span>' + esc(s.status || 'unknown') + '</td>' +
                '</tr>';
        });
        html += '</tbody></table>';
    } else {
        html += '<p style="color:var(--text-muted);text-align:center;padding:20px;">No social accounts connected</p>';
    }

    html += '</div></div>';

    // ── Content Queue ────────────────────────────────────────
    html += '<div class="card">' +
        '<div class="card-header"><h3>Content Queue</h3></div>' +
        '<div class="card-body">';

    if (queue.length > 0) {
        queue.slice(0, 5).forEach(function(item) {
            html += '<div class="queue-item">' +
                '<span class="queue-date">' + fmtDate(item.scheduled_at) + '</span>' +
                '<span class="queue-title">' + esc(item.title || item.excerpt || 'Untitled') + '</span>' +
                '<span class="queue-platform">' + esc(item.platform || '') + '</span>' +
                '<button class="btn btn-sm btn-ghost" onclick="showToast(\'Editor coming soon\', \'info\')">Edit</button>' +
            '</div>';
        });
    } else {
        html += '<p style="color:var(--text-muted);text-align:center;padding:20px;">No content scheduled</p>';
    }

    html += '</div></div>';

    // ── Recent Actions ───────────────────────────────────────
    html += '<div class="card">' +
        '<div class="card-header"><h3>Recent AI Actions</h3><button class="btn btn-sm btn-ghost" onclick="showTab(\'actions\')">View All</button></div>' +
        '<div class="card-body">';

    if (actions.length > 0) {
        html += '<div class="action-list">';
        actions.slice(0, 5).forEach(function(a) {
            var statusBadge = (a.status === 'completed' || a.status === 'success') ? 'badge-success' :
                              a.status === 'failed' ? 'badge-error' :
                              a.status === 'pending' ? 'badge-warning' : 'badge-neutral';
            html += '<div class="action-item">' +
                '<div class="action-icon">' + actionIcon(a.action_type) + '</div>' +
                '<div class="action-info">' +
                    '<div class="action-summary">' + esc(a.summary || a.action_type) + '</div>' +
                    '<div class="action-time">' + timeAgo(a.created_at) + '</div>' +
                '</div>' +
                '<span class="badge ' + statusBadge + '">' + esc(a.status || 'unknown') + '</span>' +
            '</div>';
        });
        html += '</div>';
    } else {
        html += '<p style="color:var(--text-muted);text-align:center;padding:20px;">No actions yet</p>';
    }

    html += '</div></div>';

    // ── HITL Queue Preview ───────────────────────────────────
    html += '<div class="card">' +
        '<div class="card-header"><h3>Pending Approvals</h3><button class="btn btn-sm btn-ghost" onclick="showTab(\'hitl\')">Review All</button></div>' +
        '<div class="card-body">';

    if (hitlItems.length > 0) {
        html += '<div class="hitl-list">';
        hitlItems.slice(0, 3).forEach(function(item) {
            html += '<div class="hitl-item ' + riskClass(item.risk_level) + '">' +
                '<div class="hitl-header">' +
                    '<span class="badge ' + riskBadgeClass(item.risk_level) + '">' + esc(item.risk_level || 'low') + '</span>' +
                    '<span class="hitl-title">' + esc(item.title) + '</span>' +
                '</div>' +
                '<div class="hitl-desc">' + esc(item.description || '') + '</div>' +
                '<div class="hitl-actions">' +
                    '<button class="btn btn-sm btn-primary" onclick="showTab(\'hitl\')">Review</button>' +
                '</div>' +
            '</div>';
        });
        html += '</div>';
        if (hitlItems.length > 3) {
            html += '<p style="color:var(--text-muted);font-size:12px;margin-top:8px;text-align:center;">+ ' + (hitlItems.length - 3) + ' more items</p>';
        }
    } else {
        html += '<p style="color:var(--text-muted);text-align:center;padding:20px;">No pending approvals</p>';
    }

    html += '</div></div>';

    // ── Goals ────────────────────────────────────────────────
    if (goals.length > 0) {
        html += '<div class="card full-width">' +
            '<div class="card-header"><h3>Goals</h3></div>' +
            '<div class="card-body">';

        goals.forEach(function(g) {
            var pct = g.progress != null ? Math.min(g.progress, 100) : 0;
            html += '<div class="goal-bar">' +
                '<div class="goal-header">' +
                    '<span>' + esc(g.name) + '</span>' +
                    '<span class="goal-pct">' + pct + '%</span>' +
                '</div>' +
                '<div class="goal-track"><div class="goal-fill" style="width:' + pct + '%"></div></div>' +
            '</div>';
        });

        html += '</div></div>';
    }

    html += '</div>'; // close dash-grid

    el.innerHTML = html;

    // Update HITL badge
    updateHITLBadge(hitlItems.length);
}

function updateHITLBadge(count) {
    var badge = document.getElementById('hitl-badge');
    if (!badge) return;
    if (count > 0) {
        badge.textContent = count;
        badge.style.display = '';
    } else {
        badge.style.display = 'none';
    }
}

// ── HITL Tab ─────────────────────────────────────────────────────────────────
async function renderHITL() {
    var el = document.getElementById('view-hitl');
    if (!HELM.currentBusiness) {
        el.innerHTML = '<p style="padding:40px;text-align:center;color:var(--text-muted);">Select a business first.</p>';
        return;
    }

    el.innerHTML = '<div class="flex-center" style="padding:60px;"><div class="spinner spinner-lg"></div></div>';

    try {
        var items = await bizApi('/hitl');
        var list = items.items || items || [];
        _hitlItems = list;
        renderHITLContent(el, list);
    } catch (err) {
        el.innerHTML = '<div style="padding:40px;text-align:center;"><p style="color:var(--error);">Failed to load HITL queue</p><p style="color:var(--text-muted);font-size:13px;">' + esc(err.message) + '</p><button class="btn" onclick="renderHITL()" style="margin-top:12px;">Retry</button></div>';
    }
}

function renderHITLContent(el, items) {
    var pending = items.filter(function(i) { return i.status === 'pending'; });
    var resolved = items.filter(function(i) { return i.status !== 'pending'; });

    var html = '<div style="max-width:800px;margin:0 auto;width:100%;">';

    html += '<h2 style="margin-bottom:16px;">Human-in-the-Loop Queue</h2>';

    if (pending.length === 0) {
        html += '<div class="card" style="text-align:center;padding:40px;">' +
            '<p style="font-size:16px;margin-bottom:4px;">All clear</p>' +
            '<p style="color:var(--text-muted);">No items need your approval right now.</p>' +
        '</div>';
    } else {
        html += '<p style="color:var(--text-muted);margin-bottom:12px;">' + pending.length + ' item' + (pending.length !== 1 ? 's' : '') + ' waiting for your review</p>';
        html += '<div class="hitl-list">';
        pending.forEach(function(item) {
            html += renderHITLCard(item);
        });
        html += '</div>';
    }

    // Resolved history — collapsible
    if (resolved.length > 0) {
        html += '<div style="margin-top:28px;">' +
            '<button class="btn btn-ghost btn-sm" style="color:var(--text-muted);margin-bottom:8px;" ' +
                'onclick="this.nextElementSibling.classList.toggle(\'hidden\');this.textContent=this.nextElementSibling.classList.contains(\'hidden\')?\'▶ History (' + resolved.length + ')\':\'▼ History (' + resolved.length + ')\';">' +
                '▶ History (' + resolved.length + ')' +
            '</button>' +
            '<div class="hitl-list hidden">';
        resolved.slice(0, 20).forEach(function(item) {
            var statusBadge = item.status === 'approved' ? 'badge-success' : (item.status === 'rejected' ? 'badge-error' : 'badge-neutral');
            var statusIcon  = item.status === 'approved' ? '✓' : (item.status === 'rejected' ? '✕' : '–');
            var reviewNote  = item.reviewer_notes ? '<div style="margin-top:6px;font-size:12px;color:var(--text-muted);font-style:italic;">Note: ' + esc(item.reviewer_notes) + '</div>' : '';
            var reviewedAt  = item.reviewed_at ? ' · ' + timeAgo(item.reviewed_at) : '';
            html += '<div class="hitl-item" style="opacity:0.55;cursor:default;">' +
                '<div class="hitl-header">' +
                    '<span class="badge ' + statusBadge + '">' + statusIcon + ' ' + esc(item.status) + '</span>' +
                    '<span class="hitl-title" style="flex:1;">' + esc(item.title) + '</span>' +
                    '<span style="color:var(--text-faint);font-size:12px;white-space:nowrap;">' + esc(item.action_type || '') + reviewedAt + '</span>' +
                '</div>' +
                reviewNote +
            '</div>';
        });
        html += '</div></div>';
    }

    html += '</div>';
    el.innerHTML = html;
}

var _hitlItems = [];

// Extract preview text from a HITL item object
function _hitlPreviewText(item) {
    if (!item) return '';
    var raw = item.execution_payload;
    if (!raw) return '';
    if (typeof raw === 'object' && raw.preview) return String(raw.preview);
    if (typeof raw === 'string' && raw.trim()) return raw;
    return '';
}

function renderHITLCard(item) {
    var expiresHtml = '';
    if (item.expires_at) {
        expiresHtml = '<div class="hitl-expires">\u23F0 ' + esc(countdown(item.expires_at)) + '</div>';
    }

    var isReport     = item.action_type === 'report_review';
    var approveLabel = isReport ? 'Mark Reviewed' : 'Approve';
    var viewLabel    = isReport ? 'View Report' : (item.action_type === 'content_review' ? 'View Content' : 'View Details');

    // Extract preview once — used for teaser and embedded on the card element
    var previewText = _hitlPreviewText(item);

    // Inline teaser — first 200 chars collapsed to single line
    var teaserHtml = '';
    if (previewText) {
        var teaser = previewText.replace(/\n+/g, ' ').slice(0, 200);
        if (previewText.length > 200) teaser += '…';
        teaserHtml = '<div class="hitl-teaser">' + esc(teaser) + '</div>';
    }

    var approveClass = isReport ? 'btn-reviewed' : 'btn-primary';
    var actionBtns =
        '<button class="btn btn-sm ' + approveClass + '" onclick="approveHITL(\'' + esc(item.id) + '\')">' + approveLabel + '</button>' +
        (!isReport ? '<button class="btn btn-sm btn-danger" onclick="rejectHITL(\'' + esc(item.id) + '\')">Reject</button>' : '') +
        '<button class="btn btn-sm" onclick="viewHITLContent(this)">' + viewLabel + '</button>';

    // Extract resource ID for full-content fetch
    var payload = item.execution_payload || {};
    var resourceId = payload.content_id || payload.report_id || '';
    var resourceType = payload.content_id ? 'content' : (payload.report_id ? 'report' : '');

    // Embed all display data on the card via data-attributes — no array lookup needed
    return '<div class="hitl-item ' + riskClass(item.risk_level) + '"' +
        ' id="hitl-' + esc(item.id) + '"' +
        ' data-hitl-id="' + esc(item.id) + '"' +
        ' data-hitl-title="' + esc(item.title || '') + '"' +
        ' data-hitl-type="' + esc(item.action_type || '') + '"' +
        ' data-hitl-preview="' + esc(previewText) + '"' +
        ' data-hitl-resource-id="' + esc(resourceId) + '"' +
        ' data-hitl-resource-type="' + esc(resourceType) + '"' +
        '>' +
        '<div class="hitl-header">' +
            '<span class="badge ' + riskBadgeClass(item.risk_level) + '">' + esc(item.risk_level || 'low') + '</span>' +
            '<span class="hitl-title">' + esc(item.title) + '</span>' +
        '</div>' +
        '<div class="hitl-desc">' + esc(item.description || '') + '</div>' +
        expiresHtml +
        teaserHtml +
        '<div class="hitl-actions">' + actionBtns + '</div>' +
    '</div>';
}

// ── Lightweight markdown → HTML (no external dep) ────────────────────────────
function _mdToHtml(md) {
    if (!md) return '';
    var html = md
        // Escape HTML special chars first (except we'll re-add allowed markup)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        // Headings
        .replace(/^###### (.+)$/gm, '<h6>$1</h6>')
        .replace(/^##### (.+)$/gm, '<h5>$1</h5>')
        .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
        .replace(/^### (.+)$/gm, '<h3>$1</h3>')
        .replace(/^## (.+)$/gm, '<h2>$1</h2>')
        .replace(/^# (.+)$/gm, '<h1>$1</h1>')
        // HR
        .replace(/^---+$/gm, '<hr>')
        // Bold + italic
        .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        // Inline code
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        // Blockquote
        .replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')
        // Unordered list lines
        .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
        // Ordered list lines
        .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
        // Wrap consecutive <li> in <ul>
        .replace(/(<li>[\s\S]*?<\/li>)(\s*(?=<li>|$))/g, function(m) { return m; })
        // Paragraphs: blank-line-separated blocks that aren't already block elements
        .split(/\n{2,}/).map(function(block) {
            block = block.trim();
            if (!block) return '';
            if (/^<(h[1-6]|ul|ol|li|hr|blockquote)/.test(block)) return block;
            // Wrap consecutive <li> in ul
            if (/<li>/.test(block)) return '<ul>' + block + '</ul>';
            return '<p>' + block.replace(/\n/g, '<br>') + '</p>';
        }).join('\n');
    return html;
}

// ── Content View/Edit Modal ───────────────────────────────────────────────────
// Tracks current state across tab switches and save operations
var _hitlModal = {
    hitlId: '', resourceId: '', resourceType: '', isReport: false,
    fullText: '', isDirty: false,
};

function viewHITLContent(triggerEl) {
    var card         = triggerEl.closest('.hitl-item');
    var hitlId       = card ? card.dataset.hitlId           : '';
    var title        = card ? card.dataset.hitlTitle        : 'Review Item';
    var preview      = card ? card.dataset.hitlPreview      : '';
    var aType        = card ? card.dataset.hitlType         : '';
    var resourceId   = card ? card.dataset.hitlResourceId   : '';
    var resourceType = card ? card.dataset.hitlResourceType : '';
    var isReport     = aType === 'report_review';

    _hitlModal.hitlId       = hitlId;
    _hitlModal.resourceId   = resourceId;
    _hitlModal.resourceType = resourceType;
    _hitlModal.isReport     = isReport;
    _hitlModal.fullText     = '';
    _hitlModal.isDirty      = false;

    var existing = document.getElementById('helm-hitl-modal');
    if (existing) existing.remove();

    var approveClass = isReport ? 'btn-reviewed' : 'btn-primary';
    var approveLabel = isReport ? 'Mark Reviewed' : 'Approve';
    // Reports show preview-only (no edit tab); content items get both tabs
    var tabsHtml = isReport ? '' :
        '<div class="hitl-modal-tabs">' +
            '<button class="hitl-modal-tab active" id="htab-preview" onclick="hitlModalTab(\'preview\')">Preview</button>' +
            '<button class="hitl-modal-tab"        id="htab-edit"    onclick="hitlModalTab(\'edit\')">Edit</button>' +
        '</div>';

    var modal = document.createElement('div');
    modal.id = 'helm-hitl-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:32px 20px;overflow-y:auto;';

    modal.innerHTML =
        '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);max-width:860px;width:100%;display:flex;flex-direction:column;">' +
            // Header
            '<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--border);flex-shrink:0;">' +
                '<div style="display:flex;align-items:center;gap:10px;">' +
                    '<strong style="font-size:14px;">' + esc(title) + '</strong>' +
                    (resourceType === 'content' ? '<span style="font-size:11px;color:var(--text-muted);background:var(--surface3);padding:2px 8px;border-radius:999px;">Blog Post</span>' : '') +
                    (resourceType === 'report'  ? '<span style="font-size:11px;color:var(--text-muted);background:var(--surface3);padding:2px 8px;border-radius:999px;">Weekly Report</span>' : '') +
                '</div>' +
                '<button class="btn btn-sm btn-ghost" onclick="document.getElementById(\'helm-hitl-modal\').remove()">✕</button>' +
            '</div>' +
            // Tabs
            tabsHtml +
            // Body panes
            '<div class="hitl-modal-body">' +
                '<div class="hitl-modal-pane active" id="htab-pane-preview">' +
                    '<div class="hitl-modal-preview" id="hitl-preview-content">' +
                        '<div class="flex-center" style="padding:40px;"><div class="spinner"></div></div>' +
                    '</div>' +
                '</div>' +
                (!isReport ?
                '<div class="hitl-modal-pane" id="htab-pane-edit">' +
                    '<div class="hitl-modal-edit">' +
                        '<textarea id="hitl-edit-ta" spellcheck="true" placeholder="Loading content…" oninput="_hitlModal.isDirty=true;document.getElementById(\'hitl-save-status\').textContent=\'Unsaved changes\'"></textarea>' +
                    '</div>' +
                '</div>' : '') +
            '</div>' +
            // Feedback
            '<div class="hitl-modal-feedback">' +
                '<label>Feedback for next generation (optional)</label>' +
                '<textarea id="hitl-feedback-ta" placeholder="e.g. Make it shorter, focus more on pricing, use a warmer tone…"></textarea>' +
            '</div>' +
            // Footer
            '<div class="hitl-modal-footer">' +
                '<span class="hitl-modal-save-status" id="hitl-save-status"></span>' +
                (!isReport ? '<button class="btn btn-sm btn-ghost" onclick="hitlSaveEdits()" id="hitl-save-btn">Save Edits</button>' : '') +
                '<button class="btn btn-sm ' + approveClass + '" onclick="hitlApproveAndClose(\'' + esc(hitlId) + '\')">' + approveLabel + '</button>' +
                (!isReport ? '<button class="btn btn-sm btn-danger" onclick="rejectHITL(\'' + esc(hitlId) + '\');document.getElementById(\'helm-hitl-modal\').remove()">Reject</button>' : '') +
                (!isReport && resourceId ? '<button class="btn btn-sm" id="hitl-wp-push-btn" onclick="pushContentToWP(\'' + esc(resourceId) + '\')">⬆ Push to WP</button>' : '') +
                (!isReport && resourceId ? '<button class="btn btn-sm" id="hitl-netlify-push-btn" onclick="pushContentToNetlify(\'' + esc(resourceId) + '\')">⬆ Push to GitHub</button>' : '') +
                '<button class="btn btn-sm btn-ghost" onclick="document.getElementById(\'helm-hitl-modal\').remove()">Close</button>' +
            '</div>' +
        '</div>';

    document.body.appendChild(modal);
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });

    // Fetch full content
    function populateContent(text) {
        _hitlModal.fullText = text;
        // Preview pane — render markdown as HTML
        var previewEl = document.getElementById('hitl-preview-content');
        if (previewEl) previewEl.innerHTML = text ? _mdToHtml(text) : '<p style="color:var(--text-muted);">(No content)</p>';
        // Edit textarea
        var ta = document.getElementById('hitl-edit-ta');
        if (ta) { ta.value = text; ta.placeholder = ''; }
    }
    function populateError(msg) {
        var previewEl = document.getElementById('hitl-preview-content');
        if (previewEl) previewEl.innerHTML = '<p style="color:var(--text-muted);">' + esc(msg) + '</p>' +
            (preview ? '<hr style="margin:16px 0;border-color:var(--border);">' + _mdToHtml(preview) : '');
        var ta = document.getElementById('hitl-edit-ta');
        if (ta) ta.value = preview || '';
    }

    if (resourceId && resourceType) {
        bizApi('/' + resourceType + '/' + resourceId).then(function(row) {
            var text = row.content_text || row.content || '';
            text ? populateContent(text) : populateError('Full content not available.');
        }).catch(function(err) { populateError('Could not load: ' + err.message); });
    } else if (preview) {
        populateContent(preview);
    } else {
        populateError('No preview available for this item.');
    }
}

function hitlModalTab(tab) {
    ['preview', 'edit'].forEach(function(t) {
        var btn  = document.getElementById('htab-' + t);
        var pane = document.getElementById('htab-pane-' + t);
        if (btn)  btn.classList.toggle('active',  t === tab);
        if (pane) pane.classList.toggle('active', t === tab);
    });
    // Sync textarea → preview when switching to preview
    if (tab === 'preview') {
        var ta = document.getElementById('hitl-edit-ta');
        var previewEl = document.getElementById('hitl-preview-content');
        if (ta && previewEl) previewEl.innerHTML = _mdToHtml(ta.value) || '<p style="color:var(--text-muted);">(No content)</p>';
    }
}

async function hitlSaveEdits() {
    if (!_hitlModal.resourceId || _hitlModal.resourceType !== 'content') return;
    var ta = document.getElementById('hitl-edit-ta');
    if (!ta) return;
    var saveBtn    = document.getElementById('hitl-save-btn');
    var statusEl   = document.getElementById('hitl-save-status');
    var newBody    = ta.value;

    if (saveBtn) saveBtn.disabled = true;
    if (statusEl) statusEl.textContent = 'Saving…';

    try {
        await bizApi('/content/' + _hitlModal.resourceId, {
            method: 'PATCH',
            body: { body: newBody },
        });
        _hitlModal.fullText = newBody;
        _hitlModal.isDirty  = false;
        if (statusEl) statusEl.textContent = 'Saved ✓';
        setTimeout(function() { if (statusEl) statusEl.textContent = ''; }, 3000);
    } catch (err) {
        if (statusEl) statusEl.textContent = 'Save failed: ' + err.message;
    } finally {
        if (saveBtn) saveBtn.disabled = false;
    }
}

async function hitlApproveAndClose(hitlId) {
    // Auto-save edits first if dirty
    if (_hitlModal.isDirty && !_hitlModal.isReport) {
        await hitlSaveEdits();
    }
    // Log feedback if provided
    var feedbackTa = document.getElementById('hitl-feedback-ta');
    var feedback   = feedbackTa ? feedbackTa.value.trim() : '';
    if (feedback && _hitlModal.resourceId) {
        try {
            await bizApi('/content-feedback', {
                method: 'POST',
                body: {
                    resource_id:   _hitlModal.resourceId,
                    resource_type: _hitlModal.resourceType,
                    feedback_text: feedback,
                },
            });
        } catch (_) { /* non-blocking */ }
    }
    // Approve
    try {
        var data = await bizApi('/hitl/' + hitlId + '/approve', { method: 'POST' });
        var modal = document.getElementById('helm-hitl-modal');
        if (modal) modal.remove();
        var dispatch = data && data.dispatch;
        var msg = _hitlModal.isReport ? 'Report marked reviewed' : 'Content approved';
        if (dispatch && !_hitlModal.isReport) {
            if (dispatch.action === 'queued_social') {
                msg = 'Content approved — queued for ' + (dispatch.platform || 'social');
            } else if (dispatch.action === 'scheduled') {
                msg = 'Content approved — scheduled';
            } else if (dispatch.action === 'hitl_queued') {
                msg = 'Content approved — ' + (dispatch.message || 'queued for manual publish');
            }
        }
        showToast(msg, 'success');
        renderHITL();
        refreshHITLBadge();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function approveHITL(hitlId) {
    try {
        var data = await bizApi('/hitl/' + hitlId + '/approve', { method: 'POST' });
        var dispatch = data && data.dispatch;
        var msg = 'Item approved';
        if (dispatch) {
            if (dispatch.action === 'queued_social') {
                msg = 'Content approved — queued for ' + (dispatch.platform || 'social') + ' (' + (dispatch.handle || '') + ')';
            } else if (dispatch.action === 'scheduled') {
                msg = 'Content approved — scheduled for publishing';
            } else if (dispatch.action === 'hitl_queued') {
                msg = 'Content approved — ' + (dispatch.message || 'queued for manual publish');
            }
        }
        showToast(msg, 'success');
        renderHITL();
        refreshHITLBadge();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function rejectHITL(hitlId) {
    // Close any open content modal first
    var existing = document.getElementById('helm-hitl-modal');
    if (existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = 'helm-reject-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
    modal.innerHTML =
        '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);max-width:480px;width:100%;padding:24px;">' +
            '<h3 style="margin-bottom:12px;font-size:15px;">Reject &amp; Provide Feedback</h3>' +
            '<p style="color:var(--text-muted);font-size:13px;margin-bottom:16px;">Tell HELM what to fix — this will be used to improve the next generation.</p>' +
            '<textarea id="reject-reason-ta" rows="4" placeholder="e.g. Too long, wrong tone, missing CTA, inaccurate product info…" style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-family:var(--font);font-size:13px;padding:10px 12px;resize:vertical;outline:none;margin-bottom:16px;"></textarea>' +
            '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
                '<button class="btn btn-sm btn-ghost" onclick="document.getElementById(\'helm-reject-modal\').remove()">Cancel</button>' +
                '<button class="btn btn-sm" onclick="submitRejectHITL(\'' + esc(hitlId) + '\', false)">Reject</button>' +
                '<button class="btn btn-sm btn-primary" onclick="submitRejectHITL(\'' + esc(hitlId) + '\', true)">Reject &amp; Regenerate</button>' +
            '</div>' +
        '</div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
    setTimeout(function() { var ta = document.getElementById('reject-reason-ta'); if (ta) ta.focus(); }, 50);
}

async function submitRejectHITL(hitlId, regenerate) {
    var ta     = document.getElementById('reject-reason-ta');
    var reason = ta ? ta.value.trim() : '';
    var modal  = document.getElementById('helm-reject-modal');
    if (modal) modal.remove();

    try {
        await bizApi('/hitl/' + hitlId + '/reject', {
            method: 'POST',
            body: { reason: reason },
        });

        // Log rejection reason as feedback for next generation
        if (reason && _hitlModal.resourceId) {
            try {
                await bizApi('/content-feedback', {
                    method: 'POST',
                    body: {
                        resource_id:   _hitlModal.resourceId   || hitlId,
                        resource_type: _hitlModal.resourceType || 'content',
                        feedback_text: reason,
                    },
                });
            } catch (_) { /* non-blocking */ }
        }

        showToast(regenerate ? 'Rejected — queuing regeneration…' : 'Item rejected', 'success');
        renderHITL();
        refreshHITLBadge();

        // Trigger a new content generation run for this business
        if (regenerate) {
            try {
                await bizApi('/schedule/content_generate/trigger', { method: 'POST' });
                showToast('Regeneration queued', 'info');
            } catch (e) {
                showToast('Could not queue regeneration: ' + e.message, 'error');
            }
        }
    } catch (err) {
        showToast(err.message, 'error');
    }
}


// ── WordPress Push ────────────────────────────────────────────────────────────
async function pushContentToWP(contentId) {
    // Check if any WP connections exist first
    var btn = document.getElementById('hitl-wp-push-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Pushing…'; }
    try {
        // Load connections to let user pick one if multiple exist
        var conns = await bizApi('/wp-connections');
        if (!conns || conns.length === 0) {
            showToast('No WordPress sites connected. Add one in Settings.', 'error');
            if (btn) { btn.disabled = false; btn.textContent = '⬆ Push to WP'; }
            return;
        }

        var connId;
        if (conns.length === 1) {
            connId = conns[0].id;
        } else {
            // Show picker modal
            connId = await _pickWPConnection(conns);
            if (!connId) {
                if (btn) { btn.disabled = false; btn.textContent = '⬆ Push to WP'; }
                return;
            }
        }

        var result = await bizApi('/content/' + contentId + '/push-to-wp', {
            method: 'POST',
            body: { connection_id: connId },
        });

        var link = result.link || result.edit_link || '';
        showToast('Pushed to WordPress' + (result.status ? ' as ' + result.status : '') + '!', 'success');
        if (link) {
            var statusEl = document.getElementById('hitl-save-status');
            if (statusEl) {
                statusEl.innerHTML = 'Published: <a href="' + link + '" target="_blank" style="color:#38bdf8;">' + link + '</a>';
            }
        }
        if (btn) { btn.textContent = '✓ Pushed'; }
    } catch (err) {
        showToast('WP push failed: ' + err.message, 'error');
        if (btn) { btn.disabled = false; btn.textContent = '⬆ Push to WP'; }
    }
}

function _pickWPConnection(conns) {
    return new Promise(function(resolve) {
        var existing = document.getElementById('helm-wp-pick-modal');
        if (existing) existing.remove();

        var modal = document.createElement('div');
        modal.id = 'helm-wp-pick-modal';
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;';

        var btnHtml = conns.map(function(c) {
            return '<button class="btn btn-secondary" style="width:100%;text-align:left;margin-bottom:8px;" ' +
                'onclick="document.getElementById(\'helm-wp-pick-modal\').remove(); window._wpPickResolve(\'' + c.id + '\');">' +
                '<strong>' + c.site_name + '</strong><br><span style="font-size:12px;color:#94a3b8;">' + c.site_url + ' · ' + c.default_status + '</span>' +
            '</button>';
        }).join('');

        modal.innerHTML =
            '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);max-width:400px;width:100%;padding:24px;">' +
                '<h3 style="margin-bottom:12px;font-size:15px;">Choose WordPress Site</h3>' +
                btnHtml +
                '<button class="btn btn-ghost btn-sm" style="width:100%;margin-top:4px;" ' +
                    'onclick="document.getElementById(\'helm-wp-pick-modal\').remove(); window._wpPickResolve(null);">Cancel</button>' +
            '</div>';

        window._wpPickResolve = function(id) {
            window._wpPickResolve = null;
            resolve(id);
        };
        document.body.appendChild(modal);
        modal.addEventListener('click', function(e) {
            if (e.target === modal) { modal.remove(); resolve(null); }
        });
    });
}

// ── GitHub Push ─────────────────────────────────────────────────────
// NOTE: This commits a Markdown file to a GitHub repo that Netlify deploys from.
// The Netlify PAT stored during onboarding is for SITE MANAGEMENT (deploy hooks),
// NOT for blog content. Content push requires a separate GitHub connection in
// Settings → Netlify Connections (repo + branch + content path + GitHub PAT).
// The target site MUST have a static site generator (Hugo, Astro, 11ty, etc.)
// configured to render Markdown files as blog posts.

async function pushContentToNetlify(contentId) {
    var btn = document.getElementById('hitl-netlify-push-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    try {
        var conns = await bizApi('/netlify-connections');

        if (!conns || conns.length === 0) {
            // Show an informative "not configured" modal rather than a vague toast
            _showNetlifyNotConfigured();
            if (btn) { btn.disabled = false; btn.textContent = '⬆ Push to GitHub'; }
            return;
        }

        // Pick connection if multiple
        var conn;
        if (conns.length === 1) {
            conn = conns[0];
        } else {
            var connId = await _pickNetlifyConnection(conns);
            if (!connId) {
                if (btn) { btn.disabled = false; btn.textContent = '⬆ Push to GitHub'; }
                return;
            }
            conn = conns.find(function(c) { return c.id === connId; }) || conns[0];
        }

        // Show confirmation dialog with full details before committing
        var confirmed = await _confirmNetlifyPush(conn, contentId);
        if (!confirmed) {
            if (btn) { btn.disabled = false; btn.textContent = '⬆ Push to GitHub'; }
            return;
        }

        if (btn) btn.textContent = 'Committing…';
        var result = await bizApi('/content/' + contentId + '/push-to-netlify', {
            method: 'POST',
            body: { connection_id: conn.id },
        });

        showToast('Committed to GitHub — Netlify will auto-deploy', 'success');
        var statusEl = document.getElementById('hitl-save-status');
        if (statusEl && result.html_url) {
            statusEl.innerHTML = 'Committed: <a href="' + result.html_url + '" target="_blank" style="color:#38bdf8;">' + esc(result.path) + '</a>';
        }
        if (btn) { btn.textContent = '✓ Committed'; }
    } catch (err) {
        showToast('GitHub push failed: ' + err.message, 'error');
        if (btn) { btn.disabled = false; btn.textContent = '⬆ Push to GitHub'; }
    }
}

function _showNetlifyNotConfigured() {
    var existing = document.getElementById('helm-netlify-info-modal');
    if (existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = 'helm-netlify-info-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;';
    modal.innerHTML =
        '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);max-width:500px;width:100%;padding:28px;">' +
            '<h3 style="margin:0 0 12px;font-size:15px;">GitHub Content Push — Setup Required</h3>' +
            '<p style="color:#94a3b8;font-size:13px;line-height:1.6;margin-bottom:16px;">' +
                'Push to Netlify works by <strong style="color:#e2e8f0;">committing a Markdown file</strong> to the GitHub repo your Netlify site deploys from. ' +
                'Netlify then automatically rebuilds and the post goes live.' +
            '</p>' +
            '<div style="background:#0f172a;border:1px solid #1e293b;border-radius:6px;padding:12px 16px;margin-bottom:16px;font-size:12px;line-height:1.7;">' +
                '<div style="color:#94a3b8;margin-bottom:8px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;font-size:11px;">Requirements</div>' +
                '<div>✅ A GitHub repo connected to your Netlify site</div>' +
                '<div>✅ A static site generator that renders Markdown (Hugo, Astro, 11ty, etc.)</div>' +
                '<div>✅ A content directory for blog posts (e.g. <code style="color:#38bdf8;">content/posts/</code>)</div>' +
                '<div>✅ A GitHub Personal Access Token with <code style="color:#38bdf8;">repo</code> write scope</div>' +
            '</div>' +
            '<div style="background:#1c1917;border:1px solid #44403c;border-radius:6px;padding:12px 16px;margin-bottom:20px;font-size:12px;color:#a8a29e;">' +
                '<strong style="color:#fbbf24;">Note:</strong> The Netlify PAT from your onboarding is for <em>site management</em> (deploy hooks, site settings) — ' +
                'it does not write content files. This is a separate GitHub connection.' +
            '</div>' +
            '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
                '<button class="btn btn-primary btn-sm" onclick="document.getElementById(\'helm-netlify-info-modal\').remove(); showTab(\'settings\');">Go to Settings</button>' +
                '<button class="btn btn-ghost btn-sm" onclick="document.getElementById(\'helm-netlify-info-modal\').remove();">Close</button>' +
            '</div>' +
        '</div>';

    document.body.appendChild(modal);
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
}

function _confirmNetlifyPush(conn, contentId) {
    return new Promise(function(resolve) {
        var existing = document.getElementById('helm-netlify-confirm-modal');
        if (existing) existing.remove();

        // Build preview filename (best-effort without full title — just show pattern)
        var today = new Date().toISOString().slice(0, 10);
        var exampleFile = today + '-post-title.md';

        var modal = document.createElement('div');
        modal.id = 'helm-netlify-confirm-modal';
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;';
        modal.innerHTML =
            '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);max-width:520px;width:100%;padding:28px;">' +
                '<h3 style="margin:0 0 4px;font-size:15px;">Confirm GitHub Commit</h3>' +
                '<p style="color:#64748b;font-size:12px;margin:0 0 20px;">Review what will happen before committing.</p>' +

                '<div style="background:#0f172a;border:1px solid #1e293b;border-radius:6px;padding:14px 16px;margin-bottom:16px;font-size:12px;line-height:1.9;">' +
                    '<div><span style="color:#64748b;display:inline-block;width:90px;">Repo:</span> <strong style="color:#e2e8f0;">' + esc(conn.github_repo) + '</strong></div>' +
                    '<div><span style="color:#64748b;display:inline-block;width:90px;">Branch:</span> <strong style="color:#e2e8f0;">' + esc(conn.github_branch) + '</strong></div>' +
                    '<div><span style="color:#64748b;display:inline-block;width:90px;">File path:</span> <code style="color:#38bdf8;">' + esc(conn.content_path) + '/' + exampleFile + '</code></div>' +
                    '<div><span style="color:#64748b;display:inline-block;width:90px;">Format:</span> Markdown with YAML frontmatter (title, date, draft: false)</div>' +
                '</div>' +

                '<div style="background:#1a1a12;border:1px solid #44403c;border-radius:6px;padding:12px 16px;margin-bottom:20px;font-size:12px;color:#a8a29e;line-height:1.6;">' +
                    '<strong style="color:#fbbf24;">⚠ Important:</strong> This commits a single new file — nothing is deleted or overwritten. ' +
                    'However, your site must have a <strong style="color:#e2e8f0;">blog/content system</strong> (Hugo, Astro, 11ty, etc.) configured to read this directory. ' +
                    'A plain HTML/landing-page site will not render the file automatically.' +
                '</div>' +

                '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
                    '<button class="btn btn-primary btn-sm" onclick="document.getElementById(\'helm-netlify-confirm-modal\').remove(); window._nlConfirmResolve(true);">Commit to GitHub</button>' +
                    '<button class="btn btn-ghost btn-sm" onclick="document.getElementById(\'helm-netlify-confirm-modal\').remove(); window._nlConfirmResolve(false);">Cancel</button>' +
                '</div>' +
            '</div>';

        window._nlConfirmResolve = function(v) { window._nlConfirmResolve = null; resolve(v); };
        document.body.appendChild(modal);
        modal.addEventListener('click', function(e) { if (e.target === modal) { modal.remove(); resolve(false); } });
    });
}

function _pickNetlifyConnection(conns) {
    return new Promise(function(resolve) {
        var existing = document.getElementById('helm-netlify-pick-modal');
        if (existing) existing.remove();

        var modal = document.createElement('div');
        modal.id = 'helm-netlify-pick-modal';
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;';

        var btnHtml = conns.map(function(c) {
            return '<button class="btn btn-secondary" style="width:100%;text-align:left;margin-bottom:8px;" ' +
                'onclick="document.getElementById(\'helm-netlify-pick-modal\').remove(); window._netlifyPickResolve(\'' + c.id + '\');">' +
                '<strong>' + esc(c.site_name) + '</strong><br>' +
                '<span style="font-size:12px;color:#94a3b8;">' + esc(c.github_repo) + ' @ ' + esc(c.github_branch) + ' → ' + esc(c.content_path) + '</span>' +
            '</button>';
        }).join('');

        modal.innerHTML =
            '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);max-width:420px;width:100%;padding:24px;">' +
                '<h3 style="margin-bottom:12px;font-size:15px;">Choose Netlify Site</h3>' +
                btnHtml +
                '<button class="btn btn-ghost btn-sm" style="width:100%;margin-top:4px;" ' +
                    'onclick="document.getElementById(\'helm-netlify-pick-modal\').remove(); window._netlifyPickResolve(null);">Cancel</button>' +
            '</div>';

        window._netlifyPickResolve = function(id) { window._netlifyPickResolve = null; resolve(id); };
        document.body.appendChild(modal);
        modal.addEventListener('click', function(e) { if (e.target === modal) { modal.remove(); resolve(null); } });
    });
}

async function refreshHITLBadge() {
    try {
        var items = await bizApi('/hitl');
        var list = items.items || items || [];
        var pending = list.filter(function(i) { return i.status === 'pending'; });
        updateHITLBadge(pending.length);
    } catch (_) { /* silently fail */ }
}

// ── Activity Log (Actions Tab) ───────────────────────────────────────────────
var actionsPage = 1;
var actionsPerPage = 20;

async function renderActions() {
    var el = document.getElementById('view-actions');
    if (!HELM.currentBusiness) {
        el.innerHTML = '<p style="padding:40px;text-align:center;color:var(--text-muted);">Select a business first.</p>';
        return;
    }

    el.innerHTML = '<div class="flex-center" style="padding:60px;"><div class="spinner spinner-lg"></div></div>';

    try {
        var data = await bizApi('/actions?page=' + actionsPage + '&per_page=' + actionsPerPage);
        var actions = data.actions || data.items || data || [];
        var total = data.total || actions.length;
        renderActionsContent(el, actions, total);
    } catch (err) {
        el.innerHTML = '<div style="padding:40px;text-align:center;"><p style="color:var(--error);">Failed to load actions</p><p style="color:var(--text-muted);font-size:13px;">' + esc(err.message) + '</p><button class="btn" onclick="renderActions()" style="margin-top:12px;">Retry</button></div>';
    }
}

function renderActionsContent(el, actions, total) {
    var html = '<div style="max-width:800px;margin:0 auto;width:100%;">';
    html += '<h2 style="margin-bottom:16px;">Activity Log</h2>';

    if (actions.length === 0) {
        html += '<div class="card" style="text-align:center;padding:40px;">' +
            '<p style="color:var(--text-muted);">No actions recorded yet.</p>' +
        '</div>';
    } else {
        html += '<div class="action-list">';
        actions.forEach(function(a, idx) {
            var statusBadge = (a.status === 'completed' || a.status === 'success') ? 'badge-success' :
                              a.status === 'failed' ? 'badge-error' :
                              a.status === 'pending' ? 'badge-warning' :
                              a.status === 'running' ? 'badge-info' : 'badge-neutral';

            var detailText = '';
            var rawDetail = a.detail || a.metadata;
            if (rawDetail && !(typeof rawDetail === 'object' && Object.keys(rawDetail).length === 0)) {
                try {
                    detailText = typeof rawDetail === 'string' ? rawDetail : JSON.stringify(rawDetail, null, 2);
                } catch (_) {
                    detailText = String(rawDetail);
                }
            }

            // Build meta line: tokens/cost if available
            var metaParts = [];
            if (a.tokens_used) metaParts.push(a.tokens_used.toLocaleString() + ' tokens');
            if (a.cost_usd && a.cost_usd > 0) metaParts.push('$' + parseFloat(a.cost_usd).toFixed(4));
            if (a.duration_ms) metaParts.push((a.duration_ms / 1000).toFixed(1) + 's');
            var metaLine = metaParts.length ? '<div class="action-meta">' + esc(metaParts.join(' · ')) + '</div>' : '';

            // Detail block — content/report types render markdown; others show plain text
            var isContentDetail = detailText && (a.action_type === 'content_generate' || a.action_type === 'report_weekly');
            var detailStyle = isContentDetail ? 'style="max-height:420px;overflow-y:auto;"' : '';
            var detailBlock = '<div class="action-detail" ' + detailStyle + '>';
            if (detailText) {
                if (isContentDetail) {
                    detailBlock += '<div style="color:var(--text-muted);font-size:11px;margin-bottom:10px;font-family:var(--font-mono);letter-spacing:0.05em;">▼ PREVIEW</div>' +
                        '<div class="hitl-modal-preview" style="padding:0;max-height:none;">' + _mdToHtml(detailText) + '</div>';
                } else {
                    detailBlock += '<pre style="white-space:pre-wrap;word-break:break-word;font-size:12px;color:var(--text2);">' + esc(detailText) + '</pre>';
                }
            } else {
                detailBlock += '<span style="color:var(--text-faint);font-style:italic;">No additional details recorded for this action.</span>';
            }
            detailBlock += '</div>';

            html += '<div class="action-item" onclick="toggleActionDetail(this)">' +
                '<div class="action-icon">' + actionIcon(a.action_type) + '</div>' +
                '<div class="action-info">' +
                    '<div class="action-summary">' + esc(a.summary || a.action_type) + '</div>' +
                    '<div class="action-time">' + fmtDateTime(a.created_at) + ' · ' + timeAgo(a.created_at) + '</div>' +
                    metaLine +
                    detailBlock +
                '</div>' +
                '<span class="badge ' + statusBadge + '">' + esc(a.status || 'unknown') + '</span>' +
            '</div>';
        });
        html += '</div>';

        // Pagination
        var totalPages = Math.ceil(total / actionsPerPage);
        if (totalPages > 1) {
            html += '<div class="pagination">' +
                '<button class="btn btn-sm" onclick="goActionsPage(' + (actionsPage - 1) + ')"' + (actionsPage <= 1 ? ' disabled' : '') + '>Prev</button>' +
                '<span class="page-info">Page ' + actionsPage + ' of ' + totalPages + '</span>' +
                '<button class="btn btn-sm" onclick="goActionsPage(' + (actionsPage + 1) + ')"' + (actionsPage >= totalPages ? ' disabled' : '') + '>Next</button>' +
            '</div>';
        }
    }

    html += '</div>';
    el.innerHTML = html;
}

function toggleActionDetail(el) {
    el.classList.toggle('expanded');
}

function goActionsPage(page) {
    if (page < 1) return;
    actionsPage = page;
    renderActions();
}
