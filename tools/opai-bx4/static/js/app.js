/**
 * Bx4 -- BoutaByte Business Bot -- Core App Bootstrap
 * Auth, state, navigation, API helpers, company switching.
 */

'use strict';

// ── Global State ─────────────────────────────────────────────────────────────
window.BX4 = {
    token: null,
    user: null,
    supabase: null,
    companies: [],
    currentCompany: null,
    currentView: 'dashboard',
    isAdmin: false
};

// ── Utility: HTML escaping ───────────────────────────────────────────────────
function esc(str) {
    if (str == null) return '';
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
}

// ── Utility: Format currency ─────────────────────────────────────────────────
function fmtCurrency(val, compact) {
    if (val == null || isNaN(val)) return '--';
    const n = Number(val);
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
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateTime(dateStr) {
    if (!dateStr) return '--';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
           d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// ── Utility: Relative time ───────────────────────────────────────────────────
function timeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ago';
    const days = Math.floor(hours / 24);
    return days + 'd ago';
}

// ── Utility: Urgency badge ───────────────────────────────────────────────────
function urgencyBadge(urgency) {
    const map = { critical: 'badge-critical', high: 'badge-high', medium: 'badge-medium', low: 'badge-low' };
    const cls = map[(urgency || '').toLowerCase()] || 'badge-low';
    return '<span class="badge ' + cls + '">' + esc(urgency || 'low') + '</span>';
}

// ── Utility: Financial impact badge ──────────────────────────────────────────
function impactBadge(impact) {
    if (!impact) return '';
    const val = String(impact).toLowerCase();
    let cls = 'impact-neutral';
    if (val.includes('positive') || val.includes('save') || val.includes('+')) cls = 'impact-positive';
    else if (val.includes('negative') || val.includes('cost') || val.includes('-')) cls = 'impact-negative';
    return '<span class="impact-badge ' + cls + '">' + esc(impact) + '</span>';
}

// ── Utility: Score color class ───────────────────────────────────────────────
function scoreClass(score) {
    if (score == null) return '';
    if (score >= 70) return 'score-green';
    if (score >= 40) return 'score-amber';
    return 'score-red';
}

function gradeClass(grade) {
    if (!grade) return '';
    const g = grade.toUpperCase().charAt(0);
    if (g === 'A') return 'grade-a';
    if (g === 'B') return 'grade-b';
    if (g === 'C') return 'grade-c';
    if (g === 'D') return 'grade-d';
    return 'grade-f';
}

function fillClass(score) {
    if (score == null) return 'fill-amber';
    if (score >= 70) return 'fill-green';
    if (score >= 40) return 'fill-amber';
    return 'fill-red';
}

// ── Toast Notifications ──────────────────────────────────────────────────────
function showToast(msg, type) {
    type = type || 'info';
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(function() {
        toast.classList.add('toast-fade-out');
        setTimeout(function() { toast.remove(); }, 300);
    }, 4000);
}

// ── Collapsible Sections ─────────────────────────────────────────────────────
function toggleCollapsible(headerEl) {
    headerEl.classList.toggle('open');
    const body = headerEl.nextElementSibling;
    if (body) body.classList.toggle('open');
}

// ── API Helper ───────────────────────────────────────────────────────────────
async function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign({}, opts.headers || {});
    if (window.BX4.token) {
        headers['Authorization'] = 'Bearer ' + window.BX4.token;
    }
    if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(opts.body);
    }
    opts.headers = headers;

    const resp = await fetch(path, opts);
    if (resp.status === 401) {
        window.location.href = '/auth/login?redirect=' + encodeURIComponent('/bx4/');
        throw new Error('Unauthorized');
    }
    if (!resp.ok) {
        let errMsg = 'API error: ' + resp.status;
        try {
            const errBody = await resp.json();
            if (errBody.detail) errMsg = errBody.detail;
            else if (errBody.error) errMsg = errBody.error;
        } catch (_) { /* ignore parse error */ }
        throw new Error(errMsg);
    }
    if (resp.status === 204) return null;
    return resp.json();
}

// ── Company API shorthand ────────────────────────────────────────────────────
function companyApi(subpath, opts) {
    if (!window.BX4.currentCompany) {
        return Promise.reject(new Error('No company selected'));
    }
    return api('/bx4/api/companies/' + window.BX4.currentCompany.id + subpath, opts);
}

