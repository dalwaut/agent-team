/* OPAI Bot Space — SPA Logic */

'use strict';

// ── State ──────────────────────────────────────────────────────────────────────
let _supabase = null;
let _session  = null;
let _token    = null;
let _bots     = [];
let _credits  = 0;
let _activeCategory = 'all';
let _wizardBot    = null;
let _wizardStep   = 0;
let _wizardSteps  = [];
let _wizardConfig = {};
let _detailBot    = null;
let _isAdmin      = false;

// ── Boot ───────────────────────────────────────────────────────────────────────
(async function boot() {
    showLoading(true);

    // 1. Fetch Supabase config
    let cfg;
    try {
        const r = await fetch('/bot-space/api/auth/config');
        cfg = await r.json();
    } catch (e) {
        showError('Failed to reach server. Is opai-bot-space running?');
        return;
    }

    _supabase = window.supabase.createClient(cfg.supabase_url, cfg.supabase_anon_key);

    // 2. Get session
    const { data: { session } } = await _supabase.auth.getSession();
    if (!session) {
        window.location.href = '/auth/login?redirect=' + encodeURIComponent('/bot-space/');
        return;
    }
    _session = session;
    _token   = session.access_token;

    // 3. Determine role
    const meta = session.user?.app_metadata || {};
    _isAdmin = meta.role === 'admin';

    // 4. Load data
    const [, creditData] = await Promise.all([loadBots(), loadCredits()]);
    updateCreditChip();

    showLoading(false);
    renderAll();
})();

function showLoading(on) {
    const loading = document.getElementById('loading-screen');
    const body    = document.getElementById('app-body-wrap');
    if (loading) loading.style.display = on ? 'flex' : 'none';
    if (body)    body.style.display    = on ? 'none' : 'block';
}

function showError(msg) {
    const loading = document.getElementById('loading-screen');
    if (loading) {
        loading.innerHTML = '<div style="color:var(--red);text-align:center;padding:2rem;">' +
            '<div style="font-size:24px;margin-bottom:12px;">⚠️</div>' +
            '<div>' + esc(msg) + '</div>' +
            '<button class="btn btn-outline" style="margin-top:16px" onclick="location.reload()">Retry</button>' +
        '</div>';
        loading.style.display = 'flex';
    }
    const body = document.getElementById('app-body-wrap');
    if (body) body.style.display = 'none';
}

// ── API helpers ────────────────────────────────────────────────────────────────
async function api(method, path, body) {
    const opts = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + _token,
        },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const r = await fetch('/bot-space' + path, opts);
    if (!r.ok) {
        const err = await r.json().catch(() => ({ detail: r.statusText }));
        throw new Error(err.detail || r.statusText);
    }
    if (r.status === 204) return null;
    return r.json();
}

// ── Data loaders ───────────────────────────────────────────────────────────────
async function loadBots() {
    try {
        _bots = await api('GET', '/api/bots');
        // Ensure array fields are parsed (Supabase JSONB comes pre-parsed, but guard)
        _bots.forEach(b => {
            if (typeof b.cron_options === 'string') {
                try { b.cron_options = JSON.parse(b.cron_options); } catch { b.cron_options = []; }
            }
            if (typeof b.setup_schema === 'string') {
                try { b.setup_schema = JSON.parse(b.setup_schema); } catch { b.setup_schema = {}; }
            }
            b.cron_options = Array.isArray(b.cron_options) ? b.cron_options : [];
            b.features     = Array.isArray(b.features) ? b.features : [];
            b.tags         = Array.isArray(b.tags) ? b.tags : [];
        });
    } catch (e) {
        showToast('Failed to load bots: ' + e.message, true);
        _bots = [];
    }
}

async function loadCredits() {
    try {
        const data = await api('GET', '/api/credits');
        _credits = data.balance ?? 0;
        return data;
    } catch (e) {
        _credits = 0;
        return { balance: 0, transactions: [] };
    }
}

function updateCreditChip() {
    const el = document.getElementById('credit-balance');
    if (el) el.textContent = _credits.toLocaleString();
}

