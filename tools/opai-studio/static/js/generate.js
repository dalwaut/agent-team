/**
 * OPAI Studio -- AI Generation Panel
 *
 * Manages the image generation form, model selection, API calls,
 * result previews, daily usage tracking, and recent generation history.
 */

const GeneratePanel = {
    /** Available models and options from the backend */
    models: [],
    aspectRatios: ['1:1', '3:4', '4:3', '9:16', '16:9'],
    imageSizes: ['512px', '1K', '2K', '4K'],

    /** Recent generations for the current session */
    recentGenerations: [],
    _maxRecent: 6,

    /** Loading state */
    _generating: false,

    /** Usage tracking */
    _usage: { used: 0, limit: 50, remaining: 50 },
    _overrideLimit: false,

    // -- Initialization -------------------------------------------------------

    async init() {
        try {
            const [modelData, usageData] = await Promise.all([
                App.apiJSON('/api/generate/models'),
                App.apiJSON('/api/generate/usage'),
            ]);
            this.models = modelData.models || [];
            this.aspectRatios = modelData.aspect_ratios || this.aspectRatios;
            this.imageSizes = modelData.image_sizes || this.imageSizes;
            this._usage = usageData;
        } catch (err) {
            console.warn('[Studio] Failed to fetch models/usage:', err);
        }

        this.render();
    },

    // -- Rendering ------------------------------------------------------------

    render() {
        const container = document.getElementById('generate-content');
        if (!container) return;

        const modelOpts = this.models.length
            ? this.models.map(m => {
                const label = typeof m === 'object' ? (m.label || m.name || m.id) : m;
                const value = typeof m === 'object' ? (m.id || m.name) : m;
                return `<option value="${App._esc(value)}">${App._esc(label)}</option>`;
            }).join('')
            : `<option value="nano-banana-2">Nano Banana 2</option>
               <option value="nano-banana-pro">Nano Banana Pro</option>
               <option value="nano-banana">Nano Banana</option>`;

        const arOpts = this.aspectRatios.map(ar =>
            `<option value="${ar}">${ar}</option>`
        ).join('');

        const sizeOpts = this.imageSizes.map(s =>
            `<option value="${s}" ${s === '2K' ? 'selected' : ''}>${s}</option>`
        ).join('');

        const u = this._usage;
        const atLimit = u.used >= u.limit;
        const usageClass = atLimit ? 'usage-at-limit' : (u.remaining <= 10 ? 'usage-low' : '');

        container.innerHTML = `
            <div class="gen-form">
                <div class="gen-usage ${usageClass}">
                    <span class="gen-usage-count">${u.used} / ${u.limit}</span>
                    <span class="gen-usage-label">today</span>
                    <label class="gen-override-toggle" title="Override daily limit and keep generating">
                        <input type="checkbox" id="gen-override"
                               ${this._overrideLimit ? 'checked' : ''}
                               onchange="GeneratePanel.toggleOverride(this.checked)">
                        <span class="toggle-slider"></span>
                        <span class="toggle-label">Override</span>
                    </label>
                </div>

                <div class="form-group gen-prompt">
                    <label>Prompt</label>
                    <textarea id="gen-prompt" rows="5"
                              placeholder="Describe the image you want to generate..."></textarea>
                </div>

                <div class="form-group">
                    <label>Model</label>
                    <select id="gen-model">${modelOpts}</select>
                </div>

                <div class="form-row">
                    <div class="form-group">
                        <label>Aspect Ratio</label>
                        <select id="gen-aspect">${arOpts}</select>
                    </div>
                    <div class="form-group">
                        <label>Size</label>
                        <select id="gen-size">${sizeOpts}</select>
                    </div>
                </div>

                <div class="gen-actions">
                    <button class="btn btn-primary btn-block gen-btn" id="gen-btn-generate"
                            onclick="GeneratePanel.generate(false)">
                        <span class="gen-btn-text">Generate</span>
                        <span class="gen-btn-spinner"></span>
                    </button>
                    <button class="btn btn-block gen-btn" id="gen-btn-add"
                            onclick="GeneratePanel.generate(true)">
                        <span class="gen-btn-text">Generate &amp; Add to Canvas</span>
                        <span class="gen-btn-spinner"></span>
                    </button>
                </div>

                <div id="gen-preview-area"></div>

                <div id="gen-recent-area"></div>
            </div>
        `;

        this._renderRecent();

        const promptEl = document.getElementById('gen-prompt');
        if (promptEl) {
            promptEl.addEventListener('keydown', (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    this.generate(false);
                }
            });
        }
    },

    // -- Override Toggle ------------------------------------------------------

    toggleOverride(checked) {
        this._overrideLimit = checked;
        // Update UI state without full re-render
        const usageEl = document.querySelector('.gen-usage');
        if (usageEl) {
            if (checked) {
                usageEl.classList.remove('usage-at-limit');
                usageEl.classList.add('usage-override');
            } else {
                usageEl.classList.remove('usage-override');
                if (this._usage.used >= this._usage.limit) {
                    usageEl.classList.add('usage-at-limit');
                }
            }
        }
    },

    // -- Usage Display --------------------------------------------------------

    _updateUsage(usageData) {
        if (!usageData) return;
        this._usage = usageData;
        const countEl = document.querySelector('.gen-usage-count');
        const wrapEl = document.querySelector('.gen-usage');
        if (countEl) {
            countEl.textContent = `${usageData.used} / ${usageData.limit}`;
        }
        if (wrapEl) {
            wrapEl.classList.remove('usage-at-limit', 'usage-low');
            if (this._overrideLimit) {
                wrapEl.classList.add('usage-override');
            } else if (usageData.used >= usageData.limit) {
                wrapEl.classList.add('usage-at-limit');
            } else if (usageData.remaining <= 10) {
                wrapEl.classList.add('usage-low');
            }
        }
    },

    // -- Generation -----------------------------------------------------------

    async generate(addToCanvas = false) {
        if (this._generating) return;

        const prompt = (document.getElementById('gen-prompt')?.value || '').trim();
        const model = document.getElementById('gen-model')?.value || 'nano-banana-2';
        const aspectRatio = document.getElementById('gen-aspect')?.value || '1:1';
        const imageSize = document.getElementById('gen-size')?.value || '2K';

        if (!prompt) {
            App.toast('Please enter a prompt.', 'warning');
            document.getElementById('gen-prompt')?.focus();
            return;
        }

        this._generating = true;
        this._setButtonLoading(true);

        try {
            const payload = {
                prompt,
                model,
                aspect_ratio: aspectRatio,
                image_size: imageSize,
                override_limit: this._overrideLimit,
            };

            if (App.state.currentImage) {
                payload.image_id = App.state.currentImage.id;
            }
            if (App.state.currentProject) {
                payload.project_id = App.state.currentProject.id;
            }

            const result = await App.apiJSON('/api/generate', {
                method: 'POST',
                body: JSON.stringify(payload),
            });

            // Update usage counter from response
            if (result.usage) {
                this._updateUsage(result.usage);
            }

            if (addToCanvas && result.image_b64) {
                CanvasMgr.addImageFromB64(result.image_b64, 'AI Generated');
            }

            this._showPreview(result);
            this._addToRecent(result);

            const durationSec = result.duration_ms
                ? (result.duration_ms / 1000).toFixed(1)
                : '?';
            App.toast(
                `Image generated in ${durationSec}s using ${result.model || model}.`,
                'success'
            );
        } catch (err) {
            console.error('[Studio] Generation error:', err);
            App.toast(`Generation failed: ${err.message}`, 'error');
        } finally {
            this._generating = false;
            this._setButtonLoading(false);
        }
    },

    // -- Loading State --------------------------------------------------------

    _setButtonLoading(loading) {
        const btnGenerate = document.getElementById('gen-btn-generate');
        const btnAdd = document.getElementById('gen-btn-add');

        [btnGenerate, btnAdd].forEach(btn => {
            if (!btn) return;
            if (loading) {
                btn.classList.add('loading');
                btn.disabled = true;
            } else {
                btn.classList.remove('loading');
                btn.disabled = false;
            }
        });
    },

    // -- Preview --------------------------------------------------------------

    _showPreview(result) {
        const area = document.getElementById('gen-preview-area');
        if (!area || !result.image_b64) return;

        const src = result.image_b64.startsWith('data:')
            ? result.image_b64
            : `data:image/png;base64,${result.image_b64}`;

        area.innerHTML = `
            <div class="gen-preview">
                <img src="${src}" alt="Generated image" />
                <div class="gen-preview-actions">
                    <button class="btn btn-sm btn-primary" onclick="GeneratePanel.addPreviewToCanvas()">
                        Add to Canvas
                    </button>
                    <button class="btn btn-sm" onclick="GeneratePanel.downloadPreview()">
                        Download
                    </button>
                </div>
            </div>
            <div class="gen-info">
                ${result.model ? `Model: ${App._esc(result.model)}` : ''}
                ${result.duration_ms ? ` &middot; ${(result.duration_ms / 1000).toFixed(1)}s` : ''}
            </div>
        `;

        this._lastPreviewB64 = result.image_b64;
    },

    addPreviewToCanvas() {
        if (this._lastPreviewB64) {
            CanvasMgr.addImageFromB64(this._lastPreviewB64, 'AI Generated');
            App.toast('Image added to canvas.', 'success');
        }
    },

    downloadPreview() {
        if (!this._lastPreviewB64) return;

        const src = this._lastPreviewB64.startsWith('data:')
            ? this._lastPreviewB64
            : `data:image/png;base64,${this._lastPreviewB64}`;

        const link = document.createElement('a');
        link.download = `studio-gen-${Date.now()}.png`;
        link.href = src;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    },

    // -- Recent Generations ---------------------------------------------------

    _addToRecent(result) {
        if (!result.image_b64) return;

        this.recentGenerations.unshift({
            b64: result.image_b64,
            model: result.model,
            prompt: result.prompt_used,
            storage_key: result.storage_key,
            duration_ms: result.duration_ms,
            timestamp: Date.now(),
        });

        if (this.recentGenerations.length > this._maxRecent) {
            this.recentGenerations = this.recentGenerations.slice(0, this._maxRecent);
        }

        this._renderRecent();
    },

    _renderRecent() {
        const area = document.getElementById('gen-recent-area');
        if (!area) return;

        if (!this.recentGenerations.length) {
            area.innerHTML = '';
            return;
        }

        const thumbs = this.recentGenerations.map((gen, idx) => {
            const src = gen.b64.startsWith('data:')
                ? gen.b64
                : `data:image/png;base64,${gen.b64}`;
            return `
                <div class="gen-recent-thumb"
                     onclick="GeneratePanel.useRecent(${idx})"
                     title="${App._esc(gen.prompt || '')}">
                    <img src="${src}" alt="Recent generation" />
                </div>
            `;
        }).join('');

        area.innerHTML = `
            <div class="gen-recent-title">Recent Generations</div>
            <div class="gen-recent-grid">${thumbs}</div>
        `;
    },

    useRecent(index) {
        const gen = this.recentGenerations[index];
        if (!gen) return;

        CanvasMgr.addImageFromB64(gen.b64, 'AI Generated');
        App.toast('Image added to canvas.', 'success');
    },
};
