/* 2nd Brain — Frontend SPA */
'use strict';

// ── State ────────────────────────────────────────────────────────────────────
let _supabase = null;
let _session  = null;
let _nodes    = [];       // library nodes (non-inbox)
let _inbox    = [];
let _activeNodeId = null;
let _activeTab    = 'library';
let _searchTimer  = null;
let _dirty        = false;
let _previewMode  = false;
let _typeFilter   = 'all';
let _tagFilter    = null;

// Promote modal state
let _promoteNodeId = null;

// Tier state
let _meData = null;  // result of GET /api/me

// AI state
let _aiResult     = null;  // last AI action result text
let _aiAction     = null;  // last AI action type

// Block editor state
let _editor        = null;   // EditorJS instance
let _editorMode    = 'block'; // 'block' | 'markdown'

// Snapshot drawer state
let _snapshotDrawerOpen = false;
let _activeSnapshotId   = null;
let _activeSnapshotContent = null;

// Canvas label modal state (Phase 6)
let _pendingLinkSrc = null;
let _pendingLinkTgt = null;

// Schedule dirty flag
let _scheduleDirty = false;

// ── Toast ────────────────────────────────────────────────────────────────────
function toast(msg, type = 'ok') {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ── Auth helpers ─────────────────────────────────────────────────────────────
function authHeader() {
  const tok = _session?.access_token;
  return tok ? { 'Authorization': 'Bearer ' + tok } : {};
}

async function apiFetch(path, opts = {}) {
  const r = await fetch('/brain' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...authHeader(), ...(opts.headers || {}) },
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(body || r.statusText);
  }
  return r.status === 204 ? null : r.json();
}

// ── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  // Fetch Supabase config
  const cfg = await fetch('/brain/api/auth/config').then(r => r.json());
  _supabase = supabase.createClient(cfg.supabase_url, cfg.supabase_anon_key);

  const { data: { session } } = await _supabase.auth.getSession();
  if (session) {
    _session = session;
    showApp();
  } else {
    showAuth();
  }

  _supabase.auth.onAuthStateChange((_evt, sess) => {
    _session = sess;
    if (sess) showApp();
    else showAuth();
  });

  // Init block editor after DOM is ready
  initBlockEditor();
}

function showAuth() {
  document.getElementById('loading').classList.add('hidden');
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
}

function showApp() {
  document.getElementById('loading').classList.add('hidden');
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  loadMe();   // fetch tier + apply gating before loading content
  loadLibrary();
  loadInbox();
  loadResearch();
  loadSchedule();  // admin-only; no-ops for non-admin
  // Canvas loads lazily on first tab switch (initCanvasSvg needs visible SVG dimensions)
}

async function loadMe() {
  try {
    _meData = await apiFetch('/api/me');
    applyTierGating();
  } catch (e) {
    console.warn('Could not load user info:', e);
  }
}

function applyTierGating() {
  if (!_meData) return;
  const { features, research_quota, research_used } = _meData;

  // AI toolbar: hide for starter / no-tier
  const aiToolbarBtns = document.querySelectorAll('.ai-toolbar .ai-btn');
  if (!features.ai_editor) {
    const toolbar = document.getElementById('ai-toolbar');
    if (toolbar) {
      toolbar.dataset.tierLocked = '1';
      // Replace toolbar hint with upgrade message (shown when node is open)
      const hint = toolbar.querySelector('.ai-toolbar-hint');
      if (hint) hint.textContent = 'Upgrade to Pro or Ultimate to unlock AI writing tools.';
      aiToolbarBtns.forEach(b => b.disabled = true);
    }
  }

  // Research tab: hide input form / show upgrade notice for starter
  const researchForm = document.querySelector('.research-form-box');
  if (researchForm) {
    if (!features.research) {
      researchForm.innerHTML = `
        <div class="tier-gate-notice">
          <div class="tier-gate-icon">🔒</div>
          <h3>Research requires Pro or Ultimate</h3>
          <p>Upgrade your plan to access Claude-powered research synthesis.</p>
          <a href="/billing/" class="btn-upgrade">View Plans</a>
        </div>`;
    } else {
      // Show quota usage for non-unlimited tiers
      const quota = research_quota; // -1 = unlimited
      if (quota !== -1) {
        const remaining = Math.max(0, quota - research_used);
        let quotaEl = document.getElementById('research-quota-bar');
        if (!quotaEl) {
          quotaEl = document.createElement('div');
          quotaEl.id = 'research-quota-bar';
          quotaEl.className = 'research-quota-bar';
          researchForm.appendChild(quotaEl);
        }
        const pct = Math.min(100, (research_used / quota) * 100);
        quotaEl.innerHTML = `
          <div class="quota-label">Research sessions this month: <strong>${research_used} / ${quota}</strong></div>
          <div class="quota-track"><div class="quota-fill" style="width:${pct}%"></div></div>
          ${remaining === 0 ? '<div class="quota-warn">Monthly quota reached. Resets next month.</div>' : ''}`;
        if (remaining === 0) {
          document.getElementById('btn-research').disabled = true;
        }
      }
    }
  }
}

// ── Tab navigation ────────────────────────────────────────────────────────────
function switchTab(tab) {
  _activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
  if (tab === 'graph') renderGraph();
  if (tab === 'research') loadResearch();
  if (tab === 'canvas') loadCanvas();
}

// ── Library ──────────────────────────────────────────────────────────────────
async function loadLibrary(query = '') {
  try {
    const params = new URLSearchParams();
    if (_typeFilter && _typeFilter !== 'all') params.set('type', _typeFilter);
    params.set('limit', '200');

    let data;
    if (query.trim().length >= 2) {
      data = await apiFetch('/api/search?q=' + encodeURIComponent(query));
      _nodes = data.results || [];
    } else {
      if (!_typeFilter || _typeFilter === 'all') {
        // Single call for all non-inbox nodes (was 3 parallel calls)
        const d = await apiFetch('/api/nodes?limit=500');
        _nodes = (d.nodes || []).filter(n => n.type !== 'inbox');
      } else {
        const d = await apiFetch('/api/nodes?' + params);
        _nodes = d.nodes || [];
      }
    }

    renderNoteList();
  } catch (e) {
    toast('Failed to load library: ' + e.message, 'err');
  }
}

function renderNoteList() {
  const list = document.getElementById('note-list');

  let filtered = _nodes;
  if (_tagFilter) {
    filtered = filtered.filter(n => (n.tags || []).includes(_tagFilter));
  }

  if (!filtered.length) {
    list.innerHTML = '<div class="note-list-empty">No notes yet — create one!</div>';
    return;
  }

  list.innerHTML = filtered.map(n => {
    const active = n.id === _activeNodeId ? 'active' : '';
    const badge = `<span class="type-badge badge-${n.type}">${n.type}</span>`;
    const date = new Date(n.updated_at).toLocaleDateString();
    return `<div class="note-item ${active}" onclick="openNode('${n.id}')" data-id="${n.id}">
      <div class="note-item-title">${esc(n.title || 'Untitled')}</div>
      <div class="note-item-meta">${badge}<span>${date}</span></div>
    </div>`;
  }).join('');
}

function openNode(id) {
  const node = _nodes.find(n => n.id === id);
  if (!node) return;
  if (_dirty && _activeNodeId) {
    if (!confirm('You have unsaved changes. Discard them?')) return;
  }
  _activeNodeId = id;
  _dirty = false;
  renderNoteList();
  showEditor(node);
}

function showEditor(node) {
  document.getElementById('editor-empty').classList.add('hidden');
  document.getElementById('editor-form').classList.remove('hidden');
  // Show AI toolbar only for persisted nodes
  const aiBar = document.getElementById('ai-toolbar');
  if (aiBar) aiBar.classList.toggle('hidden', !node.id);

  document.getElementById('node-title').value = node.title || '';
  document.getElementById('node-type-select').value = node.type || 'note';

  const md = node.content || '';
  document.getElementById('node-content').value = md;

  // Load block editor
  if (_editorMode === 'block' && _editor) {
    const blocks = node.metadata?.blocks;
    if (blocks && Array.isArray(blocks) && blocks.length) {
      _editor.render({ blocks }).catch(() => {});
    } else {
      // Auto-convert markdown to blocks
      const converted = markdownToBlocks(md);
      _editor.render({ blocks: converted }).catch(() => {});
    }
  }

  renderTags(node.tags || []);
  updateSaveBtn();
  updateWordCount();
  if (_previewMode) renderPreview();

  // Load related notes sidebar (if node is persisted)
  if (node.id) loadRelatedForNode(node.id);
  else renderRelatedSidebar([]);
}

function showEditorEmpty() {
  document.getElementById('editor-empty').classList.remove('hidden');
  document.getElementById('editor-form').classList.add('hidden');
  const aiBar = document.getElementById('ai-toolbar');
  if (aiBar) aiBar.classList.add('hidden');
  _activeNodeId = null;
}

// ── Tags ──────────────────────────────────────────────────────────────────────
let _currentTags = [];

function renderTags(tags) {
  _currentTags = [...tags];
  const row = document.getElementById('tags-row');
  const chips = _currentTags.map(t =>
    `<span class="tag-chip" onclick="removeTag('${esc(t)}')">${esc(t)}<span class="remove">&times;</span></span>`
  ).join('');
  row.innerHTML = chips +
    `<input class="tag-input" id="tag-input" placeholder="add tag..." onkeydown="tagKeydown(event)">`;
}

function removeTag(t) {
  _currentTags = _currentTags.filter(x => x !== t);
  renderTags(_currentTags);
  _dirty = true;
  updateSaveBtn();
}

function tagKeydown(e) {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    const val = e.target.value.trim().replace(/,/g, '');
    if (val && !_currentTags.includes(val)) {
      _currentTags.push(val);
    }
    renderTags(_currentTags);
    _dirty = true;
    updateSaveBtn();
  }
}

// ── Create / Save / Delete ────────────────────────────────────────────────────
function newNote() {
  if (_dirty && _activeNodeId) {
    if (!confirm('Discard unsaved changes?')) return;
  }
  _activeNodeId = null;
  _dirty = false;
  const fakeNode = { id: null, title: '', content: '', type: document.getElementById('node-type-select')?.value || 'note', tags: [] };
  showEditor(fakeNode);
  document.getElementById('node-title').focus();
}

function markDirty() {
  _dirty = true;
  updateSaveBtn();
  updateWordCount();
}

function updateSaveBtn() {
  const btn = document.getElementById('btn-save');
  if (btn) btn.disabled = !_dirty;
}

async function saveNode() {
  const title = document.getElementById('node-title').value.trim();
  const type  = document.getElementById('node-type-select').value;

  // Collect any pending tag input
  const tagInput = document.getElementById('tag-input');
  if (tagInput && tagInput.value.trim()) {
    _currentTags.push(tagInput.value.trim());
    tagInput.value = '';
  }

  // Get content from block editor or textarea
  let content = document.getElementById('node-content').value;
  let metadata = {};

  if (_editorMode === 'block' && _editor) {
    try {
      const editorData = await _editor.save();
      metadata.blocks = editorData.blocks;
      content = blocksToMarkdown(editorData.blocks);
      // Sync textarea for preview
      document.getElementById('node-content').value = content;
    } catch (e) {
      console.warn('Block editor save failed, using textarea:', e);
    }
  }

  const body = { title, content, type, tags: _currentTags, metadata };

  try {
    let saved;
    if (_activeNodeId) {
      saved = await apiFetch('/api/nodes/' + _activeNodeId, { method: 'PATCH', body: JSON.stringify(body) });
    } else {
      saved = await apiFetch('/api/nodes', { method: 'POST', body: JSON.stringify(body) });
      _activeNodeId = saved.id;
    }

    _dirty = false;
    updateSaveBtn();

    // Refresh list
    await loadLibrary(document.getElementById('search-input').value);
    openNode(_activeNodeId);
    toast('Saved!');
  } catch (e) {
    toast('Save failed: ' + e.message, 'err');
  }
}

async function deleteNode() {
  if (!_activeNodeId) return;
  if (!confirm('Delete this note permanently?')) return;
  try {
    await apiFetch('/api/nodes/' + _activeNodeId, { method: 'DELETE' });
    _activeNodeId = null;
    _dirty = false;
    showEditorEmpty();
    await loadLibrary(document.getElementById('search-input').value);
    toast('Deleted.');
  } catch (e) {
    toast('Delete failed: ' + e.message, 'err');
  }
}

// ── Preview ───────────────────────────────────────────────────────────────────
function togglePreview() {
  _previewMode = !_previewMode;
  document.getElementById('btn-preview').classList.toggle('active', _previewMode);

  const blockEl = document.getElementById('editor-block');
  const taEl    = document.getElementById('node-content');
  const prevEl  = document.getElementById('preview-area');

  if (_previewMode) {
    // Hide editor (block or textarea), show preview
    if (blockEl) blockEl.classList.add('hidden');
    if (taEl) taEl.classList.add('hidden');
    if (prevEl) prevEl.classList.remove('hidden');
    renderPreview();
  } else {
    // Show editor, hide preview
    if (prevEl) prevEl.classList.add('hidden');
    if (_editorMode === 'block') {
      if (blockEl) blockEl.classList.remove('hidden');
    } else {
      if (taEl) taEl.classList.remove('hidden');
    }
  }
}

function renderPreview() {
  const md = document.getElementById('node-content').value;
  // Basic markdown rendering (no library dependency)
  let html = esc(md)
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank">$1</a>')
    .replace(/\[\[(.+?)\]\]/g, '<span class="wikilink" onclick="searchWikilink(\'$1\')">$1</span>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');
  document.getElementById('preview-area').innerHTML = '<p>' + html + '</p>';
}