// ── Render all ─────────────────────────────────────────────────────────────────
function renderAll() {
    renderMyAgents();
    renderBrowse();
}

// ── My Agents ──────────────────────────────────────────────────────────────────
// Shows:
//   - Admin bots (is_admin_only) always visible to admins — no install record needed
//   - User bots that have an installation record
function renderMyAgents() {
    const section = document.getElementById('my-agents-section');
    const list    = document.getElementById('my-agents-list');

    // Admin bots always shown to admins; user bots shown if installed
    const myBots = _bots.filter(b => {
        if (b.is_admin_only && _isAdmin) return true;
        return !!b.installation;
    });

    if (!myBots.length) {
        section.style.display = 'none';
        return;
    }
    section.style.display = 'block';

    list.innerHTML = myBots.map(bot => {
        const inst   = bot.installation;
        const isAdmin = bot.is_admin_only;

        // For admin bots with no installation, show as "active" system service
        const status = isAdmin && !inst ? 'active' : (inst?.status || 'pending_setup');
        const nextRun = inst?.next_run_at ? relativeTime(inst.next_run_at) : (isAdmin ? 'System managed' : '—');
        const cron    = inst?.cron_expr || (isAdmin ? 'System' : '');

        const instId = inst?.id || '';

        return '<div class="agent-row status-' + status + '">' +
            '<div class="agent-row-icon">' + esc(bot.icon || '🤖') + '</div>' +
            '<div class="agent-row-info">' +
                '<div class="agent-row-name">' + esc(bot.name) +
                    ' <span class="status-badge badge-' + status + '">' +
                        (isAdmin && !inst ? 'system' : esc(status.replace(/_/g, ' '))) +
                    '</span>' +
                '</div>' +
                '<div class="agent-row-meta">' +
                    (isAdmin ? 'Admin service' : 'Next run: ' + nextRun + ' · ' + esc(cron)) +
                '</div>' +
            '</div>' +
            '<div class="agent-row-actions">' +
                (bot.dashboard_url
                    ? '<a href="' + esc(bot.dashboard_url) + '" class="btn btn-outline btn-sm">Dashboard</a>'
                    : '') +
                (!isAdmin && inst
                    ? '<button class="btn btn-outline btn-sm" onclick="openWizard(\'' + bot.slug + '\', true)">Configure</button>'
                    : '') +
                (!isAdmin && inst && status === 'active'
                    ? '<button class="btn btn-outline btn-sm" onclick="pauseInstallation(\'' + instId + '\')">Pause</button>'
                    : '') +
                (!isAdmin && inst && status === 'paused'
                    ? '<button class="btn btn-outline btn-sm" onclick="resumeInstallation(\'' + instId + '\')">Resume</button>'
                    : '') +
            '</div>' +
        '</div>';
    }).join('');
}

