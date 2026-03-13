/**
 * Eliza Hub — app.js
 * Init, auth, tab switching, fetchAPI wrapper, toast system.
 */

const EZ = {
  supabase: null,
  user: null,
  authDisabled: false,
  currentTab: 'overview',
  agents: [],
  API: (window.location.pathname.startsWith('/eliza-hub') ? '/eliza-hub' : '') + '/api',
};

// ── Init ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await initAuth();
  initTabs();
  loadOverview();
  startPolling();
});

// ── Auth ───────────────────────────────────────────────────
async function initAuth() {
  try {
    const cfg = await fetch(`${EZ.API}/auth/config`).then(r => r.json());
    EZ.authDisabled = cfg.auth_disabled;
    if (cfg.supabase_url && cfg.supabase_anon_key) {
      EZ.supabase = window.supabase.createClient(cfg.supabase_url, cfg.supabase_anon_key);
      if (!EZ.authDisabled) {
        const { data } = await EZ.supabase.auth.getSession();
        if (!data?.session) {
          window.location.href = '/login.html?redirect=/eliza-hub/';
          return;
        }
        EZ.user = data.session.user;
      }
    }
  } catch (e) {
    console.warn('[auth] Failed:', e.message);
  }
}

// ── Fetch Wrapper ──────────────────────────────────────────
async function fetchAPI(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  if (EZ.supabase && !EZ.authDisabled) {
    const { data } = await EZ.supabase.auth.getSession();
    if (data?.session?.access_token) {
      headers['Authorization'] = `Bearer ${data.session.access_token}`;
    }
  }
  const resp = await fetch(`${EZ.API}${path}`, { ...opts, headers });
  if (!resp.ok) {
    const err = await resp.text().catch(() => 'Unknown error');
    throw new Error(`${resp.status}: ${err}`);
  }
  return resp.json();
}

// ── Tab Switching ──────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.ez-nav-item').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(tab) {
  EZ.currentTab = tab;

  // Update nav
  document.querySelectorAll('.ez-nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));

  // Update panels
  document.querySelectorAll('.ez-tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));

  // Update header
  const labels = { overview: 'Overview', agents: 'Agents', knowledge: 'Knowledge', audit: 'Audit', settings: 'Settings' };
  document.getElementById('breadcrumb').textContent = labels[tab] || tab;

  // Show/hide add agent button
  document.getElementById('btn-add-agent').style.display = tab === 'agents' ? '' : 'none';

  // Load tab data
  switch (tab) {
    case 'overview': loadOverview(); break;
    case 'agents': if (typeof loadAgents === 'function') loadAgents(); break;
    case 'knowledge': if (typeof loadKnowledge === 'function') loadKnowledge(); break;
    case 'audit': if (typeof loadAudit === 'function') loadAudit(); break;
    case 'settings': if (typeof loadSettings === 'function') loadSettings(); break;
  }
}

// ── Overview Tab ───────────────────────────────────────────
async function loadOverview() {
  try {
    const [agentsData, runtimeData, statsData] = await Promise.all([
      fetchAPI('/agents').catch(() => ({ agents: [] })),
      fetchAPI('/agents/runtime/status').catch(() => null),
      fetchAPI('/audit/stats').catch(() => ({ total_interactions: 0, by_classification: {}, total_events: 0 })),
    ]);

    EZ.agents = agentsData.agents || [];
    const agents = EZ.agents;
    const running = agents.filter(a => a.status === 'running').length;
    const stopped = agents.filter(a => a.status === 'stopped').length;
    const errors = agents.filter(a => a.status === 'error').length;

    // Update sidebar stats
    document.getElementById('sidebar-running').textContent = running;
    document.getElementById('sidebar-stopped').textContent = stopped;
    document.getElementById('sidebar-errors').textContent = errors;

    // Runtime badge
    const badge = document.getElementById('runtime-badge');
    if (runtimeData) {
      badge.textContent = `Runtime: Connected`;
      badge.classList.add('connected');
    } else {
      badge.textContent = `Runtime: Offline`;
      badge.classList.remove('connected');
    }

    // Stat cards
    document.getElementById('overview-stats').innerHTML = `
      <div class="ez-stat-card" data-color="accent">
        <div class="ez-stat-card-label">Total Agents</div>
        <div class="ez-stat-card-value">${agents.length}</div>
      </div>
      <div class="ez-stat-card" data-color="success">
        <div class="ez-stat-card-label">Running</div>
        <div class="ez-stat-card-value">${running}</div>
      </div>
      <div class="ez-stat-card" data-color="warning">
        <div class="ez-stat-card-label">Stopped</div>
        <div class="ez-stat-card-value">${stopped}</div>
      </div>
      <div class="ez-stat-card" data-color="error">
        <div class="ez-stat-card-label">Errors</div>
        <div class="ez-stat-card-value">${errors}</div>
      </div>
    `;

    // Agent health grid
    const healthGrid = document.getElementById('agent-health-grid');
    if (agents.length === 0) {
      healthGrid.innerHTML = '<div class="ez-empty"><div class="ez-empty-text">No agents configured</div><div class="ez-empty-sub">Create your first agent in the Agents tab</div></div>';
    } else {
      healthGrid.innerHTML = agents.map(a => `
        <div class="ez-health-card" onclick="switchTab('agents')">
          <span class="ez-health-dot ${a.status}"></span>
          <span class="ez-health-card-name">${escHtml(a.name)}</span>
          <span class="ez-health-card-status">${a.status}</span>
        </div>
      `).join('');
    }

    // Activity feed (from audit events)
    const feedEl = document.getElementById('activity-feed');
    try {
      const auditData = await fetchAPI('/audit/events?limit=15');
      const events = auditData.events || [];
      if (events.length === 0) {
        feedEl.innerHTML = '<div class="ez-empty"><div class="ez-empty-text">No activity yet</div></div>';
      } else {
        feedEl.innerHTML = events.map(e => `
          <div class="ez-activity-item">
            <span class="ez-activity-time">${formatTime(e.created_at)}</span>
            <span class="ez-activity-text">${escHtml(e.action)} ${e.agent_id ? `<span class="ez-badge ez-badge-muted">${e.agent_id.slice(0,8)}</span>` : ''}</span>
          </div>
        `).join('');
      }
    } catch {
      feedEl.innerHTML = '<div class="ez-empty"><div class="ez-empty-text">Could not load activity</div></div>';
    }

  } catch (err) {
    console.error('[overview]', err);
    showToast('Failed to load overview', 'error');
  }
}

// ── Polling ────────────────────────────────────────────────
function startPolling() {
  setInterval(() => {
    if (EZ.currentTab === 'overview') loadOverview();
  }, 30000);
}

// ── Toast System ───────────────────────────────────────────
function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `ez-toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 4000);
}

// ── Helpers ────────────────────────────────────────────────
function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatTime(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString();
}

function formatDate(iso) {
  if (!iso) return '--';
  return new Date(iso).toLocaleString();
}