function searchWikilink(title) {
  document.getElementById('search-input').value = title;
  loadLibrary(title);
  switchTab('library');
}

// ── Search ────────────────────────────────────────────────────────────────────
function onSearch(val) {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => loadLibrary(val), 300);
}

function filterType(type) {
  _typeFilter = type;
  document.querySelectorAll('.type-pill').forEach(p => p.classList.toggle('active', p.dataset.type === type));
  loadLibrary(document.getElementById('search-input').value);
}

// ── Inbox ─────────────────────────────────────────────────────────────────────
async function loadInbox() {
  try {
    const data = await apiFetch('/api/inbox');
    _inbox = data.items || [];
    renderInbox();
    updateInboxBadge();
  } catch (e) {
    console.error('Inbox load error:', e);
  }
}

function renderInbox() {
  const list = document.getElementById('inbox-list');
  if (!_inbox.length) {
    list.innerHTML = '<div class="inbox-empty">Inbox is empty — capture a thought above!</div>';
    return;
  }
  list.innerHTML = _inbox.map(item => {
    const date = new Date(item.created_at).toLocaleString();
    return `<div class="inbox-item" data-id="${item.id}">
      <div class="inbox-item-body">
        <div class="inbox-item-content">${esc(item.content)}</div>
        <div class="inbox-item-meta">${date}</div>
      </div>
      <div class="inbox-item-actions">
        <button class="btn-promote" onclick="openPromoteModal('${item.id}')">Promote</button>
        <button class="btn-dismiss" onclick="dismissInbox('${item.id}')">Dismiss</button>
      </div>
    </div>`;
  }).join('');

  // Load suggestion chips for inbox items (async, non-blocking)
  setTimeout(() => {
    _inbox.forEach(item => {
      const el = list.querySelector(`.inbox-item[data-id="${item.id}"] .inbox-item-body`);
      if (el) loadInboxSuggestions(item, el);
    });
  }, 100);
}

function updateInboxBadge() {
  const badge = document.getElementById('inbox-badge');
  if (badge) {
    badge.textContent = _inbox.length || '';
    badge.style.display = _inbox.length ? 'flex' : 'none';
  }
}

