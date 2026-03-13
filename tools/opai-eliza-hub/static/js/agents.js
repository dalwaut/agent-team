/**
 * Eliza Hub — agents.js
 * Agent grid/list view, filters, search, CRUD operations.
 */

let agentView = 'grid';
let agentFilters = { status: '', platform: '', deploy: '', search: '' };

// ── Init ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // View switcher
  document.querySelectorAll('.ez-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      agentView = btn.dataset.view;
      document.querySelectorAll('.ez-view-btn').forEach(b => b.classList.toggle('active', b === btn));
      renderAgents();
    });
  });

  // Filters
  document.getElementById('agent-search').addEventListener('input', e => {
    agentFilters.search = e.target.value.toLowerCase();
    renderAgents();
  });
  document.getElementById('filter-status').addEventListener('change', e => {
    agentFilters.status = e.target.value;
    renderAgents();
  });
  document.getElementById('filter-platform').addEventListener('change', e => {
    agentFilters.platform = e.target.value;
    renderAgents();
  });
  document.getElementById('filter-deploy').addEventListener('change', e => {
    agentFilters.deploy = e.target.value;
    renderAgents();
  });

  // Add Agent button
  document.getElementById('btn-add-agent').addEventListener('click', () => {
    if (typeof openWizard === 'function') openWizard();
  });
});

// ── Load Agents ────────────────────────────────────────────
async function loadAgents() {
  try {
    const [agentsData, charsData] = await Promise.all([
      fetchAPI('/agents'),
      fetchAPI('/agents/runtime/characters').catch(() => ({ characters: [] })),
    ]);
    EZ.agents = agentsData.agents || [];
    EZ.characters = charsData.characters || [];
    renderAgents();
  } catch (err) {
    console.error('[agents]', err);
    showToast('Failed to load agents', 'error');
  }
}

// ── Start/Stop from character file ────────────────────────
async function startCharacter(file) {
  try {
    showToast('Starting agent...', 'info');
    await fetchAPI('/agents/runtime/start', {
      method: 'POST',
      body: JSON.stringify({ characterFile: file }),
    });
    showToast('Agent started!', 'success');
    loadAgents();
    if (typeof loadOverview === 'function') loadOverview();
  } catch (err) {
    showToast(`Failed to start: ${err.message}`, 'error');
  }
}

async function stopRuntimeAgent(id) {
  try {
    await fetchAPI(`/agents/${id}/stop`, { method: 'POST' });
    showToast('Agent stopped', 'info');
    loadAgents();
    if (typeof loadOverview === 'function') loadOverview();
  } catch (err) {
    showToast(`Failed to stop: ${err.message}`, 'error');
  }
}

