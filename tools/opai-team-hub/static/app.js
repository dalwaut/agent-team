/* OPAI Team Hub — Frontend v2.0 (Supabase-native) */

const API = '/team-hub/api';

const PRIORITIES = [
    { value: 'critical', label: 'Critical', color: '#e17055' },
    { value: 'high', label: 'High', color: '#fdcb6e' },
    { value: 'medium', label: 'Medium', color: '#74b9ff' },
    { value: 'low', label: 'Low', color: '#8b8e96' },
    { value: 'none', label: 'None', color: '#595d66' },
];

const ITEM_TYPES = ['task', 'note', 'idea', 'decision', 'bug'];

// ── State ────────────────────────────────────────────────────
let _user = null;
let _spaces = [];       // team_workspaces
let _profiles = [];     // all OPAI users
let _currentSpaceId = null;
let _currentSpaceName = '';
let _currentListId = null;
let _currentListName = '';
let _currentStatuses = [];
let _tasks = [];
let _currentView = 'board';  // board | list | calendar | dashboard
let _detailTask = null;
let _searchTimeout = null;
let _notifInterval = null;
let _selectedItems = new Set();  // batch selection
let _batchMode = false;
let _expandedSpaces = {};
let _expandedFolders = {};
let _hierarchyCache = {};
let _allAssignees = [];  // [{id, name, type:'opai'|'clickup'}]
let _supabase = null;
let _realtimeChannel = null;
let _createNewType = null;    // wizard: space|folder|list|task
let _savedTemplates = [];     // saved templates from DB (all)
let _personalTemplates = [];  // user's own private templates
let _sharedTemplates = [];    // shared team templates
let _tplBuilderFolders = [];  // [{name, lists:[str]}]
let _tplBuilderLists = [];    // [str] folderless lists
let _structBuilderFolders = []; // [{name, lists:[{name, tasks:[str]}]}]
let _structBuilderLists = [];   // [{name, tasks:[str]}]
let _calendarMonth = null;    // Date for 1st of displayed month
let _calendarItems = [];      // items with due_date for calendar view
let _calendarStatuses = [];   // statuses for calendar coloring
let _calendarSpaces = null;   // space info for all-spaces calendar view
let _homeData = null;         // cached home dashboard data
// AI Panel
let _aiPanelOpen = false;
let _aiMessages = [];         // [{role, content}] conversation history
let _aiStreaming = false;
let _aiCurrentSpaceId = null;  // tracks which space the user is viewing (optional context hint)
let _homeLayout = null;       // tile layout from localStorage
let _hideClosedTasks = true;  // hide done/closed tasks by default

function _myPersonalSpaceId() {
    return _spaces.find(s => s.is_personal)?.id;
}

function _isSettingsOwner() {
    const ps = _spaces.find(s => s.is_personal);
    return ps?.my_role === 'owner';
}

async function _syncSettingsToAllSpaces() {
    try { await api('POST', API + '/settings/sync'); }
    catch { /* sync is best-effort */ }
}

// ── Init ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    const cfg = await fetch(API + '/auth/config').then(r => r.json());
    if (cfg.supabase_url && cfg.supabase_anon_key) {
        window.OPAI_SUPABASE_URL = cfg.supabase_url;
        window.OPAI_SUPABASE_ANON_KEY = cfg.supabase_anon_key;
    }

    const user = await opaiAuth.init({ requireApp: 'team-hub' });
    if (!user) return;

    _user = user;
    document.getElementById('loading-screen').style.display = 'none';
    document.getElementById('app').style.display = '';
    document.getElementById('user-chip').textContent =
        user.user_metadata?.display_name || user.email?.split('@')[0] || '';

    // Init Supabase client for Realtime
    if (window.OPAI_SUPABASE_URL && window.OPAI_SUPABASE_ANON_KEY && window.supabase) {
        _supabase = window.supabase.createClient(window.OPAI_SUPABASE_URL, window.OPAI_SUPABASE_ANON_KEY);
        initRealtime();
    }

    bindEvents();
    loadSpaces();
    loadProfiles();
    startNotifPolling();
    // Show home dashboard by default (no space selected)
    renderHome();
});

// ── API helpers ──────────────────────────────────────────────

async function api(method, path, body) {
    const token = await opaiAuth.getToken();
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(path, opts);
    if (!resp.ok) throw new Error(await resp.text() || 'HTTP ' + resp.status);
    const text = await resp.text();
    if (!text) return { ok: true };
    try { return JSON.parse(text); } catch { return { ok: true, raw: text }; }
}

// ── Realtime ─────────────────────────────────────────────────

function initRealtime() {
    if (!_supabase) return;

    // Broadcast channel for live cross-user updates
    _realtimeChannel = _supabase.channel('team-hub-live', {
        config: { broadcast: { self: false } },
    });

    _realtimeChannel.on('broadcast', { event: 'task_updated' }, (payload) => {
        const { taskId, changes, listId } = payload.payload;
        if (listId === _currentListId) {
            const task = _tasks.find(t => t.id === taskId);
            if (task) {
                Object.assign(task, changes);
                renderMainContent();
            }
        }
        if (_detailTask && _detailTask.id === taskId && !document.querySelector('#detail-body :focus')) {
            openDetail(taskId);
        }
    });

    _realtimeChannel.on('broadcast', { event: 'task_created' }, (payload) => {
        if (payload.payload.listId === _currentListId) {
            selectList(_currentListId, _currentListName, _currentSpaceId);
        }
    });

    _realtimeChannel.on('broadcast', { event: 'comment_added' }, (payload) => {
        if (_detailTask && _detailTask.id === payload.payload.taskId) {
            if (!document.querySelector('#comment-input:focus')) {
                openDetail(_detailTask.id);
            }
        }
    });

    // Live notifications via postgres_changes
    _supabase
        .channel('team-hub-notifs')
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'team_notifications',
        }, (payload) => {
            if (payload.new.user_id === _user.id) {
                pollNotifications();
                showToast(payload.new.title || 'New notification');
            }
        })
        .subscribe();

    _realtimeChannel.on('broadcast', { event: 'structure_changed' }, (payload) => {
        const { type, id, spaceId, action } = payload.payload || {};
        if (action === 'deleted') {
            if (type === 'space') {
                _spaces = _spaces.filter(s => s.id !== id);
                delete _hierarchyCache[id];
                if (_currentSpaceId === id) { _currentSpaceId = null; _currentListId = null; renderMainContent(); }
            } else if (spaceId) {
                delete _hierarchyCache[spaceId];
                if (_expandedSpaces[spaceId]) {
                    api('GET', API + '/workspaces/' + spaceId + '/folders').then(d => {
                        _hierarchyCache[spaceId] = d;
                        renderSpaceTree();
                    }).catch(() => {});
                }
                if (type === 'list' && _currentListId === id) { _currentListId = null; renderMainContent(); }
            }
            renderSpaceTree();
        }
    });

    _realtimeChannel.on('broadcast', { event: 'system_update' }, (payload) => {
        showSystemUpdateBanner(payload.payload?.message || 'Team Hub has been updated.');
    });

    _realtimeChannel.subscribe();
}

function broadcast(event, payload) {
    if (_realtimeChannel) {
        _realtimeChannel.send({ type: 'broadcast', event, payload });
    }
}

// ── Events ───────────────────────────────────────────────────

function bindEvents() {
    // View switcher
    document.querySelectorAll('.th-view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.th-view-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _currentView = btn.dataset.view;
            renderMainContent();
        });
    });

    // Detail close
    document.getElementById('detail-close').addEventListener('click', closeDetail);
    document.getElementById('detail-backdrop').addEventListener('click', closeDetail);

    // Search
    const searchInput = document.getElementById('search-input');
    searchInput.addEventListener('input', (e) => {
        clearTimeout(_searchTimeout);
        const q = e.target.value.trim();
        if (q.length < 2) { document.getElementById('search-results').style.display = 'none'; return; }
        _searchTimeout = setTimeout(() => doSearch(q), 300);
    });
    searchInput.addEventListener('blur', () => {
        setTimeout(() => { document.getElementById('search-results').style.display = 'none'; }, 200);
    });

    // Notifications
    document.getElementById('notif-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleNotifDropdown();
    });
    document.getElementById('mark-all-read').addEventListener('click', (e) => {
        e.stopPropagation();
        markAllRead();
    });
    document.addEventListener('click', (e) => {
        const dd = document.getElementById('notification-dropdown');
        if (dd.style.display !== 'none' && !dd.contains(e.target) && e.target.id !== 'notif-btn') {
            dd.style.display = 'none';
        }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
        if (e.key === '/' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); document.getElementById('search-input').focus(); }
        if (e.key === 'n' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); openCreateNewModal(); }
        if (e.key === 'Escape') {
            closeDetail();
            closeAllModals();
            closeCalDayPopup();
            closeAIPanel();
            document.getElementById('notification-dropdown').style.display = 'none';
            document.getElementById('search-results').style.display = 'none';
        }
    });

    // Modal close handlers
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.classList.remove('visible');
        });
    });
    document.querySelectorAll('.modal-close').forEach(btn => {
        btn.addEventListener('click', () => btn.closest('.modal-overlay').classList.remove('visible'));
    });

    // Create New wizard form (dynamic submit handled inline)

    // (Add Member modal binds events dynamically in openInviteModal)

    // AI panel — Enter sends, Shift+Enter newline
    document.getElementById('ai-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAIMessage(); }
    });
}

// ── Spaces & Hierarchy (Supabase-native) ─────────────────────

async function loadSpaces() {
    try {
        const data = await api('GET', API + '/workspaces');
        _spaces = data.workspaces || [];
    } catch (e) {
        _spaces = [];
        showToast('Failed to load spaces');
    }
    renderSpaceTree();
}

async function loadProfiles() {
    try {
        const data = await api('GET', API + '/profiles');
        _profiles = data.profiles || [];
    } catch { _profiles = []; }
}

function resolveAssigneeName(assigneeId) {
    if (!assigneeId) return '?';
    if (assigneeId.startsWith('clickup:')) return null; // Filter out ClickUp placeholders
    const p = _profiles.find(pp => pp.id === assigneeId);
    return p ? (p.display_name || p.email || '?') : assigneeId.substring(0, 8);
}

function resolveAssigneeInitials(assigneeId) {
    const name = resolveAssigneeName(assigneeId);
    return name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
}

async function loadAssignees(wsId) {
    try {
        const data = await api('GET', API + '/workspaces/' + wsId + '/assignees');
        _allAssignees = data.assignees || [];
    } catch { _allAssignees = []; }
}

function renderSpaceTree() {
    const tree = document.getElementById('space-tree');
    if (!_spaces.length) {
        tree.innerHTML = '<div class="empty-state" style="padding:20px;"><div class="empty-state-text">No spaces found</div></div>';
        return;
    }

    let html = '';
    for (const space of _spaces) {
        const expanded = _expandedSpaces[space.id];
        const active = _currentSpaceId === space.id;
        html += '<div class="th-tree-space" data-space-id="' + esc(space.id) + '" data-drop-type="space" data-drop-id="' + esc(space.id) + '">'
            + '<div class="th-tree-toggle' + (active && !_currentListId ? ' active' : '') + '">'
            + '<span class="th-tree-arrow-btn" onclick="event.stopPropagation();toggleSpace(\'' + esc(space.id) + '\')">'
            + '<svg class="th-tree-arrow' + (expanded ? ' open' : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>'
            + '</span>'
            + '<span class="th-tree-space-name" onclick="clickSpace(\'' + esc(space.id) + '\',\'' + esc(space.name) + '\')" oncontextmenu="showCtxMenu(event,\'space\',\'' + esc(space.id) + '\',\'' + esc(space.name) + '\')">'
            + '<span class="th-tree-dot" style="background:' + esc(space.color || '#6c5ce7') + ';"></span>'
            + '<span class="th-tree-name">' + esc(space.name) + '</span>'
            + '</span>'
            + '</div>'
            + '<div class="th-tree-children' + (expanded ? ' open' : '') + '" id="space-children-' + esc(space.id) + '">'
            + (expanded && _hierarchyCache[space.id] ? renderHierarchy(_hierarchyCache[space.id], space.id) : '')
            + '</div>'
            + '</div>';
    }
    tree.innerHTML = html;
    bindSidebarDragAndDrop();
}

async function clickSpace(spaceId, spaceName) {
    // Expand tree if not already
    if (!_expandedSpaces[spaceId]) {
        _expandedSpaces[spaceId] = true;
        if (!_hierarchyCache[spaceId]) {
            try {
                const data = await api('GET', API + '/workspaces/' + spaceId + '/folders');
                _hierarchyCache[spaceId] = data;
            } catch (e) {
                showToast('Failed to load folders');
            }
        }
    }
    // Load assignees for this workspace
    loadAssignees(spaceId);

    // If user has a view selected (board/list/calendar), keep it at space level
    const activeView = document.querySelector('.th-view-btn.active')?.dataset.view;
    if (activeView === 'calendar') {
        _currentSpaceId = spaceId;
        _currentSpaceName = spaceName;
        _currentListId = null;
        _currentView = 'calendar';
        renderSpaceTree();
        renderMainContent();
        return;
    }

    // Default: open space dashboard
    openSpaceDashboard(spaceId, spaceName);
}

async function toggleSpace(spaceId) {
    _expandedSpaces[spaceId] = !_expandedSpaces[spaceId];
    if (_expandedSpaces[spaceId] && !_hierarchyCache[spaceId]) {
        try {
            const data = await api('GET', API + '/workspaces/' + spaceId + '/folders');
            _hierarchyCache[spaceId] = data;
        } catch (e) {
            showToast('Failed to load folders');
            _expandedSpaces[spaceId] = false;
        }
    }
    renderSpaceTree();
}

function renderHierarchy(data, spaceId) {
    let html = '';
    for (const folder of (data.folders || [])) {
        const expanded = _expandedFolders[folder.id];
        html += '<div class="th-tree-folder" draggable="true" data-drag-type="folder" data-drag-id="' + esc(folder.id) + '" data-drag-space="' + esc(spaceId) + '" data-drop-type="folder" data-drop-id="' + esc(folder.id) + '" data-drop-space="' + esc(spaceId) + '">'
            + '<button class="th-tree-folder-toggle" onclick="toggleFolder(\'' + esc(folder.id) + '\')" oncontextmenu="showCtxMenu(event,\'folder\',\'' + esc(folder.id) + '\',\'' + esc(folder.name) + '\',\'' + esc(spaceId) + '\')">'
            + '<svg class="th-tree-arrow' + (expanded ? ' open' : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;"><path d="M9 18l6-6-6-6"/></svg>'
            + '<span>\uD83D\uDCC1</span>'
            + '<span class="th-tree-name">' + esc(folder.name) + '</span>'
            + '</button>'
            + '<div class="th-tree-folder-children' + (expanded ? ' open' : '') + '">';
        for (const list of (folder.lists || [])) {
            const active = _currentListId === list.id ? ' active' : '';
            html += '<button class="th-tree-list' + active + '" draggable="true" data-drag-type="list" data-drag-id="' + esc(list.id) + '" data-drag-space="' + esc(spaceId) + '" data-drag-folder="' + esc(folder.id) + '" data-drop-type="list" data-drop-id="' + esc(list.id) + '" data-drop-space="' + esc(spaceId) + '" onclick="selectList(\'' + esc(list.id) + '\',\'' + esc(list.name) + '\',\'' + esc(spaceId) + '\')" oncontextmenu="showCtxMenu(event,\'list\',\'' + esc(list.id) + '\',\'' + esc(list.name) + '\',\'' + esc(spaceId) + '\')">'
                + '<span class="th-tree-list-icon">\uD83D\uDCCB</span>'
                + '<span class="th-tree-name">' + esc(list.name) + '</span>'
                + '<span class="th-tree-list-count">' + (list.task_count || 0) + '</span>'
                + '</button>';
        }
        // Docs inside folder
        for (const doc of (folder.docs || [])) {
            html += '<button class="th-tree-list th-tree-doc" onclick="openDoc(\'' + esc(doc.id) + '\',\'' + esc(spaceId) + '\')">'
                + '<span class="th-tree-list-icon">\uD83D\uDCC4</span>'
                + '<span class="th-tree-name">' + esc(doc.title) + '</span>'
                + '</button>';
        }
        html += '</div></div>';
    }
    for (const list of (data.folderless_lists || [])) {
        const active = _currentListId === list.id ? ' active' : '';
        html += '<button class="th-tree-list' + active + '" draggable="true" data-drag-type="list" data-drag-id="' + esc(list.id) + '" data-drag-space="' + esc(spaceId) + '" data-drag-folder="" data-drop-type="list" data-drop-id="' + esc(list.id) + '" data-drop-space="' + esc(spaceId) + '" onclick="selectList(\'' + esc(list.id) + '\',\'' + esc(list.name) + '\',\'' + esc(spaceId) + '\')" oncontextmenu="showCtxMenu(event,\'list\',\'' + esc(list.id) + '\',\'' + esc(list.name) + '\',\'' + esc(spaceId) + '\')">'
            + '<span class="th-tree-list-icon">\uD83D\uDCCB</span>'
            + '<span class="th-tree-name">' + esc(list.name) + '</span>'
            + '<span class="th-tree-list-count">' + (list.task_count || 0) + '</span>'
            + '</button>';
    }
    // Folderless docs at space level
    for (const doc of (data.docs || [])) {
        html += '<button class="th-tree-list th-tree-doc" onclick="openDoc(\'' + esc(doc.id) + '\',\'' + esc(spaceId) + '\')">'
            + '<span class="th-tree-list-icon">\uD83D\uDCC4</span>'
            + '<span class="th-tree-name">' + esc(doc.title) + '</span>'
            + '</button>';
    }
    return html;
}

function toggleFolder(folderId) {
    _expandedFolders[folderId] = !_expandedFolders[folderId];
    renderSpaceTree();
}

// ── List Selection ───────────────────────────────────────────

async function selectList(listId, listName, spaceId) {
    _currentListId = listId;
    _currentListName = listName;
    _currentSpaceId = spaceId;

    // Restore the user's selected view from the switcher buttons
    const activeBtn = document.querySelector('.th-view-btn.active');
    const selectedView = activeBtn?.dataset.view;
    // If no button is active (e.g. came from dashboard), default to list
    if (selectedView && selectedView !== 'dashboard') {
        _currentView = selectedView;
    } else if (_currentView === 'dashboard' || !_currentView) {
        // Coming from dashboard — pick the last non-dashboard view, default list
        _currentView = 'list';
        document.querySelectorAll('.th-view-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('.th-view-btn[data-view="list"]')?.classList.add('active');
    }

    // Load assignees for the workspace if not loaded
    if (spaceId) loadAssignees(spaceId);
    renderSpaceTree();

    const el = document.getElementById('main-content');
    el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:200px;"><div class="spinner"></div></div>';

    // Always load list items (needed for board/list, and calendar uses them at list level)
    try {
        const data = await api('GET', API + '/lists/' + listId + '/items');
        _tasks = data.items || [];
        _currentStatuses = data.statuses || [];
    } catch (e) {
        _tasks = [];
        _currentStatuses = [];
        showToast('Failed to load tasks');
    }
    renderMainContent();
    _aiOnContextChange();
}

// ── Space Dashboard ──────────────────────────────────────────

async function openSpaceDashboard(spaceId, spaceName) {
    _currentSpaceId = spaceId;
    _currentSpaceName = spaceName;
    _currentListId = null;
    _currentView = 'dashboard';
    document.querySelectorAll('.th-view-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.th-view-btn[data-view="board"]')?.classList.remove('active');
    renderSpaceTree();

    const el = document.getElementById('main-content');
    el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:200px;"><div class="spinner"></div></div>';

    try {
        const data = await api('GET', API + '/workspaces/' + spaceId + '/dashboard');
        renderDashboard(el, data, spaceName);
    } catch (e) {
        el.innerHTML = '<div class="empty-state"><div class="empty-state-text">Failed to load dashboard</div></div>';
    }
    _aiOnContextChange();
}

function renderDashboard(el, data, spaceName) {
    const d = data.data || {};
    const statuses = d.statuses || [];
    const statusCounts = d.status_counts || {};
    const priorityCounts = d.priority_counts || {};
    const dueSoon = d.due_soon || [];
    const activity = d.activity || [];
    const total = d.total_items || 0;

    let html = '<div class="th-dashboard">'
        + '<div class="th-dashboard-header">'
        + '<h2>' + esc(spaceName) + ' Dashboard</h2>'
        + '<span class="th-dashboard-total">' + total + ' items</span>'
        + '</div>'
        + '<div class="th-dashboard-grid">';

    // Status chart widget
    html += '<div class="th-widget">'
        + '<div class="th-widget-title">Tasks by Status</div>'
        + '<div class="th-widget-body">';
    for (const st of statuses) {
        const count = statusCounts[st.name] || 0;
        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
        html += '<div class="th-bar-row">'
            + '<span class="th-bar-label">' + esc(st.name) + '</span>'
            + '<div class="th-bar-track"><div class="th-bar-fill" style="width:' + pct + '%;background:' + esc(st.color) + ';"></div></div>'
            + '<span class="th-bar-count">' + count + '</span>'
            + '</div>';
    }
    html += '</div></div>';

    // Priority chart widget
    html += '<div class="th-widget">'
        + '<div class="th-widget-title">Priority Breakdown</div>'
        + '<div class="th-widget-body">';
    for (const p of PRIORITIES) {
        const count = priorityCounts[p.value] || 0;
        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
        html += '<div class="th-bar-row">'
            + '<span class="th-bar-label">' + esc(p.label) + '</span>'
            + '<div class="th-bar-track"><div class="th-bar-fill" style="width:' + pct + '%;background:' + esc(p.color) + ';"></div></div>'
            + '<span class="th-bar-count">' + count + '</span>'
            + '</div>';
    }
    html += '</div></div>';

    // Due soon widget
    html += '<div class="th-widget">'
        + '<div class="th-widget-title">Due Soon</div>'
        + '<div class="th-widget-body">';
    if (dueSoon.length === 0) {
        html += '<div style="color:var(--text-muted);font-size:13px;padding:8px;">No upcoming deadlines</div>';
    } else {
        for (const item of dueSoon) {
            const due = item.due_date ? new Date(item.due_date).toLocaleDateString('en', { month: 'short', day: 'numeric' }) : '';
            html += '<div class="th-widget-item" onclick="openDetail(\'' + esc(item.id) + '\')">'
                + '<span>' + esc(item.title || item.id) + '</span>'
                + '<span class="th-widget-item-due">' + esc(due) + '</span>'
                + '</div>';
        }
    }
    html += '</div></div>';

    // Recent activity widget
    html += '<div class="th-widget">'
        + '<div class="th-widget-title">Recent Activity</div>'
        + '<div class="th-widget-body">';
    if (activity.length === 0) {
        html += '<div style="color:var(--text-muted);font-size:13px;padding:8px;">No recent activity</div>';
    } else {
        for (const a of activity) {
            html += '<div class="th-widget-item">'
                + '<span>' + esc(a.action) + '</span>'
                + '<span class="th-widget-item-due">' + timeAgo(a.created_at) + '</span>'
                + '</div>';
        }
    }
    html += '</div></div>';

    // Files widget
    html += '<div class="th-widget">'
        + '<div class="th-widget-title">Files <button class="btn btn-small btn-ghost" onclick="openFileUpload()" style="float:right;font-size:10px;">+ Upload</button></div>'
        + '<div class="th-widget-body" id="dashboard-files">Loading...</div>'
        + '</div>';

    html += '</div></div>';
    el.innerHTML = html;

    // Load files async
    loadDashboardFiles();
}

async function loadDashboardFiles() {
    const container = document.getElementById('dashboard-files');
    if (!container) return;
    try {
        const data = await api('GET', API + '/workspaces/' + _currentSpaceId + '/files');
        const files = data.files || [];
        if (files.length === 0) {
            container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px;">No files shared</div>';
            return;
        }
        container.innerHTML = files.map(f =>
            '<div class="th-file-row" onclick="previewFile(\'' + esc(f.file_path) + '\',\'' + esc(f.file_name) + '\',\'' + esc(f.mime_type || '') + '\')">'
            + '<span class="th-file-icon">' + fileIcon(f.mime_type) + '</span>'
            + '<div class="th-file-info">'
            + '<div class="th-file-name">' + esc(f.file_name) + '</div>'
            + '<div class="th-file-meta">' + esc(f.uploader_name || 'Unknown') + ' &middot; ' + formatSize(f.file_size) + '</div>'
            + '</div>'
            + '<button class="btn btn-small btn-ghost" onclick="event.stopPropagation();deleteFile(\'' + esc(f.id) + '\')">&#10005;</button>'
            + '</div>'
        ).join('');
    } catch {
        container.innerHTML = '<div style="color:var(--text-muted);">Failed to load files</div>';
    }
}

// ── Task Filtering ──────────────────────────────────────────

function getVisibleTasks() {
    if (!_hideClosedTasks) return _tasks;
    const closedStatuses = new Set(
        _currentStatuses.filter(s => s.type === 'done' || s.type === 'closed').map(s => s.name)
    );
    if (!closedStatuses.size) return _tasks;
    return _tasks.filter(t => !closedStatuses.has(t.status));
}

function toggleHideClosed() {
    _hideClosedTasks = !_hideClosedTasks;
    renderMainContent();
}

function renderFilterToggle(visibleCount) {
    const hasClosedStatuses = _currentStatuses.some(s => s.type === 'done' || s.type === 'closed');
    if (!hasClosedStatuses) return '';
    const label = _hideClosedTasks ? 'Show closed' : 'Hide closed';
    const icon = _hideClosedTasks ? '&#9745;' : '&#9744;';
    return '<button class="btn btn-ghost btn-small th-filter-toggle' + (_hideClosedTasks ? ' active' : '') + '" onclick="toggleHideClosed()" title="' + label + '" style="margin-left:8px;font-size:12px;gap:4px;">'
        + icon + ' ' + label
        + (visibleCount < _tasks.length ? ' <span style="color:var(--text-muted);font-size:11px;">(' + visibleCount + '/' + _tasks.length + ')</span>' : '')
        + '</button>';
}

// ── Main Content Router ──────────────────────────────────────

function renderMainContent() {
    const el = document.getElementById('main-content');
    if (_currentView === 'dashboard') return;
    if (_currentView === 'calendar') {
        renderCalendarView(el);
        return;
    }
    if (!_currentListId) {
        if (_currentView === 'list') {
            renderHomeListView(el);
        } else {
            renderHome();
        }
        return;
    }
    if (_currentView === 'board') renderBoard(el);
    else renderList(el);
}

// ── Home Dashboard ───────────────────────────────────────────

const DEFAULT_HOME_TILES = [
    { id: 'top3', title: 'Top 3 Priorities', visible: true, order: 0, size: '1x1' },
    { id: 'overdue', title: 'Overdue', visible: true, order: 1, size: '1x1' },
    { id: 'due_week', title: 'Due This Week', visible: true, order: 2, size: '1x1' },
    { id: 'follow_ups', title: 'Follow-ups Due', visible: true, order: 3, size: '1x1' },
    { id: 'todos', title: 'Recent Todos', visible: true, order: 4, size: '1x1' },
    { id: 'workspaces', title: 'My Workspaces', visible: true, order: 5, size: '1x1' },
    { id: 'mentions', title: 'Mentions', visible: true, order: 6, size: '1x1' },
    { id: 'activity', title: 'Recent Activity', visible: true, order: 7, size: '1x1' },
];

// ── Top 3 Pinning ────────────────────────────────────────────
function getPinnedItems() {
    try {
        const key = 'teamhub_pinned_' + (_user ? _user.id : 'anon');
        return JSON.parse(localStorage.getItem(key) || '[]');
    } catch { return []; }
}

function savePinnedItems(ids) {
    const key = 'teamhub_pinned_' + (_user ? _user.id : 'anon');
    localStorage.setItem(key, JSON.stringify(ids));
}

function togglePinItem(itemId) {
    const pins = getPinnedItems();
    const idx = pins.indexOf(itemId);
    if (idx >= 0) pins.splice(idx, 1);
    else pins.push(itemId);
    savePinnedItems(pins);
    _homeData = null;
    renderMainContent();
}

function isItemPinned(itemId) {
    return getPinnedItems().includes(itemId);
}

function loadHomeLayout() {
    // Try localStorage cache first for instant render
    const key = 'teamhub_home_layout_' + (_user ? _user.id : 'anon');
    try {
        const stored = localStorage.getItem(key);
        if (stored) {
            const parsed = JSON.parse(stored);
            const knownIds = new Set(parsed.tiles.map(t => t.id));
            for (const dt of DEFAULT_HOME_TILES) {
                if (!knownIds.has(dt.id)) parsed.tiles.push({ ...dt, order: parsed.tiles.length });
            }
            _homeLayout = parsed;
            return parsed;
        }
    } catch { /* ignore */ }
    _homeLayout = { tiles: DEFAULT_HOME_TILES.map(t => ({ ...t })) };
    return _homeLayout;
}

async function loadHomeLayoutFromServer() {
    try {
        const remote = await api('GET', API + '/my/home-layout');
        if (remote && remote.tiles) {
            // Merge with defaults in case new tiles were added since save
            const knownIds = new Set(remote.tiles.map(t => t.id));
            for (const dt of DEFAULT_HOME_TILES) {
                if (!knownIds.has(dt.id)) remote.tiles.push({ ...dt, order: remote.tiles.length });
            }
            _homeLayout = remote;
            // Cache locally
            const key = 'teamhub_home_layout_' + (_user ? _user.id : 'anon');
            try { localStorage.setItem(key, JSON.stringify(_homeLayout)); } catch {}
            return true; // layout changed
        }
    } catch { /* server unavailable, use local */ }
    return false;
}

let _saveLayoutTimer = null;

function saveHomeLayout() {
    // Write to localStorage immediately (instant)
    const key = 'teamhub_home_layout_' + (_user ? _user.id : 'anon');
    try { localStorage.setItem(key, JSON.stringify(_homeLayout)); } catch { /* ignore */ }
    // Debounce server save (300ms) to avoid rapid-fire API calls during drag reorder
    clearTimeout(_saveLayoutTimer);
    _saveLayoutTimer = setTimeout(() => {
        api('PUT', API + '/my/home-layout', _homeLayout).catch(() => {});
    }, 300);
}

let _homeLayoutLoaded = false; // track if we've fetched from server this session

async function renderHome() {
    const el = document.getElementById('main-content');
    loadHomeLayout(); // instant from localStorage cache

    // Show loading state
    el.innerHTML = '<div class="home-dashboard"><div class="home-header">'
        + '<h2>Welcome back' + (_user ? ', ' + esc(_user.user_metadata?.display_name || _user.email?.split('@')[0] || '') : '') + '</h2>'
        + '<span class="home-date">' + new Date().toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) + '</span>'
        + '</div><div style="display:flex;align-items:center;justify-content:center;height:200px;"><div class="spinner"></div></div></div>';

    // Fetch server layout once per session (authoritative source)
    if (!_homeLayoutLoaded) {
        _homeLayoutLoaded = true;
        await loadHomeLayoutFromServer();
    }

    try {
        _homeData = await api('GET', API + '/my/home');
    } catch (e) {
        _homeData = {};
        // Build fallback workspace_summary from sidebar spaces if API failed
        if (_spaces && _spaces.length) {
            _homeData.workspace_summary = _spaces.map(s => ({
                id: s.id, name: s.name, icon: s.icon || '',
                color: s.color || '#6c5ce7', total_items: 0, done_count: 0, active_count: 0,
            }));
        }
        showToast('Failed to load home data');
    }

    renderHomeTiles();
}

function renderHomeTiles() {
    const el = document.getElementById('main-content');
    const layout = _homeLayout || loadHomeLayout();
    const data = _homeData || {};

    const visibleTiles = layout.tiles.filter(t => t.visible).sort((a, b) => a.order - b.order);

    let html = '<div class="home-dashboard">'
        + '<div class="home-header">'
        + '<div class="home-header-top">'
        + '<div><h2>Welcome back' + (_user ? ', ' + esc(_user.user_metadata?.display_name || _user.email?.split('@')[0] || '') : '') + '</h2>'
        + '<span class="home-date">' + new Date().toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) + '</span></div>'
        + '</div>'
        + '</div>'
        + '<div class="home-grid">';

    for (const tile of visibleTiles) {
        const sizeClass = tileSizeClass(tile.size);
        html += '<div class="home-tile' + sizeClass + '" draggable="true" data-tile-id="' + esc(tile.id) + '">'
            + '<div class="home-tile-header">'
            + '<span class="home-tile-title">' + esc(tile.title) + '</span>'
            + '<span class="home-tile-size-label">' + (tile.size || '1x1') + '</span>'
            + '<button class="home-tile-resize" onclick="event.stopPropagation();toggleTileSize(\'' + esc(tile.id) + '\')" title="Cycle size: 1x1 → 2x1 → 3x1 → 1x2 → 2x2 → 3x2">'
            + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>'
            + '</button></div>'
            + '<div class="home-tile-body">'
            + renderHomeTileContent(tile.id, data, tile.size || '1x1')
            + '</div></div>';
    }

    html += '</div></div>';
    el.innerHTML = html;
    bindHomeDragAndDrop();
}

function renderHomeTileContent(tileId, data, size) {
    size = size || '1x1';
    const cols = tileSizeCols(size);
    const rows = tileSizeRows(size);
    const area = cols * rows; // 1..6 — controls how much data to show
    const pri = { critical: '#e17055', high: '#fdcb6e', medium: '#74b9ff', low: '#8b8e96', none: '#595d66' };
    const statusColor = (s) => s === 'done' ? '#00b894' : s === 'in_progress' ? '#fdcb6e' : s === 'closed' ? '#636e72' : '#74b9ff';
    const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en', { month: 'short', day: 'numeric' }) : '';
    const fmtDateLong = (d) => d ? new Date(d).toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' }) : '';
    const isWide = cols >= 2;
    const isExtraWide = cols >= 3;
    const isTall = rows >= 2;

    if (tileId === 'top3') {
        // 1x1:3  2x1:5  3x1:8  1x2:8  2x2:15  3x2:25
        const limit = isTall ? (isExtraWide ? 25 : isWide ? 15 : 8) : (isExtraWide ? 8 : isWide ? 5 : 3);
        // Merge pinned items (shown first) with auto-priority items
        const pinnedIds = getPinnedItems();
        const autoItems = data.top_items || [];
        const pinned = autoItems.filter(i => pinnedIds.includes(i.id));
        const unpinned = autoItems.filter(i => !pinnedIds.includes(i.id));
        const items = [...pinned, ...unpinned].slice(0, limit);
        if (!items.length) return '<div class="home-tile-empty">No priorities right now.<br><small>Pin tasks from the detail panel.</small></div>';
        return items.map((i, idx) => {
            const pColor = pri[i.priority] || '#595d66';
            const due = fmtDate(i.due_date);
            const isPinned = pinnedIds.includes(i.id);
            const pinIcon = isPinned ? '<span class="home-tile-pin pinned" onclick="event.stopPropagation();togglePinItem(\'' + esc(i.id) + '\')" title="Unpin">&#128204;</span>' : '';
            const statusBadge = (isWide || isTall) ? '<span class="home-tile-meta">' + esc(i.status || '') + '</span>' : '';
            const wsBadge = isExtraWide && i.workspace_id ? '<span class="home-tile-meta ws-badge">' + esc(i.workspace_id).substring(0, 8) + '</span>' : '';
            const desc = isTall && isWide && i.description
                ? '<div class="home-tile-item-desc">' + esc((i.description || '').substring(0, 120)) + '</div>' : '';
            return '<div class="home-tile-item' + (isWide ? ' tile-item-row' : '') + '" onclick="openDetail(\'' + esc(i.id) + '\')">'
                + pinIcon
                + '<span class="home-tile-rank">#' + (idx + 1) + '</span>'
                + '<span class="home-tile-item-title">' + esc(i.title) + '</span>'
                + '<span class="cu-priority-pill" style="background:' + pColor + '22;color:' + pColor + ';font-size:10px;">' + esc(i.priority) + '</span>'
                + statusBadge
                + (due ? '<span class="home-tile-due">' + esc(due) + '</span>' : '')
                + wsBadge
                + '</div>' + desc;
        }).join('');
    }

    if (tileId === 'todos') {
        // 1x1:6  2x1:10  3x1:14  1x2:15  2x2:25  3x2:40
        const limit = isTall ? (isExtraWide ? 40 : isWide ? 25 : 15) : (isExtraWide ? 14 : isWide ? 10 : 6);
        const items = (data.recent_todos || []).slice(0, limit);
        if (!items.length) return '<div class="home-tile-empty">No recent todos</div>';
        return items.map(i => {
            const due = (isWide || isTall) ? fmtDate(i.due_date) : '';
            const pColor = isExtraWide || isTall ? pri[i.priority] || '#595d66' : '';
            const updated = isWide ? '<span class="home-tile-meta">' + timeAgo(i.updated_at) + '</span>' : '';
            return '<div class="home-tile-item' + (isWide ? ' tile-item-row' : '') + '" onclick="openDetail(\'' + esc(i.id) + '\')">'
                + '<span class="home-tile-status-dot" style="background:' + statusColor(i.status) + ';"></span>'
                + '<span class="home-tile-item-title">' + esc(i.title) + '</span>'
                + (pColor ? '<span class="cu-priority-pill" style="background:' + pColor + '22;color:' + pColor + ';font-size:10px;">' + esc(i.priority || 'none') + '</span>' : '')
                + '<span class="home-tile-meta">' + esc(i.status) + '</span>'
                + (due ? '<span class="home-tile-due">' + esc(due) + '</span>' : '')
                + updated
                + '</div>';
        }).join('');
    }

    if (tileId === 'overdue') {
        const items = data.overdue || [];
        if (!items.length) return '<div class="home-tile-empty home-tile-empty-good">All caught up!</div>';
        // 1x1:5  2x1:8  3x1:12  1x2:12  2x2:20  3x2:35
        const limit = isTall ? (isExtraWide ? 35 : isWide ? 20 : 12) : (isExtraWide ? 12 : isWide ? 8 : 5);
        const showing = items.slice(0, limit);
        let html = showing.map(i => {
            const due = fmtDate(i.due_date);
            const daysOverdue = i.due_date ? Math.floor((Date.now() - new Date(i.due_date).getTime()) / 86400000) : 0;
            const urgency = (isWide || isTall) ? '<span class="home-tile-meta overdue-days">' + daysOverdue + 'd overdue</span>' : '';
            const pColor = (isExtraWide || isTall) ? pri[i.priority] || '#595d66' : '';
            return '<div class="home-tile-item' + (isWide ? ' tile-item-row' : '') + '" onclick="openDetail(\'' + esc(i.id) + '\')">'
                + '<span class="home-tile-item-title">' + esc(i.title) + '</span>'
                + (pColor ? '<span class="cu-priority-pill" style="background:' + pColor + '22;color:' + pColor + ';font-size:10px;">' + esc(i.priority) + '</span>' : '')
                + '<span class="home-tile-due overdue">' + esc(due) + '</span>'
                + urgency
                + '</div>';
        }).join('');
        if (items.length > limit) html += '<div class="home-tile-overflow">+' + (items.length - limit) + ' more</div>';
        return html;
    }

    if (tileId === 'due_week') {
        const items = data.due_this_week || [];
        if (!items.length) return '<div class="home-tile-empty">Nothing due this week</div>';
        // 1x1:5  2x1:8  3x1:12  1x2:12  2x2:20  3x2:35
        const limit = isTall ? (isExtraWide ? 35 : isWide ? 20 : 12) : (isExtraWide ? 12 : isWide ? 8 : 5);
        const showing = items.slice(0, limit);

        // Group by day for wide+tall sizes
        if (isTall && isWide) {
            const byDay = {};
            for (const i of showing) {
                const dayKey = i.due_date || 'No date';
                if (!byDay[dayKey]) byDay[dayKey] = [];
                byDay[dayKey].push(i);
            }
            let html = '';
            for (const [day, dayItems] of Object.entries(byDay)) {
                html += '<div class="home-tile-day-header">' + fmtDateLong(day) + '</div>';
                html += dayItems.map(i => {
                    const pColor = pri[i.priority] || '#595d66';
                    return '<div class="home-tile-item tile-item-row" onclick="openDetail(\'' + esc(i.id) + '\')">'
                        + '<span class="home-tile-status-dot" style="background:' + statusColor(i.status) + ';"></span>'
                        + '<span class="home-tile-item-title">' + esc(i.title) + '</span>'
                        + '<span class="cu-priority-pill" style="background:' + pColor + '22;color:' + pColor + ';font-size:10px;">' + esc(i.priority || 'none') + '</span>'
                        + '<span class="home-tile-meta">' + esc(i.status) + '</span>'
                        + '</div>';
                }).join('');
            }
            if (items.length > limit) html += '<div class="home-tile-overflow">+' + (items.length - limit) + ' more</div>';
            return html;
        }

        let html = showing.map(i => {
            const due = (isWide || isTall) ? fmtDateLong(i.due_date) : fmtDate(i.due_date);
            const pColor = (isWide || isTall) ? pri[i.priority] || '#595d66' : '';
            return '<div class="home-tile-item" onclick="openDetail(\'' + esc(i.id) + '\')">'
                + '<span class="home-tile-item-title">' + esc(i.title) + '</span>'
                + (pColor ? '<span class="cu-priority-pill" style="background:' + pColor + '22;color:' + pColor + ';font-size:10px;">' + esc(i.priority || 'none') + '</span>' : '')
                + '<span class="home-tile-due">' + esc(due) + '</span>'
                + '</div>';
        }).join('');
        if (items.length > limit) html += '<div class="home-tile-overflow">+' + (items.length - limit) + ' more</div>';
        return html;
    }

    if (tileId === 'follow_ups') {
        const items = data.follow_ups_due || [];
        if (!items.length) return '<div class="home-tile-empty home-tile-empty-good">No follow-ups due</div>';
        // 1x1:5  2x1:8  3x1:12  1x2:12  2x2:20  3x2:35
        const fuLimit = isTall ? (isExtraWide ? 35 : isWide ? 20 : 12) : (isExtraWide ? 12 : isWide ? 8 : 5);
        const showing = items.slice(0, fuLimit);
        const todayStr = new Date().toISOString().split('T')[0];
        let html = showing.map(i => {
            const fuDate = fmtDate(i.follow_up_date);
            const isPast = i.follow_up_date < todayStr;
            const daysDiff = Math.abs(Math.floor((Date.now() - new Date(i.follow_up_date).getTime()) / 86400000));
            const urgencyLabel = isPast ? daysDiff + 'd overdue' : (daysDiff === 0 ? 'today' : 'in ' + daysDiff + 'd');
            const urgency = (isWide || isTall) ? '<span class="home-tile-meta' + (isPast ? ' overdue-days' : '') + '">' + urgencyLabel + '</span>' : '';
            const pColor = (isExtraWide || isTall) ? pri[i.priority] || '#595d66' : '';
            return '<div class="home-tile-item' + (isWide ? ' tile-item-row' : '') + '" onclick="openDetail(\'' + esc(i.id) + '\')">'
                + '<span class="home-tile-item-title">' + esc(i.title) + '</span>'
                + (pColor ? '<span class="cu-priority-pill" style="background:' + pColor + '22;color:' + pColor + ';font-size:10px;">' + esc(i.priority) + '</span>' : '')
                + '<span class="home-tile-due' + (isPast ? ' overdue' : '') + '">' + esc(fuDate) + '</span>'
                + urgency
                + '</div>';
        }).join('');
        if (items.length > fuLimit) html += '<div class="home-tile-overflow">+' + (items.length - fuLimit) + ' more</div>';
        return html;
    }

    if (tileId === 'mentions') {
        // 1x1:5  2x1:8  3x1:10  1x2:12  2x2:20  3x2:30
        const limit = isTall ? (isExtraWide ? 30 : isWide ? 20 : 12) : (isExtraWide ? 10 : isWide ? 8 : 5);
        const charLimit = isExtraWide ? 200 : isWide ? 120 : isTall ? 100 : 60;
        const items = (data.mentions || []).slice(0, limit);
        if (!items.length) return '<div class="home-tile-empty">No recent mentions</div>';

        // Build item lookup from all available home data arrays
        const allHomeItems = [
            ...(data.top_items || []), ...(data.recent_todos || []),
            ...(data.overdue || []), ...(data.due_this_week || []),
            ...(data.follow_ups_due || []),
        ];
        const itemMap = {};
        for (const it of allHomeItems) { if (it.id) itemMap[it.id] = it; }

        return items.map(c => {
            const authorProfile = _profiles.find(p => p.id === c.author_id);
            const authorName = authorProfile ? (authorProfile.display_name || authorProfile.email || '').split('@')[0] : '';
            const itemObj = c.item_id ? itemMap[c.item_id] : null;
            const itemTitle = itemObj ? itemObj.title : '';

            // Build preview with @mention highlighting
            const rawPreview = (c.content || '').substring(0, charLimit) + ((c.content || '').length > charLimit ? '...' : '');
            const hlPreview = esc(rawPreview).replace(/@(\w[\w\s]*?\w|\w)/g, '<span class="mention-hl">@$1</span>');

            // Header line: AuthorName in TaskTitle
            let headerHtml = '';
            if (authorName || itemTitle) {
                headerHtml = '<div style="font-size:11px;margin-bottom:2px;">';
                if (authorName) headerHtml += '<span class="mention-author">' + esc(authorName) + '</span>';
                if (itemTitle) headerHtml += (authorName ? ' in ' : '') + '<span class="mention-task">' + esc(itemTitle) + '</span>';
                headerHtml += '</div>';
            }

            const fullContent = isTall && isWide
                ? '<div class="home-tile-item-desc">' + esc((c.content || '').substring(0, 300)).replace(/@(\w[\w\s]*?\w|\w)/g, '<span class="mention-hl">@$1</span>') + '</div>' : '';
            return '<div class="home-tile-item' + (isWide ? ' tile-item-row' : '') + '" onclick="' + (c.item_id ? 'openDetail(\'' + esc(c.item_id) + '\')' : '') + '">'
                + headerHtml
                + '<span class="home-tile-item-title">' + hlPreview + '</span>'
                + '<span class="home-tile-meta">' + timeAgo(c.created_at) + '</span>'
                + '</div>' + fullContent;
        }).join('');
    }

    if (tileId === 'workspaces') {
        const items = data.workspace_summary || [];
        if (!items.length) return '<div class="home-tile-empty">No workspaces</div>';
        return items.map(w => {
            const pct = w.total_items > 0 ? Math.round((w.done_count / w.total_items) * 100) : 0;
            const stats = (isWide || isTall)
                ? '<span class="home-tile-meta">' + w.done_count + '/' + w.total_items + ' done (' + pct + '%)</span>'
                : '<span class="home-tile-meta">' + w.active_count + ' active</span>';
            const extraStats = isTall && isWide
                ? '<div class="home-tile-ws-stats">'
                    + '<span class="ws-stat"><span class="ws-stat-num">' + w.total_items + '</span> total</span>'
                    + '<span class="ws-stat"><span class="ws-stat-num">' + w.done_count + '</span> done</span>'
                    + '<span class="ws-stat"><span class="ws-stat-num">' + w.active_count + '</span> active</span>'
                    + '</div>'
                : '';
            return '<div class="home-tile-item home-tile-ws' + (isWide ? ' tile-item-row' : '') + '" onclick="clickSpace(\'' + esc(w.id) + '\',\'' + esc(w.name) + '\')">'
                + '<span class="th-tree-dot" style="background:' + esc(w.color || '#6c5ce7') + ';"></span>'
                + '<span class="home-tile-item-title">' + esc(w.name) + '</span>'
                + stats
                + '<div class="home-tile-progress"><div class="home-tile-progress-fill" style="width:' + pct + '%;background:' + esc(w.color || '#6c5ce7') + ';"></div></div>'
                + extraStats
                + '</div>';
        }).join('');
    }

    if (tileId === 'activity') {
        // 1x1:6  2x1:10  3x1:14  1x2:15  2x2:25  3x2:40
        const limit = isTall ? (isExtraWide ? 40 : isWide ? 25 : 15) : (isExtraWide ? 14 : isWide ? 10 : 6);
        const items = (data.recent_activity || []).slice(0, limit);
        if (!items.length) return '<div class="home-tile-empty">No recent activity</div>';
        return items.map(a => {
            const icon = a.action === 'item_created' ? '+' : a.action === 'item_updated' ? '~' : a.action === 'comment_added' ? '#' : a.action === 'item_deleted' ? '×' : '*';
            const details = (isWide || isTall) && a.details ? '<span class="home-tile-meta">' + esc(typeof a.details === 'string' ? a.details.substring(0, 60) : JSON.stringify(a.details).substring(0, 60)) + '</span>' : '';
            const fullDetails = isTall && isWide && a.details
                ? '<div class="home-tile-item-desc">' + esc(typeof a.details === 'string' ? a.details.substring(0, 200) : JSON.stringify(a.details).substring(0, 200)) + '</div>' : '';
            return '<div class="home-tile-item' + (isWide ? ' tile-item-row' : '') + '">'
                + '<span class="home-tile-activity-icon">' + icon + '</span>'
                + '<span class="home-tile-item-title">' + esc(a.action.replace(/_/g, ' ')) + '</span>'
                + details
                + '<span class="home-tile-meta">' + timeAgo(a.created_at) + '</span>'
                + '</div>' + fullDetails;
        }).join('');
    }

    return '<div class="home-tile-empty">No data</div>';
}

const TILE_SIZES = ['1x1', '2x1', '3x1', '1x2', '2x2', '3x2'];

function tileSizeClass(size) {
    const classes = { '1x1': '', '2x1': ' tile-2x1', '3x1': ' tile-3x1', '1x2': ' tile-1x2', '2x2': ' tile-2x2', '3x2': ' tile-3x2' };
    return classes[size] || '';
}

function tileSizeCols(size) { return parseInt((size || '1x1')[0]) || 1; }
function tileSizeRows(size) { return parseInt((size || '1x1')[2]) || 1; }

function toggleTileSize(tileId) {
    if (!_homeLayout) loadHomeLayout();
    const tile = _homeLayout.tiles.find(t => t.id === tileId);
    if (tile) {
        const idx = TILE_SIZES.indexOf(tile.size || '1x1');
        tile.size = TILE_SIZES[(idx + 1) % TILE_SIZES.length];
        saveHomeLayout();
        renderHomeTiles();
    }
}

// ── Home Drag-and-Drop ──────────────────────────────────────

let _homeDragTileId = null;

function bindHomeDragAndDrop() {
    document.querySelectorAll('.home-tile').forEach(tile => {
        tile.addEventListener('dragstart', (e) => {
            _homeDragTileId = tile.dataset.tileId;
            tile.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', tile.dataset.tileId);
        });
        tile.addEventListener('dragend', () => {
            tile.classList.remove('dragging');
            _homeDragTileId = null;
            document.querySelectorAll('.home-tile').forEach(t => t.classList.remove('drag-over-left', 'drag-over-right'));
        });
        tile.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (tile.dataset.tileId === _homeDragTileId) return;
            const rect = tile.getBoundingClientRect();
            const midX = rect.left + rect.width / 2;
            tile.classList.remove('drag-over-left', 'drag-over-right');
            tile.classList.add(e.clientX < midX ? 'drag-over-left' : 'drag-over-right');
        });
        tile.addEventListener('dragleave', () => {
            tile.classList.remove('drag-over-left', 'drag-over-right');
        });
        tile.addEventListener('drop', (e) => {
            e.preventDefault();
            tile.classList.remove('drag-over-left', 'drag-over-right');
            const dragId = e.dataTransfer.getData('text/plain');
            const dropId = tile.dataset.tileId;
            if (!dragId || dragId === dropId) return;
            reorderHomeTiles(dragId, dropId);
        });
    });
}

