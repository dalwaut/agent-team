/**
 * OPAI Files — Radial knowledge graph.
 *
 * Lays out files and folders in concentric rings radiating from the center.
 * Root/current folder sits at the center, its children orbit in ring 1,
 * their children in ring 2, etc. Guaranteed zero overlap via manual positioning.
 *
 * Edge types: containment (dashed) and wikilinks (solid blue arrows).
 * Click a folder to drill into it. Click a file to open in the editor panel.
 */

let cy = null;
let cyLoaded = false;
let cyLoading = false;

const GROUP_COLORS = [
    '#4a6cf7', '#e74c3c', '#2ecc71', '#f39c12', '#9b59b6',
    '#1abc9c', '#e67e22', '#3498db', '#e91e63', '#00bcd4',
    '#8bc34a', '#ff5722', '#607d8b', '#795548', '#cddc39',
];
const groupColorMap = {};
let groupColorIdx = 0;

function getGroupColor(group) {
    if (!group) return '#666';
    if (!groupColorMap[group]) {
        groupColorMap[group] = GROUP_COLORS[groupColorIdx % GROUP_COLORS.length];
        groupColorIdx++;
    }
    return groupColorMap[group];
}

function loadCytoscape() {
    return new Promise((resolve, reject) => {
        if (cyLoaded) { resolve(); return; }
        if (cyLoading) {
            const wait = setInterval(() => { if (cyLoaded) { clearInterval(wait); resolve(); } }, 100);
            return;
        }
        cyLoading = true;
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/cytoscape@3/dist/cytoscape.min.js';
        s.onload = () => { cyLoaded = true; cyLoading = false; resolve(); };
        s.onerror = () => { cyLoading = false; reject(new Error('Failed to load Cytoscape')); };
        document.head.appendChild(s);
    });
}

async function openGraph() {
    document.getElementById('graph-overlay').classList.add('active');
    try { await loadCytoscape(); } catch (e) {
        document.getElementById('graph-info').textContent = 'Failed to load graph library';
        return;
    }
    await renderGraph();
}

function closeGraph() {
    document.getElementById('graph-overlay').classList.remove('active');
    document.getElementById('graph-overlay').classList.remove('with-editor');
    if (cy) { cy.destroy(); cy = null; }
}

async function renderGraph() {
    const depth = parseInt(document.getElementById('graph-depth').value, 10);
    const info = document.getElementById('graph-info');
    info.textContent = 'Loading graph...';

    const centerPath = (typeof currentPath !== 'undefined') ? currentPath : '';

    const params = new URLSearchParams({
        scope: 'directory',
        path: centerPath,
        depth: String(depth),
    });

    try {
        const resp = await apiFetch(`/files/api/links/graph?${params}`);
        const data = await resp.json();

        if (!data.nodes || !data.nodes.length) {
            info.textContent = 'No files found';
            return;
        }

        buildGraph(data);

        const fileCount = data.nodes.filter(n => !n.is_dir).length;
        const dirCount = data.nodes.filter(n => n.is_dir).length;
        const linkEdges = data.edges.filter(e => e.type === 'link').length;
        info.textContent = `${fileCount} files, ${dirCount} folders, ${linkEdges} wikilinks`;
    } catch (err) {
        info.textContent = `Error: ${err.message}`;
    }
}

// ── Radial layout engine ─────────────────────────────

/**
 * Compute x,y for every node using concentric radial rings.
 *
 * Algorithm:
 *  1. Build a tree from containment edges (parent → children).
 *  2. Find the center node (is_center flag, or pick the root dir).
 *  3. BFS from center outward, assigning each depth level to a ring.
 *  4. For each ring, space children evenly within the angular slice
 *     allocated by their parent. This prevents overlap and keeps
 *     children visually grouped near their parent.
 */
