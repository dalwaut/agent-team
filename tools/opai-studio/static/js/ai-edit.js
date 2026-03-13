/**
 * OPAI Studio — AI Edit Panel
 *
 * Region-based AI image editing: select a region on the canvas,
 * apply AI operations (inpaint, remove, replace background, etc.),
 * preview results, and apply to canvas.
 */

const AIEdit = {
    /** @type {{ left: number, top: number, width: number, height: number } | null} */
    _region: null,
    /** @type {fabric.Rect | null} */
    _selectionRect: null,
    _isSelecting: false,
    _selectStart: null,

    /** @type {string | null} Preview image base64 */
    _previewB64: null,
    _previewOperation: null,

    // ── Initialization ─────────────────────────────────────────────────────

    init() {
        this.render();
    },

    render() {
        const container = document.getElementById('ai-edit-content');
        if (!container) return;

        const hasRegion = !!this._region;
        const regionInfo = hasRegion
            ? `${Math.round(this._region.width)} x ${Math.round(this._region.height)}`
            : '';

        container.innerHTML = `
            <div class="ai-edit-form">
                <div class="ai-edit-section">
                    <div class="ai-edit-section-title">Region</div>
                    ${hasRegion
                        ? `<div class="ai-edit-region-info">
                               <span>Selected: ${regionInfo}</span>
                               <button class="btn btn-sm" onclick="AIEdit.clearSelection()">Clear</button>
                           </div>`
                        : `<div class="ai-edit-region-btns">
                               <button class="btn btn-sm ai-edit-select-btn"
                                       onclick="AIEdit.startRegionSelect()">
                                   Select Region
                               </button>
                               <button class="btn btn-sm ai-edit-select-btn"
                                       onclick="AIEdit.selectFullCanvas()">
                                   Full Canvas
                               </button>
                           </div>`
                    }
                </div>

                <div class="ai-edit-section">
                    <div class="ai-edit-section-title">Quick Actions</div>
                    <div class="ai-edit-ops-grid">
                        <button class="btn btn-sm ai-edit-op" onclick="AIEdit.runOperation('fill_bg')"
                                title="Fill transparent/blank areas">Fill Background</button>
                        <button class="btn btn-sm ai-edit-op" onclick="AIEdit.runOperation('remove')"
                                title="Remove an object from the image">Remove Object</button>
                        <button class="btn btn-sm ai-edit-op" onclick="AIEdit.runOperation('replace_bg')"
                                title="Replace the background">Replace Background</button>
                        <button class="btn btn-sm ai-edit-op" onclick="AIEdit.runOperation('remove_bg')"
                                title="Remove background, keep subject">Remove Background</button>
                        <button class="btn btn-sm ai-edit-op" onclick="AIEdit.runOperation('make_transparent')"
                                title="Make background transparent">Make Transparent</button>
                        <button class="btn btn-sm ai-edit-op" onclick="AIEdit.runOperation('inpaint')"
                                title="Replace part of the image">Inpaint / Replace</button>
                    </div>
                </div>

                <div class="ai-edit-section">
                    <div class="ai-edit-section-title">Custom Edit</div>
                    <textarea id="ai-edit-instruction" class="ai-edit-textarea"
                              placeholder="Describe what to change..."
                              rows="3"></textarea>
                    <button class="btn btn-sm btn-primary btn-block ai-edit-run-btn"
                            onclick="AIEdit.runOperation('inpaint')">
                        Edit Region
                    </button>
                </div>

                <div class="ai-edit-section">
                    <div class="ai-edit-section-title">Full Canvas</div>
                    <div class="ai-edit-ops-grid">
                        <button class="btn btn-sm ai-edit-op" onclick="AIEdit.runOperation('upscale')">Upscale</button>
                        <button class="btn btn-sm ai-edit-op" onclick="AIEdit.runOperation('style')">Style Transfer</button>
                        <button class="btn btn-sm ai-edit-op" onclick="AIEdit.runOperation('enhance')">Enhance Colors</button>
                        <button class="btn btn-sm ai-edit-op" onclick="AIEdit.runOperation('outpaint')">Outpaint / Extend</button>
                    </div>
                </div>

                <div id="ai-edit-preview" class="ai-edit-preview" style="display:none"></div>
            </div>

            <!-- Processing overlay -->
            <div id="ai-edit-processing" class="ai-edit-processing" style="display:none">
                <div class="ai-edit-spinner"></div>
                <div class="ai-edit-processing-text">Processing...</div>
                <div class="ai-edit-processing-sub" id="ai-edit-processing-op"></div>
            </div>
        `;
    },

    // ── Region Selection ───────────────────────────────────────────────────

    /** Stored handler references (Fabric.js 5.x doesn't support namespaced events) */
    _onMouseDown: null,
    _onMouseMove: null,
    _onMouseUp: null,

    startRegionSelect() {
        const canvas = CanvasMgr.canvas;
        if (!canvas) return;

        // Remove any previous handlers first
        this._removeCanvasHandlers();

        this._isSelecting = true;
        canvas.defaultCursor = 'crosshair';
        canvas.selection = false;
        canvas.forEachObject(obj => { obj.selectable = false; });

        App.toast('Click and drag to select a region', 'info', 3000);

        // Store bound handlers so we can remove them later
        this._onMouseDown = (opt) => {
            if (!this._isSelecting) return;
            const pointer = canvas.getPointer(opt.e);
            this._selectStart = { x: pointer.x, y: pointer.y };

            // Remove existing selection rect
            if (this._selectionRect) {
                canvas.remove(this._selectionRect);
            }

            this._selectionRect = new fabric.Rect({
                left: pointer.x,
                top: pointer.y,
                width: 0,
                height: 0,
                fill: 'rgba(108, 99, 255, 0.1)',
                stroke: '#6C63FF',
                strokeWidth: 2,
                strokeDashArray: [8, 4],
                selectable: false,
                evented: false,
                name: '_ai_edit_selection',
            });
            canvas.add(this._selectionRect);
        };

        this._onMouseMove = (opt) => {
            if (!this._isSelecting || !this._selectStart || !this._selectionRect) return;
            const pointer = canvas.getPointer(opt.e);

            const left = Math.min(this._selectStart.x, pointer.x);
            const top = Math.min(this._selectStart.y, pointer.y);
            const width = Math.abs(pointer.x - this._selectStart.x);
            const height = Math.abs(pointer.y - this._selectStart.y);

            this._selectionRect.set({ left, top, width, height });
            canvas.renderAll();
        };

        this._onMouseUp = () => {
            if (!this._isSelecting || !this._selectionRect) return;
            this._isSelecting = false;
            this._selectStart = null;

            // Cleanup event handlers
            this._removeCanvasHandlers();

            // Restore canvas state
            canvas.defaultCursor = 'default';
            canvas.selection = true;
            canvas.forEachObject(obj => {
                if (obj.name !== '_ai_edit_selection') obj.selectable = true;
            });

            const w = this._selectionRect.width;
            const h = this._selectionRect.height;
            if (w < 10 || h < 10) {
                canvas.remove(this._selectionRect);
                this._selectionRect = null;
                this._region = null;
            } else {
                this._region = {
                    left: this._selectionRect.left,
                    top: this._selectionRect.top,
                    width: w,
                    height: h,
                };
            }

            this.render();
        };

        canvas.on('mouse:down', this._onMouseDown);
        canvas.on('mouse:move', this._onMouseMove);
        canvas.on('mouse:up', this._onMouseUp);
    },

    _removeCanvasHandlers() {
        const canvas = CanvasMgr.canvas;
        if (!canvas) return;
        if (this._onMouseDown) { canvas.off('mouse:down', this._onMouseDown); this._onMouseDown = null; }
        if (this._onMouseMove) { canvas.off('mouse:move', this._onMouseMove); this._onMouseMove = null; }
        if (this._onMouseUp)   { canvas.off('mouse:up', this._onMouseUp);     this._onMouseUp = null; }
    },

    selectFullCanvas() {
        this._region = {
            left: 0,
            top: 0,
            width: CanvasMgr.width,
            height: CanvasMgr.height,
        };
        // Remove any existing selection rect visual
        const canvas = CanvasMgr.canvas;
        if (canvas && this._selectionRect) {
            canvas.remove(this._selectionRect);
            this._selectionRect = null;
        }
        App.toast('Full canvas selected', 'info', 2000);
        this.render();
    },

    clearSelection() {
        const canvas = CanvasMgr.canvas;
        if (canvas && this._selectionRect) {
            canvas.remove(this._selectionRect);
            this._selectionRect = null;
        }
        this._region = null;
        this._isSelecting = false;
        this._removeCanvasHandlers();
        if (canvas) {
            canvas.defaultCursor = 'default';
            canvas.selection = true;
            canvas.forEachObject(obj => { obj.selectable = true; });
            canvas.renderAll();
        }
        this.render();
    },

    // ── AI Operations ──────────────────────────────────────────────────────

    _showProcessing(operation) {
        const el = document.getElementById('ai-edit-processing');
        const opEl = document.getElementById('ai-edit-processing-op');
        if (el) el.style.display = '';
        const opNames = {
            fill_bg: 'Filling background...',
            remove: 'Removing object...',
            replace_bg: 'Replacing background...',
            remove_bg: 'Removing background...',
            make_transparent: 'Making transparent...',
            inpaint: 'Inpainting region...',
            upscale: 'Upscaling image...',
            style: 'Applying style transfer...',
            enhance: 'Enhancing colors...',
            outpaint: 'Extending canvas...',
        };
        if (opEl) opEl.textContent = opNames[operation] || 'Processing...';
    },

    _hideProcessing() {
        const el = document.getElementById('ai-edit-processing');
        if (el) el.style.display = 'none';
    },

    async runOperation(operation) {
        const canvas = CanvasMgr.canvas;
        if (!canvas) return;

        let instruction = document.getElementById('ai-edit-instruction')?.value?.trim() || '';

        // Full-canvas operations don't need a region
        const fullCanvasOps = ['upscale', 'style', 'enhance', 'outpaint'];
        const needsRegion = !fullCanvasOps.includes(operation);

        if (needsRegion && !this._region) {
            App.toast('Select a region first, or click "Full Canvas"', 'warning');
            return;
        }

        // Apply instruction defaults when user hasn't typed anything
        const defaults = {
            fill_bg: 'natural background',
            replace_bg: 'blurred office background',
            remove_bg: 'remove the background completely, keep only the main subject on a clean white background',
            make_transparent: 'remove the background completely, output only the main subject with a transparent background',
            style: 'oil painting',
            outpaint: 'continue the scene naturally',
            remove: 'the selected object',
            enhance: 'improve colors and sharpness',
        };
        if (!instruction) {
            if (defaults[operation]) {
                instruction = defaults[operation];
            } else if (operation === 'inpaint') {
                App.toast('Please describe what you want in the instruction field', 'warning');
                return;
            }
        }

        // Temporarily hide the AI edit selection rect so it doesn't appear in exports
        let selectionWasVisible = false;
        if (this._selectionRect) {
            selectionWasVisible = this._selectionRect.visible !== false;
            this._selectionRect.set('visible', false);
            canvas.renderAll();
        }

        // Export the image region (or full canvas)
        let imageB64;
        try {
            if (needsRegion && this._region) {
                imageB64 = canvas.toDataURL({
                    left: this._region.left,
                    top: this._region.top,
                    width: this._region.width,
                    height: this._region.height,
                    format: 'png',
                });
            } else {
                imageB64 = canvas.toDataURL({ format: 'png' });
            }
        } finally {
            // Restore selection rect visibility
            if (this._selectionRect && selectionWasVisible) {
                this._selectionRect.set('visible', true);
                canvas.renderAll();
            }
        }

        // Strip data URI prefix
        imageB64 = imageB64.replace(/^data:image\/\w+;base64,/, '');

        // Show processing overlay with spinner
        this._showProcessing(operation);

        // Disable all AI edit buttons during processing
        const allBtns = document.querySelectorAll('.ai-edit-op, .ai-edit-run-btn');
        allBtns.forEach(btn => { btn.disabled = true; });

        try {
            const result = await App.apiJSON('/api/edit', {
                method: 'POST',
                body: JSON.stringify({
                    image_b64: imageB64,
                    operation,
                    instruction: instruction || undefined,
                    region: needsRegion ? this._region : null,
                }),
            });

            this._previewB64 = result.image_b64;
            this._previewOperation = operation;
            this._showPreview(result.image_b64);
            App.toast('Edit complete. Preview ready.', 'success');
        } catch (err) {
            App.toast(`AI Edit failed: ${err.message}`, 'error');
        } finally {
            this._hideProcessing();
            allBtns.forEach(btn => { btn.disabled = false; });
        }
    },

    _showPreview(b64) {
        const previewEl = document.getElementById('ai-edit-preview');
        if (!previewEl) return;

        previewEl.style.display = '';
        previewEl.innerHTML = `
            <div class="ai-edit-preview-title">Preview</div>
            <img src="data:image/png;base64,${b64}" alt="AI Edit Preview" />
            <div class="ai-edit-preview-actions">
                <button class="btn btn-sm btn-primary" onclick="AIEdit.applyPreview()">Apply to Canvas</button>
                <button class="btn btn-sm" onclick="AIEdit.discardPreview()">Discard</button>
            </div>
        `;
    },

    applyPreview() {
        if (!this._previewB64) return;

        const canvas = CanvasMgr.canvas;
        if (!canvas) return;

        const b64 = this._previewB64;
        const operation = this._previewOperation;
        const region = this._region;
        const src = `data:image/png;base64,${b64}`;

        const fullCanvasOps = ['upscale', 'style', 'enhance'];

        // Use fabric.Image.fromURL to load the preview image
        fabric.Image.fromURL(src, (img) => {
            if (!img || !img.width) {
                App.toast('Failed to load preview image.', 'error');
                return;
            }

            if (fullCanvasOps.includes(operation)) {
                // Full canvas replacement: place centered at native size
                img.set({
                    left: CanvasMgr.width / 2,
                    top: CanvasMgr.height / 2,
                    originX: 'center',
                    originY: 'center',
                    name: `AI ${operation}`,
                });
            } else if (region) {
                // Region replacement: place at the region location, scaled to fit
                img.set({
                    left: region.left,
                    top: region.top,
                    name: 'AI Edit',
                });
                img.scaleToWidth(region.width);
            } else {
                // Fallback: center on canvas
                img.set({
                    left: CanvasMgr.width / 2,
                    top: CanvasMgr.height / 2,
                    originX: 'center',
                    originY: 'center',
                    name: 'AI Edit',
                });
            }

            canvas.add(img);
            canvas.setActiveObject(img);
            canvas.renderAll();
            CanvasMgr.saveState();
            CanvasMgr.updateLayersList();
            App.toast('Applied to canvas.', 'success');
        });

        // Clear state
        this.clearSelection();
        this._previewB64 = null;
        this._previewOperation = null;
        this.render();
    },

    discardPreview() {
        this._previewB64 = null;
        this._previewOperation = null;
        const previewEl = document.getElementById('ai-edit-preview');
        if (previewEl) previewEl.style.display = 'none';
    },
};
