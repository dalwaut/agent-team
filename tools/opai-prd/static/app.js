/* PRD Pipeline — App JS */
'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let _ideas       = [];
let _filtered    = [];
let _selected    = new Set();
let _currentIdea = null;
let _importTab   = 'paste';
let _importParsed = [];

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
    try {
        const cfgRes = await fetch('/prd/api/auth/config');
        const cfg    = await cfgRes.json();
        // auth-v3.js reads from window globals, not init() options
        window.OPAI_SUPABASE_URL      = cfg.supabase_url;
        window.OPAI_SUPABASE_ANON_KEY = cfg.supabase_anon_key;
        await opaiAuth.init({ requireAdmin: true });
    } catch (e) {
        // dev mode fallback
    }

    if (typeof injectNavbar === 'function') injectNavbar();

    document.getElementById('loading').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');

    await Promise.all([loadIdeas(), loadStats()]);
}

// ── API ───────────────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
    const token = await opaiAuth.getToken().catch(() => null);
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch('/prd' + path, { ...opts, headers });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail || err.message || res.statusText);
    }
    return res.json();
}

// ── Load data ─────────────────────────────────────────────────────────────────
async function loadIdeas() {
    const data = await apiFetch('/api/ideas').catch(e => { toast(e.message, 'error'); return null; });
    if (!data) return;
    _ideas = data.ideas;
    filterIdeas();
}

async function loadStats() {
    const s = await apiFetch('/api/stats').catch(() => null);
    if (!s) return;
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.querySelector('.stat-num').textContent = val; };
    set('stat-total',    s.total);
    set('stat-pending',  s.pending);
    set('stat-good',     s.good_ideas);
    set('stat-approved', s.approved);
    set('stat-moved',    s.moved);
    set('stat-rejected', s.rejected);
}

async function refreshAll() {
    await Promise.all([loadIdeas(), loadStats()]);
}

// ── Filter & render ───────────────────────────────────────────────────────────
function filterIdeas() {
    const q       = document.getElementById('search-input').value.toLowerCase();
    const status  = document.getElementById('filter-status').value;
    const verdict = document.getElementById('filter-verdict').value;

    _filtered = _ideas.filter(idea => {
        const text = (idea.name + ' ' + idea.description + ' ' + (idea.target_market||'')).toLowerCase();
        if (q && !text.includes(q)) return false;
        if (status && idea.status !== status) return false;
        if (verdict && (idea.evaluation?.verdict) !== verdict) return false;
        return true;
    });

    renderIdeas();
}

function renderIdeas() {
    const container = document.getElementById('ideas-container');
    const empty     = document.getElementById('empty-state');

    if (_filtered.length === 0) {
        container.innerHTML = '';
        container.appendChild(empty);
        empty.classList.remove('hidden');
        return;
    }
    empty.classList.add('hidden');

    container.innerHTML = _filtered.map(idea => renderIdeaCard(idea)).join('');
}

function renderIdeaCard(idea) {
    const ev      = idea.evaluation;
    const checked = _selected.has(idea.id);
    const statusBadge = `<span class="badge badge-${idea.status}">${statusLabel(idea.status)}</span>`;
    const verdictBadge = ev ? `<span class="verdict-badge verdict-${ev.verdict}">${verdictLabel(ev.verdict)}</span>` : '';
    const avgScore = ev?.scores?.average ? `<span class="eval-avg-small">avg ${ev.scores.average.toFixed(1)}/10</span>` : '';
    const sourceBadge = `<span class="source-badge">${idea.source}</span>`;
    const date = idea.submitted_at ? new Date(idea.submitted_at).toLocaleDateString() : '';

    return `<div class="idea-card${checked ? ' selected' : ''}" data-id="${idea.id}">
        <div class="idea-check${checked ? ' checked' : ''}" onclick="toggleSelect(event,'${idea.id}')"></div>
        <div class="idea-body" onclick="openDetail('${idea.id}')">
            <div class="idea-name">${esc(idea.name)}</div>
            <div class="idea-desc">${esc(idea.description)}</div>
            <div class="idea-meta">
                ${statusBadge}
                ${verdictBadge}
                ${avgScore}
                ${sourceBadge}
                <span class="source-badge">${date}</span>
            </div>
        </div>
        <div class="idea-actions">
            ${idea.status === 'approved' ? `<button class="btn btn-move btn-sm" onclick="openMoveFromCard(event,'${idea.id}')">🚀 Move</button>` : ''}
            <button class="btn btn-ghost btn-sm danger" onclick="deleteIdea(event,'${idea.id}')">✕</button>
        </div>
    </div>`;
}

