/* OPAI Forum Bot — Admin SPA */

let _token = '';
let _categories = [];
let _draftsPage = 0;
let _historyPage = 0;

// ── Auth ─────────────────────────────────────────────────────

async function initAuth() {
    try {
        const resp = await fetch('/auth/config');
        const cfg = await resp.json();
        if (!cfg.supabase_url || !cfg.supabase_anon_key) return;

        const sb = window.supabase.createClient(cfg.supabase_url, cfg.supabase_anon_key);
        const { data: { session } } = await sb.auth.getSession();
        if (!session) { window.location.href = '/auth/login'; return; }

        const role = session.user.app_metadata?.role || 'user';
        if (role !== 'admin') { window.location.href = '/'; return; }

        _token = session.access_token;
        const name = session.user.user_metadata?.display_name || session.user.email.split('@')[0];
        document.getElementById('user-display').textContent = name;

        sb.auth.onAuthStateChange((_ev, sess) => { if (sess) _token = sess.access_token; });

        await loadCategories();
        loadDashboard();
    } catch (e) {
        console.error('Auth error:', e);
    }
}

function api(path, opts = {}) {
    return fetch(`/forumbot/api${path}`, {
        ...opts,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${_token}`,
            ...(opts.headers || {}),
        },
    }).then(async r => {
        if (!r.ok) {
            const text = await r.text();
            throw new Error(text || r.statusText);
        }
        return r.json();
    });
}

// ── Tabs ─────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');

        // Load data on tab switch
        const tab = btn.dataset.tab;
        if (tab === 'dashboard') loadDashboard();
        else if (tab === 'drafts') loadDrafts();
        else if (tab === 'schedules') loadSchedules();
        else if (tab === 'history') { _historyPage = 0; loadHistory(); }
    });
});

// ── Categories ───────────────────────────────────────────────

async function loadCategories() {
    try {
        _categories = await api('/categories');
        populateCategoryDropdowns();
    } catch (e) {
        console.error('Failed to load categories:', e);
    }
}

function populateCategoryDropdowns() {
    ['gen-category', 'sm-category'].forEach(id => {
        const sel = document.getElementById(id);
        if (!sel) return;
        sel.innerHTML = '<option value="">No category</option>';
        _categories.forEach(c => {
            sel.innerHTML += `<option value="${c.id}">${c.icon || ''} ${c.name}</option>`;
        });
    });
}

// ── Dashboard ────────────────────────────────────────────────

async function loadDashboard() {
    try {
        const [stats, histData] = await Promise.all([
            api('/stats'),
            api('/history?limit=10'),
        ]);

        document.getElementById('stat-pending').textContent = stats.pending_drafts;
        document.getElementById('stat-today').textContent = stats.published_today;
        document.getElementById('stat-total').textContent = stats.total_published;
        document.getElementById('stat-schedules').textContent = stats.active_schedules;

        renderActivityFeed(histData.history || []);
    } catch (e) {
        console.error('Dashboard load error:', e);
    }
}

function renderActivityFeed(items) {
    const feed = document.getElementById('activity-feed');
    if (!items.length) {
        feed.innerHTML = '<p class="text-muted" style="padding:20px;text-align:center;">No activity yet. Generate your first post!</p>';
        return;
    }

    const icons = {
        generated: '&#9998;',
        approved: '&#10003;',
        published: '&#128640;',
        discarded: '&#128465;',
        schedule_triggered: '&#9200;',
    };

    feed.innerHTML = items.map(h => `
        <div class="activity-item">
            <div class="activity-icon">${icons[h.action] || '&#8226;'}</div>
            <div>
                <div class="activity-text"><strong>${h.action}</strong> ${h.details?.title ? '&mdash; ' + esc(h.details.title) : ''}</div>
                <div class="activity-time">${h.actor} &middot; ${timeAgo(h.created_at)}</div>
            </div>
        </div>
    `).join('');
}

// ── Generate ─────────────────────────────────────────────────

document.getElementById('gen-count').addEventListener('input', e => {
    document.getElementById('gen-count-val').textContent = e.target.value;
});

async function generatePosts() {
    const btn = document.getElementById('gen-btn');
    const prompt = document.getElementById('gen-prompt').value.trim();
    if (!prompt) { alert('Please enter a prompt'); return; }

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Generating...';

    try {
        const tagsRaw = document.getElementById('gen-tags').value.trim();
        const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];
        const categoryId = document.getElementById('gen-category').value || null;

        const result = await api('/generate', {
            method: 'POST',
            body: JSON.stringify({
                prompt,
                post_type: document.getElementById('gen-type').value,
                count: parseInt(document.getElementById('gen-count').value),
                category_id: categoryId,
                tags,
            }),
        });

        const container = document.getElementById('gen-results-list');
        container.innerHTML = result.drafts.map(d => `
            <div class="card draft-card" onclick="openDraftModal('${d.id}')">
                <div class="card-header">
                    <span class="card-title">${esc(d.title)}</span>
                    <span class="badge badge-draft">${d.status}</span>
                </div>
                <div class="md-preview">${renderMd(d.content)}</div>
                <div class="draft-tags">${(d.tags || []).map(t => `<span class="draft-tag">${esc(t)}</span>`).join('')}</div>
            </div>
        `).join('');

        document.getElementById('gen-results').classList.remove('hidden');
    } catch (e) {
        alert('Generation failed: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Generate';
    }
}

// ── Drafts ───────────────────────────────────────────────────

async function loadDrafts() {
    const filter = document.getElementById('drafts-filter').value;
    const statusParam = filter ? `&status=${filter}` : '';

    try {
        const data = await api(`/drafts?page=${_draftsPage}&limit=20${statusParam}`);
        const list = document.getElementById('drafts-list');

        if (!data.drafts || !data.drafts.length) {
            list.innerHTML = '<p class="text-muted" style="text-align:center;padding:40px;">No drafts found</p>';
            document.getElementById('drafts-pagination').innerHTML = '';
            return;
        }

        list.innerHTML = data.drafts.map(d => `
            <div class="card draft-card" onclick="openDraftModal('${d.id}')">
                <div class="card-header">
                    <div>
                        <span class="card-title">${esc(d.title)}</span>
                        <span class="badge badge-${d.status}" style="margin-left:8px;">${d.status}</span>
                    </div>
                    <span class="text-sm text-muted">${d.post_type}</span>
                </div>
                <div class="draft-meta">
                    <span>${d.category?.name || 'Uncategorized'}</span>
                    <span>${timeAgo(d.created_at)}</span>
                </div>
                <div class="draft-tags">${(d.tags || []).map(t => `<span class="draft-tag">${esc(t)}</span>`).join('')}</div>
            </div>
        `).join('');

        // Pagination
        const totalPages = Math.ceil(data.total / 20);
        const pag = document.getElementById('drafts-pagination');
        pag.innerHTML = totalPages > 1 ? `
            <button class="btn btn-small" ${_draftsPage <= 0 ? 'disabled' : ''} onclick="_draftsPage--;loadDrafts()">Prev</button>
            <span class="text-sm text-muted">Page ${_draftsPage + 1} of ${totalPages}</span>
            <button class="btn btn-small" ${_draftsPage >= totalPages - 1 ? 'disabled' : ''} onclick="_draftsPage++;loadDrafts()">Next</button>
        ` : '';
    } catch (e) {
        console.error('Drafts load error:', e);
    }
}

// ── Draft Modal ──────────────────────────────────────────────

async function openDraftModal(id) {
    try {
        const draft = await api(`/drafts/${id}`);
        document.getElementById('dm-id').value = draft.id;
        document.getElementById('dm-status').value = draft.status;
        document.getElementById('dm-title').textContent = draft.title;
        document.getElementById('dm-edit-title').value = draft.title;
        document.getElementById('dm-edit-content').value = draft.content;
        document.getElementById('dm-edit-tags').value = (draft.tags || []).join(', ');
        document.getElementById('dm-preview').innerHTML = renderMd(draft.content);

        // Show/hide action buttons based on status
        const isDraft = draft.status === 'draft';
        document.getElementById('dm-save-btn').classList.toggle('hidden', !isDraft);
        document.getElementById('dm-discard-btn').classList.toggle('hidden', !isDraft);
        document.getElementById('dm-approve-btn').classList.toggle('hidden', !isDraft);

        document.getElementById('draft-modal').classList.remove('hidden');

        // Live preview
        document.getElementById('dm-edit-content').addEventListener('input', function() {
            document.getElementById('dm-preview').innerHTML = renderMd(this.value);
        });
    } catch (e) {
        alert('Failed to load draft: ' + e.message);
    }
}

function closeDraftModal() {
    document.getElementById('draft-modal').classList.add('hidden');
}

async function saveDraft() {
    const id = document.getElementById('dm-id').value;
    const tagsRaw = document.getElementById('dm-edit-tags').value.trim();
    try {
        await api(`/drafts/${id}`, {
            method: 'PUT',
            body: JSON.stringify({
                title: document.getElementById('dm-edit-title').value,
                content: document.getElementById('dm-edit-content').value,
                tags: tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [],
            }),
        });
        closeDraftModal();
        loadDrafts();
    } catch (e) {
        alert('Save failed: ' + e.message);
    }
}

async function discardDraft() {
    const id = document.getElementById('dm-id').value;
    if (!confirm('Discard this draft? This cannot be undone.')) return;
    try {
        await api(`/drafts/${id}`, { method: 'DELETE' });
        closeDraftModal();
        loadDrafts();
    } catch (e) {
        alert('Discard failed: ' + e.message);
    }
}

async function approveDraft() {
    const id = document.getElementById('dm-id').value;
    if (!confirm('Publish this draft to the forum?')) return;

    const btn = document.getElementById('dm-approve-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Publishing...';

    try {
        await api(`/drafts/${id}/approve`, { method: 'POST' });
        closeDraftModal();
        loadDrafts();
        loadDashboard();
    } catch (e) {
        alert('Publish failed: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Publish to Forum';
    }
}

// ── Schedules ────────────────────────────────────────────────

async function loadSchedules() {
    try {
        const schedules = await api('/schedules');
        const list = document.getElementById('schedules-list');

        if (!schedules.length) {
            list.innerHTML = '<p class="text-muted" style="text-align:center;padding:40px;">No schedules. Create one to automate content generation.</p>';
            return;
        }

        list.innerHTML = schedules.map(s => `
            <div class="card">
                <div class="card-header">
                    <div>
                        <span class="card-title">${esc(s.name)}</span>
                        <span class="badge ${s.enabled ? 'badge-published' : 'badge-discarded'}" style="margin-left:8px;">
                            ${s.enabled ? 'Active' : 'Disabled'}
                        </span>
                    </div>
                    <div style="display:flex;gap:8px;">
                        <button class="btn btn-small btn-outline" onclick="runScheduleNow('${s.id}')">Run Now</button>
                        <button class="btn btn-small" onclick="openScheduleModal('${s.id}')">Edit</button>
                        <button class="btn btn-small btn-danger" onclick="deleteSchedule('${s.id}')">Delete</button>
                    </div>
                </div>
                <div class="draft-meta">
                    <span>Cron: <code>${esc(s.cron_expr)}</code></span>
                    <span>Type: ${s.post_type}</span>
                    <span>Max: ${s.max_drafts}/run</span>
                    <span>${s.auto_publish ? 'Auto-publish' : 'Manual review'}</span>
                </div>
                ${s.last_run_at ? `<div class="text-sm text-muted" style="margin-top:8px;">Last run: ${timeAgo(s.last_run_at)} ${s.last_result?.drafts_created != null ? '(' + s.last_result.drafts_created + ' drafts)' : ''}</div>` : ''}
                ${(s.conditions || []).length ? `<div class="text-sm text-muted" style="margin-top:4px;">Conditions: ${s.conditions.map(c => c.type).join(', ')}</div>` : ''}
            </div>
        `).join('');
    } catch (e) {
        console.error('Schedules load error:', e);
    }
}

async function runScheduleNow(id) {
    if (!confirm('Manually trigger this schedule now?')) return;
    try {
        const result = await api(`/schedules/${id}/run`, { method: 'POST' });
        alert(`Schedule triggered. ${result.drafts_created || 0} draft(s) created.`);
        loadSchedules();
        loadDrafts();
    } catch (e) {
        alert('Run failed: ' + e.message);
    }
}

async function deleteSchedule(id) {
    if (!confirm('Delete this schedule permanently?')) return;
    try {
        await api(`/schedules/${id}`, { method: 'DELETE' });
        loadSchedules();
    } catch (e) {
        alert('Delete failed: ' + e.message);
    }
}

// ── Schedule Modal ───────────────────────────────────────────

let _editSchedule = null;

async function openScheduleModal(id) {
    _editSchedule = null;
    document.getElementById('sm-id').value = '';
    document.getElementById('sm-title').textContent = 'New Schedule';
    document.getElementById('sm-name').value = '';
    document.getElementById('sm-cron').value = '0 9 * * 1-5';
    document.getElementById('sm-type').value = 'dev-note';
    document.getElementById('sm-category').value = '';
    document.getElementById('sm-prompt').value = '';
    document.getElementById('sm-tags').value = '';
    document.getElementById('sm-max').value = 1;
    document.getElementById('sm-max-val').textContent = '1';
    document.getElementById('sm-autopublish').checked = false;
    document.getElementById('sm-conditions').innerHTML = '';

    if (id) {
        try {
            const schedules = await api('/schedules');
            _editSchedule = schedules.find(s => s.id === id);
            if (_editSchedule) {
                document.getElementById('sm-id').value = _editSchedule.id;
                document.getElementById('sm-title').textContent = 'Edit Schedule';
                document.getElementById('sm-name').value = _editSchedule.name;
                document.getElementById('sm-cron').value = _editSchedule.cron_expr;
                document.getElementById('sm-type').value = _editSchedule.post_type;
                document.getElementById('sm-category').value = _editSchedule.category_id || '';
                document.getElementById('sm-prompt').value = _editSchedule.prompt_template;
                document.getElementById('sm-tags').value = (_editSchedule.tags || []).join(', ');
                document.getElementById('sm-max').value = _editSchedule.max_drafts;
                document.getElementById('sm-max-val').textContent = _editSchedule.max_drafts;
                document.getElementById('sm-autopublish').checked = _editSchedule.auto_publish;

                // Render conditions
                (_editSchedule.conditions || []).forEach(c => addCondition(c));
            }
        } catch (e) { console.error(e); }
    }

    document.getElementById('schedule-modal').classList.remove('hidden');
}

function closeScheduleModal() {
    document.getElementById('schedule-modal').classList.add('hidden');
}

document.getElementById('sm-max').addEventListener('input', e => {
    document.getElementById('sm-max-val').textContent = e.target.value;
});

function addCondition(existing) {
    const container = document.getElementById('sm-conditions');
    const idx = container.children.length;
    const type = existing?.type || 'git_commits';

    const row = document.createElement('div');
    row.className = 'condition-row';
    row.dataset.idx = idx;

    let paramsHtml = '';
    if (type === 'git_commits') {
        const min = existing?.params?.min_commits || 3;
        const hrs = existing?.params?.hours || 24;
        paramsHtml = `min <input type="number" class="cond-param" data-key="min_commits" value="${min}" min="1" max="50" style="width:60px;"> commits in <input type="number" class="cond-param" data-key="hours" value="${hrs}" min="1" max="168" style="width:60px;"> hours`;
    } else if (type === 'weekday') {
        const days = existing?.params?.days || [];
        paramsHtml = `Days: <input type="text" class="cond-param" data-key="days" value="${days.join(',')}" placeholder="0,1,2,3,4" style="width:100px;"> (0=Mon)`;
    } else if (type === 'service_restart') {
        const thresh = existing?.params?.threshold_seconds || 3600;
        paramsHtml = `Uptime < <input type="number" class="cond-param" data-key="threshold_seconds" value="${thresh}" min="60" style="width:80px;"> seconds`;
    }

    row.innerHTML = `
        <select class="cond-type" onchange="updateConditionParams(this)">
            <option value="git_commits" ${type === 'git_commits' ? 'selected' : ''}>Git Commits</option>
            <option value="weekday" ${type === 'weekday' ? 'selected' : ''}>Weekday</option>
            <option value="service_restart" ${type === 'service_restart' ? 'selected' : ''}>Service Restart</option>
        </select>
        <span class="cond-params">${paramsHtml}</span>
        <button class="btn btn-small btn-danger" onclick="this.parentElement.remove()" style="padding:4px 8px;">X</button>
    `;

    container.appendChild(row);
}

function updateConditionParams(sel) {
    const row = sel.closest('.condition-row');
    const type = sel.value;
    const paramsSpan = row.querySelector('.cond-params');

    if (type === 'git_commits') {
        paramsSpan.innerHTML = `min <input type="number" class="cond-param" data-key="min_commits" value="3" min="1" max="50" style="width:60px;"> commits in <input type="number" class="cond-param" data-key="hours" value="24" min="1" max="168" style="width:60px;"> hours`;
    } else if (type === 'weekday') {
        paramsSpan.innerHTML = `Days: <input type="text" class="cond-param" data-key="days" value="0,1,2,3,4" placeholder="0,1,2,3,4" style="width:100px;"> (0=Mon)`;
    } else if (type === 'service_restart') {
        paramsSpan.innerHTML = `Uptime < <input type="number" class="cond-param" data-key="threshold_seconds" value="3600" min="60" style="width:80px;"> seconds`;
    }
}

function gatherConditions() {
    const conditions = [];
    document.querySelectorAll('#sm-conditions .condition-row').forEach(row => {
        const type = row.querySelector('.cond-type').value;
        const params = {};
        row.querySelectorAll('.cond-param').forEach(inp => {
            const key = inp.dataset.key;
            let val = inp.value;
            if (key === 'days') {
                val = val.split(',').map(d => parseInt(d.trim())).filter(d => !isNaN(d));
            } else {
                val = parseInt(val) || 0;
            }
            params[key] = val;
        });
        conditions.push({ type, params });
    });
    return conditions;
}

async function saveSchedule() {
    const id = document.getElementById('sm-id').value;
    const tagsRaw = document.getElementById('sm-tags').value.trim();

    const data = {
        name: document.getElementById('sm-name').value.trim(),
        cron_expr: document.getElementById('sm-cron').value.trim(),
        post_type: document.getElementById('sm-type').value,
        prompt_template: document.getElementById('sm-prompt').value.trim(),
        category_id: document.getElementById('sm-category').value || null,
        tags: tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [],
        max_drafts: parseInt(document.getElementById('sm-max').value),
        auto_publish: document.getElementById('sm-autopublish').checked,
        conditions: gatherConditions(),
    };

    if (!data.name || !data.cron_expr || !data.prompt_template) {
        alert('Name, cron expression, and prompt are required');
        return;
    }

    try {
        if (id) {
            await api(`/schedules/${id}`, { method: 'PUT', body: JSON.stringify(data) });
        } else {
            await api('/schedules', { method: 'POST', body: JSON.stringify(data) });
        }
        closeScheduleModal();
        loadSchedules();
    } catch (e) {
        alert('Save failed: ' + e.message);
    }
}

// ── History ──────────────────────────────────────────────────

async function loadHistory() {
    try {
        const data = await api(`/history?page=${_historyPage}&limit=20`);
        const tbody = document.getElementById('history-tbody');

        if (!data.history || !data.history.length) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-muted" style="text-align:center;padding:40px;">No history yet</td></tr>';
            document.getElementById('history-pagination').innerHTML = '';
            return;
        }

        tbody.innerHTML = data.history.map(h => `
            <tr>
                <td>${formatDate(h.created_at)}</td>
                <td><span class="badge badge-${h.action === 'published' ? 'published' : h.action === 'discarded' ? 'discarded' : 'draft'}">${h.action}</span></td>
                <td class="text-muted">${esc(h.actor)}</td>
                <td class="text-muted">${h.details?.title ? esc(h.details.title) : h.details?.schedule_name ? esc(h.details.schedule_name) : ''}</td>
            </tr>
        `).join('');

        const totalPages = Math.ceil(data.total / 20);
        const pag = document.getElementById('history-pagination');
        pag.innerHTML = totalPages > 1 ? `
            <button class="btn btn-small" ${_historyPage <= 0 ? 'disabled' : ''} onclick="_historyPage--;loadHistory()">Prev</button>
            <span class="text-sm text-muted">Page ${_historyPage + 1} of ${totalPages}</span>
            <button class="btn btn-small" ${_historyPage >= totalPages - 1 ? 'disabled' : ''} onclick="_historyPage++;loadHistory()">Next</button>
        ` : '';
    } catch (e) {
        console.error('History load error:', e);
    }
}

// ── Helpers ──────────────────────────────────────────────────

function esc(s) {
    if (!s) return '';
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function renderMd(md) {
    try {
        return marked.parse(md || '');
    } catch (e) {
        return esc(md);
    }
}

function timeAgo(iso) {
    if (!iso) return '';
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
}

function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
}

// Close modals on overlay click
document.querySelectorAll('.modal-overlay').forEach(ov => {
    ov.addEventListener('click', e => {
        if (e.target === ov) ov.classList.add('hidden');
    });
});

// ── Init ─────────────────────────────────────────────────────
initAuth();
