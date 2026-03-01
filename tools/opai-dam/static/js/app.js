/**
 * DAM Bot — Do Anything Mode — Frontend Application
 */
(function () {
  'use strict';

  const API = '/dam/api';
  let supabase = null;
  let currentUser = null;
  let currentSessionId = null;
  let sseSource = null;

  // ── Init ────────────────────────────────────────────────
  async function init() {
    try {
      const cfg = await fetch(`${API}/auth/config`).then(r => r.json());
      supabase = window.supabase.createClient(cfg.supabase_url, cfg.supabase_anon_key);

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        window.location.href = '/auth/login?redirect=/dam/';
        return;
      }
      currentUser = session.user;
      document.getElementById('user-display').textContent = currentUser.email;

      document.getElementById('loading-overlay').classList.add('hidden');
      document.getElementById('app').classList.remove('hidden');

      loadSessions();
      loadPendingApprovalCount();
    } catch (err) {
      console.error('Init failed:', err);
      document.querySelector('.loading-sub').textContent = 'Failed to connect';
    }
  }

  // ── Tab Navigation ──────────────────────────────────────
  function showTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));

    const panel = document.getElementById(`panel-${tab}`);
    if (panel) panel.classList.add('active');

    // Load data for tab
    if (tab === 'sessions') loadSessions();
    else if (tab === 'approvals') loadApprovals();
    else if (tab === 'skills') loadSkills();
    else if (tab === 'improvements') loadImprovements();

    // Close SSE if leaving detail
    if (tab !== 'session-detail' && sseSource) {
      sseSource.close();
      sseSource = null;
    }
  }

  // ── Sessions ────────────────────────────────────────────
  async function loadSessions() {
    const status = document.getElementById('filter-status')?.value || '';
    const url = status ? `${API}/sessions?status=${status}` : `${API}/sessions`;
    try {
      const data = await fetch(url).then(r => r.json());
      renderSessionList(data.sessions || []);
    } catch (err) {
      document.getElementById('sessions-list').innerHTML = '<div class="empty-state">Failed to load sessions</div>';
    }
  }

  function modelBadge(model) {
    if (!model) return '';
    const label = model === 'auto' ? 'Auto' : model.charAt(0).toUpperCase() + model.slice(1);
    return `<span class="model-badge model-${model}">${label}</span>`;
  }

  function renderSessionList(sessions) {
    const container = document.getElementById('sessions-list');
    if (!sessions.length) {
      container.innerHTML = '<div class="empty-state">No sessions yet. Click "+ New Session" to get started.</div>';
      return;
    }
    container.innerHTML = sessions.map(s => `
      <div class="card" onclick="DAM.openSession('${s.id}')">
        <div class="card-top">
          <span class="card-title">${esc(s.title)}</span>
          <span class="status status-${s.status}">${s.status}</span>
        </div>
        <div class="card-meta">
          Autonomy: ${s.autonomy_level}/4 &middot; Model: ${modelBadge(s.model_preference || 'auto')} &middot; ${timeAgo(s.created_at)}
          ${s.tags?.length ? ' &middot; ' + s.tags.map(t => `<span style="color:var(--accent)">#${esc(t)}</span>`).join(' ') : ''}
        </div>
      </div>
    `).join('');
  }

  async function openSession(sessionId) {
    currentSessionId = sessionId;

    // Hide tabs, show detail panel
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.getElementById('panel-session-detail').classList.add('active');

    const container = document.getElementById('session-detail-content');
    container.innerHTML = '<div class="empty-state">Loading session...</div>';

    try {
      const session = await fetch(`${API}/sessions/${sessionId}`).then(r => r.json());
      const plansData = await fetch(`${API}/plans/${sessionId}`).then(r => r.json());
      const stepsData = await fetch(`${API}/steps/${sessionId}`).then(r => r.json()).catch(() => ({ steps: [] }));
      const logsData = await fetch(`${API}/stream/${sessionId}/logs?limit=50`).then(r => r.json()).catch(() => ({ logs: [] }));
      const approvalsData = await fetch(`${API}/approvals?session_id=${sessionId}`).then(r => r.json()).catch(() => ({ approvals: [] }));

      renderSessionDetail(session, plansData.plans || [], stepsData.steps || [], logsData.logs || [], approvalsData.approvals || []);

      // Start SSE if session is active
      if (['executing', 'planning', 'paused'].includes(session.status)) {
        startSSE(sessionId);
      }
    } catch (err) {
      container.innerHTML = `<div class="empty-state">Failed to load session: ${esc(err.message)}</div>`;
    }
  }

  function renderSessionDetail(session, plans, steps, logs, approvals) {
    const activePlan = plans.find(p => p.is_active);
    const canPlan = ['draft', 'failed'].includes(session.status);
    const canExecute = ['draft', 'planning', 'failed'].includes(session.status);
    const canResume = session.status === 'paused';
    const canCancel = ['executing', 'paused', 'planning'].includes(session.status);

    document.getElementById('session-detail-content').innerHTML = `
      <div class="session-detail">
        <button class="back-btn" onclick="DAM.showTab('sessions')">&larr; Back to Sessions</button>

        <div class="session-header">
          <div>
            <h2>${esc(session.title)}</h2>
            <span class="status status-${session.status}">${session.status}</span>
            <span style="color:var(--text-dim); font-size:12px; margin-left:8px;">
              Autonomy: ${session.autonomy_level}/4
            </span>
            ${modelBadge(session.model_preference || 'auto')}
          </div>
          <div class="session-actions">
            ${canPlan ? `<button class="btn btn-sm btn-ghost" onclick="DAM.generatePlan('${session.id}')">Generate Plan</button>` : ''}
            ${canExecute && activePlan ? `<button class="btn btn-sm btn-accent" onclick="DAM.executePipeline('${session.id}')">Execute</button>` : ''}
            ${canResume ? `<button class="btn btn-sm btn-green" onclick="DAM.executePipeline('${session.id}')">Resume</button>` : ''}
            ${canCancel ? `<button class="btn btn-sm btn-red" onclick="DAM.cancelSession('${session.id}')">Cancel</button>` : ''}
          </div>
        </div>

        <div style="background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius); padding:12px;">
          <div class="section-title">Goal</div>
          <div style="font-size:14px; line-height:1.5;">${esc(session.goal)}</div>
        </div>

        ${approvals.length ? `
          <div>
            <div class="section-title">Pending Approvals</div>
            <div class="card-list">${approvals.map(a => renderApprovalCard(a)).join('')}</div>
          </div>
        ` : ''}

        ${steps.length ? `
          <div>
            <div class="section-title">Plan Steps (${steps.filter(s=>s.status==='completed').length}/${steps.length} done)</div>
            <div class="plan-tree">${steps.map((s, i) => renderStep(s, i)).join('')}</div>
          </div>
        ` : activePlan ? `
          <div>
            <div class="section-title">Plan</div>
            <div style="font-size:13px; color:var(--text-dim);">Plan generated. Click Execute to start.</div>
          </div>
        ` : `
          <div class="empty-state">No plan yet. Click "Generate Plan" to decompose the goal.</div>
        `}

        <div>
          <div class="section-title">Activity Log</div>
          <div class="log-stream" id="log-stream">
            ${logs.length ? logs.reverse().map(l => renderLogEntry(l)).join('') : '<div style="color:var(--text-dim)">No activity yet</div>'}
          </div>
        </div>
      </div>
    `;
  }

  function renderStep(step, index) {
    const cfg = step.config || {};
    const stepModel = cfg.model || (step.result && step.result.model) || '';
    return `
      <div class="plan-step">
        <div class="step-ordinal">${index + 1}</div>
        <div class="step-body">
          <div class="step-title">
            ${esc(step.title)}
            <span class="status status-${step.status}" style="margin-left:8px;">${step.status}</span>
          </div>
          ${step.description ? `<div class="step-desc">${esc(step.description)}</div>` : ''}
          <span class="step-type">${step.step_type}</span>
          ${stepModel ? modelBadge(stepModel) : ''}
          ${cfg.model_reason ? `<span style="font-size:10px; color:var(--text-dim); margin-left:6px;" title="${esc(cfg.model_reason)}">${esc(cfg.model_reason)}</span>` : ''}
          ${step.duration_ms ? `<span style="font-size:11px; color:var(--text-dim); margin-left:8px;">${step.duration_ms}ms</span>` : ''}
        </div>
      </div>
    `;
  }

  function renderLogEntry(log) {
    const ts = new Date(log.created_at).toLocaleTimeString();
    return `<div class="log-entry ${log.level}"><span class="log-ts">${ts}</span>${esc(log.message)}</div>`;
  }

  // ── Approvals ───────────────────────────────────────────
  async function loadApprovals() {
    try {
      const data = await fetch(`${API}/approvals/all`).then(r => r.json());
      renderApprovalList(data.approvals || []);
    } catch (err) {
      document.getElementById('approvals-list').innerHTML = '<div class="empty-state">Failed to load approvals</div>';
    }
  }

  async function loadPendingApprovalCount() {
    try {
      const data = await fetch(`${API}/approvals`).then(r => r.json());
      const count = (data.approvals || []).length;
      const badge = document.getElementById('approvals-badge');
      if (count > 0) {
        badge.textContent = count;
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
    } catch {}
  }

  function renderApprovalList(approvals) {
    const container = document.getElementById('approvals-list');
    if (!approvals.length) {
      container.innerHTML = '<div class="empty-state">No approvals</div>';
      return;
    }
    container.innerHTML = approvals.map(a => renderApprovalCard(a)).join('');
  }

  function renderApprovalCard(a) {
    const isPending = a.status === 'pending';
    return `
      <div class="approval-card risk-${a.risk_level}">
        <div class="card-top">
          <span class="card-title">${esc(a.title)}</span>
          <span class="status status-${a.status}">${a.status}</span>
        </div>
        <div class="card-meta">
          Risk: ${a.risk_level} &middot; Type: ${a.approval_type} &middot; ${timeAgo(a.created_at)}
        </div>
        ${a.description ? `<div style="font-size:12px; color:var(--text-dim); margin-top:4px;">${esc(a.description)}</div>` : ''}
        ${isPending ? `
          <div class="approval-actions">
            <button class="btn btn-sm btn-green" onclick="DAM.approveAction('${a.id}')">Approve</button>
            <button class="btn btn-sm btn-red" onclick="DAM.rejectAction('${a.id}')">Reject</button>
          </div>
        ` : ''}
      </div>
    `;
  }

  async function approveAction(approvalId) {
    await fetch(`${API}/approvals/${approvalId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: currentUser?.id }),
    });
    loadApprovals();
    loadPendingApprovalCount();
    if (currentSessionId) openSession(currentSessionId);
  }

  async function rejectAction(approvalId) {
    await fetch(`${API}/approvals/${approvalId}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: currentUser?.id }),
    });
    loadApprovals();
    loadPendingApprovalCount();
    if (currentSessionId) openSession(currentSessionId);
  }

  // ── Skills ──────────────────────────────────────────────
  async function loadSkills() {
    try {
      const data = await fetch(`${API}/skills`).then(r => r.json());
      const container = document.getElementById('skills-list');
      const skills = data.skills || [];
      if (!skills.length) {
        container.innerHTML = '<div class="empty-state">No skills in library yet. Skills are learned as DAM Bot encounters new challenges.</div>';
        return;
      }
      container.innerHTML = skills.map(s => `
        <div class="card">
          <div class="card-top">
            <span class="card-title">${esc(s.name)}</span>
            <span class="status ${s.is_verified ? 'status-completed' : 'status-pending'}">${s.is_verified ? 'verified' : 'unverified'}</span>
          </div>
          <div class="card-meta">
            Type: ${s.skill_type} &middot; Used ${s.usage_count}x &middot; Success: ${Math.round(s.success_rate * 100)}%
          </div>
          ${s.description ? `<div style="font-size:12px; color:var(--text-dim); margin-top:4px;">${esc(s.description)}</div>` : ''}
        </div>
      `).join('');
    } catch (err) {
      document.getElementById('skills-list').innerHTML = '<div class="empty-state">Failed to load skills</div>';
    }
  }

  // ── Improvements ────────────────────────────────────────
  async function loadImprovements() {
    try {
      const data = await fetch(`${API}/improvements`).then(r => r.json());
      const container = document.getElementById('improvements-list');
      const items = data.improvements || [];
      if (!items.length) {
        container.innerHTML = '<div class="empty-state">No improvement requests yet. These are generated when DAM Bot encounters capability gaps.</div>';
        return;
      }
      container.innerHTML = items.map(item => `
        <div class="card">
          <div class="card-top">
            <span class="card-title">${esc(item.title)}</span>
            <span class="status status-${item.implementation_status === 'approved' ? 'completed' : item.implementation_status === 'rejected' ? 'failed' : 'pending'}">${item.implementation_status}</span>
          </div>
          <div class="card-meta">
            Trigger: ${item.trigger_type} &middot; ${timeAgo(item.created_at)}
          </div>
        </div>
      `).join('');
    } catch (err) {
      document.getElementById('improvements-list').innerHTML = '<div class="empty-state">Failed to load improvements</div>';
    }
  }

  // ── Autonomy tooltip descriptions ───────────────────────
  const AUTONOMY_LABELS = {
    1: 'Supervised — Confirms sandbox writes, external API calls, content publishing, and purchases. Blocks irreversible actions entirely. CEO-gate on large financial decisions.',
    2: 'Guided — Auto-approves sandbox ops (agents, file writes, code builds). Confirms external API calls, content publishing, and purchases. Blocks irreversible actions. CEO-gate on large financial.',
    3: 'Autonomous — Auto-approves sandbox ops. Confirms external API calls, content publishing, and purchases. Irreversible actions escalate to CEO-gate instead of being blocked. CEO-gate on large financial.',
    4: 'Full Autonomy — Auto-approves sandbox ops, external API calls, and content publishing. Only confirms purchases. CEO-gates irreversible and large financial decisions.',
  };

  function updateAutonomyLabel(val) {
    document.getElementById('autonomy-val').textContent = val;
    document.getElementById('autonomy-tooltip').textContent = AUTONOMY_LABELS[val] || '';
  }

  function applyExample(btn) {
    const goal = btn.textContent.trim();
    document.getElementById('new-goal').value = goal;
    document.getElementById('new-goal').focus();
  }

  // ── Actions ─────────────────────────────────────────────
  function showNewSessionModal() {
    document.getElementById('modal-new-session').classList.remove('hidden');
    updateAutonomyLabel(document.getElementById('new-autonomy').value);
    document.getElementById('new-title').focus();
  }

  function closeModals() {
    document.querySelectorAll('.modal-overlay').forEach(m => m.classList.add('hidden'));
  }

  async function createSession() {
    const title = document.getElementById('new-title').value.trim();
    const goal = document.getElementById('new-goal').value.trim();
    const autonomy = parseInt(document.getElementById('new-autonomy').value);
    const modelPref = document.getElementById('new-model').value;

    if (!title || !goal) return alert('Title and goal are required.');

    try {
      const session = await fetch(`${API}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, goal, autonomy_level: autonomy, model_preference: modelPref }),
      }).then(r => r.json());

      closeModals();
      document.getElementById('new-title').value = '';
      document.getElementById('new-goal').value = '';
      document.getElementById('new-model').value = 'auto';
      openSession(session.id);
    } catch (err) {
      alert('Failed to create session: ' + err.message);
    }
  }

  async function generatePlan(sessionId) {
    const btn = event.target;
    btn.disabled = true;
    btn.textContent = 'Planning...';
    try {
      await fetch(`${API}/plans/${sessionId}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      openSession(sessionId);
    } catch (err) {
      alert('Plan generation failed: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Generate Plan';
    }
  }

  async function executePipeline(sessionId) {
    const btn = event.target;
    btn.disabled = true;
    btn.textContent = 'Starting...';
    try {
      fetch(`${API}/steps/${sessionId}/execute`, { method: 'POST' });
      // Don't await — pipeline runs async, SSE will update UI
      startSSE(sessionId);
      setTimeout(() => openSession(sessionId), 1500);
    } catch (err) {
      alert('Execution failed: ' + err.message);
    }
  }

  async function cancelSession(sessionId) {
    if (!confirm('Cancel this session? Running steps will be stopped.')) return;
    await fetch(`${API}/sessions/${sessionId}/cancel`, { method: 'POST' });
    openSession(sessionId);
  }

  // ── SSE Stream ──────────────────────────────────────────
  function startSSE(sessionId) {
    if (sseSource) sseSource.close();
    sseSource = new EventSource(`${API}/stream/${sessionId}`);

    sseSource.addEventListener('log', (e) => {
      const log = JSON.parse(e.data);
      const stream = document.getElementById('log-stream');
      if (stream) {
        stream.innerHTML += renderLogEntry(log);
        stream.scrollTop = stream.scrollHeight;
      }
    });

    sseSource.addEventListener('step_update', () => {
      if (currentSessionId === sessionId) openSession(sessionId);
    });

    sseSource.addEventListener('session_ended', (e) => {
      sseSource.close();
      sseSource = null;
      if (currentSessionId === sessionId) openSession(sessionId);
    });

    sseSource.onerror = () => {
      sseSource.close();
      sseSource = null;
    };
  }

  // ── Helpers ─────────────────────────────────────────────
  function esc(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  // ── Public API ──────────────────────────────────────────
  window.DAM = {
    showTab,
    loadSessions,
    openSession,
    showNewSessionModal,
    closeModals,
    createSession,
    generatePlan,
    executePipeline,
    cancelSession,
    approveAction,
    rejectAction,
    loadSkills,
    loadImprovements,
    applyExample,
    updateAutonomyLabel,
  };

  // Init
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
