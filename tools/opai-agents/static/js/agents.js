/**
 * OPAI Agent Studio — Agents list + wizard.
 */

const Agents = (() => {
    let wizardStep = 1;
    let editingId = null; // null = create mode, string = edit mode

    function render() {
        const agents = State.agents;
        document.getElementById('agent-count').textContent = agents.length;

        // Populate category filter
        const sel = document.getElementById('filter-category');
        const current = sel.value;
        sel.innerHTML = '<option value="">All Categories</option>' +
            State.categories.map(c => '<option value="' + c + '">' + c + '</option>').join('');
        sel.value = current;

        renderTable(agents);
    }

    function filter() {
        const cat = document.getElementById('filter-category').value;
        const filtered = cat ? State.agents.filter(a => a.category === cat) : State.agents;
        renderTable(filtered);
    }

    function renderTable(agents) {
        // Build squad lookup
        const squadMap = {};
        State.squads.forEach(s => {
            s.agents.forEach(a => {
                if (!squadMap[a.id]) squadMap[a.id] = [];
                squadMap[a.id].push(s.id);
            });
        });

        const tbody = document.getElementById('agent-tbody');
        if (!agents.length) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-muted" style="text-align:center;padding:2rem;">No agents found</td></tr>';
            return;
        }
        tbody.innerHTML = agents.map(a => {
            const squads = squadMap[a.id] || [];
            const squadTags = squads.map(s => '<span class="squad-tag">' + esc(s) + '</span>').join('');
            return '<tr>' +
                '<td><div class="agent-name"><span class="agent-emoji">' + esc(a.emoji || '?') + '</span>' +
                '<div class="agent-label"><strong>' + esc(a.name) + '</strong><span class="desc">' + esc(a.description) + '</span></div></div></td>' +
                '<td><span class="cat-badge cat-' + a.category + '">' + esc(a.category) + '</span></td>' +
                '<td>' + esc(a.run_order) + '</td>' +
                '<td><div class="squad-tags">' + (squadTags || '<span class="text-muted">none</span>') + '</div></td>' +
                '<td><div class="action-btns">' +
                '<button class="btn btn-sm" onclick="Agents.edit(\'' + esc(a.id) + '\')">Edit</button>' +
                '<button class="btn btn-sm btn-danger" onclick="Agents.confirmDelete(\'' + esc(a.id) + '\')">Del</button>' +
                '</div></td></tr>';
        }).join('');
    }

    // ── Wizard ───────────────────────────────────────

    function showWizard() {
        editingId = null;
        wizardStep = 1;
        document.getElementById('wizard-title').textContent = 'Create Agent';
        _clearWizard();
        _populateWizardDropdowns();
        _showStep(1);
        document.getElementById('wizard-overlay').classList.remove('hidden');
    }

    async function edit(id) {
        try {
            const agent = await apiFetch('/agents/' + id);
            editingId = id;
            wizardStep = 1;
            document.getElementById('wizard-title').textContent = 'Edit Agent';
            _clearWizard();
            _populateWizardDropdowns();

            // Fill fields
            document.getElementById('wiz-id').value = agent.id;
            document.getElementById('wiz-id').disabled = true;
            document.getElementById('wiz-name').value = agent.name || '';
            document.getElementById('wiz-emoji').value = agent.emoji || '';
            document.getElementById('wiz-category').value = agent.category || 'quality';
            document.getElementById('wiz-desc').value = agent.description || '';
            document.getElementById('wiz-prompt').value = agent.prompt_content || '';

            // Run order
            document.querySelectorAll('#wiz-run-order .radio-card').forEach(c => {
                c.classList.toggle('active', c.dataset.value === agent.run_order);
            });

            // Model & tuning
            document.getElementById('wiz-model').value = agent.model || '';
            document.getElementById('wiz-max-turns').value = agent.max_turns || 0;
            document.getElementById('wiz-no-project-ctx').checked = agent.no_project_context || false;

            // Dependencies
            _populateDependencies(agent.depends_on || []);

            _showStep(1);
            document.getElementById('wizard-overlay').classList.remove('hidden');
        } catch (e) {
            toast('Failed to load agent: ' + e.message, 'error');
        }
    }

    function closeWizard() {
        document.getElementById('wizard-overlay').classList.add('hidden');
        document.getElementById('wiz-id').disabled = false;
        editingId = null;
    }

    function wizardNext() {
        if (wizardStep < 4) {
            if (wizardStep === 1 && !_validateStep1()) return;
            wizardStep++;
            if (wizardStep === 3) _populateDependencies();
            if (wizardStep === 4) _buildReview();
            _showStep(wizardStep);
        } else {
            _save();
        }
    }

    function wizardBack() {
        if (wizardStep > 1) { wizardStep--; _showStep(wizardStep); }
    }

    function _showStep(n) {
        document.querySelectorAll('.wizard-step').forEach(s => s.classList.add('hidden'));
        document.querySelector('.wizard-step[data-step="' + n + '"]')?.classList.remove('hidden');
        document.querySelectorAll('.wizard-steps .step').forEach(s => {
            const sn = parseInt(s.dataset.step);
            s.classList.toggle('active', sn === n);
            s.classList.toggle('done', sn < n);
        });
        document.getElementById('wiz-back').style.display = n > 1 ? '' : 'none';
        document.getElementById('wiz-next').textContent = n === 4 ? (editingId ? 'Save' : 'Create') : 'Next';
    }

    function onEmojiPick(val) {
        const textInput = document.getElementById('wiz-emoji');
        if (val) {
            textInput.value = val;
        }
        // Reset dropdown to placeholder so user can pick again
        document.getElementById('wiz-emoji-picker').value = '';
    }

    function _clearWizard() {
        document.getElementById('wiz-id').value = '';
        document.getElementById('wiz-name').value = '';
        document.getElementById('wiz-emoji').value = '';
        document.getElementById('wiz-emoji-picker').value = '';
        document.getElementById('wiz-desc').value = '';
        document.getElementById('wiz-prompt').value = '';
        document.getElementById('wiz-model').value = '';
        document.getElementById('wiz-max-turns').value = 0;
        document.getElementById('wiz-no-project-ctx').checked = false;
        document.querySelectorAll('#wiz-run-order .radio-card').forEach(c => {
            c.classList.toggle('active', c.dataset.value === 'parallel');
        });
    }

    function _populateWizardDropdowns() {
        const catSel = document.getElementById('wiz-category');
        catSel.innerHTML = State.categories.map(c => '<option value="' + c + '">' + c + '</option>').join('');

        // Radio card clicks
        document.querySelectorAll('#wiz-run-order .radio-card').forEach(card => {
            card.onclick = () => {
                document.querySelectorAll('#wiz-run-order .radio-card').forEach(c => c.classList.remove('active'));
                card.classList.add('active');
            };
        });
    }

    function _populateDependencies(selected) {
        const list = document.getElementById('wiz-depends');
        const currentId = document.getElementById('wiz-id').value;
        const sel = selected || [];
        list.innerHTML = State.agents
            .filter(a => a.id !== currentId)
            .map(a => {
                const checked = sel.includes(a.id) || sel.includes('*') ? ' checked' : '';
                return '<label><input type="checkbox" value="' + esc(a.id) + '"' + checked + '>' + esc(a.emoji) + ' ' + esc(a.name) + '</label>';
            }).join('');
        if (!State.agents.filter(a => a.id !== currentId).length) {
            list.innerHTML = '<div class="text-muted" style="padding:0.5rem;">No other agents to depend on</div>';
        }
    }

    function _validateStep1() {
        const id = document.getElementById('wiz-id').value.trim();
        const name = document.getElementById('wiz-name').value.trim();
        if (!id) { toast('Agent ID is required', 'error'); return false; }
        if (!/^[a-z0-9_]+$/.test(id)) { toast('ID must be lowercase letters, numbers, underscores', 'error'); return false; }
        if (!name) { toast('Display name is required', 'error'); return false; }
        return true;
    }

    function _getWizardData() {
        const runOrder = document.querySelector('#wiz-run-order .radio-card.active')?.dataset.value || 'parallel';
        const deps = Array.from(document.querySelectorAll('#wiz-depends input:checked')).map(i => i.value);

        return {
            id: document.getElementById('wiz-id').value.trim(),
            name: document.getElementById('wiz-name').value.trim(),
            emoji: document.getElementById('wiz-emoji').value.trim(),
            category: document.getElementById('wiz-category').value,
            description: document.getElementById('wiz-desc').value.trim(),
            run_order: runOrder,
            depends_on: deps,
            model: document.getElementById('wiz-model').value || '',
            max_turns: parseInt(document.getElementById('wiz-max-turns').value) || 0,
            no_project_context: document.getElementById('wiz-no-project-ctx').checked,
            prompt_content: document.getElementById('wiz-prompt').value,
        };
    }

    function _buildReview() {
        const data = _getWizardData();
        const { prompt_content, ...config } = data;
        document.getElementById('wiz-review-json').textContent = JSON.stringify(config, null, 2);
        document.getElementById('wiz-review-prompt').textContent = prompt_content || '(empty)';
    }

    async function _save() {
        const data = _getWizardData();
        try {
            if (editingId) {
                const { id, ...updateData } = data;
                await apiFetch('/agents/' + editingId, { method: 'PUT', body: JSON.stringify(updateData) });
                toast('Agent updated', 'success');
            } else {
                await apiFetch('/agents', { method: 'POST', body: JSON.stringify(data) });
                toast('Agent created', 'success');
            }
            closeWizard();
            await loadAll();
            render();
            renderDashboard();
            Squads.render();
        } catch (e) {
            toast(e.message, 'error');
        }
    }

    function insertVar(v) {
        const ta = document.getElementById('wiz-prompt');
        const start = ta.selectionStart;
        ta.value = ta.value.slice(0, start) + v + ta.value.slice(ta.selectionEnd);
        ta.focus();
        ta.selectionStart = ta.selectionEnd = start + v.length;
    }

    async function confirmDelete(id) {
        if (!confirm('Delete agent "' + id + '"? This cannot be undone.')) return;
        try {
            await apiFetch('/agents/' + id, { method: 'DELETE' });
            toast('Agent deleted', 'success');
            await loadAll();
            render();
            renderDashboard();
            Squads.render();
        } catch (e) {
            toast(e.message, 'error');
        }
    }

    return { render, filter, showWizard, edit, closeWizard, wizardNext, wizardBack, insertVar, confirmDelete, onEmojiPick };
})();
