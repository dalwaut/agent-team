/**
 * OPAI Engine Dashboard — app.js
 *
 * Vanilla JS, no frameworks. Uses Engine API + WebSocket for live data.
 * Auth via opaiAuth (auth-v3.js) when available.
 */

// Build API base from current path so fetch works through Caddy prefix stripping
// e.g., at /engine/ → API = '/engine', at /tasks/ → API = '/tasks'
const API = location.pathname.replace(/\/+$/, '');

// Initialize auth (non-blocking — only needed for OC broker calls, not Engine's own API)
if (typeof opaiAuth !== 'undefined') {
  opaiAuth.init({ allowAnonymous: true }).catch(e => console.warn('Auth init:', e));
}

// ── Auth-aware fetch ──────────────────────────────────────

async function fetchAPI(endpoint, opts = {}) {
  opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (typeof opaiAuth !== 'undefined' && opaiAuth.fetchWithAuth) {
    return opaiAuth.fetchWithAuth(API + endpoint, opts);
  }
  return fetch(API + endpoint, opts);
}

async function fetchJSON(endpoint, opts = {}) {
  const r = await fetchAPI(endpoint, opts);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

// OC Broker lives on a separate service (/oc/api/...) — not through Engine's API prefix
async function ocFetch(endpoint, opts = {}) {
  opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const url = '/oc/api' + endpoint;
  if (typeof opaiAuth !== 'undefined' && opaiAuth.fetchWithAuth) {
    return opaiAuth.fetchWithAuth(url, opts);
  }
  return fetch(url, opts);
}

async function ocFetchJSON(endpoint, opts = {}) {
  const r = await ocFetch(endpoint, opts);
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    let msg = `${r.status} ${r.statusText}`;
    try { const j = JSON.parse(body); msg = j.detail || j.error || msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

// ── Tab Navigation ────────────────────────────────────────

function initTabs() {
  // Main tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      onTabActivated(btn.dataset.tab);
    });
  });

  // Subtabs
  document.querySelectorAll('.subtab-nav').forEach(nav => {
    nav.querySelectorAll('.subtab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        nav.querySelectorAll('.subtab-btn').forEach(b => b.classList.remove('active'));
        const parent = nav.parentElement;
        parent.querySelectorAll('.subtab-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('subtab-' + btn.dataset.subtab).classList.add('active');
        onSubtabActivated(btn.dataset.subtab);
      });
    });
  });
}

const _loaded = {};
function onTabActivated(tab) {
  if (tab === 'tasks' && !_loaded.tasks) { loadTasks(); loadFeedback(); _loaded.tasks = true; }
  if (tab === 'workers' && !_loaded.workers) { loadWorkers(); _loaded.workers = true; }
  if (tab === 'openclaw' && !_loaded.openclaw) { loadOCInstances(); _loaded.openclaw = true; }
  if (tab === 'system' && !_loaded.system) { loadHealth(); loadServices(); _loaded.system = true; }
}

function onSubtabActivated(subtab) {
  if (subtab === 'task-audit' && !_loaded.audit) { loadAudit(); _loaded.audit = true; }
  if (subtab === 'worker-guardrails' && !_loaded.guardrails) { loadGuardrails(); _loaded.guardrails = true; }
  if (subtab === 'worker-approvals') { loadApprovals(); }
  if (subtab === 'oc-audit' && !_loaded.ocAudit) { loadOCAudit(); _loaded.ocAudit = true; }
  if (subtab === 'oc-hub' && !_loaded.ocHub) { loadClawHub(); _loaded.ocHub = true; }
  if (subtab === 'sys-logs') { connectLogWS(); }
  if (subtab === 'sys-suggestions' && !_loaded.suggestions) { loadSuggestions(); _loaded.suggestions = true; }
  if (subtab === 'sys-bottlenecks') { loadBottlenecks(); loadApprovalTracker(); }
  if (subtab === 'sys-settings' && !_loaded.settings) { loadSettings(); _loaded.settings = true; }
}

// ── Command Center ────────────────────────────────────────

async function loadCommandCenter() {
  // System stats
  try {
    const stats = await fetchJSON('/api/system/stats');
    const cpu = Math.round(stats.cpu_percent || 0);
    const mem = Math.round(stats.memory?.percent || 0);
    const disk = Math.round(stats.disk?.percent || 0);

    document.getElementById('stat-cpu').textContent = cpu + '%';
    document.getElementById('stat-mem').textContent = mem + '%';
    document.getElementById('stat-disk').textContent = disk + '%';

    setBar('bar-cpu', cpu);
    setBar('bar-mem', mem);
    setBar('bar-disk', disk);
  } catch (e) { console.warn('Stats error:', e); }

  // Task summary
  try {
    const summary = await fetchJSON('/api/tasks/summary');
    document.getElementById('stat-tasks').textContent = summary.total;
    const pending = summary.by_status?.pending || 0;
    const running = summary.by_status?.running || 0;
    document.getElementById('stat-tasks-detail').textContent =
      `${pending} pending, ${running} running`;
  } catch (e) { console.warn('Tasks error:', e); }

  // Workers
  try {
    const workers = await fetchJSON('/api/workers');
    const entries = Object.entries(workers);
    const running = entries.filter(([, w]) => w.running === true).length;
    document.getElementById('stat-workers').textContent = `${running}/${entries.length}`;
    document.getElementById('stat-workers-detail').textContent =
      `${running} running, ${entries.length - running} idle/off`;
  } catch (e) { console.warn('Workers error:', e); }

  // Service health
  try {
    const health = await fetchJSON('/api/health/summary');
    renderServiceHealth(health);
  } catch (e) { console.warn('Health error:', e); }

  // Activity feed (recent audit entries)
  try {
    const audit = await fetchJSON('/api/audit?limit=15');
    renderActivityFeed(audit.records || []);
  } catch (e) { console.warn('Activity error:', e); }
}

function setBar(id, pct) {
  const el = document.getElementById(id);
  el.style.width = pct + '%';
  el.className = 'stat-fill' + (pct > 85 ? ' danger' : pct > 70 ? ' warn' : '');
}

function renderServiceHealth(data) {
  const el = document.getElementById('service-health');
  const services = data.services || {};
  el.innerHTML = Object.entries(services).map(([name, info]) => `
    <div class="service-row">
      <div class="health-dot ${info.status}"></div>
      <div class="service-name">${name}</div>
      <div class="service-uptime">${info.uptime_seconds ? formatUptime(info.uptime_seconds) : ''}</div>
    </div>
  `).join('');
}

