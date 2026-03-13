/**
 * Eliza Hub — knowledge.js
 * Knowledge tree view, branch management, node picker, prune/detach.
 */

let knowledgeBranches = [];
let selectedBranch = null;

// ── Load Knowledge ─────────────────────────────────────────
async function loadKnowledge() {
  const tree = document.getElementById('knowledge-tree');
  tree.innerHTML = '<div class="ez-loading">Loading...</div>';

  try {
    const data = await fetchAPI('/knowledge/branches');
    knowledgeBranches = data.branches || [];
    renderKnowledgeTree();
  } catch (err) {
    tree.innerHTML = '<div class="ez-empty"><div class="ez-empty-text">Failed to load branches</div></div>';
    console.error('[knowledge]', err);
  }
}

// ── Render Tree ────────────────────────────────────────────
function renderKnowledgeTree() {
  const tree = document.getElementById('knowledge-tree');
  const search = (document.getElementById('knowledge-search')?.value || '').toLowerCase();
  const layerFilter = document.getElementById('filter-info-layer')?.value || '';

  let filtered = [...knowledgeBranches];
  if (search) filtered = filtered.filter(b => b.name.toLowerCase().includes(search));
  if (layerFilter) filtered = filtered.filter(b => b.info_layer === layerFilter);

  if (filtered.length === 0) {
    tree.innerHTML = `
      <div class="ez-empty">
        <div class="ez-empty-icon">&#x1F4DA;</div>
        <div class="ez-empty-text">${knowledgeBranches.length === 0 ? 'No knowledge branches' : 'No matching branches'}</div>
        <div class="ez-empty-sub"><button class="ez-btn ez-btn-primary ez-btn-sm" onclick="createBranch()">+ Create Branch</button></div>
      </div>
    `;
    return;
  }

  // Info layer legend
  const legend = `
    <div style="display:flex;gap:12px;margin-bottom:12px;font-size:12px">
      <span><span class="ez-badge ez-badge-public">PUBLIC</span> Customer-safe</span>
      <span><span class="ez-badge ez-badge-internal">INTERNAL</span> System only</span>
      <span><span class="ez-badge ez-badge-agent_specific">AGENT</span> Isolated</span>
      <button class="ez-btn ez-btn-secondary ez-btn-sm" style="margin-left:auto" onclick="createBranch()">+ Create Branch</button>
    </div>
  `;

  tree.innerHTML = legend + filtered.map(b => {
    const isSelected = selectedBranch?.id === b.id;
    const nodeCount = b.eliza_knowledge_branch_nodes?.[0]?.count || 0;
    return `
      <div class="ez-branch-card ${isSelected ? 'selected' : ''}" onclick="selectBranch('${b.id}')">
        <div class="ez-branch-header">
          <span class="ez-branch-name">${escHtml(b.name)}</span>
          <div class="ez-branch-meta">
            <span class="ez-badge ez-badge-${b.info_layer}">${b.info_layer}</span>
            <span>${nodeCount} nodes</span>
            ${b.auto_sync ? '<span class="ez-badge ez-badge-accent">auto-sync</span>' : ''}
          </div>
        </div>
        <div style="font-size:12px;color:var(--text-dim)">${escHtml(b.description || b.slug)}</div>
      </div>
    `;
  }).join('');
}

