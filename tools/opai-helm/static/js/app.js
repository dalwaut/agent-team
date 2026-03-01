/**
 * HELM -- Autonomous Business Runner -- Core App Bootstrap
 * Auth, state, navigation, API helpers, business switching.
 */

'use strict';

// ── Global State ─────────────────────────────────────────────────────────────
window.HELM = {
    currentBusiness: null,
    businesses: [],
    supabase: null,
    user: null,
    token: null,
    currentTab: 'welcome',
};

// ── Utility: HTML escaping ───────────────────────────────────────────────────
function esc(str) {
    if (str == null) return '';
    var d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
}

// ── Utility: Format currency ─────────────────────────────────────────────────
function fmtCurrency(val, compact) {
    if (val == null || isNaN(val)) return '--';
    var n = Number(val);
    if (compact && Math.abs(n) >= 1000) {
        if (Math.abs(n) >= 1000000) return '$' + (n / 1000000).toFixed(1) + 'M';
        return '$' + (n / 1000).toFixed(1) + 'K';
    }
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Utility: Format number ───────────────────────────────────────────────────
function fmtNum(val) {
    if (val == null || isNaN(val)) return '--';
    return Number(val).toLocaleString('en-US');
}

// ── Utility: Format date ─────────────────────────────────────────────────────
function fmtDate(dateStr) {
    if (!dateStr) return '--';
    var d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateTime(dateStr) {
    if (!dateStr) return '--';
    var d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
           d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// ── Utility: Relative time ───────────────────────────────────────────────────
function timeAgo(dateStr) {
    if (!dateStr) return '';
    var diff = Date.now() - new Date(dateStr).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.floor(hours / 24);
    return days + 'd ago';
}

// ── Utility: Countdown ───────────────────────────────────────────────────────
function countdown(dateStr) {
    if (!dateStr) return '';
    var diff = new Date(dateStr).getTime() - Date.now();
    if (diff <= 0) return 'Expired';
    var hours = Math.floor(diff / 3600000);
    var mins = Math.floor((diff % 3600000) / 60000);
    if (hours > 24) return Math.floor(hours / 24) + 'd ' + (hours % 24) + 'h left';
    if (hours > 0) return hours + 'h ' + mins + 'm left';
    return mins + 'm left';
}

// ── Toast Notifications ──────────────────────────────────────────────────────
function showToast(msg, type, duration, onClick) {
    type = type || 'info';
    duration = duration || 4000;
    var container = document.getElementById('toast-container');
    var toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.textContent = msg;
    if (onClick) {
        toast.style.cursor = 'pointer';
        toast.addEventListener('click', function() {
            toast.remove();
            onClick();
        });
    }
    container.appendChild(toast);
    setTimeout(function() {
        toast.classList.add('toast-fade-out');
        setTimeout(function() { toast.remove(); }, 300);
    }, duration);
}

// ── Loading ──────────────────────────────────────────────────────────────────
function showLoading() {
    var el = document.getElementById('loading-overlay');
    if (el) el.classList.remove('hidden');
}

function hideLoading() {
    var el = document.getElementById('loading-overlay');
    if (el) el.classList.add('hidden');
}

// ── API Fetch Wrapper ────────────────────────────────────────────────────────
async function apiFetch(path, options) {
    options = options || {};
    var headers = Object.assign({}, options.headers || {});

    if (HELM.token) {
        headers['Authorization'] = 'Bearer ' + HELM.token;
    }

    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(options.body);
    }

    options.headers = headers;
    var resp = await fetch(path, options);

    if (resp.status === 401) {
        window.location.href = '/auth/login?redirect=' + encodeURIComponent('/helm/');
        throw new Error('Unauthorized');
    }
    if (!resp.ok) {
        var errMsg = 'API error: ' + resp.status;
        try {
            var errBody = await resp.json();
            if (errBody.detail) errMsg = errBody.detail;
            else if (errBody.error) errMsg = errBody.error;
        } catch (_) { /* ignore parse error */ }
        throw new Error(errMsg);
    }
    if (resp.status === 204) return null;
    return resp.json();
}

// ── Business API shorthand ───────────────────────────────────────────────────
function bizApi(subpath, opts) {
    if (!HELM.currentBusiness) {
        return Promise.reject(new Error('No business selected'));
    }
    return apiFetch('/helm/api/businesses/' + HELM.currentBusiness.id + subpath, opts);
}

// ── Tab Routing ──────────────────────────────────────────────────────────────
function showTab(tabName) {
    HELM.currentTab = tabName;

    // Update tab button active states
    document.querySelectorAll('.tab-nav .tab-btn').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    // Update view panels
    document.querySelectorAll('.view').forEach(function(view) {
        view.classList.toggle('active', view.dataset.tab === tabName);
    });

    // Render tab content on switch
    if (tabName === 'dashboard' && HELM.currentBusiness) {
        renderDashboard();
    } else if (tabName === 'onboarding') {
        renderOnboarding();
    } else if (tabName === 'actions' && HELM.currentBusiness) {
        renderActions();
    } else if (tabName === 'hitl' && HELM.currentBusiness) {
        renderHITL();
    } else if (tabName === 'settings' && HELM.currentBusiness) {
        renderSettings();
    }
}

// ── Health Score Helpers ─────────────────────────────────────────────────────
function healthScoreClass(score) {
    if (score == null) return 'score-yellow';
    if (score >= 90) return 'score-blue';
    if (score >= 75) return 'score-green';
    if (score >= 60) return 'score-yellow';
    if (score >= 40) return 'score-orange';
    return 'score-red';
}

function healthFillClass(score) {
    if (score == null) return 'fill-yellow';
    if (score >= 90) return 'fill-blue';
    if (score >= 75) return 'fill-green';
    if (score >= 60) return 'fill-yellow';
    if (score >= 40) return 'fill-orange';
    return 'fill-red';
}

// ── Risk Level Class ─────────────────────────────────────────────────────────
function riskClass(level) {
    var l = (level || '').toLowerCase();
    if (l === 'high' || l === 'critical') return 'risk-high';
    if (l === 'medium') return 'risk-medium';
    return 'risk-low';
}

function riskBadgeClass(level) {
    var l = (level || '').toLowerCase();
    if (l === 'high' || l === 'critical') return 'badge-error';
    if (l === 'medium') return 'badge-warning';
    return 'badge-info';
}

// ── Action Type Icons ────────────────────────────────────────────────────────
function actionIcon(type) {
    // Content creation — bold/colorful icons
    if (type === 'content_generate')    return '✏️';
    if (type === 'content_publish')     return '📤';
    if (type === 'content_review')      return '👁️';
    // Scheduler wrappers — muted gear (these are system/operational)
    if (type && type.startsWith('scheduled_')) return '⚙️';
    // Business lifecycle
    if (type === 'helm_launched')       return '🚀';
    if (type === 'hitl_expiry')         return '⏱️';
    if (type === 'hitl_approved')       return '✅';
    if (type === 'hitl_rejected')       return '❌';
    // Other ops
    var map = {
        'social_post':  '📱',
        'email':        '✉️',
        'payment':      '💳',
        'website':      '🌐',
        'analytics':    '📊',
        'customer':     '👤',
        'support':      '💬',
        'stripe_sync':  '💳',
        'site_health':  '🩺',
        'alert':        '⚠️',
    };
    return map[type] || '⚡';
}

// ── Business Selector ────────────────────────────────────────────────────────
function renderBusinessSelector(businesses) {
    var area = document.getElementById('business-selector-area');
    if (!businesses || businesses.length === 0) {
        area.innerHTML = '';
        return;
    }

    var options = businesses.map(function(b) {
        var sel = (HELM.currentBusiness && HELM.currentBusiness.id === b.id) ? ' selected' : '';
        return '<option value="' + esc(b.id) + '"' + sel + '>' + esc(b.name) + '</option>';
    }).join('');

    area.innerHTML =
        '<select class="business-select" id="business-switcher" onchange="onBusinessSwitch(this.value)">' +
            options +
        '</select>' +
        '<button class="btn btn-sm btn-primary" onclick="startOnboarding()">+ New Business</button>';
}

function onBusinessSwitch(bizId) {
    var biz = HELM.businesses.find(function(b) { return b.id === bizId; });
    if (biz) selectBusiness(biz);
}

// ── Tab mode: 'onboarding' shows only the Onboarding tab; 'full' shows all ──
function setTabMode(mode) {
    var nav = document.getElementById('tab-nav');
    nav.classList.remove('hidden');
    var restricted = ['dashboard', 'actions', 'hitl', 'settings'];
    restricted.forEach(function(tab) {
        var btn = nav.querySelector('[data-tab="' + tab + '"]');
        if (btn) btn.style.display = mode === 'full' ? '' : 'none';
    });
}

function selectBusiness(business) {
    HELM.currentBusiness = business;
    renderBusinessHeader();
    setTabMode('full');
    showTab('dashboard');
}

// ── Business Header ──────────────────────────────────────────────────────────
function renderBusinessHeader() {
    var biz = HELM.currentBusiness;
    if (!biz) return;

    var el = document.getElementById('business-header');
    el.classList.remove('hidden');

    var score = biz.health_score != null ? biz.health_score : null;
    var scoreHtml = '';
    if (score != null) {
        scoreHtml =
            '<div class="health-badge">' +
                '<div class="health-score">' +
                    '<span class="score-num ' + healthScoreClass(score) + '">' + score + '</span>' +
                    '<div class="health-bar"><div class="bar-fill ' + healthFillClass(score) + '" style="width:' + Math.min(score, 100) + '%"></div></div>' +
                '</div>' +
            '</div>';
    }

    var pauseLabel = biz.is_active ? 'Pause HELM' : 'Resume HELM';
    var pauseClass = biz.is_active ? 'btn btn-sm btn-ghost' : 'btn btn-sm btn-primary';

    el.innerHTML =
        '<div>' +
            '<span class="biz-name">' + esc(biz.name) + '</span>' +
            (biz.industry ? ' <span class="biz-industry">' + esc(biz.industry) + '</span>' : '') +
        '</div>' +
        scoreHtml +
        '<button class="' + pauseClass + '" onclick="togglePause()" style="margin-left:auto;">' +
            (biz.is_active ? '\u23F8 ' : '\u25B6 ') + pauseLabel +
        '</button>';
}

async function togglePause() {
    try {
        var newState = !HELM.currentBusiness.is_active;
        await bizApi('', { method: 'PATCH', body: { is_active: newState } });
        HELM.currentBusiness.is_active = newState;
        renderBusinessHeader();
        showToast(newState ? 'HELM resumed' : 'HELM paused', 'success');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// ── Welcome Screen ───────────────────────────────────────────────────────────
function renderWelcome() {
    var el = document.getElementById('view-welcome');
    el.innerHTML =
        '<div class="welcome-screen">' +
            '<div class="welcome-logo">HELM</div>' +
            '<h2>Autonomous Business Runner</h2>' +
            '<p>HELM runs your entire business on autopilot -- content, social media, payments, customer support, and more. Add your first business to get started.</p>' +
            '<button class="btn btn-lg btn-primary" onclick="startOnboarding()">Add Your First Business</button>' +
        '</div>';
}

function startOnboarding() {
    setTabMode('onboarding');
    showTab('onboarding');
    initOnboarding();
}

// ── Settings Tab ─────────────────────────────────────────────────────────────
// ── Settings — mutable state for products & competitors ──────────────────────
var HELM_EDIT = { products: [], competitors: [] };

function _renderProductsList() {
    var el = document.getElementById('s-products-list');
    if (!el) return;
    if (HELM_EDIT.products.length === 0) {
        el.innerHTML = '<p style="color:var(--text-muted);font-size:13px;margin:0;">No products/services yet.</p>';
        return;
    }
    el.innerHTML = HELM_EDIT.products.map(function(p, i) {
        return '<div class="item-row" id="prod-row-' + i + '">' +
            '<div class="item-row-info">' +
                '<strong>' + esc(p.name || '') + '</strong>' +
                (p.price ? ' <span style="color:var(--accent);">$' + esc(String(p.price)) + '</span>' : '') +
                (p.description ? '<div style="color:var(--text-muted);font-size:12px;margin-top:2px;">' + esc(p.description) + '</div>' : '') +
            '</div>' +
            '<div class="item-row-actions">' +
                '<button class="btn btn-sm btn-ghost" onclick="editProduct(' + i + ')">Edit</button>' +
                '<button class="btn btn-sm btn-danger" onclick="deleteProduct(' + i + ')">✕</button>' +
            '</div>' +
        '</div>';
    }).join('');
}

function editProduct(i) {
    var p = HELM_EDIT.products[i];
    var row = document.getElementById('prod-row-' + i);
    if (!row) return;
    row.innerHTML =
        '<div style="display:grid;grid-template-columns:1fr 80px;gap:6px;flex:1;">' +
            '<input type="text" id="pe-name-' + i + '" placeholder="Name" value="' + esc(p.name || '') + '">' +
            '<input type="text" id="pe-price-' + i + '" placeholder="Price" value="' + esc(p.price ? String(p.price) : '') + '">' +
            '<textarea id="pe-desc-' + i + '" rows="2" placeholder="Description" style="grid-column:1/-1;">' + esc(p.description || '') + '</textarea>' +
        '</div>' +
        '<div class="item-row-actions">' +
            '<button class="btn btn-sm btn-primary" onclick="saveProduct(' + i + ')">Save</button>' +
            '<button class="btn btn-sm btn-ghost" onclick="_renderProductsList()">Cancel</button>' +
        '</div>';
}

function saveProduct(i) {
    HELM_EDIT.products[i] = {
        name: document.getElementById('pe-name-' + i).value.trim(),
        price: document.getElementById('pe-price-' + i).value.trim() || null,
        description: document.getElementById('pe-desc-' + i).value.trim(),
    };
    _renderProductsList();
}

function deleteProduct(i) {
    HELM_EDIT.products.splice(i, 1);
    _renderProductsList();
}

function showAddProduct() {
    var el = document.getElementById('s-product-add-form');
    if (!el) return;
    el.style.display = 'block';
    el.innerHTML =
        '<div style="display:grid;grid-template-columns:1fr 80px;gap:6px;margin-top:8px;">' +
            '<input type="text" id="pa-name" placeholder="Product/service name *" style="grid-column:1/-1;">' +
            '<input type="text" id="pa-price" placeholder="Price">' +
            '<input type="text" id="pa-desc" placeholder="Short description">' +
        '</div>' +
        '<div style="display:flex;gap:6px;margin-top:6px;">' +
            '<button class="btn btn-sm btn-primary" onclick="addProduct()">Add</button>' +
            '<button class="btn btn-sm btn-ghost" onclick="document.getElementById(\'s-product-add-form\').style.display=\'none\'">Cancel</button>' +
        '</div>';
}

function addProduct() {
    var name = document.getElementById('pa-name').value.trim();
    if (!name) { showToast('Product name is required', 'error'); return; }
    HELM_EDIT.products.push({
        name: name,
        price: document.getElementById('pa-price').value.trim() || null,
        description: document.getElementById('pa-desc').value.trim(),
    });
    document.getElementById('s-product-add-form').style.display = 'none';
    _renderProductsList();
}

// ── Competitors ───────────────────────────────────────────────────────────────
function _renderCompetitorsList() {
    var el = document.getElementById('s-competitors-list');
    if (!el) return;
    if (HELM_EDIT.competitors.length === 0) {
        el.innerHTML = '<p style="color:var(--text-muted);font-size:13px;margin:0;">No competitors recorded yet.</p>';
        return;
    }
    el.innerHTML = HELM_EDIT.competitors.map(function(c, i) {
        return '<div class="item-row" id="comp-row-' + i + '">' +
            '<div class="item-row-info">' +
                '<strong>' + esc(c.name || '') + '</strong>' +
                (c.url ? ' <a href="' + esc(c.url) + '" target="_blank" style="color:var(--accent);font-size:12px;margin-left:6px;">visit ↗</a>' : '') +
                (c.notes ? '<div style="color:var(--text-muted);font-size:12px;margin-top:2px;">' + esc(c.notes) + '</div>' : '') +
            '</div>' +
            '<div class="item-row-actions">' +
                '<button class="btn btn-sm btn-ghost" onclick="editCompetitor(' + i + ')">Edit</button>' +
                '<button class="btn btn-sm btn-danger" onclick="deleteCompetitor(' + i + ')">✕</button>' +
            '</div>' +
        '</div>';
    }).join('');
}

function editCompetitor(i) {
    var c = HELM_EDIT.competitors[i];
    var row = document.getElementById('comp-row-' + i);
    if (!row) return;
    row.innerHTML =
        '<div style="display:flex;flex-direction:column;gap:4px;flex:1;">' +
            '<input type="text" id="ce-name-' + i + '" placeholder="Competitor name" value="' + esc(c.name || '') + '">' +
            '<input type="text" id="ce-url-' + i + '" placeholder="Website URL" value="' + esc(c.url || '') + '">' +
            '<input type="text" id="ce-notes-' + i + '" placeholder="Notes" value="' + esc(c.notes || '') + '">' +
        '</div>' +
        '<div class="item-row-actions">' +
            '<button class="btn btn-sm btn-primary" onclick="saveCompetitor(' + i + ')">Save</button>' +
            '<button class="btn btn-sm btn-ghost" onclick="_renderCompetitorsList()">Cancel</button>' +
        '</div>';
}

function saveCompetitor(i) {
    HELM_EDIT.competitors[i] = {
        name: document.getElementById('ce-name-' + i).value.trim(),
        url:  document.getElementById('ce-url-' + i).value.trim() || null,
        notes:document.getElementById('ce-notes-' + i).value.trim(),
    };
    _renderCompetitorsList();
}

function deleteCompetitor(i) {
    HELM_EDIT.competitors.splice(i, 1);
    _renderCompetitorsList();
}

function showAddCompetitor() {
    var el = document.getElementById('s-competitor-add-form');
    if (!el) return;
    el.style.display = 'block';
    el.innerHTML =
        '<div style="display:flex;flex-direction:column;gap:4px;margin-top:8px;">' +
            '<input type="text" id="ca-name" placeholder="Competitor name *">' +
            '<input type="text" id="ca-url" placeholder="Website URL">' +
            '<input type="text" id="ca-notes" placeholder="Notes">' +
        '</div>' +
        '<div style="display:flex;gap:6px;margin-top:6px;">' +
            '<button class="btn btn-sm btn-primary" onclick="addCompetitor()">Add</button>' +
            '<button class="btn btn-sm btn-ghost" onclick="document.getElementById(\'s-competitor-add-form\').style.display=\'none\'">Cancel</button>' +
        '</div>';
}

function addCompetitor() {
    var name = document.getElementById('ca-name').value.trim();
    if (!name) { showToast('Competitor name is required', 'error'); return; }
    HELM_EDIT.competitors.push({
        name: name,
        url:  document.getElementById('ca-url').value.trim() || null,
        notes:document.getElementById('ca-notes').value.trim(),
    });
    document.getElementById('s-competitor-add-form').style.display = 'none';
    _renderCompetitorsList();
}

// ── Social account / credential delete ───────────────────────────────────────
async function deleteSocialAccount(platform) {
    if (!confirm('Remove this social account connection?')) return;
    try {
        await bizApi('/social-accounts/' + platform, { method: 'DELETE' });
        showToast('Account removed', 'success');
        renderSettings();
    } catch (err) { showToast(err.message, 'error'); }
}

function showSetHandle(platform) {
    var row = document.getElementById('handle-row-' + platform);
    if (row) row.style.display = 'flex';
}

async function saveHandle(platform) {
    var inp = document.getElementById('handle-input-' + platform);
    var handle = inp ? inp.value.trim().replace(/^@/, '') : '';
    if (!handle) { showToast('Enter a handle first', 'error'); return; }
    try {
        await bizApi('/social-accounts/handle', {
            method: 'PATCH',
            body: JSON.stringify({ platform: platform, handle: handle }),
        });
        showToast('Handle saved', 'success');
        renderSettings();
    } catch (err) { showToast(err.message, 'error'); }
}

async function deleteCredential(credId) {
    if (!confirm('Remove this credential?')) return;
    try {
        await bizApi('/credentials/' + credId, { method: 'DELETE' });
        showToast('Credential removed', 'success');
        renderSettings();
    } catch (err) { showToast(err.message, 'error'); }
}

async function renderSettings() {
    var el = document.getElementById('view-settings');
    if (!HELM.currentBusiness) {
        el.innerHTML = '<p class="text-muted" style="padding:40px;text-align:center;">Select a business first.</p>';
        return;
    }
    el.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted);">Loading settings...</div>';

    var data;
    try {
        data = await apiFetch('/helm/api/businesses/' + HELM.currentBusiness.id + '/settings');
    } catch (err) {
        el.innerHTML = '<div style="padding:40px;text-align:center;color:var(--error);">Failed to load settings: ' + esc(err.message) + '</div>';
        return;
    }

    var biz = data.business || HELM.currentBusiness;
    var sd = data.step_data || {};
    var sdFields = {};
    if (Array.isArray(sd.fields)) {
        sd.fields.forEach(function(f) { sdFields[f.key] = f.value; });
    }
    function bv(key) { return biz[key] || sdFields[key] || ''; }

    var tone = biz.tone_of_voice || '';
    var toneOpts = ['professional','friendly','casual','authoritative','playful'];

    var socialRows = data.social_accounts || [];
    window._currentSocialRows = socialRows;  // expose for renderSocialPostSchedules()
    var credRows = data.credentials || [];
    var scheduleRows = data.schedules || [];

    // ── Connected Accounts section ────────────────────────────────────────────
    var socialHtml = '';
    if (socialRows.length > 0) {
        socialHtml = socialRows.map(function(s) {
            var statusDot = s.status === 'connected'
                ? '<span style="color:#22c55e;font-size:10px;">● connected</span>'
                : '<span style="color:#f59e0b;font-size:10px;">● credentials saved</span>';
            var handleHtml = s.handle
                ? ' <span style="color:var(--text-muted);">@' + esc(s.handle) + '</span>'
                : ' <span style="color:var(--text-faint);font-size:11px;">no handle set</span>';
            var setHandleRow = !s.handle
                ? '<div id="handle-row-' + esc(s.platform) + '" style="display:none;gap:6px;align-items:center;margin-top:6px;">' +
                    '<input id="handle-input-' + esc(s.platform) + '" type="text" placeholder="@yourhandle" style="flex:1;padding:4px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg-input);color:var(--text);font-size:12px;">' +
                    '<button class="btn btn-sm btn-primary" onclick="saveHandle(' + JSON.stringify(s.platform) + ')">Save</button>' +
                  '</div>'
                : '';
            return '<div class="item-row" style="flex-direction:column;align-items:stretch;">' +
                '<div style="display:flex;align-items:center;justify-content:space-between;">' +
                    '<div class="item-row-info">' +
                        '<strong style="text-transform:capitalize;">' + esc(s.platform) + '</strong>' +
                        handleHtml + ' ' + statusDot +
                        (s.followers_count ? ' <span style="color:var(--text-faint);font-size:12px;">· ' + s.followers_count.toLocaleString() + ' followers</span>' : '') +
                        (s.auto_post_enabled ? ' <span class="badge badge-success" style="font-size:10px;">auto-post on</span>' : '') +
                    '</div>' +
                    '<div class="item-row-actions">' +
                        (!s.handle ? '<button class="btn btn-sm" onclick="showSetHandle(' + JSON.stringify(s.platform) + ')">Set handle</button> ' : '') +
                        '<button class="btn btn-sm btn-danger" onclick="deleteSocialAccount(' + JSON.stringify(s.platform) + ')">Remove</button>' +
                    '</div>' +
                '</div>' +
                setHandleRow +
            '</div>';
        }).join('');
    } else {
        socialHtml = '<p style="color:var(--text-muted);font-size:13px;">No social accounts connected.</p>';
    }

    var credHtml = '';
    if (credRows.length > 0) {
        credHtml = credRows.map(function(c) {
            var verified = c.last_verified_at ? 'Last verified ' + timeAgo(c.last_verified_at) : 'Not yet verified';
            return '<div class="item-row">' +
                '<div class="item-row-info">' +
                    '<strong style="text-transform:capitalize;">' + esc(c.service) + '</strong>' +
                    ' <span style="color:var(--text-muted);font-size:12px;">' + esc(c.label || c.credential_type || '') + '</span>' +
                    '<div style="color:var(--text-faint);font-size:11px;">' + esc(verified) + '</div>' +
                '</div>' +
                '<div class="item-row-actions">' +
                    '<span style="color:var(--success);font-size:12px;">✓ Active</span>' +
                    '<button class="btn btn-sm btn-danger" onclick="deleteCredential(' + JSON.stringify(c.id) + ')">Remove</button>' +
                '</div>' +
            '</div>';
        }).join('');
    } else {
        credHtml = '<p style="color:var(--text-muted);font-size:13px;">No credentials stored.</p>';
    }

    var JOB_LABELS = {
        'content_generate':  'Content Generation',
        'report_weekly':     'Weekly Report',
        'stripe_sync':       'Stripe Sync',
        'site_health_check': 'Site Health Check',
        'hitl_expiry':       'HITL Expiry Check',
        'social_stats_sync': 'Social Stats Sync',
    };
    var JOB_DESC = {
        'content_generate':  'Generate new blog posts and content drafts for HITL review',
        'report_weekly':     'AI-written summary of content, social, and business performance',
        'stripe_sync':       'Pull revenue metrics from Stripe (requires Stripe credentials)',
        'site_health_check': 'Ping your WordPress and Netlify sites for uptime monitoring',
        'hitl_expiry':       'Auto-expire stale HITL items past their deadline',
        'social_stats_sync': 'Sync follower and engagement stats from social platforms',
    };
    var FREQ_PRESETS = [
        {label:'Every 15 min',   cron:'*/15 * * * *'},
        {label:'Every 30 min',   cron:'*/30 * * * *'},
        {label:'Every hour',     cron:'0 * * * *'},
        {label:'Every 2 hours',  cron:'0 */2 * * *'},
        {label:'Every 6 hours',  cron:'0 */6 * * *'},
        {label:'Daily at 2am',   cron:'0 2 * * *'},
        {label:'Daily at 6am',   cron:'0 6 * * *'},
        {label:'Daily at 9am',   cron:'0 9 * * *'},
        {label:'Weekly Mon 7am', cron:'0 7 * * 1'},
    ];
    function cronDesc(expr) {
        if (!expr) return '';
        var preset = FREQ_PRESETS.find(function(p) { return p.cron === expr.trim(); });
        if (preset) return preset.label;
        var parts = expr.trim().split(/\s+/);
        if (parts.length < 5) return expr;
        var min = parts[0], hr = parts[1], dom = parts[2], dow = parts[4];
        if (min === '0' && dom === '*' && dow === '*') return 'Daily at ' + hr + ':00 UTC';
        if (dow === '1' && min === '0') return 'Weekly Mon at ' + hr + ':00 UTC';
        if (dom === '1' && min === '0') return 'Monthly 1st at ' + hr + ':00 UTC';
        return expr;
    }
    var schedHtml = '';
    if (scheduleRows.length > 0) {
        schedHtml = '<div class="sched-grid">' + scheduleRows.map(function(s) {
            var label    = JOB_LABELS[s.job_type] || s.job_type.replace(/_/g,' ').replace(/\b\w/g, function(c){ return c.toUpperCase(); });
            var desc     = JOB_DESC[s.job_type] || '';
            var freq     = cronDesc(s.cron_expr);
            var nxt      = s.next_run_at ? timeAgo(s.next_run_at) : '--';
            var last     = s.last_run_at ? timeAgo(s.last_run_at) : 'never';
            var enabled  = s.enabled !== false;
            var runs     = s.run_count || 0;
            var fails    = s.fail_count || 0;
            var jt       = s.job_type;
            // Toggle switch HTML
            var toggleId = 'sched-toggle-' + jt;
            var toggleHtml =
                '<label class="sched-toggle" title="' + (enabled ? 'Disable' : 'Enable') + '">' +
                    '<input type="checkbox" id="' + toggleId + '"' + (enabled ? ' checked' : '') +
                        ' onchange="toggleSchedule(' + JSON.stringify(jt) + ', this.checked)">' +
                    '<span class="sched-toggle-track"></span>' +
                '</label>';
            // Frequency select dropdown
            var freqSelectHtml =
                '<select class="form-input sched-freq-select" onchange="setScheduleFreq(' + JSON.stringify(jt) + ', this.value)">' +
                FREQ_PRESETS.map(function(p) {
                    return '<option value="' + p.cron + '"' + (p.cron === s.cron_expr ? ' selected' : '') + '>' + p.label + '</option>';
                }).join('') +
                '</select>';
            return '<div class="sched-card' + (enabled ? '' : ' sched-card-disabled') + '" id="sched-card-' + jt + '">' +
                '<div class="sched-top">' +
                    '<div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;">' +
                        '<strong style="white-space:nowrap;">' + esc(label) + '</strong>' +
                        (desc ? '<span style="font-size:11px;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(desc) + '</span>' : '') +
                    '</div>' +
                    '<div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">' +
                        toggleHtml +
                        '<button class="btn btn-sm btn-ghost" onclick="triggerJobNow(' + JSON.stringify(jt) + ')" title="Run now">▶</button>' +
                    '</div>' +
                '</div>' +
                '<div class="sched-controls">' +
                    freqSelectHtml +
                '</div>' +
                '<div class="sched-meta" id="sched-meta-' + jt + '">' +
                    '<span class="sched-next">Next: ' + esc(nxt) + '</span>' +
                    '<span>Last: ' + esc(last) + '</span>' +
                    (runs ? '<span>' + runs + ' runs' + (fails ? ' · <span style="color:#f87171;">' + fails + ' failed</span>' : '') + '</span>' : '<span style="color:#64748b;">not run yet</span>') +
                '</div>' +
            '</div>';
        }).join('') + '</div>';
    } else {
        schedHtml = '<p style="color:var(--text-muted);font-size:13px;margin:0;">Loading schedules…</p>';
    }

    // ── Seed mutable edit state ──────────────────────────────────────────────
    var rawProducts = biz.products || sdFields.products;
    try { HELM_EDIT.products = Array.isArray(rawProducts) ? rawProducts : (rawProducts ? JSON.parse(rawProducts) : []); }
    catch(e) { HELM_EDIT.products = []; }

    var rawCompetitors = biz.competitors || sdFields.competitors;
    try { HELM_EDIT.competitors = Array.isArray(rawCompetitors) ? rawCompetitors : (rawCompetitors ? JSON.parse(rawCompetitors) : []); }
    catch(e) { HELM_EDIT.competitors = []; }

    el.innerHTML =
        '<div style="max-width:700px;margin:0 auto;width:100%;padding-bottom:60px;">' +

        // ── Business Identity ──────────────────────────────────────────────
        '<div class="settings-section">' +
            '<h3>Business Identity</h3>' +
            '<label>Business Name<input type="text" id="s-name" value="' + esc(biz.name || '') + '"></label>' +
            '<label>Tagline<input type="text" id="s-tagline" value="' + esc(biz.tagline || '') + '" placeholder="One-line description"></label>' +
            '<label>Industry<input type="text" id="s-industry" value="' + esc(biz.industry || '') + '"></label>' +
            '<label>Stage<select id="s-stage">' +
                ['idea','mvp','growth','established','scaling'].map(function(s) {
                    return '<option value="' + s + '"' + (biz.stage === s ? ' selected' : '') + '>' + s.charAt(0).toUpperCase() + s.slice(1) + '</option>';
                }).join('') +
            '</select></label>' +
            '<label>Website URL<input type="text" id="s-website" value="' + esc(biz.website || '') + '" placeholder="https://yourbusiness.com"></label>' +
            '<label>Description<textarea id="s-description" rows="3">' + esc(biz.description || '') + '</textarea></label>' +
            '<label>Value Proposition<textarea id="s-value-prop" rows="2" placeholder="What makes you different?">' + esc(biz.value_proposition || '') + '</textarea></label>' +
            '<label>Primary Goal<input type="text" id="s-primary-goal" value="' + esc(biz.primary_goal || '') + '" placeholder="e.g. Generate 50 leads/month"></label>' +
        '</div>' +

        // ── Brand Voice ───────────────────────────────────────────────────
        '<div class="settings-section">' +
            '<h3>Brand Voice</h3>' +
            '<label>Tone of Voice<select id="s-tone">' +
                toneOpts.map(function(t) {
                    return '<option value="' + t + '"' + (tone === t ? ' selected' : '') + '>' + t.charAt(0).toUpperCase() + t.slice(1) + '</option>';
                }).join('') +
            '</select></label>' +
            '<label>Brand Voice Notes<textarea id="s-brand-voice" rows="3" placeholder="Describe the personality, writing style, and communication approach...">' + esc(biz.brand_voice_notes || '') + '</textarea></label>' +
            '<label>Never Say (comma-separated)<input type="text" id="s-never-say" value="' + esc(Array.isArray(biz.never_say) ? biz.never_say.join(', ') : (biz.never_say || '')) + '" placeholder="e.g. cheap, discount, deal"></label>' +
            '<label>Primary Color' +
                '<div class="color-picker-row">' +
                    '<input type="color" id="s-color1" value="' + esc(biz.brand_color_primary || '#e11d48') + '">' +
                    '<input type="text" id="s-color1-text" value="' + esc(biz.brand_color_primary || '#e11d48') + '" oninput="document.getElementById(\'s-color1\').value=this.value">' +
                '</div>' +
            '</label>' +
        '</div>' +

        // ── Audience ─────────────────────────────────────────────────────
        '<div class="settings-section">' +
            '<h3>Target Audience</h3>' +
            '<label>Target Audience<textarea id="s-audience" rows="2" placeholder="Who are your ideal customers?">' + esc(biz.target_audience || '') + '</textarea></label>' +
            '<label>Pain Points<textarea id="s-pain-points" rows="2" placeholder="What problems do they face?">' + esc(biz.pain_points || '') + '</textarea></label>' +
            '<label>Revenue Model<input type="text" id="s-revenue-model" value="' + esc(biz.revenue_model || '') + '" placeholder="e.g. SaaS subscription, one-time purchase, retainer"></label>' +
        '</div>' +

        // ── Goals ────────────────────────────────────────────────────────
        '<div class="settings-section">' +
            '<h3>Goals</h3>' +
            '<label>3-Month Goals<textarea id="s-goals-3mo" rows="2" placeholder="What do you want to achieve in 90 days?">' + esc(biz.goals_3mo || '') + '</textarea></label>' +
            '<label>6-Month Goals<textarea id="s-goals-6mo" rows="2" placeholder="6-month milestones">' + esc(biz.goals_6mo || '') + '</textarea></label>' +
            '<label>12-Month Goals<textarea id="s-goals-12mo" rows="2" placeholder="Annual vision">' + esc(biz.goals_12mo || '') + '</textarea></label>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
                '<label>Monthly Revenue Target ($)<input type="number" id="s-rev-target" value="' + esc(String(biz.monthly_revenue_target || '')) + '" placeholder="5000"></label>' +
                '<label>Monthly Lead Target<input type="number" id="s-lead-target" value="' + esc(String(biz.monthly_lead_target || '')) + '" placeholder="50"></label>' +
            '</div>' +
        '</div>' +

        // ── Content Strategy ─────────────────────────────────────────────
        '<div class="settings-section">' +
            '<h3>Content Strategy</h3>' +
            '<label>Content Pillars<textarea id="s-content-pillars" rows="3" placeholder="List your content topics, one per line or comma-separated">' + esc(biz.content_pillars || '') + '</textarea></label>' +
            '<label>Topics to Avoid<textarea id="s-avoid-topics" rows="2" placeholder="Topics HELM should never cover">' + esc(biz.avoid_topics || '') + '</textarea></label>' +
        '</div>' +

        // ── Autonomy ─────────────────────────────────────────────────────
        '<div class="settings-section">' +
            '<h3>Autonomy &amp; Control</h3>' +
            '<p style="font-size:13px;color:var(--text-muted);margin-bottom:8px;">Controls how much HELM does without asking. 1 = ask for everything, 10 = full autopilot.</p>' +
            '<input type="range" id="s-autonomy" min="1" max="10" value="' + (biz.autonomy_level || 8) + '" oninput="document.getElementById(\'s-autonomy-val\').textContent=this.value">' +
            '<div class="range-labels"><span>1 - Ask First</span><span id="s-autonomy-val">' + (biz.autonomy_level || 8) + '</span><span>10 - Full Auto</span></div>' +
        '</div>' +

        // ── Products/Services ─────────────────────────────────────────────
        '<div class="settings-section">' +
            '<div class="section-header-row">' +
                '<h3>Products &amp; Services</h3>' +
                '<button class="btn btn-sm btn-ghost" onclick="showAddProduct()">+ Add</button>' +
            '</div>' +
            '<div id="s-products-list"></div>' +
            '<div id="s-product-add-form" style="display:none;"></div>' +
        '</div>' +

        // ── Competitors ───────────────────────────────────────────────────
        '<div class="settings-section">' +
            '<div class="section-header-row">' +
                '<h3>Competitors</h3>' +
                '<button class="btn btn-sm btn-ghost" onclick="showAddCompetitor()">+ Add</button>' +
            '</div>' +
            '<div id="s-competitors-list"></div>' +
            '<div id="s-competitor-add-form" style="display:none;"></div>' +
        '</div>' +

        // ── Connected Accounts ────────────────────────────────────────────
        '<div class="settings-section">' +
            '<h3>Connected Social Accounts</h3>' +
            socialHtml +
        '</div>' +

        '<div class="settings-section">' +
            '<h3>Stored Credentials</h3>' +
            credHtml +
        '</div>' +

        // ── WordPress Connections ──────────────────────────────────────────
        '<div class="settings-section">' +
            '<h3>WordPress Connections</h3>' +
            '<p style="color:#94a3b8;font-size:13px;margin:0 0 12px;">Connect WordPress sites to push approved content directly as posts.</p>' +
            '<div id="wp-connections-list"><div class="loading-spinner" style="margin:0"></div></div>' +
            '<div id="wp-add-form" style="display:none;margin-top:12px;">' +
                '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">' +
                    '<div><label class="form-label">Site Name</label><input id="wp-site-name" class="form-input" placeholder="My WordPress Site"></div>' +
                    '<div><label class="form-label">Site URL</label><input id="wp-site-url" class="form-input" placeholder="https://example.com"></div>' +
                    '<div><label class="form-label">Username</label><input id="wp-username" class="form-input" placeholder="admin"></div>' +
                    '<div><label class="form-label">Application Password</label><input id="wp-app-password" class="form-input" type="password" placeholder="xxxx xxxx xxxx xxxx xxxx xxxx"></div>' +
                    '<div><label class="form-label">Default Post Status</label>' +
                        '<select id="wp-default-status" class="form-input">' +
                            '<option value="draft">Draft</option>' +
                            '<option value="pending">Pending Review</option>' +
                            '<option value="publish">Publish Immediately</option>' +
                        '</select>' +
                    '</div>' +
                '</div>' +
                '<div style="display:flex;gap:8px;">' +
                    '<button class="btn btn-primary" onclick="saveWPConnection()">Save Connection</button>' +
                    '<button class="btn btn-secondary" onclick="cancelWPAdd()">Cancel</button>' +
                '</div>' +
            '</div>' +
            '<button class="btn btn-secondary" id="wp-add-btn" onclick="showWPAddForm()" style="margin-top:10px;">+ Add WordPress Site</button>' +
        '</div>' +

        // ── GitHub Connections ───────────────────────────────────────────
        '<div class="settings-section">' +
            '<h3>GitHub Connections</h3>' +
            '<p style="color:#94a3b8;font-size:13px;margin:0 0 12px;">Connect a GitHub repo to push approved content as Markdown files — Netlify auto-deploys on commit.</p>' +
            '<div id="netlify-connections-list"><div class="loading-spinner" style="margin:0"></div></div>' +
            '<div id="netlify-add-form" style="display:none;margin-top:12px;">' +
                '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">' +
                    '<div><label class="form-label">Site Name</label><input id="nl-site-name" class="form-input" placeholder="My Netlify Site"></div>' +
                    '<div><label class="form-label">GitHub Repo (owner/repo)</label><input id="nl-github-repo" class="form-input" placeholder="boutabyte/boutacare"></div>' +
                    '<div><label class="form-label">Branch</label><input id="nl-github-branch" class="form-input" placeholder="main" value="main"></div>' +
                    '<div><label class="form-label">Content Path</label><input id="nl-content-path" class="form-input" placeholder="content/posts" value="content/posts"></div>' +
                    '<div style="grid-column:1/-1;"><label class="form-label">GitHub Personal Access Token (repo write scope)</label><input id="nl-github-token" class="form-input" type="password" placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"></div>' +
                '</div>' +
                '<div style="display:flex;gap:8px;">' +
                    '<button class="btn btn-primary" onclick="saveNetlifyConnection()">Save Connection</button>' +
                    '<button class="btn btn-secondary" onclick="cancelNetlifyAdd()">Cancel</button>' +
                '</div>' +
            '</div>' +
            '<button class="btn btn-secondary" id="netlify-add-btn" onclick="showNetlifyAddForm()" style="margin-top:10px;">+ Add Netlify Site</button>' +
        '</div>' +

        // ── Schedules ─────────────────────────────────────────────────────
        '<div class="settings-section">' +
            '<h3>Automation Schedules</h3>' +
            schedHtml +
            '<h4 style="margin:20px 0 10px;color:var(--text-muted);font-size:13px;text-transform:uppercase;letter-spacing:.05em;">Social Post Schedules</h4>' +
            '<p style="font-size:12px;color:var(--text-muted);margin:0 0 12px;">Schedule automated posts to your connected social accounts. HELM generates and queues content for each scheduled run.</p>' +
            '<div id="social-post-schedules"><div class="loading-spinner" style="margin:0;"></div></div>' +
        '</div>' +

        // ── Actions ───────────────────────────────────────────────────────
        '<div style="display:flex;gap:10px;">' +
            '<button class="btn btn-primary" onclick="saveSettings()">Save Settings</button>' +
            '<button class="btn btn-danger" onclick="confirmDeleteBusiness()">Delete Business</button>' +
        '</div>' +

        '</div>';

    // Sync color picker ↔ text input
    var colorInput = document.getElementById('s-color1');
    if (colorInput) {
        colorInput.addEventListener('input', function() {
            document.getElementById('s-color1-text').value = this.value;
        });
    }

    // Render managed lists
    _renderProductsList();
    _renderCompetitorsList();
    loadWPConnections();
    loadNetlifyConnections();
    loadSocialPostSchedule();
}

async function saveSettings() {
    try {
        var payload = {
            name:               document.getElementById('s-name').value.trim(),
            tagline:            document.getElementById('s-tagline').value.trim(),
            industry:           document.getElementById('s-industry').value.trim(),
            stage:              document.getElementById('s-stage').value,
            website:            document.getElementById('s-website').value.trim(),
            description:        document.getElementById('s-description').value.trim(),
            value_proposition:  document.getElementById('s-value-prop').value.trim(),
            primary_goal:       document.getElementById('s-primary-goal').value.trim(),
            tone_of_voice:      document.getElementById('s-tone').value,
            brand_voice_notes:  document.getElementById('s-brand-voice').value.trim(),
            never_say:          document.getElementById('s-never-say').value.trim().split(',').map(function(s){ return s.trim(); }).filter(Boolean),
            brand_color_primary:document.getElementById('s-color1').value,
            target_audience:    document.getElementById('s-audience').value.trim(),
            pain_points:        document.getElementById('s-pain-points').value.trim(),
            revenue_model:      document.getElementById('s-revenue-model').value.trim(),
            goals_3mo:          document.getElementById('s-goals-3mo').value.trim(),
            goals_6mo:          document.getElementById('s-goals-6mo').value.trim(),
            goals_12mo:         document.getElementById('s-goals-12mo').value.trim(),
            content_pillars:    document.getElementById('s-content-pillars').value.trim(),
            avoid_topics:       document.getElementById('s-avoid-topics').value.trim(),
            autonomy_level:     parseInt(document.getElementById('s-autonomy').value, 10),
        };
        var revTarget = document.getElementById('s-rev-target').value.trim();
        var leadTarget = document.getElementById('s-lead-target').value.trim();
        if (revTarget) payload.monthly_revenue_target = parseFloat(revTarget);
        if (leadTarget) payload.monthly_lead_target = parseInt(leadTarget, 10);

        // Include managed JSON arrays
        payload.products    = HELM_EDIT.products;
        payload.competitors = HELM_EDIT.competitors;

        // Remove empty strings so they don't overwrite existing data with blanks
        Object.keys(payload).forEach(function(k) {
            if (payload[k] === '' || payload[k] === null) delete payload[k];
        });

        var updated = await apiFetch(
            '/helm/api/businesses/' + HELM.currentBusiness.id + '/settings',
            { method: 'PATCH', body: payload }
        );
        Object.assign(HELM.currentBusiness, updated);
        renderBusinessHeader();
        renderBusinessSelector(HELM.businesses);
        showToast('Settings saved', 'success');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function triggerJobNow(jobType) {
    try {
        await bizApi('/schedule/' + jobType + '/trigger', { method: 'POST' });
        showToast('Job queued — switching to Activity Log…', 'success');
        // Switch to actions tab so user can watch the job run
        showTab('actions');
        // Auto-refresh actions after ~70s (one scheduler tick + job execution)
        setTimeout(function() {
            if (typeof renderActions === 'function') {
                renderActions();
                showToast('Activity log refreshed', 'success');
            }
        }, 70000);
    } catch (err) {
        showToast('Trigger failed: ' + err.message, 'error');
    }
}

async function confirmDeleteBusiness() {
    if (!confirm('Are you sure you want to delete "' + HELM.currentBusiness.name + '"? This cannot be undone.')) return;
    try {
        await bizApi('', { method: 'DELETE' });
        HELM.businesses = HELM.businesses.filter(function(b) { return b.id !== HELM.currentBusiness.id; });
        HELM.currentBusiness = null;
        showToast('Business deleted', 'success');
        if (HELM.businesses.length > 0) {
            selectBusiness(HELM.businesses[0]);
        } else {
            document.getElementById('tab-nav').classList.add('hidden');
            document.getElementById('business-header').classList.add('hidden');
            renderBusinessSelector([]);
            showTab('welcome');
            renderWelcome();
        }
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// ── WordPress Connection Management ──────────────────────────────────────────
var _wpConnections = [];

async function loadWPConnections() {
    var list = document.getElementById('wp-connections-list');
    if (!list) return;
    try {
        _wpConnections = await bizApi('/wp-connections');
        if (!_wpConnections.length) {
            list.innerHTML = '<p style="color:#64748b;font-size:13px;margin:0;">No WordPress sites connected yet.</p>';
            return;
        }
        list.innerHTML = _wpConnections.map(function(conn) {
            var statusDot = conn.last_test_ok === true
                ? '<span style="color:#22c55e;">●</span>'
                : conn.last_test_ok === false
                    ? '<span style="color:#ef4444;">●</span>'
                    : '<span style="color:#64748b;">●</span>';
            var testedAt = conn.last_tested_at
                ? new Date(conn.last_tested_at).toLocaleDateString()
                : 'never tested';
            return '<div class="settings-item" style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #1e293b;">' +
                '<div style="flex:1;">' +
                    '<div style="font-weight:600;color:#e2e8f0;">' + statusDot + ' ' + _esc(conn.site_name) + '</div>' +
                    '<div style="font-size:12px;color:#64748b;">' + _esc(conn.site_url) + ' · default: ' + conn.default_status + ' · ' + testedAt + '</div>' +
                '</div>' +
                '<button class="btn btn-secondary btn-sm" onclick="testWPConnection(\'' + conn.id + '\')">Test</button>' +
                '<button class="btn btn-danger btn-sm" onclick="deleteWPConnection(\'' + conn.id + '\')">Remove</button>' +
            '</div>';
        }).join('');
    } catch (err) {
        list.innerHTML = '<p style="color:#ef4444;font-size:13px;margin:0;">Failed to load connections.</p>';
    }
}

function showWPAddForm() {
    document.getElementById('wp-add-form').style.display = 'block';
    document.getElementById('wp-add-btn').style.display = 'none';
}

function cancelWPAdd() {
    document.getElementById('wp-add-form').style.display = 'none';
    document.getElementById('wp-add-btn').style.display = '';
    ['wp-site-name','wp-site-url','wp-username','wp-app-password'].forEach(function(id) {
        document.getElementById(id).value = '';
    });
    document.getElementById('wp-default-status').value = 'draft';
}

async function saveWPConnection() {
    var payload = {
        site_name:      (document.getElementById('wp-site-name').value || 'WordPress Site').trim(),
        site_url:       document.getElementById('wp-site-url').value.trim(),
        username:       document.getElementById('wp-username').value.trim(),
        app_password:   document.getElementById('wp-app-password').value.trim(),
        default_status: document.getElementById('wp-default-status').value,
    };
    if (!payload.site_url || !payload.username || !payload.app_password) {
        showToast('Site URL, username, and app password are required', 'error'); return;
    }
    try {
        await bizApi('/wp-connections', { method: 'POST', body: payload });
        showToast('WordPress connection saved', 'success');
        cancelWPAdd();
        await loadWPConnections();
    } catch (err) {
        showToast('Save failed: ' + err.message, 'error');
    }
}

async function testWPConnection(connId) {
    showToast('Testing connection…', 'success');
    try {
        var r = await bizApi('/wp-connections/' + connId + '/test', { method: 'POST' });
        if (r.ok) {
            showToast('Connection OK — logged in as ' + (r.user || 'unknown'), 'success');
        } else {
            showToast('Connection failed: ' + (r.error || 'Unknown error'), 'error');
        }
        await loadWPConnections();
    } catch (err) {
        showToast('Test error: ' + err.message, 'error');
    }
}

async function deleteWPConnection(connId) {
    if (!confirm('Remove this WordPress connection?')) return;
    try {
        await bizApi('/wp-connections/' + connId, { method: 'DELETE' });
        showToast('Connection removed', 'success');
        await loadWPConnections();
    } catch (err) {
        showToast('Delete failed: ' + err.message, 'error');
    }
}

function _esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Schedule Management ───────────────────────────────────────────────────────
async function toggleSchedule(jobType, enabled) {
    try {
        await bizApi('/schedules/' + jobType, {
            method: 'PATCH',
            body: { enabled: enabled },
        });
        // Visual feedback — toggle card opacity
        var card = document.getElementById('sched-card-' + jobType);
        if (card) card.classList.toggle('sched-card-disabled', !enabled);
        showToast((enabled ? 'Enabled' : 'Disabled') + ': ' + jobType.replace(/_/g,' '), 'success');
    } catch (err) {
        showToast('Update failed: ' + err.message, 'error');
        // Revert checkbox
        var chk = document.getElementById('sched-toggle-' + jobType);
        if (chk) chk.checked = !enabled;
    }
}

async function setScheduleFreq(jobType, cronExpr) {
    try {
        var result = await bizApi('/schedules/' + jobType, {
            method: 'PATCH',
            body: { cron_expr: cronExpr },
        });
        showToast('Schedule updated', 'success');
        // Update the "Next:" display in the card without full re-render
        var meta = document.getElementById('sched-meta-' + jobType);
        if (meta && result && result.next_run_at) {
            var nextSpan = meta.querySelector('.sched-next');
            if (nextSpan) nextSpan.textContent = 'Next: ' + timeAgo(result.next_run_at);
        }
    } catch (err) {
        showToast('Update failed: ' + err.message, 'error');
    }
}

// ── Social Post Schedule Management ──────────────────────────────────────────
var _socialPostConfig = { platforms: [] };

async function loadSocialPostSchedule() {
    try {
        var result = await bizApi('/schedules/social-post');
        _socialPostConfig = (result && result.config) || { platforms: [] };
        if (!Array.isArray(_socialPostConfig.platforms)) _socialPostConfig.platforms = [];
    } catch (err) {
        _socialPostConfig = { platforms: [] };
    }
    renderSocialPostSchedules();
}

function renderSocialPostSchedules() {
    var el = document.getElementById('social-post-schedules');
    if (!el) return;
    var socialRows = window._currentSocialRows || [];
    if (!socialRows.length) {
        el.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">No social accounts connected. Add accounts in the Connected Social Accounts section above.</p>';
        return;
    }
    var FREQ_PRESETS = [
        {label:'Every hour',     cron:'0 * * * *'},
        {label:'Every 2 hours',  cron:'0 */2 * * *'},
        {label:'Every 6 hours',  cron:'0 */6 * * *'},
        {label:'Daily at 8am',   cron:'0 8 * * *'},
        {label:'Daily at 9am',   cron:'0 9 * * *'},
        {label:'Daily at 12pm',  cron:'0 12 * * *'},
        {label:'2x Daily',       cron:'0 9,18 * * *'},
        {label:'Weekly Mon 9am', cron:'0 9 * * 1'},
    ];
    el.innerHTML = socialRows.map(function(s) {
        var platform = s.platform;
        var pConfig = (_socialPostConfig.platforms || []).find(function(p) { return p.platform === platform; });
        var hasSchedule = !!pConfig;
        var enabled = pConfig ? pConfig.enabled !== false : false;
        var cronExpr = pConfig ? pConfig.cron_expr : '0 9 * * *';
        var freqOpts = FREQ_PRESETS.map(function(p) {
            return '<option value="' + p.cron + '"' + (p.cron === cronExpr ? ' selected' : '') + '>' + p.label + '</option>';
        }).join('');
        return '<div class="sched-card' + (!hasSchedule ? ' sched-card-disabled' : '') + '" id="social-sched-card-' + platform + '" style="margin-bottom:10px;">' +
            '<div class="sched-top">' +
                '<div style="display:flex;align-items:center;gap:8px;flex:1;">' +
                    '<strong style="text-transform:capitalize;">' + platform + '</strong>' +
                    (s.handle ? '<span style="font-size:12px;color:var(--text-muted);">@' + _esc(s.handle) + '</span>' : '') +
                    (hasSchedule ? '<span class="badge badge-success" style="font-size:10px;">scheduled</span>' : '<span style="font-size:11px;color:var(--text-muted);">no schedule</span>') +
                '</div>' +
                '<div style="display:flex;align-items:center;gap:6px;">' +
                    (hasSchedule ? (
                        '<label class="sched-toggle">' +
                            '<input type="checkbox" ' + (enabled ? 'checked' : '') + ' onchange="toggleSocialPostSchedule(' + JSON.stringify(platform) + ', this.checked)">' +
                            '<span class="sched-toggle-track"></span>' +
                        '</label>' +
                        '<button class="btn btn-sm btn-danger" onclick="deleteSocialPostSchedule(' + JSON.stringify(platform) + ')">Remove</button>'
                    ) : (
                        '<button class="btn btn-sm btn-primary" onclick="showSocialPostAdd(' + JSON.stringify(platform) + ')">+ Schedule</button>'
                    )) +
                '</div>' +
            '</div>' +
            (hasSchedule ? (
                '<div class="sched-controls">' +
                    '<select class="form-input sched-freq-select" onchange="setSocialPostFreq(' + JSON.stringify(platform) + ', this.value)">' + freqOpts + '</select>' +
                '</div>'
            ) : '') +
            '<div id="social-post-add-' + platform + '" style="display:none;margin-top:8px;padding:8px;border:1px solid var(--border);border-radius:6px;">' +
                '<label style="font-size:12px;">Post frequency:' +
                    '<select id="social-post-freq-' + platform + '" class="form-input" style="margin-top:4px;">' +
                    FREQ_PRESETS.map(function(p) { return '<option value="' + p.cron + '">' + p.label + '</option>'; }).join('') +
                    '</select>' +
                '</label>' +
                '<div style="display:flex;gap:6px;margin-top:8px;">' +
                    '<button class="btn btn-sm btn-primary" onclick="createSocialPostSchedule(' + JSON.stringify(platform) + ')">Create Schedule</button>' +
                    '<button class="btn btn-sm" onclick="document.getElementById(\'social-post-add-' + platform + '\').style.display=\'none\'">Cancel</button>' +
                '</div>' +
            '</div>' +
        '</div>';
    }).join('');
}

function showSocialPostAdd(platform) {
    var el = document.getElementById('social-post-add-' + platform);
    if (el) el.style.display = 'block';
}

async function createSocialPostSchedule(platform) {
    var freqEl = document.getElementById('social-post-freq-' + platform);
    var cronExpr = freqEl ? freqEl.value : '0 9 * * *';
    _socialPostConfig.platforms = (_socialPostConfig.platforms || []).filter(function(p) { return p.platform !== platform; });
    _socialPostConfig.platforms.push({ platform: platform, cron_expr: cronExpr, enabled: true });
    await _saveSocialPostConfig();
}

async function deleteSocialPostSchedule(platform) {
    _socialPostConfig.platforms = (_socialPostConfig.platforms || []).filter(function(p) { return p.platform !== platform; });
    await _saveSocialPostConfig();
}

async function toggleSocialPostSchedule(platform, enabled) {
    var entry = (_socialPostConfig.platforms || []).find(function(p) { return p.platform === platform; });
    if (entry) { entry.enabled = enabled; await _saveSocialPostConfig(); }
}

async function setSocialPostFreq(platform, cronExpr) {
    var entry = (_socialPostConfig.platforms || []).find(function(p) { return p.platform === platform; });
    if (entry) { entry.cron_expr = cronExpr; await _saveSocialPostConfig(); }
}

async function _saveSocialPostConfig() {
    try {
        await bizApi('/schedules/social-post', {
            method: 'PUT',
            body: { config: _socialPostConfig },
        });
        showToast('Social post schedule saved', 'success');
        renderSocialPostSchedules();
    } catch (err) {
        showToast('Failed to save: ' + err.message, 'error');
    }
}

// ── Netlify / GitHub Connection Management ────────────────────────────────────
var _netlifyConnections = [];

async function loadNetlifyConnections() {
    var list = document.getElementById('netlify-connections-list');
    if (!list) return;
    try {
        _netlifyConnections = await bizApi('/netlify-connections');
        if (!_netlifyConnections.length) {
            list.innerHTML = '<p style="color:#64748b;font-size:13px;margin:0;">No Netlify sites connected yet.</p>';
            return;
        }
        list.innerHTML = _netlifyConnections.map(function(conn) {
            var statusDot = conn.last_test_ok === true
                ? '<span style="color:#22c55e;">●</span>'
                : conn.last_test_ok === false
                    ? '<span style="color:#ef4444;">●</span>'
                    : '<span style="color:#64748b;">●</span>';
            var testedAt = conn.last_tested_at
                ? new Date(conn.last_tested_at).toLocaleDateString()
                : 'never tested';
            return '<div class="settings-item" style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #1e293b;">' +
                '<div style="flex:1;">' +
                    '<div style="font-weight:600;color:#e2e8f0;">' + statusDot + ' ' + _esc(conn.site_name) + '</div>' +
                    '<div style="font-size:12px;color:#64748b;">' + _esc(conn.github_repo) + ' @ ' + _esc(conn.github_branch) + ' → ' + _esc(conn.content_path) + ' · ' + testedAt + '</div>' +
                '</div>' +
                '<button class="btn btn-secondary btn-sm" onclick="testNetlifyConnection(\'' + conn.id + '\')">Test</button>' +
                '<button class="btn btn-danger btn-sm" onclick="deleteNetlifyConnection(\'' + conn.id + '\')">Remove</button>' +
            '</div>';
        }).join('');
    } catch (err) {
        list.innerHTML = '<p style="color:#ef4444;font-size:13px;margin:0;">Failed to load connections.</p>';
    }
}

function showNetlifyAddForm() {
    document.getElementById('netlify-add-form').style.display = 'block';
    document.getElementById('netlify-add-btn').style.display = 'none';
}

function cancelNetlifyAdd() {
    document.getElementById('netlify-add-form').style.display = 'none';
    document.getElementById('netlify-add-btn').style.display = '';
    ['nl-site-name','nl-github-repo','nl-github-token'].forEach(function(id) {
        document.getElementById(id).value = '';
    });
    document.getElementById('nl-github-branch').value = 'main';
    document.getElementById('nl-content-path').value = 'content/posts';
}

async function saveNetlifyConnection() {
    var payload = {
        site_name:     (document.getElementById('nl-site-name').value || 'Netlify Site').trim(),
        github_repo:   document.getElementById('nl-github-repo').value.trim(),
        github_branch: (document.getElementById('nl-github-branch').value || 'main').trim(),
        github_token:  document.getElementById('nl-github-token').value.trim(),
        content_path:  (document.getElementById('nl-content-path').value || 'content/posts').trim(),
    };
    if (!payload.github_repo || !payload.github_token) {
        showToast('GitHub repo and token are required', 'error'); return;
    }
    if (!payload.github_repo.includes('/')) {
        showToast('Repo must be in owner/repo format (e.g. boutabyte/boutacare)', 'error'); return;
    }
    try {
        await bizApi('/netlify-connections', { method: 'POST', body: payload });
        showToast('Netlify connection saved', 'success');
        cancelNetlifyAdd();
        await loadNetlifyConnections();
    } catch (err) {
        showToast('Save failed: ' + err.message, 'error');
    }
}

async function testNetlifyConnection(connId) {
    showToast('Testing GitHub connection…', 'success');
    try {
        var r = await bizApi('/netlify-connections/' + connId + '/test', { method: 'POST' });
        if (r.ok) {
            showToast('Connected to ' + (r.repo || 'repo') + (r.private ? ' (private)' : ' (public)'), 'success');
        } else {
            showToast('Connection failed: ' + (r.error || 'Unknown error'), 'error');
        }
        await loadNetlifyConnections();
    } catch (err) {
        showToast('Test error: ' + err.message, 'error');
    }
}

async function deleteNetlifyConnection(connId) {
    if (!confirm('Remove this Netlify connection?')) return;
    try {
        await bizApi('/netlify-connections/' + connId, { method: 'DELETE' });
        showToast('Connection removed', 'success');
        await loadNetlifyConnections();
    } catch (err) {
        showToast('Delete failed: ' + err.message, 'error');
    }
}

// ── Keyboard Shortcuts ───────────────────────────────────────────────────────
document.addEventListener('keydown', function(e) {
    // Ctrl+H = open HITL tab
    if (e.ctrlKey && e.key === 'h') {
        e.preventDefault();
        if (HELM.currentBusiness) {
            showTab('hitl');
        }
    }
});

// ── Init App ─────────────────────────────────────────────────────────────────
async function initApp() {
    try {
        // Load Supabase config
        var configResp = await fetch('/helm/api/auth/config');
        var config = await configResp.json();
        HELM.supabase = window.supabase.createClient(config.supabase_url, config.supabase_anon_key);

        // Check auth
        var sessionResult = await HELM.supabase.auth.getSession();
        var session = sessionResult.data.session;
        if (!session) {
            window.location.href = '/auth/login?redirect=' + encodeURIComponent('/helm/');
            return;
        }

        HELM.user = session.user;
        HELM.token = session.access_token;

        // Display user
        var userDisplay = document.getElementById('user-display');
        userDisplay.textContent = HELM.user.email;

        // Listen for auth changes
        HELM.supabase.auth.onAuthStateChange(function(event, session) {
            if (event === 'SIGNED_OUT' || !session) {
                window.location.href = '/auth/login?redirect=' + encodeURIComponent('/helm/');
            } else {
                HELM.token = session.access_token;
            }
        });

        // Load businesses (active + any pending onboarding)
        var _pendingOnboarding = [];
        try {
            var data = await apiFetch('/helm/api/businesses');
            HELM.businesses = data.businesses || data || [];
            _pendingOnboarding = data.pending_onboarding || [];
        } catch (err) {
            HELM.businesses = [];
        }

        // Show app
        hideLoading();
        document.getElementById('app').classList.remove('hidden');

        // ── Stripe return from website builder checkout ──────────────────────
        var _urlP = new URLSearchParams(window.location.search);
        var _wsSession = _urlP.get('ws_session');
        var _obParam = _urlP.get('ob');
        if (_wsSession && _obParam && HELM.businesses.length > 0) {
            renderBusinessSelector(HELM.businesses);
            HELM.currentBusiness = HELM.businesses[0];
            renderBusinessHeader();
            onboardingState.onboardingId = _obParam;
            onboardingState.step = 4;
            setTabMode('onboarding');
            showTab('onboarding');

        // ── Resume pending onboarding (page refresh mid-flow) ────────────────
        } else if (_pendingOnboarding.length > 0 && HELM.businesses.length === 0) {
            // No active business yet — automatically resume the pending onboarding
            resumeOnboardingFromDB(_pendingOnboarding[0]);

        } else if (_pendingOnboarding.length > 0 && HELM.businesses.length > 0) {
            // Has active businesses AND a pending one — show dashboard, banner to resume
            renderBusinessSelector(HELM.businesses);
            selectBusiness(HELM.businesses[0]);
            var _pob = _pendingOnboarding[0];
            showToast(
                '\u26A0\uFE0F Unfinished onboarding for "' + _pob.business_name + '" — click to resume',
                'info',
                12000,
                function() { resumeOnboardingFromDB(_pob); }
            );

        } else if (HELM.businesses.length > 0) {
            renderBusinessSelector(HELM.businesses);
            selectBusiness(HELM.businesses[0]);

        } else {
            renderWelcome();
            showTab('welcome');
        }

    } catch (err) {
        hideLoading();
        document.getElementById('app').classList.remove('hidden');
        showToast('Failed to initialize: ' + err.message, 'error');
        renderWelcome();
        showTab('welcome');
    }
}

// ── Resume In-Progress Onboarding ────────────────────────────────────────────
async function resumeOnboardingFromDB(pending) {
    // pending = {business_id, business_name, onboarding_id, current_step, step_data}
    var stepToResume = pending.current_step || 1;

    // Seed onboarding state
    onboardingState.businessId   = pending.business_id;
    onboardingState.onboardingId = pending.onboarding_id;
    onboardingState.step         = stepToResume;

    // For step 2/3 we need parsedFields — re-fetch from backend
    if (stepToResume === 2 || stepToResume === 3) {
        try {
            var parseData = await apiFetch('/helm/api/onboarding/' + pending.onboarding_id + '/parse');
            onboardingState.parsedFields = parseData.fields || [];
        } catch (e) {
            // If parse re-fetch fails, drop back to step 1 so user can re-upload
            onboardingState.step = 1;
        }
    }

    // For form-mode onboarding the step_data.form holds the original inputs
    var sd = pending.step_data || {};
    var formData = sd.form || {};
    if (formData.name) onboardingState.data = Object.assign({}, formData);

    // Update selector (active businesses only in header)
    renderBusinessSelector(HELM.businesses);
    setTabMode('onboarding');
    showTab('onboarding');
    renderOnboarding();

    showToast(
        'Resuming your onboarding for "' + pending.business_name + '" — step ' + onboardingState.step + ' of ' + onboardingState.totalSteps,
        'success'
    );
}

// Boot
document.addEventListener('DOMContentLoaded', initApp);
