/**
 * Bx4 -- Operations Wing View
 * Goals, KPIs, operations analysis, recommendations, team hub links.
 */

'use strict';

async function initOperations() {
    var root = document.getElementById('view-root');
    var co = window.BX4.currentCompany;
    if (!co) { root.innerHTML = '<div class="empty-state"><div class="empty-state-title">Select a company</div></div>'; return; }

    root.innerHTML = buildOperationsShell(co);

    var results = await Promise.allSettled([
        companyApi('/goals'),
        companyApi('/kpis'),
        companyApi('/recommendations?wing=operations&status=pending')
    ]);

    var goals = results[0].status === 'fulfilled' ? results[0].value : null;
    var kpis = results[1].status === 'fulfilled' ? results[1].value : null;
    var recs = results[2].status === 'fulfilled' ? results[2].value : null;

    renderGoals(goals);
    renderKPIs(kpis);
    renderOpsRecs(recs);
    loadTeamHubTasks();
    setupOpsEventListeners();
}

function buildOperationsShell(co) {
    return '' +
        '<div class="view-header">' +
            '<div><h1 class="view-title">Operations Wing</h1>' +
            '<div class="view-subtitle">' + esc(co.name) + '</div></div>' +
            '<button class="btn btn-primary" onclick="runOpsAnalysis()">Run Operations Analysis</button>' +
        '</div>' +

        // Goals
        '<div class="card section-gap">' +
            '<div class="card-header"><h3>Goals</h3><button class="btn btn-sm btn-ghost" onclick="toggleOpsAddGoal()">+ Add Goal</button></div>' +
            '<div id="ops-add-goal" class="hidden" style="padding:16px;border-bottom:1px solid var(--border);">' +
                '<form id="ops-goal-form" class="form">' +
                    '<div class="form-row">' +
                        '<label class="form-label">Title<input type="text" class="form-input" id="goal-title" placeholder="e.g. Reach $10K MRR" required></label>' +
                        '<label class="form-label">Type<select class="form-select" id="goal-type"><option value="primary">Primary</option><option value="secondary">Secondary</option></select></label>' +
                    '</div>' +
                    '<div class="form-row">' +
                        '<label class="form-label">Target Date<input type="date" class="form-input" id="goal-target-date"></label>' +
                        '<label class="form-label">Description<input type="text" class="form-input" id="goal-desc" placeholder="Optional details"></label>' +
                    '</div>' +
                    '<div><button type="submit" class="btn btn-primary">Create Goal</button></div>' +
                '</form>' +
            '</div>' +
            '<div class="card-body" id="ops-goals"><div class="spinner"></div></div>' +
        '</div>' +

        // KPIs
        '<div class="card section-gap">' +
            '<div class="card-header"><h3>KPI Board</h3><button class="btn btn-sm btn-ghost" onclick="toggleOpsAddKPI()">+ Add KPI</button></div>' +
            '<div id="ops-add-kpi" class="hidden" style="padding:16px;border-bottom:1px solid var(--border);">' +
                '<form id="ops-kpi-form" class="form-inline">' +
                    '<input type="text" class="form-input" id="kpi-name" placeholder="KPI name" required>' +
                    '<input type="number" step="0.01" class="form-input" id="kpi-current" placeholder="Current" required style="width:100px;">' +
                    '<input type="number" step="0.01" class="form-input" id="kpi-target" placeholder="Target" style="width:100px;">' +
                    '<input type="text" class="form-input" id="kpi-unit" placeholder="Unit" style="width:80px;">' +
                    '<button type="submit" class="btn btn-sm btn-primary">Add</button>' +
                '</form>' +
            '</div>' +
            '<div class="card-body" id="ops-kpis"><div class="spinner"></div></div>' +
        '</div>' +

        // Recommendations
        '<div class="card section-gap">' +
            '<div class="card-header"><h3>Operations Recommendations</h3></div>' +
            '<div class="card-body" id="ops-recs"><div class="spinner"></div></div>' +
        '</div>' +

        // Team Hub Linked Tasks
        '<div class="card section-gap">' +
            '<div class="card-header"><h3>Team Hub Linked Tasks</h3><button class="btn btn-sm btn-ghost" onclick="refreshTeamHubTasks()">Refresh</button></div>' +
            '<div class="card-body" id="ops-team-hub"><div class="spinner"></div></div>' +
        '</div>';
}