// ── Select Branch ──────────────────────────────────────────
async function selectBranch(branchId) {
  const branch = knowledgeBranches.find(b => b.id === branchId);
  if (!branch) return;

  selectedBranch = branch;
  renderKnowledgeTree();

  const layout = document.querySelector('.ez-knowledge-layout');
  layout.classList.add('has-detail');

  const detail = document.getElementById('knowledge-detail');
  detail.style.display = '';
  detail.innerHTML = '<div class="ez-loading">Loading nodes...</div>';

  try {
    const data = await fetchAPI(`/knowledge/branches/${branchId}/nodes`);
    const nodes = data.nodes || [];

    detail.innerHTML = `
      <div class="ez-panel">
        <h3 class="ez-panel-title">
          ${escHtml(branch.name)}
          <span class="ez-badge ez-badge-${branch.info_layer}">${branch.info_layer}</span>
        </h3>

        <div class="ez-detail-meta" style="margin-bottom:16px">
          <div class="ez-detail-meta-item"><label>Slug</label><span style="font-family:var(--font-mono)">${escHtml(branch.slug)}</span></div>
          <div class="ez-detail-meta-item"><label>Auto-Sync</label><span>${branch.auto_sync ? 'Enabled' : 'Disabled'}</span></div>
          <div class="ez-detail-meta-item"><label>Created</label><span>${formatDate(branch.created_at)}</span></div>
          <div class="ez-detail-meta-item"><label>Nodes</label><span>${nodes.length}</span></div>
        </div>

        <div class="ez-detail-section-title">Nodes (${nodes.length})</div>
        <div id="branch-nodes">
          ${nodes.length === 0
            ? '<div class="ez-empty"><div class="ez-empty-text">No nodes assigned</div></div>'
            : nodes.map(n => `
              <div class="ez-node-card">
                <div style="display:flex;justify-content:space-between;align-items:center">
                  <div>
                    <div class="ez-node-card-title">${escHtml(n.node_id?.slice(0, 8) || 'Node')}</div>
                    <div class="ez-node-card-type">Added ${formatTime(n.added_at)} by ${n.added_by}</div>
                  </div>
                  <button class="ez-btn ez-btn-ghost ez-btn-sm" onclick="pruneNode('${branchId}', '${n.node_id}')" title="Remove node">&#x2715;</button>
                </div>
              </div>
            `).join('')
          }
        </div>

        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="ez-btn ez-btn-secondary ez-btn-sm" onclick="triggerSync('${branchId}')">Sync Now</button>
          <button class="ez-btn ez-btn-danger ez-btn-sm" style="margin-left:auto" onclick="deleteBranch('${branchId}')">Delete Branch</button>
        </div>
      </div>
    `;
  } catch (err) {
    detail.innerHTML = '<div class="ez-empty"><div class="ez-empty-text">Failed to load nodes</div></div>';
  }
}

// ── CRUD Operations ────────────────────────────────────────
async function createBranch() {
  const name = prompt('Branch name (e.g., sales-kb):');
  if (!name) return;
  const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

  try {
    await fetchAPI('/knowledge/branches', {
      method: 'POST',
      body: JSON.stringify({ name, slug, info_layer: 'public', description: '' }),
    });
    showToast(`Branch "${name}" created`, 'success');
    loadKnowledge();
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
}

async function deleteBranch(branchId) {
  if (!confirm('Delete this knowledge branch? Nodes will be detached.')) return;
  try {
    await fetchAPI(`/knowledge/branches/${branchId}`, { method: 'DELETE' });
    showToast('Branch deleted', 'success');
    selectedBranch = null;
    document.getElementById('knowledge-detail').style.display = 'none';
    document.querySelector('.ez-knowledge-layout').classList.remove('has-detail');
    loadKnowledge();
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
}

async function pruneNode(branchId, nodeId) {
  try {
    await fetchAPI(`/knowledge/branches/${branchId}/nodes/${nodeId}`, { method: 'DELETE' });
    showToast('Node removed from branch', 'success');
    selectBranch(branchId);
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
}

async function triggerSync(branchId) {
  try {
    const result = await fetchAPI(`/knowledge/branches/${branchId}/sync`, { method: 'POST' });
    showToast(`Synced ${result.synced} nodes (${result.total_matched} matched)`, 'success');
    selectBranch(branchId);
  } catch (err) {
    showToast(`Sync failed: ${err.message}`, 'error');
  }
}

// ── Filter listeners ───────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('knowledge-search')?.addEventListener('input', renderKnowledgeTree);
  document.getElementById('filter-info-layer')?.addEventListener('change', renderKnowledgeTree);
});
