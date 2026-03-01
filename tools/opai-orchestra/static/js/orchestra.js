/**
 * OPAI Agent Orchestra — Level 1: The Orchestra Pit (SVG visualization).
 *
 * Layout system: ROW-BANDS instead of concentric circular arcs.
 * Each section occupies a guaranteed non-overlapping horizontal band.
 * Within each band, agents follow a gentle parabolic arc (center bows
 * toward the audience, sides curve back) — giving the orchestra look
 * without the geometric overlap that circular arcs produce at the sides.
 *
 * Band geometry (y increases downward in SVG):
 *   Agents sit at:  y_agent(t) = yCtr - parabH·4t(1-t)   where t∈[0,1]
 *   Inner edge (front/audience side):  y = yCtr + bandH/2  (high y = front)
 *   Outer edge (back):                 y = yCtr - bandH/2  (low y = back)
 *   Sides of both edges bow down by parabH.
 *   All bands verified to have ≥10px gap between them.
 */

const OrchestraPit = (() => {

    // ── Section Row Definitions ───────────────────────────────
    // yCtr: agent centerline. parabH: px the sides bow below center.
    // bandH: total band height in px. xL/xR: left/right edge of section.
    // Verified no-overlap spacing — see module comment.
    const SECTION_ROWS = {
        leadership:    { yCtr: 450, parabH: 4,  bandH: 28, xL: 392, xR: 508 },
        quality:       { yCtr: 385, parabH: 11, bandH: 38, xL: 218, xR: 682 },
        planning:      { yCtr: 319, parabH: 15, bandH: 38, xL: 162, xR: 738 },
        research:      { yCtr: 252, parabH: 18, bandH: 38, xL: 112, xR: 788 },
        security:      { yCtr: 184, parabH: 20, bandH: 38, xL: 66,  xR: 834 },
        operations:    { yCtr: 116, parabH: 22, bandH: 36, xL: 24,  xR: 876 },
    };

    // Top-row mini-sections for small categories (side/special instruments).
    // Placed in two horizontal groups, above the main bands.
    const TOP_SECTIONS_LEFT  = ['meta', 'content'];
    const TOP_SECTIONS_RIGHT = ['orchestration', 'execution'];
    const TOP_Y = 50;       // centerline for top-row sections
    const TOP_BAND_H = 28;
    const TOP_PARAB_H = 4;

    // Pod x-ranges for left and right top sections (split canvas into zones)
    const TOP_LEFT_ZONES  = { meta: [20, 180], content: [200, 360] };
    const TOP_RIGHT_ZONES = { orchestration: [540, 700], execution: [720, 880] };

    let svg = null;
    let tooltip = null;

    // ── Render ────────────────────────────────────────────────
    function render() {
        svg = document.getElementById('orchestra-svg');
        tooltip = document.getElementById('pit-tooltip');
        if (!svg) return;

        svg.innerHTML = '';

        _drawDefs();
        _drawStageDecor();

        // Group agents by category
        const byCategory = {};
        State.agents.forEach(a => {
            const cat = a.category || 'meta';
            if (!byCategory[cat]) byCategory[cat] = [];
            byCategory[cat].push(a);
        });

        // Main arc sections
        Object.entries(SECTION_ROWS).forEach(([cat, row]) => {
            _drawBand(cat, row, byCategory[cat] || []);
        });

        // Top mini-sections (left side)
        TOP_SECTIONS_LEFT.forEach(cat => {
            const zone = TOP_LEFT_ZONES[cat];
            if (!zone) return;
            const row = { yCtr: TOP_Y, parabH: TOP_PARAB_H, bandH: TOP_BAND_H, xL: zone[0], xR: zone[1] };
            _drawBand(cat, row, byCategory[cat] || []);
        });

        // Top mini-sections (right side)
        TOP_SECTIONS_RIGHT.forEach(cat => {
            const zone = TOP_RIGHT_ZONES[cat];
            if (!zone) return;
            const row = { yCtr: TOP_Y, parabH: TOP_PARAB_H, bandH: TOP_BAND_H, xL: zone[0], xR: zone[1] };
            _drawBand(cat, row, byCategory[cat] || []);
        });

        // Audience/stage indicator
        _drawAudienceGlow();

        updatePitControls();
        renderLegend();
        updateLive();
    }

    // ── Band Drawing ──────────────────────────────────────────
    function _drawBand(cat, row, agents) {
        const def = getSectionDef(cat);
        const { yCtr, parabH, bandH, xL, xR } = row;
        const xMid = (xL + xR) / 2;

        // Band background shape — inner (front) and outer (back) parabolic edges
        const yInnerMid  = yCtr + bandH / 2;
        const yInnerSide = yCtr + parabH + bandH / 2;
        const cpInnerY   = 2 * yInnerMid - yInnerSide;   // bezier control point

        const yOuterMid  = yCtr - bandH / 2;
        const yOuterSide = yCtr + parabH - bandH / 2;
        const cpOuterY   = 2 * yOuterMid - yOuterSide;

        const bandPath = [
            `M ${xL} ${yInnerSide.toFixed(1)}`,
            `Q ${xMid} ${cpInnerY.toFixed(1)} ${xR} ${yInnerSide.toFixed(1)}`,
            `L ${xR} ${yOuterSide.toFixed(1)}`,
            `Q ${xMid} ${cpOuterY.toFixed(1)} ${xL} ${yOuterSide.toFixed(1)}`,
            `Z`,
        ].join(' ');

        const bandEl = svgEl('path', {
            d: bandPath,
            fill: hexAlpha(def.color, 0.07),
            stroke: hexAlpha(def.color, 0.28),
            'stroke-width': '1',
            class: 'svg-section-band',
        });
        svg.appendChild(bandEl);

        // Section label — centered above the band's outer (back) edge
        const labelY = (cpOuterY - 10).toFixed(1);
        const labelEl = svgEl('text', {
            x: xMid,
            y: labelY,
            fill: hexAlpha(def.color, 0.75),
            class: 'svg-section-label',
            'text-anchor': 'middle',
            'dominant-baseline': 'central',
        });
        labelEl.textContent = (def.instrument + ' ' + def.name).toUpperCase();
        svg.appendChild(labelEl);

        // Place agents along the parabolic arc
        if (!agents.length) {
            const emptyEl = svgEl('text', {
                x: xMid, y: yCtr,
                fill: 'rgba(255,255,255,0.1)', 'font-size': '8',
                'text-anchor': 'middle', 'dominant-baseline': 'central',
                'font-family': 'Inter, sans-serif',
            });
            emptyEl.textContent = 'empty';
            svg.appendChild(emptyEl);
            return;
        }

        const n = agents.length;
        agents.forEach((agent, i) => {
            const t = n > 1 ? i / (n - 1) : 0.5;
            const ax = xL + t * (xR - xL);
            const ay = yCtr - parabH * 4 * t * (1 - t);  // arc: center bows toward audience
            _drawMusicianSeat(agent, ax, ay, def.color);
        });
    }

    // ── Musician Seat ─────────────────────────────────────────
    function _drawMusicianSeat(agent, x, y, color) {
        const g = svgEl('g', {
            class: 'svg-musician-seat',
            id: 'seat-' + agent.id,
            transform: `translate(${x.toFixed(1)},${y.toFixed(1)})`,
        });
        g.dataset.agentId = agent.id;

        // Hover ring
        const ring = svgEl('circle', {
            r: 17, cx: 0, cy: 0,
            fill: 'none',
            stroke: color, 'stroke-width': '1.5', 'stroke-opacity': '0.25',
            class: 'seat-ring',
        });

        // Seat fill
        const circle = svgEl('circle', {
            r: 12, cx: 0, cy: 0,
            fill: hexAlpha(color, 0.88),
            class: 'seat-circle',
        });

        // Initials
        const initials = (agent.emoji || agent.id || '?').substring(0, 2).toUpperCase();
        const labelEl = svgEl('text', {
            class: 'seat-label', fill: '#fff',
            'font-size': '8', x: 0, y: 0,
        });
        labelEl.textContent = initials;

        // Name below
        const nameEl = svgEl('text', {
            class: 'seat-name', fill: 'rgba(255,255,255,0.5)',
            'font-size': '6.5', x: 0, y: 20,
        });
        nameEl.textContent = _truncate(agent.name || agent.id, 13);

        g.append(ring, circle, labelEl, nameEl);

        // Events
        g.addEventListener('click', () =>
            navigateTo('musician', { musicianId: agent.id, sectionId: State.currentSection }));
        g.addEventListener('mouseenter', e => {
            _showTooltip(agent, e);
            ring.setAttribute('stroke-opacity', '0.8');
        });
        g.addEventListener('mousemove', e => _positionTooltip(e));
        g.addEventListener('mouseleave', () => {
            _hideTooltip();
            ring.setAttribute('stroke-opacity', '0.25');
        });

        svg.appendChild(g);
    }

    // ── Stage Decor ───────────────────────────────────────────
    function _drawDefs() {
        const defs = svgEl('defs');

        const grad = svgEl('radialGradient', { id: 'stage-glow-grad', cx: '50%', cy: '100%', r: '50%' });
        _addStop(grad, '0%', 'rgba(201,168,76,0.07)');
        _addStop(grad, '100%', 'rgba(0,0,0,0)');
        defs.appendChild(grad);

        svg.appendChild(defs);
    }

    function _drawStageDecor() {
        // Stage floor arc at the bottom (audience side)
        const floor = svgEl('path', {
            d: 'M 30 488 L 30 462 Q 450 440 870 462 L 870 488 Z',
            fill: 'rgba(201,168,76,0.04)',
            stroke: 'rgba(201,168,76,0.14)',
            'stroke-width': '1',
        });
        svg.appendChild(floor);

        // Conductor podium (small ellipse at leadership front)
        const podium = svgEl('ellipse', {
            cx: 450, cy: 465, rx: 22, ry: 7,
            fill: 'rgba(239,68,68,0.1)',
            stroke: 'rgba(239,68,68,0.28)',
            'stroke-width': '1',
        });
        svg.appendChild(podium);

        // Subtle divider between main sections and top special sections
        const divider = svgEl('line', {
            x1: 20, y1: 76, x2: 880, y2: 76,
            stroke: 'rgba(255,255,255,0.05)',
            'stroke-width': '1',
            'stroke-dasharray': '4 6',
        });
        svg.appendChild(divider);

        // "Special Instruments" label
        const specLabel = svgEl('text', {
            x: 450, y: 20,
            fill: 'rgba(255,255,255,0.12)',
            'font-size': '8', 'font-family': 'Playfair Display, serif',
            'text-anchor': 'middle', 'letter-spacing': '3',
        });
        specLabel.textContent = 'SPECIAL INSTRUMENTS';
        svg.appendChild(specLabel);
    }

    function _drawAudienceGlow() {
        const glow = svgEl('ellipse', {
            cx: 450, cy: 490, rx: 260, ry: 50,
            fill: 'url(#stage-glow-grad)',
        });
        svg.appendChild(glow);

        const audienceLabel = svgEl('text', {
            x: 450, y: 484,
            fill: 'rgba(201,168,76,0.22)',
            'font-size': '9', 'font-family': 'Playfair Display, serif',
            'text-anchor': 'middle', 'letter-spacing': '4',
        });
        audienceLabel.textContent = 'AUDIENCE';
        svg.appendChild(audienceLabel);
    }

    // ── Tooltip ───────────────────────────────────────────────
    function _showTooltip(agent, e) {
        if (!tooltip) return;
        const def = getSectionDef(agent.category);
        const roLabel = { first: 'Intro (first)', parallel: 'Main Movement (parallel)', last: 'Coda (last)' };
        const modelLabel = (agent.model && agent.model !== 'inherit') ? agent.model : 'inherit (default)';

        tooltip.innerHTML =
            '<div class="pit-tooltip-cat">' + esc(def.instrument + ' ' + def.name) + '</div>' +
            '<div class="pit-tooltip-name">' + esc(agent.name) + '</div>' +
            '<div class="pit-tooltip-desc">' + esc(agent.description || '—') + '</div>' +
            '<div class="pit-tooltip-tech">plays: ' + esc(roLabel[agent.run_order] || agent.run_order || 'parallel') +
            ' · model: ' + esc(modelLabel) + '</div>';

        tooltip.classList.remove('hidden');
        _positionTooltip(e);
    }

    function _positionTooltip(e) {
        if (!tooltip || tooltip.classList.contains('hidden')) return;
        const wrap = document.getElementById('pit-svg-wrap');
        const wr = wrap.getBoundingClientRect();
        let lx = e.clientX - wr.left + 14;
        let ly = e.clientY - wr.top  + 14;
        if (lx + 270 > wr.width)  lx = e.clientX - wr.left - 270 - 10;
        if (ly + 140 > wr.height) ly = e.clientY - wr.top  - 140 - 10;
        tooltip.style.left = lx + 'px';
        tooltip.style.top  = ly + 'px';
    }

    function _hideTooltip() {
        if (tooltip) tooltip.classList.add('hidden');
    }

    // ── Live Run Overlay ──────────────────────────────────────
    function updateLive() {
        const running = new Set(), done = new Set();
        State.activeRuns.forEach(r => {
            (r.agents_running || []).forEach(id => running.add(id));
            (r.agents_done   || []).forEach(id => done.add(id));
        });
        document.querySelectorAll('.svg-musician-seat').forEach(g => {
            const circle = g.querySelector('.seat-circle');
            if (!circle) return;
            const id = g.dataset.agentId;
            circle.classList.toggle('seat-live', running.has(id));
            circle.classList.toggle('seat-done', !running.has(id) && done.has(id));
        });
    }

    // ── Controls ──────────────────────────────────────────────
    function updatePitControls() {
        const sel  = document.getElementById('pit-programme-select');
        const btn  = document.getElementById('pit-perform-btn');
        const info = document.getElementById('pit-counts');

        if (sel) {
            const cur = sel.value;
            sel.innerHTML = '<option value="">— Select a Programme —</option>' +
                State.squads.map(s =>
                    '<option value="' + esc(s.id) + '"' + (s.id === cur ? ' selected' : '') + '>' +
                    esc(s.id) + (s.description ? ' — ' + esc(s.description) : '') + '</option>'
                ).join('');
            sel.onchange = () => {
                if (btn) btn.disabled = !sel.value;
                _highlightProgramme(sel.value);
            };
            // Restore dimming if a programme was already selected
            _highlightProgramme(cur);
        }

        if (btn) {
            btn.disabled = !sel?.value;
            btn.onclick = async () => {
                const squadId = document.getElementById('pit-programme-select').value;
                if (!squadId) return;
                try {
                    btn.disabled = true; btn.textContent = '⏳ Performing…';
                    const r = await apiFetch('/runs/squad/' + encodeURIComponent(squadId), { method: 'POST' });
                    toast('Performance begun! Run ID: ' + r.run_id, 'success');
                    await refreshActiveRuns(); updateLive();
                } catch(e) { toast('Performance failed: ' + e.message, 'error'); }
                finally { btn.textContent = '▶ Begin Performance'; btn.disabled = false; }
            };
        }

        // "View Flow" button — opens Composition Studio preloaded with selected programme
        const flowBtn = document.getElementById('pit-view-flow-btn');
        if (flowBtn) {
            flowBtn.onclick = () => {
                const squadId = document.getElementById('pit-programme-select')?.value;
                if (!squadId) return;
                navigateTo('composition', { squadId });
            };
            // Keep enabled state in sync with select
            sel?.addEventListener('change', () => { flowBtn.disabled = !sel.value; });
            flowBtn.disabled = !sel?.value;
        }

        if (info) info.textContent = State.agents.length + ' musicians · ' + State.squads.length + ' programmes';
    }

    // ── Programme Highlight ───────────────────────────────────
    // Dims all musician seats that are NOT members of the selected programme.
    // Pass empty string to reset everything to full opacity.
    function _highlightProgramme(squadId) {
        const seats = document.querySelectorAll('.svg-musician-seat');
        if (!squadId) {
            seats.forEach(g => { g.style.opacity = ''; g.style.filter = ''; g.style.pointerEvents = ''; });
            const info = document.getElementById('pit-counts');
            if (info) info.textContent = State.agents.length + ' musicians · ' + State.squads.length + ' programmes';
            return;
        }
        const squad = State.squads.find(s => s.id === squadId);
        // squad.agents may be full objects or plain IDs — normalise to a Set of ID strings
        const rawAgents = squad?.agents || [];
        const memberIds = new Set(rawAgents.map(a => (typeof a === 'object' ? a.id : a)));
        seats.forEach(g => {
            const inProgramme = memberIds.has(g.dataset.agentId);
            g.style.opacity       = inProgramme ? '1' : '0.08';
            g.style.filter        = inProgramme ? '' : 'grayscale(1)';
            g.style.pointerEvents = inProgramme ? '' : 'none';
        });
        const info = document.getElementById('pit-counts');
        if (info) info.textContent = memberIds.size + ' musicians in programme · ' + State.squads.length + ' programmes total';
    }

    // ── Legend ────────────────────────────────────────────────
    function renderLegend() {
        const el = document.getElementById('pit-legend');
        if (!el) return;
        const cats = [...new Set(State.agents.map(a => a.category).filter(Boolean))];
        el.innerHTML = cats.map(cat => {
            const def = getSectionDef(cat);
            const count = State.agents.filter(a => a.category === cat).length;
            return '<div class="legend-item" onclick="filterBySection(\'' + esc(cat) + '\')">' +
                '<div class="legend-dot" style="background:' + def.color + '"></div>' +
                '<span>' + esc(def.instrument + ' ' + def.name) + ' (' + count + ')</span>' +
            '</div>';
        }).join('');
    }

    // ── Helpers ───────────────────────────────────────────────
    function svgEl(tag, attrs = {}) {
        const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
        Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
        return el;
    }
    function _addStop(grad, offset, color) {
        grad.appendChild(svgEl('stop', { offset, 'stop-color': color }));
    }
    function hexAlpha(hex, alpha) {
        const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
        return `rgba(${r},${g},${b},${alpha})`;
    }
    function _truncate(s, n) {
        return s && s.length > n ? s.substring(0, n-1) + '…' : (s || '');
    }

    return { render, updateLive, highlightProgramme: _highlightProgramme };
})();

// ── Legend filter (category dim) ──────────────────────────────
// Clears any programme highlight first, then dims by section.
function filterBySection(cat) {
    // Clear programme highlight so the two filters don't stack
    OrchestraPit.highlightProgramme('');

    document.querySelectorAll('.svg-musician-seat').forEach(g => {
        const agent = State.agents.find(a => a.id === g.dataset.agentId);
        const inSection = !cat || agent?.category === cat;
        g.style.opacity = inSection ? '1' : '0.1';
        g.style.filter  = inSection ? '' : 'grayscale(1)';
    });

    // Also reset the programme select so it doesn't look selected
    if (cat) {
        const sel = document.getElementById('pit-programme-select');
        if (sel) sel.value = '';
        const btn = document.getElementById('pit-perform-btn');
        if (btn) btn.disabled = true;
    }
}