// ── Browse Grid ────────────────────────────────────────────────────────────────
function renderBrowse() {
    const grid = document.getElementById('bot-grid');
    const q    = (document.getElementById('search-input')?.value || '').toLowerCase();

    let visible = _bots.filter(b => {
        if (_activeCategory !== 'all' && b.category !== _activeCategory) return false;
        if (q && !b.name.toLowerCase().includes(q) && !b.tagline.toLowerCase().includes(q)) return false;
        return true;
    });

    if (!visible.length) {
        grid.innerHTML = '<div class="empty">No bots match your search.</div>';
        return;
    }

    grid.innerHTML = visible.map(bot => {
        const inst    = bot.installation;
        const status  = inst?.status;
        const isAdmin = bot.is_admin_only;

        let borderClass = '';
        let ctaLabel    = isAdmin ? 'View Dashboard' : 'Get Agent';
        let ctaClass    = '';
        let ctaAction   = isAdmin
            ? 'window.location.href=\'' + esc(bot.dashboard_url) + '\''
            : 'handleCardCTA(\'' + bot.slug + '\')';

        if (!isAdmin) {
            if (status === 'active')        { borderClass = 'is-active';   ctaLabel = 'Manage';      ctaClass = 'cta-manage'; ctaAction = 'openWizard(\'' + bot.slug + '\', true)'; }
            else if (status === 'pending_setup') { borderClass = 'is-unlocked'; ctaLabel = 'Set Up'; ctaClass = 'cta-setup';  ctaAction = 'openWizard(\'' + bot.slug + '\', false)'; }
            else if (status === 'paused')   { borderClass = 'is-unlocked'; ctaLabel = 'Manage';      ctaClass = 'cta-manage'; ctaAction = 'openWizard(\'' + bot.slug + '\', true)'; }
            else if (status === 'error')    { ctaLabel = 'Reconfigure'; ctaClass = 'cta-setup'; ctaAction = 'openWizard(\'' + bot.slug + '\', true)'; }
        }

        const priceStr = isAdmin
            ? 'Free — admin managed'
            : bot.unlock_credits > 0
                ? '⚡ ' + bot.unlock_credits + ' to unlock · ' + bot.run_credits + '/run'
                : bot.run_credits > 0
                    ? '⚡ ' + bot.run_credits + ' credits/run'
                    : 'Free';

        const tags = bot.tags.slice(0, 4)
            .map(t => '<span class="bot-tag">' + esc(t) + '</span>').join('');

        const adminBadge = isAdmin
            ? '<div class="admin-overlay">Admin</div>'
            : '';

        // Use single-quoted slug in onclick — slugs are safe kebab-case identifiers
        return '<div class="bot-card ' + borderClass + '" onclick="openDetail(\'' + bot.slug + '\')">' +
            adminBadge +
            '<div class="bot-card-icon">' + bot.icon + '</div>' +
            '<div class="bot-card-name">' + esc(bot.name) + '</div>' +
            '<div class="bot-card-tagline">' + esc(bot.tagline || '') + '</div>' +
            '<div class="bot-card-tags">' + tags + '</div>' +
            '<div class="bot-card-pricing">' + esc(priceStr) + '</div>' +
            '<button class="bot-card-cta ' + ctaClass + '" onclick="event.stopPropagation();' + ctaAction + '">' +
                esc(ctaLabel) +
            '</button>' +
        '</div>';
    }).join('');
}

function setCategory(cat, el) {
    _activeCategory = cat;
    document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    el.classList.add('active');
    renderBrowse();
}

function applyFilters() { renderBrowse(); }

// ── Detail Modal ───────────────────────────────────────────────────────────────
function openDetail(slug) {
    const bot = _bots.find(b => b.slug === slug);
    if (!bot) return;
    _detailBot = bot;

    const inst    = bot.installation;
    const status  = inst?.status;
    const isAdmin = bot.is_admin_only;

    document.getElementById('dm-icon').textContent    = bot.icon || '🤖';
    document.getElementById('dm-name').textContent    = bot.name;
    document.getElementById('dm-tagline').textContent = bot.tagline || '';

    const meta = document.getElementById('dm-meta');
    meta.innerHTML =
        '<span class="meta-badge">' + esc(bot.category) + '</span>' +
        '<span class="meta-badge">v' + esc(bot.version || '1.0.0') + '</span>' +
        '<span class="meta-badge">' + esc(bot.author || 'OPAI') + '</span>' +
        (isAdmin ? '<span class="meta-badge" style="color:var(--accent)">Admin</span>' : '');

    document.getElementById('dm-description').textContent = bot.description || '';

    const featEl = document.getElementById('dm-features');
    if (bot.features.length) {
        featEl.innerHTML = '<h4>Features</h4><ul>' +
            bot.features.map(f => '<li>' + esc(f) + '</li>').join('') +
            '</ul>';
    } else {
        featEl.innerHTML = '';
    }

    const priceEl = document.getElementById('dm-pricing');
    priceEl.innerHTML =
        '<div class="price-row"><span>Unlock cost</span>' +
            (isAdmin || bot.unlock_credits === 0
                ? '<span class="price-free">Free</span>'
                : '<span class="price-val">⚡ ' + bot.unlock_credits + ' credits</span>') +
        '</div>' +
        '<div class="price-row"><span>Per-run cost</span>' +
            (isAdmin || bot.run_credits === 0
                ? '<span class="price-free">Free</span>'
                : '<span class="price-val">⚡ ' + bot.run_credits + ' credits</span>') +
        '</div>' +
        (bot.cron_options.length
            ? '<div class="price-row" style="flex-direction:column;gap:4px"><span style="margin-bottom:4px">Available schedules</span>' +
                bot.cron_options.map(o => '<span class="price-free" style="font-size:12px">· ' + esc(o.label) + '</span>').join('') +
              '</div>'
            : '');

    const cta = document.getElementById('dm-cta');
    if (isAdmin) {
        cta.textContent = 'Go to Dashboard';
    } else if (!status) {
        cta.textContent = bot.unlock_credits > 0 ? 'Get Agent — ⚡ ' + bot.unlock_credits : 'Get Agent (Free)';
    } else if (status === 'pending_setup') {
        cta.textContent = 'Set Up';
    } else {
        cta.textContent = 'Manage';
    }

    openModal('detail-modal');
}

