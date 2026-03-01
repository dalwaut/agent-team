/* OPAI Task Control Panel — Client Logic */

// ── State ────────────────────────────────────────────────
let tasks = [];
let filteredTasks = [];
let selectedIds = new Set();
let sortColumn = 'id';
let sortDir = 'desc';
let currentPage = 1;
const pageSize = 25;
let settings = {};
let feedbackPollTimer = null;
let feedbackBadgeTimer = null;
let currentDetailId = null;
let currentHitlFile = null;
let emailTaskId = null;
let _tasksInitialized = false;  // Set to true after first successful load

// Status transition tracking
let previousTaskStatuses = {};  // task_id → last known status
let justCompletedTasks = new Set();  // task IDs recently completed (green flash)
let justTransitionedTasks = new Map();  // task_id → new status (brief flash on transition)
let transitionTimers = {};  // task_id → setTimeout handle for clearing transition class
let completionTimers = {};  // task_id → setTimeout handle for auto-archive

// Reference data (loaded once)
let contactsData = { contacts: [], specialAssignees: [] };
let projectsData = { projects: [], clients: [] };
let emailAccounts = [];
let squadsData = [];
let agentsData = { agents: [], squads: [] };

// ── Column Configuration ─────────────────────────────────
const DEFAULT_COLUMNS = [
    { key: 'id',       label: 'ID',       visible: true },
    { key: 'title',    label: 'Title',    visible: true },
    { key: 'status',   label: 'Status',   visible: true },
    { key: 'priority', label: 'Priority', visible: true },
    { key: 'assignee', label: 'Assignee', visible: true },
    { key: 'project',  label: 'Project',  visible: true },
    { key: 'client',   label: 'Client',   visible: true },
    { key: 'deadline', label: 'Deadline', visible: true },
    { key: 'source',   label: 'Source',   visible: true },
];

let columnConfig = loadColumnConfig();

function loadColumnConfig() {
    try {
        const saved = localStorage.getItem('opai_tasks_columns');
        if (saved) {
            const parsed = JSON.parse(saved);
            // Merge with defaults in case new columns were added
            const knownKeys = new Set(parsed.map(c => c.key));
            const merged = [...parsed];
            for (const def of DEFAULT_COLUMNS) {
                if (!knownKeys.has(def.key)) merged.push({ ...def });
            }
            return merged;
        }
    } catch {}
    return DEFAULT_COLUMNS.map(c => ({ ...c }));
}

function saveColumnConfig() {
    localStorage.setItem('opai_tasks_columns', JSON.stringify(columnConfig));
}

function getVisibleColumns() {
    return columnConfig.filter(c => c.visible);
}

// ── Auth ─────────────────────────────────────────────────
async function getToken() {
    // Use Supabase JWT from opaiAuth (preferred), fall back to legacy localStorage token
    if (typeof opaiAuth !== 'undefined' && opaiAuth.getToken) {
        try {
            const token = await opaiAuth.getToken();
            if (token) return token;
        } catch (e) {
            console.warn('opaiAuth.getToken() failed:', e.message);
        }
    }
    return localStorage.getItem('opai_tasks_token') || '';
}

async function authHeaders() {
    const token = await getToken();
    const h = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
}

async function authFetch(url, opts = {}) {
    opts.headers = { ...(await authHeaders()), ...(opts.headers || {}) };
    const resp = await fetch(url, opts);
    if (resp.status === 401 || resp.status === 403) {
        // Try refreshing the Supabase token once
        if (typeof opaiAuth !== 'undefined' && opaiAuth.getToken) {
            try {
                const freshToken = await opaiAuth.getToken();
                if (freshToken) {
                    opts.headers['Authorization'] = `Bearer ${freshToken}`;
                    return fetch(url, opts);
                }
            } catch (e) {
                console.warn('Token refresh failed:', e.message);
            }
        }
        console.error('Auth failed for', url, '- status', resp.status);
    }
    return resp;
}

// ── Searchable Select Component ─────────────────────────
function createSearchableSelect(containerId, options, opts = {}) {
    const container = document.getElementById(containerId);
    if (!container) return null;

    const placeholder = opts.placeholder || 'Type to search...';
    const allowFreeText = opts.allowFreeText !== false;
    const onSelect = opts.onSelect || (() => {});

    container.innerHTML = '';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = placeholder;
    input.setAttribute('autocomplete', 'off');

    const dropdown = document.createElement('div');
    dropdown.className = 'ss-dropdown';

    container.appendChild(input);
    container.appendChild(dropdown);

    let highlighted = -1;

    function renderOptions(filter) {
        const q = (filter || '').toLowerCase();
        const matches = options.filter(o => {
            const label = (o.label || '').toLowerCase();
            const meta = (o.meta || '').toLowerCase();
            return !q || label.includes(q) || meta.includes(q);
        });

        if (!matches.length) {
            dropdown.innerHTML = '<div class="ss-empty">No matches</div>';
            return;
        }

        dropdown.innerHTML = matches.map((o, i) => {
            const metaHtml = o.meta ? `<span class="ss-meta">${esc(o.meta)}</span>` : '';
            return `<div class="ss-option" data-value="${escAttr(o.value)}" data-index="${i}">
                <span class="ss-label">${esc(o.label)}</span>${metaHtml}
            </div>`;
        }).join('');

        highlighted = -1;
    }

    function selectOption(value, label) {
        input.value = label || value;
        container.classList.remove('open');
        container._value = value;
        onSelect(value, label);
    }

    input.addEventListener('focus', () => {
        renderOptions(input.value);
        container.classList.add('open');
    });

    input.addEventListener('input', () => {
        renderOptions(input.value);
        container.classList.add('open');
        container._value = allowFreeText ? input.value : '';
    });

    input.addEventListener('keydown', (e) => {
        const items = dropdown.querySelectorAll('.ss-option');
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            highlighted = Math.min(highlighted + 1, items.length - 1);
            items.forEach((el, i) => el.classList.toggle('highlighted', i === highlighted));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            highlighted = Math.max(highlighted - 1, 0);
            items.forEach((el, i) => el.classList.toggle('highlighted', i === highlighted));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (highlighted >= 0 && items[highlighted]) {
                const opt = items[highlighted];
                selectOption(opt.dataset.value, opt.querySelector('.ss-label').textContent);
            } else if (allowFreeText) {
                container._value = input.value;
                container.classList.remove('open');
            }
        } else if (e.key === 'Escape') {
            container.classList.remove('open');
        }
    });

    dropdown.addEventListener('click', (e) => {
        const opt = e.target.closest('.ss-option');
        if (opt) {
            selectOption(opt.dataset.value, opt.querySelector('.ss-label').textContent);
        }
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
        if (!container.contains(e.target)) {
            container.classList.remove('open');
            if (!allowFreeText && !options.find(o => o.label === input.value || o.value === input.value)) {
                // Invalid entry — clear
            }
        }
    });

    // Public API
    container._value = '';
    container.getValue = () => container._value || input.value || '';
    container.setValue = (val) => {
        input.value = val || '';
        container._value = val || '';
    };

    return container;
}

// ── Build Option Lists ──────────────────────────────────
function getAssigneeOptions() {
    return [
        { value: '',      label: 'Unassigned',           meta: '' },
        { value: 'human', label: 'Human',                meta: 'Assigned to a human for manual action' },
        { value: 'agent', label: 'Agent (Auto-Assign)',   meta: 'System classifies task and picks the best agent or squad' },
    ];
}

function getProjectOptions() {
    return (projectsData.projects || []).map(p => ({ value: p, label: p, meta: '' }));
}

function getClientOptions() {
    return (projectsData.clients || []).map(c => ({ value: c, label: c, meta: '' }));
}

function getAgentOptions() {
    const opts = [{ value: 'auto:', label: 'Auto (let system decide)', meta: 'Classifies task and picks best agent' }];
    // Agents grouped
    for (const a of agentsData.agents || []) {
        opts.push({ value: `agent:${a.id}`, label: a.name, meta: briefAgentDesc(a) });
    }
    // Squads
    for (const s of agentsData.squads || []) {
        const agentCount = (s.agents || []).length;
        opts.push({ value: `squad:${s.id}`, label: `[Squad] ${s.name}`, meta: briefAgentDesc(s, agentCount) });
    }
    return opts;
}

function briefAgentDesc(a, agentCount) {
    // Return a short description for the agent picker dropdown
    const d = (a.description || '').replace(/\.$/, '');
    if (agentCount !== undefined) {
        // Squad: show description or agent count
        if (d) {
            // Truncate to first sentence or ~60 chars
            const short = d.length > 60 ? d.substring(0, 57) + '...' : d;
            return `${agentCount} agents — ${short}`;
        }
        return `${agentCount} agents`;
    }
    // Agent: truncate long descriptions
    if (d.length > 60) return d.substring(0, 57) + '...';
    return d || a.category || '';
}

function getEmailToOptions() {
    const opts = [];
    for (const c of contactsData.contacts || []) {
        for (const email of c.emails || []) {
            opts.push({ value: email, label: email, meta: c.name });
        }
    }
    return opts;
}

// ── Init ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    loadReferenceData();
    refreshAll();
    loadSquads();
    loadHitl();

    // Kill Chrome autofill on all TCP inputs
    const searchInput = document.getElementById('searchInput');
    searchInput.value = '';
    let _searchUserActive = false;
    searchInput.addEventListener('focus', () => { _searchUserActive = true; });
    // Delayed clear: Chrome autofill fires ~100-300ms after DOMContentLoaded
    setTimeout(() => {
        if (!_searchUserActive && searchInput.value) {
            searchInput.value = '';
            applyFilters();
        }
    }, 500);
    setTimeout(() => {
        if (!_searchUserActive && searchInput.value) {
            searchInput.value = '';
            applyFilters();
        }
    }, 1500);

    // Filter listeners
    ['filterStatus', 'filterPriority', 'filterProject', 'filterClient', 'filterAssignee', 'filterSource'].forEach(id => {
        document.getElementById(id).addEventListener('change', () => applyFilters(true));
    });
    searchInput.addEventListener('input', debounce(() => {
        if (!_searchUserActive) {
            searchInput.value = '';
            applyFilters();
            return;
        }
        applyFilters(true);
    }, 300));
    document.getElementById('autoExecToggle').addEventListener('change', toggleAutoExec);
    document.getElementById('queueEnabledToggle').addEventListener('change', toggleQueueEnabled);

    // Feedback filter listeners
    ['feedbackFilterTool', 'feedbackFilterSeverity', 'feedbackFilterStatus'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', renderFeedback);
    });
    loadFeedbackBadge();

    // Polling
    setInterval(loadTasks, 15000);
    setInterval(loadSummary, 10000);
    setInterval(loadSettings, 30000);
    setInterval(loadExecutorStatus, 10000);
    setupFeedbackPolling();
    loadExecutorStatus();

    // Hash-based routing (e.g. /tasks/#health from redirects)
    if (location.hash === '#health') {
        switchView('health');
    }
});

function debounce(fn, ms) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// ── Reference Data Loading ──────────────────────────────
async function loadReferenceData() {
    try {
        const [contactsResp, projectsResp, emailResp, agentsResp] = await Promise.all([
            fetch('api/contacts'),
            fetch('api/projects'),
            fetch('api/email-accounts'),
            fetch('api/agents'),
        ]);
        contactsData = await contactsResp.json();
        projectsData = await projectsResp.json();
        const emailData = await emailResp.json();
        emailAccounts = emailData.accounts || [];
        agentsData = await agentsResp.json();
    } catch (e) {
        console.error('Failed to load reference data:', e);
    }
}

// ── Data Loading ─────────────────────────────────────────
async function refreshAll() {
    await Promise.all([loadTasks(), loadSummary(), loadSettings(), loadAuditBadge()]);
}

async function loadTasks() {
    try {
        const resp = await fetch('api/tasks?_t=' + Date.now());
        if (!resp.ok) {
            console.warn('[TCP] loadTasks: HTTP', resp.status);
            return;  // Keep existing tasks — don't wipe on error
        }
        const data = await resp.json();
        const newTasks = data.tasks;
        if (!Array.isArray(newTasks)) {
            console.warn('[TCP] loadTasks: invalid response', typeof data, Object.keys(data));
            return;  // Keep existing tasks
        }
        tasks = newTasks;
        console.debug('[TCP] loadTasks:', tasks.length, 'tasks');

        // Detect status transitions
        for (const t of tasks) {
            const prev = previousTaskStatuses[t.id];
            if (prev && prev !== t.status) {
                // Completed transition — green flash + auto-archive
                if (t.status === 'completed') {
                    justCompletedTasks.add(t.id);
                    startAutoArchiveTimer(t);
                }
                // Other notable transitions — brief highlight flash
                if (t.status === 'running' || t.status === 'scheduled' || t.status === 'failed') {
                    justTransitionedTasks.set(t.id, t.status);
                    // Clear transition after 10 seconds
                    if (transitionTimers[t.id]) clearTimeout(transitionTimers[t.id]);
                    transitionTimers[t.id] = setTimeout(() => {
                        justTransitionedTasks.delete(t.id);
                        delete transitionTimers[t.id];
                        renderTable();
                    }, 10000);
                }
            }
            previousTaskStatuses[t.id] = t.status;
        }

        populateFilters();

        // On first load, default the Status filter to show actionable tasks
        if (!_tasksInitialized) {
            _tasksInitialized = true;
            const statusSel = document.getElementById('filterStatus');
            if (statusSel && !statusSel.value) {
                statusSel.value = 'pending';
            }
        }

        applyFilters();
        updateQueueBadge();
    } catch (e) {
        console.error('[TCP] loadTasks error:', e);
    }
}

async function loadSummary() {
    try {
        const resp = await fetch('api/tasks/summary');
        const data = await resp.json();
        document.getElementById('statTotal').textContent = data.total || 0;
        document.getElementById('statPending').textContent = (data.by_status || {}).pending || 0;
        document.getElementById('statOverdue').textContent = data.overdue || 0;
        renderStats(data);
    } catch (e) {
        console.error('Failed to load summary:', e);
    }
}

async function loadSettings() {
    try {
        const resp = await fetch('api/settings');
        settings = await resp.json();
        document.getElementById('autoExecToggle').checked = settings.auto_execute || false;
        const queueToggle = document.getElementById('queueEnabledToggle');
        if (queueToggle) {
            queueToggle.checked = settings.queue_enabled !== false; // default true
            updateQueueStatusBadge(settings.queue_enabled !== false);
        }
        // Sync autofix threshold dropdown
        const thresholdSelect = document.getElementById('feedbackAutofixThreshold');
        if (thresholdSelect) {
            thresholdSelect.value = settings.feedback_autofix_threshold || 'HIGH';
            styleAutofixSelect(thresholdSelect);
        }
        // Re-apply polling config if it changed
        setupFeedbackPolling();
    } catch (e) {
        console.error('Failed to load settings:', e);
    }
}

function styleAutofixSelect() {
    // No-op — colors are applied via CSS on the individual options
}

async function updateAutofixThreshold(value) {
    try {
        const resp = await authFetch('api/settings', {
            method: 'POST',
            body: JSON.stringify({ feedback_autofix_threshold: value }),
        });
        const data = await resp.json();
        if (resp.ok && data.success) {
            settings.feedback_autofix_threshold = value;
            showToast(`Auto-fix threshold set to ${value}`);
        } else {
            alert('Failed to update: ' + (data.error || 'Unknown'));
        }
    } catch (e) {
        alert('Error: ' + e.message);
    }
}

// ── Feedback Polling Settings ──────────────────────────────

function setupFeedbackPolling() {
    // Clear existing timers
    if (feedbackBadgeTimer) clearInterval(feedbackBadgeTimer);
    if (feedbackPollTimer) clearInterval(feedbackPollTimer);

    const onDemand = settings.feedback_poll_on_demand === true;
    const intervalSec = settings.feedback_poll_interval || 10;
    const intervalMs = intervalSec * 1000;

    if (onDemand) {
        // On-demand: no automatic polling, only manual Refresh
        feedbackBadgeTimer = null;
        feedbackPollTimer = null;
        return;
    }

    feedbackBadgeTimer = setInterval(loadFeedbackBadge, intervalMs);
    feedbackPollTimer = setInterval(() => {
        if (currentView === 'feedback' && !feedbackUserInteracting()) loadFeedback();
    }, intervalMs);
}

function _secondsToUnitValue(totalSec) {
    if (totalSec >= 86400 && totalSec % 86400 === 0) return { value: totalSec / 86400, unit: 'days' };
    if (totalSec >= 3600 && totalSec % 3600 === 0) return { value: totalSec / 3600, unit: 'hours' };
    if (totalSec >= 60 && totalSec % 60 === 0) return { value: totalSec / 60, unit: 'minutes' };
    return { value: totalSec, unit: 'seconds' };
}

function _unitValueToSeconds(value, unit) {
    const v = parseFloat(value) || 1;
    switch (unit) {
        case 'days': return Math.round(v * 86400);
        case 'hours': return Math.round(v * 3600);
        case 'minutes': return Math.round(v * 60);
        default: return Math.round(v);
    }
}

function showFeedbackSettings() {
    const totalSec = settings.feedback_poll_interval || 10;
    const onDemand = settings.feedback_poll_on_demand === true;
    const { value, unit } = _secondsToUnitValue(totalSec);

    function sel(u) { return u === unit ? ' selected' : ''; }

    const html = '<div class="modal-overlay visible" id="feedbackSettingsModal" onclick="if(event.target===this)this.remove()">' +
        '<div class="modal" style="max-width:420px">' +
            '<div class="modal-header"><h3>Feedback Polling</h3><button class="modal-close" onclick="document.getElementById(\'feedbackSettingsModal\').remove()">&times;</button></div>' +
            '<div class="modal-body">' +
                '<div class="form-group">' +
                    '<label class="form-label">Mode</label>' +
                    '<select id="fbPollMode" class="form-input" style="width:100%" onchange="document.getElementById(\'fbIntervalGroup\').style.display=this.value===\'auto\'?\'block\':\'none\'">' +
                        '<option value="auto"' + (!onDemand ? ' selected' : '') + '>Auto-poll (timed interval)</option>' +
                        '<option value="ondemand"' + (onDemand ? ' selected' : '') + '>On-demand only (manual Refresh)</option>' +
                    '</select>' +
                '</div>' +
                '<div class="form-group" id="fbIntervalGroup" style="' + (onDemand ? 'display:none' : '') + '">' +
                    '<label class="form-label">Poll Interval</label>' +
                    '<div style="display:flex;align-items:center;gap:8px">' +
                        '<input type="number" id="fbIntervalValue" class="form-input" value="' + value + '" min="1" step="1" style="width:80px">' +
                        '<select id="fbIntervalUnit" class="form-input" style="width:auto">' +
                            '<option value="seconds"' + sel('seconds') + '>seconds</option>' +
                            '<option value="minutes"' + sel('minutes') + '>minutes</option>' +
                            '<option value="hours"' + sel('hours') + '>hours</option>' +
                            '<option value="days"' + sel('days') + '>days</option>' +
                        '</select>' +
                    '</div>' +
                    '<small class="text-muted">Default: 10 seconds. Higher values reduce overhead.</small>' +
                '</div>' +
            '</div>' +
            '<div class="modal-footer">' +
                '<button class="btn" onclick="document.getElementById(\'feedbackSettingsModal\').remove()">Cancel</button>' +
                '<button class="btn btn-primary" onclick="saveFeedbackSettings()">Save</button>' +
            '</div>' +
        '</div>' +
    '</div>';

    document.body.insertAdjacentHTML('beforeend', html);
}

async function saveFeedbackSettings() {
    const mode = document.getElementById('fbPollMode').value;
    const onDemand = mode === 'ondemand';
    const rawValue = document.getElementById('fbIntervalValue').value;
    const unit = document.getElementById('fbIntervalUnit').value;
    const intervalSec = _unitValueToSeconds(rawValue, unit);

    if (intervalSec < 5) {
        alert('Minimum interval is 5 seconds.');
        return;
    }

    const payload = {
        feedback_poll_interval: intervalSec,
        feedback_poll_on_demand: onDemand,
    };

    try {
        const resp = await authFetch('api/settings', {
            method: 'POST',
            body: JSON.stringify(payload),
        });
        if (!resp.ok) {
            const body = await resp.json().catch(() => ({}));
            alert('Save failed: ' + (body.detail || body.error || 'HTTP ' + resp.status));
            return;
        }
        settings.feedback_poll_interval = intervalSec;
        settings.feedback_poll_on_demand = onDemand;
        setupFeedbackPolling();
        const { value: dispVal, unit: dispUnit } = _secondsToUnitValue(intervalSec);
        showToast(onDemand ? 'Polling set to on-demand' : 'Poll interval set to ' + dispVal + ' ' + dispUnit);
        document.getElementById('feedbackSettingsModal')?.remove();
    } catch (e) {
        alert('Error saving: ' + e.message);
    }
}

async function loadSquads() {
    try {
        const resp = await fetch('api/team/squads');
        const data = await resp.json();
        squadsData = data.squads || [];
        document.getElementById('squadCount').textContent = squadsData.length;
        const el = document.getElementById('squadList');
        if (!squadsData.length) {
            el.innerHTML = '<div class="empty-state">No squads found</div>';
            return;
        }
        el.innerHTML = squadsData.map(s => {
            const details = (s.agentsDetail || []).map(a =>
                `<div class="squad-agent-item"><span class="squad-agent-name">${esc(a.name || a.id)}</span><span class="squad-agent-desc">${esc(a.description || '')}</span></div>`
            ).join('');
            return `
            <div class="squad-item">
                <div class="squad-item-header" onclick="this.parentElement.classList.toggle('expanded'); event.stopPropagation();">
                    <div class="squad-item-left">
                        <span class="squad-expand-icon">&#9654;</span>
                        <span class="squad-name">${esc(s.name)}</span>
                        <span class="squad-agents">(${s.agents.length} agents)</span>
                    </div>
                    <button class="btn btn-primary btn-sm" onclick="runSquad('${esc(s.name)}'); event.stopPropagation();">Run</button>
                </div>
                ${s.description ? `<div class="squad-description">${esc(s.description)}</div>` : ''}
                <div class="squad-agents-detail">${details}</div>
            </div>`;
        }).join('');
    } catch (e) {
        console.error('Failed to load squads:', e);
    }
}

async function loadHitl() {
    try {
        const resp = await fetch('api/hitl');
        const data = await resp.json();
        const items = data.items || [];
        document.getElementById('hitlCount').textContent = items.length;
        const el = document.getElementById('hitlList');
        if (!items.length) {
            el.innerHTML = '<div class="empty-state">No briefings pending</div>';
            return;
        }
        el.innerHTML = items.map(i => `
            <div class="hitl-item">
                <span class="hitl-name" onclick="viewHitl('${esc(i.filename)}')">${esc(i.filename)}</span>
                <button class="btn" onclick="viewHitl('${esc(i.filename)}')">View</button>
            </div>
        `).join('');
    } catch (e) {
        console.error('Failed to load HITL:', e);
    }
}

// ── Filters ──────────────────────────────────────────────
function populateFilters() {
    const vals = { status: new Set(), priority: new Set(), project: new Set(), client: new Set(), assignee: new Set(), source: new Set() };
    for (const t of tasks) {
        if (t && typeof t === 'object') {
            if (t.status) vals.status.add(String(t.status));
            if (t.priority) vals.priority.add(String(t.priority));
            if (t.project) vals.project.add(String(t.project));
            if (t.client) vals.client.add(String(t.client));
            if (t.assignee) vals.assignee.add(String(t.assignee));
            if (t.source) vals.source.add(String(t.source));
        }
    }

    // Ensure all 9 canonical statuses always appear in the dropdown
    const ALL_STATUSES = ['pending','scheduled','running','paused','awaiting_retry','completed','failed','timed_out','cancelled'];
    ALL_STATUSES.forEach(s => vals.status.add(s));

    fillSelect('filterStatus', 'Status', vals.status);
    fillSelect('filterPriority', 'Priority', vals.priority);
    fillSelect('filterProject', 'Project', vals.project);
    fillSelect('filterClient', 'Client', vals.client);
    fillSelect('filterAssignee', 'Assignee', vals.assignee);
    fillSelect('filterSource', 'Source', vals.source);
}

function fillSelect(id, label, values) {
    const el = document.getElementById(id);
    if (!el) return;
    const current = el.value;
    el.length = 0;
    el.add(new Option(label, ''));
    [...values].sort().forEach(v => el.add(new Option(v, v)));
    if (current) el.value = current;
    // If the previous value no longer exists, el.value becomes '' (show all)
}