function reorderHomeTiles(dragId, dropId) {
    if (!_homeLayout) loadHomeLayout();
    const tiles = _homeLayout.tiles.filter(t => t.visible).sort((a, b) => a.order - b.order);
    const dragIdx = tiles.findIndex(t => t.id === dragId);
    const dropIdx = tiles.findIndex(t => t.id === dropId);
    if (dragIdx < 0 || dropIdx < 0) return;

    // Remove dragged tile and insert at drop position
    const [dragged] = tiles.splice(dragIdx, 1);
    tiles.splice(dropIdx, 0, dragged);

    // Update order values
    tiles.forEach((t, i) => {
        const layoutTile = _homeLayout.tiles.find(lt => lt.id === t.id);
        if (layoutTile) layoutTile.order = i;
    });

    saveHomeLayout();
    renderHomeTiles();
}

function goHome() {
    _currentSpaceId = null;
    _currentListId = null;
    _currentSpaceName = '';
    _currentListName = '';
    _homeData = null;
    document.querySelectorAll('.th-view-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.th-view-btn[data-view="board"]')?.classList.add('active');
    _currentView = 'board';
    renderSpaceTree();
    renderHome();
}

// ── Home List View (All Tasks) ────────────────────────────────

let _homeListItems = null;
let _homeListSort = 'updated_at';
let _homeListDir = 'desc';
let _homeListStatusFilter = '';
let _homeListPriorityFilter = '';
let _homeListSearch = '';
let _homeListWorkspaceFilter = '';
let _homeListTagFilter = '';
let _homeListShowAll = false;
let _homeListWorkspaces = {};
let _homeListAllTags = [];

async function renderHomeListView(el) {
    const userName = _user ? ', ' + esc(_user.user_metadata?.display_name || _user.email?.split('@')[0] || '') : '';
    const dateStr = new Date().toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    el.innerHTML = '<div class="home-list-view">'
        + '<div class="home-header">'
        + '<div class="home-header-top">'
        + '<div><h2>Welcome back' + userName + '</h2>'
        + '<span class="home-date">' + dateStr + '</span></div>'
        + '</div>'
        + '</div>'
        + '<div style="display:flex;align-items:center;justify-content:center;height:200px;"><div class="spinner"></div></div>'
        + '</div>';

    try {
        const params = new URLSearchParams({
            sort: _homeListSort,
            direction: _homeListDir,
            limit: '200',
        });
        if (_homeListStatusFilter) params.set('status', _homeListStatusFilter);
        if (_homeListPriorityFilter) params.set('priority', _homeListPriorityFilter);
        if (_homeListWorkspaceFilter) params.set('workspace_id', _homeListWorkspaceFilter);
        if (_homeListTagFilter) params.set('tag', _homeListTagFilter);
        if (_homeListShowAll) params.set('show_all', 'true');
        const data = await api('GET', API + '/my/all-items?' + params.toString());
        _homeListItems = data.items || [];
        _homeListWorkspaces = data.workspaces || {};
        _homeListAllTags = data.all_tags || [];
    } catch (e) {
        _homeListItems = [];
        showToast('Failed to load items');
    }

    renderHomeListTable(el);
}

function buildHomeListRows(items) {
    const statusColor = (s) => s === 'done' ? '#00b894' : s === 'in_progress' ? '#fdcb6e' : s === 'review' ? '#a29bfe' : s === 'closed' ? '#636e72' : '#74b9ff';
    if (!items.length) {
        return '<tr><td colspan="10" style="text-align:center;color:var(--text-muted);padding:40px;">No items found</td></tr>';
    }
    let rows = '';
    for (const t of items) {
        const due = t.due_date ? new Date(t.due_date).toLocaleDateString('en', { month: 'short', day: 'numeric' }) : '-';
        const dueOverdue = t.due_date && new Date(t.due_date) < new Date() && t.status !== 'done' && t.status !== 'closed' ? ' overdue' : '';
        const assignees = (t.assignees || []).map(a => resolveAssigneeName(a.assignee_id)).filter(Boolean).join(', ') || '-';
        const sColor = statusColor(t.status);
        const pObj = PRIORITIES.find(p => p.value === t.priority);
        const tags = (t.tags || []).map(tg => '<span class="th-tag-pill th-tag-clickable" style="background:' + esc(tg.color || '#6366f1') + '22;color:' + esc(tg.color || '#6366f1') + ';font-size:10px;cursor:pointer;" onclick="event.stopPropagation();filterByTag(\'' + esc(tg.name) + '\')" title="Filter by ' + esc(tg.name) + '">' + esc(tg.name) + '</span>').join(' ');
        const updated = timeAgo(t.updated_at);
        const checked = _selectedItems.has(t.id);
        rows += '<tr class="' + (checked ? 'th-batch-selected' : '') + '" onclick="openDetail(\'' + esc(t.id) + '\')">'
            + '<td class="th-list-check-col" onclick="event.stopPropagation()"><input type="checkbox" class="th-batch-check" ' + (checked ? 'checked' : '') + ' onchange="batchToggleItem(\'' + esc(t.id) + '\', this.checked)"></td>'
            + '<td class="th-list-title-cell">' + esc(t.title || '') + '</td>'
            + '<td><span class="home-list-ws-badge" style="background:' + esc(t.workspace_color || '#6c5ce7') + '22;color:' + esc(t.workspace_color || '#6c5ce7') + ';">' + esc(t.workspace_name || '') + '</span></td>'
            + '<td style="font-size:12px;color:var(--text-muted);">' + esc(t.list_name || '-') + '</td>'
            + '<td><span class="cu-status-pill" style="background:' + sColor + '22;color:' + sColor + ';">' + esc(t.status || '') + '</span></td>'
            + '<td>' + (pObj ? '<span class="cu-priority-pill" style="background:' + pObj.color + '22;color:' + pObj.color + ';">' + esc(pObj.label) + '</span>' : '-') + '</td>'
            + '<td style="font-size:12px;color:var(--text-muted);">' + esc(assignees) + '</td>'
            + '<td style="font-size:12px;" class="' + dueOverdue + '">' + esc(due) + '</td>'
            + '<td>' + tags + '</td>'
            + '<td style="font-size:11px;color:var(--text-muted);">' + esc(updated) + '</td>'
            + '</tr>';
    }
    return rows;
}

function renderHomeListTable(el) {
    const items = filterHomeListItems(_homeListItems || []);
    const sortIcon = (col) => {
        if (col !== _homeListSort) return '';
        return _homeListDir === 'asc' ? ' &#9650;' : ' &#9660;';
    };
    const sortAttr = (col) => 'onclick="homeListSortBy(\'' + col + '\')"';

    // If the list view already exists with table, do a surgical update to preserve input focus
    const existingView = el.querySelector('.home-list-view');
    const existingTbody = existingView && existingView.querySelector('.home-list-table tbody');
    if (existingView && existingTbody) {
        const subtitle = existingView.querySelector('.home-list-subtitle');
        if (subtitle) subtitle.textContent = items.length + ' item' + (items.length !== 1 ? 's' : '') + ' across all spaces';
        existingTbody.innerHTML = buildHomeListRows(items);
        // Update batch toolbar
        const oldToolbar = existingView.querySelector('.th-batch-toolbar');
        const newToolbarHtml = renderBatchToolbar();
        if (oldToolbar && !newToolbarHtml) oldToolbar.remove();
        else if (oldToolbar && newToolbarHtml) oldToolbar.outerHTML = newToolbarHtml;
        else if (!oldToolbar && newToolbarHtml) {
            const table = existingView.querySelector('.home-list-table');
            if (table) table.insertAdjacentHTML('beforebegin', newToolbarHtml);
        }
        // Update select-all checkbox
        const selectAllCb = existingView.querySelector('thead .th-batch-check');
        if (selectAllCb) selectAllCb.checked = items.length > 0 && items.every(t => _selectedItems.has(t.id));
        return;
    }

    const userName = _user ? ', ' + esc(_user.user_metadata?.display_name || _user.email?.split('@')[0] || '') : '';
    const dateStr = new Date().toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    // Build workspace options from cached data
    let wsOptions = '<option value="">All Spaces</option>';
    for (const [id, ws] of Object.entries(_homeListWorkspaces)) {
        wsOptions += '<option value="' + esc(id) + '"' + (_homeListWorkspaceFilter === id ? ' selected' : '') + '>' + esc(ws.name) + '</option>';
    }
    // Build tag options
    let tagOptions = '<option value="">All Tags</option>';
    for (const tg of _homeListAllTags) {
        tagOptions += '<option value="' + esc(tg.name) + '"' + (_homeListTagFilter === tg.name ? ' selected' : '') + '>' + esc(tg.name) + '</option>';
    }
    const toggleLabel = _homeListShowAll ? 'All Tasks' : 'My Tasks';
    const toggleTitle = _homeListShowAll ? 'Showing all workspace tasks — click to show only your assigned tasks' : 'Showing your assigned tasks — click to show all workspace tasks';

    let html = '<div class="home-list-view">'
        + '<div class="home-header">'
        + '<div class="home-header-top">'
        + '<div><h2>Welcome back' + userName + '</h2>'
        + '<span class="home-date">' + dateStr + '</span></div>'
        + '</div>'
        + '</div>'
        + '<div class="home-list-subheader">'
        + '<span class="home-list-subtitle">' + items.length + ' item' + (items.length !== 1 ? 's' : '') + ' across all spaces</span>'
        + '<button class="btn btn-small' + (_homeListShowAll ? ' btn-accent' : ' btn-ghost') + '" onclick="homeListToggleShowAll()" title="' + toggleTitle + '" style="margin-left:12px;font-size:11px;">' + toggleLabel + '</button>'
        + '</div>'
        + '<div class="home-list-filters">'
        + '<input type="text" class="home-list-search" placeholder="Filter tasks..." value="' + esc(_homeListSearch) + '" oninput="homeListSearchChanged(this.value)">'
        + '<select class="home-list-filter-select" onchange="homeListFilterWorkspace(this.value)">' + wsOptions + '</select>'
        + '<select class="home-list-filter-select" onchange="homeListFilterStatus(this.value)">'
        + '<option value="">All Statuses</option>'
        + '<option value="open"' + (_homeListStatusFilter === 'open' ? ' selected' : '') + '>Open</option>'
        + '<option value="in_progress"' + (_homeListStatusFilter === 'in_progress' ? ' selected' : '') + '>In Progress</option>'
        + '<option value="review"' + (_homeListStatusFilter === 'review' ? ' selected' : '') + '>Review</option>'
        + '<option value="done"' + (_homeListStatusFilter === 'done' ? ' selected' : '') + '>Done</option>'
        + '<option value="closed"' + (_homeListStatusFilter === 'closed' ? ' selected' : '') + '>Closed</option>'
        + '</select>'
        + '<select class="home-list-filter-select" onchange="homeListFilterPriority(this.value)">'
        + '<option value="">All Priorities</option>';
    for (const p of PRIORITIES) {
        html += '<option value="' + p.value + '"' + (_homeListPriorityFilter === p.value ? ' selected' : '') + '>' + p.label + '</option>';
    }
    html += '</select>'
        + '<select class="home-list-filter-select" onchange="homeListFilterTag(this.value)">' + tagOptions + '</select>'
        + '</div>'
        + renderBatchToolbar()
        + '<table class="th-list-table home-list-table"><thead><tr>'
        + '<th class="th-list-check-col"><input type="checkbox" class="th-batch-check" title="Select all" ' + (items.length > 0 && items.every(t => _selectedItems.has(t.id)) ? 'checked' : '') + ' onchange="batchToggleAllHome(this.checked)"></th>'
        + '<th class="sortable" ' + sortAttr('title') + '>Title' + sortIcon('title') + '</th>'
        + '<th>Space</th>'
        + '<th>List</th>'
        + '<th class="sortable" ' + sortAttr('status') + '>Status' + sortIcon('status') + '</th>'
        + '<th class="sortable" ' + sortAttr('priority') + '>Priority' + sortIcon('priority') + '</th>'
        + '<th>Assignees</th>'
        + '<th class="sortable" ' + sortAttr('due_date') + '>Due' + sortIcon('due_date') + '</th>'
        + '<th>Tags</th>'
        + '<th class="sortable" ' + sortAttr('updated_at') + '>Updated' + sortIcon('updated_at') + '</th>'
        + '</tr></thead><tbody>'
        + buildHomeListRows(items)
        + '</tbody></table></div>';
    el.innerHTML = html;
}

function filterHomeListItems(items) {
    if (!_homeListSearch) return items;
    const q = _homeListSearch.toLowerCase();
    return items.filter(i =>
        (i.title || '').toLowerCase().includes(q) ||
        (i.workspace_name || '').toLowerCase().includes(q) ||
        (i.list_name || '').toLowerCase().includes(q) ||
        (i.status || '').toLowerCase().includes(q)
    );
}

function homeListSortBy(col) {
    if (_homeListSort === col) {
        _homeListDir = _homeListDir === 'asc' ? 'desc' : 'asc';
    } else {
        _homeListSort = col;
        _homeListDir = col === 'title' ? 'asc' : 'desc';
    }
    _homeListItems = null;
    renderHomeListView(document.getElementById('main-content'));
}

function homeListFilterStatus(val) {
    _homeListStatusFilter = val;
    _homeListItems = null;
    renderHomeListView(document.getElementById('main-content'));
}

function homeListFilterPriority(val) {
    _homeListPriorityFilter = val;
    _homeListItems = null;
    renderHomeListView(document.getElementById('main-content'));
}

function homeListFilterWorkspace(val) {
    _homeListWorkspaceFilter = val;
    _homeListItems = null;
    renderHomeListView(document.getElementById('main-content'));
}

function homeListFilterTag(val) {
    _homeListTagFilter = val;
    _homeListItems = null;
    renderHomeListView(document.getElementById('main-content'));
}

function homeListToggleShowAll() {
    _homeListShowAll = !_homeListShowAll;
    _homeListItems = null;
    renderHomeListView(document.getElementById('main-content'));
}

// Click a tag pill anywhere to filter the home list by that tag
function filterByTag(tagName) {
    _homeListTagFilter = tagName;
    _homeListItems = null;
    _currentView = 'list';
    _currentSpaceId = null;
    _currentListId = null;
    document.querySelectorAll('.th-view-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.th-view-btn[data-view="list"]')?.classList.add('active');
    renderMainContent();
}

let _homeListSearchTimeout = null;
function homeListSearchChanged(val) {
    clearTimeout(_homeListSearchTimeout);
    _homeListSearchTimeout = setTimeout(() => {
        _homeListSearch = val;
        renderHomeListTable(document.getElementById('main-content'));
    }, 200);
}