function computeRadialPositions(data) {
    // Build adjacency from containment edges
    const children = {};   // parentId -> [childId, ...]
    const parentOf = {};   // childId -> parentId
    const nodeSet = new Set(data.nodes.map(n => n.id));

    for (const e of data.edges) {
        if (e.type !== 'contains') continue;
        if (!nodeSet.has(e.source) || !nodeSet.has(e.target)) continue;
        if (!children[e.source]) children[e.source] = [];
        children[e.source].push(e.target);
        parentOf[e.target] = e.source;
    }

    // Find root: the center node, or the node with no parent
    let rootId = data.nodes.find(n => n.is_center)?.id;
    if (!rootId) {
        for (const n of data.nodes) {
            if (!parentOf[n.id]) { rootId = n.id; break; }
        }
    }
    if (!rootId) rootId = data.nodes[0].id;

    // Count total leaf descendants to allocate angular space proportionally
    const descendantCount = {};
    function countDescendants(id) {
        if (descendantCount[id] !== undefined) return descendantCount[id];
        const kids = children[id] || [];
        if (kids.length === 0) {
            descendantCount[id] = 1;
            return 1;
        }
        let total = 0;
        for (const kid of kids) total += countDescendants(kid);
        descendantCount[id] = total;
        return total;
    }
    countDescendants(rootId);

    // Also count any orphan nodes (no parent, not root)
    const orphans = data.nodes.filter(n => n.id !== rootId && !parentOf[n.id]);

    // BFS to assign positions
    const positions = {};
    const RING_GAP = 220;         // pixels between rings
    const MIN_NODE_ARC = 55;     // minimum arc-length per node in pixels

    positions[rootId] = { x: 0, y: 0 };

    // Assign children of a node within an angular range
    function layoutChildren(parentId, angleStart, angleEnd, depth) {
        const kids = children[parentId] || [];
        if (kids.length === 0) return;

        const radius = depth * RING_GAP;
        const parentDescTotal = kids.reduce((s, k) => s + (descendantCount[k] || 1), 0);

        // Ensure minimum arc-length: expand radius if needed
        const arcLength = radius * (angleEnd - angleStart);
        const neededArc = kids.length * MIN_NODE_ARC;
        const effectiveRadius = neededArc > arcLength ? Math.max(radius, neededArc / (angleEnd - angleStart)) : radius;

        let currentAngle = angleStart;

        for (const kid of kids) {
            const weight = (descendantCount[kid] || 1) / parentDescTotal;
            const sliceSize = (angleEnd - angleStart) * weight;
            const midAngle = currentAngle + sliceSize / 2;

            positions[kid] = {
                x: Math.cos(midAngle) * effectiveRadius,
                y: Math.sin(midAngle) * effectiveRadius,
            };

            // Recurse: children get the sub-slice
            layoutChildren(kid, currentAngle, currentAngle + sliceSize, depth + 1);
            currentAngle += sliceSize;
        }
    }

    // Layout the full tree from root using the full 360 degrees
    layoutChildren(rootId, 0, 2 * Math.PI, 1);

    // Place orphans in an outer ring
    if (orphans.length > 0) {
        const maxDepth = Math.max(1, ...Object.values(positions).map(p =>
            Math.round(Math.sqrt(p.x * p.x + p.y * p.y) / RING_GAP)
        ));
        const orphanRadius = (maxDepth + 1) * RING_GAP;
        orphans.forEach((n, i) => {
            const angle = (2 * Math.PI * i) / orphans.length;
            positions[n.id] = {
                x: Math.cos(angle) * orphanRadius,
                y: Math.sin(angle) * orphanRadius,
            };
        });
    }

    return positions;
}

// ── Build Cytoscape instance ─────────────────────────