function applyFilters(resetPage = false) {
    const status = document.getElementById('filterStatus').value;
    const priority = document.getElementById('filterPriority').value;
    const project = document.getElementById('filterProject').value;
    const client = document.getElementById('filterClient').value;
    const assignee = document.getElementById('filterAssignee').value;
    const source = document.getElementById('filterSource').value;
    const searchEl = document.getElementById('searchInput');
    const search = searchEl.value.replace(/[\u200B-\u200D\uFEFF\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u2000-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F]/g, '').trim().toLowerCase();

    filteredTasks = tasks.filter(t => {
        if (status && t.status !== status) return false;
        if (priority && t.priority !== priority) return false;
        if (project && t.project !== project) return false;
        if (client && t.client !== client) return false;
        if (assignee && t.assignee !== assignee) return false;
        if (source && t.source !== source) return false;
        if (search && !(t.title + ' ' + (t.description || '')).toLowerCase().includes(search)) return false;
        return true;
    });

    sortTasks();
    if (resetPage) {
        currentPage = 1;
    } else {
        const maxPage = Math.max(1, Math.ceil(filteredTasks.length / pageSize));
        if (currentPage > maxPage) currentPage = maxPage;
    }
    renderTable();
}

// ── Sorting ──────────────────────────────────────────────
const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };

function setSort(col) {
    if (sortColumn === col) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
        sortColumn = col;
        sortDir = col === 'priority' ? 'asc' : 'desc';
    }
    sortTasks();
    renderTable();
}

function sortTasks() {
    filteredTasks.sort((a, b) => {
        let va, vb;
        if (sortColumn === 'priority') {
            va = priorityOrder[a.priority] ?? 2;
            vb = priorityOrder[b.priority] ?? 2;
        } else {
            va = a[sortColumn] || '';
            vb = b[sortColumn] || '';
        }
        if (va < vb) return sortDir === 'asc' ? -1 : 1;
        if (va > vb) return sortDir === 'asc' ? 1 : -1;
        // Tiebreaker: newest id first (t-YYYYMMDD-NNN is lexicographically ordered)
        return (b.id || '').localeCompare(a.id || '');
    });
}

// ── Table Rendering ──────────────────────────────────────
function renderCellHtml(key, t, today) {
    const isOverdue = t.deadline && t.deadline < today && t.status !== 'completed' && t.status !== 'cancelled';
    const sourceAccount = t.sourceRef && t.sourceRef.account ? t.sourceRef.account : '';
    switch (key) {
        case 'id':       return `<span class="task-id">${esc(t.id)}</span>`;
        case 'title':    return `<div class="task-title">${esc(t.title)}</div>`;
        case 'status':   return `<span class="chip chip-${t.status.replace('_','-')}">${esc(t.status)}</span>`;
        case 'priority': return `<span class="chip pri-${t.priority}">${esc(t.priority)}</span>`;
        case 'assignee': return `<span class="task-assignee">${esc(t.assignee || '\u2014')}</span>`;
        case 'project':  return `<span class="task-project">${esc(t.project || '\u2014')}</span>`;
        case 'client':   return `<span class="task-project">${esc(t.client || '\u2014')}</span>`;
        case 'deadline': return `<span class="task-deadline ${isOverdue ? 'overdue' : ''}">${t.deadline ? esc(t.deadline) : '\u2014'}</span>`;
        case 'source':   return `<span class="task-source">${esc(t.source || '\u2014')}</span>${sourceAccount ? `<div class="source-account">${esc(sourceAccount)}</div>` : ''}`;
        default:         return esc(t[key] || '\u2014');
    }
}

