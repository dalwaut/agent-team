/**
 * OPAI Agent Orchestra — Core: auth, state, navigation, data, tooltips.
 * API calls route to /agents/api/* (Agent Studio backend, same auth).
 */

const AGENTS_API = '/agents/api';
let token = null;
let currentUser = null;

// ── Terminology Map (Orchestra → Technical) ───────────────────
const TERM_MAP = {
    'score':              { tech: 'Prompt Content',        desc: 'The instructions given to this agent when it runs. Written in natural language.' },
    'programme-note':     { tech: 'Description',           desc: 'A short summary of what this musician does in the ensemble.' },
    'musician-initials':  { tech: 'Agent Emoji / Badge',   desc: 'A short 2–3 character identifier badge shown on the musician\'s seat.' },
    'instrument-grade':   { tech: 'Model',                 desc: 'Which Claude model powers this agent. Higher grades handle more complex, nuanced tasks.' },
    'max-bars':           { tech: 'Max Turns',             desc: 'Maximum agentic turns before the agent stops. Set to 0 for unlimited.' },
    'solo-mode':          { tech: 'Skip Project Context',  desc: 'When on, skips loading CLAUDE.md + MEMORY.md (~3,500 tokens saved per turn). Useful for fast, focused tasks.' },
    'when-they-play':     { tech: 'Run Order',             desc: 'When in the performance sequence this musician plays relative to others.' },
    'intro':              { tech: 'run_order: first',      desc: 'Plays before the main movement. Use for setup or familiarization tasks.' },
    'main-movement':      { tech: 'run_order: parallel',   desc: 'Plays concurrently alongside other main-movement musicians (up to 4 at once).' },
    'coda':               { tech: 'run_order: last',       desc: 'Plays after all main-movement musicians finish. Use for consolidation or dispatching.' },
    'cued-by':            { tech: 'Depends On',            desc: 'This musician waits for a cue from these agents before their report is considered.' },
    'programme':          { tech: 'Squad',                 desc: 'A named group of musicians that perform together in a coordinated run.' },
    'musician':           { tech: 'Agent',                 desc: 'An AI specialist that performs a defined analysis or execution role.' },
    'section':            { tech: 'Category',              desc: 'The instrument family this musician belongs to, grouping similar specializations.' },
    'perform-now':        { tech: 'Run Squad',             desc: 'Execute all musicians in this programme via the Claude CLI.' },
    'rehearse':           { tech: 'Preview Execution',     desc: 'Preview the execution order and dependencies without running.' },
    'concert-hall':       { tech: 'Run History',           desc: 'Past performances and their generated reports.' },
    'concert-calendar':   { tech: 'Scheduler',             desc: 'Automated recurring performances triggered on a cron schedule.' },
    'symphony-movements': { tech: 'Workflows',             desc: 'Multi-programme pipelines where completing one triggers the next.' },
    'composition-studio': { tech: 'Agent Flow Editor',     desc: 'Visual canvas for designing agent pipelines by connecting musicians.' },
    'haiku':              { tech: 'Claude Haiku',          desc: 'Fastest, most cost-efficient. Best for simple, focused tasks.' },
    'sonnet':             { tech: 'Claude Sonnet',         desc: 'Balanced performance. Best for most analysis and coding tasks.' },
    'opus':               { tech: 'Claude Opus',           desc: 'Most capable. Best for complex reasoning and deep analysis.' },
    'inherit':            { tech: 'System Default',        desc: 'Uses the model configured in config/orchestrator.json.' },
};

// ── State ─────────────────────────────────────────────────────
const State = {
    agents:        [],
    squads:        [],
    categories:    [],
    activeRuns:    [],
    currentView:   'orchestra',
    currentSection: null,    // squad id
    currentMusician: null,   // agent id
    liveInterval:  null,
};

// ── Section Definitions (Orchestra Metaphor) ──────────────────
const SECTION_DEFS = {
    leadership:    { name: 'Conductor',         instrument: '🎼', color: '#ef4444' },
    quality:       { name: 'Strings',           instrument: '🎻', color: '#10b981' },
    planning:      { name: 'Woodwinds',         instrument: '🎵', color: '#3b82f6' },
    research:      { name: 'Brass',             instrument: '🎺', color: '#f59e0b' },
    security:      { name: 'Security Ensemble', instrument: '🛡️', color: '#dc2626' },
    operations:    { name: 'Percussion',        instrument: '🥁', color: '#8b5cf6' },
    content:       { name: 'Keyboards',         instrument: '🎹', color: '#ec4899' },
    execution:     { name: 'Timpani',           instrument: '⚡', color: '#06b6d4' },
    meta:          { name: 'Harp',              instrument: '🔮', color: '#94a3b8' },
    orchestration: { name: 'Organ',             instrument: '🔔', color: '#f97316' },
};

function getSectionDef(category) {
    return SECTION_DEFS[category] || { name: category, instrument: '🎵', color: '#8c7c6a' };
}