function switchHomeTab(tab) {
    if (tab === 'list') {
        _currentView = 'list';
        document.querySelectorAll('.th-view-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('.th-view-btn[data-view="list"]')?.classList.add('active');
        renderMainContent();
    } else {
        _currentView = 'board';
        document.querySelectorAll('.th-view-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('.th-view-btn[data-view="board"]')?.classList.add('active');
        renderHome();
    }
}

// ── Board View ───────────────────────────────────────────────

let _collapsedColumns = new Set();

function renderBoard(el) {
    const visible = getVisibleTasks();
    const statusGroups = {};
    const statusOrder = _currentStatuses.map(s => s.name);
    const statusColors = {};
    for (const s of _currentStatuses) { statusColors[s.name] = s.color; }

    for (const t of visible) {
        const s = t.status || 'open';
        if (!statusGroups[s]) statusGroups[s] = [];
        statusGroups[s].push(t);
    }

    // Use defined status order — include ALL statuses (even empty ones)
    let ordered = [...statusOrder];
    for (const s of Object.keys(statusGroups)) {
        if (!ordered.includes(s)) ordered.push(s);
    }

    let html = '<div class="th-board-toolbar">'
        + '<span style="font-weight:600;font-size:14px;">' + esc(_currentListName) + '</span>'
        + '<span style="color:var(--text-muted);font-size:12px;margin-left:8px;">' + visible.length + ' tasks</span>'
        + renderFilterToggle(visible.length)
        + '<button class="btn btn-accent btn-small" onclick="openCreateNewModal(&#39;task&#39;)" style="margin-left:auto;">+ Task</button>'
        + '</div>';
    html += renderBatchToolbar();
    html += '<div class="th-board">';
    for (const status of ordered) {
        const items = statusGroups[status] || [];
        const color = statusColors[status] || '#595d66';
        const isCollapsed = _collapsedColumns.has(status);
        const collapseIcon = isCollapsed ? '&#9654;' : '&#9664;';

        html += '<div class="th-column' + (isCollapsed ? ' collapsed' : '') + '" data-col-status="' + esc(status) + '"'
            + (isCollapsed ? ' onclick="toggleBoardColumn(\'' + esc(status) + '\')"' : '') + '>'
            + '<div class="th-column-header" style="color:' + esc(color) + ';">'
            + '<button class="th-column-collapse" onclick="event.stopPropagation();toggleBoardColumn(\'' + esc(status) + '\')" title="' + (isCollapsed ? 'Expand' : 'Collapse') + '">' + collapseIcon + '</button>'
            + '<span>' + esc(status) + '</span>'
            + '<span class="col-count">' + items.length + '</span>'
            + '</div>'
            + '<div class="th-column-body" data-status="' + esc(status) + '">';

        if (!items.length && !isCollapsed) {
            html += '<div class="th-column-empty">Drag tasks here or click + below</div>';
        }
        for (const t of items) html += renderCard(t, statusColors);

        html += '</div>';

        // Quick-add button (only if not collapsed)
        if (!isCollapsed) {
            html += '<div class="th-board-quick-add" data-qa-status="' + esc(status) + '">'
                + '<button class="th-board-quick-add-btn" onclick="showBoardQuickAdd(\'' + esc(status) + '\')">+ Add task</button>'
                + '</div>';
        }

        html += '</div>';
    }
    html += '</div>';
    el.innerHTML = html;
    bindDragAndDrop();
}

function toggleBoardColumn(status) {
    if (_collapsedColumns.has(status)) _collapsedColumns.delete(status);
    else _collapsedColumns.add(status);
    renderMainContent();
}

function showBoardQuickAdd(status) {
    const container = document.querySelector('[data-qa-status="' + status + '"]');
    if (!container) return;
    container.innerHTML = '<input class="th-board-quick-input" placeholder="Task title..." '
        + 'onkeydown="if(event.key===\'Enter\'){event.preventDefault();submitBoardQuickAdd(\'' + esc(status) + '\',this.value)}"'
        + ' onblur="setTimeout(function(){renderMainContent()},200)">';
    container.querySelector('input').focus();
}

async function submitBoardQuickAdd(status, title) {
    title = (title || '').trim();
    if (!title || !_currentListId) return;
    try {
        await api('POST', API + '/lists/' + _currentListId + '/items', {
            title: title, type: 'task', status: status,
        });
        showToast('Task created');
        await selectList(_currentListId, _currentListName, _currentSpaceId);
        broadcast('task_created', { listId: _currentListId });
    } catch (err) {
        showToast('Failed: ' + (err.message || err));
    }
}

function renderCard(t, statusColors) {
    const color = statusColors[t.status] || '#595d66';
    const dueHtml = t.due_date ? formatDueBadge(t.due_date) : '';
    const fuHtml = t.follow_up_date ? formatFollowUpBadge(t.follow_up_date) : '';
    const assigneeNames = (t.assignees || []).map(a => resolveAssigneeName(a.assignee_id)).filter(Boolean);
    const assigneeHtml = assigneeNames.length ? '<span style="font-size:10px;color:var(--text-muted);">' + esc(assigneeNames.join(', ')) + '</span>' : '';
    const pObj = PRIORITIES.find(p => p.value === t.priority);
    const priorityHtml = pObj ? '<span class="th-card-priority" style="background:' + pObj.color + '22;color:' + pObj.color + ';">' + esc(pObj.label) + '</span>' : '';
    const checked = _selectedItems.has(t.id);

    // Description preview (first ~80 chars)
    const descPreview = t.description ? '<div class="th-card-desc">' + esc((t.description || '').substring(0, 80)) + (t.description.length > 80 ? '...' : '') + '</div>' : '';

    let tagsHtml = '';
    if (t.tags && t.tags.length) {
        tagsHtml = '<div class="th-card-tags">' + t.tags.map(tg =>
            '<span class="th-tag-pill th-tag-clickable" style="background:' + esc(tg.color || '#6366f1') + '22;color:' + esc(tg.color || '#6366f1') + ';cursor:pointer;" onclick="event.stopPropagation();filterByTag(\'' + esc(tg.name) + '\')" title="Filter by ' + esc(tg.name) + '">' + esc(tg.name) + '</span>'
        ).join('') + '</div>';
    }

    return '<div class="th-card' + (checked ? ' th-batch-selected' : '') + '" draggable="true" data-task-id="' + esc(t.id) + '" onclick="openDetail(\'' + esc(t.id) + '\')" oncontextmenu="showCtxMenu(event,\'task\',\'' + esc(t.id) + '\',\'' + esc((t.title || t.name || '').replace(/'/g, '')) + '\',\'' + esc(_currentSpaceId || '') + '\')">'
        + '<div class="th-card-check" onclick="event.stopPropagation()"><input type="checkbox" class="th-batch-check" ' + (checked ? 'checked' : '') + ' onchange="batchToggleItem(\'' + esc(t.id) + '\', this.checked)"></div>'
        + '<div class="th-card-title">' + esc(t.title || t.name || '') + '</div>'
        + descPreview
        + '<div class="th-card-meta">'
        + '<span class="cu-status-pill" style="background:' + color + '22;color:' + color + ';">' + esc(t.status) + '</span>'
        + priorityHtml + dueHtml + fuHtml + assigneeHtml
        + '</div>'
        + tagsHtml
        + '</div>';
}

function formatDueBadge(dateStr) {
    let d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    const overdue = d < new Date() ? ' overdue' : '';
    return '<span class="th-card-due' + overdue + '">' + d.toLocaleDateString('en', { month: 'short', day: 'numeric' }) + '</span>';
}

function formatFollowUpBadge(dateStr) {
    let d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    const isPast = d < new Date() ? ' follow-up-overdue' : '';
    return '<span class="th-card-follow-up' + isPast + '" title="Follow-up: ' + d.toLocaleDateString('en', { month: 'short', day: 'numeric' }) + '">&#x1F514; ' + d.toLocaleDateString('en', { month: 'short', day: 'numeric' }) + '</span>';
}

// ── Drag and Drop ────────────────────────────────────────────

function bindDragAndDrop() {
    document.querySelectorAll('.th-card').forEach(card => {
        card.addEventListener('dragstart', (e) => {
            card.classList.add('dragging');
            e.dataTransfer.setData('text/plain', card.dataset.taskId);
            e.dataTransfer.effectAllowed = 'move';
        });
        card.addEventListener('dragend', () => card.classList.remove('dragging'));
    });

    document.querySelectorAll('.th-column-body').forEach(col => {
        col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag-over'); });
        col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
        col.addEventListener('drop', async (e) => {
            e.preventDefault();
            col.classList.remove('drag-over');
            const taskId = e.dataTransfer.getData('text/plain');
            const newStatus = col.dataset.status;
            if (!taskId || !newStatus) return;

            const task = _tasks.find(t => t.id === taskId);
            if (task && task.status !== newStatus) {
                const oldStatus = task.status;
                task.status = newStatus;
                renderMainContent();
                try {
                    await api('PATCH', API + '/items/' + taskId, { status: newStatus });
                    broadcast('task_updated', { taskId, changes: { status: newStatus }, listId: _currentListId });
                } catch {
                    task.status = oldStatus;
                    renderMainContent();
                    showToast('Failed to update status');
                }
            }
        });
    });
}

// ── List View ────────────────────────────────────────────────

function renderList(el) {
    const visible = getVisibleTasks();
    const statusColors = {};
    for (const s of _currentStatuses) statusColors[s.name] = s.color;
    const allChecked = visible.length > 0 && visible.every(t => _selectedItems.has(t.id));

    let html = '<div class="th-list">'
        + '<div class="th-list-toolbar">'
        + '<span style="font-weight:600;font-size:14px;">' + esc(_currentListName) + '</span>'
        + '<span style="color:var(--text-muted);font-size:12px;margin-left:8px;">' + visible.length + ' tasks</span>'
        + renderFilterToggle(visible.length)
        + '<button class="btn btn-accent btn-small" onclick="openCreateNewModal(&#39;task&#39;)" style="margin-left:auto;">+ Task</button>'
        + '</div>'
        + renderBatchToolbar()
        + '<table class="th-list-table"><thead><tr>'
        + '<th class="th-list-check-col"><input type="checkbox" class="th-batch-check" title="Select all" ' + (allChecked ? 'checked' : '') + ' onchange="batchToggleAll(this.checked)"></th>'
        + '<th>Title</th><th>Status</th><th>Priority</th><th>Assignees</th><th>Due</th><th>Follow-up</th><th>Tags</th>'
        + '</tr></thead><tbody>';

    if (!visible.length) {
        html += '<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:40px;">No tasks</td></tr>';
    }
    for (const t of visible) {
        const due = t.due_date ? new Date(t.due_date).toLocaleDateString('en', { month: 'short', day: 'numeric' }) : '-';
        const followUp = t.follow_up_date ? new Date(t.follow_up_date).toLocaleDateString('en', { month: 'short', day: 'numeric' }) : '-';
        const fuOverdue = t.follow_up_date && new Date(t.follow_up_date) < new Date() ? ' follow-up-overdue' : '';
        const assignees = (t.assignees || []).map(a => resolveAssigneeName(a.assignee_id)).filter(Boolean).join(', ') || '-';
        const color = statusColors[t.status] || '#595d66';
        const pObj = PRIORITIES.find(p => p.value === t.priority);
        const tags = (t.tags || []).map(tg => '<span class="th-tag-pill th-tag-clickable" style="background:' + esc(tg.color || '#6366f1') + '22;color:' + esc(tg.color || '#6366f1') + ';font-size:10px;cursor:pointer;" onclick="event.stopPropagation();filterByTag(\'' + esc(tg.name) + '\')" title="Filter by ' + esc(tg.name) + '">' + esc(tg.name) + '</span>').join(' ');
        const checked = _selectedItems.has(t.id);

        html += '<tr class="' + (checked ? 'th-batch-selected' : '') + '" onclick="openDetail(\'' + esc(t.id) + '\')" oncontextmenu="showCtxMenu(event,\'task\',\'' + esc(t.id) + '\',\'' + esc((t.title || t.name || '').replace(/'/g, '')) + '\',\'' + esc(_currentSpaceId || '') + '\')">'
            + '<td class="th-list-check-col" onclick="event.stopPropagation()"><input type="checkbox" class="th-batch-check" ' + (checked ? 'checked' : '') + ' onchange="batchToggleItem(\'' + esc(t.id) + '\', this.checked)"></td>'
            + '<td class="th-list-title-cell">' + esc(t.title || t.name || '') + '</td>'
            + '<td><span class="cu-status-pill" style="background:' + color + '22;color:' + color + ';">' + esc(t.status) + '</span></td>'
            + '<td>' + (pObj ? '<span class="cu-priority-pill" style="background:' + pObj.color + '22;color:' + pObj.color + ';">' + esc(pObj.label) + '</span>' : '-') + '</td>'
            + '<td style="font-size:12px;color:var(--text-muted);">' + esc(assignees) + '</td>'
            + '<td style="font-size:12px;">' + esc(due) + '</td>'
            + '<td style="font-size:12px;" class="' + fuOverdue + '">' + esc(followUp) + '</td>'
            + '<td>' + tags + '</td>'
            + '</tr>';
    }
    html += '</tbody></table></div>';
    el.innerHTML = html;
}

// ── Detail Panel (Interactive) ───────────────────────────────

async function openDetail(taskId) {
    const panel = document.getElementById('detail-panel');
    const body = document.getElementById('detail-body');
    body.innerHTML = '<div style="display:flex;justify-content:center;padding:40px;"><div class="spinner"></div></div>';
    panel.classList.add('open');
    document.getElementById('detail-backdrop').style.display = 'block';

    try {
        _detailTask = await api('GET', API + '/items/' + taskId);
    } catch {
        body.innerHTML = '<div class="empty-state"><div class="empty-state-text">Failed to load task</div></div>';
        return;
    }

    // Load statuses for this workspace if not cached
    if (!_currentStatuses.length && _detailTask.workspace_id) {
        try {
            const stData = await api('GET', API + '/workspaces/' + _detailTask.workspace_id + '/statuses');
            _currentStatuses = stData.statuses || [];
        } catch {}
    }

    renderDetailPanel();
}

function renderDetailPanel() {
    const t = _detailTask;
    if (!t) return;
    const body = document.getElementById('detail-body');
    const statusColors = {};
    for (const s of _currentStatuses) statusColors[s.name] = s.color;

    // Type badge in header
    const typeBadge = document.getElementById('detail-type-badge');
    typeBadge.textContent = t.type || 'task';
    typeBadge.style.background = 'var(--accent)22';
    typeBadge.style.color = 'var(--accent)';

    // Header actions (pin, move, duplicate, delete)
    const headerActions = document.getElementById('detail-header-actions');
    if (headerActions) {
        const pinned = isItemPinned(t.id);
        const pinLabel = pinned ? 'Unpin' : 'Pin to Top 3';
        const pinClass = pinned ? ' active' : '';
        headerActions.innerHTML = ''
            + '<button class="th-detail-action-btn' + pinClass + '" onclick="togglePinItem(\'' + esc(t.id) + '\')" title="' + pinLabel + '">'
            + '<svg width="14" height="14" viewBox="0 0 24 24" fill="' + (pinned ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2"><path d="M12 2l2.09 6.26L21 9.27l-5 3.64L17.18 20 12 16.77 6.82 20 8 12.91l-5-3.64 6.91-1.01z"/></svg> ' + pinLabel + '</button>'
            + '<button class="th-detail-action-btn" onclick="openMoveItemModal()" title="Move to another list">'
            + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg> Move</button>'
            + '<button class="th-detail-action-btn" onclick="duplicateDetailItem()" title="Duplicate item">'
            + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Duplicate</button>'
            + '<button class="th-detail-action-btn danger" onclick="deleteDetailItem()" title="Delete item">'
            + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Delete</button>';
    }

    let html = '';

    // Editable title
    html += '<input class="th-detail-title-input" value="' + esc(t.title || t.name || '') + '" onblur="updateField(\'title\', this.value)" onkeydown="if(event.key===\'Enter\')this.blur();">';

    // Status + Priority + Due row (colored pill-dropdowns)
    html += '<div class="th-detail-row">';

    // Status pill-dropdown
    const curStatus = _currentStatuses.find(s => s.name === t.status);
    const stColor = curStatus ? curStatus.color : '#595d66';
    html += '<div class="th-detail-field"><div class="th-detail-field-label">Status</div>'
        + '<div class="th-pill-dd" id="pill-dd-status">'
        + '<div class="th-pill-dd-trigger" onclick="togglePillDD(\'status\')" style="color:' + esc(stColor) + ';background:' + esc(stColor) + '18;">'
        + '<span class="th-pill-dd-dot" style="background:' + esc(stColor) + ';"></span>'
        + '<span class="th-pill-dd-label">' + esc(t.status) + '</span>'
        + '<svg class="th-pill-dd-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>'
        + '</div></div></div>';

    // Priority pill-dropdown
    const curPri = PRIORITIES.find(p => p.value === t.priority) || PRIORITIES[4];
    html += '<div class="th-detail-field"><div class="th-detail-field-label">Priority</div>'
        + '<div class="th-pill-dd" id="pill-dd-priority">'
        + '<div class="th-pill-dd-trigger" onclick="togglePillDD(\'priority\')" style="color:' + esc(curPri.color) + ';background:' + esc(curPri.color) + '18;">'
        + '<span class="th-pill-dd-dot" style="background:' + esc(curPri.color) + ';"></span>'
        + '<span class="th-pill-dd-label">' + esc(curPri.label) + '</span>'
        + '<svg class="th-pill-dd-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>'
        + '</div></div></div>';

    // Due date picker
    const dueVal = t.due_date ? new Date(t.due_date).toISOString().split('T')[0] : '';
    html += '<div class="th-detail-field"><div class="th-detail-field-label">Due Date</div>'
        + '<input type="date" class="form-input th-inline-date" value="' + dueVal + '" onchange="updateField(\'due_date\', this.value)">'
        + '</div>';

    // Follow-up date picker
    const fuVal = t.follow_up_date ? new Date(t.follow_up_date).toISOString().split('T')[0] : '';
    html += '<div class="th-detail-field"><div class="th-detail-field-label">Follow-up Date</div>'
        + '<input type="date" class="form-input th-inline-date" value="' + fuVal + '" onchange="updateField(\'follow_up_date\', this.value)">'
        + '</div>';

    // Recurrence
    const rec = t.recurrence || {};
    const recFreq = rec.frequency || '';
    const recInterval = rec.interval || 1;
    const recCarryDesc = rec.carry_description !== false;
    const recCarryComments = rec.carry_comments === true;
    html += '<div class="th-detail-field"><div class="th-detail-field-label">Recurrence</div>'
        + '<div class="th-recurrence-row">'
        + '<select class="form-select th-recurrence-freq" onchange="updateRecurrence()" id="rec-freq">'
        + '<option value=""' + (!recFreq ? ' selected' : '') + '>None</option>'
        + '<option value="daily"' + (recFreq === 'daily' ? ' selected' : '') + '>Daily</option>'
        + '<option value="weekly"' + (recFreq === 'weekly' ? ' selected' : '') + '>Weekly</option>'
        + '<option value="monthly"' + (recFreq === 'monthly' ? ' selected' : '') + '>Monthly</option>'
        + '<option value="yearly"' + (recFreq === 'yearly' ? ' selected' : '') + '>Yearly</option>'
        + '</select>';
    if (recFreq) {
        html += '<span class="th-rec-label">every</span>'
            + '<input type="number" class="form-input th-rec-interval" id="rec-interval" value="' + recInterval + '" min="1" max="365" onchange="updateRecurrence()">'
            + '<span class="th-rec-label">' + (recFreq === 'daily' ? 'day(s)' : recFreq === 'weekly' ? 'week(s)' : recFreq === 'monthly' ? 'month(s)' : 'year(s)') + '</span>';
    }
    html += '</div>';
    if (recFreq) {
        html += '<div class="th-recurrence-options">'
            + '<label class="th-rec-checkbox"><input type="checkbox" id="rec-carry-desc"' + (recCarryDesc ? ' checked' : '') + ' onchange="updateRecurrence()"> Carry description</label>'
            + '<label class="th-rec-checkbox"><input type="checkbox" id="rec-carry-comments"' + (recCarryComments ? ' checked' : '') + ' onchange="updateRecurrence()"> Carry comments</label>'
            + '</div>';
    }
    html += '</div>';

    html += '</div>';

    // Assignees with dropdown
    html += '<div class="th-detail-field"><div class="th-detail-field-label">Assignees</div>'
        + '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">';
    const assigned = t.assignments || [];
    for (const a of assigned) {
        if (a.assignee_id && a.assignee_id.startsWith('clickup:')) continue; // Skip ClickUp placeholders
        const name = resolveAssigneeName(a.assignee_id);
        if (!name) continue;
        const initials = resolveAssigneeInitials(a.assignee_id);
        html += '<div class="th-assignee-chip">'
            + '<div class="th-member-avatar" style="width:20px;height:20px;font-size:8px;">' + esc(initials) + '</div>'
            + '<span>' + esc(name) + '</span>'
            + '<button class="th-chip-remove" onclick="removeAssignee(\'' + esc(a.id) + '\')">&times;</button>'
            + '</div>';
    }
    // Add assignee dropdown — only real OPAI team members
    html += '<select class="form-select th-inline-select" style="width:auto;min-width:120px;" onchange="addAssignee(this.value);this.value=\'\';">'
        + '<option value="">+ Assign</option>';
    const assignedIds = new Set(assigned.map(a => a.assignee_id));
    // Show workspace assignees (already filtered to OPAI-only in backend)
    for (const a of _allAssignees) {
        if (!assignedIds.has(a.id)) {
            html += '<option value="' + esc(a.id) + '">' + esc(a.name) + '</option>';
        }
    }
    // Fallback: also show OPAI profiles not in _allAssignees
    const allIds = new Set(_allAssignees.map(a => a.id));
    for (const p of _profiles) {
        if (!assignedIds.has(p.id) && !allIds.has(p.id)) {
            html += '<option value="' + esc(p.id) + '">' + esc(p.display_name || p.email) + '</option>';
        }
    }
    html += '</select></div></div>';

    // Tags with add/remove
    html += '<div class="th-detail-field"><div class="th-detail-field-label">Tags</div>'
        + '<div class="th-detail-tags" id="detail-tags">';
    const itemTags = t.tags || [];
    for (const tag of itemTags) {
        html += '<span class="th-tag-pill th-tag-removable" style="background:' + esc(tag.color || '#6366f1') + '22;color:' + esc(tag.color || '#6366f1') + ';">'
            + esc(tag.name) + '<button class="th-tag-x" onclick="removeTag(\'' + esc(tag.id) + '\')">&times;</button></span>';
    }
    html += '<button class="th-detail-tag-add" onclick="openTagPicker()">+ Tag</button>';
    html += '</div></div>';

    // Links section
    const links = t.links || [];
    html += '<div class="th-detail-field"><div class="th-detail-field-label">Links</div>'
        + '<div class="th-detail-links" id="detail-links">';
    for (let i = 0; i < links.length; i++) {
        const lnk = links[i];
        html += '<div class="th-link-row">'
            + '<a href="' + esc(lnk.url || '') + '" target="_blank" rel="noopener" class="th-link-url" title="' + esc(lnk.url || '') + '">' + esc(lnk.label || lnk.url || '') + '</a>'
            + '<button class="th-link-remove" onclick="removeLink(' + i + ')" title="Remove link">&times;</button>'
            + '</div>';
    }
    html += '<button class="th-detail-tag-add" onclick="openAddLinkModal()">+ Link</button>';
    html += '</div></div>';

    // Description (pretty/edit toggle with formatting toolbar)
    html += '<div class="th-detail-field">'
        + '<div class="th-detail-field-label" style="display:flex;align-items:center;gap:8px;">Description '
        + '<span class="th-desc-toggle" style="margin-left:auto;">'
        + '<button class="btn btn-small th-desc-mode-btn active" data-mode="pretty" onclick="toggleDescMode(\'pretty\')">Preview</button>'
        + '<button class="btn btn-small btn-ghost th-desc-mode-btn" data-mode="raw" onclick="toggleDescMode(\'raw\')">Edit</button>'
        + '</span></div>'
        + '<div class="th-desc-rendered" id="desc-rendered" onclick="toggleDescMode(\'raw\');document.getElementById(\'desc-raw\').focus();" title="Click to edit" style="cursor:text;"></div>'
        + '<div class="th-desc-toolbar" id="desc-toolbar" style="display:none;">'
        + '<select class="th-desc-tb-select" onchange="descInsertHeading(this.value);this.selectedIndex=0;" title="Heading">'
        + '<option value="">Heading</option><option value="1">H1</option><option value="2">H2</option><option value="3">H3</option><option value="4">H4</option></select>'
        + '<button class="th-desc-tb-btn" onclick="descWrapSelection(\'**\',\'**\')" title="Bold"><b>B</b></button>'
        + '<button class="th-desc-tb-btn" onclick="descWrapSelection(\'*\',\'*\')" title="Italic"><i>I</i></button>'
        + '<button class="th-desc-tb-btn" onclick="descInsertLinePrefix(\'- \')" title="Bullet list">&#8226;</button>'
        + '<button class="th-desc-tb-btn" onclick="descInsertNumberedList()" title="Numbered list">1.</button>'
        + '<button class="th-desc-tb-btn" onclick="descInsertLinePrefix(\'  \')" title="Indent">&#8594;</button>'
        + '<button class="th-desc-tb-btn" onclick="descWrapSelection(\'`\',\'`\')" title="Code">&#60;/&#62;</button>'
        + '<button class="th-desc-tb-btn" onclick="descInsertLinePrefix(\'> \')" title="Quote">&#8220;</button>'
        + '<button class="th-desc-tb-btn" onclick="descWrapSelection(\'[link text](\',\')\')" title="Link">&#128279;</button>'
        + '</div>'
        + '<textarea class="th-detail-desc" id="desc-raw" style="display:none;" onblur="updateField(\'description\', this.value)">' + esc(t.description || '') + '</textarea>'
        + '</div>';

    // Files section
    html += '<div class="th-detail-field"><div class="th-detail-field-label">Files <button class="btn btn-small btn-ghost" onclick="openFileUpload(\'' + esc(t.id) + '\')" style="font-size:10px;margin-left:8px;">+ Upload</button></div>'
        + '<div id="detail-files">Loading...</div></div>';

    // Comments
    html += '<div class="th-comments-section">'
        + '<div class="th-comments-title">Comments</div>'
        + '<div class="th-comments-list">';

    // Fetch comments from the item endpoint (they're in team_comments table)
    html += '<div id="detail-comments">Loading...</div>';

    html += '</div>';

    // Comment input
    html += '<div class="th-comment-input-wrap">'
        + '<div class="th-comment-input-row">'
        + '<input class="th-comment-input" id="comment-input" placeholder="Add a comment... (@name to mention)" onkeydown="if(event.key===\'Enter\')postComment();">'
        + '<button class="btn btn-small btn-ghost th-comment-img-btn" onclick="commentUploadImage()" title="Attach image">&#128247;</button>'
        + '<button class="btn btn-accent btn-small" onclick="postComment()">Send</button>'
        + '</div>'
        + '<div id="comment-image-preview" class="th-comment-img-preview" style="display:none;"></div>'
        + '</div></div>';

    body.innerHTML = html;

    // Render markdown description in pretty mode
    renderDescription(t.description || '');

    // Bind @mention autocomplete on comment input
    bindMentionAutocomplete();

    // Bind paste handler for image paste in comments
    bindCommentPasteHandler();

    // Load comments and files async
    loadDetailComments();
    loadDetailFiles();
}

// ── Description Pretty/Raw Toggle ─────────────────────────────

let _descMode = 'pretty';

function renderDescription(desc) {
    const container = document.getElementById('desc-rendered');
    if (!container) return;
    if (!desc || !desc.trim()) {
        container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;font-style:italic;">No description</div>';
        return;
    }
    const md = window.markdownit ? window.markdownit({ html: false, linkify: true, breaks: true }) : null;
    if (!md) {
        container.textContent = desc;
        return;
    }
    // Custom checkbox rendering: - [ ] and - [x]
    let html = md.render(desc);
    let cbIndex = 0;
    html = html.replace(/<li>([\s\S]*?)<\/li>/g, (match, inner) => {
        const unchecked = /^\s*\[ \]\s*/.test(inner);
        const checked = /^\s*\[x\]\s*/i.test(inner);
        if (unchecked || checked) {
            const idx = cbIndex++;
            const cleanInner = inner.replace(/^\s*\[[ x]\]\s*/i, '');
            return '<li class="th-cb-item">'
                + '<input type="checkbox"' + (checked ? ' checked' : '') + ' onchange="handleCheckboxToggle(' + idx + ')">'
                + '<span>' + cleanInner + '</span></li>';
        }
        return match;
    });
    container.innerHTML = html;
}

function toggleDescMode(mode) {
    _descMode = mode;
    const rendered = document.getElementById('desc-rendered');
    const raw = document.getElementById('desc-raw');
    const btns = document.querySelectorAll('.th-desc-mode-btn');
    if (!rendered || !raw) return;

    btns.forEach(b => {
        b.classList.toggle('active', b.dataset.mode === mode);
        b.classList.toggle('btn-ghost', b.dataset.mode !== mode);
    });

    const toolbar = document.getElementById('desc-toolbar');
    if (mode === 'pretty') {
        raw.style.display = 'none';
        if (toolbar) toolbar.style.display = 'none';
        rendered.style.display = '';
        renderDescription(raw.value);
    } else {
        rendered.style.display = 'none';
        raw.style.display = '';
        if (toolbar) toolbar.style.display = 'flex';
        raw.focus();
    }
}

// ── Description formatting helpers ────────────────────────────

function descWrapSelection(before, after) {
    const ta = document.getElementById('desc-raw');
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.substring(start, end);
    const replacement = before + (selected || 'text') + after;
    ta.setRangeText(replacement, start, end, 'select');
    ta.focus();
    // Adjust selection to highlight inserted text (not the markers)
    ta.selectionStart = start + before.length;
    ta.selectionEnd = start + before.length + (selected || 'text').length;
}

function descInsertHeading(level) {
    if (!level) return;
    const ta = document.getElementById('desc-raw');
    if (!ta) return;
    const prefix = '#'.repeat(parseInt(level)) + ' ';
    const start = ta.selectionStart;
    // Find the beginning of the current line
    const lineStart = ta.value.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = ta.value.indexOf('\n', start);
    const line = ta.value.substring(lineStart, lineEnd === -1 ? ta.value.length : lineEnd);
    // Strip existing heading markers
    const stripped = line.replace(/^#{1,6}\s*/, '');
    const newLine = prefix + stripped;
    ta.setRangeText(newLine, lineStart, lineEnd === -1 ? ta.value.length : lineEnd, 'end');
    ta.focus();
}

function descInsertLinePrefix(prefix) {
    const ta = document.getElementById('desc-raw');
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.substring(start, end);
    if (selected.includes('\n')) {
        // Multi-line: prefix each line
        const replacement = selected.split('\n').map(l => prefix + l).join('\n');
        ta.setRangeText(replacement, start, end, 'end');
    } else {
        // Single line: insert prefix at line start
        const lineStart = ta.value.lastIndexOf('\n', start - 1) + 1;
        ta.setRangeText(prefix, lineStart, lineStart, 'end');
    }
    ta.focus();
}

function descInsertNumberedList() {
    const ta = document.getElementById('desc-raw');
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.substring(start, end);
    if (selected.includes('\n')) {
        const lines = selected.split('\n');
        const replacement = lines.map((l, i) => (i + 1) + '. ' + l).join('\n');
        ta.setRangeText(replacement, start, end, 'end');
    } else {
        const lineStart = ta.value.lastIndexOf('\n', start - 1) + 1;
        ta.setRangeText('1. ', lineStart, lineStart, 'end');
    }
    ta.focus();
}

function handleCheckboxToggle(index) {
    const raw = document.getElementById('desc-raw');
    if (!raw) return;
    let text = raw.value;
    let cbCount = 0;
    text = text.replace(/^([ \t]*-\s*)\[([ x])\]/gim, (match, prefix, state) => {
        if (cbCount === index) {
            cbCount++;
            return prefix + (state === ' ' ? '[x]' : '[ ]');
        }
        cbCount++;
        return match;
    });
    raw.value = text;
    renderDescription(text);
    updateField('description', text);
}

// ── @Mention Autocomplete ─────────────────────────────────────

let _mentionActive = false;
let _mentionIndex = 0;
let _mentionMatches = [];

function bindMentionAutocomplete() {
    const input = document.getElementById('comment-input');
    if (!input) return;

    // Create dropdown if not exists
    let dd = document.getElementById('mention-dropdown');
    if (!dd) {
        dd = document.createElement('div');
        dd.id = 'mention-dropdown';
        dd.className = 'mention-dropdown';
        dd.style.display = 'none';
        document.body.appendChild(dd);
    }

    input.addEventListener('input', () => {
        const val = input.value;
        const cursor = input.selectionStart;
        const before = val.substring(0, cursor);
        const match = before.match(/@(\w*)$/);
        if (!match) { hideMentionDropdown(); return; }

        const query = match[1].toLowerCase();
        // Build member list from _allAssignees + _profiles
        const seen = new Set();
        const members = [];
        for (const a of _allAssignees) {
            if (!seen.has(a.id)) { seen.add(a.id); members.push({ id: a.id, name: a.name }); }
        }
        for (const p of _profiles) {
            if (!seen.has(p.id)) {
                seen.add(p.id);
                members.push({ id: p.id, name: p.display_name || p.email });
            }
        }

        _mentionMatches = members.filter(m => m.name.toLowerCase().includes(query)).slice(0, 5);
        if (!_mentionMatches.length) { hideMentionDropdown(); return; }

        _mentionActive = true;
        _mentionIndex = 0;
        renderMentionDropdown(input);
    });

    input.addEventListener('keydown', (e) => {
        if (!_mentionActive) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            _mentionIndex = Math.min(_mentionIndex + 1, _mentionMatches.length - 1);
            renderMentionDropdown(input);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            _mentionIndex = Math.max(_mentionIndex - 1, 0);
            renderMentionDropdown(input);
        } else if (e.key === 'Enter' && _mentionActive) {
            e.preventDefault();
            e.stopPropagation();
            selectMention(input, _mentionMatches[_mentionIndex]);
        } else if (e.key === 'Escape') {
            hideMentionDropdown();
        }
    });
}

function renderMentionDropdown(input) {
    const dd = document.getElementById('mention-dropdown');
    if (!dd) return;
    dd.innerHTML = _mentionMatches.map((m, i) => {
        const initials = m.name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
        return '<div class="mention-item' + (i === _mentionIndex ? ' active' : '') + '" onmousedown="selectMention(document.getElementById(\'comment-input\'), _mentionMatches[' + i + '])">'
            + '<div class="th-member-avatar" style="width:24px;height:24px;font-size:9px;">' + esc(initials) + '</div>'
            + '<span>' + esc(m.name) + '</span></div>';
    }).join('');

    // Position above the input
    const rect = input.getBoundingClientRect();
    dd.style.left = rect.left + 'px';
    dd.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
    dd.style.top = 'auto';
    dd.style.width = Math.max(220, rect.width) + 'px';
    dd.style.display = '';
}

function selectMention(input, member) {
    if (!input || !member) return;
    const val = input.value;
    const cursor = input.selectionStart;
    const before = val.substring(0, cursor);
    const after = val.substring(cursor);
    const replaced = before.replace(/@\w*$/, '@' + member.name + ' ');
    input.value = replaced + after;
    input.selectionStart = input.selectionEnd = replaced.length;
    hideMentionDropdown();
    input.focus();
}

function hideMentionDropdown() {
    _mentionActive = false;
    const dd = document.getElementById('mention-dropdown');
    if (dd) dd.style.display = 'none';
}

// ── Detail Comments / Files ───────────────────────────────────

async function loadDetailComments() {
    const container = document.getElementById('detail-comments');
    if (!container || !_detailTask) return;
    try {
        const data = await api('GET', API + '/items/' + _detailTask.id + '/comments');
        const comments = data.comments || [];
        if (comments.length === 0) {
            container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">No comments yet</div>';
            return;
        }
        container.innerHTML = comments.map(c => {
            const authorProfile = _profiles.find(p => p.id === c.author_id);
            const authorName = authorProfile ? (authorProfile.display_name || authorProfile.email) : 'Unknown';
            const initials = authorName.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
            const isOwn = _user && c.author_id === _user.id;
            const edited = c.updated_at && c.updated_at !== c.created_at;
            return '<div class="th-comment" data-comment-id="' + esc(c.id) + '">'
                + '<div class="th-comment-header">'
                + '<div style="display:flex;align-items:center;gap:6px;">'
                + '<div class="th-member-avatar" style="width:24px;height:24px;font-size:9px;">' + esc(initials) + '</div>'
                + '<span class="th-comment-author">' + esc(authorName) + '</span>'
                + (edited ? '<span class="th-comment-edited">(edited)</span>' : '')
                + '</div>'
                + '<div style="display:flex;align-items:center;gap:6px;">'
                + '<span class="th-comment-time">' + timeAgo(c.created_at) + '</span>'
                + (isOwn ? '<button class="th-comment-edit-btn" onclick="startEditComment(\'' + esc(c.id) + '\', this)" title="Edit comment">&#9998;</button>' : '')
                + '</div>'
                + '</div>'
                + '<div class="th-comment-body" id="comment-body-' + esc(c.id) + '">' + renderMentions(c.content || '') + '</div>'
                + '</div>';
        }).join('');
    } catch {
        container.innerHTML = '<div style="color:var(--text-muted);">Failed to load comments</div>';
    }
}

async function loadDetailFiles() {
    const container = document.getElementById('detail-files');
    if (!container || !_detailTask) return;
    try {
        const data = await api('GET', API + '/workspaces/' + _detailTask.workspace_id + '/files?item_id=' + _detailTask.id);
        const files = data.files || [];
        if (files.length === 0) {
            container.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">No files attached</div>';
            return;
        }
        container.innerHTML = files.map(f =>
            '<div class="th-file-row" onclick="previewFile(\'' + esc(f.file_path) + '\',\'' + esc(f.file_name) + '\',\'' + esc(f.mime_type || '') + '\')">'
            + '<span class="th-file-icon">' + fileIcon(f.mime_type) + '</span>'
            + '<div class="th-file-info"><div class="th-file-name">' + esc(f.file_name) + '</div>'
            + '<div class="th-file-meta">' + formatSize(f.file_size) + '</div></div>'
            + '<button class="btn btn-small btn-ghost" onclick="event.stopPropagation();deleteFile(\'' + esc(f.id) + '\')" style="font-size:10px;">&times;</button>'
            + '</div>'
        ).join('');
    } catch {
        container.innerHTML = '<div style="color:var(--text-muted);">Failed to load files</div>';
    }
}

function closeDetail() {
    // Save any pending changes on close (description, etc.)
    const panel = document.getElementById('detail-panel');
    panel.classList.remove('open');
    document.getElementById('detail-backdrop').style.display = 'none';
    _detailTask = null;
}

// ── Item Actions (Delete / Move / Duplicate) ─────────────────

async function deleteDetailItem() {
    if (!_detailTask) return;
    if (!confirm('Delete "' + (_detailTask.title || 'this item') + '"? This cannot be undone.')) return;
    const deletedId = _detailTask.id;
    try {
        await api('DELETE', API + '/items/' + deletedId);
    } catch (err) {
        // Server may have deleted successfully even if response parsing failed —
        // fall through to refresh the view regardless
        console.warn('Delete response error (item likely deleted):', err.message);
    }
    showToast('Item deleted');
    // Remove from local cache immediately
    _tasks = _tasks.filter(t => t.id !== deletedId);
    if (_homeListItems) _homeListItems = _homeListItems.filter(t => t.id !== deletedId);
    closeDetail();
    if (_currentListId) loadItems(_currentListId);
    else if (_currentView === 'dashboard') loadDashboard();
    else { _homeData = null; renderMainContent(); }
}

async function duplicateDetailItem() {
    if (!_detailTask) return;
    const t = _detailTask;
    try {
        const listId = t.list_id || _currentListId;
        if (!listId) { showToast('No list context to duplicate into'); return; }
        await api('POST', API + '/lists/' + listId + '/items', {
            title: t.title + ' (copy)',
            type: t.type || 'task',
            description: t.description || '',
            status: t.status || 'open',
            priority: t.priority || 'none',
        });
        showToast('Item duplicated');
        if (_currentListId) loadItems(_currentListId);
    } catch (err) {
        showToast('Failed to duplicate: ' + (err.message || 'Unknown error'));
    }
}

function openMoveItemModal() {
    if (!_detailTask) return;
    // Build a modal with space > list picker
    let overlay = document.getElementById('move-item-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'move-item-overlay';
        overlay.className = 'modal-overlay';
        overlay.innerHTML = '<div class="modal" style="max-width:420px;">'
            + '<button class="modal-close" onclick="closeMoveItemModal()">&times;</button>'
            + '<div class="modal-title">Move Item</div>'
            + '<div class="form-group"><label class="form-label">Space</label>'
            + '<select class="form-select" id="move-space" onchange="moveSpaceChanged()"><option>Loading...</option></select></div>'
            + '<div class="form-group"><label class="form-label">List</label>'
            + '<select class="form-select" id="move-list"><option>Select a space first</option></select></div>'
            + '<div class="wizard-actions"><button class="btn btn-ghost" onclick="closeMoveItemModal()">Cancel</button>'
            + '<button class="btn btn-accent" onclick="confirmMoveItem()">Move</button></div>'
            + '</div>';
        document.body.appendChild(overlay);
    }
    overlay.classList.add('visible');
    loadMoveSpaces();
}

function closeMoveItemModal() {
    const overlay = document.getElementById('move-item-overlay');
    if (overlay) overlay.classList.remove('visible');
}

async function loadMoveSpaces() {
    const sel = document.getElementById('move-space');
    sel.innerHTML = '<option value="">Loading...</option>';
    try {
        const data = await api('GET', API + '/workspaces');
        const spaces = data.workspaces || data;
        sel.innerHTML = spaces.map(s => '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>').join('');
        moveSpaceChanged();
    } catch {
        sel.innerHTML = '<option value="">Failed to load</option>';
    }
}

async function moveSpaceChanged() {
    const spaceId = document.getElementById('move-space').value;
    const listSel = document.getElementById('move-list');
    if (!spaceId) { listSel.innerHTML = '<option value="">Select a space</option>'; return; }
    listSel.innerHTML = '<option value="">Loading...</option>';
    try {
        const data = await api('GET', API + '/workspaces/' + spaceId + '/folders');
        const folders = data.folders || [];
        const folderlessLists = data.lists || [];
        let opts = '';
        for (const folder of folders) {
            if (folder.id === '__uncategorized__') continue;
            for (const list of (folder.lists || [])) {
                opts += '<option value="' + esc(list.id) + '" data-folder="' + esc(folder.id) + '">' + esc(folder.name) + ' / ' + esc(list.name) + '</option>';
            }
        }
        for (const list of folderlessLists) {
            opts += '<option value="' + esc(list.id) + '">' + esc(list.name) + '</option>';
        }
        listSel.innerHTML = opts || '<option value="">No lists found</option>';
    } catch {
        listSel.innerHTML = '<option value="">Error loading lists</option>';
    }
}

async function confirmMoveItem() {
    if (!_detailTask) return;
    const listSel = document.getElementById('move-list');
    const listId = listSel.value;
    if (!listId) { showToast('Select a target list'); return; }
    const folderId = listSel.selectedOptions[0]?.dataset?.folder || null;
    try {
        const update = { list_id: listId };
        if (folderId) update.folder_id = folderId;
        await api('PATCH', API + '/items/' + _detailTask.id, update);
        showToast('Item moved');
        closeMoveItemModal();
        closeDetail();
        if (_currentListId) loadItems(_currentListId);
        else renderMainContent();
    } catch (err) {
        showToast('Failed to move: ' + (err.message || 'Unknown error'));
    }
}

// ── Field Updates ────────────────────────────────────────────

async function updateField(field, value) {
    if (!_detailTask) return;
    const oldVal = _detailTask[field];
    if (value === oldVal) return;

    _detailTask[field] = value;
    // Update local tasks array too
    const localTask = _tasks.find(t => t.id === _detailTask.id);
    if (localTask) localTask[field] = value;
    renderMainContent();

    try {
        await api('PATCH', API + '/items/' + _detailTask.id, { [field]: value || null });
        broadcast('task_updated', { taskId: _detailTask.id, changes: { [field]: value }, listId: _currentListId });
    } catch {
        _detailTask[field] = oldVal;
        if (localTask) localTask[field] = oldVal;
        renderMainContent();
        showToast('Failed to update ' + field);
    }
}

async function updateRecurrence() {
    if (!_detailTask) return;
    const freqEl = document.getElementById('rec-freq');
    const freq = freqEl ? freqEl.value : '';
    if (!freq) {
        // Clear recurrence
        await updateField('recurrence', null);
        openDetail(_detailTask.id); // Re-render to hide options
        return;
    }
    const intervalEl = document.getElementById('rec-interval');
    const carryDescEl = document.getElementById('rec-carry-desc');
    const carryCommentsEl = document.getElementById('rec-carry-comments');
    const recurrence = {
        frequency: freq,
        interval: parseInt(intervalEl ? intervalEl.value : '1') || 1,
        carry_description: carryDescEl ? carryDescEl.checked : true,
        carry_comments: carryCommentsEl ? carryCommentsEl.checked : false,
    };
    const oldRec = _detailTask.recurrence;
    // Only re-render if frequency changed (to show/hide options)
    const freqChanged = (oldRec?.frequency || '') !== freq;
    _detailTask.recurrence = recurrence;
    try {
        await api('PATCH', API + '/items/' + _detailTask.id, { recurrence });
        if (freqChanged) openDetail(_detailTask.id);
    } catch {
        _detailTask.recurrence = oldRec;
        showToast('Failed to update recurrence');
    }
}

async function addAssignee(userId) {
    if (!_detailTask || !userId) return;
    try {
        await api('POST', API + '/items/' + _detailTask.id + '/assign', {
            assignee_type: 'user', assignee_id: userId,
        });
        showToast('Assigned');
        openDetail(_detailTask.id);
        broadcast('task_updated', { taskId: _detailTask.id, changes: {}, listId: _currentListId });
    } catch { showToast('Failed to assign'); }
}

async function removeAssignee(assignId) {
    if (!_detailTask) return;
    try {
        await api('DELETE', API + '/items/' + _detailTask.id + '/assign/' + assignId);
        showToast('Unassigned');
        openDetail(_detailTask.id);
    } catch { showToast('Failed to unassign'); }
}

async function removeTag(tagId) {
    if (!_detailTask) return;
    try {
        await api('DELETE', API + '/items/' + _detailTask.id + '/tags/' + tagId);
        openDetail(_detailTask.id);
    } catch { showToast('Failed to remove tag'); }
}

// ── Links ────────────────────────────────────────────────────

async function removeLink(index) {
    if (!_detailTask) return;
    const links = [...(_detailTask.links || [])];
    links.splice(index, 1);
    try {
        await api('PATCH', API + '/items/' + _detailTask.id, { links });
        _detailTask.links = links;
        openDetail(_detailTask.id);
    } catch { showToast('Failed to remove link'); }
}

function openAddLinkModal() {
    if (!_detailTask) return;
    let overlay = document.getElementById('add-link-overlay');
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
    overlay.id = 'add-link-overlay';
    overlay.className = 'modal-overlay visible';
    overlay.innerHTML = '<div class="modal" style="max-width:400px;">'
        + '<button class="modal-close" onclick="this.closest(\'.modal-overlay\').remove()">&times;</button>'
        + '<div class="modal-title">Add Link</div>'
        + '<div class="form-group"><label class="form-label">URL</label>'
        + '<input type="url" class="form-input" id="add-link-url" placeholder="https://..." autofocus></div>'
        + '<div class="form-group"><label class="form-label">Label (optional)</label>'
        + '<input type="text" class="form-input" id="add-link-label" placeholder="Link name"></div>'
        + '<div class="wizard-actions">'
        + '<button class="btn btn-ghost" onclick="this.closest(\'.modal-overlay\').remove()">Cancel</button>'
        + '<button class="btn btn-accent" onclick="confirmAddLink()">Add</button>'
        + '</div></div>';
    document.body.appendChild(overlay);
    overlay.querySelector('#add-link-url').focus();
    overlay.querySelector('#add-link-label').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') confirmAddLink();
    });
}

async function confirmAddLink() {
    const url = (document.getElementById('add-link-url')?.value || '').trim();
    const label = (document.getElementById('add-link-label')?.value || '').trim();
    if (!url) { showToast('URL is required'); return; }
    const overlay = document.getElementById('add-link-overlay');
    if (overlay) overlay.remove();

    const links = [...(_detailTask.links || []), { url, label: label || url }];
    try {
        await api('PATCH', API + '/items/' + _detailTask.id, { links });
        _detailTask.links = links;
        openDetail(_detailTask.id);
        showToast('Link added');
    } catch { showToast('Failed to add link'); }
}

function openTagPicker() {
    // Load workspace tags and show a dropdown
    if (!_detailTask) return;
    const wsId = _detailTask.workspace_id;
    api('GET', API + '/workspaces/' + wsId + '/tags').then(data => {
        const tags = data.tags || [];
        const existing = new Set((_detailTask.tags || []).map(t => t.id));
        const available = tags.filter(t => !existing.has(t.id));

        if (available.length === 0) {
            showToast('No tags available. Create tags in workspace settings.');
            return;
        }

        const container = document.getElementById('detail-tags');
        // Remove existing picker if any
        const old = document.getElementById('tag-picker-dd');
        if (old) old.remove();

        let dd = '<div id="tag-picker-dd" class="th-tag-picker" style="position:relative;display:inline-block;">';
        for (const tag of available) {
            dd += '<div class="th-tag-picker-item" onclick="addTag(\'' + esc(tag.id) + '\')">'
                + '<span class="th-tag-color-dot" style="background:' + esc(tag.color) + ';"></span>'
                + '<span>' + esc(tag.name) + '</span>'
                + '</div>';
        }
        dd += '</div>';
        container.insertAdjacentHTML('beforeend', dd);

        // Close on outside click
        setTimeout(() => {
            document.addEventListener('click', function closer(e) {
                const picker = document.getElementById('tag-picker-dd');
                if (picker && !picker.contains(e.target)) {
                    picker.remove();
                    document.removeEventListener('click', closer);
                }
            });
        }, 10);
    }).catch(() => showToast('Failed to load tags'));
}

async function addTag(tagId) {
    if (!_detailTask) return;
    const picker = document.getElementById('tag-picker-dd');
    if (picker) picker.remove();
    try {
        await api('POST', API + '/items/' + _detailTask.id + '/tags', { tag_id: tagId });
        openDetail(_detailTask.id);
    } catch { showToast('Failed to add tag'); }
}

// ── Comments ─────────────────────────────────────────────────

let _commentPendingImages = []; // [{url, name}] — signed URLs for images queued for next comment

async function postComment() {
    if (!_detailTask) return;
    const input = document.getElementById('comment-input');
    let text = input.value.trim();

    // Append any pending images as markdown
    if (_commentPendingImages.length) {
        for (const img of _commentPendingImages) {
            text += (text ? '\n' : '') + '![' + (img.name || 'image') + '](' + img.url + ')';
        }
        _commentPendingImages = [];
        const preview = document.getElementById('comment-image-preview');
        if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }
    }

    if (!text) return;
    input.value = '';

    try {
        await api('POST', API + '/items/' + _detailTask.id + '/comments', { content: text });
        showToast('Comment posted');
        loadDetailComments();
        broadcast('comment_added', { taskId: _detailTask.id });
    } catch {
        showToast('Failed to post comment');
    }
}

function bindCommentPasteHandler() {
    const input = document.getElementById('comment-input');
    if (!input) return;
    input.addEventListener('paste', async (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                e.preventDefault();
                const file = item.getAsFile();
                if (file) await commentHandleImageFile(file);
                return;
            }
        }
    });
}

function commentUploadImage() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
        if (input.files && input.files[0]) {
            await commentHandleImageFile(input.files[0]);
        }
    };
    input.click();
}