function renderTable() {
    const start = (currentPage - 1) * pageSize;
    const page = filteredTasks.slice(start, start + pageSize);
    const today = new Date().toISOString().slice(0, 10);
    const visCols = getVisibleColumns();
    const colCount = visCols.length + 1; // +1 for checkbox

    // Render thead
    const thead = document.getElementById('taskTableHead');
    thead.innerHTML = `<tr>
        <th><input type="checkbox" id="selectAll" onchange="toggleSelectAll()"></th>
        ${visCols.map(c => {
            const isSorted = c.key === sortColumn;
            const arrow = isSorted ? `<span class="sort-arrow">${sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span>` : '';
            return `<th data-sort="${c.key}" onclick="setSort('${c.key}')" class="${isSorted ? 'sorted' : ''}">${esc(c.label)}${arrow}</th>`;
        }).join('')}
    </tr>`;

    const tbody = document.getElementById('taskTableBody');
    if (!page.length) {
        tbody.innerHTML = `<tr><td colspan="${colCount}" class="empty-state">No tasks match filters</td></tr>`;
    } else {
        tbody.innerHTML = page.map(t => {
            let rowClass = selectedIds.has(t.id) ? 'selected' : '';
            if (t.status === 'running') rowClass += ' row-running';
            if (justCompletedTasks.has(t.id)) rowClass += ' row-just-completed';
            if (t.status === 'cancelled') rowClass += ' row-cancelled';
            if (t.status === 'scheduled') rowClass += ' row-scheduled';
            if (t.status === 'timed_out') rowClass += ' row-timed-out';
            if (t.status === 'awaiting_retry') rowClass += ' row-awaiting-retry';
            if (t.status === 'pending') rowClass += ' row-pending';
            if (t.status === 'paused') rowClass += ' row-paused';
            if (t.status === 'failed') rowClass += ' row-failed';
            // Transition flash effects (brief highlight on status change)
            if (justTransitionedTasks.has(t.id)) rowClass += ' row-just-transitioned-' + justTransitionedTasks.get(t.id);
            const rejReason = t.status === 'cancelled' && t.cancellationReason ? escAttr(t.cancellationReason) : '';
            const showResubmit = t.status === 'completed' || t.status === 'cancelled' || t.status === 'failed' || t.status === 'timed_out';
            return `
            <tr class="${rowClass.trim()}" onclick="openDetail('${t.id}')"${rejReason ? ` data-rejection-reason="${rejReason}"` : ''}>
                <td onclick="event.stopPropagation()">
                    <input type="checkbox" ${selectedIds.has(t.id) ? 'checked' : ''}
                        onchange="toggleSelect('${t.id}', this.checked)">
                </td>
                ${visCols.map(c => `<td>${renderCellHtml(c.key, t, today)}</td>`).join('')}
                <td onclick="event.stopPropagation()" class="row-actions-cell">
                    ${showResubmit ? `<button class="btn btn-sm btn-resubmit" onclick="resubmitTask('${escAttr(t.id)}')" title="Re-submit to queue">&#8635; Re-Submit</button>` : ''}
                </td>
            </tr>`;
        }).join('');
        bindRejectionTooltips();
    }

    // Footer info
    const total = filteredTasks.length;
    const showing = Math.min(page.length, pageSize);
    document.getElementById('tableInfo').textContent =
        `Showing ${start + 1}-${start + showing} of ${total} tasks`;

    // Pagination
    const pages = Math.ceil(total / pageSize);
    const pag = document.getElementById('pagination');
    if (pages <= 1) {
        pag.innerHTML = '';
    } else {
        let html = `<button ${currentPage <= 1 ? 'disabled' : ''} onclick="goPage(${currentPage - 1})">&lt;</button>`;
        for (let i = 1; i <= pages; i++) {
            html += `<button class="${i === currentPage ? 'active' : ''}" onclick="goPage(${i})">${i}</button>`;
        }
        html += `<button ${currentPage >= pages ? 'disabled' : ''} onclick="goPage(${currentPage + 1})">&gt;</button>`;
        pag.innerHTML = html;
    }

    updateBatchBar();
}

function goPage(p) {
    currentPage = p;
    renderTable();
}

// ── Selection ────────────────────────────────────────────
function toggleSelect(id, checked) {
    if (checked) selectedIds.add(id); else selectedIds.delete(id);
    updateBatchBar();
    renderTable();
}

function toggleSelectAll() {
    const checked = document.getElementById('selectAll').checked;
    const start = (currentPage - 1) * pageSize;
    const page = filteredTasks.slice(start, start + pageSize);
    page.forEach(t => { if (checked) selectedIds.add(t.id); else selectedIds.delete(t.id); });
    updateBatchBar();
    renderTable();
}

function updateBatchBar() {
    const bar = document.getElementById('batchBar');
    if (selectedIds.size > 0) {
        bar.classList.remove('hidden');
        document.getElementById('batchCount').textContent = `${selectedIds.size} selected`;
    } else {
        bar.classList.add('hidden');
    }
}

// ── Batch Actions ────────────────────────────────────────
async function batchAction(action) {
    if (!selectedIds.size) return;
    if (action === 'delete' && !confirm(`Delete ${selectedIds.size} tasks?`)) return;
    try {
        const resp = await authFetch('api/tasks/batch', {
            method: 'POST',
            body: JSON.stringify({ action, ids: [...selectedIds] }),
        });
        if (resp.ok) {
            selectedIds.clear();
            await refreshAll();
        }
    } catch (e) {
        console.error('Batch action failed:', e);
    }
}

async function batchDelegate() {
    for (const id of selectedIds) {
        await authFetch(`api/tasks/${id}/delegate`, {
            method: 'POST',
            body: JSON.stringify({}),
        });
    }
    selectedIds.clear();
    await refreshAll();
}

// ── Batch Edit ───────────────────────────────────────
function showBatchEditModal() {
    if (!selectedIds.size) return;

    document.getElementById('batchEditCount').textContent = `(${selectedIds.size} tasks)`;
    document.getElementById('batchStatus').value = '';
    document.getElementById('batchPriority').value = '';
    document.getElementById('batchDeadline').value = '';
    const batchMode = document.getElementById('batchRoutingMode');
    if (batchMode) batchMode.value = '';

    createSearchableSelect('batchAssigneeWrap', [{ value: '', label: '— No change —', meta: '' }, ...getAssigneeOptions()], {
        placeholder: 'Leave empty for no change...',
    });
    createSearchableSelect('batchProjectWrap', [{ value: '', label: '— No change —', meta: '' }, ...getProjectOptions()], {
        placeholder: 'Leave empty for no change...',
    });
    createSearchableSelect('batchClientWrap', [{ value: '', label: '— No change —', meta: '' }, ...getClientOptions()], {
        placeholder: 'Leave empty for no change...',
    });

    document.getElementById('batchEditModal').classList.add('visible');
}

async function submitBatchEdit() {
    if (!selectedIds.size) return;

    const fields = {};
    const status = document.getElementById('batchStatus').value;
    const priority = document.getElementById('batchPriority').value;
    const deadline = document.getElementById('batchDeadline').value;
    const routingMode = document.getElementById('batchRoutingMode') ? document.getElementById('batchRoutingMode').value : '';
    const assigneeWrap = document.getElementById('batchAssigneeWrap');
    const projectWrap = document.getElementById('batchProjectWrap');
    const clientWrap = document.getElementById('batchClientWrap');
    const assignee = assigneeWrap ? assigneeWrap.getValue() : '';
    const project = projectWrap ? projectWrap.getValue() : '';
    const client = clientWrap ? clientWrap.getValue() : '';

    // "Agent (Auto-Assign)" routes through auto-assign, not a literal field update
    const isAutoAssign = assignee === 'agent';

    if (!isAutoAssign) {
        if (assignee) fields.assignee = assignee;
    }
    if (project) fields.project = project;
    if (client) fields.client = client;
    if (deadline) fields.deadline = deadline;
    if (routingMode) fields.routing_mode = routingMode;

    if (!isAutoAssign && !Object.keys(fields).length) {
        alert('No fields selected to update');
        return;
    }

    const count = selectedIds.size;
    const summary = isAutoAssign
        ? `Auto-assign agents to ${count} task(s)?\n\nThe system will classify each task and pick the best agent or squad.`
        : `Apply changes to ${count} task(s)?\n\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}`;
    if (!confirm(summary)) return;

    try {
        const action = isAutoAssign ? 'auto-assign' : 'update';
        const body = isAutoAssign
            ? { action, ids: [...selectedIds] }
            : { action, ids: [...selectedIds], fields };

        const resp = await authFetch('api/tasks/batch', {
            method: 'POST',
            body: JSON.stringify(body),
        });
        const data = await resp.json().catch(function() { return {}; });
        if (!resp.ok) {
            alert(`Failed (${resp.status}): ${data.detail || data.error || 'Unknown error'}`);
            return;
        }
        if (data.success) {
            closeModal('batchEditModal');
            selectedIds.clear();
            await refreshAll();
            if (isAutoAssign) showToast(`Auto-assigned ${data.count} task(s)`);
        } else {
            alert(`Failed: ${data.error || data.detail || 'Unknown error'}`);
        }
    } catch (e) {
        alert(`Error: ${e.message}`);
    }
}

// ── Detail Panel ─────────────────────────────────────────
function openDetail(id) {
    const task = tasks.find(t => t.id === id);
    if (!task) return;
    currentDetailId = id;

    document.getElementById('detailId').textContent = id;

    const body = document.getElementById('detailBody');
    const routing = task.routing || {};
    const routingMode = routing.mode || 'propose';
    const modeLabels = { propose: 'Needs Approval', execute: 'Execute', queued: 'Queued (auto)', auto_safe: 'Auto-Safe' };
    const modeDesc = { propose: 'Waiting for human approval before the system can act', execute: 'Cleared to run — auto-executor will pick this up when enabled', queued: 'Explicitly queued by human — runs regardless of auto-execute setting', auto_safe: 'Low-risk task, may run without full review' };
    const bypassReason = task.bypassReason || '';
    const bypassBadge = bypassReason ? `<span class="bypass-badge bypass-${bypassReason.split('-')[0]}" data-tooltip="This task bypassed the approval gate: ${esc(bypassReason)}">${bypassReason === 'discord-admin' ? '⚡ Discord' : bypassReason === 'trusted-email' ? '✉ Trusted Email' : '⚙ System'}</span>` : '';
    const isPending = task.status === 'pending';
    const isScheduled = task.status === 'scheduled';
    const hasAgent = task.assignee === 'agent' && task.agentConfig?.agentId;

    body.innerHTML = `
        <div class="mode-panel">
            <div class="mode-panel-row">
                <div class="mode-panel-left">
                    <span class="mode-label" data-tooltip="${esc(modeDesc[routingMode] || routingMode)}">
                        Mode: <strong class="mode-badge mode-${routingMode}">${esc(modeLabels[routingMode] || routingMode)}</strong>
                    </span>
                    ${bypassBadge}
                </div>
                <div class="mode-panel-right">
                    <select class="mode-select" id="detRoutingMode" data-tooltip="Change the execution mode for this task. 'Needs Approval' = waits for human. 'Execute' = runs when auto-execute is on. 'Queued' = always runs regardless of auto-execute." onchange="changeRoutingMode(this.value)">
                        <option value="propose" ${routingMode === 'propose' ? 'selected' : ''}>Needs Approval</option>
                        <option value="execute" ${routingMode === 'execute' ? 'selected' : ''}>Execute</option>
                        <option value="queued" ${routingMode === 'queued' ? 'selected' : ''}>Queued (always runs)</option>
                        <option value="auto_safe" ${routingMode === 'auto_safe' ? 'selected' : ''}>Auto-Safe</option>
                    </select>
                </div>
            </div>
            ${task.approvedAt ? `<div class="mode-approved-info">Approved ${formatDate(task.approvedAt)} by <em>${esc(task.approvedBy || 'human')}</em></div>` : ''}
            ${isPending && hasAgent ? `<button class="btn btn-approve" onclick="approveTask('${escAttr(id)}')" data-tooltip="Schedule this task for execution. It will be picked up by the auto-executor on the next cycle.">✓ Approve Task</button>` : ''}
        </div>
        <div class="detail-section">
            <h4>Core</h4>
            <div class="form-group">
                <label data-tooltip="The task title — keep it concise and action-oriented">Title</label>
                <input type="text" id="detTitle" value="${escAttr(task.title)}" data-tooltip="Short description of what needs to be done">
            </div>
            <div class="form-group">
                <label data-tooltip="Current lifecycle status of this task">Status</label>
                <select id="detStatus" data-tooltip="pending = awaiting action | scheduled = approved, ready to execute | running = agent executing | paused = manually paused | awaiting_retry = failed, will retry | completed = done | failed = errored | timed_out = exceeded time limit | cancelled = dismissed">
                    ${['pending','scheduled','running','paused','awaiting_retry','completed','failed','timed_out','cancelled'].map(s =>
                        `<option value="${s}" ${task.status === s ? 'selected' : ''}>${s}</option>`
                    ).join('')}
                </select>
            </div>
            <div class="form-group">
                <label data-tooltip="Task urgency level — affects queue sort order">Priority</label>
                <select id="detPriority" data-tooltip="critical = urgent action needed | high = important | normal = default | low = when time allows">
                    ${['critical','high','normal','low'].map(p =>
                        `<option value="${p}" ${task.priority === p ? 'selected' : ''}>${p}</option>`
                    ).join('')}
                </select>
            </div>
            <div class="form-group">
                <label data-tooltip="Who is responsible for this task — human or an AI agent">Assignee</label>
                <div class="searchable-select" id="detAssigneeWrap" data-tooltip="Set to 'agent' to assign to an AI agent/squad, or pick a specific person"></div>
            </div>
            <div id="detAgentFields" style="display: none;">
                <div class="form-group">
                    <label data-tooltip="Which agent role or squad should execute this task">Agent / Squad</label>
                    <div class="searchable-select" id="detAgentPicker" data-tooltip="Individual agent = one specialist. Squad = coordinated group. 'Auto' = system picks the best fit."></div>
                </div>
                <div class="form-group">
                    <label data-tooltip="Optional custom instructions that override the agent's default behavior for this specific task">Agent Instructions</label>
                    <textarea id="detAgentInstructions" placeholder="Custom instructions for the agent..." style="min-height: 60px;" data-tooltip="Leave blank to use the agent's default prompt. Add specific instructions here to customize behavior for this task.">${esc(task.agentConfig?.instructions || '')}</textarea>
                </div>
            </div>
            <div class="form-group">
                <label data-tooltip="The project this task belongs to — used for grouping and filtering">Project</label>
                <div class="searchable-select" id="detProjectWrap" data-tooltip="Associate this task with a project for organized tracking"></div>
            </div>
            <div class="form-group">
                <label data-tooltip="The client associated with this task">Client</label>
                <div class="searchable-select" id="detClientWrap" data-tooltip="Link this task to a specific client account"></div>
            </div>
            <div class="form-group">
                <label data-tooltip="When this task must be completed — overdue tasks appear in My Queue">Deadline</label>
                <input type="date" id="detDeadline" value="${escAttr(task.deadline || '')}" data-tooltip="Set a due date to track deadlines. Overdue tasks are highlighted in the queue.">
            </div>
            <div class="form-group">
                <label data-tooltip="Full description of the task — agents use this as their primary context">Description</label>
                <textarea id="detDesc" style="min-height: 100px;" data-tooltip="Be specific — the more context you provide, the better the agent performs. Include goals, constraints, and relevant links.">${esc(task.description || '')}</textarea>
            </div>
        </div>
        ${task.agentConfig?.response ? `
        <div class="detail-section">
            <h4>Agent Response <button class="btn btn-sm btn-resubmit" onclick="resubmitTask('${escAttr(id)}')" title="Re-run this task from scratch">&#8635; Re-Submit</button></h4>
            <div class="detail-field"><span class="field-label">Agent</span><span class="field-value">${esc(task.agentConfig.agentName || task.agentConfig.agentId || 'auto')}</span></div>
            ${task.agentConfig.completedAt ? `<div class="detail-field"><span class="field-label">Completed</span><span class="field-value">${formatDate(task.agentConfig.completedAt)}</span></div>` : ''}
            ${task.agentConfig.instructions ? `<div class="detail-field" style="flex-direction:column;align-items:flex-start;"><span class="field-label">Instructions</span><div class="detail-description" style="margin-top:4px;font-size:11px;">${esc(task.agentConfig.instructions)}</div></div>` : ''}
            <div class="markdown-content" style="margin-top: 8px; padding: 12px; background: var(--bg-primary); border-radius: var(--radius); border: 1px solid var(--border); max-height: 400px; overflow-y: auto;">${renderMarkdown(task.agentConfig.response)}</div>
        </div>
        ` : ''}
        <div class="detail-section">
            <h4>Source</h4>
            <div class="detail-field"><span class="field-label">Source</span><span class="field-value">${esc(task.source || '\u2014')}</span></div>
            ${task.sourceRef ? `
                ${task.sourceRef.account ? `<div class="detail-field"><span class="field-label">Account</span><span class="field-value">${esc(task.sourceRef.account)}</span></div>` : ''}
                <div class="detail-field"><span class="field-label">Sender</span><span class="field-value">${esc(task.sourceRef.senderName || task.sourceRef.sender || '\u2014')}</span></div>
                <div class="detail-field"><span class="field-label">Subject</span><span class="field-value">${esc(task.sourceRef.subject || '\u2014')}</span></div>
            ` : ''}
        </div>
        <div class="detail-section">
            <h4>Routing</h4>
            ${task.routing ? `
                <div class="detail-field"><span class="field-label">Type</span><span class="field-value">${esc(task.routing.type || '\u2014')}</span></div>
                <div class="detail-field"><span class="field-label">Squads</span><span class="field-value">${esc((task.routing.squads || []).join(', ') || '\u2014')}</span></div>
                <div class="detail-field"><span class="field-label">Mode</span><span class="field-value">${esc(task.routing.mode || '\u2014')}</span></div>
            ` : '<div class="detail-field"><span class="field-label">No routing configured</span></div>'}
        </div>
        <div class="detail-section">
            <h4>Attachments <button class="btn btn-sm" onclick="showAttachModal()">+ Add</button></h4>
            <div class="attachments-list" id="detAttachments">
                ${(task.attachments || []).length === 0 ? '<div class="text-muted" style="font-size:11px;">No attachments</div>' :
                  (task.attachments || []).map((a, i) => `
                    <div class="attachment-item">
                        <span class="attachment-icon">&#128196;</span>
                        <span class="attachment-name" onclick="viewAttachment('${escAttr(a.path)}')" title="${escAttr(a.path)}">${esc(a.name)}</span>
                        <button class="attachment-remove" onclick="removeAttachment(${i})" title="Remove">&times;</button>
                    </div>
                  `).join('')}
            </div>
        </div>
        <div class="detail-section">
            <h4>Timestamps</h4>
            <div class="detail-field"><span class="field-label">Created</span><span class="field-value">${formatDate(task.createdAt)}</span></div>
            <div class="detail-field"><span class="field-label">Updated</span><span class="field-value">${formatDate(task.updatedAt)}</span></div>
            <div class="detail-field"><span class="field-label">Completed</span><span class="field-value">${formatDate(task.completedAt)}</span></div>
        </div>
        ${task.status === 'cancelled' && task.cancellationReason ? `
        <div class="detail-section rejection-reason-section">
            <h4>Cancellation Reason</h4>
            <div class="rejection-reason-box">${esc(task.cancellationReason)}</div>
        </div>` : ''}
        ${task.notes ? `
        <div class="detail-section">
            <h4>Notes</h4>
            <div class="detail-description">${esc(task.notes)}</div>
        </div>` : ''}
    `;

    // Initialize searchable selects in detail panel
    const detAssignee = createSearchableSelect('detAssigneeWrap', getAssigneeOptions(), {
        placeholder: 'Search assignee...',
        onSelect: (val) => toggleAgentFields('det', val),
    });
    if (detAssignee) detAssignee.setValue(task.assignee || '');

    const detProject = createSearchableSelect('detProjectWrap', getProjectOptions(), { placeholder: 'Search project...' });
    if (detProject) detProject.setValue(task.project || '');

    const detClient = createSearchableSelect('detClientWrap', getClientOptions(), { placeholder: 'Search client...' });
    if (detClient) detClient.setValue(task.client || '');

    // Show agent fields if assignee is already "agent"
    if (task.assignee === 'agent') {
        toggleAgentFields('det', 'agent');
        // Set existing agent config
        const ac = task.agentConfig || {};
        const pickerWrap = document.getElementById('detAgentPicker');
        if (pickerWrap && ac.agentId) {
            const prefix = ac.agentType === 'squad' ? 'squad' : 'agent';
            pickerWrap.setValue(`${prefix}:${ac.agentId}`);
        }
    }

    const actions = document.getElementById('detailActions');
    actions.innerHTML = `
        <button class="btn btn-primary" onclick="saveDetail()" data-tooltip="Save all changes made in the detail panel to the task registry">Save</button>
        ${(task.status === 'pending' && hasAgent) ? `<button class="btn btn-approve" onclick="approveTask('${escAttr(id)}')" data-tooltip="Schedule this task for execution — auto-executor picks it up on the next cycle.">✓ Approve</button>` : ''}
        <button class="btn btn-success" onclick="quickAction('complete')" data-tooltip="Mark this task as completed. It will be automatically archived after 30 seconds.">Complete</button>
        <button class="btn btn-warning" onclick="quickAction('cancel')" data-tooltip="Cancel this task — you will be prompted for an optional reason.">Cancel</button>
        <button class="btn" onclick="resubmitTask()" data-tooltip="Reset task back to pending and re-queue it for execution. Clears any rejection reason.">Re-Submit</button>
        <button class="btn" onclick="archiveCurrentTask()" data-tooltip="Move this task to the archive. It can be restored later via the Archive button.">Archive</button>
        <button class="btn" onclick="runTaskSquad()" data-tooltip="Trigger a squad to run on this task immediately via the monitor service.">Run Squad</button>
        <button class="btn btn-purple" onclick="runAgentOnTask()" data-tooltip="Run a specific agent on this task right now. Uses the assigned agent or lets you pick one.">Run Agent</button>
        <button class="btn" onclick="showDelegateModal()" data-tooltip="Delegate this task to a person via email, or assign it to an AI agent for automated execution.">Delegate</button>
        <button class="btn" onclick="showEmailModal('${id}')" data-tooltip="Send this task's details to someone via email.">Email</button>
        <button class="btn btn-danger" onclick="deleteTask()" data-tooltip="Permanently delete this task from the registry. This cannot be undone — use Archive instead to preserve history.">Delete</button>
    `;

    document.getElementById('detailPanel').classList.add('open');
    document.getElementById('detailBackdrop').classList.add('visible');
}

function closeDetail() {
    document.getElementById('detailPanel').classList.remove('open');
    document.getElementById('detailBackdrop').classList.remove('visible');
    currentDetailId = null;
}

async function saveDetail() {
    if (!currentDetailId) return;
    const detAssigneeWrap = document.getElementById('detAssigneeWrap');
    const detProjectWrap = document.getElementById('detProjectWrap');
    const detClientWrap = document.getElementById('detClientWrap');
    const assignee = detAssigneeWrap ? detAssigneeWrap.getValue() || null : null;
    const data = {
        title: document.getElementById('detTitle').value,
        status: document.getElementById('detStatus').value,
        priority: document.getElementById('detPriority').value,
        assignee: assignee,
        project: detProjectWrap ? detProjectWrap.getValue() || null : null,
        client: detClientWrap ? detClientWrap.getValue() || null : null,
        deadline: document.getElementById('detDeadline').value || null,
        description: document.getElementById('detDesc').value,
    };

    // Include agent config if agent is selected
    if (assignee === 'agent') {
        const agentPicker = document.getElementById('detAgentPicker');
        const agentInstr = document.getElementById('detAgentInstructions');
        const agentVal = agentPicker ? agentPicker.getValue() : '';
        const existingConfig = tasks.find(t => t.id === currentDetailId)?.agentConfig || {};
        if (agentVal === 'auto:') {
            // Auto-route: save first, then call auto-route endpoint
            data.agentConfig = null;
            data.assignee = null;
        } else if (agentVal && agentVal.includes(':')) {
            const [agentType, agentId] = agentVal.split(':', 2);
            // Validate agent exists
            const validation = await validateAgent(agentId, agentType);
            if (!validation.valid) {
                alert(`Invalid agent: ${validation.error}`);
                return;
            }
            data.agentConfig = {
                ...existingConfig,
                agentId: agentId,
                agentType: agentType,
                instructions: agentInstr ? agentInstr.value : '',
            };
        } else if (agentVal) {
            const validation = await validateAgent(agentVal, 'agent');
            if (!validation.valid) {
                alert(`Invalid agent: ${validation.error}`);
                return;
            }
            data.agentConfig = {
                ...existingConfig,
                agentId: agentVal,
                agentType: 'agent',
                instructions: agentInstr ? agentInstr.value : '',
            };
        } else if (agentInstr && agentInstr.value) {
            data.agentConfig = {
                ...existingConfig,
                instructions: agentInstr.value,
            };
        }
    }
    // Track whether auto-route is needed after save
    const needsAutoRoute = (assignee === 'agent' && data.assignee === null);
    // Track whether this is a scheduling to an agent (triggers execution)
    const isDelegatingToAgent = (data.status === 'scheduled'
        && assignee === 'agent'
        && data.agentConfig && data.agentConfig.agentId);

    // Serialize payload — catch non-serializable data early
    let body;
    try {
        body = JSON.stringify(data);
    } catch (serErr) {
        console.error('Save failed — payload not serializable:', serErr, data);
        alert('Save failed: could not serialize task data. Check console for details.');
        return;
    }
    console.debug('[TCP] saveDetail payload:', data);

    try {
        const resp = await authFetch(`api/tasks/${currentDetailId}`, {
            method: 'PATCH',
            body: body,
        });
        if (!resp) {
            alert('Save failed: no response from server — check your connection.');
            return;
        }
        if (resp.status === 401 || resp.status === 403) {
            alert('Not authenticated — please refresh the page and log in again.');
            return;
        }
        if (resp.ok) {
            // If Auto was selected, call auto-route then schedule the task
            if (needsAutoRoute) {
                try {
                    const routeResp = await authFetch(`api/tasks/${currentDetailId}/auto-route`, { method: 'POST' });
                    if (routeResp && routeResp.ok) {
                        const routeResult = await routeResp.json();
                        const routed = routeResult.task || {};
                        if (routed.assignee === 'agent' && routed.agentConfig?.agentId) {
                            // Auto-route succeeded — schedule the task so executor picks it up
                            await authFetch(`api/tasks/${currentDetailId}`, {
                                method: 'PATCH',
                                body: JSON.stringify({ status: 'scheduled' }),
                            });
                            showToast(`Auto-routed to ${routed.agentConfig.agentName || routed.agentConfig.agentId} — task scheduled`);
                        } else {
                            showToast('Auto-route assigned to human review — no suitable agent found');
                        }
                    } else {
                        showToast('Auto-route failed — task saved without agent assignment');
                    }
                } catch (e) {
                    console.error('Auto-route failed:', e);
                    showToast('Auto-route failed — task saved without agent assignment');
                }
            }
            // If delegating to an agent with auto-execute on, launch immediately
            if (isDelegatingToAgent) {
                const autoExecOn = document.getElementById('autoExecToggle')?.checked;
                if (autoExecOn) {
                    try {
                        await authFetch(`api/tasks/${currentDetailId}/run-agent`, {
                            method: 'POST',
                            body: JSON.stringify({
                                agent_id: data.agentConfig.agentId,
                                agent_type: data.agentConfig.agentType || 'agent',
                                instructions: data.agentConfig.instructions || '',
                            }),
                        });
                        showToast('Task scheduled and agent launched');
                    } catch (e) {
                        console.error('Agent launch failed:', e);
                        showToast('Task saved but agent launch failed — will retry in auto-execute cycle');
                    }
                } else {
                    showToast('Task scheduled — will execute on next auto-execute cycle');
                }
            }
            await refreshAll();
            openDetail(currentDetailId);
        } else {
            const text = await resp.text();
            let detail;
            try { detail = JSON.parse(text).detail; } catch {}
            console.error('Save failed:', resp.status, text);
            alert(`Save failed (${resp.status}): ${detail || text.slice(0, 200) || 'Unknown error'}`);
        }
    } catch (e) {
        console.error('Save failed:', e, e.stack);
        alert(`Save failed: ${e.message || 'unknown error'} — check console for details`);
    }
}

async function quickAction(action) {
    if (!currentDetailId) return;
    try {
        const opts = { method: 'POST' };
        if (action === 'reject') {
            const reason = prompt('Rejection reason (optional):');
            if (reason === null) return; // cancelled
            if (reason.trim()) {
                opts.body = JSON.stringify({ reason: reason.trim() });
            }
        }
        await authFetch(`api/tasks/${currentDetailId}/${action}`, opts);
        await refreshAll();
        openDetail(currentDetailId);
    } catch (e) {
        console.error('Action failed:', e);
    }
}

async function runTaskSquad() {
    if (!currentDetailId) return;

    // Prompt user with squad list
    const squadNames = squadsData.map(s => s.name);
    if (!squadNames.length) {
        alert('No squads available');
        return;
    }
    const choice = prompt(`Choose a squad to run:\n\n${squadNames.map((n, i) => `${i + 1}. ${n}`).join('\n')}\n\nEnter squad name or number:`);
    if (!choice) return;

    let squad = choice.trim();
    const num = parseInt(squad, 10);
    if (!isNaN(num) && num >= 1 && num <= squadNames.length) {
        squad = squadNames[num - 1];
    }

    try {
        const resp = await authFetch(`api/tasks/${currentDetailId}/run`, {
            method: 'POST',
            body: JSON.stringify({ squad }),
        });
        const data = await resp.json();
        if (data.success) {
            alert(`Squad triggered: ${data.squad || squad} (PID: ${data.pid || '?'})`);
            await refreshAll();
        } else {
            alert(`Failed: ${data.error || data.detail || 'Unknown error'}`);
        }
    } catch (e) {
        alert(`Error: ${e.message}`);
    }
}

async function resubmitTask(taskId) {
    const id = taskId || currentDetailId;
    if (!id) return;
    if (!confirm('Re-submit this task back into the pending queue?')) return;
    try {
        const resp = await authFetch(`api/tasks/${id}/resubmit`, { method: 'POST' });
        if (resp.ok) {
            await refreshAll();
            if (currentDetailId === id) openDetail(id);
        } else {
            const err = await resp.json().catch(() => ({}));
            alert(`Re-submit failed: ${err.detail || 'Unknown error'}`);
        }
    } catch (e) {
        console.error('Re-submit failed:', e);
        alert('Re-submit failed: ' + e.message);
    }
}

async function runAgentOnTask() {
    if (!currentDetailId) return;
    const task = tasks.find(t => t.id === currentDetailId);
    if (!task) return;

    // Get agent selection from detail panel or prompt
    let agentId = '';
    let agentType = 'agent';
    let instructions = '';

    const agentPicker = document.getElementById('detAgentPicker');
    const agentInstr = document.getElementById('detAgentInstructions');

    let autoRoute = false;

    if (agentPicker) {
        const agentVal = agentPicker.getValue();
        if (agentVal === 'auto:') {
            autoRoute = true;
        } else if (agentVal && agentVal.includes(':')) {
            [agentType, agentId] = agentVal.split(':', 2);
        } else if (agentVal) {
            agentId = agentVal;
        }
    }

    if (agentInstr) {
        instructions = agentInstr.value;
    }

    // Auto-route: let the system classify and assign
    if (autoRoute) {
        if (!confirm(`Auto-route task ${currentDetailId}?\n\nThe system will classify this task and assign the best agent or squad.`)) return;
        const btn = document.querySelector('[onclick="runAgentOnTask()"]');
        if (btn) { btn.textContent = 'Routing...'; btn.disabled = true; }
        try {
            const resp = await authFetch(`api/tasks/${currentDetailId}/auto-route`, { method: 'POST' });
            const data = await resp.json();
            if (data.success) {
                const routed = data.task;
                const ac = routed.agentConfig || {};
                const assignedTo = ac.agentName || ac.agentId || routed.assignee || 'unknown';
                await refreshAll();
                openDetail(currentDetailId);
                // Auto-run the assigned agent immediately
                if (ac.agentId && confirm(`Routed to "${assignedTo}" (${ac.agentType || 'agent'}).\n\nRun it now?`)) {
                    agentId = ac.agentId;
                    agentType = ac.agentType || 'agent';
                    // Fall through to the run-agent call below
                } else {
                    if (btn) { btn.textContent = 'Run Agent'; btn.disabled = false; }
                    return;
                }
            } else {
                alert(`Auto-route failed: ${data.error || data.detail || 'Unknown error'}`);
                if (btn) { btn.textContent = 'Run Agent'; btn.disabled = false; }
                return;
            }
        } catch (e) {
            alert(`Error: ${e.message}`);
            if (btn) { btn.textContent = 'Run Agent'; btn.disabled = false; }
            return;
        }
    }

    // If no agent selected, prompt with a quick picker (with descriptions)
    if (!agentId) {
        const allAgents = (agentsData.agents || []);
        const lines = allAgents.map((a, i) => {
            const desc = briefAgentDesc(a);
            return `${i + 1}. ${a.id} — ${desc}`;
        });
        const choice = prompt(
            `Select an agent to run:\n\n` +
            lines.join('\n') +
            `\n\nEnter agent name or number (or leave empty to cancel):`
        );
        if (!choice) return;
        const num = parseInt(choice.trim(), 10);
        if (!isNaN(num) && num >= 1 && num <= allAgents.length) {
            agentId = allAgents[num - 1].id;
        } else {
            agentId = choice.trim();
        }

        if (!instructions) {
            instructions = prompt('Agent instructions (optional):') || '';
        }
    }

    if (!agentId) return;

    // Confirm
    const agentInfo = (agentsData.agents || []).find(a => a.id === agentId);
    const displayName = agentInfo ? agentInfo.name : agentId;
    if (!confirm(`Run "${displayName}" on task ${currentDetailId}?\n\nThis may take up to 5 minutes.`)) return;

    // Show loading state
    const btn = document.querySelector('[onclick="runAgentOnTask()"]');
    if (btn) { btn.textContent = 'Running...'; btn.disabled = true; }

    try {
        const resp = await authFetch(`api/tasks/${currentDetailId}/run-agent`, {
            method: 'POST',
            body: JSON.stringify({
                agent_id: agentId,
                agent_type: agentType,
                instructions: instructions,
            }),
        });
        const data = await resp.json();
        if (data.success) {
            await refreshAll();
            openDetail(currentDetailId);
            if (agentType === 'squad') {
                alert(`Squad "${agentId}" started (PID: ${data.pid})`);
            }
            // For single agents, the response is now visible in the detail panel
        } else {
            alert(`Agent failed: ${data.error || data.detail || 'Unknown error'}`);
        }
    } catch (e) {
        alert(`Error: ${e.message}`);
    } finally {
        if (btn) { btn.textContent = 'Run Agent'; btn.disabled = false; }
    }
}

async function deleteTask() {
    if (!currentDetailId) return;
    if (!confirm(`Delete task ${currentDetailId}?`)) return;
    try {
        await authFetch(`api/tasks/${currentDetailId}`, { method: 'DELETE' });
        closeDetail();
        await refreshAll();
    } catch (e) {
        console.error('Delete failed:', e);
    }
}

// ── Add Task ─────────────────────────────────────────────
function showAddModal() {
    document.getElementById('addTitle').value = '';
    document.getElementById('addDesc').value = '';
    document.getElementById('addPriority').value = 'normal';
    document.getElementById('addDeadline').value = '';

    createSearchableSelect('addAssigneeWrap', getAssigneeOptions(), {
        placeholder: 'Search assignee...',
        onSelect: (val) => toggleAgentFields('add', val),
    });
    createSearchableSelect('addProjectWrap', getProjectOptions(), { placeholder: 'Search project...' });
    createSearchableSelect('addClientWrap', getClientOptions(), { placeholder: 'Search client...' });

    // Initialize agent fields hidden
    toggleAgentFields('add', '');

    document.getElementById('addModal').classList.add('visible');
}

function toggleAgentFields(prefix, assigneeValue) {
    const agentFields = document.getElementById(`${prefix}AgentFields`);
    if (!agentFields) return;
    if (assigneeValue === 'agent') {
        agentFields.style.display = '';
        // Initialize agent picker if not already done
        if (!agentFields.dataset.initialized) {
            createSearchableSelect(`${prefix}AgentPicker`, getAgentOptions(), {
                placeholder: 'Search agent or squad...',
            });
            agentFields.dataset.initialized = 'true';
        }
    } else {
        agentFields.style.display = 'none';
    }
}

async function createTask() {
    const addAssigneeWrap = document.getElementById('addAssigneeWrap');
    const addProjectWrap = document.getElementById('addProjectWrap');
    const addClientWrap = document.getElementById('addClientWrap');
    const assignee = addAssigneeWrap ? addAssigneeWrap.getValue() || null : null;
    const data = {
        title: document.getElementById('addTitle').value,
        description: document.getElementById('addDesc').value,
        priority: document.getElementById('addPriority').value,
        project: addProjectWrap ? addProjectWrap.getValue() || null : null,
        client: addClientWrap ? addClientWrap.getValue() || null : null,
        assignee: assignee,
        deadline: document.getElementById('addDeadline').value || null,
    };

    // Include agent config if agent is selected
    if (assignee === 'agent') {
        const agentPicker = document.getElementById('addAgentPicker');
        const agentInstr = document.getElementById('addAgentInstructions');
        const agentVal = agentPicker ? agentPicker.getValue() : '';
        if (agentVal) {
            const [agentType, agentId] = agentVal.includes(':') ? agentVal.split(':', 2) : ['agent', agentVal];
            // Validate agent exists
            const validation = await validateAgent(agentId, agentType);
            if (!validation.valid) {
                alert(`Invalid agent: ${validation.error}`);
                return;
            }
            data.agentConfig = {
                agentId: agentId,
                agentType: agentType,
                instructions: agentInstr ? agentInstr.value : '',
            };
        } else if (agentInstr && agentInstr.value) {
            data.agentConfig = { instructions: agentInstr.value };
        }
    }

    if (!data.title) { alert('Title is required'); return; }
    try {
        const resp = await authFetch('api/tasks', {
            method: 'POST',
            body: JSON.stringify(data),
        });
        if (resp.ok) {
            closeModal('addModal');
            await refreshAll();
        } else {
            const err = await resp.json().catch(() => ({}));
            alert(`Create failed: ${err.detail || 'Unknown error'}`);
        }
    } catch (e) {
        console.error('Create failed:', e);
    }
}

// ── Email ────────────────────────────────────────────────
function showEmailModal(taskId) {
    emailTaskId = taskId;
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;

    // Populate From account dropdown
    const fromSelect = document.getElementById('emailFrom');
    fromSelect.innerHTML = emailAccounts.map(a =>
        `<option value="${escAttr(a.env_prefix)}">${esc(a.name)} (${esc(a.email)})</option>`
    ).join('');

    // Searchable To field
    createSearchableSelect('emailToWrap', getEmailToOptions(), {
        placeholder: 'Search or type email...',
        allowFreeText: true,
    });

    document.getElementById('emailSubject').value = `[OPAI Task ${taskId}] ${task.title}`;

    const lines = [
        `Task: ${taskId}`,
        `Title: ${task.title}`,
        `Status: ${task.status}`,
        `Priority: ${task.priority}`,
        `Project: ${task.project || 'N/A'}`,
        `Client: ${task.client || 'N/A'}`,
        `Assignee: ${task.assignee || 'Unassigned'}`,
        `Deadline: ${task.deadline || 'None'}`,
        '',
        'Description:',
        task.description || 'No description',
    ];
    if (task.sourceRef && task.sourceRef.account) {
        lines.push('', 'Source:', `  Account: ${task.sourceRef.account}`);
        if (task.sourceRef.sender) lines.push(`  Sender: ${task.sourceRef.senderName || ''} <${task.sourceRef.sender}>`);
        if (task.sourceRef.subject) lines.push(`  Subject: ${task.sourceRef.subject}`);
    }
    document.getElementById('emailBody').value = lines.join('\n');
    document.getElementById('emailModal').classList.add('visible');
}

async function sendEmail() {
    if (!emailTaskId) return;
    const toWrap = document.getElementById('emailToWrap');
    const to = toWrap ? toWrap.getValue() : '';
    if (!to) { alert('Recipient email required'); return; }
    try {
        const resp = await authFetch(`api/tasks/${emailTaskId}/email`, {
            method: 'POST',
            body: JSON.stringify({
                to,
                from_account: document.getElementById('emailFrom').value,
                subject: document.getElementById('emailSubject').value,
                body: document.getElementById('emailBody').value,
            }),
        });
        const data = await resp.json();
        if (data.success) {
            closeModal('emailModal');
            alert('Email sent!');
        } else {
            alert(`Failed: ${data.error || data.detail || 'Unknown error'}`);
        }
    } catch (e) {
        alert(`Error: ${e.message}`);
    }
}

// ── Delegate Modal ───────────────────────────────────────
function showDelegateModal() {
    if (!currentDetailId) return;

    // Populate assignee picker (exclude "Unassigned" and "agent")
    const personOptions = [];
    for (const sa of contactsData.specialAssignees || []) {
        personOptions.push({ value: sa, label: sa, meta: 'special' });
    }
    for (const c of contactsData.contacts || []) {
        personOptions.push({ value: c.id, label: c.name, meta: c.role || '' });
    }

    createSearchableSelect('delegateAssigneeWrap', personOptions, {
        placeholder: 'Search person...',
        allowFreeText: true,
        onSelect: (value) => { populateDelegateEmails(value); },
    });

    // Populate From account dropdown
    const fromSelect = document.getElementById('delegateFromAccount');
    fromSelect.innerHTML = emailAccounts.map(a =>
        `<option value="${escAttr(a.env_prefix)}">${esc(a.name)} (${esc(a.email)})</option>`
    ).join('');

    // Clear email to dropdown
    document.getElementById('delegateEmailTo').innerHTML = '<option value="">Select person first</option>';
    document.getElementById('delegateMessage').value = '';
    document.getElementById('delegateSendEmail').checked = true;
    document.getElementById('delegateEmailFields').style.display = '';

    document.getElementById('delegateModal').classList.add('visible');
}

function populateDelegateEmails(personId) {
    const contact = (contactsData.contacts || []).find(c => c.id === personId || c.name === personId);
    const select = document.getElementById('delegateEmailTo');

    if (!contact || !contact.emails || !contact.emails.length) {
        select.innerHTML = '<option value="">No email found — type below</option>';
        return;
    }

    select.innerHTML = contact.emails.map(email =>
        `<option value="${escAttr(email)}" ${email === contact.primaryEmail ? 'selected' : ''}>${esc(email)}</option>`
    ).join('');
}

function toggleDelegateEmail() {
    const checked = document.getElementById('delegateSendEmail').checked;
    document.getElementById('delegateEmailFields').style.display = checked ? '' : 'none';
}

async function submitDelegate() {
    if (!currentDetailId) return;
    const assigneeWrap = document.getElementById('delegateAssigneeWrap');
    const assignee = assigneeWrap ? assigneeWrap.getValue() : '';
    if (!assignee) { alert('Please select a person to delegate to'); return; }

    const sendEmail = document.getElementById('delegateSendEmail').checked;
    const payload = { assignee };

    if (sendEmail) {
        payload.sendEmail = true;
        payload.emailTo = document.getElementById('delegateEmailTo').value;
        payload.fromAccount = document.getElementById('delegateFromAccount').value;
        payload.message = document.getElementById('delegateMessage').value;

        if (!payload.emailTo) {
            alert('Email recipient required when sending notification');
            return;
        }
    }

    try {
        const resp = await authFetch(`api/tasks/${currentDetailId}/delegate`, {
            method: 'POST',
            body: JSON.stringify(payload),
        });
        const data = await resp.json();
        if (data.success) {
            closeModal('delegateModal');
            await refreshAll();
            openDetail(currentDetailId);
            if (data.email && data.email.success) {
                alert('Task assigned and email sent!');
            } else if (data.email && !data.email.success) {
                alert(`Task assigned, but email failed: ${data.email.error}`);
            } else {
                alert('Task assigned!');
            }
        } else {
            alert(`Failed: ${data.error || data.detail || 'Unknown error'}`);
        }
    } catch (e) {
        alert(`Error: ${e.message}`);
    }
}

// ── HITL ─────────────────────────────────────────────────
async function viewHitl(filename) {
    currentHitlFile = filename;
    try {
        const resp = await fetch(`api/hitl/${encodeURIComponent(filename)}`);
        const data = await resp.json();
        document.getElementById('hitlModalTitle').textContent = filename;
        document.getElementById('hitlContent').innerHTML = renderMarkdown(data.content || '');
        document.getElementById('hitlArchiveBtn').onclick = () => archiveCurrentHitl(filename);
        document.getElementById('hitlModal').classList.add('visible');
    } catch (e) {
        console.error('Failed to load HITL:', e);
    }
}

async function archiveCurrentHitl(filename) {
    try {
        await authFetch(`api/hitl/${encodeURIComponent(filename)}/archive`, { method: 'POST' });
        closeModal('hitlModal');
        loadHitl();
    } catch (e) {
        console.error('Archive failed:', e);
    }
}

// ── Squad Runner ─────────────────────────────────────────
async function runSquad(name) {
    alert(`Squad runs are proxied through the monitor service. Use the monitor dashboard or trigger via a task's Run Squad button.`);
}

// ── Settings ─────────────────────────────────────────────
async function toggleAutoExec() {
    const checked = document.getElementById('autoExecToggle').checked;
    const badge = document.getElementById('executorStatus');
    try {
        await authFetch('api/settings', {
            method: 'POST',
            body: JSON.stringify({ auto_execute: checked }),
        });
        if (badge) {
            badge.textContent = checked ? 'on' : 'off';
            badge.className = 'executor-status ' + (checked ? 'status-on' : 'status-off');
        }
    } catch (e) {
        console.error('Settings update failed:', e);
        document.getElementById('autoExecToggle').checked = !checked;
    }
}

function updateQueueStatusBadge(on) {
    const badge = document.getElementById('queueStatus');
    if (!badge) return;
    badge.textContent = on ? 'on' : 'paused';
    badge.className = 'executor-status ' + (on ? 'status-on' : 'status-queue-paused');
}

async function toggleQueueEnabled() {
    const checked = document.getElementById('queueEnabledToggle').checked;
    updateQueueStatusBadge(checked);
    try {
        await authFetch('api/settings', {
            method: 'POST',
            body: JSON.stringify({ queue_enabled: checked }),
        });
        showToast(checked ? 'Queue enabled — processing resumed' : 'Queue paused — no tasks will execute');
    } catch (e) {
        console.error('Queue toggle failed:', e);
        document.getElementById('queueEnabledToggle').checked = !checked;
        updateQueueStatusBadge(!checked);
    }
}

async function approveTask(taskId) {
    const id = taskId || currentDetailId;
    if (!id) return;
    try {
        await authFetch(`api/tasks/${id}/approve`, {
            method: 'POST',
            body: JSON.stringify({ notes: '' }),
        });
        showToast('Task scheduled — will execute on next cycle');
        await loadTasks();
        if (currentDetailId === id) openDetail(id);
    } catch (e) {
        console.error('Approve failed:', e);
        showToast('Approve failed: ' + e.message);
    }
}

async function changeRoutingMode(newMode) {
    if (!currentDetailId) return;
    const task = tasks.find(t => t.id === currentDetailId);
    if (!task) return;
    const routing = { ...(task.routing || {}), mode: newMode };
    try {
        await authFetch(`api/tasks/${currentDetailId}`, {
            method: 'PATCH',
            body: JSON.stringify({ routing }),
        });
        showToast(`Routing mode changed to: ${newMode}`);
        await loadTasks();
    } catch (e) {
        console.error('Mode change failed:', e);
        showToast('Mode change failed: ' + e.message);
    }
}

// ── Stats Panel ──────────────────────────────────────────
function renderStats(data) {
    const el = document.getElementById('statsPanel');
    const sections = [
        { label: 'By Status', map: data.by_status },
        { label: 'By Priority', map: data.by_priority },
        { label: 'By Project', map: data.by_project },
        { label: 'By Source', map: data.by_source },
    ];

    let html = '';
    for (const sec of sections) {
        if (!sec.map || !Object.keys(sec.map).length) continue;
        const chips = Object.entries(sec.map)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `<span class="stats-chip">${esc(k)} <strong>${v}</strong></span>`)
            .join('');
        html += `<div class="stats-section">
            <div class="stats-label">${sec.label}</div>
            <div class="stats-row">${chips}</div>
        </div>`;
    }

    if (data.overdue > 0) {
        html += `<div class="stats-section">
            <div class="stats-label">Overdue</div>
            <div class="stats-row"><span class="stats-chip" style="border-color: var(--accent-red);"><strong class="text-red">${data.overdue}</strong> tasks past deadline</span></div>
        </div>`;
    }

    el.innerHTML = html || '<div class="empty-state">No data</div>';
}

// ── Column Config Modal ──────────────────────────────────
let pendingColumnConfig = [];

function showColumnsModal() {
    pendingColumnConfig = columnConfig.map(c => ({ ...c }));
    renderColumnsConfig();
    document.getElementById('columnsModal').classList.add('visible');
}

function renderColumnsConfig() {
    const list = document.getElementById('columnsConfigList');
    list.innerHTML = pendingColumnConfig.map((c, i) => `
        <div class="col-config-item ${c.visible ? '' : 'col-disabled'}"
             draggable="true" data-col-index="${i}">
            <span class="col-drag-handle">\u2261</span>
            <input type="checkbox" ${c.visible ? 'checked' : ''}
                onchange="toggleColumnVisible(${i}, this.checked)">
            <span class="col-label">${esc(c.label)}</span>
        </div>
    `).join('');

    // Drag-and-drop reorder
    let dragIdx = null;
    list.querySelectorAll('.col-config-item').forEach(el => {
        el.addEventListener('dragstart', (e) => {
            dragIdx = parseInt(el.dataset.colIndex);
            el.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        });
        el.addEventListener('dragend', () => {
            el.classList.remove('dragging');
            list.querySelectorAll('.col-config-item').forEach(x => x.classList.remove('drag-over'));
        });
        el.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            list.querySelectorAll('.col-config-item').forEach(x => x.classList.remove('drag-over'));
            el.classList.add('drag-over');
        });
        el.addEventListener('dragleave', () => {
            el.classList.remove('drag-over');
        });
        el.addEventListener('drop', (e) => {
            e.preventDefault();
            const dropIdx = parseInt(el.dataset.colIndex);
            if (dragIdx !== null && dragIdx !== dropIdx) {
                const item = pendingColumnConfig.splice(dragIdx, 1)[0];
                pendingColumnConfig.splice(dropIdx, 0, item);
                renderColumnsConfig();
            }
        });
    });
}

