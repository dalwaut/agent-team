/**
 * OPAI Agent Orchestra — Concert Hall (Run History + Active Runs).
 * Orchestra term: "Concert Hall" = Agent Studio's "Runs" tab.
 */

const ConcertHall = (() => {
    let reportModal = null;

    function render() {
        const shell = document.getElementById('concert-hall-shell');
        shell.innerHTML =
            '<div class="panel-title">🏛️ Concert Hall <span class="term-badge">Run History</span></div>' +
            '<div class="panel-subtitle">Past and active performances by your ensemble</div>' +

            '<div style="display:flex;gap:10px;margin-bottom:20px;align-items:center">' +
                '<button class="btn-ghost btn-sm" onclick="ConcertHall.refresh()">↻ Refresh</button>' +
                '<span style="font-size:12px;color:var(--text-muted)">Auto-refreshes every 4 seconds during active runs</span>' +
            '</div>' +

            '<div id="ch-active-section" style="margin-bottom:28px">' +
                '<div class="orch-label" style="margin-bottom:10px;font-size:13px;color:var(--gold-2)">🎭 Active Performances <span class="term-badge">Running</span></div>' +
                '<div id="ch-active-runs"></div>' +
            '</div>' +

            '<div>' +
                '<div class="orch-label" style="margin-bottom:10px;font-size:13px;color:var(--text-2)">📚 Performance Archive <span class="term-badge">Run History</span></div>' +
                '<div id="ch-history"></div>' +
            '</div>';

        renderActive();
        loadHistory();
    }

    function renderActive() {
        const el = document.getElementById('ch-active-runs');
        if (!el) return;

        if (!State.activeRuns.length) {
            el.innerHTML = '<div class="empty-state" style="padding:24px"><div class="empty-emblem" style="font-size:24px">🤫</div><div class="empty-sub">No active performances right now</div></div>';
            return;
        }

        el.innerHTML = '<div class="runs-grid">' +
            State.activeRuns.map(run => _runCard(run, true)).join('') +
        '</div>';
    }

    async function loadHistory() {
        const el = document.getElementById('ch-history');
        if (!el) return;
        el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:16px">Loading archive…</div>';

        try {
            const resp = await apiFetch('/runs?limit=50');
            const runs = resp.runs || [];

            if (!runs.length) {
                el.innerHTML = '<div class="empty-state"><div class="empty-emblem">📂</div><div class="empty-title">No performances yet</div><div class="empty-sub">Run a programme from the Orchestra or a Section view to start.</div></div>';
                return;
            }

            el.innerHTML = '<table class="orch-table">' +
                '<thead><tr>' +
                    '<th>Programme <span class="term-badge">Squad</span></th>' +
                    '<th>Status</th>' +
                    '<th>Started</th>' +
                    '<th>Duration</th>' +
                    '<th>Actions</th>' +
                '</tr></thead>' +
                '<tbody>' +
                runs.map(run => _runRow(run)).join('') +
                '</tbody></table>';
        } catch(e) {
            el.innerHTML = '<div class="empty-state"><div class="empty-sub">Could not load history: ' + esc(e.message) + '</div></div>';
        }
    }

    function _runCard(run, isActive) {
        const statusLabel = { running: 'Performing', done: 'Completed', failed: 'Failed', cancelled: 'Cancelled' };
        const status = run.status || 'running';

        return '<div class="run-card' + (isActive ? ' run-active' : '') + '">' +
            '<div class="run-header">' +
                '<div class="run-squad">🎼 ' + esc(run.squad || '—') + ' <span class="term-badge">Squad</span></div>' +
                '<span class="run-badge ' + status + '">' + esc(statusLabel[status] || status) + '</span>' +
            '</div>' +
            '<div class="run-meta">' +
                'Run ID: <code style="font-size:10px">' + esc(run.run_id || run.id || '—') + '</code>' +
                (run.started_at ? ' · Started ' + fmtDate(run.started_at) : '') +
            '</div>' +
            (isActive && (run.agents_running || []).length ? '<div class="run-meta">Playing now: ' + esc((run.agents_running || []).join(', ')) + '</div>' : '') +
            '<div class="run-actions">' +
                '<button class="btn-ghost btn-sm" onclick="ConcertHall.viewReport(\'' + esc(run.run_id || run.id) + '\')">📄 Programme Notes</button>' +
                (status === 'running' ? '<button class="btn-ghost btn-sm" style="color:var(--c-security)" onclick="ConcertHall.cancelRun(\'' + esc(run.run_id || run.id) + '\')">◼ Stop</button>' : '') +
            '</div>' +
        '</div>';
    }

    function _runRow(run) {
        const status = run.status || 'done';
        const statusDots = { running: 'running', done: 'done', failed: 'failed', cancelled: 'done' };
        const dur = run.duration_s ? run.duration_s + 's' : run.started_at && run.ended_at
            ? Math.round((new Date(run.ended_at) - new Date(run.started_at)) / 1000) + 's' : '—';

        return '<tr>' +
            '<td><strong>' + esc(run.squad || '—') + '</strong></td>' +
            '<td><span class="status-dot ' + (statusDots[status] || 'done') + '"></span> ' + esc(status) + '</td>' +
            '<td style="font-family:var(--font-mono);font-size:11px">' + esc(fmtDate(run.started_at || run.created_at)) + '</td>' +
            '<td style="font-family:var(--font-mono);font-size:11px">' + esc(dur) + '</td>' +
            '<td>' +
                '<button class="btn-ghost btn-sm" onclick="ConcertHall.viewReport(\'' + esc(run.run_id || run.id) + '\')">Notes</button> ' +
                (status === 'running' ? '<button class="btn-ghost btn-sm" style="color:var(--c-security)" onclick="ConcertHall.cancelRun(\'' + esc(run.run_id || run.id) + '\')">Stop</button>' : '') +
            '</td>' +
        '</tr>';
    }

    async function viewReport(runId) {
        // Show available reports for this run
        try {
            const resp = await apiFetch('/reports/latest');
            const reports = resp.reports || [];

            let html = '<div class="modal-header">' +
                '<h2>📄 Programme Notes <span class="term-badge">Reports</span></h2>' +
                '<button class="modal-close" onclick="document.getElementById(\'musician-modal\').classList.add(\'hidden\')">✕</button>' +
            '</div>';

            if (!reports.length) {
                html += '<p class="modal-body-text">No reports found for this run.</p>';
            } else {
                html += '<div style="display:flex;flex-direction:column;gap:8px">';
                html += reports.map(r =>
                    '<button class="btn-ghost" onclick="ConcertHall.readReport(\'' + esc(r.name || r) + '\')" style="text-align:left">' +
                        '📄 ' + esc(r.name || r) +
                    '</button>'
                ).join('');
                html += '</div>';
            }

            html += '<div class="modal-actions"><button class="btn-ghost" onclick="document.getElementById(\'musician-modal\').classList.add(\'hidden\')">Close</button></div>';

            document.getElementById('musician-modal-box').innerHTML = html;
            document.getElementById('musician-modal').classList.remove('hidden');
        } catch(e) {
            toast('Could not load reports: ' + e.message, 'error');
        }
    }

    async function readReport(name) {
        try {
            const resp = await apiFetch('/reports/latest/' + encodeURIComponent(name));
            const content = typeof resp === 'string' ? resp : resp.content || JSON.stringify(resp, null, 2);

            document.getElementById('musician-modal-box').innerHTML =
                '<div class="modal-header">' +
                    '<h2>' + esc(name) + '</h2>' +
                    '<button class="modal-close" onclick="document.getElementById(\'musician-modal\').classList.add(\'hidden\')">✕</button>' +
                '</div>' +
                '<pre style="background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:16px;overflow:auto;max-height:60vh;font-size:12px;color:var(--text-2);white-space:pre-wrap;font-family:var(--font-mono)">' +
                    esc(content) +
                '</pre>' +
                '<div class="modal-actions"><button class="btn-ghost" onclick="ConcertHall.viewReport(\'\')">← Back</button><button class="btn-ghost" onclick="document.getElementById(\'musician-modal\').classList.add(\'hidden\')">Close</button></div>';
        } catch(e) {
            toast('Could not read report: ' + e.message, 'error');
        }
    }

    async function cancelRun(runId) {
        const ok = await showConfirm('Stop Performance?', 'Stop run ' + runId + '? The agents will be terminated.', 'Stop');
        if (!ok) return;
        try {
            await apiFetch('/runs/' + encodeURIComponent(runId) + '/cancel', { method: 'POST' });
            toast('Performance stopped', 'success');
            await refreshActiveRuns();
            render();
        } catch(e) { toast(e.message, 'error'); }
    }

    async function refresh() {
        await refreshActiveRuns();
        render();
    }

    return { render, renderActive, viewReport, readReport, cancelRun, refresh };
})();
