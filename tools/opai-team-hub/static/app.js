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
let _itemsChannel = null;      // postgres_changes subscription for current list's items
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
let _customTileData = {};     // cached data for custom tiles {tileId: {items, total}}
let _hideClosedTasks = true;  // hide done/closed tasks by default
let _favorites = [];          // user's favorites
let _hubs = [];               // user's hubs [{id, name, slug, icon, color, my_role}]
let _currentHubId = null;     // active hub context

function _myPersonalSpaceId() {
    return _spaces.find(s => s.is_personal)?.id;
}

function _myHub() {
    return _hubs.length ? _hubs[0] : null;
}

function _isHubAdmin() {
    const hub = _myHub();
    return hub?.my_role === 'admin';
}

function _isSettingsOwner() {
    // Hub admin or personal workspace owner
    if (_isHubAdmin()) return true;
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
    await loadSpaces();
    // Update header with hub name if user belongs to one
    const hub = _myHub();
    if (hub) {
        const logo = document.querySelector('.th-logo');
        if (logo) logo.textContent = (hub.icon || '🏢') + ' ' + hub.name;
    }
    loadProfiles();
    loadFavorites();
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

async function apiFetch(path, opts = {}) {
    const token = await opaiAuth.getToken();
    const headers = { ...(opts.headers || {}) };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (!headers['Content-Type'] && opts.body) headers['Content-Type'] = 'application/json';
    const resp = await fetch(API.replace('/api', '') + path, { ...opts, headers });
    if (!resp.ok) throw new Error(await resp.text() || 'HTTP ' + resp.status);
    if (resp.status === 204) return { ok: true };
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

    // task_updated broadcast: Postgres Changes UPDATE listener handles the actual data sync.
    // This broadcast is kept as a no-op placeholder for backward compatibility.
    _realtimeChannel.on('broadcast', { event: 'task_updated' }, () => {});

    // task_created broadcast: Postgres Changes INSERT listener handles the actual data sync.
    // This broadcast is kept as a no-op placeholder for backward compatibility.
    _realtimeChannel.on('broadcast', { event: 'task_created' }, () => {});

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

// ── Live Items Channel (Postgres Changes) ────────────────────

function subscribeToListItems(listId) {
    unsubscribeFromListItems();
    if (!_supabase || !listId) return;

    _itemsChannel = _supabase
        .channel('team-items-' + listId)
        .on('postgres_changes', {
            event: 'UPDATE',
            schema: 'public',
            table: 'team_items',
            filter: 'list_id=eq.' + listId,
        }, (payload) => {
            const updated = payload.new;
            const idx = _tasks.findIndex(t => t.id === updated.id);
            if (idx >= 0) {
                // Preserve enriched fields (assignees, tags) that aren't in the DB row
                const enriched = _tasks[idx];
                Object.assign(enriched, updated);
                _tasks[idx] = enriched;
            }
            // Update detail panel if viewing this task (skip if user is editing)
            if (_detailTask && _detailTask.id === updated.id) {
                if (!document.querySelector('#detail-body :focus')) {
                    Object.assign(_detailTask, updated);
                    renderDetailPanel();
                }
            }
            renderMainContent();
        })
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'team_items',
            filter: 'list_id=eq.' + listId,
        }, (payload) => {
            const newItem = payload.new;
            // Avoid duplicates (e.g. if we already added it optimistically)
            if (!_tasks.find(t => t.id === newItem.id)) {
                newItem.assignees = newItem.assignees || [];
                newItem.tags = newItem.tags || [];
                _tasks.unshift(newItem);
                renderMainContent();
            }
        })
        .on('postgres_changes', {
            event: 'DELETE',
            schema: 'public',
            table: 'team_items',
            filter: 'list_id=eq.' + listId,
        }, (payload) => {
            const deletedId = payload.old.id;
            _tasks = _tasks.filter(t => t.id !== deletedId);
            if (_detailTask && _detailTask.id === deletedId) {
                closeDetail();
                showToast('This item was deleted');
            }
            renderMainContent();
        })
        .subscribe();
}

function unsubscribeFromListItems() {
    if (_itemsChannel) {
        _supabase.removeChannel(_itemsChannel);
        _itemsChannel = null;
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

    // Detail close — only via explicit close button
    document.getElementById('detail-close').addEventListener('click', closeDetail);

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

    // Modal close handlers — only close via explicit close/cancel buttons, not backdrop click
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
        _hubs = data.hubs || [];
        if (_hubs.length && !_currentHubId) {
            _currentHubId = _hubs[0].id;
        }
    } catch (e) {
        _spaces = [];
        _hubs = [];
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

    // Hub header (if user belongs to a hub)
    const hub = _myHub();
    if (hub) {
        html += '<div class="th-hub-header" style="padding:8px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#888;display:flex;align-items:center;gap:6px;">'
            + '<span>' + esc(hub.icon || '🏢') + '</span>'
            + '<span>' + esc(hub.name) + '</span>'
            + '</div>';
    }

    // "All Tasks" quick nav — shows list view of all hub tasks
    html += '<div class="th-tree-all-tasks" style="padding:6px 16px;cursor:pointer;font-size:13px;color:#aaa;display:flex;align-items:center;gap:6px;" '
        + 'onclick="showAllHubTasks()">'
        + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>'
        + '<span>All Tasks</span></div>';

    for (const space of _spaces) {
        const expanded = _expandedSpaces[space.id];
        const active = _currentSpaceId === space.id;
        html += '<div class="th-tree-space" data-space-id="' + esc(space.id) + '" data-drop-type="space" data-drop-id="' + esc(space.id) + '" draggable="true">'
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
    bindSpaceReorder();
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
    subscribeToListItems(listId);
    _aiOnContextChange();
}

// ── Space Dashboard ──────────────────────────────────────────

async function openSpaceDashboard(spaceId, spaceName) {
    _currentSpaceId = spaceId;
    _currentSpaceName = spaceName;
    _currentListId = null;
    _currentView = 'dashboard';
    unsubscribeFromListItems();
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

    const openTasks = d.open_tasks || [];
    const openCount = d.open_count || openTasks.length;

    let html = '<div class="th-dashboard">'
        + '<div class="th-dashboard-header">'
        + '<h2>' + esc(spaceName) + ' Dashboard</h2>'
        + '<span class="th-dashboard-total">' + total + ' items</span>'
        + '</div>'
        + '<div class="th-dashboard-grid">';

    // Open Tasks widget (position #1)
    html += '<div class="th-widget th-widget-open-tasks">'
        + '<div class="th-widget-title">Open Tasks <span class="th-widget-count">' + openCount + '</span></div>'
        + '<div class="th-widget-body">';
    if (openTasks.length === 0) {
        html += '<div style="color:var(--text-muted);font-size:13px;padding:8px;">No open tasks</div>';
    } else {
        for (const item of openTasks) {
            const due = item.due_date ? new Date(item.due_date).toLocaleDateString('en', { month: 'short', day: 'numeric' }) : '';
            const isOverdue = item.due_date && item.due_date.slice(0, 10) < new Date().toISOString().split('T')[0];
            const sColor = { 'in_progress': '#fdcb6e', 'Working on': '#fdcb6e', 'Not Started': '#d3d3d3', 'review': '#6c5ce7', 'Manager Review': '#6c5ce7', 'Quality Review': '#74b9ff', 'Client Review': '#a29bfe', 'Back to You': '#e17055', 'Stuck': '#d63031', 'Waiting on Client': '#fd79a8' }[item.status] || '#74b9ff';
            html += '<div class="th-widget-item" onclick="openDetail(\'' + esc(item.id) + '\')">'
                + '<span class="th-widget-item-dot" style="background:' + sColor + ';"></span>'
                + '<span class="th-widget-item-title">' + esc(item.title || item.id) + '</span>'
                + '<span class="th-widget-item-status" style="color:' + sColor + ';">' + esc(item.status || '') + '</span>'
                + (due ? '<span class="th-widget-item-due' + (isOverdue ? ' overdue' : '') + '">' + esc(due) + '</span>' : '')
                + '</div>';
        }
        if (openCount > openTasks.length) {
            html += '<div class="th-widget-item" style="text-align:center;color:var(--accent);cursor:pointer;" onclick="_currentView=\'list\';renderMainContent();">+' + (openCount - openTasks.length) + ' more</div>';
        }
    }
    html += '</div></div>';

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
    { id: 'priorities', title: 'Priorities', visible: true, order: 0, size: '1x1' },
    { id: 'top3', title: 'Top 3 Priorities', visible: true, order: 1, size: '1x1' },
    { id: 'overdue', title: 'Overdue', visible: true, order: 2, size: '1x1' },
    { id: 'due_week', title: 'Due This Week', visible: true, order: 3, size: '1x1' },
    { id: 'follow_ups', title: 'Follow-ups Due', visible: true, order: 4, size: '1x1' },
    { id: 'todos', title: 'Recent Todos', visible: true, order: 5, size: '1x1' },
    { id: 'workspaces', title: 'My Workspaces', visible: true, order: 6, size: '1x1' },
    { id: 'mentions', title: 'Mentions', visible: true, order: 7, size: '1x1' },
    { id: 'activity', title: 'Recent Activity', visible: true, order: 8, size: '1x1' },
];

// Tile tooltip descriptions
const TILE_TOOLTIPS = {
    priorities: 'Your most important tasks to focus on — ranked by urgency, priority, and recency',
    top3: 'Your highest-priority open tasks, sorted by urgency. Pin tasks from the detail panel.',
    overdue: 'All tasks assigned to you that are past their due date',
    due_week: 'Tasks due within the next 7 days',
    follow_ups: 'Tasks with follow-up dates due soon',
    todos: 'Recently updated tasks across your workspaces',
    workspaces: 'Overview of your workspace progress',
    mentions: 'Comments where you were @mentioned',
    activity: 'Recent changes across your workspaces',
};

// ── Dismissed (Cleared) Items ────────────────────────────────
function getDismissedItems(tileId) {
    try {
        const key = 'teamhub_dismissed_' + tileId + '_' + (_user ? _user.id : 'anon');
        return JSON.parse(localStorage.getItem(key) || '[]');
    } catch { return []; }
}

function dismissItem(tileId, itemId) {
    const dismissed = getDismissedItems(tileId);
    if (!dismissed.includes(itemId)) dismissed.push(itemId);
    const key = 'teamhub_dismissed_' + tileId + '_' + (_user ? _user.id : 'anon');
    localStorage.setItem(key, JSON.stringify(dismissed));
    renderHomeTiles();
}

function filterDismissed(items, tileId, idField) {
    const dismissed = getDismissedItems(tileId);
    if (!dismissed.length) return items;
    return items.filter(i => !dismissed.includes(i[idField || 'id']));
}

// Clean ClickUp import prefixes from mention content
function cleanMentionContent(content) {
    if (!content) return '';
    // Strip patterns like "**Name** (from ClickUp):" at start
    return content.replace(/^\*\*[^*]+\*\*\s*\(from\s+\w+\)\s*:\s*/i, '');
}

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

    // Fetch custom tile data in parallel
    await fetchAllCustomTileData();

    renderHomeTiles();
}

async function fetchAllCustomTileData() {
    const layout = _homeLayout || loadHomeLayout();
    const customTiles = layout.tiles.filter(t => t.custom && t.visible && t.criteria);
    if (!customTiles.length) return;

    const promises = customTiles.map(async (tile) => {
        try {
            const result = await api('POST', API + '/my/custom-tile', tile.criteria);
            _customTileData[tile.id] = result;
        } catch {
            _customTileData[tile.id] = { items: [], total: 0 };
        }
    });
    await Promise.all(promises);
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
        const tooltip = tile.custom ? (tile.criteria?.conditions?.length || 0) + ' filter(s)' : (TILE_TOOLTIPS[tile.id] || '');
        const isCustom = tile.custom;
        const customBtns = isCustom
            ? '<button class="home-tile-edit" onclick="event.stopPropagation();openCustomTileWizard(\'' + esc(tile.id) + '\')" title="Edit tile">'
              + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>'
              + '</button>'
              + '<button class="home-tile-delete" onclick="event.stopPropagation();deleteCustomTile(\'' + esc(tile.id) + '\')" title="Delete tile">'
              + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
              + '</button>'
            : '';
        html += '<div class="home-tile' + sizeClass + '" draggable="true" data-tile-id="' + esc(tile.id) + '">'
            + '<div class="home-tile-header">'
            + '<span class="home-tile-title" title="' + esc(tooltip) + '">' + esc(tile.title) + '</span>'
            + '<span class="home-tile-size-label">' + (tile.size || '1x1') + '</span>'
            + customBtns
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
    const statusColor = (s) => {
        const m = { 'done': '#00b894', 'Complete': '#00b894', 'Approved': '#00cec9',
            'in_progress': '#fdcb6e', 'Working on': '#fdcb6e',
            'closed': '#636e72', 'Postponed': '#636e72',
            'review': '#6c5ce7', 'Manager Review': '#6c5ce7', 'Quality Review': '#74b9ff',
            'Client Review': '#a29bfe', 'Back to You': '#e17055', 'Stuck': '#d63031',
            'Waiting on Client': '#fd79a8', 'Not Started': '#d3d3d3' };
        return m[s] || '#74b9ff';
    };
    const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en', { month: 'short', day: 'numeric' }) : '';
    const fmtDateLong = (d) => d ? new Date(d).toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' }) : '';
    const isWide = cols >= 2;
    const isExtraWide = cols >= 3;
    const isTall = rows >= 2;

    // Clear button helper
    const clearBtn = (tile, itemId) => {
        if (['priorities', 'top3', 'todos', 'mentions'].includes(tile)) {
            return '<button class="home-tile-clear" onclick="event.stopPropagation();dismissItem(\'' + esc(tile) + '\',\'' + esc(itemId) + '\')" title="Clear from dashboard">&times;</button>';
        }
        return '';
    };

    if (tileId === 'priorities') {
        const limit = isTall ? (isExtraWide ? 25 : isWide ? 15 : 8) : (isExtraWide ? 8 : isWide ? 5 : 5);
        const items = filterDismissed(data.priorities || [], 'priorities').slice(0, limit);
        if (!items.length) return '<div class="home-tile-empty home-tile-empty-good">All caught up!</div>';
        const todayStr = new Date().toISOString().split('T')[0];
        return items.map(i => {
            const pColor = pri[i.priority] || '#595d66';
            const due = i.due_date ? fmtDate(i.due_date) : '';
            const isOverdue = i.due_date && i.due_date < todayStr;
            const isDueToday = i.due_date && i.due_date === todayStr;
            const dueClass = isOverdue ? ' style="color:var(--red);font-weight:600;"' : isDueToday ? ' style="color:var(--orange);font-weight:600;"' : '';
            const statusBadge = (isWide || isTall) ? '<span class="home-tile-meta">' + esc(i.status || '') + '</span>' : '';
            return '<div class="home-tile-item' + (isWide ? ' tile-item-row' : '') + '" onclick="openDetail(\'' + esc(i.id) + '\')">'
                + '<span class="home-tile-status-dot" style="background:' + statusColor(i.status) + ';"></span>'
                + '<span class="home-tile-item-title">' + esc(i.title) + '</span>'
                + '<span class="cu-priority-pill" style="background:' + pColor + '22;color:' + pColor + ';font-size:10px;">' + esc(i.priority || 'none') + '</span>'
                + (due ? '<span class="home-tile-due"' + dueClass + '>' + (isOverdue ? 'Overdue ' : '') + esc(due) + '</span>' : '')
                + statusBadge
                + clearBtn('priorities', i.id)
                + '</div>';
        }).join('');
    }

    if (tileId === 'top3') {
        // 1x1:3  2x1:5  3x1:8  1x2:8  2x2:15  3x2:25
        const limit = isTall ? (isExtraWide ? 25 : isWide ? 15 : 8) : (isExtraWide ? 8 : isWide ? 5 : 3);
        // Merge pinned items (shown first) with auto-priority items
        const pinnedIds = getPinnedItems();
        const autoItems = filterDismissed(data.top_items || [], 'top3');
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
                + clearBtn('top3', i.id)
                + '</div>' + desc;
        }).join('');
    }

    if (tileId === 'todos') {
        // 1x1:6  2x1:10  3x1:14  1x2:15  2x2:25  3x2:40
        const limit = isTall ? (isExtraWide ? 40 : isWide ? 25 : 15) : (isExtraWide ? 14 : isWide ? 10 : 6);
        const items = filterDismissed(data.recent_todos || [], 'todos').slice(0, limit);
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
                + clearBtn('todos', i.id)
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
        if (items.length > limit) html += '<div class="home-tile-overflow" onclick="showAllFromTile(\'overdue\')" style="cursor:pointer;" title="View all overdue tasks">+' + (items.length - limit) + ' more</div>';
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
            if (items.length > limit) html += '<div class="home-tile-overflow" onclick="showAllFromTile(\'due_week\')" style="cursor:pointer;" title="View all tasks due this week">+' + (items.length - limit) + ' more</div>';
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
        if (items.length > limit) html += '<div class="home-tile-overflow" onclick="showAllFromTile(\'due_week\')" style="cursor:pointer;" title="View all tasks due this week">+' + (items.length - limit) + ' more</div>';
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
        if (items.length > fuLimit) html += '<div class="home-tile-overflow" onclick="showAllFromTile(\'follow_ups\')" style="cursor:pointer;" title="View all follow-ups">+' + (items.length - fuLimit) + ' more</div>';
        return html;
    }

    if (tileId === 'mentions') {
        // 1x1:5  2x1:8  3x1:10  1x2:12  2x2:20  3x2:30
        const limit = isTall ? (isExtraWide ? 30 : isWide ? 20 : 12) : (isExtraWide ? 10 : isWide ? 8 : 5);
        const charLimit = isExtraWide ? 200 : isWide ? 120 : isTall ? 100 : 60;
        const items = filterDismissed(data.mentions || [], 'mentions').slice(0, limit);
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

            // Clean ClickUp import prefixes and build preview with @mention highlighting
            const cleanedContent = cleanMentionContent(c.content || '');
            const rawPreview = cleanedContent.substring(0, charLimit) + (cleanedContent.length > charLimit ? '...' : '');
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
                ? '<div class="home-tile-item-desc">' + esc(cleanMentionContent(c.content || '').substring(0, 300)).replace(/@(\w[\w\s]*?\w|\w)/g, '<span class="mention-hl">@$1</span>') + '</div>' : '';
            return '<div class="home-tile-item' + (isWide ? ' tile-item-row' : '') + '" onclick="' + (c.item_id ? 'openDetail(\'' + esc(c.item_id) + '\')' : '') + '">'
                + headerHtml
                + '<span class="home-tile-item-title">' + hlPreview + '</span>'
                + '<span class="home-tile-meta">' + timeAgo(c.created_at) + '</span>'
                + clearBtn('mentions', c.id)
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

    // Custom tiles — render from _customTileData
    if (tileId.startsWith('custom_')) {
        const tileData = _customTileData[tileId];
        if (!tileData) return '<div class="home-tile-empty"><div class="spinner" style="width:20px;height:20px;"></div></div>';
        const limit = isTall ? (isExtraWide ? 25 : isWide ? 15 : 8) : (isExtraWide ? 8 : isWide ? 5 : 5);
        const items = filterDismissed(tileData.items || [], tileId).slice(0, limit);
        if (!items.length) return '<div class="home-tile-empty home-tile-empty-good">No matching items</div>';
        const totalBadge = tileData.total > items.length
            ? '<div class="custom-tile-preview-count">' + tileData.total + ' total</div>' : '';
        return items.map(i => {
            const pColor = pri[i.priority] || '#595d66';
            const due = i.due_date ? fmtDate(i.due_date) : '';
            const statusBadge = (isWide || isTall) ? '<span class="home-tile-meta">' + esc(i.status || '') + '</span>' : '';
            return '<div class="home-tile-item' + (isWide ? ' tile-item-row' : '') + '" onclick="openDetail(\'' + esc(i.id) + '\')">'
                + '<span class="home-tile-status-dot" style="background:' + statusColor(i.status) + ';"></span>'
                + '<span class="home-tile-item-title">' + esc(i.title) + '</span>'
                + '<span class="cu-priority-pill" style="background:' + pColor + '22;color:' + pColor + ';font-size:10px;">' + esc(i.priority || 'none') + '</span>'
                + (due ? '<span class="home-tile-due">' + esc(due) + '</span>' : '')
                + statusBadge
                + '<button class="home-tile-clear" onclick="event.stopPropagation();dismissItem(\'' + esc(tileId) + '\',\'' + esc(i.id) + '\')" title="Clear from tile">&times;</button>'
                + '</div>';
        }).join('') + totalBadge;
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
    unsubscribeFromListItems();
    document.querySelectorAll('.th-view-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.th-view-btn[data-view="board"]')?.classList.add('active');
    _currentView = 'board';
    renderSpaceTree();
    renderHome();
}

function showAllHubTasks() {
    _currentSpaceId = null;
    _currentListId = null;
    _currentSpaceName = '';
    _currentListName = '';
    _homeData = null;
    _homeListItems = null;
    _homeListShowAll = true;       // show ALL tasks, not just "my tasks"
    _homeListHideCompleted = true;
    unsubscribeFromListItems();
    // Switch to list view
    document.querySelectorAll('.th-view-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.th-view-btn[data-view="list"]')?.classList.add('active');
    _currentView = 'list';
    renderSpaceTree();
    renderMainContent();
}

// ── Home List View (All Tasks) ────────────────────────────────

let _homeListItems = null;
let _homeListSort = 'updated_at';
let _homeListDir = 'desc';
let _homeListStatusFilters = [];   // multi-select
let _homeListPriorityFilters = []; // multi-select
let _homeListSearch = '';
let _homeListWorkspaceFilter = '';
let _homeListTagFilters = [];      // multi-select
let _homeListShowAll = false;
let _homeListHideCompleted = true; // default: hide completed
let _homeListWorkspaces = {};
let _homeListAllTags = [];
const HOME_COMPLETED_STATUSES = ['Complete', 'done', 'closed', 'Approved'];

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
        if (_homeListStatusFilters.length) params.set('status', _homeListStatusFilters.join(','));
        if (_homeListPriorityFilters.length) params.set('priority', _homeListPriorityFilters.join(','));
        if (_homeListWorkspaceFilter) params.set('workspace_id', _homeListWorkspaceFilter);
        if (_homeListTagFilters.length) params.set('tag', _homeListTagFilters.join(','));
        if (_homeListShowAll) params.set('show_all', 'true');
        if (_homeListHideCompleted) params.set('hide_completed', 'true');
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
    const statusColor = (s) => { const m = { 'done': '#00b894', 'Complete': '#00b894', 'Approved': '#00cec9', 'in_progress': '#fdcb6e', 'Working on': '#fdcb6e', 'Not Started': '#d3d3d3', 'closed': '#636e72', 'Postponed': '#636e72', 'review': '#6c5ce7', 'Manager Review': '#6c5ce7', 'Quality Review': '#74b9ff', 'Client Review': '#a29bfe', 'Back to You': '#e17055', 'Stuck': '#d63031', 'Waiting on Client': '#fd79a8' }; return m[s] || '#74b9ff'; };
    if (!items.length) {
        return '<tr><td colspan="10" style="text-align:center;color:var(--text-muted);padding:40px;">No items found</td></tr>';
    }
    let rows = '';
    for (const t of items) {
        const due = t.due_date ? new Date(t.due_date).toLocaleDateString('en', { month: 'short', day: 'numeric' }) : '-';
        const dueOverdue = t.due_date && new Date(t.due_date) < new Date() && t.status !== 'done' && t.status !== 'closed' && t.status !== 'Complete' ? ' overdue' : '';
        const assignees = (t.assignees || []).map(a => resolveAssigneeName(a.assignee_id)).filter(Boolean).join(', ') || '-';
        const sColor = statusColor(t.status);
        const pObj = PRIORITIES.find(p => p.value === t.priority);
        const tags = (t.tags || []).map(tg => '<span class="th-tag-pill th-tag-clickable" style="background:' + esc(tg.color || '#6366f1') + '22;color:' + esc(tg.color || '#6366f1') + ';font-size:10px;cursor:pointer;" onclick="event.stopPropagation();filterByTag(\'' + esc(tg.name) + '\')" title="Filter by ' + esc(tg.name) + '">' + esc(tg.name) + '</span>').join(' ');
        const updated = timeAgo(t.updated_at);
        const checked = _selectedItems.has(t.id);
        const cidHtml = t.custom_id ? '<span class="th-custom-id">' + esc(t.custom_id) + '</span>' : '';
        rows += '<tr class="' + (checked ? 'th-batch-selected' : '') + '" onclick="openDetail(\'' + esc(t.id) + '\')">'
            + '<td class="th-list-check-col" onclick="event.stopPropagation()"><input type="checkbox" class="th-batch-check" ' + (checked ? 'checked' : '') + ' onchange="batchToggleItem(\'' + esc(t.id) + '\', this.checked)"></td>'
            + '<td class="th-list-title-cell">' + cidHtml + '<span class="th-inline-edit-cell" ondblclick="event.stopPropagation();inlineEditTitle(this,\'' + esc(t.id) + '\')">' + esc(t.title || '') + '</span></td>'
            + '<td><span class="home-list-ws-badge" style="background:' + esc(t.workspace_color || '#6c5ce7') + '22;color:' + esc(t.workspace_color || '#6c5ce7') + ';">' + esc(t.workspace_name || '') + '</span></td>'
            + '<td style="font-size:12px;color:var(--text-muted);">' + esc(t.list_name || '-') + '</td>'
            + '<td onclick="event.stopPropagation()"><span class="cu-status-pill th-inline-edit-cell" style="background:' + sColor + '22;color:' + sColor + ';" ondblclick="inlineEditStatus(this,\'' + esc(t.id) + '\',\'' + esc(t.status || '') + '\')">' + esc(t.status || '') + '</span></td>'
            + '<td onclick="event.stopPropagation()">' + (pObj ? '<span class="cu-priority-pill th-inline-edit-cell" style="background:' + pObj.color + '22;color:' + pObj.color + ';" ondblclick="inlineEditPriority(this,\'' + esc(t.id) + '\',\'' + esc(t.priority || '') + '\')">' + esc(pObj.label) + '</span>' : '-') + '</td>'
            + '<td style="font-size:12px;color:var(--text-muted);">' + esc(assignees) + '</td>'
            + '<td style="font-size:12px;" class="' + dueOverdue + '">' + esc(due) + '</td>'
            + '<td>' + tags + '</td>'
            + '<td style="font-size:11px;color:var(--text-muted);">' + esc(updated) + '</td>'
            + '</tr>';
    }
    return rows;
}