function renderActivityFeed(records) {
  const el = document.getElementById('activity-feed');
  if (!records.length) { el.innerHTML = '<div class="empty-state">No recent activity</div>'; return; }
  el.innerHTML = records.slice(0, 15).map(r => {
    const ts = r.timestamp ? new Date(r.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
    const summary = r.summary || r.event || r.id || '';
    return `<div class="activity-item">
      <span class="activity-time">${ts}</span>
      <span class="activity-badge badge badge-${r.status || 'pending'}">${r.status || ''}</span>
      <span class="activity-msg">${escapeHtml(summary)}</span>
    </div>`;
  }).join('');
}

// ── Tasks Tab ─────────────────────────────────────────────

let _taskCache = [];

async function loadTasks() {
  try {
    const data = await fetchJSON('/api/tasks');
    const tasks = data.tasks || data;
    _taskCache = Array.isArray(tasks) ? tasks : [];
    filterAndRenderTasks();
  } catch (e) { console.warn('Tasks load error:', e); }
}

function filterAndRenderTasks() {
  const tbody = document.getElementById('task-tbody');
  const search = (document.getElementById('task-search')?.value || '').toLowerCase();
  const statusFilter = document.getElementById('task-filter-status')?.value || '';
  const priorityFilter = document.getElementById('task-filter-priority')?.value || '';

  let filtered = _taskCache;
  if (search) filtered = filtered.filter(t =>
    (t.title || '').toLowerCase().includes(search) || (t.id || '').toLowerCase().includes(search));
  if (statusFilter) filtered = filtered.filter(t => t.status === statusFilter);
  if (priorityFilter) filtered = filtered.filter(t => t.priority === priorityFilter);

  tbody.innerHTML = filtered.slice(0, 100).map(t => `
    <tr class="task-row" data-id="${t.id || ''}" onclick="showTaskDetail('${t.id}')">
      <td><code>${t.id || ''}</code></td>
      <td>${escapeHtml(t.title || '')}</td>
      <td><span class="badge badge-${t.status || 'pending'}">${t.status || 'pending'}</span></td>
      <td><span class="badge badge-${t.priority || 'normal'}">${t.priority || 'normal'}</span></td>
      <td>${t.source || ''}</td>
      <td style="font-family: var(--font-mono); font-size: 11px">${formatDate(t.createdAt)}</td>
    </tr>
  `).join('') || '<tr><td colspan="6" class="empty-state">No tasks</td></tr>';
}

// Task filters (use cached data, no re-fetch)
document.getElementById('task-search')?.addEventListener('input', filterAndRenderTasks);
document.getElementById('task-filter-status')?.addEventListener('change', filterAndRenderTasks);
document.getElementById('task-filter-priority')?.addEventListener('change', filterAndRenderTasks);

// ── Task Detail Modal ─────────────────────────────────────

window.showTaskDetail = async function(taskId) {
  const modal = document.getElementById('task-modal');
  const body = document.getElementById('task-modal-body');
  body.innerHTML = '<div class="loading">Loading...</div>';
  modal.classList.add('open');

  try {
    const t = await fetchJSON(`/api/tasks/${taskId}`);
    body.innerHTML = `
      <div class="modal-section">
        <div class="modal-row">
          <span class="modal-label">ID</span>
          <code>${t.id}</code>
        </div>
        <div class="modal-row">
          <span class="modal-label">Status</span>
          <span class="badge badge-${t.status}">${t.status}</span>
        </div>
        <div class="modal-row">
          <span class="modal-label">Priority</span>
          <span class="badge badge-${t.priority}">${t.priority}</span>
        </div>
        <div class="modal-row">
          <span class="modal-label">Source</span>
          <span>${t.source || 'N/A'}</span>
        </div>
        <div class="modal-row">
          <span class="modal-label">Assignee</span>
          <span>${t.assignee || 'N/A'}</span>
        </div>
        <div class="modal-row">
          <span class="modal-label">Project</span>
          <span>${t.project || 'N/A'}</span>
        </div>
        <div class="modal-row">
          <span class="modal-label">Created</span>
          <span>${formatDate(t.createdAt)}</span>
        </div>
        ${t.updatedAt ? `<div class="modal-row">
          <span class="modal-label">Updated</span>
          <span>${formatDate(t.updatedAt)}</span>
        </div>` : ''}
        ${t.completedAt ? `<div class="modal-row">
          <span class="modal-label">Completed</span>
          <span>${formatDate(t.completedAt)}</span>
        </div>` : ''}
      </div>

      <h4 class="modal-subtitle">Title</h4>
      <div class="modal-text">${escapeHtml(t.title)}</div>

      ${t.description ? `
        <h4 class="modal-subtitle">Description</h4>
        <div class="modal-text modal-desc">${escapeHtml(t.description)}</div>
      ` : ''}

      ${t.agentConfig?.response ? `
        <h4 class="modal-subtitle">Agent Response</h4>
        <div class="modal-text modal-desc">${escapeHtml(t.agentConfig.response)}</div>
      ` : ''}

      ${t.routing ? `
        <h4 class="modal-subtitle">Routing</h4>
        <div class="modal-text"><code>${JSON.stringify(t.routing, null, 2)}</code></div>
      ` : ''}

      <div class="modal-actions">
        ${t.status === 'pending' || t.status === 'running' ? `
          <button class="btn btn-sm btn-danger" onclick="taskAction('${t.id}','cancel')">Cancel</button>
        ` : ''}
        ${t.status === 'failed' || t.status === 'cancelled' ? `
          <button class="btn btn-sm btn-primary" onclick="taskAction('${t.id}','resubmit')">Resubmit</button>
        ` : ''}
        ${t.status === 'pending' ? `
          <button class="btn btn-sm btn-success" onclick="taskAction('${t.id}','run')">Run Now</button>
        ` : ''}
      </div>
    `;
  } catch (e) {
    body.innerHTML = `<div class="empty-state">Failed to load task: ${escapeHtml(e.message)}</div>`;
  }
};

window.taskAction = async function(taskId, action) {
  try {
    await fetchAPI(`/api/tasks/${taskId}/${action}`, { method: 'POST', body: '{}' });
    closeTaskModal();
    loadTasks();
  } catch (e) { alert('Failed: ' + e.message); }
};

window.closeTaskModal = function() {
  document.getElementById('task-modal').classList.remove('open');
  document.getElementById('modal-title').textContent = 'Task Detail';
};

// Close modal on backdrop click
document.getElementById('task-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'task-modal') closeTaskModal();
});

async function loadFeedback() {
  try {
    const data = await fetchJSON('/api/feedback');
    const items = data.items || data;
    const el = document.getElementById('feedback-list');
    if (!items || !items.length) {
      el.innerHTML = '<div class="empty-state">No feedback items</div>';
      return;
    }
    const arr = Array.isArray(items) ? items : [];
    const open = arr.filter(f => !f.implemented && f.status !== 'done').length;
    el.innerHTML = `<div class="fb-count">${arr.length} items (${open} open, ${arr.length - open} done)</div>` +
    arr.map(f => {
      const fid = f.feedbackId || f.id || f.feedback_id || '';
      const sevClass = f.severity === 'HIGH' ? 'high' : f.severity === 'MEDIUM' ? 'normal' : 'low';
      const isDone = f.implemented || f.status === 'done';
      return `<div class="feedback-item" data-fid="${escapeHtml(fid)}">
        <div class="fb-title">
          <span class="badge badge-${sevClass}">${f.severity || ''}</span>
          <strong>${escapeHtml(f.tool || '')}</strong>
          ${isDone ? '<span class="badge badge-completed">done</span>' : ''}
        </div>
        <div class="fb-detail">${escapeHtml(f.description || '')}</div>
        ${!isDone ? `<div class="fb-actions">
          <button class="btn btn-sm btn-primary" onclick="feedbackAction('${fid}','create-task')" title="Create a task from this feedback">Create Task</button>
          <button class="btn btn-sm btn-success" onclick="feedbackAction('${fid}','run')" title="Run agent to fix">Run</button>
          <button class="btn btn-sm" onclick="feedbackAction('${fid}','queue')" title="Queue for later">Queue</button>
          <button class="btn btn-sm" onclick="feedbackAction('${fid}','mark-done')" title="Mark as done">Done</button>
          <button class="btn btn-sm btn-danger" onclick="feedbackAction('${fid}','dismiss')" title="Dismiss">Dismiss</button>
        </div>` : ''}
      </div>`;
    }).join('');
  } catch (e) {
    document.getElementById('feedback-list').innerHTML = '<div class="empty-state">Failed to load</div>';
  }
}

window.feedbackAction = async function(feedbackId, action) {
  try {
    const btn = event?.target;
    if (btn) { btn.disabled = true; btn.textContent = '...'; }
    await fetchAPI('/api/feedback/action', {
      method: 'POST',
      body: JSON.stringify({ feedback_id: feedbackId, action }),
    });
    _loaded.tasks = false;
    loadFeedback();
  } catch (e) {
    alert('Feedback action failed: ' + e.message);
    loadFeedback();
  }
};

async function loadAudit() {
  try {
    const data = await fetchJSON('/api/audit?limit=50');
    const records = data.records || [];
    const el = document.getElementById('audit-list');
    el.innerHTML = records.map(r => {
      const aid = r.id || '';
      return `<div class="audit-item clickable" onclick="showAuditTrace('${escapeHtml(aid)}')" title="Click to view trace">
        <div class="audit-row-top">
          <span class="audit-ts">${formatDate(r.timestamp)}</span>
          <span class="audit-action badge badge-${r.status || 'pending'}">${r.event || ''}</span>
          ${r.tier ? `<span class="badge badge-normal">${r.tier}</span>` : ''}
          ${r.service ? `<span class="audit-svc">${escapeHtml(r.service)}</span>` : ''}
        </div>
        <div class="audit-summary">${escapeHtml(r.summary || '')}</div>
      </div>`;
    }).join('') || '<div class="empty-state">No audit records</div>';
  } catch (e) {
    document.getElementById('audit-list').innerHTML = '<div class="empty-state">Failed to load</div>';
  }
}

