/**
 * Inbox Cleanup — Frontend Module
 *
 * Manages the Cleanup view: scan flow, folder sidebar, email list
 * with checkboxes, preview panel, bulk actions, agentic search,
 * and toast notifications with undo.
 */

// ── State ─────────────────────────────────────────────────────

let _cuView = 'live'; // 'live' | 'cleanup'
let _cuFolder = 'all';
let _cuEmails = [];
let _cuSelected = new Set(); // UIDs
let _cuPage = 1;
let _cuPages = 0;
let _cuTotal = 0;
let _cuPageSize = 100;
let _cuFolders = null;
let _cuPreviewUid = null;
let _cuSearchMode = false;
let _cuSearchResults = null;
let _cuScanPolling = null;
let _cuSkipConfirm = false;
let _cuToastTimer = null;

// ── View Toggle ───────────────────────────────────────────────

function cuSwitchView(view) {
  _cuView = view;
  const liveBtn = document.getElementById('view-live-btn');
  const cleanupBtn = document.getElementById('view-cleanup-btn');
  const liveView = document.getElementById('live-view');
  const cleanupView = document.getElementById('cleanup-view');
  const liveStats = document.querySelector('.stats-strip');

  if (view === 'cleanup') {
    liveBtn?.classList.remove('active');
    cleanupBtn?.classList.add('active');
    if (liveView) liveView.style.display = 'none';
    if (liveStats) liveStats.style.display = 'none';
    cleanupView?.classList.add('active');
    cuInit();
  } else {
    cleanupBtn?.classList.remove('active');
    liveBtn?.classList.add('active');
    cleanupView?.classList.remove('active');
    if (liveView) liveView.style.removeProperty('display');
    if (liveStats) liveStats.style.removeProperty('display');
  }
}

// ── Init ──────────────────────────────────────────────────────

async function cuInit() {
  const layout = document.querySelector('.cu-layout');
  const mainContent = document.getElementById('cu-main-content');
  const statsBar = document.querySelector('.cu-stats-bar');

  // Stats bar is always visible in cleanup mode
  if (statsBar) statsBar.style.display = 'flex';

  // Helper to show the 3-panel layout (after scan data exists)
  function showLayout() {
    if (layout) layout.style.display = 'flex';
    if (mainContent) mainContent.style.display = 'none';
  }
  // Helper to show the main content area (scan empty / scanning states)
  function showMain() {
    if (layout) layout.style.display = 'none';
    if (mainContent) { mainContent.style.display = 'flex'; mainContent.style.flex = '1'; }
  }

  try {
    // Check scan status
    const status = await cuApi('GET', '/api/cleanup/status');

    if (status.active) {
      showMain();
      cuShowScanning(status.progress);
      cuStartScanPolling();
      return;
    }

    // Check for cached data
    const folders = await cuApi('GET', '/api/cleanup/folders');
    if (folders && folders.folders) {
      _cuFolders = folders.folders;
      showLayout();
      cuRenderSidebar();
      cuLoadEmails();
    } else {
      showMain();
      cuShowScanEmpty();
    }
  } catch (err) {
    console.error('[cleanup] Init error:', err);
    showMain();
    cuShowScanEmpty();
  }
}

// ── API helper ────────────────────────────────────────────────

async function cuApi(method, endpoint, body = null) {
  const opts = { method, headers: {} };
  if (_activeAccountId) {
    const sep = endpoint.includes('?') ? '&' : '?';
    if (method === 'GET') {
      endpoint += sep + 'accountId=' + encodeURIComponent(_activeAccountId);
    }
  }
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    if (_activeAccountId && !body.accountId) body.accountId = _activeAccountId;
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(BASE + endpoint, opts);
  return resp.json();
}

// ── Scan Flow ─────────────────────────────────────────────────