// ── Auth ──────────────────────────────────────────────────────
async function initAuth() {
    const resp = await fetch('/orchestra/api/auth/config');
    const cfg = await resp.json();
    if (!cfg.supabase_url) {
        document.getElementById('loading-screen').textContent = 'Auth not configured';
        return false;
    }
    const sb = window.supabase.createClient(cfg.supabase_url, cfg.supabase_anon_key);
    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
        window.location.href = '/auth/login';
        return false;
    }
    const role = session.user.app_metadata?.role || 'user';
    if (role !== 'admin') {
        try {
            const ar = await fetch('/api/me/apps', { headers: { 'Authorization': 'Bearer ' + session.access_token } });
            if (ar.ok) {
                const ad = await ar.json();
                if (!(ad.allowed_apps || []).includes('agents')) {
                    window.location.href = '/';
                    return false;
                }
            }
        } catch(e) { /* allow on fetch failure */ }
    }

    token = session.access_token;
    sb.auth.onAuthStateChange((_ev, sess) => { if (sess) token = sess.access_token; });

    const user = session.user;
    currentUser = {
        id: user.id,
        email: user.email,
        name: user.user_metadata?.display_name || user.email.split('@')[0],
        role: role,
        isAdmin: role === 'admin',
    };
    document.getElementById('user-display').textContent =
        currentUser.name + (currentUser.isAdmin ? ' (admin)' : '');
    return true;
}

function authHeaders() {
    return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
}

async function apiFetch(path, opts = {}) {
    opts.headers = { ...authHeaders(), ...(opts.headers || {}) };
    const resp = await fetch(AGENTS_API + path, opts);
    if (resp.status === 401) { window.location.href = '/auth/login'; throw new Error('Unauthorized'); }
    if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.detail || 'Error ' + resp.status);
    }
    return resp.json();
}

// ── Toast ─────────────────────────────────────────────────────
function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    document.getElementById('toast-container').appendChild(el);
    setTimeout(() => el.remove(), 3800);
}

// ── Tooltip System ────────────────────────────────────────────
const Tooltip = (() => {
    let el = null;

    function init() {
        el = document.getElementById('orch-tooltip');
        document.addEventListener('mousemove', onMove);

        // Wire up all .term-info triggers (ℹ icons on form labels)
        document.addEventListener('mouseover', onTermOver);
        document.addEventListener('mouseout', onTermOut);
    }

    function onMove(e) {
        if (!el || el.classList.contains('hidden')) return;
        const x = e.clientX + 14;
        const y = e.clientY + 14;
        const rect = el.getBoundingClientRect();
        el.style.left = Math.min(x, window.innerWidth - rect.width - 10) + 'px';
        el.style.top = Math.min(y, window.innerHeight - rect.height - 10) + 'px';
    }

    function onTermOver(e) {
        const trigger = e.target.closest('[data-term]');
        if (!trigger) return;
        show(trigger.dataset.term);
    }

    function onTermOut(e) {
        if (!e.target.closest('[data-term]')) return;
        hide();
    }

    function show(termKey) {
        const term = TERM_MAP[termKey];
        if (!term || !el) return;
        el.innerHTML =
            '<div class="ot-orch-name">' + esc(termKey.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())) + '</div>' +
            '<div class="ot-tech-name"><span class="ot-tech-label">Studio term:</span> ' + esc(term.tech) + '</div>' +
            '<div class="ot-desc">' + esc(term.desc) + '</div>';
        el.classList.remove('hidden');
    }

    function hide() {
        if (el) el.classList.add('hidden');
    }

    return { init, show, hide };
})();

// ── Navigation ────────────────────────────────────────────────
function navigateTo(view, params = {}) {
    State.currentView = view;

    // Hide all views
    document.querySelectorAll('.orch-view').forEach(v => v.classList.add('hidden'));

    // Update panel nav active state
    document.querySelectorAll('.panel-btn').forEach(b => b.classList.remove('active'));

    const panels = ['concert-hall', 'calendar', 'symphony', 'composition'];
    if (panels.includes(view)) {
        document.querySelector('.panel-btn[data-panel="' + view + '"]')?.classList.add('active');
    }

    // Show target view
    const viewEl = document.getElementById('view-' + view);
    if (viewEl) viewEl.classList.remove('hidden');

    // Handle composition full-height
    document.body.classList.toggle('comp-active', view === 'composition');

    // Update state
    if (params.sectionId !== undefined) State.currentSection = params.sectionId;
    if (params.musicianId !== undefined) State.currentMusician = params.musicianId;

    // Render breadcrumb
    renderBreadcrumb();

    // Call render function for the view
    switch(view) {
        case 'orchestra':   OrchestraPit.render(); break;
        case 'section':     SectionView.render(State.currentSection); break;
        case 'musician':    MusicianView.render(State.currentMusician); break;
        case 'concert-hall': ConcertHall.render(); break;
        case 'calendar':    CalendarView.render(); break;
        case 'symphony':    SymphonyView.render(); break;
        case 'composition': CompositionStudio.render(params); break;
    }
}

