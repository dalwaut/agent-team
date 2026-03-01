/**
 * OPAI Agent Orchestra — Level 2: Section / Squad View.
 * Shows a squad as a concert section with phase lanes (Intro / Main Movement / Coda).
 * Allows adding/removing musicians and running the section.
 */

const SectionView = (() => {
    let currentSquad = null;

    // ── Render ────────────────────────────────────────────────
    function render(squadId) {
        currentSquad = State.squads.find(s => s.id === squadId);
        if (!currentSquad) {
            document.getElementById('section-header').innerHTML = '<p class="text-muted">Programme not found.</p>';
            return;
        }

        const def = getSectionDef(_dominantCategory(currentSquad));
        _renderHeader(currentSquad, def);
        _renderPhases(currentSquad);
        _renderPool(currentSquad);
    }

    function _dominantCategory(squad) {
        const counts = {};
        (squad.agents || []).forEach(a => {
            const cat = a.category || 'meta';
            counts[cat] = (counts[cat] || 0) + 1;
        });
        return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'meta';
    }

    // ── Header ────────────────────────────────────────────────
    function _renderHeader(squad, def) {
        const el = document.getElementById('section-header');
        const agentCount = (squad.agents || []).length;

        el.innerHTML =
            '<div class="section-header-left">' +
                '<div class="section-title">' +
                    '<span class="section-instrument">' + esc(def.instrument) + '</span>' +
                    '<span>' + esc(squad.id) + '</span>' +
                    '<span class="badge" style="background:' + hexAlpha(def.color, 0.15) + ';color:' + def.color + ';border:1px solid ' + hexAlpha(def.color, 0.3) + '">' +
                        esc(def.name) +
                    '</span>' +
                '</div>' +
                '<div class="section-subtitle">' +
                    agentCount + ' musician' + (agentCount !== 1 ? 's' : '') +
                    ' <span class="term-badge" title="Technical name: agents in squad">agents in squad</span>' +
                '</div>' +
                '<div class="section-prog-desc">' + esc(squad.description || 'No programme description') + '</div>' +
            '</div>' +
            '<div class="section-actions">' +
                '<button class="btn-rehearse" onclick="SectionView.showExecutionOrder()">📋 Rehearse</button>' +
                '<button class="btn-perform" onclick="SectionView.perform(\'' + esc(squad.id) + '\')">▶ Perform Now</button>' +
                '<button class="btn-ghost btn-sm" onclick="SectionView.openEditModal()">✏️ Edit</button>' +
                (currentUser?.isAdmin ? '<button class="btn-ghost btn-sm" style="color:var(--c-security)" onclick="SectionView.deleteProgramme()">🗑️ Delete</button>' : '') +
            '</div>';
    }

    // ── Phase Lanes ───────────────────────────────────────────
    function _renderPhases(squad) {
        const agents = (squad.agents || []).map(a => {
            // Resolve full agent data from State
            return State.agents.find(sa => sa.id === a.id) || a;
        });

        const firstAgents    = agents.filter(a => a.run_order === 'first');
        const parallelAgents = agents.filter(a => !a.run_order || a.run_order === 'parallel');
        const lastAgents     = agents.filter(a => a.run_order === 'last');

        const stages = document.getElementById('section-stages');
        stages.innerHTML = [
            _phaseLane('intro', 'Intro', 'first', 'Setup agents that run before the main movement', firstAgents, squad),
            _phaseLane('main', 'Main Movement', 'parallel', 'Specialist analysts running concurrently (up to 4 at once)', parallelAgents, squad),
            _phaseLane('coda', 'Coda', 'last', 'Consolidation agents that run after the main movement finishes', lastAgents, squad),
        ].join('');

        // Wire remove buttons
        stages.querySelectorAll('.mc-remove').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const agentId = btn.dataset.agentId;
                await removeFromSection(squad.id, agentId);
            });
        });

        // Wire musician card clicks
        stages.querySelectorAll('.musician-card').forEach(card => {
            card.addEventListener('click', (e) => {
                if (e.target.classList.contains('mc-remove')) return;
                navigateTo('musician', {
                    musicianId: card.dataset.agentId,
                    sectionId: squad.id,
                });
            });
        });
    }

    function _phaseLane(id, title, techName, desc, agents, squad) {
        const activeRunHasThis = State.activeRuns.some(r =>
            r.squad === squad.id &&
            agents.some(a => (r.agents_running || []).includes(a.id))
        );

        const cards = agents.map(agent => _musicianCard(agent)).join('');

        return '<div class="phase-lane" id="phase-' + id + '">' +
            '<div class="phase-lane-header">' +
                '<div>' +
                    '<div class="phase-name">' + esc(title) +
                        (activeRunHasThis ? ' <span style="color:var(--amber);font-size:12px">● Live</span>' : '') +
                    '</div>' +
                    '<div class="phase-desc">' + esc(desc) + '</div>' +
                '</div>' +
                '<span class="phase-tech" data-term="' + esc(id === 'intro' ? 'intro' : id === 'main' ? 'main-movement' : 'coda') + '">' +
                    'run_order: ' + techName +
                '</span>' +
            '</div>' +
            '<div class="phase-musicians">' +
                (agents.length ? cards : '<div class="phase-empty">No musicians in this phase — add from the pool →</div>') +
            '</div>' +
        '</div>';
    }

    function _musicianCard(agent) {
        const def = getSectionDef(agent.category);
        const isLive = State.activeRuns.some(r => (r.agents_running || []).includes(agent.id));
        const isDone = State.activeRuns.some(r => (r.agents_done || []).includes(agent.id));

        return '<div class="musician-card' + (isLive ? ' live' : isDone ? ' done' : '') + '" data-agent-id="' + esc(agent.id) + '">' +
            '<button class="mc-remove" data-agent-id="' + esc(agent.id) + '" title="Remove from programme">✕</button>' +
            '<div class="mc-emblem" style="background:' + hexAlpha(def.color, 0.25) + ';color:' + def.color + ';border:1px solid ' + hexAlpha(def.color, 0.4) + '">' +
                esc((agent.emoji || agent.id || '?').substring(0, 2).toUpperCase()) +
            '</div>' +
            '<div class="mc-name">' + esc(agent.name) + '</div>' +
            '<div class="mc-desc">' + esc(truncate(agent.description || '', 60)) + '</div>' +
            '<div style="font-size:10px;color:var(--text-faint);margin-top:4px;font-family:var(--font-mono)">' + esc(def.instrument) + ' ' + esc(def.name) + '</div>' +
        '</div>';
    }

    // ── Agent Pool ────────────────────────────────────────────
    function _renderPool(squad) {
        const inSquad = new Set((squad.agents || []).map(a => a.id));
        const available = State.agents.filter(a => !inSquad.has(a.id));

        const pool = document.getElementById('pool-list');
        const search = document.getElementById('pool-search');

        function renderPoolItems(filter) {
            const filtered = available.filter(a =>
                !filter || a.name.toLowerCase().includes(filter) || (a.id || '').toLowerCase().includes(filter)
            );

            pool.innerHTML = filtered.length
                ? filtered.map(agent => {
                    const def = getSectionDef(agent.category);
                    return '<div class="pool-item" data-agent-id="' + esc(agent.id) + '" title="Add ' + esc(agent.name) + ' to programme">' +
                        '<div class="pool-badge" style="background:' + hexAlpha(def.color, 0.25) + ';color:' + def.color + '">' +
                            esc((agent.emoji || agent.id || '?').substring(0, 2).toUpperCase()) +
                        '</div>' +
                        '<div>' +
                            '<div class="pool-name">' + esc(agent.name) + '</div>' +
                            '<div style="font-size:10px;color:var(--text-faint)">' + esc(def.instrument) + ' ' + esc(def.name) + '</div>' +
                        '</div>' +
                        '<span class="pool-add-icon">＋</span>' +
                    '</div>';
                }).join('')
                : '<div class="phase-empty">All musicians are in this programme</div>';

            pool.querySelectorAll('.pool-item').forEach(item => {
                item.addEventListener('click', async () => {
                    await addToSection(squad.id, item.dataset.agentId);
                });
            });
        }

        renderPoolItems('');
        if (search) {
            search.oninput = () => renderPoolItems(search.value.toLowerCase().trim());
        }
    }

    // ── Mutate Squad ──────────────────────────────────────────
    async function addToSection(squadId, agentId) {
        const squad = State.squads.find(s => s.id === squadId);
        if (!squad) return;
        const agentIds = (squad.agents || []).map(a => a.id || a);
        if (agentIds.includes(agentId)) return;
        try {
            await apiFetch('/squads/' + encodeURIComponent(squadId), {
                method: 'PUT',
                body: JSON.stringify({ agents: [...agentIds, agentId] }),
            });
            await loadAll();
            render(squadId);
            toast('Musician added to programme', 'success');
        } catch(e) { toast(e.message, 'error'); }
    }

    async function removeFromSection(squadId, agentId) {
        const squad = State.squads.find(s => s.id === squadId);
        if (!squad) return;
        const agentIds = (squad.agents || []).map(a => a.id || a).filter(id => id !== agentId);
        try {
            await apiFetch('/squads/' + encodeURIComponent(squadId), {
                method: 'PUT',
                body: JSON.stringify({ agents: agentIds }),
            });
            await loadAll();
            render(squadId);
            toast('Musician removed from programme', 'success');
        } catch(e) { toast(e.message, 'error'); }
    }

    // ── Perform (Run Squad) ───────────────────────────────────
    async function perform(squadId) {
        const btn = document.querySelector('.btn-perform');
        try {
            if (btn) { btn.disabled = true; btn.textContent = '⏳ Performing…'; }
            const resp = await apiFetch('/runs/squad/' + encodeURIComponent(squadId), { method: 'POST' });
            toast('Performance begun! Run ID: ' + resp.run_id, 'success');
            await refreshActiveRuns();
            render(squadId);
        } catch(e) {
            toast('Performance failed: ' + e.message, 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '▶ Perform Now'; }
        }
    }

    // ── Rehearse (Show Execution Order) ──────────────────────
    function showExecutionOrder() {
        if (!currentSquad) return;
        const agents = (currentSquad.agents || []).map(a =>
            State.agents.find(sa => sa.id === a.id) || a
        );
        const first    = agents.filter(a => a.run_order === 'first');
        const parallel = agents.filter(a => !a.run_order || a.run_order === 'parallel');
        const last     = agents.filter(a => a.run_order === 'last');

        let html = '<div class="modal-section">';
        html += '<div class="modal-section-title">📋 Rehearsal — Execution Order Preview</div>';
        html += '<p style="font-size:12px;color:var(--text-muted);margin-bottom:16px">This is how the performance will proceed when you click Perform Now.</p>';

        if (first.length) {
            html += '<div style="margin-bottom:12px"><div style="font-size:11px;color:var(--gold);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Phase 1 — Intro (Sequential)</div>';
            html += first.map(a => '<div style="padding:6px 10px;background:var(--surface-2);border-radius:5px;margin-bottom:4px;font-size:12px">' + esc(a.name) + '</div>').join('');
            html += '</div>';
        }
        if (parallel.length) {
            html += '<div style="margin-bottom:12px"><div style="font-size:11px;color:var(--gold);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Phase 2 — Main Movement (Parallel, max 4 concurrent)</div>';
            html += '<div style="display:flex;flex-wrap:wrap;gap:6px">' +
                parallel.map(a => '<span style="padding:4px 10px;background:var(--surface-2);border-radius:12px;font-size:11px">' + esc(a.name) + '</span>').join('') +
            '</div></div>';
        }
        if (last.length) {
            html += '<div><div style="font-size:11px;color:var(--gold);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Phase 3 — Coda (Sequential)</div>';
            html += last.map(a => '<div style="padding:6px 10px;background:var(--surface-2);border-radius:5px;margin-bottom:4px;font-size:12px">' + esc(a.name) + '</div>').join('');
            html += '</div>';
        }
        html += '</div>';
        html += '<div class="modal-actions"><button class="btn-ghost" onclick="document.getElementById(\'musician-modal\').classList.add(\'hidden\')">Close</button></div>';

        document.getElementById('musician-modal-box').innerHTML = html;
        document.getElementById('musician-modal').classList.remove('hidden');
    }

    // ── Edit Programme Modal ──────────────────────────────────
    function openEditModal() {
        if (!currentSquad) return;
        document.getElementById('musician-modal-box').innerHTML =
            '<div class="modal-header">' +
                '<h2>Edit Programme <span class="term-badge">Squad</span></h2>' +
                '<button class="modal-close" onclick="document.getElementById(\'musician-modal\').classList.add(\'hidden\')">✕</button>' +
            '</div>' +
            '<form class="orch-form" onsubmit="SectionView.saveEdit(event)">' +
                '<label>Programme ID <span class="term-badge">Squad ID</span>' +
                    '<input class="orch-input" value="' + esc(currentSquad.id) + '" disabled style="opacity:.5">' +
                '</label>' +
                '<label>Programme Name / Description <span class="term-badge">Description</span>' +
                    '<input class="orch-input" id="edit-prog-desc" value="' + esc(currentSquad.description || '') + '" required>' +
                '</label>' +
                '<div class="modal-actions">' +
                    '<button type="button" class="btn-ghost" onclick="document.getElementById(\'musician-modal\').classList.add(\'hidden\')">Cancel</button>' +
                    '<button type="submit" class="btn-gold">Save Changes</button>' +
                '</div>' +
            '</form>';
        document.getElementById('musician-modal').classList.remove('hidden');
    }

    async function saveEdit(e) {
        e.preventDefault();
        const desc = document.getElementById('edit-prog-desc').value.trim();
        try {
            await apiFetch('/squads/' + encodeURIComponent(currentSquad.id), {
                method: 'PUT',
                body: JSON.stringify({ description: desc }),
            });
            await loadAll();
            render(currentSquad.id);
            document.getElementById('musician-modal').classList.add('hidden');
            toast('Programme updated', 'success');
        } catch(err) { toast(err.message, 'error'); }
    }

    // ── Delete Programme ──────────────────────────────────────
    async function deleteProgramme() {
        if (!currentSquad) return;
        const ok = await showConfirm(
            'Delete Programme?',
            'Delete "' + currentSquad.id + '"? This cannot be undone.',
            'Delete'
        );
        if (!ok) return;
        try {
            await apiFetch('/squads/' + encodeURIComponent(currentSquad.id), { method: 'DELETE' });
            await loadAll();
            navigateTo('orchestra');
            toast('Programme deleted', 'success');
        } catch(e) { toast(e.message, 'error'); }
    }

    // ── Helpers ───────────────────────────────────────────────
    function truncate(s, n) { return s.length > n ? s.substring(0, n - 1) + '…' : s; }
    function hexAlpha(hex, alpha) {
        const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
        return `rgba(${r},${g},${b},${alpha})`;
    }

    return { render, addToSection, removeFromSection, perform, showExecutionOrder, openEditModal, saveEdit, deleteProgramme };
})();