function toggleColumnVisible(index, checked) {
    pendingColumnConfig[index].visible = checked;
    const item = document.querySelectorAll('.col-config-item')[index];
    if (item) item.classList.toggle('col-disabled', !checked);
}

function applyColumns() {
    columnConfig = pendingColumnConfig.map(c => ({ ...c }));
    saveColumnConfig();
    renderTable();
    closeModal('columnsModal');
}

function resetColumns() {
    pendingColumnConfig = DEFAULT_COLUMNS.map(c => ({ ...c }));
    renderColumnsConfig();
}

// ── Rejection Reason Tooltip ─────────────────────────────
const _rejTooltip = document.createElement('div');
_rejTooltip.className = 'rejection-tooltip';
_rejTooltip.style.display = 'none';
document.body.appendChild(_rejTooltip);

function bindRejectionTooltips() {
    document.querySelectorAll('tr[data-rejection-reason]').forEach(row => {
        row.addEventListener('mouseenter', _showRejTooltip);
        row.addEventListener('mousemove', _moveRejTooltip);
        row.addEventListener('mouseleave', _hideRejTooltip);
    });
}

function _showRejTooltip(e) {
    const reason = e.currentTarget.getAttribute('data-rejection-reason');
    if (!reason) return;
    _rejTooltip.textContent = reason;
    _rejTooltip.style.display = 'block';
    _moveRejTooltip(e);
}

function _moveRejTooltip(e) {
    _rejTooltip.style.left = (e.clientX + 12) + 'px';
    _rejTooltip.style.top = (e.clientY + 12) + 'px';
}

function _hideRejTooltip() {
    _rejTooltip.style.display = 'none';
}

// ── Modals ───────────────────────────────────────────────
function closeModal(id) {
    document.getElementById(id).classList.remove('visible');
    if (!document.querySelector('.modal-overlay.visible')) {
        document.body.style.overflow = '';
    }
}

function openModal(id) {
    document.getElementById(id).classList.add('visible');
    document.body.style.overflow = 'hidden';
}

// Close modals on overlay click
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay') && e.target.classList.contains('visible')) {
        e.target.classList.remove('visible');
        if (!document.querySelector('.modal-overlay.visible')) {
            document.body.style.overflow = '';
        }
    }
});

// Close on Escape
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeDetail();
        document.querySelectorAll('.modal-overlay.visible').forEach(m => m.classList.remove('visible'));
    }
});

// ── Archive ──────────────────────────────────────────

async function archiveCurrentTask() {
    if (!currentDetailId) return;
    if (!confirm(`Archive task ${currentDetailId}? It will be removed from the active list.`)) return;
    try {
        const resp = await authFetch('api/archive', {
            method: 'POST',
            body: JSON.stringify({ ids: [currentDetailId] }),
        });
        const data = await resp.json();
        if (data.success) {
            closeDetail();
            await refreshAll();
        } else {
            alert(`Failed: ${data.error || 'Unknown error'}`);
        }
    } catch (e) {
        alert(`Error: ${e.message}`);
    }
}

async function batchArchive() {
    if (!selectedIds.size) return;
    if (!confirm(`Archive ${selectedIds.size} task(s)?`)) return;
    try {
        const resp = await authFetch('api/archive', {
            method: 'POST',
            body: JSON.stringify({ ids: [...selectedIds] }),
        });
        if (resp.ok) {
            selectedIds.clear();
            await refreshAll();
        }
    } catch (e) {
        console.error('Batch archive failed:', e);
    }
}

async function showArchiveModal() {
    document.getElementById('archiveSearch').value = '';
    document.getElementById('archiveModal').classList.add('visible');
    await loadArchive();
}

async function loadArchive() {
    const search = document.getElementById('archiveSearch').value.trim();
    const params = search ? `?search=${encodeURIComponent(search)}` : '';
    try {
        const resp = await fetch(`api/archive${params}`);
        const data = await resp.json();
        const items = data.tasks || [];
        document.getElementById('archiveCount').textContent = `(${data.total} tasks)`;
        const list = document.getElementById('archiveList');

        if (!items.length) {
            list.innerHTML = '<div class="empty-state">No archived tasks</div>';
            return;
        }

        list.innerHTML = items.map(t => `
            <div class="archive-item">
                <div class="archive-item-main">
                    <span class="archive-item-id">${esc(t.id)}</span>
                    <span class="archive-item-title">${esc(t.title)}</span>
                    <span class="chip chip-${t.status}" style="font-size:10px;">${esc(t.status)}</span>
                    ${t.project ? `<span class="text-muted" style="font-size:10px;">${esc(t.project)}</span>` : ''}
                </div>
                <div class="archive-item-meta">
                    <span class="text-muted" style="font-size:10px;">Archived ${formatDate(t.archivedAt)}</span>
                    <button class="btn btn-sm" onclick="restoreArchivedTask('${escAttr(t.id)}')">Restore</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteArchivedTask('${escAttr(t.id)}')">Delete</button>
                </div>
            </div>
        `).join('');
    } catch (e) {
        document.getElementById('archiveList').innerHTML = `<div class="empty-state">Failed to load archive</div>`;
    }
}

async function restoreArchivedTask(taskId) {
    if (!confirm(`Restore task ${taskId} to the active list?`)) return;
    try {
        const resp = await authFetch('api/archive/restore', {
            method: 'POST',
            body: JSON.stringify({ ids: [taskId] }),
        });
        if (resp.ok) {
            await loadArchive();
            await refreshAll();
        }
    } catch (e) {
        alert(`Error: ${e.message}`);
    }
}

async function deleteArchivedTask(taskId) {
    if (!confirm(`Permanently delete task ${taskId}? This cannot be undone.`)) return;
    try {
        const resp = await authFetch('api/archive', {
            method: 'DELETE',
            body: JSON.stringify({ ids: [taskId] }),
        });
        if (resp.ok) {
            await loadArchive();
        }
    } catch (e) {
        alert(`Error: ${e.message}`);
    }
}

// ── Attachments ──────────────────────────────────────

function showAttachModal() {
    document.getElementById('attachPath').value = '';
    document.getElementById('attachName').value = '';
    document.getElementById('attachModal').classList.add('visible');
}

async function submitAttachment() {
    if (!currentDetailId) return;
    const path = document.getElementById('attachPath').value.trim();
    const name = document.getElementById('attachName').value.trim();
    if (!path) { alert('File path is required'); return; }

    try {
        const resp = await authFetch(`api/tasks/${currentDetailId}/attachments`, {
            method: 'POST',
            body: JSON.stringify({ path, name }),
        });
        const data = await resp.json();
        if (data.success) {
            closeModal('attachModal');
            await refreshAll();
            openDetail(currentDetailId);
        } else {
            alert(`Failed: ${data.error || data.detail || 'Unknown error'}`);
        }
    } catch (e) {
        alert(`Error: ${e.message}`);
    }
}

async function removeAttachment(index) {
    if (!currentDetailId) return;
    if (!confirm('Remove this attachment?')) return;
    try {
        const resp = await authFetch(`api/tasks/${currentDetailId}/attachments/${index}`, {
            method: 'DELETE',
        });
        if (resp.ok) {
            await refreshAll();
            openDetail(currentDetailId);
        }
    } catch (e) {
        console.error('Remove attachment failed:', e);
    }
}

let _fileViewRaw = '';
let _fileViewMode = 'pretty';
let _fileIsMarkdown = false;

async function viewAttachment(path) {
    const modal = document.getElementById('fileViewerModal');
    const title = document.getElementById('fileViewerTitle');
    const meta = document.getElementById('fileViewerMeta');
    const rawEl = document.getElementById('fileViewerContent');
    const prettyEl = document.getElementById('fileViewerPretty');
    const toggle = document.getElementById('fileViewToggle');

    title.textContent = 'Loading...';
    meta.textContent = '';
    rawEl.textContent = '';
    prettyEl.innerHTML = '';
    toggle.style.display = 'none';
    _fileViewRaw = '';
    _fileIsMarkdown = false;
    _fileViewMode = 'pretty';
    modal.classList.add('visible');

    try {
        const resp = await fetch('api/files/read?path=' + encodeURIComponent(path));
        const data = await resp.json();
        if (data.success) {
            title.textContent = data.name;
            meta.textContent = data.path + '  \u2022  ' + formatFileSize(data.size);
            _fileViewRaw = data.content;
            _fileIsMarkdown = /\.(md|txt|markdown)$/i.test(data.name);

            if (_fileIsMarkdown) {
                toggle.style.display = '';
                setFileViewMode('pretty');
            } else {
                rawEl.textContent = data.content;
                rawEl.style.display = '';
                prettyEl.style.display = 'none';
            }
        } else {
            title.textContent = 'Error';
            rawEl.textContent = data.error || data.detail || 'Failed to load file';
            rawEl.style.display = '';
            prettyEl.style.display = 'none';
        }
    } catch (e) {
        title.textContent = 'Error';
        rawEl.textContent = 'Failed to load file: ' + e.message;
        rawEl.style.display = '';
        prettyEl.style.display = 'none';
    }
}

function setFileViewMode(mode) {
    _fileViewMode = mode;
    const rawEl = document.getElementById('fileViewerContent');
    const prettyEl = document.getElementById('fileViewerPretty');

    if (mode === 'raw') {
        rawEl.textContent = _fileViewRaw;
        rawEl.style.display = '';
        prettyEl.style.display = 'none';
    } else {
        prettyEl.innerHTML = renderMarkdown(_fileViewRaw);
        prettyEl.style.display = '';
        rawEl.style.display = 'none';
    }

    document.querySelectorAll('#fileViewToggle .toggle-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });
}

function copyFileContent() {
    navigator.clipboard.writeText(_fileViewRaw || document.getElementById('fileViewerContent').textContent).then(() => {
        const btn = document.querySelector('#fileViewerModal .modal-footer .btn:first-child');
        if (btn) { const orig = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = orig, 1500); }
    });
}

function formatFileSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB'];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
    return `${bytes.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

// ── Auto-Archive Timer ───────────────────────────────────

function startAutoArchiveTimer(task) {
    // Only auto-archive agent tasks that have a report
    if (task.assignee !== 'agent') return;
    const ac = task.agentConfig || {};
    if (!ac.reportFile && !ac.response) return;

    // Clear existing timer if any
    if (completionTimers[task.id]) clearTimeout(completionTimers[task.id]);

    completionTimers[task.id] = setTimeout(async () => {
        try {
            await authFetch(`api/tasks/${task.id}/auto-archive`, { method: 'POST' });
            justCompletedTasks.delete(task.id);
            delete completionTimers[task.id];
            await refreshAll();
        } catch (e) {
            console.error(`Auto-archive failed for ${task.id}:`, e);
        }
    }, 30000);
}

// ── Executor Status ──────────────────────────────────────

async function loadExecutorStatus() {
    try {
        const resp = await fetch('api/executor/status');
        const data = await resp.json();
        const el = document.getElementById('executorStatus');
        if (!el) return;

        if (!data.enabled) {
            el.textContent = 'off';
            el.className = 'executor-status status-off';
        } else if (data.running_count > 0) {
            el.textContent = `${data.running_count} running`;
            el.className = 'executor-status status-running';
        } else {
            el.textContent = 'idle';
            el.className = 'executor-status status-idle';
        }
    } catch (e) {
        // Silently fail — status indicator is non-critical
    }
}

// ── Agent Validation ─────────────────────────────────────

async function validateAgent(agentId, agentType) {
    try {
        const resp = await fetch('api/agents/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent_id: agentId, agent_type: agentType }),
        });
        return await resp.json();
    } catch (e) {
        return { valid: false, error: e.message };
    }
}

// ── My Queue View ────────────────────────────────────────

let currentView = 'all';

function switchView(view) {
    // Tear down health view if leaving it
    if (currentView === 'health' && view !== 'health') {
        if (typeof MonitorHealth !== 'undefined') MonitorHealth.destroy();
    }

    currentView = view;
    document.querySelectorAll('.view-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.view === view);
    });

    const allView = document.getElementById('allTasksView');
    const queueView = document.getElementById('myQueueView');
    const feedbackView = document.getElementById('feedbackView');
    const auditView = document.getElementById('auditView');
    const healthView = document.getElementById('healthView');
    const controlBar = document.querySelector('.control-bar');
    const bottomGrid = document.querySelector('.bottom-grid');

    // Hide all views first
    allView.classList.add('hidden');
    queueView.classList.add('hidden');
    if (feedbackView) feedbackView.classList.add('hidden');
    if (auditView) auditView.classList.add('hidden');
    if (healthView) healthView.classList.add('hidden');

    if (view === 'health') {
        if (bottomGrid) bottomGrid.classList.add('hidden');
        controlBar.classList.add('hidden');
        if (healthView) healthView.classList.remove('hidden');
        if (typeof MonitorHealth !== 'undefined') MonitorHealth.init();
        // Update hash without triggering hashchange
        if (location.hash !== '#health') history.replaceState(null, '', '#health');
    } else if (view === 'my-queue') {
        if (bottomGrid) bottomGrid.classList.add('hidden');
        controlBar.classList.add('hidden');
        queueView.classList.remove('hidden');
        renderMyQueue();
        if (location.hash) history.replaceState(null, '', location.pathname);
    } else if (view === 'feedback') {
        if (bottomGrid) bottomGrid.classList.add('hidden');
        controlBar.classList.add('hidden');
        if (feedbackView) feedbackView.classList.remove('hidden');
        // Default to Open filter on first open (user can change)
        const statusSel = document.getElementById('feedbackFilterStatus');
        if (statusSel && !statusSel.dataset.userSet) {
            statusSel.value = 'open';
            statusSel.dataset.userSet = '1';
        }
        loadFeedback();
        if (location.hash) history.replaceState(null, '', location.pathname);
    } else if (view === 'audit') {
        if (bottomGrid) bottomGrid.classList.add('hidden');
        controlBar.classList.add('hidden');
        if (auditView) auditView.classList.remove('hidden');
        loadAudit();
        if (location.hash) history.replaceState(null, '', location.pathname);
    } else {
        allView.classList.remove('hidden');
        if (bottomGrid) bottomGrid.classList.remove('hidden');
        controlBar.classList.remove('hidden');
        // Force fresh data load when returning to All Tasks
        loadTasks();
        if (location.hash) history.replaceState(null, '', location.pathname);
    }
}

function getQueueItems() {
    const today = new Date().toISOString().slice(0, 10);
    const items = [];

    for (const t of tasks) {
        if (t.status === 'completed' || t.status === 'cancelled') continue;

        let queueType = null;
        let priority = 0; // lower = more urgent

        // Overdue tasks (highest priority)
        if (t.deadline && t.deadline < today && t.status !== 'completed') {
            queueType = 'overdue';
            priority = 0;
        }
        // Propose-mode tasks waiting for human decision
        else if (t.routing && t.routing.mode === 'propose') {
            queueType = 'propose';
            priority = 1;
        }
        // Scheduled tasks — authorized but waiting for execution
        else if (t.status === 'scheduled') {
            queueType = 'scheduled';
            priority = 2;
        }
        // Failed/timed_out/awaiting_retry — needs attention
        else if (t.status === 'failed' || t.status === 'timed_out' || t.status === 'awaiting_retry') {
            queueType = 'attention';
            priority = 1;
        }
        // Tasks explicitly assigned to human
        else if (t.assignee === 'human') {
            queueType = 'human';
            priority = 3;
        }

        if (queueType) {
            items.push({ ...t, queueType, queuePriority: priority });
        }
    }

    // Sort: overdue first, then propose, then human; within each by priority then date
    items.sort((a, b) => {
        if (a.queuePriority !== b.queuePriority) return a.queuePriority - b.queuePriority;
        const pa = priorityOrder[a.priority] ?? 2;
        const pb = priorityOrder[b.priority] ?? 2;
        if (pa !== pb) return pa - pb;
        return (b.createdAt || '').localeCompare(a.createdAt || '');
    });

    return items;
}

let queueHitlItems = [];

async function renderMyQueue() {
    const items = getQueueItems();

    // Also fetch HITL briefings for inline display
    try {
        const resp = await fetch('api/hitl');
        const data = await resp.json();
        queueHitlItems = data.items || [];
    } catch (e) {
        queueHitlItems = [];
    }

    const totalCount = items.length + queueHitlItems.length;
    const summary = document.getElementById('queueSummary');
    const cards = document.getElementById('queueCards');
    const empty = document.getElementById('queueEmpty');
    const badge = document.getElementById('queueBadge');

    // Update badge
    badge.textContent = totalCount;
    badge.classList.toggle('has-items', totalCount > 0);

    if (!totalCount) {
        summary.innerHTML = '';
        cards.innerHTML = '';
        empty.classList.remove('hidden');
        return;
    }

    empty.classList.add('hidden');

    // Summary counts
    const overdueCount = items.filter(i => i.queueType === 'overdue').length;
    const proposeCount = items.filter(i => i.queueType === 'propose').length;
    const humanCount = items.filter(i => i.queueType === 'human').length;
    const hitlCount = queueHitlItems.length;

    summary.innerHTML = `
        <div class="queue-summary-card">
            <div class="queue-summary-count" style="color: var(--text-primary)">${totalCount}</div>
            <div class="queue-summary-label">Total</div>
        </div>
        ${hitlCount ? `<div class="queue-summary-card">
            <div class="queue-summary-count" style="color: var(--accent-orange)">${hitlCount}</div>
            <div class="queue-summary-label">HITL Briefings</div>
        </div>` : ''}
        ${overdueCount ? `<div class="queue-summary-card">
            <div class="queue-summary-count" style="color: var(--accent-red)">${overdueCount}</div>
            <div class="queue-summary-label">Overdue</div>
        </div>` : ''}
        ${proposeCount ? `<div class="queue-summary-card">
            <div class="queue-summary-count" style="color: var(--accent-purple)">${proposeCount}</div>
            <div class="queue-summary-label">Proposals</div>
        </div>` : ''}
        ${humanCount ? `<div class="queue-summary-card">
            <div class="queue-summary-count" style="color: var(--accent-blue)">${humanCount}</div>
            <div class="queue-summary-label">Assigned</div>
        </div>` : ''}
    `;

    // Build sections
    let html = '';

    // HITL Briefings first (most urgent — agents waiting for your decision)
    if (hitlCount) {
        html += `<div class="queue-section-header">HITL Briefings <span class="queue-section-count">${hitlCount}</span></div>`;
        for (const h of queueHitlItems) {
            const taskId = h.filename.replace(/\.md$/, '');
            const linkedTask = tasks.find(t => t.id === taskId);
            const title = linkedTask ? linkedTask.title : taskId.replace(/-/g, ' ');
            const squad = linkedTask?.routing?.squads?.[0] || 'review';
            const priority = linkedTask?.priority || 'normal';
            const project = linkedTask?.project || '';
            const source = linkedTask?.source || '';

            const metaParts = [];
            metaParts.push(`<span>${esc(taskId)}</span>`);
            if (project) metaParts.push(`<span>${esc(project)}</span>`);
            if (priority !== 'normal') metaParts.push(`<span class="chip pri-${priority}" style="font-size:10px;">${esc(priority)}</span>`);
            metaParts.push(`<span>Squad: ${esc(squad)}</span>`);
            if (source) metaParts.push(`<span>${esc(source)}</span>`);

            html += `
                <div class="queue-card card-hitl" id="hitl-card-${escAttr(taskId)}">
                    <div class="queue-card-top">
                        <span class="queue-card-title">${esc(title)}</span>
                        <span class="queue-card-type type-hitl">HITL</span>
                    </div>
                    <div class="queue-card-meta">${metaParts.join('')}</div>
                    <div class="queue-card-desc">${esc(linkedTask?.description || 'Loading briefing...')}</div>
                    <div class="hitl-briefing-toggle">
                        <button class="btn" onclick="event.stopPropagation(); toggleHitlBriefing('${escAttr(h.filename)}', '${escAttr(taskId)}')">
                            Show Full Briefing
                        </button>
                    </div>
                    <div class="hitl-briefing-content hidden" id="hitl-briefing-${escAttr(taskId)}"></div>
                    <div class="hitl-notes-wrap">
                        <textarea class="hitl-notes" id="hitl-notes-${escAttr(taskId)}" placeholder="Add notes or instructions (optional)..."></textarea>
                    </div>
                    <div class="queue-card-actions">
                        <button class="btn btn-success" onclick="event.stopPropagation(); hitlRespond('${escAttr(h.filename)}', 'run')" title="Launch feedback fixer or squad immediately">Run</button>
                        <button class="btn btn-primary" onclick="event.stopPropagation(); hitlRespond('${escAttr(h.filename)}', 'queue')" title="Queue for auto-execute cycle">Queue</button>
                        <button class="btn btn-purple" onclick="event.stopPropagation(); hitlRespondWithSquad('${escAttr(h.filename)}')" title="Pick a specific squad to run">Run Squad</button>
                        <button class="btn btn-danger btn-sm" onclick="event.stopPropagation(); hitlRespond('${escAttr(h.filename)}', 'dismiss')" title="Archive briefing and reject task">Dismiss</button>
                    </div>
                </div>
            `;
        }
    }

    // Overdue tasks
    const overdueItems = items.filter(i => i.queueType === 'overdue');
    if (overdueItems.length) {
        html += `<div class="queue-section-header">Overdue <span class="queue-section-count">${overdueItems.length}</span></div>`;
        for (const item of overdueItems) html += renderQueueCard(item);
    }

    // Propose-mode tasks (need your decision)
    const proposeItems = items.filter(i => i.queueType === 'propose');
    if (proposeItems.length) {
        html += `<div class="queue-section-header">Needs Decision <span class="queue-section-count">${proposeItems.length}</span></div>`;
        for (const item of proposeItems) html += renderQueueCard(item);
    }

    // Needs attention — failed/timed_out/awaiting_retry
    const attentionItems = items.filter(i => i.queueType === 'attention');
    if (attentionItems.length) {
        html += `<div class="queue-section-header queue-section-attention">Needs Attention <span class="queue-section-count">${attentionItems.length}</span></div>`;
        for (const item of attentionItems) html += renderQueueCard(item);
    }

    // Scheduled tasks — authorized but waiting for execution
    const scheduledItems = items.filter(i => i.queueType === 'scheduled');
    if (scheduledItems.length) {
        const autoExecOn = document.getElementById('autoExecToggle')?.checked;
        const queueOn = document.getElementById('queueEnabledToggle')?.checked !== false;
        const hint = !queueOn ? ' (Queue is paused)' : !autoExecOn ? ' (Auto-Execute is OFF)' : ' (will run on next cycle)';
        html += `<div class="queue-section-header queue-section-scheduled">Scheduled — Awaiting Execution${hint} <span class="queue-section-count">${scheduledItems.length}</span></div>`;
        for (const item of scheduledItems) html += renderQueueCard(item);
    }

    // Human-assigned tasks
    const humanItems = items.filter(i => i.queueType === 'human');
    if (humanItems.length) {
        html += `<div class="queue-section-header">Assigned to You <span class="queue-section-count">${humanItems.length}</span></div>`;
        for (const item of humanItems) html += renderQueueCard(item);
    }

    cards.innerHTML = html;
}

function renderQueueCard(item) {
    const typeLabels = { overdue: 'Overdue', propose: 'Proposal', human: 'Assigned', scheduled: 'Scheduled', attention: 'Attention' };
    const typeClass = `type-${item.queueType}`;
    const cardClass = `card-${item.queueType}`;
    const desc = item.description ? item.description.substring(0, 200) : '';

    const metaParts = [];
    if (item.id) metaParts.push(`<span>${esc(item.id)}</span>`);
    if (item.project) metaParts.push(`<span>${esc(item.project)}</span>`);
    if (item.priority && item.priority !== 'normal') metaParts.push(`<span class="chip pri-${item.priority}" style="font-size:10px;">${esc(item.priority)}</span>`);
    if (item.deadline) metaParts.push(`<span>${esc(item.deadline)}</span>`);
    if (item.source) metaParts.push(`<span>${esc(item.source)}</span>`);

    // Action buttons depend on type
    let actions = '';
    if (item.queueType === 'propose') {
        // Check if this task has a HITL briefing file — if so, the HITL section handles it
        const hasHitl = queueHitlItems.some(h => h.filename === item.id + '.md');
        if (!hasHitl) {
            actions = `
                <button class="btn btn-approve" onclick="event.stopPropagation(); approveTask('${escAttr(item.id)}')" title="Authorize this task to proceed — enters the execution queue">✓ Approve</button>
                <button class="btn btn-success" onclick="event.stopPropagation(); queueRunTask('${escAttr(item.id)}')" title="Launch agent immediately without approval step">Run Now</button>
                <button class="btn btn-purple" onclick="event.stopPropagation(); queueReassignAgent('${escAttr(item.id)}')" title="Route to a specific agent/squad">Assign Agent</button>
                <button class="btn btn-danger btn-sm" onclick="event.stopPropagation(); quickQueueAction('${escAttr(item.id)}', 'reject')">Dismiss</button>
            `;
        } else {
            // Has HITL — skip this card (it's shown in HITL section above)
            return '';
        }
    } else if (item.queueType === 'scheduled') {
        actions = `
            <button class="btn btn-success" onclick="event.stopPropagation(); queueRunTask('${escAttr(item.id)}')" title="Launch agent immediately — bypasses auto-execute wait">Run Now</button>
            <button class="btn btn-danger btn-sm" onclick="event.stopPropagation(); quickQueueAction('${escAttr(item.id)}', 'cancel')" title="Cancel this task">Cancel</button>
        `;
    } else if (item.queueType === 'attention') {
        actions = `
            <button class="btn btn-success" onclick="event.stopPropagation(); queueRunTask('${escAttr(item.id)}')" title="Retry this task immediately">Retry</button>
            <button class="btn btn-danger btn-sm" onclick="event.stopPropagation(); quickQueueAction('${escAttr(item.id)}', 'cancel')" title="Cancel this task">Cancel</button>
        `;
    } else {
        actions = `
            <button class="btn btn-success" onclick="event.stopPropagation(); queueRunTask('${escAttr(item.id)}')" title="Launch agent immediately">Run</button>
            <button class="btn btn-primary" onclick="event.stopPropagation(); queueQueueTask('${escAttr(item.id)}')" title="Queue for auto-execute cycle">Queue</button>
            <button class="btn btn-purple" onclick="event.stopPropagation(); queueReassignAgent('${escAttr(item.id)}')" title="Route to a specific agent/squad">Assign Agent</button>
            <button class="btn btn-danger btn-sm" onclick="event.stopPropagation(); quickQueueAction('${escAttr(item.id)}', 'reject')">Dismiss</button>
        `;
    }

    return `
        <div class="queue-card ${cardClass}" id="queue-card-${escAttr(item.id)}" onclick="openDetail('${escAttr(item.id)}')">
            <div class="queue-card-top">
                <span class="queue-card-title">${esc(item.title)}</span>
                <span class="queue-card-type ${typeClass}">${typeLabels[item.queueType]}</span>
            </div>
            <div class="queue-card-meta">${metaParts.join('')}</div>
            ${desc ? `<div class="queue-card-desc">${esc(desc)}</div>` : ''}
            <div class="queue-card-actions">${actions}</div>
        </div>
    `;
}

async function queueRunTask(taskId) {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    try {
        // For feedback-sourced tasks, use the feedback fixer
        if (task.source === 'feedback' && task.sourceRef?.feedbackId) {
            const resp = await authFetch('api/feedback/action', {
                method: 'POST',
                body: JSON.stringify({ feedbackId: task.sourceRef.feedbackId, action: 'run' }),
            });
            const data = await resp.json();
            if (resp.ok && data.success) {
                removeQueueCard(`queue-card-${taskId}`);
                updateQueueBadge();
                updateQueueSectionCounts();
                loadTasks();
                showToast('Agent launched for ' + taskId);
            } else {
                alert('Failed: ' + (data.error || 'Unknown error'));
            }
        } else {
            // For non-feedback tasks, set to execute mode and trigger run
            await authFetch(`api/tasks/${taskId}`, {
                method: 'PATCH',
                body: JSON.stringify({
                    routing: { ...(task.routing || {}), mode: 'execute' },
                    assignee: 'agent',
                    status: 'running',
                }),
            });
            const squads = (task.routing && task.routing.squads) ? task.routing.squads : [];
            const squad = squads[0] || 'review';
            await authFetch(`api/tasks/${taskId}/run`, {
                method: 'POST',
                body: JSON.stringify({ squad }),
            });
            removeQueueCard(`queue-card-${taskId}`);
            updateQueueBadge();
            updateQueueSectionCounts();
            loadTasks();
            showToast('Squad ' + squad + ' launched for ' + taskId);
        }
    } catch (e) {
        alert(`Error: ${e.message}`);
    }
}

async function queueQueueTask(taskId) {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    try {
        // For feedback-sourced tasks, use the feedback queue action
        if (task.source === 'feedback' && task.sourceRef?.feedbackId) {
            const resp = await authFetch('api/feedback/action', {
                method: 'POST',
                body: JSON.stringify({ feedbackId: task.sourceRef.feedbackId, action: 'queue' }),
            });
            const data = await resp.json();
            if (resp.ok && data.success) {
                removeQueueCard(`queue-card-${taskId}`);
                updateQueueBadge();
                updateQueueSectionCounts();
                loadTasks();
                showToast('Queued ' + taskId + ' for auto-execute');
            } else {
                alert('Failed: ' + (data.error || 'Unknown error'));
            }
        } else {
            // For non-feedback tasks, set routing mode to queued
            await authFetch(`api/tasks/${taskId}`, {
                method: 'PATCH',
                body: JSON.stringify({
                    routing: { ...(task.routing || {}), mode: 'queued' },
                    assignee: 'agent',
                }),
            });
            removeQueueCard(`queue-card-${taskId}`);
            updateQueueBadge();
            updateQueueSectionCounts();
            loadTasks();
            showToast('Queued ' + taskId + ' for auto-execute');
        }
    } catch (e) {
        alert(`Error: ${e.message}`);
    }
}

async function quickQueueAction(taskId, action) {
    const opts = { method: 'POST' };
    if (action === 'reject') {
        const reason = prompt(`Dismiss task ${taskId}?\n\nRejection reason (optional, Cancel to abort):`);
        if (reason === null) return; // cancelled
        if (reason.trim()) {
            opts.body = JSON.stringify({ reason: reason.trim() });
        }
    }
    try {
        await authFetch(`api/tasks/${taskId}/${action}`, opts);
        removeQueueCard(`queue-card-${taskId}`);
        updateQueueBadge();
        updateQueueSectionCounts();
        loadTasks();
    } catch (e) {
        alert(`Error: ${e.message}`);
    }
}

async function queueReassignAgent(taskId) {
    if (!confirm(`Reassign task ${taskId} to an agent? The system will auto-route and schedule it.`)) return;
    try {
        await authFetch(`api/tasks/${taskId}`, {
            method: 'PATCH',
            body: JSON.stringify({ assignee: 'agent' }),
        });
        const routeResp = await authFetch(`api/tasks/${taskId}/auto-route`, { method: 'POST' });
        if (routeResp && routeResp.ok) {
            const routeResult = await routeResp.json();
            const routed = routeResult.task || {};
            if (routed.assignee === 'agent' && routed.agentConfig?.agentId) {
                // Schedule so executor picks it up
                await authFetch(`api/tasks/${taskId}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ status: 'scheduled' }),
                });
                showToast(`Auto-routed to ${routed.agentConfig.agentName || routed.agentConfig.agentId} — task scheduled`);
            } else {
                showToast('Auto-route assigned to human review — no suitable agent found');
            }
        }
        removeQueueCard(`queue-card-${taskId}`);
        updateQueueBadge();
        updateQueueSectionCounts();
        loadTasks();
    } catch (e) {
        alert(`Error: ${e.message}`);
    }
}

// ── HITL Response Actions ────────────────────────────────

async function toggleHitlBriefing(filename, taskId) {
    const el = document.getElementById(`hitl-briefing-${taskId}`);
    if (!el) return;

    if (el.classList.contains('hidden')) {
        // Load and show
        el.innerHTML = '<div class="text-muted" style="padding:8px;">Loading...</div>';
        el.classList.remove('hidden');
        try {
            const resp = await fetch(`api/hitl/${encodeURIComponent(filename)}`);
            const data = await resp.json();
            el.innerHTML = `<div class="markdown-content">${renderMarkdown(data.content || '')}</div>`;
        } catch (e) {
            el.innerHTML = `<div class="text-muted" style="padding:8px;">Failed to load briefing</div>`;
        }
        // Update button text
        const btn = el.previousElementSibling?.querySelector('button');
        if (btn) btn.textContent = 'Hide Briefing';
    } else {
        el.classList.add('hidden');
        const btn = el.previousElementSibling?.querySelector('button');
        if (btn) btn.textContent = 'Show Full Briefing';
    }
}

async function hitlRespond(filename, action, squad) {
    const taskId = filename.replace(/\.md$/, '');
    const notesEl = document.getElementById(`hitl-notes-${taskId}`);
    const notes = notesEl ? notesEl.value.trim() : '';

    if (action === 'dismiss' && !confirm(`Dismiss task ${taskId}? This will archive the briefing.`)) return;
    if (action === 'approve' && !confirm(`Approve task ${taskId} and run squad "${squad}"?`)) return;

    try {
        const body = { action, notes };
        if (squad) body.squad = squad;
        const resp = await authFetch(`api/hitl/${encodeURIComponent(filename)}/respond`, {
            method: 'POST',
            body: JSON.stringify(body),
        });
        const data = await resp.json();
        if (data.success) {
            removeQueueCard(`hitl-card-${taskId}`);
            queueHitlItems = queueHitlItems.filter(h => h.filename !== filename);
            updateQueueBadge();
            updateQueueSectionCounts();
            loadTasks();
            if (action === 'run') showToast('Agent launched for ' + taskId);
            if (action === 'queue') showToast('Queued ' + taskId + ' for auto-execute');
        } else {
            alert(`Failed: ${data.detail || data.error || 'Unknown error'}`);
        }
    } catch (e) {
        alert(`Error: ${e.message}`);
    }
}

async function hitlRespondWithSquad(filename) {
    const taskId = filename.replace(/\.md$/, '');
    const task = tasks.find(t => t.id === taskId);
    const defaultSquads = task?.routing?.squads || [];

    const squadNames = squadsData.map(s => s.name);
    if (!squadNames.length) {
        alert('No squads available');
        return;
    }
    const choice = prompt(
        `Choose a squad to run for ${taskId}:\n\n` +
        squadNames.map((n, i) => `${i + 1}. ${n}${defaultSquads.includes(n) ? ' (recommended)' : ''}`).join('\n') +
        `\n\nEnter squad name or number:`
    );
    if (!choice) return;

    let squad = choice.trim();
    const num = parseInt(squad, 10);
    if (!isNaN(num) && num >= 1 && num <= squadNames.length) {
        squad = squadNames[num - 1];
    }

    await hitlRespond(filename, 'approve', squad);
}

// Remove a single card from the queue with fade-out animation
function removeQueueCard(cardId) {
    const card = document.getElementById(cardId);
    if (!card) return;
    card.style.transition = 'opacity 0.3s, max-height 0.3s, margin 0.3s, padding 0.3s';
    card.style.opacity = '0';
    card.style.overflow = 'hidden';
    setTimeout(() => {
        card.style.maxHeight = '0';
        card.style.marginBottom = '0';
        card.style.paddingTop = '0';
        card.style.paddingBottom = '0';
        card.style.borderWidth = '0';
        setTimeout(() => card.remove(), 300);
    }, 200);

    // Check if the queue is now empty after removal
    setTimeout(() => {
        const cards = document.getElementById('queueCards');
        const remaining = cards ? cards.querySelectorAll('.queue-card').length : 0;
        if (remaining === 0) {
            const empty = document.getElementById('queueEmpty');
            if (empty) empty.classList.remove('hidden');
            const summary = document.getElementById('queueSummary');
            if (summary) summary.innerHTML = '';
        }
    }, 600);
}

// Update section header counts after card removal (without full re-render)
function updateQueueSectionCounts() {
    document.querySelectorAll('.queue-section-header').forEach(header => {
        // Count remaining cards in the section (cards between this header and the next header)
        let count = 0;
        let el = header.nextElementSibling;
        while (el && !el.classList.contains('queue-section-header')) {
            if (el.classList.contains('queue-card')) count++;
            el = el.nextElementSibling;
        }
        const badge = header.querySelector('.queue-section-count');
        if (badge) badge.textContent = count;
        // Hide section if empty
        if (count === 0) header.style.display = 'none';
    });
}

// Update badge on every task load (HITL count from last fetch)
function updateQueueBadge() {
    const items = getQueueItems();
    const total = items.length + queueHitlItems.length;
    const badge = document.getElementById('queueBadge');
    if (badge) {
        badge.textContent = total;
        badge.classList.toggle('has-items', total > 0);
    }
}

// ── Utilities ────────────────────────────────────────────
function esc(str) {
    if (str == null) return '';
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
}

function escAttr(str) {
    return esc(str).replace(/"/g, '&quot;');
}

function formatDate(iso) {
    if (!iso) return '\u2014';
    try {
        const d = new Date(iso);
        return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
        return iso;
    }
}

function renderMarkdown(text) {
    let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Code blocks (fenced) — extract before other transforms
    const codeBlocks = [];
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
        codeBlocks.push('<pre><code>' + code + '</code></pre>');
        return '\x00CB' + (codeBlocks.length - 1) + '\x00';
    });

    // Horizontal rules
    html = html.replace(/^[-*_]{3,}$/gm, '<hr>');

    // Headers
    html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Bold/italic
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Tables
    html = html.replace(/^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)+)/gm, (_, header, sep, body) => {
        const aligns = sep.split('|').filter(c => c.trim()).map(c => {
            c = c.trim();
            if (c.startsWith(':') && c.endsWith(':')) return 'center';
            if (c.endsWith(':')) return 'right';
            return 'left';
        });
        const th = header.split('|').filter(c => c.trim())
            .map((c, i) => '<th style="text-align:' + (aligns[i] || 'left') + '">' + c.trim() + '</th>').join('');
        const rows = body.trim().split('\n').map(row => {
            const cells = row.split('|').filter(c => c.trim())
                .map((c, i) => '<td style="text-align:' + (aligns[i] || 'left') + '">' + c.trim() + '</td>').join('');
            return '<tr>' + cells + '</tr>';
        }).join('');
        return '<table class="md-table"><thead><tr>' + th + '</tr></thead><tbody>' + rows + '</tbody></table>';
    });

    // Checkboxes
    html = html.replace(/^- \[x\] (.+)$/gm, '<li class="task-done"><span class="checkbox checked"></span>$1</li>');
    html = html.replace(/^- \[ \] (.+)$/gm, '<li class="task-todo"><span class="checkbox"></span>$1</li>');

    // Unordered lists
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');

    // Ordered lists
    html = html.replace(/^\d+\. (.+)$/gm, '<li class="ol-item">$1</li>');

    // Wrap consecutive <li> into <ul> or <ol>
    html = html.replace(/((?:<li class="ol-item">.*<\/li>\n?)+)/gm, m => '<ol>' + m.replace(/ class="ol-item"/g, '') + '</ol>');
    html = html.replace(/((?:<li(?:\s[^>]*)?>.*<\/li>\n?)+)/gm, m => {
        if (m.startsWith('<ol>')) return m;
        return '<ul>' + m + '</ul>';
    });

    // Blockquotes
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

    // Paragraphs
    html = html.replace(/\n\n/g, '</p><p>');
    html = '<p>' + html + '</p>';

    // Clean up empty paragraphs around block elements
    html = html.replace(/<p>\s*(<h[1-4]|<hr|<table|<ul|<ol|<pre|<blockquote)/g, '$1');
    html = html.replace(/(<\/h[1-4]>|<\/table>|<\/ul>|<\/ol>|<\/pre>|<\/blockquote>|<hr>)\s*<\/p>/g, '$1');
    html = html.replace(/<p>\s*<\/p>/g, '');

    // Remaining single newlines → <br>
    html = html.replace(/\n/g, '<br>');

    // Restore code blocks
    html = html.replace(/\x00CB(\d+)\x00/g, (_, i) => codeBlocks[parseInt(i)]);

    return html;
}

// ── Feedback View ────────────────────────────────────────

let feedbackItems = [];
let feedbackSummary = {};
// Store evaluation results in memory so they persist across polling refreshes
const _feedbackEvaluations = {};

async function loadFeedback(force) {
    const container = document.getElementById('feedbackCards');
    try {
        const resp = await fetch('api/feedback');
        const data = await resp.json();
        feedbackItems = data.items || [];
        feedbackSummary = data.summary || {};

        // Re-apply any stored evaluation tags so they persist across polling refreshes
        for (const item of feedbackItems) {
            const stored = _feedbackEvaluations[item.feedbackId];
            if (stored) item._evalTag = buildEvalTag(stored);
        }

        renderFeedbackSummary();
        populateFeedbackFilters();
        renderFeedback(force);
    } catch (e) {
        console.error('Failed to load feedback:', e);
        if (container) container.innerHTML = '<div class="empty-state">Failed to load feedback: ' + e.message + '</div>';
    }
}

async function updateTokenBudgetBadge() {
    const btn = document.getElementById('tokenBudgetBtn');
    if (!btn) return;
    try {
        const resp = await fetch('api/token-usage');
        const d = await resp.json();
        // Remove any existing badge
        const old = btn.querySelector('.token-badge');
        if (old) old.remove();
        if (!d.enabled) return;
        const pct = Math.round((d.used / d.budget) * 100);
        const cls = pct >= 100 ? 'over' : pct >= 75 ? 'warn' : 'ok';
        const badge = document.createElement('span');
        badge.className = 'token-badge ' + cls;
        badge.textContent = pct + '%';
        btn.appendChild(badge);
    } catch {}
}

async function loadFeedbackBadge() {
    try {
        const resp = await fetch('api/feedback');
        const data = await resp.json();
        const summary = data.summary || {};
        const badge = document.getElementById('feedbackBadge');
        if (badge) {
            // Show total non-implemented feedback (all severities needing attention)
            const count = (summary.total || 0) - (summary.implemented || 0);
            badge.textContent = count;
            badge.classList.toggle('has-items', count > 0);
        }
    } catch {}
}

function renderFeedbackSummary() {
    const el = document.getElementById('feedbackSummary');
    if (!el) return;
    const s = feedbackSummary;
    el.innerHTML = `
        <div class="queue-summary-card">
            <div class="queue-summary-count" style="color: var(--text-primary)">${s.total || 0}</div>
            <div class="queue-summary-label">Total</div>
        </div>
        <div class="queue-summary-card">
            <div class="queue-summary-count" style="color: var(--accent-red)">${(s.by_severity || {}).HIGH || 0}</div>
            <div class="queue-summary-label">High</div>
        </div>
        <div class="queue-summary-card">
            <div class="queue-summary-count" style="color: var(--accent-orange)">${(s.by_severity || {}).MEDIUM || 0}</div>
            <div class="queue-summary-label">Medium</div>
        </div>
        <div class="queue-summary-card">
            <div class="queue-summary-count" style="color: var(--accent-blue)">${(s.by_severity || {}).LOW || 0}</div>
            <div class="queue-summary-label">Low</div>
        </div>
        <div class="queue-summary-card">
            <div class="queue-summary-count" style="color: var(--accent-green)">${s.implemented || 0}</div>
            <div class="queue-summary-label">Done</div>
        </div>
    `;
}

function populateFeedbackFilters() {
    const toolSelect = document.getElementById('feedbackFilterTool');
    if (!toolSelect) return;
    const tools = [...new Set(feedbackItems.map(i => i.tool))].sort();
    const current = toolSelect.value;
    toolSelect.innerHTML = '<option value="">All Tools</option>' +
        tools.map(t => `<option value="${escAttr(t)}">${esc(t)}</option>`).join('');
    toolSelect.value = current;
}

function getFilteredFeedback() {
    const toolFilter = document.getElementById('feedbackFilterTool')?.value || '';
    const sevFilter = document.getElementById('feedbackFilterSeverity')?.value || '';
    const statusFilter = document.getElementById('feedbackFilterStatus')?.value || '';

    return feedbackItems.filter(item => {
        if (toolFilter && item.tool !== toolFilter) return false;
        if (sevFilter && item.severity !== sevFilter) return false;
        if (statusFilter === 'open' && (item.implemented || item.taskId)) return false;
        if (statusFilter === 'queued-running') {
            if (!item.taskId) return false;
            const ts = item.taskStatus;
            if (ts !== 'running' && ts !== 'pending' && ts !== 'scheduled' && ts !== 'awaiting_retry') return false;
        }
        if (statusFilter === 'implemented' && !item.implemented) return false;
        if (statusFilter === 'has-task' && !item.taskId) return false;
        return true;
    });
}

function feedbackUserInteracting() {
    // Returns true if the user has an open context textarea or focused input in the feedback view
    const feedbackView = document.getElementById('feedbackView');
    if (!feedbackView) return false;
    // Check for open context areas (added by feedbackAddContext)
    if (feedbackView.querySelector('.feedback-context-area')) return true;
    // Check if any input/textarea inside feedback is focused
    const active = document.activeElement;
    if (active && feedbackView.contains(active) && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) return true;
    return false;
}

function renderFeedback(force) {
    const container = document.getElementById('feedbackCards');
    if (!container) return;

    // Don't rebuild if user is mid-interaction (context textarea open, etc.)
    // Unless force=true (manual refresh)
    if (!force && feedbackUserInteracting()) return;

    const filtered = getFilteredFeedback();
    if (!filtered.length) {
        container.innerHTML = '<div class="empty-state">No feedback items match the current filters</div>';
        return;
    }

    container.innerHTML = filtered.map(renderFeedbackCard).join('');
}

