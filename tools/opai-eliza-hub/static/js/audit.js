/**
 * Eliza Hub — audit.js
 * Interaction log table, expandable rows, filters, pagination, CSV export, flag/review.
 */

let auditPage = 0;
const AUDIT_PAGE_SIZE = 50;
let auditInteractions = [];

// ── Load Audit ─────────────────────────────────────────────
async function loadAudit() {
  const container = document.getElementById('audit-container');
  container.innerHTML = '<div class="ez-loading">Loading interactions...</div>';

  try {
    // Populate agent filter dropdown
    if (EZ.agents.length === 0) {
      const agentsData = await fetchAPI('/agents').catch(() => ({ agents: [] }));
      EZ.agents = agentsData.agents || [];
    }
    const agentSelect = document.getElementById('filter-audit-agent');
    if (agentSelect.options.length <= 1) {
      EZ.agents.forEach(a => {
        const opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = a.name;
        agentSelect.appendChild(opt);
      });
    }

    await fetchAuditPage();
  } catch (err) {
    container.innerHTML = '<div class="ez-empty"><div class="ez-empty-text">Failed to load audit data</div></div>';
    console.error('[audit]', err);
  }
}

async function fetchAuditPage() {
  const params = new URLSearchParams();
  params.set('limit', AUDIT_PAGE_SIZE);
  params.set('offset', auditPage * AUDIT_PAGE_SIZE);

  const agentId = document.getElementById('filter-audit-agent')?.value;
  const channel = document.getElementById('filter-audit-platform')?.value;
  const infoClass = document.getElementById('filter-audit-class')?.value;

  if (agentId) params.set('agent_id', agentId);
  if (channel) params.set('channel', channel);
  if (infoClass) params.set('info_class', infoClass);

  const data = await fetchAPI(`/audit/interactions?${params}`);
  auditInteractions = data.interactions || [];
  renderAuditTable();
}

// ── Render Table ───────────────────────────────────────────
function renderAuditTable() {
  const container = document.getElementById('audit-container');

  if (auditInteractions.length === 0) {
    container.innerHTML = '<div class="ez-empty"><div class="ez-empty-text">No interactions found</div></div>';
    return;
  }

  const agentMap = {};
  EZ.agents.forEach(a => agentMap[a.id] = a.name);

  const rows = auditInteractions.map((i, idx) => `
    <tr class="ez-expandable" onclick="toggleAuditRow(${idx})">
      <td style="font-family:var(--font-mono);font-size:11px;white-space:nowrap">${formatDate(i.created_at)}</td>
      <td>${escHtml(agentMap[i.agent_id] || i.agent_id?.slice(0, 8) || '--')}</td>
      <td><span class="ez-agent-platform-tag">${escHtml(i.channel)}</span></td>
      <td><span class="ez-badge ez-badge-${i.info_class === 'blocked' ? 'error' : i.info_class === 'escalation' ? 'warn' : 'muted'}">${i.info_class}</span></td>
      <td><span class="ez-interaction-direction ${i.direction}">${i.direction === 'inbound' ? '&#x2192; IN' : '&#x2190; OUT'}</span></td>
      <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml((i.content || '').slice(0, 80))}</td>
      <td>
        <button class="ez-audit-flag-btn ${i.metadata?.flagged ? 'flagged' : ''}" onclick="event.stopPropagation();flagInteraction('${i.id}')" title="Flag for review">&#x2691;</button>
      </td>
    </tr>
    <tr id="audit-expand-${idx}" style="display:none">
      <td colspan="7" class="ez-audit-expand">
        <div class="ez-audit-expand-content">
          <div>
            <div class="ez-audit-expand-label">Full Content</div>
            <div class="ez-audit-expand-value">${escHtml(i.content || '(empty)')}</div>
          </div>
          <div>
            <div class="ez-audit-expand-label">Metadata</div>
            <div class="ez-audit-expand-value">${JSON.stringify(i.metadata || {}, null, 2)}</div>
          </div>
        </div>
        <div style="margin-top:8px;font-size:11px;color:var(--text-muted)">
          Tokens: ${i.tokens_used || 0} | Latency: ${i.latency_ms || 0}ms | Sender: ${escHtml(i.sender_id || '--')}
        </div>
      </td>
    </tr>
  `).join('');

  container.innerHTML = `
    <div style="overflow-x:auto">
      <table class="ez-audit-table">
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Agent</th>
            <th>Channel</th>
            <th>Class</th>
            <th>Dir</th>
            <th>Content</th>
            <th style="width:40px"></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="ez-pagination">
      <button class="ez-btn ez-btn-secondary ez-btn-sm" onclick="auditPrev()" ${auditPage === 0 ? 'disabled' : ''}>Previous</button>
      <span style="font-size:12px;color:var(--text-dim)">Page ${auditPage + 1}</span>
      <button class="ez-btn ez-btn-secondary ez-btn-sm" onclick="auditNext()" ${auditInteractions.length < AUDIT_PAGE_SIZE ? 'disabled' : ''}>Next</button>
    </div>
  `;
}

// ── Expand/Collapse ────────────────────────────────────────
function toggleAuditRow(idx) {
  const row = document.getElementById(`audit-expand-${idx}`);
  if (row) row.style.display = row.style.display === 'none' ? '' : 'none';
}

// ── Pagination ─────────────────────────────────────────────
function auditPrev() {
  if (auditPage > 0) { auditPage--; fetchAuditPage(); }
}
function auditNext() {
  if (auditInteractions.length >= AUDIT_PAGE_SIZE) { auditPage++; fetchAuditPage(); }
}

// ── Flag ───────────────────────────────────────────────────
async function flagInteraction(interactionId) {
  const reason = prompt('Reason for flagging (optional):') || 'Manual review';
  try {
    await fetchAPI(`/audit/interactions/${interactionId}/flag`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    showToast('Interaction flagged for review', 'warn');
    fetchAuditPage();
  } catch (err) {
    showToast(`Failed to flag: ${err.message}`, 'error');
  }
}

// ── Export CSV ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-export-csv')?.addEventListener('click', () => {
    const agentId = document.getElementById('filter-audit-agent')?.value || '';
    const params = agentId ? `?agent_id=${agentId}` : '';
    window.open(`/api/audit/export/interactions${params}`, '_blank');
  });

  // Filter listeners
  ['filter-audit-agent', 'filter-audit-platform', 'filter-audit-class'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => {
      auditPage = 0;
      fetchAuditPage();
    });
  });
});