window.showAuditTrace = async function(auditId) {
  if (!auditId) return;
  const modal = document.getElementById('task-modal');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('task-modal-body');
  title.textContent = 'Audit Trace';
  body.innerHTML = '<div class="loading">Loading trace...</div>';
  modal.classList.add('open');

  try {
    const data = await fetchJSON(`/api/audit/${auditId}/trace`);
    const trace = data.trace || [];
    if (!trace.length) {
      body.innerHTML = `
        <div class="modal-section">
          <div class="modal-row"><span class="modal-label">Audit ID</span><code>${escapeHtml(auditId)}</code></div>
          <div class="modal-row"><span class="modal-label">Session</span><span>${data.session_id || 'No session found'}</span></div>
        </div>
        <div class="empty-state">No trace data available for this audit record</div>`;
      return;
    }
    body.innerHTML = `
      <div class="modal-section">
        <div class="modal-row"><span class="modal-label">Audit ID</span><code>${escapeHtml(auditId)}</code></div>
        <div class="modal-row"><span class="modal-label">Session</span><code>${escapeHtml(data.session_id || '')}</code></div>
        <div class="modal-row"><span class="modal-label">Steps</span><span>${trace.length}</span></div>
      </div>
      <h4 class="modal-subtitle">Tool Call Trace</h4>
      <div class="trace-list">
        ${trace.map((step, i) => `
          <div class="trace-step">
            <div class="trace-step-num">${i + 1}</div>
            <div class="trace-step-body">
              <div class="trace-tool">${escapeHtml(step.tool || step.name || 'unknown')}</div>
              ${step.input ? `<div class="trace-input">${escapeHtml(typeof step.input === 'string' ? step.input : JSON.stringify(step.input, null, 2))}</div>` : ''}
              ${step.output ? `<div class="trace-output">${escapeHtml(typeof step.output === 'string' ? step.output.slice(0, 500) : JSON.stringify(step.output, null, 2).slice(0, 500))}</div>` : ''}
              ${step.error ? `<div class="trace-error">${escapeHtml(step.error)}</div>` : ''}
            </div>
          </div>
        `).join('')}
      </div>`;
  } catch (e) {
    body.innerHTML = `<div class="empty-state">Failed to load trace: ${escapeHtml(e.message)}</div>`;
  }
};

// ── Workers Tab ───────────────────────────────────────────

async function loadWorkers() {
  try {
    const workers = await fetchJSON('/api/workers');
    renderWorkerCards(workers);
  } catch (e) { console.warn('Workers load error:', e); }
}

function renderWorkerCards(workers) {
  const el = document.getElementById('worker-cards');
  const entries = Object.entries(workers);
  if (!entries.length) { el.innerHTML = '<div class="empty-state">No workers registered</div>'; return; }

  el.innerHTML = entries.map(([id, w]) => {
    const stateClass = w.running ? 'running' : w.type === 'task' ? 'task' : 'stopped';
    const stateLabel = w.running ? 'Running' : w.type === 'task' ? 'On-demand' : 'Stopped';
    const stateColor = w.running ? 'var(--success)' : w.type === 'task' ? 'var(--text-muted)' : 'var(--error)';
    const showControls = w.type !== 'task';

    return `<div class="worker-card ${stateClass} clickable" onclick="showWorkerDetail('${id}')">
      <div class="worker-header">
        <span class="worker-name">${escapeHtml(w.name)}</span>
        <span class="worker-type">${w.type}</span>
      </div>
      <div class="worker-meta">
        <span style="color: ${stateColor}">${stateLabel}</span>
        ${w.port ? ` &middot; port ${w.port}` : ''}
        ${w.runtime ? ` &middot; ${w.runtime}` : ''}
        ${w.trigger ? ` &middot; ${w.trigger}` : ''}
      </div>
      <div class="worker-actions" onclick="event.stopPropagation()">
        ${showControls
          ? (w.running
            ? `<button class="btn btn-sm" onclick="workerAction('${id}','stop')">Stop</button>
               <button class="btn btn-sm" onclick="workerAction('${id}','restart')">Restart</button>`
            : `<button class="btn btn-sm btn-success" onclick="workerAction('${id}','start')">Start</button>`)
          : `<button class="btn btn-sm btn-primary" onclick="runTaskWorker('${id}')">Run</button>`}
      </div>
    </div>`;
  }).join('');
}

window.showWorkerDetail = async function(workerId) {
  const modal = document.getElementById('task-modal');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('task-modal-body');
  title.textContent = 'Worker Detail';
  body.innerHTML = '<div class="loading">Loading worker info...</div>';
  modal.classList.add('open');

  try {
    const [detail, logsData] = await Promise.all([
      fetchJSON(`/api/workers/${workerId}`),
      fetchJSON(`/api/workers/${workerId}/logs?lines=100`).catch(() => ({ lines: [] })),
    ]);

    const logs = logsData.lines || [];
    const d = detail;

    body.innerHTML = `
      <div class="modal-section">
        <div class="modal-row"><span class="modal-label">ID</span><code>${escapeHtml(workerId)}</code></div>
        <div class="modal-row"><span class="modal-label">Name</span><span>${escapeHtml(d.name || '')}</span></div>
        <div class="modal-row"><span class="modal-label">Type</span><span class="badge badge-normal">${escapeHtml(d.type || '')}</span></div>
        <div class="modal-row"><span class="modal-label">Status</span><span class="badge badge-${d.running ? 'completed' : 'failed'}">${d.running ? 'Running' : 'Stopped'}</span></div>
        ${d.port ? `<div class="modal-row"><span class="modal-label">Port</span><span>${d.port}</span></div>` : ''}
        ${d.runtime ? `<div class="modal-row"><span class="modal-label">Runtime</span><span>${escapeHtml(d.runtime)}</span></div>` : ''}
        ${d.pid ? `<div class="modal-row"><span class="modal-label">PID</span><code>${d.pid}</code></div>` : ''}
        ${d.trigger ? `<div class="modal-row"><span class="modal-label">Trigger</span><span>${escapeHtml(d.trigger)}</span></div>` : ''}
        ${d.schedule ? `<div class="modal-row"><span class="modal-label">Schedule</span><span>${escapeHtml(d.schedule)}</span></div>` : ''}
        ${d.uptime_seconds ? `<div class="modal-row"><span class="modal-label">Uptime</span><span>${formatUptime(d.uptime_seconds)}</span></div>` : ''}
        ${d.memory_mb ? `<div class="modal-row"><span class="modal-label">Memory</span><span>${d.memory_mb} MB</span></div>` : ''}
      </div>

      ${d.description ? `<h4 class="modal-subtitle">Description</h4><div class="modal-text">${escapeHtml(d.description)}</div>` : ''}

      ${d.config ? `<h4 class="modal-subtitle">Configuration</h4><div class="modal-desc">${escapeHtml(JSON.stringify(d.config, null, 2))}</div>` : ''}

      <h4 class="modal-subtitle">Recent Logs (${logs.length})</h4>
      <div class="modal-desc worker-logs">${logs.length ? logs.map(l => escapeHtml(l)).join('\n') : 'No logs available'}</div>
    `;
  } catch (e) {
    body.innerHTML = `<div class="empty-state">Failed to load worker: ${escapeHtml(e.message)}</div>`;
  }
};

window.workerAction = async function(id, action) {
  try {
    await fetchAPI(`/api/workers/${id}/${action}`, { method: 'POST' });
    setTimeout(loadWorkers, 1000);
  } catch (e) { alert('Failed: ' + e.message); }
};

window.runTaskWorker = async function(id) {
  try {
    await fetchAPI(`/api/workers/${id}/run`, { method: 'POST', body: '{}' });
    alert('Task worker started: ' + id);
  } catch (e) { alert('Failed: ' + e.message); }
};

async function loadGuardrails() {
  try {
    const data = await fetchJSON('/api/workers/guardrails');
    const el = document.getElementById('guardrails-content');
    el.innerHTML = `
      <div class="guardrails-section">
        <h4>Read-Only Workers (${data.read_only_workers.length})</h4>
        ${data.read_only_workers.map(w => `<span class="guardrail-tag">${w}</span>`).join('')}
      </div>
      <div class="guardrails-section">
        <h4>Approval-Gated Actions</h4>
        ${Object.entries(data.approval_gated_actions).map(([w, actions]) =>
          `<div style="margin-bottom: 6px"><strong>${w}:</strong> ${actions.map(a => `<span class="guardrail-tag">${a}</span>`).join('')}</div>`
        ).join('')}
      </div>
      <div class="guardrails-section">
        <h4>Rate-Limited Workers</h4>
        ${Object.entries(data.rate_limited_workers).map(([w, limit]) =>
          `<span class="guardrail-tag">${w}: ${limit}/hr</span>`
        ).join('')}
      </div>
      <div class="guardrails-section">
        <h4>Prompt-Protected</h4>
        ${data.prompt_protected.map(w => `<span class="guardrail-tag">${w}</span>`).join('')}
      </div>
    `;
  } catch (e) {
    document.getElementById('guardrails-content').innerHTML = '<div class="empty-state">Failed to load</div>';
  }
}

