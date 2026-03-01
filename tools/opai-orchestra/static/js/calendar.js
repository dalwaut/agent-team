/**
 * OPAI Agent Orchestra — Concert Calendar (Scheduler).
 * Orchestra term: "Concert Calendar" = Agent Studio's "Scheduler" tab.
 */

const CalendarView = (() => {

    function render() {
        const shell = document.getElementById('calendar-shell');
        shell.innerHTML =
            '<div class="panel-title">📅 Concert Calendar <span class="term-badge">Scheduler</span></div>' +
            '<div class="panel-subtitle">Schedule recurring performances on a cron-based timetable — admin only</div>';

        if (!currentUser?.isAdmin) {
            shell.innerHTML += '<div class="empty-state"><div class="empty-emblem">🔒</div><div class="empty-title">Admin access required</div><div class="empty-sub">Only admins can manage the concert calendar.</div></div>';
            return;
        }

        shell.innerHTML +=
            '<div style="display:flex;gap:10px;margin-bottom:24px">' +
                '<button class="btn-gold" onclick="CalendarView.openNewSchedule()">＋ Schedule Performance</button>' +
                '<button class="btn-ghost" onclick="CalendarView.refresh()">↻ Refresh</button>' +
            '</div>' +
            '<div id="cal-list"></div>';

        loadSchedules();
    }

    async function loadSchedules() {
        const el = document.getElementById('cal-list');
        if (!el) return;
        try {
            const resp = await apiFetch('/schedules');
            const schedules = resp.schedules || [];

            if (!schedules.length) {
                el.innerHTML = '<div class="empty-state"><div class="empty-emblem">📅</div><div class="empty-title">No scheduled performances</div><div class="empty-sub">Add a schedule to have programmes run automatically.</div></div>';
                return;
            }

            el.innerHTML = '<table class="orch-table">' +
                '<thead><tr>' +
                    '<th>Performance Name <span class="term-badge">Schedule</span></th>' +
                    '<th>Programme <span class="term-badge">Squad</span></th>' +
                    '<th>Timing <span class="term-badge">Cron</span></th>' +
                    '<th>Status</th>' +
                    '<th>Actions</th>' +
                '</tr></thead>' +
                '<tbody>' +
                schedules.map(s =>
                    '<tr>' +
                        '<td><strong>' + esc(s.name) + '</strong></td>' +
                        '<td>' + esc(s.squad) + '</td>' +
                        '<td><code style="font-family:var(--font-mono);font-size:11px">' + esc(s.cron) + '</code></td>' +
                        '<td>' +
                            '<span class="status-dot ' + (s.enabled ? 'done' : 'done') + '" style="background:' + (s.enabled ? 'var(--c-quality)' : 'var(--text-faint)') + '"></span> ' +
                            (s.enabled ? 'Active' : 'Paused') +
                        '</td>' +
                        '<td>' +
                            '<button class="btn-ghost btn-sm" onclick="CalendarView.toggleSchedule(\'' + esc(s.name) + '\', ' + !s.enabled + ')">' +
                                (s.enabled ? '⏸ Pause' : '▶ Resume') +
                            '</button> ' +
                            '<button class="btn-ghost btn-sm" style="color:var(--c-security)" onclick="CalendarView.deleteSchedule(\'' + esc(s.name) + '\')">🗑️</button>' +
                        '</td>' +
                    '</tr>'
                ).join('') +
                '</tbody></table>';
        } catch(e) {
            el.innerHTML = '<div class="empty-state"><div class="empty-sub">Could not load schedules: ' + esc(e.message) + '</div></div>';
        }
    }

    function openNewSchedule() {
        const presets = [
            { label: 'Nightly (2 AM)',       cron: '0 2 * * *' },
            { label: 'Weekday mornings (8 AM)', cron: '0 8 * * 1-5' },
            { label: 'Every 6 hours',        cron: '0 */6 * * *' },
            { label: 'Weekly (Sunday 3 AM)', cron: '0 3 * * 0' },
            { label: 'Hourly',               cron: '0 * * * *' },
        ];

        const squadOptions = State.squads.map(s =>
            '<option value="' + esc(s.id) + '">' + esc(s.id) + ' — ' + esc(s.description || '') + '</option>'
        ).join('');

        document.getElementById('musician-modal-box').innerHTML =
            '<div class="modal-header">' +
                '<h2>Schedule Performance <span class="term-badge">Add Schedule</span></h2>' +
                '<button class="modal-close" onclick="document.getElementById(\'musician-modal\').classList.add(\'hidden\')">✕</button>' +
            '</div>' +
            '<form class="orch-form" onsubmit="CalendarView.submitSchedule(event)">' +
                '<label>Schedule Name <span class="term-badge">Schedule ID</span>' +
                    '<input class="orch-input" id="sched-name" placeholder="e.g. nightly_audit" pattern="[a-z0-9_]+" required>' +
                '</label>' +
                '<label>Programme <span class="term-badge">Squad</span>' +
                    '<select class="orch-select-field" id="sched-squad">' + squadOptions + '</select>' +
                '</label>' +
                '<label>Timing (Cron Expression) <span class="term-badge">Cron</span>' +
                    '<input class="orch-input" id="sched-cron" placeholder="e.g. 0 2 * * *" required>' +
                    '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">' +
                        presets.map(p => '<button type="button" class="btn-ghost btn-sm" onclick="document.getElementById(\'sched-cron\').value=\'' + esc(p.cron) + '\'">' + esc(p.label) + '</button>').join('') +
                    '</div>' +
                '</label>' +
                '<div class="modal-actions">' +
                    '<button type="button" class="btn-ghost" onclick="document.getElementById(\'musician-modal\').classList.add(\'hidden\')">Cancel</button>' +
                    '<button type="submit" class="btn-gold">Add to Calendar</button>' +
                '</div>' +
            '</form>';

        document.getElementById('musician-modal').classList.remove('hidden');
        document.getElementById('sched-name')?.focus();
    }

    async function submitSchedule(e) {
        e.preventDefault();
        const name  = document.getElementById('sched-name').value.trim();
        const squad = document.getElementById('sched-squad').value;
        const cron  = document.getElementById('sched-cron').value.trim();
        try {
            await apiFetch('/schedules', {
                method: 'POST',
                body: JSON.stringify({ name, squad, cron, enabled: true }),
            });
            document.getElementById('musician-modal').classList.add('hidden');
            toast('Performance scheduled: ' + name, 'success');
            loadSchedules();
        } catch(err) { toast(err.message, 'error'); }
    }

    async function toggleSchedule(name, enabled) {
        try {
            await apiFetch('/schedules/' + encodeURIComponent(name), {
                method: 'PUT',
                body: JSON.stringify({ enabled }),
            });
            toast('Schedule ' + (enabled ? 'resumed' : 'paused'), 'success');
            loadSchedules();
        } catch(e) { toast(e.message, 'error'); }
    }

    async function deleteSchedule(name) {
        const ok = await showConfirm('Remove from Calendar?', 'Delete schedule "' + name + '"?', 'Delete');
        if (!ok) return;
        try {
            await apiFetch('/schedules/' + encodeURIComponent(name), { method: 'DELETE' });
            toast('Schedule removed', 'success');
            loadSchedules();
        } catch(e) { toast(e.message, 'error'); }
    }

    async function refresh() { loadSchedules(); }

    return { render, openNewSchedule, submitSchedule, toggleSchedule, deleteSchedule, refresh };
})();