async function commentHandleImageFile(file) {
    if (!_detailTask || !_supabase) { showToast('Cannot upload right now'); return; }
    const wsId = _detailTask.workspace_id;
    const filePath = wsId + '/comments/' + Date.now() + '_' + file.name;
    showToast('Uploading image...');

    try {
        const { data, error } = await _supabase.storage
            .from('team-files')
            .upload(filePath, file);
        if (error) throw error;

        // Get a signed URL (valid for 1 year)
        const { data: signedData, error: signedErr } = await _supabase.storage
            .from('team-files')
            .createSignedUrl(filePath, 365 * 24 * 60 * 60);
        if (signedErr) throw signedErr;

        const url = signedData.signedUrl;
        _commentPendingImages.push({ url, name: file.name });

        // Also register in team_files table
        await api('POST', API + '/workspaces/' + wsId + '/files', {
            file_name: file.name,
            file_path: filePath,
            file_size: file.size,
            mime_type: file.type || 'image/png',
            item_id: _detailTask.id
        });

        // Show preview
        const preview = document.getElementById('comment-image-preview');
        if (preview) {
            preview.style.display = 'flex';
            const idx = _commentPendingImages.length - 1;
            preview.innerHTML += '<div class="th-comment-img-thumb" data-idx="' + idx + '">'
                + '<img src="' + esc(url) + '" alt="' + esc(file.name) + '">'
                + '<button class="th-comment-img-remove" onclick="commentRemovePendingImage(' + idx + ')">&times;</button>'
                + '</div>';
        }
        showToast('Image ready — send your comment');
    } catch (err) {
        showToast('Image upload failed: ' + (err.message || err));
    }
}

function commentRemovePendingImage(idx) {
    _commentPendingImages.splice(idx, 1);
    const preview = document.getElementById('comment-image-preview');
    if (preview) {
        if (!_commentPendingImages.length) {
            preview.style.display = 'none';
            preview.innerHTML = '';
        } else {
            const thumb = preview.querySelector('[data-idx="' + idx + '"]');
            if (thumb) thumb.remove();
        }
    }
}

function startEditComment(commentId, btn) {
    const bodyEl = document.getElementById('comment-body-' + commentId);
    if (!bodyEl || bodyEl.querySelector('.th-comment-edit-area')) return;
    const currentText = bodyEl.textContent;
    const ta = document.createElement('textarea');
    ta.className = 'th-comment-edit-area';
    ta.id = 'comment-edit-' + commentId;
    ta.value = currentText;
    const actions = document.createElement('div');
    actions.className = 'th-comment-edit-actions';
    actions.innerHTML = '<button class="btn btn-accent btn-small" onclick="saveEditComment(\'' + commentId + '\')">Save</button>'
        + '<button class="btn btn-ghost btn-small" onclick="loadDetailComments()">Cancel</button>';
    bodyEl.textContent = '';
    bodyEl.appendChild(ta);
    bodyEl.appendChild(actions);
    ta.focus();
    ta.selectionStart = ta.value.length;
}

async function saveEditComment(commentId) {
    const ta = document.getElementById('comment-edit-' + commentId);
    if (!ta) return;
    const text = ta.value.trim();
    if (!text) { showToast('Comment cannot be empty'); return; }
    try {
        await api('PATCH', API + '/comments/' + commentId, { content: text });
        showToast('Comment updated');
        loadDetailComments();
    } catch {
        showToast('Failed to update comment');
    }
}

function renderMentions(text) {
    const escaped = esc(text);
    // Render markdown images: ![alt](url) — must decode escaped HTML entities in URLs
    let result = escaped.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
        const decodedUrl = url.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
        return '<div class="th-comment-image"><img src="' + decodedUrl + '" alt="' + alt + '" loading="lazy" onclick="window.open(this.src,\'_blank\')"></div>';
    });
    // Render @mentions
    result = result.replace(/@(\w[\w\s]*?\w|\w)/g, (match) => {
        return '<span class="mention">' + match + '</span>';
    });
    return result;
}

// ── Create New Wizard ─────────────────────────────────────────

async function openCreateNewModal(preselect) {
    _createNewType = null;
    _structBuilderFolders = [];
    _structBuilderLists = [];
    const modal = document.getElementById('create-new-modal');
    const stepType = document.getElementById('cn-step-type');
    const stepForm = document.getElementById('cn-step-form');
    const title = document.getElementById('cn-modal-title');
    stepType.style.display = '';
    stepForm.style.display = 'none';
    stepForm.innerHTML = '';
    title.textContent = 'Create New';
    modal.classList.add('visible');
    // Pre-load saved templates for the space dropdown
    if (!_savedTemplates.length) {
        try { await loadSavedTemplates(); } catch {}
    }
    if (preselect) selectCreateType(preselect);
}

function selectCreateType(type) {
    _createNewType = type;
    const stepType = document.getElementById('cn-step-type');
    const stepForm = document.getElementById('cn-step-form');
    const title = document.getElementById('cn-modal-title');
    stepType.style.display = 'none';
    stepForm.style.display = '';
    title.textContent = 'Create New ' + type.charAt(0).toUpperCase() + type.slice(1);

    let html = '';

    if (type === 'space') {
        html += '<form id="cn-form" onsubmit="handleCreateNew(event)">'
            + '<div class="form-group"><label class="form-label">Space Name</label>'
            + '<input class="form-input" id="cn-space-name" required placeholder="e.g. Project Alpha"></div>'
            + '<div class="form-group"><label class="form-label">Prefix (optional)</label>'
            + '<input class="form-input" id="cn-space-prefix" placeholder="e.g. ACME">'
            + '<div class="form-hint">Prefix is prepended to all folder/list names</div></div>'
            + '<div class="form-row">'
            + '<div class="form-group"><label class="form-label">Template</label>'
            + '<select class="form-select" id="cn-space-template">'
            + '<option value="">(Blank)</option>'
            + '<optgroup label="Built-in">'
            + '<option value="standard">Standard</option>'
            + '<option value="client">Client</option>'
            + '<option value="simple">Simple</option>'
            + '<option value="kanban">Kanban</option>'
            + '</optgroup>';
        if (_sharedTemplates.length) {
            html += '<optgroup label="Shared Team Templates">';
            for (const st of _sharedTemplates) html += '<option value="saved:' + esc(st.id) + '">' + esc(st.name) + '</option>';
            html += '</optgroup>';
        }
        if (_personalTemplates.length) {
            html += '<optgroup label="My Templates">';
            for (const st of _personalTemplates) html += '<option value="saved:' + esc(st.id) + '">' + esc(st.name) + '</option>';
            html += '</optgroup>';
        }
        html += '</select></div>'
            + '<div class="form-group"><label class="form-label">Color</label>'
            + '<input type="color" class="form-input" id="cn-space-color" value="#6c5ce7" style="height:38px;padding:4px;"></div>'
            + '</div>'
            + '<div class="wizard-actions">'
            + '<button type="button" class="btn btn-ghost" onclick="cnBack()">Back</button>'
            + '<button type="submit" class="btn btn-accent">Create Space</button>'
            + '</div></form>';
    } else if (type === 'folder') {
        html += '<form id="cn-form" onsubmit="handleCreateNew(event)">'
            + '<div class="form-group"><label class="form-label">Folder Name</label>'
            + '<input class="form-input" id="cn-folder-name" required placeholder="e.g. Development"></div>'
            + '<div class="form-group"><label class="form-label">Space</label>'
            + '<select class="form-select" id="cn-folder-space">';
        for (const s of _spaces) {
            const sel = s.id === _currentSpaceId ? ' selected' : '';
            html += '<option value="' + esc(s.id) + '"' + sel + '>' + esc(s.name) + '</option>';
        }
        html += '</select></div>'
            + '<div class="wizard-actions">'
            + '<button type="button" class="btn btn-ghost" onclick="cnBack()">Back</button>'
            + '<button type="submit" class="btn btn-accent">Create Folder</button>'
            + '</div></form>';
    } else if (type === 'list') {
        const defaultSpace = _currentSpaceId || (_spaces[0] && _spaces[0].id) || '';
        html += '<form id="cn-form" onsubmit="handleCreateNew(event)">'
            + '<div class="form-group"><label class="form-label">List Name</label>'
            + '<input class="form-input" id="cn-list-name" required placeholder="e.g. Backlog"></div>'
            + '<div class="form-row">'
            + '<div class="form-group"><label class="form-label">Space</label>'
            + '<select class="form-select" id="cn-list-space" onchange="cnListSpaceChanged()">';
        for (const s of _spaces) {
            const sel = s.id === defaultSpace ? ' selected' : '';
            html += '<option value="' + esc(s.id) + '"' + sel + '>' + esc(s.name) + '</option>';
        }
        html += '</select></div>'
            + '<div class="form-group"><label class="form-label">Folder (optional)</label>'
            + '<select class="form-select" id="cn-list-folder"><option value="">(No folder)</option></select></div>'
            + '</div>'
            + '<div class="wizard-actions">'
            + '<button type="button" class="btn btn-ghost" onclick="cnBack()">Back</button>'
            + '<button type="submit" class="btn btn-accent">Create List</button>'
            + '</div></form>';
        stepForm.innerHTML = html;
        cnListSpaceChanged();
        return;
    } else if (type === 'task') {
        const defaultSpace = _currentSpaceId || (_spaces[0] && _spaces[0].id) || '';
        html += '<form id="cn-form" onsubmit="handleCreateNew(event)">'
            + '<div class="form-group"><label class="form-label">Title</label>'
            + '<input class="form-input" id="cn-task-title" required placeholder="Task title..."></div>'
            + '<div class="form-row">'
            + '<div class="form-group"><label class="form-label">Space</label>'
            + '<select class="form-select" id="cn-task-space" onchange="cnTaskSpaceChanged()">';
        for (const s of _spaces) {
            const sel = s.id === defaultSpace ? ' selected' : '';
            html += '<option value="' + esc(s.id) + '"' + sel + '>' + esc(s.name) + '</option>';
        }
        html += '</select></div>'
            + '<div class="form-group"><label class="form-label">List</label>'
            + '<select class="form-select" id="cn-task-list"><option value="">Loading...</option></select></div>'
            + '</div>'
            + '<div class="form-row">'
            + '<div class="form-group"><label class="form-label">Type</label>'
            + '<select class="form-select" id="cn-task-type">'
            + '<option value="task">Task</option><option value="bug">Bug</option>'
            + '<option value="feature">Feature</option><option value="idea">Idea</option>'
            + '<option value="note">Note</option><option value="decision">Decision</option>'
            + '</select></div>'
            + '<div class="form-group"><label class="form-label">Priority</label>'
            + '<select class="form-select" id="cn-task-priority">'
            + '<option value="medium">Medium</option><option value="critical">Critical</option>'
            + '<option value="high">High</option><option value="low">Low</option>'
            + '<option value="none">None</option></select></div>'
            + '</div>'
            + '<div class="form-row">'
            + '<div class="form-group"><label class="form-label">Status</label>'
            + '<select class="form-select" id="cn-task-status"><option value="open">open</option></select></div>'
            + '<div class="form-group"><label class="form-label">Due Date</label>'
            + '<input type="date" class="form-input" id="cn-task-due"></div>'
            + '</div>'
            + '<div class="form-group"><label class="form-label">Description</label>'
            + '<textarea class="form-textarea" id="cn-task-desc" placeholder="Describe the task..."></textarea></div>'
            + '<div class="wizard-actions">'
            + '<button type="button" class="btn btn-ghost" onclick="cnBack()">Back</button>'
            + '<button type="submit" class="btn btn-accent">Create Task</button>'
            + '</div></form>';
        stepForm.innerHTML = html;
        cnTaskSpaceChanged();
        return;
    } else if (type === 'structure') {
        _structBuilderFolders = [];
        _structBuilderLists = [];
        html += '<form id="cn-form" onsubmit="handleCreateNew(event)">'
            + '<div class="form-group"><label class="form-label">Space Name</label>'
            + '<input class="form-input" id="cn-struct-space-name" required placeholder="e.g. Client Project"></div>'
            + '<div class="form-row">'
            + '<div class="form-group"><label class="form-label">Prefix (optional)</label>'
            + '<input class="form-input" id="cn-struct-prefix" placeholder="e.g. ACME">'
            + '<div class="form-hint">Prepended to all folder/list names</div></div>'
            + '<div class="form-group"><label class="form-label">Color</label>'
            + '<input type="color" class="form-input" id="cn-struct-color" value="#6c5ce7" style="height:38px;padding:4px;"></div>'
            + '</div>'
            + '<div class="form-group"><label class="form-label">Structure</label>'
            + '<div class="tpl-tree" id="struct-builder-tree">'
            + '<div style="color:var(--text-muted);font-size:12px;padding:8px;">Add folders, lists, and tasks below</div>'
            + '</div>'
            + '<div class="struct-builder-actions">'
            + '<button type="button" class="btn btn-small btn-ghost" onclick="structAddFolder()">+ Folder</button>'
            + '<button type="button" class="btn btn-small btn-ghost" onclick="structAddList()">+ List</button>'
            + '</div></div>'
            + '<div class="form-group"><label class="form-label" style="display:flex;align-items:center;gap:8px;">'
            + '<input type="checkbox" id="cn-struct-save-tpl" onchange="toggleStructTplName()"> Save as template'
            + '</label>'
            + '<div id="cn-struct-tpl-name-wrap" style="display:none;margin-top:6px;">'
            + '<input class="form-input" id="cn-struct-tpl-name" placeholder="Template name...">'
            + '</div></div>'
            + '<div class="wizard-actions">'
            + '<button type="button" class="btn btn-ghost" onclick="cnBack()">Back</button>'
            + '<button type="submit" class="btn btn-accent">Create Structure</button>'
            + '</div></form>';
    }

    stepForm.innerHTML = html;
}

function cnBack() {
    _createNewType = null;
    _structBuilderFolders = [];
    _structBuilderLists = [];
    document.getElementById('cn-step-type').style.display = '';
    document.getElementById('cn-step-form').style.display = 'none';
    document.getElementById('cn-modal-title').textContent = 'Create New';
}

async function cnListSpaceChanged() {
    const spaceId = document.getElementById('cn-list-space')?.value;
    const folderSel = document.getElementById('cn-list-folder');
    if (!spaceId || !folderSel) return;
    folderSel.innerHTML = '<option value="">(No folder)</option>';
    if (!_hierarchyCache[spaceId]) {
        try {
            _hierarchyCache[spaceId] = await api('GET', API + '/workspaces/' + spaceId + '/folders');
        } catch { return; }
    }
    const folders = _hierarchyCache[spaceId].folders || [];
    for (const f of folders) {
        folderSel.innerHTML += '<option value="' + esc(f.id) + '">' + esc(f.name) + '</option>';
    }
}

async function cnTaskSpaceChanged() {
    const spaceId = document.getElementById('cn-task-space')?.value;
    const listSel = document.getElementById('cn-task-list');
    const statusSel = document.getElementById('cn-task-status');
    if (!spaceId || !listSel) return;
    listSel.innerHTML = '<option value="">Loading...</option>';
    if (!_hierarchyCache[spaceId]) {
        try {
            _hierarchyCache[spaceId] = await api('GET', API + '/workspaces/' + spaceId + '/folders');
        } catch {
            listSel.innerHTML = '<option value="">Failed to load</option>';
            return;
        }
    }
    const data = _hierarchyCache[spaceId];
    listSel.innerHTML = '';
    // Lists inside folders
    for (const f of (data.folders || [])) {
        for (const l of (f.lists || [])) {
            const sel = l.id === _currentListId ? ' selected' : '';
            listSel.innerHTML += '<option value="' + esc(l.id) + '"' + sel + '>' + esc(f.name) + ' / ' + esc(l.name) + '</option>';
        }
    }
    // Folderless lists (skip virtual uncategorized)
    for (const l of (data.folderless_lists || [])) {
        if (l.id.startsWith('__uncategorized__')) continue;
        const sel = l.id === _currentListId ? ' selected' : '';
        listSel.innerHTML += '<option value="' + esc(l.id) + '"' + sel + '>' + esc(l.name) + '</option>';
    }
    if (!listSel.options.length) {
        listSel.innerHTML = '<option value="">No lists in this space</option>';
    }
    // Load statuses for this space
    if (statusSel) {
        try {
            const stData = await api('GET', API + '/workspaces/' + spaceId + '/statuses');
            const sts = stData.statuses || [];
            statusSel.innerHTML = sts.map(s => '<option value="' + esc(s.name) + '">' + esc(s.name) + '</option>').join('');
            if (!sts.length) statusSel.innerHTML = '<option value="open">open</option>';
        } catch {
            statusSel.innerHTML = '<option value="open">open</option>';
        }
    }
}

