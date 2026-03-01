/**
 * OPAI Agent Studio — Scheduler view.
 */

const Scheduler = (() => {
    let schedules = [];
    let presets = [];
    let editingName = null;

    async function render() {
        if (!currentUser?.isAdmin) {
            document.getElementById('schedule-list').innerHTML =
                '<p class="text-muted">Scheduler is admin-only.</p>';
            return;
        }
        try {
            const [schedData, presetData] = await Promise.all([
                apiFetch('/schedules'),
                apiFetch('/schedules/presets'),
            ]);
            schedules = schedData.schedules || [];
            presets = presetData.presets || [];
        } catch (e) {
            document.getElementById('schedule-list').innerHTML =
                '<p class="text-muted">Could not load schedules.</p>';
            return;
        }
        _renderList();
    }

    function _renderList() {
        const container = document.getElementById('schedule-list');
        if (!schedules.length) {
            container.innerHTML = '<p class="text-muted">No schedules configured.</p>';
            return;
        }
        container.innerHTML = schedules.map(s =>
            '<div class="schedule-row">' +
            '<div class="sr-info">' +
            '<strong>' + esc(s.name) + '</strong>' +
            '<span class="text-muted">' + esc(s.description) + '</span>' +
            '</div>' +
            '<code class="sr-cron">' + esc(s.cron) + '</code>' +
            '<div class="action-btns">' +
            '<button class="btn btn-sm" onclick="Scheduler.edit(\'' + esc(s.name) + '\')">Edit</button>' +
            '<button class="btn btn-sm btn-danger" onclick="Scheduler.confirmDelete(\'' + esc(s.name) + '\')">Del</button>' +
            '</div>' +
            '</div>'
        ).join('');
    }

    function showCreate() {
        editingName = null;
        document.getElementById('sched-modal-title').textContent = 'Add Schedule';
        document.getElementById('sched-name').value = '';
        document.getElementById('sched-name').disabled = false;
        document.getElementById('sched-cron').value = '';
        document.getElementById('cron-preview').textContent = '--';
        _populatePresets();
        document.getElementById('schedule-overlay').classList.remove('hidden');
    }

    function edit(name) {
        const s = schedules.find(x => x.name === name);
        if (!s) return;
        editingName = name;
        document.getElementById('sched-modal-title').textContent = 'Edit Schedule';
        document.getElementById('sched-name').value = s.name;
        document.getElementById('sched-name').disabled = true;
        document.getElementById('sched-cron').value = s.cron;
        document.getElementById('cron-preview').textContent = s.description;
        _populatePresets();
        // Try to match a preset
        const match = presets.find(p => p.cron === s.cron);
        document.getElementById('sched-preset').value = match ? match.id : '';
        document.getElementById('schedule-overlay').classList.remove('hidden');
    }

    function closeModal() {
        document.getElementById('schedule-overlay').classList.add('hidden');
        document.getElementById('sched-name').disabled = false;
        editingName = null;
    }

    function _populatePresets() {
        const sel = document.getElementById('sched-preset');
        sel.innerHTML = '<option value="">Custom...</option>' +
            presets.map(p => '<option value="' + esc(p.id) + '">' + esc(p.label) + '</option>').join('');
    }

    function applyPreset() {
        const sel = document.getElementById('sched-preset');
        const preset = presets.find(p => p.id === sel.value);
        if (preset) {
            document.getElementById('sched-cron').value = preset.cron;
            document.getElementById('cron-preview').textContent = preset.label;
        }
    }

    async function save() {
        const name = document.getElementById('sched-name').value.trim();
        const cron = document.getElementById('sched-cron').value.trim();

        if (!name) { toast('Schedule name is required', 'error'); return; }
        if (!cron) { toast('Cron expression is required', 'error'); return; }

        try {
            if (editingName) {
                await apiFetch('/schedules/' + editingName, {
                    method: 'PUT',
                    body: JSON.stringify({ cron }),
                });
                toast('Schedule updated', 'success');
            } else {
                await apiFetch('/schedules', {
                    method: 'POST',
                    body: JSON.stringify({ name, cron }),
                });
                toast('Schedule created', 'success');
            }
            closeModal();
            render();
        } catch (e) {
            toast(e.message, 'error');
        }
    }

    async function confirmDelete(name) {
        if (!confirm('Delete schedule "' + name + '"?')) return;
        try {
            await apiFetch('/schedules/' + name, { method: 'DELETE' });
            toast('Schedule deleted', 'success');
            render();
        } catch (e) {
            toast(e.message, 'error');
        }
    }

    return { render, showCreate, edit, closeModal, applyPreset, save, confirmDelete };
})();
