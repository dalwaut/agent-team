/**
 * OPAI Agent Studio — Squad builder.
 */

const Squads = (() => {
    let editingId = null;
    let selectedAgents = []; // agent IDs in current squad being built

    function render() {
        document.getElementById('squad-count').textContent = State.squads.length;
        const container = document.getElementById('squad-list');

        if (!State.squads.length) {
            container.innerHTML = '<p class="text-muted">No squads defined yet.</p>';
            return;
        }

        container.innerHTML = State.squads.map(s => {
            const flow = _buildExecFlow(s.agents);
            return '<div class="squad-builder-card">' +
                '<div class="card-top"><div><h3>' + esc(s.id) + '</h3><div class="desc">' + esc(s.description) + '</div></div>' +
                '<div class="action-btns">' +
                '<button class="btn btn-sm" onclick="Squads.edit(\'' + esc(s.id) + '\')">Edit</button>' +
                '<button class="btn btn-sm btn-danger" onclick="Squads.confirmDelete(\'' + esc(s.id) + '\')">Del</button>' +
                '</div></div>' +
                '<div class="exec-flow">' + flow + '</div></div>';
        }).join('');
    }

    function _buildExecFlow(agents) {
        const first = agents.filter(a => a.run_order === 'first');
        const parallel = agents.filter(a => a.run_order === 'parallel');
        const last = agents.filter(a => a.run_order === 'last');

        const parts = [];
        if (first.length) {
            parts.push(_groupHtml(first, 'First'));
        }
        if (parallel.length) {
            parts.push(_groupHtml(parallel, 'Parallel'));
        }
        if (last.length) {
            parts.push(_groupHtml(last, 'Sequential'));
        }

        return parts.join('<span class="exec-arrow">&rarr;</span>');
    }

    function _groupHtml(agents, label) {
        const chips = agents.map(a =>
            '<span class="agent-chip"><span class="chip-emoji">' + esc(a.emoji || '?') + '</span>' + esc(a.name) + '</span>'
        ).join('');
        return '<div><div class="exec-group">' + chips + '</div><div class="exec-label">' + label + '</div></div>';
    }

    // ── Squad Modal ──────────────────────────────────

    function showCreate() {
        editingId = null;
        selectedAgents = [];
        document.getElementById('squad-modal-title').textContent = 'Create Squad';
        document.getElementById('squad-save-btn').textContent = 'Create Squad';
        document.getElementById('squad-id').value = '';
        document.getElementById('squad-id').disabled = false;
        document.getElementById('squad-desc').value = '';
        _renderPools();
        _renderExecPreview();
        document.getElementById('squad-overlay').classList.remove('hidden');
    }

    async function edit(id) {
        try {
            const squad = await apiFetch('/squads/' + id);
            editingId = id;
            selectedAgents = squad.agents.map(a => a.id);
            document.getElementById('squad-modal-title').textContent = 'Edit Squad';
            document.getElementById('squad-save-btn').textContent = 'Save Squad';
            document.getElementById('squad-id').value = squad.id;
            document.getElementById('squad-id').disabled = true;
            document.getElementById('squad-desc').value = squad.description || '';
            _renderPools();
            _renderExecPreview();
            document.getElementById('squad-overlay').classList.remove('hidden');
        } catch (e) {
            toast('Failed to load squad: ' + e.message, 'error');
        }
    }

    function closeModal() {
        document.getElementById('squad-overlay').classList.add('hidden');
        document.getElementById('squad-id').disabled = false;
        editingId = null;
    }

    function _renderPools() {
        const pool = document.getElementById('squad-pool');
        const members = document.getElementById('squad-members');

        pool.innerHTML = State.agents
            .filter(a => !selectedAgents.includes(a.id))
            .map(a => _poolAgentHtml(a, false))
            .join('');

        members.innerHTML = selectedAgents.map(id => {
            const a = State.agents.find(x => x.id === id);
            return a ? _poolAgentHtml(a, true) : '';
        }).join('');

        document.getElementById('squad-member-count').textContent = selectedAgents.length;

        // Add click handlers
        pool.querySelectorAll('.pool-agent').forEach(el => {
            el.onclick = () => { _addAgent(el.dataset.id); };
        });
        members.querySelectorAll('.pool-agent').forEach(el => {
            el.onclick = () => { _removeAgent(el.dataset.id); };
        });
    }

    function _poolAgentHtml(a, inSquad) {
        return '<div class="pool-agent" data-id="' + esc(a.id) + '">' +
            '<span class="pa-emoji">' + esc(a.emoji || '?') + '</span>' +
            '<span class="pa-name">' + esc(a.name) + '</span>' +
            '<span class="pa-cat">' + esc(a.category) + '</span>' +
            '</div>';
    }

    function _addAgent(id) {
        if (!selectedAgents.includes(id)) {
            selectedAgents.push(id);
            _renderPools();
            _renderExecPreview();
        }
    }

    function _removeAgent(id) {
        selectedAgents = selectedAgents.filter(a => a !== id);
        _renderPools();
        _renderExecPreview();
    }

    function _renderExecPreview() {
        const preview = document.getElementById('exec-preview');
        if (!selectedAgents.length) {
            preview.innerHTML = 'Click agents on the left to add them to the squad';
            return;
        }

        const agents = selectedAgents.map(id => State.agents.find(a => a.id === id)).filter(Boolean);
        const first = agents.filter(a => a.run_order === 'first');
        const parallel = agents.filter(a => a.run_order === 'parallel');
        const last = agents.filter(a => a.run_order === 'last');

        let html = '';
        if (first.length) html += '<strong>First:</strong> ' + first.map(a => a.name).join(', ') + '<br>';
        if (parallel.length) html += '<strong>Parallel:</strong> ' + parallel.map(a => a.name).join(', ') + '<br>';
        if (last.length) html += '<strong>Then:</strong> ' + last.map(a => a.name).join(' &rarr; ');
        preview.innerHTML = html;
    }

    async function save() {
        const id = document.getElementById('squad-id').value.trim();
        const desc = document.getElementById('squad-desc').value.trim();

        if (!id) { toast('Squad ID is required', 'error'); return; }
        if (!/^[a-z0-9_]+$/.test(id)) { toast('ID must be lowercase letters, numbers, underscores', 'error'); return; }
        if (!selectedAgents.length) { toast('Add at least one agent', 'error'); return; }

        const body = { id, description: desc, agents: selectedAgents };

        try {
            if (editingId) {
                await apiFetch('/squads/' + editingId, { method: 'PUT', body: JSON.stringify({ description: desc, agents: selectedAgents }) });
                toast('Squad updated', 'success');
            } else {
                await apiFetch('/squads', { method: 'POST', body: JSON.stringify(body) });
                toast('Squad created', 'success');
            }
            closeModal();
            await loadAll();
            render();
            renderDashboard();
        } catch (e) {
            toast(e.message, 'error');
        }
    }

    async function confirmDelete(id) {
        if (!confirm('Delete squad "' + id + '"? This cannot be undone.')) return;
        try {
            await apiFetch('/squads/' + id, { method: 'DELETE' });
            toast('Squad deleted', 'success');
            await loadAll();
            render();
            renderDashboard();
        } catch (e) {
            toast(e.message, 'error');
        }
    }

    return { render, showCreate, edit, closeModal, save, confirmDelete };
})();