function cuShowScanEmpty() {
  const main = document.getElementById('cu-main-content');
  main.innerHTML = `
    <div class="cu-scan-empty">
      <div class="cu-scan-empty-icon">&#128233;</div>
      <h2>Inbox Cleanup</h2>
      <p>Scan your inbox to categorize and clean up old emails. AI will sort everything into smart folders so you can bulk-trash junk and keep what matters.</p>
      <button class="cu-scan-btn" onclick="cuStartScan()">&#128270; Start Inbox Scan</button>
      <div class="cu-scan-options">
        <label class="cu-scan-option">
          <input type="checkbox" id="cu-scan-spam"> Include Spam folder
        </label>
        <label class="cu-scan-option">
          <input type="checkbox" id="cu-scan-trash"> Include Trash folder
        </label>
        <label class="cu-scan-option">
          Scan depth:
          <select id="cu-scan-depth">
            <option value="6m">Last 6 months</option>
            <option value="1y">Last year</option>
            <option value="2y" selected>Last 2 years</option>
            <option value="5y">Last 5 years</option>
            <option value="10y">Last 10 years</option>
          </select>
        </label>
      </div>
    </div>
  `;
  // Hide sidebar and preview
  document.getElementById('cu-sidebar').innerHTML = '';
  document.getElementById('cu-preview').innerHTML = cuPreviewEmpty();
}

async function cuStartScan() {
  const includeSpam = document.getElementById('cu-scan-spam')?.checked || false;
  const includeTrash = document.getElementById('cu-scan-trash')?.checked || false;
  const maxAge = document.getElementById('cu-scan-depth')?.value || '2y';

  const result = await cuApi('POST', '/api/cleanup/scan', { includeSpam, includeTrash, maxAge });
  if (result.error) {
    cuShowToast(result.error, 'error');
    return;
  }

  cuShowScanning({ total: 0, processed: 0, percent: 0 });
  cuStartScanPolling();
}

function cuShowScanning(progress) {
  const main = document.getElementById('cu-main-content');
  main.innerHTML = `
    <div class="cu-scanning">
      <div class="cu-scanning-spinner"></div>
      <h3>Scanning inbox...</h3>
      <div class="cu-scanning-progress">
        <div class="cu-scanning-track">
          <div class="cu-scanning-fill" id="cu-scan-fill" style="width:${progress.percent || 0}%"></div>
        </div>
        <div class="cu-scanning-stats" id="cu-scan-stats">
          ${(progress.processed || 0).toLocaleString()} / ${(progress.total || 0).toLocaleString()} emails processed
        </div>
      </div>
      <button class="cu-scanning-cancel" onclick="cuCancelScan()">Cancel</button>
    </div>
  `;
}

function cuUpdateScanProgress(data) {
  const fill = document.getElementById('cu-scan-fill');
  const stats = document.getElementById('cu-scan-stats');
  if (fill) fill.style.width = data.percent + '%';
  if (stats) stats.textContent = `${(data.processed || 0).toLocaleString()} / ${(data.total || 0).toLocaleString()} emails processed`;
}

function cuStartScanPolling() {
  if (_cuScanPolling) return;
  _cuScanPolling = setInterval(async () => {
    const status = await cuApi('GET', '/api/cleanup/status');
    if (status.active) {
      cuUpdateScanProgress(status.progress);
    } else {
      clearInterval(_cuScanPolling);
      _cuScanPolling = null;
      if (status.error) {
        cuShowToast('Scan failed: ' + status.error, 'error');
        cuShowScanEmpty();
      } else {
        cuShowToast('Scan complete!', 'success');
        cuInit(); // Reload with results
      }
    }
  }, 2000);
}

async function cuCancelScan() {
  await cuApi('POST', '/api/cleanup/cancel');
  clearInterval(_cuScanPolling);
  _cuScanPolling = null;
  cuShowScanEmpty();
}

// ── Sidebar ───────────────────────────────────────────────────

