/**
 * OPAI Studio — Clipboard Manager
 *
 * Cut/Copy/Paste/Duplicate for Fabric.js canvas objects.
 * Uses internal buffer (not system clipboard) for object cloning.
 */

const Clipboard = {
    /** @type {fabric.Object|null} Internal clipboard buffer */
    _buffer: null,

    /**
     * Copy active object(s) to internal buffer.
     */
    copy() {
        const canvas = CanvasMgr.canvas;
        if (!canvas) return;
        const active = canvas.getActiveObject();
        if (!active) return;

        active.clone((cloned) => {
            this._buffer = cloned;
        }, ['name', 'selectable', 'evented']);
    },

    /**
     * Cut = copy + delete.
     */
    cut() {
        const canvas = CanvasMgr.canvas;
        if (!canvas) return;
        const active = canvas.getActiveObject();
        if (!active) return;

        this.copy();

        // Delete after copy
        if (active.type === 'activeSelection') {
            active.forEachObject((obj) => canvas.remove(obj));
            canvas.discardActiveObject();
        } else {
            canvas.remove(active);
        }
        canvas.renderAll();
        CanvasMgr.saveState();
        CanvasMgr.updateLayersList();
        CanvasMgr.clearProperties();
    },

    /**
     * Paste from internal buffer, offset +20px from original position.
     * Returns false if buffer is empty (caller can fall back to image paste).
     */
    paste() {
        if (!this._buffer) return false;

        const canvas = CanvasMgr.canvas;
        if (!canvas) return false;

        this._buffer.clone((cloned) => {
            canvas.discardActiveObject();

            if (cloned.type === 'activeSelection') {
                cloned.canvas = canvas;
                cloned.forEachObject((obj) => {
                    obj.set({
                        left: (obj.left || 0) + 20,
                        top: (obj.top || 0) + 20,
                    });
                    canvas.add(obj);
                });
                cloned.setCoords();
            } else {
                cloned.set({
                    left: (cloned.left || 0) + 20,
                    top: (cloned.top || 0) + 20,
                    evented: true,
                });
                canvas.add(cloned);
                canvas.setActiveObject(cloned);
            }

            // Update buffer position so next paste offsets further
            this._buffer.set({
                left: (this._buffer.left || 0) + 20,
                top: (this._buffer.top || 0) + 20,
            });

            canvas.renderAll();
            CanvasMgr.saveState();
            CanvasMgr.updateLayersList();
        }, ['name', 'selectable', 'evented']);

        return true;
    },

    /**
     * Duplicate = instant copy-paste (Ctrl+D).
     */
    duplicate() {
        const canvas = CanvasMgr.canvas;
        if (!canvas) return;
        const active = canvas.getActiveObject();
        if (!active) return;

        active.clone((cloned) => {
            canvas.discardActiveObject();

            if (cloned.type === 'activeSelection') {
                cloned.canvas = canvas;
                cloned.forEachObject((obj) => {
                    obj.set({
                        left: (obj.left || 0) + 20,
                        top: (obj.top || 0) + 20,
                    });
                    canvas.add(obj);
                });
                cloned.setCoords();
            } else {
                cloned.set({
                    left: (cloned.left || 0) + 20,
                    top: (cloned.top || 0) + 20,
                    evented: true,
                });
                canvas.add(cloned);
                canvas.setActiveObject(cloned);
            }

            canvas.renderAll();
            CanvasMgr.saveState();
            CanvasMgr.updateLayersList();
        }, ['name', 'selectable', 'evented']);
    },
};
