/**
 * OPAI Agent Orchestra — Level 3: Musician View (Agent Editor).
 * Full agent editor with orchestra terminology and dual-term tooltips on every field.
 * The "music stand" displays the Score (Prompt Content) in a styled editor.
 */

const MusicianView = (() => {
    let currentAgent = null;
    let isDirty = false;

    // ── Render (inline page view) ─────────────────────────────
    function render(agentId) {
        currentAgent = State.agents.find(a => a.id === agentId);
        if (!currentAgent) {
            document.getElementById('musician-shell').innerHTML =
                '<div class="empty-state"><div class="empty-emblem">🎻</div>' +
                '<div class="empty-title">Musician not found</div>' +
                '<div class="empty-sub">This agent could not be located in the ensemble.</div>' +
                '<button class="btn-ghost" onclick="navigateTo(\'orchestra\')">Back to Orchestra</button>' +
                '</div>';
            return;
        }

        // Fetch full agent data (including prompt) then render
        apiFetch('/agents/' + encodeURIComponent(agentId))
            .then(full => {
                currentAgent = full;
                _renderMusicianLayout(full);
            })
            .catch(() => _renderMusicianLayout(currentAgent));
    }

    function _renderMusicianLayout(agent) {
        const def = getSectionDef(agent.category);
        const shell = document.getElementById('musician-shell');

        shell.innerHTML =
            '<div class="musician-sidebar">' + _sidebarHTML(agent, def) + '</div>' +
            '<div class="musician-main">' +
                '<div class="musician-score-header">' + _scoreHeaderHTML(agent) + '</div>' +
                '<div class="musician-score-body">' + _scoreBodyHTML(agent) + '</div>' +
            '</div>' +
            '<div class="musician-footer">' + _footerHTML(agent) + '</div>';

        _wireSidebar(agent, def);
        _wireScore(agent);
        _wireFooter(agent);
        isDirty = false;
    }

    // ── Sidebar ───────────────────────────────────────────────
    function _sidebarHTML(agent, def) {
        const modelVal  = agent.model || 'inherit';
        const maxTurns  = agent.max_turns ?? 0;
        const skipCtx   = agent.no_project_context || false;

        const modelOptions = [
            { val: 'inherit', label: 'Inherit',  sub: 'Uses system default', term: 'inherit' },
            { val: 'haiku',   label: 'Haiku',    sub: 'Fast · focused tasks', term: 'haiku' },
            { val: 'sonnet',  label: 'Sonnet',   sub: 'Balanced · most tasks', term: 'sonnet' },
            { val: 'opus',    label: 'Opus',     sub: 'Powerful · deep analysis', term: 'opus' },
        ];

        const runOrderOptions = [
            { val: 'first',    label: 'Intro',          sub: 'Runs before main movement', term: 'intro' },
            { val: 'parallel', label: 'Main Movement',  sub: 'Concurrent with others (default)', term: 'main-movement' },
            { val: 'last',     label: 'Coda',           sub: 'Runs after main movement', term: 'coda' },
        ];

        return `
        <!-- Instrument Display -->
        <div class="instrument-display">
            <span class="instrument-emoji">${esc(def.instrument)}</span>
            <div class="instrument-name">${esc(def.name)}</div>
            <div class="instrument-section">${esc(agent.category || 'uncategorized')}</div>
            <div class="musician-emblem-badge" id="emblem-preview" style="background:${hexAlpha(def.color,0.2)};color:${def.color};border-color:${hexAlpha(def.color,0.4)}">
                ${esc((agent.emoji || agent.id || '?').substring(0, 2).toUpperCase())}
            </div>
        </div>

        <!-- Identity Fields -->
        <div>
            <div class="orch-field">
                <div class="orch-label">
                    Musician Name
                    <span class="term-info" data-term="musician" title="Click for details">ℹ</span>
                </div>
                <input class="orch-input" id="m-name" value="${esc(agent.name || '')}" placeholder="e.g. Code Reviewer">
            </div>
            <div class="orch-field">
                <div class="orch-label">
                    Musician Initials
                    <span class="term-info" data-term="musician-initials">ℹ</span>
                </div>
                <input class="orch-input" id="m-emoji" value="${esc(agent.emoji || '')}" placeholder="e.g. CR" maxlength="4" style="font-size:16px">
            </div>
            <div class="orch-field">
                <div class="orch-label">
                    Programme Note
                    <span class="term-info" data-term="programme-note">ℹ</span>
                </div>
                <textarea class="orch-textarea" id="m-desc" rows="3" placeholder="What does this musician do?">${esc(agent.description || '')}</textarea>
            </div>
            <div class="orch-field">
                <div class="orch-label">
                    Section
                    <span class="term-info" data-term="section">ℹ</span>
                </div>
                <select class="orch-select-field" id="m-category">
                    ${Object.entries(SECTION_DEFS).map(([val, d]) =>
                        '<option value="' + esc(val) + '"' + (agent.category === val ? ' selected' : '') + '>' +
                            esc(d.instrument + ' ' + d.name + ' (' + val + ')') +
                        '</option>'
                    ).join('')}
                </select>
            </div>
        </div>

        <!-- Tuning Panel -->
        <div class="tuning-panel">
            <div class="tuning-title">
                🎛️ Tuning
                <span class="term-badge">Per-agent config</span>
            </div>

            <!-- Instrument Grade (Model) -->
            <div class="orch-field">
                <div class="orch-label">
                    Instrument Grade
                    <span class="term-info" data-term="instrument-grade">ℹ</span>
                </div>
                <div class="radio-group" id="m-model-group">
                    ${modelOptions.map(opt => `
                    <label class="radio-opt${modelVal === opt.val ? ' selected' : ''}" data-val="${esc(opt.val)}">
                        <input type="radio" name="m-model" value="${esc(opt.val)}"${modelVal === opt.val ? ' checked' : ''}>
                        <div>
                            <span class="radio-opt-label" data-term="${opt.term}">${esc(opt.label)}</span>
                            <span class="radio-opt-sub">${esc(opt.sub)}</span>
                        </div>
                    </label>`).join('')}
                </div>
            </div>

            <!-- Max Bars (Max Turns) -->
            <div class="orch-field">
                <div class="orch-label">
                    Max Bars
                    <span class="term-info" data-term="max-bars">ℹ</span>
                </div>
                <input class="orch-input" id="m-max-turns" type="number" min="0" max="200" value="${maxTurns}" placeholder="0 = unlimited">
                <div style="font-size:11px;color:var(--text-faint);margin-top:3px">0 = unlimited</div>
            </div>

            <!-- When They Play (Run Order) -->
            <div class="orch-field">
                <div class="orch-label">
                    When They Play
                    <span class="term-info" data-term="when-they-play">ℹ</span>
                </div>
                <div class="radio-group" id="m-runorder-group">
                    ${runOrderOptions.map(opt => `
                    <label class="radio-opt${(agent.run_order || 'parallel') === opt.val ? ' selected' : ''}" data-val="${esc(opt.val)}">
                        <input type="radio" name="m-runorder" value="${esc(opt.val)}"${(agent.run_order || 'parallel') === opt.val ? ' checked' : ''}>
                        <div>
                            <span class="radio-opt-label" data-term="${opt.term}">${esc(opt.label)}</span>
                            <span class="radio-opt-sub">${esc(opt.sub)}</span>
                        </div>
                    </label>`).join('')}
                </div>
            </div>

            <!-- Solo Mode (Skip Project Context) -->
            <div class="orch-field">
                <div class="orch-label">
                    Solo Mode
                    <span class="term-info" data-term="solo-mode">ℹ</span>
                </div>
                <div class="orch-toggle">
                    <label class="toggle-switch">
                        <input type="checkbox" id="m-skip-ctx"${skipCtx ? ' checked' : ''}>
                        <div class="toggle-track"></div>
                        <div class="toggle-thumb"></div>
                    </label>
                    <span class="toggle-label">Skip project score context<br><span style="font-size:10px;color:var(--text-faint)">Saves ~3,500 tokens/turn</span></span>
                </div>
            </div>
        </div>

        <!-- Cues Panel (Depends On) -->
        <div class="cues-panel">
            <div class="cues-title">
                🎵 Cues
                <span class="term-info" data-term="cued-by">ℹ</span>
                <span class="term-badge" style="margin-left:auto">depends_on</span>
            </div>
            <div class="cues-list" id="cues-list">${_cuesHTML(agent)}</div>
            <div class="cue-add-wrap">
                <input class="cue-add-input" id="cue-add-input" placeholder="Agent ID (e.g. manager)" list="cue-datalist">
                <datalist id="cue-datalist">
                    ${State.agents.map(a => '<option value="' + esc(a.id) + '">' + esc(a.name) + '</option>').join('')}
                </datalist>
                <button class="cue-add-btn" onclick="MusicianView.addCue()">＋</button>
            </div>
        </div>

        <!-- Performance History -->
        ${_performanceHistoryHTML(agent)}`;
    }

    function _cuesHTML(agent) {
        const deps = agent.depends_on || [];
        if (!deps.length) return '<div class="cues-empty">No cues — plays independently</div>';
        return deps.map(dep => {
            const a = State.agents.find(x => x.id === dep);
            return '<div class="cue-tag">' +
                esc(a ? a.name : dep) +
                '<button class="cue-remove" onclick="MusicianView.removeCue(\'' + esc(dep) + '\')" title="Remove cue">✕</button>' +
            '</div>';
        }).join('');
    }

    function _performanceHistoryHTML(agent) {
        return '<div class="perf-history">' +
            '<div class="perf-title">Recent Performances</div>' +
            '<div id="perf-history-list"><div class="cues-empty" style="padding:8px 0">Loading…</div></div>' +
        '</div>';
    }

    // ── Score Header ──────────────────────────────────────────
    function _scoreHeaderHTML(agent) {
        return '<div>' +
            '<div style="font-family:var(--font-serif);font-size:18px;color:var(--gold)">' + esc(agent.name) + '</div>' +
            '<div style="font-size:12px;color:var(--text-muted)">Score <span class="term-badge">Prompt Content</span></div>' +
        '</div>' +
        '<div style="display:flex;gap:8px;align-items:center">' +
            '<span id="score-dirty-indicator" class="hidden" style="font-size:11px;color:var(--amber)">● Unsaved changes</span>' +
        '</div>';
    }

    // ── Score Body (Prompt Editor) ────────────────────────────
    function _scoreBodyHTML(agent) {
        return '<div class="score-editor">' +
            '<div class="score-status-bar">' +
                '<span class="score-stat" id="score-char-count">' + (agent.prompt_content || '').length + ' chars</span>' +
                '<span class="score-stat" id="score-line-count">' + ((agent.prompt_content || '').split('\\n').length) + ' lines</span>' +
                '<span class="score-stat" id="score-word-count">~' + Math.ceil((agent.prompt_content || '').split(/\\s+/).filter(Boolean).length) + ' words</span>' +
            '</div>' +
            '<div class="score-paper">' +
                '<textarea class="score-textarea" id="score-textarea" placeholder="Write the score for this musician…\n\nYou are the [Name] agent.\n\nTasks:\n1. …\n\nOutput a markdown report.">' +
                    esc(agent.prompt_content || '') +
                '</textarea>' +
            '</div>' +
        '</div>';
    }

    // ── Footer ────────────────────────────────────────────────
    function _footerHTML(agent) {
        return '<button class="btn-gold" onclick="MusicianView.save()" id="m-save-btn">💾 Save Score</button>' +
            '<button class="btn-ghost" onclick="MusicianView.runSolo()" title="Run just this agent">▶ Run Solo</button>' +
            (currentUser?.isAdmin ? '<button class="btn-ghost btn-sm" style="color:var(--c-security);margin-left:auto" onclick="MusicianView.deleteMusician()">🗑️ Remove Musician</button>' : '');
    }

    // ── Wire Interactions ─────────────────────────────────────
    function _wireSidebar(agent, def) {
        // Mark dirty on any input change
        ['m-name','m-emoji','m-desc','m-category','m-max-turns'].forEach(id => {
            document.getElementById(id)?.addEventListener('input', markDirty);
        });
        document.getElementById('m-skip-ctx')?.addEventListener('change', markDirty);

        // Model radio group
        document.querySelectorAll('#m-model-group .radio-opt').forEach(opt => {
            opt.addEventListener('click', () => {
                document.querySelectorAll('#m-model-group .radio-opt').forEach(o => o.classList.remove('selected'));
                opt.classList.add('selected');
                opt.querySelector('input').checked = true;
                markDirty();
            });
        });

        // Run order radio group
        document.querySelectorAll('#m-runorder-group .radio-opt').forEach(opt => {
            opt.addEventListener('click', () => {
                document.querySelectorAll('#m-runorder-group .radio-opt').forEach(o => o.classList.remove('selected'));
                opt.classList.add('selected');
                opt.querySelector('input').checked = true;
                markDirty();
            });
        });

        // Live emblem preview
        document.getElementById('m-emoji')?.addEventListener('input', (e) => {
            const preview = document.getElementById('emblem-preview');
            if (preview) preview.textContent = (e.target.value || agent.id || '?').substring(0, 2).toUpperCase();
        });

        // Category change → update instrument display
        document.getElementById('m-category')?.addEventListener('change', (e) => {
            const newDef = getSectionDef(e.target.value);
            document.querySelector('.instrument-emoji').textContent = newDef.instrument;
            document.querySelector('.instrument-name').textContent = newDef.name;
            document.querySelector('.instrument-section').textContent = e.target.value;
            markDirty();
        });

        // Load performance history
        _loadPerformanceHistory(agent.id);
    }

    function _wireScore(agent) {
        const ta = document.getElementById('score-textarea');
        if (!ta) return;
        ta.addEventListener('input', () => {
            markDirty();
            document.getElementById('score-char-count').textContent = ta.value.length + ' chars';
            document.getElementById('score-line-count').textContent = ta.value.split('\n').length + ' lines';
            document.getElementById('score-word-count').textContent = '~' + Math.ceil(ta.value.split(/\s+/).filter(Boolean).length) + ' words';
        });
    }

    function _wireFooter(agent) {
        // Keyboard shortcut: Ctrl+S to save
        document.getElementById('score-textarea')?.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 's') { e.preventDefault(); save(); }
        });
    }

    async function _loadPerformanceHistory(agentId) {
        const el = document.getElementById('perf-history-list');
        if (!el) return;
        try {
            const resp = await apiFetch('/runs?limit=5');
            const runs = (resp.runs || []).filter(r =>
                (r.agents || []).includes(agentId) || r.squad
            ).slice(0, 5);

            if (!runs.length) {
                el.innerHTML = '<div class="cues-empty" style="padding:8px 0">No performances yet</div>';
                return;
            }
            el.innerHTML = runs.map(r => {
                const st = r.status || 'done';
                return '<div class="perf-item">' +
                    '<span class="status-dot ' + st + '"></span>' +
                    '<span class="perf-date">' + esc(fmtDate(r.started_at || r.created_at)) + '</span>' +
                    '<span style="font-size:11px;color:var(--text-muted)">' + esc(r.squad || '—') + '</span>' +
                    '<span class="perf-status"><a href="#" onclick="ConcertHall.viewReport(\'' + esc(r.run_id || r.id) + '\');return false" style="font-size:10px;color:var(--gold-dim)">report →</a></span>' +
                '</div>';
            }).join('');
        } catch(e) {
            el.innerHTML = '<div class="cues-empty" style="padding:8px 0">Could not load history</div>';
        }
    }

    // ── Dirty Tracking ────────────────────────────────────────
    function markDirty() {
        isDirty = true;
        document.getElementById('score-dirty-indicator')?.classList.remove('hidden');
    }

    // ── Collect Form Values ───────────────────────────────────
    function _collectForm() {
        return {
            name:              document.getElementById('m-name')?.value.trim() || '',
            emoji:             document.getElementById('m-emoji')?.value.trim() || '',
            description:       document.getElementById('m-desc')?.value.trim() || '',
            category:          document.getElementById('m-category')?.value || 'meta',
            model:             document.querySelector('#m-model-group input:checked')?.value || 'inherit',
            max_turns:         parseInt(document.getElementById('m-max-turns')?.value || '0'),
            no_project_context: document.getElementById('m-skip-ctx')?.checked || false,
            run_order:         document.querySelector('#m-runorder-group input:checked')?.value || 'parallel',
            prompt_content:    document.getElementById('score-textarea')?.value || '',
            depends_on:        currentAgent?.depends_on || [],
        };
    }

    // ── Save ──────────────────────────────────────────────────
    async function save() {
        if (!currentAgent) return;
        const btn = document.getElementById('m-save-btn');
        const data = _collectForm();

        try {
            if (btn) { btn.disabled = true; btn.textContent = '⏳ Saving…'; }
            await apiFetch('/agents/' + encodeURIComponent(currentAgent.id), {
                method: 'PUT',
                body: JSON.stringify(data),
            });
            isDirty = false;
            document.getElementById('score-dirty-indicator')?.classList.add('hidden');
            toast('Score saved for ' + data.name, 'success');
            await loadAll();
            currentAgent = State.agents.find(a => a.id === currentAgent.id) || currentAgent;
        } catch(e) {
            toast('Save failed: ' + e.message, 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '💾 Save Score'; }
        }
    }

    // ── Run Solo ──────────────────────────────────────────────
    async function runSolo() {
        if (!currentAgent) return;
        const ok = await showConfirm(
            'Run Solo Performance?',
            'Run "' + currentAgent.name + '" alone now? This will use Claude CLI and generate a report.',
            'Perform Solo'
        );
        if (!ok) return;
        try {
            const resp = await apiFetch('/runs/agent/' + encodeURIComponent(currentAgent.id), { method: 'POST' });
            toast('Solo performance started! Run ID: ' + resp.run_id, 'success');
        } catch(e) { toast('Solo failed: ' + e.message, 'error'); }
    }

    // ── Cue Manipulation ──────────────────────────────────────
    function addCue() {
        const input = document.getElementById('cue-add-input');
        if (!input || !currentAgent) return;
        const agentId = input.value.trim();
        if (!agentId) return;
        if (!(currentAgent.depends_on || []).includes(agentId)) {
            currentAgent.depends_on = [...(currentAgent.depends_on || []), agentId];
            document.getElementById('cues-list').innerHTML = _cuesHTML(currentAgent);
            markDirty();
        }
        input.value = '';
    }

    function removeCue(agentId) {
        if (!currentAgent) return;
        currentAgent.depends_on = (currentAgent.depends_on || []).filter(d => d !== agentId);
        document.getElementById('cues-list').innerHTML = _cuesHTML(currentAgent);
        markDirty();
    }

    // ── Delete Musician ───────────────────────────────────────
    async function deleteMusician() {
        if (!currentAgent) return;
        const ok = await showConfirm(
            'Remove Musician?',
            'Remove "' + currentAgent.name + '" from the ensemble permanently? This deletes the agent and their score.',
            'Remove'
        );
        if (!ok) return;
        try {
            await apiFetch('/agents/' + encodeURIComponent(currentAgent.id), { method: 'DELETE' });
            await loadAll();
            navigateTo('orchestra');
            toast('Musician removed from ensemble', 'success');
        } catch(e) { toast(e.message, 'error'); }
    }

    // ── Create Modal (New Musician) ───────────────────────────
    function openCreateModal() {
        const cats = Object.entries(SECTION_DEFS).map(([val, d]) =>
            '<option value="' + esc(val) + '">' + esc(d.instrument + ' ' + d.name + ' (' + val + ')') + '</option>'
        ).join('');

        document.getElementById('musician-modal-box').innerHTML =
            '<div class="modal-header">' +
                '<h2>New Musician <span class="term-badge">New Agent</span></h2>' +
                '<button class="modal-close" onclick="document.getElementById(\'musician-modal\').classList.add(\'hidden\')">✕</button>' +
            '</div>' +
            '<form class="orch-form" onsubmit="MusicianView.submitCreate(event)">' +
                '<div class="form-row">' +
                    '<label>Musician ID <span class="term-badge">Agent ID</span>' +
                        '<input class="orch-input" id="c-id" placeholder="e.g. doc_reviewer" pattern="[a-z0-9_]+" required>' +
                        '<span class="field-hint">Lowercase, underscores only</span>' +
                    '</label>' +
                    '<label>Musician Initials <span class="term-badge" data-term="musician-initials">Emoji/Badge</span>' +
                        '<input class="orch-input" id="c-emoji" placeholder="e.g. DR" maxlength="4">' +
                    '</label>' +
                '</div>' +
                '<label>Musician Name <span class="term-badge">Agent Name</span>' +
                    '<input class="orch-input" id="c-name" placeholder="e.g. Documentation Reviewer" required>' +
                '</label>' +
                '<label>Section <span class="term-badge" data-term="section">Category</span>' +
                    '<select class="orch-select-field" id="c-cat">' + cats + '</select>' +
                '</label>' +
                '<label>Programme Note <span class="term-badge" data-term="programme-note">Description</span>' +
                    '<input class="orch-input" id="c-desc" placeholder="What does this musician do?">' +
                '</label>' +
                '<label>When They Play <span class="term-badge" data-term="when-they-play">Run Order</span>' +
                    '<select class="orch-select-field" id="c-runorder">' +
                        '<option value="parallel">Main Movement (parallel) — default</option>' +
                        '<option value="first">Intro (first)</option>' +
                        '<option value="last">Coda (last)</option>' +
                    '</select>' +
                '</label>' +
                '<label>Score <span class="term-badge" data-term="score">Prompt Content</span>' +
                    '<textarea class="orch-textarea" id="c-prompt" rows="6" placeholder="You are the [Name] agent.\n\nTasks:\n1. …\n\nOutput a markdown report."></textarea>' +
                '</label>' +
                '<div class="modal-actions">' +
                    '<button type="button" class="btn-ghost" onclick="document.getElementById(\'musician-modal\').classList.add(\'hidden\')">Cancel</button>' +
                    '<button type="submit" class="btn-gold">Add to Ensemble</button>' +
                '</div>' +
            '</form>';

        document.getElementById('musician-modal').classList.remove('hidden');
        document.getElementById('c-id')?.focus();
    }

    async function submitCreate(e) {
        e.preventDefault();
        const id      = document.getElementById('c-id').value.trim();
        const name    = document.getElementById('c-name').value.trim();
        const emoji   = document.getElementById('c-emoji').value.trim() || id.substring(0, 2).toUpperCase();
        const cat     = document.getElementById('c-cat').value;
        const desc    = document.getElementById('c-desc').value.trim();
        const order   = document.getElementById('c-runorder').value;
        const prompt  = document.getElementById('c-prompt').value;

        try {
            await apiFetch('/agents', {
                method: 'POST',
                body: JSON.stringify({ id, name, emoji, category: cat, description: desc, run_order: order, prompt_content: prompt, depends_on: [] }),
            });
            await loadAll();
            document.getElementById('musician-modal').classList.add('hidden');
            toast('Musician "' + name + '" added to ensemble', 'success');
            navigateTo('musician', { musicianId: id });
        } catch(err) { toast(err.message, 'error'); }
    }

    // ── Helpers ───────────────────────────────────────────────
    function hexAlpha(hex, alpha) {
        const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
        return `rgba(${r},${g},${b},${alpha})`;
    }

    return { render, save, runSolo, addCue, removeCue, deleteMusician, openCreateModal, submitCreate };
})();
