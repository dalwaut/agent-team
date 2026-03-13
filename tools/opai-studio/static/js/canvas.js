/**
 * OPAI Studio -- Fabric.js Canvas Manager
 *
 * Handles canvas initialization, object manipulation, undo/redo,
 * layer management, zoom, keyboard shortcuts, saving/loading,
 * and image import (file upload, paste, drag-drop).
 */

const CanvasMgr = {
    /** @type {fabric.Canvas|null} */
    canvas: null,

    /** Canvas logical dimensions */
    width: 1024,
    height: 1024,

    /** Undo/redo history stack */
    history: [],
    historyIndex: -1,
    _skipHistorySave: false,
    _maxHistory: 50,

    /** Current zoom level (1.0 = 100%) */
    zoom: 1,
    _minZoom: 0.1,
    _maxZoom: 5,

    /** Active tool name */
    activeTool: 'select',

    // -- Initialization -------------------------------------------------------

    init(width, height) {
        this.width = width || 1024;
        this.height = height || 1024;

        if (this.canvas) {
            this.canvas.dispose();
        }

        this.canvas = new fabric.Canvas('studio-canvas', {
            width: this.width,
            height: this.height,
            backgroundColor: '#ffffff',
            preserveObjectStacking: true,
            selection: true,
            controlsAboveOverlay: true,
        });

        this.history = [];
        this.historyIndex = -1;
        this.zoom = 1;
        this._updateZoomDisplay();

        fabric.Object.prototype.set({
            transparentCorners: false,
            cornerColor: '#6C63FF',
            cornerStrokeColor: '#6C63FF',
            cornerSize: 8,
            cornerStyle: 'circle',
            borderColor: '#6C63FF',
            borderScaleFactor: 1.5,
            padding: 4,
        });

        this._setupEvents();
        this._setupImport();
        this.setupKeyboard();
        this.saveState();
        this._fitCanvasInView();

        // Initialize grid system
        Grid.init();
    },

    // -- Event Bindings -------------------------------------------------------

    _setupEvents() {
        const c = this.canvas;

        c.on('selection:created', () => this.updateProperties());
        c.on('selection:updated', () => this.updateProperties());
        c.on('selection:cleared', () => this.clearProperties());

        c.on('object:modified', () => {
            this.saveState();
            this.updateLayersList();
        });

        c.on('object:added', () => this.updateLayersList());
        c.on('object:removed', () => this.updateLayersList());

        c.on('mouse:move', (opt) => {
            const pointer = c.getPointer(opt.e);
            const cursorEl = document.getElementById('canvas-cursor');
            if (cursorEl) {
                cursorEl.textContent =
                    `${Math.round(pointer.x)}, ${Math.round(pointer.y)}`;
            }
        });

        c.on('mouse:wheel', (opt) => {
            opt.e.preventDefault();
            opt.e.stopPropagation();
            const delta = opt.e.deltaY;
            // Use viewport coordinates (offsetX/Y) so zoomToPoint centers on cursor
            const point = { x: opt.e.offsetX, y: opt.e.offsetY };
            const zoomFactor = delta > 0 ? 0.92 : 1.08;
            this._applyZoom(this.zoom * zoomFactor, point);
        });
    },

    // -- Import: Paste, Drop, File Upload -------------------------------------

    _setupImport() {
        // Clipboard paste (Ctrl+V with image data)
        document.addEventListener('paste', (e) => this._handlePaste(e));

        // Drag-and-drop onto the canvas area
        const wrapper = document.getElementById('canvas-wrapper');
        if (wrapper) {
            wrapper.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.stopPropagation();
                wrapper.classList.add('drag-over');
            });
            wrapper.addEventListener('dragleave', () => {
                wrapper.classList.remove('drag-over');
            });
            wrapper.addEventListener('drop', (e) => {
                e.preventDefault();
                e.stopPropagation();
                wrapper.classList.remove('drag-over');
                this._handleDrop(e);
            });
        }
    },

    _handlePaste(e) {
        // Only handle paste when editor view is visible
        if (document.getElementById('editor-view')?.style.display === 'none') return;
        // Don't intercept paste in inputs/textareas
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;

        // If Ctrl+V was handled by clipboard module (object paste), skip image paste
        // This method is only called for native paste events, not keyboard shortcuts
        if (Clipboard._buffer) return;

        const items = e.clipboardData?.items;
        if (!items) return;

        for (const item of items) {
            // Image from clipboard (screenshot, copied image)
            if (item.type.startsWith('image/')) {
                e.preventDefault();
                const file = item.getAsFile();
                if (file) this._importFile(file, 'Pasted Image');
                return;
            }
        }

        // Check for pasted text that looks like a URL to an image
        const text = e.clipboardData?.getData('text/plain')?.trim();
        if (text && /^https?:\/\/.+\.(png|jpe?g|webp|gif|svg)(\?.*)?$/i.test(text)) {
            e.preventDefault();
            this.addImageFromURL(App.BASE + '/api/proxy-image?url=' + encodeURIComponent(text), 'Pasted URL Image');
            // Fallback: try loading directly
            this.addImageFromURL(text, 'Pasted URL Image');
        }
    },

    _handleDrop(e) {
        const files = e.dataTransfer?.files;
        if (!files?.length) return;

        for (const file of files) {
            if (file.type.startsWith('image/')) {
                this._importFile(file, file.name || 'Dropped Image');
            }
        }
    },

    /**
     * Import a File object: upload to backend, get URL, add to canvas.
     */
    async _importFile(file, name = 'Imported Image') {
        if (!this.canvas) return;

        const formData = new FormData();
        formData.append('file', file);

        try {
            App.toast('Uploading image...', 'info', 2000);
            const resp = await App.apiFetch('/api/images/upload-file', {
                method: 'POST',
                body: formData,
                // Don't set Content-Type -- browser sets it with boundary for FormData
            });

            if (!resp.ok) {
                const err = await resp.json().catch(() => ({ detail: resp.statusText }));
                throw new Error(err.detail || 'Upload failed');
            }

            const result = await resp.json();
            // Add to canvas using the server URL (not data URI)
            this.addImageFromURL(App.BASE + result.url, name);
        } catch (err) {
            console.error('[Studio] File import error:', err);
            App.toast(`Import failed: ${err.message}`, 'error');
        }
    },

    /**
     * Open a file picker to import an image.
     */
    importFromFile() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/png,image/jpeg,image/webp';
        input.multiple = true;
        input.onchange = () => {
            for (const file of input.files) {
                this._importFile(file, file.name || 'Uploaded Image');
            }
        };
        input.click();
    },

    // -- Load / Save JSON -----------------------------------------------------

    loadJSON(json) {
        if (!this.canvas) return;
        this._skipHistorySave = true;

        const jsonObj = typeof json === 'string' ? JSON.parse(json) : json;

        // Rewrite relative asset URLs to include the BASE prefix so
        // Fabric.js can fetch them through Caddy.
        if (jsonObj.objects) {
            for (const obj of jsonObj.objects) {
                if (obj.type === 'image' && obj.src && obj.src.startsWith('/api/')) {
                    obj.src = App.BASE + obj.src;
                }
            }
        }

        this.canvas.loadFromJSON(jsonObj, () => {
            this.canvas.renderAll();
            this._skipHistorySave = false;
            this.history = [];
            this.historyIndex = -1;
            this.saveState();
            this.updateLayersList();
        });
    },

    toJSON() {
        if (!this.canvas) return null;
        const json = this.canvas.toJSON(['name', 'selectable', 'evented']);

        // Strip the BASE prefix from image src URLs before saving so the
        // stored JSON uses clean relative paths (/api/assets/...).
        if (json.objects) {
            for (const obj of json.objects) {
                if (obj.type === 'image' && obj.src && obj.src.startsWith(App.BASE + '/api/')) {
                    obj.src = obj.src.slice(App.BASE.length);
                }
            }
        }
        return json;
    },

    async save(silent = false) {
        if (!this.canvas || !App.state.currentImage) return;

        const canvasJSON = this.toJSON();
        try {
            // Use apiJSON which properly checks for HTTP errors
            await App.apiJSON(`/api/images/${App.state.currentImage.id}/save-canvas`, {
                method: 'POST',
                body: JSON.stringify({ canvas_json: canvasJSON }),
            });
            if (!silent) {
                App.toast('Canvas saved.', 'success');
            }
        } catch (err) {
            console.error('[Studio] Save error:', err);
            if (!silent) {
                App.toast(`Failed to save: ${err.message}`, 'error');
            }
        }
    },

    // -- Tools / Shape Creation -----------------------------------------------

    setTool(tool) {
        this.activeTool = tool;

        // Extended tools are handled by Tools module
        const extendedTools = ['hand', 'line', 'arrow', 'pen', 'eraser', 'eyedropper', 'crop'];
        if (extendedTools.includes(tool)) {
            Tools.activate(tool);
            return;
        }

        document.querySelectorAll('.tool-btn, .tool-group-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tool === tool);
        });
        if (this.canvas) {
            this.canvas.isDrawingMode = false;
            this.canvas.selection = tool === 'select';
            this.canvas.defaultCursor = tool === 'select' ? 'default' : 'crosshair';
        }

        // Hide pen options bar when switching away
        const penBar = document.getElementById('pen-options-bar');
        if (penBar) penBar.style.display = 'none';
    },

    addText() {
        if (!this.canvas) return;

        const text = new fabric.IText('Double-click to edit', {
            left: this.width / 2,
            top: this.height / 2,
            originX: 'center',
            originY: 'center',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            fontSize: 36,
            fill: '#000000',
            name: 'Text',
        });

        this.canvas.add(text);
        this.canvas.setActiveObject(text);
        this.canvas.renderAll();
        this.saveState();
        this.setTool('select');
    },

    addRect() {
        if (!this.canvas) return;

        const rect = new fabric.Rect({
            left: this.width / 2 - 100,
            top: this.height / 2 - 75,
            width: 200,
            height: 150,
            fill: '#6C63FF',
            stroke: '#5046cc',
            strokeWidth: 0,
            rx: 4,
            ry: 4,
            name: 'Rectangle',
        });

        this.canvas.add(rect);
        this.canvas.setActiveObject(rect);
        this.canvas.renderAll();
        this.saveState();
        this.setTool('select');
    },

    addCircle() {
        if (!this.canvas) return;

        const circle = new fabric.Circle({
            left: this.width / 2,
            top: this.height / 2,
            originX: 'center',
            originY: 'center',
            radius: 80,
            fill: '#4ECB71',
            stroke: '#3ba858',
            strokeWidth: 0,
            name: 'Circle',
        });

        this.canvas.add(circle);
        this.canvas.setActiveObject(circle);
        this.canvas.renderAll();
        this.saveState();
        this.setTool('select');
    },

    // -- Image Operations -----------------------------------------------------

    addImageFromURL(url, name = 'Image') {
        if (!this.canvas) return;

        fabric.Image.fromURL(url, (img) => {
            if (!img || !img.width) {
                App.toast('Failed to load image from URL.', 'error');
                return;
            }

            // Place at native size, centered on canvas
            img.set({
                left: this.width / 2,
                top: this.height / 2,
                originX: 'center',
                originY: 'center',
                name: name,
            });

            this.canvas.add(img);
            this.canvas.setActiveObject(img);
            this.canvas.renderAll();
            this.saveState();
        }, { crossOrigin: 'anonymous' });
    },

    /**
     * Add an image from base64 data. Uploads to backend first to get a
     * stable URL, so the canvas JSON stays small and saves correctly.
     */
    async addImageFromB64(b64, name = 'Generated Image') {
        if (!this.canvas) return;

        // Upload the b64 to disk via backend and get a URL
        const projectId = App.state.currentProject?.id;
        try {
            const result = await App.apiJSON('/api/images/store-b64', {
                method: 'POST',
                body: JSON.stringify({
                    image_b64: b64,
                    name: name,
                    project_id: projectId,
                }),
            });

            // Use the server URL instead of data URI
            this.addImageFromURL(App.BASE + result.url, name);
        } catch (err) {
            console.warn('[Studio] store-b64 failed, falling back to data URI:', err);
            // Fallback: use data URI directly (will bloat canvas JSON)
            const src = b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`;
            this._addImageDirectly(src, name);
        }
    },

    /**
     * Internal: add image directly from a src (data URI or URL) without uploading.
     */
    _addImageDirectly(src, name) {
        fabric.Image.fromURL(src, (img) => {
            if (!img || !img.width) {
                App.toast('Failed to decode image.', 'error');
                return;
            }
            // Place at native size, centered on canvas
            img.set({
                left: this.width / 2,
                top: this.height / 2,
                originX: 'center',
                originY: 'center',
                name: name,
            });
            this.canvas.add(img);
            this.canvas.setActiveObject(img);
            this.canvas.renderAll();
            this.saveState();
        });
    },

    // -- Layer Creation --------------------------------------------------------

    addEmptyLayer() {
        if (!this.canvas) return;
        const layer = new fabric.Rect({
            left: 0,
            top: 0,
            width: this.width,
            height: this.height,
            fill: 'transparent',
            stroke: null,
            strokeWidth: 0,
            selectable: true,
            evented: true,
            name: `Layer ${this.canvas.getObjects().length + 1}`,
        });
        this.canvas.add(layer);
        this.canvas.setActiveObject(layer);
        this.canvas.renderAll();
        this.saveState();
        this.updateLayersList();
    },

    // -- Layer Reordering ------------------------------------------------------

    moveLayerUp(index) {
        if (!this.canvas) return;
        const objects = this.canvas.getObjects();
        if (index >= objects.length - 1) return;
        const obj = objects[index];
        obj.bringForward();
        this.canvas.renderAll();
        this.saveState();
        this.updateLayersList();
    },

    moveLayerDown(index) {
        if (!this.canvas) return;
        if (index <= 0) return;
        const obj = this.canvas.getObjects()[index];
        obj.sendBackwards();
        this.canvas.renderAll();
        this.saveState();
        this.updateLayersList();
    },

    // -- Canvas Resize --------------------------------------------------------

    resizeCanvas(newWidth, newHeight) {
        if (!this.canvas) return;
        this.width = newWidth;
        this.height = newHeight;
        this.canvas.setWidth(newWidth);
        this.canvas.setHeight(newHeight);
        this.canvas.renderAll();
        this.saveState();

        // Update size display
        const sizeEl = document.getElementById('canvas-size');
        if (sizeEl) sizeEl.innerHTML = `${newWidth} &times; ${newHeight}`;

        // Re-fit in view
        this._fitCanvasInView();
    },

    // -- Object Operations (Flip, Group, Lock, Align) -------------------------

    flipH() {
        if (!this.canvas) return;
        const obj = this.canvas.getActiveObject();
        if (!obj) return;
        obj.set('flipX', !obj.flipX);
        this.canvas.renderAll();
        this.saveState();
    },

    flipV() {
        if (!this.canvas) return;
        const obj = this.canvas.getActiveObject();
        if (!obj) return;
        obj.set('flipY', !obj.flipY);
        this.canvas.renderAll();
        this.saveState();
    },

    groupSelected() {
        if (!this.canvas) return;
        const active = this.canvas.getActiveObject();
        if (!active || active.type !== 'activeSelection') return;

        const group = active.toGroup();
        group.set('name', 'Group');
        this.canvas.renderAll();
        this.saveState();
        this.updateLayersList();
    },

    ungroupSelected() {
        if (!this.canvas) return;
        const active = this.canvas.getActiveObject();
        if (!active || active.type !== 'group') return;

        active.toActiveSelection();
        this.canvas.renderAll();
        this.saveState();
        this.updateLayersList();
    },

    toggleLock() {
        if (!this.canvas) return;
        const obj = this.canvas.getActiveObject();
        if (!obj) return;

        const isLocked = !!obj._locked;
        const newState = !isLocked;
        obj._locked = newState;
        obj.set({
            lockMovementX: newState,
            lockMovementY: newState,
            lockRotation: newState,
            lockScalingX: newState,
            lockScalingY: newState,
            hasControls: !newState,
        });
        this.canvas.renderAll();
        this.updateLayersList();
        App.toast(newState ? 'Object locked' : 'Object unlocked', 'info', 1500);
    },

    alignObjects(alignment) {
        if (!this.canvas) return;
        const active = this.canvas.getActiveObject();
        if (!active) return;

        const objects = active.type === 'activeSelection'
            ? active.getObjects()
            : [active];

        if (objects.length < 2 && active.type === 'activeSelection') return;

        // For single objects, align to canvas
        if (objects.length === 1) {
            const obj = objects[0];
            switch (alignment) {
                case 'left': obj.set('left', 0); break;
                case 'center': obj.set('left', this.width / 2 - (obj.width * obj.scaleX) / 2); break;
                case 'right': obj.set('left', this.width - obj.width * obj.scaleX); break;
                case 'top': obj.set('top', 0); break;
                case 'middle': obj.set('top', this.height / 2 - (obj.height * obj.scaleY) / 2); break;
                case 'bottom': obj.set('top', this.height - obj.height * obj.scaleY); break;
            }
            obj.setCoords();
            this.canvas.renderAll();
            this.saveState();
            return;
        }

        // Multi-object alignment
        const bounds = active.getBoundingRect(true);
        const vpt = this.canvas.viewportTransform;

        objects.forEach(obj => {
            const objBounds = obj.getBoundingRect(true);
            switch (alignment) {
                case 'left':
                    obj.set('left', obj.left - (objBounds.left - bounds.left) / vpt[0]);
                    break;
                case 'center':
                    obj.set('left', obj.left - (objBounds.left + objBounds.width / 2 - bounds.left - bounds.width / 2) / vpt[0]);
                    break;
                case 'right':
                    obj.set('left', obj.left - (objBounds.left + objBounds.width - bounds.left - bounds.width) / vpt[0]);
                    break;
                case 'top':
                    obj.set('top', obj.top - (objBounds.top - bounds.top) / vpt[3]);
                    break;
                case 'middle':
                    obj.set('top', obj.top - (objBounds.top + objBounds.height / 2 - bounds.top - bounds.height / 2) / vpt[3]);
                    break;
                case 'bottom':
                    obj.set('top', obj.top - (objBounds.top + objBounds.height - bounds.top - bounds.height) / vpt[3]);
                    break;
            }
            obj.setCoords();
        });

        this.canvas.renderAll();
        this.saveState();
    },

    // -- Undo / Redo ----------------------------------------------------------

    saveState() {
        if (!this.canvas || this._skipHistorySave) return;

        if (this.historyIndex < this.history.length - 1) {
            this.history = this.history.slice(0, this.historyIndex + 1);
        }

        const state = JSON.stringify(this.canvas.toJSON(['name', 'selectable', 'evented']));
        this.history.push(state);

        if (this.history.length > this._maxHistory) {
            this.history.shift();
        }

        this.historyIndex = this.history.length - 1;
    },

    undo() {
        if (this.historyIndex <= 0) return;
        this.historyIndex--;
        this._restoreState(this.history[this.historyIndex]);
    },

    redo() {
        if (this.historyIndex >= this.history.length - 1) return;
        this.historyIndex++;
        this._restoreState(this.history[this.historyIndex]);
    },

    _restoreState(stateStr) {
        if (!this.canvas || !stateStr) return;
        this._skipHistorySave = true;
        this.canvas.loadFromJSON(JSON.parse(stateStr), () => {
            this.canvas.renderAll();
            this._skipHistorySave = false;
            this.updateLayersList();
        });
    },

    // -- Zoom -----------------------------------------------------------------

    zoomIn() {
        this._applyZoom(this.zoom * 1.2);
    },

    zoomOut() {
        this._applyZoom(this.zoom * 0.8);
    },

    zoomReset() {
        this._applyZoom(1);
        if (this.canvas) {
            this.canvas.viewportTransform = [1, 0, 0, 1, 0, 0];
            this.canvas.renderAll();
        }
    },

    _applyZoom(newZoom, point) {
        if (!this.canvas) return;
        newZoom = Math.max(this._minZoom, Math.min(this._maxZoom, newZoom));
        this.zoom = newZoom;

        if (point) {
            this.canvas.zoomToPoint(new fabric.Point(point.x, point.y), newZoom);
        } else {
            this.canvas.setZoom(newZoom);
        }

        this.canvas.renderAll();
        this._updateZoomDisplay();
    },

    _updateZoomDisplay() {
        const el = document.getElementById('canvas-zoom');
        if (el) {
            el.textContent = `${Math.round(this.zoom * 100)}%`;
        }
    },

    _fitCanvasInView() {
        const wrapper = document.getElementById('canvas-wrapper');
        if (!wrapper || !this.canvas) return;

        requestAnimationFrame(() => {
            const ww = wrapper.clientWidth - 40;
            const wh = wrapper.clientHeight - 40;
            const scaleX = ww / this.width;
            const scaleY = wh / this.height;
            const scale = Math.min(scaleX, scaleY, 1);
            this._applyZoom(scale);
        });
    },

    // -- Layers Panel ---------------------------------------------------------

    updateLayersList() {
        const list = document.getElementById('layers-list');
        if (!list || !this.canvas) return;

        const objects = this.canvas.getObjects();
        const active = this.canvas.getActiveObject();

        if (!objects.length) {
            list.innerHTML = '<div class="layers-empty">No layers yet. Add shapes or generate images.</div>';
            return;
        }

        list.innerHTML = objects.slice().reverse().map((obj, revIdx) => {
            const idx = objects.length - 1 - revIdx;
            const isActive = active === obj;
            const isVisible = obj.visible !== false;
            const isLocked = !!obj._locked;
            const name = obj.name || this._objectTypeName(obj.type) || `Layer ${idx}`;
            const typeBadge = this._objectTypeName(obj.type);
            const isTop = idx === objects.length - 1;
            const isBottom = idx === 0;

            return `
                <div class="layer-item ${isActive ? 'active' : ''}"
                     onclick="CanvasMgr.selectLayer(${idx})"
                     data-layer-index="${idx}">
                    <button class="layer-visibility ${isVisible ? '' : 'is-hidden'}"
                            onclick="event.stopPropagation(); CanvasMgr.toggleLayerVisibility(${idx})"
                            title="${isVisible ? 'Hide' : 'Show'}">
                        ${isVisible ? '\u25C9' : '\u25CB'}
                    </button>
                    <span class="layer-name" ondblclick="event.stopPropagation(); CanvasMgr.startRenameLayer(${idx}, this)"
                          title="Double-click to rename">${App._esc(name)}</span>
                    ${isLocked ? '<span class="layer-lock" title="Locked">\u{1F512}</span>' : ''}
                    <span class="layer-type">${typeBadge}</span>
                    <div class="layer-reorder" onclick="event.stopPropagation()">
                        <button class="layer-reorder-btn ${isTop ? 'disabled' : ''}" onclick="CanvasMgr.moveLayerUp(${idx})" title="Move up">\u25B2</button>
                        <button class="layer-reorder-btn ${isBottom ? 'disabled' : ''}" onclick="CanvasMgr.moveLayerDown(${idx})" title="Move down">\u25BC</button>
                    </div>
                </div>
            `;
        }).join('');
    },

    selectLayer(index) {
        if (!this.canvas) return;
        const obj = this.canvas.item(index);
        if (obj) {
            this.canvas.setActiveObject(obj);
            this.canvas.renderAll();
            this.updateProperties();
            this.updateLayersList();
        }
    },

    startRenameLayer(index, spanEl) {
        const obj = this.canvas ? this.canvas.item(index) : null;
        if (!obj) return;

        const currentName = obj.name || this._objectTypeName(obj.type) || `Layer ${index}`;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'layer-rename-input';
        input.value = currentName;

        const finish = () => {
            const newName = input.value.trim();
            if (newName && newName !== currentName) {
                obj.set('name', newName);
                this.canvas.renderAll();
            }
            this.updateLayersList();
        };

        input.addEventListener('blur', finish);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
            if (e.key === 'Escape') { input.value = currentName; input.blur(); }
        });
        input.addEventListener('click', (e) => e.stopPropagation());

        spanEl.replaceWith(input);
        input.focus();
        input.select();
    },

    toggleLayerVisibility(index) {
        if (!this.canvas) return;
        const obj = this.canvas.item(index);
        if (obj) {
            obj.set('visible', !obj.visible);
            this.canvas.renderAll();
            this.updateLayersList();
        }
    },

    _objectTypeName(type) {
        const map = {
            'i-text': 'Text',
            'text': 'Text',
            'textbox': 'Text',
            'rect': 'Rect',
            'circle': 'Circle',
            'triangle': 'Tri',
            'image': 'Img',
            'path': 'Path',
            'group': 'Group',
            'polygon': 'Poly',
            'line': 'Line',
            'ellipse': 'Ellipse',
        };
        return map[type] || type || 'Object';
    },

    // -- Properties Panel -----------------------------------------------------

    updateProperties() {
        const el = document.getElementById('props-content');
        if (!el || !this.canvas) return;

        const obj = this.canvas.getActiveObject();
        if (!obj) {
            this.clearProperties();
            return;
        }

        App.switchRightTab('properties');

        const left = Math.round(obj.left || 0);
        const top = Math.round(obj.top || 0);
        const width = Math.round((obj.width || 0) * (obj.scaleX || 1));
        const height = Math.round((obj.height || 0) * (obj.scaleY || 1));
        const angle = Math.round(obj.angle || 0);
        const opacity = Math.round((obj.opacity ?? 1) * 100);
        const fill = obj.fill || '#000000';
        const fillHex = typeof fill === 'string' ? fill : '#000000';

        const isLocked = !!obj._locked;
        const isMultiSelect = obj.type === 'activeSelection';

        el.innerHTML = `
            <div class="props-section">
                <div class="props-section-title">Position & Size</div>
                <div class="props-row">
                    <div class="props-field">
                        <label>X</label>
                        <input type="number" value="${left}" onchange="CanvasMgr.setProp('left', +this.value)" />
                    </div>
                    <div class="props-field">
                        <label>Y</label>
                        <input type="number" value="${top}" onchange="CanvasMgr.setProp('top', +this.value)" />
                    </div>
                </div>
                <div class="props-row">
                    <div class="props-field">
                        <label>W</label>
                        <input type="number" value="${width}" onchange="CanvasMgr.setSize('width', +this.value)" />
                    </div>
                    <div class="props-field">
                        <label>H</label>
                        <input type="number" value="${height}" onchange="CanvasMgr.setSize('height', +this.value)" />
                    </div>
                </div>
                <div class="props-row">
                    <div class="props-field">
                        <label>Rotation</label>
                        <input type="number" value="${angle}" min="0" max="360"
                               onchange="CanvasMgr.setProp('angle', +this.value)" />
                    </div>
                    <div class="props-field props-transform-btns">
                        <label>Transform</label>
                        <div class="props-btn-row">
                            <button class="btn btn-icon btn-sm" onclick="CanvasMgr.flipH()" title="Flip Horizontal">\u21C4</button>
                            <button class="btn btn-icon btn-sm" onclick="CanvasMgr.flipV()" title="Flip Vertical">\u21C5</button>
                            <button class="btn btn-icon btn-sm ${isLocked ? 'active' : ''}" onclick="CanvasMgr.toggleLock()" title="Lock/Unlock (Ctrl+L)">${isLocked ? '\u{1F512}' : '\u{1F513}'}</button>
                        </div>
                    </div>
                </div>
            </div>

            ${isMultiSelect ? `
            <div class="props-section">
                <div class="props-section-title">Alignment</div>
                <div class="align-toolbar">
                    <button class="btn btn-icon btn-sm align-btn" onclick="CanvasMgr.alignObjects('left')" title="Align Left">\u258C</button>
                    <button class="btn btn-icon btn-sm align-btn" onclick="CanvasMgr.alignObjects('center')" title="Align Center H">\u2503</button>
                    <button class="btn btn-icon btn-sm align-btn" onclick="CanvasMgr.alignObjects('right')" title="Align Right">\u2590</button>
                    <span class="toolbar-divider"></span>
                    <button class="btn btn-icon btn-sm align-btn" onclick="CanvasMgr.alignObjects('top')" title="Align Top">\u2580</button>
                    <button class="btn btn-icon btn-sm align-btn" onclick="CanvasMgr.alignObjects('middle')" title="Align Center V">\u2501</button>
                    <button class="btn btn-icon btn-sm align-btn" onclick="CanvasMgr.alignObjects('bottom')" title="Align Bottom">\u2584</button>
                </div>
            </div>
            ` : ''}

            <div class="props-section">
                <div class="props-section-title">Appearance</div>
                <div class="form-group">
                    <label>Fill Color</label>
                    <div class="props-color">
                        <input type="color" value="${fillHex}"
                               onchange="CanvasMgr.setProp('fill', this.value)" />
                        <input type="text" value="${fillHex}"
                               onchange="CanvasMgr.setProp('fill', this.value)" />
                    </div>
                </div>
                <div class="form-group">
                    <label>Opacity</label>
                    <div class="prop-opacity-row">
                        <input type="range" min="0" max="100" value="${opacity}"
                               oninput="CanvasMgr.setProp('opacity', this.value / 100); this.nextElementSibling.textContent = this.value + '%'" />
                        <span class="prop-opacity-val">${opacity}%</span>
                    </div>
                </div>
            </div>

            <div class="props-section">
                <button class="btn btn-danger btn-sm btn-block prop-delete-btn"
                        onclick="CanvasMgr.deleteSelected()">Delete Object</button>
            </div>
        `;
    },

    clearProperties() {
        const el = document.getElementById('props-content');
        if (el) {
            el.innerHTML = '<p class="muted">Select an object to see properties</p>';
        }
    },

    setProp(prop, value) {
        if (!this.canvas) return;
        const obj = this.canvas.getActiveObject();
        if (!obj) return;
        obj.set(prop, value);
        obj.setCoords();
        this.canvas.renderAll();
        this.saveState();
    },

    setSize(dim, value) {
        if (!this.canvas) return;
        const obj = this.canvas.getActiveObject();
        if (!obj) return;

        if (dim === 'width') {
            obj.set('scaleX', value / (obj.width || 1));
        } else {
            obj.set('scaleY', value / (obj.height || 1));
        }
        obj.setCoords();
        this.canvas.renderAll();
        this.saveState();
    },

    deleteSelected() {
        if (!this.canvas) return;
        const active = this.canvas.getActiveObjects();
        if (!active.length) return;

        active.forEach(obj => this.canvas.remove(obj));
        this.canvas.discardActiveObject();
        this.canvas.renderAll();
        this.saveState();
        this.clearProperties();
    },

    // -- Keyboard Shortcuts ---------------------------------------------------

    setupKeyboard() {
        if (this._keyHandler) {
            document.removeEventListener('keydown', this._keyHandler);
        }

        this._keyHandler = (e) => {
            const tag = e.target.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;

            // Only process when editor view is visible
            if (document.getElementById('editor-view')?.style.display === 'none') return;

            const ctrl = e.ctrlKey || e.metaKey;

            // -- Ctrl shortcuts --
            if (ctrl && !e.shiftKey && e.key === 'z') {
                e.preventDefault(); this.undo(); return;
            }
            if ((ctrl && e.key === 'y') || (ctrl && e.shiftKey && e.key === 'z') || (ctrl && e.shiftKey && e.key === 'Z')) {
                e.preventDefault(); this.redo(); return;
            }
            if (ctrl && e.key === 's') {
                e.preventDefault(); this.save(); return;
            }

            // Clipboard
            if (ctrl && e.key === 'c') {
                e.preventDefault(); Clipboard.copy(); return;
            }
            if (ctrl && e.key === 'x') {
                e.preventDefault(); Clipboard.cut(); return;
            }
            if (ctrl && e.key === 'v') {
                e.preventDefault();
                // Try object paste first, fall back to image paste
                if (!Clipboard.paste()) {
                    // Let _handlePaste handle image paste
                }
                return;
            }
            if (ctrl && e.key === 'd') {
                e.preventDefault(); Clipboard.duplicate(); return;
            }

            // Group / Ungroup
            if (ctrl && !e.shiftKey && e.key === 'g') {
                e.preventDefault(); this.groupSelected(); return;
            }
            if (ctrl && e.shiftKey && (e.key === 'g' || e.key === 'G')) {
                e.preventDefault(); this.ungroupSelected(); return;
            }

            // Lock
            if (ctrl && e.key === 'l') {
                e.preventDefault(); this.toggleLock(); return;
            }

            // Grid toggles
            if (ctrl && e.key === ';') {
                e.preventDefault(); Grid.toggleSnap(); return;
            }
            if (ctrl && e.key === "'") {
                e.preventDefault(); Grid.toggleRulers(); return;
            }

            // Zoom
            if (ctrl && e.key === '0') { e.preventDefault(); this.zoomReset(); return; }
            if (ctrl && (e.key === '=' || e.key === '+')) { e.preventDefault(); this.zoomIn(); return; }
            if (ctrl && e.key === '-') { e.preventDefault(); this.zoomOut(); return; }

            // -- Non-ctrl shortcuts --
            if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault(); this.deleteSelected(); return;
            }

            if (e.key === 'Escape') {
                // Cancel crop if active
                if (Tools._cropRect) { Tools.cancelCrop(); return; }
                // Cancel AI edit region select
                if (AIEdit._isSelecting) { AIEdit.clearSelection(); return; }
                // Return to select tool
                this.setTool('select');
                return;
            }

            // Enter to confirm crop
            if (e.key === 'Enter' && Tools._cropRect) {
                e.preventDefault(); Tools.applyCrop(); return;
            }

            // Brush size
            if (e.key === '[') {
                if (this.activeTool === 'pen' || this.activeTool === 'eraser') {
                    Tools.decreaseBrushSize();
                }
                return;
            }
            if (e.key === ']') {
                if (this.activeTool === 'pen' || this.activeTool === 'eraser') {
                    Tools.increaseBrushSize();
                }
                return;
            }

            // Tool shortcuts (single key, no ctrl)
            if (e.key === 'v' || e.key === 'V') { this.setTool('select'); return; }
            if (e.key === 'h' && !ctrl) { this.setTool('hand'); return; }
            if (e.key === 't' && !ctrl) { this.addText(); return; }
            if (e.key === 'r' && !ctrl) { this.addRect(); return; }
            if (e.key === 'c' && !ctrl) { this.addCircle(); return; }
            if (e.key === 'l' && !ctrl) { this.setTool('line'); return; }
            if (e.key === 'a' && !ctrl) { this.setTool('arrow'); return; }
            if (e.key === 'b' && !ctrl) { this.setTool('pen'); return; }
            if (e.key === 'e' && !ctrl) { this.setTool('eraser'); return; }
            if (e.key === 'p' && !ctrl) { this.setTool('eyedropper'); return; }
            if (e.key === 'k' && !ctrl) { this.setTool('crop'); return; }
            if (e.key === 'i' && !ctrl) { this.importFromFile(); return; }
            if (e.key === 'g' && !ctrl) { Grid.toggleGrid(); return; }

            // Shift+S for AI Edit region select
            if (e.shiftKey && (e.key === 's' || e.key === 'S') && !ctrl) {
                AIEdit.startRegionSelect(); return;
            }
        };

        document.addEventListener('keydown', this._keyHandler);
    },
};