async function captureInbox() {
  const ta = document.getElementById('capture-textarea');
  const content = ta.value.trim();
  if (!content) return;

  const btn = document.getElementById('btn-capture');
  btn.disabled = true;
  try {
    const item = await apiFetch('/api/inbox', { method: 'POST', body: JSON.stringify({ content }) });
    _inbox.unshift(item);
    renderInbox();
    updateInboxBadge();
    ta.value = '';
    toast('Captured!');
  } catch (e) {
    toast('Capture failed: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function dismissInbox(id) {
  if (!confirm('Dismiss this item?')) return;
  try {
    await apiFetch('/api/inbox/' + id, { method: 'DELETE' });
    _inbox = _inbox.filter(i => i.id !== id);
    renderInbox();
    updateInboxBadge();
    toast('Dismissed.');
  } catch (e) {
    toast('Failed: ' + e.message, 'err');
  }
}

// ── Promote modal ─────────────────────────────────────────────────────────────
function openPromoteModal(id) {
  _promoteNodeId = id;
  const item = _inbox.find(i => i.id === id);
  document.getElementById('promote-title').value = item?.title || item?.content?.slice(0, 60) || '';
  document.getElementById('promote-type').value = 'note';
  document.getElementById('promote-modal').classList.remove('hidden');
}

function closePromoteModal() {
  document.getElementById('promote-modal').classList.add('hidden');
  _promoteNodeId = null;
}

async function confirmPromote() {
  const title = document.getElementById('promote-title').value.trim();
  const type  = document.getElementById('promote-type').value;
  try {
    await apiFetch('/api/inbox/' + _promoteNodeId + '/process', {
      method: 'PATCH',
      body: JSON.stringify({ title, type }),
    });
    _inbox = _inbox.filter(i => i.id !== _promoteNodeId);
    renderInbox();
    updateInboxBadge();
    await loadLibrary();
    closePromoteModal();
    toast('Promoted to Library!');
  } catch (e) {
    toast('Promote failed: ' + e.message, 'err');
  }
}

// ── Graph ─────────────────────────────────────────────────────────────────────
let _graphData = null;
let _graphSim = null;
let _graphFrozen = false;
let _graphGroupBy = 'none';
let _graphPositionTimers = {};
let _graphNodes = null;  // live D3 node array
let _graphLinks = null;  // live D3 link array
let _graphG = null;      // main SVG <g> for hull drawing
let _orphanUpdater = null;
let _deadEndUpdater = null;
let _graphFocusedId = null;       // currently focused node (single-click)
let _graphPanelNodeId = null;     // node shown in side panel (double-click)
let _graphNodeSelection = null;   // D3 selection of all node <g> elements
let _graphLinkSelection = null;   // D3 selection of all link <line> elements
let _graphDegreeMap = {};         // nodeId -> connection count
let _graphClickTimer = null;      // for distinguishing single vs double click

function saveGraphPosition(nodeData) {
  // Debounced save — 600ms after last drag
  if (_graphPositionTimers[nodeData.id]) clearTimeout(_graphPositionTimers[nodeData.id]);
  _graphPositionTimers[nodeData.id] = setTimeout(async () => {
    try {
      await apiFetch(`/api/graph/nodes/${nodeData.id}/position`, {
        method: 'PATCH',
        body: JSON.stringify({ x: nodeData.fx, y: nodeData.fy }),
      });
    } catch (e) {
      console.warn('Failed to save graph position:', e);
    }
  }, 600);
}

function _getNodeGroup(n) {
  if (_graphGroupBy === 'source') return n.group || 'ungrouped';
  if (_graphGroupBy === 'type') return n.type || 'note';
  return null;
}

// ── Focus mode (single-click highlight) ──────────────────────────────────────

function _getNeighborIds(nodeId, links) {
  const neighbors = new Set();
  links.forEach(l => {
    const sid = typeof l.source === 'object' ? l.source.id : l.source;
    const tid = typeof l.target === 'object' ? l.target.id : l.target;
    if (sid === nodeId) neighbors.add(tid);
    if (tid === nodeId) neighbors.add(sid);
  });
  return neighbors;
}

function graphFocusNode(nodeId) {
  if (!_graphNodeSelection || !_graphLinkSelection || !_graphLinks) return;
  _graphFocusedId = nodeId;

  const neighborIds = _getNeighborIds(nodeId, _graphLinks);

  // Dim all, then highlight focused + neighbors
  _graphNodeSelection.each(function(d) {
    const el = d3.select(this);
    el.classed('graph-node-dimmed', false).classed('graph-node-focused', false).classed('graph-node-neighbor', false);
    if (d.id === nodeId) {
      el.classed('graph-node-focused', true);
    } else if (neighborIds.has(d.id)) {
      el.classed('graph-node-neighbor', true);
    } else {
      el.classed('graph-node-dimmed', true);
    }
  });

  _graphLinkSelection.each(function(l) {
    const el = d3.select(this);
    const sid = typeof l.source === 'object' ? l.source.id : l.source;
    const tid = typeof l.target === 'object' ? l.target.id : l.target;
    const connected = sid === nodeId || tid === nodeId;
    el.classed('graph-link-dimmed', !connected).classed('graph-link-focused', connected);
  });
}

function graphClearFocus() {
  _graphFocusedId = null;
  if (!_graphNodeSelection || !_graphLinkSelection) return;
  _graphNodeSelection.classed('graph-node-dimmed', false)
    .classed('graph-node-focused', false)
    .classed('graph-node-neighbor', false);
  _graphLinkSelection.classed('graph-link-dimmed', false)
    .classed('graph-link-focused', false);
}

// ── Side panel (double-click preview) ────────────────────────────────────────

async function openGraphPanel(nodeData) {
  _graphPanelNodeId = nodeData.id;
  const panel = document.getElementById('graph-side-panel');
  if (!panel) return;

  const typeColor = { note: '#60a5fa', concept: '#a78bfa', question: '#34d399' };
  const linkTypeColor = {
    related: '#60a5fa', supports: '#22c55e', contradicts: '#ef4444',
    derived_from: '#a78bfa', suggested: '#f59e0b', blocks: '#f97316',
    enables: '#06b6d4', canvas_edge: '#6b7280',
  };

  // Title + meta
  document.getElementById('graph-panel-title').textContent = nodeData.title || 'Untitled';
  const typeBadge = '<span class="type-badge badge-' + nodeData.type + '">' + (nodeData.type || 'note') + '</span>';
  const degree = _graphDegreeMap[nodeData.id] || 0;
  document.getElementById('graph-panel-meta').innerHTML = typeBadge +
    ' <span>' + degree + ' connection' + (degree !== 1 ? 's' : '') + '</span>';

  // Connections list
  const neighborIds = _getNeighborIds(nodeData.id, _graphLinks || []);
  const connEl = document.getElementById('graph-panel-connections');
  if (neighborIds.size > 0) {
    const connNodes = (_graphNodes || []).filter(n => neighborIds.has(n.id));
    // Find link info for each connection
    const connHtml = connNodes.map(cn => {
      const connLink = (_graphLinks || []).find(l => {
        const sid = typeof l.source === 'object' ? l.source.id : l.source;
        const tid = typeof l.target === 'object' ? l.target.id : l.target;
        return (sid === nodeData.id && tid === cn.id) || (tid === nodeData.id && sid === cn.id);
      });
      const lt = connLink ? (connLink.type || 'related') : 'related';
      const color = linkTypeColor[lt] || '#6b7280';
      return '<div class="graph-panel-conn-item" onclick="graphPanelFocusNode(\'' + cn.id + '\')">' +
        '<span class="graph-panel-conn-dot" style="background:' + color + ';"></span>' +
        '<span>' + esc(cn.title || 'Untitled') + '</span>' +
        '<span class="graph-panel-conn-label">' + lt + '</span></div>';
    }).join('');
    connEl.innerHTML = '<h4>Connections</h4>' + connHtml;
    connEl.style.display = '';
  } else {
    connEl.innerHTML = '<h4>Connections</h4><div style="font-size:12px;color:var(--text-muted);">No connections</div>';
    connEl.style.display = '';
  }

  // Body — fetch full node content
  const bodyEl = document.getElementById('graph-panel-body');
  bodyEl.innerHTML = '<div style="color:var(--text-muted);">Loading...</div>';
  panel.classList.add('open');

  try {
    const fullNode = await apiFetch('/api/nodes/' + nodeData.id);
    const content = fullNode.content || '';
    if (content) {
      bodyEl.innerHTML = renderMarkdownSimple(content);
    } else {
      bodyEl.innerHTML = '<div style="color:var(--text-muted);font-style:italic;">No content</div>';
    }
  } catch (e) {
    bodyEl.innerHTML = '<div style="color:var(--text-muted);">Failed to load content.</div>';
  }
}

function closeGraphPanel() {
  _graphPanelNodeId = null;
  const panel = document.getElementById('graph-side-panel');
  if (panel) panel.classList.remove('open');
}

function graphPanelOpenInLibrary() {
  if (_graphPanelNodeId) {
    closeGraphPanel();
    graphClearFocus();
    switchTab('library');
    openNodeById(_graphPanelNodeId);
  }
}

function graphPanelFocusNode(nodeId) {
  // Click a connection in the side panel → focus that node + open its panel
  graphFocusNode(nodeId);
  const nd = (_graphNodes || []).find(n => n.id === nodeId);
  if (nd) openGraphPanel(nd);
}

// Simple markdown renderer for side panel (reuse preview logic if available)
function renderMarkdownSimple(md) {
  // Basic markdown → HTML (headers, bold, italic, code, links, lists, blockquotes)
  let html = esc(md);
  // Code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Bold + italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color:var(--accent);">$1</a>');
  // Paragraphs (double newlines)
  html = html.replace(/\n\n/g, '</p><p>');
  html = '<p>' + html + '</p>';
  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, '');
  return html;
}

async function renderGraph() {
  const svg = document.getElementById('graph-svg');

  try {
    const data = await apiFetch('/api/graph');
    _graphData = data;

    if (!data.nodes?.length) {
      document.getElementById('graph-empty').classList.remove('hidden');
      return;
    }
    document.getElementById('graph-empty').classList.add('hidden');

    // Restore UI state
    const groupSel = document.getElementById('graph-group-by');
    if (groupSel) groupSel.value = _graphGroupBy;

    // Load suggestions in parallel
    await loadGraphSuggestions();

    // Close side panel on re-render
    closeGraphPanel();
    _graphFocusedId = null;

    drawForceGraph(svg, data);
  } catch (e) {
    console.error('Graph error:', e);
    toast('Graph load failed.', 'err');
  }
}

function drawForceGraph(svgEl, data) {
  const W = svgEl.clientWidth || 800;
  const H = svgEl.clientHeight || 600;
  const cx = W / 2, cy = H / 2;

  // Clear previous
  svgEl.innerHTML = '';
  _graphFrozen = false;
  _graphFocusedId = null;
  const freezeBtn = document.getElementById('btn-graph-freeze');
  if (freezeBtn) { freezeBtn.textContent = 'Freeze'; freezeBtn.classList.remove('frozen'); }

  const svg = d3.select(svgEl);
  const typeColor = { note: '#60a5fa', concept: '#a78bfa', question: '#34d399' };
  const linkTypeColor = {
    related: '#60a5fa', supports: '#22c55e', contradicts: '#ef4444',
    derived_from: '#a78bfa', suggested: '#f59e0b', blocks: '#f97316',
    enables: '#06b6d4', canvas_edge: '#6b7280',
  };

  // Group colors for hulls
  const groupColors = [
    '#8b5cf6', '#60a5fa', '#22c55e', '#f59e0b', '#ef4444',
    '#06b6d4', '#a78bfa', '#f97316', '#ec4899', '#14b8a6',
  ];

  const g = svg.append('g');
  _graphG = g;

  // Zoom/pan — also dismiss focus on background click
  const zoom = d3.zoom().scaleExtent([0.3, 3]).on('zoom', (e) => g.attr('transform', e.transform));
  svg.call(zoom);
  svg.on('click', (e) => {
    // Only on direct SVG click (background), not bubbled from nodes
    if (e.target === svgEl || e.target.tagName === 'svg') {
      graphClearFocus();
      closeGraphPanel();
    }
  });

  // Nodes copy for simulation — load saved positions
  const nodes = data.nodes.map(n => {
    const copy = { ...n };
    if (n.x != null && n.y != null) {
      copy.x = n.x;
      copy.y = n.y;
      copy.fx = n.x;
      copy.fy = n.y;
    }
    return copy;
  });
  _graphNodes = nodes;
  const links = data.links.map(l => ({ ...l }));
  _graphLinks = links;

  const allPositioned = nodes.length > 0 && nodes.every(n => n.fx != null);

  // ── Compute degree (connection count) per node ──
  const degreeMap = {};
  nodes.forEach(n => { degreeMap[n.id] = 0; });
  links.forEach(l => {
    const sid = typeof l.source === 'object' ? l.source.id : l.source;
    const tid = typeof l.target === 'object' ? l.target.id : l.target;
    if (degreeMap[sid] !== undefined) degreeMap[sid]++;
    if (degreeMap[tid] !== undefined) degreeMap[tid]++;
  });
  _graphDegreeMap = degreeMap;

  // ── Radial layout: compute target radius per node based on degree ──
  // maxDegree → center (radius 0), 0 connections → outermost ring
  const maxDegree = Math.max(1, ...Object.values(degreeMap));
  const graphRadius = Math.min(W, H) * 0.42; // overall radius of the circle
  // Store radial target per node (for forceRadial)
  nodes.forEach(n => {
    const deg = degreeMap[n.id] || 0;
    // Invert: high degree = small radius (center), low degree = large radius (edge)
    // Use sqrt to spread mid-range nodes more evenly
    n._targetRadius = graphRadius * (1 - Math.sqrt(deg / maxDegree));
  });

  // Scale node circle size by degree
  const rScale = d3.scaleSqrt().domain([0, maxDegree]).range([5, 12]);

  // Compute cluster centers for group-by mode
  let clusterCenters = {};
  if (_graphGroupBy !== 'none') {
    const groups = {};
    nodes.forEach(n => {
      const grp = _getNodeGroup(n);
      if (grp) {
        if (!groups[grp]) groups[grp] = [];
        groups[grp].push(n);
      }
    });
    const groupNames = Object.keys(groups).sort();
    const cols = Math.ceil(Math.sqrt(groupNames.length));
    const cellW = W / (cols + 1);
    const cellH = H / (Math.ceil(groupNames.length / cols) + 1);
    groupNames.forEach((name, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      clusterCenters[name] = {
        x: cellW * (col + 1),
        y: cellH * (row + 1),
        color: groupColors[i % groupColors.length],
      };
    });
  }

  // Hull group (drawn behind everything)
  const hullGroup = g.append('g').attr('class', 'hull-layer');

  // Link elements
  const link = g.append('g').selectAll('line')
    .data(links)
    .join('line')
    .attr('stroke', d => linkTypeColor[d.type] || '#6b7280')
    .attr('stroke-width', d => 1 + (d.strength || 1) * 2)
    .attr('stroke-opacity', d => 0.3 + (d.strength || 1) * 0.5)
    .attr('stroke-dasharray', d => d.type === 'suggested' ? '6,4' : null);
  _graphLinkSelection = link;

  // Link labels (visible on hover)
  const linkLabels = g.append('g').selectAll('text')
    .data(links.filter(l => l.label))
    .join('text')
    .attr('text-anchor', 'middle')
    .attr('font-size', '9px')
    .attr('fill', '#6b7280')
    .attr('opacity', 0)
    .text(d => d.label);

  link.on('mouseenter', function(_e, d) {
    if (d.label) linkLabels.filter(l => l.id === d.id).attr('opacity', 1);
  }).on('mouseleave', function() {
    linkLabels.attr('opacity', 0);
  });

  // Node elements
  const node = g.append('g').selectAll('g')
    .data(nodes)
    .join('g')
    .style('cursor', 'pointer')
    .call(d3.drag()
      .on('start', (e, d) => {
        if (!e.active && _graphSim) _graphSim.alphaTarget(0.3).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end', (e, d) => {
        // Keep pinned (Obsidian style) — node stays where dropped
        if (!e.active && _graphSim) _graphSim.alphaTarget(0);
        saveGraphPosition(d);
        updatePinIndicators();
      })
    );
  _graphNodeSelection = node;

  // Single-click → focus (highlight neighborhood), double-click → open side panel
  node.on('click', (e, d) => {
    e.stopPropagation();
    if (_graphClickTimer) {
      // Double-click detected
      clearTimeout(_graphClickTimer);
      _graphClickTimer = null;
      graphFocusNode(d.id);
      openGraphPanel(d);
    } else {
      // Wait to see if it's a double-click
      _graphClickTimer = setTimeout(() => {
        _graphClickTimer = null;
        // Single click — toggle focus
        if (_graphFocusedId === d.id) {
          graphClearFocus();
        } else {
          graphFocusNode(d.id);
        }
      }, 250);
    }
  });

  node.append('circle')
    .attr('r', d => rScale(degreeMap[d.id] || 0))
    .attr('fill', d => typeColor[d.type] || '#888')
    .attr('stroke', '#0d0d0f')
    .attr('stroke-width', 2);

  // Pin indicator (small dot above pinned nodes)
  node.append('circle')
    .attr('class', 'graph-pin-indicator')
    .attr('r', 2.5)
    .attr('cx', 0)
    .attr('cy', d => -(rScale(degreeMap[d.id] || 0) + 5))
    .attr('opacity', d => d.fx != null ? 0.7 : 0);

  node.append('text')
    .attr('x', d => rScale(degreeMap[d.id] || 0) + 5).attr('y', 4)
    .text(d => (d.title || 'Untitled').slice(0, 24))
    .attr('font-size', '11px')
    .attr('fill', '#e8e8f0');

  function updatePinIndicators() {
    node.selectAll('.graph-pin-indicator')
      .attr('opacity', d => d.fx != null ? 0.7 : 0);
  }

  // Tooltip
  const tooltip = document.getElementById('graph-tooltip');
  node
    .on('mouseenter', (e, d) => {
      tooltip.style.display = 'block';
      tooltip.style.left = (e.offsetX + 14) + 'px';
      tooltip.style.top  = (e.offsetY - 8) + 'px';
      const deg = degreeMap[d.id] || 0;
      tooltip.textContent = (d.title || 'Untitled') + ' (' + deg + ' link' + (deg !== 1 ? 's' : '') + ')';
    })
    .on('mouseleave', () => { tooltip.style.display = 'none'; })
    .on('contextmenu', (e, d) => {
      e.preventDefault();
      e.stopPropagation();
      showGraphNodePopover(e, d);
    });

  // Update group hulls on each tick
  function updateGroupHulls() {
    if (_graphGroupBy === 'none') {
      hullGroup.selectAll('*').remove();
      return;
    }
    const groups = {};
    nodes.forEach(n => {
      const grp = _getNodeGroup(n);
      if (grp) {
        if (!groups[grp]) groups[grp] = [];
        groups[grp].push([n.x, n.y]);
      }
    });

    hullGroup.selectAll('*').remove();

    Object.entries(groups).forEach(([name, points]) => {
      if (points.length < 2) {
        const center = clusterCenters[name];
        const color = center ? center.color : '#888';
        hullGroup.append('circle')
          .attr('cx', points[0][0]).attr('cy', points[0][1])
          .attr('r', 30)
          .attr('class', 'graph-group-hull')
          .attr('fill', color).attr('stroke', color);
        hullGroup.append('text')
          .attr('class', 'graph-group-label')
          .attr('x', points[0][0]).attr('y', points[0][1] - 36)
          .attr('text-anchor', 'middle')
          .text(name);
        return;
      }
      const padded = [];
      points.forEach(p => {
        padded.push([p[0] - 20, p[1] - 20]);
        padded.push([p[0] + 20, p[1] - 20]);
        padded.push([p[0] - 20, p[1] + 20]);
        padded.push([p[0] + 20, p[1] + 20]);
      });
      const hull = d3.polygonHull(padded);
      if (!hull) return;

      const center = clusterCenters[name];
      const color = center ? center.color : '#888';

      hullGroup.append('path')
        .attr('d', 'M' + hull.join('L') + 'Z')
        .attr('class', 'graph-group-hull')
        .attr('fill', color).attr('stroke', color);

      const hcx = d3.mean(points, p => p[0]);
      const hcy = d3.min(points, p => p[1]) - 28;
      hullGroup.append('text')
        .attr('class', 'graph-group-label')
        .attr('x', hcx).attr('y', hcy)
        .attr('text-anchor', 'middle')
        .text(name);
    });
  }

  // Build simulation — radial orbital layout
  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id)
      .distance(d => 80 - (d.strength || 0.5) * 30)
      .strength(d => 0.4 + (d.strength || 0.5) * 0.6))
    .force('charge', d3.forceManyBody().strength(d => {
      // Stronger repulsion for high-degree nodes to give them space
      const deg = degreeMap[d.id] || 0;
      return -80 - deg * 15;
    }))
    .force('radial', d3.forceRadial(d => d._targetRadius, cx, cy).strength(0.3))
    .force('collision', d3.forceCollide(d => rScale(degreeMap[d.id] || 0) + 8))
    .alphaDecay(0.02)
    .on('tick', () => {
      link
        .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
      linkLabels
        .attr('x', d => (d.source.x + d.target.x) / 2)
        .attr('y', d => (d.source.y + d.target.y) / 2 - 4);
      node.attr('transform', d => `translate(${d.x},${d.y})`);
      if (_orphanUpdater) _orphanUpdater();
      if (_deadEndUpdater) _deadEndUpdater();
      updateGroupHulls();
    });

  _graphSim = sim;

  // Add clustering forces when group-by is active
  if (_graphGroupBy !== 'none' && Object.keys(clusterCenters).length > 0) {
    sim.force('groupX', d3.forceX(d => {
      const grp = _getNodeGroup(d);
      return clusterCenters[grp] ? clusterCenters[grp].x : cx;
    }).strength(0.15));
    sim.force('groupY', d3.forceY(d => {
      const grp = _getNodeGroup(d);
      return clusterCenters[grp] ? clusterCenters[grp].y : cy;
    }).strength(0.15));
    // Reduce radial strength when grouping — let groups dominate
    sim.force('radial').strength(0.08);
  }

  // If all nodes have saved positions, skip simulation — just render static
  if (allPositioned) {
    sim.stop();
    sim.tick();
    link
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    linkLabels
      .attr('x', d => (d.source.x + d.target.x) / 2)
      .attr('y', d => (d.source.y + d.target.y) / 2 - 4);
    node.attr('transform', d => `translate(${d.x},${d.y})`);
    updateGroupHulls();
    _graphFrozen = true;
    if (freezeBtn) { freezeBtn.textContent = 'Unfreeze'; freezeBtn.classList.add('frozen'); }
  } else {
    // Auto-freeze after simulation settles
    sim.on('end.autofreeze', () => {
      _graphFrozen = true;
      if (freezeBtn) { freezeBtn.textContent = 'Unfreeze'; freezeBtn.classList.add('frozen'); }
    });
  }

  // Draw suggestion overlay (dashed amber lines)
  drawSuggestionOverlay(g, nodes, sim);

  // Draw orphan highlights (pulsing amber rings)
  _orphanUpdater = drawOrphanHighlights(g, nodes, links);

  // Compute stats: orphans, dead-ends
  const connectedSet = new Set();
  const incomingSet = new Set();
  const outgoingSet = new Set();
  links.forEach(l => {
    const sid = typeof l.source === 'object' ? l.source.id : l.source;
    const tid = typeof l.target === 'object' ? l.target.id : l.target;
    connectedSet.add(sid);
    connectedSet.add(tid);
    outgoingSet.add(sid);
    incomingSet.add(tid);
  });
  const orphanCount = nodes.filter(n => !connectedSet.has(n.id)).length;
  const deadEndCount = nodes.filter(n => outgoingSet.has(n.id) && !incomingSet.has(n.id)).length;

  // Draw dead-end highlights (orange pulse rings)
  const deadEndNodes = nodes.filter(n => outgoingSet.has(n.id) && !incomingSet.has(n.id));
  _deadEndUpdater = drawDeadEndHighlights(g, deadEndNodes);

  // Update stats bar
  const countEl = document.getElementById('graph-node-count');
  if (countEl) {
    let text = `${nodes.length} nodes \u00b7 ${links.length} links`;
    if (orphanCount) text += ` \u00b7 ${orphanCount} orphans`;
    if (deadEndCount) text += ` \u00b7 ${deadEndCount} dead-ends`;
    const pinned = nodes.filter(n => n.fx != null).length;
    if (pinned) text += ` \u00b7 ${pinned} pinned`;
    countEl.textContent = text;
  }
}

// ── Graph toolbar handlers ──────────────────────────────────────────────────