function buildGraph(data) {
    const container = document.getElementById('graph-container');
    if (cy) { cy.destroy(); cy = null; }

    // Compute positions
    const positions = computeRadialPositions(data);

    const elements = [];

    for (const node of data.nodes) {
        const pos = positions[node.id] || { x: 0, y: 0 };
        elements.push({
            data: {
                id: node.id,
                label: node.label,
                group: node.group || '',
                isDir: !!node.is_dir,
                isCenter: !!node.is_center,
                linkCount: node.link_count || 0,
            },
            position: { x: pos.x, y: pos.y },
        });
    }

    for (const edge of data.edges) {
        elements.push({
            data: {
                id: edge.source + '>' + edge.target + ':' + edge.type,
                source: edge.source,
                target: edge.target,
                edgeType: edge.type,
            },
        });
    }

    cy = window.cytoscape({
        container,
        elements,
        layout: { name: 'preset' },   // use our computed positions
        style: [
            // ── Folder nodes ──
            {
                selector: 'node[?isDir]',
                style: {
                    'shape': 'round-rectangle',
                    'label': 'data(label)',
                    'background-color': function (e) { return getGroupColor(e.data('group') || e.data('label')); },
                    'background-opacity': 0.75,
                    'width': 64,
                    'height': 34,
                    'font-size': '11px',
                    'font-weight': 'bold',
                    'color': '#e0e0e8',
                    'text-valign': 'center',
                    'text-halign': 'center',
                    'text-outline-width': 2,
                    'text-outline-color': '#0a0a0f',
                    'border-width': 2,
                    'border-color': function (e) { return getGroupColor(e.data('group') || e.data('label')); },
                },
            },
            // ── File nodes ──
            {
                selector: 'node[!isDir]',
                style: {
                    'shape': 'ellipse',
                    'label': 'data(label)',
                    'background-color': function (e) { return getGroupColor(e.data('group')); },
                    'width': function (e) { return Math.max(20, Math.min(50, 16 + (e.data('linkCount') || 0) * 4)); },
                    'height': function (e) { return Math.max(20, Math.min(50, 16 + (e.data('linkCount') || 0) * 4)); },
                    'font-size': '9px',
                    'color': '#b0b0bb',
                    'text-valign': 'bottom',
                    'text-margin-y': 5,
                    'text-outline-width': 1.5,
                    'text-outline-color': '#0a0a0f',
                    'opacity': 0.9,
                },
            },
            // ── Center node ──
            {
                selector: 'node[?isCenter]',
                style: {
                    'border-width': 3,
                    'border-color': '#ffffff',
                    'opacity': 1,
                    'font-size': '13px',
                    'font-weight': 'bold',
                    'color': '#ffffff',
                    'width': function (e) { return e.data('isDir') ? 80 : 44; },
                    'height': function (e) { return e.data('isDir') ? 44 : 44; },
                },
            },
            // ── Containment edges ──
            {
                selector: 'edge[edgeType="contains"]',
                style: {
                    'width': 1,
                    'line-color': '#2a2a3a',
                    'line-style': 'dashed',
                    'line-dash-pattern': [6, 4],
                    'target-arrow-shape': 'none',
                    'curve-style': 'bezier',
                    'opacity': 0.3,
                },
            },
            // ── Wikilink edges ──
            {
                selector: 'edge[edgeType="link"]',
                style: {
                    'width': 2,
                    'line-color': '#4a6cf7',
                    'target-arrow-color': '#4a6cf7',
                    'target-arrow-shape': 'triangle',
                    'arrow-scale': 0.8,
                    'curve-style': 'bezier',
                    'opacity': 0.7,
                },
            },
            // ── Interaction ──
            { selector: 'node.highlighted', style: { 'border-width': 3, 'border-color': '#fff', 'opacity': 1, 'z-index': 10 } },
            { selector: 'node.dimmed', style: { 'opacity': 0.07 } },
            { selector: 'edge.dimmed', style: { 'opacity': 0.02 } },
            { selector: 'edge.highlighted', style: { 'opacity': 1, 'width': 3, 'z-index': 10 } },
            { selector: 'edge.highlighted[edgeType="link"]', style: { 'line-color': '#7c9dff', 'target-arrow-color': '#7c9dff' } },
            { selector: 'edge.highlighted[edgeType="contains"]', style: { 'line-color': '#555', 'line-style': 'solid' } },
        ],
        minZoom: 0.03,
        maxZoom: 6,
    });

    // Fit with padding
    cy.fit(undefined, 40);

    // Zoom-dependent label visibility
    cy.on('zoom', () => {
        const z = cy.zoom();
        cy.nodes('[!isDir]').style('font-size', z < 0.2 ? '0px' : z < 0.45 ? '7px' : '9px');
        cy.nodes('[?isDir]').style('font-size', z < 0.12 ? '0px' : z < 0.35 ? '8px' : '11px');
    });

    // ── Node click ──
    cy.on('tap', 'node', function (e) {
        const node = e.target;
        const nodeId = node.id();

        if (node.data('isDir')) {
            const dirPath = nodeId.replace(/^dir:/, '');
            if (typeof currentPath !== 'undefined') currentPath = dirPath;
            renderGraph();
        } else {
            document.getElementById('graph-overlay').classList.add('with-editor');
            if (typeof openFile === 'function') openFile(nodeId);
        }
    });

    // ── Hover: highlight neighborhood ──
    cy.on('mouseover', 'node', function (e) {
        const node = e.target;
        const hood = node.neighborhood().add(node);
        cy.elements().addClass('dimmed');
        hood.removeClass('dimmed');
        hood.edges().addClass('highlighted');
        node.addClass('highlighted');

        const info = document.getElementById('graph-info');
        if (node.data('isDir')) {
            info.textContent = 'Folder: ' + (node.id().replace(/^dir:/, '') || '(root)');
        } else {
            const lc = node.data('linkCount');
            info.textContent = node.data('label') + ' — ' + node.id() + (lc ? ` (${lc} links)` : '');
        }
    });

    cy.on('mouseout', 'node', function () {
        cy.elements().removeClass('dimmed').removeClass('highlighted');
        const fc = data.nodes.filter(n => !n.is_dir).length;
        const dc = data.nodes.filter(n => n.is_dir).length;
        const lc = data.edges.filter(e => e.type === 'link').length;
        document.getElementById('graph-info').textContent = `${fc} files, ${dc} folders, ${lc} wikilinks`;
    });

    // ── Filter ──
    const filterInput = document.getElementById('graph-filter');
    filterInput.value = '';
    filterInput.oninput = () => {
        const q = filterInput.value.toLowerCase();
        if (!q) { cy.elements().removeClass('dimmed'); return; }
        cy.nodes().forEach(n => {
            if (n.data('label').toLowerCase().includes(q) || n.id().toLowerCase().includes(q)) {
                n.removeClass('dimmed');
                n.neighborhood().removeClass('dimmed');
            } else {
                n.addClass('dimmed');
            }
        });
        cy.edges().forEach(e => {
            if (!e.source().hasClass('dimmed') && !e.target().hasClass('dimmed')) e.removeClass('dimmed');
            else e.addClass('dimmed');
        });
    };
}

function changeGraphScope() {
    renderGraph();
}

function resetGraphView() {
    if (cy) cy.fit(undefined, 40);
    document.getElementById('graph-overlay').classList.remove('with-editor');
}