function handleDetailCTA() {
    if (!_detailBot) return;
    const bot = _detailBot;
    closeModal('detail-modal');

    // Admin bots: just navigate to dashboard
    if (bot.is_admin_only) {
        if (bot.dashboard_url) window.location.href = bot.dashboard_url;
        return;
    }

    handleCardCTA(bot.slug);
}

async function handleCardCTA(slug) {
    const bot  = _bots.find(b => b.slug === slug);
    if (!bot) return;

    // Admin bots handled differently
    if (bot.is_admin_only) {
        if (bot.dashboard_url) window.location.href = bot.dashboard_url;
        return;
    }

    const inst = bot.installation;

    if (!inst) {
        // Unlock first
        if (bot.unlock_credits === 0) {
            try {
                await api('POST', '/api/bots/' + slug + '/unlock');
                await loadBots();
            } catch (e) {
                if (!e.message.includes('Already unlocked')) {
                    showToast('Unlock error: ' + e.message, true);
                    return;
                }
                await loadBots();
            }
        } else {
            if (!confirm('Unlock ' + bot.name + ' for ⚡ ' + bot.unlock_credits + ' credits?\n\nYour current balance: ⚡ ' + _credits)) return;
            try {
                await api('POST', '/api/bots/' + slug + '/unlock');
                await loadBots();
                await loadCredits();
                updateCreditChip();
                showToast('Unlocked! Complete setup to activate.');
            } catch (e) {
                showToast('Unlock failed: ' + e.message, true);
                return;
            }
        }
    }

    openWizard(slug, false);
}

// ── Wizard ────────────────────────────────────────────────────────────────────
// Step order for user bots with schema:  [schema steps...] → schedule → review
// Step order for user bots without schema: schedule → review
// Admin bots: never reach wizard (handled above)
function openWizard(slug, isReconfigure) {
    const bot = _bots.find(b => b.slug === slug);
    if (!bot) return;
    _wizardBot    = bot;
    _wizardConfig = {};
    _wizardStep   = 0;

    const schema      = bot.setup_schema || {};
    const schemaSteps = Array.isArray(schema.steps) ? schema.steps : [];
    const cronOpts    = bot.cron_options;

    // Build wizard steps
    const schedStep = {
        title: 'Schedule',
        fields: [{
            name: 'cron_preset',
            label: 'Check Frequency',
            type: 'select',
            required: true,
            options: cronOpts,
        }],
    };

    if (schemaSteps.length) {
        _wizardSteps = [
            ...schemaSteps,
            ...(cronOpts.length ? [schedStep] : []),
            { title: 'Review', fields: [], _review: true },
        ];
    } else {
        _wizardSteps = [
            ...(cronOpts.length ? [schedStep] : []),
            { title: 'Review', fields: [], _review: true },
        ];
    }

    document.getElementById('wiz-title').textContent =
        (isReconfigure ? 'Configure: ' : 'Set Up: ') + bot.name;

    renderWizardSteps();
    renderWizardPanel();
    openModal('wizard-modal');
}