function onGraphGroupChange(value) {
  _graphGroupBy = value;
  if (_graphData) drawForceGraph(document.getElementById('graph-svg'), _graphData);
}

function toggleGraphFreeze() {
  const btn = document.getElementById('btn-graph-freeze');
  if (!_graphSim) return;

  if (_graphFrozen) {
    _graphSim.alpha(0.3).restart();
    _graphFrozen = false;
    if (btn) { btn.textContent = 'Freeze'; btn.classList.remove('frozen'); }
  } else {
    _graphSim.stop();
    _graphFrozen = true;
    if (btn) { btn.textContent = 'Unfreeze'; btn.classList.add('frozen'); }
  }
}

async function graphLockAll() {
  if (!_graphNodes || !_graphNodes.length) return;

  // Pin all nodes at current positions
  const positions = [];
  _graphNodes.forEach(n => {
    n.fx = n.x;
    n.fy = n.y;
    positions.push({ id: n.id, x: n.x, y: n.y });
  });

  // Stop simulation
  if (_graphSim) _graphSim.stop();
  _graphFrozen = true;
  const btn = document.getElementById('btn-graph-freeze');
  if (btn) { btn.textContent = 'Unfreeze'; btn.classList.add('frozen'); }

  // Bulk save
  try {
    const result = await apiFetch('/api/graph/save-all-positions', {
      method: 'POST',
      body: JSON.stringify({ positions }),
    });
    toast(`Locked ${result.updated || positions.length} node positions.`);
  } catch (e) {
    toast('Failed to save positions: ' + e.message, 'err');
  }
}

async function graphResetLayout() {
  if (!confirm('Reset all graph positions? Nodes will re-simulate from scratch.')) return;

  try {
    await apiFetch('/api/graph/reset-positions', { method: 'POST' });
    toast('Graph positions cleared.');
    _graphGroupBy = 'none';
    const groupSel = document.getElementById('graph-group-by');
    if (groupSel) groupSel.value = 'none';
    await renderGraph();
  } catch (e) {
    toast('Reset failed: ' + e.message, 'err');
  }
}

async function openNodeById(id) {
  // First ensure library has this node
  if (!_nodes.find(n => n.id === id)) {
    await loadLibrary();
  }
  openNode(id);
}

// ── Auth UI ───────────────────────────────────────────────────────────────────
async function signIn() {
  const email = document.getElementById('auth-email').value.trim();
  const pass  = document.getElementById('auth-pass').value;
  const err   = document.getElementById('auth-error');
  err.textContent = '';
  if (!email || !pass) { err.textContent = 'Email and password required.'; return; }

  const { error } = await _supabase.auth.signInWithPassword({ email, password: pass });
  if (error) { err.textContent = error.message; }
}

async function signOut() {
  await _supabase.auth.signOut();
}

// ── Utilities ────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Word Count ────────────────────────────────────────────────────────────────
function updateWordCount() {
  const ta = document.getElementById('node-content');
  const text = (ta?.value || '').trim();
  const words = text ? text.split(/\s+/).length : 0;
  const chars = text.length;
  const wc = document.getElementById('word-count');
  const cc = document.getElementById('char-count');
  if (wc) wc.textContent = words + ' word' + (words !== 1 ? 's' : '');
  if (cc) cc.textContent = chars.toLocaleString() + ' chars';
}

// ── Canvas (Phase 3) ──────────────────────────────────────────────────────────

const NODE_W = 160;
const NODE_H = 60;
const PORT_R = 5;
const TYPE_COLOR = { note: '#3b82f6', concept: '#8b5cf6', question: '#10b981', inbox: '#6b7280' };

let _canvasData    = null;   // {nodes, links}
let _canvasSvg     = null;
let _canvasZoom    = null;
let _canvasLoaded  = false;

// Connection drawing state
let _connectSrc    = null;   // {node_id, x, y} when port drag starts
let _ctxPos        = {x: 0, y: 0};   // right-click position on canvas
let _ctxNodeId     = null;            // right-click target node

// Position save debounce
let _posTimers = {};

async function loadCanvas() {
  try {
    const data = await apiFetch('/api/canvas');
    _canvasData = data;
    if (!_canvasLoaded) {
      initCanvasSvg();
      _canvasLoaded = true;
    }
    renderCanvas();
    document.getElementById('canvas-node-count').textContent =
      data.total + ' note' + (data.total !== 1 ? 's' : '') +
      (data.links.length ? ' · ' + data.links.length + ' link' + (data.links.length !== 1 ? 's' : '') : '');
  } catch (e) {
    toast('Canvas load failed: ' + e.message, 'err');
  }
}

function initCanvasSvg() {
  const svgEl = document.getElementById('canvas-svg');
  _canvasSvg  = d3.select(svgEl);

  // Zoom/pan transforms #canvas-content (already in the HTML, no DOM moving needed)
  _canvasZoom = d3.zoom().scaleExtent([0.1, 3]).on('zoom', (e) => {
    d3.select('#canvas-content').attr('transform', e.transform);
  });
  _canvasSvg.call(_canvasZoom);
  _canvasSvg.on('dblclick.zoom', null);

  // Right-click on background (not on a node)
  svgEl.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.canvas-node')) return;
    e.preventDefault();
    _ctxPos = svgToCanvas(e.clientX, e.clientY);
    showCanvasCtxMenu(e.clientX, e.clientY);
  });

  // Dismiss context menus on canvas click (scoped to SVG, not document)
  svgEl.addEventListener('click', () => {
    document.getElementById('canvas-ctx-menu').classList.add('hidden');
    document.getElementById('node-ctx-menu').classList.add('hidden');
  });
}

function svgToCanvas(screenX, screenY) {
  const svgEl = document.getElementById('canvas-svg');
  const pt = svgEl.createSVGPoint();
  pt.x = screenX;
  pt.y = screenY;
  const content = document.getElementById('canvas-content');
  const ctm = content.getScreenCTM();
  if (!ctm) return { x: screenX, y: screenY };
  const inv = ctm.inverse();
  const tp  = pt.matrixTransform(inv);
  return { x: tp.x, y: tp.y };
}

function renderCanvas() {
  if (!_canvasData) return;
  const { nodes, links } = _canvasData;

  // Auto-assign positions for unpositioned nodes
  let unposIdx = 0;
  const positioned = nodes.filter(n => n.x !== null);
  nodes.forEach(n => {
    if (n.x === null || n.y === null) {
      const cols = 5;
      const col = unposIdx % cols;
      const row = Math.floor(unposIdx / cols);
      n.x = 80 + col * 220;
      n.y = 80 + row * 120;
      unposIdx++;
    }
  });

  const isEmpty = nodes.length === 0;
  document.getElementById('canvas-empty').classList.toggle('hidden', !isEmpty);

  renderCanvasLinks(links, nodes);
  renderCanvasNodes(nodes);
}

function renderCanvasLinks(links, nodes) {
  const nodeMap = {};
  nodes.forEach(n => { nodeMap[n.id] = n; });

  const linksLayer = document.getElementById('canvas-links');
  linksLayer.innerHTML = '';

  links.forEach(lk => {
    const s = nodeMap[lk.source];
    const t = nodeMap[lk.target];
    if (!s || !t) return;

    const sx = s.x + NODE_W / 2;
    const sy = s.y + NODE_H / 2;
    const tx = t.x + NODE_W / 2;
    const ty = t.y + NODE_H / 2;

    // Bezier curve
    const mx = (sx + tx) / 2;
    const my = (sy + ty) / 2;

    const strength = lk.strength || 1;
    const strokeWidth = (1 + strength * 3).toFixed(1);
    const opacity = (0.4 + strength * 0.6).toFixed(2);

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const d = `M${sx},${sy} Q${mx},${sy} ${tx},${ty}`;
    path.setAttribute('d', d);
    path.setAttribute('stroke', '#4a4a5a');
    path.setAttribute('stroke-width', strokeWidth);
    path.setAttribute('stroke-opacity', opacity);
    path.setAttribute('fill', 'none');
    path.setAttribute('marker-end', 'url(#arrow)');
    path.setAttribute('class', 'canvas-link');
    path.dataset.linkId = lk.id;

    // Right-click to delete link
    path.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (confirm('Delete this connection?')) deleteCanvasLink(lk.id);
    });

    // Label on hover
    if (lk.label) {
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', mx);
      text.setAttribute('y', my - 6);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', '11');
      text.setAttribute('fill', '#6b7280');
      text.textContent = lk.label;
      linksLayer.appendChild(text);
    }

    linksLayer.appendChild(path);
  });
}

function renderCanvasNodes(nodes) {
  const nodesLayer = d3.select('#canvas-nodes');
  nodesLayer.selectAll('.canvas-node').remove();

  nodes.forEach(n => {
    const g = nodesLayer.append('g')
      .attr('class', 'canvas-node')
      .attr('transform', `translate(${n.x},${n.y})`)
      .datum(n);

    // Shadow rect
    g.append('rect')
      .attr('x', 2).attr('y', 3)
      .attr('width', NODE_W).attr('height', NODE_H)
      .attr('rx', 8).attr('ry', 8)
      .attr('fill', '#0d0d0f').attr('opacity', 0.5);

    // Main card
    const card = g.append('rect')
      .attr('width', NODE_W).attr('height', NODE_H)
      .attr('rx', 8).attr('ry', 8)
      .attr('fill', '#1a1a24')
      .attr('stroke', TYPE_COLOR[n.type] || '#3b3b4a')
      .attr('stroke-width', 1.5)
      .attr('class', 'node-card');

    // Type accent bar (left edge)
    g.append('rect')
      .attr('width', 4).attr('height', NODE_H)
      .attr('rx', 2).attr('ry', 2)
      .attr('fill', TYPE_COLOR[n.type] || '#6b7280');

    // Title text
    const title = (n.title || 'Untitled').slice(0, 22);
    g.append('text')
      .attr('x', 14).attr('y', 22)
      .attr('font-size', '12')
      .attr('font-weight', '600')
      .attr('fill', '#e8e8f0')
      .text(title);

    // Type label
    g.append('text')
      .attr('x', 14).attr('y', 40)
      .attr('font-size', '10')
      .attr('fill', TYPE_COLOR[n.type] || '#6b7280')
      .text(n.type);

    // Port circles (connect handles) — visible on node hover
    const portPositions = [
      { cx: NODE_W, cy: NODE_H / 2 },   // right
      { cx: 0,      cy: NODE_H / 2 },   // left
      { cx: NODE_W / 2, cy: 0 },        // top
      { cx: NODE_W / 2, cy: NODE_H },   // bottom
    ];

    portPositions.forEach(pos => {
      const port = g.append('circle')
        .attr('cx', pos.cx).attr('cy', pos.cy)
        .attr('r', PORT_R)
        .attr('fill', '#8b5cf6')
        .attr('stroke', '#fff')
        .attr('stroke-width', 1.5)
        .attr('class', 'node-port')
        .attr('opacity', 0);

      // Port drag to connect
      port.on('mousedown', (e) => {
        e.stopPropagation();
        if (!e.shiftKey && e.buttons !== 1) return;
        _connectSrc = { node_id: n.id, x: n.x + pos.cx, y: n.y + pos.cy };
        startConnecting(e);
      });
    });

    // Show ports on hover
    g.on('mouseenter', function() {
      d3.select(this).selectAll('.node-port').attr('opacity', 0.9);
    }).on('mouseleave', function() {
      d3.select(this).selectAll('.node-port').attr('opacity', 0);
    });

    // Click → open in library
    card.on('click', () => {
      switchTab('library');
      openNodeById(n.id);
    });

    // Right-click node context menu
    g.on('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      _ctxNodeId = n.id;
      showNodeCtxMenu(e.clientX, e.clientY);
    });

    // D3 drag for repositioning
    g.call(d3.drag()
      .filter(e => !e.shiftKey && !e.target.classList.contains('node-port'))
      .on('start', function(e, d) {
        d3.select(this).raise();
      })
      .on('drag', function(e, d) {
        d.x += e.dx;
        d.y += e.dy;
        d3.select(this).attr('transform', `translate(${d.x},${d.y})`);
        // Update link paths live
        renderCanvasLinks(_canvasData.links, _canvasData.nodes);
      })
      .on('end', function(e, d) {
        saveNodePosition(d.id, d.x, d.y);
      })
    );
  });
}

// ── Connection drawing ────────────────────────────────────────────────────────

function startConnecting(startEvent) {
  const svgEl = document.getElementById('canvas-svg');
  const line  = document.getElementById('canvas-drag-line');
  line.style.display = '';
  line.setAttribute('x1', _connectSrc.x);
  line.setAttribute('y1', _connectSrc.y);
  line.setAttribute('x2', _connectSrc.x);
  line.setAttribute('y2', _connectSrc.y);

  function onMove(e) {
    const pos = svgToCanvas(e.clientX, e.clientY);
    line.setAttribute('x2', pos.x);
    line.setAttribute('y2', pos.y);
  }

  function onUp(e) {
    line.style.display = 'none';
    svgEl.removeEventListener('mousemove', onMove);
    svgEl.removeEventListener('mouseup', onUp);

    // Find node under cursor
    const pos = svgToCanvas(e.clientX, e.clientY);
    const target = _canvasData.nodes.find(n =>
      pos.x >= n.x && pos.x <= n.x + NODE_W &&
      pos.y >= n.y && pos.y <= n.y + NODE_H
    );

    if (target && target.id !== _connectSrc.node_id) {
      // Phase 6: show label modal instead of direct create
      showCanvasLabelModal(_connectSrc.node_id, target.id);
    }
    _connectSrc = null;
  }

  svgEl.addEventListener('mousemove', onMove);
  svgEl.addEventListener('mouseup', onUp);
}

