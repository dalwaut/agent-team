/**
 * OPAI Agent Orchestra — Symphony Movements (Workflows).
 * Orchestra term: "Symphony" = Agent Studio's "Workflows" tab.
 * A symphony is a multi-movement work — each movement = one squad/programme.
 */

const SymphonyView = (() => {

    function render() {
        const shell = document.getElementById('symphony-shell');
        shell.innerHTML =
            '<div class="panel-title">🎶 Symphony Movements <span class="term-badge">Workflows</span></div>' +
            '<div class="panel-subtitle">Chain multiple programmes into a multi-movement symphony — one completes, the next begins</div>' +

            '<div style="display:flex;gap:10px;margin-bottom:24px">' +
                '<button class="btn-gold" onclick="SymphonyView.openNewSymphony()">＋ Compose Symphony</button>' +
                '<button class="btn-ghost" onclick="SymphonyView.refresh()">↻ Refresh</button>' +
            '</div>' +

            '<div id="sym-list"></div>';

        loadWorkflows();
    }

    async function loadWorkflows() {
        const el = document.getElementById('sym-list');
        if (!el) return;
        try {
            const resp = await apiFetch('/workflows');
            const wfs = resp.workflows || [];

            if (!wfs.length) {
                el.innerHTML = '<div class="empty-state"><div class="empty-emblem">🎶</div><div class="empty-title">No symphonies composed</div><div class="empty-sub">A symphony chains multiple programmes into a sequential pipeline.</div></div>';
                return;
            }

            el.innerHTML = wfs.map(wf => _workflowCard(wf)).join('');
        } catch(e) {
            el.innerHTML = '<div class="empty-state"><div class="empty-sub">Could not load symphonies: ' + esc(e.message) + '</div></div>';
        }
    }

    function _workflowCard(wf) {
        const steps = wf.steps || [];
        const movementsHtml = steps.map((step, i) => {
            const failLabel = { stop: 'Stops symphony', skip: 'Skips, continues', continue: 'Continues regardless' };
            return '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' +
                (i > 0 ? '<div style="width:2px;height:16px;background:var(--border);margin-left:16px;margin-bottom:-20px"></div>' : '') +
                '</div>' +
                '<div style="display:flex;align-items:center;gap:10px">' +
                    '<div style="background:var(--gold-glow);border:1px solid var(--gold-dim);border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;color:var(--gold)">' + (i + 1) + '</div>' +
                    '<div>' +
                        '<div style="font-size:13px;font-weight:600;color:var(--text)">' + esc(step.squad) + ' <span class="term-badge">programme</span></div>' +
                        '<div style="font-size:11px;color:var(--text-muted)">On failure: ' + esc(failLabel[step.on_failure] || step.on_failure || 'stop') + '</div>' +
                    '</div>' +
                '</div>';
        }).join('');

        return '<div class="run-card" style="margin-bottom:16px">' +
            '<div class="run-header">' +
                '<div class="run-squad">🎶 ' + esc(wf.id) + ' <span class="term-badge">workflow</span></div>' +
                '<div style="display:flex;gap:8px">' +
                    '<button class="btn-ghost btn-sm" onclick="SymphonyView.performSymphony(\'' + esc(wf.id) + '\')">▶ Perform</button>' +
                    '<button class="btn-ghost btn-sm" onclick="SymphonyView.editSymphony(\'' + esc(wf.id) + '\')">✏️</button>' +
                    '<button class="btn-ghost btn-sm" style="color:var(--c-security)" onclick="SymphonyView.deleteSymphony(\'' + esc(wf.id) + '\')">🗑️</button>' +
                '</div>' +
            '</div>' +
            '<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">' + esc(wf.name || '') + ' · ' + steps.length + ' movement' + (steps.length !== 1 ? 's' : '') + '</div>' +
            '<div style="border-left:2px solid var(--border);padding-left:16px;margin-left:12px">' + movementsHtml + '</div>' +
        '</div>';
    }

    function openNewSymphony() {
        const squadOptions = State.squads.map(s =>
            '<option value="' + esc(s.id) + '">' + esc(s.id) + '</option>'
        ).join('');

        document.getElementById('musician-modal-box').innerHTML =
            '<div class="modal-header">' +
                '<h2>Compose Symphony <span class="term-badge">New Workflow</span></h2>' +
                '<button class="modal-close" onclick="document.getElementById(\'musician-modal\').classList.add(\'hidden\')">✕</button>' +
            '</div>' +
            '<div class="orch-form">' +
                '<div class="form-row">' +
                    '<label>Symphony ID <span class="term-badge">Workflow ID</span>' +
                        '<input class="orch-input" id="sym-id" placeholder="e.g. full_review" pattern="[a-z0-9_]+" required>' +
                    '</label>' +
                    '<label>Title <span class="term-badge">Name</span>' +
                        '<input class="orch-input" id="sym-name" placeholder="e.g. Full Review Symphony">' +
                    '</label>' +
                '</div>' +
                '<div>' +
                    '<div class="orch-label" style="margin-bottom:10px">Movements <span class="term-badge">Steps / Squads</span></div>' +
                    '<div id="sym-movements" style="display:flex;flex-direction:column;gap:8px"></div>' +
                    '<button type="button" class="btn-ghost btn-sm" style="margin-top:8px" onclick="SymphonyView.addMovement(\'' + esc(squadOptions.replace(/'/g, "\\'")) + '\')">＋ Add Movement</button>' +
                '</div>' +
                '<div class="modal-actions">' +
                    '<button type="button" class="btn-ghost" onclick="document.getElementById(\'musician-modal\').classList.add(\'hidden\')">Cancel</button>' +
                    '<button type="button" class="btn-gold" onclick="SymphonyView.submitSymphony()">Compose</button>' +
                '</div>' +
            '</div>';

        document.getElementById('musician-modal').classList.remove('hidden');
        // Add first movement automatically
        addMovement(squadOptions);
    }

    function addMovement(squadOptionsHtml) {
        const container = document.getElementById('sym-movements');
        if (!container) return;
        const idx = container.children.length;

        const div = document.createElement('div');
        div.className = 'sym-movement';
        div.style.cssText = 'display:flex;gap:8px;align-items:center;background:var(--surface-2);border:1px solid var(--border);border-radius:7px;padding:10px 12px';
        div.innerHTML =
            '<div style="font-size:11px;color:var(--gold);min-width:20px">' + (idx + 1) + '.</div>' +
            '<select class="orch-select-field sym-squad" style="flex:1">' + squadOptionsHtml + '</select>' +
            '<select class="orch-select-field sym-fail" style="width:180px" title="On failure">' +
                '<option value="stop">On fail: Stop</option>' +
                '<option value="skip">On fail: Skip movement</option>' +
                '<option value="continue">On fail: Continue</option>' +
            '</select>' +
            '<button type="button" class="btn-ghost btn-sm" style="color:var(--c-security)" onclick="this.closest(\'.sym-movement\').remove();SymphonyView.renumberMovements()">✕</button>';
        container.appendChild(div);
    }

    function renumberMovements() {
        document.querySelectorAll('.sym-movement').forEach((el, i) => {
            const num = el.querySelector('div');
            if (num) num.textContent = (i + 1) + '.';
        });
    }

    async function submitSymphony() {
        const id   = document.getElementById('sym-id')?.value.trim();
        const name = document.getElementById('sym-name')?.value.trim();
        if (!id) { toast('Symphony ID is required', 'error'); return; }

        const steps = [...document.querySelectorAll('.sym-movement')].map(el => ({
            squad: el.querySelector('.sym-squad')?.value,
            on_failure: el.querySelector('.sym-fail')?.value || 'stop',
        })).filter(s => s.squad);

        if (!steps.length) { toast('Add at least one movement', 'error'); return; }

        try {
            await apiFetch('/workflows', {
                method: 'POST',
                body: JSON.stringify({ id, name: name || id, steps }),
            });
            document.getElementById('musician-modal').classList.add('hidden');
            toast('Symphony "' + id + '" composed', 'success');
            loadWorkflows();
        } catch(e) { toast(e.message, 'error'); }
    }

    async function performSymphony(wfId) {
        const ok = await showConfirm('Perform Symphony?', 'Execute all movements of "' + wfId + '" in sequence?', 'Perform');
        if (!ok) return;
        toast('Symphony performance not yet wired to a direct endpoint — use Concert Hall to trigger individual programmes.', 'warning');
    }

    async function deleteSymphony(wfId) {
        const ok = await showConfirm('Remove Symphony?', 'Delete "' + wfId + '"?', 'Delete');
        if (!ok) return;
        try {
            await apiFetch('/workflows/' + encodeURIComponent(wfId), { method: 'DELETE' });
            toast('Symphony deleted', 'success');
            loadWorkflows();
        } catch(e) { toast(e.message, 'error'); }
    }

    async function editSymphony(wfId) {
        toast('Edit symphony: coming soon. For now, delete and recreate.', 'info');
    }

    async function refresh() { loadWorkflows(); }

    return { render, openNewSymphony, addMovement, renumberMovements, submitSymphony, performSymphony, deleteSymphony, editSymphony, refresh };
})();