async function loadApprovals() {
  try {
    const data = await fetchJSON('/api/workers/approvals');
    const el = document.getElementById('approvals-content');
    if (!data.length) {
      el.innerHTML = '<div class="empty-state">No pending approvals</div>';
      return;
    }
    el.innerHTML = data.map(a => `
      <div class="feedback-item">
        <div class="fb-title">${escapeHtml(a.worker_name)}: ${escapeHtml(a.action)}</div>
        <div class="fb-detail">${escapeHtml(JSON.stringify(a.params))}</div>
        <div style="margin-top:8px">
          <button class="btn btn-sm btn-success" onclick="approveRequest('${a.request_id}')">Approve</button>
          <button class="btn btn-sm btn-danger" onclick="denyRequest('${a.request_id}')">Deny</button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    document.getElementById('approvals-content').innerHTML = '<div class="empty-state">Failed to load</div>';
  }
}

window.approveRequest = async function(id) {
  await fetchAPI(`/api/workers/approvals/${id}/approve`, { method: 'POST' });
  loadApprovals();
};
window.denyRequest = async function(id) {
  await fetchAPI(`/api/workers/approvals/${id}/deny`, { method: 'POST', body: '{"reason":""}' });
  loadApprovals();
};

// ── System Tab ────────────────────────────────────────────

async function loadHealth() {
  try {
    const data = await fetchJSON('/api/health/summary');
    const el = document.getElementById('health-grid');
    el.innerHTML = Object.entries(data.services || {}).map(([name, info]) => `
      <div class="health-card">
        <div class="health-dot ${info.status}"></div>
        <div class="health-info">
          <div class="health-name">${name}</div>
          <div class="health-detail">
            ${info.uptime_seconds ? formatUptime(info.uptime_seconds) : info.status}
            ${info.memory_mb ? ` &middot; ${info.memory_mb}MB` : ''}
          </div>
        </div>
      </div>
    `).join('');
  } catch (e) {
    document.getElementById('health-grid').innerHTML = '<div class="empty-state">Failed to load</div>';
  }
}

async function loadServices() {
  try {
    const data = await fetchJSON('/api/system/services');
    const el = document.getElementById('services-list');
    const services = Array.isArray(data) ? data : Object.entries(data).map(([name, info]) => ({ name, ...info }));
    el.innerHTML = services.map(s => `
      <div class="service-card">
        <div class="health-dot ${s.active || s.status === 'active' ? 'healthy' : 'unreachable'}"></div>
        <div class="svc-info">
          <div class="svc-name">${s.name || s.unit || ''}</div>
          <div class="svc-state">${s.state || s.status || 'unknown'}</div>
        </div>
      </div>
    `).join('');
  } catch (e) {
    document.getElementById('services-list').innerHTML = '<div class="empty-state">Failed to load</div>';
  }
}

async function loadSuggestions() {
  try {
    const data = await fetchJSON('/api/updater/suggestions');
    const el = document.getElementById('suggestions-list');
    const items = data.suggestions || data;
    if (!items || !items.length) {
      el.innerHTML = '<div class="empty-state">No suggestions</div>';
      return;
    }
    el.innerHTML = (Array.isArray(items) ? items : []).map(s => {
      const sid = s.id || '';
      const kind = s.kind || s.type || '';
      const actions = s.suggested_actions || [];
      return `<div class="feedback-item suggestion-item" data-sid="${escapeHtml(sid)}">
        <div class="fb-title">
          ${kind ? `<span class="badge badge-normal">${escapeHtml(kind)}</span>` : ''}
          ${escapeHtml(s.title || '')}
        </div>
        <div class="fb-detail">${escapeHtml(s.detail || s.description || '')}</div>
        ${actions.length ? `<div class="suggestion-actions-list">
          ${actions.map(a => `<div class="suggestion-action-item">&bull; ${escapeHtml(a)}</div>`).join('')}
        </div>` : ''}
        <div class="fb-actions">
          <button class="btn btn-sm btn-primary" onclick="createTaskFromSuggestion('${escapeHtml(sid)}')" title="Create a task from this suggestion">Create Task</button>
          <button class="btn btn-sm btn-danger" onclick="archiveSuggestion('${escapeHtml(sid)}')" title="Archive / dismiss">Archive</button>
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    document.getElementById('suggestions-list').innerHTML = '<div class="empty-state">Failed to load</div>';
  }
}

window.archiveSuggestion = async function(suggestionId) {
  if (!confirm('Archive this suggestion?')) return;
  try {
    await fetchAPI(`/api/updater/suggestions/${suggestionId}/archive`, { method: 'POST' });
    _loaded.suggestions = false;
    loadSuggestions();
  } catch (e) { alert('Failed to archive: ' + e.message); }
};

window.createTaskFromSuggestion = async function(suggestionId) {
  try {
    const btn = event?.target;
    if (btn) { btn.disabled = true; btn.textContent = 'Creating...'; }
    const result = await fetchJSON(`/api/updater/suggestions/${suggestionId}/task`, {
      method: 'POST',
      body: '{}',
    });
    alert('Task created: ' + (result.task_id || 'OK'));
    _loaded.suggestions = false;
    loadSuggestions();
  } catch (e) {
    alert('Failed to create task: ' + e.message);
    loadSuggestions();
  }
};

// ── Settings Tab ──────────────────────────────────────────

async function loadSettings() {
  try {
    const [settings, executor] = await Promise.all([
      fetchJSON('/api/settings'),
      fetchJSON('/api/executor/status'),
    ]);
    const el = document.getElementById('settings-content');
    el.innerHTML = `
      <div class="settings-grid">
        <div class="settings-section">
          <h4 class="settings-title">Execution</h4>
          ${settingToggle('auto_execute', 'Auto-Execute Tasks', settings.auto_execute)}
          ${settingToggle('queue_enabled', 'Queue Enabled', settings.queue_enabled)}
          ${settingNumber('max_parallel_jobs', 'Max Parallel Jobs', settings.max_parallel_jobs)}
          ${settingNumber('max_squad_runs_per_cycle', 'Max Squad Runs / Cycle', settings.max_squad_runs_per_cycle)}
          ${settingNumber('cooldown_minutes', 'Cooldown (min)', settings.cooldown_minutes)}
        </div>
        <div class="settings-section">
          <h4 class="settings-title">Feedback Loop</h4>
          ${settingSelect('feedback_autofix_threshold', 'Auto-fix Threshold', settings.feedback_autofix_threshold, ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])}
          ${settingNumber('feedback_poll_interval', 'Poll Interval (sec)', settings.feedback_poll_interval)}
          ${settingSelect('feedback_fixer_model', 'Fixer Model', settings.feedback_fixer_model, ['haiku', 'sonnet', 'opus'])}
          ${settingNumber('feedback_fixer_max_turns', 'Fixer Max Turns', settings.feedback_fixer_max_turns)}
        </div>
        <div class="settings-section">
          <h4 class="settings-title">Executor Status</h4>
          <div class="setting-row">
            <span class="setting-label">Status</span>
            <span class="badge badge-${executor.enabled ? 'completed' : 'failed'}">${executor.enabled ? 'enabled' : 'disabled'}</span>
          </div>
          <div class="setting-row">
            <span class="setting-label">Running Jobs</span>
            <span class="setting-value">${executor.running_count}</span>
          </div>
          <div class="setting-row">
            <span class="setting-label">Max Parallel</span>
            <span class="setting-value">${executor.max_parallel}</span>
          </div>
          ${executor.last_cycle ? `<div class="setting-row">
            <span class="setting-label">Last Cycle</span>
            <span class="setting-value">${formatDate(executor.last_cycle)}</span>
          </div>` : ''}
        </div>
        <div class="settings-section">
          <h4 class="settings-title">Trusted Senders</h4>
          <div class="trusted-list">
            ${(settings.trusted_senders || []).map(s => `<span class="guardrail-tag">${escapeHtml(s)}</span>`).join('')}
          </div>
        </div>
      </div>
    `;
  } catch (e) {
    document.getElementById('settings-content').innerHTML = '<div class="empty-state">Failed to load settings</div>';
  }
}

function settingToggle(key, label, value) {
  return `<div class="setting-row">
    <span class="setting-label">${label}</span>
    <label class="toggle">
      <input type="checkbox" ${value ? 'checked' : ''} onchange="updateSetting('${key}', this.checked)">
      <span class="toggle-slider"></span>
    </label>
  </div>`;
}

function settingNumber(key, label, value) {
  return `<div class="setting-row">
    <span class="setting-label">${label}</span>
    <input type="number" class="setting-input" value="${value}" onchange="updateSetting('${key}', parseInt(this.value))">
  </div>`;
}

function settingSelect(key, label, value, options) {
  return `<div class="setting-row">
    <span class="setting-label">${label}</span>
    <select class="filter-select" onchange="updateSetting('${key}', this.value)">
      ${options.map(o => `<option value="${o}" ${o === value ? 'selected' : ''}>${o}</option>`).join('')}
    </select>
  </div>`;
}

window.updateSetting = async function(key, value) {
  try {
    await fetchAPI('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ [key]: value }),
    });
  } catch (e) {
    alert('Failed to update: ' + e.message);
    _loaded.settings = false;
    loadSettings();
  }
};