function renderWizardSteps() {
    const el = document.getElementById('wiz-steps');
    el.innerHTML = _wizardSteps.map((s, i) => {
        let cls = i < _wizardStep ? 'done' : i === _wizardStep ? 'active' : '';
        return '<div class="wizard-step ' + cls + '">' + esc(s.title) + '</div>';
    }).join('');
}

function renderWizardPanel() {
    const step    = _wizardSteps[_wizardStep];
    const panels  = document.getElementById('wiz-panels');
    const backBtn = document.getElementById('wiz-back');
    const nextBtn = document.getElementById('wiz-next');

    backBtn.style.display = _wizardStep > 0 ? 'inline-flex' : 'none';

    if (step._review) {
        nextBtn.textContent = 'Activate Bot';
        panels.innerHTML = renderReviewPanel();
        return;
    }

    const isLastContentStep = _wizardStep === _wizardSteps.length - 2;
    nextBtn.textContent = isLastContentStep ? 'Review →' : 'Next →';

    let html = '<div class="wizard-panel active"><h3>' + esc(step.title) + '</h3>';

    // Setup guide accordion
    if (step.guide) {
        const g = step.guide;
        html += '<div class="guide-accordion">' +
            '<button class="guide-toggle" onclick="toggleGuide(this)">ℹ️ Setup Guide: ' + esc(g.title || '') + '</button>' +
            '<div class="guide-body">';
        if (g.steps && g.steps.length) {
            html += '<ol>' + g.steps.map(s => '<li>' + esc(s) + '</li>').join('') + '</ol>';
        }
        if (g.external_url && g.external_label) {
            html += '<br><a href="' + esc(g.external_url) + '" target="_blank" rel="noopener">' + esc(g.external_label) + ' ↗</a>';
        }
        html += '</div></div>';
    }

    // Form fields
    (step.fields || []).forEach(field => {
        const val = _wizardConfig[field.name] !== undefined ? _wizardConfig[field.name] : (field.default !== undefined ? String(field.default) : '');
        html += '<div class="form-group">';
        html += '<label class="form-label">' + esc(field.label) + (field.required ? ' *' : '') + '</label>';

        if (field.type === 'select') {
            const opts = Array.isArray(field.options) ? field.options : [];
            html += '<select class="form-select" id="wf-' + field.name + '" onchange="wizardFieldChange()">';
            opts.forEach(opt => {
                const sel = (opt.value === val || (!val && opts.indexOf(opt) === 0)) ? ' selected' : '';
                html += '<option value="' + esc(opt.value) + '"' + sel + '>' + esc(opt.label) + '</option>';
            });
            html += '</select>';
        } else {
            html += '<input class="form-input" id="wf-' + field.name + '"' +
                ' type="' + esc(field.type || 'text') + '"' +
                ' placeholder="' + esc(field.placeholder || '') + '"' +
                ' value="' + esc(val) + '"' +
                ' oninput="wizardFieldChange()">';
        }
        html += '</div>';
    });

    // Test Connection button — shown on steps with credential fields
    const hasCredentials = (step.fields || []).some(f => ['password', 'email', 'text'].includes(f.type));
    if (hasCredentials && _wizardBot) {
        html += '<div class="test-section">' +
            '<button class="test-btn" id="test-btn" onclick="runTest()">🔌 Test Connection</button>' +
            '<div id="test-result" style="display:none"></div>' +
            '</div>';
    }

    html += '</div>';
    panels.innerHTML = html;

    // Auto-collect the first select value if nothing set yet
    collectWizardFields();
}