// ── Select ────────────────────────────────────────────────────────────────────
function toggleSelect(e, id) {
    e.stopPropagation();
    if (_selected.has(id)) _selected.delete(id); else _selected.add(id);
    renderIdeas();
    updateRunBtn();
}

function toggleSelectAll() {
    if (_selected.size === _filtered.length) {
        _selected.clear();
    } else {
        _filtered.forEach(i => _selected.add(i.id));
    }
    renderIdeas();
    updateRunBtn();
}

function updateRunBtn() {
    const btn = document.getElementById('run-btn');
    const count = _selected.size;
    btn.textContent = count > 0
        ? `▶ Run PRDgent (${count})`
        : '▶ Run PRDgent';
}

// ── Add Idea modal ────────────────────────────────────────────────────────────
function openAddModal() {
    document.getElementById('add-name').value  = '';
    document.getElementById('add-desc').value  = '';
    document.getElementById('add-market').value = '';
    document.getElementById('add-notes').value  = '';
    showModal('add-modal');
}

async function submitAddIdea() {
    const name = document.getElementById('add-name').value.trim();
    const desc = document.getElementById('add-desc').value.trim();
    if (!name || !desc) { toast('Name and description are required', 'error'); return; }

    try {
        await apiFetch('/api/ideas', {
            method: 'POST',
            body: JSON.stringify({ name, description: desc, target_market: document.getElementById('add-market').value.trim(), notes: document.getElementById('add-notes').value.trim(), source: 'manual' }),
        });
        closeModal('add-modal');
        toast('Idea added');
        await refreshAll();
    } catch (e) { toast(e.message, 'error'); }
}

// ── Import modal ──────────────────────────────────────────────────────────────
function openImportModal() {
    _importParsed = [];
    clearImportPreview();
    showModal('import-modal');
}

function switchImportTab(tab, btn) {
    _importTab = tab;
    document.querySelectorAll('.import-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    ['paste','sheets','json'].forEach(t => {
        const el = document.getElementById('import-tab-' + t);
        if (el) el.classList.toggle('hidden', t !== tab);
    });
}

async function previewImport() {
    _importParsed = [];
    const previews = [];

    if (_importTab === 'paste') {
        const raw = document.getElementById('import-csv-text').value.trim();
        if (!raw) { toast('Paste CSV first', 'error'); return; }
        try {
            const res = await apiFetch('/api/ideas/import-csv', { method: 'POST', body: JSON.stringify({ csv: raw, dry_run: true }) });
            previews.push(...(res.ideas || []));
            _importParsed = [{ type: 'csv', raw }];
        } catch (e) { toast(e.message, 'error'); return; }

    } else if (_importTab === 'sheets') {
        const url = document.getElementById('import-sheets-url').value.trim();
        if (!url) { toast('Enter a Google Sheets URL', 'error'); return; }
        try {
            const csvUrl = sheetsUrlToCsv(url);
            const csv = await fetchSheetCsv(csvUrl);
            const res = await apiFetch('/api/ideas/import-csv', { method: 'POST', body: JSON.stringify({ csv, dry_run: true }) });
            previews.push(...(res.ideas || []));
            _importParsed = [{ type: 'csv', raw: csv }];
        } catch (e) { toast(e.message, 'error'); return; }

    } else if (_importTab === 'json') {
        const raw = document.getElementById('import-json-text').value.trim();
        try {
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr)) throw new Error('Must be a JSON array');
            previews.push(...arr.map(r => ({ name: r.name || r.title || 'Untitled', description: r.description || r.desc || '' })));
            _importParsed = [{ type: 'json', data: arr }];
        } catch (e) { toast('Invalid JSON: ' + e.message, 'error'); return; }
    }

    if (!previews.length) { toast('No ideas found in input', 'error'); return; }
    showImportPreview(previews);
}