// ── OpenClaw Tab ──────────────────────────────────────────

async function loadOCInstances() {
  try {
    const data = await ocFetchJSON('/runtime/overview');
    const instances = data.instances || [];
    const running = data.running || 0;
    const total = data.total || instances.length;
    const stopped = total - running;
    const range = data.port_range || [9001, 9099];

    document.getElementById('oc-total').textContent = total;
    document.getElementById('oc-running').textContent = running;
    document.getElementById('oc-stopped').textContent = stopped;
    document.getElementById('oc-ports').textContent = `${range[0]}-${range[1]}`;

    renderOCInstances(instances);
  } catch (e) {
    console.warn('OC load error:', e);
    document.getElementById('oc-instance-grid').innerHTML =
      `<div class="empty-state">Failed to load: ${escapeHtml(e.message)}</div>`;
  }
}

function renderOCInstances(instances) {
  const el = document.getElementById('oc-instance-grid');
  if (!instances.length) {
    el.innerHTML = '<div class="empty-state">No OpenClaw instances. Click "+ New Instance" to create one.</div>';
    return;
  }

  el.innerHTML = instances.map(inst => {
    const slug = inst.slug || '';
    const status = inst.status || 'stopped';
    const statusClass = status === 'running' ? 'oc-running'
      : status === 'provisioning' ? 'oc-provisioning'
      : status === 'error' ? 'oc-error'
      : status === 'archived' ? 'oc-archived'
      : 'oc-stopped';
    const healthClass = inst.container_running ? 'oc-health-ok'
      : status === 'error' ? 'oc-health-error'
      : 'oc-health-off';
    const port = inst.port || '—';
    const tier = inst.tier || 'internal';
    const name = inst.display_name || slug;
    const resources = inst.resources || {};
    const cpuStr = resources.cpu ? resources.cpu : '';
    const memStr = resources.mem ? resources.mem : '';

    return `<div class="oc-instance-card ${statusClass} clickable" onclick="showOCInstanceDetail('${escapeHtml(slug)}')">
      <div class="oc-card-header">
        <span class="oc-health-dot ${healthClass}"></span>
        <span class="oc-card-name">${escapeHtml(name)}</span>
        <span class="badge badge-${status === 'running' ? 'completed' : status === 'error' ? 'failed' : 'pending'}">${status}</span>
      </div>
      <div class="oc-card-meta">
        <span>${escapeHtml(slug)}</span>
        <span>port ${port}</span>
        <span>${tier}</span>
      </div>
      ${cpuStr || memStr ? `<div class="oc-card-resources">
        ${cpuStr ? `<span>CPU: ${escapeHtml(cpuStr)}</span>` : ''}
        ${memStr ? `<span>Mem: ${escapeHtml(memStr)}</span>` : ''}
      </div>` : ''}
      <div class="oc-card-actions" onclick="event.stopPropagation()">
        ${status === 'running'
          ? `<button class="btn btn-sm" onclick="ocAction('${slug}','stop')">Stop</button>
             <button class="btn btn-sm" onclick="ocAction('${slug}','restart')">Restart</button>`
          : status === 'stopped'
          ? `<button class="btn btn-sm btn-success" onclick="ocAction('${slug}','start')">Start</button>
             <button class="btn btn-sm btn-primary" onclick="ocAction('${slug}','provision')">Provision</button>`
          : status === 'provisioning'
          ? `<button class="btn btn-sm" disabled>Provisioning...</button>`
          : status === 'error'
          ? `<button class="btn btn-sm btn-primary" onclick="ocAction('${slug}','provision')">Re-provision</button>`
          : ''}
      </div>
    </div>`;
  }).join('');
}

// ── OC Create Form ────────

window.ocShowCreateForm = function() {
  document.getElementById('oc-create-form').style.display = 'flex';
};

window.ocHideCreateForm = function() {
  document.getElementById('oc-create-form').style.display = 'none';
  document.getElementById('oc-new-slug').value = '';
  document.getElementById('oc-new-name').value = '';
};

window.ocCreateInstance = async function() {
  const slug = document.getElementById('oc-new-slug').value.trim();
  const displayName = document.getElementById('oc-new-name').value.trim();
  const tier = document.getElementById('oc-new-tier').value;

  if (!slug) { alert('Slug is required'); return; }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    alert('Slug must be lowercase alphanumeric with hyphens only');
    return;
  }

  try {
    const body = { slug, tier };
    if (displayName) body.display_name = displayName;
    await ocFetchJSON('/instances', { method: 'POST', body: JSON.stringify(body) });
    ocHideCreateForm();
    _loaded.openclaw = false;
    loadOCInstances();
  } catch (e) {
    alert('Create failed: ' + e.message);
  }
};

// ── OC Instance Actions ────────

window.ocAction = async function(slug, action) {
  try {
    const method = action === 'destroy' ? 'DELETE' : 'POST';
    const endpoint = action === 'destroy'
      ? `/instances/${slug}`
      : `/instances/${slug}/${action}`;
    await ocFetchJSON(endpoint, { method });
    _loaded.openclaw = false;
    setTimeout(loadOCInstances, 1000);
  } catch (e) {
    alert(`${action} failed: ${e.message}`);
  }
};

window.ocDestroy = async function(slug) {
  const typed = prompt(`Type the slug "${slug}" to confirm destruction:`);
  if (typed !== slug) { alert('Destruction cancelled — slug did not match.'); return; }
  try {
    await ocFetchJSON(`/instances/${slug}`, { method: 'DELETE' });
    closeTaskModal();
    _loaded.openclaw = false;
    loadOCInstances();
  } catch (e) { alert('Destroy failed: ' + e.message); }
};

window.ocKillSwitch = async function(slug) {
  if (!confirm(`KILL SWITCH for "${slug}"?\n\nThis will:\n• Revoke ALL credentials immediately\n• Stop the container\n\nProceed?`)) return;
  try {
    const result = await ocFetchJSON(`/instances/${slug}/kill-switch`, { method: 'POST' });
    alert(`Kill switch activated.\nCredentials revoked: ${result.credentials_revoked || 0}`);
    closeTaskModal();
    _loaded.openclaw = false;
    loadOCInstances();
  } catch (e) { alert('Kill switch failed: ' + e.message); }
};

// ── OC Instance Detail Modal ────────