function renderMultiSelectDropdown(id, label, options, selected, onChangeFn) {
    const hasSelection = selected.length > 0;
    const displayLabel = hasSelection ? label + ' (' + selected.length + ')' : label;
    let html = '<div class="hl-multiselect" id="ms-' + id + '">'
        + '<button class="hl-multiselect-btn' + (hasSelection ? ' has-selection' : '') + '" onclick="toggleMultiSelect(\'' + id + '\')">'
        + '<span>' + esc(displayLabel) + '</span>'
        + '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="6 9 12 15 18 9"/></svg>'
        + '</button>'
        + '<div class="hl-multiselect-dropdown" id="msd-' + id + '" style="display:none;">';
    if (hasSelection) {
        html += '<button class="hl-ms-clear" onclick="' + onChangeFn + '([])">Clear all</button>';
    }
    for (const opt of options) {
        const val = typeof opt === 'string' ? opt : opt.value;
        const lbl = typeof opt === 'string' ? opt : opt.label;
        const color = (typeof opt === 'object' && opt.color) ? opt.color : null;
        const checked = selected.includes(val);
        const colorDot = color ? '<span class="hl-ms-dot" style="background:' + esc(color) + ';"></span>' : '';
        html += '<label class="hl-ms-option' + (checked ? ' checked' : '') + '">'
            + '<input type="checkbox" ' + (checked ? 'checked' : '') + ' onchange="handleMultiSelectChange(\'' + id + '\',\'' + esc(val).replace(/'/g, "\\'") + '\',this.checked,\'' + onChangeFn + '\')">'
            + colorDot + esc(lbl)
            + '</label>';
    }
    html += '</div></div>';
    return html;
}

function toggleMultiSelect(id) {
    const dd = document.getElementById('msd-' + id);
    if (!dd) return;
    // Close all other dropdowns first
    document.querySelectorAll('.hl-multiselect-dropdown').forEach(d => { if (d.id !== 'msd-' + id) d.style.display = 'none'; });
    dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
}

function handleMultiSelectChange(id, val, checked, fnName) {
    let current;
    if (id === 'status') current = [..._homeListStatusFilters];
    else if (id === 'priority') current = [..._homeListPriorityFilters];
    else if (id === 'tag') current = [..._homeListTagFilters];
    else return;
    if (checked && !current.includes(val)) current.push(val);
    else if (!checked) current = current.filter(v => v !== val);
    window[fnName](current);
}

// Close multi-select dropdowns when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.hl-multiselect')) {
        document.querySelectorAll('.hl-multiselect-dropdown').forEach(d => d.style.display = 'none');
    }
});

function renderHomeListTable(el) {
    const items = filterHomeListItems(_homeListItems || []);
    const sortIcon = (col) => {
        if (col !== _homeListSort) return '';
        return _homeListDir === 'asc' ? ' &#9650;' : ' &#9660;';
    };
    const sortAttr = (col) => 'onclick="homeListSortBy(\'' + col + '\')" style="cursor:pointer;user-select:none;"';

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

    // Status multi-select options with colors
    const statusOpts = ['Not Started', 'Working on', 'Manager Review', 'Back to You', 'Stuck', 'Waiting on Client', 'Client Review', 'Approved', 'Postponed', 'Quality Review', 'Complete'].map(s => {
        const colors = { 'Not Started': '#d3d3d3', 'Working on': '#fdcb6e', 'Manager Review': '#6c5ce7', 'Back to You': '#e17055', 'Stuck': '#d63031', 'Waiting on Client': '#fd79a8', 'Client Review': '#a29bfe', 'Approved': '#00cec9', 'Postponed': '#636e72', 'Quality Review': '#74b9ff', 'Complete': '#00b894' };
        return { value: s, label: s, color: colors[s] || '#74b9ff' };
    });
    const priorityOpts = PRIORITIES.map(p => ({ value: p.value, label: p.label, color: p.color }));
    const tagOpts = _homeListAllTags.map(tg => ({ value: tg.name, label: tg.name, color: tg.color || '#6366f1' }));

    // My Tasks toggle — clear on/off with toggle switch
    const myTasksOn = !_homeListShowAll;
    const myTasksToggle = '<label class="hl-toggle" title="' + (myTasksOn ? 'Showing only your assigned tasks' : 'Showing all workspace tasks') + '">'
        + '<input type="checkbox" ' + (myTasksOn ? 'checked' : '') + ' onchange="homeListToggleShowAll()">'
        + '<span class="hl-toggle-track"><span class="hl-toggle-thumb"></span></span>'
        + '<span class="hl-toggle-label">My Tasks</span>'
        + '</label>';

    // Hide Completed toggle
    const hideCompletedToggle = '<label class="hl-toggle" title="' + (_homeListHideCompleted ? 'Completed tasks are hidden' : 'Showing completed tasks') + '">'
        + '<input type="checkbox" ' + (_homeListHideCompleted ? 'checked' : '') + ' onchange="homeListToggleHideCompleted()">'
        + '<span class="hl-toggle-track"><span class="hl-toggle-thumb"></span></span>'
        + '<span class="hl-toggle-label">Hide Completed</span>'
        + '</label>';

    let html = '<div class="home-list-view">'
        + '<div class="home-header">'
        + '<div class="home-header-top">'
        + '<div><h2>Welcome back' + userName + '</h2>'
        + '<span class="home-date">' + dateStr + '</span></div>'
        + '</div>'
        + '</div>'
        + '<div class="home-list-subheader">'
        + '<span class="home-list-subtitle">' + items.length + ' item' + (items.length !== 1 ? 's' : '') + ' across all spaces</span>'
        + '<div class="hl-toggles">'
        + myTasksToggle
        + hideCompletedToggle
        + '</div>'
        + '</div>'
        + '<div class="home-list-filters">'
        + '<input type="text" class="home-list-search" placeholder="Filter tasks..." value="' + esc(_homeListSearch) + '" oninput="homeListSearchChanged(this.value)">'
        + '<select class="home-list-filter-select" onchange="homeListFilterWorkspace(this.value)">' + wsOptions + '</select>'
        + renderMultiSelectDropdown('status', 'Status', statusOpts, _homeListStatusFilters, 'homeListFilterStatus')
        + renderMultiSelectDropdown('priority', 'Priority', priorityOpts, _homeListPriorityFilters, 'homeListFilterPriority')
        + renderMultiSelectDropdown('tag', 'Tags', tagOpts, _homeListTagFilters, 'homeListFilterTag')
        + '</div>'
        + renderBatchToolbar()
        + '<table class="th-list-table home-list-table"><thead><tr>'
        + '<th class="th-list-check-col"><input type="checkbox" class="th-batch-check" title="Select all" ' + (items.length > 0 && items.every(t => _selectedItems.has(t.id)) ? 'checked' : '') + ' onchange="batchToggleAllHome(this.checked)"></th>'
        + '<th class="sortable" ' + sortAttr('title') + '>Title' + sortIcon('title') + '</th>'
        + '<th class="sortable" ' + sortAttr('workspace_name') + '>Space' + sortIcon('workspace_name') + '</th>'
        + '<th class="sortable" ' + sortAttr('list_name') + '>List' + sortIcon('list_name') + '</th>'
        + '<th class="sortable" ' + sortAttr('status') + '>Status' + sortIcon('status') + '</th>'
        + '<th class="sortable" ' + sortAttr('priority') + '>Priority' + sortIcon('priority') + '</th>'
        + '<th class="sortable" ' + sortAttr('assignee') + '>Assignee' + sortIcon('assignee') + '</th>'
        + '<th class="sortable" ' + sortAttr('due_date') + '>Due' + sortIcon('due_date') + '</th>'
        + '<th class="sortable" ' + sortAttr('tags') + '>Tags' + sortIcon('tags') + '</th>'
        + '<th class="sortable" ' + sortAttr('updated_at') + '>Updated' + sortIcon('updated_at') + '</th>'
        + '</tr></thead><tbody>'
        + buildHomeListRows(items)
        + '</tbody></table></div>';
    el.innerHTML = html;
}

function filterHomeListItems(items) {
    let filtered = items;
    if (_homeListSearch) {
        const q = _homeListSearch.toLowerCase();
        filtered = filtered.filter(i =>
            (i.title || '').toLowerCase().includes(q) ||
            (i.workspace_name || '').toLowerCase().includes(q) ||
            (i.list_name || '').toLowerCase().includes(q) ||
            (i.status || '').toLowerCase().includes(q)
        );
    }
    return filtered;
}

function homeListSortBy(col) {
    if (_homeListSort === col) {
        _homeListDir = _homeListDir === 'asc' ? 'desc' : 'asc';
    } else {
        _homeListSort = col;
        _homeListDir = (col === 'title' || col === 'workspace_name' || col === 'list_name' || col === 'assignee' || col === 'tags') ? 'asc' : 'desc';
    }
    // Client-side sortable columns don't need API re-fetch
    const clientSortCols = ['workspace_name', 'list_name', 'assignee', 'tags'];
    if (clientSortCols.includes(col) && _homeListItems) {
        _homeListItems = sortHomeListItemsClient(_homeListItems, col, _homeListDir);
        renderHomeListTable(document.getElementById('main-content'));
    } else {
        _homeListItems = null;
        renderHomeListView(document.getElementById('main-content'));
    }
}

function sortHomeListItemsClient(items, col, dir) {
    const sorted = [...items];
    sorted.sort((a, b) => {
        let va, vb;
        if (col === 'workspace_name') {
            va = (a.workspace_name || '').toLowerCase();
            vb = (b.workspace_name || '').toLowerCase();
        } else if (col === 'list_name') {
            va = (a.list_name || '').toLowerCase();
            vb = (b.list_name || '').toLowerCase();
        } else if (col === 'assignee') {
            va = (a.assignees || []).map(x => resolveAssigneeName(x.assignee_id)).filter(Boolean).join(', ').toLowerCase();
            vb = (b.assignees || []).map(x => resolveAssigneeName(x.assignee_id)).filter(Boolean).join(', ').toLowerCase();
        } else if (col === 'tags') {
            va = (a.tags || []).map(t => t.name).join(', ').toLowerCase();
            vb = (b.tags || []).map(t => t.name).join(', ').toLowerCase();
        } else {
            va = (a[col] || '').toString().toLowerCase();
            vb = (b[col] || '').toString().toLowerCase();
        }
        if (va < vb) return dir === 'asc' ? -1 : 1;
        if (va > vb) return dir === 'asc' ? 1 : -1;
        return 0;
    });
    return sorted;
}

function homeListFilterStatus(vals) {
    _homeListStatusFilters = Array.isArray(vals) ? vals : [vals];
    if (vals === '' || (Array.isArray(vals) && !vals.length)) _homeListStatusFilters = [];
    _homeListItems = null;
    renderHomeListView(document.getElementById('main-content'));
}

function homeListFilterPriority(vals) {
    _homeListPriorityFilters = Array.isArray(vals) ? vals : [vals];
    if (vals === '' || (Array.isArray(vals) && !vals.length)) _homeListPriorityFilters = [];
    _homeListItems = null;
    renderHomeListView(document.getElementById('main-content'));
}

function homeListFilterWorkspace(val) {
    _homeListWorkspaceFilter = val;
    _homeListItems = null;
    renderHomeListView(document.getElementById('main-content'));
}

function homeListFilterTag(vals) {
    _homeListTagFilters = Array.isArray(vals) ? vals : [vals];
    if (vals === '' || (Array.isArray(vals) && !vals.length)) _homeListTagFilters = [];
    _homeListItems = null;
    renderHomeListView(document.getElementById('main-content'));
}

function homeListToggleShowAll() {
    _homeListShowAll = !_homeListShowAll;
    _homeListItems = null;
    renderHomeListView(document.getElementById('main-content'));
}

function homeListToggleHideCompleted() {
    _homeListHideCompleted = !_homeListHideCompleted;
    _homeListItems = null;
    renderHomeListView(document.getElementById('main-content'));
}

// Navigate from a dashboard tile's "+N more" to the full list view with appropriate sorting
function showAllFromTile(tileType) {
    _homeListItems = null;
    _homeListStatusFilters = [];
    _homeListPriorityFilters = [];
    _homeListTagFilters = [];
    _homeListWorkspaceFilter = '';
    _homeListSearch = '';
    if (tileType === 'overdue') {
        _homeListSort = 'due_date';
        _homeListDir = 'asc';
    } else if (tileType === 'due_week') {
        _homeListSort = 'due_date';
        _homeListDir = 'asc';
    } else if (tileType === 'follow_ups') {
        _homeListSort = 'follow_up_date';
        _homeListDir = 'asc';
    } else {
        _homeListSort = 'updated_at';
        _homeListDir = 'desc';
    }
    _currentView = 'list';
    _currentSpaceId = null;
    _currentListId = null;
    document.querySelectorAll('.th-view-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.th-view-btn[data-view="list"]')?.classList.add('active');
    renderMainContent();
}