function cuRenderSidebar() {
  if (!_cuFolders) return;
  const f = _cuFolders;
  const sidebar = document.getElementById('cu-sidebar');

  const folders = [
    { id: 'all', icon: '&#128231;', name: 'All Mail', count: f.all },
    { id: 'inbox', icon: '&#128229;', name: 'Inbox', count: f.inbox },
    { id: 'promos', icon: '&#128226;', name: 'Promotions', count: f.promos },
    { id: 'newsletters', icon: '&#128240;', name: 'Newsletters', count: f.newsletters },
    { id: 'social', icon: '&#128172;', name: 'Social', count: f.social },
    { divider: true },
    { id: 'older-6m', icon: '&#128336;', name: 'Older than 6mo', count: f['older-6m'] },
    { id: 'older-1y', icon: '&#128336;', name: 'Older than 1yr', count: f['older-1y'] },
    { id: 'never-opened', icon: '&#128123;', name: 'Never Opened', count: f['never-opened'] },
  ];

  sidebar.innerHTML = `
    <div class="cu-sidebar-section">
      <div class="cu-sidebar-label">Folders</div>
      ${folders.map(f => {
        if (f.divider) return '<div class="cu-sidebar-divider"></div>';
        const active = _cuFolder === f.id ? 'active' : '';
        return `
          <div class="cu-folder ${active}" onclick="cuSelectFolder('${f.id}')">
            <span class="cu-folder-icon">${f.icon}</span>
            <span class="cu-folder-name">${f.name}</span>
            <span class="cu-folder-count">${(f.count || 0).toLocaleString()}</span>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function cuSelectFolder(folderId) {
  _cuFolder = folderId;
  _cuPage = 1;
  _cuSelected.clear();
  _cuSearchMode = false;
  _cuSearchResults = null;
  cuRenderSidebar();
  cuLoadEmails();
  cuUpdateBulkBar();
}

// ── Email List ────────────────────────────────────────────────

async function cuLoadEmails() {
  cuShowEmailSkeleton();

  const data = await cuApi('GET', `/api/cleanup/emails?category=${_cuFolder}&page=${_cuPage}&pageSize=${_cuPageSize}&sortBy=date-desc`);
  _cuEmails = data.emails || [];
  _cuTotal = data.total || 0;
  _cuPages = data.pages || 0;

  cuRenderEmailList();
  cuRenderPagination();
  cuUpdateStats();
}

function cuShowEmailSkeleton() {
  const list = document.getElementById('cu-email-list');
  if (!list) return;
  let html = '';
  for (let i = 0; i < 12; i++) {
    html += `
      <div class="cu-skeleton-row">
        <div class="cu-checkbox"><div class="cu-skeleton" style="width:16px;height:16px;border-radius:4px"></div></div>
        <div><div class="cu-skeleton circle"></div></div>
        <div style="padding-right:12px">
          <div class="cu-skeleton line" style="width:${40 + Math.random() * 30}%;margin-bottom:6px"></div>
          <div class="cu-skeleton line-short"></div>
        </div>
        <div><div class="cu-skeleton line-xs" style="margin-left:auto"></div></div>
        <div><div class="cu-skeleton line-xs" style="margin-left:auto"></div></div>
      </div>
    `;
  }
  list.innerHTML = html;
}

function cuRenderEmailList() {
  const list = document.getElementById('cu-email-list');
  if (!list) return;

  if (_cuEmails.length === 0) {
    list.innerHTML = `
      <div class="cu-scan-empty" style="padding:40px">
        <div style="font-size:2rem;opacity:0.4">&#128237;</div>
        <p style="font-size:0.85rem;color:var(--cu-text-dim)">No emails in this category</p>
      </div>
    `;
    return;
  }

  list.innerHTML = _cuEmails.map(e => {
    const checked = _cuSelected.has(e.uid) ? 'checked' : '';
    const selectedClass = _cuSelected.has(e.uid) ? 'selected' : '';
    const previewClass = _cuPreviewUid === e.uid ? 'preview-active' : '';
    const initials = getInitials(e.fromName || e.from);
    const avatarClass = getAvatarClass(e);
    const date = formatDate(e.date);
    const category = e.categories?.[0] || 'inbox';
    const catClass = getCatClass(category);
    const catLabel = getCatLabel(category);

    return `
      <div class="cu-email-row ${selectedClass} ${previewClass}" data-uid="${e.uid}" data-folder="${e.folder}">
        <div class="cu-checkbox" onclick="event.stopPropagation()">
          <input type="checkbox" ${checked} onchange="cuToggleSelect(${e.uid}, this.checked)">
        </div>
        <div class="cu-avatar ${avatarClass}">${initials}</div>
        <div class="cu-email-content" onclick="cuPreview(${e.uid}, '${e.folder}')">
          <div class="cu-email-sender">${escHtml(e.fromName || e.from)}</div>
          <div class="cu-email-subject">${escHtml(e.subject)}</div>
        </div>
        <div class="cu-email-date">${date}</div>
        <div class="cu-email-category">
          <span class="cu-cat-pill ${catClass}">${catLabel}</span>
        </div>
        <div class="cu-row-actions">
          <button class="cu-row-action-btn trash-btn" title="Trash" onclick="event.stopPropagation();cuQuickTrash(${e.uid},'${e.folder}')">&#128465;</button>
          <button class="cu-row-action-btn" title="Archive" onclick="event.stopPropagation();cuQuickArchive(${e.uid},'${e.folder}')">&#128230;</button>
          <button class="cu-row-action-btn" title="Flag" onclick="event.stopPropagation();cuQuickFlag(${e.uid},'${e.folder}')">&#9873;</button>
        </div>
      </div>
    `;
  }).join('');
}

function cuRenderPagination() {
  const pag = document.getElementById('cu-pagination');
  if (!pag) return;

  if (_cuPages <= 1) {
    pag.innerHTML = `<span>${_cuTotal.toLocaleString()} emails</span>`;
    return;
  }

  pag.innerHTML = `
    <button class="cu-page-btn" onclick="cuGoPage(${_cuPage - 1})" ${_cuPage <= 1 ? 'disabled' : ''}>&#9664; Prev</button>
    <span>Page ${_cuPage} of ${_cuPages}</span>
    <span style="color:var(--cu-text-dim);font-size:0.72rem">${_cuTotal.toLocaleString()} emails</span>
    <button class="cu-page-btn" onclick="cuGoPage(${_cuPage + 1})" ${_cuPage >= _cuPages ? 'disabled' : ''}>Next &#9654;</button>
  `;
}

function cuGoPage(page) {
  if (page < 1 || page > _cuPages) return;
  _cuPage = page;
  _cuSelected.clear();
  cuUpdateBulkBar();
  cuLoadEmails();
}

// ── Selection ─────────────────────────────────────────────────

function cuToggleSelect(uid, checked) {
  if (checked) _cuSelected.add(uid);
  else _cuSelected.delete(uid);
  cuUpdateBulkBar();
  cuUpdateRowStates();
}

function cuSelectAll() {
  for (const e of _cuEmails) _cuSelected.add(e.uid);
  cuUpdateBulkBar();
  cuRenderEmailList();
}

function cuDeselectAll() {
  _cuSelected.clear();
  cuUpdateBulkBar();
  cuRenderEmailList();
}

function cuToggleSelectAll() {
  const allSelected = _cuEmails.every(e => _cuSelected.has(e.uid));
  if (allSelected) cuDeselectAll();
  else cuSelectAll();
}

function cuUpdateBulkBar() {
  const bar = document.getElementById('cu-bulk-bar');
  if (!bar) return;

  if (_cuSelected.size > 0) {
    bar.classList.add('visible');
    document.getElementById('cu-bulk-count').textContent = `${_cuSelected.size} selected`;
  } else {
    bar.classList.remove('visible');
  }
}

function cuUpdateRowStates() {
  document.querySelectorAll('.cu-email-row').forEach(row => {
    const uid = parseInt(row.dataset.uid);
    row.classList.toggle('selected', _cuSelected.has(uid));
    const cb = row.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = _cuSelected.has(uid);
  });
}

// ── Bulk Operations ───────────────────────────────────────────

async function cuBulkTrash() {
  const uids = Array.from(_cuSelected);
  if (uids.length === 0) return;

  if (!_cuSkipConfirm) {
    cuShowConfirmModal('trash', uids.length, async () => {
      await _executeBulkTrash(uids);
    });
    return;
  }
  await _executeBulkTrash(uids);
}

async function _executeBulkTrash(uids) {
  // Optimistic UI — remove rows immediately
  const removedEmails = _cuEmails.filter(e => uids.includes(e.uid));
  _cuEmails = _cuEmails.filter(e => !uids.includes(e.uid));
  _cuSelected.clear();
  cuRenderEmailList();
  cuUpdateBulkBar();

  const result = await cuApi('POST', '/api/cleanup/trash', { uids, folder: removedEmails[0]?.folder || 'INBOX' });

  if (result.success) {
    cuShowToast(`${result.moved} emails moved to Trash`, 'success', true);
    // Refresh folder counts
    const folders = await cuApi('GET', '/api/cleanup/folders');
    if (folders.folders) { _cuFolders = folders.folders; cuRenderSidebar(); }
  } else {
    // Revert on failure
    _cuEmails = [...removedEmails, ..._cuEmails];
    cuRenderEmailList();
    cuShowToast('Failed: ' + (result.error || 'Unknown error'), 'error');
  }
}

async function cuBulkArchive() {
  const uids = Array.from(_cuSelected);
  if (uids.length === 0) return;

  if (!_cuSkipConfirm) {
    cuShowConfirmModal('archive', uids.length, async () => {
      await _executeBulkArchive(uids);
    });
    return;
  }
  await _executeBulkArchive(uids);
}

async function _executeBulkArchive(uids) {
  const removedEmails = _cuEmails.filter(e => uids.includes(e.uid));
  _cuEmails = _cuEmails.filter(e => !uids.includes(e.uid));
  _cuSelected.clear();
  cuRenderEmailList();
  cuUpdateBulkBar();

  const result = await cuApi('POST', '/api/cleanup/archive', { uids, folder: removedEmails[0]?.folder || 'INBOX' });

  if (result.success) {
    cuShowToast(`${result.moved} emails archived`, 'success', true);
    const folders = await cuApi('GET', '/api/cleanup/folders');
    if (folders.folders) { _cuFolders = folders.folders; cuRenderSidebar(); }
  } else {
    _cuEmails = [...removedEmails, ..._cuEmails];
    cuRenderEmailList();
    cuShowToast('Failed: ' + (result.error || 'Unknown error'), 'error');
  }
}

async function cuBulkFlag() {
  const uids = Array.from(_cuSelected);
  if (uids.length === 0) return;

  const result = await cuApi('POST', '/api/cleanup/flag', { uids, folder: _cuEmails[0]?.folder || 'INBOX' });

  if (result.success) {
    _cuSelected.clear();
    cuUpdateBulkBar();
    cuShowToast(`${result.flagged} emails flagged for review`, 'success');
  } else {
    cuShowToast('Failed: ' + (result.error || 'Unknown error'), 'error');
  }
}

// Quick single-row actions
async function cuQuickTrash(uid, folder) {
  _cuSelected.clear();
  _cuSelected.add(uid);
  await _executeBulkTrash([uid]);
}

async function cuQuickArchive(uid, folder) {
  _cuSelected.clear();
  _cuSelected.add(uid);
  await _executeBulkArchive([uid]);
}

async function cuQuickFlag(uid, folder) {
  const result = await cuApi('POST', '/api/cleanup/flag', { uids: [uid], folder });
  if (result.success) cuShowToast('Email flagged', 'success');
}

// ── Undo ──────────────────────────────────────────────────────

async function cuUndo() {
  const result = await cuApi('POST', '/api/cleanup/undo');
  if (result.success) {
    cuShowToast(`Undid ${result.type} of ${result.count} emails`, 'success');
    // Need to rescan since cache was invalidated
    cuInit();
  } else {
    cuShowToast('Undo failed: ' + (result.error || 'Unknown error'), 'error');
  }
}

// ── Preview Panel ─────────────────────────────────────────────

async function cuPreview(uid, folder) {
  _cuPreviewUid = uid;
  cuUpdateRowStates();

  const panel = document.getElementById('cu-preview');
  panel.innerHTML = `
    <div class="cu-preview-header">
      <span class="cu-preview-title">Loading...</span>
      <button class="cu-preview-close" onclick="cuClosePreview()">&#10005;</button>
    </div>
    <div class="cu-preview-content" style="display:flex;align-items:center;justify-content:center">
      <div class="cu-scanning-spinner" style="width:32px;height:32px;border-width:2px"></div>
    </div>
  `;

  const data = await cuApi('GET', `/api/cleanup/preview/${uid}?folder=${encodeURIComponent(folder)}`);

  if (data.error) {
    panel.innerHTML = `
      <div class="cu-preview-header">
        <span class="cu-preview-title">Error</span>
        <button class="cu-preview-close" onclick="cuClosePreview()">&#10005;</button>
      </div>
      <div class="cu-preview-content">
        <p style="color:var(--cu-red)">${escHtml(data.error)}</p>
      </div>
    `;
    return;
  }

  panel.innerHTML = `
    <div class="cu-preview-header">
      <span class="cu-preview-title">Preview</span>
      <button class="cu-preview-close" onclick="cuClosePreview()">&#10005;</button>
    </div>
    <div class="cu-preview-content">
      <div class="cu-preview-subject">${escHtml(data.subject)}</div>
      <div class="cu-preview-meta">
        <div class="cu-preview-meta-row">
          <span class="cu-preview-meta-label">From</span>
          <span class="cu-preview-meta-value">${escHtml(data.from)}</span>
        </div>
        <div class="cu-preview-meta-row">
          <span class="cu-preview-meta-label">To</span>
          <span class="cu-preview-meta-value">${escHtml(data.to)}</span>
        </div>
        ${data.cc ? `<div class="cu-preview-meta-row"><span class="cu-preview-meta-label">CC</span><span class="cu-preview-meta-value">${escHtml(data.cc)}</span></div>` : ''}
        <div class="cu-preview-meta-row">
          <span class="cu-preview-meta-label">Date</span>
          <span class="cu-preview-meta-value">${data.date ? new Date(data.date).toLocaleString() : 'Unknown'}</span>
        </div>
        ${data.attachments?.length ? `<div class="cu-preview-meta-row"><span class="cu-preview-meta-label">Files</span><span class="cu-preview-meta-value">${data.attachments.map(a => a.filename).join(', ')}</span></div>` : ''}
      </div>
      <div class="cu-preview-body">${escHtml(data.text || '(no text content)')}</div>
    </div>
    <div class="cu-preview-actions">
      <button class="cu-preview-action-btn trash" onclick="cuQuickTrash(${uid},'${data.folder || 'INBOX'}')">&#128465; Trash</button>
      <button class="cu-preview-action-btn archive" onclick="cuQuickArchive(${uid},'${data.folder || 'INBOX'}')">&#128230; Archive</button>
      <button class="cu-preview-action-btn flag" onclick="cuQuickFlag(${uid},'${data.folder || 'INBOX'}')">&#9873; Flag</button>
    </div>
  `;
}

function cuClosePreview() {
  _cuPreviewUid = null;
  const panel = document.getElementById('cu-preview');
  panel.innerHTML = cuPreviewEmpty();
  cuUpdateRowStates();
}

function cuPreviewEmpty() {
  return `
    <div class="cu-preview-empty">
      <div class="cu-preview-empty-icon">&#128236;</div>
      <div class="cu-preview-empty-text">Click an email to preview</div>
    </div>
  `;
}

// ── Agentic Search ────────────────────────────────────────────

async function cuSearch() {
  const input = document.getElementById('cu-search-input');
  const query = input?.value?.trim();
  if (!query) return;

  const btn = document.getElementById('cu-search-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Searching...'; }

  const result = await cuApi('POST', '/api/cleanup/search', { query });

  if (btn) { btn.disabled = false; btn.textContent = 'Search'; }

  if (result.error) {
    cuShowToast(result.error, 'error');
    return;
  }

  _cuSearchMode = true;
  _cuSearchResults = result;
  cuRenderSearchResults();
}

function cuQuickSearch(query) {
  const input = document.getElementById('cu-search-input');
  if (input) input.value = query;
  cuSearch();
}

function cuRenderSearchResults() {
  const list = document.getElementById('cu-email-list');
  if (!list || !_cuSearchResults) return;

  const r = _cuSearchResults;

  list.innerHTML = `
    <div class="cu-search-results">
      <div class="cu-search-summary">
        <span>&#129302; Found <span class="count">${r.totalMatches.toLocaleString()}</span> emails matching "${escHtml(r.query)}"</span>
        <button class="cu-search-back" onclick="cuExitSearch()">&#10005; Back to list</button>
      </div>
      ${r.groups.map((g, i) => `
        <div class="cu-search-group">
          <div class="cu-search-group-header">
            <span class="cu-search-group-icon">&#128230;</span>
            <div class="cu-search-group-info">
              <div class="cu-search-group-name">${escHtml(g.name)}</div>
              <div class="cu-search-group-desc">${escHtml(g.description)}</div>
            </div>
            <span class="cu-search-group-count">${g.count.toLocaleString()}</span>
          </div>
          ${g.topSenders?.length ? `
            <div class="cu-search-group-senders">
              Top: ${g.topSenders.map(s => `${s.domain} (${s.count})`).join(', ')}
            </div>
          ` : ''}
          <div class="cu-search-group-actions">
            <button class="cu-bulk-btn danger" onclick="cuSearchGroupTrash(${i})">&#128465; Trash All ${g.count.toLocaleString()}</button>
            <button class="cu-bulk-btn" onclick="cuSearchGroupArchive(${i})">&#128230; Archive All</button>
            <button class="cu-bulk-btn" onclick="cuSearchGroupPreview(${i})">Preview</button>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

async function cuSearchGroupTrash(groupIdx) {
  const group = _cuSearchResults?.groups?.[groupIdx];
  if (!group) return;

  const uids = group.allUids.map(u => u.uid);
  const folder = group.allUids[0]?.folder || 'INBOX';

  cuShowConfirmModal('trash', uids.length, async () => {
    const result = await cuApi('POST', '/api/cleanup/trash', { uids, folder });
    if (result.success) {
      cuShowToast(`${result.moved} emails trashed from "${group.name}"`, 'success', true);
      cuExitSearch();
      cuInit();
    } else {
      cuShowToast('Failed: ' + (result.error || 'Unknown error'), 'error');
    }
  });
}

async function cuSearchGroupArchive(groupIdx) {
  const group = _cuSearchResults?.groups?.[groupIdx];
  if (!group) return;

  const uids = group.allUids.map(u => u.uid);
  const folder = group.allUids[0]?.folder || 'INBOX';

  const result = await cuApi('POST', '/api/cleanup/archive', { uids, folder });
  if (result.success) {
    cuShowToast(`${result.moved} emails archived from "${group.name}"`, 'success', true);
    cuExitSearch();
    cuInit();
  }
}

function cuSearchGroupPreview(groupIdx) {
  const group = _cuSearchResults?.groups?.[groupIdx];
  if (!group || !group.emails?.length) return;
  // Switch to list view showing these emails
  _cuSearchMode = false;
  _cuEmails = group.emails;
  _cuTotal = group.count;
  _cuPages = 1;
  _cuPage = 1;
  cuRenderEmailList();
  cuRenderPagination();
}

function cuExitSearch() {
  _cuSearchMode = false;
  _cuSearchResults = null;
  const input = document.getElementById('cu-search-input');
  if (input) input.value = '';
  cuLoadEmails();
}

function cuSearchKeydown(e) {
  if (e.key === 'Enter') cuSearch();
}

// ── Confirm Modal ─────────────────────────────────────────────

let _cuModalCallback = null;

function cuShowConfirmModal(type, count, callback) {
  _cuModalCallback = callback;
  const overlay = document.getElementById('cu-modal-overlay');
  const icon = type === 'trash' ? '&#128465;' : '&#128230;';
  const title = type === 'trash' ? `Trash ${count.toLocaleString()} emails?` : `Archive ${count.toLocaleString()} emails?`;
  const body = type === 'trash'
    ? 'This will move the selected emails to Trash in the connected email account. Emails in Trash are permanently deleted after 30 days.'
    : 'This will archive the selected emails, removing them from the inbox.';
  const btnClass = type === 'trash' ? 'confirm-trash' : 'confirm-archive';
  const btnText = type === 'trash' ? `&#128465; Trash ${count.toLocaleString()} Emails` : `&#128230; Archive ${count.toLocaleString()} Emails`;

  document.getElementById('cu-modal-icon').innerHTML = icon;
  document.getElementById('cu-modal-title').textContent = title;
  document.getElementById('cu-modal-body').textContent = body;
  document.getElementById('cu-modal-confirm').className = `cu-modal-btn ${btnClass}`;
  document.getElementById('cu-modal-confirm').innerHTML = btnText;

  overlay.classList.add('open');
}

function cuCloseModal() {
  document.getElementById('cu-modal-overlay').classList.remove('open');
  _cuModalCallback = null;
}

async function cuConfirmModal() {
  const skipCheck = document.getElementById('cu-modal-skip');
  if (skipCheck?.checked) _cuSkipConfirm = true;

  const cb = _cuModalCallback;
  cuCloseModal();
  if (cb) await cb();
}

// ── Toast ─────────────────────────────────────────────────────

function cuShowToast(message, type = 'success', showUndo = false) {
  let toast = document.getElementById('cu-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'cu-toast';
    toast.className = 'cu-toast';
    document.body.appendChild(toast);
  }

  const icon = type === 'success' ? '&#10003;' : '&#9888;';
  toast.className = `cu-toast ${type}`;
  toast.innerHTML = `
    <span class="cu-toast-icon">${icon}</span>
    <span class="cu-toast-message">${escHtml(message)}</span>
    ${showUndo ? '<button class="cu-toast-undo" onclick="cuUndo()">Undo</button>' : ''}
    <button class="cu-toast-close" onclick="cuHideToast()">&#10005;</button>
  `;

  // Trigger animation
  requestAnimationFrame(() => {
    toast.classList.add('visible');
  });

  clearTimeout(_cuToastTimer);
  _cuToastTimer = setTimeout(cuHideToast, showUndo ? 10000 : 5000);
}

function cuHideToast() {
  const toast = document.getElementById('cu-toast');
  if (toast) toast.classList.remove('visible');
  clearTimeout(_cuToastTimer);
}

// ── Stats bar ─────────────────────────────────────────────────

function cuUpdateStats() {
  const el = document.getElementById('cu-stat-total');
  if (el && _cuFolders) el.textContent = _cuFolders.all?.toLocaleString() || '0';

  const cleaned = document.getElementById('cu-stat-cleaned');
  if (cleaned) cleaned.textContent = '0'; // Updated on operations

  const flagged = document.getElementById('cu-stat-flagged');
  if (flagged) flagged.textContent = '0';
}

// ── SSE listener ──────────────────────────────────────────────

function cuInitSSE() {
  try {
    const evtSource = new EventSource(BASE + '/api/events');
    evtSource.addEventListener('cleanup-progress', (e) => {
      try {
        const data = JSON.parse(e.data);
        cuUpdateScanProgress(data);
      } catch {}
    });
    evtSource.addEventListener('cleanup-complete', (e) => {
      try {
        const data = JSON.parse(e.data);
        clearInterval(_cuScanPolling);
        _cuScanPolling = null;
        cuShowToast('Scan complete!', 'success');
        cuInit();
      } catch {}
    });
    evtSource.addEventListener('cleanup-action', (e) => {
      try {
        const data = JSON.parse(e.data);
        // Refresh folders after action
        cuApi('GET', '/api/cleanup/folders').then(r => {
          if (r.folders) { _cuFolders = r.folders; cuRenderSidebar(); }
        });
      } catch {}
    });
  } catch {}
}

// ── Helpers ───────────────────────────────────────────────────

function escHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function getInitials(name) {
  if (!name) return '?';
  const parts = name.split(/[\s@.]+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (name[0] || '?').toUpperCase();
}

function getAvatarClass(email) {
  if (email.categories?.includes('promos')) return 'promo';
  if (email.categories?.includes('newsletters')) return 'newsletter';
  if (email.categories?.includes('social')) return 'social';
  return 'default';
}

function getCatClass(cat) {
  const map = { promos: 'promo', newsletters: 'newsletter', social: 'social', inbox: 'inbox' };
  if (cat.startsWith('older')) return 'old';
  return map[cat] || 'inbox';
}

function getCatLabel(cat) {
  const map = {
    promos: 'Promo', newsletters: 'Newsletter', social: 'Social',
    inbox: 'Inbox', 'older-6m': '6mo+', 'older-1y': '1yr+',
    'never-opened': 'Unread', all: 'All',
  };
  return map[cat] || cat;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.floor((now - d) / (24 * 60 * 60 * 1000));

  if (diffDays === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' });
  if (diffDays < 365) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleDateString([], { month: 'short', year: '2-digit' });
}

// Init SSE on load
cuInitSSE();
