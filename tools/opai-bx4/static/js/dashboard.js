/**
 * Bx4 -- Dashboard View
 * Business Pulse: health score, wing cards, priority actions, goal progress, quick pulse.
 */

'use strict';

async function initDashboard() {
    var root = document.getElementById('view-root');
    var co = window.BX4.currentCompany;
    if (!co) {
        root.innerHTML = '<div class="empty-state"><div class="empty-state-title">Select a company</div></div>';
        return;
    }

    root.innerHTML = buildDashboardShell(co);

    // Load data in parallel
    var results = await Promise.allSettled([
        companyApi('/health'),
        companyApi('/recommendations?status=pending&limit=5'),
        companyApi('/goals?primary=true'),
        companyApi('/pulse/latest')
    ]);

    var health = results[0].status === 'fulfilled' ? results[0].value : null;
    var recs = results[1].status === 'fulfilled' ? results[1].value : null;
    var goalData = results[2].status === 'fulfilled' ? results[2].value : null;
    var pulse = results[3].status === 'fulfilled' ? results[3].value : null;

    renderHealthScore(health);
    renderWingCards(health);
    renderPriorityActions(recs);
    renderGoalProgress(goalData);
    renderPulseWidget(pulse);

    // Auto-load pulse if stale (> 6 hours)
    if (pulse && pulse.created_at) {
        var age = Date.now() - new Date(pulse.created_at).getTime();
        if (age > 6 * 60 * 60 * 1000) {
            triggerQuickPulse();
        }
    } else if (!pulse) {
        // No pulse ever -- do not auto-trigger, let user decide
    }
}

function buildDashboardShell(co) {
    return '' +
        '<div class="view-header">' +
            '<div>' +
                '<h1 class="view-title">' + esc(co.name) + ' -- Business Pulse</h1>' +
                '<div class="view-subtitle">Real-time business health overview</div>' +
            '</div>' +
            '<button class="btn btn-primary" onclick="runFullAnalysis()">Run Full Analysis</button>' +
        '</div>' +

        // Health Score
        '<div class="card section-gap" id="dash-health-card">' +
            '<div class="card-body">' +
                '<div class="health-gauge" id="dash-health-gauge">' +
                    '<div class="spinner"></div>' +
                '</div>' +
            '</div>' +
        '</div>' +

        // Wing Cards
        '<div class="wing-cards" id="dash-wing-cards">' +
            buildWingCardPlaceholder('Financial') +
            buildWingCardPlaceholder('Market') +
            buildWingCardPlaceholder('Social') +
        '</div>' +

        // Priority Actions
        '<div class="card section-gap">' +
            '<div class="card-header"><h3>Priority Actions</h3></div>' +
            '<div class="card-body" id="dash-actions"><div class="spinner"></div></div>' +
        '</div>' +

        // Goal Progress
        '<div class="card section-gap">' +
            '<div class="card-header"><h3>Goal Progress</h3></div>' +
            '<div class="card-body" id="dash-goal"><div class="spinner"></div></div>' +
        '</div>' +

        // Quick Pulse
        '<div class="card section-gap">' +
            '<div class="card-header">' +
                '<h3>Quick Pulse</h3>' +
                '<button class="btn btn-sm btn-outline" onclick="triggerQuickPulse()">Get Today\'s Pulse</button>' +
            '</div>' +
            '<div class="card-body" id="dash-pulse">' +
                '<div class="text-muted text-sm">Click "Get Today\'s Pulse" to generate a quick business summary.</div>' +
            '</div>' +
        '</div>';
}

function buildWingCardPlaceholder(name) {
    return '<div class="wing-card" id="dash-wing-' + name.toLowerCase() + '">' +
        '<div class="wing-card-title">' + esc(name) + '</div>' +
        '<div class="wing-score" style="color:var(--text-faint);">--</div>' +
        '<div class="wing-stats"><div class="text-muted text-sm">Loading...</div></div>' +
    '</div>';
}

function renderHealthScore(health) {
    var el = document.getElementById('dash-health-gauge');
    if (!health || health.overall_score == null) {
        el.innerHTML = '<div class="health-gauge-value" style="color:var(--text-faint);">--</div>' +
            '<div class="health-gauge-label">Overall Health</div>' +
            '<div class="text-muted text-sm mt-12">Run an analysis to calculate your health score.</div>';
        return;
    }
    var score = Math.round(health.overall_score);
    var colorCls = scoreClass(score);
    var fillCls = fillClass(score);
    el.innerHTML =
        '<div class="health-gauge-value ' + colorCls + '">' + score + '</div>' +
        '<div class="health-gauge-label">Overall Health Score</div>' +
        '<div class="health-gauge-bar"><div class="health-gauge-fill ' + fillCls + '" style="width:' + score + '%;"></div></div>';
}

function renderWingCards(health) {
    if (!health) return;

    var wings = [
        { key: 'financial', name: 'Financial', data: health.financial },
        { key: 'market', name: 'Market', data: health.market },
        { key: 'social', name: 'Social', data: health.social }
    ];

    wings.forEach(function(w) {
        var el = document.getElementById('dash-wing-' + w.key);
        if (!el) return;
        var d = w.data || {};
        var score = d.score != null ? Math.round(d.score) : null;
        var grade = d.grade || '--';

        el.innerHTML =
            '<div class="wing-card-title">' + esc(w.name) + '</div>' +
            '<div class="wing-score ' + scoreClass(score) + '">' + (score != null ? score : '--') + '</div>' +
            '<span class="wing-grade ' + gradeClass(grade) + '">' + esc(grade) + '</span>' +
            renderWingStats(w.key, d);
    });
}