// Click a tag pill anywhere to filter the home list by that tag
function filterByTag(tagName) {
    _homeListTagFilters = [tagName];
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
        const s = t.status || 'Not Started';
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
        // Postgres Changes INSERT listener will add the new task automatically
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

    const customIdHtml = t.custom_id ? '<span class="th-custom-id">' + esc(t.custom_id) + '</span>' : '';
    const subtaskBadge = t.subtask_count ? '<span class="th-subtask-badge" title="' + (t.subtask_done || 0) + '/' + t.subtask_count + ' done">&#9776; ' + (t.subtask_done || 0) + '/' + t.subtask_count + '</span>' : '';

    return '<div class="th-card' + (checked ? ' th-batch-selected' : '') + '" draggable="true" data-task-id="' + esc(t.id) + '" onclick="openDetail(\'' + esc(t.id) + '\')" oncontextmenu="showCtxMenu(event,\'task\',\'' + esc(t.id) + '\',\'' + esc((t.title || t.name || '').replace(/'/g, '')) + '\',\'' + esc(_currentSpaceId || '') + '\')">'
        + '<div class="th-card-check" onclick="event.stopPropagation()"><input type="checkbox" class="th-batch-check" ' + (checked ? 'checked' : '') + ' onchange="batchToggleItem(\'' + esc(t.id) + '\', this.checked)"></div>'
        + '<div class="th-card-title">' + customIdHtml + esc(t.title || t.name || '') + '</div>'
        + descPreview
        + '<div class="th-card-meta">'
        + '<span class="cu-status-pill" style="background:' + color + '22;color:' + color + ';">' + esc(t.status) + '</span>'
        + priorityHtml + dueHtml + fuHtml + subtaskBadge + assigneeHtml
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
        const isFav = _favorites.some(f => f.target_type === 'item' && f.target_id === t.id);
        headerActions.innerHTML = ''
            + '<button class="th-star-btn' + (isFav ? ' active' : '') + '" onclick="toggleFavorite(\'item\',\'' + esc(t.id) + '\')" title="' + (isFav ? 'Remove from favorites' : 'Add to favorites') + '">&#9733;</button>'
            + '<div style="position:relative;display:inline-block;"><button class="th-reminder-btn" onclick="toggleReminderDropdown(this,\'' + esc(t.id) + '\')" title="Set reminder">&#128276; Remind</button></div>'
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

    // Custom ID badge + Editable title
    if (t.custom_id) {
        html += '<span class="th-custom-id-header">' + esc(t.custom_id) + '</span>';
    }
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

    // Subtasks section
    html += '<div class="th-subtask-section">'
        + '<div class="th-subtask-header"><span>Subtasks</span>'
        + '<button class="btn btn-small btn-ghost" onclick="document.getElementById(\'subtask-add-input\').style.display=\'flex\'" style="font-size:11px;">+ Add</button></div>'
        + '<div class="th-subtask-list" id="detail-subtasks">';
    const subtasks = t.subtasks || [];
    for (const sub of subtasks) {
        const isDone = sub.status === 'done' || sub.status === 'closed' || sub.status === 'Complete';
        html += '<div class="th-subtask-row" onclick="openDetail(\'' + esc(sub.id) + '\')">'
            + '<div class="th-subtask-status' + (isDone ? ' done' : '') + '" onclick="event.stopPropagation();toggleSubtaskStatus(\'' + esc(sub.id) + '\',\'' + esc(sub.status) + '\')"></div>'
            + (sub.custom_id ? '<span class="th-custom-id">' + esc(sub.custom_id) + '</span>' : '')
            + '<span class="th-subtask-title' + (isDone ? ' done' : '') + '">' + esc(sub.title) + '</span>'
            + '</div>';
    }
    html += '</div>'
        + '<div class="th-subtask-add" id="subtask-add-input" style="display:none;">'
        + '<input type="text" placeholder="Subtask title..." onkeydown="if(event.key===\'Enter\'){createSubtask(\'' + esc(t.id) + '\',this.value);this.value=\'\';}">'
        + '</div></div>';

    // Dependencies section (Phase 2)
    html += '<div class="th-dep-section">'
        + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">'
        + '<span style="font-size:13px;font-weight:600;">Dependencies</span>'
        + '<button class="btn btn-small btn-ghost" onclick="openDepPicker()" style="font-size:11px;">+ Add</button></div>'
        + '<div id="dep-picker" style="display:none;margin-bottom:8px;"></div>'
        + '<div id="detail-dependencies">Loading...</div></div>';

    // Custom Fields section (Phase 2)
    if (_customFields.length) {
        html += '<div class="th-cf-section">'
            + '<div style="font-size:13px;font-weight:600;margin-bottom:6px;">Custom Fields</div>'
            + '<div id="detail-custom-fields">Loading...</div></div>';
    }

    // Time Tracking section (Phase 2)
    html += '<div class="th-time-section">'
        + '<div style="font-size:13px;font-weight:600;margin-bottom:6px;">Time Tracking</div>'
        + '<div id="detail-time-tracking">Loading...</div></div>';

    // Checklists section
    html += '<div class="th-checklist-section" id="detail-checklists">'
        + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">'
        + '<span style="font-size:13px;font-weight:600;">Checklists</span>'
        + '<button class="btn btn-small btn-ghost" onclick="createChecklist(\'' + esc(t.id) + '\')" style="font-size:11px;">+ Add Checklist</button>'
        + '</div>'
        + '<div id="checklists-container">Loading...</div>'
        + '</div>';

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
        + '<textarea class="th-comment-input" id="comment-input" rows="1" placeholder="Add a comment... (Shift+Enter for new line)" onkeydown="commentKeyHandler(event)" oninput="autoResizeComment(this)"></textarea>'
        + '<button class="btn btn-small btn-ghost th-comment-img-btn" onclick="commentUploadImage()" title="Attach image">&#128247;</button>'
        + '<button class="btn btn-accent btn-small" onclick="postComment()">Send</button>'
        + '</div>'
        + '<div class="th-comment-format-hint">**bold** *italic* `code` - list</div>'
        + '<div id="comment-image-preview" class="th-comment-img-preview" style="display:none;"></div>'
        + '</div></div>';

    body.innerHTML = html;

    // Render markdown description in pretty mode
    renderDescription(t.description || '');

    // Bind @mention autocomplete on comment input
    bindMentionAutocomplete();

    // Bind paste handler for image paste in comments
    bindCommentPasteHandler();

    // Load comments, files, checklists, and Phase 2 sections async
    loadDetailComments();
    loadDetailFiles();
    loadDetailChecklists();
    loadDetailDependencies();
    loadDetailCustomFields();
    renderTimeTracking();
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
    const replaced = before.replace(/@\w*$/, '@[' + member.name + '](' + member.id + ') ');
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
    if (_currentView === 'dashboard') loadDashboard();
    else { renderMainContent(); }
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
            status: t.status || 'Not Started',
            priority: t.priority || 'none',
        });
        showToast('Item duplicated');
        // Postgres Changes INSERT listener will add the new task automatically
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
        // Remove from current list locally — Postgres Changes will handle the update
        if (_detailTask) _tasks = _tasks.filter(t => t.id !== _detailTask.id);
        renderMainContent();
    } catch (err) {
        showToast('Failed to move: ' + (err.message || 'Unknown error'));
    }
}

// ── Field Updates ────────────────────────────────────────────

function _syncHomeDataForItem(task) {
    // Sync _homeData arrays in-place after a due_date or status change
    if (!_homeData) return;
    const today = new Date().toISOString().slice(0, 10);
    const closedStatuses = new Set(['done', 'closed', 'archived', 'Complete']);
    const isClosed = closedStatuses.has(task.status);
    const isOverdue = task.due_date && task.due_date < today && !isClosed;

    // Helper: remove item from an array by id
    const removeById = (arr, id) => { const idx = arr.findIndex(x => x.id === id); if (idx >= 0) arr.splice(idx, 1); };
    // Helper: upsert item in an array (replace or push)
    const upsertById = (arr, item) => { const idx = arr.findIndex(x => x.id === item.id); if (idx >= 0) arr[idx] = item; else arr.push(item); };

    // Build a slim item object matching the shape returned by /my/home
    const slim = { id: task.id, type: task.type, title: task.title, status: task.status,
        priority: task.priority, due_date: task.due_date, follow_up_date: task.follow_up_date,
        workspace_id: task.workspace_id, created_at: task.created_at, updated_at: task.updated_at };

    // Overdue tile
    if (_homeData.overdue) {
        if (isOverdue) { upsertById(_homeData.overdue, slim); _homeData.overdue.sort((a, b) => (b.due_date || '').localeCompare(a.due_date || '')); }
        else removeById(_homeData.overdue, task.id);
    }

    // Due this week tile
    if (_homeData.due_this_week) {
        const weekFromNow = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
        const isDueThisWeek = task.due_date && task.due_date >= today && task.due_date <= weekFromNow && !isClosed;
        if (isDueThisWeek) { upsertById(_homeData.due_this_week, slim); _homeData.due_this_week.sort((a, b) => (a.due_date || '').localeCompare(b.due_date || '')); }
        else removeById(_homeData.due_this_week, task.id);
    }

    // Recent todos / top items — update in place if present
    for (const key of ['recent_todos', 'top_items', 'priorities']) {
        if (_homeData[key]) {
            const idx = _homeData[key].findIndex(x => x.id === task.id);
            if (idx >= 0) _homeData[key][idx] = slim;
        }
    }
}

