/**
 * Eliza Hub — detail.js
 * Agent detail slide-in panel with character info, platforms,
 * knowledge, metrics, interaction log, config editor, lifecycle actions.
 */

// ── Open Detail Panel ──────────────────────────────────────
async function openAgentDetail(agentId) {
  const overlay = document.getElementById('detail-overlay');
  const panel = document.getElementById('detail-panel');

  try {
    const agent = await fetchAPI(`/agents/${agentId}`);
    panel.innerHTML = renderDetailPanel(agent);
    overlay.style.display = 'flex';

    // Close on overlay click
    overlay.onclick = (e) => {
      if (e.target === overlay) closeDetail();
    };

    // Load interaction log
    loadDetailInteractions(agentId);
  } catch (err) {
    showToast('Failed to load agent details', 'error');
  }
}

function closeDetail() {
  document.getElementById('detail-overlay').style.display = 'none';
}

// ── Render Detail ──────────────────────────────────────────
function renderDetailPanel(agent) {
  const char = agent.character_file || {};
  const avatar = char.avatar || agent.name?.charAt(0) || '?';
  const platforms = (agent.platforms || []).map(p => `<span class="ez-agent-platform-tag">${escHtml(p)}</span>`).join('') || 'None';

  return `
    <div class="ez-detail-header">
      <div class="ez-detail-title">
        <div class="ez-agent-avatar">${avatar.length === 1 ? avatar : '&#x1F916;'}</div>
        ${escHtml(agent.name)}
        <span class="ez-health-dot ${agent.status}"></span>
        <span class="ez-badge ${agent.status === 'running' ? 'ez-badge-success' : agent.status === 'error' ? 'ez-badge-error' : 'ez-badge-muted'}">${agent.status}</span>
      </div>
      <button class="ez-detail-close" onclick="closeDetail()">&#x2715;</button>
    </div>

    <!-- Character Info -->
    <div class="ez-detail-section">
      <div class="ez-detail-section-title">Character</div>
      <div class="ez-detail-meta">
        <div class="ez-detail-meta-item"><label>Slug</label><span style="font-family:var(--font-mono)">${escHtml(agent.slug)}</span></div>
        <div class="ez-detail-meta-item"><label>Model</label><span>${escHtml(agent.model)}</span></div>
        <div class="ez-detail-meta-item"><label>Deployment</label><span>${escHtml(agent.deployment_tier)}</span></div>
        <div class="ez-detail-meta-item"><label>Temperature</label><span>${agent.temperature}</span></div>
        <div class="ez-detail-meta-item"><label>Max Tokens</label><span>${agent.max_tokens}</span></div>
        <div class="ez-detail-meta-item"><label>Rate Limit</label><span>${agent.rate_limit_rpm} RPM / ${agent.rate_limit_daily} daily</span></div>
      </div>
      ${char.bio ? `<p style="margin-top:10px;font-size:13px;color:var(--text-dim)">${escHtml(char.bio)}</p>` : ''}
    </div>

    <!-- Platforms -->
    <div class="ez-detail-section">
      <div class="ez-detail-section-title">Platforms</div>
      <div class="ez-agent-platforms" style="gap:6px">${platforms}</div>
    </div>

    <!-- Knowledge Branch -->
    <div class="ez-detail-section">
      <div class="ez-detail-section-title">Knowledge</div>
      <div style="font-size:13px">
        ${agent.knowledge_branch_id
          ? `<span class="ez-badge ez-badge-accent">Branch: ${agent.knowledge_branch_id.slice(0,8)}...</span>`
          : '<span class="ez-badge ez-badge-muted">No branch assigned</span>'
        }
      </div>
    </div>

    <!-- Metrics -->
    <div class="ez-detail-section">
      <div class="ez-detail-section-title">Metrics</div>
      <div class="ez-detail-meta">
        <div class="ez-detail-meta-item"><label>Created</label><span>${formatDate(agent.created_at)}</span></div>
        <div class="ez-detail-meta-item"><label>Updated</label><span>${formatDate(agent.updated_at)}</span></div>
      </div>
    </div>

    <!-- Interaction Log -->
    <div class="ez-detail-section">
      <div class="ez-detail-section-title">Recent Interactions</div>
      <div id="detail-interactions" class="ez-interaction-log">
        <div class="ez-loading">Loading...</div>
      </div>
    </div>

    <!-- Config JSON -->
    <div class="ez-detail-section">
      <div class="ez-detail-section-title">Character Config (JSON)</div>
      <textarea class="ez-config-editor" id="detail-config-editor">${JSON.stringify(char, null, 2)}</textarea>
      <button class="ez-btn ez-btn-secondary ez-btn-sm" style="margin-top:8px" onclick="saveAgentConfig('${agent.id}')">Save Config</button>
    </div>

    <!-- Lifecycle Actions -->
    <div class="ez-detail-actions">
      ${agent.status === 'running'
        ? `<button class="ez-btn ez-btn-secondary" onclick="agentAction('${agent.id}', 'stop')">Stop</button>
           <button class="ez-btn ez-btn-secondary" onclick="agentAction('${agent.id}', 'restart')">Restart</button>`
        : `<button class="ez-btn ez-btn-primary" onclick="agentAction('${agent.id}', 'start')">Start</button>`
      }
      <button class="ez-btn ez-btn-danger" style="margin-left:auto" onclick="deleteAgent('${agent.id}')">Delete</button>
    </div>
  `;
}