function renderReviewPanel() {
    const bot  = _wizardBot;
    const cron = _wizardConfig.cron_preset || (bot.cron_options[0]?.value) || '0 * * * *';
    const cronLabel = (bot.cron_options.find(o => o.value === cron))?.label || cron;

    return '<div class="wizard-panel active">' +
        '<h3>Review & Activate</h3>' +
        '<div class="review-card">' +
            '<div class="review-row"><span class="review-label">Bot</span><span>' + esc(bot.name) + '</span></div>' +
            '<div class="review-row"><span class="review-label">Schedule</span><span>' + esc(cronLabel) + '</span></div>' +
            '<div class="review-row"><span class="review-label">Unlock cost</span><span>' +
                (bot.unlock_credits > 0 ? '⚡ ' + bot.unlock_credits + ' (already charged)' : 'Free') +
            '</span></div>' +
            '<div class="review-row"><span class="review-label">Per run</span><span>' +
                (bot.run_credits > 0 ? '⚡ ' + bot.run_credits + ' credits' : 'Free') +
            '</span></div>' +
        '</div>' +
    '</div>';
}

function toggleGuide(btn) {
    btn.nextElementSibling.classList.toggle('open');
}

function wizardFieldChange() { collectWizardFields(); }

function collectWizardFields() {
    const step = _wizardSteps[_wizardStep];
    if (!step || step._review) return;
    (step.fields || []).forEach(field => {
        const el = document.getElementById('wf-' + field.name);
        if (el) _wizardConfig[field.name] = el.value;
    });
}

function wizardNext() {
    if (_wizardSteps[_wizardStep]._review) { activateBot(); return; }
    collectWizardFields();
    _wizardStep++;
    renderWizardSteps();
    renderWizardPanel();
}

function wizardPrev() {
    if (_wizardStep === 0) return;
    collectWizardFields();
    _wizardStep--;
    renderWizardSteps();
    renderWizardPanel();
}

// ── Test Connection ────────────────────────────────────────────────────────────
async function runTest() {
    const btn   = document.getElementById('test-btn');
    const resEl = document.getElementById('test-result');
    if (!btn || !resEl) return;

    collectWizardFields();
    btn.disabled     = true;
    btn.textContent  = '⏳ Testing...';
    resEl.style.display = 'none';

    try {
        const result = await api('POST', '/api/bots/' + _wizardBot.slug + '/test', { config: _wizardConfig });
        resEl.style.display = 'block';

        if (result.success) {
            let html = '<div class="test-result success">✓ ' + esc(result.message) + '</div>';
            if (result.preview) {
                const p = result.preview;
                html += '<div class="test-preview">';
                if (p.from)          html += previewRow('From',    p.from);
                if (p.subject)       html += previewRow('Subject', p.subject);
                if (p.date)          html += previewRow('Date',    p.date);
                if (p.total_unseen != null) html += previewRow('Unseen', p.total_unseen + ' email(s)');
                if (p.classification) html += previewRow('AI note', p.classification);
                html += '</div>';
            }
            resEl.innerHTML = html;
        } else {
            resEl.innerHTML = '<div class="test-result error">✗ ' + esc(result.message) + '</div>';
        }
    } catch (e) {
        resEl.style.display = 'block';
        resEl.innerHTML = '<div class="test-result error">✗ ' + esc(e.message) + '</div>';
    } finally {
        btn.disabled = false;
        btn.textContent = '🔌 Test Connection';
    }
}

function previewRow(label, val) {
    return '<div class="test-preview-row">' +
        '<span class="test-preview-label">' + esc(label) + '</span>' +
        '<span class="test-preview-val">' + esc(String(val)) + '</span>' +
        '</div>';
}

// ── Activate ──────────────────────────────────────────────────────────────────
async function activateBot() {
    const bot  = _wizardBot;
    const cron = _wizardConfig.cron_preset || (bot.cron_options[0]?.value) || '0 * * * *';

    const botConfig = Object.fromEntries(
        Object.entries(_wizardConfig).filter(([k]) => k !== 'cron_preset')
    );

    const nextBtn = document.getElementById('wiz-next');
    nextBtn.disabled = true;
    nextBtn.textContent = 'Activating...';

    try {
        await api('POST', '/api/installations', {
            agent_slug: bot.slug,
            cron_expr: cron,
            config: botConfig,
        });
        closeModal('wizard-modal');
        showToast(bot.name + ' is now active!');
        await loadBots();
        await loadCredits();
        updateCreditChip();
        renderAll();
    } catch (e) {
        showToast('Activation failed: ' + e.message, true);
    } finally {
        nextBtn.disabled = false;
        nextBtn.textContent = 'Activate Bot';
    }
}