function renderWingStats(key, data) {
    if (!data || !data.stats) return '<div class="wing-stats"></div>';
    var stats = data.stats;
    var rows = '';
    Object.keys(stats).forEach(function(k) {
        var label = k.replace(/_/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
        var val = stats[k];
        if (typeof val === 'number' && (k.includes('revenue') || k.includes('cash') || k.includes('burn'))) {
            val = fmtCurrency(val, true);
        } else if (typeof val === 'number') {
            val = fmtNum(val);
        }
        rows += '<div class="wing-stat-row"><span>' + esc(label) + '</span><span>' + esc(val) + '</span></div>';
    });
    return '<div class="wing-stats">' + rows + '</div>';
}

function renderPriorityActions(recs) {
    var el = document.getElementById('dash-actions');
    var items = (recs && recs.recommendations) ? recs.recommendations : (Array.isArray(recs) ? recs : []);

    if (items.length === 0) {
        el.innerHTML = '<div class="empty-state" style="padding:24px;">' +
            '<div class="empty-state-title">No pending actions</div>' +
            '<div class="empty-state-msg">Run an analysis to generate recommendations.</div></div>';
        return;
    }

    var html = '<div class="action-list">';
    items.forEach(function(item) {
        html += '<div class="action-item">' +
            '<div class="action-item-body">' +
                '<div class="action-item-title">' +
                    urgencyBadge(item.urgency) + ' ' + esc(item.title) +
                    (item.financial_impact ? ' ' + impactBadge(item.financial_impact) : '') +
                '</div>' +
                '<div class="action-item-summary">' + esc(item.summary || item.reasoning || '') + '</div>' +
            '</div>' +
            '<div class="action-item-actions">' +
                '<button class="btn btn-sm btn-primary" onclick="actionRec(\'' + esc(item.id) + '\', \'acted\')">Action</button>' +
                '<button class="btn btn-sm btn-ghost" onclick="actionRec(\'' + esc(item.id) + '\', \'dismissed\')">Dismiss</button>' +
            '</div>' +
        '</div>';
    });
    html += '</div>';
    el.innerHTML = html;
}

function renderGoalProgress(goalData) {
    var el = document.getElementById('dash-goal');
    var goal = goalData && goalData.goal ? goalData.goal : (goalData && goalData.id ? goalData : null);

    if (!goal) {
        el.innerHTML = '<div class="empty-state" style="padding:24px;">' +
            '<div class="empty-state-title">No primary goal set</div>' +
            '<div class="empty-state-msg">Set a primary goal in the Operations view.</div>' +
            '<button class="btn btn-sm btn-outline mt-12" onclick="renderView(\'operations\')">Go to Operations</button></div>';
        return;
    }

    var progress = goal.progress || 0;
    var milestone = goal.next_milestone || '';
    var targetDate = goal.target_date ? fmtDate(goal.target_date) : '';

    el.innerHTML =
        '<div class="mb-12"><strong>' + esc(goal.title || goal.description || 'Primary Goal') + '</strong></div>' +
        '<div class="progress-wrap">' +
            '<div class="progress-header">' +
                '<span class="progress-label">Progress</span>' +
                '<span class="progress-value">' + Math.round(progress) + '%</span>' +
            '</div>' +
            '<div class="progress-bar"><div class="progress-fill" style="width:' + progress + '%;"></div></div>' +
        '</div>' +
        (milestone ? '<div class="text-sm text-muted">Next milestone: ' + esc(milestone) + '</div>' : '') +
        (targetDate ? '<div class="text-sm text-muted">Target: ' + esc(targetDate) + '</div>' : '');
}

function renderPulseWidget(pulse) {
    var el = document.getElementById('dash-pulse');
    if (!pulse || !pulse.content) return;

    el.innerHTML =
        '<div style="white-space:pre-wrap;font-size:13px;line-height:1.7;color:var(--text-2);">' +
            esc(pulse.content) +
        '</div>' +
        '<div class="text-sm text-muted mt-12">Generated ' + timeAgo(pulse.created_at) + '</div>';
}

// ── Actions ──────────────────────────────────────────────────────────────────
async function runFullAnalysis() {
    showToast('Starting full analysis...', 'info');
    try {
        await companyApi('/advisor/analyze', { method: 'POST', body: { depth: 'full' } });
        showToast('Analysis complete. Refreshing...', 'success');
        initDashboard();
    } catch (err) {
        showToast('Analysis failed: ' + err.message, 'error');
    }
}

async function triggerQuickPulse() {
    var el = document.getElementById('dash-pulse');
    el.innerHTML = '<div class="flex-center gap-8"><div class="spinner"></div> Generating pulse...</div>';
    try {
        var result = await companyApi('/advisor/pulse', { method: 'POST' });
        renderPulseWidget(result);
    } catch (err) {
        el.innerHTML = '<div class="text-sm" style="color:var(--danger);">Failed to generate pulse: ' + esc(err.message) + '</div>';
    }
}

async function actionRec(recId, status) {
    try {
        await companyApi('/recommendations/' + recId, {
            method: 'PATCH',
            body: { status: status }
        });
        showToast(status === 'acted' ? 'Action recorded' : 'Dismissed', 'success');
        // Refresh actions
        var recs = await companyApi('/recommendations?status=pending&limit=5');
        renderPriorityActions(recs);
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
}

// Expose globally
window.runFullAnalysis = runFullAnalysis;
window.triggerQuickPulse = triggerQuickPulse;
window.actionRec = actionRec;