async function updateField(field, value) {
    if (!_detailTask) return;
    const oldVal = _detailTask[field];
    if (value === oldVal) return;

    const onHomePage = !_currentListId && _currentView !== 'list' && _currentView !== 'calendar' && _currentView !== 'dashboard';

    _detailTask[field] = value;
    // Update local tasks array too
    const localTask = _tasks.find(t => t.id === _detailTask.id);
    if (localTask) localTask[field] = value;

    // Optimistic: sync home data in-place and re-render tiles (no server refetch)
    if (onHomePage && _homeData) {
        _syncHomeDataForItem(_detailTask);
        renderHomeTiles();
    } else {
        renderMainContent();
    }

    try {
        await api('PATCH', API + '/items/' + _detailTask.id, { [field]: value || null });
        broadcast('task_updated', { taskId: _detailTask.id, changes: { [field]: value }, listId: _currentListId });
    } catch {
        _detailTask[field] = oldVal;
        if (localTask) localTask[field] = oldVal;
        // Revert home data sync
        if (onHomePage && _homeData) {
            _syncHomeDataForItem(_detailTask);
            renderHomeTiles();
        } else {
            renderMainContent();
        }
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

function commentKeyHandler(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        postComment();
    }
}

function autoResizeComment(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}

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
    // Render structured @[Name](id) mentions as pills
    result = result.replace(/@\[([^\]]+)\]\([0-9a-f\-]{36}\)/g, (match, name) => {
        return '<span class="th-mention-pill">@' + name + '</span>';
    });
    // Render legacy @mentions
    result = result.replace(/@(\w[\w\s]*?\w|\w)/g, (match) => {
        return '<span class="mention">' + match + '</span>';
    });
    // Basic markdown formatting for comments
    result = result.replace(/`([^`]+)`/g, '<code class="th-comment-code">$1</code>');
    result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    // Convert newlines to <br> for multiline comments
    result = result.replace(/\n/g, '<br>');
    // Simple unordered list lines: "- item" at start of line (after <br> or start)
    result = result.replace(/(^|<br>)- ([^<]+)/g, '$1<span class="th-comment-li">&bull; $2</span>');
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
            + '<select class="form-select" id="cn-task-status"><option value="Not Started">Not Started</option></select></div>'
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
            if (!sts.length) statusSel.innerHTML = '<option value="Not Started">Not Started</option>';
        } catch {
            statusSel.innerHTML = '<option value="Not Started">Not Started</option>';
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
                status: document.getElementById('cn-task-status')?.value || 'Not Started',
                priority: document.getElementById('cn-task-priority')?.value || 'medium',
                due_date: document.getElementById('cn-task-due')?.value || null,
            };
            await api('POST', API + '/lists/' + listId + '/items', data);
            showToast('Task created!');
            // Postgres Changes INSERT listener will add the new task if viewing this list
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
    const hub = _myHub();
    document.getElementById('settings-space-label').textContent = hub
        ? (hub.icon || '🏢') + ' ' + hub.name + ' Settings'
        : 'TeamHub Settings';

    // Bind sidebar nav click handlers
    modal.querySelectorAll('.settings-nav-item').forEach(btn => {
        btn.onclick = () => switchSettingsTab(btn.dataset.tab);
    });

    _settingsTab = 'statuses';
    switchSettingsTab('statuses');
    await loadSettingsData();
}

async function loadSettingsData() {
    const hub = _myHub();

    if (hub) {
        // Hub mode: load from hub-level statuses/tags
        try {
            const data = await api('GET', API + '/hubs/' + hub.id + '/statuses');
            _settingsStatuses = data.statuses || [];
        } catch { _settingsStatuses = []; }
        try {
            const data = await api('GET', API + '/hubs/' + hub.id + '/tags');
            _settingsTags = data.tags || [];
        } catch { _settingsTags = []; }
    } else {
        // Legacy mode: load from personal workspace
        const wsId = _myPersonalSpaceId();
        if (!wsId) {
            _settingsStatuses = [];
            _settingsTags = [];
            renderSettingsTab();
            return;
        }
        try {
            const data = await api('GET', API + '/workspaces/' + wsId + '/statuses');
            _settingsStatuses = data.statuses || [];
        } catch { _settingsStatuses = []; }
        try {
            const data = await api('GET', API + '/workspaces/' + wsId + '/tags');
            _settingsTags = data.tags || [];
        } catch { _settingsTags = []; }
    }

    // Load custom fields and automations for current workspace
    const activeWs = _currentSpaceId || _myPersonalSpaceId();
    if (activeWs) {
        await loadCustomFields(activeWs);
        await loadAutomations(activeWs);
    }

    renderSettingsTab();
}

function switchSettingsTab(tab) {
    _settingsTab = tab;
    // Toggle active class on sidebar nav items
    document.querySelectorAll('#settings-modal .settings-nav-item').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    // Show/hide content divs
    const tabs = ['statuses','priorities','tags','import','landing','members','custom-fields','automations','discord-ai'];
    tabs.forEach(t => {
        const el = document.getElementById('settings-tab-' + t);
        if (el) el.style.display = t === tab ? '' : 'none';
    });
    renderSettingsTab();
}

function renderSettingsTab() {
    if (_settingsTab === 'statuses') renderSettingsStatuses();
    else if (_settingsTab === 'priorities') renderSettingsPriorities();
    else if (_settingsTab === 'tags') renderSettingsTags();
    else if (_settingsTab === 'import') renderSettingsImport();
    else if (_settingsTab === 'landing') renderSettingsLanding();
    else if (_settingsTab === 'members') renderSettingsMembers();
    else if (_settingsTab === 'custom-fields') renderSettingsCustomFields();
    else if (_settingsTab === 'automations') renderSettingsAutomations();
    else if (_settingsTab === 'discord-ai') renderSettingsDiscordAI();
}

function renderSettingsStatuses() {
    const el = document.getElementById('settings-tab-statuses');
    const isOwner = _isSettingsOwner();
    const hubMode = !!_myHub();
    let html = '<div class="settings-info-box">' + (isOwner
        ? (hubMode ? 'Manage hub-wide workflow statuses. These apply to all spaces in the hub.' : 'Manage the workflow statuses for this space. Statuses define the lifecycle of your tasks.')
        : (hubMode ? 'These statuses are managed by hub admins and apply to all spaces.' : 'These statuses are managed by the workspace owner. You can still assign them to tasks.')) + '</div>';
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

function _settingsStatusUrl(action, statusId) {
    const hub = _myHub();
    if (hub) {
        if (action === 'create') return API + '/hubs/' + hub.id + '/statuses';
        return API + '/hubs/' + hub.id + '/statuses/' + statusId;
    }
    const wsId = _myPersonalSpaceId();
    if (action === 'create') return API + '/workspaces/' + wsId + '/statuses';
    return API + '/statuses/' + statusId;
}

function _settingsTagUrl(action, tagId) {
    const hub = _myHub();
    if (hub) {
        if (action === 'create') return API + '/hubs/' + hub.id + '/tags';
        return API + '/hubs/' + hub.id + '/tags/' + tagId;
    }
    const wsId = _myPersonalSpaceId();
    if (action === 'create') return API + '/workspaces/' + wsId + '/tags';
    return API + '/workspaces/' + wsId + '/tags/' + tagId;
}

async function addSettingsStatus() {
    if (!_isSettingsOwner()) { showToast('Only the workspace owner can manage statuses'); return; }
    const name = document.getElementById('settings-new-status-name')?.value?.trim();
    const color = document.getElementById('settings-new-status-color')?.value || '#6c5ce7';
    const type = document.getElementById('settings-new-status-type')?.value || 'active';
    if (!name) { showToast('Enter a status name'); return; }
    try {
        await api('POST', _settingsStatusUrl('create'), { name, color, type });
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
        await api('PATCH', _settingsStatusUrl('update', statusId), body);
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
        await api('DELETE', _settingsStatusUrl('delete', statusId));
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
    const hubMode = !!_myHub();
    let html = '<div class="settings-info-box">' + (isOwner
        ? (hubMode ? 'Manage hub-wide tags. These are available across all spaces in the hub.' : 'Tags help categorize and filter tasks. Create workspace-level tags that can be applied to any task in this space.')
        : (hubMode ? 'These tags are managed by hub admins and are available across all spaces.' : 'These tags are managed by the workspace owner. You can still assign them to tasks.')) + '</div>';
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
    const name = document.getElementById('settings-new-tag-name')?.value?.trim();
    const color = document.getElementById('settings-new-tag-color')?.value || '#6366f1';
    if (!name) { showToast('Enter a tag name'); return; }
    try {
        await api('POST', _settingsTagUrl('create'), { name, color });
        showToast('Tag added');
        document.getElementById('settings-new-tag-name').value = '';
        _syncSettingsToAllSpaces();
        await loadSettingsData();
    } catch { showToast('Failed to add tag'); }
}

async function updateSettingsTag(tagId, newName, newColor) {
    if (!_isSettingsOwner()) { showToast('Only the workspace owner can manage tags'); return; }
    const body = {};
    if (newName) body.name = newName;
    if (newColor) body.color = newColor;
    try {
        await api('PATCH', _settingsTagUrl('update', tagId), body);
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
    if (!confirm('Delete tag "' + name + '"? It will be removed from all tasks.')) return;
    try {
        await api('DELETE', _settingsTagUrl('delete', tagId));
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
        const isCustom = tile.custom;
        const customActions = isCustom
            ? '<button class="btn btn-ghost btn-small" onclick="openCustomTileWizard(\'' + esc(tile.id) + '\')" title="Edit" style="padding:2px 6px;font-size:11px;">'
              + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>'
              + '</button>'
              + '<button class="btn btn-ghost btn-small" onclick="deleteCustomTile(\'' + esc(tile.id) + '\')" title="Delete" style="padding:2px 6px;font-size:11px;color:var(--red);">'
              + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
              + '</button>'
            : '';
        html += '<div class="settings-item landing-tile-item" draggable="true" data-tile-id="' + esc(tile.id) + '">'
            + '<span class="landing-drag-handle" title="Drag to reorder">&#9776;</span>'
            + '<label class="landing-toggle-label">'
            + '<input type="checkbox"' + checked + ' onchange="toggleLandingTile(\'' + esc(tile.id) + '\', this.checked)">'
            + '<span class="settings-item-name">' + esc(tile.title) + (isCustom ? ' <span style="color:var(--accent);font-size:10px;">(custom)</span>' : '') + '</span>'
            + '</label>'
            + customActions
            + '<span class="landing-size-btn" onclick="toggleLandingTileSize(\'' + esc(tile.id) + '\')" title="Click to cycle size">' + esc(sizeLabel) + '</span>'
            + '</div>';
    }
    html += '</div>';
    html += '<div style="margin-top:12px;display:flex;gap:8px;">'
        + '<button class="btn btn-ghost btn-small" onclick="resetLandingDefaults()">Reset to Defaults</button>'
        + '<button class="btn btn-accent btn-small" onclick="openCustomTileWizard()">+ Custom Tile</button>'
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

// ── Custom Tile Wizard ──────────────────────────────────────

let _customWizardStep = 1;
let _customWizardEditId = null;
let _customWizardConditions = [];
let _customWizardTitle = 'My Custom Tile';
let _customWizardSort = 'updated_at';
let _customWizardSortDir = 'desc';
let _customWizardLimit = 25;
let _customWizardSize = '1x1';
let _customWizardMode = 'manual'; // 'manual' | 'ai'
let _customWizardPreviewData = null;
let _customWizardPreviewTimer = null;

const CRITERIA_FIELDS = [
    { value: 'workspace_id', label: 'Workspace', type: 'workspace' },
    { value: 'status', label: 'Status', type: 'multi', options: ['Not Started', 'Working on', 'Manager Review', 'Back to You', 'Stuck', 'Waiting on Client', 'Client Review', 'Approved', 'Postponed', 'Quality Review', 'Complete'] },
    { value: 'priority', label: 'Priority', type: 'multi', options: ['critical', 'high', 'medium', 'low', 'none'] },
    { value: 'assignee_id', label: 'Assignee', type: 'assignee' },
    { value: 'due_date', label: 'Due Date', type: 'date' },
    { value: 'follow_up_date', label: 'Follow-up Date', type: 'date' },
    { value: 'type', label: 'Type', type: 'multi', options: ['task', 'note', 'idea', 'decision', 'bug'] },
    { value: 'tag', label: 'Tag', type: 'tag' },
    { value: 'list_id', label: 'List', type: 'text' },
];

const CRITERIA_OPS = {
    default: [
        { value: 'eq', label: 'equals' },
        { value: 'neq', label: 'not equal' },
        { value: 'in', label: 'in' },
        { value: 'not_in', label: 'not in' },
    ],
    date: [
        { value: 'eq', label: 'equals' },
        { value: 'lt', label: 'before' },
        { value: 'lte', label: 'on or before' },
        { value: 'gt', label: 'after' },
        { value: 'gte', label: 'on or after' },
    ],
};

const DATE_PRESETS = [
    { value: 'today', label: 'Today' },
    { value: 'this_week', label: 'This week' },
    { value: 'this_month', label: 'This month' },
    { value: 'relative:7d', label: 'Next 7 days' },
    { value: 'relative:14d', label: 'Next 14 days' },
    { value: 'relative:30d', label: 'Next 30 days' },
    { value: 'relative:-1d', label: 'Yesterday' },
    { value: 'relative:-3d', label: '3 days ago' },
    { value: 'relative:-7d', label: '7 days ago' },
];

function openCustomTileWizard(editId) {
    _customWizardEditId = editId || null;
    _customWizardStep = 1;
    _customWizardMode = 'manual';
    _customWizardPreviewData = null;

    if (editId) {
        const layout = _homeLayout || loadHomeLayout();
        const tile = layout.tiles.find(t => t.id === editId);
        if (tile) {
            _customWizardTitle = tile.title || 'My Custom Tile';
            _customWizardConditions = JSON.parse(JSON.stringify(tile.criteria?.conditions || []));
            _customWizardSort = tile.criteria?.sort || 'updated_at';
            _customWizardSortDir = tile.criteria?.sort_dir || 'desc';
            _customWizardLimit = tile.criteria?.limit || 25;
            _customWizardSize = tile.size || '1x1';
        }
    } else {
        _customWizardTitle = 'My Custom Tile';
        _customWizardConditions = [];
        _customWizardSort = 'updated_at';
        _customWizardSortDir = 'desc';
        _customWizardLimit = 25;
        _customWizardSize = '1x1';
    }

    renderCustomWizard();
}

function renderCustomWizard() {
    // Remove existing wizard if present
    let overlay = document.getElementById('custom-tile-wizard-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'custom-tile-wizard-overlay';
        overlay.className = 'modal-overlay visible';
        document.body.appendChild(overlay);
    }

    const isEdit = !!_customWizardEditId;
    const stepTitles = ['Name & Mode', 'Criteria Builder', 'Preview & Confirm'];

    let html = '<div class="modal" style="max-width:640px;">'
        + '<button class="modal-close" onclick="closeCustomTileWizard()">&times;</button>'
        + '<div class="modal-title">' + (isEdit ? 'Edit' : 'New') + ' Custom Tile</div>'
        + '<div class="custom-tile-wizard-steps">';

    for (let i = 1; i <= 3; i++) {
        const active = i === _customWizardStep ? ' active' : '';
        const done = i < _customWizardStep ? ' done' : '';
        html += '<div class="custom-tile-wizard-step-indicator' + active + done + '">'
            + '<span class="step-num">' + i + '</span> ' + stepTitles[i - 1] + '</div>';
    }
    html += '</div>';

    if (_customWizardStep === 1) {
        html += renderWizardStep1();
    } else if (_customWizardStep === 2) {
        html += renderWizardStep2();
    } else {
        html += renderWizardStep3();
    }

    html += '</div>';
    overlay.innerHTML = html;
    overlay.style.display = 'flex';

    // Trigger live preview if on step 2
    if (_customWizardStep === 2) {
        refreshCustomTilePreview();
    }
}

function renderWizardStep1() {
    let html = '<div class="custom-tile-wizard-body">';
    html += '<div class="form-group">'
        + '<label class="form-label">Tile Name</label>'
        + '<input class="form-input" id="ctw-title" value="' + esc(_customWizardTitle) + '" placeholder="My Custom Tile" onchange="_customWizardTitle=this.value">'
        + '</div>';

    html += '<div class="form-group">'
        + '<label class="form-label">Build Mode</label>'
        + '<div class="ai-mode-toggle">'
        + '<button class="btn btn-small' + (_customWizardMode === 'manual' ? ' btn-accent' : ' btn-ghost') + '" onclick="_customWizardMode=\'manual\';renderCustomWizard()">Manual</button>'
        + '<button class="btn btn-small' + (_customWizardMode === 'ai' ? ' btn-accent' : ' btn-ghost') + '" onclick="_customWizardMode=\'ai\';renderCustomWizard()">AI Assist</button>'
        + '</div>'
        + '</div>';

    if (_customWizardMode === 'ai') {
        html += '<div class="form-group">'
            + '<label class="form-label">Describe what you want to see</label>'
            + '<textarea class="form-input" id="ctw-ai-desc" rows="3" placeholder="e.g. Show me overdue high priority tasks across all projects"></textarea>'
            + '<button class="btn btn-accent btn-small" style="margin-top:8px;" onclick="generateCustomTileCriteria()" id="ctw-ai-btn">Generate Criteria</button>'
            + '<div id="ctw-ai-status" style="font-size:12px;color:var(--text-muted);margin-top:6px;"></div>'
            + '</div>';
    }

    html += '<div class="wizard-actions">'
        + '<button class="btn btn-ghost" onclick="closeCustomTileWizard()">Cancel</button>'
        + '<button class="btn btn-accent" onclick="wizardGoStep(2)">Next</button>'
        + '</div></div>';
    return html;
}

function renderWizardStep2() {
    let html = '<div class="custom-tile-wizard-body">';

    // Condition rows
    html += '<div class="form-group"><label class="form-label">Conditions</label>';
    html += '<div id="ctw-conditions">';
    _customWizardConditions.forEach((cond, idx) => {
        html += renderConditionRow(idx, cond);
    });
    html += '</div>';
    html += '<button class="btn btn-ghost btn-small criteria-add-btn" onclick="addWizardCondition()">+ Add Condition</button>';
    html += '</div>';

    // Sort
    html += '<div class="form-group" style="display:flex;gap:12px;">'
        + '<div style="flex:1;">'
        + '<label class="form-label">Sort by</label>'
        + '<select class="form-input" onchange="_customWizardSort=this.value;refreshCustomTilePreview()">';
    for (const f of CRITERIA_FIELDS) {
        html += '<option value="' + f.value + '"' + (_customWizardSort === f.value ? ' selected' : '') + '>' + f.label + '</option>';
    }
    html += '</select></div>'
        + '<div style="flex:1;">'
        + '<label class="form-label">Direction</label>'
        + '<select class="form-input" onchange="_customWizardSortDir=this.value;refreshCustomTilePreview()">'
        + '<option value="asc"' + (_customWizardSortDir === 'asc' ? ' selected' : '') + '>Ascending</option>'
        + '<option value="desc"' + (_customWizardSortDir === 'desc' ? ' selected' : '') + '>Descending</option>'
        + '</select></div></div>';

    // Limit
    html += '<div class="form-group">'
        + '<label class="form-label">Max items</label>'
        + '<input class="form-input" type="number" min="1" max="100" value="' + _customWizardLimit + '" onchange="_customWizardLimit=parseInt(this.value)||25;refreshCustomTilePreview()">'
        + '</div>';

    // Live preview
    html += '<div class="form-group">'
        + '<label class="form-label">Preview</label>'
        + '<div class="custom-tile-preview" id="ctw-preview"><div class="home-tile-empty">Add conditions and preview will appear here</div></div>'
        + '</div>';

    html += '<div class="wizard-actions">'
        + '<button class="btn btn-ghost" onclick="wizardGoStep(1)">Back</button>'
        + '<button class="btn btn-accent" onclick="wizardGoStep(3)">Next</button>'
        + '</div></div>';
    return html;
}

function renderConditionRow(idx, cond) {
    const fieldDef = CRITERIA_FIELDS.find(f => f.value === cond.field) || CRITERIA_FIELDS[0];
    const isDate = fieldDef.type === 'date';
    const ops = isDate ? CRITERIA_OPS.date : CRITERIA_OPS.default;

    let html = '<div class="criteria-row">';

    // Field dropdown
    html += '<select class="form-input criteria-field" onchange="updateConditionField(' + idx + ', this.value)">';
    for (const f of CRITERIA_FIELDS) {
        html += '<option value="' + f.value + '"' + (cond.field === f.value ? ' selected' : '') + '>' + f.label + '</option>';
    }
    html += '</select>';

    // Operator dropdown
    html += '<select class="form-input criteria-op" onchange="updateConditionOp(' + idx + ', this.value)">';
    for (const o of ops) {
        html += '<option value="' + o.value + '"' + (cond.op === o.value ? ' selected' : '') + '>' + o.label + '</option>';
    }
    html += '</select>';

    // Value input — contextual based on field type
    html += renderConditionValue(idx, cond, fieldDef);

    // Remove button
    html += '<button class="btn btn-ghost btn-small" onclick="removeWizardCondition(' + idx + ')" style="padding:4px 6px;color:var(--red);">&times;</button>';
    html += '</div>';
    return html;
}

function renderConditionValue(idx, cond, fieldDef) {
    const currentVal = cond.value;
    const isMulti = cond.op === 'in' || cond.op === 'not_in';

    if (fieldDef.type === 'date') {
        // Date presets
        let html = '<div class="criteria-value">'
            + '<select class="form-input" onchange="updateConditionValue(' + idx + ', this.value)">'
            + '<option value="">Select...</option>';
        for (const p of DATE_PRESETS) {
            html += '<option value="' + p.value + '"' + (currentVal === p.value ? ' selected' : '') + '>' + p.label + '</option>';
        }
        html += '</select></div>';
        return html;
    }

    if (fieldDef.type === 'multi' && fieldDef.options) {
        // Multi-select checkboxes for in/not_in, single select for eq/neq
        const selectedVals = Array.isArray(currentVal) ? currentVal : (currentVal ? [currentVal] : []);
        if (isMulti) {
            let html = '<div class="criteria-value criteria-value-multi">';
            for (const opt of fieldDef.options) {
                const checked = selectedVals.includes(opt) ? ' checked' : '';
                html += '<label class="criteria-check-label">'
                    + '<input type="checkbox"' + checked + ' onchange="toggleConditionMultiValue(' + idx + ', \'' + opt + '\', this.checked)">'
                    + '<span>' + esc(opt) + '</span></label>';
            }
            html += '</div>';
            return html;
        } else {
            let html = '<select class="form-input criteria-value" onchange="updateConditionValue(' + idx + ', this.value)">'
                + '<option value="">Select...</option>';
            for (const opt of fieldDef.options) {
                html += '<option value="' + opt + '"' + (currentVal === opt ? ' selected' : '') + '>' + esc(opt) + '</option>';
            }
            html += '</select>';
            return html;
        }
    }

    if (fieldDef.type === 'workspace') {
        const selectedVals = Array.isArray(currentVal) ? currentVal : (currentVal ? [currentVal] : []);
        if (isMulti) {
            let html = '<div class="criteria-value criteria-value-multi">';
            for (const s of _spaces) {
                const checked = selectedVals.includes(s.id) ? ' checked' : '';
                html += '<label class="criteria-check-label">'
                    + '<input type="checkbox"' + checked + ' onchange="toggleConditionMultiValue(' + idx + ', \'' + s.id + '\', this.checked)">'
                    + '<span>' + esc(s.name) + '</span></label>';
            }
            html += '</div>';
            return html;
        } else {
            let html = '<select class="form-input criteria-value" onchange="updateConditionValue(' + idx + ', this.value)">'
                + '<option value="">All workspaces</option>';
            for (const s of _spaces) {
                html += '<option value="' + s.id + '"' + (currentVal === s.id ? ' selected' : '') + '>' + esc(s.name) + '</option>';
            }
            html += '</select>';
            return html;
        }
    }

    if (fieldDef.type === 'assignee') {
        const selectedVals = Array.isArray(currentVal) ? currentVal : (currentVal ? [currentVal] : []);
        if (isMulti) {
            let html = '<div class="criteria-value criteria-value-multi">';
            for (const p of _profiles) {
                const name = p.display_name || p.email || p.id;
                const checked = selectedVals.includes(p.id) ? ' checked' : '';
                html += '<label class="criteria-check-label">'
                    + '<input type="checkbox"' + checked + ' onchange="toggleConditionMultiValue(' + idx + ', \'' + p.id + '\', this.checked)">'
                    + '<span>' + esc(name) + '</span></label>';
            }
            html += '</div>';
            return html;
        } else {
            let html = '<select class="form-input criteria-value" onchange="updateConditionValue(' + idx + ', this.value)">'
                + '<option value="">Anyone</option>';
            for (const p of _profiles) {
                const name = p.display_name || p.email || p.id;
                html += '<option value="' + p.id + '"' + (currentVal === p.id ? ' selected' : '') + '>' + esc(name) + '</option>';
            }
            html += '</select>';
            return html;
        }
    }

    // Default: text input
    const val = Array.isArray(currentVal) ? currentVal.join(', ') : (currentVal || '');
    return '<input class="form-input criteria-value" value="' + esc(val) + '" placeholder="Value..." onchange="updateConditionValue(' + idx + ', this.value)">';
}

function addWizardCondition() {
    _customWizardConditions.push({ field: 'status', op: 'in', value: [] });
    renderCustomWizard();
}

function removeWizardCondition(idx) {
    _customWizardConditions.splice(idx, 1);
    renderCustomWizard();
}

function updateConditionField(idx, field) {
    _customWizardConditions[idx].field = field;
    const fieldDef = CRITERIA_FIELDS.find(f => f.value === field);
    // Reset op and value when field changes
    if (fieldDef?.type === 'date') {
        _customWizardConditions[idx].op = 'lte';
        _customWizardConditions[idx].value = '';
    } else {
        _customWizardConditions[idx].op = 'in';
        _customWizardConditions[idx].value = [];
    }
    renderCustomWizard();
}

function updateConditionOp(idx, op) {
    const oldOp = _customWizardConditions[idx].op;
    _customWizardConditions[idx].op = op;
    const wasMulti = oldOp === 'in' || oldOp === 'not_in';
    const isMulti = op === 'in' || op === 'not_in';
    // Convert value between array/scalar when switching multi/single
    if (wasMulti && !isMulti) {
        const val = _customWizardConditions[idx].value;
        _customWizardConditions[idx].value = Array.isArray(val) ? (val[0] || '') : val;
    } else if (!wasMulti && isMulti) {
        const val = _customWizardConditions[idx].value;
        _customWizardConditions[idx].value = val ? [val] : [];
    }
    renderCustomWizard();
}

function updateConditionValue(idx, value) {
    _customWizardConditions[idx].value = value;
    refreshCustomTilePreview();
}

function toggleConditionMultiValue(idx, val, checked) {
    let current = _customWizardConditions[idx].value;
    if (!Array.isArray(current)) current = current ? [current] : [];
    if (checked && !current.includes(val)) current.push(val);
    if (!checked) current = current.filter(v => v !== val);
    _customWizardConditions[idx].value = current;
    refreshCustomTilePreview();
}

function refreshCustomTilePreview() {
    clearTimeout(_customWizardPreviewTimer);
    _customWizardPreviewTimer = setTimeout(async () => {
        const previewEl = document.getElementById('ctw-preview');
        if (!previewEl) return;

        // Only fetch if we have conditions
        const validConditions = _customWizardConditions.filter(c => c.field && c.op && c.value && (Array.isArray(c.value) ? c.value.length : true));
        if (!validConditions.length) {
            previewEl.innerHTML = '<div class="home-tile-empty">Add conditions to see a preview</div>';
            return;
        }

        previewEl.innerHTML = '<div style="text-align:center;padding:12px;"><div class="spinner" style="width:20px;height:20px;"></div></div>';

        try {
            const criteria = {
                conditions: validConditions,
                sort: _customWizardSort,
                sort_dir: _customWizardSortDir,
                limit: Math.min(_customWizardLimit, 10), // preview limit
            };
            const result = await api('POST', API + '/my/custom-tile', criteria);
            _customWizardPreviewData = result;

            if (!result.items?.length) {
                previewEl.innerHTML = '<div class="home-tile-empty">No items match these criteria</div>';
                return;
            }

            const pri = { critical: '#e17055', high: '#fdcb6e', medium: '#74b9ff', low: '#8b8e96', none: '#595d66' };
            const statusColor = (s) => {
        const m = { 'done': '#00b894', 'Complete': '#00b894', 'Approved': '#00cec9',
            'in_progress': '#fdcb6e', 'Working on': '#fdcb6e',
            'closed': '#636e72', 'Postponed': '#636e72',
            'review': '#6c5ce7', 'Manager Review': '#6c5ce7', 'Quality Review': '#74b9ff',
            'Client Review': '#a29bfe', 'Back to You': '#e17055', 'Stuck': '#d63031',
            'Waiting on Client': '#fd79a8', 'Not Started': '#d3d3d3' };
        return m[s] || '#74b9ff';
    };

            let previewHtml = result.items.slice(0, 8).map(i => {
                const pColor = pri[i.priority] || '#595d66';
                return '<div class="home-tile-item">'
                    + '<span class="home-tile-status-dot" style="background:' + statusColor(i.status) + ';"></span>'
                    + '<span class="home-tile-item-title">' + esc(i.title) + '</span>'
                    + '<span class="cu-priority-pill" style="background:' + pColor + '22;color:' + pColor + ';font-size:10px;">' + esc(i.priority || 'none') + '</span>'
                    + '</div>';
            }).join('');

            if (result.total > result.items.length) {
                previewHtml += '<div class="custom-tile-preview-count">' + result.total + ' total items</div>';
            }
            previewEl.innerHTML = previewHtml;
        } catch {
            previewEl.innerHTML = '<div class="home-tile-empty" style="color:var(--red);">Preview failed</div>';
        }
    }, 300);
}

function renderWizardStep3() {
    let html = '<div class="custom-tile-wizard-body">';

    // Full preview
    html += '<div class="form-group">'
        + '<label class="form-label">Tile Preview: ' + esc(_customWizardTitle) + '</label>'
        + '<div class="custom-tile-preview" id="ctw-preview-final" style="min-height:120px;">'
        + '<div class="home-tile-empty">Loading preview...</div>'
        + '</div></div>';

    // Size selector
    html += '<div class="form-group">'
        + '<label class="form-label">Tile Size</label>'
        + '<div class="ai-mode-toggle">';
    for (const s of TILE_SIZES) {
        html += '<button class="btn btn-small' + (_customWizardSize === s ? ' btn-accent' : ' btn-ghost') + '" onclick="_customWizardSize=\'' + s + '\';renderCustomWizard()">' + s + '</button>';
    }
    html += '</div></div>';

    // Summary
    html += '<div class="settings-info-box" style="font-size:12px;">'
        + '<strong>Conditions:</strong> ' + (_customWizardConditions.length || 'None') + '<br>'
        + '<strong>Sort:</strong> ' + esc(_customWizardSort) + ' ' + esc(_customWizardSortDir) + '<br>'
        + '<strong>Limit:</strong> ' + _customWizardLimit
        + '</div>';

    html += '<div class="wizard-actions">'
        + '<button class="btn btn-ghost" onclick="wizardGoStep(2)">Back</button>'
        + '<button class="btn btn-accent" onclick="saveCustomTileFromWizard()">Save Tile</button>'
        + '</div></div>';
    return html;
}

function wizardGoStep(step) {
    // Capture current title input before navigating away
    const titleInput = document.getElementById('ctw-title');
    if (titleInput) _customWizardTitle = titleInput.value || 'My Custom Tile';

    _customWizardStep = step;
    renderCustomWizard();

    // Load final preview on step 3
    if (step === 3) {
        setTimeout(async () => {
            const el = document.getElementById('ctw-preview-final');
            if (!el) return;
            const validConditions = _customWizardConditions.filter(c => c.field && c.op && c.value && (Array.isArray(c.value) ? c.value.length : true));
            if (!validConditions.length) {
                el.innerHTML = '<div class="home-tile-empty">No conditions set</div>';
                return;
            }
            try {
                const result = await api('POST', API + '/my/custom-tile', {
                    conditions: validConditions,
                    sort: _customWizardSort, sort_dir: _customWizardSortDir,
                    limit: _customWizardLimit,
                });
                const pri = { critical: '#e17055', high: '#fdcb6e', medium: '#74b9ff', low: '#8b8e96', none: '#595d66' };
                const statusColor = (s) => {
        const m = { 'done': '#00b894', 'Complete': '#00b894', 'Approved': '#00cec9',
            'in_progress': '#fdcb6e', 'Working on': '#fdcb6e',
            'closed': '#636e72', 'Postponed': '#636e72',
            'review': '#6c5ce7', 'Manager Review': '#6c5ce7', 'Quality Review': '#74b9ff',
            'Client Review': '#a29bfe', 'Back to You': '#e17055', 'Stuck': '#d63031',
            'Waiting on Client': '#fd79a8', 'Not Started': '#d3d3d3' };
        return m[s] || '#74b9ff';
    };
                const items = result.items || [];
                if (!items.length) { el.innerHTML = '<div class="home-tile-empty">No matching items</div>'; return; }
                const limit = Math.min(items.length, 12);
                el.innerHTML = items.slice(0, limit).map(i => {
                    const pColor = pri[i.priority] || '#595d66';
                    const due = i.due_date ? new Date(i.due_date).toLocaleDateString('en', { month: 'short', day: 'numeric' }) : '';
                    return '<div class="home-tile-item">'
                        + '<span class="home-tile-status-dot" style="background:' + statusColor(i.status) + ';"></span>'
                        + '<span class="home-tile-item-title">' + esc(i.title) + '</span>'
                        + '<span class="cu-priority-pill" style="background:' + pColor + '22;color:' + pColor + ';font-size:10px;">' + esc(i.priority || 'none') + '</span>'
                        + (due ? '<span class="home-tile-due">' + esc(due) + '</span>' : '')
                        + '</div>';
                }).join('') + (result.total > limit ? '<div class="custom-tile-preview-count">' + result.total + ' total</div>' : '');
            } catch { el.innerHTML = '<div class="home-tile-empty" style="color:var(--red);">Preview failed</div>'; }
        }, 100);
    }
}

function closeCustomTileWizard() {
    const overlay = document.getElementById('custom-tile-wizard-overlay');
    if (overlay) overlay.remove();
}

async function generateCustomTileCriteria() {
    const desc = document.getElementById('ctw-ai-desc')?.value?.trim();
    if (!desc) { showToast('Enter a description first'); return; }

    const btn = document.getElementById('ctw-ai-btn');
    const status = document.getElementById('ctw-ai-status');
    if (btn) btn.disabled = true;
    if (status) status.textContent = 'Generating...';

    try {
        const result = await api('POST', API + '/my/custom-tile/ai-generate', { description: desc });
        if (result.title) _customWizardTitle = result.title;
        if (result.criteria) {
            _customWizardConditions = result.criteria.conditions || [];
            _customWizardSort = result.criteria.sort || 'updated_at';
            _customWizardSortDir = result.criteria.sort_dir || 'desc';
            _customWizardLimit = result.criteria.limit || 25;
        }
        if (status) status.textContent = 'Generated! Click Next to review.';
        // Update title input
        const titleInput = document.getElementById('ctw-title');
        if (titleInput) titleInput.value = _customWizardTitle;
    } catch (e) {
        if (status) status.textContent = 'Failed: ' + (e.message || 'try again');
    } finally {
        if (btn) btn.disabled = false;
    }
}

function saveCustomTileFromWizard() {
    const titleInput = document.getElementById('ctw-title');
    if (titleInput) _customWizardTitle = titleInput.value || 'My Custom Tile';

    const validConditions = _customWizardConditions.filter(c => c.field && c.op && c.value && (Array.isArray(c.value) ? c.value.length : true));

    const tileData = {
        id: _customWizardEditId || ('custom_' + Math.random().toString(36).substring(2, 8)),
        title: _customWizardTitle,
        visible: true,
        size: _customWizardSize,
        custom: true,
        criteria: {
            conditions: validConditions,
            sort: _customWizardSort,
            sort_dir: _customWizardSortDir,
            limit: _customWizardLimit,
        },
    };

    saveCustomTile(tileData);
    closeCustomTileWizard();
    showToast('Custom tile saved');
    // Re-render home if we're on home view
    _homeData = null;
    renderMainContent();
}

function saveCustomTile(tileData) {
    if (!_homeLayout) loadHomeLayout();
    const existing = _homeLayout.tiles.findIndex(t => t.id === tileData.id);
    if (existing >= 0) {
        // Update in place, preserving order
        const oldTile = _homeLayout.tiles[existing];
        _homeLayout.tiles[existing] = { ...oldTile, ...tileData, order: tileData.order ?? oldTile.order };
    } else {
        // Add new tile at the end
        tileData.order = _homeLayout.tiles.length;
        _homeLayout.tiles.push(tileData);
    }
    saveHomeLayout();
}

function deleteCustomTile(tileId) {
    if (!confirm('Delete this custom tile?')) return;
    if (!_homeLayout) loadHomeLayout();
    _homeLayout.tiles = _homeLayout.tiles.filter(t => t.id !== tileId);
    // Reorder remaining tiles
    _homeLayout.tiles.sort((a, b) => a.order - b.order).forEach((t, i) => t.order = i);
    delete _customTileData[tileId];
    saveHomeLayout();
    // Re-render
    _homeData = null;
    renderMainContent();
    // Also re-render settings if open
    const settingsEl = document.getElementById('settings-tab-landing');
    if (settingsEl && settingsEl.innerHTML) renderSettingsLanding();
    showToast('Custom tile deleted');
}

// ── Members management ────────────────────────────────────
let _settingsMembers = [];
let _settingsDetailedMembers = [];
let _settingsAllSpaces = [];
let _expandedMemberCards = new Set();

const AVAILABLE_APPS = [
    { name: 'op-wordpress', label: 'OP WordPress', icon: 'W' },
];

const PERMISSION_KEYS = [
    { key: 'can_manage_statuses', label: 'Manage Statuses' },
    { key: 'can_manage_priorities', label: 'Manage Priorities' },
    { key: 'can_manage_tags', label: 'Manage Tags' },
    { key: 'can_manage_members', label: 'Manage Members' },
    { key: 'can_manage_fields', label: 'Manage Fields' },
    { key: 'can_manage_automations', label: 'Manage Automations' },
];

async function renderSettingsMembers() {
    const el = document.getElementById('settings-tab-members');
    if (!el) return;

    const hub = _myHub();
    const isAdmin = hub ? _isHubAdmin() : false;

    el.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted);">Loading members...</div>';

    if (hub) {
        // Hub mode: load from hub members API
        try {
            const data = await api('GET', API + '/hubs/' + hub.id + '/members');
            _settingsDetailedMembers = (data.members || []).map(m => ({
                user_id: m.user_id,
                display_name: m.display_name || m.email || m.user_id.substring(0, 8),
                email: m.email || '',
                role: m.role,
                permissions: m.permissions || {},
                spaces: [],
                app_sharing: {}
            }));
            _settingsAllSpaces = [];
        } catch {
            el.innerHTML = '<div class="settings-info-box" style="color:var(--red);">Failed to load hub members.</div>';
            return;
        }
    } else {
        // Legacy workspace mode
        const wsId = _myPersonalSpaceId();
        if (!wsId) {
            el.innerHTML = '<div class="settings-info-box">No workspace found.</div>';
            return;
        }
        const space = _spaces.find(s => s.id === (_currentSpaceId || wsId));
        const myRole = space?.my_role || 'member';

        try {
            const data = await api('GET', API + '/workspaces/' + wsId + '/members/detailed');
            _settingsDetailedMembers = data.members || [];
            _settingsAllSpaces = data.spaces || [];
        } catch (e) {
            try {
                const data = await api('GET', API + '/workspaces/' + wsId + '/members');
                _settingsDetailedMembers = (data.members || []).map(m => ({
                    ...m, spaces: [], permissions: {}, app_sharing: {}
                }));
                _settingsAllSpaces = [];
            } catch {
                el.innerHTML = '<div class="settings-info-box" style="color:var(--red);">Failed to load members.</div>';
                return;
            }
        }
    }

    let html = '';
    if (hub) {
        html += '<div class="settings-info-box">' + (isAdmin
            ? 'Manage hub members. All members can see every space in the hub.'
            : 'Hub members have access to all spaces. Only admins can manage membership.') + '</div>';
    }

    for (const m of _settingsDetailedMembers) {
        const name = m.display_name || m.email || m.user_id.substring(0, 8);
        const isMe = m.user_id === _user?.id;
        const initial = (name[0] || '?').toUpperCase();
        const isExpanded = _expandedMemberCards.has(m.user_id);
        const canEdit = isAdmin && !isMe && m.role !== 'owner';

        html += '<div class="th-member-card" data-user-id="' + esc(m.user_id) + '">';

        // Header row
        html += '<div class="th-member-card-header" onclick="toggleMemberCard(\'' + esc(m.user_id) + '\')">';
        html += '<div class="th-member-card-avatar">' + esc(initial) + '</div>';
        html += '<div class="th-member-card-info">'
            + '<div class="th-member-card-name">' + esc(name) + (isMe ? ' <span style="color:var(--text-muted);font-size:11px;">(you)</span>' : '') + '</div>'
            + '<div class="th-member-card-email">' + esc(m.email || '') + '</div>'
            + '</div>';

        // Role badge or selector
        if (canEdit) {
            if (hub) {
                html += '<select class="form-select" style="width:auto;font-size:11px;padding:2px 6px;" onchange="event.stopPropagation();changeHubMemberRole(\'' + esc(m.user_id) + '\', this.value)">'
                    + '<option value="admin"' + (m.role === 'admin' ? ' selected' : '') + '>Admin</option>'
                    + '<option value="member"' + (m.role === 'member' ? ' selected' : '') + '>Member</option>'
                    + '</select>';
            } else {
                html += '<select class="form-select" style="width:auto;font-size:11px;padding:2px 6px;" onchange="event.stopPropagation();changeMemberRole(\'' + esc(m.user_id) + '\', this.value)">'
                    + '<option value="admin"' + (m.role === 'admin' ? ' selected' : '') + '>Admin</option>'
                    + '<option value="member"' + (m.role === 'member' ? ' selected' : '') + '>Member</option>'
                    + '<option value="viewer"' + (m.role === 'viewer' ? ' selected' : '') + '>Viewer</option>'
                    + '</select>';
            }
        } else {
            html += '<span class="th-member-card-role ' + esc(m.role) + '">' + esc(m.role) + '</span>';
        }

        html += '<button class="th-member-card-expand' + (isExpanded ? ' open' : '') + '">'
            + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>'
            + '</button>';
        html += '</div>'; // end header

        // Expandable body
        html += '<div class="th-member-card-body' + (isExpanded ? ' open' : '') + '">';

        if (hub && canEdit) {
            // Hub permissions section
            const HUB_PERM_KEYS = [
                { key: 'can_edit_titles', label: 'Edit task titles' },
                { key: 'can_change_status', label: 'Change status' },
                { key: 'can_change_priority', label: 'Change priority' },
                { key: 'can_create_items', label: 'Create items' },
                { key: 'can_comment', label: 'Comment' },
                { key: 'can_assign', label: 'Assign tasks' },
                { key: 'can_create_statuses', label: 'Create statuses' },
                { key: 'can_delete_statuses', label: 'Delete statuses' },
                { key: 'can_create_tags', label: 'Create tags' },
                { key: 'can_delete_tags', label: 'Delete tags' },
                { key: 'can_delete_items', label: 'Delete items' },
                { key: 'can_manage_members', label: 'Manage members' },
                { key: 'can_create_spaces', label: 'Create spaces' },
                { key: 'can_delete_spaces', label: 'Delete spaces' },
                { key: 'can_manage_automations', label: 'Manage automations' },
                { key: 'can_manage_fields', label: 'Manage custom fields' },
            ];
            html += '<div class="th-member-section">';
            html += '<div class="th-member-section-label">Hub Permissions</div>';
            html += '<div class="th-member-perms-grid">';
            for (const perm of HUB_PERM_KEYS) {
                const checked = m.permissions && m.permissions[perm.key];
                html += '<label class="th-member-perm-item">'
                    + '<input type="checkbox" ' + (checked ? 'checked' : '') + ' onchange="updateHubMemberPermission(\'' + esc(m.user_id) + '\',\'' + esc(perm.key) + '\',this.checked)">'
                    + '<span>' + esc(perm.label) + '</span>'
                    + '</label>';
            }
            html += '</div></div>';

            // Remove button
            html += '<div class="th-member-card-footer">'
                + '<button class="btn btn-small btn-ghost" style="color:var(--red);" onclick="removeHubMember(\'' + esc(m.user_id) + '\',\'' + esc(name) + '\')">Remove from Hub</button>'
                + '</div>';
        } else if (!hub) {
            // Legacy workspace mode — spaces, apps, permissions
            if (_settingsAllSpaces.length > 0) {
                html += '<div class="th-member-section">';
                html += '<div class="th-member-section-label">Spaces</div>';
                html += '<div class="th-member-spaces-grid">';
                for (const sp of (m.spaces || [])) {
                    const active = sp.has_access;
                    if (canEdit) {
                        html += '<div class="th-member-space-chip' + (active ? ' active' : '') + '" '
                            + 'onclick="toggleMemberSpaceAccess(\'' + esc(m.user_id) + '\',\'' + esc(sp.id) + '\',' + active + ')">'
                            + (active ? '&#10003; ' : '') + esc(sp.name) + '</div>';
                    } else {
                        if (active) {
                            html += '<div class="th-member-space-chip active">&#10003; ' + esc(sp.name) + '</div>';
                        }
                    }
                }
                html += '</div>';
                if (canEdit) {
                    html += '<div class="th-member-space-actions">'
                        + '<button class="btn btn-small btn-ghost" onclick="shareAllSpaces(\'' + esc(m.user_id) + '\')">Share All</button>'
                        + '<button class="btn btn-small btn-ghost" onclick="removeAllSpaces(\'' + esc(m.user_id) + '\')">Remove All</button>'
                        + '</div>';
                }
                html += '</div>';
            }

            html += '<div class="th-member-section">';
            html += '<div class="th-member-section-label">App Sharing</div>';
            html += '<div class="th-member-apps-list">';
            for (const app of AVAILABLE_APPS) {
                const shared = m.app_sharing && m.app_sharing[app.name];
                if (canEdit) {
                    html += '<label class="th-member-app-row">'
                        + '<input type="checkbox" ' + (shared ? 'checked' : '') + ' onchange="updateMemberAppSharing(\'' + esc(m.user_id) + '\',\'' + esc(app.name) + '\',this.checked)">'
                        + '<span>' + esc(app.label) + '</span>'
                        + (shared ? '<span class="th-member-app-level">' + esc(shared.access_level || 'full') + '</span>' : '')
                        + '</label>';
                } else {
                    if (shared) {
                        html += '<div class="th-member-app-row">'
                            + '<span>&#10003;</span>'
                            + '<span>' + esc(app.label) + '</span>'
                            + '<span class="th-member-app-level">' + esc(shared.access_level || 'full') + '</span>'
                            + '</div>';
                    }
                }
            }
            html += '</div></div>';

            if (canEdit && (m.role === 'admin' || m.role === 'member')) {
                html += '<div class="th-member-section">';
                html += '<div class="th-member-section-label">Admin Permissions</div>';
                html += '<div class="th-member-perms-grid">';
                for (const perm of PERMISSION_KEYS) {
                    const checked = m.permissions && m.permissions[perm.key];
                    html += '<label class="th-member-perm-item">'
                        + '<input type="checkbox" ' + (checked ? 'checked' : '') + ' onchange="updateMemberPermission(\'' + esc(m.user_id) + '\',\'' + esc(perm.key) + '\',this.checked)">'
                        + '<span>' + esc(perm.label) + '</span>'
                        + '</label>';
                }
                html += '</div></div>';
            }

            if (canEdit) {
                html += '<div class="th-member-card-footer">'
                    + '<button class="btn btn-small btn-ghost" style="color:var(--red);" onclick="removeMemberFromSpace(\'' + esc(m.user_id) + '\',\'' + esc(name) + '\')">Remove from Workspace</button>'
                    + '</div>';
            }
        }

        html += '</div>'; // end body
        html += '</div>'; // end card
    }

    if (!isAdmin && !hub) {
        html += '<div class="settings-info-box" style="margin-top:12px;">Only workspace owners and admins can manage members.</div>';
    }

    el.innerHTML = html;
}

function toggleMemberCard(userId) {
    if (_expandedMemberCards.has(userId)) {
        _expandedMemberCards.delete(userId);
    } else {
        _expandedMemberCards.add(userId);
    }
    // Toggle DOM directly for smooth UX
    const card = document.querySelector('.th-member-card[data-user-id="' + userId + '"]');
    if (!card) return;
    const body = card.querySelector('.th-member-card-body');
    const expandBtn = card.querySelector('.th-member-card-expand');
    if (body) body.classList.toggle('open');
    if (expandBtn) expandBtn.classList.toggle('open');
}

async function toggleMemberSpaceAccess(userId, spaceId, hasAccess) {
    const wsId = _myPersonalSpaceId();
    if (!wsId) return;
    try {
        if (hasAccess) {
            await api('DELETE', API + '/workspaces/' + wsId + '/members/' + userId + '/spaces/' + spaceId);
        } else {
            await api('PUT', API + '/workspaces/' + wsId + '/members/' + userId + '/spaces/' + spaceId);
        }
        showToast(hasAccess ? 'Removed from space' : 'Added to space');
        renderSettingsMembers();
    } catch (e) {
        showToast(e.message || 'Failed to update space access');
    }
}

async function shareAllSpaces(userId) {
    const wsId = _myPersonalSpaceId();
    if (!wsId) return;
    try {
        const result = await api('POST', API + '/workspaces/' + wsId + '/members/' + userId + '/share-all-spaces');
        showToast('Added to ' + (result.added || 'all') + ' spaces');
        renderSettingsMembers();
    } catch (e) {
        showToast(e.message || 'Failed to share all spaces');
    }
}

async function removeAllSpaces(userId) {
    const wsId = _myPersonalSpaceId();
    if (!wsId) return;
    if (!confirm('Remove this member from all spaces?')) return;
    try {
        const result = await api('POST', API + '/workspaces/' + wsId + '/members/' + userId + '/remove-all-spaces');
        showToast('Removed from ' + (result.removed || 'all') + ' spaces');
        renderSettingsMembers();
    } catch (e) {
        showToast(e.message || 'Failed to remove from spaces');
    }
}

async function updateMemberPermission(userId, permKey, value) {
    const wsId = _myPersonalSpaceId();
    if (!wsId) return;
    try {
        const body = {};
        body[permKey] = value;
        await api('PUT', API + '/workspaces/' + wsId + '/members/' + userId + '/permissions', body);
        showToast('Permission updated');
        // Update local state without full re-render
        const member = _settingsDetailedMembers.find(m => m.user_id === userId);
        if (member && member.permissions) member.permissions[permKey] = value;
    } catch (e) {
        showToast(e.message || 'Failed to update permission');
    }
}

async function updateMemberAppSharing(userId, appName, enabled) {
    const wsId = _myPersonalSpaceId();
    if (!wsId) return;
    try {
        await api('PUT', API + '/workspaces/' + wsId + '/members/' + userId + '/app-sharing', {
            app_name: appName, enabled: enabled, access_level: 'full'
        });
        showToast(enabled ? appName + ' shared' : appName + ' access removed');
        renderSettingsMembers();
    } catch (e) {
        showToast(e.message || 'Failed to update app sharing');
    }
}

async function changeMemberRole(userId, newRole) {
    const wsId = _currentSpaceId || _myPersonalSpaceId();
    if (!wsId) return;
    try {
        await api('PATCH', API + '/workspaces/' + wsId + '/members/' + userId, { role: newRole });
        showToast('Role updated');
        renderSettingsMembers();
    } catch (e) {
        showToast(e.message || 'Failed to update role');
    }
}

async function removeMemberFromSpace(userId, name) {
    const wsId = _currentSpaceId || _myPersonalSpaceId();
    if (!wsId) return;
    if (!confirm('Remove ' + name + ' from this workspace? They will lose access to all tasks.')) return;
    try {
        await api('DELETE', API + '/workspaces/' + wsId + '/members/' + userId);
        showToast(name + ' removed');
        renderSettingsMembers();
    } catch (e) {
        showToast(e.message || 'Failed to remove member');
    }
}

// ── Hub Member Management ──────────────────────────────────

async function changeHubMemberRole(userId, newRole) {
    const hub = _myHub();
    if (!hub) return;
    try {
        await api('PATCH', API + '/hubs/' + hub.id + '/members/' + userId, { role: newRole });
        showToast('Role updated');
        renderSettingsMembers();
    } catch (e) {
        showToast(e.message || 'Failed to update role');
    }
}

async function updateHubMemberPermission(userId, permKey, value) {
    const hub = _myHub();
    if (!hub) return;
    try {
        const body = {};
        body[permKey] = value;
        await api('PATCH', API + '/hubs/' + hub.id + '/members/' + userId, body);
        showToast('Permission updated');
        const member = _settingsDetailedMembers.find(m => m.user_id === userId);
        if (member && member.permissions) member.permissions[permKey] = value;
    } catch (e) {
        showToast(e.message || 'Failed to update permission');
    }
}

async function removeHubMember(userId, name) {
    const hub = _myHub();
    if (!hub) return;
    if (!confirm('Remove ' + name + ' from the hub? They will lose access to all hub spaces and tasks.')) return;
    try {
        await api('DELETE', API + '/hubs/' + hub.id + '/members/' + userId);
        showToast(name + ' removed from hub');
        renderSettingsMembers();
    } catch (e) {
        showToast(e.message || 'Failed to remove member');
    }
}

// ── Telegram Connection Tab ───────────────────────────────

function renderSettingsDiscordAI() {
    const el = document.getElementById('settings-tab-discord-ai');
    if (!el) return;

    let html = '';

    // ── Header ──
    html += '<div class="discord-ai-section">'
        + '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">'
        + '<svg width="24" height="24" viewBox="0 0 24 24" fill="var(--accent)"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.2-.08-.06-.19-.04-.27-.02-.12.03-1.97 1.25-5.56 3.69-.53.36-1 .54-1.42.53-.47-.01-1.37-.26-2.03-.48-.82-.27-1.47-.42-1.41-.88.03-.24.37-.49 1.02-.74 3.99-1.74 6.65-2.89 7.99-3.44 3.81-1.58 4.6-1.86 5.12-1.87.11 0 .37.03.53.17.14.12.18.28.2.45-.01.06.01.24 0 .37z"/></svg>'
        + '<strong style="font-size:14px;">Team Hub on Telegram</strong>'
        + '</div>'
        + '<div class="settings-info-box" style="margin-bottom:16px;">'
        + 'Team Hub is connected to Telegram. You can manage tasks, get updates, and talk to the AI assistant directly from the OPAI Telegram group.'
        + '</div>';

    // ── How to connect ──
    html += '<div class="discord-ai-howto" style="margin-bottom:16px;">'
        + '<strong>How to join</strong>'
        + '<ol style="margin:8px 0 0;padding-left:20px;">'
        + '<li>Open Telegram and search for the <strong>OPAI</strong> group, or ask Dallas for an invite link.</li>'
        + '<li>Inside the group, find the <strong>Team Hub</strong> topic &mdash; this is where the bot listens for your commands.</li>'
        + '<li>Send a message in the topic and the AI will respond with access to your workspaces.</li>'
        + '</ol>'
        + '</div>';

    // ── What you can do ──
    html += '<div class="discord-ai-howto" style="margin-bottom:16px;">'
        + '<strong>What the bot can do</strong>'
        + '<ul style="margin:8px 0 0;padding-left:20px;">'
        + '<li>Create, search, and update tasks, notes, and ideas</li>'
        + '<li>List and create spaces, folders, and lists</li>'
        + '<li>Add comments to items</li>'
        + '<li>Get workspace summaries and detailed item views</li>'
        + '<li>Natural language queries &mdash; just ask in plain English</li>'
        + '</ul>'
        + '</div>';

    // ── Contact / Trouble ──
    html += '<div class="discord-ai-section" style="margin-top:8px;padding:14px;border-radius:8px;background:var(--bg-hover);">'
        + '<strong style="font-size:13px;">Need access or having trouble?</strong>'
        + '<p style="margin:8px 0 12px;font-size:12px;color:var(--text-muted);">'
        + 'If you can\'t find the group, need an invite, or are having issues connecting, reach out to Dallas directly on Telegram.'
        + '</p>'
        + '<a href="https://t.me/Dalwaut" target="_blank" rel="noopener" '
        + 'style="display:inline-flex;align-items:center;gap:6px;padding:8px 16px;background:var(--accent);color:#fff;border-radius:6px;font-size:13px;font-weight:500;text-decoration:none;">'
        + '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.2-.08-.06-.19-.04-.27-.02-.12.03-1.97 1.25-5.56 3.69-.53.36-1 .54-1.42.53-.47-.01-1.37-.26-2.03-.48-.82-.27-1.47-.42-1.41-.88.03-.24.37-.49 1.02-.74 3.99-1.74 6.65-2.89 7.99-3.44 3.81-1.58 4.6-1.86 5.12-1.87.11 0 .37.03.53.17.14.12.18.28.2.45-.01.06.01.24 0 .37z"/></svg>'
        + 'Contact Dallas on Telegram'
        + '</a>'
        + '</div>';

    html += '</div>'; // section

    el.innerHTML = html;
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

// ── Docs Viewer & Editor ─────────────────────────────────────

let _currentDocId = null;
let _currentDoc = null;
let _docEditMode = false;
let _docEditingPageId = null;

function renderDocContent(text) {
    if (!text) return '';
    if (window.markdownit) {
        return window.markdownit({ html: false, linkify: true, breaks: true }).render(text);
    }
    // Fallback: basic rendering
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

async function openDoc(docId, spaceId) {
    _currentDocId = docId;
    _currentSpaceId = spaceId;
    _currentListId = null;
    _currentView = 'doc';
    _docEditMode = false;
    _docEditingPageId = null;
    renderSpaceTree();

    const el = document.getElementById('main-content');
    el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:200px;"><div class="spinner"></div></div>';

    try {
        const doc = await apiFetch('/docs/' + docId);
        _currentDoc = doc;
        renderDocView(el, doc);
    } catch (e) {
        el.innerHTML = '<div class="empty-state"><div class="empty-state-text">Failed to load document</div></div>';
    }
}

async function createNewDoc(spaceId, folderId) {
    const title = prompt('Document title:');
    if (!title || !title.trim()) return;
    try {
        const body = { title: title.trim(), content: '' };
        if (folderId) body.folder_id = folderId;
        const doc = await apiFetch('/workspaces/' + spaceId + '/docs', { method: 'POST', body: JSON.stringify(body) });
        // Refresh sidebar
        delete _hierarchyCache[spaceId];
        if (_expandedSpaces[spaceId]) {
            const data = await api('GET', API + '/workspaces/' + spaceId + '/folders');
            _hierarchyCache[spaceId] = data;
        }
        renderSpaceTree();
        openDoc(doc.id, spaceId);
        showToast('Document created');
    } catch (e) {
        showToast('Failed to create document');
    }
}

function renderDocView(el, doc) {
    const pages = doc.pages || [];
    const sourceTag = doc.source === 'clickup' ? ' <span class="th-doc-source-tag">ClickUp</span>' : '';
    const updatedAt = doc.updated_at ? new Date(doc.updated_at).toLocaleDateString() : '';

    let html = '<div class="th-doc-viewer">';

    // ── Header with actions ──
    html += '<div class="th-doc-header">'
        + '<div class="th-doc-title-row">'
        + '<span class="th-doc-icon">\uD83D\uDCC4</span>';

    if (_docEditMode) {
        html += '<input type="text" class="th-doc-title-input" id="doc-title-input" value="' + esc(doc.title) + '">';
    } else {
        html += '<h2 class="th-doc-title">' + esc(doc.title) + sourceTag + '</h2>';
    }
    html += '<div class="th-doc-actions">';
    if (_docEditMode) {
        html += '<button class="th-doc-action-btn th-doc-save" onclick="saveDoc()">Save</button>'
            + '<button class="th-doc-action-btn th-doc-cancel" onclick="cancelDocEdit()">Cancel</button>';
    } else {
        html += '<button class="th-doc-action-btn" onclick="enterDocEdit()" title="Edit">'
            + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>'
            + '</button>'
            + '<button class="th-doc-action-btn th-doc-danger" onclick="deleteDoc()" title="Delete">'
            + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>'
            + '</button>';
    }
    html += '</div></div>';

    html += '<div class="th-doc-meta">'
        + (doc.author_name ? '<span>By ' + esc(doc.author_name) + '</span>' : '')
        + (updatedAt ? '<span>Updated ' + esc(updatedAt) + '</span>' : '')
        + '</div>'
        + '</div>';

    // ── Main doc content ──
    if (_docEditMode) {
        html += '<div class="th-doc-edit-section">'
            + '<label class="th-doc-edit-label">Content</label>'
            + '<textarea class="th-doc-textarea" id="doc-content-input" placeholder="Write your document content here... (Markdown supported)">' + esc(doc.content || '') + '</textarea>'
            + '</div>';
    } else if (doc.content) {
        html += '<div class="th-doc-content">' + renderDocContent(doc.content) + '</div>';
    }

    // ── Pages ──
    html += '<div class="th-doc-pages-section">'
        + '<div class="th-doc-pages-header">'
        + '<h3>Pages (' + pages.length + ')</h3>';
    if (!_docEditMode) {
        html += '<button class="th-doc-add-page-btn" onclick="addDocPage()">+ Add Page</button>';
    }
    html += '</div>';

    if (pages.length > 0) {
        html += '<div class="th-doc-pages">';
        for (let i = 0; i < pages.length; i++) {
            const page = pages[i];
            const isEditing = _docEditingPageId === page.id;
            html += '<div class="th-doc-page" data-page-id="' + esc(page.id) + '">';

            if (isEditing) {
                html += '<div class="th-doc-page-edit">'
                    + '<input type="text" class="th-doc-page-title-input" id="page-title-input" value="' + esc(page.title || 'Untitled Page') + '">'
                    + '<textarea class="th-doc-textarea th-doc-page-textarea" id="page-content-input">' + esc(page.content || '') + '</textarea>'
                    + '<div class="th-doc-page-edit-actions">'
                    + '<button class="th-doc-action-btn th-doc-save" onclick="saveDocPage(\'' + esc(page.id) + '\')">Save</button>'
                    + '<button class="th-doc-action-btn th-doc-cancel" onclick="cancelPageEdit()">Cancel</button>'
                    + '</div></div>';
            } else {
                html += '<div class="th-doc-page-header">'
                    + '<h3 class="th-doc-page-title">' + esc(page.title || 'Untitled Page') + '</h3>'
                    + '<div class="th-doc-page-actions">'
                    + '<button class="th-doc-page-action" onclick="editDocPage(\'' + esc(page.id) + '\')" title="Edit">'
                    + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>'
                    + '</button>'
                    + '<button class="th-doc-page-action th-doc-danger" onclick="deleteDocPage(\'' + esc(page.id) + '\')" title="Delete">'
                    + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>'
                    + '</button>'
                    + '</div></div>'
                    + '<div class="th-doc-page-content">' + renderDocContent(page.content || '') + '</div>';
            }
            html += '</div>';
        }
        html += '</div>';
    }

    if (!doc.content && pages.length === 0 && !_docEditMode) {
        html += '<div class="empty-state" style="padding:40px;">'
            + '<div class="empty-state-text">This document is empty</div>'
            + '<button class="th-doc-action-btn th-doc-save" onclick="enterDocEdit()" style="margin-top:12px;">Start Writing</button>'
            + '</div>';
    }

    html += '</div></div>';
    el.innerHTML = html;
}

function enterDocEdit() {
    _docEditMode = true;
    _docEditingPageId = null;
    const el = document.getElementById('main-content');
    renderDocView(el, _currentDoc);
}

function cancelDocEdit() {
    _docEditMode = false;
    const el = document.getElementById('main-content');
    renderDocView(el, _currentDoc);
}

async function saveDoc() {
    const title = document.getElementById('doc-title-input')?.value?.trim();
    const content = document.getElementById('doc-content-input')?.value || '';
    if (!title) { showToast('Title is required'); return; }

    try {
        const updated = await apiFetch('/docs/' + _currentDocId, {
            method: 'PUT',
            body: JSON.stringify({ title, content }),
        });
        _currentDoc.title = updated.title || title;
        _currentDoc.content = updated.content !== undefined ? updated.content : content;
        _currentDoc.updated_at = updated.updated_at || new Date().toISOString();
        _docEditMode = false;
        const el = document.getElementById('main-content');
        renderDocView(el, _currentDoc);
        // Refresh sidebar to show updated title
        if (_currentSpaceId) {
            delete _hierarchyCache[_currentSpaceId];
            if (_expandedSpaces[_currentSpaceId]) {
                const data = await api('GET', API + '/workspaces/' + _currentSpaceId + '/folders');
                _hierarchyCache[_currentSpaceId] = data;
            }
            renderSpaceTree();
        }
        showToast('Document saved');
    } catch (e) {
        showToast('Failed to save document');
    }
}

async function deleteDoc() {
    if (!confirm('Delete this document and all its pages? This cannot be undone.')) return;
    try {
        await apiFetch('/docs/' + _currentDocId, { method: 'DELETE' });
        _currentDocId = null;
        _currentDoc = null;
        _docEditMode = false;
        // Refresh sidebar
        if (_currentSpaceId) {
            delete _hierarchyCache[_currentSpaceId];
            if (_expandedSpaces[_currentSpaceId]) {
                const data = await api('GET', API + '/workspaces/' + _currentSpaceId + '/folders');
                _hierarchyCache[_currentSpaceId] = data;
            }
            renderSpaceTree();
        }
        // Go back to space dashboard
        openSpaceDashboard(_currentSpaceId, _currentSpaceName);
        showToast('Document deleted');
    } catch (e) {
        showToast('Failed to delete document');
    }
}

// ── Page management ──

async function addDocPage() {
    const title = prompt('Page title:', 'Untitled Page');
    if (title === null) return;
    try {
        const page = await apiFetch('/docs/' + _currentDocId + '/pages', {
            method: 'POST',
            body: JSON.stringify({ title: title.trim() || 'Untitled Page', content: '' }),
        });
        if (!_currentDoc.pages) _currentDoc.pages = [];
        _currentDoc.pages.push(page);
        _docEditingPageId = page.id;
        const el = document.getElementById('main-content');
        renderDocView(el, _currentDoc);
        showToast('Page added');
        // Scroll to new page
        setTimeout(() => {
            const pageEl = document.querySelector('[data-page-id="' + page.id + '"]');
            if (pageEl) pageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 100);
    } catch (e) {
        showToast('Failed to add page');
    }
}

function editDocPage(pageId) {
    _docEditingPageId = pageId;
    _docEditMode = false;
    const el = document.getElementById('main-content');
    renderDocView(el, _currentDoc);
    setTimeout(() => {
        const input = document.getElementById('page-content-input');
        if (input) input.focus();
    }, 50);
}

function cancelPageEdit() {
    _docEditingPageId = null;
    const el = document.getElementById('main-content');
    renderDocView(el, _currentDoc);
}

async function saveDocPage(pageId) {
    const title = document.getElementById('page-title-input')?.value?.trim() || 'Untitled Page';
    const content = document.getElementById('page-content-input')?.value || '';
    try {
        await apiFetch('/docs/' + _currentDocId + '/pages/' + pageId, {
            method: 'PUT',
            body: JSON.stringify({ title, content }),
        });
        const page = (_currentDoc.pages || []).find(p => p.id === pageId);
        if (page) {
            page.title = title;
            page.content = content;
        }
        _docEditingPageId = null;
        const el = document.getElementById('main-content');
        renderDocView(el, _currentDoc);
        showToast('Page saved');
    } catch (e) {
        showToast('Failed to save page');
    }
}

async function deleteDocPage(pageId) {
    if (!confirm('Delete this page?')) return;
    try {
        await apiFetch('/docs/' + _currentDocId + '/pages/' + pageId, { method: 'DELETE' });
        _currentDoc.pages = (_currentDoc.pages || []).filter(p => p.id !== pageId);
        if (_docEditingPageId === pageId) _docEditingPageId = null;
        const el = document.getElementById('main-content');
        renderDocView(el, _currentDoc);
        showToast('Page deleted');
    } catch (e) {
        showToast('Failed to delete page');
    }
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
    // Only close via the explicit close button, not backdrop click

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
        const typeIcons = {
            assignment: '\u{1F464}',
            mention: '@',
            update: '\u270F',
            reminder: '\u{1F514}',
            automation: '\u26A1',
        };
        list.innerHTML = notifs.map(n => {
            const unread = !n.read ? ' unread' : '';
            const icon = typeIcons[n.type] || '\u{1F514}';
            const bodySnippet = n.body ? '<div class="th-notif-item-body">' + esc(n.body).slice(0, 80) + '</div>' : '';
            return '<div class="th-notif-item' + unread + '" data-nid="' + n.id + '" onclick="clickNotification(' + JSON.stringify(n).replace(/"/g, '&quot;') + ')">'
                + '<span class="th-notif-type-icon">' + icon + '</span>'
                + '<div class="th-notif-item-content">'
                + '<div class="th-notif-item-text">' + esc(n.title || 'Notification') + '</div>'
                + bodySnippet
                + '<div class="th-notif-item-time">' + timeAgo(n.created_at) + '</div>'
                + '</div>'
                + '<button class="th-notif-dismiss" onclick="dismissNotification(\'' + n.id + '\', event)" title="Dismiss">&times;</button>'
                + '</div>';
        }).join('');
    } catch {
        list.innerHTML = '<div class="th-notif-empty">Failed to load</div>';
    }
}

async function dismissNotification(id, event) {
    event.stopPropagation();
    try {
        await api('DELETE', API + '/my/notifications/' + id);
        const el = document.querySelector('[data-nid="' + id + '"]');
        if (el) el.remove();
        // Update badge count
        const remaining = document.querySelectorAll('.th-notif-item.unread').length;
        const badge = document.getElementById('notif-badge');
        if (remaining > 0) {
            badge.textContent = remaining;
            badge.style.display = '';
        } else {
            badge.style.display = 'none';
        }
        if (document.querySelectorAll('.th-notif-item').length === 0) {
            document.getElementById('notif-list').innerHTML = '<div class="th-notif-empty">No notifications</div>';
        }
    } catch { showToast('Failed to dismiss'); }
}

async function clickNotification(n) {
    try {
        await api('POST', API + '/my/notifications/read', { notification_ids: [n.id] });
        const el = document.querySelector('[data-nid="' + n.id + '"]');
        if (el) el.classList.remove('unread');
        // Update badge
        const remaining = document.querySelectorAll('.th-notif-item.unread').length;
        const badge = document.getElementById('notif-badge');
        if (remaining > 0) { badge.textContent = remaining; badge.style.display = ''; }
        else { badge.style.display = 'none'; }
    } catch { /* silent */ }
    if (n.item_id) {
        openDetail(n.item_id);
        document.getElementById('notification-dropdown').style.display = 'none';
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

    // New Doc (spaces + folders)
    if (type === 'space') {
        items.push({ icon: '\uD83D\uDCC4', label: 'New Doc', action: () => createNewDoc(id, null) });
    } else if (type === 'folder') {
        items.push({ icon: '\uD83D\uDCC4', label: 'New Doc', action: () => createNewDoc(spaceId, id) });
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
            status: task.status || 'Not Started',
            priority: task.priority || 'none',
        });
        // Postgres Changes INSERT listener will add the new task automatically
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

function _batchRender() {
    // In home list view, do a surgical table update (no API refetch)
    if (_currentView === 'list' && !_currentListId && _homeListItems) {
        renderHomeListTable(document.getElementById('main-content'));
    } else {
        renderMainContent();
    }
}

function batchToggleItem(itemId, checked) {
    if (checked) _selectedItems.add(itemId);
    else _selectedItems.delete(itemId);
    _batchRender();
}

function batchToggleAll(checked) {
    const visible = getVisibleTasks();
    if (checked) visible.forEach(t => _selectedItems.add(t.id));
    else _selectedItems.clear();
    _batchRender();
}

function batchToggleAllHome(checked) {
    const visible = filterHomeListItems(_homeListItems || []);
    if (checked) visible.forEach(t => _selectedItems.add(t.id));
    else _selectedItems.clear();
    _batchRender();
}

function batchClearSelection() {
    _selectedItems.clear();
    _batchRender();
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
        : ['Not Started', 'Working on', 'Manager Review', 'Back to You', 'Stuck', 'Waiting on Client', 'Client Review', 'Approved', 'Postponed', 'Quality Review', 'Complete'];
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
            if (_spaceReorderDrag) return; // Space reorder in progress — handled separately
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
            if (_spaceReorderDrag) return; // Space reorder in progress — handled separately
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

// ── Space Reorder Drag-and-Drop ──────────────────────────────

let _spaceReorderDrag = null; // { id, el, startIndex }

function bindSpaceReorder() {
    const tree = document.getElementById('space-tree');
    if (!tree) return;

    tree.querySelectorAll('.th-tree-space[draggable="true"]').forEach((el, idx) => {
        el.addEventListener('dragstart', (e) => {
            // If a folder/list drag is already active, don't interfere
            if (_sidebarDrag) return;
            const target = e.target;
            // If drag started from a child item (folder/list), let existing handler take over
            if (target.closest('[data-drag-type]')) return;

            _spaceReorderDrag = {
                id: el.dataset.spaceId,
                startIndex: idx
            };
            el.classList.add('th-space-reorder-dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('application/x-space-reorder', el.dataset.spaceId);
        });

        el.addEventListener('dragend', () => {
            el.classList.remove('th-space-reorder-dragging');
            _spaceReorderDrag = null;
            tree.querySelectorAll('.th-space-drop-above, .th-space-drop-below').forEach(
                n => n.classList.remove('th-space-drop-above', 'th-space-drop-below')
            );
        });

        el.addEventListener('dragover', (e) => {
            if (!_spaceReorderDrag) return;
            if (_spaceReorderDrag.id === el.dataset.spaceId) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';

            // Determine if cursor is in top or bottom half
            const rect = el.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            el.classList.remove('th-space-drop-above', 'th-space-drop-below');
            if (e.clientY < midY) {
                el.classList.add('th-space-drop-above');
            } else {
                el.classList.add('th-space-drop-below');
            }
        });

        el.addEventListener('dragleave', () => {
            el.classList.remove('th-space-drop-above', 'th-space-drop-below');
        });

        el.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            el.classList.remove('th-space-drop-above', 'th-space-drop-below');
            if (!_spaceReorderDrag || _spaceReorderDrag.id === el.dataset.spaceId) return;

            const dragId = _spaceReorderDrag.id;
            const rect = el.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            const insertBefore = e.clientY < midY;

            // Optimistic reorder
            const oldIdx = _spaces.findIndex(s => s.id === dragId);
            let targetIdx = _spaces.findIndex(s => s.id === el.dataset.spaceId);
            if (oldIdx < 0 || targetIdx < 0) return;

            const [moved] = _spaces.splice(oldIdx, 1);
            // Recalc target after removal
            targetIdx = _spaces.findIndex(s => s.id === el.dataset.spaceId);
            const newIdx = insertBefore ? targetIdx : targetIdx + 1;
            _spaces.splice(newIdx, 0, moved);

            _spaceReorderDrag = null;
            renderSpaceTree();

            // Persist to backend
            try {
                await api('POST', API + '/workspaces/reorder', {
                    workspace_ids: _spaces.map(s => s.id)
                });
            } catch (err) {
                showToast('Reorder failed: ' + (err.message || err));
                await loadSpaces(); // Revert on failure
            }
        });
    });
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

// ── Favorites ────────────────────────────────────────────────

async function loadFavorites() {
    try {
        const data = await api('GET', API + '/my/favorites');
        _favorites = data.favorites || [];
        renderFavoritesSection();
    } catch { _favorites = []; }
}

function _resolveFavName(f) {
    if (f.target_type === 'workspace') {
        const sp = _spaces.find(s => s.id === f.target_id);
        return sp ? sp.name : f.target_id.substring(0, 8);
    }
    return f.target_id.substring(0, 8);
}

function renderFavoritesSection() {
    let section = document.getElementById('favorites-section');
    if (!_favorites.length) {
        if (section) section.remove();
        return;
    }
    if (!section) {
        section = document.createElement('div');
        section.id = 'favorites-section';
        section.className = 'th-favorites-section';
        const tree = document.getElementById('space-tree');
        if (tree) tree.parentElement.insertBefore(section, tree);
        else return;
    }
    let html = '<div class="th-favorites-label">&#9733; Favorites</div><div class="th-favorites-list">';
    for (const f of _favorites) {
        const name = _resolveFavName(f);
        const icon = f.target_type === 'workspace' ? '&#9679;' : f.target_type === 'list' ? '&#9776;' : '&#9744;';
        html += '<div class="th-favorites-item" onclick="openFavorite(\'' + esc(f.target_type) + '\',\'' + esc(f.target_id) + '\',\'' + esc(name) + '\')">'
            + '<span style="margin-right:6px;">' + icon + '</span>'
            + '<span>' + esc(name) + '</span>'
            + '<button class="th-star-btn active" onclick="event.stopPropagation();toggleFavorite(\'' + esc(f.target_type) + '\',\'' + esc(f.target_id) + '\')" style="margin-left:auto;font-size:12px;">&#9733;</button>'
            + '</div>';
    }
    html += '</div>';
    section.innerHTML = html;
}

function openFavorite(type, id, name) {
    if (type === 'workspace') {
        clickSpace(id, name);
    } else if (type === 'list') {
        selectList(id, name);
    } else if (type === 'item') {
        openDetail(id);
    }
}

async function toggleFavorite(targetType, targetId) {
    try {
        await api('POST', API + '/my/favorites', { target_type: targetType, target_id: targetId });
        await loadFavorites();
        // Re-render detail panel if open to update star
        if (_detailTask && targetType === 'item' && targetId === _detailTask.id) renderDetailPanel();
    } catch (err) {
        showToast('Failed to toggle favorite: ' + (err.message || ''));
    }
}

// ── Reminders ────────────────────────────────────────────────

function toggleReminderDropdown(btn, itemId) {
    // Close if already open
    let dd = btn.parentElement.querySelector('.th-reminder-dropdown');
    if (dd) { dd.remove(); return; }

    const now = new Date();
    const in15m = new Date(now.getTime() + 15 * 60000).toISOString();
    const in1h = new Date(now.getTime() + 60 * 60000).toISOString();
    const tomorrow9 = new Date(now);
    tomorrow9.setDate(tomorrow9.getDate() + 1);
    tomorrow9.setHours(9, 0, 0, 0);
    const nextMon = new Date(now);
    nextMon.setDate(nextMon.getDate() + ((8 - nextMon.getDay()) % 7 || 7));
    nextMon.setHours(9, 0, 0, 0);

    dd = document.createElement('div');
    dd.className = 'th-reminder-dropdown';
    dd.innerHTML = ''
        + '<div class="th-reminder-option" onclick="createReminder(\'' + esc(itemId) + '\',\'' + in15m + '\')">In 15 minutes</div>'
        + '<div class="th-reminder-option" onclick="createReminder(\'' + esc(itemId) + '\',\'' + in1h + '\')">In 1 hour</div>'
        + '<div class="th-reminder-option" onclick="createReminder(\'' + esc(itemId) + '\',\'' + tomorrow9.toISOString() + '\')">Tomorrow 9 AM</div>'
        + '<div class="th-reminder-option" onclick="createReminder(\'' + esc(itemId) + '\',\'' + nextMon.toISOString() + '\')">Next Monday 9 AM</div>'
        + '<div class="th-reminder-option" onclick="promptCustomReminder(\'' + esc(itemId) + '\')">Custom...</div>';
    btn.parentElement.appendChild(dd);

    // Close on outside click
    setTimeout(() => {
        const handler = (e) => { if (!dd.contains(e.target) && e.target !== btn) { dd.remove(); document.removeEventListener('click', handler); } };
        document.addEventListener('click', handler);
    }, 10);
}

async function createReminder(itemId, remindAt, note) {
    try {
        await api('POST', API + '/my/reminders', { item_id: itemId, remind_at: remindAt, note: note || '' });
        showToast('Reminder set');
        // Close any open dropdown
        document.querySelectorAll('.th-reminder-dropdown').forEach(d => d.remove());
    } catch (err) {
        showToast('Failed: ' + (err.message || ''));
    }
}

function promptCustomReminder(itemId) {
    document.querySelectorAll('.th-reminder-dropdown').forEach(d => d.remove());
    // Remove any existing picker overlay
    const existing = document.getElementById('reminder-picker-overlay');
    if (existing) existing.remove();

    const now = new Date();
    const dateVal = now.toISOString().split('T')[0];
    const timeVal = now.toTimeString().slice(0, 5);

    const overlay = document.createElement('div');
    overlay.id = 'reminder-picker-overlay';
    overlay.className = 'th-reminder-picker-overlay';
    overlay.innerHTML = ''
        + '<div class="th-reminder-picker">'
        + '<div class="th-reminder-picker-header">Set Reminder</div>'
        + '<div class="form-group">'
        + '<label class="form-label">Date</label>'
        + '<input type="date" class="form-input" id="reminder-date-input" value="' + dateVal + '">'
        + '</div>'
        + '<div class="form-group">'
        + '<label class="form-label">Time</label>'
        + '<input type="time" class="form-input" id="reminder-time-input" value="' + timeVal + '">'
        + '</div>'
        + '<div class="th-reminder-picker-actions">'
        + '<button class="btn btn-ghost btn-small" onclick="document.getElementById(\'reminder-picker-overlay\').remove()">Cancel</button>'
        + '<button class="btn btn-accent btn-small" id="reminder-picker-confirm">Set Reminder</button>'
        + '</div>'
        + '</div>';
    document.body.appendChild(overlay);

    // Confirm button
    document.getElementById('reminder-picker-confirm').addEventListener('click', () => {
        const d = document.getElementById('reminder-date-input').value;
        const t = document.getElementById('reminder-time-input').value;
        if (!d || !t) { showToast('Please select date and time'); return; }
        const parsed = new Date(d + 'T' + t);
        if (isNaN(parsed.getTime())) { showToast('Invalid date/time'); return; }
        overlay.remove();
        createReminder(itemId, parsed.toISOString());
    });
}

// ── Subtasks ─────────────────────────────────────────────────

async function createSubtask(parentId, title) {
    if (!title || !title.trim()) return;
    try {
        const t = _detailTask;
        const listId = t.list_id || _currentListId;
        if (!listId) { showToast('No list context'); return; }
        await api('POST', API + '/lists/' + listId + '/items', {
            title: title.trim(),
            type: 'task',
            status: 'Not Started',
            priority: 'none',
            parent_id: parentId,
        });
        showToast('Subtask created');
        // Reload the detail to show the new subtask
        const updated = await api('GET', API + '/items/' + parentId);
        if (updated) { _detailTask = updated; renderDetailPanel(); }
    } catch (err) {
        showToast('Failed: ' + (err.message || ''));
    }
}

async function toggleSubtaskStatus(subtaskId, currentStatus) {
    const newStatus = (currentStatus === 'done' || currentStatus === 'closed' || currentStatus === 'Complete') ? 'Not Started' : 'Complete';
    try {
        await api('PATCH', API + '/items/' + subtaskId, { status: newStatus });
        // Reload parent detail
        if (_detailTask) {
            const updated = await api('GET', API + '/items/' + _detailTask.id);
            if (updated) { _detailTask = updated; renderDetailPanel(); }
        }
    } catch (err) {
        showToast('Failed: ' + (err.message || ''));
    }
}

// ── Checklists ───────────────────────────────────────────────

async function loadDetailChecklists() {
    const container = document.getElementById('checklists-container');
    if (!container || !_detailTask) return;
    try {
        const data = await api('GET', API + '/items/' + _detailTask.id + '/checklists');
        const checklists = data.checklists || [];
        if (!checklists.length) {
            container.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">No checklists</div>';
            return;
        }
        container.innerHTML = checklists.map(cl => {
            const items = cl.items || [];
            const done = items.filter(i => i.checked).length;
            const total = items.length;
            const pct = total ? Math.round(done / total * 100) : 0;
            let html = '<div class="th-checklist-block" data-cl-id="' + esc(cl.id) + '">'
                + '<div class="th-checklist-header">'
                + '<span class="th-checklist-name">' + esc(cl.name) + '</span>'
                + '<span class="th-checklist-progress">' + done + '/' + total + '</span>'
                + '<button class="btn btn-small btn-ghost" onclick="deleteChecklist(\'' + esc(cl.id) + '\')" style="font-size:10px;margin-left:auto;" title="Delete checklist">&times;</button>'
                + '</div>'
                + '<div class="th-checklist-progress-bar"><div class="th-checklist-progress-fill" style="width:' + pct + '%;"></div></div>'
                + '<div class="th-checklist-items">';
            for (const ci of items) {
                html += '<div class="th-checklist-item">'
                    + '<input type="checkbox" class="th-checklist-checkbox"' + (ci.checked ? ' checked' : '') + ' onchange="toggleChecklistItem(\'' + esc(ci.id) + '\',this.checked)">'
                    + '<span class="' + (ci.checked ? 'th-checklist-checked' : '') + '">' + esc(ci.text) + '</span>'
                    + '<button class="btn btn-small btn-ghost" onclick="deleteChecklistItem(\'' + esc(ci.id) + '\')" style="font-size:9px;opacity:0.5;margin-left:auto;">&times;</button>'
                    + '</div>';
            }
            html += '<div class="th-checklist-add">'
                + '<input type="text" class="th-checklist-add-input" placeholder="Add item..." onkeydown="if(event.key===\'Enter\'){addChecklistItem(\'' + esc(cl.id) + '\',this.value);this.value=\'\';}">'
                + '</div></div></div>';
            return html;
        }).join('');
    } catch {
        container.innerHTML = '<div style="color:var(--text-muted);">Failed to load checklists</div>';
    }
}

async function createChecklist(itemId) {
    const name = prompt('Checklist name:', 'Checklist');
    if (!name) return;
    try {
        await api('POST', API + '/items/' + itemId + '/checklists', { name });
        loadDetailChecklists();
    } catch (err) {
        showToast('Failed: ' + (err.message || ''));
    }
}

async function deleteChecklist(clId) {
    if (!confirm('Delete this checklist?')) return;
    try {
        await api('DELETE', API + '/checklists/' + clId);
        loadDetailChecklists();
    } catch (err) {
        showToast('Failed: ' + (err.message || ''));
    }
}

async function addChecklistItem(clId, text) {
    if (!text || !text.trim()) return;
    try {
        await api('POST', API + '/checklists/' + clId + '/items', { text: text.trim() });
        loadDetailChecklists();
    } catch (err) {
        showToast('Failed: ' + (err.message || ''));
    }
}

async function toggleChecklistItem(ciId, checked) {
    try {
        await api('PATCH', API + '/checklist-items/' + ciId, { checked });
        loadDetailChecklists();
    } catch (err) {
        showToast('Failed: ' + (err.message || ''));
    }
}

async function deleteChecklistItem(ciId) {
    try {
        await api('DELETE', API + '/checklist-items/' + ciId);
        loadDetailChecklists();
    } catch (err) {
        showToast('Failed: ' + (err.message || ''));
    }
}

// ── Inline Editing (List View) ───────────────────────────────

function inlineEditTitle(cell, itemId) {
    const currentText = cell.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'th-inline-edit-input';
    input.value = currentText;
    cell.textContent = '';
    cell.appendChild(input);
    input.focus();
    input.select();

    const save = async () => {
        const newVal = input.value.trim();
        if (newVal && newVal !== currentText) {
            try {
                await api('PATCH', API + '/items/' + itemId, { title: newVal });
                cell.textContent = newVal;
            } catch {
                cell.textContent = currentText;
                showToast('Failed to update title');
            }
        } else {
            cell.textContent = currentText;
        }
    };

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = currentText; input.blur(); }
    });
}

function inlineEditStatus(cell, itemId, currentStatus) {
    const select = document.createElement('select');
    select.className = 'th-inline-edit-select';
    const statuses = _currentStatuses.length ? _currentStatuses.map(s => s.name) : ['Not Started', 'Working on', 'Manager Review', 'Back to You', 'Stuck', 'Waiting on Client', 'Client Review', 'Approved', 'Postponed', 'Quality Review', 'Complete'];
    for (const s of statuses) {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = s;
        if (s === currentStatus) opt.selected = true;
        select.appendChild(opt);
    }
    const origHtml = cell.innerHTML;
    cell.textContent = '';
    cell.appendChild(select);
    select.focus();

    const save = async () => {
        const newVal = select.value;
        if (newVal !== currentStatus) {
            try {
                await api('PATCH', API + '/items/' + itemId, { status: newVal });
                _homeListItems = null;
                if (!_currentListId) renderHome();
                else renderMainContent();
            } catch {
                cell.innerHTML = origHtml;
                showToast('Failed to update status');
            }
        } else {
            cell.innerHTML = origHtml;
        }
    };

    select.addEventListener('blur', save);
    select.addEventListener('change', () => select.blur());
    select.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { cell.innerHTML = origHtml; }
    });
}

function inlineEditPriority(cell, itemId, currentPriority) {
    const select = document.createElement('select');
    select.className = 'th-inline-edit-select';
    for (const p of PRIORITIES) {
        const opt = document.createElement('option');
        opt.value = p.value;
        opt.textContent = p.label;
        if (p.value === currentPriority) opt.selected = true;
        select.appendChild(opt);
    }
    const origHtml = cell.innerHTML;
    cell.textContent = '';
    cell.appendChild(select);
    select.focus();

    const save = async () => {
        const newVal = select.value;
        if (newVal !== currentPriority) {
            try {
                await api('PATCH', API + '/items/' + itemId, { priority: newVal });
                _homeListItems = null;
                if (!_currentListId) renderHome();
                else renderMainContent();
            } catch {
                cell.innerHTML = origHtml;
                showToast('Failed to update priority');
            }
        } else {
            cell.innerHTML = origHtml;
        }
    };

    select.addEventListener('blur', save);
    select.addEventListener('change', () => select.blur());
    select.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { cell.innerHTML = origHtml; }
    });
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


// ══════════════════════════════════════════════════════════════
// PHASE 2: Dependencies
// ══════════════════════════════════════════════════════════════

async function loadDetailDependencies() {
    if (!_detailTask) return;
    const el = document.getElementById('detail-dependencies');
    if (!el) return;
    try {
        const r = await apiFetch(`/api/items/${_detailTask.id}/dependencies`);
        let html = '';
        const outgoing = r.outgoing || [];
        const incoming = r.incoming || [];
        for (const d of outgoing) {
            const t = d.target_item || {};
            const isDone = t.status === 'done' || t.status === 'closed' || t.status === 'Complete';
            html += '<div class="th-dep-row">'
                + '<span class="th-dep-type">' + esc(d.type === 'blocks' ? 'Blocks' : d.type === 'relates_to' ? 'Relates to' : d.type) + '</span>'
                + '<span class="th-dep-title' + (isDone ? ' done' : '') + '" onclick="openDetail(\'' + esc(t.id || '') + '\')">'
                + (t.custom_id ? '<span class="th-custom-id">' + esc(t.custom_id) + '</span> ' : '')
                + esc(t.title || 'Unknown') + '</span>'
                + '<button class="th-dep-remove" onclick="removeDependency(\'' + esc(d.id) + '\')">&times;</button>'
                + '</div>';
        }
        for (const d of incoming) {
            const t = d.source_item || {};
            const isDone = t.status === 'done' || t.status === 'closed' || t.status === 'Complete';
            html += '<div class="th-dep-row">'
                + '<span class="th-dep-type">Blocked by</span>'
                + '<span class="th-dep-title' + (isDone ? ' done' : '') + '" onclick="openDetail(\'' + esc(t.id || '') + '\')">'
                + (t.custom_id ? '<span class="th-custom-id">' + esc(t.custom_id) + '</span> ' : '')
                + esc(t.title || 'Unknown') + '</span>'
                + '<button class="th-dep-remove" onclick="removeDependency(\'' + esc(d.id) + '\')">&times;</button>'
                + '</div>';
        }
        if (!html) html = '<div class="th-dep-empty">No dependencies</div>';
        el.innerHTML = html;
    } catch (e) {
        el.innerHTML = '<div class="th-dep-empty">Failed to load</div>';
    }
}

async function addDependency(targetId, type) {
    if (!_detailTask || !targetId) return;
    try {
        await apiFetch(`/api/items/${_detailTask.id}/dependencies`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target_id: targetId, type: type || 'blocks' }),
        });
        loadDetailDependencies();
        showToast('Dependency added');
    } catch (e) { showToast('Failed to add dependency', 'error'); }
}

async function removeDependency(depId) {
    try {
        await apiFetch(`/api/dependencies/${depId}`, { method: 'DELETE' });
        loadDetailDependencies();
        showToast('Dependency removed');
    } catch (e) { showToast('Failed to remove', 'error'); }
}

function openDepPicker() {
    const el = document.getElementById('dep-picker');
    if (!el) return;
    el.style.display = el.style.display === 'none' ? '' : 'none';
    if (el.style.display !== 'none') {
        el.innerHTML = '<input class="form-input th-dep-search" placeholder="Search items..." oninput="searchDeps(this.value)">'
            + '<select class="form-select th-dep-type-select" id="dep-type-select">'
            + '<option value="blocks">Blocks</option><option value="blocked_by">Blocked by</option><option value="relates_to">Relates to</option></select>'
            + '<div id="dep-search-results" class="th-dep-results"></div>';
    }
}

async function searchDeps(q) {
    if (!q || q.length < 2 || !_currentSpaceId) return;
    const el = document.getElementById('dep-search-results');
    if (!el) return;
    try {
        const r = await apiFetch(`/api/search?q=${encodeURIComponent(q)}`);
        const items = (r || []).filter(i => i.id !== _detailTask?.id).slice(0, 8);
        el.innerHTML = items.map(i =>
            '<div class="th-dep-result" onclick="addDependency(\'' + esc(i.id) + '\', document.getElementById(\'dep-type-select\').value)">'
            + (i.custom_id ? '<span class="th-custom-id">' + esc(i.custom_id) + '</span> ' : '')
            + esc(i.title) + '</div>'
        ).join('') || '<div class="th-dep-empty">No results</div>';
    } catch (e) { el.innerHTML = ''; }
}




// ══════════════════════════════════════════════════════════════
// PHASE 2: Time Tracking
// ══════════════════════════════════════════════════════════════

let _activeTimer = null; // { itemId, startedAt }

function initTimer() {
    const saved = localStorage.getItem('teamhub_timer');
    if (saved) {
        try { _activeTimer = JSON.parse(saved); } catch (e) {}
    }
}
initTimer();

function startTimer(itemId) {
    _activeTimer = { itemId, startedAt: Date.now() };
    localStorage.setItem('teamhub_timer', JSON.stringify(_activeTimer));
    renderTimeTracking();
    showToast('Timer started');
}

async function stopTimer() {
    if (!_activeTimer) return;
    const elapsed = Math.round((Date.now() - _activeTimer.startedAt) / 60000); // minutes
    if (elapsed > 0) {
        try {
            await apiFetch(`/api/items/${_activeTimer.itemId}/time-entries`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ duration: elapsed, started_at: new Date(_activeTimer.startedAt).toISOString() }),
            });
            showToast(`Logged ${elapsed}m`);
        } catch (e) { showToast('Failed to log time', 'error'); }
    }
    _activeTimer = null;
    localStorage.removeItem('teamhub_timer');
    renderTimeTracking();
    loadDetailTimeEntries();
}

async function logManualTime() {
    if (!_detailTask) return;
    const input = document.getElementById('manual-time-input');
    const mins = parseInt(input?.value);
    if (!mins || mins <= 0) return;
    try {
        await apiFetch(`/api/items/${_detailTask.id}/time-entries`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ duration: mins }),
        });
        input.value = '';
        showToast(`Logged ${mins}m`);
        loadDetailTimeEntries();
    } catch (e) { showToast('Failed to log time', 'error'); }
}

async function deleteTimeEntry(entryId) {
    try {
        await apiFetch(`/api/time-entries/${entryId}`, { method: 'DELETE' });
        loadDetailTimeEntries();
    } catch (e) { showToast('Failed to delete', 'error'); }
}

async function loadDetailTimeEntries() {
    if (!_detailTask) return;
    const el = document.getElementById('detail-time-entries');
    if (!el) return;
    try {
        const entries = await apiFetch(`/api/items/${_detailTask.id}/time-entries`);
        let html = '';
        let total = 0;
        for (const e of entries) {
            total += e.duration || 0;
            const date = e.created_at ? new Date(e.created_at).toLocaleDateString() : '';
            html += '<div class="th-time-entry">'
                + '<span class="th-time-dur">' + formatDuration(e.duration) + '</span>'
                + (e.description ? '<span class="th-time-desc">' + esc(e.description) + '</span>' : '')
                + '<span class="th-time-date">' + date + '</span>'
                + '<button class="th-dep-remove" onclick="deleteTimeEntry(\'' + esc(e.id) + '\')">&times;</button>'
                + '</div>';
        }
        if (!html) html = '<div class="th-dep-empty">No time logged</div>';
        el.innerHTML = html;

        // Update total display
        const totalEl = document.getElementById('time-total');
        if (totalEl) totalEl.textContent = formatDuration(total);
    } catch (e) {}
}

function formatDuration(mins) {
    if (!mins) return '0m';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
}

function renderTimeTracking() {
    const el = document.getElementById('detail-time-tracking');
    if (!el || !_detailTask) return;
    const isTimerRunning = _activeTimer && _activeTimer.itemId === _detailTask.id;
    const est = _detailTask.time_estimate || 0;
    const logged = _detailTask.time_logged || 0;

    let html = '<div class="th-time-header">'
        + '<span>Est: <input type="number" class="th-time-est-input" value="' + est + '" min="0" onchange="updateTimeEstimate(this.value)" title="Minutes"> min</span>'
        + '<span>Logged: <span id="time-total">' + formatDuration(logged) + '</span></span>';
    if (est > 0) {
        const pct = Math.min(100, Math.round(logged / est * 100));
        html += '<div class="th-time-bar"><div class="th-time-bar-fill" style="width:' + pct + '%"></div></div>';
    }
    html += '</div>';

    if (isTimerRunning) {
        html += '<button class="btn btn-small btn-accent" onclick="stopTimer()">Stop Timer</button>';
    } else {
        html += '<button class="btn btn-small btn-ghost" onclick="startTimer(\'' + esc(_detailTask.id) + '\')">Start Timer</button>';
    }
    html += '<div style="display:flex;gap:6px;align-items:center;margin-top:6px;">'
        + '<input type="number" class="form-input th-time-est-input" id="manual-time-input" placeholder="mins" min="1" style="width:70px;">'
        + '<button class="btn btn-small btn-ghost" onclick="logManualTime()">+ Log</button></div>';
    html += '<div id="detail-time-entries" style="margin-top:8px;">Loading...</div>';
    el.innerHTML = html;
    loadDetailTimeEntries();
}

async function updateTimeEstimate(val) {
    if (!_detailTask) return;
    try {
        await apiFetch(`/api/items/${_detailTask.id}/time-estimate`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ time_estimate: parseInt(val) || 0 }),
        });
    } catch (e) {}
}


// ══════════════════════════════════════════════════════════════
// PHASE 2: Custom Fields
// ══════════════════════════════════════════════════════════════

let _customFields = [];

async function loadCustomFields(wsId) {
    if (!wsId) return;
    try {
        _customFields = await apiFetch(`/api/workspaces/${wsId}/custom-fields`);
    } catch (e) { _customFields = []; }
}

async function loadDetailCustomFields() {
    if (!_detailTask) return;
    const el = document.getElementById('detail-custom-fields');
    if (!el) return;
    try {
        const values = await apiFetch(`/api/items/${_detailTask.id}/field-values`);
        const valueMap = {};
        for (const v of values) valueMap[v.field_id] = v;

        let html = '';
        for (const f of _customFields) {
            const val = valueMap[f.id];
            const curVal = val ? val.value : '';
            html += '<div class="th-cf-row">'
                + '<span class="th-cf-label">' + esc(f.name) + '</span>';
            if (f.type === 'checkbox') {
                html += '<input type="checkbox"' + (curVal === 'true' ? ' checked' : '') + ' onchange="setFieldValue(\'' + esc(f.id) + '\', this.checked ? \'true\' : \'false\')">';
            } else if (f.type === 'dropdown' && f.options && f.options.length) {
                html += '<select class="form-select th-cf-input" onchange="setFieldValue(\'' + esc(f.id) + '\', this.value)">'
                    + '<option value="">—</option>';
                for (const opt of f.options) {
                    html += '<option value="' + esc(opt) + '"' + (curVal === opt ? ' selected' : '') + '>' + esc(opt) + '</option>';
                }
                html += '</select>';
            } else if (f.type === 'date') {
                html += '<input type="date" class="form-input th-cf-input" value="' + esc(curVal) + '" onchange="setFieldValue(\'' + esc(f.id) + '\', this.value)">';
            } else if (f.type === 'number') {
                html += '<input type="number" class="form-input th-cf-input" value="' + esc(curVal) + '" onblur="setFieldValue(\'' + esc(f.id) + '\', this.value)">';
            } else {
                html += '<input type="' + (f.type === 'url' ? 'url' : f.type === 'email' ? 'email' : 'text') + '" class="form-input th-cf-input" value="' + esc(curVal) + '" onblur="setFieldValue(\'' + esc(f.id) + '\', this.value)">';
            }
            html += '</div>';
        }
        if (!html) html = '<div class="th-dep-empty">No custom fields defined</div>';
        el.innerHTML = html;
    } catch (e) {
        el.innerHTML = '';
    }
}

async function setFieldValue(fieldId, value) {
    if (!_detailTask) return;
    try {
        await apiFetch(`/api/items/${_detailTask.id}/field-values/${fieldId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value }),
        });
    } catch (e) { showToast('Failed to save field', 'error'); }
}

