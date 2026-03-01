/**
 * OPAI Agent Orchestra — Composition Studio (Visual Flow Editor).
 * Fixes: pixel-perfect port positions via getBoundingClientRect,
 * right-side agent info panel, right-click context menu for
 * node/connection deletion, squad preload from orchestra view.
 */

const CompositionStudio = (() => {
    // ── Canvas State ──────────────────────────────────────────
    let nodes       = [];
    let connections = [];
    let zoom = 1, panX = 0, panY = 0;
    let isPanning = false, panStart = { x: 0, y: 0 };
    let drawingConn = null;   // { fromNodeId, x1, y1 } — in-progress connection
    let mouseX = 0, mouseY = 0; // screen coords of current mouse position
    let nextId  = 1;

    // Right-panel state
    let rightPanelNode = null;

    // DOM refs
    let $canvasWrap, $nodesLayer, $svg;

    // ── Init / Render ─────────────────────────────────────────
    function render(opts = {}) {
        const shell = document.getElementById('composition-shell');
        shell.innerHTML =
            '<div class="comp-toolbar">' +
                '<span style="font-family:var(--font-serif);font-size:14px;color:var(--gold)">🖊️ Composition Studio <span class="term-badge">Flow Editor</span></span>' +
                '<div style="height:20px;width:1px;background:var(--border);margin:0 4px"></div>' +
                '<button class="btn-ghost btn-sm" onclick="CompositionStudio.clearCanvas()" title="Clear canvas">Clear</button>' +
                '<button class="btn-ghost btn-sm" onclick="CompositionStudio.zoomReset()" title="Reset zoom">⌖ Reset</button>' +
                '<button class="btn-ghost btn-sm" onclick="CompositionStudio.saveAsWorkflow()">💾 Save as Symphony</button>' +
                '<div style="margin-left:auto;font-size:11px;color:var(--text-faint)" id="comp-status">Ready · right-click nodes or connections to delete</div>' +
            '</div>' +
            '<div class="comp-canvas-area">' +
                '<div class="comp-palette" id="comp-palette"></div>' +
                '<div class="comp-canvas-wrap" id="comp-canvas-wrap">' +
                    // SVG first (z-order below nodes); same CSS transform as nodesLayer
                    '<svg class="comp-svg" id="comp-svg" style="overflow:visible;position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;transform-origin:0 0;z-index:1"></svg>' +
                    '<div class="comp-nodes" id="comp-nodes" style="z-index:2"></div>' +
                    // Right info panel — slides in from right of canvas
                    '<div class="comp-right-panel" id="comp-right-panel">' +
                        '<div class="crp-close" onclick="CompositionStudio.hideRightPanel()">✕</div>' +
                        '<div id="crp-body"></div>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div class="comp-ai-bar">' +
                '<span style="font-size:12px;color:var(--text-muted);white-space:nowrap">🎵 Compose with AI</span>' +
                '<input class="comp-ai-input" id="comp-ai-input" placeholder="Describe a pipeline… e.g. &quot;Audit security then generate a report&quot;">' +
                '<button class="comp-ai-btn" onclick="CompositionStudio.aiBuild()">Compose →</button>' +
            '</div>' +
            // Context menu (fixed to viewport)
            '<div class="comp-context-menu hidden" id="comp-context-menu"></div>';

        $canvasWrap = document.getElementById('comp-canvas-wrap');
        $nodesLayer = document.getElementById('comp-nodes');
        $svg        = document.getElementById('comp-svg');

        _initCanvas();
        _renderPalette();
        _renderNodes();
        _renderConnections();

        // Preload a squad if passed in
        if (opts.squadId) {
            preloadSquad(opts.squadId);
        }
    }

    // ── Canvas Init ───────────────────────────────────────────
    function _initCanvas() {
        if (!$canvasWrap) return;
        $canvasWrap.addEventListener('mousedown', _onCanvasDown);
        $canvasWrap.addEventListener('wheel', _onWheel, { passive: false });
        window.addEventListener('mousemove', _onMouseMove);
        window.addEventListener('mouseup',   _onMouseUp);

        // Right-click on canvas: check for node or nearby connection
        $canvasWrap.addEventListener('contextmenu', _onContextMenu);

        // Click on canvas background → close right panel and context menu
        $canvasWrap.addEventListener('mousedown', (e) => {
            if (e.target === $canvasWrap || e.target === $svg) {
                hideRightPanel();
                _hideContextMenu();
            }
        }, true /* capture so it fires before node stopPropagation */);

        // Clicking anywhere outside context menu hides it
        window.addEventListener('click', _hideContextMenu);

        const aiInput = document.getElementById('comp-ai-input');
        if (aiInput) aiInput.addEventListener('keydown', e => { if (e.key === 'Enter') aiBuild(); });
    }

    // Apply matching CSS transform to both SVG and nodes layer.
    function _applyTransform() {
        const t = `translate(${panX}px,${panY}px) scale(${zoom})`;
        if ($nodesLayer) { $nodesLayer.style.transform = t; $nodesLayer.style.transformOrigin = '0 0'; }
        if ($svg)        { $svg.style.transform = t; }
    }

    // Convert screen-space point → canvas-space coords (same as node x/y).
    function _toCanvas(cx, cy) {
        if (!$canvasWrap) return { x: cx, y: cy };
        const r = $canvasWrap.getBoundingClientRect();
        return { x: (cx - r.left - panX) / zoom, y: (cy - r.top - panY) / zoom };
    }

    // Get pixel-perfect port center in canvas-space coords via DOM measurement.
    function _portPos(nodeId, portType) {
        const dot = document.querySelector('#fn-' + nodeId + ' .fn-port-' + portType + ' .fn-port-dot');
        if (!dot || !$canvasWrap) return null;
        const dr = dot.getBoundingClientRect();
        const wr = $canvasWrap.getBoundingClientRect();
        return {
            x: (dr.left + dr.width  / 2 - wr.left - panX) / zoom,
            y: (dr.top  + dr.height / 2 - wr.top  - panY) / zoom,
        };
    }

    // ── Palette ───────────────────────────────────────────────
    function _renderPalette() {
        const el = document.getElementById('comp-palette');
        if (!el) return;

        const bySection = {};
        State.agents.forEach(a => {
            const cat = a.category || 'meta';
            if (!bySection[cat]) bySection[cat] = [];
            bySection[cat].push(a);
        });

        let html = '';
        Object.entries(bySection).forEach(([cat, agents]) => {
            const def = getSectionDef(cat);
            html += '<div class="palette-section-h">' + esc(def.instrument + ' ' + def.name) + '</div>';
            html += agents.map(a => {
                const initials = (a.emoji || a.id || '?').substring(0, 2).toUpperCase();
                return '<div class="palette-item" draggable="true" data-agent-id="' + esc(a.id) + '" title="Drag to canvas or click to add">' +
                    '<div class="palette-badge" style="background:' + hexAlpha(def.color, 0.25) + ';color:' + def.color + '">' + esc(initials) + '</div>' +
                    '<span class="palette-name">' + esc(a.name) + '</span>' +
                '</div>';
            }).join('');
        });

        el.innerHTML = html;

        el.querySelectorAll('.palette-item').forEach(item => {
            item.addEventListener('dragstart', e => e.dataTransfer.setData('agentId', item.dataset.agentId));
            item.addEventListener('click', () =>
                addAgentNode(item.dataset.agentId, 160 + Math.random() * 300, 80 + Math.random() * 220)
            );
        });

        $canvasWrap.addEventListener('dragover', e => e.preventDefault());
        $canvasWrap.addEventListener('drop', e => {
            e.preventDefault();
            const agentId = e.dataTransfer.getData('agentId');
            if (!agentId) return;
            const pos = _toCanvas(e.clientX, e.clientY);
            addAgentNode(agentId, pos.x, pos.y);
        });
    }

    // ── Nodes ─────────────────────────────────────────────────
    function addAgentNode(agentId, x, y) {
        const agent = State.agents.find(a => a.id === agentId);
        if (!agent) return;
        nodes.push({ id: 'n' + (nextId++), agentId, x, y, agent });
        _renderNodes();
        _renderConnections();
        _setStatus(nodes.length + ' musicians on stage');
    }

    function _renderNodes() {
        if (!$nodesLayer) return;
        $nodesLayer.innerHTML = '';
        _applyTransform();
        nodes.forEach(node => $nodesLayer.appendChild(_createNodeEl(node)));
    }

    function _createNodeEl(node) {
        const agent  = node.agent;
        const def    = getSectionDef(agent.category);
        const initials = (agent.emoji || agent.id || '?').substring(0, 2).toUpperCase();
        const isActive = rightPanelNode?.id === node.id;

        const el = document.createElement('div');
        el.className = 'flow-node' + (isActive ? ' selected' : '');
        el.id = 'fn-' + node.id;
        el.style.left = node.x + 'px';
        el.style.top  = node.y + 'px';

        el.innerHTML =
            '<div class="fn-head">' +
                '<div class="fn-emblem" style="background:' + hexAlpha(def.color, 0.25) + ';color:' + def.color + '">' + esc(initials) + '</div>' +
                '<div>' +
                    '<div class="fn-name">' + esc(agent.name) + '</div>' +
                    '<div class="fn-cat">' + esc(def.instrument + ' ' + def.name) + '</div>' +
                '</div>' +
            '</div>' +
            '<div class="fn-desc">' + esc((agent.description || '').substring(0, 55)) + '</div>' +
            '<div class="fn-port fn-port-in"  data-node="' + node.id + '"><div class="fn-port-dot"></div></div>' +
            '<div class="fn-port fn-port-out" data-node="' + node.id + '"><div class="fn-port-dot"></div></div>' +
            '<button class="fn-del-btn" onclick="CompositionStudio.removeNode(\'' + node.id + '\')">✕</button>';

        el.addEventListener('mouseenter', () => el.querySelector('.fn-del-btn').style.opacity = '1');
        el.addEventListener('mouseleave', () => el.querySelector('.fn-del-btn').style.opacity = '0');

        // Click node body → show right panel (don't re-render)
        el.addEventListener('click', e => {
            if (e.target.closest('.fn-port') || e.target.closest('.fn-del-btn')) return;
            e.stopPropagation();
            _showRightPanel(node);
        });

        // Drag node
        el.addEventListener('mousedown', e => {
            if (e.target.closest('.fn-port') || e.target.closest('.fn-del-btn')) return;
            e.stopPropagation();

            el.classList.add('dragging');
            const startX = e.clientX, startY = e.clientY;
            const origX  = node.x,     origY  = node.y;

            const onMove = ev => {
                node.x = origX + (ev.clientX - startX) / zoom;
                node.y = origY + (ev.clientY - startY) / zoom;
                el.style.left = node.x + 'px';
                el.style.top  = node.y + 'px';
                _renderConnections(); // re-draw lines as node moves
            };
            const onUp = () => {
                el.classList.remove('dragging');
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup',   onUp);
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup',   onUp);
        });

        // Out-port: start drawing connection
        el.querySelector('.fn-port-out')?.addEventListener('mousedown', e => {
            e.stopPropagation();
            const pos = _portPos(node.id, 'out');
            if (pos) drawingConn = { fromNodeId: node.id, x1: pos.x, y1: pos.y };
        });

        // In-port: complete connection (precision drop)
        el.querySelector('.fn-port-in')?.addEventListener('mouseup', e => {
            e.stopPropagation();
            if (drawingConn && drawingConn.fromNodeId !== node.id) {
                _addConnection(drawingConn.fromNodeId, node.id);
            }
            drawingConn = null;
            _renderConnections();
        });

        return el;
    }

    function _addConnection(fromId, toId) {
        if (!connections.some(c => c.from === fromId && c.to === toId)) {
            connections.push({ from: fromId, to: toId });
            _renderConnections();
        }
    }

    function removeNode(nodeId) {
        nodes = nodes.filter(n => n.id !== nodeId);
        connections = connections.filter(c => c.from !== nodeId && c.to !== nodeId);
        if (rightPanelNode?.id === nodeId) hideRightPanel();
        _renderNodes();
        _renderConnections();
        _setStatus(nodes.length + ' musicians on stage');
    }

    function removeConnection(fromId, toId) {
        connections = connections.filter(c => !(c.from === fromId && c.to === toId));
        _renderConnections();
    }

    // ── Connections (SVG) ─────────────────────────────────────
    // Uses _portPos (getBoundingClientRect) for pixel-perfect alignment.
    // Both the SVG and nodesLayer share the same CSS transform so
    // raw canvas-space coords map directly to SVG path coords.
    function _renderConnections() {
        if (!$svg) return;

        $svg.innerHTML =
            '<defs>' +
                '<marker id="arr"  markerWidth="9" markerHeight="9" refX="8" refY="3.5" orient="auto"><path d="M0,0 L0,7 L9,3.5 z" fill="rgba(201,168,76,0.8)"/></marker>' +
                '<marker id="arrd" markerWidth="9" markerHeight="9" refX="8" refY="3.5" orient="auto"><path d="M0,0 L0,7 L9,3.5 z" fill="rgba(201,168,76,0.35)"/></marker>' +
            '</defs>';

        connections.forEach((conn, idx) => {
            const fromNode = nodes.find(n => n.id === conn.from);
            const toNode   = nodes.find(n => n.id === conn.to);
            if (!fromNode || !toNode) return;

            const p1 = _portPos(fromNode.id, 'out');
            const p2 = _portPos(toNode.id,   'in');
            if (!p1 || !p2) return;

            const cpx = (p1.x + p2.x) / 2;

            // Wide invisible hit-path for right-click detection (stored as data)
            const hitPath = svgEl('path', {
                d: `M ${p1.x} ${p1.y} C ${cpx} ${p1.y} ${cpx} ${p2.y} ${p2.y}`,
                fill: 'none', stroke: 'transparent', 'stroke-width': '14',
                'data-conn-from': conn.from, 'data-conn-to': conn.to,
                style: 'pointer-events:stroke; cursor:context-menu',
            });

            const visPath = svgEl('path', {
                d: `M ${p1.x} ${p1.y} C ${cpx} ${p1.y} ${cpx} ${p2.y} ${p2.x} ${p2.y}`,
                fill: 'none',
                stroke: 'rgba(201,168,76,0.55)',
                'stroke-width': '2',
                'marker-end': 'url(#arr)',
            });

            $svg.appendChild(hitPath);
            $svg.appendChild(visPath);
        });

        // In-progress dashed line while drawing a connection
        if (drawingConn) {
            const pos = _toCanvas(mouseX, mouseY);
            const cpx = (drawingConn.x1 + pos.x) / 2;
            const tempPath = svgEl('path', {
                d: `M ${drawingConn.x1} ${drawingConn.y1} C ${cpx} ${drawingConn.y1} ${cpx} ${pos.y} ${pos.x} ${pos.y}`,
                fill: 'none', stroke: 'rgba(201,168,76,0.3)',
                'stroke-width': '1.5', 'stroke-dasharray': '5 4',
                'marker-end': 'url(#arrd)',
            });
            $svg.appendChild(tempPath);
        }
    }

    function svgEl(tag, attrs = {}) {
        const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
        Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
        return el;
    }

    // ── Pan / Zoom ────────────────────────────────────────────
    function _onCanvasDown(e) {
        _hideContextMenu();
        if (e.target !== $canvasWrap && e.target !== $svg) return;
        isPanning = true;
        panStart  = { x: e.clientX - panX, y: e.clientY - panY };
        $canvasWrap.classList.add('panning');
    }

    function _onMouseMove(e) {
        mouseX = e.clientX; mouseY = e.clientY;
        if (isPanning) {
            panX = e.clientX - panStart.x;
            panY = e.clientY - panStart.y;
            _applyTransform();
        }
        if (isPanning || drawingConn) _renderConnections();
    }

    function _onMouseUp(e) {
        // Proximity snap: if still drawing a connection, snap to nearest in-port
        if (drawingConn) {
            const pos = _toCanvas(e.clientX, e.clientY);
            let closest = null, minDist = 52;
            nodes.forEach(n => {
                if (n.id === drawingConn.fromNodeId) return;
                const p = _portPos(n.id, 'in');
                if (!p) return;
                const d = Math.hypot(pos.x - p.x, pos.y - p.y);
                if (d < minDist) { closest = n; minDist = d; }
            });
            if (closest) _addConnection(drawingConn.fromNodeId, closest.id);
            drawingConn = null;
            _renderConnections();
        }
        isPanning = false;
        $canvasWrap?.classList.remove('panning');
    }

    function _onWheel(e) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        zoom = Math.max(0.25, Math.min(4, zoom * delta));
        _applyTransform();
        _renderConnections();
    }

    function zoomReset() {
        zoom = 1; panX = 0; panY = 0;
        _applyTransform(); _renderConnections();
    }

    // ── Context Menu (right-click) ────────────────────────────
    function _onContextMenu(e) {
        e.preventDefault();
        _hideContextMenu();

        const menu  = document.getElementById('comp-context-menu');
        if (!menu) return;

        // Check if right-clicked on a node
        const nodeEl = e.target.closest('.flow-node');
        if (nodeEl) {
            const nodeId = nodeEl.id.replace('fn-', '');
            const node   = nodes.find(n => n.id === nodeId);
            if (!node) return;
            menu.innerHTML =
                '<div class="ctx-item ctx-danger" onclick="CompositionStudio.removeNode(\'' + nodeId + '\');CompositionStudio._hideContextMenu()">🗑 Remove Node</div>' +
                '<div class="ctx-item" onclick="CompositionStudio._showRightPanel_byId(\'' + nodeId + '\');CompositionStudio._hideContextMenu()">ℹ View Info</div>' +
                '<div class="ctx-item" onclick="navigateTo(\'musician\',{musicianId:\'' + esc(node.agentId) + '\'});CompositionStudio._hideContextMenu()">✏ Edit Musician</div>';
            _positionContextMenu(menu, e.clientX, e.clientY);
            return;
        }

        // Check if right-clicked near a connection (find nearest)
        const conn = _nearestConnection(e.clientX, e.clientY, 20);
        if (conn) {
            menu.innerHTML =
                '<div class="ctx-item ctx-danger" onclick="CompositionStudio.removeConnection(\'' + conn.from + '\',\'' + conn.to + '\');CompositionStudio._hideContextMenu()">🗑 Remove Connection</div>';
            _positionContextMenu(menu, e.clientX, e.clientY);
        }
    }

    // Find the connection whose bezier curve passes closest to the screen point (screenX, screenY).
    function _nearestConnection(screenX, screenY, threshPx) {
        let best = null, bestD = threshPx;
        const wr = $canvasWrap?.getBoundingClientRect();
        if (!wr) return null;

        connections.forEach(conn => {
            const fromNode = nodes.find(n => n.id === conn.from);
            const toNode   = nodes.find(n => n.id === conn.to);
            if (!fromNode || !toNode) return;

            const p1 = _portPos(fromNode.id, 'out');
            const p2 = _portPos(toNode.id,   'in');
            if (!p1 || !p2) return;

            // Convert to screen coords for comparison
            const toScreen = (cx, cy) => ({
                x: wr.left + panX + cx * zoom,
                y: wr.top  + panY + cy * zoom,
            });

            const cpx = (p1.x + p2.x) / 2;
            // Sample 16 points along the cubic bezier
            for (let i = 0; i <= 16; i++) {
                const t  = i / 16;
                const t2 = 1 - t;
                // Cubic bezier: P0, CP1=(cpx,p1.y), CP2=(cpx,p2.y), P3
                const bx = t2*t2*t2*p1.x + 3*t2*t2*t*cpx + 3*t2*t*t*cpx + t*t*t*p2.x;
                const by = t2*t2*t2*p1.y + 3*t2*t2*t*p1.y + 3*t2*t*t*p2.y + t*t*t*p2.y;
                const sp = toScreen(bx, by);
                const d  = Math.hypot(screenX - sp.x, screenY - sp.y);
                if (d < bestD) { bestD = d; best = conn; }
            }
        });
        return best;
    }

    function _positionContextMenu(menu, x, y) {
        menu.style.left = x + 'px';
        menu.style.top  = y + 'px';
        menu.classList.remove('hidden');
    }

    function _hideContextMenu() {
        document.getElementById('comp-context-menu')?.classList.add('hidden');
    }

    // ── Right Panel (agent info) ──────────────────────────────
    function _showRightPanel(node) {
        rightPanelNode = node;
        const panel = document.getElementById('comp-right-panel');
        const body  = document.getElementById('crp-body');
        if (!panel || !body) return;

        const agent = node.agent;
        const def   = getSectionDef(agent.category);
        const initials = (agent.emoji || agent.id || '?').substring(0, 2).toUpperCase();
        const modelLabel = { inherit: 'Inherit (system default)', haiku: 'Haiku — fast', sonnet: 'Sonnet — balanced', opus: 'Opus — powerful' };
        const orderLabel = { first: 'Intro (first)', parallel: 'Main Movement', last: 'Coda (last)' };

        body.innerHTML =
            '<div class="crp-emblem" style="background:' + hexAlpha(def.color, 0.2) + ';color:' + def.color + ';border-color:' + hexAlpha(def.color, 0.4) + '">' + esc(initials) + '</div>' +
            '<div class="crp-instrument">' + esc(def.instrument + ' · ' + def.name) + '</div>' +
            '<div class="crp-name">' + esc(agent.name) + '</div>' +
            (agent.description ? '<div class="crp-desc">' + esc(agent.description) + '</div>' : '') +
            '<div class="crp-divider"></div>' +
            '<div class="crp-row"><span class="crp-key">Model</span><span class="crp-val">' + esc(modelLabel[agent.model] || agent.model || 'inherit') + '</span></div>' +
            '<div class="crp-row"><span class="crp-key">When plays</span><span class="crp-val">' + esc(orderLabel[agent.run_order] || agent.run_order || 'parallel') + '</span></div>' +
            '<div class="crp-row"><span class="crp-key">Max bars</span><span class="crp-val">' + (agent.max_turns ? agent.max_turns : 'Unlimited') + '</span></div>' +
            '<div class="crp-row"><span class="crp-key">Solo mode</span><span class="crp-val">' + (agent.no_project_context ? 'On' : 'Off') + '</span></div>' +
            (agent.depends_on?.length ? '<div class="crp-row"><span class="crp-key">Cued by</span><span class="crp-val">' + esc(agent.depends_on.join(', ')) + '</span></div>' : '') +
            '<div class="crp-divider"></div>' +
            '<button class="btn-gold" style="width:100%;margin-top:4px" onclick="navigateTo(\'musician\',{musicianId:\'' + esc(agent.id) + '\'})">✏ Edit Musician</button>' +
            '<button class="btn-ghost btn-sm" style="width:100%;margin-top:6px;color:var(--c-security)" onclick="CompositionStudio.removeNode(\'' + node.id + '\')">Remove from Canvas</button>';

        panel.classList.add('open');

        // Mark node as selected (highlight)
        document.querySelectorAll('.flow-node').forEach(el => el.classList.remove('selected'));
        document.getElementById('fn-' + node.id)?.classList.add('selected');
    }

    function _showRightPanel_byId(nodeId) {
        const node = nodes.find(n => n.id === nodeId);
        if (node) _showRightPanel(node);
    }

    function hideRightPanel() {
        rightPanelNode = null;
        document.getElementById('comp-right-panel')?.classList.remove('open');
        document.querySelectorAll('.flow-node').forEach(el => el.classList.remove('selected'));
    }

    // ── Preload Squad ─────────────────────────────────────────
    // Called from orchestra view "View Flow" button.
    function preloadSquad(squadId) {
        const squad = State.squads.find(s => s.id === squadId);
        if (!squad) { _setStatus('Programme "' + squadId + '" not found'); return; }

        nodes = []; connections = []; nextId = 1;
        hideRightPanel();

        // squad.agents may be full objects or ID strings — normalise
        const rawAgents = squad.agents || [];
        const agentList = rawAgents.map(a => {
            const id  = typeof a === 'object' ? a.id : a;
            return State.agents.find(ag => ag.id === id) || { id, name: id, category: 'meta', emoji: '?' };
        });

        // Sort by run_order: first → parallel → last
        const orderRank = { first: 0, parallel: 1, last: 2 };
        agentList.sort((a, b) => (orderRank[a.run_order] ?? 1) - (orderRank[b.run_order] ?? 1));

        const SPACING = 220, START_X = 80, START_Y = 180;
        agentList.forEach((agent, i) => {
            nodes.push({ id: 'n' + (nextId++), agentId: agent.id, x: START_X + i * SPACING, y: START_Y, agent });
        });

        // Connect sequentially
        for (let i = 0; i < nodes.length - 1; i++) {
            connections.push({ from: nodes[i].id, to: nodes[i + 1].id });
        }

        _renderNodes();
        _renderConnections();
        _setStatus('"' + squadId + '" — ' + nodes.length + ' musicians loaded');
    }

    // ── Actions ───────────────────────────────────────────────
    function clearCanvas() {
        nodes = []; connections = []; nextId = 1;
        hideRightPanel();
        _renderNodes(); _renderConnections();
        _setStatus('Canvas cleared');
    }

    async function saveAsWorkflow() {
        if (!nodes.length) { toast('Add musicians to the canvas first', 'error'); return; }
        const id = prompt('Symphony ID (workflow ID, lowercase_underscores):');
        if (!id || !/^[a-z0-9_]+$/.test(id)) { toast('Invalid ID', 'error'); return; }
        const ordered = [...nodes].sort((a, b) => a.x - b.x);
        const steps   = ordered.map(n => ({ squad: n.agentId, on_failure: 'stop' }));
        try {
            await apiFetch('/workflows', { method: 'POST', body: JSON.stringify({ id, name: id, steps }) });
            toast('Symphony "' + id + '" saved', 'success');
        } catch(e) { toast(e.message, 'error'); }
    }

    async function aiBuild() {
        const input = document.getElementById('comp-ai-input');
        if (!input?.value.trim()) return;
        const prompt = input.value.trim();
        _setStatus('🎵 Composing…');
        try {
            const resp   = await apiFetch('/ai/build-flow', { method: 'POST', body: JSON.stringify({ prompt }) });
            nodes = []; connections = []; nextId = 1; hideRightPanel();
            (resp.agents || []).forEach((ag, i) => {
                const agentObj = State.agents.find(a => a.id === ag.id) || { ...ag, category: ag.category || 'meta' };
                nodes.push({ id: 'n' + (nextId++), agentId: ag.id, x: 80 + i * 220, y: 180, agent: agentObj });
            });
            for (let i = 0; i < nodes.length - 1; i++) connections.push({ from: nodes[i].id, to: nodes[i+1].id });
            _renderNodes(); _renderConnections();
            input.value = '';
            _setStatus('Composition ready — ' + nodes.length + ' musicians placed');
            toast('AI composition complete!', 'success');
        } catch(e) { _setStatus('Composition failed'); toast('AI build failed: ' + e.message, 'error'); }
    }

    function _setStatus(msg) {
        const el = document.getElementById('comp-status');
        if (el) el.textContent = msg;
    }

    // ── Helpers ───────────────────────────────────────────────
    function hexAlpha(hex, alpha) {
        const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
        return `rgba(${r},${g},${b},${alpha})`;
    }

    return {
        render, addAgentNode, removeNode, removeConnection,
        clearCanvas, zoomReset, saveAsWorkflow, aiBuild, preloadSquad,
        hideRightPanel, _showRightPanel_byId, _hideContextMenu,
    };
})();