function renderGoals(data) {
    var el = document.getElementById('ops-goals');
    var goals = data && data.goals ? data.goals : (Array.isArray(data) ? data : []);

    if (goals.length === 0) {
        el.innerHTML = '<div class="empty-state" style="padding:24px;">' +
            '<div class="empty-state-title">No goals set</div>' +
            '<div class="empty-state-msg">Create your first business goal to track progress.</div></div>';
        return;
    }

    // Separate primary from secondary
    var primary = goals.filter(function(g) { return g.type === 'primary' || g.is_primary; });
    var secondary = goals.filter(function(g) { return g.type !== 'primary' && !g.is_primary; });

    var html = '';

    // Primary goal (large card)
    primary.forEach(function(goal) {
        html += buildGoalCard(goal, true);
    });

    // Secondary goals
    if (secondary.length > 0) {
        html += '<div class="section-title mt-16">Secondary Goals</div>';
        secondary.forEach(function(goal) {
            html += buildGoalCard(goal, false);
        });
    }

    el.innerHTML = html;
}

function buildGoalCard(goal, isPrimary) {
    var progress = goal.progress_pct || goal.progress || 0;
    var targetDate = goal.target_date ? fmtDate(goal.target_date) : '';
    var milestone = goal.next_milestone || '';

    return '<div class="card mb-12" style="' + (isPrimary ? 'border-color:var(--primary-dim);' : '') + '">' +
        '<div class="card-body">' +
            '<div class="flex-between mb-8">' +
                '<div>' +
                    (isPrimary ? '<span class="badge badge-info" style="margin-right:6px;">PRIMARY</span>' : '') +
                    '<strong>' + esc(goal.title || goal.description || 'Goal') + '</strong>' +
                '</div>' +
                '<div style="display:flex;gap:8px;align-items:center;">' +
                    (targetDate ? '<span class="text-sm text-muted">Target: ' + esc(targetDate) + '</span>' : '') +
                    '<button class="btn btn-sm btn-ghost" onclick="decomposeGoal(\'' + esc(goal.id) + '\', this)" title="AI: Break into milestones">&#x1F9E9; Decompose</button>' +
                '</div>' +
            '</div>' +
            (goal.description && goal.title ? '<div class="text-sm text-muted mb-12">' + esc(goal.description) + '</div>' : '') +
            '<div class="progress-wrap">' +
                '<div class="progress-header"><span class="progress-label">Progress</span><span class="progress-value">' + Math.round(progress) + '%</span></div>' +
                '<div class="progress-bar"><div class="progress-fill" style="width:' + progress + '%;"></div></div>' +
            '</div>' +
            (milestone ? '<div class="text-sm text-muted">Next: ' + esc(milestone) + '</div>' : '') +
            '<div class="mt-12">' +
                '<label class="text-sm text-muted">Update Progress: </label>' +
                '<input type="range" min="0" max="100" value="' + Math.round(progress) + '" ' +
                    'style="width:200px;vertical-align:middle;" ' +
                    'oninput="this.nextElementSibling.textContent=this.value+\'%\'" ' +
                    'onchange="updateGoalProgress(\'' + esc(goal.id) + '\', this.value)">' +
                '<span class="text-sm" style="margin-left:8px;">' + Math.round(progress) + '%</span>' +
            '</div>' +
            '<div id="milestones-' + esc(goal.id) + '" class="hidden" style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border);"></div>' +
        '</div>' +
    '</div>';
}

