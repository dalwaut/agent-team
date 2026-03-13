/**
 * OPAI Studio — Extended Tools
 *
 * Line, Arrow, Pen/Brush, Eraser, Eyedropper, Crop, Hand/Pan.
 * Toolbar flyout groups for organized tool access.
 */

const Tools = {
    /** Brush size for pen/eraser */
    brushSize: 5,
    brushColor: '#000000',
    brushOpacity: 1,

    /** Crop state */
    _cropRect: null,
    _cropOverlay: null,

    /** Hand/Pan state */
    _isPanning: false,
    _panStart: { x: 0, y: 0 },

    /** Line/Arrow drawing state */
    _drawingLine: null,
    _drawingStart: null,

    // ── Flyout Management ──────────────────────────────────────────────────

    /**
     * Toggle a flyout menu open/closed.
     */
    toggleFlyout(groupId) {
        const flyout = document.getElementById(`flyout-${groupId}`);
        if (!flyout) return;

        // Close all other flyouts
        document.querySelectorAll('.tool-flyout').forEach(f => {
            if (f.id !== `flyout-${groupId}`) f.classList.remove('open');
        });

        flyout.classList.toggle('open');

        // Close on click outside
        if (flyout.classList.contains('open')) {
            const close = (e) => {
                if (!flyout.contains(e.target) && !e.target.closest(`[data-flyout="${groupId}"]`)) {
                    flyout.classList.remove('open');
                    document.removeEventListener('click', close);
                }
            };
            setTimeout(() => document.addEventListener('click', close), 0);
        }
    },

    /**
     * Select a tool from a flyout group. Updates the group button icon.
     */
    selectFromFlyout(groupId, toolKey, label, shortcut) {
        // Close flyout
        const flyout = document.getElementById(`flyout-${groupId}`);
        if (flyout) flyout.classList.remove('open');

        // Update group button display
        const groupBtn = document.querySelector(`[data-flyout="${groupId}"] .tool-group-label`);
        if (groupBtn) groupBtn.textContent = label;

        // Activate the tool
        this.activate(toolKey);
    },

    // ── Tool Activation ────────────────────────────────────────────────────

    activate(tool) {
        const canvas = CanvasMgr.canvas;
        if (!canvas) return;

        // Cleanup previous tool state
        this._cleanupTool();

        CanvasMgr.activeTool = tool;

        // Update toolbar active state
        document.querySelectorAll('.tool-btn, .tool-group-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tool === tool);
        });

        // Default canvas state
        canvas.isDrawingMode = false;
        canvas.selection = false;
        canvas.defaultCursor = 'crosshair';
        canvas.forEachObject(obj => {
            if (!obj._locked) obj.selectable = true;
            obj.evented = true;
        });

        // Show/hide pen options bar
        const penBar = document.getElementById('pen-options-bar');
        if (penBar) penBar.style.display = (tool === 'pen' || tool === 'eraser') ? 'flex' : 'none';

        switch (tool) {
            case 'select':
                canvas.selection = true;
                canvas.defaultCursor = 'default';
                break;

            case 'hand':
                canvas.defaultCursor = 'grab';
                canvas.forEachObject(obj => {
                    obj.selectable = false;
                    obj.evented = false;
                });
                this._setupPan();
                break;

            case 'line':
                this._setupLineDraw('line');
                break;

            case 'arrow':
                this._setupLineDraw('arrow');
                break;

            case 'pen':
                canvas.isDrawingMode = true;
                canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);
                canvas.freeDrawingBrush.color = this.brushColor;
                canvas.freeDrawingBrush.width = this.brushSize;
                canvas.freeDrawingBrush.globalCompositeOperation = 'source-over';
                break;

            case 'eraser':
                canvas.isDrawingMode = true;
                canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);
                canvas.freeDrawingBrush.color = '#ffffff';
                canvas.freeDrawingBrush.width = this.brushSize;
                break;

            case 'eyedropper':
                canvas.defaultCursor = 'crosshair';
                this._setupEyedropper();
                break;

            case 'crop':
                canvas.defaultCursor = 'crosshair';
                this._setupCrop();
                break;
        }
    },

    _cleanupTool() {
        const canvas = CanvasMgr.canvas;
        if (!canvas) return;

        // Remove event listeners from previous tool
        canvas.off('mouse:down.tool');
        canvas.off('mouse:move.tool');
        canvas.off('mouse:up.tool');

        // Cancel crop if active
        if (this._cropRect) {
            canvas.remove(this._cropRect);
            this._cropRect = null;
        }
        if (this._cropOverlay) {
            canvas.remove(this._cropOverlay);
            this._cropOverlay = null;
        }

        // Cancel line drawing
        if (this._drawingLine) {
            canvas.remove(this._drawingLine);
            this._drawingLine = null;
            this._drawingStart = null;
        }

        this._isPanning = false;
    },

    // ── Hand / Pan ─────────────────────────────────────────────────────────

    _setupPan() {
        const canvas = CanvasMgr.canvas;

        canvas.on('mouse:down.tool', (opt) => {
            this._isPanning = true;
            this._panStart = { x: opt.e.clientX, y: opt.e.clientY };
            canvas.defaultCursor = 'grabbing';
        });

        canvas.on('mouse:move.tool', (opt) => {
            if (!this._isPanning) return;
            const vpt = canvas.viewportTransform.slice();
            vpt[4] += opt.e.clientX - this._panStart.x;
            vpt[5] += opt.e.clientY - this._panStart.y;
            canvas.setViewportTransform(vpt);
            this._panStart = { x: opt.e.clientX, y: opt.e.clientY };
        });

        canvas.on('mouse:up.tool', () => {
            this._isPanning = false;
            canvas.defaultCursor = 'grab';
        });
    },

    // ── Line / Arrow Drawing ───────────────────────────────────────────────

    _setupLineDraw(type) {
        const canvas = CanvasMgr.canvas;

        canvas.on('mouse:down.tool', (opt) => {
            const pointer = canvas.getPointer(opt.e);
            this._drawingStart = { x: pointer.x, y: pointer.y };

            const line = new fabric.Line(
                [pointer.x, pointer.y, pointer.x, pointer.y],
                {
                    stroke: '#000000',
                    strokeWidth: 2,
                    selectable: false,
                    evented: false,
                    name: type === 'arrow' ? 'Arrow' : 'Line',
                }
            );
            canvas.add(line);
            this._drawingLine = line;
        });

        canvas.on('mouse:move.tool', (opt) => {
            if (!this._drawingLine || !this._drawingStart) return;
            const pointer = canvas.getPointer(opt.e);
            this._drawingLine.set({ x2: pointer.x, y2: pointer.y });
            canvas.renderAll();
        });

        canvas.on('mouse:up.tool', (opt) => {
            if (!this._drawingLine || !this._drawingStart) return;
            const pointer = canvas.getPointer(opt.e);
            const dx = pointer.x - this._drawingStart.x;
            const dy = pointer.y - this._drawingStart.y;

            // Discard tiny lines
            if (Math.sqrt(dx * dx + dy * dy) < 5) {
                canvas.remove(this._drawingLine);
                this._drawingLine = null;
                this._drawingStart = null;
                return;
            }

            // Remove the preview line
            canvas.remove(this._drawingLine);

            if (type === 'arrow') {
                this._createArrow(
                    this._drawingStart.x, this._drawingStart.y,
                    pointer.x, pointer.y
                );
            } else {
                // Create final line object
                const line = new fabric.Line(
                    [this._drawingStart.x, this._drawingStart.y, pointer.x, pointer.y],
                    {
                        stroke: '#000000',
                        strokeWidth: 2,
                        name: 'Line',
                    }
                );
                canvas.add(line);
                canvas.setActiveObject(line);
            }

            this._drawingLine = null;
            this._drawingStart = null;
            canvas.renderAll();
            CanvasMgr.saveState();
        });
    },

    _createArrow(x1, y1, x2, y2) {
        const canvas = CanvasMgr.canvas;
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const headLen = 15;

        const line = new fabric.Line([x1, y1, x2, y2], {
            stroke: '#000000',
            strokeWidth: 2,
        });

        const head = new fabric.Triangle({
            left: x2,
            top: y2,
            originX: 'center',
            originY: 'center',
            width: headLen,
            height: headLen,
            fill: '#000000',
            angle: (angle * 180 / Math.PI) + 90,
        });

        const group = new fabric.Group([line, head], {
            name: 'Arrow',
        });
        canvas.add(group);
        canvas.setActiveObject(group);
    },

    // ── Eyedropper ─────────────────────────────────────────────────────────

    _setupEyedropper() {
        const canvas = CanvasMgr.canvas;

        canvas.on('mouse:down.tool', (opt) => {
            const pointer = canvas.getPointer(opt.e);
            const ctx = canvas.getContext('2d');

            // Account for zoom/pan
            const vpt = canvas.viewportTransform;
            const px = Math.round(pointer.x * vpt[0] + vpt[4]);
            const py = Math.round(pointer.y * vpt[3] + vpt[5]);

            const pixel = ctx.getImageData(px, py, 1, 1).data;
            const hex = '#' +
                ((1 << 24) + (pixel[0] << 16) + (pixel[1] << 8) + pixel[2])
                    .toString(16).slice(1);

            this.brushColor = hex;

            // Update pen options color picker if visible
            const picker = document.getElementById('pen-color-picker');
            if (picker) picker.value = hex;

            App.toast(`Color picked: ${hex}`, 'info', 2000);

            // Return to select tool
            this.activate('select');
            CanvasMgr.setTool('select');
        });
    },

    // ── Crop ───────────────────────────────────────────────────────────────

    _setupCrop() {
        const canvas = CanvasMgr.canvas;

        canvas.on('mouse:down.tool', (opt) => {
            // Remove existing crop rect
            if (this._cropRect) {
                canvas.remove(this._cropRect);
            }

            const pointer = canvas.getPointer(opt.e);
            this._drawingStart = { x: pointer.x, y: pointer.y };

            this._cropRect = new fabric.Rect({
                left: pointer.x,
                top: pointer.y,
                width: 0,
                height: 0,
                fill: 'rgba(108, 99, 255, 0.1)',
                stroke: '#6C63FF',
                strokeWidth: 2,
                strokeDashArray: [6, 4],
                selectable: false,
                evented: false,
                name: '_crop_selection',
            });
            canvas.add(this._cropRect);
        });

        canvas.on('mouse:move.tool', (opt) => {
            if (!this._cropRect || !this._drawingStart) return;
            const pointer = canvas.getPointer(opt.e);

            const left = Math.min(this._drawingStart.x, pointer.x);
            const top = Math.min(this._drawingStart.y, pointer.y);
            const width = Math.abs(pointer.x - this._drawingStart.x);
            const height = Math.abs(pointer.y - this._drawingStart.y);

            this._cropRect.set({ left, top, width, height });
            canvas.renderAll();
        });

        canvas.on('mouse:up.tool', () => {
            if (!this._cropRect) return;
            this._drawingStart = null;

            const w = this._cropRect.width;
            const h = this._cropRect.height;
            if (w < 10 || h < 10) {
                canvas.remove(this._cropRect);
                this._cropRect = null;
                return;
            }

            // Show crop confirmation
            App.toast('Press Enter to crop, Escape to cancel', 'info', 5000);
        });
    },

    /**
     * Apply the current crop selection — resizes canvas.
     */
    applyCrop() {
        const canvas = CanvasMgr.canvas;
        if (!canvas || !this._cropRect) return;

        const left = this._cropRect.left;
        const top = this._cropRect.top;
        const width = Math.round(this._cropRect.width);
        const height = Math.round(this._cropRect.height);

        // Remove crop rect
        canvas.remove(this._cropRect);
        this._cropRect = null;

        // Export just the cropped region
        const dataURL = canvas.toDataURL({
            left, top, width, height,
            format: 'png',
        });

        // Resize canvas
        canvas.setWidth(width);
        canvas.setHeight(height);
        CanvasMgr.width = width;
        CanvasMgr.height = height;

        // Clear and load cropped image
        canvas.clear();
        canvas.backgroundColor = '#ffffff';

        fabric.Image.fromURL(dataURL, (img) => {
            img.set({
                left: 0, top: 0,
                originX: 'left', originY: 'top',
                name: 'Cropped',
                selectable: true,
            });
            canvas.add(img);
            canvas.renderAll();
            CanvasMgr.saveState();
            CanvasMgr.updateLayersList();

            // Update size display
            document.getElementById('canvas-size').textContent =
                `${width} \u00d7 ${height}`;
        });

        this.activate('select');
        CanvasMgr.setTool('select');
        App.toast('Canvas cropped.', 'success');
    },

    cancelCrop() {
        const canvas = CanvasMgr.canvas;
        if (!canvas || !this._cropRect) return;
        canvas.remove(this._cropRect);
        this._cropRect = null;
        canvas.renderAll();
    },

    // ── Brush Options ──────────────────────────────────────────────────────

    setBrushSize(size) {
        this.brushSize = Math.max(1, Math.min(50, size));
        const canvas = CanvasMgr.canvas;
        if (canvas && canvas.freeDrawingBrush) {
            canvas.freeDrawingBrush.width = this.brushSize;
        }
        const sizeEl = document.getElementById('pen-size-value');
        if (sizeEl) sizeEl.textContent = this.brushSize + 'px';
        const slider = document.getElementById('pen-size-slider');
        if (slider) slider.value = this.brushSize;
    },

    setBrushColor(color) {
        this.brushColor = color;
        const canvas = CanvasMgr.canvas;
        if (canvas && canvas.freeDrawingBrush && CanvasMgr.activeTool === 'pen') {
            canvas.freeDrawingBrush.color = color;
        }
    },

    setBrushOpacity(opacity) {
        this.brushOpacity = opacity;
        const canvas = CanvasMgr.canvas;
        if (canvas && canvas.freeDrawingBrush) {
            // Apply opacity through color
            const hex = this.brushColor;
            const a = Math.round(opacity * 255);
            if (CanvasMgr.activeTool === 'pen') {
                canvas.freeDrawingBrush.color = hex + a.toString(16).padStart(2, '0');
            }
        }
    },

    increaseBrushSize() {
        this.setBrushSize(this.brushSize + 2);
    },

    decreaseBrushSize() {
        this.setBrushSize(this.brushSize - 2);
    },
};