function renderSettingsCustomFields() {
    const el = document.getElementById('settings-tab-custom-fields');
    if (!el) return;
    const isOwner = _isSettingsOwner();
    let html = '<div class="settings-info-box">Define custom fields for items in this workspace. Fields appear in the detail panel.</div>';
    html += '<div class="settings-list">';
    for (const f of _customFields) {
        html += '<div class="settings-item">'
            + '<span class="settings-item-name">' + esc(f.name) + '</span>'
            + '<span class="th-cf-type-badge">' + esc(f.type) + '</span>';
        if (isOwner) {
            html += '<button class="settings-delete" onclick="deleteCustomField(\'' + esc(f.id) + '\')">&times;</button>';
        }
        html += '</div>';
    }
    html += '</div>';
    if (isOwner) {
        html += '<div style="display:flex;gap:6px;margin-top:12px;align-items:flex-end;">'
            + '<input class="form-input" id="cf-new-name" placeholder="Field name" style="flex:1;">'
            + '<select class="form-select" id="cf-new-type" style="width:120px;">'
            + '<option value="text">Text</option><option value="number">Number</option><option value="dropdown">Dropdown</option>'
            + '<option value="date">Date</option><option value="checkbox">Checkbox</option>'
            + '<option value="url">URL</option><option value="email">Email</option></select>'
            + '<button class="btn btn-accent btn-small" onclick="createCustomField()">Add</button></div>';
        html += '<div id="cf-dropdown-options" style="display:none;margin-top:8px;">'
            + '<label class="form-label" style="font-size:11px;">Options (comma-separated)</label>'
            + '<input class="form-input" id="cf-new-options" placeholder="Option 1, Option 2, ...">'
            + '</div>';
    }
    el.innerHTML = html;
    // Show/hide dropdown options
    const typeSelect = document.getElementById('cf-new-type');
    if (typeSelect) {
        typeSelect.addEventListener('change', () => {
            const optDiv = document.getElementById('cf-dropdown-options');
            if (optDiv) optDiv.style.display = typeSelect.value === 'dropdown' ? '' : 'none';
        });
    }
}