async function handleCreateNew(e) {
    e.preventDefault();
    const type = _createNewType;
    try {
        if (type === 'space') {
            const name = document.getElementById('cn-space-name')?.value?.trim();
            const tplVal = document.getElementById('cn-space-template')?.value || '';
            const color = document.getElementById('cn-space-color')?.value || '#6c5ce7';
            const prefix = document.getElementById('cn-space-prefix')?.value?.trim() || '';
            if (!name) return;
            const body = { space_name: name, color };
            if (prefix) body.prefix = prefix;
            if (tplVal.startsWith('saved:')) {
                body.template_id = tplVal.substring(6);
            } else if (tplVal) {
                body.template = tplVal;
            }
            showToast('Creating space...');
            await api('POST', API + '/templates/apply', body);
            showToast('Space created!');
            _hierarchyCache = {};
            _expandedSpaces = {};
            loadSpaces();
        } else if (type === 'folder') {
            const name = document.getElementById('cn-folder-name')?.value?.trim();
            const spaceId = document.getElementById('cn-folder-space')?.value;
            if (!name || !spaceId) return;
            await api('POST', API + '/workspaces/' + spaceId + '/folders', { name });
            showToast('Folder created!');
            delete _hierarchyCache[spaceId];
            if (_expandedSpaces[spaceId]) {
                _hierarchyCache[spaceId] = await api('GET', API + '/workspaces/' + spaceId + '/folders');
            }
            renderSpaceTree();
        } else if (type === 'list') {
            const name = document.getElementById('cn-list-name')?.value?.trim();
            const spaceId = document.getElementById('cn-list-space')?.value;
            const folderId = document.getElementById('cn-list-folder')?.value || null;
            if (!name || !spaceId) return;
            await api('POST', API + '/workspaces/' + spaceId + '/lists', { name, folder_id: folderId });
            showToast('List created!');
            delete _hierarchyCache[spaceId];
            if (_expandedSpaces[spaceId]) {
                _hierarchyCache[spaceId] = await api('GET', API + '/workspaces/' + spaceId + '/folders');
            }
            renderSpaceTree();
        } else if (type === 'task') {
            const title = document.getElementById('cn-task-title')?.value?.trim();
            const listId = document.getElementById('cn-task-list')?.value;
            if (!title || !listId) { showToast('Title and list are required'); return; }
            const data = {
                title,
                type: document.getElementById('cn-task-type')?.value || 'task',
                description: document.getElementById('cn-task-desc')?.value || '',
                status: document.getElementById('cn-task-status')?.value || 'open',
                priority: document.getElementById('cn-task-priority')?.value || 'medium',
                due_date: document.getElementById('cn-task-due')?.value || null,
            };
            await api('POST', API + '/lists/' + listId + '/items', data);
            showToast('Task created!');
            if (listId === _currentListId) {
                selectList(_currentListId, _currentListName, _currentSpaceId);
            }
            broadcast('task_created', { listId });
        } else if (type === 'structure') {
            const name = document.getElementById('cn-struct-space-name')?.value?.trim();
            const prefix = document.getElementById('cn-struct-prefix')?.value?.trim() || '';
            const color = document.getElementById('cn-struct-color')?.value || '#6c5ce7';
            if (!name) return;
            // Build structure from builder state
            const structure = {
                folders: _structBuilderFolders.map(f => ({
                    name: f.name,
                    lists: f.lists.map(l => ({ name: l.name, tasks: [...l.tasks] })),
                })),
                lists: _structBuilderLists.map(l => ({ name: l.name, tasks: [...l.tasks] })),
            };
            // Optionally save as template first
            const saveTpl = document.getElementById('cn-struct-save-tpl')?.checked;
            if (saveTpl) {
                const tplName = document.getElementById('cn-struct-tpl-name')?.value?.trim();
                if (tplName) {
                    // Save template with string-only lists for compatibility
                    const tplStruct = {
                        folders: structure.folders.map(f => ({ name: f.name, lists: f.lists.map(l => l.name) })),
                        lists: structure.lists.map(l => l.name),
                    };
                    try {
                        await api('POST', API + '/templates', { name: tplName, structure: tplStruct, shared: false });
                        await loadSavedTemplates();
                    } catch {}
                }
            }
            showToast('Creating structure...');
            const body = { space_name: name, color, structure };
            if (prefix) body.prefix = prefix;
            await api('POST', API + '/templates/apply', body);
            showToast('Structure created!');
            _hierarchyCache = {};
            _expandedSpaces = {};
            _structBuilderFolders = [];
            _structBuilderLists = [];
            loadSpaces();
        }
        closeAllModals();
    } catch (err) {
        showToast('Failed to create ' + type);
    }
}

// ── Template Browser / Builder ───────────────────────────────

async function openTemplateBrowser() {
    const modal = document.getElementById('template-browser-modal');
    modal.classList.add('visible');
    switchTemplateTab('browse');
    await loadSavedTemplates();
    renderTemplateBrowseList();
}

function switchTemplateTab(tab) {
    document.querySelectorAll('#template-browser-modal .th-tab').forEach(t => t.classList.remove('active'));
    document.getElementById('tpl-tab-browse').style.display = tab === 'browse' ? '' : 'none';
    document.getElementById('tpl-tab-create').style.display = tab === 'create' ? '' : 'none';
    const tabs = document.querySelectorAll('#template-browser-modal .th-tab');
    if (tab === 'browse' && tabs[0]) tabs[0].classList.add('active');
    if (tab === 'create' && tabs[1]) tabs[1].classList.add('active');
    if (tab === 'create') {
        _tplBuilderFolders = [];
        _tplBuilderLists = [];
        renderTplBuilderTree();
    }
}

async function loadSavedTemplates() {
    try {
        const data = await api('GET', API + '/templates');
        _savedTemplates = data.saved || [];
        _personalTemplates = data.personal || [];
        _sharedTemplates = data.shared || [];
    } catch { _savedTemplates = []; _personalTemplates = []; _sharedTemplates = []; }
}

function renderTemplateBrowseList() {
    const container = document.getElementById('tpl-browse-list');
    let html = '';

    // ── Shared Team Templates ──
    html += '<div class="tpl-section-header">Shared Team Templates</div>';
    // Built-in templates are always shared
    const builtinEntries = [
        { key: 'standard', name: 'Standard', desc: 'Development + Marketing + Admin folders' },
        { key: 'client', name: 'Client', desc: 'Deliverables + Communication folders' },
        { key: 'simple', name: 'Simple', desc: 'Flat lists, no folders' },
        { key: 'kanban', name: 'Kanban', desc: 'Single list for kanban board workflow' },
    ];
    for (const b of builtinEntries) {
        html += '<div class="tpl-card">'
            + '<div class="tpl-card-info"><div class="tpl-card-name">' + esc(b.name) + ' <span class="tpl-card-badge">built-in</span></div>'
            + '<div class="tpl-card-desc">' + esc(b.desc) + '</div></div>'
            + '<div class="tpl-card-actions">'
            + '<button class="btn btn-accent btn-small" onclick="useTemplate(\'builtin\',\'' + esc(b.key) + '\')">Use</button>'
            + '</div></div>';
    }
    for (const st of _sharedTemplates) {
        const isOwner = _user && st.owner_id === _user.id;
        const ownerLabel = st.owner_name && st.owner_name !== 'You' ? ' by ' + esc(st.owner_name) : '';
        html += '<div class="tpl-card">'
            + '<div class="tpl-card-info"><div class="tpl-card-name">' + esc(st.name) + ' <span class="tpl-card-badge">shared</span></div>'
            + '<div class="tpl-card-desc">' + esc(st.description || '') + (ownerLabel ? '<span class="tpl-card-owner">' + ownerLabel + '</span>' : '') + '</div></div>'
            + '<div class="tpl-card-actions">'
            + '<button class="btn btn-accent btn-small" onclick="useTemplate(\'saved\',\'' + esc(st.id) + '\')">Use</button>'
            + (isOwner ? '<button class="btn btn-small btn-danger" onclick="deleteSavedTemplate(\'' + esc(st.id) + '\')" title="Delete">&times;</button>' : '')
            + '</div></div>';
    }
    if (!_sharedTemplates.length) {
        html += '<div class="tpl-empty-hint">No shared templates yet. Create one and check "Share with team".</div>';
    }

    // ── Personal Templates ──
    html += '<div class="tpl-section-header" style="margin-top:20px;">My Templates</div>';
    if (_personalTemplates.length) {
        for (const st of _personalTemplates) {
            html += '<div class="tpl-card">'
                + '<div class="tpl-card-info"><div class="tpl-card-name">' + esc(st.name) + '</div>'
                + '<div class="tpl-card-desc">' + esc(st.description || '') + '</div></div>'
                + '<div class="tpl-card-actions">'
                + '<button class="btn btn-accent btn-small" onclick="useTemplate(\'saved\',\'' + esc(st.id) + '\')">Use</button>'
                + '<button class="btn btn-small btn-danger" onclick="deleteSavedTemplate(\'' + esc(st.id) + '\')" title="Delete">&times;</button>'
                + '</div></div>';
        }
    } else {
        html += '<div class="tpl-empty-hint">No personal templates yet. Create one to get started.</div>';
    }

    container.innerHTML = html;
}

function useTemplate(type, key) {
    closeAllModals();
    openCreateNewModal('space');
    // Wait for DOM to render, then set the template dropdown
    setTimeout(() => {
        const sel = document.getElementById('cn-space-template');
        if (!sel) return;
        if (type === 'builtin') {
            sel.value = key;
        } else {
            sel.value = 'saved:' + key;
        }
    }, 50);
}

async function deleteSavedTemplate(tplId) {
    if (!confirm('Delete this template?')) return;
    try {
        await api('DELETE', API + '/templates/' + tplId);
        showToast('Template deleted');
        await loadSavedTemplates();
        renderTemplateBrowseList();
    } catch { showToast('Failed to delete template'); }
}

// ── Template Tree Builder ────────────────────────────────────

function renderTplBuilderTree() {
    const container = document.getElementById('tpl-builder-tree');
    if (!_tplBuilderFolders.length && !_tplBuilderLists.length) {
        container.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px;">Add folders and lists below</div>';
        return;
    }
    let html = '';
    _tplBuilderFolders.forEach((f, fi) => {
        html += '<div class="tpl-tree-folder">'
            + '<div class="tpl-tree-folder-header">'
            + '<span>&#128193;</span> <span>' + esc(f.name) + '</span>'
            + '<button type="button" onclick="tplRemoveFolder(' + fi + ')" title="Remove">&times;</button>'
            + '<button type="button" class="tpl-tree-add-btn" onclick="tplAddListToFolder(' + fi + ')">+ list</button>'
            + '</div><div class="tpl-tree-folder-lists">';
        f.lists.forEach((l, li) => {
            html += '<div class="tpl-tree-list-item">'
                + '<span>&#128203;</span> <span>' + esc(l) + '</span>'
                + '<button type="button" onclick="tplRemoveListFromFolder(' + fi + ',' + li + ')">&times;</button>'
                + '</div>';
        });
        html += '</div></div>';
    });
    _tplBuilderLists.forEach((l, li) => {
        html += '<div class="tpl-tree-list-item">'
            + '<span>&#128203;</span> <span>' + esc(l) + '</span>'
            + '<button type="button" onclick="tplRemoveList(' + li + ')">&times;</button>'
            + '</div>';
    });
    container.innerHTML = html;
}

function tplAddFolder() {
    const name = prompt('Folder name:');
    if (!name || !name.trim()) return;
    _tplBuilderFolders.push({ name: name.trim(), lists: [] });
    renderTplBuilderTree();
}

function tplAddList() {
    const name = prompt('List name (folderless):');
    if (!name || !name.trim()) return;
    _tplBuilderLists.push(name.trim());
    renderTplBuilderTree();
}

function tplAddListToFolder(fi) {
    const name = prompt('List name:');
    if (!name || !name.trim()) return;
    _tplBuilderFolders[fi].lists.push(name.trim());
    renderTplBuilderTree();
}

function tplRemoveFolder(fi) { _tplBuilderFolders.splice(fi, 1); renderTplBuilderTree(); }
function tplRemoveList(li) { _tplBuilderLists.splice(li, 1); renderTplBuilderTree(); }
function tplRemoveListFromFolder(fi, li) { _tplBuilderFolders[fi].lists.splice(li, 1); renderTplBuilderTree(); }

// ── Structure Builder (Create New → Structure) ───────────────

function renderStructBuilderTree() {
    const container = document.getElementById('struct-builder-tree');
    if (!container) return;
    if (!_structBuilderFolders.length && !_structBuilderLists.length) {
        container.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px;">Add folders, lists, and tasks below</div>';
        return;
    }
    let html = '';
    _structBuilderFolders.forEach((f, fi) => {
        html += '<div class="tpl-tree-folder">'
            + '<div class="tpl-tree-folder-header">'
            + '<span>&#128193;</span> <span>' + esc(f.name) + '</span>'
            + '<button type="button" onclick="structRemoveFolder(' + fi + ')" title="Remove">&times;</button>'
            + '<button type="button" class="tpl-tree-add-btn" onclick="structAddListToFolder(' + fi + ')">+ list</button>'
            + '</div><div class="tpl-tree-folder-lists">';
        f.lists.forEach((l, li) => {
            html += '<div class="tpl-tree-list-item">'
                + '<span>&#128203;</span> <span>' + esc(l.name) + '</span>'
                + '<button type="button" onclick="structRemoveListFromFolder(' + fi + ',' + li + ')">&times;</button>'
                + '<button type="button" class="tpl-tree-add-btn" onclick="structAddTaskToFolderList(' + fi + ',' + li + ')">+ task</button>'
                + '</div>';
            l.tasks.forEach((t, ti) => {
                html += '<div class="struct-tree-task-item">'
                    + '<span>&#9998;</span> <span>' + esc(t) + '</span>'
                    + '<button type="button" onclick="structRemoveTaskFromFolderList(' + fi + ',' + li + ',' + ti + ')">&times;</button>'
                    + '</div>';
            });
        });
        html += '</div></div>';
    });
    _structBuilderLists.forEach((l, li) => {
        html += '<div class="tpl-tree-list-item">'
            + '<span>&#128203;</span> <span>' + esc(l.name) + '</span>'
            + '<button type="button" onclick="structRemoveList(' + li + ')">&times;</button>'
            + '<button type="button" class="tpl-tree-add-btn" onclick="structAddTaskToList(' + li + ')">+ task</button>'
            + '</div>';
        l.tasks.forEach((t, ti) => {
            html += '<div class="struct-tree-task-item">'
                + '<span>&#9998;</span> <span>' + esc(t) + '</span>'
                + '<button type="button" onclick="structRemoveTaskFromList(' + li + ',' + ti + ')">&times;</button>'
                + '</div>';
        });
    });
    container.innerHTML = html;
}

function structAddFolder() {
    const name = prompt('Folder name:');
    if (!name || !name.trim()) return;
    _structBuilderFolders.push({ name: name.trim(), lists: [] });
    renderStructBuilderTree();
}

function structAddList() {
    const name = prompt('List name (folderless):');
    if (!name || !name.trim()) return;
    _structBuilderLists.push({ name: name.trim(), tasks: [] });
    renderStructBuilderTree();
}

function structAddListToFolder(fi) {
    const name = prompt('List name:');
    if (!name || !name.trim()) return;
    _structBuilderFolders[fi].lists.push({ name: name.trim(), tasks: [] });
    renderStructBuilderTree();
}

function structAddTaskToFolderList(fi, li) {
    const name = prompt('Task title:');
    if (!name || !name.trim()) return;
    _structBuilderFolders[fi].lists[li].tasks.push(name.trim());
    renderStructBuilderTree();
}

function structAddTaskToList(li) {
    const name = prompt('Task title:');
    if (!name || !name.trim()) return;
    _structBuilderLists[li].tasks.push(name.trim());
    renderStructBuilderTree();
}

function structRemoveFolder(fi) { _structBuilderFolders.splice(fi, 1); renderStructBuilderTree(); }
function structRemoveList(li) { _structBuilderLists.splice(li, 1); renderStructBuilderTree(); }
function structRemoveListFromFolder(fi, li) { _structBuilderFolders[fi].lists.splice(li, 1); renderStructBuilderTree(); }
function structRemoveTaskFromFolderList(fi, li, ti) { _structBuilderFolders[fi].lists[li].tasks.splice(ti, 1); renderStructBuilderTree(); }
function structRemoveTaskFromList(li, ti) { _structBuilderLists[li].tasks.splice(ti, 1); renderStructBuilderTree(); }

function toggleStructTplName() {
    const checked = document.getElementById('cn-struct-save-tpl')?.checked;
    const wrap = document.getElementById('cn-struct-tpl-name-wrap');
    if (wrap) wrap.style.display = checked ? '' : 'none';
}

async function handleSaveTemplate(e) {
    e.preventDefault();
    const name = document.getElementById('tpl-create-name')?.value?.trim();
    if (!name) return;
    const desc = document.getElementById('tpl-create-desc')?.value?.trim() || '';
    const shared = document.getElementById('tpl-create-shared')?.checked || false;
    const structure = {
        folders: _tplBuilderFolders.map(f => ({ name: f.name, lists: [...f.lists] })),
        lists: [..._tplBuilderLists],
    };
    try {
        await api('POST', API + '/templates', { name, description: desc, shared, structure });
        showToast('Template saved!');
        document.getElementById('tpl-create-form')?.reset();
        _tplBuilderFolders = [];
        _tplBuilderLists = [];
        renderTplBuilderTree();
        await loadSavedTemplates();
        switchTemplateTab('browse');
    } catch { showToast('Failed to save template'); }
}

// ── Add Member Modal (Multi-Space) ───────────────────────────

let _memberSearchTimeout = null;
let _inviteSpaceMembers = {};  // { spaceId: [user_ids] }
let _inviteSelectedSpaces = new Set();

async function openInviteModal() {
    const modal = document.getElementById('invite-modal');
    if (!modal) return;
    modal.classList.add('visible');

    const searchInput = document.getElementById('member-search');
    const resultsEl = document.getElementById('member-search-results');
    const hintEl = document.getElementById('member-search-hint');
    searchInput.value = '';
    resultsEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:16px;text-align:center;">Loading users...</div>';
    searchInput.disabled = false;
    hintEl.style.display = 'none';

    // Always reload profiles to ensure fresh data
    await loadProfiles();

    // Pre-select current space if one is selected
    _inviteSelectedSpaces.clear();
    if (_currentSpaceId) {
        _inviteSelectedSpaces.add(_currentSpaceId);
    }
    document.getElementById('invite-share-all').checked = false;

    // Render space checkboxes
    renderInviteSpaceList();

    // Load members for selected spaces
    if (_inviteSelectedSpaces.size > 0) {
        await loadInviteSpaceMembers();
    }

    // Show all available users immediately
    renderMemberSearchResults('');
    renderCurrentMembers();

    searchInput.focus();
    searchInput.oninput = () => {
        clearTimeout(_memberSearchTimeout);
        _memberSearchTimeout = setTimeout(() => {
            renderMemberSearchResults(searchInput.value.trim());
        }, 100);
    };
}

function renderInviteSpaceList() {
    const container = document.getElementById('invite-space-list');
    if (!container) return;
    const shareAll = document.getElementById('invite-share-all')?.checked;
    container.innerHTML = _spaces.map(s => {
        const checked = shareAll || _inviteSelectedSpaces.has(s.id) ? ' checked' : '';
        const disabled = shareAll ? ' disabled' : '';
        return '<label class="invite-space-item">'
            + '<input type="checkbox"' + checked + disabled + ' onchange="toggleInviteSpace(\'' + esc(s.id) + '\', this.checked)">'
            + '<span class="invite-space-dot" style="background:' + esc(s.color || '#6c5ce7') + ';"></span>'
            + '<span class="th-tree-name">' + esc(s.name) + '</span>'
            + '</label>';
    }).join('');
}

function toggleInviteShareAll() {
    const shareAll = document.getElementById('invite-share-all')?.checked;
    if (shareAll) {
        _inviteSelectedSpaces = new Set(_spaces.map(s => s.id));
    }
    renderInviteSpaceList();
    loadInviteSpaceMembers().then(() => {
        const searchInput = document.getElementById('member-search');
        renderMemberSearchResults(searchInput?.value?.trim() || '');
        renderCurrentMembers();
    });
}

function toggleInviteSpace(spaceId, checked) {
    if (checked) _inviteSelectedSpaces.add(spaceId);
    else _inviteSelectedSpaces.delete(spaceId);
    loadInviteSpaceMembers().then(() => {
        const searchInput = document.getElementById('member-search');
        renderMemberSearchResults(searchInput?.value?.trim() || '');
        renderCurrentMembers();
    });
}

async function loadInviteSpaceMembers() {
    _inviteSpaceMembers = {};
    const promises = [];
    for (const spaceId of _inviteSelectedSpaces) {
        promises.push(
            api('GET', API + '/workspaces/' + spaceId + '/members')
                .then(data => { _inviteSpaceMembers[spaceId] = (data.members || []).map(m => m.user_id); })
                .catch(() => { _inviteSpaceMembers[spaceId] = []; })
        );
    }
    await Promise.all(promises);
}

function renderMemberSearchResults(query) {
    const resultsEl = document.getElementById('member-search-results');
    const hintEl = document.getElementById('member-search-hint');
    if (!resultsEl) return;

    const noSpaces = _inviteSelectedSpaces.size === 0;

    // Combine all member IDs from selected spaces (to show "Added" state)
    const allMemberIds = new Set();
    for (const spaceId of _inviteSelectedSpaces) {
        for (const uid of (_inviteSpaceMembers[spaceId] || [])) {
            allMemberIds.add(uid);
        }
    }

    const q = query.toLowerCase();
    const available = _profiles.filter(p => {
        if (p.id === _user?.id) return false;
        if (!q) return true;
        const name = (p.display_name || '').toLowerCase();
        const email = (p.email || '').toLowerCase();
        return name.includes(q) || email.includes(q);
    });

    if (_profiles.length === 0) {
        resultsEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:16px;text-align:center;">No users found. Make sure profiles exist in the system.</div>';
        hintEl.style.display = 'none';
        return;
    }

    if (available.length === 0) {
        const msg = q ? 'No users match "' + esc(query) + '"' : 'No other users available';
        resultsEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:16px;text-align:center;">' + msg + '</div>';
        hintEl.style.display = 'none';
        return;
    }

    hintEl.style.display = 'none';
    resultsEl.innerHTML = available.map(p => {
        const name = p.display_name || p.email || '?';
        const initials = name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
        const sub = p.display_name ? p.email : '';
        const alreadyInAll = !noSpaces && allMemberIds.has(p.id);
        const noSpaceHint = noSpaces;
        const btnLabel = alreadyInAll ? 'Added' : (noSpaceHint ? 'Select space' : 'Add');
        const btnClass = alreadyInAll || noSpaceHint ? 'btn btn-ghost btn-small' : 'btn btn-accent btn-small';
        const btnDisabled = alreadyInAll || noSpaceHint ? ' disabled' : '';
        return '<div class="invite-user-row">'
            + '<div class="th-member-avatar" style="width:32px;height:32px;font-size:11px;">' + esc(initials) + '</div>'
            + '<div class="th-member-info" style="flex:1;">'
            + '<div class="th-member-name">' + esc(name) + '</div>'
            + (sub ? '<div class="th-member-email">' + esc(sub) + '</div>' : '')
            + '</div>'
            + '<button class="' + btnClass + '"' + btnDisabled + ' onclick="event.stopPropagation();addMemberToSpaces(\'' + esc(p.id) + '\', this)">' + btnLabel + '</button>'
            + '</div>';
    }).join('');
}

async function addMemberToSpaces(userId, btnEl) {
    if (_inviteSelectedSpaces.size === 0) { showToast('No spaces selected'); return; }
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = 'Adding...'; }
    let addedCount = 0;
    let alreadyCount = 0;
    for (const spaceId of _inviteSelectedSpaces) {
        // Skip if already a member of this space
        if ((_inviteSpaceMembers[spaceId] || []).includes(userId)) {
            alreadyCount++;
            continue;
        }
        try {
            await api('POST', API + '/workspaces/' + spaceId + '/add-member', { user_id: userId });
            if (!_inviteSpaceMembers[spaceId]) _inviteSpaceMembers[spaceId] = [];
            _inviteSpaceMembers[spaceId].push(userId);
            addedCount++;
        } catch (err) {
            const msg = err.message || '';
            if (msg.includes('already a member')) alreadyCount++;
        }
    }
    if (addedCount > 0) {
        showToast('Added to ' + addedCount + ' space' + (addedCount > 1 ? 's' : ''));
    } else if (alreadyCount > 0) {
        showToast('Already a member of selected spaces');
    } else {
        showToast('Failed to add member');
    }
    if (btnEl) { btnEl.textContent = 'Added'; btnEl.classList.remove('btn-accent'); btnEl.classList.add('btn-ghost'); }
}

// ── Space Settings Modal ─────────────────────────────────────

let _settingsStatuses = [];
let _settingsTags = [];
let _settingsTab = 'statuses';

async function openSettingsModal() {
    const modal = document.getElementById('settings-modal');
    if (!modal) return;
    modal.classList.add('visible');
    _discordAIWorkspaces = null; // Reset so Discord AI tab reloads fresh

    document.getElementById('settings-space-label').textContent = 'TeamHub Settings';

    _settingsTab = 'statuses';
    switchSettingsTab('statuses');
    await loadSettingsData();
}

async function loadSettingsData() {
    const wsId = _myPersonalSpaceId();
    if (!wsId) {
        _settingsStatuses = [];
        _settingsTags = [];
        renderSettingsTab();
        return;
    }

    // Load statuses from personal workspace (global settings)
    try {
        const data = await api('GET', API + '/workspaces/' + wsId + '/statuses');
        _settingsStatuses = data.statuses || [];
    } catch { _settingsStatuses = []; }

    // Load tags from personal workspace (global settings)
    try {
        const data = await api('GET', API + '/workspaces/' + wsId + '/tags');
        _settingsTags = data.tags || [];
    } catch { _settingsTags = []; }

    renderSettingsTab();
}

function switchSettingsTab(tab) {
    _settingsTab = tab;
    document.querySelectorAll('#settings-modal .th-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('#settings-modal .th-tab').forEach(t => {
        const txt = t.textContent.toLowerCase();
        if (tab === 'landing' && txt.includes('land')) t.classList.add('active');
        else if (tab !== 'landing' && txt.includes(tab.substring(0, 4))) t.classList.add('active');
    });
    document.getElementById('settings-tab-statuses').style.display = tab === 'statuses' ? '' : 'none';
    document.getElementById('settings-tab-priorities').style.display = tab === 'priorities' ? '' : 'none';
    document.getElementById('settings-tab-tags').style.display = tab === 'tags' ? '' : 'none';
    document.getElementById('settings-tab-import').style.display = tab === 'import' ? '' : 'none';
    document.getElementById('settings-tab-landing').style.display = tab === 'landing' ? '' : 'none';
    document.getElementById('settings-tab-members').style.display = tab === 'members' ? '' : 'none';
    document.getElementById('settings-tab-discord-ai').style.display = tab === 'discord-ai' ? '' : 'none';
    renderSettingsTab();
}

function renderSettingsTab() {
    if (_settingsTab === 'statuses') renderSettingsStatuses();
    else if (_settingsTab === 'priorities') renderSettingsPriorities();
    else if (_settingsTab === 'tags') renderSettingsTags();
    else if (_settingsTab === 'import') renderSettingsImport();
    else if (_settingsTab === 'landing') renderSettingsLanding();
    else if (_settingsTab === 'members') renderSettingsMembers();
    else if (_settingsTab === 'discord-ai') renderSettingsDiscordAI();
}

function renderSettingsStatuses() {
    const el = document.getElementById('settings-tab-statuses');
    const isOwner = _isSettingsOwner();
    let html = '<div class="settings-info-box">' + (isOwner
        ? 'Manage the workflow statuses for this space. Statuses define the lifecycle of your tasks.'
        : 'These statuses are managed by the workspace owner. You can still assign them to tasks.') + '</div>';
    html += '<div class="settings-list">';
    for (const s of _settingsStatuses) {
        if (isOwner) {
            html += '<div class="settings-item" data-status-id="' + esc(s.id) + '">'
                + '<input type="color" class="settings-color-input-inline" value="' + esc(s.color || '#595d66') + '" onchange="updateSettingsStatus(\'' + esc(s.id) + '\', null, this.value)" title="Change color">'
                + '<span class="settings-item-name">' + esc(s.name) + '</span>'
                + '<span class="settings-item-type">' + esc(s.type || 'active') + '</span>'
                + '<div class="settings-item-actions">'
                + '<button class="settings-item-btn" onclick="editSettingsStatus(\'' + esc(s.id) + '\', \'' + esc(s.name) + '\')" title="Rename"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>'
                + '<button class="settings-item-btn danger" onclick="deleteSettingsStatus(\'' + esc(s.id) + '\', \'' + esc(s.name) + '\')" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>'
                + '</div></div>';
        } else {
            html += '<div class="settings-item">'
                + '<span class="settings-item-color" style="background:' + esc(s.color || '#595d66') + ';"></span>'
                + '<span class="settings-item-name">' + esc(s.name) + '</span>'
                + '<span class="settings-item-type">' + esc(s.type || 'active') + '</span>'
                + '</div>';
        }
    }
    html += '</div>';
    if (isOwner) {
        html += '<div class="settings-add-row">'
            + '<input type="color" value="#6c5ce7" id="settings-new-status-color" style="width:36px;height:36px;padding:2px;border:1px solid var(--border);border-radius:6px;background:var(--bg);cursor:pointer;">'
            + '<input class="form-input" id="settings-new-status-name" placeholder="New status name..." style="flex:1;" onkeydown="if(event.key===\'Enter\'){event.preventDefault();addSettingsStatus();}">'
            + '<select class="form-select" id="settings-new-status-type" style="width:auto;min-width:90px;padding:8px 10px;font-size:12px;">'
            + '<option value="active">Active</option><option value="done">Done</option><option value="closed">Closed</option>'
            + '</select>'
            + '<button class="btn btn-accent btn-small" onclick="addSettingsStatus()">Add</button>'
            + '</div>';
    }
    el.innerHTML = html;
}

async function addSettingsStatus() {
    if (!_isSettingsOwner()) { showToast('Only the workspace owner can manage statuses'); return; }
    const wsId = _myPersonalSpaceId();
    if (!wsId) return;
    const name = document.getElementById('settings-new-status-name')?.value?.trim();
    const color = document.getElementById('settings-new-status-color')?.value || '#6c5ce7';
    const type = document.getElementById('settings-new-status-type')?.value || 'active';
    if (!name) { showToast('Enter a status name'); return; }
    try {
        await api('POST', API + '/workspaces/' + wsId + '/statuses', { name, color, type });
        showToast('Status added');
        document.getElementById('settings-new-status-name').value = '';
        _syncSettingsToAllSpaces();
        await loadSettingsData();
    } catch { showToast('Failed to add status'); }
}

async function updateSettingsStatus(statusId, newName, newColor) {
    if (!_isSettingsOwner()) { showToast('Only the workspace owner can manage statuses'); return; }
    const body = {};
    if (newName) body.name = newName;
    if (newColor) body.color = newColor;
    try {
        await api('PATCH', API + '/statuses/' + statusId, body);
        _syncSettingsToAllSpaces();
        await loadSettingsData();
    } catch { showToast('Failed to update status'); }
}

function editSettingsStatus(statusId, currentName) {
    const item = document.querySelector('[data-status-id="' + statusId + '"] .settings-item-name');
    if (!item) return;
    const input = document.createElement('input');
    input.className = 'settings-edit-inline';
    input.value = currentName;
    input.onblur = () => {
        const newName = input.value.trim();
        if (newName && newName !== currentName) {
            updateSettingsStatus(statusId, newName, null);
        } else {
            renderSettingsStatuses();
        }
    };
    input.onkeydown = (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { input.value = currentName; input.blur(); }
    };
    item.replaceWith(input);
    input.focus();
    input.select();
}

async function deleteSettingsStatus(statusId, name) {
    if (!_isSettingsOwner()) { showToast('Only the workspace owner can manage statuses'); return; }
    if (!confirm('Delete status "' + name + '"? Tasks with this status will keep their current value.')) return;
    try {
        await api('DELETE', API + '/statuses/' + statusId);
        showToast('Status deleted');
        _syncSettingsToAllSpaces();
        await loadSettingsData();
    } catch { showToast('Failed to delete status'); }
}

function renderSettingsPriorities() {
    const el = document.getElementById('settings-tab-priorities');
    const isOwner = _isSettingsOwner();
    let html = '<div class="settings-info-box">' + (isOwner
        ? 'Priority levels apply across all your spaces. These are the built-in priorities used by the system.'
        : 'These priority levels are set by the workspace owner and apply to all tasks.') + '</div>';
    html += '<div class="settings-list">';
    for (const p of PRIORITIES) {
        html += '<div class="settings-item">'
            + '<span class="settings-item-color" style="background:' + esc(p.color) + ';"></span>'
            + '<span class="settings-item-name">' + esc(p.label) + '</span>'
            + '<span class="settings-item-type" style="font-size:10px;background:' + esc(p.color) + '18;color:' + esc(p.color) + ';">' + esc(p.value) + '</span>'
            + '</div>';
    }
    html += '</div>';
    if (isOwner) {
        html += '<div style="margin-top:12px;padding:10px;font-size:12px;color:var(--text-muted);background:var(--bg);border-radius:8px;">Custom priority levels coming soon. These system defaults apply across all your spaces.</div>';
    }
    el.innerHTML = html;
}

