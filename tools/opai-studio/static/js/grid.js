/**
 * OPAI Studio — Grid, Rulers, Snap & Alignment Guides
 *
 * Grid overlay, snap-to-grid, smart alignment guides, rulers.
 * Grid uses DPI-accurate sizing: 1 inch on screen = 1 inch in the grid.
 */

const Grid = {
    /** Grid config — gridSize set dynamically from screen DPI */
    gridSize: 96,
    gridEnabled: false,
    snapEnabled: false,
    rulersEnabled: false,
    snapThreshold: 8,
    alignThreshold: 5,

    /** Measured screen DPI */
    _screenDPI: 96,

    /** Alignment guides currently rendered */
    _guides: [],

    // ── Grid Overlay ───────────────────────────────────────────────────────

    init() {
        const canvas = CanvasMgr.canvas;
        if (!canvas) return;

        // Measure actual screen DPI
        this._measureDPI();

        // Render grid after canvas renders
        canvas.on('after:render', () => {
            if (this.gridEnabled) {
                this._renderGrid(canvas.contextContainer);
            }
        });

        // Snap-to-grid on object move
        canvas.on('object:moving', (opt) => {
            const obj = opt.target;
            if (!obj) return;

            if (this.snapEnabled) {
                this._snapToGrid(obj);
            }

            this._showAlignmentGuides(obj);
        });

        // Clear guides when done moving
        canvas.on('object:modified', () => {
            this._clearGuides();
        });

        canvas.on('mouse:up', () => {
            this._clearGuides();
        });
    },

    /**
     * Measure the actual screen DPI by creating a temporary CSS element.
     * Sets gridSize to match 1 real inch.
     */
    _measureDPI() {
        const testEl = document.createElement('div');
        testEl.style.cssText = 'position:absolute;left:-9999px;width:1in;height:1in;';
        document.body.appendChild(testEl);
        this._screenDPI = testEl.offsetWidth || 96;
        document.body.removeChild(testEl);
        this.gridSize = this._screenDPI;
    },

    // ── Grid Rendering ─────────────────────────────────────────────────────

    _renderGrid(ctx) {
        const canvas = CanvasMgr.canvas;
        if (!canvas) return;

        if (!ctx) ctx = canvas.lowerCanvasEl && canvas.lowerCanvasEl.getContext('2d');
        if (!ctx) return;

        const vpt = canvas.viewportTransform;
        const zoom = canvas.getZoom();

        // Calculate visible area in canvas coordinates
        // The canvas element dimensions
        const canvasElWidth = canvas.lowerCanvasEl.width;
        const canvasElHeight = canvas.lowerCanvasEl.height;

        // Convert viewport bounds to canvas coordinates
        const visibleLeft = -vpt[4] / zoom;
        const visibleTop = -vpt[5] / zoom;
        const visibleRight = (canvasElWidth - vpt[4]) / zoom;
        const visibleBottom = (canvasElHeight - vpt[5]) / zoom;

        // Grid size in canvas pixels — 1 inch at current DPI
        const gridSize = this.gridSize;
        const majorEvery = 4; // Major line every 4 inches (quarter-foot grid)

        // Snap start positions to grid boundaries
        const startX = Math.floor(visibleLeft / gridSize) * gridSize;
        const startY = Math.floor(visibleTop / gridSize) * gridSize;
        const endX = Math.ceil(visibleRight / gridSize) * gridSize;
        const endY = Math.ceil(visibleBottom / gridSize) * gridSize;

        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.setTransform(vpt[0], vpt[1], vpt[2], vpt[3], vpt[4], vpt[5]);

        // Minor lines (every 1 inch)
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(108, 99, 255, 0.18)';
        ctx.lineWidth = 1 / zoom;

        for (let x = startX; x <= endX; x += gridSize) {
            if (x % (gridSize * majorEvery) === 0) continue;
            ctx.moveTo(x, startY);
            ctx.lineTo(x, endY);
        }
        for (let y = startY; y <= endY; y += gridSize) {
            if (y % (gridSize * majorEvery) === 0) continue;
            ctx.moveTo(startX, y);
            ctx.lineTo(endX, y);
        }
        ctx.stroke();

        // Major lines (every 4 inches)
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(108, 99, 255, 0.30)';
        ctx.lineWidth = 1 / zoom;

        for (let x = startX; x <= endX; x += gridSize * majorEvery) {
            ctx.moveTo(x, startY);
            ctx.lineTo(x, endY);
        }
        for (let y = startY; y <= endY; y += gridSize * majorEvery) {
            ctx.moveTo(startX, y);
            ctx.lineTo(endX, y);
        }
        ctx.stroke();

        // Canvas boundary border (logical canvas area)
        const w = CanvasMgr.width;
        const h = CanvasMgr.height;
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(108, 99, 255, 0.45)';
        ctx.lineWidth = 2 / zoom;
        ctx.strokeRect(0, 0, w, h);

        // Draw origin crosshair
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(108, 99, 255, 0.35)';
        ctx.lineWidth = 1 / zoom;
        ctx.setLineDash([6 / zoom, 4 / zoom]);
        ctx.moveTo(0, startY);
        ctx.lineTo(0, endY);
        ctx.moveTo(startX, 0);
        ctx.lineTo(endX, 0);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.restore();
    },

    // ── Snap to Grid ───────────────────────────────────────────────────────

    _snapToGrid(obj) {
        const gridSize = this.gridSize;
        const threshold = this.snapThreshold;

        const left = obj.left;
        const top = obj.top;

        const nearestX = Math.round(left / gridSize) * gridSize;
        const nearestY = Math.round(top / gridSize) * gridSize;

        if (Math.abs(left - nearestX) < threshold) {
            obj.set('left', nearestX);
        }
        if (Math.abs(top - nearestY) < threshold) {
            obj.set('top', nearestY);
        }
    },

    // ── Smart Alignment Guides ─────────────────────────────────────────────

    _showAlignmentGuides(movingObj) {
        const canvas = CanvasMgr.canvas;
        if (!canvas) return;

        this._clearGuides();

        const threshold = this.alignThreshold;
        const objBounds = this._getBounds(movingObj);
        const guides = [];

        // Canvas center guides
        const canvasCenterX = CanvasMgr.width / 2;
        const canvasCenterY = CanvasMgr.height / 2;
        const objCenterX = objBounds.left + objBounds.width / 2;
        const objCenterY = objBounds.top + objBounds.height / 2;

        if (Math.abs(objCenterX - canvasCenterX) < threshold) {
            guides.push(this._createGuideLine(canvasCenterX, 0, canvasCenterX, CanvasMgr.height));
            movingObj.set('left', canvasCenterX - objBounds.width / 2 + (movingObj.left - objBounds.left));
        }
        if (Math.abs(objCenterY - canvasCenterY) < threshold) {
            guides.push(this._createGuideLine(0, canvasCenterY, CanvasMgr.width, canvasCenterY));
            movingObj.set('top', canvasCenterY - objBounds.height / 2 + (movingObj.top - objBounds.top));
        }

        // Check alignment with other objects
        canvas.forEachObject((other) => {
            if (other === movingObj || other._isGuide) return;
            if (other.name === '_crop_selection') return;

            const otherBounds = this._getBounds(other);
            const otherCenterX = otherBounds.left + otherBounds.width / 2;
            const otherCenterY = otherBounds.top + otherBounds.height / 2;

            // Left edge alignment
            if (Math.abs(objBounds.left - otherBounds.left) < threshold) {
                guides.push(this._createGuideLine(
                    otherBounds.left, Math.min(objBounds.top, otherBounds.top) - 20,
                    otherBounds.left, Math.max(objBounds.top + objBounds.height, otherBounds.top + otherBounds.height) + 20
                ));
                movingObj.set('left', otherBounds.left + (movingObj.left - objBounds.left));
            }

            // Right edge alignment
            if (Math.abs(objBounds.left + objBounds.width - otherBounds.left - otherBounds.width) < threshold) {
                const x = otherBounds.left + otherBounds.width;
                guides.push(this._createGuideLine(
                    x, Math.min(objBounds.top, otherBounds.top) - 20,
                    x, Math.max(objBounds.top + objBounds.height, otherBounds.top + otherBounds.height) + 20
                ));
                movingObj.set('left', x - objBounds.width + (movingObj.left - objBounds.left));
            }

            // Center X alignment
            if (Math.abs(objCenterX - otherCenterX) < threshold) {
                guides.push(this._createGuideLine(
                    otherCenterX, Math.min(objBounds.top, otherBounds.top) - 20,
                    otherCenterX, Math.max(objBounds.top + objBounds.height, otherBounds.top + otherBounds.height) + 20
                ));
                movingObj.set('left', otherCenterX - objBounds.width / 2 + (movingObj.left - objBounds.left));
            }

            // Top edge alignment
            if (Math.abs(objBounds.top - otherBounds.top) < threshold) {
                guides.push(this._createGuideLine(
                    Math.min(objBounds.left, otherBounds.left) - 20, otherBounds.top,
                    Math.max(objBounds.left + objBounds.width, otherBounds.left + otherBounds.width) + 20, otherBounds.top
                ));
                movingObj.set('top', otherBounds.top + (movingObj.top - objBounds.top));
            }

            // Bottom edge alignment
            if (Math.abs(objBounds.top + objBounds.height - otherBounds.top - otherBounds.height) < threshold) {
                const y = otherBounds.top + otherBounds.height;
                guides.push(this._createGuideLine(
                    Math.min(objBounds.left, otherBounds.left) - 20, y,
                    Math.max(objBounds.left + objBounds.width, otherBounds.left + otherBounds.width) + 20, y
                ));
                movingObj.set('top', y - objBounds.height + (movingObj.top - objBounds.top));
            }

            // Center Y alignment
            if (Math.abs(objCenterY - otherCenterY) < threshold) {
                guides.push(this._createGuideLine(
                    Math.min(objBounds.left, otherBounds.left) - 20, otherCenterY,
                    Math.max(objBounds.left + objBounds.width, otherBounds.left + otherBounds.width) + 20, otherCenterY
                ));
                movingObj.set('top', otherCenterY - objBounds.height / 2 + (movingObj.top - objBounds.top));
            }
        });

        this._guides = guides;
        canvas.renderAll();
    },

    _createGuideLine(x1, y1, x2, y2) {
        const canvas = CanvasMgr.canvas;
        const line = new fabric.Line([x1, y1, x2, y2], {
            stroke: '#00d4ff',
            strokeWidth: 1,
            strokeDashArray: [4, 3],
            selectable: false,
            evented: false,
            _isGuide: true,
        });
        canvas.add(line);
        return line;
    },

    _clearGuides() {
        const canvas = CanvasMgr.canvas;
        if (!canvas) return;
        this._guides.forEach(g => canvas.remove(g));
        this._guides = [];
    },

    _getBounds(obj) {
        const br = obj.getBoundingRect(true);
        // getBoundingRect with absolute=true gives viewport coords,
        // we need canvas coords
        const vpt = CanvasMgr.canvas.viewportTransform;
        return {
            left: (br.left - vpt[4]) / vpt[0],
            top: (br.top - vpt[5]) / vpt[3],
            width: br.width / vpt[0],
            height: br.height / vpt[3],
        };
    },

    // ── Toggle Functions ───────────────────────────────────────────────────

    toggleGrid() {
        this.gridEnabled = !this.gridEnabled;
        this._updateStatusToggles();
        if (CanvasMgr.canvas) CanvasMgr.canvas.renderAll();
    },

    toggleSnap() {
        this.snapEnabled = !this.snapEnabled;
        this._updateStatusToggles();
    },

    toggleRulers() {
        this.rulersEnabled = !this.rulersEnabled;
        this._updateStatusToggles();

        const rulerH = document.getElementById('ruler-h');
        const rulerV = document.getElementById('ruler-v');
        const wrapper = document.getElementById('canvas-wrapper');

        if (rulerH) rulerH.style.display = this.rulersEnabled ? '' : 'none';
        if (rulerV) rulerV.style.display = this.rulersEnabled ? '' : 'none';
        if (wrapper) {
            wrapper.classList.toggle('has-rulers', this.rulersEnabled);
        }

        if (this.rulersEnabled) this.renderRulers();
    },

    _updateStatusToggles() {
        // Status bar toggles
        const gridBtn = document.getElementById('status-grid');
        const snapBtn = document.getElementById('status-snap');
        const rulersBtn = document.getElementById('status-rulers');
        if (gridBtn) gridBtn.classList.toggle('active', this.gridEnabled);
        if (snapBtn) snapBtn.classList.toggle('active', this.snapEnabled);
        if (rulersBtn) rulersBtn.classList.toggle('active', this.rulersEnabled);

        // Toolbar toggles
        const tbGrid = document.getElementById('tb-grid');
        const tbSnap = document.getElementById('tb-snap');
        const tbRulers = document.getElementById('tb-rulers');
        if (tbGrid) tbGrid.classList.toggle('active', this.gridEnabled);
        if (tbSnap) tbSnap.classList.toggle('active', this.snapEnabled);
        if (tbRulers) tbRulers.classList.toggle('active', this.rulersEnabled);
    },

    // ── Rulers ─────────────────────────────────────────────────────────────

    renderRulers() {
        if (!this.rulersEnabled) return;

        const rulerH = document.getElementById('ruler-h');
        const rulerV = document.getElementById('ruler-v');
        if (!rulerH || !rulerV) return;

        const zoom = CanvasMgr.zoom || 1;
        const vpt = CanvasMgr.canvas ? CanvasMgr.canvas.viewportTransform : [1,0,0,1,0,0];
        const w = CanvasMgr.width;
        const h = CanvasMgr.height;

        // Horizontal ruler
        let hTicks = '';
        const step = this._rulerStep(zoom);
        for (let x = 0; x <= w; x += step) {
            const px = x * zoom + vpt[4];
            const isMajor = x % (step * 5) === 0;
            hTicks += `<div class="ruler-tick ${isMajor ? 'major' : ''}" style="left:${px}px">`;
            if (isMajor) hTicks += `<span class="ruler-label">${x}</span>`;
            hTicks += '</div>';
        }
        rulerH.innerHTML = hTicks;

        // Vertical ruler
        let vTicks = '';
        for (let y = 0; y <= h; y += step) {
            const py = y * zoom + vpt[5];
            const isMajor = y % (step * 5) === 0;
            vTicks += `<div class="ruler-tick ${isMajor ? 'major' : ''}" style="top:${py}px">`;
            if (isMajor) vTicks += `<span class="ruler-label">${y}</span>`;
            vTicks += '</div>';
        }
        rulerV.innerHTML = vTicks;
    },

    _rulerStep(zoom) {
        // Adaptive step based on zoom level
        if (zoom >= 2) return 25;
        if (zoom >= 1) return 50;
        if (zoom >= 0.5) return 100;
        return 200;
    },
};