function renderFeedbackCard(item) {
    const sevColors = { HIGH: 'var(--accent-red)', MEDIUM: 'var(--accent-orange)', LOW: 'var(--accent-blue)' };
    const sevBg = { HIGH: 'rgba(248,81,73,0.15)', MEDIUM: 'rgba(210,153,34,0.15)', LOW: 'rgba(88,166,255,0.15)' };
    const implemented = item.implemented;
    const taskStatus = item.taskStatus;
    const taskAgent = item.taskAgent || '';
    const opacityStyle = (implemented || taskStatus === 'completed') ? 'opacity: 0.5;' : '';
    const strikeStyle = (implemented || taskStatus === 'completed') ? 'text-decoration: line-through;' : '';

    let actionsHtml = '';
    if (implemented || taskStatus === 'completed') {
        actionsHtml = '<span class="chip chip-completed">IMPLEMENTED</span>';
    } else if (item.taskId && taskStatus === 'running') {
        actionsHtml = `
            <span class="chip chip-running"><span class="spinner-sm"></span> Running</span>
            ${taskAgent ? `<span class="feedback-agent-name">${esc(taskAgent)}</span>` : ''}
            <a class="btn btn-sm" onclick="openDetail('${escAttr(item.taskId)}'); switchView('all');" style="cursor:pointer;">View Task</a>
        `;
    } else if (item.taskId && (taskStatus === 'pending' || taskStatus === 'scheduled' || taskStatus === 'awaiting_retry')) {
        actionsHtml = `
            <span class="chip chip-queued">Queued</span>
            ${taskAgent ? `<span class="feedback-agent-name">${esc(taskAgent)}</span>` : ''}
            <a class="btn btn-sm" onclick="openDetail('${escAttr(item.taskId)}'); switchView('all');" style="cursor:pointer;">View Task</a>
        `;
    } else {
        actionsHtml = `
            <button class="btn btn-success" onclick="feedbackRun('${escAttr(item.feedbackId)}')" title="Create task and launch fixer agent immediately">Run</button>
            <button class="btn btn-primary" onclick="feedbackQueue('${escAttr(item.feedbackId)}')" title="Create task for orchestrator queue (runs later)">Queue</button>
            <button class="btn btn-purple" onclick="feedbackAddContext('${escAttr(item.feedbackId)}')">Add Context</button>
            <button class="btn btn-sm" onclick="feedbackReEvaluate('${escAttr(item.feedbackId)}')" title="Re-evaluate against current app state" style="background: var(--bg-tertiary); color: var(--text-secondary);">Re-Evaluate</button>
            <button class="btn btn-danger btn-sm" onclick="feedbackAction('${escAttr(item.feedbackId)}', 'dismiss')">Dismiss</button>
        `;
    }

    return `
        <div class="feedback-card" data-feedback-id="${escAttr(item.feedbackId)}" style="${opacityStyle} border-left-color: ${sevColors[item.severity] || sevColors.LOW};">
            <div class="feedback-card-top">
                <div class="feedback-card-title" style="${strikeStyle}">${esc(item.description)}</div>
                ${(implemented || taskStatus === 'completed')
                    ? `<span class="chip" style="background: ${sevBg[item.severity] || sevBg.LOW}; color: ${sevColors[item.severity] || sevColors.LOW};">${item.severity}</span>`
                    : `<select class="feedback-severity-select" data-feedback-id="${escAttr(item.feedbackId)}" onchange="feedbackChangeSeverity('${escAttr(item.feedbackId)}', this.value)" style="background: ${sevBg[item.severity] || sevBg.LOW}; color: ${sevColors[item.severity] || sevColors.LOW}; border: 1px solid ${sevColors[item.severity] || sevColors.LOW};">
                        <option value="HIGH" ${item.severity === 'HIGH' ? 'selected' : ''}>HIGH</option>
                        <option value="MEDIUM" ${item.severity === 'MEDIUM' ? 'selected' : ''}>MEDIUM</option>
                        <option value="LOW" ${item.severity === 'LOW' ? 'selected' : ''}>LOW</option>
                    </select>`
                }
            </div>
            <div class="feedback-card-meta">
                <span class="chip" style="background: var(--bg-primary); color: var(--text-secondary);">${esc(item.tool)}</span>
                <span class="chip" style="background: var(--bg-primary); color: var(--text-muted);">${esc(item.category)}</span>
                ${item._evalTag || ''}
                <span style="font-size: 11px; color: var(--text-muted);">${esc(item.timestamp || '')}</span>
            </div>
            <div class="feedback-card-actions">${actionsHtml}</div>
        </div>
    `;
}

async function feedbackChangeSeverity(feedbackId, newSeverity) {
    try {
        const resp = await authFetch('api/feedback/action', {
            method: 'POST',
            body: JSON.stringify({ feedbackId, action: 'change-severity', extraData: { severity: newSeverity } }),
        });
        const data = await resp.json();
        if (resp.ok && data.success) {
            // Update local state so re-renders reflect the change
            const item = feedbackItems.find(i => i.feedbackId === feedbackId);
            if (item) item.severity = newSeverity;
            renderFeedback();
            loadFeedbackBadge();
            showToast(`Severity changed to ${newSeverity}`);
        } else {
            alert('Failed: ' + (data.error || data.detail || 'Unknown error'));
            renderFeedback(); // Reset dropdown to original value
        }
    } catch (e) {
        alert('Error: ' + e.message);
        renderFeedback();
    }
}

async function feedbackAction(feedbackId, action) {
    if (action === 'dismiss' && !confirm('Dismiss this feedback? It will be removed from the file.')) return;
    try {
        const resp = await authFetch('api/feedback/action', {
            method: 'POST',
            body: JSON.stringify({ feedbackId, action }),
        });
        const data = await resp.json();
        if (resp.ok && data.success) {
            await loadFeedback(true);
            loadFeedbackBadge();
        } else {
            alert('Failed: ' + (data.error || data.detail || 'Unknown error'));
        }
    } catch (e) {
        alert('Error: ' + e.message);
    }
}

function buildEvalTag(ev) {
    const tagColors = {
        missing:       { bg: 'rgba(63,185,80,0.15)',   color: '#3fb950', label: 'Missing',      cls: 'eval-missing' },
        unnecessary:   { bg: 'rgba(248,81,73,0.15)',   color: '#f85149', label: 'Un-Necessary', cls: 'eval-unnecessary' },
        implemented:   { bg: 'rgba(88,166,255,0.15)',   color: '#58a6ff', label: 'Implemented',  cls: 'eval-implemented' },
        partial:       { bg: 'rgba(210,153,34,0.15)',  color: '#d29922', label: 'Partial',       cls: 'eval-partial' },
    };
    const tc = tagColors[ev.status] || tagColors.missing;
    const safeReason = esc(ev.reason).replace(/'/g, '&#39;').replace(/"/g, '&quot;');
    return `<span class="chip feedback-eval-tag ${tc.cls}" style="background: ${tc.bg}; color: ${tc.color}; cursor: help; position: relative;" title="${safeReason}">${tc.label}</span>`;
}

async function feedbackReEvaluate(feedbackId) {
    const card = document.querySelector(`[data-feedback-id="${feedbackId}"]`);
    if (!card) return;

    // Show pulsing green state on the button
    const btn = card.querySelector('[onclick*="feedbackReEvaluate"]');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Evaluating...';
        btn.classList.add('btn-evaluating');
    }

    try {
        const resp = await authFetch('api/feedback/action', {
            method: 'POST',
            body: JSON.stringify({ feedbackId, action: 're-evaluate' }),
        });
        const data = await resp.json();
        if (resp.ok && data.success && data.evaluation) {
            const ev = data.evaluation;
            // Persist in memory map — survives polling re-renders
            _feedbackEvaluations[feedbackId] = ev;

            // Update the item in feedbackItems so renderFeedback picks it up
            const item = feedbackItems.find(i => i.feedbackId === feedbackId);
            if (item) item._evalTag = buildEvalTag(ev);

            renderFeedback();
            showToast(`Evaluated: ${ev.status} — ${ev.reason}`);
        } else {
            if (btn) { btn.disabled = false; btn.textContent = 'Re-Evaluate'; btn.classList.remove('btn-evaluating'); }
            alert('Evaluation failed: ' + (data.error || data.detail || 'Unknown error'));
        }
    } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = 'Re-Evaluate'; btn.classList.remove('btn-evaluating'); }
        alert('Error: ' + e.message);
    }
}

async function feedbackRun(feedbackId) {
    try {
        const resp = await authFetch('api/feedback/action', {
            method: 'POST',
            body: JSON.stringify({ feedbackId, action: 'run' }),
        });
        const data = await resp.json();
        if (resp.ok && data.success) {
            await loadFeedback(true);
            loadFeedbackBadge();
            if (data.launched) {
                showToast('Agent launched for ' + data.task_id);
            } else {
                showToast(data.message || 'Task created — no agent matched, assign manually');
            }
        } else {
            alert('Failed: ' + (data.error || data.detail || 'Unknown error'));
        }
    } catch (e) {
        alert('Error: ' + e.message);
    }
}

async function feedbackQueue(feedbackId) {
    try {
        const resp = await authFetch('api/feedback/action', {
            method: 'POST',
            body: JSON.stringify({ feedbackId, action: 'queue' }),
        });
        const data = await resp.json();
        if (resp.ok && data.success) {
            await loadFeedback(true);
            loadFeedbackBadge();
            showToast('Queued ' + data.task_id + ' for orchestrator');
        } else {
            alert('Failed: ' + (data.error || data.detail || 'Unknown error'));
        }
    } catch (e) {
        alert('Error: ' + e.message);
    }
}

async function feedbackAssignAndRun(feedbackId) {
    // Build options: Auto + squads + agents
    const opts = ['0. Auto (let system decide)'];
    const squadsList = agentsData.squads || [];
    const agentsList = agentsData.agents || [];
    for (let i = 0; i < squadsList.length; i++) {
        opts.push((i + 1) + '. [Squad] ' + squadsList[i].name);
    }
    const offset = squadsList.length + 1;
    for (let i = 0; i < agentsList.length; i++) {
        opts.push((offset + i) + '. ' + agentsList[i].name + ' (' + agentsList[i].id + ')');
    }

    const choice = prompt('Choose an agent or squad:\n\n' + opts.join('\n') + '\n\nEnter number:');
    if (choice === null) return;

    const num = parseInt(choice.trim(), 10);
    let agentId = null;
    let agentType = 'agent';

    if (num === 0 || choice.trim().toLowerCase() === 'auto') {
        // Auto-route — no agentId
    } else if (num >= 1 && num <= squadsList.length) {
        agentId = squadsList[num - 1].id;
        agentType = 'squad';
    } else if (num >= offset && num < offset + agentsList.length) {
        agentId = agentsList[num - offset].id;
        agentType = 'agent';
    } else {
        alert('Invalid selection');
        return;
    }

    try {
        const body = { feedbackId, action: 'run' };
        if (agentId) {
            body.agentId = agentId;
            body.agentType = agentType;
        }
        const resp = await authFetch('api/feedback/action', {
            method: 'POST',
            body: JSON.stringify(body),
        });
        const data = await resp.json();
        if (resp.ok && data.success) {
            await loadFeedback(true);
            loadFeedbackBadge();
            if (data.launched) {
                showToast('Agent launched for ' + data.task_id);
            } else {
                showToast(data.message || 'Task created — assign manually');
            }
        } else {
            alert('Failed: ' + (data.error || data.detail || 'Unknown error'));
        }
    } catch (e) {
        alert('Error: ' + e.message);
    }
}

// Store context text per feedback ID so it survives card re-renders
const _feedbackContextDrafts = {};

function feedbackAddContext(feedbackId) {
    const card = document.querySelector('[data-feedback-id="' + feedbackId + '"]');
    if (!card) return;
    const actionsDiv = card.querySelector('.feedback-card-actions');
    if (!actionsDiv) return;

    const savedDraft = _feedbackContextDrafts[feedbackId] || '';

    actionsDiv.innerHTML = '<div class="feedback-context-area">' +
        '<textarea id="fb-ctx-' + feedbackId + '" placeholder="Add context, notes, or instructions for the agent...">' + esc(savedDraft) + '</textarea>' +
        '<div class="feedback-context-btns">' +
        '<button class="btn btn-success" onclick="feedbackSaveContext(\'' + feedbackId + '\')">Save &amp; Run</button>' +
        '<button class="btn btn-primary" onclick="feedbackSaveContextOnly(\'' + feedbackId + '\')">Save Context</button>' +
        '<button class="btn" onclick="feedbackCollapseContext(\'' + feedbackId + '\')">Cancel</button>' +
        '</div></div>';

    const textarea = document.getElementById('fb-ctx-' + feedbackId);
    if (textarea) {
        textarea.focus();
        // Save draft as user types
        textarea.addEventListener('input', () => { _feedbackContextDrafts[feedbackId] = textarea.value; });
    }
}

function feedbackCollapseContext(feedbackId) {
    // Save current text before collapsing
    const textarea = document.getElementById('fb-ctx-' + feedbackId);
    if (textarea) _feedbackContextDrafts[feedbackId] = textarea.value;
    renderFeedback(true);
}

async function feedbackSaveContext(feedbackId) {
    const textarea = document.getElementById('fb-ctx-' + feedbackId);
    const context = textarea ? textarea.value.trim() : '';

    // Save context if provided
    if (context) {
        try {
            await authFetch('api/feedback/action', {
                method: 'POST',
                body: JSON.stringify({ feedbackId, action: 'add-context', extraData: { context } }),
            });
        } catch (e) {
            alert('Error saving context: ' + e.message);
            return;
        }
    }

    // Clear draft since it's been saved
    delete _feedbackContextDrafts[feedbackId];

    // Run the feedback fixer — force reload after to show Running status
    try {
        const resp = await authFetch('api/feedback/action', {
            method: 'POST',
            body: JSON.stringify({ feedbackId, action: 'run' }),
        });
        const data = await resp.json();
        if (resp.ok && data.success) {
            await loadFeedback(true);  // force=true to bypass interaction guard
            loadFeedbackBadge();
            if (data.launched) {
                showToast('Agent launched for ' + data.task_id);
            } else {
                showToast(data.message || 'Task created');
            }
        } else {
            alert('Failed: ' + (data.error || data.detail || 'Unknown error'));
        }
    } catch (e) {
        alert('Error: ' + e.message);
    }
}

async function feedbackSaveContextOnly(feedbackId) {
    const textarea = document.getElementById('fb-ctx-' + feedbackId);
    const context = textarea ? textarea.value.trim() : '';
    if (!context) {
        alert('Please enter some context');
        return;
    }

    // Clear draft since it's been saved
    delete _feedbackContextDrafts[feedbackId];

    try {
        const resp = await authFetch('api/feedback/action', {
            method: 'POST',
            body: JSON.stringify({ feedbackId, action: 'add-context', extraData: { context } }),
        });
        const data = await resp.json();
        if (resp.ok && data.success) {
            showToast('Context saved');
            await loadFeedback(true);  // force=true to collapse textarea and refresh
        } else {
            alert('Failed: ' + (data.error || data.detail || 'Unknown error'));
        }
    } catch (e) {
        alert('Error: ' + e.message);
    }
}

// ── Audit View ───────────────────────────────────────────

let auditRecords = [];
let auditSummaryData = {};
let auditPage = 1;
const auditPageSize = 50;
let auditTierFilter = '';