window.showOCInstanceDetail = async function(slug) {
  const modal = document.getElementById('task-modal');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('task-modal-body');
  title.textContent = 'OpenClaw Instance';
  body.innerHTML = '<div class="loading">Loading instance...</div>';
  modal.classList.add('open');

  try {
    const [instData, credsData, runtimeData, logsText] = await Promise.all([
      ocFetchJSON(`/instances/${slug}`),
      ocFetchJSON(`/instances/${slug}/credentials`),
      ocFetchJSON(`/instances/${slug}/runtime`).catch(() => null),
      ocFetch(`/instances/${slug}/logs?lines=40`).then(r => r.ok ? r.text() : '').catch(() => ''),
    ]);

    const inst = instData.instance || instData;
    const grants = credsData.grants || [];
    const activeGrants = grants.filter(g => !g.revoked_at);
    const runtime = runtimeData || {};
    const resources = runtime.resources || {};

    body.innerHTML = `
      <div class="modal-section">
        <div class="modal-row"><span class="modal-label">Slug</span><code>${escapeHtml(inst.slug)}</code></div>
        <div class="modal-row"><span class="modal-label">Name</span><span>${escapeHtml(inst.display_name || inst.slug)}</span></div>
        <div class="modal-row"><span class="modal-label">Status</span><span class="badge badge-${inst.status === 'running' ? 'completed' : inst.status === 'error' ? 'failed' : 'pending'}">${inst.status}</span></div>
        <div class="modal-row"><span class="modal-label">Tier</span><span>${inst.tier || 'internal'}</span></div>
        <div class="modal-row"><span class="modal-label">Port</span><span>${inst.port || runtime.port || '—'}</span></div>
        ${inst.autonomy_level != null ? `<div class="modal-row"><span class="modal-label">Autonomy</span><span>${inst.autonomy_level}/10</span></div>` : ''}
        <div class="modal-row"><span class="modal-label">Created</span><span>${formatDate(inst.created_at)}</span></div>
        ${inst.updated_at ? `<div class="modal-row"><span class="modal-label">Updated</span><span>${formatDate(inst.updated_at)}</span></div>` : ''}
      </div>

      ${runtime.container_running != null ? `
        <h4 class="modal-subtitle">Runtime</h4>
        <div class="modal-section">
          <div class="modal-row"><span class="modal-label">Container</span><span class="badge badge-${runtime.container_running ? 'completed' : 'failed'}">${runtime.container_running ? 'running' : 'stopped'}</span></div>
          ${runtime.health ? `<div class="modal-row"><span class="modal-label">Health</span><span>${escapeHtml(typeof runtime.health === 'string' ? runtime.health : JSON.stringify(runtime.health))}</span></div>` : ''}
          ${resources.cpu ? `<div class="modal-row"><span class="modal-label">CPU</span><span>${escapeHtml(resources.cpu)}</span></div>` : ''}
          ${resources.mem ? `<div class="modal-row"><span class="modal-label">Memory</span><span>${escapeHtml(resources.mem)}</span></div>` : ''}
        </div>
      ` : ''}

      <h4 class="modal-subtitle">Credentials (${activeGrants.length} active)</h4>
      <div class="oc-cred-list">
        ${activeGrants.length ? activeGrants.map(g => `
          <div class="oc-cred-row">
            <code>${escapeHtml(g.vault_key)}</code>
            ${g.vault_service ? `<span class="badge badge-normal">${escapeHtml(g.vault_service)}</span>` : ''}
            ${g.reason ? `<span style="color:var(--text-muted);font-size:11px">${escapeHtml(g.reason)}</span>` : ''}
            <button class="btn btn-sm btn-danger" onclick="ocRevokeCred('${escapeHtml(slug)}','${escapeHtml(g.vault_key)}','${escapeHtml(g.vault_service || '')}')">Revoke</button>
          </div>
        `).join('') : '<div class="empty-state" style="padding:8px">No active credentials</div>'}
      </div>

      <div class="oc-grant-form">
        <input type="text" id="oc-grant-key" class="search-input" placeholder="vault_key (e.g. SUPABASE_URL)" style="min-width:180px">
        <input type="text" id="oc-grant-service" class="search-input" placeholder="vault_service (optional)" style="min-width:120px">
        <input type="text" id="oc-grant-reason" class="search-input" placeholder="reason" style="min-width:100px">
        <button class="btn btn-sm btn-success" onclick="ocGrantCred('${escapeHtml(slug)}')">Grant</button>
      </div>

      ${logsText ? `
        <h4 class="modal-subtitle">Recent Logs</h4>
        <div class="modal-desc worker-logs">${escapeHtml(logsText)}</div>
      ` : ''}

      <div class="modal-actions" style="margin-top:16px">
        ${inst.status === 'running'
          ? `<button class="btn btn-sm" onclick="ocAction('${slug}','stop');closeTaskModal()">Stop</button>
             <button class="btn btn-sm" onclick="ocAction('${slug}','restart');closeTaskModal()">Restart</button>`
          : inst.status === 'stopped' || inst.status === 'error'
          ? `<button class="btn btn-sm btn-success" onclick="ocAction('${slug}','start');closeTaskModal()">Start</button>
             <button class="btn btn-sm btn-primary" onclick="ocAction('${slug}','provision');closeTaskModal()">Provision</button>`
          : ''}
        <button class="btn btn-sm btn-danger" onclick="ocKillSwitch('${escapeHtml(slug)}')">Kill Switch</button>
        <button class="btn btn-sm btn-danger" onclick="ocDestroy('${escapeHtml(slug)}')">Destroy</button>
      </div>
    `;
  } catch (e) {
    body.innerHTML = `<div class="empty-state">Failed to load instance: ${escapeHtml(e.message)}</div>`;
  }
};