async function createCanvasLink(sourceId, targetId, label) {
  try {
    const link = await apiFetch('/api/canvas/links', {
      method: 'POST',
      body: JSON.stringify({ source_id: sourceId, target_id: targetId, label: label || '' }),
    });
    _canvasData.links.push({
      id: link.id, source: link.source_id, target: link.target_id,
      label: link.label || label || '', type: link.link_type || 'canvas_edge',
      strength: link.strength || 1,
    });
    renderCanvasLinks(_canvasData.links, _canvasData.nodes);
    toast('Connection created');
  } catch (e) {
    toast('Connection failed: ' + e.message, 'err');
  }
}

async function deleteCanvasLink(linkId) {
  try {
    await apiFetch('/api/canvas/links/' + linkId, { method: 'DELETE' });
    _canvasData.links = _canvasData.links.filter(l => l.id !== linkId);
    renderCanvasLinks(_canvasData.links, _canvasData.nodes);
    toast('Connection removed');
  } catch (e) {
    toast('Delete failed: ' + e.message, 'err');
  }
}

// ── Position save (debounced) ─────────────────────────────────────────────────

function saveNodePosition(nodeId, x, y) {
  clearTimeout(_posTimers[nodeId]);
  _posTimers[nodeId] = setTimeout(async () => {
    try {
      await apiFetch('/api/canvas/nodes/' + nodeId + '/position', {
        method: 'PATCH',
        body: JSON.stringify({ x, y }),
      });
    } catch (e) {
      console.warn('Position save failed:', e.message);
    }
  }, 600);
}

// ── Context menus ─────────────────────────────────────────────────────────────

function showCanvasCtxMenu(screenX, screenY) {
  const menu = document.getElementById('canvas-ctx-menu');
  menu.style.left = screenX + 'px';
  menu.style.top  = screenY + 'px';
  menu.classList.remove('hidden');
  document.getElementById('node-ctx-menu').classList.add('hidden');
}

function showNodeCtxMenu(screenX, screenY) {
  const menu = document.getElementById('node-ctx-menu');
  menu.style.left = screenX + 'px';
  menu.style.top  = screenY + 'px';
  menu.classList.remove('hidden');
  document.getElementById('canvas-ctx-menu').classList.add('hidden');
}

async function ctxNewNode() {
  document.getElementById('canvas-ctx-menu').classList.add('hidden');
  const x = _ctxPos.x;
  const y = _ctxPos.y;
  try {
    const node = await apiFetch('/api/nodes', {
      method: 'POST',
      body: JSON.stringify({ type: 'note', title: 'Untitled', content: '', metadata: { canvas_x: x, canvas_y: y }, tags: [] }),
    });
    // Save position
    await apiFetch('/api/canvas/nodes/' + node.id + '/position', {
      method: 'PATCH',
      body: JSON.stringify({ x, y }),
    });
    _canvasData.nodes.push({ ...node, x, y });
    renderCanvas();
    toast('Note created — click it to edit in Library');
  } catch (e) {
    toast('Failed: ' + e.message, 'err');
  }
}

function nctxEdit() {
  document.getElementById('node-ctx-menu').classList.add('hidden');
  if (!_ctxNodeId) return;
  switchTab('library');
  openNodeById(_ctxNodeId);
}

async function nctxDelete() {
  document.getElementById('node-ctx-menu').classList.add('hidden');
  if (!_ctxNodeId) return;
  if (!confirm('Delete this note permanently?')) return;
  try {
    await apiFetch('/api/nodes/' + _ctxNodeId, { method: 'DELETE' });
    _canvasData.nodes = _canvasData.nodes.filter(n => n.id !== _ctxNodeId);
    _canvasData.links = _canvasData.links.filter(l => l.source !== _ctxNodeId && l.target !== _ctxNodeId);
    renderCanvas();
    await loadLibrary();
    toast('Note deleted.');
  } catch (e) {
    toast('Delete failed: ' + e.message, 'err');
  }
}

// ── Canvas toolbar actions ────────────────────────────────────────────────────

async function canvasAddNode() {
  // Place at center of current viewport
  const svgEl = document.getElementById('canvas-svg');
  const cx = svgEl.clientWidth / 2;
  const cy = svgEl.clientHeight / 2;
  const pos = svgToCanvas(cx, cy);
  _ctxPos = pos;
  await ctxNewNode();
}

async function canvasAutoLayout() {
  if (!confirm('Reset all canvas positions to a grid layout?')) return;
  try {
    const btn = document.querySelector('[onclick="canvasAutoLayout()"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Laying out…'; }
    await apiFetch('/api/canvas/auto-layout', { method: 'POST' });
    await loadCanvas();
    toast('Canvas auto-laid out.');
  } catch (e) {
    toast('Auto-layout failed: ' + e.message, 'err');
  } finally {
    const btn = document.querySelector('[onclick="canvasAutoLayout()"]');
    if (btn) { btn.disabled = false; btn.textContent = 'Auto Layout'; }
  }
}

// ── AI Co-editor ──────────────────────────────────────────────────────────────

const AI_ACTION_LABELS = {
  expand: 'Expand',
  summarize: 'Summarize',
  rewrite: 'Rewrite',
  extract_tasks: 'Extract Tasks',
  find_related: 'Find Related',
};

async function aiAction(action) {
  if (!_activeNodeId) { toast('Save the note first before using AI actions.', 'err'); return; }

  // Sync block editor → textarea before reading content
  const ta = document.getElementById('node-content');
  if (_editorMode === 'block' && _editor) {
    try {
      const editorData = await _editor.save();
      ta.value = blocksToMarkdown(editorData.blocks);
    } catch (e) { /* fallback to existing textarea value */ }
  }

  // Get selection from textarea (block editor doesn't expose selection)
  const selection = ta ? ta.value.substring(ta.selectionStart, ta.selectionEnd).trim() : '';

  const btnEl = document.querySelector(`.btn-ai[onclick="aiAction('${action}')"]`);
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = '…'; }

  try {
    const body = { action };
    if (selection) body.selection = selection;

    const data = await apiFetch('/api/nodes/' + _activeNodeId + '/ai', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    _aiAction = action;
    _aiResult = data.result || '';

    if (action === 'find_related') {
      showRelatedModal(data.related_nodes || []);
    } else {
      showAiModal(action, data.result || '');
    }
  } catch (e) {
    toast('AI action failed: ' + e.message, 'err');
  } finally {
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = AI_ACTION_LABELS[action] || action; }
  }
}

function showAiModal(action, result) {
  document.getElementById('ai-modal-title').textContent = '✦ ' + (AI_ACTION_LABELS[action] || action);
  const resultEl = document.getElementById('ai-modal-result');
  // Simple markdown display
  resultEl.innerHTML = '<pre style="white-space:pre-wrap;font-family:inherit;font-size:13px;">' + esc(result) + '</pre>';

  // Only show Apply for content-modifying actions
  const applyBtn = document.getElementById('ai-modal-apply');
  const contentActions = new Set(['expand', 'summarize', 'rewrite', 'extract_tasks']);
  if (applyBtn) applyBtn.style.display = contentActions.has(action) ? '' : 'none';

  document.getElementById('ai-modal').classList.remove('hidden');
}

function closeAiModal() {
  document.getElementById('ai-modal').classList.add('hidden');
  _aiResult = null;
  _aiAction = null;
}

function applyAiResult() {
  if (!_aiResult) return;
  const ta = document.getElementById('node-content');
  if (!ta) return;

  const start = ta.selectionStart;
  const end   = ta.selectionEnd;
  const selected = ta.value.substring(start, end).trim();

  if (selected && start !== end) {
    // Replace selection
    ta.value = ta.value.substring(0, start) + _aiResult + ta.value.substring(end);
  } else if (_aiAction === 'summarize' || _aiAction === 'extract_tasks') {
    // Append at end
    ta.value = ta.value.trimEnd() + '\n\n' + _aiResult;
  } else {
    // Replace full content
    ta.value = _aiResult;
  }

  // Sync textarea → block editor if in block mode
  if (_editorMode === 'block' && _editor) {
    const blocks = markdownToBlocks(ta.value);
    _editor.render({ blocks }).catch(() => {});
  }

  markDirty();
  if (_previewMode) renderPreview();
  updateWordCount();
  closeAiModal();
  toast('Applied!');
}

function showRelatedModal(nodes) {
  const list = document.getElementById('related-list');
  if (!nodes.length) {
    list.innerHTML = '<p style="color:var(--text-muted);padding:12px;">No closely related notes found yet. Add more notes to grow your graph!</p>';
  } else {
    list.innerHTML = nodes.map(n =>
      `<div class="related-item" onclick="openNodeFromRelated('${n.id}')">
        <span class="type-badge badge-${n.type}">${n.type}</span>
        <span>${esc(n.title || 'Untitled')}</span>
      </div>`
    ).join('');
  }
  document.getElementById('related-modal').classList.remove('hidden');
}

function openNodeFromRelated(id) {
  document.getElementById('related-modal').classList.add('hidden');
  switchTab('library');
  openNodeById(id);
}

// ── Research Tab ──────────────────────────────────────────────────────────────

let _researchSessions = [];
let _researchPollers  = {};  // session_id → interval

async function loadResearch() {
  try {
    const data = await apiFetch('/api/research');
    _researchSessions = data.sessions || [];
    renderResearch();
  } catch (e) {
    console.error('Research load error:', e);
  }
}

function renderResearch() {
  const list = document.getElementById('research-list');
  if (!_researchSessions.length) {
    list.innerHTML = '<div class="research-empty">No research sessions yet — try one above!</div>';
    return;
  }

  list.innerHTML = _researchSessions.map(s => {
    const date = new Date(s.created_at).toLocaleString();
    let statusHtml = '';
    if (s.status === 'pending' || s.status === 'running') {
      statusHtml = `<span class="research-status status-running"><span class="spinner-sm"></span>${s.status === 'running' ? 'Synthesizing…' : 'Starting…'}</span>`;
    } else if (s.status === 'done') {
      statusHtml = `<span class="research-status status-complete">✓ Complete</span>`;
    } else {
      const errTip = s.error_message ? ` title="${esc(s.error_message)}"` : '';
      statusHtml = `<span class="research-status status-failed"${errTip}>✗ Failed${s.error_message ? ' — hover for details' : ''}</span>`;
    }

    const openBtn = s.status === 'done' && s.result_node
      ? `<button class="btn-open-research" onclick="openResearchNode('${s.result_node}')">Open Note</button>`
      : '';
    const deleteBtn = (s.status !== 'running')
      ? `<button class="btn-dismiss-research" onclick="deleteResearch('${s.id}')">✕</button>`
      : '';

    return `<div class="research-session" data-id="${s.id}">
      <div class="research-session-top">
        <span class="research-query-text">${esc(s.query)}</span>
        ${deleteBtn}
      </div>
      <div class="research-session-meta">
        ${statusHtml}
        <span class="research-date">${date}</span>
        ${openBtn}
      </div>
    </div>`;
  }).join('');

  // Start polling for running/pending sessions
  _researchSessions.forEach(s => {
    if ((s.status === 'pending' || s.status === 'running') && !_researchPollers[s.id]) {
      _researchPollers[s.id] = setInterval(() => pollResearch(s.id), 3000);
    }
  });

  // Load related notes for completed sessions (async, non-blocking)
  setTimeout(() => {
    _researchSessions.forEach(s => {
      if (s.status === 'done' && s.result_node) {
        const el = list.querySelector(`.research-session[data-id="${s.id}"]`);
        if (el) loadResearchSuggestions(s.result_node, el);
      }
    });
  }, 200);
}

async function pollResearch(sessionId) {
  try {
    const s = await apiFetch('/api/research/' + sessionId);
    const idx = _researchSessions.findIndex(r => r.id === sessionId);
    if (idx !== -1) _researchSessions[idx] = s;

    if (s.status === 'done' || s.status === 'failed') {
      clearInterval(_researchPollers[sessionId]);
      delete _researchPollers[sessionId];
      if (s.status === 'done') {
        toast('Research complete! "' + s.query.slice(0, 40) + '"', 'ok');
        await loadLibrary();  // refresh library so the new note appears
      }
    }
    renderResearch();
  } catch (e) {
    clearInterval(_researchPollers[sessionId]);
    delete _researchPollers[sessionId];
  }
}