function showImportPreview(items) {
    const p = document.getElementById('import-preview');
    const list = document.getElementById('import-preview-list');
    const count = document.getElementById('import-preview-count');
    count.textContent = items.length + ' idea(s) found';
    list.innerHTML = items.slice(0, 20).map(i => `<li>${esc(i.name)} — ${esc((i.description||'').substring(0,80))}</li>`).join('');
    if (items.length > 20) list.innerHTML += `<li style="color:var(--text3)">...and ${items.length - 20} more</li>`;
    p.style.display = 'block';
}

function clearImportPreview() {
    _importParsed = [];
    const p = document.getElementById('import-preview');
    if (p) p.style.display = 'none';
}

async function submitImport() {
    if (!_importParsed.length) { await previewImport(); if (!_importParsed.length) return; }
    const item = _importParsed[0];

    try {
        let result;
        if (item.type === 'csv') {
            result = await apiFetch('/api/ideas/import-csv', { method: 'POST', body: JSON.stringify({ csv: item.raw }) });
        } else {
            const ideas = item.data.map(r => ({
                name:          r.name || r.title || 'Untitled',
                description:   r.description || r.desc || '',
                target_market: r.target_market || r.market || '',
                notes:         r.notes || '',
                source:        'json',
            }));
            result = await apiFetch('/api/ideas/bulk', { method: 'POST', body: JSON.stringify({ ideas }) });
        }
        closeModal('import-modal');
        toast(`Imported ${result.parsed || result.created || 0} idea(s)`);
        await refreshAll();
    } catch (e) { toast(e.message, 'error'); }
}