// ── Navigation ───────────────────────────────────────────────────────────────
const VIEW_MAP = {
    dashboard:  'initDashboard',
    financial:  'initFinancial',
    market:     'initMarket',
    social:     'initSocial',
    operations: 'initOperations',
    advisor:    'initAdvisor',
    briefings:  'initBriefings',
    portfolio:  'initPortfolio',
    settings:   'initSettings'
};

function renderView(name) {
    if (!VIEW_MAP[name]) name = 'dashboard';
    window.BX4.currentView = name;

    // Update nav active state
    document.querySelectorAll('.nav-item').forEach(function(el) {
        el.classList.toggle('active', el.dataset.view === name);
    });

    // Clear view root
    var root = document.getElementById('view-root');
    root.innerHTML = '<div class="flex-center" style="padding:60px;"><div class="spinner spinner-lg"></div></div>';

    // Call view init
    var fnName = VIEW_MAP[name];
    if (typeof window[fnName] === 'function') {
        window[fnName]();
    } else {
        root.innerHTML = '<div class="empty-state"><span class="empty-state-icon">&#x1F6A7;</span>' +
            '<div class="empty-state-title">Coming Soon</div>' +
            '<div class="empty-state-msg">This view is under development.</div></div>';
    }

    // Save to localStorage
    try { localStorage.setItem('bx4_view', name); } catch(_) {}

    // Close mobile sidebar
    document.getElementById('sidebar').classList.remove('open');
}

// ── Company Switcher ─────────────────────────────────────────────────────────
function populateCompanySwitcher() {
    var select = document.getElementById('company-select');
    select.innerHTML = '';
    if (window.BX4.companies.length === 0) {
        select.innerHTML = '<option value="">-- No companies --</option>';
        return;
    }
    window.BX4.companies.forEach(function(c) {
        var opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        if (window.BX4.currentCompany && window.BX4.currentCompany.id === c.id) {
            opt.selected = true;
        }
        select.appendChild(opt);
    });
}

function selectCompany(id) {
    var co = window.BX4.companies.find(function(c) { return c.id === id; });
    if (!co) return;
    window.BX4.currentCompany = co;
    try { localStorage.setItem('bx4_company', co.id); } catch(_) {}

    // Check triage mode
    var banner = document.getElementById('triage-banner');
    if (co.triage_mode) {
        banner.classList.remove('hidden');
    } else {
        banner.classList.add('hidden');
    }

    // Re-render current view
    renderView(window.BX4.currentView);
}

// ── Add Company Modal ────────────────────────────────────────────────────────
function openAddCompanyModal() {
    document.getElementById('add-company-modal').classList.remove('hidden');
    document.getElementById('new-company-name').focus();
}

function closeAddCompanyModal() {
    document.getElementById('add-company-modal').classList.add('hidden');
    document.getElementById('add-company-form').reset();
}
// Expose globally
window.closeAddCompanyModal = closeAddCompanyModal;