window.ocGrantCred = async function(slug) {
  const key = document.getElementById('oc-grant-key')?.value.trim();
  const service = document.getElementById('oc-grant-service')?.value.trim();
  const reason = document.getElementById('oc-grant-reason')?.value.trim();

  if (!key) { alert('vault_key is required'); return; }

  try {
    const body = { vault_key: key };
    if (service) body.vault_service = service;
    if (reason) body.reason = reason;
    await ocFetchJSON(`/instances/${slug}/credentials`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    showOCInstanceDetail(slug);
  } catch (e) { alert('Grant failed: ' + e.message); }
};

window.ocRevokeCred = async function(slug, vaultKey, vaultService) {
  if (!confirm(`Revoke credential "${vaultKey}" from ${slug}?`)) return;
  try {
    const body = { vault_key: vaultKey };
    if (vaultService) body.vault_service = vaultService;
    await ocFetchJSON(`/instances/${slug}/credentials`, {
      method: 'DELETE',
      body: JSON.stringify(body),
    });
    showOCInstanceDetail(slug);
  } catch (e) { alert('Revoke failed: ' + e.message); }
};

// ── OC Audit Log ────────

async function loadOCAudit() {
  try {
    const filter = document.getElementById('oc-audit-filter')?.value.trim() || '';
    const params = new URLSearchParams({ limit: '50' });
    if (filter) params.set('instance_slug', filter);
    const data = await ocFetchJSON(`/audit?${params}`);
    const entries = data.entries || [];
    const el = document.getElementById('oc-audit-list');

    if (!entries.length) {
      el.innerHTML = '<div class="empty-state">No credential audit entries</div>';
      return;
    }

    el.innerHTML = entries.map(entry => {
      const actionClass = entry.action === 'grant' ? 'completed'
        : entry.action === 'revoke' ? 'failed'
        : entry.action === 'kill_switch' ? 'failed'
        : 'pending';
      return `<div class="audit-item">
        <div class="audit-row-top">
          <span class="audit-ts">${formatDate(entry.created_at || entry.timestamp)}</span>
          <span class="badge badge-${actionClass}">${escapeHtml(entry.action || '')}</span>
          <code style="font-size:11px">${escapeHtml(entry.instance_slug || '')}</code>
          ${entry.vault_key ? `<span style="color:var(--text-muted)">${escapeHtml(entry.vault_key)}</span>` : ''}
        </div>
        ${entry.performed_by ? `<div class="audit-summary">by ${escapeHtml(entry.performed_by)}</div>` : ''}
      </div>`;
    }).join('');
  } catch (e) {
    document.getElementById('oc-audit-list').innerHTML =
      `<div class="empty-state">Failed to load: ${escapeHtml(e.message)}</div>`;
  }
}

// Audit filter listener
document.getElementById('oc-audit-filter')?.addEventListener('input', () => {
  _loaded.ocAudit = false;
  loadOCAudit();
});

// ── ClawHub Marketplace ────────

async function loadClawHub() {
  const grid = document.getElementById('hub-skill-grid');
  try {
    const search = document.getElementById('hub-search')?.value.trim() || '';
    const category = document.getElementById('hub-category')?.value || '';
    const compat = document.getElementById('hub-compat')?.value || '';
    const params = new URLSearchParams({ limit: '50' });
    if (search) params.set('search', search);
    if (category) params.set('category', category);
    if (compat) params.set('claude_compat', compat);

    const data = await ocFetchJSON(`/hub/catalog?${params}`);
    const skills = data.skills || [];

    if (!skills.length) {
      grid.innerHTML = '<div class="empty-state">No skills found. Try syncing the catalog.</div>';
      return;
    }

    grid.innerHTML = skills.map(renderHubSkillCard).join('');
  } catch (e) {
    grid.innerHTML = `<div class="empty-state">Failed to load: ${escapeHtml(e.message)}</div>`;
  }
}

function renderHubSkillCard(skill) {
  const compatBadge = {
    full: '<span class="badge badge-completed" title="Full Claude Code compatibility">Full</span>',
    partial: '<span class="badge badge-pending" title="Partial — some files need manual review">Partial</span>',
    oc_only: '<span class="badge badge-failed" title="OpenClaw runtime required">OC Only</span>',
  }[skill.claude_compat] || '';

  const verifiedIcon = skill.opai_verified
    ? '<span style="color:var(--accent)" title="OPAI Verified">&#x2713;</span> '
    : '';

  const vaultWarning = (skill.required_vault_keys && skill.required_vault_keys.length)
    ? `<div style="color:var(--warning);font-size:11px;margin-top:4px">Requires keys: ${skill.required_vault_keys.join(', ')}</div>`
    : '';

  const tags = (skill.tags || []).slice(0, 4).map(t =>
    `<span class="tag" style="background:var(--surface-alt,#1c2333);padding:1px 6px;border-radius:4px;font-size:11px;color:var(--text-muted)">${escapeHtml(t)}</span>`
  ).join(' ');

  return `
    <div class="worker-card" style="cursor:pointer" onclick="showHubSkillDetail('${escapeHtml(skill.slug)}')">
      <div class="worker-header">
        <span class="worker-name">${verifiedIcon}${escapeHtml(skill.name)}</span>
        ${compatBadge}
      </div>
      <div class="worker-meta">${escapeHtml(skill.author || 'unknown')} &middot; v${escapeHtml(skill.version || '?')} &middot; ${skill.install_count || 0} installs</div>
      <div class="worker-meta" style="margin-top:4px">${escapeHtml((skill.description || '').slice(0, 120))}</div>
      <div style="margin-top:6px">${tags}</div>
      ${vaultWarning}
    </div>
  `;
}

async function showHubSkillDetail(slug) {
  try {
    const data = await ocFetchJSON(`/hub/skills/${slug}`);
    const skill = data.skill;
    const installs = data.installations || [];

    // Build file list
    const files = (skill.files || []).map(f =>
      `<div style="padding:4px 0;border-bottom:1px solid var(--border)">
        <code>${escapeHtml(f.name || 'untitled')}</code>
        <span class="badge badge-${f.type === 'prompt' ? 'completed' : f.type === 'knowledge' ? 'pending' : 'failed'}" style="margin-left:6px">${escapeHtml(f.type || 'unknown')}</span>
      </div>`
    ).join('');

    // Build install buttons
    let installBtns = '';

    // Claude Code install button
    if (skill.claude_compat !== 'oc_only') {
      const ccInstalled = installs.some(i => i.target_type === 'claude_code' && i.status === 'installed');
      if (ccInstalled) {
        installBtns += `<button class="btn btn-sm btn-danger" onclick="ocHubUninstall('${slug}','claude_code')">Uninstall from Claude Code</button>`;
      } else {
        installBtns += `<button class="btn btn-sm btn-primary" onclick="ocHubInstall('${slug}','claude_code')">Install to Claude Code</button>`;
      }
    } else {
      installBtns += `<button class="btn btn-sm" disabled title="Requires OpenClaw runtime">Claude Code N/A</button>`;
    }

    installBtns += ' ';

    // OC Instance install — dropdown of instances
    installBtns += `
      <select id="hub-install-instance" class="filter-select" style="min-width:120px">
        <option value="">Select instance...</option>
      </select>
      <button class="btn btn-sm btn-primary" onclick="ocHubInstallToInstance('${slug}')">Install to Instance</button>
    `;

    const compatLabel = { full: 'Full', partial: 'Partial', oc_only: 'OC Only' }[skill.claude_compat] || '?';
    const compatClass = { full: 'completed', partial: 'pending', oc_only: 'failed' }[skill.claude_compat] || '';

    // Populate the pre-existing modal
    document.getElementById('hub-modal-title').textContent = `${skill.name} v${skill.version || '?'}`;
    document.getElementById('hub-modal-body').innerHTML = `
      <p>${escapeHtml(skill.description || '')}</p>
      <div style="margin:12px 0;display:flex;gap:12px;flex-wrap:wrap;align-items:center">
        <span class="badge badge-${compatClass}">Compat: ${compatLabel}</span>
        <span style="color:var(--text-muted)">by ${escapeHtml(skill.author || 'unknown')}</span>
        <span style="color:var(--text-muted)">${skill.install_count || 0} installs</span>
        ${skill.rating ? `<span style="color:var(--warning)">${skill.rating}/5</span>` : ''}
        ${skill.opai_verified ? '<span style="color:var(--accent)">OPAI Verified</span>' : ''}
      </div>

      <h4 style="margin:16px 0 8px">Files (${(skill.files || []).length})</h4>
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:8px">${files || '<em>No files</em>'}</div>

      ${(skill.required_vault_keys && skill.required_vault_keys.length)
        ? `<div style="margin-top:12px;padding:8px;background:rgba(210,153,34,0.1);border-radius:6px;color:var(--warning)">
            <strong>Required credentials:</strong> ${skill.required_vault_keys.join(', ')}
          </div>`
        : ''}

      <h4 style="margin:16px 0 8px">Install</h4>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${installBtns}</div>

      ${installs.length ? `
        <h4 style="margin:16px 0 8px">Current Installations</h4>
        <div style="font-size:13px">
          ${installs.map(i => `<div style="padding:4px 0">${escapeHtml(i.target_type)}${i.instance_id ? ' (' + i.instance_id.slice(0,8) + ')' : ''} — ${escapeHtml(i.status)}</div>`).join('')}
        </div>
      ` : ''}
    `;
    document.getElementById('hub-modal').classList.add('open');

    // Populate instance dropdown
    try {
      const instData = await ocFetchJSON('/instances');
      const select = document.getElementById('hub-install-instance');
      if (select && instData.instances) {
        instData.instances.filter(i => i.status !== 'archived').forEach(inst => {
          const opt = document.createElement('option');
          opt.value = inst.slug;
          opt.textContent = `${inst.slug} (${inst.status})`;
          select.appendChild(opt);
        });
      }
    } catch {}

  } catch (e) {
    alert('Failed to load skill: ' + e.message);
  }
}

function closeHubModal() {
  const modal = document.getElementById('hub-modal');
  if (modal) modal.classList.remove('open');
}

async function ocHubInstall(slug, targetType, instanceSlug) {
  try {
    const body = { slug, target_type: targetType };
    if (instanceSlug) body.instance_slug = instanceSlug;
    const result = await ocFetchJSON('/hub/install', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    let msg = `Installed "${slug}" to ${targetType}`;
    if (result.files_written) msg += `\nFiles: ${result.files_written.join(', ')}`;
    if (result.warnings && result.warnings.length) msg += `\n\nWarnings:\n${result.warnings.join('\n')}`;
    alert(msg);
    closeHubModal();
    loadClawHub();
  } catch (e) {
    alert('Install failed: ' + e.message);
  }
}

async function ocHubInstallToInstance(slug) {
  const select = document.getElementById('hub-install-instance');
  const instanceSlug = select?.value;
  if (!instanceSlug) { alert('Select an instance first'); return; }
  await ocHubInstall(slug, 'oc_instance', instanceSlug);
}

async function ocHubUninstall(slug, targetType, instanceSlug) {
  if (!confirm(`Uninstall "${slug}" from ${targetType}?`)) return;
  try {
    const body = { slug, target_type: targetType };
    if (instanceSlug) body.instance_slug = instanceSlug;
    await ocFetchJSON('/hub/install', {
      method: 'DELETE',
      body: JSON.stringify(body),
    });
    alert(`Uninstalled "${slug}" from ${targetType}`);
    closeHubModal();
    loadClawHub();
  } catch (e) {
    alert('Uninstall failed: ' + e.message);
  }
}

async function syncClawHub() {
  try {
    const result = await ocFetchJSON('/hub/sync', { method: 'POST' });
    alert(`Catalog synced: ${result.synced} skills (${result.errors} errors) from ${result.source}`);
    _loaded.ocHub = false;
    loadClawHub();
  } catch (e) {
    alert('Sync failed: ' + e.message);
  }
}

// Hub filter listeners
document.getElementById('hub-search')?.addEventListener('input', () => { _loaded.ocHub = false; loadClawHub(); });
document.getElementById('hub-category')?.addEventListener('change', () => { _loaded.ocHub = false; loadClawHub(); });
document.getElementById('hub-compat')?.addEventListener('change', () => { _loaded.ocHub = false; loadClawHub(); });

// Expose OC functions for inline onclick
window.loadOCInstances = loadOCInstances;
window.loadOCAudit = loadOCAudit;
window.loadClawHub = loadClawHub;
window.syncClawHub = syncClawHub;
window.showHubSkillDetail = showHubSkillDetail;
window.closeHubModal = closeHubModal;
window.ocHubInstall = ocHubInstall;
window.ocHubInstallToInstance = ocHubInstallToInstance;
window.ocHubUninstall = ocHubUninstall;

// ── Log Streaming ─────────────────────────────────────────

let _logWS = null;
let _logPaused = false;
const _logBuffer = [];
const MAX_LOG_LINES = 500;

function connectLogWS() {
  if (_logWS && _logWS.readyState <= 1) return;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${proto}//${location.host}`;
  // Determine WS path based on how we're accessed
  const pathPrefix = location.pathname.replace(/\/+$/, '');
  _logWS = new WebSocket(`${base}${pathPrefix}/ws/logs`);

  _logWS.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'history') {
      (data.entries || []).forEach(entry => addLogLine(entry));
    } else if (data.type === 'log') {
      addLogLine(data.entry);
    }
  };

  _logWS.onerror = () => setTimeout(connectLogWS, 3000);
  _logWS.onclose = () => setTimeout(connectLogWS, 3000);
}