// ── Installation actions ───────────────────────────────────────────────────────
async function pauseInstallation(id) {
    try {
        await api('POST', '/api/installations/' + id + '/pause');
        showToast('Bot paused.');
        await loadBots();
        renderAll();
    } catch (e) { showToast('Error: ' + e.message, true); }
}

async function resumeInstallation(id) {
    try {
        await api('POST', '/api/installations/' + id + '/resume');
        showToast('Bot resumed.');
        await loadBots();
        renderAll();
    } catch (e) { showToast('Error: ' + e.message, true); }
}

// ── Credits Modal ──────────────────────────────────────────────────────────────
async function openCreditsModal() {
    const data = await loadCredits();
    updateCreditChip();
    document.getElementById('modal-credit-num').textContent = _credits.toLocaleString();

    const txList = document.getElementById('tx-list');
    const txs = data?.transactions || [];
    if (!txs.length) {
        txList.innerHTML = '<div class="empty">No transactions yet.</div>';
    } else {
        txList.innerHTML = txs.map(tx => {
            const pos  = tx.amount > 0;
            const amt  = (pos ? '+' : '') + tx.amount;
            const date = new Date(tx.created_at).toLocaleDateString();
            return '<div class="tx-row">' +
                '<span class="tx-amount ' + (pos ? 'pos' : 'neg') + '">' + amt + '</span>' +
                '<span class="tx-desc">' + esc(tx.description || tx.type) + '</span>' +
                '<span class="tx-date">' + date + '</span>' +
            '</div>';
        }).join('');
    }
    openModal('credits-modal');
}

// ── Runs Modal ─────────────────────────────────────────────────────────────────
async function openRunsModal() {
    let runs = [];
    try { runs = await api('GET', '/api/runs'); } catch (e) {}

    const list = document.getElementById('runs-list');
    if (!runs.length) {
        list.innerHTML = '<div class="empty">No runs yet — activate a bot to get started.</div>';
    } else {
        list.innerHTML = runs.map(r => {
            const when    = r.started_at ? new Date(r.started_at).toLocaleString() : '—';
            const summary = r.result_summary || r.error_message || '';
            return '<div class="run-row">' +
                '<span class="run-status ' + esc(r.status) + '">' + esc(r.status) + '</span>' +
                '<span class="run-slug">' + esc(r.agent_slug) + '</span>' +
                '<span class="run-meta">' + esc(when) + (summary ? ' · ' + esc(summary.slice(0, 60)) : '') + '</span>' +
                (r.credits_charged ? '<span class="run-credits">-⚡' + r.credits_charged + '</span>' : '') +
            '</div>';
        }).join('');
    }
    openModal('runs-modal');
}

// ── Modal helpers ──────────────────────────────────────────────────────────────
function openModal(id)  { document.getElementById(id)?.classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id)?.classList.add('hidden'); }

document.addEventListener('click', e => {
    if (e.target.classList.contains('modal-backdrop')) e.target.classList.add('hidden');
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        document.querySelectorAll('.modal-backdrop:not(.hidden)').forEach(m => m.classList.add('hidden'));
    }
});

// ── Toast ──────────────────────────────────────────────────────────────────────
let _toastTimer = null;
function showToast(msg, isError = false) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'show ' + (isError ? 'err' : 'ok');
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

// ── Utilities ──────────────────────────────────────────────────────────────────
function esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

function relativeTime(iso) {
    const diff = new Date(iso) - Date.now();
    const abs  = Math.abs(diff);
    const past = diff < 0;
    if (abs < 60000)    return 'just now';
    if (abs < 3600000)  return Math.round(abs / 60000)   + 'm ' + (past ? 'ago' : '');
    if (abs < 86400000) return Math.round(abs / 3600000)  + 'h ' + (past ? 'ago' : '');
    return Math.round(abs / 86400000) + 'd';
}
