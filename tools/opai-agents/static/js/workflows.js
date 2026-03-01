/**
 * OPAI Agent Studio — Workflows view (chain squads).
 */

const Workflows = (() => {
    let workflows = [];
    let editingId = null;
    let steps = []; // current steps being built

    async function render() {
        try {
            const data = await apiFetch('/workflows');
            workflows = data.workflows || [];
        } catch (e) {
            workflows = [];
        }
        document.getElementById('workflow-count').textContent = workflows.length;
        _renderList();
    }

    function _renderList() {
        const container = document.getElementById('workflow-list');
        if (!workflows.length) {
            container.innerHTML = '<p class="text-muted">No workflows yet. Create one to chain squads into a pipeline.</p>';
            return;
        }
        container.innerHTML = workflows.map(wf => {
            const pipeline = wf.steps.map((s, i) => {
                const failLabel = s.on_fail === 'stop' ? '' :
                    s.on_fail === 'continue' ? ' <span class="wf-flag">skip-on-fail</span>' :
                    ' <span class="wf-flag">fallback: ' + esc(s.on_fail.replace('run:', '')) + '</span>';
                return '<span class="wf-step-chip">' + esc(s.squad) + failLabel + '</span>';
            }).join('<span class="exec-arrow">&rarr;</span>');

            return '<div class="workflow-card">' +
                '<div class="card-top">' +
                '<div><h3>' + esc(wf.id) + '</h3><div class="desc">' + esc(wf.description) + '</div></div>' +
                '<div class="action-btns">' +
                '<button class="btn btn-sm" onclick="Workflows.edit(\'' + esc(wf.id) + '\')">Edit</button>' +
                '<button class="btn btn-sm btn-danger" onclick="Workflows.confirmDelete(\'' + esc(wf.id) + '\')">Del</button>' +
                '</div></div>' +
                '<div class="wf-pipeline">' + pipeline + '</div>' +
                '</div>';
        }).join('');
    }

    function showCreate() {
        editingId = null;
        steps = [{ squad: '', on_fail: 'stop' }];
        document.getElementById('wf-modal-title').textContent = 'Create Workflow';
        document.getElementById('wf-save-btn').textContent = 'Create Workflow';
        document.getElementById('wf-id').value = '';
        document.getElementById('wf-id').disabled = false;
        document.getElementById('wf-desc').value = '';
        _renderSteps();
        document.getElementById('workflow-overlay').classList.remove('hidden');
    }

    async function edit(id) {
        try {
            const wf = await apiFetch('/workflows/' + id);
            editingId = id;
            steps = wf.steps.map(s => ({ squad: s.squad, on_fail: s.on_fail || 'stop' }));
            if (!steps.length) steps = [{ squad: '', on_fail: 'stop' }];
            document.getElementById('wf-modal-title').textContent = 'Edit Workflow';
            document.getElementById('wf-save-btn').textContent = 'Save Workflow';
            document.getElementById('wf-id').value = wf.id;
            document.getElementById('wf-id').disabled = true;
            document.getElementById('wf-desc').value = wf.description || '';
            _renderSteps();
            document.getElementById('workflow-overlay').classList.remove('hidden');
        } catch (e) {
            toast(e.message, 'error');
        }
    }

    function closeModal() {
        document.getElementById('workflow-overlay').classList.add('hidden');
        document.getElementById('wf-id').disabled = false;
        editingId = null;
    }

    function _renderSteps() {
        const container = document.getElementById('wf-steps');
        const squadOpts = State.squads.map(s =>
            '<option value="' + esc(s.id) + '">' + esc(s.id) + '</option>'
        ).join('');

        container.innerHTML = steps.map((step, i) => {
            return '<div class="wf-step-row">' +
                '<span class="wf-step-num">' + (i + 1) + '</span>' +
                '<select class="wf-squad-sel" data-idx="' + i + '" onchange="Workflows.updateStep(' + i + ', \'squad\', this.value)">' +
                '<option value="">Select squad...</option>' + squadOpts +
                '</select>' +
                '<select class="wf-fail-sel" data-idx="' + i + '" onchange="Workflows.updateStep(' + i + ', \'on_fail\', this.value)">' +
                '<option value="stop">On fail: stop</option>' +
                '<option value="continue">On fail: continue</option>' +
                '</select>' +
                (steps.length > 1 ? '<button class="btn btn-sm btn-danger" onclick="Workflows.removeStep(' + i + ')">x</button>' : '') +
                '</div>';
        }).join('');

        // Set selected values
        steps.forEach((step, i) => {
            const row = container.children[i];
            if (row) {
                row.querySelector('.wf-squad-sel').value = step.squad;
                row.querySelector('.wf-fail-sel').value = step.on_fail;
            }
        });
    }

    function addStep() {
        steps.push({ squad: '', on_fail: 'stop' });
        _renderSteps();
    }

    function removeStep(idx) {
        steps.splice(idx, 1);
        _renderSteps();
    }

    function updateStep(idx, field, value) {
        if (steps[idx]) steps[idx][field] = value;
    }

    async function save() {
        const id = document.getElementById('wf-id').value.trim();
        const desc = document.getElementById('wf-desc').value.trim();

        if (!id) { toast('Workflow ID is required', 'error'); return; }
        if (!/^[a-z0-9_]+$/.test(id)) { toast('ID must be lowercase letters, numbers, underscores', 'error'); return; }

        const validSteps = steps.filter(s => s.squad);
        if (!validSteps.length) { toast('Add at least one step with a squad', 'error'); return; }

        const body = { id, description: desc, steps: validSteps };

        try {
            if (editingId) {
                await apiFetch('/workflows/' + editingId, {
                    method: 'PUT',
                    body: JSON.stringify({ description: desc, steps: validSteps }),
                });
                toast('Workflow updated', 'success');
            } else {
                await apiFetch('/workflows', { method: 'POST', body: JSON.stringify(body) });
                toast('Workflow created', 'success');
            }
            closeModal();
            render();
        } catch (e) {
            toast(e.message, 'error');
        }
    }

    async function confirmDelete(id) {
        if (!confirm('Delete workflow "' + id + '"?')) return;
        try {
            await apiFetch('/workflows/' + id, { method: 'DELETE' });
            toast('Workflow deleted', 'success');
            render();
        } catch (e) {
            toast(e.message, 'error');
        }
    }

    return { render, showCreate, edit, closeModal, addStep, removeStep, updateStep, save, confirmDelete };
})();