function addLogLine(entry) {
  if (_logPaused) return;
  const container = document.getElementById('log-container');
  if (!container) return;

  const line = document.createElement('div');
  line.className = 'log-entry';
  const ts = entry.timestamp || entry.ts || '';
  const svc = entry.service || entry.source || '';
  const msg = entry.message || entry.msg || (typeof entry === 'string' ? entry : JSON.stringify(entry));
  line.innerHTML = `<span class="log-ts">${escapeHtml(ts)}</span> <span class="log-svc">[${escapeHtml(svc)}]</span> ${escapeHtml(msg)}`;
  container.appendChild(line);

  while (container.children.length > MAX_LOG_LINES) container.removeChild(container.firstChild);
  container.scrollTop = container.scrollHeight;
}

window.toggleLogPause = function() {
  _logPaused = !_logPaused;
  document.getElementById('log-pause-btn').textContent = _logPaused ? 'Resume' : 'Pause';
};

window.clearLogs = function() {
  document.getElementById('log-container').innerHTML = '';
};

// Expose for inline onclick
window.loadTasks = loadTasks;
window.loadAudit = loadAudit;

// ── WebSocket: Live Stats ─────────────────────────────────

function connectStatsWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${proto}//${location.host}`;
  const pathPrefix = location.pathname.replace(/\/+$/, '');
  const ws = new WebSocket(`${base}${pathPrefix}/ws/stats`);

  ws.onmessage = (e) => {
    const stats = JSON.parse(e.data);
    const cpu = Math.round(stats.cpu_percent || 0);
    const mem = Math.round(stats.memory?.percent || 0);
    const disk = Math.round(stats.disk?.percent || 0);

    document.getElementById('stat-cpu').textContent = cpu + '%';
    document.getElementById('stat-mem').textContent = mem + '%';
    document.getElementById('stat-disk').textContent = disk + '%';
    setBar('bar-cpu', cpu);
    setBar('bar-mem', mem);
    setBar('bar-disk', disk);
  };

  ws.onerror = () => setTimeout(connectStatsWS, 5000);
  ws.onclose = () => setTimeout(connectStatsWS, 5000);
}

// ── Utilities ─────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatUptime(seconds) {
  if (!seconds) return '';
  if (seconds < 3600) return Math.round(seconds / 60) + 'm';
  if (seconds < 86400) return Math.round(seconds / 3600) + 'h';
  return Math.round(seconds / 86400) + 'd';
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
           d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

// ── Bottleneck Detection (v3.3) ──────────────────────────

async function loadBottlenecks() {
  const el = document.getElementById('bn-suggestions');
  try {
    const data = await fetchJSON('/api/bottleneck/suggestions');
    const items = data.suggestions || [];
    const pending = items.filter(s => s.status === 'pending');
    if (!pending.length) {
      el.innerHTML = '<div class="empty-state">No bottleneck suggestions — system is running smoothly</div>';
      return;
    }
    el.innerHTML = pending.map(s => {
      const typeLabel = {
        source_auto_approve: 'Source Trust',
        worker_action_auto_approve: 'Worker Gate',
        slow_approval: 'Slow Approval',
      }[s.type] || s.type;
      return `<div class="feedback-item">
        <div class="fb-title">
          <span class="badge badge-pending">${escapeHtml(typeLabel)}</span>
          ${escapeHtml(s.title || '')}
        </div>
        <div class="fb-detail">${escapeHtml(s.description || '')}</div>
        <div class="fb-actions">
          <button class="btn btn-sm btn-success" onclick="acceptBottleneck('${escapeHtml(s.id)}')">Accept</button>
          <button class="btn btn-sm btn-danger" onclick="dismissBottleneck('${escapeHtml(s.id)}')">Dismiss</button>
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    el.innerHTML = '<div class="empty-state">Failed to load suggestions</div>';
  }
}

async function loadApprovalTracker() {
  const statsEl = document.getElementById('bn-stats-line');
  const tbody = document.getElementById('bn-tracker-tbody');
  try {
    const data = await fetchJSON('/api/bottleneck/tracker?limit=50');
    const stats = data.stats || {};
    const events = data.events || [];

    statsEl.textContent = `${stats.total_events || 0} events tracked` +
      (stats.avg_wait_time_sec != null ? ` · avg wait ${Math.round(stats.avg_wait_time_sec / 60)}m` : '');

    if (!events.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No approval events yet</td></tr>';
      return;
    }
    tbody.innerHTML = events.map(ev => {
      const outcomeClass = ev.outcome === 'approved' ? 'completed'
        : ev.outcome === 'denied' ? 'failed'
        : ev.outcome === 'auto' ? 'completed'
        : 'pending';
      const waitStr = ev.wait_time_sec != null
        ? (ev.wait_time_sec < 60 ? Math.round(ev.wait_time_sec) + 's'
           : ev.wait_time_sec < 3600 ? Math.round(ev.wait_time_sec / 60) + 'm'
           : (ev.wait_time_sec / 3600).toFixed(1) + 'h')
        : '';
      return `<tr>
        <td>${formatDate(ev.timestamp)}</td>
        <td style="font-size:.8rem">${escapeHtml(ev.event_type || '')}</td>
        <td>${escapeHtml(ev.source || '')}</td>
        <td>${escapeHtml(ev.action || '')}</td>
        <td><span class="badge badge-${outcomeClass}">${escapeHtml(ev.outcome || '')}</span></td>
        <td>${waitStr}</td>
      </tr>`;
    }).join('');
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Failed to load</td></tr>';
  }
}

window.acceptBottleneck = async function(id) {
  if (!confirm('Accept this suggestion and apply the config change?')) return;
  try {
    const result = await fetchJSON(`/api/bottleneck/suggestions/${id}/accept`, { method: 'POST' });
    if (result.success) {
      alert('Applied: ' + (result.action || 'OK'));
    } else {
      alert('Failed: ' + (result.error || 'unknown'));
    }
    loadBottlenecks();
  } catch (e) { alert('Error: ' + e.message); }
};

window.dismissBottleneck = async function(id) {
  if (!confirm('Dismiss this suggestion?')) return;
  try {
    await fetchJSON(`/api/bottleneck/suggestions/${id}/dismiss`, { method: 'POST' });
    loadBottlenecks();
  } catch (e) { alert('Error: ' + e.message); }
};

window.scanBottlenecks = async function() {
  try {
    const result = await fetchJSON('/api/bottleneck/scan', { method: 'POST' });
    alert(`Scan complete: ${result.events_analyzed || 0} events, ${result.new_suggestions || 0} new suggestions`);
    loadBottlenecks();
    loadApprovalTracker();
  } catch (e) { alert('Scan failed: ' + e.message); }
};

window.loadBottlenecks = loadBottlenecks;
window.loadApprovalTracker = loadApprovalTracker;

// ── Init ──────────────────────────────────────────────────

initTabs();
loadCommandCenter();
connectStatsWS();

// Handle hash-based deep links (e.g., #system, #tasks, #workers)
function handleHash() {
  const hash = location.hash.replace('#', '');
  if (!hash) return;
  const btn = document.querySelector(`.tab-btn[data-tab="${hash}"]`);
  if (btn) btn.click();
}
handleHash();
window.addEventListener('hashchange', handleHash);

// Refresh command center every 30s
setInterval(loadCommandCenter, 30000);

// ── Keyboard Shortcuts ───────────────────────────────────

document.addEventListener('keydown', (e) => {
  // Escape: close modal
  if (e.key === 'Escape') {
    const modal = document.getElementById('task-modal');
    if (modal && modal.classList.contains('open')) {
      closeTaskModal();
      return;
    }
  }

  // Don't capture when typing in inputs
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

  // 1-5: Switch tabs
  if (e.key >= '1' && e.key <= '5' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const tabs = document.querySelectorAll('.tab-btn');
    const idx = parseInt(e.key) - 1;
    if (tabs[idx]) { tabs[idx].click(); e.preventDefault(); }
  }

  // r: Refresh current tab
  if (e.key === 'r' && !e.ctrlKey && !e.metaKey) {
    const active = document.querySelector('.tab-btn.active');
    if (active) {
      const tab = active.dataset.tab;
      if (tab === 'command-center') loadCommandCenter();
      else if (tab === 'tasks') loadTasks();
      else if (tab === 'workers') loadWorkers();
      else if (tab === 'openclaw') { _loaded.openclaw = false; _loaded.ocHub = false; loadOCInstances(); }
      else if (tab === 'system') { loadHealth(); loadServices(); }
    }
    e.preventDefault();
  }

  // /: Focus search
  if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
    const search = document.querySelector('.search-input:not([style*="display: none"])');
    if (search) { search.focus(); e.preventDefault(); }
  }
});