async function createCustomField() {
    if (!_currentSpaceId) return;
    const name = document.getElementById('cf-new-name')?.value?.trim();
    const type = document.getElementById('cf-new-type')?.value || 'text';
    if (!name) return;
    const options = type === 'dropdown' ? (document.getElementById('cf-new-options')?.value || '').split(',').map(s => s.trim()).filter(Boolean) : [];
    try {
        await apiFetch(`/api/workspaces/${_currentSpaceId}/custom-fields`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, type, options }),
        });
        await loadCustomFields(_currentSpaceId);
        renderSettingsCustomFields();
        showToast('Field created');
    } catch (e) { showToast('Failed to create field', 'error'); }
}

async function deleteCustomField(fieldId) {
    try {
        await apiFetch(`/api/custom-fields/${fieldId}`, { method: 'DELETE' });
        await loadCustomFields(_currentSpaceId);
        renderSettingsCustomFields();
        showToast('Field deleted');
    } catch (e) { showToast('Failed to delete', 'error'); }
}


// ══════════════════════════════════════════════════════════════
// PHASE 2: Automations
// ══════════════════════════════════════════════════════════════

let _automations = [];

async function loadAutomations(wsId) {
    if (!wsId) return;
    try {
        _automations = await apiFetch(`/api/workspaces/${wsId}/automations`);
    } catch (e) { _automations = []; }
}

