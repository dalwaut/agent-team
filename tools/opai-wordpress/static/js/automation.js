/* OP WordPress — Automation: Schedules, Backups, Activity Log */

WP.Automation = {
    schedules: [],
    backups: [],
    logs: [],
    logsTotal: 0,
    logsPage: 0,
    logsStatus: '',
    logsTaskType: '',
    logStats: null,

    // ── Cron presets ─────────────────────────────────────
    cronPresets: [
        { label: 'Daily at 3:00 AM', cron: '0 3 * * *' },
        { label: 'Daily at 6:00 AM', cron: '0 6 * * *' },
        { label: 'Every 6 hours', cron: '0 */6 * * *' },
        { label: 'Every 12 hours', cron: '0 */12 * * *' },
        { label: 'Weekly — Sunday 2:00 AM', cron: '0 2 * * 0' },
        { label: 'Weekly — Monday 3:00 AM', cron: '0 3 * * 1' },
        { label: 'Monthly — 1st at 3:00 AM', cron: '0 3 1 * *' },
        { label: 'Custom', cron: '' },
    ],

    taskTypes: [
        { value: 'update_all', label: 'Update All (Core + Plugins + Themes)' },
        { value: 'update_plugins', label: 'Update Plugins Only' },
        { value: 'update_themes', label: 'Update Themes Only' },
        { value: 'update_core', label: 'Update Core Only' },
        { value: 'backup', label: 'Backup' },
        { value: 'health_check', label: 'Health Check' },
    ],

    _taskLabel(type) {
        var t = this.taskTypes.find(function(t) { return t.value === type; });
        return t ? t.label : type;
    },

    // ═══════════════════════════════════════════════════════════
    //  SCHEDULES
    // ═══════════════════════════════════════════════════════════

    async renderSchedules(main) {
        if (!WP.requireSite(main)) return;

        main.innerHTML = '<div class="loading-inline"><div class="spinner"></div></div>';

        // Load schedules and last run results in parallel
        var schedPromise, connPromise, logsPromise;
        try {
            schedPromise = WP.api('schedules?site_id=' + WP.currentSite.id);
        } catch (e) { schedPromise = Promise.resolve([]); }
        try {
            connPromise = WP.api('sites/' + WP.currentSite.id + '/connector/status');
        } catch (e) { connPromise = Promise.resolve({ installed: false, reachable: false }); }
        try {
            logsPromise = WP.api('sites/' + WP.currentSite.id + '/logs?page=0&limit=50');
        } catch (e) { logsPromise = Promise.resolve({ logs: [] }); }

        var results = await Promise.allSettled([schedPromise, connPromise, logsPromise]);
        this.schedules = results[0].status === 'fulfilled' ? results[0].value : [];
        var connector = results[1].status === 'fulfilled' ? results[1].value : { installed: false, reachable: false };
        var recentLogs = results[2].status === 'fulfilled' ? (results[2].value.logs || []) : [];

        // Build a map of schedule_id -> last log status
        var lastRunMap = {};
        for (var i = 0; i < recentLogs.length; i++) {
            var log = recentLogs[i];
            if (log.schedule_id && !lastRunMap[log.schedule_id]) {
                lastRunMap[log.schedule_id] = log.status;
            }
        }

        var html = '<div class="main-header">' +
            '<h2>Schedules — ' + WP.stripHtml(WP.currentSite.name) + '</h2>' +
            '<div style="display:flex;gap:8px">' +
                '<button class="btn btn-primary" onclick="WP.Automation.showCreateModal()">+ New Schedule</button>' +
            '</div>' +
        '</div>';

        if (!connector.installed || !connector.reachable) {
            html += '<div class="callout callout-warn">' +
                '<span class="callout-icon">&#9888;</span>' +
                '<div>' +
                    '<strong>OPAI Connector required</strong> — Install the connector plugin on this WordPress site to enable automation.' +
                    ' <button class="btn btn-sm" style="margin-left:8px" onclick="WP.Automation.setupConnector()">Setup Connector</button>' +
                '</div>' +
            '</div>';
        }

        if (!this.schedules.length) {
            html += '<div class="empty-state">' +
                '<div class="empty-icon">&#128337;</div>' +
                '<h3>No schedules yet</h3>' +
                '<p>Create automated schedules for updates, backups, and health checks.</p>' +
            '</div>';
        } else {
            html += '<table class="data-table">' +
                '<thead><tr>' +
                    '<th>Name</th><th>Task</th><th>Schedule</th><th>Next Run</th><th>Last Run</th><th>Result</th><th>Enabled</th><th>Actions</th>' +
                '</tr></thead><tbody>';

            for (var i = 0; i < this.schedules.length; i++) {
                var s = this.schedules[i];
                var taskLabel = this._taskLabel(s.task_type);
                var lastResult = lastRunMap[s.id] || null;
                var resultBadge = '';
                if (lastResult === 'success') {
                    resultBadge = '<span class="badge badge-green">&#10003; OK</span>';
                } else if (lastResult === 'failed') {
                    resultBadge = '<span class="badge badge-red">&#10007; Failed</span>';
                } else if (lastResult === 'rolled_back') {
                    resultBadge = '<span class="badge badge-orange">&#8634; Rolled Back</span>';
                } else if (lastResult === 'running') {
                    resultBadge = '<span class="badge badge-blue">&#9654; Running</span>';
                } else {
                    resultBadge = '<span style="color:var(--text-muted);font-size:12px">--</span>';
                }

                var siteName = s.wp_sites ? s.wp_sites.name : '';

                html += '<tr>' +
                    '<td><strong>' + WP.stripHtml(s.name) + '</strong>' +
                        (siteName ? '<br><span style="font-size:11px;color:var(--text-muted)">' + WP.stripHtml(siteName) + '</span>' : '') +
                    '</td>' +
                    '<td><span class="badge badge-blue">' + WP.stripHtml(taskLabel) + '</span></td>' +
                    '<td><code>' + WP.stripHtml(s.cron_expression) + '</code><br><span style="font-size:11px;color:var(--text-muted)">' + this._cronToHuman(s.cron_expression) + '</span></td>' +
                    '<td>' + this._relativeTime(s.next_run_at) + '</td>' +
                    '<td>' + (s.last_run_at ? this._relativeTime(s.last_run_at) : '--') + '</td>' +
                    '<td>' + resultBadge + '</td>' +
                    '<td>' +
                        '<label class="toggle-switch">' +
                            '<input type="checkbox" ' + (s.enabled ? 'checked' : '') + ' onchange="WP.Automation.toggleSchedule(\'' + s.id + '\')">' +
                            '<span class="toggle-slider"></span>' +
                        '</label>' +
                    '</td>' +
                    '<td style="white-space:nowrap">' +
                        '<button class="btn-sm" onclick="WP.Automation.runNow(\'' + s.id + '\')" title="Run Now">&#9654;</button> ' +
                        '<button class="btn-sm" onclick="WP.Automation.editSchedule(\'' + s.id + '\')" title="Edit">&#9998;</button> ' +
                        '<button class="btn-sm" onclick="WP.Automation.duplicateSchedule(\'' + s.id + '\')" title="Duplicate">&#128203;</button> ' +
                        '<button class="btn-sm" onclick="WP.Automation.deleteSchedule(\'' + s.id + '\')" title="Delete" style="color:var(--red)">&#128465;</button>' +
                    '</td>' +
                '</tr>';
            }

            html += '</tbody></table>';
        }

        main.innerHTML = html;
    },

    // ── Create/Edit Modal ────────────────────────────────
    showCreateModal(schedule) {
        var isEdit = !!schedule;
        var title = isEdit ? 'Edit Schedule' : 'New Schedule';

        var presetOptions = this.cronPresets.map(function(p) {
            return '<option value="' + p.cron + '"' + (schedule && schedule.cron_expression === p.cron ? ' selected' : '') + '>' + p.label + '</option>';
        }).join('');

        var taskOptions = this.taskTypes.map(function(t) {
            return '<option value="' + t.value + '"' + (schedule && schedule.task_type === t.value ? ' selected' : '') + '>' + t.label + '</option>';
        }).join('');

        var isCustomCron = schedule && !this.cronPresets.find(function(p) { return p.cron === schedule.cron_expression; });

        var html = '<div class="modal-backdrop" onclick="if(event.target===this)this.remove()">' +
            '<div class="modal">' +
                '<h3>' + title + '</h3>' +
                '<div class="form-group">' +
                    '<label>Name</label>' +
                    '<input class="form-input" id="sched-name" value="' + WP.stripHtml(schedule ? schedule.name || '' : '') + '" placeholder="e.g. Nightly Updates">' +
                '</div>' +
                '<div class="form-group">' +
                    '<label>Task Type</label>' +
                    '<select class="form-input" id="sched-task-type">' + taskOptions + '</select>' +
                '</div>' +
                '<div class="form-group">' +
                    '<label>Schedule</label>' +
                    '<select class="form-input" id="sched-preset" onchange="document.getElementById(\'sched-cron\').value=this.value;document.getElementById(\'sched-cron-row\').style.display=this.value?\'none\':\'\'">' +
                        presetOptions +
                    '</select>' +
                '</div>' +
                '<div class="form-group" id="sched-cron-row" style="display:' + (isCustomCron ? '' : 'none') + '">' +
                    '<label>Cron Expression</label>' +
                    '<input class="form-input" id="sched-cron" value="' + WP.stripHtml(schedule ? schedule.cron_expression || '0 3 * * *' : '0 3 * * *') + '" placeholder="0 3 * * *">' +
                    '<div class="form-hint">minute hour day-of-month month day-of-week</div>' +
                '</div>' +
                '<div class="form-group">' +
                    '<label>Timezone</label>' +
                    '<select class="form-input" id="sched-tz">' +
                        ['America/Chicago','America/New_York','America/Los_Angeles','America/Denver','UTC','Europe/London','Europe/Berlin','Asia/Tokyo'].map(function(tz) {
                            return '<option value="' + tz + '"' + ((schedule ? schedule.timezone || 'America/Chicago' : 'America/Chicago') === tz ? ' selected' : '') + '>' + tz + '</option>';
                        }).join('') +
                    '</select>' +
                '</div>' +
                '<div class="form-row">' +
                    '<div class="form-group">' +
                        '<label class="form-check">' +
                            '<input type="checkbox" id="sched-auto-rollback"' + (schedule ? (schedule.auto_rollback !== false ? ' checked' : '') : ' checked') + '>' +
                            ' Auto-rollback on failure' +
                        '</label>' +
                    '</div>' +
                    '<div class="form-group">' +
                        '<label class="form-check">' +
                            '<input type="checkbox" id="sched-pre-backup"' + (schedule ? (schedule.pre_backup !== false ? ' checked' : '') : ' checked') + '>' +
                            ' Pre-update backup' +
                        '</label>' +
                    '</div>' +
                '</div>' +
                '<div class="modal-actions">' +
                    '<button class="btn btn-ghost" onclick="this.closest(\'.modal-backdrop\').remove()">Cancel</button>' +
                    '<button class="btn btn-primary" onclick="WP.Automation.saveSchedule(' + (isEdit ? "'" + schedule.id + "'" : 'null') + ')">' + (isEdit ? 'Save' : 'Create') + '</button>' +
                '</div>' +
            '</div>' +
        '</div>';

        document.body.insertAdjacentHTML('beforeend', html);
    },

    async saveSchedule(scheduleId) {
        var name = document.getElementById('sched-name').value.trim();
        var taskType = document.getElementById('sched-task-type').value;
        var preset = document.getElementById('sched-preset').value;
        var customCron = document.getElementById('sched-cron').value.trim();
        var cron = preset || customCron;
        var tz = document.getElementById('sched-tz').value;
        var autoRollback = document.getElementById('sched-auto-rollback').checked;
        var preBackup = document.getElementById('sched-pre-backup').checked;

        if (!name) { WP.toast('Name is required', 'error'); return; }
        if (!cron) { WP.toast('Schedule is required', 'error'); return; }

        var body = {
            name: name, task_type: taskType, cron_expression: cron,
            timezone: tz, auto_rollback: autoRollback, pre_backup: preBackup,
        };

        try {
            if (scheduleId) {
                await WP.api('schedules/' + scheduleId, { method: 'PUT', body: body });
                WP.toast('Schedule updated');
            } else {
                body.site_id = WP.currentSite.id;
                await WP.api('schedules', { method: 'POST', body: body });
                WP.toast('Schedule created');
            }

            document.querySelector('.modal-backdrop').remove();
            this.renderSchedules(document.getElementById('main-content'));
        } catch (e) {
            WP.toast('Error: ' + e.message, 'error');
        }
    },

    async editSchedule(id) {
        var schedule = this.schedules.find(function(s) { return s.id === id; });
        if (schedule) this.showCreateModal(schedule);
    },

    async duplicateSchedule(id) {
        var schedule = this.schedules.find(function(s) { return s.id === id; });
        if (!schedule) return;

        var clone = {
            site_id: WP.currentSite.id,
            name: schedule.name + ' (Copy)',
            task_type: schedule.task_type,
            cron_expression: schedule.cron_expression,
            timezone: schedule.timezone,
            auto_rollback: schedule.auto_rollback,
            pre_backup: schedule.pre_backup,
        };

        try {
            await WP.api('schedules', { method: 'POST', body: clone });
            WP.toast('Schedule duplicated');
            this.renderSchedules(document.getElementById('main-content'));
        } catch (e) {
            WP.toast('Error: ' + e.message, 'error');
        }
    },

    async deleteSchedule(id) {
        if (!confirm('Delete this schedule?')) return;
        try {
            await WP.api('schedules/' + id, { method: 'DELETE' });
            WP.toast('Schedule deleted');
            this.renderSchedules(document.getElementById('main-content'));
        } catch (e) {
            WP.toast('Error: ' + e.message, 'error');
        }
    },

    async toggleSchedule(id) {
        try {
            await WP.api('schedules/' + id + '/toggle', { method: 'POST' });
        } catch (e) {
            WP.toast('Error: ' + e.message, 'error');
        }
    },

    async runNow(id) {
        try {
            await WP.api('schedules/' + id + '/run', { method: 'POST' });
            WP.toast('Schedule triggered — check Activity Log');
        } catch (e) {
            WP.toast('Error: ' + e.message, 'error');
        }
    },

    // ═══════════════════════════════════════════════════════════
    //  BACKUPS
    // ═══════════════════════════════════════════════════════════

    async renderBackups(main) {
        if (!WP.requireSite(main)) return;

        main.innerHTML = '<div class="loading-inline"><div class="spinner"></div></div>';

        // Load backups and connector status in parallel
        var results = await Promise.allSettled([
            WP.api('sites/' + WP.currentSite.id + '/backups'),
            WP.api('sites/' + WP.currentSite.id + '/connector/status'),
        ]);
        this.backups = results[0].status === 'fulfilled' ? results[0].value : [];
        var connector = results[1].status === 'fulfilled' ? results[1].value : { installed: false, reachable: false };

        var html = '<div class="main-header">' +
            '<h2>Backups — ' + WP.stripHtml(WP.currentSite.name) + '</h2>' +
            '<button class="btn btn-primary" onclick="WP.Automation.createBackup()">Create Backup</button>' +
        '</div>';

        if (!connector.installed || !connector.reachable) {
            html += '<div class="callout callout-warn">' +
                '<span class="callout-icon">&#9888;</span>' +
                '<div>' +
                    '<strong>OPAI Connector required</strong> — Backups require the connector plugin installed on your WordPress site.' +
                    ' <button class="btn btn-sm" style="margin-left:8px" onclick="WP.Automation.setupConnector()">Setup Connector</button>' +
                '</div>' +
            '</div>';
        }

        // Stats row
        if (this.backups.length > 0) {
            var totalSize = 0;
            var completedCount = 0;
            for (var i = 0; i < this.backups.length; i++) {
                if (this.backups[i].size_bytes) totalSize += this.backups[i].size_bytes;
                if (this.backups[i].status === 'completed') completedCount++;
            }
            html += '<div style="display:flex;gap:16px;margin-bottom:16px">' +
                '<div class="stat-card"><div class="stat-value">' + this.backups.length + '</div><div class="stat-label">Total Backups</div></div>' +
                '<div class="stat-card"><div class="stat-value">' + completedCount + '</div><div class="stat-label">Completed</div></div>' +
                '<div class="stat-card"><div class="stat-value">' + this._formatBytes(totalSize) + '</div><div class="stat-label">Total Size</div></div>' +
                '<div class="stat-card"><div class="stat-value">' + (this.backups[0] ? this._relativeTime(this.backups[0].created_at) : '--') + '</div><div class="stat-label">Last Backup</div></div>' +
            '</div>';
        }

        if (!this.backups.length) {
            html += '<div class="empty-state">' +
                '<div class="empty-icon">&#128190;</div>' +
                '<h3>No backups yet</h3>' +
                '<p>Create a backup manually or set up an automated schedule.</p>' +
            '</div>';
        } else {
            html += '<table class="data-table">' +
                '<thead><tr>' +
                    '<th>Date</th><th>Type</th><th>Size</th><th>Trigger</th><th>Status</th><th>Storage</th><th>Actions</th>' +
                '</tr></thead><tbody>';

            for (var i = 0; i < this.backups.length; i++) {
                var b = this.backups[i];
                var statusClass = {
                    'completed': 'badge-green', 'in_progress': 'badge-blue',
                    'failed': 'badge-red', 'restoring': 'badge-orange', 'restored': 'badge-purple',
                }[b.status] || 'badge-blue';

                var triggerLabel = {
                    'manual': 'Manual', 'scheduled': 'Scheduled',
                    'pre_update': 'Pre-Update', 'auto': 'Auto',
                }[b.trigger] || b.trigger;

                var typeLabel = {
                    'full': 'Full', 'database': 'Database', 'files': 'Files',
                }[b.backup_type] || b.backup_type;

                var hasLocal = b.metadata && b.metadata.local_path;
                var storageIndicator = hasLocal
                    ? '<span title="Stored locally" style="color:var(--green)">&#10003; Local</span>'
                    : '<span style="color:var(--text-muted);font-size:11px">Remote only</span>';

                html += this._buildBackupRow(b, false);
            }

            html += '</tbody></table>';
        }

        main.innerHTML = html;
    },

    // ── Backup actions ───────────────────────────────────
    async createBackup() {
        if (!WP.currentSite) return;

        // Load backup folders
        var folders = [];
        try { folders = await WP.api('backup-folders'); } catch (e) { /* ok */ }
        var currentFolder = WP.currentSite.backup_folder || '';

        var folderOptions = '<option value="">-- Site default --</option>';
        for (var i = 0; i < folders.length; i++) {
            folderOptions += '<option value="' + WP.stripHtml(folders[i]) + '"' +
                (currentFolder === folders[i] ? ' selected' : '') + '>' +
                WP.stripHtml(folders[i]) + '</option>';
        }

        var html = '<div class="modal-backdrop" onclick="if(event.target===this)this.remove()">' +
            '<div class="modal">' +
                '<h3>Create Backup</h3>' +
                '<div class="form-group">' +
                    '<label>Backup Type</label>' +
                    '<select class="form-input" id="backup-type">' +
                        '<option value="full">Full (Database + Files)</option>' +
                        '<option value="database">Database Only</option>' +
                        '<option value="files">Files Only</option>' +
                    '</select>' +
                '</div>' +
                '<div class="form-group">' +
                    '<label>Local Storage Folder</label>' +
                    '<div style="display:flex;gap:8px">' +
                        '<select class="form-input" id="backup-folder" style="flex:1">' +
                            folderOptions +
                        '</select>' +
                        '<button class="btn btn-ghost" onclick="WP.Automation._promptNewFolder()" title="Create new folder">+ New</button>' +
                    '</div>' +
                    '<div class="form-hint">Backup will be downloaded to this folder on the OPAI server (synced to NAS).</div>' +
                '</div>' +
                '<div class="callout callout-info" style="margin-bottom:0">' +
                    '<span class="callout-icon">&#128161;</span>' +
                    '<div style="font-size:12px">Full backups include the WordPress database and all uploaded files. Database-only backups are faster and smaller.</div>' +
                '</div>' +
                '<div class="modal-actions">' +
                    '<button class="btn btn-ghost" onclick="this.closest(\'.modal-backdrop\').remove()">Cancel</button>' +
                    '<button class="btn btn-primary" onclick="WP.Automation.doCreateBackup()">Create Backup</button>' +
                '</div>' +
            '</div>' +
        '</div>';
        document.body.insertAdjacentHTML('beforeend', html);
    },

    _promptNewFolder() {
        var name = prompt('New folder name:');
        if (!name || !name.trim()) return;
        name = name.trim();
        var sel = document.getElementById('backup-folder');
        // Add and select the new option
        var opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        opt.selected = true;
        sel.appendChild(opt);
    },

    _backupPollTimer: null,
    _backupTicker: null,
    _backupHighPct: 0,
    _backupServerTarget: 0,

    async doCreateBackup() {
        var type = document.getElementById('backup-type').value;
        var folder = document.getElementById('backup-folder').value;
        document.querySelector('.modal-backdrop').remove();

        if (folder) {
            try {
                await WP.api('sites/' + WP.currentSite.id + '/backup-folder', {
                    method: 'PUT', body: { backup_folder: folder },
                });
                WP.currentSite.backup_folder = folder;
            } catch (e) { /* non-critical */ }
        }

        // Inject animation CSS (once)
        if (!document.getElementById('backup-anim-css')) {
            var style = document.createElement('style');
            style.id = 'backup-anim-css';
            style.textContent =
                '@keyframes backupPulse { 0%,100% { background:transparent } 50% { background:rgba(108,92,231,0.15) } }' +
                '.backup-row-new { animation: backupPulse 1.2s ease infinite; }' +
                '.backup-row-done { background:rgba(46,204,113,0.25); transition: background 0.8s ease; }' +
                '.backup-row-done.fade-out { background:transparent; }';
            document.head.appendChild(style);
        }

        var main = document.getElementById('main-content');
        var progressHtml = '<div id="backup-progress-card" style="' +
            'padding:24px;margin-bottom:20px;border:1px solid var(--border);border-radius:12px;' +
            'background:var(--bg-card, var(--bg))">' +
            '<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">' +
                '<div class="spinner" style="width:20px;height:20px"></div>' +
                '<h3 style="margin:0" id="backup-progress-title">Creating Backup...</h3>' +
            '</div>' +
            '<div style="background:rgba(255,255,255,0.05);border-radius:8px;height:24px;overflow:hidden;margin-bottom:8px;border:1px solid var(--border)">' +
                '<div id="backup-progress-bar" style="' +
                    'height:100%;width:0%;background:var(--accent, #6c5ce7);' +
                    'border-radius:7px;transition:none"></div>' +
            '</div>' +
            '<div style="display:flex;justify-content:space-between;align-items:center">' +
                '<div id="backup-progress-phase" style="font-size:13px;color:var(--text-muted)">Initializing...</div>' +
                '<div id="backup-progress-pct" style="font-size:13px;font-weight:600;color:var(--accent, #6c5ce7)">0%</div>' +
            '</div>' +
        '</div>';

        main.insertAdjacentHTML('afterbegin', progressHtml);

        var self = this;
        var siteId = WP.currentSite.id;
        self._backupHighPct = 0;
        self._backupServerTarget = 0;
        var backupDone = false;
        var serverLabel = 'Initializing...';

        // Helper: update bar — ONLY moves forward
        function setProgress(pct, label) {
            pct = Math.round(pct * 10) / 10;
            if (pct <= self._backupHighPct) pct = self._backupHighPct;
            self._backupHighPct = pct;
            var bar = document.getElementById('backup-progress-bar');
            var pctEl = document.getElementById('backup-progress-pct');
            var phaseEl = document.getElementById('backup-progress-phase');
            if (bar) bar.style.width = pct + '%';
            if (pctEl) pctEl.textContent = Math.round(pct) + '%';
            if (phaseEl && label) phaseEl.textContent = label;
        }

        // Smooth ticker every second — catches up to serverTarget gradually (max 2%/tick)
        // If no server data, uses a gentle autonomous increment
        self._backupTicker = setInterval(function() {
            if (backupDone) return;
            var p = self._backupHighPct;
            var target = self._backupServerTarget;
            var gap = target - p;
            var inc;

            if (gap > 20) inc = 2.0;       // server far ahead, catch up fast
            else if (gap > 10) inc = 1.5;   // server moderately ahead
            else if (gap > 3) inc = 1.0;    // server slightly ahead
            else if (p < 15) inc = 1.2;     // autonomous: early phase
            else if (p < 40) inc = 0.6;     // autonomous: mid-early
            else if (p < 65) inc = 0.4;     // autonomous: mid
            else if (p < 82) inc = 0.25;    // autonomous: mid-late
            else if (p < 90) inc = 0.12;    // autonomous: late
            else inc = 0.04;                // autonomous: very late, crawl

            setProgress(Math.min(94, p + inc), serverLabel);
        }, 1000);

        // Poll connector progress every 2s — sets the target for the ticker
        self._backupPollTimer = setInterval(function() {
            if (backupDone) return;
            WP.api('sites/' + siteId + '/backups/progress').then(function(progress) {
                if (backupDone) return;
                var phase = progress.phase || 'unknown';
                var serverPct = progress.pct || 0;

                if (phase === 'starting') {
                    serverLabel = 'Initializing backup...';
                } else if (phase === 'database') {
                    serverLabel = progress.db_done ? 'Database exported' : 'Exporting database...';
                } else if (phase === 'files') {
                    var section = progress.section ? ' (' + progress.section + ')' : '';
                    serverLabel = 'Compressing files' + section + '... ' + (progress.files_added || 0) + ' added';
                } else if (phase === 'finalizing') {
                    serverLabel = 'Finalizing archive...';
                    serverPct = Math.max(serverPct, 91);
                } else if (phase === 'completed' || phase === 'idle' || phase === 'not_found') {
                    serverLabel = 'Downloading to local storage...';
                    serverPct = 95;
                }

                // Set target — ticker will catch up gradually
                if (serverPct > self._backupServerTarget) {
                    self._backupServerTarget = serverPct;
                }
            }).catch(function() {});
        }, 2000);

        // Start the actual backup
        try {
            var result = await WP.api('sites/' + siteId + '/backups', {
                method: 'POST', body: { backup_type: type },
            });

            backupDone = true;
            clearInterval(self._backupPollTimer);
            clearInterval(self._backupTicker);

            setProgress(100, 'Backup complete!');

            // Fade out progress card, then insert new row into existing table
            var card = document.getElementById('backup-progress-card');
            setTimeout(function() {
                if (card) {
                    card.style.transition = 'opacity 0.4s';
                    card.style.opacity = '0';
                }
                setTimeout(function() {
                    if (card && card.parentNode) card.remove();
                    self._insertNewBackup(main, result.backup_row_id);
                }, 400);
            }, 1200);
        } catch (e) {
            backupDone = true;
            clearInterval(self._backupPollTimer);
            clearInterval(self._backupTicker);

            var card = document.getElementById('backup-progress-card');
            if (card) {
                card.innerHTML = '<div style="display:flex;align-items:center;gap:12px">' +
                    '<span style="font-size:24px">&#10060;</span>' +
                    '<div>' +
                        '<h3 style="margin:0;color:var(--red)">Backup Failed</h3>' +
                        '<p style="margin:4px 0 0;font-size:13px;color:var(--text-muted)">' + WP.stripHtml(e.message) + '</p>' +
                    '</div>' +
                '</div>';
                setTimeout(function() { if (card.parentNode) card.remove(); }, 8000);
            }
            WP.toast('Backup failed: ' + e.message, 'error');
        }
    },

    // Build a single backup table row
    _buildBackupRow: function(b, isNew) {
        var statusClass = {
            'completed': 'badge-green', 'in_progress': 'badge-blue',
            'failed': 'badge-red', 'restoring': 'badge-orange', 'restored': 'badge-purple',
        }[b.status] || 'badge-blue';

        var triggerLabel = {
            'manual': 'Manual', 'scheduled': 'Scheduled',
            'pre_update': 'Pre-Update', 'auto': 'Auto',
        }[b.trigger] || b.trigger;

        var typeLabel = {
            'full': 'Full', 'database': 'Database', 'files': 'Files',
        }[b.backup_type] || b.backup_type;

        var hasLocal = b.metadata && b.metadata.local_path;
        var storageIndicator = hasLocal
            ? '<span title="Stored locally" style="color:var(--green)">&#10003; Local</span>'
            : '<span style="color:var(--text-muted);font-size:11px">Remote only</span>';

        return '<tr data-backup-id="' + b.id + '"' + (isNew ? ' class="backup-row-new"' : '') + '>' +
            '<td>' + WP.formatDate(b.created_at) + '</td>' +
            '<td>' + WP.stripHtml(typeLabel) + '</td>' +
            '<td>' + (b.size_bytes ? this._formatBytes(b.size_bytes) : '--') + '</td>' +
            '<td><span class="badge badge-blue">' + WP.stripHtml(triggerLabel) + '</span></td>' +
            '<td><span class="badge ' + statusClass + '">' + b.status + '</span></td>' +
            '<td>' + storageIndicator + '</td>' +
            '<td style="white-space:nowrap">' +
                (b.status === 'completed' ?
                    '<button class="btn-sm" onclick="WP.Automation.downloadBackup(\'' + b.id + '\')" title="Download">&#128229;</button> ' +
                    '<button class="btn-sm" onclick="WP.Automation.restoreBackup(\'' + b.id + '\')" title="Restore">&#128260;</button> '
                : '') +
                '<button class="btn-sm" onclick="WP.Automation.deleteBackup(\'' + b.id + '\')" title="Delete" style="color:var(--red)">&#128465;</button>' +
            '</td>' +
        '</tr>';
    },

    // Insert a new backup row into the existing page — no full re-render
    async _insertNewBackup(main, backupRowId) {
        // Fetch updated backup list
        try {
            this.backups = await WP.api('sites/' + WP.currentSite.id + '/backups');
        } catch (e) {
            this.backups = [];
        }

        // Find the new backup
        var newBackup = null;
        if (backupRowId) {
            for (var i = 0; i < this.backups.length; i++) {
                if (this.backups[i].id === backupRowId) {
                    newBackup = this.backups[i];
                    break;
                }
            }
        }
        if (!newBackup && this.backups.length > 0) {
            newBackup = this.backups[0]; // fallback: newest
        }

        if (!newBackup) {
            WP.toast('Backup completed');
            return;
        }

        var tbody = main.querySelector('.data-table tbody');
        var emptyState = main.querySelector('.empty-state');

        if (tbody) {
            // Table exists — prepend the new row
            var rowHtml = this._buildBackupRow(newBackup, true);
            tbody.insertAdjacentHTML('afterbegin', rowHtml);
        } else if (emptyState) {
            // Was empty — replace empty state with a table
            var tableHtml = '<table class="data-table">' +
                '<thead><tr>' +
                    '<th>Date</th><th>Type</th><th>Size</th><th>Trigger</th><th>Status</th><th>Storage</th><th>Actions</th>' +
                '</tr></thead><tbody>' +
                this._buildBackupRow(newBackup, true) +
                '</tbody></table>';
            emptyState.outerHTML = tableHtml;
        } else {
            // Fallback: full render
            this._highlightBackupId = backupRowId;
            this.renderBackups(main);
            WP.toast('Backup completed');
            return;
        }

        // Update stat cards if they exist
        var statCards = main.querySelectorAll('.stat-card');
        if (statCards.length >= 4) {
            var totalSize = 0;
            var completedCount = 0;
            for (var i = 0; i < this.backups.length; i++) {
                if (this.backups[i].size_bytes) totalSize += this.backups[i].size_bytes;
                if (this.backups[i].status === 'completed') completedCount++;
            }
            statCards[0].querySelector('.stat-value').textContent = this.backups.length;
            statCards[1].querySelector('.stat-value').textContent = completedCount;
            statCards[2].querySelector('.stat-value').textContent = this._formatBytes(totalSize);
            statCards[3].querySelector('.stat-value').textContent = this._relativeTime(this.backups[0].created_at);
        } else if (!statCards.length && this.backups.length > 0) {
            // Insert stats row (first backup ever)
            var header = main.querySelector('.main-header');
            if (header) {
                var statsHtml = '<div style="display:flex;gap:16px;margin-bottom:16px">' +
                    '<div class="stat-card"><div class="stat-value">1</div><div class="stat-label">Total Backups</div></div>' +
                    '<div class="stat-card"><div class="stat-value">1</div><div class="stat-label">Completed</div></div>' +
                    '<div class="stat-card"><div class="stat-value">' + this._formatBytes(newBackup.size_bytes || 0) + '</div><div class="stat-label">Total Size</div></div>' +
                    '<div class="stat-card"><div class="stat-value">' + this._relativeTime(newBackup.created_at) + '</div><div class="stat-label">Last Backup</div></div>' +
                '</div>';
                header.insertAdjacentHTML('afterend', statsHtml);
            }
        }

        WP.toast('Backup completed');

        // After brief pulse, switch to persistent green — fades on hover >1s
        setTimeout(function() {
            var row = main.querySelector('.backup-row-new');
            if (row) {
                row.classList.remove('backup-row-new');
                row.classList.add('backup-row-done');
                var hoverTimer = null;
                row.addEventListener('mouseenter', function onEnter() {
                    hoverTimer = setTimeout(function() {
                        row.classList.add('fade-out');
                        row.removeEventListener('mouseenter', onEnter);
                        row.removeEventListener('mouseleave', onLeave);
                    }, 1000);
                });
                var onLeave = function() {
                    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
                };
                row.addEventListener('mouseleave', onLeave);
            }
        }, 1500);
    },

    async restoreBackup(id) {
        if (!confirm('Are you sure you want to restore this backup? This will overwrite your current site data.')) return;

        WP.toast('Restoring backup...');

        try {
            await WP.api('backups/' + id + '/restore', { method: 'POST' });
            WP.toast('Backup restored successfully');
            this.renderBackups(document.getElementById('main-content'));
        } catch (e) {
            WP.toast('Restore failed: ' + e.message, 'error');
        }
    },

    async downloadBackup(id) {
        try {
            var token = WP.session && WP.session.access_token;
            if (!token) throw new Error('Not authenticated — please refresh the page');

            // Native browser download via query-string token — fast, streams directly
            var url = 'api/backups/' + id + '/download?token=' + encodeURIComponent(token);
            var link = document.createElement('a');
            link.href = url;
            link.style.display = 'none';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            WP.toast('Download started');
        } catch (e) {
            WP.toast('Download failed: ' + e.message, 'error');
        }
    },

    async deleteBackup(id) {
        if (!confirm('Delete this backup? This cannot be undone.')) return;
        try {
            await WP.api('backups/' + id, { method: 'DELETE' });

            // Remove from local array
            this.backups = this.backups.filter(function(b) { return b.id !== id; });

            // Remove the row from the DOM with a slide-up animation
            var row = document.querySelector('tr[data-backup-id="' + id + '"]');
            if (row) {
                row.style.transition = 'opacity 0.3s, transform 0.3s';
                row.style.opacity = '0';
                row.style.transform = 'translateX(30px)';
                setTimeout(function() { row.remove(); }, 300);
            }

            // Update stat cards in place
            var main = document.getElementById('main-content');
            var statCards = main.querySelectorAll('.stat-card');
            if (statCards.length >= 4) {
                var totalSize = 0, completedCount = 0;
                for (var i = 0; i < this.backups.length; i++) {
                    if (this.backups[i].size_bytes) totalSize += this.backups[i].size_bytes;
                    if (this.backups[i].status === 'completed') completedCount++;
                }
                statCards[0].querySelector('.stat-value').textContent = this.backups.length;
                statCards[1].querySelector('.stat-value').textContent = completedCount;
                statCards[2].querySelector('.stat-value').textContent = this._formatBytes(totalSize);
                statCards[3].querySelector('.stat-value').textContent = this.backups.length > 0
                    ? this._relativeTime(this.backups[0].created_at) : '--';
            }

            // If no backups left, show empty state
            if (this.backups.length === 0) {
                setTimeout(function() {
                    var table = main.querySelector('.data-table');
                    var statsRow = table ? table.previousElementSibling : null;
                    if (statsRow && statsRow.querySelector('.stat-card')) statsRow.remove();
                    if (table) {
                        table.outerHTML = '<div class="empty-state">' +
                            '<div class="empty-icon">&#128190;</div>' +
                            '<h3>No backups yet</h3>' +
                            '<p>Create a backup manually or set up an automated schedule.</p>' +
                        '</div>';
                    }
                }, 350);
            }

            WP.toast('Backup deleted');
        } catch (e) {
            WP.toast('Delete failed: ' + e.message, 'error');
        }
    },

    // ═══════════════════════════════════════════════════════════
    //  ACTIVITY LOG
    // ═══════════════════════════════════════════════════════════

    async renderLogs(main) {
        if (!WP.requireSite(main)) return;

        main.innerHTML = '<div class="loading-inline"><div class="spinner"></div></div>';

        // Load logs and stats in parallel
        var params = 'page=' + this.logsPage + '&limit=20';
        if (this.logsStatus) params += '&status=' + this.logsStatus;
        if (this.logsTaskType) params += '&task_type=' + this.logsTaskType;

        var results = await Promise.allSettled([
            WP.api('sites/' + WP.currentSite.id + '/logs?' + params),
            WP.api('sites/' + WP.currentSite.id + '/logs/stats'),
        ]);

        var data = results[0].status === 'fulfilled' ? results[0].value : { logs: [], total: 0 };
        this.logs = data.logs || [];
        this.logsTotal = data.total || 0;
        this.logStats = results[1].status === 'fulfilled' ? results[1].value : null;

        var html = '<div class="main-header">' +
            '<h2>Activity Log — ' + WP.stripHtml(WP.currentSite.name) + '</h2>' +
            '<span style="font-size:13px;color:var(--text-muted)">' + this.logsTotal + ' entries' +
                (this.logsStatus ? ' (' + this.logsStatus + ')' : '') +
            '</span>' +
        '</div>';

        // Stats cards
        if (this.logStats && this.logStats.total > 0) {
            html += '<div style="display:flex;gap:12px;margin-bottom:16px">' +
                '<div class="stat-card"><div class="stat-value">' + this.logStats.total + '</div><div class="stat-label">Total Runs</div></div>' +
                '<div class="stat-card"><div class="stat-value" style="color:var(--green)">' + this.logStats.success + '</div><div class="stat-label">Successful</div></div>' +
                '<div class="stat-card"><div class="stat-value" style="color:var(--red)">' + this.logStats.failed + '</div><div class="stat-label">Failed</div></div>' +
                '<div class="stat-card"><div class="stat-value" style="color:var(--orange)">' + this.logStats.rolled_back + '</div><div class="stat-label">Rolled Back</div></div>' +
            '</div>';
        }

        // Filter tabs
        var statuses = [
            { value: '', label: 'All' },
            { value: 'success', label: 'Success' },
            { value: 'failed', label: 'Failed' },
            { value: 'rolled_back', label: 'Rolled Back' },
            { value: 'running', label: 'Running' },
        ];

        html += '<div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center">';
        html += '<div class="tab-bar">';
        for (var i = 0; i < statuses.length; i++) {
            var s = statuses[i];
            var active = this.logsStatus === s.value ? ' active' : '';
            html += '<button class="tab-btn' + active + '" onclick="WP.Automation.filterLogs(\'' + s.value + '\')">' + s.label + '</button>';
        }
        html += '</div>';

        // Task type filter
        html += '<select class="form-input" style="width:auto;font-size:12px;padding:5px 10px" onchange="WP.Automation.filterLogsByType(this.value)">' +
            '<option value="">All task types</option>';
        for (var i = 0; i < this.taskTypes.length; i++) {
            var t = this.taskTypes[i];
            html += '<option value="' + t.value + '"' + (this.logsTaskType === t.value ? ' selected' : '') + '>' + t.label + '</option>';
        }
        html += '</select>';
        html += '</div>';

        if (!this.logs.length) {
            html += '<div class="empty-state">' +
                '<div class="empty-icon">&#128203;</div>' +
                '<h3>No activity' + (this.logsStatus ? ' matching "' + this.logsStatus + '"' : '') + '</h3>' +
                '<p>Execution logs will appear here when schedules run.</p>' +
            '</div>';
        } else {
            html += '<div class="log-list">';

            for (var i = 0; i < this.logs.length; i++) {
                var l = this.logs[i];
                var statusClass = {
                    'success': 'badge-green', 'running': 'badge-blue',
                    'failed': 'badge-red', 'rolled_back': 'badge-orange',
                }[l.status] || 'badge-blue';

                var scheduleName = l.wp_schedules ? l.wp_schedules.name : 'Manual';
                var duration = l.finished_at && l.started_at
                    ? Math.round((new Date(l.finished_at) - new Date(l.started_at)) / 1000) + 's'
                    : 'running...';

                var taskLabel = this._taskLabel(l.task_type);
                var triggerIcon = l.trigger === 'manual' ? '&#9995;' : '&#128337;';
                var stepsCount = l.steps ? l.steps.length : 0;
                var passCount = 0;
                var failCount = 0;
                if (l.steps) {
                    for (var j = 0; j < l.steps.length; j++) {
                        if (l.steps[j].status === 'pass') passCount++;
                        else failCount++;
                    }
                }

                html += '<div class="log-entry" onclick="WP.Automation.showLogDetail(\'' + l.id + '\')">' +
                    '<div class="log-entry-header">' +
                        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
                            '<strong>' + WP.stripHtml(scheduleName) + '</strong>' +
                            '<span class="badge badge-blue">' + WP.stripHtml(taskLabel) + '</span>' +
                            '<span class="badge ' + statusClass + '">' + l.status + '</span>' +
                            '<span style="font-size:11px;color:var(--text-muted)" title="Trigger">' + triggerIcon + ' ' + (l.trigger || 'schedule') + '</span>' +
                        '</div>' +
                        '<div style="display:flex;gap:12px;align-items:center">' +
                            (stepsCount > 0 ? '<span style="font-size:11px;color:var(--text-muted)">' + passCount + '/' + stepsCount + ' steps passed</span>' : '') +
                            '<span style="font-size:12px;color:var(--text-muted)">' + duration + '</span>' +
                            '<span style="font-size:12px;color:var(--text-muted)">' + this._relativeTime(l.started_at) + '</span>' +
                            '<span style="font-size:11px;color:var(--text-muted)">&#9654;</span>' +
                        '</div>' +
                    '</div>' +
                '</div>';
            }

            html += '</div>';

            // Pagination
            var totalPages = Math.ceil(this.logsTotal / 20);
            if (totalPages > 1) {
                html += '<div class="pagination">' +
                    '<button ' + (this.logsPage === 0 ? 'disabled' : '') + ' onclick="WP.Automation.logsPage--;WP.Automation.renderLogs(document.getElementById(\'main-content\'))">Prev</button>' +
                    '<span class="page-info">Page ' + (this.logsPage + 1) + ' of ' + totalPages + '</span>' +
                    '<button ' + (this.logsPage >= totalPages - 1 ? 'disabled' : '') + ' onclick="WP.Automation.logsPage++;WP.Automation.renderLogs(document.getElementById(\'main-content\'))">Next</button>' +
                '</div>';
            }
        }

        main.innerHTML = html;
    },

    filterLogs(status) {
        this.logsStatus = status;
        this.logsPage = 0;
        this.renderLogs(document.getElementById('main-content'));
    },

    filterLogsByType(taskType) {
        this.logsTaskType = taskType;
        this.logsPage = 0;
        this.renderLogs(document.getElementById('main-content'));
    },

    // ── Log Detail Modal ─────────────────────────────────

    async showLogDetail(logId) {
        var backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';
        backdrop.id = 'log-detail-modal';
        backdrop.onclick = function(e) { if (e.target === backdrop) backdrop.remove(); };
        backdrop.innerHTML = '<div class="modal" style="max-width:700px"><div class="spinner" style="margin:40px auto"></div></div>';
        document.body.appendChild(backdrop);

        try {
            var l = await WP.api('logs/' + logId);

            var scheduleName = l.wp_schedules ? l.wp_schedules.name : 'Manual Run';
            var taskLabel = this._taskLabel(l.task_type);
            var statusClass = {
                'success': 'badge-green', 'running': 'badge-blue',
                'failed': 'badge-red', 'rolled_back': 'badge-orange',
            }[l.status] || 'badge-blue';

            var duration = l.finished_at && l.started_at
                ? Math.round((new Date(l.finished_at) - new Date(l.started_at)) / 1000)
                : null;

            var stepsHtml = this._renderSteps(l.steps || []);

            var modal = backdrop.querySelector('.modal');
            modal.innerHTML =
                '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">' +
                    '<h3 style="margin:0">' + WP.stripHtml(scheduleName) + '</h3>' +
                    '<span class="badge ' + statusClass + '" style="font-size:13px;padding:4px 12px">' + l.status + '</span>' +
                '</div>' +

                '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px">' +
                    '<div style="background:var(--bg);padding:10px;border-radius:8px;text-align:center">' +
                        '<div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Task</div>' +
                        '<div style="font-size:13px;font-weight:500;margin-top:2px">' + WP.stripHtml(taskLabel) + '</div>' +
                    '</div>' +
                    '<div style="background:var(--bg);padding:10px;border-radius:8px;text-align:center">' +
                        '<div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Trigger</div>' +
                        '<div style="font-size:13px;font-weight:500;margin-top:2px">' + (l.trigger || 'schedule') + '</div>' +
                    '</div>' +
                    '<div style="background:var(--bg);padding:10px;border-radius:8px;text-align:center">' +
                        '<div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Duration</div>' +
                        '<div style="font-size:13px;font-weight:500;margin-top:2px">' + (duration !== null ? duration + 's' : 'running...') + '</div>' +
                    '</div>' +
                    '<div style="background:var(--bg);padding:10px;border-radius:8px;text-align:center">' +
                        '<div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Started</div>' +
                        '<div style="font-size:13px;font-weight:500;margin-top:2px">' + (l.started_at ? WP.formatDate(l.started_at) : '--') + '</div>' +
                    '</div>' +
                '</div>' +

                (l.rollback_backup_id ?
                    '<div class="callout callout-warn" style="margin-bottom:16px">' +
                        '<span class="callout-icon">&#128260;</span>' +
                        '<div><strong>Auto-rollback triggered</strong> — The site was restored from a pre-update backup after a post-update health check failed.</div>' +
                    '</div>'
                : '') +

                '<div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;margin-bottom:8px">Execution Steps</div>' +
                stepsHtml +

                '<div class="modal-actions" style="margin-top:16px">' +
                    '<button class="btn btn-ghost" onclick="document.getElementById(\'log-detail-modal\').remove()">Close</button>' +
                '</div>';

        } catch (e) {
            var modal = backdrop.querySelector('.modal');
            modal.innerHTML = '<p style="color:var(--red);padding:20px">Failed to load log: ' + e.message + '</p>' +
                '<div class="modal-actions"><button class="btn btn-ghost" onclick="document.getElementById(\'log-detail-modal\').remove()">Close</button></div>';
        }
    },

    _renderSteps(steps) {
        if (!steps.length) return '<div style="padding:12px;color:var(--text-muted);font-size:12px">No steps recorded</div>';

        var html = '<div class="step-timeline">';
        for (var i = 0; i < steps.length; i++) {
            var step = steps[i];
            var icon = step.status === 'pass' ? '&#9989;' : '&#10060;';
            var stepName = {
                'pre_backup': 'Pre-Update Backup',
                'apply_updates': 'Apply Updates',
                'health_check': 'Health Check',
                'post_update_health': 'Post-Update Health Check',
                'rollback': 'Rollback',
                'backup': 'Backup',
                'connector_health': 'Connector Health',
                'homepage_http': 'Homepage HTTP',
                'wp_rest_api': 'WP REST API',
            }[step.name] || step.name;

            var detail = '';
            if (step.detail) {
                if (typeof step.detail === 'object') {
                    // For health check steps (array of sub-checks)
                    if (Array.isArray(step.detail)) {
                        detail = '<div class="step-sub-checks">';
                        for (var j = 0; j < step.detail.length; j++) {
                            var sub = step.detail[j];
                            var subIcon = sub.status === 'pass' ? '&#9989;' : '&#10060;';
                            detail += '<div class="step-sub-check">' + subIcon + ' ' + WP.stripHtml(sub.name || '') +
                                (sub.detail ? ' <span style="color:var(--text-muted)">— ' + WP.stripHtml(String(sub.detail).substring(0, 100)) + '</span>' : '') +
                            '</div>';
                        }
                        detail += '</div>';
                    } else {
                        detail = '<pre class="step-detail">' + WP.stripHtml(JSON.stringify(step.detail, null, 2)).substring(0, 500) + '</pre>';
                    }
                } else {
                    detail = '<pre class="step-detail">' + WP.stripHtml(String(step.detail)).substring(0, 500) + '</pre>';
                }
            }

            html += '<div class="step-item step-' + step.status + '">' +
                '<span class="step-icon">' + icon + '</span>' +
                '<div class="step-content">' +
                    '<div class="step-name">' + WP.stripHtml(stepName) + '</div>' +
                    detail +
                '</div>' +
            '</div>';
        }
        html += '</div>';
        return html;
    },

    // ═══════════════════════════════════════════════════════════
    //  CONNECTOR SETUP (shared by Schedules + Backups)
    // ═══════════════════════════════════════════════════════════

    async setupConnector() {
        if (!WP.currentSite) return;

        try {
            var result = await WP.api('sites/' + WP.currentSite.id + '/connector/setup', { method: 'POST' });

            var html = '<div class="modal-backdrop" onclick="if(event.target===this)this.remove()">' +
                '<div class="modal" style="max-width:640px">' +
                    '<h3>Setup OPAI Connector</h3>' +
                    '<div class="callout callout-info">' +
                        '<span class="callout-icon">&#128268;</span>' +
                        '<div>Follow these steps to install the connector on <strong>' + WP.stripHtml(WP.currentSite.name) + '</strong></div>' +
                    '</div>' +
                    '<ol style="font-size:13px;line-height:2;padding-left:20px">' +
                        result.instructions.map(function(inst) { return '<li>' + inst + '</li>'; }).join('') +
                    '</ol>' +
                    '<div class="form-group" style="margin-top:16px">' +
                        '<label>WP-CLI Command</label>' +
                        '<div style="display:flex;gap:8px">' +
                            '<input class="form-input" readonly value="' + WP.stripHtml(result.wp_cli_command) + '" id="connector-cmd" style="font-family:monospace;font-size:12px">' +
                            '<button class="btn btn-ghost" onclick="navigator.clipboard.writeText(document.getElementById(\'connector-cmd\').value);WP.toast(\'Copied!\')">Copy</button>' +
                        '</div>' +
                    '</div>' +
                    '<div class="modal-actions">' +
                        '<button class="btn btn-ghost" onclick="this.closest(\'.modal-backdrop\').remove()">Close</button>' +
                        '<button class="btn btn-primary" onclick="WP.Automation.verifyConnector()">Verify Connection</button>' +
                    '</div>' +
                '</div>' +
            '</div>';

            document.body.insertAdjacentHTML('beforeend', html);
        } catch (e) {
            WP.toast('Error: ' + e.message, 'error');
        }
    },

    async verifyConnector() {
        try {
            var result = await WP.api('sites/' + WP.currentSite.id + '/connector/verify', { method: 'POST' });
            if (result.verified) {
                WP.toast('Connector verified!');
                document.querySelector('.modal-backdrop').remove();
                this.renderSchedules(document.getElementById('main-content'));
            } else {
                WP.toast('Connector not reachable: ' + (result.error || 'Unknown error'), 'error');
            }
        } catch (e) {
            WP.toast('Verification failed: ' + e.message, 'error');
        }
    },

    // ═══════════════════════════════════════════════════════════
    //  UTILITIES
    // ═══════════════════════════════════════════════════════════

    _formatBytes(bytes) {
        if (!bytes || bytes === 0) return '0 B';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
        return (bytes / 1073741824).toFixed(1) + ' GB';
    },

    _relativeTime(iso) {
        if (!iso) return '--';
        var diff = (new Date() - new Date(iso)) / 1000;
        if (diff < 0) {
            var abs = Math.abs(diff);
            if (abs < 60) return 'in ' + Math.round(abs) + 's';
            if (abs < 3600) return 'in ' + Math.round(abs / 60) + 'm';
            if (abs < 86400) return 'in ' + Math.round(abs / 3600) + 'h';
            return 'in ' + Math.round(abs / 86400) + 'd';
        }
        if (diff < 60) return Math.round(diff) + 's ago';
        if (diff < 3600) return Math.round(diff / 60) + 'm ago';
        if (diff < 86400) return Math.round(diff / 3600) + 'h ago';
        return Math.round(diff / 86400) + 'd ago';
    },

    _cronToHuman(cron) {
        var preset = this.cronPresets.find(function(p) { return p.cron === cron; });
        if (preset && preset.cron) return preset.label;

        var parts = cron.split(' ');
        if (parts.length !== 5) return cron;

        var min = parts[0], hour = parts[1], dom = parts[2], mon = parts[3], dow = parts[4];

        if (dom === '*' && mon === '*' && dow === '*') {
            if (hour.indexOf('*/') === 0) return 'Every ' + hour.slice(2) + ' hours';
            if (min === '0') return 'Daily at ' + hour + ':00';
            return 'Daily at ' + hour + ':' + (min.length < 2 ? '0' : '') + min;
        }
        if (dow !== '*' && dom === '*') {
            var days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
            return 'Weekly on ' + (days[parseInt(dow)] || dow);
        }
        if (dom !== '*') return 'Monthly on day ' + dom;

        return cron;
    },
};