// ── Load Interactions ──────────────────────────────────────
async function loadDetailInteractions(agentId) {
  const el = document.getElementById('detail-interactions');
  try {
    const data = await fetchAPI(`/audit/interactions?agent_id=${agentId}&limit=20`);
    const items = data.interactions || [];
    if (items.length === 0) {
      el.innerHTML = '<div class="ez-empty"><div class="ez-empty-text">No interactions yet</div></div>';
      return;
    }
    el.innerHTML = items.map(i => `
      <div class="ez-interaction-item">
        <span class="ez-interaction-direction ${i.direction}">${i.direction === 'inbound' ? '&#x2192;' : '&#x2190;'}</span>
        <span class="ez-badge ${i.info_class === 'blocked' ? 'ez-badge-error' : 'ez-badge-muted'}" style="margin:0 6px">${i.info_class}</span>
        <span>${escHtml((i.content || '').slice(0, 100))}${(i.content || '').length > 100 ? '...' : ''}</span>
        <span style="margin-left:auto;color:var(--text-muted);font-size:11px">${formatTime(i.created_at)}</span>
      </div>
    `).join('');
  } catch {
    el.innerHTML = '<div class="ez-empty"><div class="ez-empty-text">Could not load interactions</div></div>';
  }
}

// ── Agent Actions ──────────────────────────────────────────
async function agentAction(agentId, action) {
  try {
    await fetchAPI(`/agents/${agentId}/${action}`, { method: 'POST' });
    showToast(`Agent ${action}ed successfully`, 'success');
    closeDetail();
    if (typeof loadAgents === 'function') loadAgents();
    loadOverview();
  } catch (err) {
    showToast(`Failed to ${action} agent: ${err.message}`, 'error');
  }
}

async function deleteAgent(agentId) {
  if (!confirm('Delete this agent? This cannot be undone.')) return;
  try {
    await fetchAPI(`/agents/${agentId}`, { method: 'DELETE' });
    showToast('Agent deleted', 'success');
    closeDetail();
    loadAgents();
    loadOverview();
  } catch (err) {
    showToast(`Failed to delete: ${err.message}`, 'error');
  }
}

async function saveAgentConfig(agentId) {
  const editor = document.getElementById('detail-config-editor');
  try {
    const character = JSON.parse(editor.value);
    await fetchAPI(`/agents/${agentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ character_file: character }),
    });
    showToast('Config saved', 'success');
  } catch (err) {
    showToast(`Invalid JSON or save failed: ${err.message}`, 'error');
  }
}