function setAuditTier(btn, tier) {
    auditTierFilter = tier;
    document.querySelectorAll('.audit-tier-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    auditPage = 1;
    loadAudit();
}

async function loadAudit(force) {
    const agent = document.getElementById('auditFilterAgent')?.value || '';
    const service = document.getElementById('auditFilterService')?.value || '';
    const origin = document.getElementById('auditFilterOrigin')?.value || '';
    const status = document.getElementById('auditFilterStatus')?.value || '';
    const dateFrom = document.getElementById('auditDateFrom')?.value || '';
    const dateTo = document.getElementById('auditDateTo')?.value || '';
    const sort = document.getElementById('auditSort')?.value || 'timestamp';

    const params = new URLSearchParams();
    if (auditTierFilter) params.set('tier', auditTierFilter);
    if (service) params.set('service', service);
    if (agent) params.set('agent', agent);
    if (origin) params.set('origin', origin);
    if (status) params.set('status', status);
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    params.set('sort', sort);
    params.set('dir', 'desc');
    params.set('page', auditPage);
    params.set('limit', auditPageSize);

    try {
        const [recordsResp, summaryResp] = await Promise.all([
            fetch('api/audit?' + params.toString()),
            fetch('api/audit/summary?' + (dateFrom ? 'date_from=' + dateFrom : '') + (dateTo ? '&date_to=' + dateTo : '')),
        ]);
        const recordsData = await recordsResp.json();
        const summaryData = await summaryResp.json();

        auditRecords = recordsData.records || [];
        auditSummaryData = summaryData;

        renderAuditSummary();
        renderAuditTable(recordsData.total);
        renderAuditPagination(recordsData.total);
        populateAuditAgentFilter(summaryData);
        populateAuditServiceFilter();
        updateAuditHeartbeat();
        updateTokenBudgetBadge();

        document.getElementById('auditTableInfo').textContent =
            `Showing ${auditRecords.length} of ${recordsData.total} records`;
    } catch (e) {
        console.error('Failed to load audit:', e);
    }
}

function formatTokens(n) {
    if (!n || n === 0) return '0';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
}

function renderAuditSummary() {
    const s = auditSummaryData;
    const el = document.getElementById('auditSummary');
    if (!el) return;

    const bt = s.byTier || {};
    const tierBreakdown = (bt.execution || bt.system || bt.health)
        ? '<div class="queue-summary-card">' +
            '<div class="queue-summary-count" style="font-size:13px">' +
                '<span class="audit-tier-dot audit-tier-execution"></span>' + (bt.execution || 0) +
                ' <span class="audit-tier-dot audit-tier-system" style="margin-left:6px"></span>' + (bt.system || 0) +
                ' <span class="audit-tier-dot audit-tier-health" style="margin-left:6px"></span>' + (bt.health || 0) +
            '</div>' +
            '<div class="queue-summary-label">By Tier</div>' +
          '</div>'
        : '';

    el.innerHTML =
        '<div class="queue-summary-card">' +
            '<div class="queue-summary-count">' + (s.totalRuns || 0) + '</div>' +
            '<div class="queue-summary-label">Total Runs</div>' +
        '</div>' +
        '<div class="queue-summary-card">' +
            '<div class="queue-summary-count" style="color:var(--accent-blue)">' + formatTokens(s.totalTokens || 0) + '</div>' +
            '<div class="queue-summary-label">Total Tokens</div>' +
        '</div>' +
        '<div class="queue-summary-card">' +
            '<div class="queue-summary-count">' + formatTokens(s.avgTokensPerRun || 0) + '</div>' +
            '<div class="queue-summary-label">Avg Tokens/Run</div>' +
        '</div>' +
        '<div class="queue-summary-card">' +
            '<div class="queue-summary-count">' + formatDuration(s.avgDurationMs || 0) + '</div>' +
            '<div class="queue-summary-label">Avg Duration</div>' +
        '</div>' +
        '<div class="queue-summary-card">' +
            '<div class="queue-summary-count" style="color:' + ((s.errorRate || 0) > 0.1 ? 'var(--accent-red)' : 'var(--accent-green)') + '">' + ((s.errorRate || 0) * 100).toFixed(1) + '%</div>' +
            '<div class="queue-summary-label">Error Rate</div>' +
        '</div>' +
        tierBreakdown;
}

async function showTokenBudgetSettings() {
    // Fetch fresh settings + usage to ensure current values
    try {
        const [settingsResp, usageResp] = await Promise.all([
            fetch('api/settings'),
            fetch('api/token-usage'),
        ]);
        const fresh = await settingsResp.json();
        const usage = await usageResp.json();
        // Update local settings cache
        Object.assign(settings, fresh);
        _renderTokenBudgetModal(fresh, usage);
    } catch (e) {
        // Fallback to cached settings
        _renderTokenBudgetModal(settings, null);
    }
}

function _renderTokenBudgetModal(s, usage) {
    const enabled = s.daily_token_budget_enabled !== false;
    const budget = s.daily_token_budget || 5000000;
    const model = s.feedback_fixer_model || 'sonnet';
    const maxTurns = s.feedback_fixer_max_turns || 7;

    let usageBar = '';
    if (usage) {
        const pct = Math.min(100, Math.round((usage.used / budget) * 100));
        const cls = pct >= 100 ? 'over' : pct >= 75 ? 'warn' : 'ok';
        const usedFmt = (usage.used / 1e6).toFixed(1) + 'M';
        const budgetFmt = (budget / 1e6).toFixed(1) + 'M';
        usageBar =
            '<div style="margin-bottom:12px;padding:8px 12px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px">' +
                '<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px">' +
                    '<span>Today: ' + usedFmt + ' / ' + budgetFmt + ' tokens</span>' +
                    '<span class="token-badge ' + cls + '">' + pct + '%</span>' +
                '</div>' +
                '<div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden">' +
                    '<div style="height:100%;width:' + pct + '%;background:var(--accent-' + (cls === 'over' ? 'red' : cls === 'warn' ? 'orange' : 'green') + ');border-radius:3px;transition:width .3s"></div>' +
                '</div>' +
            '</div>';
    }

    const html = '<div class="modal-overlay visible" id="tokenBudgetModal" onclick="if(event.target===this)this.remove()">' +
        '<div class="modal" style="max-width:480px">' +
            '<div class="modal-header"><h3>Agent Execution Settings</h3><button class="modal-close" onclick="document.getElementById(\'tokenBudgetModal\').remove()">&times;</button></div>' +
            '<div class="modal-body">' +
                usageBar +
                '<div class="form-group">' +
                    '<label class="form-label">Daily Token Budget</label>' +
                    '<div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">' +
                        '<label class="toggle"><input type="checkbox" id="budgetEnabledToggle" ' + (enabled ? 'checked' : '') + '><span class="toggle-slider"></span></label>' +
                        '<span>' + (enabled ? 'Enabled' : 'Disabled') + '</span>' +
                    '</div>' +
                    '<input type="number" id="budgetLimitInput" class="form-input" value="' + budget + '" min="100000" step="500000" style="width:100%">' +
                    '<small class="text-muted">Tokens per day. Auto-execution pauses when budget is reached.</small>' +
                '</div>' +
                '<div class="form-group">' +
                    '<label class="form-label">Feedback Fixer Model</label>' +
                    '<select id="fixerModelSelect" class="form-input" style="width:100%">' +
                        '<option value="haiku"' + (model === 'haiku' ? ' selected' : '') + '>Haiku (fastest, cheapest)</option>' +
                        '<option value="sonnet"' + (model === 'sonnet' ? ' selected' : '') + '>Sonnet (balanced)</option>' +
                        '<option value="opus"' + (model === 'opus' ? ' selected' : '') + '>Opus (most capable)</option>' +
                    '</select>' +
                '</div>' +
                '<div class="form-group">' +
                    '<label class="form-label">Max Turns per Fix</label>' +
                    '<input type="number" id="fixerMaxTurnsInput" class="form-input" value="' + maxTurns + '" min="1" max="50" style="width:100%">' +
                    '<small class="text-muted">Lower = cheaper. 8 for simple fixes, 15 for moderate, 25+ for complex.</small>' +
                '</div>' +
            '</div>' +
            '<div class="modal-footer">' +
                '<button class="btn" onclick="document.getElementById(\'tokenBudgetModal\').remove()">Cancel</button>' +
                '<button class="btn btn-primary" onclick="saveTokenBudgetSettings()">Save</button>' +
            '</div>' +
        '</div>' +
    '</div>';

    document.body.insertAdjacentHTML('beforeend', html);
}

async function saveTokenBudgetSettings() {
    const enabled = document.getElementById('budgetEnabledToggle').checked;
    const budget = parseInt(document.getElementById('budgetLimitInput').value) || 5000000;
    const model = document.getElementById('fixerModelSelect').value;
    const maxTurns = parseInt(document.getElementById('fixerMaxTurnsInput').value) || 8;

    const payload = {
        daily_token_budget_enabled: enabled,
        daily_token_budget: budget,
        feedback_fixer_model: model,
        feedback_fixer_max_turns: maxTurns,
    };

    try {
        const resp = await authFetch('api/settings', {
            method: 'POST',
            body: JSON.stringify(payload),
        });
        if (!resp.ok) {
            const body = await resp.json().catch(() => ({}));
            alert('Save failed: ' + (body.detail || body.error || 'HTTP ' + resp.status));
            return;
        }
        const data = await resp.json();
        // Update local cache
        settings.daily_token_budget_enabled = enabled;
        settings.daily_token_budget = budget;
        settings.feedback_fixer_model = model;
        settings.feedback_fixer_max_turns = maxTurns;
        showToast('Settings saved');
        document.getElementById('tokenBudgetModal')?.remove();
        updateTokenBudgetBadge();
        loadAudit();
    } catch (e) {
        alert('Error saving: ' + e.message);
    }
}

function renderAuditTable(total) {
    const tbody = document.getElementById('auditTableBody');
    if (!tbody) return;

    const avgTokens = auditSummaryData.avgTokensPerRun || 0;
    const avgDur = auditSummaryData.avgDurationMs || 0;

    tbody.innerHTML = auditRecords.map(r => {
        // Normalize: support both legacy (flat) and tiered (details) format
        const d = r.details || {};
        const isError = r.isError || d.isError || r.status === 'failed' || r.status === 'timeout';
        const rTokens = r.tokensTotal || d.tokensTotal || 0;
        const rDuration = r.durationMs || r.duration_ms || 0;
        const isAnomaly = !isError && ((rTokens > avgTokens * 2 && avgTokens > 0) || (rDuration > avgDur * 2 && avgDur > 0));
        const rowClass = isError ? 'audit-row-error' : isAnomaly ? 'audit-row-anomaly' : '';
        const tokenClass = (rTokens > avgTokens * 2 && avgTokens > 0) ? 'text-warning' : '';

        const time = (r.timestamp || r.startedAt) ? new Date(r.timestamp || r.startedAt).toLocaleString() : '—';

        // Service column — tiered records have r.service, legacy have nothing
        const serviceName = r.service || '';
        const serviceBadge = serviceName
            ? '<span class="audit-service-badge">' + esc(serviceName.replace('opai-', '')) + '</span>'
            : '<span class="text-muted">—</span>';

        // Event column — tiered have r.event, legacy use origin
        const eventLabel = r.event || r.origin || 'manual';
        const agentLabel = d.agentName || d.agentId || r.agentName || r.agentId || '';
        const eventCell = agentLabel
            ? '<span class="audit-event-label">' + esc(eventLabel) + '</span><br><span class="text-muted" style="font-size:10px">' + esc(agentLabel) + '</span>'
            : '<span class="audit-event-label">' + esc(eventLabel) + '</span>';

        // Model (may be nested in details for tiered records)
        const model = r.model || d.model || '';
        const tokensOut = r.tokensOutput || d.tokensOutput || 0;

        const statusColor = isError ? 'var(--accent-red)' :
            r.status === 'partial' ? 'var(--accent-orange)' :
            r.status === 'skipped' ? 'var(--text-muted)' : 'var(--accent-green)';
        const statusBadge = '<span class="status-badge" style="color:' + statusColor + '">' + esc(r.status || '—') + '</span>';

        // Tier indicator dot
        const tierDot = r.tier ? '<span class="audit-tier-dot audit-tier-' + r.tier + '" title="' + r.tier + '"></span>' : '';

        return '<tr class="' + rowClass + '" data-audit-id="' + r.id + '" onclick="toggleAuditDetail(this, \'' + r.id + '\')">' +
            '<td class="audit-cell-time">' + tierDot + time + '</td>' +
            '<td>' + serviceBadge + '</td>' +
            '<td>' + eventCell + '</td>' +
            '<td>' + esc(agentLabel || '—') + '</td>' +
            '<td class="audit-cell-model">' + esc(model || '—') + '</td>' +
            '<td>' + formatDuration(rDuration) + '</td>' +
            '<td class="' + tokenClass + '">' + formatTokens(rTokens) + '</td>' +
            '<td>' + formatTokens(tokensOut) + '</td>' +
            '<td>' + statusBadge +
                ' <button class="btn-ai" onclick="event.stopPropagation();openAuditAI(\'' + r.id + '\')" title="AI Analysis">AI</button>' +
            '</td>' +
        '</tr>';
    }).join('');
}

function toggleAuditDetail(rowEl, auditId) {
    const existing = rowEl.nextElementSibling;
    if (existing && existing.classList.contains('audit-detail-row')) {
        existing.remove();
        return;
    }
    document.querySelectorAll('.audit-detail-row').forEach(r => r.remove());

    const r = auditRecords.find(rec => rec.id === auditId);
    if (!r) return;

    const d = r.details || {};
    const detailRow = document.createElement('tr');
    const tier = r.tier || 'legacy';

    // Detect record type for appropriate detail layout
    const isLegacySquad = !r.tier && (r.agentType === 'squad' || r.agentType === 'evolution');
    const isLegacyAgent = !r.tier && !isLegacySquad;
    const isExecution = tier === 'execution';
    const isSystem = tier === 'system';
    const isHealth = tier === 'health';

    let detailHtml = '';

    if (isLegacySquad) {
        // Legacy squad format
        detailHtml = [
            '<div><strong>Agent Type:</strong> ' + esc(r.agentType || '—') + '</div>',
            '<div><strong>Agents Run:</strong> ' + esc((r.agentsRun || []).join(', ') || '—') + '</div>',
            '<div><strong>Findings:</strong> ' + (r.totalFindings || 0) + ' critical/high</div>',
            '<div><strong>Action Items:</strong> ' + (r.totalActions || 0) + '</div>',
            '<div><strong>Output Size:</strong> ' + formatSize(r.outputSizeChars || 0) + '</div>',
            '<div><strong>Audit ID:</strong> ' + esc(r.id) + '</div>',
        ].join('');
    } else if (isLegacyAgent) {
        // Legacy single-agent format
        const taskId = r.taskId || d.taskId || '';
        const sameTask = taskId ? auditRecords.filter(rec => (rec.taskId || (rec.details || {}).taskId) === taskId) : [];
        const attemptIdx = sameTask.indexOf(r) + 1;
        const retryInfo = sameTask.length > 1 ? '<div><strong>Attempt:</strong> ' + attemptIdx + ' of ' + sameTask.length + '</div>' : '';
        detailHtml = [
            '<div><strong>Session ID:</strong> ' + esc(r.session_id || r.sessionId || '—') + '</div>',
            '<div><strong>Turns:</strong> ' + (r.numTurns || 0) + '</div>',
            '<div><strong>API Duration:</strong> ' + formatDuration(r.durationApiMs || 0) + '</div>',
            '<div><strong>Prompt Size:</strong> ' + formatSize(r.promptSizeChars || 0) + '</div>',
            '<div><strong>Agent Type:</strong> ' + esc(r.agentType || '—') + '</div>',
            '<div><strong>Audit ID:</strong> ' + esc(r.id) + '</div>',
            '<div><strong>Input Tokens:</strong> ' + formatTokens(r.tokensInput || 0) + '</div>',
            '<div><strong>Output Tokens:</strong> ' + formatTokens(r.tokensOutput || 0) + '</div>',
            '<div><strong>Cache Read:</strong> ' + formatTokens(r.tokensCacheRead || 0) + '</div>',
            '<div><strong>Cache Create:</strong> ' + formatTokens(r.tokensCacheCreate || 0) + '</div>',
            retryInfo,
        ].join('');
    } else if (isExecution) {
        // Tiered execution format
        detailHtml = [
            '<div><strong>Service:</strong> ' + esc(r.service || '—') + '</div>',
            '<div><strong>Event:</strong> ' + esc(r.event || '—') + '</div>',
            '<div><strong>Agent:</strong> ' + esc(d.agentName || d.agentId || '—') + '</div>',
            '<div><strong>Agent Type:</strong> ' + esc(d.agentType || '—') + '</div>',
            '<div><strong>Task ID:</strong> ' + esc(d.taskId || '—') + '</div>',
            '<div><strong>Audit ID:</strong> ' + esc(r.id) + '</div>',
            '<div><strong>Model:</strong> ' + esc(d.model || '—') + '</div>',
            '<div><strong>Turns:</strong> ' + (d.numTurns || 0) + '</div>',
            '<div><strong>Input Tokens:</strong> ' + formatTokens(d.tokensInput || 0) + '</div>',
            '<div><strong>Output Tokens:</strong> ' + formatTokens(d.tokensOutput || 0) + '</div>',
            '<div><strong>Cache Read:</strong> ' + formatTokens(d.tokensCacheRead || 0) + '</div>',
            '<div><strong>Cost:</strong> $' + (d.costUsd || 0).toFixed(4) + '</div>',
            d.sessionId ? '<div><strong>Session:</strong> ' + esc(d.sessionId) + '</div>' : '',
        ].join('');
    } else if (isSystem) {
        // System tier — service operations
        const detailKeys = Object.keys(d).filter(k => !['agentId','agentName','agentType','model'].includes(k));
        detailHtml = [
            '<div><strong>Service:</strong> ' + esc(r.service || '—') + '</div>',
            '<div><strong>Event:</strong> ' + esc(r.event || '—') + '</div>',
            '<div><strong>Audit ID:</strong> ' + esc(r.id) + '</div>',
            '<div><strong>Duration:</strong> ' + formatDuration(r.duration_ms || 0) + '</div>',
        ].join('');
        // Show all detail keys dynamically
        for (const k of detailKeys) {
            const v = d[k];
            if (v === null || v === undefined) continue;
            const label = k.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
            detailHtml += '<div><strong>' + esc(label) + ':</strong> ' + esc(typeof v === 'object' ? JSON.stringify(v) : String(v)) + '</div>';
        }
    } else if (isHealth) {
        // Health tier — heartbeat/status checks
        detailHtml = [
            '<div><strong>Service:</strong> ' + esc(r.service || '—') + '</div>',
            '<div><strong>Event:</strong> ' + esc(r.event || '—') + '</div>',
            '<div><strong>Audit ID:</strong> ' + esc(r.id) + '</div>',
        ].join('');
        for (const [k, v] of Object.entries(d)) {
            if (v === null || v === undefined) continue;
            const label = k.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
            detailHtml += '<div><strong>' + esc(label) + ':</strong> ' + esc(typeof v === 'object' ? JSON.stringify(v) : String(v)) + '</div>';
        }
    }

    // Common fields across all formats
    const summary = r.summary || '';
    const errorMsg = r.errorMessage || d.errorMessage || '';
    const reportFile = r.reportFile || d.reportFile || '';
    const reportDir = r.reportDir || d.reportDir || '';

    detailRow.className = 'audit-detail-row';
    detailRow.innerHTML = '<td colspan="9" class="audit-detail-cell">' +
        (summary ? '<div class="audit-detail-summary">' + esc(summary) + '</div>' : '') +
        '<div class="audit-detail-grid">' + detailHtml + '</div>' +
        (errorMsg ? '<div style="margin-top:8px;color:var(--accent-red)"><strong>Error:</strong> ' + esc(errorMsg) + '</div>' : '') +
        (reportFile ? '<div style="margin-top:4px"><strong>Report:</strong> <a href="#" onclick="event.preventDefault();viewAttachment(\'' + escAttr(reportFile) + '\')">' + esc(reportFile.split('/').slice(-2).join('/')) + '</a></div>' : '') +
        (reportDir ? '<div><strong>Report Dir:</strong> <code style="font-size:10px">' + esc(reportDir) + '</code></div>' : '') +
        (isLegacyAgent ? '<div style="margin-top:4px"><button class="btn btn-sm" onclick="loadAuditTrace(\'' + escAttr(r.id) + '\', this)">Show Steps</button><span class="trace-container" id="trace-' + r.id + '"></span></div>' : '') +
        (isExecution && d.sessionId ? '<div style="margin-top:4px"><button class="btn btn-sm" onclick="loadAuditTrace(\'' + escAttr(r.id) + '\', this)">Show Steps</button><span class="trace-container" id="trace-' + r.id + '"></span></div>' : '') +
    '</td>';
    rowEl.after(detailRow);
}

async function loadAuditTrace(auditId, btn) {
    const container = document.getElementById('trace-' + auditId);
    if (!container) return;
    if (container.innerHTML) {
        container.innerHTML = '';
        btn.textContent = 'Show Steps';
        return;
    }
    btn.textContent = 'Loading...';
    try {
        const resp = await fetch('api/audit/' + encodeURIComponent(auditId) + '/trace');
        const data = await resp.json();
        if (!data.steps || data.steps.length === 0) {
            container.innerHTML = '<span class="text-muted" style="margin-left:8px">No trace available (session not found)</span>';
            btn.textContent = 'Show Steps';
            return;
        }
        const icons = {Grep:'🔍', Glob:'📂', Read:'📖', Edit:'✏️', Write:'📝', Bash:'⚠️', text:'💬'};
        let html = '<div class="trace-steps">';
        for (const s of data.steps) {
            const icon = icons[s.action] || '🔧';
            const cls = s.action === 'Edit' || s.action === 'Write' ? 'trace-step-edit' : s.action === 'text' ? 'trace-step-text' : 'trace-step';
            const file = s.file ? '<code>' + esc(s.file) + '</code> ' : '';
            const detail = esc(s.detail || '').substring(0, 80);
            html += '<div class="' + cls + '">';
            html += '<span class="trace-turn">T' + s.turn + '</span> ';
            html += icon + ' <strong>' + esc(s.action) + '</strong> ' + file + '<span class="text-muted">' + detail + '</span>';
            html += '</div>';
        }
        html += '</div>';
        container.innerHTML = html;
        btn.textContent = 'Hide Steps';
    } catch (e) {
        container.innerHTML = '<span style="color:var(--accent-red);margin-left:8px">Failed to load trace</span>';
        btn.textContent = 'Show Steps';
    }
}

function renderAuditPagination(total) {
    const el = document.getElementById('auditPagination');
    if (!el) return;
    const totalPages = Math.ceil(total / auditPageSize);
    if (totalPages <= 1) { el.innerHTML = ''; return; }

    let html = '';
    if (auditPage > 1) html += `<button class="btn" onclick="auditPage--;loadAudit()">Prev</button>`;
    html += `<span style="margin:0 8px;font-size:12px;color:var(--text-muted)">Page ${auditPage}/${totalPages}</span>`;
    if (auditPage < totalPages) html += `<button class="btn" onclick="auditPage++;loadAudit()">Next</button>`;
    el.innerHTML = html;
}

function populateAuditAgentFilter(summary) {
    const sel = document.getElementById('auditFilterAgent');
    if (!sel) return;
    const current = sel.value;
    const agents = Object.keys(summary.byAgent || {}).sort();
    sel.innerHTML = '<option value="">All Agents</option>' +
        agents.map(a => '<option value="' + escAttr(a) + '"' + (a === current ? ' selected' : '') + '>' + esc(a) + '</option>').join('');
}

function populateAuditServiceFilter() {
    const sel = document.getElementById('auditFilterService');
    if (!sel) return;
    const current = sel.value;
    const services = new Set();
    for (const r of auditRecords) {
        if (r.service) services.add(r.service);
    }
    const sorted = [...services].sort();
    sel.innerHTML = '<option value="">All Services</option>' +
        sorted.map(s => '<option value="' + escAttr(s) + '"' + (s === current ? ' selected' : '') + '>' + esc(s) + '</option>').join('');
}

function updateAuditHeartbeat() {
    const el = document.getElementById('auditHeartbeat');
    if (!el) return;
    if (auditRecords.length === 0) {
        el.textContent = '';
        el.className = 'audit-heartbeat';
        return;
    }
    const latest = auditRecords[0];
    const ts = latest.timestamp || latest.startedAt;
    if (!ts) { el.textContent = ''; return; }
    const ago = Date.now() - new Date(ts).getTime();
    const mins = Math.floor(ago / 60000);
    let label, cls;
    if (mins < 5) { label = 'just now'; cls = 'heartbeat-ok'; }
    else if (mins < 60) { label = mins + 'm ago'; cls = 'heartbeat-ok'; }
    else if (mins < 1440) { label = Math.floor(mins / 60) + 'h ago'; cls = mins > 360 ? 'heartbeat-stale' : 'heartbeat-warn'; }
    else { label = Math.floor(mins / 1440) + 'd ago'; cls = 'heartbeat-stale'; }
    el.innerHTML = '<span class="heartbeat-dot ' + cls + '"></span>Last: ' + label;
    el.className = 'audit-heartbeat ' + cls;
}

async function loadAuditBadge() {
    try {
        const resp = await fetch('api/audit?limit=1&page=1');
        const data = await resp.json();
        const badge = document.getElementById('auditBadge');
        if (badge) badge.textContent = data.total || 0;
    } catch {}
}

// ── AI Audit Analyzer ─────────────────────────────────────

let _aiChatState = null;  // {auditId, record, messages: [{role,content}], streaming}

function openAuditAI(auditId) {
    const r = auditRecords.find(rec => rec.id === auditId);
    if (!r) return;

    const d = r.details || {};
    const statusText = r.status || '?';
    const isError = statusText === 'failed' || statusText === 'timeout';
    const agentLabel = d.agentName || d.agentId || r.agentName || r.agentId || '?';
    const eventLabel = r.event || r.origin || 'manual';
    const serviceLabel = (r.service || '').replace('opai-', '') || '?';
    const model = d.model || r.model || '?';
    const duration = formatDuration(r.durationMs || r.duration_ms || 0);
    const tokens = formatTokens(d.tokensTotal || r.tokensTotal || 0);

    _aiChatState = { auditId: auditId, record: r, messages: [], streaming: false };

    const html = '<div class="modal-overlay visible ai-analyze-modal" id="aiAnalyzeModal" onclick="if(event.target===this)closeAuditAI()">' +
        '<div class="modal">' +
            '<div class="modal-header">' +
                '<h3>AI Log Analysis</h3>' +
                '<button class="modal-close" onclick="closeAuditAI()">&times;</button>' +
            '</div>' +
            '<div class="modal-body">' +
                '<div class="ai-context-bar">' +
                    '<span class="ai-context-tag ' + (isError ? 'status-fail' : 'status-ok') + '">' + esc(statusText) + '</span>' +
                    '<span class="ai-context-tag">' + esc(serviceLabel) + '</span>' +
                    '<span class="ai-context-tag">' + esc(eventLabel) + '</span>' +
                    '<span class="ai-context-tag">' + esc(agentLabel) + '</span>' +
                    '<span class="ai-context-tag">' + esc(model) + '</span>' +
                    '<span class="ai-context-tag">' + duration + '</span>' +
                    '<span class="ai-context-tag">' + tokens + ' tok</span>' +
                '</div>' +
                '<div class="ai-chat-messages" id="aiChatMessages"></div>' +
                '<div class="ai-chat-input-bar">' +
                    '<input type="text" id="aiChatInput" placeholder="Ask a follow-up question..." onkeydown="if(event.key===\'Enter\')sendAuditAI()">' +
                    '<button class="btn btn-primary" onclick="sendAuditAI()">Send</button>' +
                '</div>' +
            '</div>' +
        '</div>' +
    '</div>';

    document.body.insertAdjacentHTML('beforeend', html);

    // Auto-trigger initial analysis
    _runAuditAnalysis();
}

function closeAuditAI() {
    document.getElementById('aiAnalyzeModal')?.remove();
    _aiChatState = null;
}

function sendAuditAI() {
    if (!_aiChatState || _aiChatState.streaming) return;
    const input = document.getElementById('aiChatInput');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';

    _aiChatState.messages.push({ role: 'user', content: text });
    _appendAIChatMsg('user', text);
    _runAuditAnalysis();
}

function _appendAIChatMsg(role, content) {
    const container = document.getElementById('aiChatMessages');
    if (!container) return;
    const div = document.createElement('div');
    div.className = 'ai-msg ai-msg-' + role;
    if (role === 'assistant') {
        div.innerHTML = _renderMarkdown(content);
    } else {
        div.textContent = content;
    }
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    return div;
}

function _appendAILoading() {
    const container = document.getElementById('aiChatMessages');
    if (!container) return;
    const div = document.createElement('div');
    div.className = 'ai-msg-loading';
    div.id = 'aiLoadingMsg';
    div.innerHTML = 'Analyzing <span class="dot-pulse">.</span><span class="dot-pulse">.</span><span class="dot-pulse">.</span>';
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function _removeAILoading() {
    document.getElementById('aiLoadingMsg')?.remove();
}

async function _runAuditAnalysis() {
    if (!_aiChatState || _aiChatState.streaming) return;
    _aiChatState.streaming = true;
    _appendAILoading();

    const payload = { messages: _aiChatState.messages };
    let fullText = '';

    try {
        const resp = await authFetch('api/audit/' + encodeURIComponent(_aiChatState.auditId) + '/analyze', {
            method: 'POST',
            body: JSON.stringify(payload),
        });

        if (!resp.ok) {
            _removeAILoading();
            _appendAIChatMsg('assistant', 'Error: ' + resp.status + ' ' + resp.statusText);
            _aiChatState.streaming = false;
            return;
        }

        _removeAILoading();

        // Create the assistant message element for streaming
        const msgDiv = _appendAIChatMsg('assistant', '');
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
                    const event = JSON.parse(line.slice(6));
                    if (event.type === 'delta') {
                        fullText += event.content;
                        msgDiv.innerHTML = _renderMarkdown(fullText);
                        const container = document.getElementById('aiChatMessages');
                        if (container) container.scrollTop = container.scrollHeight;
                    } else if (event.type === 'result' && !fullText) {
                        fullText = event.content;
                        msgDiv.innerHTML = _renderMarkdown(fullText);
                    } else if (event.type === 'text' && !fullText) {
                        fullText = event.content;
                        msgDiv.innerHTML = _renderMarkdown(fullText);
                    } else if (event.type === 'error') {
                        fullText += '\n\n**Error:** ' + event.content;
                        msgDiv.innerHTML = _renderMarkdown(fullText);
                    }
                } catch (e) { /* skip unparseable SSE lines */ }
            }
        }

        if (!fullText) {
            msgDiv.innerHTML = '<span class="text-muted">No response received</span>';
        }

        // Save assistant response for follow-up context
        _aiChatState.messages.push({ role: 'assistant', content: fullText });

        // Add "Create Task" button if this looks like a failure with suggestions
        const r = _aiChatState.record;
        const isError = r.status === 'failed' || r.status === 'timeout';
        if (isError || fullText.toLowerCase().includes('fix') || fullText.toLowerCase().includes('suggest')) {
            _appendTaskButton(fullText);
        }

    } catch (e) {
        _removeAILoading();
        _appendAIChatMsg('assistant', 'Connection error: ' + e.message);
    }

    _aiChatState.streaming = false;
}