function sheetsUrlToCsv(url) {
    // Convert edit/view URL to CSV export URL
    const m = url.match(/spreadsheets\/d\/([^/]+)/);
    if (!m) throw new Error('Not a valid Google Sheets URL');
    const id = m[1];
    const gidM = url.match(/[#&]gid=(\d+)/);
    const gid = gidM ? `&gid=${gidM[1]}` : '';
    return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid}`;
}

async function fetchSheetCsv(csvUrl) {
    // Proxy through a simple fetch — will fail for private sheets
    const res = await fetch(csvUrl);
    if (!res.ok) throw new Error('Could not fetch sheet — make sure it is publicly shared');
    return res.text();
}

// ── Evaluation ────────────────────────────────────────────────────────────────
async function runEvaluation() {
    const ids = _selected.size > 0 ? Array.from(_selected) : [];

    // Count how many pending ideas will be evaluated
    const targets = ids.length > 0
        ? _ideas.filter(i => ids.includes(i.id))
        : _ideas.filter(i => i.status === 'pending');

    if (targets.length === 0) {
        toast('No pending ideas to evaluate. Select specific ideas or add new ones first.', 'error');
        return;
    }

    document.getElementById('eval-count').textContent = targets.length;
    showModal('eval-modal');

    try {
        const result = await apiFetch('/api/evaluate', {
            method: 'POST',
            body: JSON.stringify({ idea_ids: ids }),
        });
        closeModal('eval-modal');
        _selected.clear();
        await refreshAll();
        toast(`PRDgent evaluated ${result.evaluated} idea(s)`);
    } catch (e) {
        closeModal('eval-modal');
        toast('Evaluation failed: ' + e.message, 'error');
    }
}

// ── Delete ────────────────────────────────────────────────────────────────────
async function deleteIdea(e, id) {
    e.stopPropagation();
    if (!confirm('Delete this idea?')) return;
    try {
        await apiFetch('/api/ideas/' + id, { method: 'DELETE' });
        _selected.delete(id);
        await refreshAll();
        toast('Idea deleted');
    } catch (err) { toast(err.message, 'error'); }
}

// ── Detail modal ──────────────────────────────────────────────────────────────
function openDetail(id) {
    _currentIdea = _ideas.find(i => i.id === id);
    if (!_currentIdea) return;
    renderDetailModal(_currentIdea);
    showModal('detail-modal');
}

function renderDetailModal(idea) {
    document.getElementById('detail-title').textContent = idea.name;
    const ev = idea.evaluation;

    // Approve / reject buttons
    const approveBtn = document.getElementById('detail-approve-btn');
    const rejectBtn  = document.getElementById('detail-reject-btn');
    const moveBtn    = document.getElementById('detail-move-btn');

    if (idea.status === 'moved') {
        approveBtn.classList.add('hidden');
        rejectBtn.classList.add('hidden');
        moveBtn.textContent = '📁 ' + (idea.project_path || 'Project exists');
        moveBtn.disabled = true;
    } else {
        approveBtn.classList.remove('hidden');
        rejectBtn.classList.remove('hidden');
        approveBtn.textContent = idea.status === 'approved' ? '✓ Approved' : 'Approve';
        approveBtn.disabled = idea.status === 'approved';
        rejectBtn.textContent = idea.status === 'rejected' ? '✕ Rejected' : 'Reject';
        rejectBtn.disabled = idea.status === 'rejected';
        moveBtn.disabled = !['approved', 'evaluated'].includes(idea.status);
        moveBtn.textContent = '🚀 Move to Project';
    }

    // Status badge
    const statusBadge = `<span class="badge badge-${idea.status}">${statusLabel(idea.status)}</span>`;
    const verdictHtml = ev ? `<span class="verdict-badge verdict-${ev.verdict}">${verdictLabel(ev.verdict)}</span>` : '';

    let html = `
    <div class="detail-section">
        <div class="idea-meta" style="margin-bottom:12px">${statusBadge} ${verdictHtml}</div>
        <div class="detail-field">
            <label>Description</label>
            <p>${esc(idea.description)}</p>
        </div>
        ${idea.target_market ? `<div class="detail-field"><label>Target Market</label><p>${esc(idea.target_market)}</p></div>` : ''}
        ${idea.notes ? `<div class="detail-field"><label>Notes</label><p>${esc(idea.notes)}</p></div>` : ''}
    </div>`;

    if (idea.status === 'moved' && idea.project_path) {
        html += `<div class="detail-section">
            <div class="detail-section-title">Project</div>
            <span class="project-link">📁 ${esc(idea.project_path)}</span>
        </div>`;
    }

    if (ev) {
        const s = ev.scores || {};
        const scoreColor = (v) => {
            if (v >= 7) return 'var(--green)';
            if (v >= 4) return 'var(--yellow)';
            return 'var(--red)';
        };
        const scoreBar = (label, key) => `
            <div class="score-row">
                <div class="score-label">${label} <span>${s[key] ?? '—'}/10</span></div>
                <div class="score-track"><div class="score-fill" style="width:${(s[key]||0)*10}%;background:${scoreColor(s[key]||0)}"></div></div>
            </div>`;

        html += `<div class="detail-section">
            <div class="detail-section-title">PRDgent Evaluation</div>
            <div class="eval-block">
                <p class="eval-summary">"${esc(ev.one_line_summary || '')}"</p>
                <p class="eval-avg">Average score: <strong>${(s.average||0).toFixed(1)}</strong>/10</p>
                <div class="score-grid">
                    ${scoreBar('Market Demand','market_demand')}
                    ${scoreBar('Differentiation','differentiation')}
                    ${scoreBar('Feasibility','feasibility')}
                    ${scoreBar('Monetization','monetization')}
                    ${scoreBar('Timing','timing')}
                </div>
            </div>
        </div>`;

        if (ev.strengths?.length) html += `
            <div class="detail-section">
                <div class="detail-section-title">Strengths</div>
                <ul class="eval-list">${ev.strengths.map(s => `<li>${esc(s)}</li>`).join('')}</ul>
            </div>`;

        if (ev.concerns?.length) html += `
            <div class="detail-section">
                <div class="detail-section-title">Concerns</div>
                <ul class="eval-list concerns">${ev.concerns.map(c => `<li>${esc(c)}</li>`).join('')}</ul>
            </div>`;

        if (ev.target_customer) html += `
            <div class="detail-section">
                <div class="detail-section-title">Target Customer</div>
                <p class="target-customer">${esc(ev.target_customer)}</p>
            </div>`;

        if (ev.competitive_landscape) html += `
            <div class="detail-section">
                <div class="detail-section-title">Competitive Landscape</div>
                <p class="competitive-landscape">${esc(ev.competitive_landscape)}</p>
            </div>`;

        if (ev.recommended_next_steps?.length) html += `
            <div class="detail-section">
                <div class="detail-section-title">Recommended Next Steps</div>
                <ol class="steps-list">${ev.recommended_next_steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>
            </div>`;

    } else {
        html += `<div class="detail-section">
            <div class="no-eval-banner">⚡ This idea hasn't been evaluated yet. Select it and click Run PRDgent.</div>
        </div>`;
    }

    document.getElementById('detail-body').innerHTML = html;
}

async function approveCurrentIdea() {
    if (!_currentIdea) return;
    try {
        await apiFetch('/api/ideas/' + _currentIdea.id + '/approve', { method: 'POST' });
        await refreshAll();
        _currentIdea = _ideas.find(i => i.id === _currentIdea.id);
        if (_currentIdea) renderDetailModal(_currentIdea);
        toast('Idea approved');
    } catch (e) { toast(e.message, 'error'); }
}

async function rejectCurrentIdea() {
    if (!_currentIdea) return;
    try {
        await apiFetch('/api/ideas/' + _currentIdea.id + '/reject', { method: 'POST' });
        await refreshAll();
        _currentIdea = _ideas.find(i => i.id === _currentIdea.id);
        if (_currentIdea) renderDetailModal(_currentIdea);
        toast('Idea rejected');
    } catch (e) { toast(e.message, 'error'); }
}

// ── Move to Project ───────────────────────────────────────────────────────────
function openMoveModal() {
    if (!_currentIdea) return;
    const suggested = (_currentIdea.evaluation?.suggested_project_name)
        || slugify(_currentIdea.name);
    document.getElementById('move-name').value  = _currentIdea.name;
    document.getElementById('move-slug').value  = suggested;
    document.getElementById('move-slug-preview').textContent = suggested;
    showModal('move-modal');
}

function openMoveFromCard(e, id) {
    e.stopPropagation();
    _currentIdea = _ideas.find(i => i.id === id);
    if (!_currentIdea) return;
    if (document.getElementById('detail-modal').classList.contains('hidden')) {
        // open directly from card — no detail modal open
        openMoveModal();
    } else {
        openMoveModal();
    }
}

function updateMoveSlug() {
    const name = document.getElementById('move-name').value;
    const slug = slugify(name);
    document.getElementById('move-slug').value         = slug;
    document.getElementById('move-slug-preview').textContent = slug || '...';
}

function syncMoveSlug() {
    const slug = document.getElementById('move-slug').value;
    document.getElementById('move-slug-preview').textContent = slug || '...';
}

async function submitMoveToProject() {
    if (!_currentIdea) return;
    const name = document.getElementById('move-name').value.trim();
    const slug = document.getElementById('move-slug').value.trim();
    if (!name || !slug) { toast('Project name is required', 'error'); return; }

    try {
        const result = await apiFetch('/api/ideas/' + _currentIdea.id + '/move-to-project', {
            method: 'POST',
            body: JSON.stringify({ project_name: name, project_slug: slug }),
        });
        closeModal('move-modal');
        closeModal('detail-modal');
        await refreshAll();
        toast(`Project created at ${result.project_path} 🚀`);
    } catch (e) { toast(e.message, 'error'); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function statusLabel(s) {
    return { pending: 'Pending', evaluated: 'Evaluated', reviewed: 'Reviewed',
             approved: 'Approved', rejected: 'Rejected', moved: 'In Project' }[s] || s;
}
function verdictLabel(v) {
    return { good: '✓ Good Idea', not_ready: '⚡ Not Ready', poor: '✗ Poor Fit' }[v] || v;
}

function slugify(s) {
    return (s || '')
        .toLowerCase().trim()
        .replace(/[^\w\s-]/g, '')
        .replace(/[\s_]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 60);
}

function esc(s) {
    return String(s || '')
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Modal helpers ─────────────────────────────────────────────────────────────
function showModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }
function closeModalBg(e, id) { if (e.target.id === id) closeModal(id); }

// ── Toast ─────────────────────────────────────────────────────────────────────
let _toastTimer;
function toast(msg, type = 'success') {
    const el = document.getElementById('toast');
    el.textContent  = msg;
    el.className    = 'toast ' + type;
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}

// ── Start ─────────────────────────────────────────────────────────────────────
init().catch(e => { console.error('Init failed:', e); });