function renderKPIs(data) {
    var el = document.getElementById('ops-kpis');
    var kpis = data && data.kpis ? data.kpis : (Array.isArray(data) ? data : []);

    if (kpis.length === 0) {
        el.innerHTML = '<div class="empty-state" style="padding:24px;">' +
            '<div class="empty-state-title">No KPIs defined</div>' +
            '<div class="empty-state-msg">Add key performance indicators to track your business metrics.</div></div>';
        return;
    }

    var html = '<div style="margin-bottom:8px;text-align:right;"><button class="btn btn-sm btn-ghost" onclick="runAnomalyDetection()">&#x1F50D; Detect Anomalies</button></div>';
    html += '<div class="kpi-grid">';
    kpis.forEach(function(kpi) {
        var current = kpi.current_value != null ? kpi.current_value : 0;
        var target = kpi.target_value;
        var unit = kpi.unit || '';
        var trend = kpi.trend || 'flat';
        var trendIcon = trend === 'up' ? '&#x2191;' : (trend === 'down' ? '&#x2193;' : '&#x2192;');
        var trendCls = trend === 'up' ? 'up' : (trend === 'down' ? 'down' : 'flat');
        var anomalyBadge = kpi.anomaly_flag
            ? '<span class="badge badge-danger" style="font-size:10px;margin-left:4px;" title="Z-score: ' + (kpi.anomaly_score || '?') + '">ANOMALY</span>'
            : '';

        html += '<div class="kpi-card' + (kpi.anomaly_flag ? ' kpi-anomaly' : '') + '">' +
            '<div class="kpi-name">' + esc(kpi.name) + anomalyBadge + '</div>' +
            '<div class="kpi-value">' + fmtNum(current) + (unit ? '<span class="text-sm text-muted" style="margin-left:4px;">' + esc(unit) + '</span>' : '') + '<span class="kpi-trend ' + trendCls + '">' + trendIcon + '</span></div>' +
            (target != null ? '<div class="kpi-target">Target: ' + fmtNum(target) + (unit ? ' ' + esc(unit) : '') + '</div>' : '') +
            (kpi.anomaly_flag && kpi.anomaly_score ? '<div class="text-sm" style="color:var(--danger);margin-top:4px;">Z-score: ' + kpi.anomaly_score + ' — unusual reading</div>' : '') +
            '<div class="mt-12">' +
                '<input type="number" step="0.01" class="form-input" style="width:100px;display:inline-block;font-size:12px;padding:4px 8px;" ' +
                    'placeholder="New value" id="kpi-val-' + esc(kpi.id) + '">' +
                '<button class="btn btn-sm btn-ghost" style="margin-left:4px;" onclick="updateKPI(\'' + esc(kpi.id) + '\')">Update</button>' +
            '</div>' +
        '</div>';
    });
    html += '</div>';
    el.innerHTML = html;
}

function renderOpsRecs(data) {
    var el = document.getElementById('ops-recs');
    var items = data && data.recommendations ? data.recommendations : (Array.isArray(data) ? data : []);

    if (items.length === 0) {
        el.innerHTML = '<div class="text-muted text-sm">No operations recommendations. Run an analysis to generate them.</div>';
        return;
    }

    var html = '<div class="rec-cards">';
    items.forEach(function(rec) {
        var linkedLabel = rec.team_hub_item_id
            ? '<span class="badge badge-info" style="margin-left:8px;">In Team Hub</span>'
            : '';
        var roiLabel = rec.roi_score != null
            ? '<span class="badge badge-neutral" style="margin-left:8px;" title="Estimated ROI score">ROI ' + rec.roi_score + '</span>'
            : '';
        html += '<div class="rec-card">' +
            '<div class="rec-card-header">' + urgencyBadge(rec.urgency) + ' <span class="rec-card-title">' + esc(rec.title) + '</span>' + roiLabel + linkedLabel + '</div>' +
            '<div class="rec-card-reasoning">' + esc(rec.reasoning || rec.why_it_matters || rec.summary || '') + '</div>' +
            (rec.what_to_do ? '<div class="text-sm mt-8" style="color:var(--primary);">Action: ' + esc(rec.what_to_do) + '</div>' : '') +
            '<div class="rec-card-footer">' +
                (rec.team_hub_item_id
                    ? '<button class="btn btn-sm btn-ghost" onclick="checkTeamHubStatus(\'' + esc(rec.team_hub_item_id) + '\', this)">Check Status</button>'
                    : '<button class="btn btn-sm btn-outline" onclick="pushRecToTeamHub(\'' + esc(rec.id) + '\')">Push to Team Hub</button>') +
            '</div>' +
        '</div>';
    });
    html += '</div>';
    el.innerHTML = html;
}