function renderSettingsAutomations() {
    const el = document.getElementById('settings-tab-automations');
    if (!el) return;
    const isOwner = _isSettingsOwner();
    let html = '<div class="settings-info-box">Automations run when items change. When a trigger fires, the action executes automatically.</div>';
    html += '<div class="settings-list">';
    for (const a of _automations) {
        html += '<div class="settings-item th-auto-item">'
            + '<div class="th-auto-info">'
            + '<span class="th-auto-name">' + esc(a.name) + '</span>'
            + '<span class="th-auto-rule">When <b>' + esc(a.trigger_type.replace(/_/g, ' ')) + '</b> → <b>' + esc(a.action_type.replace(/_/g, ' ')) + '</b></span>'
            + '</div>'
            + '<label class="th-auto-toggle"><input type="checkbox"' + (a.active ? ' checked' : '') + ' onchange="toggleAutomation(\'' + esc(a.id) + '\', this.checked)"></label>';
        if (isOwner) html += '<button class="settings-delete" onclick="deleteAutomation(\'' + esc(a.id) + '\')">&times;</button>';
        html += '</div>';
    }
    if (!_automations.length) html += '<div class="th-dep-empty" style="padding:12px;">No automations yet</div>';
    html += '</div>';
    if (isOwner) {
        html += '<div class="th-auto-form" style="margin-top:16px;border-top:1px solid var(--border);padding-top:12px;">'
            + '<div class="form-group"><label class="form-label">Name</label><input class="form-input" id="auto-name" placeholder="e.g. Auto-close done items"></div>'
            + '<div style="display:flex;gap:8px;">'
            + '<div class="form-group" style="flex:1;"><label class="form-label">When (Trigger)</label>'
            + '<select class="form-select" id="auto-trigger">'
            + '<option value="status_changed">Status Changed</option>'
            + '<option value="priority_changed">Priority Changed</option>'
            + '<option value="item_created">Item Created</option>'
            + '<option value="due_date_passed">Due Date Passed</option></select></div>'
            + '<div class="form-group" style="flex:1;"><label class="form-label">Then (Action)</label>'
            + '<select class="form-select" id="auto-action">'
            + '<option value="change_status">Change Status</option>'
            + '<option value="change_priority">Change Priority</option>'
            + '<option value="add_assignee">Add Assignee</option>'
            + '<option value="send_notification">Send Notification</option>'
            + '<option value="move_to_list">Move to List</option>'
            + '<option value="add_tag">Add Tag</option></select></div></div>'
            + '<div class="form-group"><label class="form-label">Trigger Config (JSON)</label><input class="form-input" id="auto-trigger-cfg" placeholder=\'{"to_status":"done"}\'></div>'
            + '<div class="form-group"><label class="form-label">Action Config (JSON)</label><input class="form-input" id="auto-action-cfg" placeholder=\'{"status":"closed"}\'></div>'
            + '<button class="btn btn-accent btn-small" onclick="createAutomation()">Create Automation</button></div>';
    }
    el.innerHTML = html;
}