function renderSettingsTags() {
    const el = document.getElementById('settings-tab-tags');
    const isOwner = _isSettingsOwner();
    let html = '<div class="settings-info-box">' + (isOwner
        ? 'Tags help categorize and filter tasks. Create workspace-level tags that can be applied to any task in this space.'
        : 'These tags are managed by the workspace owner. You can still assign them to tasks.') + '</div>';
    html += '<div class="settings-list">';
    for (const tag of _settingsTags) {
        if (isOwner) {
            html += '<div class="settings-item" data-tag-id="' + esc(tag.id) + '">'
                + '<input type="color" class="settings-color-input-inline" value="' + esc(tag.color || '#6366f1') + '" onchange="updateSettingsTag(\'' + esc(tag.id) + '\', null, this.value)" title="Change color">'
                + '<span class="settings-item-name">' + esc(tag.name) + '</span>'
                + '<div class="settings-item-actions">'
                + '<button class="settings-item-btn" onclick="editSettingsTag(\'' + esc(tag.id) + '\', \'' + esc(tag.name) + '\')" title="Rename"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>'
                + '<button class="settings-item-btn danger" onclick="deleteSettingsTag(\'' + esc(tag.id) + '\', \'' + esc(tag.name) + '\')" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>'
                + '</div></div>';
        } else {
            html += '<div class="settings-item">'
                + '<span class="settings-item-color" style="background:' + esc(tag.color || '#6366f1') + ';"></span>'
                + '<span class="settings-item-name">' + esc(tag.name) + '</span>'
                + '</div>';
        }
    }
    html += '</div>';
    if (isOwner) {
        html += '<div class="settings-add-row">'
            + '<input type="color" value="#6366f1" id="settings-new-tag-color" style="width:36px;height:36px;padding:2px;border:1px solid var(--border);border-radius:6px;background:var(--bg);cursor:pointer;">'
            + '<input class="form-input" id="settings-new-tag-name" placeholder="New tag name..." style="flex:1;" onkeydown="if(event.key===\'Enter\'){event.preventDefault();addSettingsTag();}">'
            + '<button class="btn btn-accent btn-small" onclick="addSettingsTag()">Add</button>'
            + '</div>';
    }
    el.innerHTML = html;
}

async function addSettingsTag() {
    if (!_isSettingsOwner()) { showToast('Only the workspace owner can manage tags'); return; }
    const wsId = _myPersonalSpaceId();
    if (!wsId) return;
    const name = document.getElementById('settings-new-tag-name')?.value?.trim();
    const color = document.getElementById('settings-new-tag-color')?.value || '#6366f1';
    if (!name) { showToast('Enter a tag name'); return; }
    try {
        await api('POST', API + '/workspaces/' + wsId + '/tags', { name, color });
        showToast('Tag added');
        document.getElementById('settings-new-tag-name').value = '';
        _syncSettingsToAllSpaces();
        await loadSettingsData();
    } catch { showToast('Failed to add tag'); }
}

async function updateSettingsTag(tagId, newName, newColor) {
    if (!_isSettingsOwner()) { showToast('Only the workspace owner can manage tags'); return; }
    const wsId = _myPersonalSpaceId();
    if (!wsId) return;
    const body = {};
    if (newName) body.name = newName;
    if (newColor) body.color = newColor;
    try {
        await api('PATCH', API + '/workspaces/' + wsId + '/tags/' + tagId, body);
        _syncSettingsToAllSpaces();
        await loadSettingsData();
    } catch { showToast('Failed to update tag'); }
}

function editSettingsTag(tagId, currentName) {
    const item = document.querySelector('[data-tag-id="' + tagId + '"] .settings-item-name');
    if (!item) return;
    const input = document.createElement('input');
    input.className = 'settings-edit-inline';
    input.value = currentName;
    input.onblur = () => {
        const newName = input.value.trim();
        if (newName && newName !== currentName) {
            updateSettingsTag(tagId, newName, null);
        } else {
            renderSettingsTags();
        }
    };
    input.onkeydown = (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { input.value = currentName; input.blur(); }
    };
    item.replaceWith(input);
    input.focus();
    input.select();
}

async function deleteSettingsTag(tagId, name) {
    if (!_isSettingsOwner()) { showToast('Only the workspace owner can manage tags'); return; }
    const wsId = _myPersonalSpaceId();
    if (!wsId) return;
    if (!confirm('Delete tag "' + name + '"? It will be removed from all tasks.')) return;
    try {
        await api('DELETE', API + '/workspaces/' + wsId + '/tags/' + tagId);
        showToast('Tag deleted');
        _syncSettingsToAllSpaces();
        await loadSettingsData();
    } catch { showToast('Failed to delete tag'); }
}

// ── Landing Settings Tab ─────────────────────────────────────

function renderSettingsLanding() {
    const el = document.getElementById('settings-tab-landing');
    if (!el) return;
    const layout = loadHomeLayout();
    const tiles = [...layout.tiles].sort((a, b) => a.order - b.order);

    let html = '<div class="settings-info-box">Configure your home dashboard. Toggle tiles on/off and drag to reorder them.</div>';
    html += '<div class="settings-list" id="landing-tile-list">';
    for (const tile of tiles) {
        const checked = tile.visible ? ' checked' : '';
        const sizeLabel = tile.size || '1x1';
        html += '<div class="settings-item landing-tile-item" draggable="true" data-tile-id="' + esc(tile.id) + '">'
            + '<span class="landing-drag-handle" title="Drag to reorder">&#9776;</span>'
            + '<label class="landing-toggle-label">'
            + '<input type="checkbox"' + checked + ' onchange="toggleLandingTile(\'' + esc(tile.id) + '\', this.checked)">'
            + '<span class="settings-item-name">' + esc(tile.title) + '</span>'
            + '</label>'
            + '<span class="landing-size-btn" onclick="toggleLandingTileSize(\'' + esc(tile.id) + '\')" title="Click to cycle size">' + esc(sizeLabel) + '</span>'
            + '</div>';
    }
    html += '</div>';
    html += '<div style="margin-top:12px;">'
        + '<button class="btn btn-ghost btn-small" onclick="resetLandingDefaults()">Reset to Defaults</button>'
        + '</div>';
    el.innerHTML = html;
    bindLandingDragAndDrop();
}

function toggleLandingTile(tileId, visible) {
    if (!_homeLayout) loadHomeLayout();
    const tile = _homeLayout.tiles.find(t => t.id === tileId);
    if (tile) { tile.visible = visible; saveHomeLayout(); }
}

function toggleLandingTileSize(tileId) {
    if (!_homeLayout) loadHomeLayout();
    const tile = _homeLayout.tiles.find(t => t.id === tileId);
    if (tile) {
        const idx = TILE_SIZES.indexOf(tile.size || '1x1');
        tile.size = TILE_SIZES[(idx + 1) % TILE_SIZES.length];
        saveHomeLayout();
        renderSettingsLanding();
    }
}

function resetLandingDefaults() {
    _homeLayout = { tiles: DEFAULT_HOME_TILES.map(t => ({ ...t })) };
    saveHomeLayout();
    renderSettingsLanding();
    showToast('Reset to defaults');
}

function bindLandingDragAndDrop() {
    let dragId = null;
    document.querySelectorAll('.landing-tile-item').forEach(item => {
        item.addEventListener('dragstart', (e) => {
            dragId = item.dataset.tileId;
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        });
        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
            dragId = null;
            document.querySelectorAll('.landing-tile-item').forEach(i => i.classList.remove('drag-over-above'));
        });
        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (item.dataset.tileId === dragId) return;
            item.classList.add('drag-over-above');
        });
        item.addEventListener('dragleave', () => item.classList.remove('drag-over-above'));
        item.addEventListener('drop', (e) => {
            e.preventDefault();
            item.classList.remove('drag-over-above');
            if (!dragId || dragId === item.dataset.tileId) return;
            // Reorder in layout
            const tiles = _homeLayout.tiles;
            const dragTile = tiles.find(t => t.id === dragId);
            const dropTile = tiles.find(t => t.id === item.dataset.tileId);
            if (!dragTile || !dropTile) return;
            const sorted = [...tiles].sort((a, b) => a.order - b.order);
            const dragIdx = sorted.indexOf(dragTile);
            const dropIdx = sorted.indexOf(dropTile);
            sorted.splice(dragIdx, 1);
            sorted.splice(dropIdx, 0, dragTile);
            sorted.forEach((t, i) => t.order = i);
            saveHomeLayout();
            renderSettingsLanding();
        });
    });
}

// ── Discord AI Settings Tab ──────────────────────────────────
//
// Single-server model: one Discord connection at the top level,
// workspace scope checkboxes below to control what the bot can access.
//
// Future: per-workspace server/channel config is commented out below
// this section — can be re-enabled for multi-server support later.

// ── Members management ────────────────────────────────────
let _settingsMembers = [];

async function renderSettingsMembers() {
    const el = document.getElementById('settings-tab-members');
    if (!el) return;
    if (!_currentSpaceId) {
        el.innerHTML = '<div class="settings-info-box">Select a space first to manage its members.</div>';
        return;
    }
    // Find current user's role in this space
    const space = _spaces.find(s => s.id === _currentSpaceId);
    const myRole = space?.my_role || 'member';
    const isOwner = myRole === 'owner';

    el.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted);">Loading members...</div>';
    try {
        const data = await api('GET', API + '/workspaces/' + _currentSpaceId + '/members');
        _settingsMembers = data.members || [];
    } catch {
        el.innerHTML = '<div class="settings-info-box" style="color:var(--error);">Failed to load members.</div>';
        return;
    }

    let html = '<div class="th-members-list">';
    for (const m of _settingsMembers) {
        const name = m.display_name || m.email || m.user_id;
        const isMe = m.user_id === _user?.id;
        const isMemberOwner = m.role === 'owner';

        html += '<div class="th-member-row">'
            + '<div class="th-member-info">'
            + '<div class="th-member-name">' + esc(name) + (isMe ? ' <span style="color:var(--text-muted);font-size:11px;">(you)</span>' : '') + '</div>'
            + '<div class="th-member-email" style="font-size:11px;color:var(--text-muted);">' + esc(m.email || '') + '</div>'
            + '</div>'
            + '<div class="th-member-controls">';

        if (isOwner && !isMe && !isMemberOwner) {
            // Owner can change roles and remove non-owner members
            html += '<select class="form-select th-member-role-select" onchange="changeMemberRole(\'' + esc(m.user_id) + '\', this.value)">'
                + '<option value="admin"' + (m.role === 'admin' ? ' selected' : '') + '>Admin</option>'
                + '<option value="member"' + (m.role === 'member' ? ' selected' : '') + '>Member</option>'
                + '<option value="viewer"' + (m.role === 'viewer' ? ' selected' : '') + '>Viewer</option>'
                + '</select>'
                + '<button class="btn btn-small btn-ghost th-member-remove" onclick="removeMemberFromSpace(\'' + esc(m.user_id) + '\', \'' + esc(name) + '\')" title="Remove member">&times;</button>';
        } else {
            // Display role as badge
            html += '<span class="th-member-role-badge th-role-' + esc(m.role) + '">' + esc(m.role) + '</span>';
        }

        html += '</div></div>';
    }
    html += '</div>';

    if (!isOwner) {
        html += '<div class="settings-info-box" style="margin-top:12px;">Only workspace owners can manage member access.</div>';
    }

    el.innerHTML = html;
}

async function changeMemberRole(userId, newRole) {
    if (!_currentSpaceId) return;
    try {
        await api('PATCH', API + '/workspaces/' + _currentSpaceId + '/members/' + userId, { role: newRole });
        showToast('Role updated');
        renderSettingsMembers();
    } catch (e) {
        showToast(e.message || 'Failed to update role');
    }
}

async function removeMemberFromSpace(userId, name) {
    if (!_currentSpaceId) return;
    if (!confirm('Remove ' + name + ' from this space? They will lose access to all tasks in this space.')) return;
    try {
        await api('DELETE', API + '/workspaces/' + _currentSpaceId + '/members/' + userId);
        showToast(name + ' removed');
        renderSettingsMembers();
    } catch (e) {
        showToast(e.message || 'Failed to remove member');
    }
}

// ── Discord AI ────────────────────────────────────────────
let _discordAIWorkspaces = null;
let _discordAIConnection = null; // {server_id, channel_id, bot_prompt} from first linked workspace
let _discordAIDirty = false;

async function renderSettingsDiscordAI() {
    const el = document.getElementById('settings-tab-discord-ai');
    if (!el) return;

    // Load all workspaces + their Discord settings on first render
    if (!_discordAIWorkspaces) {
        el.innerHTML = '<div class="settings-info-box">Loading workspaces...</div>';
        try {
            const wsData = await api('GET', API + '/workspaces');
            const workspaces = wsData.workspaces || [];
            _discordAIWorkspaces = await Promise.all(workspaces.map(async (ws) => {
                let discord = {};
                try {
                    discord = await api('GET', API + '/workspaces/' + ws.id + '/discord');
                } catch {}
                return {
                    id: ws.id,
                    name: ws.name,
                    icon: ws.icon || '',
                    my_role: ws.my_role || 'member',
                    discord_server_id: discord.discord_server_id || '',
                    discord_channel_id: discord.discord_channel_id || '',
                    bot_prompt: discord.bot_prompt || '',
                };
            }));
        } catch {
            _discordAIWorkspaces = [];
        }
        // Derive top-level connection from first workspace that has discord settings
        const linked = _discordAIWorkspaces.find(w => w.discord_server_id && w.discord_channel_id);
        _discordAIConnection = {
            server_id: linked ? linked.discord_server_id : '',
            channel_id: linked ? linked.discord_channel_id : '',
            bot_prompt: linked ? linked.bot_prompt : '',
        };
        _discordAIDirty = false;
    }

    const conn = _discordAIConnection;
    const isConnected = !!(conn.server_id && conn.channel_id);
    const enabledCount = _discordAIWorkspaces.filter(w => !!w.bot_prompt).length;

    let html = '';

    // ── Connection section ──
    html += '<div class="discord-ai-section">'
        + '<div class="discord-ai-section-header">'
        + '<div style="display:flex;align-items:center;gap:8px;">'
        + '<span class="discord-ai-status-dot' + (isConnected && enabledCount > 0 ? ' connected' : '') + '"></span>'
        + '<strong style="font-size:13px;">' + (isConnected && enabledCount > 0 ? 'Bot Connected' : isConnected ? 'Channel Linked' : 'Not Connected') + '</strong>'
        + '</div></div>'
        + '<div class="settings-info-box" style="margin-bottom:12px;">'
        + 'Connect the OPAI Discord bot to a channel. Messages in that channel will be answered by the AI with access to your selected workspaces below.'
        + '</div>';

    // Server ID + invite link
    html += '<div class="discord-ai-field">'
        + '<label class="form-label">Discord Server ID</label>'
        + '<input class="form-input" id="dai-server-id" value="' + esc(conn.server_id) + '" '
        + 'placeholder="Right-click your server name > Copy Server ID" '
        + 'oninput="_discordAIDirty=true; _updateBotInviteLink()">'
        + '</div>';

    // Bot invite banner — shown when server ID is entered
    html += '<div id="dai-invite-banner" class="discord-ai-invite-banner" style="display:' + (conn.server_id ? 'block' : 'none') + ';">'
        + '<div class="discord-ai-invite-header">Add the bot to your server</div>'
        + '<p style="margin:4px 0 8px;font-size:12px;color:var(--text-muted);">'
        + 'The OPAI bot must be a member of your Discord server to see and respond to messages. Click the link below to invite it:</p>'
        + '<a id="dai-invite-link" href="https://discord.com/oauth2/authorize?client_id=1470540768547700920&scope=bot&permissions=274877975552&guild_id=' + esc(conn.server_id) + '" '
        + 'target="_blank" rel="noopener" class="discord-ai-invite-link">'
        + 'Invite OPAI Bot to Server</a>'
        + '<ol class="discord-ai-invite-steps">'
        + '<li>Click the invite link above &mdash; it opens Discord\'s authorization page.</li>'
        + '<li>Select your server from the dropdown (it will be pre-selected if the Server ID is correct).</li>'
        + '<li>Click <strong>Authorize</strong> &mdash; the bot will join your server.</li>'
        + '<li>Come back here and enter the Channel ID below, then save.</li>'
        + '</ol>'
        + '</div>';

    // Channel ID
    html += '<div class="discord-ai-field">'
        + '<label class="form-label">Discord Channel ID</label>'
        + '<input class="form-input" id="dai-channel-id" value="' + esc(conn.channel_id) + '" '
        + 'placeholder="Right-click the channel > Copy Channel ID" '
        + 'oninput="_discordAIDirty=true">'
        + '</div>';

    // Bot prompt
    html += '<div class="discord-ai-field">'
        + '<label class="form-label">Bot System Prompt <span style="font-weight:400;color:var(--text-muted);">(optional override)</span></label>'
        + '<textarea class="form-input discord-ai-prompt" id="dai-bot-prompt" rows="3" '
        + 'placeholder="Custom personality or instructions for the bot..." '
        + 'oninput="_discordAIDirty=true">'
        + esc(conn.bot_prompt) + '</textarea>'
        + '</div>';
    html += '</div>'; // section

    // ── Workspace scope section ──
    html += '<div class="discord-ai-section" style="margin-top:16px;">'
        + '<div class="discord-ai-section-header">'
        + '<strong style="font-size:13px;">Workspace Scope</strong>'
        + '<span style="font-size:11px;color:var(--text-muted);">' + enabledCount + ' of ' + _discordAIWorkspaces.length + ' enabled</span>'
        + '</div>'
        + '<div class="settings-info-box" style="margin-bottom:8px;">'
        + 'Check the workspaces the bot can see and interact with. Checked workspaces become part of the bot\'s knowledge — it can create tasks, search items, manage folders, and more within them.'
        + '</div>';

    html += '<div class="discord-ai-ws-list">';
    for (const ws of _discordAIWorkspaces) {
        const isScoped = !!ws.bot_prompt;
        const isAdmin = ws.my_role === 'owner' || ws.my_role === 'admin';

        html += '<label class="discord-ai-ws-item' + (isScoped ? ' enabled' : '') + '">'
            + '<input type="checkbox" ' + (isScoped ? 'checked' : '') + (isAdmin ? '' : ' disabled title="Admin access required"')
            + ' data-ws-id="' + esc(ws.id) + '" onchange="_discordAIDirty=true; this.closest(\'.discord-ai-ws-item\').classList.toggle(\'enabled\', this.checked)">'
            + '<span class="discord-ai-ws-name">' + esc(ws.icon ? ws.icon + ' ' : '') + esc(ws.name) + '</span>'
            + (!isAdmin ? '<span style="font-size:10px;color:var(--text-muted);margin-left:auto;">view only</span>' : '')
            + '</label>';
    }
    html += '</div></div>'; // ws-list, section

    // ── Save button ──
    html += '<div style="margin-top:16px;display:flex;align-items:center;gap:12px;">'
        + '<button class="btn btn-accent btn-small" onclick="saveDiscordAISettings()" id="discord-ai-save-btn">Save &amp; Apply</button>'
        + '<span id="discord-ai-save-status" style="font-size:12px;color:var(--text-muted);"></span>'
        + '</div>';

    // ── How to use ──
    html += '<div class="discord-ai-howto">'
        + '<strong>How to connect your Team Discord Bot</strong>'
        + '<ol>'
        + '<li>In Discord, enable <strong>Developer Mode</strong> (Settings &gt; Advanced &gt; Developer Mode).</li>'
        + '<li>Right-click your <strong>server name</strong> &rarr; <em>Copy Server ID</em> and paste it above.</li>'
        + '<li>An <strong>invite link</strong> will appear &mdash; click it to add the bot to your server. Authorize it when prompted.</li>'
        + '<li>Right-click the <strong>channel</strong> you want the bot in &rarr; <em>Copy Channel ID</em> and paste it above.</li>'
        + '<li>Check the <strong>workspaces</strong> the bot should have access to.</li>'
        + '<li>Click <strong>Save &amp; Apply</strong>.</li>'
        + '</ol>'
        + '<strong>Talking to the bot</strong>'
        + '<ul>'
        + '<li>All messages must start with <code>!@</code> to trigger the bot.</li>'
        + '<li><code>!@ What tasks are overdue?</code> &mdash; natural language AI query</li>'
        + '<li><code>!@ Create a high-priority bug for the checkout crash</code></li>'
        + '<li><code>!@ List all folders</code></li>'
        + '<li><code>!@ hub task Fix the login bug</code> &mdash; quick-create a task</li>'
        + '<li><code>!@ hub search deployment</code> &mdash; search across scoped workspaces</li>'
        + '<li><code>!@ hub status</code> &mdash; see your open items</li>'
        + '</ul>'
        + '<strong>What the AI can do</strong>'
        + '<ul>'
        + '<li>Create, search, and update tasks, notes, and ideas</li>'
        + '<li>List and create spaces, folders, and lists</li>'
        + '<li>Add comments to items</li>'
        + '<li>Get workspace summaries and detailed item views</li>'
        + '</ul>'
        + '</div>';

    el.innerHTML = html;
}

function _updateBotInviteLink() {
    const serverId = (document.getElementById('dai-server-id')?.value || '').trim();
    const banner = document.getElementById('dai-invite-banner');
    const link = document.getElementById('dai-invite-link');
    if (!banner || !link) return;
    if (serverId) {
        banner.style.display = 'block';
        link.href = 'https://discord.com/oauth2/authorize?client_id=1470540768547700920&scope=bot&permissions=274877975552&guild_id=' + encodeURIComponent(serverId);
    } else {
        banner.style.display = 'none';
    }
}

async function saveDiscordAISettings() {
    if (!_discordAIWorkspaces) return;
    const btn = document.getElementById('discord-ai-save-btn');
    const statusEl = document.getElementById('discord-ai-save-status');
    if (btn) btn.disabled = true;
    if (statusEl) statusEl.textContent = 'Saving...';

    // Read top-level connection values
    const serverId = (document.getElementById('dai-server-id')?.value || '').trim();
    const channelId = (document.getElementById('dai-channel-id')?.value || '').trim();
    const botPrompt = (document.getElementById('dai-bot-prompt')?.value || '').trim();
    const defaultPrompt = 'You are a Team Hub AI assistant. Use the teamhub tools to manage workspace data. Be concise and helpful.';

    // Read checkbox states
    const checkboxes = document.querySelectorAll('#settings-tab-discord-ai input[type="checkbox"][data-ws-id]');
    const scopedIds = new Set();
    checkboxes.forEach(cb => { if (cb.checked) scopedIds.add(cb.dataset.wsId); });

    let saved = 0;
    let errors = 0;

    for (const ws of _discordAIWorkspaces) {
        if (ws.my_role !== 'owner' && ws.my_role !== 'admin') continue;

        const isScoped = scopedIds.has(ws.id);
        const body = {
            discord_server_id: isScoped ? (serverId || null) : null,
            discord_channel_id: isScoped ? (channelId || null) : null,
            bot_prompt: isScoped ? (botPrompt || defaultPrompt) : null,
        };

        // Skip if nothing changed
        const changed = body.discord_server_id !== (ws.discord_server_id || null)
            || body.discord_channel_id !== (ws.discord_channel_id || null)
            || body.bot_prompt !== (ws.bot_prompt || null);
        if (!changed && !_discordAIDirty) continue;

        try {
            await api('PATCH', API + '/workspaces/' + ws.id + '/discord', body);
            ws.discord_server_id = body.discord_server_id || '';
            ws.discord_channel_id = body.discord_channel_id || '';
            ws.bot_prompt = body.bot_prompt || '';
            saved++;
        } catch {
            errors++;
        }
    }

    // Update local connection state
    _discordAIConnection = { server_id: serverId, channel_id: channelId, bot_prompt: botPrompt };
    _discordAIDirty = false;
    if (btn) btn.disabled = false;

    if (errors > 0) {
        if (statusEl) statusEl.textContent = saved + ' saved, ' + errors + ' failed';
        showToast(errors + ' workspace(s) failed to save');
    } else if (saved > 0) {
        if (statusEl) statusEl.textContent = 'Saved (' + saved + ' workspace' + (saved > 1 ? 's' : '') + ' updated)';
        showToast('Discord AI settings saved');
    } else {
        if (statusEl) statusEl.textContent = 'No changes to save';
    }

    // Re-render after brief delay to update status indicators
    setTimeout(() => {
        _discordAIWorkspaces = null;
        renderSettingsDiscordAI();
    }, 1500);
}

/* ── Commented out: Per-workspace multi-server Discord AI config ──
 * Re-enable this when we want individual Discord server/channel
 * bindings per workspace instead of one shared connection.
 *
 * function toggleDiscordAIWorkspace(wsId, enabled) { ... }
 * async function saveAllDiscordAISettings() { ... }
 * // Each workspace had its own server ID, channel ID, and prompt
 * // fields inside an expandable card with per-row save logic.
 */

// ── Docs Viewer ──────────────────────────────────────────────

let _currentDocId = null;

async function openDoc(docId, spaceId) {
    _currentDocId = docId;
    _currentSpaceId = spaceId;
    _currentListId = null;
    _currentView = 'doc';
    renderSpaceTree();

    const el = document.getElementById('main-content');
    el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:200px;"><div class="spinner"></div></div>';

    try {
        const doc = await api('GET', API + '/docs/' + docId);
        renderDocView(el, doc);
    } catch (e) {
        el.innerHTML = '<div class="empty-state"><div class="empty-state-text">Failed to load document</div></div>';
    }
}

function renderDocView(el, doc) {
    const pages = doc.pages || [];
    const sourceTag = doc.source === 'clickup' ? ' <span class="th-doc-source-tag">ClickUp</span>' : '';
    const updatedAt = doc.updated_at ? new Date(doc.updated_at).toLocaleDateString() : '';

    let html = '<div class="th-doc-viewer">'
        + '<div class="th-doc-header">'
        + '<div class="th-doc-title-row">'
        + '<span class="th-doc-icon">\uD83D\uDCC4</span>'
        + '<h2 class="th-doc-title">' + esc(doc.title) + sourceTag + '</h2>'
        + '</div>'
        + '<div class="th-doc-meta">'
        + (doc.author_name ? '<span>By ' + esc(doc.author_name) + '</span>' : '')
        + (updatedAt ? '<span>Updated ' + esc(updatedAt) + '</span>' : '')
        + '</div>'
        + '</div>';

    // Main doc content
    if (doc.content) {
        html += '<div class="th-doc-content">' + renderDocContent(doc.content) + '</div>';
    }

    // Pages
    if (pages.length > 0) {
        html += '<div class="th-doc-pages">';
        for (const page of pages) {
            html += '<div class="th-doc-page">'
                + '<h3 class="th-doc-page-title">' + esc(page.title || 'Untitled Page') + '</h3>'
                + '<div class="th-doc-page-content">' + renderDocContent(page.content || '') + '</div>'
                + '</div>';
        }
        html += '</div>';
    }

    if (!doc.content && pages.length === 0) {
        html += '<div class="empty-state" style="padding:40px;"><div class="empty-state-text">This document is empty</div></div>';
    }

    html += '</div>';
    el.innerHTML = html;
}

function renderDocContent(text) {
    if (!text) return '';
    // Basic markdown-like rendering: paragraphs, bold, links, code blocks
    return text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/```([\s\S]*?)```/g, '<pre class="th-doc-code">$1</pre>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/^### (.+)$/gm, '<h4>$1</h4>')
        .replace(/^## (.+)$/gm, '<h3>$1</h3>')
        .replace(/^# (.+)$/gm, '<h2>$1</h2>')
        .replace(/^- (.+)$/gm, '<li>$1</li>')
        .replace(/\n\n/g, '</p><p>')
        .replace(/\n/g, '<br>')
        .replace(/^/, '<p>').replace(/$/, '</p>');
}

// ── ClickUp Import Tab ───────────────────────────────────────

let _importRunning = false;
let _importStats = null;
let _importConnected = false;
let _importApiKey = '';
let _importHierarchy = []; // [{team_id, team_name, spaces:[{id, name, folders, lists}]}]
let _importSelectedSpaces = new Set();

async function renderSettingsImport() {
    const el = document.getElementById('settings-tab-import');
    if (!el) return;

    if (_importRunning) return; // Don't re-render while importing

    // If already connected, show the selection view
    if (_importConnected && _importHierarchy.length > 0) {
        renderImportSelection(el);
        return;
    }

    // Step 1: API Key input
    let html = '<div class="settings-info-box">Import your ClickUp workspaces, folders, lists, and tasks into Team Hub. Enter your ClickUp API key to connect and browse your data.</div>';

    // API key input
    html += '<div class="import-connect-section">'
        + '<div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:8px;">ClickUp API Key</div>'
        + '<div style="display:flex;gap:8px;align-items:center;">'
        + '<input type="password" class="form-input" id="import-api-key" placeholder="pk_..." style="flex:1;font-family:monospace;" value="' + esc(_importApiKey) + '">'
        + '<button class="btn btn-accent" id="import-connect-btn" onclick="connectClickUp()">Connect</button>'
        + '</div>'
        + '<div id="import-connect-status" style="font-size:12px;color:var(--text-muted);margin-top:6px;"></div>'
        + '<div style="font-size:11px;color:var(--text-muted);margin-top:8px;">Find your API key in ClickUp &rarr; Settings &rarr; Apps &rarr; API Token. Each user needs their own key.</div>'
        + '</div>';

    el.innerHTML = html;

    // If admin, pre-fill the key
    if (!_importApiKey) {
        try {
            const hint = await api('GET', API + '/clickup/admin-key-hint');
            if (hint.prefill_key) {
                _importApiKey = hint.prefill_key;
                const keyInput = document.getElementById('import-api-key');
                if (keyInput) keyInput.value = hint.prefill_key;
                const statusEl = document.getElementById('import-connect-status');
                if (statusEl) statusEl.innerHTML = '<span style="color:#00b894;">Admin key pre-filled. Click Connect to browse your ClickUp data.</span>';
            }
        } catch { /* not admin or error */ }
    }
}

async function connectClickUp() {
    const keyInput = document.getElementById('import-api-key');
    const connectBtn = document.getElementById('import-connect-btn');
    const statusEl = document.getElementById('import-connect-status');
    const apiKey = keyInput?.value?.trim();

    if (!apiKey) { showToast('Enter your ClickUp API key'); return; }

    _importApiKey = apiKey;
    if (connectBtn) { connectBtn.disabled = true; connectBtn.textContent = 'Connecting...'; }
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--text-muted);">Connecting to ClickUp and loading your data...</span>';

    try {
        const data = await api('POST', API + '/clickup/connect?api_key=' + encodeURIComponent(apiKey));
        _importHierarchy = data.teams || [];
        _importConnected = true;
        _importSelectedSpaces.clear();

        // Auto-select all spaces
        for (const team of _importHierarchy) {
            for (const sp of team.spaces) {
                _importSelectedSpaces.add(sp.id);
            }
        }

        // Render the selection view
        const el = document.getElementById('settings-tab-import');
        if (el) renderImportSelection(el);
    } catch (e) {
        if (statusEl) statusEl.innerHTML = '<span style="color:#e17055;">Failed to connect: ' + esc(e.message || 'Invalid API key') + '</span>';
        if (connectBtn) { connectBtn.disabled = false; connectBtn.textContent = 'Connect'; }
    }
}

function renderImportSelection(el) {
    let totalTasks = 0;
    let totalLists = 0;
    let totalFolders = 0;

    let html = '<div class="import-connected-header">'
        + '<div style="display:flex;align-items:center;gap:8px;">'
        + '<span style="color:#00b894;font-size:18px;">&#10003;</span>'
        + '<span style="font-size:13px;font-weight:600;color:var(--text);">Connected to ClickUp</span>'
        + '</div>'
        + '<button class="btn btn-ghost btn-small" onclick="disconnectClickUp()">Disconnect</button>'
        + '</div>';

    html += '<div class="settings-info-box" style="margin-bottom:12px;">Select the spaces you want to import. Expand spaces to see their folders and lists with task counts.</div>';

    // Hierarchy tree with checkboxes
    html += '<div class="import-tree">';

    for (const team of _importHierarchy) {
        html += '<div class="import-team-header">' + esc(team.team_name) + '</div>';

        for (const space of team.spaces) {
            const checked = _importSelectedSpaces.has(space.id) ? ' checked' : '';
            let spaceTasks = 0;
            let spaceLists = 0;
            let spaceFolders = space.folders.length;

            // Count tasks across all lists
            for (const lst of space.lists) {
                spaceTasks += lst.task_count || 0;
                spaceLists++;
            }
            for (const folder of space.folders) {
                for (const lst of folder.lists) {
                    spaceTasks += lst.task_count || 0;
                    spaceLists++;
                }
            }
            totalTasks += spaceTasks;
            totalLists += spaceLists;
            totalFolders += spaceFolders;

            html += '<div class="import-space-row">'
                + '<label class="import-space-checkbox">'
                + '<input type="checkbox"' + checked + ' onchange="toggleImportSpace(\'' + esc(space.id) + '\', this.checked)">'
                + '<span class="import-space-name">' + esc(space.name) + '</span>'
                + '</label>'
                + '<span class="import-space-meta">' + spaceFolders + ' folders &middot; ' + spaceLists + ' lists &middot; ' + spaceTasks + ' tasks</span>'
                + '<button class="import-expand-btn" onclick="toggleImportExpand(this)" title="Expand">&#9660;</button>'
                + '</div>';

            // Expandable detail (hidden by default)
            html += '<div class="import-space-detail" style="display:none;">';

            // Folderless lists
            if (space.lists.length > 0) {
                for (const lst of space.lists) {
                    html += '<div class="import-list-row">'
                        + '<span class="import-list-icon">&#9776;</span>'
                        + '<span class="import-list-name">' + esc(lst.name) + '</span>'
                        + '<span class="import-list-count">' + (lst.task_count || 0) + ' tasks</span>'
                        + '</div>';
                }
            }

            // Folders with lists
            for (const folder of space.folders) {
                html += '<div class="import-folder-row">'
                    + '<span class="import-folder-icon">&#128193;</span>'
                    + '<span class="import-folder-name">' + esc(folder.name) + '</span>'
                    + '</div>';
                for (const lst of folder.lists) {
                    html += '<div class="import-list-row" style="padding-left:36px;">'
                        + '<span class="import-list-icon">&#9776;</span>'
                        + '<span class="import-list-name">' + esc(lst.name) + '</span>'
                        + '<span class="import-list-count">' + (lst.task_count || 0) + ' tasks</span>'
                        + '</div>';
                }
            }

            html += '</div>';
        }
    }

    html += '</div>';

    // Summary + import button
    html += '<div class="import-summary">'
        + '<div class="import-summary-stats">'
        + '<span><strong>' + _importSelectedSpaces.size + '</strong> spaces</span>'
        + '<span><strong>' + totalFolders + '</strong> folders</span>'
        + '<span><strong>' + totalLists + '</strong> lists</span>'
        + '<span><strong>' + totalTasks + '</strong> tasks</span>'
        + '</div>'
        + '<button class="btn btn-accent" id="import-start-btn" onclick="startClickUpImport()"'
        + (_importSelectedSpaces.size === 0 ? ' disabled' : '') + '>Import Selected</button>'
        + '</div>';

    // Progress area (hidden until import starts)
    html += '<div id="import-progress" style="display:none;">'
        + '<div class="import-progress-header">Import Progress</div>'
        + '<div id="import-current-item" class="import-current-item"></div>'
        + '<div id="import-progress-bars"></div>'
        + '<div id="import-log" class="import-log"></div>'
        + '<div id="import-stats" class="import-stats-grid"></div>'
        + '</div>';

    el.innerHTML = html;
}

function disconnectClickUp() {
    _importConnected = false;
    _importHierarchy = [];
    _importSelectedSpaces.clear();
    _importApiKey = '';
    const el = document.getElementById('settings-tab-import');
    if (el) renderSettingsImport();
}

function toggleImportSpace(spaceId, checked) {
    if (checked) _importSelectedSpaces.add(spaceId);
    else _importSelectedSpaces.delete(spaceId);
    // Update start button state
    const btn = document.getElementById('import-start-btn');
    if (btn) btn.disabled = _importSelectedSpaces.size === 0;
    // Update summary
    const el = document.getElementById('settings-tab-import');
    if (el && !_importRunning) renderImportSelection(el);
}

function toggleImportExpand(btn) {
    const detail = btn.closest('.import-space-row').nextElementSibling;
    if (detail && detail.classList.contains('import-space-detail')) {
        const show = detail.style.display === 'none';
        detail.style.display = show ? '' : 'none';
        btn.innerHTML = show ? '&#9650;' : '&#9660;';
    }
}

async function startClickUpImport() {
    if (_importRunning || !_importApiKey) return;
    _importRunning = true;

    const btn = document.getElementById('import-start-btn');
    const progressArea = document.getElementById('import-progress');
    const logEl = document.getElementById('import-log');
    const statsEl = document.getElementById('import-stats');
    const barsEl = document.getElementById('import-progress-bars');
    const currentEl = document.getElementById('import-current-item');

    if (btn) { btn.disabled = true; btn.textContent = 'Importing...'; }
    if (progressArea) progressArea.style.display = '';
    if (logEl) logEl.innerHTML = '';
    _importStats = null;

    // Count totals for progress bars
    let totalSpaces = _importSelectedSpaces.size;
    let totalExpectedTasks = 0;
    for (const team of _importHierarchy) {
        for (const sp of team.spaces) {
            if (!_importSelectedSpaces.has(sp.id)) continue;
            for (const lst of sp.lists) totalExpectedTasks += lst.task_count || 0;
            for (const folder of sp.folders) {
                for (const lst of folder.lists) totalExpectedTasks += lst.task_count || 0;
            }
        }
    }

    // Render initial progress bars
    if (barsEl) renderProgressBars(barsEl, {spaces: 0, tasks: 0}, totalSpaces, totalExpectedTasks);

    // Build URL with space IDs
    const spaceIds = Array.from(_importSelectedSpaces).join(',');
    let url = API + '/clickup/import?api_key=' + encodeURIComponent(_importApiKey) + '&space_ids=' + encodeURIComponent(spaceIds);

    try {
        const token = await opaiAuth.getToken();
        const resp = await fetch(url, {
            headers: token ? { 'Authorization': 'Bearer ' + token } : {},
        });

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const data = JSON.parse(line.substring(6));
                    handleImportEvent(data, logEl, statsEl, barsEl, currentEl, totalSpaces, totalExpectedTasks);
                } catch { /* skip malformed */ }
            }
        }
    } catch (e) {
        if (logEl) logEl.innerHTML += '<div class="import-log-entry error">Import failed: ' + esc(e.message) + '</div>';
    }

    _importRunning = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Import Selected'; }
}