// ── Event Listeners & Actions ────────────────────────────────────────────────
function setupOpsEventListeners() {
    // Goal form
    var goalForm = document.getElementById('ops-goal-form');
    if (goalForm) {
        goalForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            try {
                await companyApi('/goals', {
                    method: 'POST',
                    body: {
                        title: document.getElementById('goal-title').value.trim(),
                        type: document.getElementById('goal-type').value,
                        target_date: document.getElementById('goal-target-date').value || null,
                        description: document.getElementById('goal-desc').value.trim() || null,
                        progress: 0
                    }
                });
                showToast('Goal created', 'success');
                goalForm.reset();
                document.getElementById('ops-add-goal').classList.add('hidden');
                var goals = await companyApi('/goals');
                renderGoals(goals);
            } catch (err) {
                showToast('Failed: ' + err.message, 'error');
            }
        });
    }

    // KPI form
    var kpiForm = document.getElementById('ops-kpi-form');
    if (kpiForm) {
        kpiForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            try {
                await companyApi('/kpis', {
                    method: 'POST',
                    body: {
                        name: document.getElementById('kpi-name').value.trim(),
                        current_value: parseFloat(document.getElementById('kpi-current').value),
                        target_value: parseFloat(document.getElementById('kpi-target').value) || null,
                        unit: document.getElementById('kpi-unit').value.trim() || null
                    }
                });
                showToast('KPI added', 'success');
                kpiForm.reset();
                document.getElementById('ops-add-kpi').classList.add('hidden');
                var kpis = await companyApi('/kpis');
                renderKPIs(kpis);
            } catch (err) {
                showToast('Failed: ' + err.message, 'error');
            }
        });
    }
}

function toggleOpsAddGoal() {
    document.getElementById('ops-add-goal').classList.toggle('hidden');
}

function toggleOpsAddKPI() {
    document.getElementById('ops-add-kpi').classList.toggle('hidden');
}