async function startResearch() {
  const query = document.getElementById('research-query').value.trim();
  const scope  = document.getElementById('research-scope').value.trim();
  if (!query) { toast('Enter a research topic first.', 'err'); return; }

  const btn = document.getElementById('btn-research');
  btn.disabled = true;
  btn.textContent = 'Starting…';

  try {
    const body = { query };
    if (scope) body.scope = scope;
    const session = await apiFetch('/api/research', { method: 'POST', body: JSON.stringify(body) });
    _researchSessions.unshift(session);
    document.getElementById('research-query').value = '';
    document.getElementById('research-scope').value = '';
    renderResearch();
    toast('Research started — synthesizing…');
  } catch (e) {
    toast('Research failed: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Research';
  }
}

function openResearchNode(nodeId) {
  switchTab('library');
  openNodeById(nodeId);
}

async function deleteResearch(sessionId) {
  try {
    await apiFetch('/api/research/' + sessionId, { method: 'DELETE' });
    _researchSessions = _researchSessions.filter(s => s.id !== sessionId);
    if (_researchPollers[sessionId]) {
      clearInterval(_researchPollers[sessionId]);
      delete _researchPollers[sessionId];
    }
    renderResearch();
  } catch (e) {
    toast('Delete failed: ' + e.message, 'err');
  }
}

// ── Block Editor (Phase 6) ────────────────────────────────────────────────────

function initBlockEditor() {
  const holder = document.getElementById('editor-block');
  if (!holder || typeof EditorJS === 'undefined') return;

  _editor = new EditorJS({
    holder: 'editor-block',
    placeholder: 'Write here… or press / for commands',
    autofocus: false,
    tools: {
      header:    { class: Header,    inlineToolbar: true, config: { levels: [2, 3], defaultLevel: 2 } },
      list:      { class: List,      inlineToolbar: true, config: { defaultStyle: 'unordered' } },
      checklist: { class: Checklist, inlineToolbar: true },
      code:      { class: CodeTool },
      quote:     { class: Quote,     inlineToolbar: true },
      delimiter: { class: Delimiter },
    },
    onChange: () => markDirty(),
  });
}

function toggleEditorMode() {
  const blockEl = document.getElementById('editor-block');
  const taEl    = document.getElementById('node-content');
  const btn     = document.getElementById('btn-mode');

  if (_editorMode === 'block') {
    // Switch to markdown
    _editorMode = 'markdown';
    if (btn) { btn.textContent = '# MD'; btn.classList.add('active'); }
    if (blockEl) blockEl.classList.add('hidden');
    if (taEl) taEl.classList.remove('hidden');
    // Sync textarea from block editor
    if (_editor) {
      _editor.save().then(data => {
        taEl.value = blocksToMarkdown(data.blocks);
      }).catch(() => {});
    }
  } else {
    // Switch to block
    _editorMode = 'block';
    if (btn) { btn.textContent = '⬚ Blocks'; btn.classList.remove('active'); }
    if (taEl) taEl.classList.add('hidden');
    if (blockEl) blockEl.classList.remove('hidden');
    // Sync block editor from textarea
    if (_editor && taEl) {
      const blocks = markdownToBlocks(taEl.value);
      _editor.render({ blocks }).catch(() => {});
    }
  }
}

function markdownToBlocks(md) {
  if (!md || !md.trim()) return [{ type: 'paragraph', data: { text: '' } }];
  const lines = md.split('\n');
  const blocks = [];
  let codeBuffer = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block
    if (line.startsWith('```')) {
      if (codeBuffer !== null) {
        blocks.push({ type: 'code', data: { code: codeBuffer } });
        codeBuffer = null;
      } else {
        codeBuffer = '';
      }
      continue;
    }
    if (codeBuffer !== null) { codeBuffer += (codeBuffer ? '\n' : '') + line; continue; }

    // Delimiter
    if (/^---+$/.test(line.trim())) { blocks.push({ type: 'delimiter', data: {} }); continue; }

    // Headers
    const h2 = line.match(/^## (.+)/);
    if (h2) { blocks.push({ type: 'header', data: { text: h2[1], level: 2 } }); continue; }
    const h3 = line.match(/^### (.+)/);
    if (h3) { blocks.push({ type: 'header', data: { text: h3[1], level: 3 } }); continue; }
    const h1 = line.match(/^# (.+)/);
    if (h1) { blocks.push({ type: 'header', data: { text: h1[1], level: 2 } }); continue; }

    // Blockquote
    const bq = line.match(/^> (.+)/);
    if (bq) { blocks.push({ type: 'quote', data: { text: bq[1], caption: '', alignment: 'left' } }); continue; }

    // Checklist item
    const cl = line.match(/^- \[(x| )\] (.+)/i);
    if (cl) {
      // Aggregate into checklist block
      const items = [{ text: cl[2], checked: cl[1].toLowerCase() === 'x' }];
      while (i + 1 < lines.length && /^- \[(x| )\] /i.test(lines[i + 1])) {
        i++;
        const m = lines[i].match(/^- \[(x| )\] (.+)/i);
        if (m) items.push({ text: m[2], checked: m[1].toLowerCase() === 'x' });
      }
      blocks.push({ type: 'checklist', data: { items } });
      continue;
    }

    // List item (aggregate)
    if (/^[-*] /.test(line)) {
      const items = [line.replace(/^[-*] /, '')];
      while (i + 1 < lines.length && /^[-*] /.test(lines[i + 1])) {
        i++;
        items.push(lines[i].replace(/^[-*] /, ''));
      }
      blocks.push({ type: 'list', data: { style: 'unordered', items } });
      continue;
    }
    if (/^\d+\. /.test(line)) {
      const items = [line.replace(/^\d+\. /, '')];
      while (i + 1 < lines.length && /^\d+\. /.test(lines[i + 1])) {
        i++;
        items.push(lines[i].replace(/^\d+\. /, ''));
      }
      blocks.push({ type: 'list', data: { style: 'ordered', items } });
      continue;
    }

    // Skip blank lines
    if (!line.trim()) continue;

    // Paragraph
    blocks.push({ type: 'paragraph', data: { text: line } });
  }

  return blocks.length ? blocks : [{ type: 'paragraph', data: { text: '' } }];
}

function blocksToMarkdown(blocks) {
  if (!blocks || !blocks.length) return '';
  return blocks.map(b => {
    switch (b.type) {
      case 'header':
        return '#'.repeat(b.data.level || 2) + ' ' + (b.data.text || '');
      case 'paragraph':
        return b.data.text || '';
      case 'list':
        return (b.data.items || []).map((it, idx) =>
          b.data.style === 'ordered' ? `${idx + 1}. ${it}` : `- ${it}`
        ).join('\n');
      case 'checklist':
        return (b.data.items || []).map(it =>
          `- [${it.checked ? 'x' : ' '}] ${it.text}`
        ).join('\n');
      case 'code':
        return '```\n' + (b.data.code || '') + '\n```';
      case 'quote':
        return '> ' + (b.data.text || '');
      case 'delimiter':
        return '---';
      default:
        return b.data?.text || '';
    }
  }).join('\n\n');
}

// ── Snapshot Drawer (Phase 6) ─────────────────────────────────────────────────

function toggleSnapshotDrawer() {
  _snapshotDrawerOpen = !_snapshotDrawerOpen;
  const drawer = document.getElementById('snapshot-drawer');
  if (!drawer) return;
  drawer.classList.toggle('hidden', !_snapshotDrawerOpen);
  if (_snapshotDrawerOpen && _activeNodeId) {
    loadSnapshots(_activeNodeId);
  }
}

async function loadSnapshots(nodeId) {
  const list = document.getElementById('snapshot-list');
  if (!list) return;
  list.innerHTML = '<div class="snapshot-empty">Loading…</div>';
  try {
    const data = await apiFetch('/api/nodes/' + nodeId + '/snapshots');
    const snaps = data.snapshots || [];
    if (!snaps.length) {
      list.innerHTML = '<div class="snapshot-empty">No snapshots yet. Snapshots are created automatically each time you save.</div>';
      return;
    }
    list.innerHTML = snaps.map(s => {
      const dt = new Date(s.created_at).toLocaleString();
      return `<div class="snapshot-item" data-id="${s.id}" onclick="previewSnapshot('${s.id}')">
        <span>${dt}</span>
        <button class="snapshot-item-del" onclick="deleteSnapshotItem(event,'${s.id}')">✕</button>
      </div>`;
    }).join('');
  } catch (e) {
    list.innerHTML = '<div class="snapshot-empty">Failed to load snapshots.</div>';
  }
}

async function previewSnapshot(snapshotId) {
  if (!_activeNodeId) return;
  // Highlight selected
  document.querySelectorAll('.snapshot-item').forEach(el =>
    el.classList.toggle('active', el.dataset.id === snapshotId)
  );
  try {
    const snap = await apiFetch('/api/nodes/' + _activeNodeId + '/snapshots/' + snapshotId);
    _activeSnapshotId = snapshotId;
    _activeSnapshotContent = snap.content || '';
    const previewEl = document.getElementById('snapshot-preview');
    if (previewEl) previewEl.classList.remove('hidden');
    const dateEl = document.getElementById('snapshot-preview-date');
    if (dateEl) dateEl.textContent = new Date(snap.created_at).toLocaleString();
    const contentEl = document.getElementById('snapshot-preview-content');
    if (contentEl) contentEl.textContent = snap.content || '';
  } catch (e) {
    toast('Failed to load snapshot: ' + e.message, 'err');
  }
}

function restoreSnapshot() {
  if (!_activeSnapshotContent) return;
  if (!confirm('Restore this version? Current content will be replaced (unsaved changes will be lost).')) return;
  const ta = document.getElementById('node-content');
  if (ta) ta.value = _activeSnapshotContent;
  if (_editorMode === 'block' && _editor) {
    const blocks = markdownToBlocks(_activeSnapshotContent);
    _editor.render({ blocks }).catch(() => {});
  }
  markDirty();
  toggleSnapshotDrawer();
  toast('Snapshot restored — save to apply.');
}

async function deleteSnapshotItem(e, snapshotId) {
  e.stopPropagation();
  if (!_activeNodeId) return;
  if (!confirm('Delete this snapshot?')) return;
  try {
    await apiFetch('/api/nodes/' + _activeNodeId + '/snapshots/' + snapshotId, { method: 'DELETE' });
    if (_activeSnapshotId === snapshotId) {
      _activeSnapshotId = null;
      _activeSnapshotContent = null;
      const previewEl = document.getElementById('snapshot-preview');
      if (previewEl) previewEl.classList.add('hidden');
    }
    loadSnapshots(_activeNodeId);
    toast('Snapshot deleted.');
  } catch (e) {
    toast('Delete failed: ' + e.message, 'err');
  }
}

// ── Canvas Label Modal (Phase 6) ──────────────────────────────────────────────

function showCanvasLabelModal(srcId, tgtId) {
  _pendingLinkSrc = srcId;
  _pendingLinkTgt = tgtId;
  const modal = document.getElementById('canvas-label-modal');
  const input = document.getElementById('canvas-link-label');
  if (input) input.value = '';
  if (modal) modal.classList.remove('hidden');
}

function cancelCanvasLink() {
  _pendingLinkSrc = null;
  _pendingLinkTgt = null;
  const modal = document.getElementById('canvas-label-modal');
  if (modal) modal.classList.add('hidden');
}

async function confirmCanvasLink() {
  const label = (document.getElementById('canvas-link-label')?.value || '').trim();
  const src = _pendingLinkSrc;
  const tgt = _pendingLinkTgt;
  cancelCanvasLink();
  if (src && tgt) {
    await createCanvasLink(src, tgt, label);
  }
}

async function suggestCanvasLabel() {
  if (!_pendingLinkSrc || !_pendingLinkTgt) return;
  const btn = document.getElementById('btn-suggest-label');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const data = await apiFetch('/api/canvas/suggest-label', {
      method: 'POST',
      body: JSON.stringify({ source_id: _pendingLinkSrc, target_id: _pendingLinkTgt }),
    });
    const input = document.getElementById('canvas-link-label');
    if (input && data.suggested_label) input.value = data.suggested_label;
  } catch (e) {
    toast('Suggest failed: ' + e.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✦ Suggest'; }
  }
}

// ── Agent Scheduler UI (Phase 6) ──────────────────────────────────────────────

let _scheduleData = {};

async function loadSchedule() {
  try {
    const data = await apiFetch('/api/admin/schedule');
    _scheduleData = data;
    renderSchedule();
    const panel = document.getElementById('schedule-panel');
    if (panel) panel.classList.remove('hidden');
  } catch (e) {
    // Not admin — panel stays hidden
  }
}

function renderSchedule() {
  for (const agent of ['curator', 'linker']) {
    const cfg = _scheduleData[agent] || {};
    const enEl   = document.getElementById(agent + '-enabled');
    const cronEl = document.getElementById(agent + '-cron');
    if (enEl)   enEl.checked = !!cfg.enabled;
    if (cronEl) cronEl.value = cfg.cron_expr || (agent === 'linker' ? '0 8 * * 1' : '0 9 * * *');
  }
  _scheduleDirty = false;
  const saveBtn = document.getElementById('btn-save-schedule');
  if (saveBtn) saveBtn.disabled = true;
}

function scheduleChanged() {
  _scheduleDirty = true;
  const saveBtn = document.getElementById('btn-save-schedule');
  if (saveBtn) saveBtn.disabled = false;
}

async function saveSchedule() {
  const body = {
    curator_enabled: document.getElementById('curator-enabled')?.checked,
    curator_cron:    document.getElementById('curator-cron')?.value || '0 9 * * *',
    linker_enabled:  document.getElementById('linker-enabled')?.checked,
    linker_cron:     document.getElementById('linker-cron')?.value || '0 8 * * 1',
  };
  try {
    await apiFetch('/api/admin/schedule', { method: 'PATCH', body: JSON.stringify(body) });
    _scheduleDirty = false;
    const saveBtn = document.getElementById('btn-save-schedule');
    if (saveBtn) saveBtn.disabled = true;
    toast('Schedule saved.');
  } catch (e) {
    toast('Save failed: ' + e.message, 'err');
  }
}

async function runAgentNow(agent) {
  if (!confirm('Run ' + agent + ' now?')) return;
  try {
    await apiFetch('/api/admin/schedule/run/' + agent, { method: 'POST' });
    toast(agent + ' triggered — check reports/ for output.');
  } catch (e) {
    toast('Trigger failed: ' + e.message, 'err');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SMART SUGGESTIONS ENGINE
// ══════════════════════════════════════════════════════════════════════════════

let _suggestionsCache = {};   // node_id → {suggestions, ts}
let _pendingSugPopover = null; // {suggestion_id, source} for popover actions
let _graphSuggestions = [];   // for graph overlay
let _canvasSuggestions = [];  // for canvas overlay

// ── Score badge helper ───────────────────────────────────────────────────────
function scoreBadgeHtml(score) {
  const pct = Math.round(score * 100);
  let cls = 'score-low';
  if (score >= 0.7) cls = 'score-high';
  else if (score >= 0.4) cls = 'score-medium';
  return `<span class="score-badge ${cls}">${pct}%</span>`;
}

// ── Suggestion card HTML ─────────────────────────────────────────────────────
function suggestionCardHtml(sug, opts = {}) {
  const title = esc(sug.target_title || 'Untitled');
  const reason = esc(sug.reason || '');
  const badge = scoreBadgeHtml(sug.score);
  const typeBadge = sug.target_type ? `<span class="type-badge badge-${sug.target_type}">${sug.target_type}</span>` : '';
  const acceptBtn = opts.hideActions ? '' : `<button class="btn-sug-accept" onclick="event.stopPropagation(); acceptSuggestion('${sug.id}')" title="Accept — create link">✓</button>`;
  const dismissBtn = opts.hideActions ? '' : `<button class="btn-sug-dismiss" onclick="event.stopPropagation(); dismissSuggestion('${sug.id}')" title="Dismiss">✕</button>`;
  const clickAction = sug.target_id ? `onclick="openNodeFromSuggestion('${sug.target_id}')"` : '';

  return `<div class="suggestion-card" ${clickAction}>
    ${typeBadge}
    <div class="suggestion-card-info">
      <div class="suggestion-card-title">${title}</div>
      ${reason ? `<div class="suggestion-card-reason">${reason}</div>` : ''}
    </div>
    ${badge}
    <div class="suggestion-actions">${acceptBtn}${dismissBtn}</div>
  </div>`;
}

function openNodeFromSuggestion(id) {
  switchTab('library');
  openNodeById(id);
}

// ── Library tab: Related Notes sidebar ───────────────────────────────────────

function renderRelatedSidebar(suggestions) {
  let sidebar = document.getElementById('related-sidebar');
  if (!sidebar) {
    // Create sidebar container below the editor form
    sidebar = document.createElement('div');
    sidebar.id = 'related-sidebar';
    sidebar.className = 'related-sidebar';
    const editorSection = document.querySelector('.lib-editor');
    if (editorSection) editorSection.appendChild(sidebar);
  }

  if (!suggestions || !suggestions.length) {
    sidebar.innerHTML = `
      <div class="related-sidebar-header">
        <h4>Related Notes</h4>
        <button class="btn-find-related" id="btn-find-related" onclick="findRelatedForActive()">✦ Find Related</button>
      </div>
      <div style="color:var(--text-muted);font-size:12px;padding:8px 0;">No suggestions yet. Click "Find Related" to discover connections.</div>`;
    return;
  }

  sidebar.innerHTML = `
    <div class="related-sidebar-header">
      <h4>Related Notes</h4>
      <button class="btn-find-related" onclick="findRelatedForActive()">✦ Refresh</button>
    </div>
    ${suggestions.map(s => suggestionCardHtml(s)).join('')}`;
}

async function findRelatedForActive() {
  if (!_activeNodeId) return;
  const btn = document.getElementById('btn-find-related');
  if (btn) { btn.disabled = true; btn.textContent = 'Finding…'; }

  try {
    const data = await apiFetch('/api/suggestions', {
      method: 'POST',
      body: JSON.stringify({ node_id: _activeNodeId }),
    });
    _suggestionsCache[_activeNodeId] = { suggestions: data.suggestions, ts: Date.now() };
    renderRelatedSidebar(data.suggestions);
  } catch (e) {
    toast('Suggestions failed: ' + e.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✦ Find Related'; }
  }
}

async function loadRelatedForNode(nodeId) {
  // Check memory cache first (5 min)
  const cached = _suggestionsCache[nodeId];
  if (cached && (Date.now() - cached.ts) < 300000) {
    renderRelatedSidebar(cached.suggestions);
    return;
  }

  try {
    const data = await apiFetch('/api/suggestions/for/' + nodeId);
    _suggestionsCache[nodeId] = { suggestions: data.suggestions, ts: Date.now() };
    renderRelatedSidebar(data.suggestions);
  } catch (e) {
    renderRelatedSidebar([]);
  }
}

// ── Accept / Dismiss suggestions ─────────────────────────────────────────────

async function acceptSuggestion(suggestionId) {
  try {
    await apiFetch('/api/suggestions/accept', {
      method: 'POST',
      body: JSON.stringify({ suggestion_id: suggestionId }),
    });
    toast('Link created!');
    // Refresh related sidebar
    if (_activeNodeId) {
      delete _suggestionsCache[_activeNodeId];
      loadRelatedForNode(_activeNodeId);
    }
    // Refresh graph if visible
    if (_activeTab === 'graph') renderGraph();
  } catch (e) {
    toast('Accept failed: ' + e.message, 'err');
  }
}

async function dismissSuggestion(suggestionId) {
  try {
    await apiFetch('/api/suggestions/dismiss', {
      method: 'POST',
      body: JSON.stringify({ suggestion_id: suggestionId }),
    });
    // Remove from local UI
    if (_activeNodeId) {
      const cached = _suggestionsCache[_activeNodeId];
      if (cached) {
        cached.suggestions = cached.suggestions.filter(s => s.id !== suggestionId);
        renderRelatedSidebar(cached.suggestions);
      }
    }
  } catch (e) {
    toast('Dismiss failed: ' + e.message, 'err');
  }
}

// ── Graph tab: Suggestion overlay ────────────────────────────────────────────

async function loadGraphSuggestions() {
  try {
    const data = await apiFetch('/api/suggestions/pending');
    _graphSuggestions = data.suggestions || [];
  } catch (e) {
    _graphSuggestions = [];
  }
}

function drawSuggestionOverlay(gGroup, nodes, simulation) {
  if (!_graphSuggestions.length) return;

  const nodeMap = {};
  nodes.forEach(n => { nodeMap[n.id] = n; });

  // Draw dashed amber lines for pending suggestions
  const sugGroup = gGroup.append('g').attr('class', 'suggestion-overlay');

  _graphSuggestions.forEach(sug => {
    const s = nodeMap[sug.source_id];
    const t = nodeMap[sug.target_id];
    if (!s || !t) return;

    const line = sugGroup.append('line')
      .attr('class', 'suggestion-link-graph')
      .attr('stroke-width', 1 + sug.score * 2)
      .style('cursor', 'pointer');

    // Store data for tick updates
    line.datum({ source: s, target: t, suggestion: sug });

    // Click to show accept/dismiss popover
    line.on('click', function(event) {
      event.stopPropagation();
      showSugPopover(event.pageX, event.pageY, sug);
    });
  });

  // Update positions on tick
  simulation.on('tick.suggestions', () => {
    sugGroup.selectAll('line')
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);
  });
}

function drawOrphanHighlights(gGroup, nodes, links) {
  // Find nodes with 0 confirmed links
  const connected = new Set();
  links.forEach(l => {
    const sid = typeof l.source === 'object' ? l.source.id : l.source;
    const tid = typeof l.target === 'object' ? l.target.id : l.target;
    connected.add(sid);
    connected.add(tid);
  });

  const nodeMap = {};
  nodes.forEach(n => { nodeMap[n.id] = n; });

  const orphans = nodes.filter(n => !connected.has(n.id));
  if (!orphans.length) return;

  const orphanGroup = gGroup.append('g').attr('class', 'orphan-highlights');
  orphans.forEach(n => {
    orphanGroup.append('circle')
      .attr('r', 12)
      .attr('class', 'orphan-ring')
      .datum(n);
  });

  // Return updater for tick
  return () => {
    orphanGroup.selectAll('circle')
      .attr('cx', d => d.x)
      .attr('cy', d => d.y);
  };
}

function drawDeadEndHighlights(gGroup, deadEndNodes) {
  if (!deadEndNodes.length) return null;
  const deGroup = gGroup.append('g').attr('class', 'deadend-highlights');
  deadEndNodes.forEach(n => {
    deGroup.append('circle')
      .attr('r', 11)
      .attr('class', 'deadend-ring')
      .datum(n);
  });
  return () => {
    deGroup.selectAll('circle')
      .attr('cx', d => d.x)
      .attr('cy', d => d.y);
  };
}

function toggleGraphLegend() {
  const legend = document.getElementById('graph-legend');
  if (legend) legend.classList.toggle('hidden');
}

// ── Relationship modal ───────────────────────────────────────────────────────

function openRelModal(sourceNode) {
  document.getElementById('rel-source-label').value = sourceNode.title || 'Untitled';
  document.getElementById('rel-source-id').value = sourceNode.id;
  document.getElementById('rel-target-id').value = '';
  document.getElementById('rel-target-search').value = '';
  document.getElementById('rel-label').value = '';
  document.getElementById('rel-strength').value = '0.7';
  document.getElementById('rel-strength-val').textContent = '0.7';
  const radios = document.querySelectorAll('input[name="rel-type"]');
  radios.forEach(r => { r.checked = r.value === 'related'; });
  document.getElementById('rel-target-list').classList.remove('open');
  document.getElementById('rel-modal').classList.remove('hidden');
}

function closeRelModal() {
  document.getElementById('rel-modal').classList.add('hidden');
}

function filterRelTargets(query) {
  const list = document.getElementById('rel-target-list');
  const sourceId = document.getElementById('rel-source-id').value;
  if (!query || query.length < 2) { list.classList.remove('open'); return; }

  const q = query.toLowerCase();
  const matches = (_graphData?.nodes || [])
    .filter(n => n.id !== sourceId && (n.title || '').toLowerCase().includes(q))
    .slice(0, 10);

  if (!matches.length) { list.classList.remove('open'); return; }

  list.innerHTML = matches.map(n =>
    '<div class="rel-target-item" onclick="selectRelTarget(\'' + n.id + '\', \'' + esc(n.title || 'Untitled').replace(/'/g, "\\'") + '\')">' +
    esc(n.title || 'Untitled') + '</div>'
  ).join('');
  list.classList.add('open');
}

function selectRelTarget(id, title) {
  document.getElementById('rel-target-id').value = id;
  document.getElementById('rel-target-search').value = title;
  document.getElementById('rel-target-list').classList.remove('open');
}

async function submitRelationship() {
  const sourceId = document.getElementById('rel-source-id').value;
  const targetId = document.getElementById('rel-target-id').value;
  const linkType = document.querySelector('input[name="rel-type"]:checked')?.value || 'related';
  const label = document.getElementById('rel-label').value.trim();
  const strength = parseFloat(document.getElementById('rel-strength').value) || 0.7;

  if (!sourceId || !targetId) {
    toast('Select a target node.', 'err');
    return;
  }

  const btn = document.getElementById('btn-rel-create');
  btn.disabled = true;
  btn.textContent = 'Creating...';

  try {
    await apiFetch('/api/relationships', {
      method: 'POST',
      body: JSON.stringify({ source_id: sourceId, target_id: targetId, link_type: linkType, label, strength }),
    });
    toast('Relationship created!');
    closeRelModal();
    await renderGraph();
  } catch (e) {
    toast('Failed: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create';
  }
}

async function autoSuggestGraph() {
  const btn = document.getElementById('btn-auto-suggest');
  if (btn) { btn.disabled = true; btn.textContent = 'Suggesting…'; }

  try {
    // Get the top 10 most-recently-edited nodes
    if (!_graphData || !_graphData.nodes) {
      toast('Load the graph first.', 'err');
      return;
    }
    const topNodes = _graphData.nodes.slice(0, 10);
    let totalNew = 0;

    for (const node of topNodes) {
      try {
        const data = await apiFetch('/api/suggestions', {
          method: 'POST',
          body: JSON.stringify({ node_id: node.id }),
        });
        totalNew += (data.suggestions || []).length;
      } catch (e) {
        // skip individual failures
      }
    }

    toast(`Generated suggestions for ${topNodes.length} nodes (${totalNew} total suggestions).`);
    await renderGraph(); // re-render with new suggestions
  } catch (e) {
    toast('Auto-suggest failed: ' + e.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✦ Auto-Suggest'; }
  }
}

// ── Graph popover (right-click node info) ────────────────────────────────────

async function showGraphNodePopover(event, nodeData) {
  const popover = document.getElementById('graph-popover');
  if (!popover) return;

  // Count connections grouped by type
  const nodeLinks = (_graphData?.links || []).filter(
    l => l.source === nodeData.id || l.target === nodeData.id ||
         l.source?.id === nodeData.id || l.target?.id === nodeData.id
  );
  const linkCount = nodeLinks.length;
  const typeCounts = {};
  let userCount = 0, aiCount = 0;
  nodeLinks.forEach(l => {
    const t = l.type || 'related';
    typeCounts[t] = (typeCounts[t] || 0) + 1;
    if (l.created_by === 'suggestion' || l.created_by === 'agent') aiCount++;
    else userCount++;
  });

  // Build relationship chips HTML
  const linkTypeColor = {
    related: '#60a5fa', supports: '#22c55e', contradicts: '#ef4444',
    derived_from: '#a78bfa', suggested: '#f59e0b', blocks: '#f97316',
    enables: '#06b6d4', canvas_edge: '#6b7280',
  };
  const chipsHtml = Object.entries(typeCounts).map(([t, c]) =>
    '<span class="popover-rel-chip" style="border-color:' + (linkTypeColor[t] || '#6b7280') + ';color:' + (linkTypeColor[t] || '#6b7280') + '">' + c + ' ' + t + '</span>'
  ).join('');
  const provenanceHtml = linkCount > 0
    ? '<div class="popover-provenance">' + (userCount ? userCount + ' manual' : '') + (userCount && aiCount ? ' · ' : '') + (aiCount ? aiCount + ' AI' : '') + '</div>'
    : '';

  let sugHtml = '<div style="font-size:11px;color:var(--text-muted);">Loading\u2026</div>';
  popover.style.display = 'block';
  popover.style.left = (event.offsetX + 14) + 'px';
  popover.style.top = (event.offsetY + 14) + 'px';

  const typeBadge = '<span class="type-badge badge-' + nodeData.type + '">' + nodeData.type + '</span>';
  popover.innerHTML =
    '<div class="graph-popover-title">' + esc(nodeData.title || 'Untitled') + '</div>' +
    '<div class="graph-popover-meta">' + typeBadge + ' \u00b7 ' + linkCount + ' connection' + (linkCount !== 1 ? 's' : '') + '</div>' +
    (chipsHtml ? '<div class="popover-rel-counts">' + chipsHtml + '</div>' : '') +
    provenanceHtml +
    '<div class="graph-popover-suggestions" id="popover-sugs">' + sugHtml + '</div>' +
    '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">' +
      '<button class="btn-find-related" onclick="findRelatedFromPopover(\'' + nodeData.id + '\')" style="font-size:11px;">\u2726 Find Suggestions</button>' +
      '<button class="btn-find-related" onclick="openNodeFromSuggestion(\'' + nodeData.id + '\')" style="font-size:11px;">Open in Library</button>' +
      '<button class="btn-find-related" onclick="hideGraphPopover(); openRelModal({id:\'' + nodeData.id + '\', title:\'' + esc(nodeData.title || 'Untitled').replace(/'/g, "\\'") + '\'})" style="font-size:11px;">+ Relationship</button>' +
    '</div>';

  // Load suggestions
  try {
    const data = await apiFetch('/api/suggestions/for/' + nodeData.id);
    const sugs = (data.suggestions || []).slice(0, 3);
    const sugsEl = document.getElementById('popover-sugs');
    if (sugsEl) {
      if (!sugs.length) {
        sugsEl.innerHTML = '<div style="font-size:11px;color:var(--text-muted);">No suggestions yet.</div>';
      } else {
        sugsEl.innerHTML = sugs.map(s =>
          `<div class="graph-popover-sug" onclick="event.stopPropagation(); acceptSuggestion('${s.id}')">
            ${scoreBadgeHtml(s.score)}
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(s.target_title || 'Untitled')}</span>
          </div>`
        ).join('');
      }
    }
  } catch (e) {
    const sugsEl = document.getElementById('popover-sugs');
    if (sugsEl) sugsEl.innerHTML = '<div style="font-size:11px;color:var(--text-muted);">Could not load.</div>';
  }
}

async function findRelatedFromPopover(nodeId) {
  try {
    await apiFetch('/api/suggestions', {
      method: 'POST',
      body: JSON.stringify({ node_id: nodeId }),
    });
    toast('Suggestions generated!');
    await renderGraph();
  } catch (e) {
    toast('Failed: ' + e.message, 'err');
  }
}

function hideGraphPopover() {
  const popover = document.getElementById('graph-popover');
  if (popover) popover.style.display = 'none';
}

// ── Suggestion popover (shared accept/dismiss) ──────────────────────────────

function showSugPopover(x, y, sug) {
  _pendingSugPopover = sug;
  const popover = document.getElementById('sug-popover');
  if (!popover) return;

  const titleEl = document.getElementById('sug-popover-title');
  const reasonEl = document.getElementById('sug-popover-reason');
  if (titleEl) titleEl.textContent = `Score: ${Math.round(sug.score * 100)}%`;
  if (reasonEl) reasonEl.textContent = sug.reason || '';

  popover.style.display = 'block';
  popover.style.left = x + 'px';
  popover.style.top = y + 'px';
}

function hideSugPopover() {
  const popover = document.getElementById('sug-popover');
  if (popover) popover.style.display = 'none';
  _pendingSugPopover = null;
}

async function sugPopoverAccept() {
  if (!_pendingSugPopover) return;
  await acceptSuggestion(_pendingSugPopover.id);
  hideSugPopover();
}

async function sugPopoverDismiss() {
  if (!_pendingSugPopover) return;
  await dismissSuggestion(_pendingSugPopover.id);
  hideSugPopover();
}

// Close popovers on click elsewhere
document.addEventListener('click', () => {
  hideSugPopover();
  hideGraphPopover();
});

// ── Inbox tab: Related chips ─────────────────────────────────────────────────

let _inboxSugCache = {}; // content_hash → suggestions

async function loadInboxSuggestions(inboxItem, containerEl) {
  if (!_meData?.features?.ai_editor) return;
  const text = (inboxItem.content || '').trim();
  if (text.length < 20) return; // too short

  const key = inboxItem.id;
  if (_inboxSugCache[key]) {
    renderInboxChips(containerEl, _inboxSugCache[key], inboxItem.id);
    return;
  }

  try {
    const data = await apiFetch('/api/suggestions', {
      method: 'POST',
      body: JSON.stringify({ text: text.slice(0, 500), context: text.slice(0, 60) }),
    });
    const sugs = (data.suggestions || []).slice(0, 3);
    _inboxSugCache[key] = sugs;
    renderInboxChips(containerEl, sugs, inboxItem.id);
  } catch (e) {
    // Silent fail for inbox suggestions
  }
}

function renderInboxChips(containerEl, suggestions, inboxId) {
  if (!suggestions.length || !containerEl) return;
  let chipsDiv = containerEl.querySelector('.suggestion-chips');
  if (!chipsDiv) {
    chipsDiv = document.createElement('div');
    chipsDiv.className = 'suggestion-chips';
    containerEl.appendChild(chipsDiv);
  }
  chipsDiv.innerHTML = suggestions.map(s =>
    `<span class="suggestion-chip" onclick="event.stopPropagation(); promoteInboxToNode('${inboxId}', '${s.target_id}')" title="${esc(s.reason || '')}">
      Related: ${esc((s.target_title || '').slice(0, 25))}
      <span class="chip-score">${Math.round(s.score * 100)}%</span>
    </span>`
  ).join('');
}

async function promoteInboxToNode(inboxId, linkToNodeId) {
  // Promote inbox item and link to the target node
  const item = _inbox.find(i => i.id === inboxId);
  if (!item) return;

  // Auto-promote: create node from inbox content, then create link
  try {
    const node = await apiFetch('/api/nodes', {
      method: 'POST',
      body: JSON.stringify({
        title: (item.content || '').slice(0, 60),
        content: item.content,
        type: 'note',
        tags: [],
      }),
    });
    if (node.id && linkToNodeId) {
      await apiFetch('/api/canvas/links', {
        method: 'POST',
        body: JSON.stringify({
          source_id: node.id,
          target_id: linkToNodeId,
          link_type: 'suggested',
          label: 'from inbox',
        }),
      });
    }
    // Delete inbox item
    await apiFetch('/api/inbox/' + inboxId, { method: 'DELETE' });
    toast('Promoted and linked!');
    await loadInbox();
    await loadLibrary();
  } catch (e) {
    toast('Promote failed: ' + e.message, 'err');
  }
}

// ── Canvas tab: Suggest Links ────────────────────────────────────────────────

async function canvasSuggestLinks() {
  const btn = document.getElementById('btn-canvas-suggest');
  if (btn) { btn.disabled = true; btn.textContent = 'Finding…'; }

  try {
    if (!_canvasData || !_canvasData.nodes || !_canvasData.nodes.length) {
      toast('Add some notes to canvas first.', 'err');
      return;
    }

    // Generate suggestions for canvas nodes (up to 10)
    const canvasNodes = _canvasData.nodes.slice(0, 10);
    for (const n of canvasNodes) {
      try {
        await apiFetch('/api/suggestions', {
          method: 'POST',
          body: JSON.stringify({ node_id: n.id }),
        });
      } catch (e) { /* skip */ }
    }

    // Fetch all pending suggestions
    const data = await apiFetch('/api/suggestions/pending');
    _canvasSuggestions = data.suggestions || [];

    renderCanvasSuggestedLinks();
    renderCanvasOrphanBorders();
    toast(`Found ${_canvasSuggestions.length} suggested connections.`);
  } catch (e) {
    toast('Suggest failed: ' + e.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✦ Suggest Links'; }
  }
}

function renderCanvasSuggestedLinks() {
  if (!_canvasData || !_canvasSuggestions.length) return;

  const nodeMap = {};
  _canvasData.nodes.forEach(n => { nodeMap[n.id] = n; });

  // Get or create suggestions layer
  let layer = document.getElementById('canvas-sug-links');
  if (!layer) {
    const linksLayer = document.getElementById('canvas-links');
    layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    layer.id = 'canvas-sug-links';
    linksLayer.parentNode.insertBefore(layer, linksLayer.nextSibling);
  }
  layer.innerHTML = '';

  _canvasSuggestions.forEach(sug => {
    const s = nodeMap[sug.source_id];
    const t = nodeMap[sug.target_id];
    if (!s || !t) return;

    const sx = s.x + NODE_W / 2;
    const sy = s.y + NODE_H / 2;
    const tx = t.x + NODE_W / 2;
    const ty = t.y + NODE_H / 2;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const d = `M${sx},${sy} Q${(sx + tx) / 2},${sy} ${tx},${ty}`;
    path.setAttribute('d', d);
    path.setAttribute('class', 'canvas-suggestion-link');
    path.setAttribute('stroke-width', (1 + sug.score * 2).toFixed(1));

    path.addEventListener('click', (e) => {
      e.stopPropagation();
      showSugPopover(e.pageX, e.pageY, sug);
    });

    layer.appendChild(path);
  });
}

function renderCanvasOrphanBorders() {
  if (!_canvasData) return;

  const connected = new Set();
  (_canvasData.links || []).forEach(l => {
    connected.add(l.source);
    connected.add(l.target);
  });

  // Also count suggestion connections as "potentially connected"
  const nodesLayer = document.getElementById('canvas-nodes');
  if (!nodesLayer) return;

  const orphanIds = new Set(
    _canvasData.nodes.filter(n => !connected.has(n.id)).map(n => n.id)
  );

  // Add pulsing border to orphan node cards
  const nodeGroups = nodesLayer.querySelectorAll('.canvas-node');
  nodeGroups.forEach(g => {
    const datum = d3.select(g).datum();
    if (!datum) return;
    // Remove existing orphan highlight
    g.querySelectorAll('.canvas-orphan-highlight').forEach(el => el.remove());
    if (orphanIds.has(datum.id)) {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('width', NODE_W + 8);
      rect.setAttribute('height', NODE_H + 8);
      rect.setAttribute('x', -4);
      rect.setAttribute('y', -4);
      rect.setAttribute('rx', 10);
      rect.setAttribute('ry', 10);
      rect.setAttribute('class', 'canvas-orphan-border canvas-orphan-highlight');
      rect.setAttribute('fill', 'none');
      g.insertBefore(rect, g.firstChild);
    }
  });
}

// ── Research tab: Related notes for completed sessions ───────────────────────

async function loadResearchSuggestions(resultNodeId, containerEl) {
  if (!resultNodeId || !containerEl) return;
  if (!_meData?.features?.ai_editor) return;

  try {
    const data = await apiFetch('/api/suggestions/for/' + resultNodeId);
    const sugs = data.suggestions || [];
    if (!sugs.length) return;

    let section = containerEl.querySelector('.research-related');
    if (!section) {
      section = document.createElement('div');
      section.className = 'research-related';
      section.style.cssText = 'margin-top:8px;padding-top:8px;border-top:1px solid var(--border);';
      containerEl.appendChild(section);
    }

    section.innerHTML = `
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">Related Notes in Library:</div>
      ${sugs.slice(0, 3).map(s =>
        `<div class="suggestion-card" onclick="openNodeFromSuggestion('${s.target_id}')" style="margin-bottom:4px;">
          ${scoreBadgeHtml(s.score)}
          <div class="suggestion-card-info">
            <div class="suggestion-card-title">${esc(s.target_title || 'Untitled')}</div>
          </div>
        </div>`
      ).join('')}`;
  } catch (e) {
    // Silent fail
  }
}

// ── Keyboard Shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  // Ctrl+S / Cmd+S → Save
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    if (_dirty && _activeNodeId !== undefined) saveNode();
  }
  // Ctrl+N / Cmd+N → New Note
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
    e.preventDefault();
    if (_activeTab === 'library') newNote();
  }
  // Escape → Close modals/drawers
  if (e.key === 'Escape') {
    const aiModal = document.getElementById('ai-modal');
    const relatedModal = document.getElementById('related-modal');
    const promoteModal = document.getElementById('promote-modal');
    const labelModal = document.getElementById('canvas-label-modal');
    if (aiModal && !aiModal.classList.contains('hidden')) { closeAiModal(); return; }
    if (relatedModal && !relatedModal.classList.contains('hidden')) { relatedModal.classList.add('hidden'); return; }
    if (promoteModal && !promoteModal.classList.contains('hidden')) { closePromoteModal(); return; }
    if (labelModal && !labelModal.classList.contains('hidden')) { cancelCanvasLink(); return; }
    if (_snapshotDrawerOpen) { toggleSnapshotDrawer(); return; }
    hideSugPopover();
    hideGraphPopover();
  }
});

// ── Unsaved Changes Guard ─────────────────────────────────────────────────────
window.addEventListener('beforeunload', (e) => {
  if (_dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