// ── Render ─────────────────────────────────────────────────
function renderAgents() {
  const container = document.getElementById('agents-container');
  let agents = [...EZ.agents];

  // Apply filters
  if (agentFilters.search) {
    agents = agents.filter(a =>
      a.name.toLowerCase().includes(agentFilters.search) ||
      a.slug.toLowerCase().includes(agentFilters.search)
    );
  }
  if (agentFilters.status) {
    agents = agents.filter(a => a.status === agentFilters.status);
  }
  if (agentFilters.platform) {
    agents = agents.filter(a => (a.platforms || []).includes(agentFilters.platform));
  }
  if (agentFilters.deploy) {
    agents = agents.filter(a => a.deployment_tier === agentFilters.deploy);
  }

  // Build running agents section
  let html = '';

  if (agents.length > 0) {
    html += `<div class="ez-section-label" style="margin-bottom:12px;font-weight:600;font-size:14px;color:var(--text-dim)">Running Agents</div>`;
    container.className = agentView === 'grid' ? 'ez-agents-grid' : 'ez-agents-list';
    if (agentView === 'grid') {
      html += `<div class="ez-agents-grid">${agents.map(a => renderAgentCard(a)).join('')}</div>`;
    } else {
      html += agents.map(a => renderAgentRow(a)).join('');
    }
  }

  // Build available characters section
  const chars = EZ.characters || [];
  const runSlugs = EZ.agents.map(a => a.slug);
  const available = chars.filter(c => !runSlugs.includes(c.slug));

  if (available.length > 0 || agents.length === 0) {
    html += `<div class="ez-section-label" style="margin:24px 0 12px;font-weight:600;font-size:14px;color:var(--text-dim)">Available Characters</div>`;
    html += `<div class="ez-agents-grid">`;
    const toShow = available.length > 0 ? available : chars;
    html += toShow.map(c => {
      const isRunning = runSlugs.includes(c.slug);
      return `
        <div class="ez-agent-card" style="cursor:default">
          <div class="ez-agent-card-header">
            <div class="ez-agent-avatar">${c.name?.charAt(0) || '?'}</div>
            <div>
              <div class="ez-agent-name">${escHtml(c.name)}</div>
              <div class="ez-agent-slug">${escHtml(c.slug)}</div>
            </div>
            <span class="ez-health-dot ${isRunning ? 'running' : ''}" style="margin-left:auto" title="${isRunning ? 'running' : 'stopped'}"></span>
          </div>
          <div class="ez-agent-card-body" style="min-height:32px">
            <span class="ez-badge ${isRunning ? 'ez-badge-success' : 'ez-badge-muted'}">${isRunning ? 'running' : 'available'}</span>
          </div>
          <div class="ez-agent-card-footer">
            <span style="font-size:12px;color:var(--text-dim)">${escHtml(c.file)}</span>
            ${isRunning
              ? `<button class="ez-btn ez-btn-secondary ez-btn-sm" onclick="event.stopPropagation(); stopRuntimeAgent(EZ.agents.find(a=>a.slug==='${c.slug}')?.id)">Stop</button>`
              : `<button class="ez-btn ez-btn-primary ez-btn-sm" onclick="event.stopPropagation(); startCharacter('${escHtml(c.file)}')">Start</button>`
            }
          </div>
        </div>
      `;
    }).join('');
    html += `</div>`;
  }

  if (!html) {
    html = `
      <div class="ez-empty">
        <div class="ez-empty-icon">&#x1F916;</div>
        <div class="ez-empty-text">No agents or characters found</div>
        <div class="ez-empty-sub">Add character files to the characters/ directory</div>
      </div>
    `;
  }

  container.innerHTML = html;
}

function renderAgentCard(agent) {
  const avatar = agent.character_file?.avatar || agent.name?.charAt(0) || '?';
  const platforms = (agent.platforms || []).map(p => `<span class="ez-agent-platform-tag">${escHtml(p)}</span>`).join('');
  const deployBadge = getDeployBadge(agent.deployment_tier);

  return `
    <div class="ez-agent-card" onclick="openAgentDetail('${agent.id}')">
      <div class="ez-agent-card-header">
        <div class="ez-agent-avatar">${avatar.length === 1 ? avatar : '&#x1F916;'}</div>
        <div>
          <div class="ez-agent-name">${escHtml(agent.name)}</div>
          <div class="ez-agent-slug">${escHtml(agent.slug)}</div>
        </div>
        <span class="ez-health-dot ${agent.status}" style="margin-left:auto" title="${agent.status}"></span>
      </div>
      <div class="ez-agent-card-body">
        <div class="ez-agent-platforms">${platforms || '<span class="ez-agent-platform-tag">none</span>'}</div>
      </div>
      <div class="ez-agent-card-footer">
        <span>${deployBadge}</span>
        <span>${agent.model || 'default'}</span>
      </div>
    </div>
  `;
}

function renderAgentRow(agent) {
  const platforms = (agent.platforms || []).map(p => `<span class="ez-agent-platform-tag">${escHtml(p)}</span>`).join('');
  return `
    <div class="ez-agent-row" onclick="openAgentDetail('${agent.id}')">
      <span class="ez-health-dot ${agent.status}" title="${agent.status}"></span>
      <span class="ez-agent-name">${escHtml(agent.name)}</span>
      <span class="ez-agent-platforms">${platforms}</span>
      <span class="ez-badge ${agent.status === 'running' ? 'ez-badge-success' : agent.status === 'error' ? 'ez-badge-error' : 'ez-badge-muted'}">${agent.status}</span>
      <span style="font-size:12px;color:var(--text-dim)">${agent.deployment_tier}</span>
    </div>
  `;
}

function getDeployBadge(tier) {
  const colors = { local: 'ez-badge-info', docker: 'ez-badge-accent', cloud: 'ez-badge-warn' };
  return `<span class="ez-badge ${colors[tier] || 'ez-badge-muted'}">${tier || 'local'}</span>`;
}
