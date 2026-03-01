/**
 * OPAI Agent Studio — Main app logic, auth, router, shared utilities.
 */

const API_BASE = '/agents/api';
let token = null;
let currentUser = null;

// ── State ────────────────────────────────────────────

const State = {
    agents: [],
    squads: [],
    categories: [],
    runOrders: [],
};

// ── Auth ─────────────────────────────────────────────

async function initAuth() {
    const resp = await fetch('/agents/api/auth/config');
    const cfg = await resp.json();
    if (!cfg.supabase_url || !cfg.supabase_anon_key) {
        document.getElementById('loading-screen').textContent = 'Auth not configured';
        return false;
    }
    const sb = window.supabase.createClient(cfg.supabase_url, cfg.supabase_anon_key);
    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
        window.location.href = '/auth/login';
        return false;
    }
    // Check app access
    const role = session.user.app_metadata?.role || 'user';
    if (role !== 'admin') {
        try {
            const ar = await fetch('/api/me/apps', { headers: { 'Authorization': 'Bearer ' + session.access_token } });
            if (ar.ok) {
                const ad = await ar.json();
                if (!(ad.allowed_apps || []).includes('agents')) { window.location.href = '/'; return false; }
            }
        } catch (e) { /* allow on failure */ }
    }

    token = session.access_token;
    sb.auth.onAuthStateChange((_ev, sess) => { if (sess) token = sess.access_token; });

    const user = session.user;
    currentUser = {
        id: user.id,
        email: user.email,
        name: user.user_metadata?.display_name || user.email.split('@')[0],
        role: user.app_metadata?.role || 'user',
        isAdmin: role === 'admin',
    };
    document.getElementById('user-display').textContent =
        currentUser.name + (currentUser.isAdmin ? ' (admin)' : '');
    return true;
}

function authHeaders() {
    return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
}

async function apiFetch(url, opts = {}) {
    opts.headers = { ...opts.headers, ...authHeaders() };
    const resp = await fetch(API_BASE + url, opts);
    if (resp.status === 401) { window.location.href = '/auth/login'; throw new Error('Unauthorized'); }
    if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.detail || 'Error ' + resp.status);
    }
    return resp.json();
}

// ── Toast ────────────────────────────────────────────

function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    document.getElementById('toast-container').appendChild(el);
    setTimeout(() => el.remove(), 3500);
}

// ── Router ───────────────────────────────────────────

let currentView = 'dashboard';

function switchView(view) {
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.getElementById('view-' + view)?.classList.remove('hidden');
    document.querySelector('.tab[data-view="' + view + '"]')?.classList.add('active');
    currentView = view;
    window.location.hash = view;
    // Toggle full-width + fixed-viewport layout for flow editor
    const main = document.querySelector('.as-main');
    const appVisible = !document.getElementById('app').classList.contains('hidden');
    if (view === 'flow') {
        main.classList.add('flow-active');
        if (appVisible) document.body.classList.add('flow-layout');
        FlowEditor.render();
    } else {
        main.classList.remove('flow-active');
        document.body.classList.remove('flow-layout');
    }
}

function initRouter() {
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => switchView(tab.dataset.view));
    });
    const hash = window.location.hash.slice(1);
    if (hash && document.getElementById('view-' + hash)) {
        switchView(hash);
    }
}

// ── Data Loading ─────────────────────────────────────

async function loadAll() {
    try {
        const [agentsResp, squadsResp, catResp] = await Promise.all([
            apiFetch('/agents'),
            apiFetch('/squads'),
            apiFetch('/meta/categories'),
        ]);
        State.agents = agentsResp.agents || [];
        State.squads = squadsResp.squads || [];
        State.categories = catResp.categories || [];
    } catch (e) {
        toast('Failed to load data: ' + e.message, 'error');
    }
}

function renderDashboard() {
    const cats = {};
    State.agents.forEach(a => { cats[a.category] = (cats[a.category] || 0) + 1; });
    const topCat = Object.entries(cats).sort((a, b) => b[1] - a[1])[0];

    document.getElementById('overview-cards').innerHTML = [
        card('Agents', State.agents.length, 'Specialist roles defined'),
        card('Squads', State.squads.length, 'Execution groups'),
        card('Categories', Object.keys(cats).length, topCat ? 'Top: ' + topCat[0] : ''),
        card('Run Modes', '3', 'parallel / first / last'),
    ].join('');

    const grid = document.getElementById('dashboard-squads');
    if (!State.squads.length) {
        grid.innerHTML = '<p class="text-muted">No squads defined yet.</p>';
        return;
    }
    grid.innerHTML = State.squads.map(s => {
        const chips = s.agents.map(a =>
            '<span class="agent-chip"><span class="chip-emoji">' + esc(a.emoji || '?') + '</span>' + esc(a.name) + '</span>'
        ).join('');
        return '<div class="squad-card"><h3>' + esc(s.id) + '</h3><div class="desc">' + esc(s.description) + '</div><div class="agent-chips">' + chips + '</div></div>';
    }).join('');
}

function card(label, value, sub) {
    return '<div class="overview-card"><div class="card-label">' + label + '</div><div class="card-value">' + value + '</div><div class="card-sub">' + sub + '</div></div>';
}

// ── Helpers ──────────────────────────────────────────

function esc(s) {
    if (!s) return '';
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

// ── Init ─────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    const ok = await initAuth();
    if (!ok) return;
    initRouter();
    await loadAll();
    renderDashboard();
    Agents.render();
    Squads.render();
    Runs.render();
    Scheduler.render();
    Workflows.render();
    FlowEditor.init();
    document.getElementById('loading-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    // Apply flow layout now that app is visible (deferred from initRouter)
    if (currentView === 'flow') document.body.classList.add('flow-layout');
    Guide.init();
});