function handleImportEvent(data, logEl, statsEl, barsEl, currentEl, totalSpaces, totalExpectedTasks) {
    // Update current item indicator
    if (currentEl && data.message) {
        const icon = data.phase === 'space' ? '&#127760;' : data.phase === 'folder' ? '&#128193;' : data.phase === 'list' ? '&#9776;' : data.phase === 'docs' ? '&#128196;' : data.phase === 'done' ? '&#10003;' : '&#8987;';
        currentEl.innerHTML = '<span class="import-current-icon">' + icon + '</span> ' + esc(data.message);
        if (data.phase === 'done') currentEl.classList.add('success');
    }

    // Update log
    if (data.message && logEl) {
        const cls = data.phase === 'error' ? 'import-log-entry error' : (data.phase === 'done' ? 'import-log-entry success' : 'import-log-entry');
        logEl.innerHTML += '<div class="' + cls + '">' + esc(data.message) + '</div>';
        logEl.scrollTop = logEl.scrollHeight;
    }

    // Update stats + progress bars
    if (data.stats) {
        _importStats = data.stats;
        if (statsEl) renderImportStats(statsEl);
        if (barsEl) renderProgressBars(barsEl, data.stats, totalSpaces, totalExpectedTasks);
    }

    // Done
    if (data.phase === 'done') {
        if (data.stats) {
            _importStats = data.stats;
            if (statsEl) renderImportStats(statsEl);
            if (barsEl) renderProgressBars(barsEl, data.stats, totalSpaces, totalExpectedTasks);
        }
        loadSpaces();
    }
}

function renderProgressBars(el, stats, totalSpaces, totalTasks) {
    const spacesPct = totalSpaces > 0 ? Math.min(100, Math.round(((stats.spaces || 0) / totalSpaces) * 100)) : 0;
    const tasksPct = totalTasks > 0 ? Math.min(100, Math.round(((stats.tasks || 0) / totalTasks) * 100)) : 0;

    el.innerHTML = '<div class="import-bar-group">'
        + '<div class="import-bar-label"><span>Spaces</span><span>' + (stats.spaces || 0) + ' / ' + totalSpaces + '</span></div>'
        + '<div class="import-bar-track"><div class="import-bar-fill" style="width:' + spacesPct + '%;background:#6c5ce7;"></div></div>'
        + '</div>'
        + '<div class="import-bar-group">'
        + '<div class="import-bar-label"><span>Tasks</span><span>' + (stats.tasks || 0) + ' / ' + totalTasks + '</span></div>'
        + '<div class="import-bar-track"><div class="import-bar-fill" style="width:' + tasksPct + '%;background:#fdcb6e;"></div></div>'
        + '</div>';
}

function renderImportStats(el) {
    if (!_importStats) return;
    const s = _importStats;
    el.innerHTML = '<div class="import-stat-card">'
        + '<div class="import-stat-num">' + (s.spaces || 0) + '</div><div class="import-stat-label">Spaces</div></div>'
        + '<div class="import-stat-card">'
        + '<div class="import-stat-num">' + (s.folders || 0) + '</div><div class="import-stat-label">Folders</div></div>'
        + '<div class="import-stat-card">'
        + '<div class="import-stat-num">' + (s.lists || 0) + '</div><div class="import-stat-label">Lists</div></div>'
        + '<div class="import-stat-card">'
        + '<div class="import-stat-num">' + (s.tasks || 0) + '</div><div class="import-stat-label">Tasks</div></div>'
        + '<div class="import-stat-card">'
        + '<div class="import-stat-num">' + (s.docs || 0) + '</div><div class="import-stat-label">Docs</div></div>'
        + '<div class="import-stat-card">'
        + '<div class="import-stat-num">' + (s.comments || 0) + '</div><div class="import-stat-label">Comments</div></div>'
        + '<div class="import-stat-card">'
        + '<div class="import-stat-num">' + (s.tags || 0) + '</div><div class="import-stat-label">Tags</div></div>';
}

// ── Remove Member ────────────────────────────────────────────

async function renderCurrentMembers() {
    const container = document.getElementById('invite-current-members');
    if (!container) return;

    if (_inviteSelectedSpaces.size === 0) {
        container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px;text-align:center;">Select a space to see current members</div>';
        return;
    }

    container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px;text-align:center;">Loading members...</div>';

    // Gather members from all selected spaces
    const memberMap = {}; // userId -> {profile, spaces:[spaceId]}
    for (const spaceId of _inviteSelectedSpaces) {
        try {
            const data = await api('GET', API + '/workspaces/' + spaceId + '/members');
            for (const m of (data.members || [])) {
                const uid = m.user_id;
                if (uid === _user?.id) continue; // Don't show self
                if (!memberMap[uid]) {
                    memberMap[uid] = { user_id: uid, role: m.role, display_name: m.display_name || '', email: m.email || '', spaces: [] };
                }
                memberMap[uid].spaces.push(spaceId);
            }
        } catch { /* skip */ }
    }

    const members = Object.values(memberMap);
    if (members.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px;text-align:center;">No other members in selected spaces</div>';
        return;
    }

    container.innerHTML = members.map(m => {
        const name = m.display_name || m.email || '?';
        const initials = name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
        const spaceCount = m.spaces.length;
        return '<div class="invite-user-row">'
            + '<div class="th-member-avatar" style="width:32px;height:32px;font-size:11px;">' + esc(initials) + '</div>'
            + '<div class="th-member-info" style="flex:1;">'
            + '<div class="th-member-name">' + esc(name) + '</div>'
            + '<div class="th-member-email">' + esc(m.email) + ' &middot; ' + spaceCount + ' space' + (spaceCount > 1 ? 's' : '') + '</div>'
            + '</div>'
            + '<button class="btn btn-ghost btn-small" style="color:#e17055;border-color:#e17055;" onclick="event.stopPropagation();removeMemberFromSpaces(\'' + esc(m.user_id) + '\', this)">Remove</button>'
            + '</div>';
    }).join('');
}

async function removeMemberFromSpaces(userId, btnEl) {
    if (!confirm('Remove this member from the selected spaces?')) return;
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = 'Removing...'; }

    let removedCount = 0;
    for (const spaceId of _inviteSelectedSpaces) {
        try {
            await api('DELETE', API + '/workspaces/' + spaceId + '/members/' + userId);
            removedCount++;
            // Update local cache
            if (_inviteSpaceMembers[spaceId]) {
                _inviteSpaceMembers[spaceId] = _inviteSpaceMembers[spaceId].filter(id => id !== userId);
            }
        } catch { /* skip spaces where they're not a member */ }
    }

    if (removedCount > 0) {
        showToast('Removed from ' + removedCount + ' space' + (removedCount > 1 ? 's' : ''));
    } else {
        showToast('Failed to remove member');
    }

    // Re-render both sections
    const searchInput = document.getElementById('member-search');
    renderMemberSearchResults(searchInput?.value?.trim() || '');
    renderCurrentMembers();
}

// ── Pill Dropdown (colored status/priority picker) ───────────

function togglePillDD(type) {
    const container = document.getElementById('pill-dd-' + type);
    if (!container) return;
    const existing = container.querySelector('.th-pill-dd-menu');
    if (existing) { existing.remove(); return; }

    // Close any other open pill dropdowns
    document.querySelectorAll('.th-pill-dd-menu').forEach(m => m.remove());

    let items = [];
    if (type === 'status') {
        items = _currentStatuses.map(s => ({ value: s.name, label: s.name, color: s.color }));
        if (_detailTask && !items.find(i => i.value === _detailTask.status)) {
            items.push({ value: _detailTask.status, label: _detailTask.status, color: '#595d66' });
        }
    } else {
        items = PRIORITIES.map(p => ({ value: p.value, label: p.label, color: p.color }));
    }

    const current = type === 'status' ? (_detailTask && _detailTask.status) : (_detailTask && _detailTask.priority);

    let menuHtml = '<div class="th-pill-dd-menu">';
    for (const item of items) {
        const sel = item.value === current ? ' selected' : '';
        menuHtml += '<div class="th-pill-dd-item' + sel + '" onclick="selectPillDD(\'' + esc(type) + '\',\'' + esc(item.value) + '\')">'
            + '<span class="th-pill-dd-dot" style="background:' + esc(item.color) + ';"></span>'
            + '<span>' + esc(item.label) + '</span>'
            + '</div>';
    }
    menuHtml += '</div>';
    container.insertAdjacentHTML('beforeend', menuHtml);

    // Close on outside click
    setTimeout(() => {
        document.addEventListener('click', function closer(e) {
            if (!container.contains(e.target)) {
                const menu = container.querySelector('.th-pill-dd-menu');
                if (menu) menu.remove();
                document.removeEventListener('click', closer);
            }
        });
    }, 10);
}

function selectPillDD(type, value) {
    document.querySelectorAll('.th-pill-dd-menu').forEach(m => m.remove());
    updateField(type === 'status' ? 'status' : 'priority', value);
    renderDetailPanel();
}

// ── Calendar View ────────────────────────────────────────────

async function renderCalendarView(el) {
    if (!_calendarMonth) _calendarMonth = new Date();
    _calendarMonth.setDate(1);

    if (!_currentSpaceId) {
        // All-spaces overview calendar
        el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:200px;"><div class="spinner"></div></div>';
        await loadCalendarDataAllSpaces();
        renderCalendar(el);
        return;
    }

    // Decide data source: list-level (use _tasks) or space-level (fetch)
    if (_currentListId && _tasks.length >= 0) {
        // Use already-loaded _tasks filtered by due_date
        _calendarItems = _tasks.filter(t => t.due_date);
        _calendarStatuses = _currentStatuses;
        _calendarSpaces = null;
        renderCalendar(el);
    } else {
        // Space-level: fetch from calendar endpoint
        el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:200px;"><div class="spinner"></div></div>';
        await loadCalendarData();
        renderCalendar(el);
    }
}

async function loadCalendarData() {
    if (!_currentSpaceId) return;
    _calendarSpaces = null;
    const monthStr = _calendarMonth.getFullYear() + '-' + String(_calendarMonth.getMonth() + 1).padStart(2, '0');
    try {
        const data = await api('GET', API + '/workspaces/' + _currentSpaceId + '/calendar?month=' + monthStr);
        _calendarItems = data.items || [];
        _calendarStatuses = data.statuses || [];
    } catch {
        _calendarItems = [];
        _calendarStatuses = _currentStatuses;
        showToast('Failed to load calendar data');
    }
}

async function loadCalendarDataAllSpaces() {
    const monthStr = _calendarMonth.getFullYear() + '-' + String(_calendarMonth.getMonth() + 1).padStart(2, '0');
    try {
        const data = await api('GET', API + '/calendar/all?month=' + monthStr);
        _calendarItems = data.items || [];
        _calendarStatuses = data.statuses || [];
        _calendarSpaces = {};
        for (const sp of (data.spaces || [])) _calendarSpaces[sp.id] = sp;
    } catch {
        _calendarItems = [];
        _calendarStatuses = [];
        _calendarSpaces = {};
        showToast('Failed to load calendar data');
    }
}

function renderCalendar(el) {
    const year = _calendarMonth.getFullYear();
    const month = _calendarMonth.getMonth();
    const monthName = _calendarMonth.toLocaleString('en', { month: 'long', year: 'numeric' });

    // Status color map
    const stColorMap = {};
    for (const s of _calendarStatuses) stColorMap[s.name] = s.color;

    // Build day grid
    const firstDay = new Date(year, month, 1);
    const startDow = firstDay.getDay(); // 0=Sun
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const prevMonthDays = new Date(year, month, 0).getDate();

    // Build 6-week grid
    const cells = [];
    // Days from previous month
    for (let i = startDow - 1; i >= 0; i--) {
        cells.push({ day: prevMonthDays - i, otherMonth: true, date: new Date(year, month - 1, prevMonthDays - i) });
    }
    // Days in current month
    for (let d = 1; d <= daysInMonth; d++) {
        cells.push({ day: d, otherMonth: false, date: new Date(year, month, d) });
    }
    // Days from next month to fill 6 rows (or at least complete the row)
    const totalCells = Math.ceil(cells.length / 7) * 7;
    let nextDay = 1;
    while (cells.length < totalCells) {
        cells.push({ day: nextDay++, otherMonth: true, date: new Date(year, month + 1, nextDay - 1) });
    }

    // Group tasks by date string
    const tasksByDate = {};
    for (const item of _calendarItems) {
        if (!item.due_date) continue;
        const dStr = item.due_date.substring(0, 10); // YYYY-MM-DD
        if (!tasksByDate[dStr]) tasksByDate[dStr] = [];
        tasksByDate[dStr].push(item);
    }

    const today = new Date();
    const todayStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');

    const isAllSpaces = !_currentSpaceId && _calendarSpaces;
    const contextLabel = isAllSpaces ? 'All Spaces' : (_currentListId ? _currentListName : (_currentSpaceName || 'Space'));
    const itemCount = _calendarItems.length;

    let html = '<div class="th-calendar">'
        + '<div class="th-cal-toolbar">'
        + '<span class="th-cal-toolbar-title">' + esc(contextLabel) + '</span>'
        + '<span class="th-cal-toolbar-count">' + itemCount + ' items with due dates</span>'
        + '</div>'
        + '<div class="th-cal-header">'
        + '<div class="th-cal-nav">'
        + '<button class="th-cal-nav-btn" onclick="calNavPrev()">&lsaquo;</button>'
        + '<button class="th-cal-nav-btn" onclick="calNavToday()" style="font-size:11px;width:auto;padding:0 10px;">Today</button>'
        + '<button class="th-cal-nav-btn" onclick="calNavNext()">&rsaquo;</button>'
        + '</div>'
        + '<div class="th-cal-header-center">' + esc(monthName) + '</div>'
        + '<div></div>'
        + '</div>';

    html += '<div class="th-cal-grid">';
    // Day headers
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (const dn of dayNames) {
        html += '<div class="th-cal-day-header">' + dn + '</div>';
    }

    // Day cells
    for (const cell of cells) {
        const dateStr = cell.date.getFullYear() + '-' + String(cell.date.getMonth() + 1).padStart(2, '0') + '-' + String(cell.date.getDate()).padStart(2, '0');
        let cls = 'th-cal-day';
        if (cell.otherMonth) cls += ' other-month';
        if (dateStr === todayStr) cls += ' today';

        html += '<div class="' + cls + '">'
            + '<div class="th-cal-day-num">' + cell.day + '</div>'
            + '<div class="th-cal-tasks">';

        const dayTasks = tasksByDate[dateStr] || [];
        const maxShow = 3;
        for (let i = 0; i < Math.min(dayTasks.length, maxShow); i++) {
            const t = dayTasks[i];
            const tColor = stColorMap[t.status] || '#595d66';
            let taskLabel = esc(t.title || '');
            if (isAllSpaces && t.workspace_id && _calendarSpaces[t.workspace_id]) {
                const sp = _calendarSpaces[t.workspace_id];
                taskLabel = '<span class="th-cal-space-dot" style="background:' + esc(sp.color || '#595d66') + ';" title="' + esc(sp.name) + '"></span>' + taskLabel;
            }
            html += '<div class="th-cal-task" style="border-left-color:' + esc(tColor) + ';" onclick="event.stopPropagation();openDetail(\'' + esc(t.id) + '\')">'
                + taskLabel + '</div>';
        }
        if (dayTasks.length > maxShow) {
            html += '<div class="th-cal-more" onclick="event.stopPropagation();showCalDayPopup(event,\'' + esc(dateStr) + '\')">+' + (dayTasks.length - maxShow) + ' more</div>';
        }

        html += '</div></div>';
    }

    html += '</div></div>';
    el.innerHTML = html;

    // Set grid rows exactly: 1 header row + however many week rows the month needs
    const weekRows = cells.length / 7;
    const grid = el.querySelector('.th-cal-grid');
    if (grid) grid.style.gridTemplateRows = 'auto repeat(' + weekRows + ', 1fr)';
}

function calNavPrev() {
    if (!_calendarMonth) _calendarMonth = new Date();
    _calendarMonth.setMonth(_calendarMonth.getMonth() - 1);
    const el = document.getElementById('main-content');
    renderCalendarView(el);
}

function calNavNext() {
    if (!_calendarMonth) _calendarMonth = new Date();
    _calendarMonth.setMonth(_calendarMonth.getMonth() + 1);
    const el = document.getElementById('main-content');
    renderCalendarView(el);
}

function calNavToday() {
    _calendarMonth = new Date();
    _calendarMonth.setDate(1);
    const el = document.getElementById('main-content');
    renderCalendarView(el);
}

function showCalDayPopup(event, dateStr) {
    // Toggle off if already open for the same day
    const existing = document.getElementById('cal-day-popup');
    if (existing) {
        const same = existing.dataset.date === dateStr;
        existing.remove();
        if (same) return;
    }

    const dayTasks = _calendarItems.filter(t => (t.due_date || '').slice(0, 10) === dateStr);
    if (!dayTasks.length) return;

    const stColorMap = {};
    for (const s of _calendarStatuses) { stColorMap[s.name] = s.color; }

    const dateLabel = new Date(dateStr + 'T12:00:00').toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric' });

    let html = '<div class="th-cal-popup-header">'
        + '<span>' + esc(dateLabel) + '</span>'
        + '<span class="th-cal-popup-count">' + dayTasks.length + ' task' + (dayTasks.length !== 1 ? 's' : '') + '</span>'
        + '</div>'
        + '<div class="th-cal-popup-list">';

    for (const t of dayTasks) {
        const tColor = stColorMap[t.status] || '#595d66';
        let titleHtml = esc(t.title || '');
        if (_calendarSpaces && t.workspace_id && _calendarSpaces[t.workspace_id]) {
            const sp = _calendarSpaces[t.workspace_id];
            titleHtml = '<span class="th-cal-space-dot" style="background:' + esc(sp.color || '#595d66') + ';" title="' + esc(sp.name) + '"></span>' + titleHtml;
        }
        html += '<div class="th-cal-popup-item" style="border-left-color:' + esc(tColor) + ';" onclick="openDetail(\'' + esc(t.id) + '\');closeCalDayPopup();">'
            + titleHtml + '</div>';
    }
    html += '</div>';

    const popup = document.createElement('div');
    popup.id = 'cal-day-popup';
    popup.className = 'th-cal-popup';
    popup.dataset.date = dateStr;
    popup.innerHTML = html;
    document.body.appendChild(popup);

    // Position below the clicked element, keeping within viewport
    const rect = event.target.getBoundingClientRect();
    const popupW = 260;
    let left = rect.left;
    let top = rect.bottom + 6;
    if (left + popupW > window.innerWidth - 10) left = window.innerWidth - popupW - 10;
    const estHeight = Math.min(dayTasks.length * 34 + 44, 320);
    if (top + estHeight > window.innerHeight - 10) top = rect.top - estHeight - 6;
    popup.style.left = left + 'px';
    popup.style.top = top + 'px';

    // Dismiss on next outside click
    setTimeout(() => document.addEventListener('click', closeCalDayPopup, { once: true }), 0);
}

function closeCalDayPopup() {
    document.getElementById('cal-day-popup')?.remove();
}

// ── File Upload ──────────────────────────────────────────────

function openFileUpload(itemId) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = async () => {
        const wsId = _currentSpaceId || (_detailTask && _detailTask.workspace_id);
        if (!_supabase || !wsId) { showToast('No space selected'); return; }
        for (const file of input.files) {
            const filePath = wsId + '/' + Date.now() + '_' + file.name;
            try {
                const { data, error } = await _supabase.storage
                    .from('team-files')
                    .upload(filePath, file);
                if (error) throw error;

                // Register in team_files table
                await api('POST', API + '/workspaces/' + wsId + '/files', {
                    file_name: file.name,
                    file_path: filePath,
                    file_size: file.size,
                    mime_type: file.type || 'application/octet-stream',
                    item_id: itemId || null,
                    list_id: _currentListId || null,
                });
                showToast('Uploaded: ' + file.name);
            } catch (err) {
                showToast('Upload failed: ' + file.name);
            }
        }
        // Refresh views
        if (itemId && _detailTask) loadDetailFiles();
        if (_currentView === 'dashboard') loadDashboardFiles();
    };
    input.click();
}

async function deleteFile(fileId) {
    if (!confirm('Delete this file?')) return;
    try {
        await api('DELETE', API + '/files/' + fileId);
        showToast('File deleted');
    } catch (e) {
        console.warn('deleteFile error (refreshing anyway):', e);
        showToast('File deleted');
    }
    // Always refresh file lists — the backend deletes the record even if storage cleanup fails
    if (_detailTask) loadDetailFiles();
    if (_currentView === 'dashboard') loadDashboardFiles();
}

// ── File Preview ─────────────────────────────────────────────

async function previewFile(filePath, fileName, mimeType) {
    // Get a signed URL (1 hour expiry)
    const { data, error } = await _supabase.storage
        .from('team-files')
        .createSignedUrl(filePath, 3600);
    if (error || !data?.signedUrl) {
        showToast('Failed to get file URL');
        return;
    }
    const url = data.signedUrl;
    const mime = (mimeType || '').toLowerCase();

    // Build preview content based on mime type
    let bodyHtml = '';
    if (mime.startsWith('image/')) {
        bodyHtml = '<img src="' + esc(url) + '" alt="' + esc(fileName) + '">';
    } else if (mime === 'application/pdf') {
        bodyHtml = '<iframe src="' + esc(url) + '"></iframe>';
    } else if (mime.startsWith('video/')) {
        bodyHtml = '<video controls autoplay><source src="' + esc(url) + '" type="' + esc(mime) + '">Your browser does not support video.</video>';
    } else if (mime.startsWith('audio/')) {
        bodyHtml = '<audio controls autoplay><source src="' + esc(url) + '" type="' + esc(mime) + '">Your browser does not support audio.</audio>';
    } else if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') {
        bodyHtml = '<iframe src="' + esc(url) + '" style="background:#fff;"></iframe>';
    } else {
        bodyHtml = '<div class="th-file-preview-nopreview">'
            + '<div class="file-icon-large">' + fileIcon(mime) + '</div>'
            + '<div style="font-size:16px;font-weight:600;color:var(--text);margin-bottom:4px;">' + esc(fileName) + '</div>'
            + '<div>No preview available for this file type.</div>'
            + '<div style="margin-top:12px;"><a href="' + esc(url) + '" download="' + esc(fileName) + '" class="btn btn-accent btn-small" onclick="event.stopPropagation()">Download</a></div>'
            + '</div>';
    }

    // Create modal
    const backdrop = document.createElement('div');
    backdrop.className = 'th-file-preview-backdrop';
    backdrop.onclick = (e) => { if (e.target === backdrop) backdrop.remove(); };

    backdrop.innerHTML = '<div class="th-file-preview-modal" onclick="event.stopPropagation()">'
        + '<div class="th-file-preview-header">'
        + '<span class="th-file-preview-title">' + esc(fileName) + '</span>'
        + '<div class="th-file-preview-actions">'
        + '<a href="' + esc(url) + '" download="' + esc(fileName) + '" class="btn btn-small btn-ghost" title="Download">&#11015; Download</a>'
        + '<a href="' + esc(url) + '" target="_blank" class="btn btn-small btn-ghost" title="Open in new tab">&#8599; Open</a>'
        + '<button class="btn btn-small btn-ghost" onclick="this.closest(\'.th-file-preview-backdrop\').remove()" title="Close">&times;</button>'
        + '</div></div>'
        + '<div class="th-file-preview-body">' + bodyHtml + '</div>'
        + '</div>';

    document.body.appendChild(backdrop);

    // Close on Escape
    const escHandler = (e) => {
        if (e.key === 'Escape') { backdrop.remove(); document.removeEventListener('keydown', escHandler); }
    };
    document.addEventListener('keydown', escHandler);
}

// ── Search ───────────────────────────────────────────────────

async function doSearch(q) {
    const resultsEl = document.getElementById('search-results');
    try {
        const data = await api('GET', API + '/search?q=' + encodeURIComponent(q));
        const items = data.items || [];
        if (items.length === 0) {
            resultsEl.innerHTML = '<div class="th-search-empty">No results for "' + esc(q) + '"</div>';
        } else {
            resultsEl.innerHTML = items.map(item =>
                '<div class="th-search-item" onclick="openDetail(\'' + esc(item.id) + '\')">'
                + '<div><div class="th-search-item-title">' + esc(item.title || '') + '</div>'
                + '<div class="th-search-item-meta">' + esc(item.status || '') + ' &middot; ' + esc(item.type || '') + '</div></div></div>'
            ).join('');
        }
        resultsEl.style.display = 'block';
    } catch {
        resultsEl.innerHTML = '<div class="th-search-empty">Search failed</div>';
        resultsEl.style.display = 'block';
    }
}

// ── Notifications ────────────────────────────────────────────

function startNotifPolling() {
    pollNotifications();
    _notifInterval = setInterval(pollNotifications, 30000);
}

async function pollNotifications() {
    try {
        const data = await api('GET', API + '/my/notifications?unread_only=true&limit=50');
        const notifs = data.notifications || [];
        const badge = document.getElementById('notif-badge');
        if (notifs.length > 0) {
            badge.textContent = notifs.length > 99 ? '99+' : notifs.length;
            badge.style.display = '';
        } else {
            badge.style.display = 'none';
        }
    } catch { /* silent */ }
}

function toggleNotifDropdown() {
    const dd = document.getElementById('notification-dropdown');
    if (dd.style.display === 'none') {
        dd.style.display = '';
        loadNotifDropdown();
    } else {
        dd.style.display = 'none';
    }
}

async function loadNotifDropdown() {
    const list = document.getElementById('notif-list');
    list.innerHTML = '<div class="th-notif-empty">Loading...</div>';
    try {
        const data = await api('GET', API + '/my/notifications?unread_only=false&limit=30');
        const notifs = data.notifications || [];
        if (notifs.length === 0) {
            list.innerHTML = '<div class="th-notif-empty">No notifications</div>';
            return;
        }
        list.innerHTML = notifs.map(n => {
            const unread = !n.read ? ' unread' : '';
            return '<div class="th-notif-item' + unread + '">'
                + '<div class="th-notif-item-text">' + esc(n.title || 'Notification') + '</div>'
                + '<div class="th-notif-item-time">' + timeAgo(n.created_at) + '</div>'
                + '</div>';
        }).join('');
    } catch {
        list.innerHTML = '<div class="th-notif-empty">Failed to load</div>';
    }
}

async function markAllRead() {
    try {
        await api('POST', API + '/my/notifications/read', {});
        document.getElementById('notif-badge').style.display = 'none';
        loadNotifDropdown();
        showToast('All marked as read');
    } catch { showToast('Failed'); }
}

// ── Utilities ────────────────────────────────────────────────

function closeAllModals() {
    document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('visible'));
}

function esc(str) {
    if (str == null) return '';
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
}

function showToast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3000);
}