async function updateGoalProgress(goalId, value) {
    try {
        await companyApi('/goals/' + goalId, {
            method: 'PATCH',
            body: { progress: parseInt(value) }
        });
        showToast('Goal progress updated to ' + value + '%', 'success');
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
}

async function updateKPI(kpiId) {
    var input = document.getElementById('kpi-val-' + kpiId);
    if (!input || !input.value) { showToast('Enter a value', 'warning'); return; }
    try {
        await companyApi('/kpis/' + kpiId, {
            method: 'PATCH',
            body: { current_value: parseFloat(input.value) }
        });
        showToast('KPI updated', 'success');
        input.value = '';
        var kpis = await companyApi('/kpis');
        renderKPIs(kpis);
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
}

async function runOpsAnalysis() {
    showToast('Running operations analysis...', 'info');
    try {
        await companyApi('/advisor/analyze', { method: 'POST', body: { wing: 'operations' } });
        showToast('Operations analysis complete', 'success');
        initOperations();
    } catch (err) {
        showToast('Analysis failed: ' + err.message, 'error');
    }
}

async function loadTeamHubTasks() {
    var el = document.getElementById('ops-team-hub');
    if (!el) return;
    try {
        // Fetch recs that have been pushed to team hub
        var data = await companyApi('/recommendations?wing=operations&has_task=true&limit=10');
        var items = data && data.recommendations ? data.recommendations : (Array.isArray(data) ? data : []);
        var pushed = items.filter(function(r) { return r.team_hub_item_id; });
        if (pushed.length === 0) {
            el.innerHTML = '<div class="text-muted text-sm">No recommendations pushed to Team Hub yet.</div>';
            return;
        }
        var html = '<div class="table-wrap"><table><thead><tr><th>Task</th><th>Wing</th><th>Status</th></tr></thead><tbody>';
        pushed.forEach(function(r) {
            html += '<tr>' +
                '<td>' + esc(r.title) + '</td>' +
                '<td>' + esc(r.wing || '--') + '</td>' +
                '<td><span class="badge badge-info">' + esc(r.status || 'pushed') + '</span></td>' +
            '</tr>';
        });
        html += '</tbody></table></div>';
        el.innerHTML = html;
    } catch (err) {
        el.innerHTML = '<div class="text-muted text-sm">Could not load Team Hub tasks.</div>';
    }
}

function refreshTeamHubTasks() { loadTeamHubTasks(); }

async function runAnomalyDetection() {
    showToast('Running anomaly detection...', 'info');
    try {
        var data = await companyApi('/kpis/detect-anomalies', { method: 'POST' });
        var count = data.anomaly_count || 0;
        showToast(count + ' anomal' + (count === 1 ? 'y' : 'ies') + ' detected', count > 0 ? 'warning' : 'success');
        var kpis = await companyApi('/kpis');
        renderKPIs(kpis);
    } catch (err) {
        showToast('Detection failed: ' + err.message, 'error');
    }
}

async function checkTeamHubStatus(taskId, btn) {
    btn.textContent = '...';
    try {
        var data = await api('/api/taskhub/tasks/' + taskId);
        var status = (data && data.status) ? data.status : 'unknown';
        btn.textContent = 'Status: ' + status;
        btn.disabled = true;
    } catch (err) {
        btn.textContent = 'Check Status';
        showToast('Could not fetch status: ' + err.message, 'error');
    }
}

async function decomposeGoal(goalId, btn) {
    var container = document.getElementById('milestones-' + goalId);
    if (!container) return;
    var orig = btn.textContent;
    btn.textContent = '...';
    btn.disabled = true;
    container.classList.remove('hidden');
    container.innerHTML = '<div class="flex-center gap-8"><div class="spinner"></div> AI is generating milestones...</div>';
    try {
        var data = await companyApi('/goals/' + goalId + '/decompose', { method: 'POST' });
        var milestones = data.milestones || [];
        var created = data.team_hub_tasks_created || 0;
        if (milestones.length === 0) {
            container.innerHTML = '<div class="text-muted text-sm">No milestones generated.</div>';
        } else {
            var html = '<div class="text-sm text-muted mb-8">&#x2705; ' + milestones.length + ' milestones created, ' + created + ' pushed to Team Hub</div>';
            html += '<div class="milestone-list">';
            milestones.forEach(function(m, i) {
                html += '<div class="milestone-item">' +
                    '<span class="milestone-num">' + (i + 1) + '</span>' +
                    '<div class="milestone-body">' +
                        '<div class="milestone-title">' + esc(m.title || '') + '</div>' +
                        (m.description ? '<div class="text-sm text-muted">' + esc(m.description) + '</div>' : '') +
                        (m.target_date ? '<div class="text-sm text-muted">Due: ' + fmtDate(m.target_date) + '</div>' : '') +
                        (m.team_hub_task_id ? '<div class="text-sm" style="color:var(--primary);">Team Hub &#x2713;</div>' : '') +
                    '</div>' +
                '</div>';
            });
            html += '</div>';
            container.innerHTML = html;
        }
        showToast('Milestones generated!', 'success');
    } catch (err) {
        container.innerHTML = '<div class="text-sm" style="color:var(--danger);">Failed: ' + esc(err.message) + '</div>';
        showToast('Decompose failed: ' + err.message, 'error');
    }
    btn.textContent = orig;
    btn.disabled = false;
}

// Expose globally
window.decomposeGoal        = decomposeGoal;
window.toggleOpsAddGoal     = toggleOpsAddGoal;
window.toggleOpsAddKPI      = toggleOpsAddKPI;
window.updateGoalProgress   = updateGoalProgress;
window.updateKPI            = updateKPI;
window.runOpsAnalysis       = runOpsAnalysis;
window.runAnomalyDetection  = runAnomalyDetection;
window.checkTeamHubStatus   = checkTeamHubStatus;
window.loadTeamHubTasks     = loadTeamHubTasks;
window.refreshTeamHubTasks  = refreshTeamHubTasks;