async function createAutomation() {
    if (!_currentSpaceId) return;
    const name = document.getElementById('auto-name')?.value?.trim();
    const trigger_type = document.getElementById('auto-trigger')?.value;
    const action_type = document.getElementById('auto-action')?.value;
    if (!name) return;
    let trigger_config = {}, action_config = {};
    try { trigger_config = JSON.parse(document.getElementById('auto-trigger-cfg')?.value || '{}'); } catch (e) {}
    try { action_config = JSON.parse(document.getElementById('auto-action-cfg')?.value || '{}'); } catch (e) {}
    try {
        await apiFetch(`/api/workspaces/${_currentSpaceId}/automations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, trigger_type, trigger_config, action_type, action_config }),
        });
        await loadAutomations(_currentSpaceId);
        renderSettingsAutomations();
        showToast('Automation created');
    } catch (e) { showToast('Failed to create', 'error'); }
}

async function toggleAutomation(autoId, active) {
    try {
        await apiFetch(`/api/automations/${autoId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ active }),
        });
    } catch (e) { showToast('Failed to update', 'error'); }
}

async function deleteAutomation(autoId) {
    try {
        await apiFetch(`/api/automations/${autoId}`, { method: 'DELETE' });
        await loadAutomations(_currentSpaceId);
        renderSettingsAutomations();
        showToast('Automation deleted');
    } catch (e) { showToast('Failed to delete', 'error'); }
}
