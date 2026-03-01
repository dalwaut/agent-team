/**
 * OPAI Agent Studio — Runs & Reports view.
 */

const Runs = (() => {
    let pollTimer = null;
    let reportDates = [];

    function render() {
        // Populate squad selector
        const sel = document.getElementById('run-squad-select');
        sel.innerHTML = State.squads.map(s =>
            '<option value="' + esc(s.id) + '">' + esc(s.id) + ' — ' + esc(s.description) + '</option>'
        ).join('');

        loadRuns();
        loadReportDates();
    }

    // ── Runs ─────────────────────────────────────────

    async function loadRuns() {
        try {
            const data = await apiFetch('/runs?limit=50');
            renderActiveRuns(data.active || []);
            renderHistory(data.history || []);

            // Auto-poll if there are active runs
            if ((data.active || []).length > 0) {
                _startPolling();
            } else {
                _stopPolling();
            }
        } catch (e) {
            // Silently ignore on other tabs
        }
    }

    function renderActiveRuns(runs) {
        const section = document.getElementById('active-runs-section');
        const container = document.getElementById('active-runs');
        if (!runs.length) {
            section.classList.add('hidden');
            return;
        }
        section.classList.remove('hidden');
        container.innerHTML = runs.map(r => {
            const elapsed = Math.round((Date.now() - new Date(r.started_at).getTime()) / 1000);
            return '<div class="active-run-card">' +
                '<div class="ar-info">' +
                '<span class="ar-status status-running">Running</span>' +
                '<strong>' + esc(r.squad || r.agents.join(', ')) + '</strong>' +
                '<span class="text-muted"> by ' + esc(r.triggered_by) + ' — ' + _formatDuration(elapsed) + '</span>' +
                '</div>' +
                '<div class="ar-agents">' + r.agents.map(a => '<span class="agent-chip"><span class="chip-emoji">?</span>' + esc(a) + '</span>').join('') + '</div>' +
                '<button class="btn btn-sm btn-danger" onclick="Runs.cancel(\'' + esc(r.id) + '\')">Cancel</button>' +
                '</div>';
        }).join('');
    }

    function renderHistory(runs) {
        const tbody = document.getElementById('runs-tbody');
        if (!runs.length) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-muted" style="text-align:center;padding:2rem;">No runs yet. Trigger a squad run above.</td></tr>';
            return;
        }
        tbody.innerHTML = runs.map(r => {
            const statusClass = {
                completed: 'status-ok', failed: 'status-err',
                timeout: 'status-err', cancelled: 'status-warn',
            }[r.status] || '';
            return '<tr>' +
                '<td><span class="run-id">' + esc(r.id.split('-').slice(0, 3).join('-')) + '</span></td>' +
                '<td>' + esc(r.squad || r.agents.join(', ')) + '</td>' +
                '<td><span class="status-badge ' + statusClass + '">' + esc(r.status) + '</span></td>' +
                '<td>' + (r.duration_seconds != null ? _formatDuration(r.duration_seconds) : '--') + '</td>' +
                '<td>' + _formatTime(r.started_at) + '</td>' +
                '<td><button class="btn btn-sm" onclick="Runs.showOutput(\'' + esc(r.id) + '\')">Output</button></td>' +
                '</tr>';
        }).join('');
    }

    async function triggerSquad() {
        const sel = document.getElementById('run-squad-select');
        const squad = sel.value;
        if (!squad) { toast('Select a squad first', 'error'); return; }
        if (!confirm('Run squad "' + squad + '"?')) return;

        try {
            const run = await apiFetch('/run/squad/' + squad, { method: 'POST' });
            toast('Squad "' + squad + '" started', 'success');
            _startPolling();
            setTimeout(loadRuns, 500);
        } catch (e) {
            toast('Failed to start: ' + e.message, 'error');
        }
    }

    async function cancel(runId) {
        try {
            await apiFetch('/runs/' + runId + '/cancel', { method: 'POST' });
            toast('Run cancelled', 'info');
            loadRuns();
        } catch (e) {
            toast(e.message, 'error');
        }
    }

    async function showOutput(runId) {
        try {
            const run = await apiFetch('/runs/' + runId);
            document.getElementById('output-modal-title').textContent = 'Run: ' + (run.squad || run.agents.join(', '));
            const out = document.getElementById('run-output');
            let text = '';
            if (run.error) text += 'Error: ' + run.error + '\n\n';
            text += run.output || '(no output captured)';
            out.textContent = text;
            document.getElementById('output-overlay').classList.remove('hidden');
        } catch (e) {
            toast(e.message, 'error');
        }
    }

    function closeOutput() {
        document.getElementById('output-overlay').classList.add('hidden');
    }

    function _startPolling() {
        if (pollTimer) return;
        pollTimer = setInterval(() => {
            if (currentView === 'runs') loadRuns();
        }, 3000);
    }

    function _stopPolling() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    // ── Reports ──────────────────────────────────────

    async function loadReportDates() {
        try {
            const data = await apiFetch('/reports/dates');
            reportDates = data.dates || [];
            const sel = document.getElementById('report-date-select');
            sel.innerHTML = '<option value="latest">Latest</option>' +
                reportDates.map(d => '<option value="' + esc(d) + '">' + esc(d) + '</option>').join('');
        } catch (e) { /* ignore */ }
        loadReports();
    }

    async function loadReports() {
        const date = document.getElementById('report-date-select').value || 'latest';
        try {
            const data = await apiFetch('/reports/' + date);
            const grid = document.getElementById('report-grid');
            const reports = data.reports || [];
            if (!reports.length) {
                grid.innerHTML = '<p class="text-muted">No reports found for this date.</p>';
                return;
            }
            grid.innerHTML = reports.map(r => {
                const sizeKb = (r.size / 1024).toFixed(1);
                return '<div class="report-card" onclick="Runs.viewReport(\'' + esc(r.date) + '\', \'' + esc(r.name) + '\')">' +
                    '<div class="rc-icon">📄</div>' +
                    '<div class="rc-info">' +
                    '<strong>' + esc(r.name) + '</strong>' +
                    '<span class="text-muted">' + sizeKb + ' KB — ' + _formatTime(r.modified) + '</span>' +
                    '</div></div>';
            }).join('');
        } catch (e) {
            document.getElementById('report-grid').innerHTML = '<p class="text-muted">Could not load reports.</p>';
        }
    }

    async function viewReport(date, name) {
        try {
            const report = await apiFetch('/reports/' + date + '/' + name);
            document.getElementById('report-modal-title').textContent = report.name;
            document.getElementById('report-meta').innerHTML =
                '<span>Date: ' + esc(report.date) + '</span>' +
                '<span>Size: ' + (report.size / 1024).toFixed(1) + ' KB</span>' +
                '<span>Modified: ' + _formatTime(report.modified) + '</span>';
            document.getElementById('report-content').innerHTML = _renderMarkdown(report.content);
            document.getElementById('report-overlay').classList.remove('hidden');
        } catch (e) {
            toast(e.message, 'error');
        }
    }

    function closeReport() {
        document.getElementById('report-overlay').classList.add('hidden');
    }

    // ── Helpers ──────────────────────────────────────

    function _formatDuration(seconds) {
        if (seconds < 60) return Math.round(seconds) + 's';
        if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + Math.round(seconds % 60) + 's';
        return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
    }

    function _formatTime(iso) {
        if (!iso) return '--';
        try {
            const d = new Date(iso);
            return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        } catch { return iso; }
    }

    function _renderMarkdown(text) {
        // Simple markdown rendering — headers, bold, code blocks, lists
        if (!text) return '<p class="text-muted">(empty report)</p>';

        return text
            // Code blocks
            .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="code-block">$2</pre>')
            // Inline code
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            // Headers
            .replace(/^### (.+)$/gm, '<h4>$1</h4>')
            .replace(/^## (.+)$/gm, '<h3>$1</h3>')
            .replace(/^# (.+)$/gm, '<h2>$1</h2>')
            // Bold
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            // Italic
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            // List items
            .replace(/^- (.+)$/gm, '<li>$1</li>')
            .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
            // Horizontal rule
            .replace(/^---$/gm, '<hr>')
            // Paragraphs (double newline)
            .replace(/\n\n/g, '</p><p>')
            // Wrap in paragraph
            .replace(/^/, '<p>')
            .replace(/$/, '</p>');
    }

    return { render, loadRuns, loadReports, triggerSquad, cancel, showOutput, closeOutput, viewReport, closeReport };
})();