function timeAgo(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    const diff = Math.floor((new Date() - d) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
    return d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

function fileIcon(mime) {
    if (!mime) return '\uD83D\uDCC4';
    if (mime.startsWith('image/')) return '\uD83D\uDDBC\uFE0F';
    if (mime.startsWith('video/')) return '\uD83C\uDFAC';
    if (mime.includes('pdf')) return '\uD83D\uDCC4';
    if (mime.includes('zip') || mime.includes('rar')) return '\uD83D\uDCE6';
    if (mime.includes('spreadsheet') || mime.includes('excel')) return '\uD83D\uDCCA';
    if (mime.includes('document') || mime.includes('word')) return '\uD83D\uDCC3';
    return '\uD83D\uDCC4';
}

function formatSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
    return size.toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

// ── Context Menu (right-click on spaces/folders/lists/tasks) ──

// Block browser right-click inside the app — only our menu shows
document.addEventListener('contextmenu', function(e) {
    const app = document.querySelector('.app');
    if (app && app.contains(e.target)) e.preventDefault();
});

function showCtxMenu(e, type, id, name, spaceId) {
    e.preventDefault();
    e.stopPropagation();
    hideCtxMenu();

    const menu = document.createElement('div');
    menu.className = 'th-ctx-menu';
    menu.id = 'ctx-menu';

    const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
    const items = [];

    // Open / View (tasks open detail panel)
    if (type === 'task') {
        items.push({ icon: '\uD83D\uDC41\uFE0F', label: 'Open Task', action: () => openDetail(id) });
    }

    // Rename (all types)
    items.push({ icon: '\u270F\uFE0F', label: 'Rename ' + typeLabel, action: () => renameCtxItem(type, id, name, spaceId) });

    // Move (tasks + lists)
    if (type === 'task') {
        items.push({ icon: '\u2197\uFE0F', label: 'Move Task', action: () => { _detailTask = _tasks.find(t => t.id === id) || { id }; openMoveItemModal(); } });
    } else if (type === 'list') {
        items.push({ icon: '\u2197\uFE0F', label: 'Move to Folder', action: () => moveListToFolder(id, name, spaceId) });
    }

    // Duplicate (tasks only)
    if (type === 'task') {
        items.push({ icon: '\uD83D\uDCCB', label: 'Duplicate Task', action: () => duplicateCtxTask(id) });
    }

    // Separator before danger zone
    items.push({ separator: true });

    // Delete (all types)
    items.push({ icon: '\uD83D\uDDD1\uFE0F', label: 'Delete ' + typeLabel, danger: true, action: () => deleteCtxItem(type, id, name, spaceId) });

    for (const item of items) {
        if (item.separator) {
            const sep = document.createElement('div');
            sep.className = 'th-ctx-sep';
            menu.appendChild(sep);
            continue;
        }
        const btn = document.createElement('button');
        btn.className = 'th-ctx-item' + (item.danger ? ' th-ctx-danger' : '');
        btn.innerHTML = '<span class="th-ctx-icon">' + item.icon + '</span><span>' + item.label + '</span>';
        btn.onclick = () => { hideCtxMenu(); item.action(); };
        menu.appendChild(btn);
    }

    document.body.appendChild(menu);

    // Position near click, keep on screen
    const rect = menu.getBoundingClientRect();
    let x = e.clientX, y = e.clientY;
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    // Close on click-away or Escape
    const closeHandler = (ev) => {
        if (!menu.contains(ev.target)) hideCtxMenu();
    };
    const escHandler = (ev) => {
        if (ev.key === 'Escape') { hideCtxMenu(); document.removeEventListener('keydown', escHandler); }
    };
    setTimeout(() => {
        document.addEventListener('click', closeHandler, { once: true });
        document.addEventListener('keydown', escHandler);
    }, 0);
}

function hideCtxMenu() {
    const m = document.getElementById('ctx-menu');
    if (m) m.remove();
}

async function renameCtxItem(type, id, name, spaceId) {
    const newName = prompt('Rename ' + type + ':', name);
    if (!newName || newName === name) return;

    try {
        if (type === 'space') {
            await api('PATCH', API + '/workspaces/' + id, { name: newName });
            const sp = _spaces.find(s => s.id === id);
            if (sp) sp.name = newName;
        } else if (type === 'folder') {
            await api('PATCH', API + '/folders/' + id, { name: newName });
            if (spaceId) delete _hierarchyCache[spaceId];
        } else if (type === 'list') {
            await api('PATCH', API + '/lists/' + id, { name: newName });
            if (spaceId) delete _hierarchyCache[spaceId];
            if (_currentListId === id) _currentListName = newName;
        } else if (type === 'task') {
            await api('PATCH', API + '/items/' + id, { title: newName });
            const t = _tasks.find(t => t.id === id);
            if (t) t.title = newName;
            if (_detailTask && _detailTask.id === id) _detailTask.title = newName;
            broadcast('task_updated', { taskId: id, changes: { title: newName }, listId: _currentListId });
        }
        if (type !== 'task' && spaceId && _expandedSpaces[spaceId]) {
            const data = await api('GET', API + '/workspaces/' + spaceId + '/folders');
            _hierarchyCache[spaceId] = data;
        }
        if (type === 'task') renderMainContent();
        else renderSpaceTree();
        showToast(type.charAt(0).toUpperCase() + type.slice(1) + ' renamed');
    } catch (err) {
        showToast('Failed to rename: ' + (err.message || err));
    }
}

async function deleteCtxItem(type, id, name, spaceId) {
    const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
    let warning = 'Delete ' + typeLabel + ' "' + name + '"?';
    if (type === 'space') warning += '\n\nThis will permanently delete the space and all its contents.';
    else if (type === 'folder') warning += '\n\nItems in this folder will become uncategorized.';
    else if (type === 'list') warning += '\n\nItems in this list will become uncategorized.';
    else if (type === 'task') warning += '\n\nThis cannot be undone.';

    if (!confirm(warning)) return;

    try {
        if (type === 'space') {
            await api('DELETE', API + '/workspaces/' + id);
            _spaces = _spaces.filter(s => s.id !== id);
            delete _hierarchyCache[id];
            delete _expandedSpaces[id];
            if (_currentSpaceId === id) {
                goHome();
            }
        } else if (type === 'folder') {
            await api('DELETE', API + '/folders/' + id);
            delete _expandedFolders[id];
            if (spaceId) {
                delete _hierarchyCache[spaceId];
                const data = await api('GET', API + '/workspaces/' + spaceId + '/folders');
                _hierarchyCache[spaceId] = data;
            }
        } else if (type === 'list') {
            await api('DELETE', API + '/lists/' + id);
            if (_currentListId === id) {
                _currentListId = null;
                _currentView = 'dashboard';
                renderMainContent();
            }
            if (spaceId) {
                delete _hierarchyCache[spaceId];
                const data = await api('GET', API + '/workspaces/' + spaceId + '/folders');
                _hierarchyCache[spaceId] = data;
            }
        } else if (type === 'task') {
            await api('DELETE', API + '/items/' + id);
            _tasks = _tasks.filter(t => t.id !== id);
            if (_detailTask && _detailTask.id === id) {
                document.getElementById('detail-panel').classList.remove('open');
                document.getElementById('detail-backdrop').style.display = 'none';
                _detailTask = null;
            }
            renderMainContent();
        }
        if (type !== 'task') {
            renderSpaceTree();
            broadcast('structure_changed', { type, id, spaceId, action: 'deleted' });
        }
        showToast(typeLabel + ' deleted');
    } catch (err) {
        showToast('Failed to delete: ' + (err.message || err));
    }
}

async function duplicateCtxTask(taskId) {
    const task = _tasks.find(t => t.id === taskId);
    if (!task) { showToast('Task not found'); return; }
    try {
        const listId = task.list_id || _currentListId;
        if (!listId) { showToast('No list context for duplicate'); return; }
        await api('POST', API + '/lists/' + listId + '/items', {
            title: (task.title || task.name || '') + ' (copy)',
            type: task.type || 'task',
            description: task.description || '',
            status: task.status || 'open',
            priority: task.priority || 'none',
        });
        await selectList(_currentListId, _currentListName, _currentSpaceId);
        broadcast('task_created', { listId: _currentListId });
        showToast('Task duplicated');
    } catch (err) {
        showToast('Failed to duplicate: ' + (err.message || err));
    }
}

async function moveListToFolder(listId, listName, spaceId) {
    // Build folder options from cached hierarchy
    const hier = _hierarchyCache[spaceId];
    if (!hier) { showToast('Expand the space first'); return; }
    const folders = hier.folders || [];
    let options = '(none = folderless)';
    folders.forEach((f, i) => { options += '\n' + (i + 1) + '. ' + f.name; });
    const choice = prompt('Move list "' + listName + '" to which folder?\n\n' + options + '\n\nEnter number or leave blank for folderless:');
    if (choice === null) return;

    let folderId = '';
    const idx = parseInt(choice, 10);
    if (idx > 0 && idx <= folders.length) folderId = folders[idx - 1].id;

    try {
        await api('PATCH', API + '/lists/' + listId, { folder_id: folderId });
        delete _hierarchyCache[spaceId];
        const data = await api('GET', API + '/workspaces/' + spaceId + '/folders');
        _hierarchyCache[spaceId] = data;
        renderSpaceTree();
        showToast('List moved');
    } catch (err) {
        showToast('Failed to move: ' + (err.message || err));
    }
}

// ── Batch Selection & Operations ─────────────────────────────

function batchToggleItem(itemId, checked) {
    if (checked) _selectedItems.add(itemId);
    else _selectedItems.delete(itemId);
    renderMainContent();
}

function batchToggleAll(checked) {
    const visible = getVisibleTasks();
    if (checked) visible.forEach(t => _selectedItems.add(t.id));
    else _selectedItems.clear();
    renderMainContent();
}

function batchToggleAllHome(checked) {
    const visible = filterHomeListItems(_homeListItems || []);
    if (checked) visible.forEach(t => _selectedItems.add(t.id));
    else _selectedItems.clear();
    renderMainContent();
}

function batchClearSelection() {
    _selectedItems.clear();
    renderMainContent();
}

function renderBatchToolbar() {
    const count = _selectedItems.size;
    if (count === 0) return '';
    return '<div class="th-batch-toolbar">'
        + '<span class="th-batch-count">' + count + ' selected</span>'
        + '<button class="btn btn-small btn-ghost th-batch-btn" onclick="batchChangeStatus()" title="Change status">Status</button>'
        + '<button class="btn btn-small btn-ghost th-batch-btn" onclick="batchChangePriority()" title="Change priority">Priority</button>'
        + '<button class="btn btn-small btn-ghost th-batch-btn" onclick="batchChangeDueDate()" title="Set due date">Due Date</button>'
        + '<button class="btn btn-small btn-ghost th-batch-btn" onclick="batchAssign()" title="Assign to member">Assign</button>'
        + '<button class="btn btn-small btn-ghost th-batch-btn" onclick="batchMove()" title="Move to another list">Move</button>'
        + '<button class="btn btn-small btn-ghost th-batch-btn th-batch-btn-danger" onclick="batchDelete()" title="Delete selected">Delete</button>'
        + '<button class="btn btn-small btn-ghost" onclick="batchClearSelection()" title="Clear selection" style="margin-left:auto;font-size:11px;opacity:0.7;">Clear</button>'
        + '</div>';
}

async function batchChangeStatus() {
    const ids = [..._selectedItems];
    if (!ids.length) return;

    const statusOptions = _currentStatuses.length
        ? _currentStatuses.map(s => s.name)
        : ['open', 'in_progress', 'review', 'done', 'closed'];
    if (!statusOptions.length) { showToast('No statuses configured'); return; }

    // Build a quick picker
    const picked = await batchPickOption('Change Status', statusOptions);
    if (!picked) return;

    showToast('Updating ' + ids.length + ' items...');
    try {
        const result = await api('POST', API + '/items/batch', { item_ids: ids, action: 'update', update: { status: picked } });
        for (const id of ids) {
            const t = _tasks.find(t => t.id === id);
            if (t) t.status = picked;
        }
        _selectedItems.clear();
        _homeListItems = null;
        renderMainContent();
        showToast(result.succeeded + ' items updated');
        broadcast('task_updated', { listId: _currentListId });
    } catch (err) {
        showToast('Batch update failed: ' + (err.message || err));
    }
}

async function batchChangePriority() {
    const ids = [..._selectedItems];
    if (!ids.length) return;

    const options = PRIORITIES.map(p => p.value);
    const picked = await batchPickOption('Change Priority', options);
    if (!picked) return;

    showToast('Updating ' + ids.length + ' items...');
    try {
        const result = await api('POST', API + '/items/batch', { item_ids: ids, action: 'update', update: { priority: picked } });
        for (const id of ids) {
            const t = _tasks.find(t => t.id === id);
            if (t) t.priority = picked;
        }
        _selectedItems.clear();
        _homeListItems = null;
        renderMainContent();
        showToast(result.succeeded + ' items updated');
        broadcast('task_updated', { listId: _currentListId });
    } catch (err) {
        showToast('Batch update failed: ' + (err.message || err));
    }
}

async function batchChangeDueDate() {
    const ids = [..._selectedItems];
    if (!ids.length) return;

    // Show a date picker modal
    const picked = await batchPickDate('Set Due Date');
    if (!picked) return;

    showToast('Updating ' + ids.length + ' items...');
    try {
        const result = await api('POST', API + '/items/batch', { item_ids: ids, action: 'update', update: { due_date: picked } });
        for (const id of ids) {
            const t = _tasks.find(t => t.id === id);
            if (t) t.due_date = picked;
        }
        _selectedItems.clear();
        _homeListItems = null;
        renderMainContent();
        showToast(result.succeeded + ' items updated');
        broadcast('task_updated', { listId: _currentListId });
    } catch (err) {
        showToast('Batch update failed: ' + (err.message || err));
    }
}

function batchPickDate(title) {
    return new Promise((resolve) => {
        let overlay = document.getElementById('batch-date-overlay');
        if (overlay) overlay.remove();
        overlay = document.createElement('div');
        overlay.id = 'batch-date-overlay';
        overlay.className = 'modal-overlay visible';
        overlay.innerHTML = '<div class="modal" style="max-width:320px;">'
            + '<button class="modal-close" onclick="this.closest(\'.modal-overlay\').remove()">&times;</button>'
            + '<div class="modal-title">' + esc(title) + '</div>'
            + '<div style="padding:12px 0;"><input type="date" id="batch-date-input" class="form-input" style="width:100%;"></div>'
            + '<div class="wizard-actions">'
            + '<button class="btn btn-ghost" id="batch-date-clear">Clear Date</button>'
            + '<button class="btn btn-accent" id="batch-date-confirm">Apply</button>'
            + '</div></div>';
        document.body.appendChild(overlay);
        overlay.querySelector('.modal-close').addEventListener('click', () => resolve(null));
        overlay.querySelector('#batch-date-clear').addEventListener('click', () => { overlay.remove(); resolve(''); });
        overlay.querySelector('#batch-date-confirm').addEventListener('click', () => {
            const val = document.getElementById('batch-date-input').value;
            overlay.remove();
            resolve(val || null);
        });
    });
}

async function batchAssign() {
    const ids = [..._selectedItems];
    if (!ids.length) return;

    // Use workspace assignees, fall back to global profiles (for home list view)
    let assignees = (_allAssignees && _allAssignees.length) ? _allAssignees : [];
    if (!assignees.length && _profiles.length) {
        assignees = _profiles.map(p => ({ id: p.id, name: p.display_name || p.email || p.id }));
    }
    if (!assignees.length) { showToast('No team members found'); return; }

    const options = assignees.map(a => a.name || a.id);
    const picked = await batchPickOption('Assign To', options);
    if (!picked) return;

    const member = assignees.find(a => (a.name || a.id) === picked);
    if (!member) return;

    showToast('Assigning ' + ids.length + ' items...');
    try {
        const result = await api('POST', API + '/items/batch', { item_ids: ids, action: 'assign', assignee_id: member.id });
        _selectedItems.clear();
        _homeListItems = null;
        renderMainContent();
        showToast(result.succeeded + ' items assigned');
    } catch (err) {
        showToast('Batch assign failed: ' + (err.message || err));
    }
}

async function batchMove() {
    const ids = [..._selectedItems];
    if (!ids.length) return;

    // Reuse the move item modal approach but batch it
    let overlay = document.getElementById('batch-move-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'batch-move-overlay';
        overlay.className = 'modal-overlay';
        overlay.innerHTML = '<div class="modal" style="max-width:420px;">'
            + '<button class="modal-close" onclick="closeBatchMoveModal()">&times;</button>'
            + '<div class="modal-title">Move ' + ids.length + ' Items</div>'
            + '<div class="form-group"><label class="form-label">Space</label>'
            + '<select class="form-select" id="batch-move-space" onchange="batchMoveSpaceChanged()"><option>Loading...</option></select></div>'
            + '<div class="form-group"><label class="form-label">List</label>'
            + '<select class="form-select" id="batch-move-list"><option>Select a space first</option></select></div>'
            + '<div class="wizard-actions"><button class="btn btn-ghost" onclick="closeBatchMoveModal()">Cancel</button>'
            + '<button class="btn btn-accent" onclick="confirmBatchMove()">Move ' + ids.length + ' Items</button></div>'
            + '</div>';
        document.body.appendChild(overlay);
    } else {
        overlay.querySelector('.modal-title').textContent = 'Move ' + ids.length + ' Items';
    }
    overlay.classList.add('visible');
    // Load spaces
    const sel = document.getElementById('batch-move-space');
    sel.innerHTML = '<option value="">Loading...</option>';
    try {
        const data = await api('GET', API + '/workspaces');
        const spaces = data.workspaces || data;
        sel.innerHTML = spaces.map(s => '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>').join('');
        batchMoveSpaceChanged();
    } catch {
        sel.innerHTML = '<option value="">Failed to load</option>';
    }
}

function closeBatchMoveModal() {
    const overlay = document.getElementById('batch-move-overlay');
    if (overlay) overlay.classList.remove('visible');
}

async function batchMoveSpaceChanged() {
    const spaceId = document.getElementById('batch-move-space').value;
    const listSel = document.getElementById('batch-move-list');
    if (!spaceId) { listSel.innerHTML = '<option value="">Select a space</option>'; return; }
    listSel.innerHTML = '<option value="">Loading...</option>';
    try {
        const data = await api('GET', API + '/workspaces/' + spaceId + '/folders');
        const folders = data.folders || [];
        const folderlessLists = data.lists || [];
        let opts = '';
        for (const folder of folders) {
            if (folder.id === '__uncategorized__') continue;
            for (const list of (folder.lists || [])) {
                opts += '<option value="' + esc(list.id) + '" data-folder="' + esc(folder.id) + '">' + esc(folder.name) + ' / ' + esc(list.name) + '</option>';
            }
        }
        for (const list of folderlessLists) {
            opts += '<option value="' + esc(list.id) + '">' + esc(list.name) + '</option>';
        }
        listSel.innerHTML = opts || '<option value="">No lists found</option>';
    } catch {
        listSel.innerHTML = '<option value="">Error loading lists</option>';
    }
}

async function confirmBatchMove() {
    const ids = [..._selectedItems];
    if (!ids.length) return;
    const listSel = document.getElementById('batch-move-list');
    const listId = listSel.value;
    if (!listId) { showToast('Select a target list'); return; }
    const folderId = listSel.selectedOptions[0]?.dataset?.folder || null;

    const update = { list_id: listId };
    if (folderId) update.folder_id = folderId;

    showToast('Moving ' + ids.length + ' items...');
    try {
        const result = await api('POST', API + '/items/batch', { item_ids: ids, action: 'update', update });
        _tasks = _tasks.filter(t => !_selectedItems.has(t.id));
        _selectedItems.clear();
        _homeListItems = null;
        closeBatchMoveModal();
        renderMainContent();
        showToast(result.succeeded + ' items moved');
        broadcast('task_updated', { listId: _currentListId });
    } catch (err) {
        showToast('Batch move failed: ' + (err.message || err));
    }
}

async function batchDelete() {
    const ids = [..._selectedItems];
    if (!ids.length) return;
    if (!confirm('Delete ' + ids.length + ' items? This cannot be undone.')) return;

    showToast('Deleting ' + ids.length + ' items...');
    try {
        const result = await api('POST', API + '/items/batch', { item_ids: ids, action: 'delete' });
        _tasks = _tasks.filter(t => !_selectedItems.has(t.id));
        if (_homeListItems) _homeListItems = _homeListItems.filter(t => !_selectedItems.has(t.id));
        _selectedItems.clear();
        _homeListItems = null;
        renderMainContent();
        showToast(result.succeeded + ' items deleted');
        broadcast('task_updated', { listId: _currentListId });
    } catch (err) {
        showToast('Batch delete failed: ' + (err.message || err));
    }
}

// Generic option picker for batch ops (returns a promise that resolves with the selected option or null)
function batchPickOption(title, options) {
    return new Promise((resolve) => {
        let overlay = document.getElementById('batch-picker-overlay');
        if (overlay) overlay.remove();
        overlay = document.createElement('div');
        overlay.id = 'batch-picker-overlay';
        overlay.className = 'modal-overlay visible';
        let optionsHtml = options.map(o =>
            '<button class="th-batch-pick-option" data-value="' + esc(o) + '">' + esc(o) + '</button>'
        ).join('');
        overlay.innerHTML = '<div class="modal" style="max-width:320px;">'
            + '<button class="modal-close" onclick="this.closest(\'.modal-overlay\').remove()">&times;</button>'
            + '<div class="modal-title">' + esc(title) + '</div>'
            + '<div class="th-batch-pick-list">' + optionsHtml + '</div>'
            + '</div>';
        document.body.appendChild(overlay);
        overlay.querySelector('.modal-close').addEventListener('click', () => resolve(null));
        overlay.querySelectorAll('.th-batch-pick-option').forEach(btn => {
            btn.addEventListener('click', () => {
                overlay.remove();
                resolve(btn.dataset.value);
            });
        });
    });
}

// Clear selection when switching lists
const _origSelectList = selectList;
selectList = async function(listId, listName, spaceId) {
    _selectedItems.clear();
    return _origSelectList(listId, listName, spaceId);
};

// ── Sidebar Drag-and-Drop ────────────────────────────────────

let _sidebarDrag = null; // { type: 'folder'|'list'|'task', id, spaceId, folderId }

function bindSidebarDragAndDrop() {
    const tree = document.getElementById('space-tree');
    if (!tree) return;

    // Draggable items: folders and lists in the sidebar
    tree.querySelectorAll('[data-drag-type]').forEach(el => {
        el.addEventListener('dragstart', (e) => {
            e.stopPropagation();
            _sidebarDrag = {
                type: el.dataset.dragType,
                id: el.dataset.dragId,
                spaceId: el.dataset.dragSpace,
                folderId: el.dataset.dragFolder || null
            };
            el.classList.add('th-sidebar-dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('application/x-sidebar-drag', JSON.stringify(_sidebarDrag));
            // Highlight valid drop targets after a tick
            setTimeout(() => highlightDropTargets(_sidebarDrag.type), 0);
        });
        el.addEventListener('dragend', () => {
            el.classList.remove('th-sidebar-dragging');
            _sidebarDrag = null;
            clearDropHighlights();
        });
    });

    // Drop targets: spaces (accept folders and lists), folders (accept lists)
    tree.querySelectorAll('[data-drop-type]').forEach(el => {
        el.addEventListener('dragover', (e) => {
            if (!_sidebarDrag && !e.dataTransfer.types.includes('text/plain')) return;
            const dropType = el.dataset.dropType;
            const dropId = el.dataset.dropId;
            const dropSpace = el.dataset.dropSpace || el.dataset.dropId;

            // Determine if this is a valid drop
            if (_sidebarDrag) {
                if (!isValidSidebarDrop(_sidebarDrag, dropType, dropId, dropSpace)) return;
            } else {
                // Task card dragged from main content — only accept on lists
                if (dropType !== 'list') return;
            }
            e.preventDefault();
            e.stopPropagation();
            el.classList.add('th-sidebar-drop-target');
        });
        el.addEventListener('dragleave', (e) => {
            // Only remove if truly leaving (not entering a child)
            if (!el.contains(e.relatedTarget)) {
                el.classList.remove('th-sidebar-drop-target');
            }
        });
        el.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            el.classList.remove('th-sidebar-drop-target');
            clearDropHighlights();

            const dropType = el.dataset.dropType;
            const dropId = el.dataset.dropId;
            const dropSpace = el.dataset.dropSpace || el.dataset.dropId;

            // Handle task cards dropped onto sidebar lists
            if (!_sidebarDrag && e.dataTransfer.types.includes('text/plain')) {
                if (dropType !== 'list') return;
                const taskId = e.dataTransfer.getData('text/plain');
                if (!taskId) return;
                await handleTaskDropOnList(taskId, dropId, dropSpace);
                return;
            }

            if (!_sidebarDrag) return;
            await handleSidebarDrop(_sidebarDrag, dropType, dropId, dropSpace);
            _sidebarDrag = null;
        });
    });
}

function isValidSidebarDrop(drag, dropType, dropId, dropSpace) {
    // Can't drop on itself
    if (drag.type === dropType && drag.id === dropId) return false;

    if (drag.type === 'folder') {
        // Folders can be dropped on spaces (to move between spaces)
        return dropType === 'space' && dropSpace !== drag.spaceId;
    }
    if (drag.type === 'list') {
        // Lists can be dropped on:
        // - folders (to move into a folder, even same space)
        // - spaces (to move to folderless in that space)
        if (dropType === 'folder') {
            // Don't drop on the same folder it's already in
            return dropId !== drag.folderId;
        }
        if (dropType === 'space') {
            // Allow moving to same space (makes it folderless) or different space
            return true;
        }
    }
    return false;
}

function highlightDropTargets(dragType) {
    const tree = document.getElementById('space-tree');
    if (!tree || !_sidebarDrag) return;
    tree.querySelectorAll('[data-drop-type]').forEach(el => {
        const dropType = el.dataset.dropType;
        const dropId = el.dataset.dropId;
        const dropSpace = el.dataset.dropSpace || el.dataset.dropId;
        if (isValidSidebarDrop(_sidebarDrag, dropType, dropId, dropSpace)) {
            el.classList.add('th-sidebar-drop-hint');
        }
    });
}

function clearDropHighlights() {
    document.querySelectorAll('.th-sidebar-drop-target, .th-sidebar-drop-hint, .th-sidebar-dragging').forEach(
        el => el.classList.remove('th-sidebar-drop-target', 'th-sidebar-drop-hint', 'th-sidebar-dragging')
    );
}

async function handleSidebarDrop(drag, dropType, dropId, dropSpace) {
    try {
        if (drag.type === 'folder' && dropType === 'space') {
            // Move folder to a different space
            await api('PATCH', API + '/folders/' + drag.id, { workspace_id: dropId });
            showToast('Folder moved');
            // Invalidate both source and target space caches
            delete _hierarchyCache[drag.spaceId];
            delete _hierarchyCache[dropId];
            await refreshSpaceHierarchy(drag.spaceId);
            await refreshSpaceHierarchy(dropId);
        } else if (drag.type === 'list' && dropType === 'folder') {
            // Move list into a folder
            const update = { folder_id: dropId };
            if (dropSpace !== drag.spaceId) update.workspace_id = dropSpace;
            await api('PATCH', API + '/lists/' + drag.id, update);
            showToast('List moved to folder');
            delete _hierarchyCache[drag.spaceId];
            if (dropSpace !== drag.spaceId) delete _hierarchyCache[dropSpace];
            await refreshSpaceHierarchy(drag.spaceId);
            if (dropSpace !== drag.spaceId) await refreshSpaceHierarchy(dropSpace);
        } else if (drag.type === 'list' && dropType === 'space') {
            // Move list to space root (folderless)
            const update = { folder_id: '' };
            if (dropId !== drag.spaceId) update.workspace_id = dropId;
            await api('PATCH', API + '/lists/' + drag.id, update);
            showToast('List moved');
            delete _hierarchyCache[drag.spaceId];
            if (dropId !== drag.spaceId) delete _hierarchyCache[dropId];
            await refreshSpaceHierarchy(drag.spaceId);
            if (dropId !== drag.spaceId) await refreshSpaceHierarchy(dropId);
        }
        renderSpaceTree();
    } catch (err) {
        showToast('Move failed: ' + (err.message || err));
    }
}

async function handleTaskDropOnList(taskId, listId, spaceId) {
    // Handle dropping a task card (or selected tasks) onto a sidebar list
    const taskIds = _selectedItems.size > 0 && _selectedItems.has(taskId)
        ? Array.from(_selectedItems)
        : [taskId];

    try {
        if (taskIds.length === 1) {
            await api('PATCH', API + '/items/' + taskIds[0], { list_id: listId });
        } else {
            await api('POST', API + '/batch', {
                action: 'update',
                item_ids: taskIds,
                update: { list_id: listId }
            });
        }
        showToast(taskIds.length + ' task' + (taskIds.length > 1 ? 's' : '') + ' moved');
        _selectedItems.clear();
        // Refresh current list
        if (_currentListId) {
            const data = await api('GET', API + '/lists/' + _currentListId + '/items');
            _tasks = data.items || [];
            _currentStatuses = data.statuses || [];
            renderMainContent();
        }
        // Refresh sidebar counts
        delete _hierarchyCache[spaceId];
        if (_currentSpaceId && _currentSpaceId !== spaceId) delete _hierarchyCache[_currentSpaceId];
        await refreshSpaceHierarchy(spaceId);
        if (_currentSpaceId && _currentSpaceId !== spaceId) await refreshSpaceHierarchy(_currentSpaceId);
        renderSpaceTree();
    } catch (err) {
        showToast('Move failed: ' + (err.message || err));
    }
}

async function refreshSpaceHierarchy(spaceId) {
    if (!_expandedSpaces[spaceId]) return;
    try {
        const data = await api('GET', API + '/workspaces/' + spaceId + '/folders');
        _hierarchyCache[spaceId] = data;
    } catch { /* ignore */ }
}

// ── System Update Banner ────────────────────────────────────

function showSystemUpdateBanner(message) {
    if (document.getElementById('system-update-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'system-update-banner';
    banner.className = 'th-update-banner';
    banner.innerHTML = '<span class="th-update-icon">&#x26A1;</span>'
        + '<span class="th-update-text">' + esc(message) + '</span>'
        + '<button class="th-update-btn" onclick="location.reload()">Refresh Now</button>'
        + '<button class="th-update-dismiss" onclick="this.parentElement.remove()">&times;</button>';
    document.body.prepend(banner);
}

// ── AI Panel ─────────────────────────────────────────────────

function toggleAIPanel() {
    if (_aiPanelOpen) {
        closeAIPanel();
    } else {
        openAIPanel();
    }
}

function openAIPanel() {
    _aiPanelOpen = true;
    document.getElementById('ai-panel').classList.add('open');
    document.getElementById('ai-toggle-btn').classList.add('active');
    _aiSyncContext();
    setTimeout(() => document.getElementById('ai-input').focus(), 200);
}

function closeAIPanel() {
    _aiPanelOpen = false;
    document.getElementById('ai-panel').classList.remove('open');
    document.getElementById('ai-toggle-btn').classList.remove('active');
}

function _aiSyncContext() {
    const newSpaceId = _currentSpaceId || null;
    const label = document.getElementById('ai-context-label');

    // Track which space the user is viewing (passed as optional hint)
    _aiCurrentSpaceId = newSpaceId;

    // Update label to show focused workspace (or "All Spaces")
    if (label) {
        label.textContent = _currentSpaceName || 'All Spaces';
        label.style.display = '';
    }

    // Only reset empty state text, not the whole conversation
    const empty = document.getElementById('ai-empty');
    if (empty) {
        empty.innerHTML = newSpaceId
            ? 'Ask anything about <strong>' + esc(_currentSpaceName || 'this workspace') + '</strong> or all your tasks.'
            : 'Ask anything about your tasks across all workspaces.';
    }
}

function _aiAppendBubble(role, content, streaming) {
    const container = document.getElementById('ai-messages');
    // Remove empty state
    const empty = document.getElementById('ai-empty');
    if (empty) empty.remove();

    const wrap = document.createElement('div');
    wrap.className = 'th-ai-msg th-ai-msg-' + role;
    if (streaming) wrap.id = 'ai-streaming-bubble';

    const bubble = document.createElement('div');
    bubble.className = 'th-ai-bubble';
    if (content) {
        bubble.innerHTML = role === 'assistant' ? _aiRenderMarkdown(content) : esc(content).replace(/\n/g, '<br>');
    }
    wrap.appendChild(bubble);
    container.appendChild(wrap);
    container.scrollTop = container.scrollHeight;
    return bubble;
}

function _aiRenderMarkdown(text) {
    if (window.markdownit) {
        return window.markdownit({ linkify: true, breaks: true }).render(text);
    }
    return esc(text).replace(/\n/g, '<br>');
}

function _aiSetSendBusy(busy) {
    const btn = document.getElementById('ai-send-btn');
    const input = document.getElementById('ai-input');
    if (btn) btn.disabled = busy;
    if (input) input.disabled = busy;
}

async function sendAIMessage() {
    if (_aiStreaming) return;

    const input = document.getElementById('ai-input');
    const text = (input?.value || '').trim();
    if (!text) return;

    input.value = '';
    _aiMessages.push({ role: 'user', content: text });
    _aiAppendBubble('user', text, false);

    _aiStreaming = true;
    _aiSetSendBusy(true);

    // Show thinking indicator
    const thinkingBubble = _aiAppendBubble('assistant', '', true);
    thinkingBubble.innerHTML = '<span class="th-ai-thinking">Thinking...</span>';

    try {
        const session = await _supabase.auth.getSession();
        const token = session?.data?.session?.access_token || '';

        const body = { messages: _aiMessages.slice(0, -1).concat([{ role: 'user', content: text }]) };
        if (_aiCurrentSpaceId) body.workspace_id = _aiCurrentSpaceId;

        const resp = await fetch('/team-hub/api/ai/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token,
            },
            body: JSON.stringify(body),
        });

        if (!resp.ok) {
            const err = await resp.json().catch(() => ({ detail: resp.statusText }));
            throw new Error(err.detail || 'Request failed');
        }

        const data = await resp.json();
        const reply = data.reply || 'No response received.';

        thinkingBubble.innerHTML = _aiRenderMarkdown(reply);
        _aiMessages.push({ role: 'assistant', content: reply });

        const msgs = document.getElementById('ai-messages');
        if (msgs) msgs.scrollTop = msgs.scrollHeight;
    } catch (e) {
        thinkingBubble.textContent = 'Error: ' + (e.message || 'Failed to get response');
        thinkingBubble.style.color = 'var(--danger, #e17055)';
    }

    // Remove streaming id
    const el = document.getElementById('ai-streaming-bubble');
    if (el) el.removeAttribute('id');

    _aiStreaming = false;
    _aiSetSendBusy(false);
    input?.focus();
}

// Re-sync context whenever workspace/list changes
const _origSelectSpace = typeof selectSpace === 'function' ? selectSpace : null;
// Hook via openSpaceDashboard and selectList wrappers called after state updates:
function _aiOnContextChange() {
    if (_aiPanelOpen) _aiSyncContext();
}
