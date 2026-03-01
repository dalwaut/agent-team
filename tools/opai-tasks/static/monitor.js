/* MonitorHealth — Namespaced Monitor module for TCP Health tab */

const MonitorHealth = (() => {
    // ── Constants ──────────────────────────────────────────
    const API_PREFIX = 'api/monitor/';
    const _wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Health tab loads under /tasks/ Caddy prefix — WS paths go through /tasks/ws/...
    const WS_BASE = `${_wsProto}//${location.host}/tasks`;

    // ── State ──────────────────────────────────────────────
    let wsStats = null;
    let wsAgents = null;
    let wsLogs = null;
    let logPaused = false;
    let logLineCount = 0;
    const MAX_LOG_LINES = 500;
    let _prevNet = null;
    let _prevNetTime = null;
    let _reportRawContent = '';
    let _reportViewMode = 'pretty';
    let _usersData = [];
    let _agentsList = [];
    let updaterFilter = 'all';
    let updaterData = [];
    let _networkLocked = false;
    let _pinAction = null;
    let _claudeProjectsLoaded = false;
    let _docRawContent = '';
    let _docViewMode = 'raw';
    let _lastPlanData = null;
    const _tipContent = {};

    // Track all polling intervals for cleanup
    const _intervals = [];

    // ── Auth ───────────────────────────────────────────────

    function authFetch(url, opts = {}) {
        if (typeof opaiAuth !== 'undefined') {
            return opaiAuth.fetchWithAuth(url, opts);
        }
        return fetch(url, opts);
    }

    // ── Utilities ──────────────────────────────────────────

    function formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
    }

    function formatUptime(seconds) {
        const d = Math.floor(seconds / 86400);
        const h = Math.floor((seconds % 86400) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        if (d > 0) return `${d}d ${h}h`;
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
    }

    function colorForPercent(pct) {
        if (pct >= 90) return 'red';
        if (pct >= 70) return 'orange';
        return 'green';
    }

    function chipClass(status) {
        const map = {
            active: 'chip-active', running: 'chip-running', inactive: 'chip-inactive',
            queued: 'chip-queued', blocked: 'chip-blocked', completed: 'chip-completed',
            failed: 'chip-failed', pending: 'chip-queued',
        };
        return map[status] || '';
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function renderMarkdown(text) {
        let html = escapeHtml(text);

        // Code blocks (fenced) — extract before other transforms
        const codeBlocks = [];
        html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
            codeBlocks.push(`<pre><code class="lang-${lang || 'text'}">${code.replace(/<\/?p>/g, '')}</code></pre>`);
            return `\x00CB${codeBlocks.length - 1}\x00`;
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
                .map((c, i) => `<th style="text-align:${aligns[i] || 'left'}">${c.trim()}</th>`).join('');
            const rows = body.trim().split('\n').map(row => {
                const cells = row.split('|').filter(c => c.trim())
                    .map((c, i) => `<td style="text-align:${aligns[i] || 'left'}">${c.trim()}</td>`).join('');
                return `<tr>${cells}</tr>`;
            }).join('');
            return `<table class="md-table"><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table>`;
        });

        // Checkboxes
        html = html.replace(/^- \[x\] (.+)$/gm, '<li class="task-done"><span class="checkbox checked"></span>$1</li>');
        html = html.replace(/^- \[ \] (.+)$/gm, '<li class="task-todo"><span class="checkbox"></span>$1</li>');

        // Unordered lists
        html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
        html = html.replace(/((?:^<li>.*<\/li>\n?)+)/gm, '<ul>$1</ul>');

        // Ordered lists
        html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
        html = html.replace(/((?:^<li>.*<\/li>\n?)+)/gm, (m) => {
            if (m.startsWith('<ul>') || m.startsWith('<ol>')) return m;
            return `<ol>${m}</ol>`;
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

        // Restore code blocks
        html = html.replace(/\x00CB(\d+)\x00/g, (_, i) => codeBlocks[parseInt(i)]);

        return html;
    }

    // ── WebSocket Management ───────────────────────────────

    function connectWS(path, onMessage, onOpen) {
        const ws = new WebSocket(WS_BASE + path);
        ws.onopen = () => {
            updateConnectionStatus(true);
            if (onOpen) onOpen(ws);
        };
        ws.onmessage = (e) => {
            try {
                const data = JSON.parse(e.data);
                onMessage(data);
            } catch (err) { /* ignore parse errors */ }
        };
        ws.onclose = () => {
            updateConnectionStatus(false);
            // Reconnect after delay
            setTimeout(() => {
                if (path === '/ws/stats') wsStats = connectWS(path, onMessage, onOpen);
                if (path === '/ws/agents') wsAgents = connectWS(path, onMessage, onOpen);
                if (path === '/ws/logs') wsLogs = connectWS(path, onMessage, onOpen);
            }, 3000);
        };
        ws.onerror = () => ws.close();
        return ws;
    }

    function updateConnectionStatus(connected) {
        const dot = document.getElementById('conn-dot');
        const text = document.getElementById('conn-status');
        if (!dot || !text) return;
        if (connected) {
            dot.className = 'status-dot active';
            text.innerHTML = '<span class="status-dot active" id="conn-dot"></span>connected';
        } else {
            dot.className = 'status-dot inactive';
            text.innerHTML = '<span class="status-dot inactive" id="conn-dot"></span>reconnecting...';
        }
    }

    // ── System Stats ───────────────────────────────────────

    function handleStats(data) {
        const cpuPct = data.cpu_percent || 0;
        const memPct = data.memory?.percent || 0;
        const diskPct = data.disk?.percent || 0;
        const load = data.load_avg || [0, 0, 0];

        const statCpu = document.getElementById('stat-cpu');
        if (statCpu) {
            statCpu.textContent = cpuPct.toFixed(1) + '%';
            statCpu.className = 'stat-value ' + colorForPercent(cpuPct);
        }
        const freq = data.cpu_freq;
        const cpuDetail = freq && freq.current
            ? `${data.cpu_count || '--'} cores @ ${(freq.current / 1000).toFixed(1)} GHz`
            : `${data.cpu_count || '--'} cores`;
        const statCpuDetail = document.getElementById('stat-cpu-detail');
        if (statCpuDetail) statCpuDetail.textContent = cpuDetail;
        const barCpu = document.getElementById('bar-cpu');
        if (barCpu) {
            barCpu.style.width = cpuPct + '%';
            barCpu.className = 'progress-fill ' + colorForPercent(cpuPct);
        }

        const statMem = document.getElementById('stat-mem');
        if (statMem) {
            statMem.textContent = memPct.toFixed(1) + '%';
            statMem.className = 'stat-value ' + colorForPercent(memPct);
        }
        const statMemDetail = document.getElementById('stat-mem-detail');
        if (statMemDetail) {
            statMemDetail.textContent =
                `${formatBytes(data.memory?.used || 0)} / ${formatBytes(data.memory?.total || 0)}`;
        }
        const barMem = document.getElementById('bar-mem');
        if (barMem) {
            barMem.style.width = memPct + '%';
            barMem.className = 'progress-fill ' + colorForPercent(memPct);
        }

        const statDisk = document.getElementById('stat-disk');
        if (statDisk) {
            statDisk.textContent = diskPct.toFixed(1) + '%';
            statDisk.className = 'stat-value ' + colorForPercent(diskPct);
        }
        const statDiskDetail = document.getElementById('stat-disk-detail');
        if (statDiskDetail) {
            statDiskDetail.textContent =
                `${formatBytes(data.disk?.used || 0)} / ${formatBytes(data.disk?.total || 0)}`;
        }
        const barDisk = document.getElementById('bar-disk');
        if (barDisk) {
            barDisk.style.width = diskPct + '%';
            barDisk.className = 'progress-fill ' + colorForPercent(diskPct);
        }

        // System disk (/)
        const sysDiskPct = data.disk_system?.percent || 0;
        const statDiskSys = document.getElementById('stat-disk-sys');
        if (statDiskSys) {
            statDiskSys.textContent = sysDiskPct.toFixed(1) + '%';
            statDiskSys.className = 'stat-value ' + colorForPercent(sysDiskPct);
        }
        const statDiskSysDetail = document.getElementById('stat-disk-sys-detail');
        if (statDiskSysDetail) {
            statDiskSysDetail.textContent =
                `${formatBytes(data.disk_system?.used || 0)} / ${formatBytes(data.disk_system?.total || 0)}`;
        }
        const barDiskSys = document.getElementById('bar-disk-sys');
        if (barDiskSys) {
            barDiskSys.style.width = sysDiskPct + '%';
            barDiskSys.className = 'progress-fill ' + colorForPercent(sysDiskPct);
        }

        const statLoad = document.getElementById('stat-load');
        if (statLoad) statLoad.textContent = load[0].toFixed(2);
        const statLoadDetail = document.getElementById('stat-load-detail');
        if (statLoadDetail) statLoadDetail.textContent = `${load[1].toFixed(2)} / ${load[2].toFixed(2)}`;

        const statNetSent = document.getElementById('stat-net-sent');
        if (statNetSent) statNetSent.textContent = formatBytes(data.network?.bytes_sent || 0);
        const statNetRecv = document.getElementById('stat-net-recv');
        if (statNetRecv) statNetRecv.textContent = formatBytes(data.network?.bytes_recv || 0);

        // Network rate (bytes/sec delta)
        const now = Date.now();
        if (_prevNet && _prevNetTime) {
            const dt = (now - _prevNetTime) / 1000;
            if (dt > 0) {
                const sentRate = (data.network.bytes_sent - _prevNet.bytes_sent) / dt;
                const recvRate = (data.network.bytes_recv - _prevNet.bytes_recv) / dt;
                const sentRateEl = document.getElementById('stat-net-sent-rate');
                if (sentRateEl) sentRateEl.textContent = formatBytes(Math.max(0, sentRate)) + '/s';
                const recvRateEl = document.getElementById('stat-net-recv-rate');
                if (recvRateEl) recvRateEl.textContent = formatBytes(Math.max(0, recvRate)) + '/s';
            }
        }
        _prevNet = data.network;
        _prevNetTime = now;

        // Swap
        const swapPct = data.swap?.percent || 0;
        const statSwap = document.getElementById('stat-swap');
        if (statSwap) {
            statSwap.textContent = swapPct.toFixed(1) + '%';
            statSwap.className = 'stat-value ' + colorForPercent(swapPct);
        }
        const statSwapDetail = document.getElementById('stat-swap-detail');
        if (statSwapDetail) {
            statSwapDetail.textContent =
                `${formatBytes(data.swap?.used || 0)} / ${formatBytes(data.swap?.total || 0)}`;
        }
        const barSwap = document.getElementById('bar-swap');
        if (barSwap) {
            barSwap.style.width = swapPct + '%';
            barSwap.className = 'progress-fill ' + colorForPercent(swapPct);
        }

        // Processes
        if (data.process_count != null) {
            const statProcs = document.getElementById('stat-procs');
            if (statProcs) statProcs.textContent = data.process_count;
        }

        if (data.uptime_seconds) {
            const statsUptime = document.getElementById('stats-uptime');
            if (statsUptime) statsUptime.textContent = 'up ' + formatUptime(data.uptime_seconds);
        }
    }

    // ── Agents ─────────────────────────────────────────────

    function handleAgents(data) {
        const agents = data.agents || [];
        const container = document.getElementById('agents-content');
        const badge = document.getElementById('agent-count');
        if (!container || !badge) return;
        badge.textContent = agents.length;

        if (agents.length === 0) {
            container.innerHTML = '<div class="empty-state"><div class="empty-icon">~</div>No agents running</div>';
            return;
        }

        let html = '<table class="data-table"><thead><tr>' +
            '<th>PID</th><th>Name</th><th>CPU%</th><th>MEM%</th><th>Uptime</th><th>Actions</th>' +
            '</tr></thead><tbody>';

        for (const a of agents) {
            html += `<tr>
                <td>${a.pid}</td>
                <td title="${escapeHtml(a.cmdline)}">${escapeHtml(a.name)}</td>
                <td class="${colorForPercent(a.cpu_percent) === 'red' ? 'text-red' : ''}">${a.cpu_percent.toFixed(1)}</td>
                <td>${a.memory_percent.toFixed(1)}</td>
                <td>${formatUptime(a.uptime_seconds)}</td>
                <td class="btn-group"><button class="btn btn-primary" onclick="MonitorHealth.openAgent(${a.pid})">Open</button><button class="btn btn-danger" onclick="MonitorHealth.killAgent(${a.pid})">Kill</button></td>
            </tr>`;
        }

        html += '</tbody></table>';
        container.innerHTML = html;
    }

    // ── Logs ───────────────────────────────────────────────

    function handleLogMessage(data) {
        if (logPaused) return;

        const viewer = document.getElementById('log-viewer');
        if (!viewer) return;
        const filterEl = document.getElementById('log-filter');
        const filter = filterEl ? filterEl.value.toLowerCase() : '';

        if (data.type === 'history') {
            for (const entry of (data.entries || [])) {
                appendLogLine(viewer, entry, filter);
            }
        } else if (data.type === 'log') {
            appendLogLine(viewer, data.entry, filter);
        }

        const logCount = document.getElementById('log-count');
        if (logCount) logCount.textContent = logLineCount + ' lines';
    }

    function appendLogLine(viewer, entry, filter) {
        if (!entry || !entry.text) return;
        if (filter && !entry.text.toLowerCase().includes(filter)) return;

        const line = document.createElement('div');
        line.className = 'log-line fade-in';

        const source = entry.source || '';
        const ts = entry.timestamp ? new Date(entry.timestamp * 1000).toLocaleTimeString() : '';

        line.innerHTML = `<span class="log-source">[${escapeHtml(source)}]</span>` +
            `<span class="log-time">${ts}</span>` +
            `<span class="log-text">${escapeHtml(entry.text)}</span>`;

        viewer.appendChild(line);
        logLineCount++;

        // Trim old lines
        while (viewer.children.length > MAX_LOG_LINES) {
            viewer.removeChild(viewer.firstChild);
            logLineCount--;
        }

        // Auto-scroll
        viewer.scrollTop = viewer.scrollHeight;
    }

    function clearLogs() {
        const viewer = document.getElementById('log-viewer');
        if (viewer) viewer.innerHTML = '';
        logLineCount = 0;
        const logCount = document.getElementById('log-count');
        if (logCount) logCount.textContent = '0 lines';
    }

    function toggleLogPause() {
        logPaused = !logPaused;
        const btn = document.getElementById('log-pause-btn');
        if (btn) {
            btn.textContent = logPaused ? 'Resume' : 'Pause';
            btn.className = logPaused ? 'btn btn-warning' : 'btn';
        }
    }

    // ── Services ───────────────────────────────────────────

    async function loadServices() {
        try {
            const res = await fetch(API_PREFIX + 'system/services');
            const services = await res.json();
            const container = document.getElementById('services-content');
            if (!container) return;

            if (!services.length) {
                container.innerHTML = '<div class="empty-state">No services found</div>';
                return;
            }

            let html = '<table class="data-table"><thead><tr>' +
                '<th>Service</th><th>Status</th><th>PID</th><th>Actions</th>' +
                '</tr></thead><tbody>';

            for (const s of services) {
                const isActive = s.active === 'active';
                const chipCls = isActive ? 'chip-active' : 'chip-inactive';

                html += `<tr>
                    <td>${escapeHtml(s.name)}</td>
                    <td><span class="chip ${chipCls}">${s.active}/${s.sub}</span></td>
                    <td>${s.pid || '--'}</td>
                    <td class="btn-group">
                        <button class="btn btn-success" onclick="MonitorHealth.controlService('${s.name}','start')">Start</button>
                        <button class="btn btn-danger" onclick="MonitorHealth.controlService('${s.name}','stop')">Stop</button>
                        <button class="btn btn-warning" onclick="MonitorHealth.controlService('${s.name}','restart')">Restart</button>
                    </td>
                </tr>`;
            }

            html += '</tbody></table>';
            container.innerHTML = html;
        } catch (e) {
            const container = document.getElementById('services-content');
            if (container) container.innerHTML = '<div class="empty-state">Failed to load services</div>';
        }
    }

    // ── Squad Status ───────────────────────────────────────

    async function loadSquad() {
        try {
            const res = await fetch(API_PREFIX + 'squad');
            const data = await res.json();
            const container = document.getElementById('squad-content');
            const badge = document.getElementById('squad-badge');
            if (!container) return;

            const orch = data.orchestrator;
            let html = '';

            if (orch) {
                const stats = orch.stats || {};
                html += `<div class="stats-grid" style="margin-bottom:12px">
                    <div class="stat-card">
                        <div class="stat-label">Jobs Run</div>
                        <div class="stat-value blue">${stats.totalJobsRun || 0}</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-label">Jobs Failed</div>
                        <div class="stat-value ${stats.totalJobsFailed > 0 ? 'red' : ''}">${stats.totalJobsFailed || 0}</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-label">Restarts</div>
                        <div class="stat-value ${stats.totalRestarts > 10 ? 'orange' : ''}">${stats.totalRestarts || 0}</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-label">Active Jobs</div>
                        <div class="stat-value green">${Object.keys(orch.activeJobs || {}).length}</div>
                    </div>
                </div>`;

                // Service health
                const health = orch.serviceHealth || {};
                if (Object.keys(health).length) {
                    html += '<div class="mb-8"><strong class="text-muted text-sm">SERVICE HEALTH</strong></div>';
                    for (const [name, info] of Object.entries(health)) {
                        const isActive = info.active;
                        html += `<div style="margin-bottom:4px">
                            <span class="status-dot ${isActive ? 'active' : 'inactive'}"></span>
                            <span class="text-mono text-sm">${escapeHtml(name)}</span>
                            <span class="chip ${isActive ? 'chip-active' : 'chip-inactive'}">${isActive ? 'active' : 'inactive'}</span>
                        </div>`;
                    }
                }

                if (badge) badge.textContent = `${Object.keys(orch.activeJobs || {}).length} jobs`;
            } else {
                html += '<div class="empty-state">Orchestrator state unavailable</div>';
                if (badge) badge.textContent = '--';
            }

            // Available squads
            if (data.available_squads?.length) {
                html += '<div class="mt-8 mb-8"><strong class="text-muted text-sm">AVAILABLE SQUADS</strong></div>';
                html += '<div class="btn-group" style="flex-wrap:wrap">';
                for (const sq of data.available_squads) {
                    html += `<span class="chip chip-running">${sq}</span>`;
                }
                html += '</div>';
            }

            container.innerHTML = html;
        } catch (e) {
            const container = document.getElementById('squad-content');
            if (container) container.innerHTML = '<div class="empty-state">Failed to load squad status</div>';
        }
    }

    // ── Reports ────────────────────────────────────────────

    async function loadReports() {
        try {
            const dateSelect = document.getElementById('report-date-select');
            const dateFilter = dateSelect ? dateSelect.value : '';
            const url = dateFilter ? `${API_PREFIX}reports?date=${dateFilter}` : `${API_PREFIX}reports`;
            const res = await fetch(url);
            const data = await res.json();
            const list = document.getElementById('reports-list');
            const select = document.getElementById('report-date-select');
            if (!list) return;

            // Populate date dropdown (only on first load)
            if (select && select.options.length <= 1 && data.dates) {
                for (const special of ['latest', 'hitl', 'archive']) {
                    const opt = document.createElement('option');
                    opt.value = special;
                    opt.textContent = special;
                    select.appendChild(opt);
                }
                for (const d of data.dates) {
                    const opt = document.createElement('option');
                    opt.value = d;
                    opt.textContent = d;
                    select.appendChild(opt);
                }
            }

            const reports = data.reports || [];
            if (!reports.length) {
                list.innerHTML = '<div class="empty-state">No reports found</div>';
                return;
            }

            let html = '';
            for (const r of reports) {
                const date = r.date || 'standalone';
                html += `<li class="report-item" onclick="MonitorHealth.openReport('${date}', '${escapeHtml(r.filename)}')">
                    <div>
                        <span class="report-name">${escapeHtml(r.filename)}</span>
                        <span class="report-date">${date}</span>
                    </div>
                    <span class="report-size">${formatBytes(r.size)}</span>
                </li>`;
            }
            list.innerHTML = html;
        } catch (e) {
            const list = document.getElementById('reports-list');
            if (list) list.innerHTML = '<div class="empty-state">Failed to load reports</div>';
        }
    }

    async function openReport(date, filename) {
        try {
            const res = await fetch(`${API_PREFIX}reports/${date}/${filename}`);
            const data = await res.json();
            _reportRawContent = data.content || 'Empty report';
            _reportViewMode = 'pretty';
            const titleEl = document.getElementById('report-modal-title');
            if (titleEl) titleEl.textContent = `${date}/${filename}`;
            updateReportView();
            updateReportToggle();
            const modal = document.getElementById('report-modal');
            if (modal) modal.classList.add('visible');
        } catch (e) {
            alert('Failed to load report');
        }
    }

    function toggleReportView(mode) {
        _reportViewMode = mode;
        updateReportView();
        updateReportToggle();
    }

    function updateReportView() {
        const el = document.getElementById('report-modal-content');
        if (!el) return;
        if (_reportViewMode === 'raw') {
            el.className = 'report-raw-content';
            el.textContent = _reportRawContent;
        } else {
            el.className = 'markdown-content';
            el.innerHTML = renderMarkdown(_reportRawContent);
        }
    }

    function updateReportToggle() {
        document.querySelectorAll('.report-view-toggle .toggle-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === _reportViewMode);
        });
    }

    function closeReportModal() {
        const modal = document.getElementById('report-modal');
        if (modal) modal.classList.remove('visible');
    }

    // ── Task Queue ─────────────────────────────────────────

    async function loadQueue() {
        try {
            const res = await fetch(API_PREFIX + 'tasks/queue');
            const data = await res.json();
            const container = document.getElementById('queue-content');
            if (!container) return;

            if (!data || !data.queue?.length) {
                container.innerHTML = '<div class="empty-state">Queue is empty</div>';
                return;
            }

            let html = '<table class="data-table"><thead><tr>' +
                '<th>ID</th><th>Type</th><th>Status</th><th>Priority</th><th>Description</th>' +
                '</tr></thead><tbody>';

            for (const item of data.queue) {
                const chipCls = chipClass(item.status);
                html += `<tr>
                    <td>${escapeHtml(item.id)}</td>
                    <td>${escapeHtml(item.type)}</td>
                    <td><span class="chip ${chipCls}">${item.status}</span></td>
                    <td>${escapeHtml(item.priority || '--')}</td>
                    <td title="${escapeHtml(item.description)}">${escapeHtml(item.description).substring(0, 60)}</td>
                </tr>`;
            }

            html += '</tbody></table>';

            // Also show registry summary
            try {
                const regRes = await fetch(API_PREFIX + 'tasks/registry/summary');
                const regData = await regRes.json();
                if (regData.total > 0) {
                    html += `<div class="mt-8"><strong class="text-muted text-sm">REGISTRY: ${regData.total} tasks</strong></div>`;
                    html += '<div class="btn-group mt-8">';
                    for (const [status, count] of Object.entries(regData.by_status)) {
                        html += `<span class="chip ${chipClass(status)}">${status}: ${count}</span>`;
                    }
                    html += '</div>';
                }
            } catch (e) { /* ignore */ }

            container.innerHTML = html;
        } catch (e) {
            const container = document.getElementById('queue-content');
            if (container) container.innerHTML = '<div class="empty-state">Failed to load queue</div>';
        }
    }

    // ── System Changes (Updater) ──────────────────────────

    function setUpdaterFilter(filter) {
        updaterFilter = filter;
        document.querySelectorAll('#updater-tabs .filter-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.filter === filter);
        });
        renderUpdaterSuggestions();
    }

    async function loadUpdaterSuggestions() {
        try {
            const res = await fetch(API_PREFIX + 'updater/suggestions');
            const data = await res.json();
            updaterData = data.suggestions || [];

            const actionable = updaterData.filter(s => s.kind === 'update' && s.status === 'pending');
            const countEl = document.getElementById('updater-count');
            if (countEl) {
                countEl.textContent = actionable.length || '';
                countEl.dataset.count = actionable.length;
            }

            renderUpdaterSuggestions();
        } catch (e) { /* ignore */ }
    }

    function renderUpdaterSuggestions() {
        const container = document.getElementById('updater-content');
        if (!container) return;

        let filtered;
        if (updaterFilter === 'update') {
            filtered = updaterData.filter(s => s.kind === 'update' && s.status !== 'archived');
        } else if (updaterFilter === 'notice') {
            filtered = updaterData.filter(s => s.kind === 'notice' && s.status !== 'archived');
        } else if (updaterFilter === 'archived') {
            filtered = updaterData.filter(s => s.status === 'archived');
        } else {
            filtered = updaterData.filter(s => s.status !== 'archived');
        }

        if (!filtered.length) {
            const msg = updaterFilter === 'archived' ? 'No archived items' :
                        updaterFilter === 'update' ? 'No pending updates' :
                        updaterFilter === 'notice' ? 'No notices' :
                        'No changes detected. System is in sync.';
            container.innerHTML = `<div class="empty-state">${msg}</div>`;
            return;
        }

        let html = '';
        for (const s of filtered) {
            const kind = s.kind || 'notice';
            const statusCls = `status-${s.status || 'pending'}`;

            html += `<div class="suggestion-item kind-${kind} ${statusCls}">
                <div class="suggestion-header">
                    <div class="suggestion-header-left">
                        <span class="suggestion-kind kind-${kind}">${kind}</span>
                        <span class="suggestion-title">${escapeHtml(s.title)}</span>
                    </div>
                    <div class="suggestion-btns">`;

            if (s.status === 'pending') {
                if (kind === 'update') {
                    html += `<button class="btn btn-primary" onclick="MonitorHealth.createTaskFromSuggestion('${s.id}')">Create Task</button>`;
                }
                html += `<button class="btn" onclick="MonitorHealth.archiveSuggestion('${s.id}')">Archive</button>`;
            } else if (s.status === 'tasked') {
                html += `<span class="chip chip-completed">tasked${s.task_id ? ': ' + escapeHtml(s.task_id) : ''}</span>`;
            } else if (s.status === 'archived') {
                html += `<span class="chip chip-inactive">archived</span>`;
            }

            html += `</div></div>
                <div class="suggestion-body">${escapeHtml(s.description)}</div>`;

            if (s.suggested_actions?.length) {
                html += '<ul class="suggestion-actions">';
                for (const action of s.suggested_actions) {
                    html += `<li>${escapeHtml(action)}</li>`;
                }
                html += '</ul>';
            }

            if (s.created_at) {
                html += `<div class="suggestion-meta">${new Date(s.created_at).toLocaleString()}</div>`;
            }

            html += '</div>';
        }
        container.innerHTML = html;
    }

    async function archiveSuggestion(id) {
        try {
            const res = await authFetch(`${API_PREFIX}updater/suggestions/${id}/archive`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                showActionResult(`Archived: ${id}`, 'green');
                await loadUpdaterSuggestions();
            } else {
                showActionResult(`Archive failed: ${data.detail || 'unknown'}`, 'red');
            }
        } catch (e) {
            showActionResult('Failed to archive suggestion', 'red');
        }
    }

    async function createTaskFromSuggestion(id) {
        if (!confirm(`Create a task from suggestion "${id}"?`)) return;
        try {
            const res = await authFetch(`${API_PREFIX}updater/suggestions/${id}/task`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                showActionResult(`Task created: ${data.task_id}`, 'green');
                await loadUpdaterSuggestions();
            } else {
                showActionResult(`Task creation failed: ${data.detail || 'unknown'}`, 'red');
            }
        } catch (e) {
            showActionResult('Failed to create task', 'red');
        }
    }

    function toggleUpdaterPanel() {
        const panel = document.getElementById('panel-updater');
        if (!panel) return;
        panel.style.display = panel.style.display === 'none' ? '' : 'none';
        if (panel.style.display !== 'none') {
            loadUpdaterSuggestions();
        }
    }

    // ── Actions ────────────────────────────────────────────

    async function killAgent(pid) {
        if (!confirm(`Kill agent PID ${pid}?`)) return;
        try {
            const res = await authFetch(`${API_PREFIX}agents/${pid}/kill`, { method: 'POST' });
            const data = await res.json();
            showActionResult(data.success ? `Killed PID ${pid}` : `Failed: ${data.error || data.detail}`,
                data.success ? 'green' : 'red');
        } catch (e) {
            showActionResult('Failed to kill agent', 'red');
        }
    }

    async function openAgent(pid) {
        const titleEl = document.getElementById('agent-modal-title');
        if (titleEl) titleEl.textContent = `Agent Session — PID ${pid}`;
        const contentEl = document.getElementById('agent-modal-content');
        if (contentEl) contentEl.innerHTML = '<div class="empty-state">Loading...</div>';
        const modal = document.getElementById('agent-modal');
        if (modal) modal.classList.add('visible');

        try {
            const res = await fetch(`${API_PREFIX}agents/${pid}`);
            if (!res.ok) {
                if (contentEl) contentEl.innerHTML =
                    '<div class="empty-state">Agent process not found (may have exited)</div>';
                return;
            }
            const a = await res.json();

            let html = '<div class="agent-detail">';
            html += `<div class="agent-detail-grid">
                <div class="stat-card"><div class="stat-label">PID</div><div class="stat-value blue">${a.pid}</div></div>
                <div class="stat-card"><div class="stat-label">Status</div><div class="stat-value green">${escapeHtml(a.status)}</div></div>
                <div class="stat-card"><div class="stat-label">CPU</div><div class="stat-value ${colorForPercent(a.cpu_percent)}">${a.cpu_percent.toFixed(1)}%</div></div>
                <div class="stat-card"><div class="stat-label">Memory</div><div class="stat-value">${a.memory_percent}%</div>
                    <div class="stat-sub">${formatBytes(a.memory_rss)} RSS</div></div>
                <div class="stat-card"><div class="stat-label">Uptime</div><div class="stat-value">${formatUptime(a.uptime_seconds)}</div>
                    <div class="stat-sub">since ${new Date(a.started_at).toLocaleString()}</div></div>
                <div class="stat-card"><div class="stat-label">Threads / FDs</div><div class="stat-value">${a.num_threads} / ${a.num_fds}</div></div>
            </div>`;

            html += `<div class="agent-detail-section">
                <div class="agent-detail-label">Name</div>
                <div class="agent-detail-value">${escapeHtml(a.name)}</div>
            </div>`;

            if (a.cwd) {
                html += `<div class="agent-detail-section">
                    <div class="agent-detail-label">Working Directory</div>
                    <div class="agent-detail-value text-mono">${escapeHtml(a.cwd)}</div>
                </div>`;
            }

            html += `<div class="agent-detail-section">
                <div class="agent-detail-label">Command</div>
                <div class="agent-detail-cmd">${escapeHtml(a.cmdline)}</div>
            </div>`;

            if (a.cmdline_args && a.cmdline_args.length > 1) {
                html += `<div class="agent-detail-section">
                    <div class="agent-detail-label">Arguments</div>
                    <div class="agent-detail-cmd">${a.cmdline_args.map(arg => escapeHtml(arg)).join('\n')}</div>
                </div>`;
            }

            html += `<div class="form-actions" style="margin-top:16px;">
                <button class="btn btn-danger" onclick="MonitorHealth.killAgent(${a.pid}); MonitorHealth.closeAgentModal();">Kill Process</button>
            </div>`;
            html += '</div>';

            if (titleEl) titleEl.textContent = `Agent Session — ${escapeHtml(a.name)}`;
            if (contentEl) contentEl.innerHTML = html;
        } catch (e) {
            if (contentEl) contentEl.innerHTML =
                '<div class="empty-state">Failed to load agent details</div>';
        }
    }

    function closeAgentModal() {
        const modal = document.getElementById('agent-modal');
        if (modal) modal.classList.remove('visible');
    }

    async function killAllAgents() {
        if (!confirm('Kill ALL running agents? This is an emergency stop.')) return;
        try {
            const res = await authFetch(`${API_PREFIX}agents/kill-all`, { method: 'POST' });
            const data = await res.json();
            showActionResult(`Killed ${data.count} agents`, data.success ? 'green' : 'red');
        } catch (e) {
            showActionResult('Failed to kill agents', 'red');
        }
    }

    async function startAllServices() {
        const btn = document.getElementById('startAllBtn');
        if (!btn) return;
        const origText = btn.textContent;
        btn.textContent = 'Starting...';
        btn.disabled = true;
        try {
            const res = await authFetch(`${API_PREFIX}system/start-all`, { method: 'POST' });
            const data = await res.json();
            const parts = [];
            if (data.started?.length) parts.push(`Started: ${data.started.join(', ')}`);
            if (data.already_running?.length) parts.push(`Already running: ${data.already_running.join(', ')}`);
            if (data.errors?.length) parts.push(`Errors: ${data.errors.map(e => e.unit).join(', ')}`);
            showActionResult(parts.join(' | ') || 'All services checked', data.success ? 'green' : 'orange');
            setTimeout(loadServices, 2000);
        } catch (e) {
            showActionResult('Failed to start services', 'red');
        } finally {
            btn.textContent = origText;
            btn.disabled = false;
        }
    }

    async function emergencyStop() {
        if (!confirm('EMERGENCY STOP: Kill all agents AND stop all services?')) return;
        await killAllAgents();
        for (const svc of ['opai-orchestrator', 'opai-discord-bot']) {
            await controlService(svc, 'stop');
        }
    }

    async function controlService(name, action) {
        try {
            const res = await authFetch(`${API_PREFIX}system/services/${name}/${action}`, { method: 'POST' });
            const data = await res.json();
            showActionResult(
                data.success ? `${action} ${name}: OK` : `${action} ${name}: ${data.error || data.detail}`,
                data.success ? 'green' : 'red'
            );
            setTimeout(loadServices, 1500);
        } catch (e) {
            showActionResult(`Failed to ${action} ${name}`, 'red');
        }
    }

    async function processQueue() {
        try {
            const res = await authFetch(`${API_PREFIX}tasks/queue/process`, { method: 'POST' });
            const data = await res.json();
            showActionResult(
                data.success ? 'Queue processed successfully' : `Queue processing failed: ${data.error || data.detail}`,
                data.success ? 'green' : 'red'
            );
            setTimeout(loadQueue, 2000);
        } catch (e) {
            showActionResult('Failed to process queue', 'red');
        }
    }

    function showActionResult(msg, color) {
        const el = document.getElementById('action-result');
        if (!el) return;
        el.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        el.className = `mt-8 text-mono text-sm text-${color}`;
        setTimeout(() => { el.textContent = ''; }, 8000);
    }

    // ── User Controls ─────────────────────────────────────

    async function loadUsers() {
        // Skip if auth not ready yet (prevents redirect loop)
        if (typeof opaiAuth !== 'undefined' && !opaiAuth.getUser()) return;
        try {
            const res = await authFetch(API_PREFIX + 'users');
            if (!res.ok) return;
            const data = await res.json();
            _usersData = data.users || [];
            const badge = document.getElementById('users-badge');
            if (badge) {
                const activeCount = _usersData.filter(u => u.is_active).length;
                badge.textContent = `${activeCount}/${_usersData.length}`;
            }

            renderUsersTable();

            // Check if drop-all is active
            const settingRes = await authFetch(API_PREFIX + 'system/settings/users_enabled').catch(() => null);
            if (settingRes && settingRes.ok) {
                const setting = await settingRes.json();
                const enabled = setting.value?.enabled !== false;
                const banner = document.getElementById('drop-banner');
                if (banner) banner.style.display = enabled ? 'none' : '';
                const dropBtn = document.getElementById('dropAllBtn');
                if (dropBtn) dropBtn.textContent = enabled ? 'Drop All Users' : 'Users Dropped';
            }
        } catch (e) {
            const container = document.getElementById('users-content');
            if (container) container.innerHTML = '<div class="empty-state">Failed to load users</div>';
        }
    }

    function renderUsersTable() {
        const container = document.getElementById('users-content');
        if (!container) return;
        if (!_usersData.length) {
            container.innerHTML = '<div class="empty-state">No users found</div>';
            return;
        }

        let html = '<table class="data-table"><thead><tr>' +
            '<th></th><th>Name</th><th>Email</th><th>Role</th><th>Active</th>' +
            '<th>Apps</th><th>Preface</th><th>Actions</th>' +
            '</tr></thead><tbody>';

        for (const u of _usersData) {
            const dotCls = u.is_active ? 'active' : 'inactive';
            const roleCls = u.role === 'admin' ? 'chip-running' : 'chip-queued';
            const apps = (u.allowed_apps || []).map(a =>
                `<span class="chip chip-active">${escapeHtml(a)}</span>`
            ).join(' ') || '<span class="text-muted">--</span>';
            const hasPreface = u.preface_prompt ? '<span class="preface-indicator" title="Has preface prompt">P</span>' : '';

            html += `<tr>
                <td><span class="status-dot ${dotCls}"></span></td>
                <td>${escapeHtml(u.display_name || '--')}</td>
                <td>${escapeHtml(u.email)}</td>
                <td><span class="chip ${roleCls}">${u.role}</span></td>
                <td>
                    <button class="btn ${u.is_active ? 'btn-success' : 'btn-danger'} user-toggle"
                        onclick="MonitorHealth.toggleUserActive('${u.id}', ${!u.is_active})">
                        ${u.is_active ? 'ON' : 'OFF'}
                    </button>
                </td>
                <td>${apps}</td>
                <td>${hasPreface}</td>
                <td>
                    <button class="btn btn-primary" onclick="MonitorHealth.openEditUserModal('${u.id}')">Edit</button>
                </td>
            </tr>`;
        }

        html += '</tbody></table>';
        container.innerHTML = html;
    }

    async function toggleUserActive(userId, newState) {
        try {
            const res = await authFetch(`${API_PREFIX}users/${userId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ is_active: newState }),
            });
            const data = await res.json();
            if (data.success) {
                showActionResult(`User ${newState ? 'enabled' : 'disabled'}`, 'green');
                await loadUsers();
            } else {
                showActionResult('Failed to update user', 'red');
            }
        } catch (e) {
            showActionResult('Failed to update user', 'red');
        }
    }

    // ── Invite Modal ──────────────────────────────────────

    function openInviteModal() {
        const fields = ['invite-email', 'invite-name', 'invite-preface', 'invite-tailscale', 'invite-message'];
        fields.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        const roleEl = document.getElementById('invite-role');
        if (roleEl) roleEl.value = 'user';
        document.querySelectorAll('#invite-apps input[type=checkbox]').forEach(cb => cb.checked = false);
        const modal = document.getElementById('invite-modal');
        if (modal) modal.classList.add('visible');
    }

    function closeInviteModal() {
        const modal = document.getElementById('invite-modal');
        if (modal) modal.classList.remove('visible');
    }

    async function sendInvite() {
        const emailEl = document.getElementById('invite-email');
        const email = emailEl ? emailEl.value.trim() : '';
        if (!email) { alert('Email is required'); return; }

        const allowedApps = [];
        document.querySelectorAll('#invite-apps input[type=checkbox]:checked').forEach(cb => {
            allowedApps.push(cb.value);
        });

        const body = {
            email,
            display_name: (document.getElementById('invite-name')?.value || '').trim(),
            role: document.getElementById('invite-role')?.value || 'user',
            preface_prompt: (document.getElementById('invite-preface')?.value || '').trim(),
            allowed_apps: allowedApps,
            tailscale_invite: (document.getElementById('invite-tailscale')?.value || '').trim(),
            custom_message: (document.getElementById('invite-message')?.value || '').trim(),
        };

        try {
            const res = await authFetch(`${API_PREFIX}users/invite`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json();
            if (data.success) {
                showActionResult(`Invite sent to ${email}`, 'green');
                closeInviteModal();
                await loadUsers();
            } else {
                showActionResult(`Invite failed: ${data.detail || 'unknown'}`, 'red');
            }
        } catch (e) {
            showActionResult('Failed to send invite', 'red');
        }
    }

    // ── Edit User Modal ───────────────────────────────────

    async function openEditUserModal(userId) {
        const user = _usersData.find(u => u.id === userId);
        if (!user) return;

        const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
        setVal('edit-user-id', userId);
        setVal('edit-user-name', user.display_name || '');
        setVal('edit-user-role', user.role || 'user');
        setVal('edit-user-active', user.is_active ? 'true' : 'false');
        setVal('edit-user-preface', user.preface_prompt || '');
        setVal('edit-user-sandbox', user.sandbox_path || '');

        // Dynamically load app list from opai-users service
        const appsContainer = document.getElementById('edit-user-apps');
        const userApps = user.allowed_apps || [];
        if (appsContainer) {
            try {
                const res = await fetch('/users/api/apps');
                const data = await res.json();
                if (data.apps && data.apps.length) {
                    appsContainer.innerHTML = data.apps.map(a =>
                        `<label class="checkbox-label"><input type="checkbox" value="${a.id}" ${userApps.includes(a.id) ? 'checked' : ''}> ${a.label}</label>`
                    ).join('');
                } else {
                    appsContainer.innerHTML = '<span class="text-muted">No apps found</span>';
                }
            } catch (e) {
                appsContainer.innerHTML = '<span class="text-muted">Failed to load apps</span>';
            }
        }

        // Load agents list from team.json
        await loadAgentsList();
        const agentsContainer = document.getElementById('edit-user-agents');
        const userAgents = user.allowed_agents || [];
        if (agentsContainer) {
            if (_agentsList.length) {
                agentsContainer.innerHTML = _agentsList.map(a =>
                    `<label class="checkbox-label"><input type="checkbox" value="${a}" ${userAgents.includes(a) ? 'checked' : ''}> ${a}</label>`
                ).join('');
            } else {
                agentsContainer.innerHTML = '<span class="text-muted">No agents found</span>';
            }
        }

        const titleEl = document.getElementById('edit-user-title');
        if (titleEl) titleEl.textContent = `Edit: ${user.display_name || user.email}`;
        const modal = document.getElementById('edit-user-modal');
        if (modal) modal.classList.add('visible');
    }

    function closeEditUserModal() {
        const modal = document.getElementById('edit-user-modal');
        if (modal) modal.classList.remove('visible');
    }

    async function loadAgentsList() {
        if (_agentsList.length) return;
        try {
            const res = await fetch(API_PREFIX + 'team');
            const data = await res.json();
            if (data.agents) {
                _agentsList = data.agents.map(a => a.name || a.role).filter(Boolean);
            }
        } catch (e) { /* ignore */ }
    }

    async function saveUser() {
        const userIdEl = document.getElementById('edit-user-id');
        const userId = userIdEl ? userIdEl.value : '';
        if (!userId) return;

        const allowedApps = [];
        document.querySelectorAll('#edit-user-apps input[type=checkbox]:checked').forEach(cb => {
            allowedApps.push(cb.value);
        });

        const allowedAgents = [];
        document.querySelectorAll('#edit-user-agents input[type=checkbox]:checked').forEach(cb => {
            allowedAgents.push(cb.value);
        });

        const body = {
            display_name: (document.getElementById('edit-user-name')?.value || '').trim(),
            role: document.getElementById('edit-user-role')?.value || 'user',
            is_active: document.getElementById('edit-user-active')?.value === 'true',
            preface_prompt: document.getElementById('edit-user-preface')?.value || '',
            allowed_apps: allowedApps,
            allowed_agents: allowedAgents,
            sandbox_path: (document.getElementById('edit-user-sandbox')?.value || '').trim(),
        };

        try {
            const res = await authFetch(`${API_PREFIX}users/${userId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json();
            if (data.success) {
                showActionResult('User updated', 'green');
                closeEditUserModal();
                await loadUsers();
            } else {
                showActionResult(`Update failed: ${data.detail || 'unknown'}`, 'red');
            }
        } catch (e) {
            showActionResult('Failed to update user', 'red');
        }
    }

    // ── Drop All / Restore All ────────────────────────────

    async function dropAllUsers() {
        if (!confirm('Deactivate ALL non-admin users? This is a global kill switch.')) return;
        if (!confirm('Are you sure? All non-admin users will lose access immediately.')) return;

        try {
            const res = await authFetch(`${API_PREFIX}users/drop-all`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                showActionResult('All non-admin users deactivated', 'red');
                await loadUsers();
            } else {
                showActionResult(`Drop failed: ${data.detail || 'unknown'}`, 'red');
            }
        } catch (e) {
            showActionResult('Failed to drop users', 'red');
        }
    }

    async function restoreAllUsers() {
        if (!confirm('Re-enable ALL users?')) return;
        try {
            const res = await authFetch(`${API_PREFIX}users/restore-all`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                showActionResult('All users re-enabled', 'green');
                await loadUsers();
            } else {
                showActionResult(`Restore failed: ${data.detail || 'unknown'}`, 'red');
            }
        } catch (e) {
            showActionResult('Failed to restore users', 'red');
        }
    }

    // ── Network Lockdown ──────────────────────────────────

    async function checkNetworkStatus() {
        if (typeof opaiAuth !== 'undefined' && !opaiAuth.getUser()) return;
        try {
            const res = await authFetch(API_PREFIX + 'system/network/status');
            if (!res.ok) return;
            const data = await res.json();
            _networkLocked = data.locked === true;
            updateNetworkButton();
        } catch (e) { /* ignore */ }
    }

    function updateNetworkButton() {
        const btn = document.getElementById('killNetBtn');
        if (!btn) return;
        if (_networkLocked) {
            btn.textContent = 'LOCKED';
            btn.className = 'header-btn header-btn-danger active';
        } else {
            btn.textContent = 'Kill Net';
            btn.className = 'header-btn header-btn-danger';
        }
    }

    function toggleNetworkLockdown() {
        _pinAction = _networkLocked ? 'restore' : 'lockdown';
        const title = _networkLocked ? 'Restore Networking' : 'Confirm Network Lockdown';
        const desc = _networkLocked
            ? 'Enter PIN to restore all network connectivity'
            : 'Enter PIN to kill ALL external connections (Tailscale, UFW, RustDesk)';

        const titleEl = document.getElementById('pin-modal-title');
        if (titleEl) titleEl.textContent = title;
        const descEl = document.getElementById('pin-modal-desc');
        if (descEl) descEl.textContent = desc;
        const confirmBtn = document.getElementById('pin-confirm-btn');
        if (confirmBtn) {
            confirmBtn.textContent = _networkLocked ? 'Restore' : 'Lock Down';
            confirmBtn.className = _networkLocked ? 'btn btn-success' : 'btn btn-danger';
        }
        const pinInput = document.getElementById('pin-input');
        if (pinInput) pinInput.value = '';
        const modal = document.getElementById('pin-modal');
        if (modal) modal.classList.add('visible');
        setTimeout(() => { if (pinInput) pinInput.focus(); }, 100);
    }

    function closePinModal() {
        const modal = document.getElementById('pin-modal');
        if (modal) modal.classList.remove('visible');
        _pinAction = null;
    }

    async function confirmPinAction() {
        const pinInput = document.getElementById('pin-input');
        const pin = pinInput ? pinInput.value : '';
        if (!pin) { alert('PIN is required'); return; }

        const endpoint = _pinAction === 'restore'
            ? API_PREFIX + 'system/network/restore'
            : API_PREFIX + 'system/network/lockdown';

        try {
            const res = await authFetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pin }),
            });
            const data = await res.json();
            if (data.success) {
                showActionResult(
                    _pinAction === 'restore' ? 'Network restored' : 'Network LOCKED DOWN',
                    _pinAction === 'restore' ? 'green' : 'red'
                );
                _networkLocked = _pinAction === 'lockdown';
                updateNetworkButton();
                closePinModal();
            } else {
                showActionResult(`Failed: ${data.detail || 'Invalid PIN'}`, 'red');
            }
        } catch (e) {
            showActionResult('Network action failed', 'red');
        }
    }

    // ── Claude Usage ──────────────────────────────────────

    function formatTokens(n) {
        if (n == null || isNaN(n)) return '--';
        if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
        if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
        return String(n);
    }

    function formatTokensFull(n) {
        if (n == null || isNaN(n)) return '--';
        return n.toLocaleString();
    }

    async function loadClaudeUsage() {
        try {
            const res = await fetch(API_PREFIX + 'claude/usage');
            if (!res.ok) return;
            const data = await res.json();
            renderClaudeUsage(data);
        } catch (e) { /* ignore */ }
    }

    function buildBlockBar(pct, colorClass) {
        const TOTAL_CHARS = 50;
        const filled = Math.round((pct / 100) * TOTAL_CHARS);
        let bar = '';
        for (let i = 0; i < filled; i++) bar += '\u2588';
        const frac = ((pct / 100) * TOTAL_CHARS) - filled;
        if (frac > 0.3 && filled < TOTAL_CHARS) bar += '\u258C';
        return '<span class="block-filled ' + colorClass + '">' + bar + '</span>';
    }

    function formatResetTime(isoStr) {
        if (!isoStr) return '';
        try {
            const d = new Date(isoStr);
            const now = new Date();
            const todayStr = now.toLocaleDateString('en-US', { timeZone: 'America/Chicago' });
            const resetStr = d.toLocaleDateString('en-US', { timeZone: 'America/Chicago' });

            if (todayStr === resetStr) {
                const time = d.toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: undefined });
                return 'Resets ' + time.replace(' ', '').toLowerCase() + ' (America/Chicago)';
            } else {
                const fmt = d.toLocaleString('en-US', {
                    timeZone: 'America/Chicago',
                    month: 'short', day: 'numeric',
                    hour: 'numeric', minute: undefined
                });
                return 'Resets ' + fmt + ' (America/Chicago)';
            }
        } catch (e) { return ''; }
    }

    // ── Plan Usage (from Anthropic OAuth API) ──

    function formatTimeUntil(isoStr) {
        if (!isoStr) return '';
        try {
            const reset = new Date(isoStr);
            const now = new Date();
            const diffMs = reset - now;
            if (diffMs <= 0) return 'resetting now';
            const hours = Math.floor(diffMs / 3600000);
            const mins = Math.floor((diffMs % 3600000) / 60000);
            if (hours >= 24) {
                const days = Math.floor(hours / 24);
                const remHours = hours % 24;
                return days + 'd ' + remHours + 'h remaining';
            }
            return hours + 'h ' + mins + 'm remaining';
        } catch (e) { return ''; }
    }

    function formatResetFull(isoStr) {
        if (!isoStr) return 'Unknown';
        try {
            return new Date(isoStr).toLocaleString('en-US', {
                timeZone: 'America/Chicago',
                weekday: 'short', month: 'short', day: 'numeric',
                hour: 'numeric', minute: '2-digit'
            }) + ' CST';
        } catch (e) { return isoStr; }
    }

    function buildUsageTip(title, pct, resetIso, details) {
        let html = '<div class="tt-title">' + escapeHtml(title) + '</div>';
        html += '<div class="tt-row"><span class="tt-key">Utilization</span><span class="tt-val">' + pct.toFixed(1) + '%</span></div>';
        html += '<div class="tt-row"><span class="tt-key">Available</span><span class="tt-val">' + (100 - pct).toFixed(1) + '%</span></div>';
        if (resetIso) {
            html += '<div class="tt-row"><span class="tt-key">Resets at</span><span class="tt-val">' + escapeHtml(formatResetFull(resetIso)) + '</span></div>';
            html += '<div class="tt-row"><span class="tt-key">Time left</span><span class="tt-val">' + escapeHtml(formatTimeUntil(resetIso)) + '</span></div>';
        }
        if (details) html += details;
        return html;
    }

    function _initFloatingTip() {
        const tip = document.getElementById('usage-float-tip');
        if (!tip) return;

        document.querySelectorAll('.cli-usage-row[data-tip-key]').forEach(row => {
            row.addEventListener('mouseenter', function(e) {
                const key = this.dataset.tipKey;
                const html = _tipContent[key];
                if (!html) return;
                tip.innerHTML = html;
                tip.classList.add('visible');
                _positionTip(tip, this);
            });
            row.addEventListener('mouseleave', function() {
                tip.classList.remove('visible');
            });
        });
    }

    function _positionTip(tip, row) {
        const rect = row.getBoundingClientRect();
        const tipH = tip.offsetHeight;
        const tipW = tip.offsetWidth;

        let top = rect.top - tipH - 8;
        if (top < 8) {
            top = rect.bottom + 8;
        }
        if (top + tipH > window.innerHeight - 8) {
            top = window.innerHeight - tipH - 8;
        }

        let left = rect.left;
        if (left + tipW > window.innerWidth - 8) {
            left = window.innerWidth - tipW - 8;
        }
        if (left < 8) left = 8;

        tip.style.top = top + 'px';
        tip.style.left = left + 'px';
    }

    async function loadPlanUsage() {
        try {
            const res = await fetch(API_PREFIX + 'claude/plan-usage');
            if (!res.ok) return;
            const data = await res.json();
            if (data.error) return;
            _lastPlanData = data;
            renderPlanUsage(data);
        } catch (e) { /* ignore */ }
    }

    function renderPlanUsage(data) {
        // Session (5-hour rolling)
        const session = data.session;
        if (session) {
            const pct = session.utilization || 0;
            const color = pct > 80 ? 'red' : pct > 50 ? 'orange' : 'blue';
            const blocksEl = document.getElementById('plan-blocks-session');
            if (blocksEl) blocksEl.innerHTML = buildBlockBar(pct, color);
            const pctEl = document.getElementById('plan-pct-session');
            if (pctEl) pctEl.textContent = Math.round(pct) + '% used';
            const subEl = document.getElementById('plan-sub-session');
            if (subEl) subEl.textContent = formatResetTime(session.resetsAt);
            _tipContent.session = buildUsageTip(
                'Current Session (5-hour rolling window)', pct, session.resetsAt,
                '<div class="tt-note">This is a rolling 5-hour window. Heavy usage fills it quickly. ' +
                'When maxed out, new requests may be throttled or queued until the window slides forward.</div>'
            );
        }

        // Week all models (7-day)
        const week = data.weekAll;
        if (week) {
            const pct = week.utilization || 0;
            const color = pct > 80 ? 'red' : pct > 50 ? 'orange' : 'cyan';
            const blocksEl = document.getElementById('plan-blocks-week');
            if (blocksEl) blocksEl.innerHTML = buildBlockBar(pct, color);
            const pctEl = document.getElementById('plan-pct-week');
            if (pctEl) pctEl.textContent = Math.round(pct) + '% used';
            const subEl = document.getElementById('plan-sub-week');
            if (subEl) subEl.textContent = formatResetTime(week.resetsAt);
            _tipContent.week = buildUsageTip(
                'Weekly Usage — All Models (7-day rolling)', pct, week.resetsAt,
                '<div class="tt-note">Combined usage across Opus, Sonnet, and Haiku for the rolling 7-day period. ' +
                'This is the primary limit for Claude Max. Above 80% = consider deferring non-critical system tasks.</div>'
            );
        }

        // Week Sonnet only
        const sonnet = data.weekSonnet;
        if (sonnet) {
            const pct = sonnet.utilization || 0;
            const color = pct > 80 ? 'red' : pct > 50 ? 'orange' : 'green';
            const blocksEl = document.getElementById('plan-blocks-sonnet');
            if (blocksEl) blocksEl.innerHTML = buildBlockBar(pct, color);
            const pctEl = document.getElementById('plan-pct-sonnet');
            if (pctEl) pctEl.textContent = Math.round(pct) + '% used';
            const subEl = document.getElementById('plan-sub-sonnet');
            if (subEl) subEl.textContent = formatResetTime(sonnet.resetsAt);
            _tipContent.sonnet = buildUsageTip(
                'Weekly Sonnet Usage (7-day rolling)', pct, sonnet.resetsAt,
                '<div class="tt-note">Separate limit for Sonnet model only. Typically much higher capacity than Opus. ' +
                'System tasks can be routed to Sonnet to preserve Opus quota when weekly all-models usage is high.</div>'
            );
            const planSonnet = document.getElementById('plan-sonnet');
            if (planSonnet) planSonnet.style.display = '';
        } else {
            const planSonnet = document.getElementById('plan-sonnet');
            if (planSonnet) planSonnet.style.display = 'none';
        }

        // Extra usage
        const extra = data.extraUsage;
        if (extra) {
            const pct = extra.utilization || 0;
            const used = (extra.usedCredits || 0) / 100;
            const limit = (extra.monthlyLimit || 0) / 100;
            const color = pct > 80 ? 'red' : pct > 50 ? 'orange' : 'blue';
            const blocksEl = document.getElementById('plan-blocks-extra');
            if (blocksEl) blocksEl.innerHTML = buildBlockBar(pct, color);
            const pctEl = document.getElementById('plan-pct-extra');
            if (pctEl) pctEl.textContent = Math.round(pct) + '% used';
            const subEl = document.getElementById('plan-sub-extra');
            if (subEl) subEl.textContent =
                '$' + used.toFixed(2) + ' / $' + limit.toFixed(2) + ' spent';

            let extraDetails = '<div class="tt-row"><span class="tt-key">Spent</span><span class="tt-val">$' + used.toFixed(2) + '</span></div>';
            extraDetails += '<div class="tt-row"><span class="tt-key">Monthly limit</span><span class="tt-val">$' + limit.toFixed(2) + '</span></div>';
            extraDetails += '<div class="tt-row"><span class="tt-key">Remaining</span><span class="tt-val">$' + (limit - used).toFixed(2) + '</span></div>';
            extraDetails += '<div class="tt-note">Pay-per-use overages beyond the included Claude Max allocation. ' +
                'Resets on the 1st of each month. When the monthly limit is reached, extra usage stops until reset.</div>';
            _tipContent.extra = buildUsageTip(
                'Extra Usage (monthly spending)', pct, null, extraDetails
            );
            const planExtra = document.getElementById('plan-extra');
            if (planExtra) planExtra.style.display = '';
        } else {
            const planExtra = document.getElementById('plan-extra');
            if (planExtra) planExtra.style.display = 'none';
        }

        // Badge: show session utilization (most volatile)
        const badge = document.getElementById('claude-active-badge');
        if (badge) {
            const sessPct = session ? session.utilization : 0;
            const weekPct = week ? week.utilization : 0;
            const maxPct = Math.max(sessPct, weekPct);
            if (maxPct > 80) {
                badge.textContent = Math.round(sessPct) + '% session';
                badge.style.color = 'var(--accent-red)';
            } else if (maxPct > 50) {
                badge.textContent = Math.round(sessPct) + '% session';
                badge.style.color = 'var(--accent-orange)';
            } else {
                badge.textContent = Math.round(sessPct) + '% session';
                badge.style.color = 'var(--accent-green)';
            }
        }
    }

    function renderClaudeUsage(data) {
        const today = data.today || {};
        const lifetime = data.lifetime || {};

        // ── Summary Cards ──
        const todayMsgs = document.getElementById('claude-today-messages');
        if (todayMsgs) todayMsgs.textContent = today.messages || 0;
        const todaySessions = document.getElementById('claude-today-sessions-detail');
        if (todaySessions) todaySessions.textContent = (today.sessions || 0) + ' sessions';

        const todayTools = document.getElementById('claude-today-tools');
        if (todayTools) todayTools.textContent = today.toolCalls || 0;
        const models = today.models || {};
        const topModel = Object.keys(models).sort((a, b) => models[b] - models[a])[0];
        const todayModelDetail = document.getElementById('claude-today-model-detail');
        if (todayModelDetail) todayModelDetail.textContent =
            topModel ? topModel.replace('claude-', '').replace(/-\d+$/, '') : '--';

        const todayCacheCreate = document.getElementById('claude-today-cache-create');
        if (todayCacheCreate) todayCacheCreate.textContent = formatTokens(today.cacheCreateTokens);

        const lifetimeOutput = document.getElementById('claude-lifetime-output');
        if (lifetimeOutput) {
            lifetimeOutput.textContent = formatTokens(lifetime.outputTokens);
            lifetimeOutput.title = formatTokensFull(lifetime.outputTokens) + ' lifetime output tokens';
        }
        const lifetimeDetail = document.getElementById('claude-lifetime-detail');
        if (lifetimeDetail) lifetimeDetail.textContent = (lifetime.totalSessions || 0) + ' sessions total';

        // ── Trend bar (last 7 days, live from JSONL) ──
        const trend = data.dailyTrend || [];
        if (trend.length > 0) {
            const todayDate = (data.today || {}).date || '';
            const maxMsg = Math.max(1, ...trend.map(d => d.messages || 0));
            const bar = document.getElementById('claude-trend-bar');
            if (bar) {
                let html = '';
                for (const day of trend) {
                    const pct = Math.max(2, ((day.messages || 0) / maxMsg) * 100);
                    const label = (day.date || '').slice(5);
                    const isToday = day.date === todayDate;
                    const cls = 'trend-day' + (isToday ? ' trend-today' : '');
                    html += '<div class="' + cls + '" style="height:' + pct + '%" ' +
                        'title="' + (day.date || '') + (isToday ? ' (today)' : '') + ': ' +
                        (day.messages || 0) + ' msgs, ' +
                        (day.sessions || 0) + ' sessions, ' + (day.toolCalls || 0) + ' tools">' +
                        '<span class="trend-label">' + label + '</span></div>';
                }
                bar.innerHTML = html;
            }
        }

        // ── Hourly heatmap (today's messages by hour) ──
        const hours = data.hourCounts || {};
        const heatmapEl = document.getElementById('claude-heatmap');
        if (heatmapEl) {
            const maxH = Math.max(1, ...Object.values(hours).map(Number));
            let hhtml = '';
            const nowHour = new Date().getHours();
            for (let h = 0; h < 24; h++) {
                const count = Number(hours[String(h)] || 0);
                const intensity = count / maxH;
                const bg = count > 0
                    ? 'rgba(88,166,255,' + (0.15 + intensity * 0.65) + ')'
                    : 'rgba(88,166,255,0.05)';
                const border = h === nowHour ? 'border:1px solid rgba(88,166,255,0.6);' : '';
                const suffix = h < 12 ? 'a' : 'p';
                const label = h === 0 ? '12a' : h < 12 ? h + suffix : h === 12 ? '12p' : (h - 12) + suffix;
                hhtml += '<div class="heatmap-cell" style="background:' + bg + ';' + border + '" ' +
                    'title="' + label + ' — ' + count + ' messages">' +
                    '<span class="heatmap-hour">' + label + '</span></div>';
            }
            heatmapEl.innerHTML = hhtml;
        }

        // ── Model usage breakdown ──
        const modelUsage = data.modelUsage || {};
        const modelsEl = document.getElementById('claude-models');
        if (modelsEl) {
            const totalOut = Math.max(1, Object.values(modelUsage).reduce((s, m) => s + (m.outputTokens || 0), 0));
            let mhtml = '';
            for (const [name, info] of Object.entries(modelUsage).sort((a, b) => (b[1].outputTokens || 0) - (a[1].outputTokens || 0))) {
                const pct = ((info.outputTokens || 0) / totalOut * 100).toFixed(0);
                const shortName = name.replace('claude-', '').replace(/-\d{8}$/, '');
                mhtml += '<div class="model-row">' +
                    '<span class="model-name">' + escapeHtml(shortName) + '</span>' +
                    '<span class="model-tokens">' + formatTokens(info.outputTokens) + '</span>' +
                    '<span class="model-pct">' + pct + '%</span></div>';
            }
            modelsEl.innerHTML = mhtml || '<span class="text-muted">No data</span>';
        }
    }

    // Load projects data (less frequently — uses heavier dashboard endpoint)
    async function loadClaudeProjects() {
        try {
            const res = await fetch(API_PREFIX + 'claude/dashboard');
            if (!res.ok) return;
            const data = await res.json();
            const projEl = document.getElementById('claude-projects');
            if (!projEl) return;

            const projects = data.sessionsByProject || {};
            if (Object.keys(projects).length === 0) {
                projEl.innerHTML = '<span class="text-muted">No sessions</span>';
                return;
            }

            let html = '';
            for (const [name, count] of Object.entries(projects).slice(0, 8)) {
                html += '<div class="project-row">' +
                    '<span class="project-name">' + escapeHtml(name) + '</span>' +
                    '<span class="project-count">' + count + '</span></div>';
            }
            projEl.innerHTML = html;
            _claudeProjectsLoaded = true;
        } catch (e) { /* ignore */ }
    }

    // ── Claude Status ─────────────────────────────────────

    async function loadClaudeStatus() {
        try {
            const res = await fetch(API_PREFIX + 'claude/status');
            if (!res.ok) return;
            const data = await res.json();
            renderClaudeStatus(data);
        } catch (e) { /* ignore */ }
    }

    function renderClaudeStatus(data) {
        // Badge
        const badge = document.getElementById('claude-status-badge');
        if (badge) {
            if (data.sessionCount > 0) {
                badge.textContent = data.sessionCount + ' running';
                badge.style.color = 'var(--accent-green)';
            } else {
                badge.textContent = 'idle';
                badge.style.color = '';
            }
        }

        // Version
        const verEl = document.getElementById('status-version');
        if (verEl) verEl.textContent = data.version || 'unknown';

        // Active sessions
        const sessEl = document.getElementById('status-sessions');
        if (sessEl) {
            const sessions = data.activeSessions || [];
            if (sessions.length === 0) {
                sessEl.textContent = 'None';
                sessEl.style.color = 'var(--text-muted)';
            } else {
                let parts = [];
                for (const s of sessions) {
                    const upMin = Math.floor((s.uptime_seconds || 0) / 60);
                    const shortCwd = (s.cwd || '').replace('/workspace/synced/opai/', '');
                    parts.push(s.type + ' (' + shortCwd + ', ' + upMin + 'm)');
                }
                sessEl.innerHTML = parts.map(p => '<div>' + escapeHtml(p) + '</div>').join('');
                sessEl.style.color = 'var(--accent-green)';
            }
        }

        // Login method
        const loginEl = document.getElementById('status-login');
        if (loginEl) loginEl.textContent = data.loginMethod || 'Unknown';

        // Model
        const modelEl = document.getElementById('status-model');
        if (modelEl) modelEl.textContent = data.model || 'Unknown';

        // MCP servers
        const mcpEl = document.getElementById('status-mcp');
        if (mcpEl) {
            const servers = data.mcpServers || [];
            if (servers.length === 0) {
                mcpEl.textContent = 'None';
            } else {
                mcpEl.innerHTML = servers.map(s => {
                    const icon = s.status === 'connected' ? '<span class="mcp-ok">\u2714</span>' : '<span class="mcp-cfg">\u2699</span>';
                    return icon + ' ' + escapeHtml(s.name);
                }).join(', ');
            }
        }

        // Memory
        const memEl = document.getElementById('status-memory');
        if (memEl) {
            const mem = data.memory || [];
            if (mem.length === 0) {
                memEl.textContent = 'None';
            } else {
                memEl.innerHTML = mem.map(m =>
                    '<a class="doc-link" href="#" onclick="MonitorHealth.openDocument(\'' + escapeHtml(m.path) + '\'); return false;">' + escapeHtml(m.label) + '</a>'
                ).join(', ');
            }
        }

        // Setting sources
        const settEl = document.getElementById('status-settings');
        if (settEl) {
            const sources = data.settingSources || [];
            if (sources.length === 0) {
                settEl.textContent = 'None';
            } else if (typeof sources[0] === 'string') {
                settEl.textContent = sources.join(', ');
            } else {
                settEl.innerHTML = sources.map(s =>
                    '<a class="doc-link" href="#" onclick="MonitorHealth.openDocument(\'' + escapeHtml(s.path) + '\'); return false;">' + escapeHtml(s.label) + '</a>'
                ).join(', ');
            }
        }
    }

    // ── Document Viewer ──────────────────────────────────

    async function openDocument(filePath) {
        try {
            const res = await fetch(API_PREFIX + 'claude/document?path=' + encodeURIComponent(filePath));
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                alert(err.detail || 'Failed to load document');
                return;
            }
            const data = await res.json();
            _docRawContent = data.content || 'Empty file';
            _docViewMode = 'raw';
            const titleEl = document.getElementById('doc-modal-title');
            if (titleEl) titleEl.textContent = data.filename || filePath.split('/').pop();
            updateDocView();
            updateDocToggle();
            const modal = document.getElementById('doc-modal');
            if (modal) modal.classList.add('visible');
        } catch (e) {
            alert('Failed to load document');
        }
    }

    function toggleDocView(mode) {
        _docViewMode = mode;
        updateDocView();
        updateDocToggle();
    }

    function updateDocView() {
        const el = document.getElementById('doc-modal-content');
        if (!el) return;
        if (_docViewMode === 'raw') {
            el.className = 'report-raw-content';
            el.textContent = _docRawContent;
        } else {
            el.className = 'markdown-content';
            el.innerHTML = renderMarkdown(_docRawContent);
        }
    }

    function updateDocToggle() {
        document.querySelectorAll('#doc-modal .report-view-toggle .toggle-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === _docViewMode);
        });
    }

    function closeDocModal() {
        const modal = document.getElementById('doc-modal');
        if (modal) modal.classList.remove('visible');
    }

    // ── Keyboard shortcuts & event listeners ───────────────

    let _keydownHandler = null;
    let _overlayHandlers = [];
    let _logFilterHandler = null;

    function _bindEvents() {
        _keydownHandler = (e) => {
            if (e.key === 'Escape') {
                closeReportModal();
                closeAgentModal();
                closeDocModal();
                closeInviteModal();
                closeEditUserModal();
                closePinModal();
            }
        };
        document.addEventListener('keydown', _keydownHandler);

        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            const handler = (e) => {
                if (e.target.classList.contains('modal-overlay')) {
                    e.target.classList.remove('visible');
                    _pinAction = null;
                }
            };
            overlay.addEventListener('click', handler);
            _overlayHandlers.push({ el: overlay, handler });
        });

        const logFilter = document.getElementById('log-filter');
        if (logFilter) {
            _logFilterHandler = () => {
                // Filter is applied on incoming messages; existing lines are not re-filtered
            };
            logFilter.addEventListener('input', _logFilterHandler);
        }
    }

    function _unbindEvents() {
        if (_keydownHandler) {
            document.removeEventListener('keydown', _keydownHandler);
            _keydownHandler = null;
        }
        for (const { el, handler } of _overlayHandlers) {
            el.removeEventListener('click', handler);
        }
        _overlayHandlers = [];
        if (_logFilterHandler) {
            const logFilter = document.getElementById('log-filter');
            if (logFilter) logFilter.removeEventListener('input', _logFilterHandler);
            _logFilterHandler = null;
        }
    }

    // ── Panel Resize System ─────────────────────────────────

    const PanelResize = (() => {
        const STORAGE_KEY = 'opai-health-panel-sizes';
        const WIDTH_SIZES = ['half', 'full'];
        const HEIGHT_SIZES = ['compact', 'default', 'tall', 'max'];
        const HEIGHT_LABELS = { compact: '250', default: '400', tall: '600', max: '900' };

        const DEFAULTS = {
            'panel-stats':         { w: 'half',  h: 'default' },
            'panel-usage-meters':  { w: 'half',  h: 'default' },
            'panel-claude-status': { w: 'half',  h: 'default' },
            'panel-claude-usage':  { w: 'half',  h: 'default' },
            'panel-agents':        { w: 'half',  h: 'default' },
            'panel-squad':         { w: 'half',  h: 'default' },
            'panel-services':      { w: 'half',  h: 'default' },
            'panel-logs':          { w: 'full',  h: 'tall' },
            'panel-reports':       { w: 'half',  h: 'tall' },
            'panel-queue':         { w: 'half',  h: 'default' },
            'panel-actions':       { w: 'full',  h: 'default' },
            'panel-users':         { w: 'full',  h: 'tall' },
            'panel-updater':       { w: 'full',  h: 'default' },
        };

        let saved = {};

        function load() {
            try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
            catch { saved = {}; }
        }

        function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(saved)); }

        function getSize(panelId) {
            return saved[panelId] || DEFAULTS[panelId] || { w: 'half', h: 'default' };
        }

        function setSize(panelId, w, h) { saved[panelId] = { w, h }; save(); }

        function applySize(panel) {
            const id = panel.id;
            const size = getSize(id);
            panel.classList.remove('size-half', 'size-full');
            panel.classList.remove('height-compact', 'height-default', 'height-tall', 'height-max');
            panel.style.removeProperty('grid-column');
            panel.classList.add('size-' + size.w);
            panel.classList.add('height-' + size.h);
            panel.querySelectorAll('.grip-w').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.size === size.w);
            });
            panel.querySelectorAll('.grip-h').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.size === size.h);
            });
        }

        function setWidth(panel, w) {
            const size = getSize(panel.id);
            size.w = w;
            setSize(panel.id, size.w, size.h);
            applySize(panel);
        }

        function setHeight(panel, h) {
            const size = getSize(panel.id);
            size.h = h;
            setSize(panel.id, size.w, size.h);
            applySize(panel);
        }

        function injectControls(panel) {
            const header = panel.querySelector('.panel-header');
            if (!header || header.querySelector('.panel-resize-grip')) return;
            const size = getSize(panel.id);

            const grip = document.createElement('div');
            grip.className = 'panel-resize-grip';
            grip.title = 'Resize panel';

            WIDTH_SIZES.forEach(w => {
                const btn = document.createElement('span');
                btn.className = 'grip-icon grip-w';
                btn.dataset.size = w;
                btn.textContent = w === 'half' ? '\u00BD' : '\u2194';
                btn.title = w === 'half' ? 'Half width' : 'Full width';
                btn.classList.toggle('active', w === size.w);
                btn.addEventListener('click', (e) => { e.stopPropagation(); setWidth(panel, w); });
                grip.appendChild(btn);
            });

            const sep = document.createElement('span');
            sep.style.cssText = 'width:1px;height:14px;background:var(--border);margin:0 2px;';
            grip.appendChild(sep);

            HEIGHT_SIZES.forEach(h => {
                const btn = document.createElement('span');
                btn.className = 'grip-icon grip-h';
                btn.dataset.size = h;
                btn.textContent = h[0].toUpperCase();
                btn.title = h.charAt(0).toUpperCase() + h.slice(1) + ' (' + HEIGHT_LABELS[h] + 'px)';
                btn.classList.toggle('active', h === size.h);
                btn.addEventListener('click', (e) => { e.stopPropagation(); setHeight(panel, h); });
                grip.appendChild(btn);
            });

            header.appendChild(grip);

            const dragR = document.createElement('div');
            dragR.className = 'panel-drag-handle';
            dragR.addEventListener('mousedown', (e) => startDragWidth(e, panel));
            panel.appendChild(dragR);

            const dragB = document.createElement('div');
            dragB.className = 'panel-drag-handle-bottom';
            dragB.addEventListener('mousedown', (e) => startDragHeight(e, panel));
            panel.appendChild(dragB);
        }

        function startDragWidth(e, panel) {
            e.preventDefault();
            const dashboard = panel.parentElement;
            const dashRect = dashboard.getBoundingClientRect();
            const handle = panel.querySelector('.panel-drag-handle');
            if (handle) handle.classList.add('dragging');
            panel.classList.add('snap-preview');

            function onMove(ev) {
                const pct = (ev.clientX - dashRect.left) / dashRect.width;
                const snap = pct < 0.65 ? 'half' : 'full';
                const size = getSize(panel.id);
                if (snap !== size.w) setWidth(panel, snap);
            }
            function onUp() {
                if (handle) handle.classList.remove('dragging');
                panel.classList.remove('snap-preview');
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            }
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        }

        function startDragHeight(e, panel) {
            e.preventDefault();
            const startY = e.clientY;
            const startH = panel.getBoundingClientRect().height;
            const handle = panel.querySelector('.panel-drag-handle-bottom');
            if (handle) handle.classList.add('dragging');
            panel.classList.add('snap-preview');

            const snaps = [
                { max: 325, size: 'compact' },
                { max: 500, size: 'default' },
                { max: 750, size: 'tall' },
                { max: Infinity, size: 'max' },
            ];

            function onMove(ev) {
                const newH = startH + (ev.clientY - startY);
                const snap = snaps.find(s => newH < s.max);
                const size = getSize(panel.id);
                if (snap && snap.size !== size.h) setHeight(panel, snap.size);
            }
            function onUp() {
                if (handle) handle.classList.remove('dragging');
                panel.classList.remove('snap-preview');
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            }
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        }

        function initAll() {
            load();
            const container = document.getElementById('healthView');
            if (!container) return;
            container.querySelectorAll('.dashboard > .panel[id]').forEach(panel => {
                injectControls(panel);
                applySize(panel);
            });
        }

        function teardown() {
            const container = document.getElementById('healthView');
            if (!container) return;
            container.querySelectorAll('.panel-resize-grip').forEach(el => el.remove());
            container.querySelectorAll('.panel-drag-handle, .panel-drag-handle-bottom').forEach(el => el.remove());
        }

        return { initAll, teardown };
    })();

    // ── Panel Drag-to-Reorder System ──────────────────────

    const PanelOrder = (() => {
        const STORAGE_KEY = 'opai-health-panel-order';

        function load() {
            try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
            catch { return null; }
        }

        function save(order) { localStorage.setItem(STORAGE_KEY, JSON.stringify(order)); }

        function getDashboard() {
            const hv = document.getElementById('healthView');
            return hv ? hv.querySelector('.dashboard') : null;
        }

        function getOrder() {
            const dashboard = getDashboard();
            if (!dashboard) return [];
            return Array.from(dashboard.querySelectorAll(':scope > .panel[id]')).map(p => p.id);
        }

        function applyOrder(order) {
            const dashboard = getDashboard();
            if (!dashboard) return;
            const panels = {};
            dashboard.querySelectorAll(':scope > .panel[id]').forEach(p => { panels[p.id] = p; });
            for (const id of order) {
                if (panels[id]) { dashboard.appendChild(panels[id]); delete panels[id]; }
            }
            for (const p of Object.values(panels)) dashboard.appendChild(p);
        }

        let _dragPanel = null;
        let _dragGhost = null;
        let _dragPlaceholder = null;

        function injectDragHandle(panel) {
            const header = panel.querySelector('.panel-header');
            if (!header || header.querySelector('.panel-drag-grip')) return;
            const grip = document.createElement('span');
            grip.className = 'panel-drag-grip';
            grip.title = 'Drag to reorder';
            grip.textContent = '\u2630';
            grip.addEventListener('mousedown', (e) => startDrag(e, panel));
            header.insertBefore(grip, header.firstChild);
        }

        function startDrag(e, panel) {
            e.preventDefault();
            _dragPanel = panel;
            const dashboard = panel.parentElement;
            const rect = panel.getBoundingClientRect();

            _dragGhost = document.createElement('div');
            _dragGhost.className = 'panel-drag-ghost';
            _dragGhost.style.width = rect.width + 'px';
            _dragGhost.style.height = rect.height + 'px';
            _dragGhost.style.left = rect.left + 'px';
            _dragGhost.style.top = rect.top + 'px';
            _dragGhost.innerHTML = '<div class="panel-drag-ghost-title">' +
                (panel.querySelector('.panel-title')?.textContent || '') + '</div>';
            document.body.appendChild(_dragGhost);

            _dragPlaceholder = document.createElement('div');
            _dragPlaceholder.className = 'panel-drag-placeholder';
            const computed = getComputedStyle(panel);
            _dragPlaceholder.style.gridColumn = computed.gridColumn;
            _dragPlaceholder.style.minHeight = rect.height + 'px';
            panel.parentElement.insertBefore(_dragPlaceholder, panel);
            panel.classList.add('dragging-source');

            const offsetX = e.clientX - rect.left;
            const offsetY = e.clientY - rect.top;

            function onMove(ev) {
                _dragGhost.style.left = (ev.clientX - offsetX) + 'px';
                _dragGhost.style.top = (ev.clientY - offsetY) + 'px';
                const target = findDropTarget(ev.clientX, ev.clientY, dashboard);
                if (target && target !== panel && target !== _dragPlaceholder) {
                    const midY = target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2;
                    if (ev.clientY < midY) {
                        dashboard.insertBefore(_dragPlaceholder, target);
                    } else {
                        dashboard.insertBefore(_dragPlaceholder, target.nextSibling);
                    }
                }
            }

            function onUp() {
                dashboard.insertBefore(panel, _dragPlaceholder);
                _dragPlaceholder.remove();
                _dragGhost.remove();
                panel.classList.remove('dragging-source');
                _dragPanel = null;
                _dragGhost = null;
                _dragPlaceholder = null;
                save(getOrder());
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            }

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        }

        function findDropTarget(x, y, dashboard) {
            const panels = dashboard.querySelectorAll(':scope > .panel[id]:not(.dragging-source)');
            for (const p of panels) {
                const r = p.getBoundingClientRect();
                if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return p;
            }
            let closest = null, closestDist = Infinity;
            for (const p of panels) {
                const r = p.getBoundingClientRect();
                const dist = Math.abs(y - (r.top + r.height / 2));
                if (dist < closestDist) { closestDist = dist; closest = p; }
            }
            return closest;
        }

        function resetOrder() {
            localStorage.removeItem(STORAGE_KEY);
            teardown();
            initAll();
        }

        function initAll() {
            const savedOrder = load();
            if (savedOrder) applyOrder(savedOrder);
            const dashboard = getDashboard();
            if (!dashboard) return;
            dashboard.querySelectorAll(':scope > .panel[id]').forEach(panel => {
                injectDragHandle(panel);
            });
        }

        function teardown() {
            const container = document.getElementById('healthView');
            if (!container) return;
            container.querySelectorAll('.panel-drag-grip').forEach(el => el.remove());
        }

        return { initAll, teardown, resetOrder };
    })();

    // ── Save/Restore Layout ──────────────────────────────

    function saveLayout() {
        const dashboard = document.querySelector('#healthView .dashboard');
        if (!dashboard) return;
        const panels = dashboard.querySelectorAll(':scope > .panel[id]');
        const layout = {
            order: Array.from(panels).map(p => p.id),
            sizes: JSON.parse(localStorage.getItem('opai-health-panel-sizes') || '{}'),
            visibility: {},
            savedAt: new Date().toISOString()
        };
        panels.forEach(p => { layout.visibility[p.id] = p.style.display !== 'none'; });
        localStorage.setItem('opai-health-saved-layout', JSON.stringify(layout));
        localStorage.setItem('opai-health-panel-order', JSON.stringify(layout.order));

        const btn = document.getElementById('saveLayoutBtn');
        if (btn) {
            const orig = btn.textContent;
            btn.textContent = 'Saved!';
            btn.classList.add('saved');
            setTimeout(() => { btn.textContent = orig; btn.classList.remove('saved'); }, 1500);
        }
    }

    function restoreSavedLayout() {
        try {
            const layout = JSON.parse(localStorage.getItem('opai-health-saved-layout'));
            if (!layout) return;
            if (layout.sizes && Object.keys(layout.sizes).length > 0) {
                localStorage.setItem('opai-health-panel-sizes', JSON.stringify(layout.sizes));
            }
            if (layout.order && layout.order.length > 0) {
                localStorage.setItem('opai-health-panel-order', JSON.stringify(layout.order));
            }
            if (layout.visibility) {
                const dashboard = document.querySelector('#healthView .dashboard');
                if (dashboard) {
                    dashboard.querySelectorAll(':scope > .panel[id]').forEach(p => {
                        if (layout.visibility[p.id] !== undefined) {
                            p.style.display = layout.visibility[p.id] ? '' : 'none';
                        }
                    });
                }
            }
        } catch (e) {
            console.warn('Failed to restore saved layout:', e);
        }
    }

    // ── Initialization ─────────────────────────────────────

    function init() {
        // Bind event listeners
        _bindEvents();

        // Restore saved layout and init panel systems
        restoreSavedLayout();
        PanelOrder.initAll();
        PanelResize.initAll();

        // WebSocket connections
        wsStats = connectWS('/ws/stats', handleStats);
        wsAgents = connectWS('/ws/agents', handleAgents);
        wsLogs = connectWS('/ws/logs', handleLogMessage);

        // Initial REST loads
        loadServices();
        loadSquad();
        loadReports();
        loadQueue();
        loadUpdaterSuggestions();
        loadUsers();
        checkNetworkStatus();
        loadClaudeUsage();
        loadClaudeProjects();
        loadClaudeStatus();
        loadPlanUsage();
        _initFloatingTip();

        // Polling for REST-based panels — track all intervals for cleanup
        _intervals.push(setInterval(loadServices, 10000));
        _intervals.push(setInterval(loadSquad, 5000));
        _intervals.push(setInterval(loadQueue, 10000));
        _intervals.push(setInterval(loadUpdaterSuggestions, 60000));
        _intervals.push(setInterval(loadUsers, 15000));
        _intervals.push(setInterval(checkNetworkStatus, 10000));
        _intervals.push(setInterval(loadClaudeUsage, 10000));
        _intervals.push(setInterval(loadClaudeProjects, 60000));
        _intervals.push(setInterval(loadClaudeStatus, 30000));
        _intervals.push(setInterval(loadPlanUsage, 15000));
    }

    function destroy() {
        // Close all WebSockets
        if (wsStats) { wsStats.onclose = null; wsStats.close(); wsStats = null; }
        if (wsAgents) { wsAgents.onclose = null; wsAgents.close(); wsAgents = null; }
        if (wsLogs) { wsLogs.onclose = null; wsLogs.close(); wsLogs = null; }

        // Clear all polling intervals
        for (const id of _intervals) {
            clearInterval(id);
        }
        _intervals.length = 0;

        // Tear down panel systems
        PanelResize.teardown();
        PanelOrder.teardown();

        // Unbind event listeners
        _unbindEvents();

        // Reset state
        logPaused = false;
        logLineCount = 0;
        _prevNet = null;
        _prevNetTime = null;
        _usersData = [];
        _agentsList = [];
        updaterFilter = 'all';
        updaterData = [];
        _networkLocked = false;
        _pinAction = null;
        _claudeProjectsLoaded = false;
        _reportRawContent = '';
        _docRawContent = '';
        _lastPlanData = null;
    }

    // ── Public API ─────────────────────────────────────────

    return {
        init,
        destroy,
        // Actions callable from inline onclick handlers
        openAgent,
        killAgent,
        closeAgentModal,
        killAllAgents,
        startAllServices,
        emergencyStop,
        controlService,
        processQueue,
        clearLogs,
        toggleLogPause,
        loadReports,
        openReport,
        toggleReportView,
        closeReportModal,
        setUpdaterFilter,
        archiveSuggestion,
        createTaskFromSuggestion,
        toggleUpdaterPanel,
        toggleUserActive,
        openInviteModal,
        closeInviteModal,
        sendInvite,
        openEditUserModal,
        closeEditUserModal,
        saveUser,
        dropAllUsers,
        restoreAllUsers,
        toggleNetworkLockdown,
        closePinModal,
        confirmPinAction,
        openDocument,
        toggleDocView,
        closeDocModal,
        saveLayout,
        resetOrder: PanelOrder.resetOrder,
    };
})();