function _appendTaskButton(analysisText) {
    const container = document.getElementById('aiChatMessages');
    if (!container) return;
    const div = document.createElement('div');
    div.className = 'ai-task-suggestion';
    div.innerHTML =
        '<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">Create a task from this analysis?</div>' +
        '<button class="btn btn-primary" onclick="_openCreateTaskFromAI()">Create Fix Task</button> ' +
        '<button class="btn" onclick="_openCreateTaskFromAI(\'agent\')">Delegate to Agent</button>';
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function _openCreateTaskFromAI(assignType) {
    if (!_aiChatState) return;
    const r = _aiChatState.record;
    const d = r.details || {};
    const agentLabel = d.agentName || d.agentId || r.agentName || r.agentId || '?';
    const eventLabel = r.event || r.origin || '';
    const serviceLabel = r.service || '';
    const lastAssistant = _aiChatState.messages.filter(m => m.role === 'assistant').pop();
    const analysis = lastAssistant ? lastAssistant.content : '';

    // Build a descriptive title
    const errorMsg = r.errorMessage || d.errorMessage || '';
    const statusText = r.status || 'failed';
    let title = 'Fix: ' + (serviceLabel ? serviceLabel.replace('opai-', '') + ' ' : '') +
        eventLabel + ' ' + statusText;
    if (title.length > 80) title = title.substring(0, 77) + '...';

    // Build description with full context
    const description =
        'Auto-generated from AI audit analysis.\n\n' +
        '## Audit Context\n' +
        '- **Audit ID**: ' + r.id + '\n' +
        '- **Service**: ' + (serviceLabel || '?') + '\n' +
        '- **Event**: ' + (eventLabel || '?') + '\n' +
        '- **Agent**: ' + agentLabel + '\n' +
        '- **Status**: ' + statusText + '\n' +
        (errorMsg ? '- **Error**: ' + errorMsg + '\n' : '') +
        '\n## AI Analysis\n' + analysis;

    const isAgent = assignType === 'agent';

    // Build task creation modal
    const modalHtml = '<div class="modal-overlay visible" id="aiTaskModal" onclick="if(event.target===this)this.remove()" style="z-index:300">' +
        '<div class="modal" style="max-width:600px">' +
            '<div class="modal-header">' +
                '<h3>' + (isAgent ? 'Delegate to Agent' : 'Create Fix Task') + '</h3>' +
                '<button class="modal-close" onclick="document.getElementById(\'aiTaskModal\').remove()">&times;</button>' +
            '</div>' +
            '<div class="modal-body">' +
                '<div class="form-group">' +
                    '<label class="form-label">Title</label>' +
                    '<input type="text" id="aiTaskTitle" class="form-input" value="' + escAttr(title) + '" style="width:100%">' +
                '</div>' +
                '<div class="form-group">' +
                    '<label class="form-label">Priority</label>' +
                    '<select id="aiTaskPriority" class="form-select" style="width:100%">' +
                        '<option value="critical"' + (statusText === 'timeout' ? ' selected' : '') + '>Critical</option>' +
                        '<option value="high"' + (statusText === 'failed' ? ' selected' : '') + '>High</option>' +
                        '<option value="normal" selected>Normal</option>' +
                        '<option value="low">Low</option>' +
                    '</select>' +
                '</div>' +
                (isAgent ? '<div class="form-group">' +
                    '<label class="form-label">Agent</label>' +
                    '<select id="aiTaskAgent" class="form-select" style="width:100%">' +
                        '<option value="">Auto-route (let OPAI decide)</option>' +
                        '<option value="builder">Builder</option>' +
                        '<option value="fixer">Fixer</option>' +
                        '<option value="auditor">Auditor</option>' +
                    '</select>' +
                '</div>' : '') +
                '<div class="form-group">' +
                    '<label class="form-label">Description (includes AI analysis)</label>' +
                    '<textarea id="aiTaskDesc" class="form-input" rows="8" style="width:100%;resize:vertical;font-size:11px">' + esc(description) + '</textarea>' +
                '</div>' +
            '</div>' +
            '<div class="modal-footer">' +
                '<button class="btn" onclick="document.getElementById(\'aiTaskModal\').remove()">Cancel</button>' +
                '<button class="btn btn-primary" onclick="_submitTaskFromAI(' + (isAgent ? 'true' : 'false') + ')">Create Task</button>' +
            '</div>' +
        '</div>' +
    '</div>';
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

async function _submitTaskFromAI(isAgent) {
    const title = document.getElementById('aiTaskTitle')?.value?.trim();
    const priority = document.getElementById('aiTaskPriority')?.value || 'normal';
    const description = document.getElementById('aiTaskDesc')?.value?.trim();
    if (!title) { alert('Title required'); return; }

    const payload = {
        title: title,
        description: description,
        priority: priority,
        source: 'ai-audit-analysis',
        sourceRef: {
            auditId: _aiChatState ? _aiChatState.auditId : null,
        },
        project: 'OPAI Server',
    };

    if (isAgent) {
        const agentId = document.getElementById('aiTaskAgent')?.value || '';
        if (agentId) {
            payload.agentConfig = { agentId: agentId, agentType: 'agent' };
        }
        // auto-route will handle if no specific agent chosen
    } else {
        payload.assignee = 'human';
    }

    try {
        const resp = await authFetch('api/tasks', {
            method: 'POST',
            body: JSON.stringify(payload),
        });
        if (!resp.ok) {
            const body = await resp.json().catch(() => ({}));
            alert('Failed: ' + (body.detail || 'HTTP ' + resp.status));
            return;
        }
        const data = await resp.json();
        document.getElementById('aiTaskModal')?.remove();
        showToast('Task created: ' + data.task.id);
        // Append confirmation to chat
        const container = document.getElementById('aiChatMessages');
        if (container) {
            const div = document.createElement('div');
            div.className = 'ai-task-suggestion';
            div.style.borderStyle = 'solid';
            div.style.borderColor = 'var(--accent-green)';
            div.innerHTML = 'Task <strong>' + esc(data.task.id) + '</strong> created (' +
                esc(isAgent ? 'agent-delegated' : 'human-assigned') + ', ' + esc(priority) + ' priority)';
            container.appendChild(div);
            container.scrollTop = container.scrollHeight;
        }
    } catch (e) {
        alert('Error: ' + e.message);
    }
}

// Simple markdown renderer for AI responses
function _renderMarkdown(text) {
    if (!text) return '';
    let html = esc(text);
    // Code blocks (```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function(m, lang, code) {
        return '<pre><code>' + code + '</code></pre>';
    });
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic
    html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
    // Headers
    html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    // Unordered lists
    html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
    // Ordered lists
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
    // Line breaks
    html = html.replace(/\n\n/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');
    html = '<p>' + html + '</p>';
    // Clean up empty <p> tags
    html = html.replace(/<p><\/p>/g, '');
    return html;
}

function formatDuration(ms) {
    if (!ms) return '0s';
    if (ms < 1000) return ms + 'ms';
    const sec = ms / 1000;
    if (sec < 60) return sec.toFixed(1) + 's';
    const min = Math.floor(sec / 60);
    const remSec = Math.round(sec % 60);
    return min + 'm' + (remSec ? remSec + 's' : '');
}

function formatSize(chars) {
    if (!chars) return '0';
    if (chars < 1000) return chars + '';
    if (chars < 1000000) return (chars / 1000).toFixed(1) + 'K';
    return (chars / 1000000).toFixed(2) + 'M';
}

// ─────────────────────────────────────────────────────────
// Evolve Modal — Self-Assessment & Evolution Loop
// ─────────────────────────────────────────────────────────

let _evolveSettings = null;
let _evolveReports = null;
let _evolvePollTimer = null;

async function showEvolveModal() {
    openModal('evolveModal');
    await _loadEvolveData();
}

async function _loadEvolveData() {
    try {
        const [sResp, rResp] = await Promise.all([
            fetch('api/evolve/settings'),
            fetch('api/evolve/reports'),
        ]);
        _evolveSettings = await sResp.json();
        _evolveReports  = await rResp.json();
        _renderEvolveModal();
    } catch (e) {
        console.error('Evolve load error:', e);
    }
}

function _renderEvolveModal() {
    if (!_evolveSettings) return;
    const s = _evolveSettings;
    const r = _evolveReports || {};

    // Enable toggle
    document.getElementById('evolveEnabledToggle').checked = s.enabled !== false;
    const tag = document.getElementById('evolveLoopTag');
    tag.textContent = s.enabled !== false ? 'Scheduled' : 'Paused';
    tag.className = 'evolve-tag' + (s.enabled !== false ? '' : ' disabled');

    // Self-assessment fields
    const sa = s.self_assessment || {};
    document.getElementById('saFreqType').value  = sa.frequency_type  || 'daily';
    document.getElementById('saFreqValue').value = sa.frequency_value || 1;
    document.getElementById('saTimeHour').value  = sa.time_hour  != null ? sa.time_hour  : 2;
    document.getElementById('saTimeMin').value   = sa.time_minute != null ? sa.time_minute : 0;
    toggleEvolveTimePicker('sa');
    _updateCronPreview('sa');

    // Evolution fields
    const ev = s.evolution || {};
    document.getElementById('evoFreqType').value  = ev.frequency_type  || 'daily';
    document.getElementById('evoFreqValue').value = ev.frequency_value || 1;
    document.getElementById('evoTimeHour').value  = ev.time_hour  != null ? ev.time_hour  : 3;
    document.getElementById('evoTimeMin').value   = ev.time_minute != null ? ev.time_minute : 0;
    toggleEvolveTimePicker('evo');
    _updateCronPreview('evo');

    // Dry-run status dots
    const drs = s.dry_run_status || {};
    _setEvolveDot('saStatusDot',  'saDryStatus',  'saDryBtn',  drs.self_assessment || 'idle');
    _setEvolveDot('evoStatusDot', 'evoDryStatus', 'evoDryBtn', drs.evolution        || 'idle');

    // Report cards
    _renderEvolveReportCard('saReportWrap',  r.self_assessment, 'self_assessment.md',  '📄');
    _renderEvolveReportCard('evoReportWrap', r.evolve_plan,     'evolve_safe_plan.md', '📋');

    // Plan steps
    if (r.evolve_plan && r.evolve_plan.exists && r.evolve_plan.steps && r.evolve_plan.steps.length > 0) {
        _renderEvolvePlanSteps(r.evolve_plan.steps);
    }
}

function toggleEvolveTimePicker(prefix) {
    const type = document.getElementById(prefix + 'FreqType').value;
    const timeGroup = document.getElementById(prefix + 'TimeGroup');
    const showTime = type === 'daily' || type === 'weekly';
    timeGroup.style.display = showTime ? 'block' : 'none';
    _updateCronPreview(prefix);
}

function _updateCronPreview(prefix) {
    const type   = document.getElementById(prefix + 'FreqType')  ? document.getElementById(prefix + 'FreqType').value  : 'daily';
    const value  = parseInt(document.getElementById(prefix + 'FreqValue') ? document.getElementById(prefix + 'FreqValue').value : '1') || 1;
    const hour   = parseInt(document.getElementById(prefix + 'TimeHour')  ? document.getElementById(prefix + 'TimeHour').value  : '2');
    const minute = parseInt(document.getElementById(prefix + 'TimeMin')   ? document.getElementById(prefix + 'TimeMin').value   : '0');

    let cron;
    if (type === 'minutes')     cron = '*/' + value + ' * * * *';
    else if (type === 'hours')  cron = '0 */' + value + ' * * *';
    else if (type === 'weekly') cron = minute + ' ' + hour + ' * * 1';
    else                        cron = minute + ' ' + hour + ' * * *';

    const el = document.getElementById(prefix + 'CronPreview');
    if (el) el.textContent = 'cron: ' + cron;
}

function _setEvolveDot(dotId, statusId, btnId, status) {
    const dot = document.getElementById(dotId);
    const label = document.getElementById(statusId);
    const btn = document.getElementById(btnId);
    if (!dot) return;

    dot.className = 'evolve-status-dot ' + status;
    dot.title = status;

    const map = { idle: '', running: 'Running\u2026', done: 'Done \u2713', failed: 'Failed \u2717' };
    const cls = { idle: '', running: 'running', done: 'done', failed: 'failed' };
    if (label) { label.textContent = map[status] || ''; label.className = 'evolve-dry-status ' + (cls[status] || ''); }
    if (btn)   btn.disabled = status === 'running';
}

function _renderEvolveReportCard(wrapId, info, filename, icon) {
    const wrap = document.getElementById(wrapId);
    if (!wrap) return;
    if (!info || !info.exists) {
        wrap.innerHTML = '<div class="evolve-report-empty">No report yet \u2014 run a dry run to generate</div>';
        return;
    }
    const modified = info.modified ? new Date(info.modified).toLocaleString() : '';
    const size = info.size ? (info.size > 1024 ? (info.size / 1024).toFixed(1) + ' KB' : info.size + ' B') : '';
    const meta = [modified, size].filter(Boolean).join(' \u00b7 ');
    wrap.innerHTML =
        '<div class="evolve-report-card" onclick="viewAttachment(\'' + escAttr(info.path) + '\')">' +
            '<span class="evolve-report-icon">' + icon + '</span>' +
            '<div class="evolve-report-info">' +
                '<div class="evolve-report-name">' + esc(filename) + '</div>' +
                '<div class="evolve-report-meta">' + esc(meta) + '</div>' +
            '</div>' +
            '<span class="evolve-report-open">View \u2192</span>' +
        '</div>';
}

function _renderEvolvePlanSteps(steps) {
    const section = document.getElementById('evolvePlanSection');
    const list = document.getElementById('evolveStepsList');
    const meta = document.getElementById('evolveStepsMeta');
    if (!section || !list) return;

    meta.textContent = steps.length + ' step' + (steps.length !== 1 ? 's' : '');
    section.style.display = 'block';

    list.innerHTML = steps.map(function(step, i) {
        const actionClass = (step.action || '').replace(/[^a-z_]/g, '').toLowerCase();
        const title = esc(step.title || ('Step ' + (i + 1)));
        const reason = esc(step.reason || step.file || '');
        const actionLabel = esc(step.action || 'fix');
        const file = esc(step.file || '');
        const raw = esc(step.raw || '');
        const before = esc(step.before || '');
        const after = esc(step.after || '');
        const detailRows = [
            file   ? '<div class="evolve-step-detail-row"><span class="evolve-step-detail-label">File</span><code>' + file + '</code></div>' : '',
            reason ? '<div class="evolve-step-detail-row"><span class="evolve-step-detail-label">Reason</span><span>' + reason + '</span></div>' : '',
            before ? '<div class="evolve-step-detail-row"><span class="evolve-step-detail-label">Before</span><pre>' + before + '</pre></div>' : '',
            after  ? '<div class="evolve-step-detail-row"><span class="evolve-step-detail-label">After</span><pre>' + after + '</pre></div>' : '',
            raw && !before && !after ? '<div class="evolve-step-detail-row"><span class="evolve-step-detail-label">Details</span><pre>' + raw + '</pre></div>' : '',
        ].filter(Boolean).join('');

        return '<div class="evolve-step-card" id="evolve-step-' + i + '" onclick="toggleEvolveStep(this)">' +
            '<span class="evolve-step-action ' + actionClass + '">' + actionLabel + '</span>' +
            '<div class="evolve-step-body">' +
                '<div class="evolve-step-title" title="' + title + '">' + title + '</div>' +
                (reason ? '<div class="evolve-step-reason">' + reason + '</div>' : '') +
                (detailRows ? '<div class="evolve-step-details">' + detailRows + '</div>' : '') +
            '</div>' +
            '<button class="btn btn-outline evolve-step-btn" onclick="event.stopPropagation(); createEvolveStep(' + i + ')">+ Task</button>' +
        '</div>';
    }).join('');
}

function toggleEvolveStep(card) {
    card.classList.toggle('expanded');
}

async function triggerEvolveDryRun(type) {
    const dotId    = type === 'self_assessment' ? 'saStatusDot'  : 'evoStatusDot';
    const statusId = type === 'self_assessment' ? 'saDryStatus'  : 'evoDryStatus';
    const btnId    = type === 'self_assessment' ? 'saDryBtn'     : 'evoDryBtn';

    _setEvolveDot(dotId, statusId, btnId, 'running');

    try {
        const resp = await authFetch('api/evolve/run-dry', {
            method: 'POST',
            body: JSON.stringify({ type: type }),
        });
        if (!resp.ok) {
            const body = await resp.json().catch(function() { return {}; });
            _setEvolveDot(dotId, statusId, btnId, 'failed');
            showToast('Dry run failed: ' + (body.detail || body.error || 'unknown error'));
            return;
        }
    } catch (e) {
        _setEvolveDot(dotId, statusId, btnId, 'failed');
        showToast('Dry run error: ' + e.message);
        return;
    }

    // Poll every 8 seconds until status changes from running
    clearInterval(_evolvePollTimer);
    _evolvePollTimer = setInterval(async function() {
        try {
            const resp = await fetch('api/evolve/settings');
            const data = await resp.json();
            const status = (data.dry_run_status || {})[type] || 'idle';
            if (status !== 'running') {
                clearInterval(_evolvePollTimer);
                _setEvolveDot(dotId, statusId, btnId, status);
                if (status === 'done') {
                    showToast(type === 'self_assessment' ? 'Self-assessment complete' : 'Evolution plan generated');
                    const rResp = await fetch('api/evolve/reports');
                    _evolveReports = await rResp.json();
                    _renderEvolveReportCard(
                        type === 'self_assessment' ? 'saReportWrap' : 'evoReportWrap',
                        type === 'self_assessment' ? _evolveReports.self_assessment : _evolveReports.evolve_plan,
                        type === 'self_assessment' ? 'self_assessment.md' : 'evolve_safe_plan.md',
                        type === 'self_assessment' ? '\uD83D\uDCC4' : '\uD83D\uDCCB'
                    );
                    if (type === 'evolution' && _evolveReports.evolve_plan && _evolveReports.evolve_plan.steps && _evolveReports.evolve_plan.steps.length) {
                        _renderEvolvePlanSteps(_evolveReports.evolve_plan.steps);
                    }
                }
            }
        } catch (_) {}
    }, 8000);
}

async function saveEvolveSettings() {
    const payload = {
        enabled: document.getElementById('evolveEnabledToggle').checked,
        self_assessment: {
            frequency_type:  document.getElementById('saFreqType').value,
            frequency_value: parseInt(document.getElementById('saFreqValue').value) || 1,
            time_hour:       parseInt(document.getElementById('saTimeHour').value) || 0,
            time_minute:     parseInt(document.getElementById('saTimeMin').value)  || 0,
        },
        evolution: {
            frequency_type:  document.getElementById('evoFreqType').value,
            frequency_value: parseInt(document.getElementById('evoFreqValue').value) || 1,
            time_hour:       parseInt(document.getElementById('evoTimeHour').value) || 0,
            time_minute:     parseInt(document.getElementById('evoTimeMin').value)  || 0,
        },
    };

    try {
        const resp = await authFetch('api/evolve/settings', {
            method: 'POST',
            body: JSON.stringify(payload),
        });
        if (!resp.ok) {
            const body = await resp.json().catch(function() { return {}; });
            showToast('Save failed: ' + (body.detail || body.error || 'HTTP ' + resp.status));
            return;
        }
        _evolveSettings = Object.assign({}, _evolveSettings, payload);
        showToast('Evolve schedule saved');
        const tag = document.getElementById('evolveLoopTag');
        if (tag) {
            tag.textContent = payload.enabled ? 'Scheduled' : 'Paused';
            tag.className = 'evolve-tag' + (payload.enabled ? '' : ' disabled');
        }
    } catch (e) {
        showToast('Error: ' + e.message);
    }
}

async function createEvolveStep(stepIndex) {
    if (!_evolveReports || !_evolveReports.evolve_plan || !_evolveReports.evolve_plan.steps) return;
    const step = _evolveReports.evolve_plan.steps[stepIndex];
    if (!step) return;

    const card = document.getElementById('evolve-step-' + stepIndex);
    const btn = card ? card.querySelector('.evolve-step-btn') : null;
    if (btn) btn.textContent = 'Creating\u2026';

    try {
        const resp = await authFetch('api/evolve/create-tasks', {
            method: 'POST',
            body: JSON.stringify({ steps: [step] }),
        });
        const data = await resp.json().catch(function() { return {}; });
        if (!resp.ok) {
            if (btn) btn.textContent = '+ Task';
            showToast('Create failed (' + resp.status + '): ' + (data.detail || data.error || 'unknown'));
            return;
        }
        if (data.success && data.count > 0) {
            if (card) card.classList.add('task-created');
            if (btn) { btn.textContent = '\u2713 Created'; btn.className = 'btn evolve-step-btn created'; }
            showToast('Task created: ' + (step.title || 'step ' + stepIndex));
            loadTasks();
        } else {
            if (btn) btn.textContent = '+ Task';
            showToast('No task created — ' + (data.error || JSON.stringify(data)));
        }
    } catch (e) {
        if (btn) btn.textContent = '+ Task';
        showToast('Error: ' + e.message);
    }
}

async function createAllEvolveSteps() {
    if (!_evolveReports || !_evolveReports.evolve_plan || !_evolveReports.evolve_plan.steps || !_evolveReports.evolve_plan.steps.length) return;
    const steps = _evolveReports.evolve_plan.steps;

    try {
        const resp = await authFetch('api/evolve/create-tasks', {
            method: 'POST',
            body: JSON.stringify({ steps: steps }),
        });
        const data = await resp.json().catch(function() { return {}; });
        if (!resp.ok) {
            showToast('Create failed (' + resp.status + '): ' + (data.detail || data.error || 'unknown'));
            return;
        }
        if (data.success) {
            steps.forEach(function(_, i) {
                const card = document.getElementById('evolve-step-' + i);
                const btn = card ? card.querySelector('.evolve-step-btn') : null;
                if (card) card.classList.add('task-created');
                if (btn) { btn.textContent = '\u2713 Created'; btn.className = 'btn evolve-step-btn created'; }
            });
            showToast(data.count + ' task' + (data.count !== 1 ? 's' : '') + ' created');
            loadTasks();
        } else {
            showToast('No tasks created — ' + (data.error || JSON.stringify(data)));
        }
    } catch (e) {
        showToast('Error: ' + e.message);
    }
}

document.addEventListener('DOMContentLoaded', function() {
    ['saFreqType','saFreqValue','saTimeHour','saTimeMin'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('input', function() { _updateCronPreview('sa'); });
    });
    ['evoFreqType','evoFreqValue','evoTimeHour','evoTimeMin'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('input', function() { _updateCronPreview('evo'); });
    });
});

// ── End Evolve ───────────────────────────────────────────

function showToast(msg) {
    // Simple toast notification
    let toast = document.getElementById('opai-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'opai-toast';
        toast.style.cssText = 'position:fixed;bottom:20px;right:20px;padding:10px 20px;background:var(--bg-tertiary);border:1px solid var(--accent-green);border-radius:var(--radius);color:var(--accent-green);font-family:var(--font-mono);font-size:12px;z-index:9999;opacity:0;transition:opacity 0.3s;';
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 3000);
}


// ── Heartbeats Control Panel ─────────────────────────────────

let _heartbeatsData = {};

const HEARTBEAT_LABELS = {
    'forumbot':  'Forum Bot',
    'brain':     '2nd Brain',
    'bot-space': 'Bot Space',
    'bx4':       'Bx4',
    'helm':      'HELM',
    'marq':      'Marq',
    'wordpress': 'WordPress',
    'docs':      'Docs',
    'dam':       'DAM Bot',
};

async function showHeartbeatsModal() {
    const modal = document.getElementById('heartbeatsModal');
    if (!modal) return;
    modal.classList.add('visible');
    document.getElementById('heartbeatsLoading').style.display = 'block';
    document.getElementById('heartbeatsList').innerHTML = '';

    try {
        const token = await getToken();
        const resp = await fetch('api/heartbeats', {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        _heartbeatsData = await resp.json();
        renderHeartbeats();
    } catch (e) {
        document.getElementById('heartbeatsLoading').textContent = 'Failed to load heartbeats';
    }
}

function renderHeartbeats() {
    document.getElementById('heartbeatsLoading').style.display = 'none';
    const list = document.getElementById('heartbeatsList');
    if (!list) return;

    const tools = Object.keys(HEARTBEAT_LABELS);
    let html = '<table class="heartbeats-table"><thead><tr><th>Tool</th><th>Status</th><th>Interval (s)</th><th>Paused</th></tr></thead><tbody>';

    for (const tool of tools) {
        const data = _heartbeatsData[tool] || {};
        const label = HEARTBEAT_LABELS[tool] || tool;
        const isOk = data.status === 'ok';
        const isUnreachable = data.status === 'unreachable';
        const tick = isOk ? (data.tick_seconds || 60) : '';
        const paused = isOk ? !!data.paused : false;

        let statusBadge;
        if (isUnreachable) {
            statusBadge = '<span class="hb-badge hb-badge-off">Offline</span>';
        } else if (!isOk) {
            statusBadge = '<span class="hb-badge hb-badge-err">Error</span>';
        } else if (paused) {
            statusBadge = '<span class="hb-badge hb-badge-pause">Paused</span>';
        } else {
            statusBadge = '<span class="hb-badge hb-badge-run">Running</span>';
        }

        html += '<tr data-tool="' + esc(tool) + '">' +
            '<td class="hb-tool-name">' + esc(label) + '</td>' +
            '<td>' + statusBadge + '</td>' +
            '<td>' + (isOk ? '<input type="number" class="hb-tick-input" value="' + tick + '" min="10" max="3600" data-tool="' + esc(tool) + '">' : '<span class="muted">-</span>') + '</td>' +
            '<td>' + (isOk ? '<label class="toggle toggle-sm"><input type="checkbox" class="hb-pause-toggle" data-tool="' + esc(tool) + '"' + (paused ? ' checked' : '') + '><span class="toggle-slider"></span></label>' : '<span class="muted">-</span>') + '</td>' +
            '</tr>';
    }
    html += '</tbody></table>';
    list.innerHTML = html;
}

async function saveHeartbeats() {
    const btn = document.getElementById('heartbeatsSaveBtn');
    if (btn) btn.disabled = true;

    const payload = {};
    const inputs = document.querySelectorAll('.hb-tick-input');
    const toggles = document.querySelectorAll('.hb-pause-toggle');

    const tickMap = {};
    inputs.forEach(inp => { tickMap[inp.dataset.tool] = parseInt(inp.value, 10) || 60; });

    const pauseMap = {};
    toggles.forEach(tog => { pauseMap[tog.dataset.tool] = tog.checked; });

    // Build payload — only include tools that had OK status
    for (const tool of Object.keys(HEARTBEAT_LABELS)) {
        const data = _heartbeatsData[tool] || {};
        if (data.status !== 'ok') continue;

        const newTick = tickMap[tool];
        const newPaused = pauseMap[tool];
        const changed = newTick !== data.tick_seconds || newPaused !== !!data.paused;
        if (changed) {
            payload[tool] = { tick_seconds: newTick, paused: newPaused };
        }
    }

    if (Object.keys(payload).length === 0) {
        showToast('No changes to save');
        if (btn) btn.disabled = false;
        return;
    }

    try {
        const token = await getToken();
        const resp = await fetch('api/heartbeats', {
            method: 'PUT',
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const result = await resp.json();

        // Update local data with new values
        for (const [tool, res] of Object.entries(result)) {
            if (res.status === 'ok') {
                _heartbeatsData[tool] = res;
            }
        }
        renderHeartbeats();

        const saved = Object.values(result).filter(r => r.status === 'ok').length;
        const failed = Object.values(result).filter(r => r.status !== 'ok').length;
        showToast(saved + ' heartbeat(s) updated' + (failed ? ', ' + failed + ' failed' : ''));
    } catch (e) {
        showToast('Failed to save heartbeats');
    }

    if (btn) btn.disabled = false;
}

function closeHeartbeatsModal() {
    const modal = document.getElementById('heartbeatsModal');
    if (modal) modal.classList.remove('visible');
}
