/**
 * OPAI Agent Studio — Agent Flow: visual node editor for workflow pipelines.
 * SVG + DOM approach: DOM nodes for interactivity, SVG overlay for bezier connections.
 * Phase 2: AI assistant, prompt input, inline creation, cron builder, following triggers.
 */

const FlowEditor = (() => {
    // ── State ────────────────────────────────────────
    let nodes = [];
    let connections = [];
    let selectedNode = null;
    let zoom = 1;
    let panX = 0, panY = 0;
    let isPanning = false;
    let panStart = { x: 0, y: 0 };
    let dragNode = null;
    let dragOffset = { x: 0, y: 0 };
    let drawingConn = null; // { fromNode, fromPort, path }
    let nextId = 1;
    let loadedWorkflowId = null;
    let _flowWorkflows = []; // Cached workflow list for following node selector
    let _inlineCreateMode = false;
    let nodeNotices = {}; // { nodeId: [{ id, text }] } — dismissible notices per node

    // DOM refs
    let $palette, $canvasWrap, $svg, $nodesLayer, $props, $statusInfo, $zoomLevel;
    let $wfSelect, $wfId, $wfDesc;

    // ── Init ─────────────────────────────────────────

    function init() {
        $palette = document.getElementById('flow-palette');
        $canvasWrap = document.getElementById('flow-canvas-wrap');
        $svg = document.getElementById('flow-svg');
        $nodesLayer = document.getElementById('flow-nodes');
        $props = document.getElementById('flow-properties');
        $statusInfo = document.getElementById('flow-status-info');
        $zoomLevel = document.getElementById('flow-zoom-level');
        $wfSelect = document.getElementById('flow-workflow-select');
        $wfId = document.getElementById('flow-wf-id');
        $wfDesc = document.getElementById('flow-wf-desc');

        // Canvas events
        $canvasWrap.addEventListener('mousedown', onCanvasMouseDown);
        $canvasWrap.addEventListener('wheel', onCanvasWheel, { passive: false });
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
        window.addEventListener('keydown', onKeyDown);

        // Workflow selector
        $wfSelect.addEventListener('change', () => {
            const id = $wfSelect.value;
            if (id) loadWorkflow(id);
            else clearState();
        });

        // AI bar — Enter key
        const aiInput = document.getElementById('flow-ai-input');
        if (aiInput) {
            aiInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') aiBuild();
            });
        }
    }

    // ── Render (called when switching to flow view) ──

    function render() {
        _renderPalette();
        _renderWorkflowSelector();
        _fetchWorkflowList();
        _updateStatus();
    }

    function _renderPalette() {
        if (_inlineCreateMode) return; // Don't clobber inline wizard
        let html = '';

        // Trigger section
        html += '<div class="flow-palette-section"><h4>Triggers</h4>';
        html += _paletteItem('trigger', 'manual', 'Manual', 'fpi-trigger', '&#9654;');
        html += _paletteItem('trigger', 'schedule', 'Schedule', 'fpi-trigger', '&#9200;');
        html += _paletteItem('following', 'following', 'Following', 'fpi-following', '&#8635;');
        html += '</div>';

        // Squads
        html += '<div class="flow-palette-section"><h4>Squads</h4>';
        State.squads.forEach(s => {
            html += _paletteItem('squad', s.id, s.id, 'fpi-squad', s.agents.length + 'a');
        });
        if (!State.squads.length) html += '<span class="text-muted" style="font-size:0.7rem;">No squads</span>';
        html += '</div>';

        // Agents
        html += '<div class="flow-palette-section"><h4>Agents</h4>';
        State.agents.forEach(a => {
            html += _paletteItem('agent', a.id, a.name || a.id, 'fpi-agent', a.emoji || '?');
        });
        if (!State.agents.length) html += '<span class="text-muted" style="font-size:0.7rem;">No agents</span>';
        html += '</div>';

        // Inline create button
        html += '<div class="flow-palette-section">';
        html += '<button class="btn btn-sm" onclick="FlowEditor.showInlineCreate()" style="width:100%;">+ Create Agent</button>';
        html += '</div>';

        $palette.innerHTML = html;

        // Bind drag start on palette items
        $palette.querySelectorAll('.flow-palette-item').forEach(el => {
            el.addEventListener('mousedown', onPaletteDragStart);
        });
    }

    function _paletteItem(type, value, label, iconClass, iconText) {
        return '<div class="flow-palette-item" data-type="' + type + '" data-value="' + esc(value) + '">' +
            '<span class="fpi-icon ' + iconClass + '">' + iconText + '</span>' +
            '<span class="fpi-label">' + esc(label) + '</span></div>';
    }

    async function _renderWorkflowSelector() {
        try {
            const data = await apiFetch('/workflows');
            const wfs = data.workflows || [];
            let opts = '<option value="">New workflow...</option>';
            wfs.forEach(w => {
                opts += '<option value="' + esc(w.id) + '">' + esc(w.id) + '</option>';
            });
            $wfSelect.innerHTML = opts;
            if (loadedWorkflowId) $wfSelect.value = loadedWorkflowId;
        } catch (e) { /* ignore */ }
    }

    async function _fetchWorkflowList() {
        try {
            const data = await apiFetch('/workflows');
            _flowWorkflows = data.workflows || [];
        } catch (e) { _flowWorkflows = []; }
    }

    // ── Inline Agent Creation ────────────────────────

    function showInlineCreate() {
        _inlineCreateMode = true;
        const catOpts = (typeof config !== 'undefined' && config.AGENT_CATEGORIES || [
            'quality', 'planning', 'research', 'operations',
            'leadership', 'content', 'execution', 'meta', 'orchestration'
        ]).map(c => '<option value="' + c + '">' + c + '</option>').join('');

        $palette.innerHTML = '<div class="flow-inline-wizard">' +
            '<h4 style="font-size:0.75rem;font-weight:600;margin-bottom:0.25rem;">Quick Create Agent</h4>' +
            '<input type="text" id="fiw-id" placeholder="agent_id (lowercase)">' +
            '<input type="text" id="fiw-name" placeholder="Display Name">' +
            '<select id="fiw-category">' + catOpts + '</select>' +
            '<textarea id="fiw-prompt" placeholder="Agent prompt..."></textarea>' +
            '<div class="fiw-actions">' +
            '<button class="btn btn-sm" onclick="FlowEditor.cancelInlineCreate()">Cancel</button>' +
            '<button class="btn btn-sm btn-primary" onclick="FlowEditor.submitInlineCreate()">Create</button>' +
            '</div></div>';
    }

    async function submitInlineCreate() {
        const id = document.getElementById('fiw-id').value.trim();
        const name = document.getElementById('fiw-name').value.trim();
        const category = document.getElementById('fiw-category').value;
        const prompt = document.getElementById('fiw-prompt').value.trim();

        if (!id) { toast('Enter an agent ID', 'error'); return; }
        if (!/^[a-z0-9_]+$/.test(id)) { toast('ID must be lowercase letters, numbers, underscores', 'error'); return; }

        try {
            await apiFetch('/agents', {
                method: 'POST',
                body: JSON.stringify({ id, name: name || id, category, prompt_content: prompt, emoji: '', description: '' }),
            });

            // Refresh agents list
            const data = await apiFetch('/agents');
            State.agents = data.agents || [];

            _inlineCreateMode = false;
            _renderPalette();

            // Auto-add to canvas center
            const rect = $canvasWrap.getBoundingClientRect();
            const cx = (rect.width / 2 - panX) / zoom;
            const cy = (rect.height / 2 - panY) / zoom;
            addNode('agent', id, cx, cy);

            toast('Agent "' + id + '" created', 'success');
        } catch (e) {
            toast(e.message, 'error');
        }
    }

    function cancelInlineCreate() {
        _inlineCreateMode = false;
        _renderPalette();
    }

    // ── AI Assistant ─────────────────────────────────

    async function aiBuild() {
        const input = document.getElementById('flow-ai-input');
        const status = document.getElementById('flow-ai-status');
        if (!input) return;
        const prompt = input.value.trim();
        if (!prompt) { toast('Enter a workflow description', 'error'); return; }

        status.textContent = 'Building...';
        status.className = 'flow-ai-status loading';

        try {
            const result = await apiFetch('/flow/ai-build', {
                method: 'POST',
                body: JSON.stringify({ prompt }),
            });

            clearState();
            input.value = '';

            // Render returned nodes
            if (result.nodes) {
                result.nodes.forEach(n => {
                    nodes.push({ id: n.id, type: n.type, x: n.x, y: n.y, config: n.config || {} });
                    const idNum = parseInt(n.id.replace(/\D/g, ''), 10);
                    if (idNum >= nextId) nextId = idNum + 1;
                });
                nodes.forEach(n => _renderNode(n));
            }
            if (result.connections) {
                result.connections.forEach(c => {
                    connections.push(c);
                    const idNum = parseInt(c.id.replace(/\D/g, ''), 10);
                    if (idNum >= nextId) nextId = idNum + 1;
                });
                requestAnimationFrame(() => {
                    connections.forEach(c => _renderConnection(c));
                });
            }

            // Generate notices for each node about what needs completing
            nodes.forEach(n => {
                const notices = _generateNoticesForNode(n);
                if (notices.length) {
                    nodeNotices[n.id] = notices;
                    refreshNode(n.id);
                }
            });

            _updateStatus();
            status.textContent = 'Done';
            status.className = 'flow-ai-status';
            setTimeout(() => { status.textContent = ''; }, 2000);
            toast('Flow generated from AI — review notices on each node', 'success');
        } catch (e) {
            status.textContent = 'Failed';
            status.className = 'flow-ai-status';
            toast('AI build failed: ' + e.message, 'error');
        }
    }

    // ── Palette drag → canvas drop ───────────────────

    let paletteDrag = null;
    let paletteGhost = null;

    function onPaletteDragStart(e) {
        e.preventDefault();
        const item = e.currentTarget;
        paletteDrag = {
            type: item.dataset.type,
            value: item.dataset.value,
        };
        // Create ghost element
        paletteGhost = item.cloneNode(true);
        paletteGhost.style.cssText = 'position:fixed;pointer-events:none;opacity:0.7;z-index:999;width:' + item.offsetWidth + 'px;';
        document.body.appendChild(paletteGhost);
        _movePaletteGhost(e);
    }

    function _movePaletteGhost(e) {
        if (paletteGhost) {
            paletteGhost.style.left = (e.clientX - 40) + 'px';
            paletteGhost.style.top = (e.clientY - 14) + 'px';
        }
    }

    function _finishPaletteDrop(e) {
        if (!paletteDrag) return;
        if (paletteGhost) { paletteGhost.remove(); paletteGhost = null; }

        // Check if dropped on canvas
        const rect = $canvasWrap.getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
            const x = (e.clientX - rect.left - panX) / zoom;
            const y = (e.clientY - rect.top - panY) / zoom;
            addNode(paletteDrag.type, paletteDrag.value, x, y);
        }
        paletteDrag = null;
    }

    // ── Node CRUD ────────────────────────────────────

    function addNode(type, value, x, y) {
        const id = 'n' + (nextId++);
        const cfg = {};

        if (type === 'trigger') {
            cfg.trigger_type = value; // manual or schedule
        } else if (type === 'squad') {
            cfg.squad = value;
            cfg.on_fail = 'stop';
        } else if (type === 'agent') {
            cfg.agent = value;
            cfg.on_fail = 'stop';
        } else if (type === 'following') {
            cfg.follows = '';
            cfg.follows_type = 'squad';
            cfg.trigger_on = 'success';
        }

        const node = { id, type, x: Math.round(x), y: Math.round(y), config: cfg };
        nodes.push(node);
        _renderNode(node);
        selectNode(id);
        _updateStatus();
        return node;
    }

    function _renderNode(node) {
        const el = document.createElement('div');
        el.className = 'flow-node';
        el.id = 'fn-' + node.id;
        el.dataset.type = node.type;
        el.dataset.nodeId = node.id;
        _positionNode(el, node);
        el.innerHTML = _nodeHTML(node);

        // Ports — trigger and following have no 'in' port
        const noInPort = (node.type === 'trigger' || node.type === 'following');
        if (!noInPort) {
            const portIn = document.createElement('div');
            portIn.className = 'flow-port flow-port-in';
            portIn.dataset.nodeId = node.id;
            portIn.dataset.port = 'in';
            el.appendChild(portIn);
        }

        const portOut = document.createElement('div');
        portOut.className = 'flow-port flow-port-out';
        portOut.dataset.nodeId = node.id;
        portOut.dataset.port = 'out';
        el.appendChild(portOut);

        if (!noInPort) {
            const portFail = document.createElement('div');
            portFail.className = 'flow-port flow-port-fail';
            portFail.dataset.nodeId = node.id;
            portFail.dataset.port = 'fail';
            el.appendChild(portFail);
        }

        // Event listeners
        el.addEventListener('mousedown', onNodeMouseDown);
        el.querySelectorAll('.flow-port').forEach(p => {
            p.addEventListener('mousedown', onPortMouseDown);
        });

        $nodesLayer.appendChild(el);
    }

    function _nodeHTML(node) {
        const type = node.type;
        let iconClass, iconText, title, body = '';

        if (type === 'trigger') {
            iconClass = 'fn-icon-trigger';
            iconText = node.config.trigger_type === 'schedule' ? '&#9200;' : '&#9654;';
            title = node.config.trigger_type === 'schedule' ? 'Schedule Trigger' : 'Manual Trigger';
            body = '<div class="fn-config-line">' + (node.config.trigger_type || 'manual') + '</div>';
            if (node.config.trigger_type === 'schedule' && node.config.cron) {
                body += '<div class="fn-config-line" style="color:var(--accent);">' + esc(node.config.cron) + '</div>';
            }
        } else if (type === 'squad') {
            iconClass = 'fn-icon-squad';
            const squad = State.squads.find(s => s.id === node.config.squad);
            iconText = squad ? squad.agents.length : '?';
            title = node.config.squad || 'Select Squad';
            if (squad) {
                const chips = squad.agents.slice(0, 5).map(a =>
                    '<span class="fn-agent-chip">' + esc(a.emoji || '?') + ' ' + esc(a.name || a.id) + '</span>'
                ).join('');
                const more = squad.agents.length > 5 ? '<span class="fn-agent-chip">+' + (squad.agents.length - 5) + '</span>' : '';
                body = '<div class="fn-agent-chips">' + chips + more + '</div>';
            }
            if (node.config.on_fail && node.config.on_fail !== 'stop') {
                body += '<div class="fn-config-line">on fail: ' + esc(node.config.on_fail) + '</div>';
            }
            if (node.config.custom_prompt) {
                body += '<div class="fn-config-line" style="color:var(--accent);">custom prompt</div>';
            }
        } else if (type === 'agent') {
            iconClass = 'fn-icon-agent';
            const agent = State.agents.find(a => a.id === node.config.agent);
            iconText = agent ? (agent.emoji || '?') : '?';
            title = agent ? (agent.name || agent.id) : (node.config.agent || 'Select Agent');
            if (agent) {
                body = '<div class="fn-config-line">' + esc(agent.category) + '</div>';
            }
            if (node.config.custom_prompt) {
                body += '<div class="fn-config-line" style="color:var(--accent);">custom prompt</div>';
            }
        } else if (type === 'following') {
            iconClass = 'fn-icon-following';
            iconText = '&#8635;';
            title = node.config.follows ? ('After: ' + node.config.follows) : 'Following Trigger';
            body = '<div class="fn-config-line">' + (node.config.follows_type || 'squad') + '</div>';
            if (node.config.trigger_on && node.config.trigger_on !== 'any') {
                body += '<div class="fn-config-line">on ' + esc(node.config.trigger_on) + '</div>';
            }
        }

        // Build notices HTML if any exist for this node
        let noticesHtml = '';
        const notices = nodeNotices[node.id];
        if (notices && notices.length) {
            noticesHtml = '<div class="fn-notices">';
            notices.forEach(n => {
                noticesHtml += '<div class="fn-notice">' +
                    '<span class="fn-notice-text">' + esc(n.text) + '</span>' +
                    '<button class="fn-notice-close" onclick="event.stopPropagation(); FlowEditor.dismissNotice(\'' + node.id + '\', \'' + n.id + '\')" title="Dismiss">&times;</button>' +
                    '</div>';
            });
            noticesHtml += '</div>';
        }

        return '<div class="flow-node-header">' +
            '<span class="fn-icon ' + iconClass + '">' + iconText + '</span>' +
            '<span class="fn-title">' + esc(title) + '</span>' +
            '<button class="fn-delete" data-node-id="' + node.id + '" onclick="FlowEditor.deleteNode(\'' + node.id + '\')" title="Delete">&times;</button>' +
            '</div>' +
            '<div class="flow-node-body">' + body + '</div>' +
            noticesHtml;
    }

    function _positionNode(el, node) {
        el.style.left = node.x + 'px';
        el.style.top = node.y + 'px';
    }

    function refreshNode(nodeId) {
        const node = nodes.find(n => n.id === nodeId);
        const el = document.getElementById('fn-' + nodeId);
        if (!node || !el) return;

        // Re-render inner content while preserving ports
        const ports = el.querySelectorAll('.flow-port');
        // Remove old header/body
        const header = el.querySelector('.flow-node-header');
        const body = el.querySelector('.flow-node-body');
        if (header) header.remove();
        if (body) body.remove();
        // Insert new content before ports
        const temp = document.createElement('div');
        temp.innerHTML = _nodeHTML(node);
        while (temp.firstChild) {
            el.insertBefore(temp.firstChild, ports[0] || null);
        }
    }

    function deleteNode(nodeId) {
        // Remove connections to/from this node
        connections = connections.filter(c => {
            if (c.from === nodeId || c.to === nodeId) {
                const pathEl = document.getElementById('fc-' + c.id);
                if (pathEl) pathEl.remove();
                return false;
            }
            return true;
        });

        // Remove node and its notices
        nodes = nodes.filter(n => n.id !== nodeId);
        delete nodeNotices[nodeId];
        const el = document.getElementById('fn-' + nodeId);
        if (el) el.remove();

        if (selectedNode === nodeId) {
            selectedNode = null;
            _renderProperties(null);
        }
        _updateStatus();
    }

    function selectNode(nodeId) {
        // Deselect previous
        document.querySelectorAll('.flow-node.selected').forEach(n => n.classList.remove('selected'));
        selectedNode = nodeId;
        const el = document.getElementById('fn-' + nodeId);
        if (el) el.classList.add('selected');
        _renderProperties(nodes.find(n => n.id === nodeId));
    }

    // ── Node Notices ─────────────────────────────────

    function dismissNotice(nodeId, noticeId) {
        if (!nodeNotices[nodeId]) return;
        nodeNotices[nodeId] = nodeNotices[nodeId].filter(n => n.id !== noticeId);
        if (!nodeNotices[nodeId].length) delete nodeNotices[nodeId];
        refreshNode(nodeId);
        // Re-render properties if this node is selected
        if (selectedNode === nodeId) {
            const node = nodes.find(n => n.id === nodeId);
            if (node) _renderProperties(node);
        }
    }

    function dismissAllNotices(nodeId) {
        delete nodeNotices[nodeId];
        refreshNode(nodeId);
        if (selectedNode === nodeId) {
            const node = nodes.find(n => n.id === nodeId);
            if (node) _renderProperties(node);
        }
    }

    function _generateNoticesForNode(node) {
        const notices = [];
        let nid = 0;

        if (node.type === 'agent') {
            if (!node.config.agent) {
                notices.push({ id: 'na' + (nid++), text: 'Select an agent' });
            }
            if (!node.config.custom_prompt) {
                notices.push({ id: 'na' + (nid++), text: 'Add a custom prompt' });
            }
            if (!node.config.on_fail || node.config.on_fail === 'stop') {
                notices.push({ id: 'na' + (nid++), text: 'Review failure handling' });
            }
        } else if (node.type === 'squad') {
            if (!node.config.squad) {
                notices.push({ id: 'ns' + (nid++), text: 'Select a squad' });
            }
            if (!node.config.custom_prompt) {
                notices.push({ id: 'ns' + (nid++), text: 'Add custom prompts for agents' });
            }
            if (!node.config.on_fail || node.config.on_fail === 'stop') {
                notices.push({ id: 'ns' + (nid++), text: 'Review failure handling' });
            }
        } else if (node.type === 'trigger') {
            if (node.config.trigger_type === 'schedule' && !node.config.cron) {
                notices.push({ id: 'nt' + (nid++), text: 'Set a cron schedule' });
            }
        } else if (node.type === 'following') {
            if (!node.config.follows) {
                notices.push({ id: 'nf' + (nid++), text: 'Select what to follow' });
            }
        }

        return notices;
    }

    // ── Properties Panel ─────────────────────────────

    function _renderProperties(node) {
        if (!node) {
            $props.innerHTML = '<div class="flow-prop-empty">Select a node to configure</div>';
            return;
        }

        let html = '<div class="flow-prop-header"><h3>' + esc(node.type) + ' node</h3></div>';
        html += '<div class="flow-prop-body">';

        if (node.type === 'trigger') {
            html += '<div class="form-group"><label>Trigger Type</label>' +
                '<select onchange="FlowEditor.updateConfig(\'' + node.id + '\', \'trigger_type\', this.value)">' +
                '<option value="manual"' + (node.config.trigger_type === 'manual' ? ' selected' : '') + '>Manual</option>' +
                '<option value="schedule"' + (node.config.trigger_type === 'schedule' ? ' selected' : '') + '>Schedule</option>' +
                '</select></div>';

            // Schedule trigger — cron builder
            if (node.config.trigger_type === 'schedule') {
                html += _cronBuilder(node);
            }
        } else if (node.type === 'squad') {
            const opts = State.squads.map(s =>
                '<option value="' + esc(s.id) + '"' + (node.config.squad === s.id ? ' selected' : '') + '>' + esc(s.id) + '</option>'
            ).join('');
            html += '<div class="form-group"><label>Squad</label>' +
                '<select onchange="FlowEditor.updateConfig(\'' + node.id + '\', \'squad\', this.value)">' +
                '<option value="">Select...</option>' + opts + '</select></div>';

            html += _failSelect(node);
            html += _promptInput(node);
        } else if (node.type === 'agent') {
            const opts = State.agents.map(a =>
                '<option value="' + esc(a.id) + '"' + (node.config.agent === a.id ? ' selected' : '') + '>' + esc(a.name || a.id) + '</option>'
            ).join('');
            html += '<div class="form-group"><label>Agent</label>' +
                '<select onchange="FlowEditor.updateConfig(\'' + node.id + '\', \'agent\', this.value)">' +
                '<option value="">Select...</option>' + opts + '</select></div>';

            html += _failSelect(node);
            html += _promptInput(node);
        } else if (node.type === 'following') {
            html += _followingProperties(node);
        }

        html += '<div class="form-group"><label>Position</label>' +
            '<span class="text-muted" style="font-size:0.7rem;">x: ' + Math.round(node.x) + ', y: ' + Math.round(node.y) + '</span></div>';

        // Render notices in properties panel
        const propNotices = nodeNotices[node.id];
        if (propNotices && propNotices.length) {
            html += '<div class="flow-prop-notices">';
            html += '<label style="font-size:0.7rem;color:var(--warning);font-weight:600;">Needs Attention</label>';
            propNotices.forEach(n => {
                html += '<div class="fn-prop-notice">' +
                    '<span>' + esc(n.text) + '</span>' +
                    '<button class="fn-notice-close" onclick="FlowEditor.dismissNotice(\'' + node.id + '\', \'' + n.id + '\')">&times;</button>' +
                    '</div>';
            });
            html += '<button class="btn btn-sm" style="width:100%;margin-top:0.3rem;font-size:0.65rem;" ' +
                'onclick="FlowEditor.dismissAllNotices(\'' + node.id + '\')">Dismiss All</button>';
            html += '</div>';
        }

        html += '</div>';
        $props.innerHTML = html;
    }

    function _failSelect(node) {
        return '<div class="form-group"><label>On Failure</label>' +
            '<select onchange="FlowEditor.updateConfig(\'' + node.id + '\', \'on_fail\', this.value)">' +
            '<option value="stop"' + (node.config.on_fail === 'stop' ? ' selected' : '') + '>Stop workflow</option>' +
            '<option value="continue"' + (node.config.on_fail === 'continue' ? ' selected' : '') + '>Continue</option>' +
            '</select></div>';
    }

    // ── Prompt Input (agent & squad nodes) ───────────

    function _promptInput(node) {
        let html = '<div class="form-group"><label>Custom Prompt</label>';

        if (node.type === 'agent') {
            html += '<textarea class="flow-prompt-input" ' +
                'onchange="FlowEditor.updateConfig(\'' + node.id + '\', \'custom_prompt\', this.value)" ' +
                'placeholder="Override or augment agent prompt...">' +
                esc(node.config.custom_prompt || '') + '</textarea>';
        } else if (node.type === 'squad') {
            // Squad: per-agent prompt map
            const squad = State.squads.find(s => s.id === node.config.squad);
            if (squad && squad.agents.length) {
                let prompts = {};
                try { prompts = JSON.parse(node.config.custom_prompt || '{}'); } catch (e) { prompts = {}; }
                html += '<div class="flow-squad-prompt">';
                squad.agents.forEach(a => {
                    const aid = a.id || a;
                    const aName = a.name || aid;
                    html += '<label>' + esc(aName) + '</label>' +
                        '<textarea class="flow-prompt-input" style="min-height:50px;margin-bottom:0.4rem;" ' +
                        'onchange="FlowEditor.updateSquadPrompt(\'' + node.id + '\', \'' + esc(aid) + '\', this.value)" ' +
                        'placeholder="Prompt for ' + esc(aName) + '...">' +
                        esc(prompts[aid] || '') + '</textarea>';
                });
                html += '</div>';
            } else {
                html += '<textarea class="flow-prompt-input" ' +
                    'onchange="FlowEditor.updateConfig(\'' + node.id + '\', \'custom_prompt\', this.value)" ' +
                    'placeholder="Select a squad first...">' +
                    esc(node.config.custom_prompt || '') + '</textarea>';
            }
        }

        html += '</div>';
        return html;
    }

    function updateSquadPrompt(nodeId, agentId, value) {
        const node = nodes.find(n => n.id === nodeId);
        if (!node) return;
        let prompts = {};
        try { prompts = JSON.parse(node.config.custom_prompt || '{}'); } catch (e) { prompts = {}; }
        if (value) {
            prompts[agentId] = value;
        } else {
            delete prompts[agentId];
        }
        node.config.custom_prompt = Object.keys(prompts).length ? JSON.stringify(prompts) : '';
        refreshNode(nodeId);
    }

    // ── Schedule Trigger — Cron Builder ──────────────

    function _cronBuilder(node) {
        const cron = node.config.cron || '0 9 * * *';
        const parts = cron.split(' ');
        const minute = parts[0] || '0';
        const hour = parts[1] || '9';
        const dow = parts[4] || '*';

        const presets = [
            { label: 'Daily 9am', cron: '0 9 * * *' },
            { label: 'Weekdays 9am', cron: '0 9 * * 1-5' },
            { label: 'Hourly', cron: '0 * * * *' },
            { label: 'Every 6h', cron: '0 */6 * * *' },
            { label: 'Mon 9am', cron: '0 9 * * 1' },
        ];

        let html = '<div class="form-group"><label>Schedule</label>';

        // Presets
        html += '<div class="flow-cron-presets">';
        presets.forEach(p => {
            const active = cron === p.cron ? ' active' : '';
            html += '<button class="flow-cron-preset' + active + '" onclick="FlowEditor.setCron(\'' + node.id + '\', \'' + p.cron + '\')">' + p.label + '</button>';
        });
        html += '</div>';

        // Time selectors
        html += '<div style="display:flex;gap:0.4rem;align-items:center;margin-bottom:0.4rem;">';
        html += '<select style="width:70px;font-size:0.75rem;" onchange="FlowEditor.setCronPart(\'' + node.id + '\', 1, this.value)">';
        for (let h = 0; h < 24; h++) {
            const hStr = String(h).padStart(2, '0');
            html += '<option value="' + h + '"' + (String(hour) === String(h) ? ' selected' : '') + '>' + hStr + ':00</option>';
        }
        html += '</select>';
        html += '<select style="width:60px;font-size:0.75rem;" onchange="FlowEditor.setCronPart(\'' + node.id + '\', 0, this.value)">';
        [0, 15, 30, 45].forEach(m => {
            const mStr = String(m).padStart(2, '0');
            html += '<option value="' + m + '"' + (String(minute) === String(m) ? ' selected' : '') + '>:' + mStr + '</option>';
        });
        html += '</select>';
        html += '</div>';

        // Day-of-week checkboxes
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        html += '<div class="flow-dow-checks">';
        days.forEach((d, i) => {
            const active = _isDowActive(dow, i) ? ' active' : '';
            html += '<div class="flow-dow' + active + '" onclick="FlowEditor.toggleDow(\'' + node.id + '\', ' + i + ')">' + d + '</div>';
        });
        html += '</div>';

        // Raw cron input
        html += '<input type="text" value="' + esc(cron) + '" style="font-family:monospace;font-size:0.75rem;" ' +
            'onchange="FlowEditor.setCron(\'' + node.id + '\', this.value)">';

        // Preview
        html += '<div class="flow-cron-preview">' + _describeCron(cron) + '</div>';

        html += '</div>';
        return html;
    }

    function setCron(nodeId, cron) {
        const node = nodes.find(n => n.id === nodeId);
        if (!node) return;
        node.config.cron = cron;
        refreshNode(nodeId);
        _renderProperties(node);
    }

    function setCronPart(nodeId, partIndex, value) {
        const node = nodes.find(n => n.id === nodeId);
        if (!node) return;
        const parts = (node.config.cron || '0 9 * * *').split(' ');
        while (parts.length < 5) parts.push('*');
        parts[partIndex] = value;
        node.config.cron = parts.join(' ');
        refreshNode(nodeId);
        _renderProperties(node);
    }

    function toggleDow(nodeId, dayIndex) {
        const node = nodes.find(n => n.id === nodeId);
        if (!node) return;
        const parts = (node.config.cron || '0 9 * * *').split(' ');
        while (parts.length < 5) parts.push('*');
        let dow = parts[4];

        // Parse active days
        let activeDays = new Set();
        if (dow === '*') {
            // All days active — clicking one means "only that day"
            activeDays.add(dayIndex);
        } else {
            // Parse comma-separated or range
            dow.split(',').forEach(part => {
                if (part.includes('-')) {
                    const [a, b] = part.split('-').map(Number);
                    for (let i = a; i <= b; i++) activeDays.add(i);
                } else {
                    activeDays.add(Number(part));
                }
            });

            if (activeDays.has(dayIndex)) {
                activeDays.delete(dayIndex);
            } else {
                activeDays.add(dayIndex);
            }
        }

        if (activeDays.size === 0 || activeDays.size === 7) {
            parts[4] = '*';
        } else {
            parts[4] = Array.from(activeDays).sort((a, b) => a - b).join(',');
        }

        node.config.cron = parts.join(' ');
        refreshNode(nodeId);
        _renderProperties(node);
    }

    function _isDowActive(dow, dayIndex) {
        if (dow === '*') return true;
        const activeDays = new Set();
        dow.split(',').forEach(part => {
            if (part.includes('-')) {
                const [a, b] = part.split('-').map(Number);
                for (let i = a; i <= b; i++) activeDays.add(i);
            } else {
                activeDays.add(Number(part));
            }
        });
        return activeDays.has(dayIndex);
    }

    function _describeCron(cron) {
        const parts = cron.split(' ');
        if (parts.length < 5) return cron;
        const [min, hour, dom, mon, dow] = parts;
        let time = '';

        if (hour === '*') {
            time = min === '0' ? 'every hour' : 'every hour at :' + String(min).padStart(2, '0');
        } else if (hour.startsWith('*/')) {
            time = 'every ' + hour.slice(2) + ' hours';
        } else {
            time = 'at ' + String(hour).padStart(2, '0') + ':' + String(min).padStart(2, '0');
        }

        let days = '';
        if (dow === '*') {
            days = 'every day';
        } else if (dow === '1-5') {
            days = 'weekdays';
        } else if (dow === '0,6') {
            days = 'weekends';
        } else {
            const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            const dayList = [];
            dow.split(',').forEach(part => {
                if (part.includes('-')) {
                    const [a, b] = part.split('-').map(Number);
                    for (let i = a; i <= b; i++) dayList.push(dayNames[i] || i);
                } else {
                    dayList.push(dayNames[Number(part)] || part);
                }
            });
            days = dayList.join(', ');
        }

        return time + ', ' + days;
    }

    // ── Following Trigger Properties ─────────────────

    function _followingProperties(node) {
        // Build optgroups for workflows and squads
        let wfOpts = '<optgroup label="Workflows">';
        _flowWorkflows.forEach(w => {
            wfOpts += '<option value="workflow:' + esc(w.id) + '"' +
                (node.config.follows === w.id && node.config.follows_type === 'workflow' ? ' selected' : '') +
                '>' + esc(w.id) + '</option>';
        });
        wfOpts += '</optgroup>';

        let sqOpts = '<optgroup label="Squads">';
        State.squads.forEach(s => {
            sqOpts += '<option value="squad:' + esc(s.id) + '"' +
                (node.config.follows === s.id && node.config.follows_type === 'squad' ? ' selected' : '') +
                '>' + esc(s.id) + '</option>';
        });
        sqOpts += '</optgroup>';

        let html = '<div class="form-group"><label>Follows</label>' +
            '<select onchange="FlowEditor.updateFollowing(\'' + node.id + '\', this.value)">' +
            '<option value="">Select...</option>' + wfOpts + sqOpts + '</select></div>';

        html += '<div class="form-group"><label>Trigger On</label>' +
            '<select onchange="FlowEditor.updateConfig(\'' + node.id + '\', \'trigger_on\', this.value)">' +
            '<option value="success"' + (node.config.trigger_on === 'success' ? ' selected' : '') + '>Success</option>' +
            '<option value="failure"' + (node.config.trigger_on === 'failure' ? ' selected' : '') + '>Failure</option>' +
            '<option value="any"' + (node.config.trigger_on === 'any' ? ' selected' : '') + '>Any</option>' +
            '</select></div>';

        return html;
    }

    function updateFollowing(nodeId, value) {
        const node = nodes.find(n => n.id === nodeId);
        if (!node) return;
        if (value.includes(':')) {
            const [type, name] = value.split(':');
            node.config.follows_type = type;
            node.config.follows = name;
        } else {
            node.config.follows = '';
            node.config.follows_type = 'squad';
        }
        refreshNode(nodeId);
    }

    function updateConfig(nodeId, key, value) {
        const node = nodes.find(n => n.id === nodeId);
        if (!node) return;
        node.config[key] = value;
        refreshNode(nodeId);
        // Re-render properties if trigger type changed (to show/hide cron builder)
        if (key === 'trigger_type' && selectedNode === nodeId) {
            _renderProperties(node);
        }
    }

    // ── Connections ──────────────────────────────────

    function onPortMouseDown(e) {
        e.stopPropagation();
        e.preventDefault();
        const port = e.currentTarget;
        const nodeId = port.dataset.nodeId;
        const portType = port.dataset.port;

        // Only start drawing from output or fail ports
        if (portType === 'in') return;

        const pos = getPortPosition(nodeId, portType);
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.classList.add('flow-connection-drawing');
        $svg.appendChild(path);

        drawingConn = { fromNode: nodeId, fromPort: portType, path, startX: pos.x, startY: pos.y };
    }

    function _updateDrawingConnection(e) {
        if (!drawingConn) return;
        const rect = $canvasWrap.getBoundingClientRect();
        const mx = (e.clientX - rect.left - panX) / zoom;
        const my = (e.clientY - rect.top - panY) / zoom;
        drawingConn.path.setAttribute('d', bezierPath(drawingConn.startX, drawingConn.startY, mx, my));
    }

    function _finishConnection(e) {
        if (!drawingConn) return;
        drawingConn.path.remove();

        // Find port under cursor
        const target = document.elementFromPoint(e.clientX, e.clientY);
        if (target && target.classList.contains('flow-port') && target.dataset.port === 'in') {
            const toNode = target.dataset.nodeId;
            if (toNode !== drawingConn.fromNode) {
                // Check for duplicate
                const exists = connections.some(c =>
                    c.from === drawingConn.fromNode && c.fromPort === drawingConn.fromPort && c.to === toNode
                );
                if (!exists) {
                    const conn = {
                        id: 'c' + (nextId++),
                        from: drawingConn.fromNode,
                        fromPort: drawingConn.fromPort,
                        to: toNode,
                        toPort: 'in',
                    };
                    connections.push(conn);
                    _renderConnection(conn);
                    _updateStatus();
                }
            }
        }
        drawingConn = null;
    }

    function _renderConnection(conn) {
        const from = getPortPosition(conn.from, conn.fromPort);
        const to = getPortPosition(conn.to, conn.toPort);
        if (!from || !to) return;

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.id = 'fc-' + conn.id;
        path.classList.add(conn.fromPort === 'fail' ? 'flow-connection-fail' : 'flow-connection');
        path.setAttribute('d', bezierPath(from.x, from.y, to.x, to.y));
        path.addEventListener('dblclick', () => {
            connections = connections.filter(c => c.id !== conn.id);
            path.remove();
            _updateStatus();
        });
        $svg.appendChild(path);
    }

    function updateAllConnections() {
        connections.forEach(conn => {
            const pathEl = document.getElementById('fc-' + conn.id);
            if (!pathEl) return;
            const from = getPortPosition(conn.from, conn.fromPort);
            const to = getPortPosition(conn.to, conn.toPort);
            if (from && to) {
                pathEl.setAttribute('d', bezierPath(from.x, from.y, to.x, to.y));
            }
        });
    }

    function getPortPosition(nodeId, portType) {
        const node = nodes.find(n => n.id === nodeId);
        const el = document.getElementById('fn-' + nodeId);
        if (!node || !el) return null;

        const w = el.offsetWidth;
        const h = el.offsetHeight;

        if (portType === 'in') return { x: node.x + w / 2, y: node.y };
        if (portType === 'out') return { x: node.x + w / 2, y: node.y + h };
        if (portType === 'fail') return { x: node.x + w, y: node.y + h / 2 };
        return null;
    }

    function bezierPath(x1, y1, x2, y2) {
        const dy = Math.abs(y2 - y1);
        const cp = Math.max(50, dy * 0.4);
        return 'M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + (y1 + cp) + ', ' + x2 + ' ' + (y2 - cp) + ', ' + x2 + ' ' + y2;
    }

    // ── Canvas Pan / Zoom ────────────────────────────

    function onCanvasMouseDown(e) {
        // Middle click or space+click for panning
        if (e.button === 1 || (e.button === 0 && (e.target === $canvasWrap || e.target.classList.contains('flow-nodes')))) {
            isPanning = true;
            panStart = { x: e.clientX - panX, y: e.clientY - panY };
            $canvasWrap.classList.add('panning');
            e.preventDefault();
        }
    }

    function onCanvasWheel(e) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.05 : 0.05;
        const newZoom = Math.min(2, Math.max(0.3, zoom + delta));
        // Zoom toward cursor position
        const rect = $canvasWrap.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const ratio = newZoom / zoom;
        panX = mx - ratio * (mx - panX);
        panY = my - ratio * (my - panY);
        zoom = newZoom;
        _applyTransform();
    }

    function _applyTransform() {
        $nodesLayer.style.transform = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + zoom + ')';
        $svg.style.transform = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + zoom + ')';
        $zoomLevel.textContent = Math.round(zoom * 100) + '%';
    }

    function zoomIn() { zoom = Math.min(2, zoom + 0.1); _applyTransform(); }
    function zoomOut() { zoom = Math.max(0.3, zoom - 0.1); _applyTransform(); }
    function zoomReset() { zoom = 1; panX = 0; panY = 0; _applyTransform(); }

    // ── Node Drag ────────────────────────────────────

    function onNodeMouseDown(e) {
        // Ignore if clicking delete button or port
        if (e.target.classList.contains('fn-delete') || e.target.classList.contains('flow-port')) return;

        const nodeEl = e.currentTarget;
        const nodeId = nodeEl.dataset.nodeId;
        const node = nodes.find(n => n.id === nodeId);
        if (!node) return;

        e.stopPropagation();
        e.preventDefault();
        selectNode(nodeId);

        dragNode = nodeId;
        const rect = $canvasWrap.getBoundingClientRect();
        dragOffset = {
            x: (e.clientX - rect.left - panX) / zoom - node.x,
            y: (e.clientY - rect.top - panY) / zoom - node.y,
        };
        nodeEl.classList.add('dragging');
    }

    // ── Global Mouse Handlers ────────────────────────

    function onMouseMove(e) {
        // Palette drag
        if (paletteDrag) {
            _movePaletteGhost(e);
            return;
        }

        // Canvas pan
        if (isPanning) {
            panX = e.clientX - panStart.x;
            panY = e.clientY - panStart.y;
            _applyTransform();
            return;
        }

        // Node drag
        if (dragNode) {
            const node = nodes.find(n => n.id === dragNode);
            const el = document.getElementById('fn-' + dragNode);
            if (!node || !el) return;
            const rect = $canvasWrap.getBoundingClientRect();
            node.x = (e.clientX - rect.left - panX) / zoom - dragOffset.x;
            node.y = (e.clientY - rect.top - panY) / zoom - dragOffset.y;
            _positionNode(el, node);
            updateAllConnections();
            return;
        }

        // Connection drawing
        if (drawingConn) {
            _updateDrawingConnection(e);
        }
    }

    function onMouseUp(e) {
        if (paletteDrag) { _finishPaletteDrop(e); return; }
        if (isPanning) { isPanning = false; $canvasWrap.classList.remove('panning'); return; }
        if (dragNode) {
            const el = document.getElementById('fn-' + dragNode);
            if (el) el.classList.remove('dragging');
            // Update properties with new position
            const node = nodes.find(n => n.id === dragNode);
            if (node && selectedNode === dragNode) _renderProperties(node);
            dragNode = null;
            return;
        }
        if (drawingConn) { _finishConnection(e); return; }
    }

    function onKeyDown(e) {
        if (currentView !== 'flow') return;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

        if ((e.key === 'Delete' || e.key === 'Backspace') && selectedNode) {
            deleteNode(selectedNode);
        }
    }

    // ── Save / Load ──────────────────────────────────

    async function save() {
        const wfId = $wfId.value.trim();
        const desc = $wfDesc.value.trim();
        if (!wfId) { toast('Enter a workflow ID', 'error'); return; }
        if (!/^[a-z0-9_]+$/.test(wfId)) { toast('ID must be lowercase letters, numbers, underscores', 'error'); return; }

        const extracted = flowToSteps();
        const steps = extracted.steps;
        const triggers = extracted.triggers;

        if (!steps.length && !triggers.following.length) {
            toast('Add at least one squad/agent node connected to a trigger', 'error');
            return;
        }

        const flow = {
            nodes: nodes.map(n => ({ id: n.id, type: n.type, x: Math.round(n.x), y: Math.round(n.y), config: n.config })),
            connections: connections.map(c => ({ id: c.id, from: c.from, fromPort: c.fromPort, to: c.to, toPort: c.toPort })),
            zoom, panX: Math.round(panX), panY: Math.round(panY),
        };

        // Build payload with triggers (omit empty ones)
        const triggersPayload = {};
        if (triggers.cron) triggersPayload.cron = triggers.cron;
        if (triggers.following.length) triggersPayload.following = triggers.following;
        const hasTriggers = Object.keys(triggersPayload).length > 0;

        const body = { id: wfId, description: desc, steps, flow };
        if (hasTriggers) body.triggers = triggersPayload;

        try {
            if (loadedWorkflowId) {
                const updatePayload = { description: desc, steps, flow };
                if (hasTriggers) updatePayload.triggers = triggersPayload;
                await apiFetch('/workflows/' + loadedWorkflowId, {
                    method: 'PUT',
                    body: JSON.stringify(updatePayload),
                });
                toast('Workflow saved', 'success');
            } else {
                await apiFetch('/workflows', { method: 'POST', body: JSON.stringify(body) });
                loadedWorkflowId = wfId;
                toast('Workflow created', 'success');
            }
            _renderWorkflowSelector();
            _fetchWorkflowList();
            Workflows.render();
        } catch (e) {
            toast(e.message, 'error');
        }
    }

    async function loadWorkflow(id) {
        try {
            const wf = await apiFetch('/workflows/' + id);
            clearState();
            loadedWorkflowId = id;
            $wfId.value = wf.id;
            $wfDesc.value = wf.description || '';
            $wfSelect.value = id;

            if (wf.flow && wf.flow.nodes) {
                // Load from flow data
                wf.flow.nodes.forEach(n => {
                    nodes.push({ id: n.id, type: n.type, x: n.x, y: n.y, config: n.config || {} });
                    const idNum = parseInt(n.id.replace(/\D/g, ''), 10);
                    if (idNum >= nextId) nextId = idNum + 1;
                });
                nodes.forEach(n => _renderNode(n));
                if (wf.flow.connections) {
                    wf.flow.connections.forEach(c => {
                        connections.push(c);
                        const idNum = parseInt(c.id.replace(/\D/g, ''), 10);
                        if (idNum >= nextId) nextId = idNum + 1;
                    });
                    // Render connections after a tick so node dimensions are available
                    requestAnimationFrame(() => {
                        connections.forEach(c => _renderConnection(c));
                    });
                }
                if (wf.flow.zoom) zoom = wf.flow.zoom;
                if (wf.flow.panX != null) panX = wf.flow.panX;
                if (wf.flow.panY != null) panY = wf.flow.panY;
                _applyTransform();
            } else {
                // Auto-layout from steps
                _autoLayoutFromSteps(wf.steps || []);
            }
            _updateStatus();
        } catch (e) {
            toast('Failed to load: ' + e.message, 'error');
        }
    }

    function _autoLayoutFromSteps(steps) {
        const startX = 300, startY = 60, spacingY = 120;

        // Add trigger
        const trigger = addNode('trigger', 'manual', startX, startY);
        let prevId = trigger.id;

        steps.forEach((step, i) => {
            const y = startY + (i + 1) * spacingY;
            const type = step.squad ? 'squad' : 'agent';
            const value = step.squad || step.agent || '';
            const node = addNode(type, value, startX, y);
            if (step.on_fail) node.config.on_fail = step.on_fail;
            if (step.custom_prompt) node.config.custom_prompt = step.custom_prompt;
            refreshNode(node.id);

            // Connect
            const conn = { id: 'c' + (nextId++), from: prevId, fromPort: 'out', to: node.id, toPort: 'in' };
            connections.push(conn);
            prevId = node.id;
        });

        // Render connections after layout
        requestAnimationFrame(() => {
            connections.forEach(c => _renderConnection(c));
        });
    }

    function flowToSteps() {
        // Topological sort: find trigger(s) and following nodes, BFS through 'out' connections
        const entryNodes = nodes.filter(n => n.type === 'trigger' || n.type === 'following');
        const triggers = { cron: null, following: [] };

        if (!entryNodes.length) return { steps: [], triggers };

        const visited = new Set();
        const result = [];
        const queue = [...entryNodes.map(t => t.id)];

        // Extract trigger metadata
        entryNodes.forEach(n => {
            if (n.type === 'trigger' && n.config.trigger_type === 'schedule' && n.config.cron) {
                triggers.cron = n.config.cron;
            } else if (n.type === 'following' && n.config.follows) {
                triggers.following.push({
                    follows: n.config.follows,
                    follows_type: n.config.follows_type || 'squad',
                    trigger_on: n.config.trigger_on || 'success',
                });
            }
        });

        while (queue.length) {
            const current = queue.shift();
            if (visited.has(current)) continue;
            visited.add(current);

            const node = nodes.find(n => n.id === current);
            if (!node) continue;

            // Add to steps if it's a squad or agent
            if (node.type === 'squad' && node.config.squad) {
                const step = { squad: node.config.squad, on_fail: node.config.on_fail || 'stop' };
                if (node.config.custom_prompt) step.custom_prompt = node.config.custom_prompt;
                result.push(step);
            } else if (node.type === 'agent' && node.config.agent) {
                const step = { squad: node.config.agent, on_fail: node.config.on_fail || 'stop' };
                if (node.config.custom_prompt) step.custom_prompt = node.config.custom_prompt;
                result.push(step);
            }

            // Follow 'out' connections
            const outConns = connections.filter(c => c.from === current && c.fromPort === 'out');
            outConns.forEach(c => {
                if (!visited.has(c.to)) queue.push(c.to);
            });
        }

        return { steps: result, triggers };
    }

    function autoLayout() {
        if (!nodes.length) return;
        const startX = 300, startY = 60, spacingY = 120;

        // Entry nodes: triggers and following
        const entryNodes = nodes.filter(n => n.type === 'trigger' || n.type === 'following');
        const others = nodes.filter(n => n.type !== 'trigger' && n.type !== 'following');

        // Place entry nodes first
        entryNodes.forEach((n, i) => {
            n.x = startX + i * 250;
            n.y = startY;
            const el = document.getElementById('fn-' + n.id);
            if (el) _positionNode(el, n);
        });

        // BFS order the rest
        const visited = new Set(entryNodes.map(t => t.id));
        const queue = [...entryNodes.map(t => t.id)];
        let row = 1;

        while (queue.length) {
            const current = queue.shift();
            const outConns = connections.filter(c => c.from === current && c.fromPort === 'out');
            outConns.forEach(c => {
                if (!visited.has(c.to)) {
                    visited.add(c.to);
                    const node = nodes.find(n => n.id === c.to);
                    if (node) {
                        node.x = startX;
                        node.y = startY + row * spacingY;
                        row++;
                        const el = document.getElementById('fn-' + node.id);
                        if (el) _positionNode(el, node);
                        queue.push(c.to);
                    }
                }
            });
        }

        // Place unvisited nodes
        nodes.forEach(n => {
            if (!visited.has(n.id)) {
                n.x = startX + 300;
                n.y = startY + row * spacingY;
                row++;
                const el = document.getElementById('fn-' + n.id);
                if (el) _positionNode(el, n);
            }
        });

        updateAllConnections();
        if (selectedNode) {
            const node = nodes.find(n => n.id === selectedNode);
            if (node) _renderProperties(node);
        }
    }

    // ── Clear / Status ───────────────────────────────

    function clearState() {
        nodes = [];
        connections = [];
        selectedNode = null;
        nextId = 1;
        loadedWorkflowId = null;
        nodeNotices = {};
        $nodesLayer.innerHTML = '';
        // Clear SVG paths
        while ($svg.firstChild) $svg.removeChild($svg.firstChild);
        $wfId.value = '';
        $wfDesc.value = '';
        $wfSelect.value = '';
        _renderProperties(null);
        _updateStatus();
        zoomReset();
    }

    function clear() {
        if (nodes.length && !confirm('Clear all nodes and connections?')) return;
        clearState();
    }

    function _updateStatus() {
        if ($statusInfo) {
            $statusInfo.textContent = nodes.length + ' nodes, ' + connections.length + ' connections';
        }
    }

    // ── Public API ───────────────────────────────────

    return {
        init, render, loadWorkflow, save, clear, autoLayout,
        zoomIn, zoomOut, zoomReset,
        deleteNode, updateConfig, updateFollowing, updateSquadPrompt,
        aiBuild, setCron, setCronPart, toggleDow,
        showInlineCreate, submitInlineCreate, cancelInlineCreate,
        dismissNotice, dismissAllNotices,
    };
})();