function renderBreadcrumb() {
    const bc = document.getElementById('breadcrumb');
    const parts = [];

    const orchNav = '<span class="bc-item" data-nav="orchestra" onclick="navigateTo(\'orchestra\')">Full Orchestra</span>';

    if (State.currentView === 'orchestra') {
        parts.push('<span class="bc-item bc-active">Full Orchestra</span>');
    } else if (State.currentView === 'section') {
        const squad = State.squads.find(s => s.id === State.currentSection);
        parts.push(orchNav);
        parts.push('<span class="bc-sep">›</span>');
        parts.push('<span class="bc-item bc-active">' + esc(squad?.id || 'Section') + '</span>');
    } else if (State.currentView === 'musician') {
        const agent = State.agents.find(a => a.id === State.currentMusician);
        const squad = State.squads.find(s => s.id === State.currentSection);
        parts.push(orchNav);
        if (squad) {
            parts.push('<span class="bc-sep">›</span>');
            parts.push('<span class="bc-item" onclick="navigateTo(\'section\', {sectionId:\'' + esc(squad.id) + '\'})">' + esc(squad.id) + '</span>');
        }
        parts.push('<span class="bc-sep">›</span>');
        parts.push('<span class="bc-item bc-active">' + esc(agent?.name || 'Musician') + '</span>');
    } else {
        parts.push(orchNav);
    }

    bc.innerHTML = parts.join('');
}

// ── Data Loading ──────────────────────────────────────────────
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
    } catch(e) {
        toast('Failed to load ensemble data: ' + e.message, 'error');
    }
}

async function refreshActiveRuns() {
    try {
        const resp = await apiFetch('/runs/active');
        State.activeRuns = resp.runs || [];
    } catch(e) { /* silent */ }
}

// ── Programme (Squad) Modal ───────────────────────────────────
function openProgrammeModal() {
    document.getElementById('programme-modal').classList.remove('hidden');
    document.getElementById('prog-id').focus();
}
function closeProgrammeModal() {
    document.getElementById('programme-modal').classList.add('hidden');
    document.getElementById('programme-form').reset();
}
document.getElementById?.('programme-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('prog-id').value.trim();
    const desc = document.getElementById('prog-desc').value.trim();
    try {
        await apiFetch('/squads', {
            method: 'POST',
            body: JSON.stringify({ id, description: desc, agents: [] }),
        });
        toast('Programme "' + id + '" created', 'success');
        await loadAll();
        closeProgrammeModal();
        navigateTo('section', { sectionId: id });
    } catch(e) {
        toast(e.message, 'error');
    }
});

// ── Confirm Dialog ────────────────────────────────────────────
let _confirmResolve = null;
function showConfirm(title, msg, okLabel = 'Confirm') {
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-msg').textContent = msg;
    document.getElementById('confirm-ok-btn').textContent = okLabel;
    document.getElementById('confirm-modal').classList.remove('hidden');
    return new Promise(res => { _confirmResolve = res; });
}
function confirmResolve(val) {
    document.getElementById('confirm-modal').classList.add('hidden');
    if (_confirmResolve) { _confirmResolve(val); _confirmResolve = null; }
}

// ── Helper ────────────────────────────────────────────────────
function esc(s) {
    if (!s) return '';
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function catColor(cat) {
    return SECTION_DEFS[cat]?.color || '#8c7c6a';
}

function fmtDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

// ── Live Run Polling ──────────────────────────────────────────
function startLivePoll() {
    if (State.liveInterval) return;
    State.liveInterval = setInterval(async () => {
        await refreshActiveRuns();
        if (State.currentView === 'orchestra') OrchestraPit.updateLive();
        if (State.currentView === 'concert-hall') ConcertHall.renderActive();
    }, 4000);
}

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    const ok = await initAuth();
    if (!ok) return;

    await loadAll();
    await refreshActiveRuns();

    // Wire panel nav buttons
    document.querySelectorAll('.panel-btn').forEach(btn => {
        btn.addEventListener('click', () => navigateTo(btn.dataset.panel));
    });

    // Wire header action buttons
    document.getElementById('new-musician-btn')?.addEventListener('click', () => {
        MusicianView.openCreateModal();
    });
    document.getElementById('new-programme-btn')?.addEventListener('click', openProgrammeModal);

    // Wire programme form (deferred because it wasn't in DOM when above ran)
    document.getElementById('programme-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('prog-id').value.trim();
        const desc = document.getElementById('prog-desc').value.trim();
        try {
            await apiFetch('/squads', {
                method: 'POST',
                body: JSON.stringify({ id, description: desc, agents: [] }),
            });
            toast('Programme "' + id + '" created', 'success');
            await loadAll();
            closeProgrammeModal();
            navigateTo('section', { sectionId: id });
        } catch(e) { toast(e.message, 'error'); }
    });

    // Init tooltip system
    Tooltip.init();

    // Render initial view
    navigateTo('orchestra');

    // Hide loading, show app
    document.getElementById('loading-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');

    // Start live polling
    startLivePoll();
});
