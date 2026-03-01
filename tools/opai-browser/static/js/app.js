/**
 * OPAI Browser — Admin Debug UI
 * Vanilla JS, no frameworks. Talks to localhost:8107 API.
 */

async function apiFetch(endpoint, opts = {}) {
  opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const r = await fetch('/api' + endpoint, opts);
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    let msg = `${r.status} ${r.statusText}`;
    try { const j = JSON.parse(body); msg = j.detail || msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

// ── Jobs ─────────────────────────────────────────────────

async function loadJobs() {
  const grid = document.getElementById('job-grid');
  try {
    const data = await apiFetch('/jobs?limit=30');
    if (!data.jobs.length) {
      grid.innerHTML = '<div class="empty">No jobs yet</div>';
      return;
    }
    grid.innerHTML = data.jobs.map(renderJobCard).join('');
  } catch (e) {
    grid.innerHTML = `<div class="empty">Error: ${e.message}</div>`;
  }
}

function renderJobCard(job) {
  const badge = `<span class="badge badge-${job.status}">${job.status}</span>`;
  const task = escHtml(job.task.length > 120 ? job.task.slice(0, 120) + '...' : job.task);
  const time = job.started_at ? new Date(job.started_at).toLocaleTimeString() : '—';
  let result = '';
  if (job.result) {
    result = `<div class="card-result">${escHtml(job.result.slice(0, 2000))}</div>`;
  } else if (job.error) {
    result = `<div class="card-result" style="border-color:var(--error)">${escHtml(job.error.slice(0, 1000))}</div>`;
  }
  const cancelBtn = (job.status === 'queued' || job.status === 'running')
    ? `<button class="btn btn-sm btn-danger" onclick="cancelJob('${job.id}')">Cancel</button>`
    : '';

  return `
    <div class="card">
      <div class="card-header">
        <span class="card-title">${job.id}</span>
        ${badge}
      </div>
      <div class="card-meta">${task}</div>
      <div class="card-meta">Session: ${job.session} | Caller: ${job.caller} | ${time}</div>
      ${result}
      ${cancelBtn ? `<div style="margin-top:8px">${cancelBtn}</div>` : ''}
    </div>
  `;
}

async function submitJob() {
  const errEl = document.getElementById('submit-error');
  errEl.style.display = 'none';
  const task = document.getElementById('job-task').value.trim();
  if (!task) { errEl.textContent = 'Task is required'; errEl.style.display = 'block'; return; }

  try {
    await apiFetch('/jobs', {
      method: 'POST',
      body: JSON.stringify({
        task,
        session: document.getElementById('job-session').value.trim() || 'default',
        max_turns: parseInt(document.getElementById('job-turns').value) || 15,
        timeout_sec: parseInt(document.getElementById('job-timeout').value) || 300,
        vision_ok: document.getElementById('job-vision').checked,
      }),
    });
    document.getElementById('job-task').value = '';
    loadJobs();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
}

async function cancelJob(id) {
  try {
    await apiFetch(`/jobs/${id}`, { method: 'DELETE' });
    loadJobs();
  } catch (e) {
    alert('Cancel failed: ' + e.message);
  }
}

// ── Sessions ────────────────────────────────────────────

async function loadSessions() {
  const list = document.getElementById('session-list');
  try {
    const data = await apiFetch('/sessions');
    if (!data.sessions.length) {
      list.innerHTML = '<div class="empty">No sessions</div>';
      return;
    }
    list.innerHTML = data.sessions.map(s => `
      <div class="session-item">
        <div>
          <div class="session-name">${escHtml(s.name)}</div>
          <div class="session-info">${s.size_mb} MB &middot; Last used: ${new Date(s.last_used).toLocaleString()}</div>
        </div>
        <button class="btn btn-sm btn-danger" onclick="deleteSession('${escHtml(s.name)}')">Delete</button>
      </div>
    `).join('');
  } catch (e) {
    list.innerHTML = `<div class="empty">Error: ${e.message}</div>`;
  }
}

async function createSession() {
  const name = document.getElementById('new-session-name').value.trim();
  if (!name) return;
  try {
    await apiFetch('/sessions', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    document.getElementById('new-session-name').value = '';
    loadSessions();
  } catch (e) {
    alert('Create failed: ' + e.message);
  }
}

async function deleteSession(name) {
  if (!confirm(`Delete session "${name}" and all its browser data?`)) return;
  try {
    await apiFetch(`/sessions/${name}`, { method: 'DELETE' });
    loadSessions();
  } catch (e) {
    alert('Delete failed: ' + e.message);
  }
}

// ── Util ────────────────────────────────────────────────

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// Auto-refresh running jobs
let _refreshTimer;
function startAutoRefresh() {
  _refreshTimer = setInterval(() => {
    const cards = document.querySelectorAll('.badge-running, .badge-queued');
    if (cards.length > 0) loadJobs();
  }, 3000);
}

// ── Init ────────────────────────────────────────────────
loadJobs();
loadSessions();
startAutoRefresh();