// ── Init Flow ────────────────────────────────────────────────────────────────
(async function boot() {
    var loadingOverlay = document.getElementById('loading-overlay');
    var appEl = document.getElementById('app');

    try {
        // 1. Fetch auth config
        var cfgResp = await fetch('/bx4/api/auth/config');
        if (!cfgResp.ok) throw new Error('Failed to fetch auth config');
        var cfg = await cfgResp.json();

        if (!cfg.supabase_url || !cfg.supabase_anon_key) {
            throw new Error('Auth not configured');
        }

        // 2. Init Supabase
        window.BX4.supabase = window.supabase.createClient(cfg.supabase_url, cfg.supabase_anon_key);

        // 3. Get session
        var sessionResult = await window.BX4.supabase.auth.getSession();
        var session = sessionResult.data.session;
        if (!session) {
            window.location.href = '/auth/login?redirect=' + encodeURIComponent('/bx4/');
            return;
        }

        window.BX4.token = session.access_token;
        window.BX4.user = session.user;

        // 4. Check admin role
        var meta = session.user.app_metadata || {};
        window.BX4.isAdmin = meta.role === 'admin';

        // Show/hide admin controls
        if (window.BX4.isAdmin) {
            document.querySelectorAll('.nav-admin-only').forEach(function(el) { el.style.display = ''; });
        } else {
            var addBtn = document.getElementById('add-company-btn');
            if (addBtn) addBtn.classList.add('hidden');
        }

        // 5. Show user display name
        var displayName = session.user.user_metadata?.full_name ||
                          session.user.user_metadata?.name ||
                          session.user.email || 'User';
        document.getElementById('user-display').textContent = displayName;

        // 6. Load companies
        try {
            var companiesData = await api('/bx4/api/companies');
            window.BX4.companies = companiesData.companies || companiesData || [];
        } catch (e) {
            console.warn('Failed to load companies:', e);
            window.BX4.companies = [];
        }

        // 7. Handle no companies
        if (window.BX4.companies.length === 0) {
            loadingOverlay.classList.add('hidden');
            appEl.classList.remove('hidden');
            populateCompanySwitcher();
            var root = document.getElementById('view-root');
            root.innerHTML =
                '<div class="empty-state">' +
                '<span class="empty-state-icon">&#x1F3E2;</span>' +
                '<div class="empty-state-title">No Companies Yet</div>' +
                '<div class="empty-state-msg">Add your first company to get started with Bx4.</div>' +
                '<button class="btn btn-primary" onclick="openAddCompanyModal()">+ Add Your First Company</button>' +
                '</div>';
            setupEventListeners();
            return;
        }

        // 8. Select company (from localStorage or first)
        var savedCompanyId = null;
        try { savedCompanyId = localStorage.getItem('bx4_company'); } catch(_) {}
        var selectedCompany = window.BX4.companies.find(function(c) { return c.id === savedCompanyId; });
        if (!selectedCompany) selectedCompany = window.BX4.companies[0];
        window.BX4.currentCompany = selectedCompany;

        // Check triage mode
        if (selectedCompany.triage_mode) {
            document.getElementById('triage-banner').classList.remove('hidden');
        }

        populateCompanySwitcher();

        // 9. Determine initial view
        var savedView = null;
        try { savedView = localStorage.getItem('bx4_view'); } catch(_) {}
        var initialView = (savedView && VIEW_MAP[savedView]) ? savedView : 'dashboard';

        // 10. Show app, render dashboard
        loadingOverlay.classList.add('hidden');
        appEl.classList.remove('hidden');
        renderView(initialView);

        // 11. Setup event listeners
        setupEventListeners();

        // 12. Listen for auth state changes
        window.BX4.supabase.auth.onAuthStateChange(function(event, session) {
            if (event === 'SIGNED_OUT' || !session) {
                window.location.href = '/auth/login?redirect=' + encodeURIComponent('/bx4/');
            }
            if (session) {
                window.BX4.token = session.access_token;
            }
        });

    } catch (err) {
        console.error('Bx4 boot error:', err);
        loadingOverlay.innerHTML =
            '<div class="loading-content">' +
            '<div class="loading-icon" style="color:var(--danger);">!</div>' +
            '<div class="loading-sub" style="color:var(--danger);">' + esc(err.message) + '</div>' +
            '<button class="btn btn-outline" style="margin-top:16px;" onclick="location.reload()">Retry</button>' +
            '</div>';
    }
})();

// ── Event Listeners ──────────────────────────────────────────────────────────
function setupEventListeners() {
    // Sidebar nav
    document.querySelectorAll('.nav-item').forEach(function(item) {
        item.addEventListener('click', function() {
            renderView(this.dataset.view);
        });
    });

    // Company switcher
    document.getElementById('company-select').addEventListener('change', function() {
        if (this.value) selectCompany(this.value);
    });

    // Add company button
    var addBtn = document.getElementById('add-company-btn');
    if (addBtn) {
        addBtn.addEventListener('click', openAddCompanyModal);
    }

    // Add company form
    document.getElementById('add-company-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        var name = document.getElementById('new-company-name').value.trim();
        var industry = document.getElementById('new-company-industry').value.trim();
        var stage = document.getElementById('new-company-stage').value;
        if (!name) return;

        try {
            var result = await api('/bx4/api/companies', {
                method: 'POST',
                body: { name: name, industry: industry || null, stage: stage }
            });
            var newCompany = result.company || result;
            window.BX4.companies.push(newCompany);
            window.BX4.currentCompany = newCompany;
            populateCompanySwitcher();
            closeAddCompanyModal();
            showToast('Company created: ' + name, 'success');
            renderView('dashboard');
        } catch (err) {
            showToast('Failed to create company: ' + err.message, 'error');
        }
    });

    // Sidebar toggle (mobile)
    document.getElementById('sidebar-toggle').addEventListener('click', function() {
        document.getElementById('sidebar').classList.toggle('open');
    });

    // Close sidebar on main content click (mobile)
    document.querySelector('.main-content').addEventListener('click', function() {
        document.getElementById('sidebar').classList.remove('open');
    });

    // Close modal on overlay click
    document.querySelectorAll('.modal-overlay').forEach(function(overlay) {
        overlay.addEventListener('click', function(e) {
            if (e.target === overlay) {
                overlay.classList.add('hidden');
            }
        });
    });
}
