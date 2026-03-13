/**
 * OPAI Studio — Main Application Controller
 *
 * Handles authentication, project management, routing, export, and
 * coordinating the canvas and generation panels.
 */

const App = {
    // ── State ────────────────────────────────────────────────────────────────
    _supabase: null,
    _session: null,

    state: {
        user: null,
        token: null,
        projects: [],
        currentProject: null,
        currentImage: null,
        images: [],
    },

    // ── Initialization ───────────────────────────────────────────────────────

    /**
     * Bootstrap: create Supabase client, pick up existing Portal session,
     * redirect to /auth/login if not authenticated.
     */
    // Base path for all API calls (Caddy handle_path strips /studio/)
    BASE: '/studio',

    async init() {
        try {
            // Fetch Supabase config from backend
            const configResp = await fetch(this.BASE + '/api/auth-config');
            if (!configResp.ok) throw new Error('Failed to load auth config');
            const cfg = await configResp.json();

            // Create Supabase client — shares session with Portal via localStorage
            this._supabase = window.supabase.createClient(cfg.supabase_url, cfg.supabase_anon_key);

            // Pick up existing session (set by Portal login)
            const { data: { session }, error } = await this._supabase.auth.getSession();

            if (error || !session) {
                // No session — redirect to Portal login with return URL
                const returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
                window.location.href = `/auth/login?return=${returnUrl}`;
                return;
            }

            // Session found — store and enter app
            this._session = session;
            this.state.token = session.access_token;
            this.state.user = session.user;

            // Listen for session changes (token refresh, sign out)
            this._supabase.auth.onAuthStateChange((_event, sess) => {
                if (!sess) {
                    window.location.href = '/auth/login';
                    return;
                }
                this._session = sess;
                this.state.token = sess.access_token;
                this.state.user = sess.user;
            });

            this._hideLoading();
            await this._enterApp();
        } catch (err) {
            console.error('[Studio] Init error:', err);
            window.location.href = '/auth/login?return=' + encodeURIComponent(window.location.pathname);
        }
    },

    // ── Auth ─────────────────────────────────────────────────────────────────

    /**
     * Log out via Supabase and redirect to Portal login.
     */
    async logout() {
        if (this._supabase) {
            await this._supabase.auth.signOut();
        }
        this.state.token = null;
        this.state.user = null;
        window.location.href = '/auth/login';
    },

    /**
     * Get a fresh access token (auto-refreshes if expired).
     */
    async _getToken() {
        if (!this._supabase) return this.state.token;
        const { data: { session } } = await this._supabase.auth.getSession();
        if (session) {
            this.state.token = session.access_token;
            return session.access_token;
        }
        return null;
    },

    // ── API Wrapper ──────────────────────────────────────────────────────────

    /**
     * Fetch wrapper that injects the Authorization header,
     * auto-refreshes the token, and handles 401 → redirect.
     */
    async apiFetch(path, opts = {}) {
        // Get fresh token (handles auto-refresh)
        const token = await this._getToken();

        const headers = opts.headers || {};
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }
        if (!headers['Content-Type'] && !(opts.body instanceof FormData)) {
            headers['Content-Type'] = 'application/json';
        }

        // Prepend base path for Caddy reverse proxy
        const url = this.BASE + path;
        const resp = await fetch(url, { ...opts, headers });

        if (resp.status === 401) {
            this.toast('Session expired. Redirecting to login...', 'warning');
            setTimeout(() => { window.location.href = '/auth/login'; }, 1000);
            throw new Error('Unauthorized');
        }

        return resp;
    },

    /**
     * Convenience wrapper: apiFetch + parse JSON.
     */
    async apiJSON(path, opts = {}) {
        const resp = await this.apiFetch(path, opts);
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({ detail: resp.statusText }));
            throw new Error(err.detail || err.error || 'API error');
        }
        return resp.json();
    },

    // ── Routing ──────────────────────────────────────────────────────────────

    /**
     * Show one screen by ID, hide all others.
     */
    showScreen(screenId) {
        document.querySelectorAll('.screen').forEach(s => {
            s.style.display = 'none';
        });
        const target = document.getElementById(screenId);
        if (target) {
            target.style.display = '';
            target.classList.add('fade-in');
        }
    },

    _hideLoading() {
        const el = document.getElementById('loading-screen');
        if (el) el.style.display = 'none';
    },

    /**
     * Enter the main app after successful auth.
     */
    async _enterApp() {
        // Display user email in the top bar
        const emailEl = document.getElementById('user-email');
        if (emailEl && this.state.user) {
            emailEl.textContent = this.state.user.email || '';
        }
        this.showScreen('projects-view');
        await this.loadProjects();
    },

    // ── Projects ─────────────────────────────────────────────────────────────

    /**
     * Fetch all projects from the backend and render them.
     */
    async loadProjects() {
        try {
            const projects = await this.apiJSON('/api/projects?limit=100');
            this.state.projects = projects;
            this.renderProjects();
        } catch (err) {
            console.error('[Studio] Load projects error:', err);
            this.toast('Failed to load projects.', 'error');
        }
    },

    /**
     * Render the project cards grid.
     */
    renderProjects() {
        const grid = document.getElementById('projects-grid');
        if (!grid) return;

        if (!this.state.projects.length) {
            grid.innerHTML = `
                <div class="projects-empty">
                    <div class="empty-icon">&#127912;</div>
                    <p>No projects yet. Create one to get started.</p>
                    <button class="btn btn-primary" onclick="App.createProject()">+ New Project</button>
                </div>
            `;
            return;
        }

        grid.innerHTML = this.state.projects.map(p => `
            <div class="project-card" onclick="App.openProject('${p.id}')">
                <div class="project-card-thumb">
                    ${p.thumbnail_url
                        ? `<img src="${p.thumbnail_url}" alt="${this._esc(p.name)}" />`
                        : `<span class="placeholder-icon">&#127912;</span>`
                    }
                </div>
                <div class="project-card-body">
                    <div class="project-card-name">${this._esc(p.name)}</div>
                    <div class="project-card-meta">
                        <span class="project-card-date">${this._relativeDate(p.updated_at)}</span>
                        <button class="btn btn-icon btn-danger project-card-delete"
                                onclick="event.stopPropagation(); App.deleteProject('${p.id}')"
                                title="Delete project">&times;</button>
                    </div>
                </div>
            </div>
        `).join('');
    },

    /**
     * Prompt for a name and create a new project.
     */
    async createProject() {
        const name = prompt('Project name:', 'Untitled Project');
        if (!name) return;

        try {
            const project = await this.apiJSON('/api/projects', {
                method: 'POST',
                body: JSON.stringify({ name }),
            });
            this.toast(`Project "${name}" created.`, 'success');
            await this.loadProjects();
        } catch (err) {
            this.toast(`Failed to create project: ${err.message}`, 'error');
        }
    },

    /**
     * Confirm and delete a project.
     */
    async deleteProject(id) {
        const project = this.state.projects.find(p => p.id === id);
        const name = project ? project.name : 'this project';
        if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;

        try {
            await this.apiFetch(`/api/projects/${id}`, { method: 'DELETE' });
            this.toast('Project deleted.', 'success');
            await this.loadProjects();
        } catch (err) {
            this.toast(`Failed to delete project: ${err.message}`, 'error');
        }
    },

    /**
     * Open a project: set it as current and switch to the editor.
     */
    async openProject(id) {
        try {
            const project = await this.apiJSON(`/api/projects/${id}`);
            this.state.currentProject = project;
            document.getElementById('editor-project-name').textContent = project.name;

            // Switch to editor view
            this.showScreen('editor-view');

            // Load images for this project
            await this.loadImages();

            // If the project has images, open the first one; otherwise create one
            if (this.state.images.length > 0) {
                await this.openImage(this.state.images[0].id);
            } else {
                await this.createImage();
            }
        } catch (err) {
            this.toast(`Failed to open project: ${err.message}`, 'error');
        }
    },

    /**
     * Return to the projects browser from the editor.
     */
    async goToProjects() {
        // Auto-save canvas before leaving
        if (this.state.currentImage && CanvasMgr.canvas) {
            try {
                await CanvasMgr.save(true); // silent save
            } catch { /* ignore save errors on navigation */ }
        }
        this.state.currentProject = null;
        this.state.currentImage = null;
        this.state.images = [];
        this.showScreen('projects-view');
        await this.loadProjects();
    },

    // ── Images ───────────────────────────────────────────────────────────────

    /**
     * Load all images for the current project.
     */
    async loadImages() {
        if (!this.state.currentProject) return;
        try {
            const images = await this.apiJSON(
                `/api/projects/${this.state.currentProject.id}/images?limit=200`
            );
            this.state.images = images;
            this.renderImagesList();
        } catch (err) {
            console.error('[Studio] Load images error:', err);
        }
    },

    /**
     * Render the image list in the left panel (Images tab).
     */
    renderImagesList() {
        const list = document.getElementById('images-list');
        if (!list) return;

        if (!this.state.images.length) {
            list.innerHTML = '<div class="images-empty">No images in this project.</div>';
            return;
        }

        list.innerHTML = this.state.images.map(img => {
            const isActive = this.state.currentImage && this.state.currentImage.id === img.id;
            return `
                <div class="image-item ${isActive ? 'active' : ''}"
                     onclick="App.openImage('${img.id}')">
                    <div class="image-item-icon">
                        ${img.thumbnail_key
                            ? `<img src="${App.BASE}/api/assets/${img.thumbnail_key}" alt="" />`
                            : '&#9634;'
                        }
                    </div>
                    <div class="image-item-info">
                        <div class="image-item-name">${this._esc(img.name)}</div>
                        <div class="image-item-dims">${img.width || 1024} &times; ${img.height || 1024}</div>
                    </div>
                </div>
            `;
        }).join('');
    },

    /**
     * Create a new blank image in the current project and open it.
     */
    async createImage() {
        if (!this.state.currentProject) return;

        try {
            const image = await this.apiJSON(
                `/api/projects/${this.state.currentProject.id}/images`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        name: 'Untitled',
                        width: 1024,
                        height: 1024,
                    }),
                }
            );
            await this.loadImages();
            await this.openImage(image.id);
            this.toast('New image created.', 'success');
        } catch (err) {
            this.toast(`Failed to create image: ${err.message}`, 'error');
        }
    },

    /**
     * Open a specific image: load its data, initialize the canvas, and
     * set up the generation panel.
     */
    async openImage(id) {
        try {
            const image = await this.apiJSON(`/api/images/${id}`);
            this.state.currentImage = image;

            // Update UI
            const nameEl = document.getElementById('editor-image-name');
            if (nameEl) nameEl.textContent = image.name || 'Untitled';
            document.getElementById('canvas-size').textContent =
                `${image.width || 1024} \u00d7 ${image.height || 1024}`;

            // Initialize or reload the canvas
            CanvasMgr.init(image.width || 1024, image.height || 1024);
            if (image.canvas_json) {
                CanvasMgr.loadJSON(image.canvas_json);
            }

            // Initialize the generation panel and AI Edit panel
            GeneratePanel.init();
            AIEdit.init();

            // Update the image list to reflect active state
            this.renderImagesList();
        } catch (err) {
            this.toast(`Failed to open image: ${err.message}`, 'error');
        }
    },

    // ── Editor Tabs ──────────────────────────────────────────────────────────

    /**
     * Switch active tab in the left panel.
     */
    switchLeftTab(tab) {
        // Toggle panel-tab active class
        document.querySelectorAll('.panel-left .panel-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.panel === tab);
        });
        // Toggle tab-panel visibility
        document.getElementById('layers-panel').style.display = tab === 'layers' ? '' : 'none';
        document.getElementById('layers-panel').classList.toggle('active', tab === 'layers');
        document.getElementById('images-panel').style.display = tab === 'images' ? '' : 'none';
        document.getElementById('images-panel').classList.toggle('active', tab === 'images');
    },

    /**
     * Switch active tab in the right panel.
     */
    switchRightTab(tab) {
        document.querySelectorAll('.panel-right .panel-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.panel === tab);
        });
        document.getElementById('generate-panel').style.display = tab === 'generate' ? '' : 'none';
        document.getElementById('generate-panel').classList.toggle('active', tab === 'generate');
        const aiEditPanel = document.getElementById('ai-edit-panel');
        if (aiEditPanel) {
            aiEditPanel.style.display = tab === 'ai-edit' ? '' : 'none';
            aiEditPanel.classList.toggle('active', tab === 'ai-edit');
            if (tab === 'ai-edit') AIEdit.render();
        }
        document.getElementById('properties-panel').style.display = tab === 'properties' ? '' : 'none';
        document.getElementById('properties-panel').classList.toggle('active', tab === 'properties');
    },

    // ── Export ────────────────────────────────────────────────────────────────

    showExport() {
        document.getElementById('export-modal').style.display = '';
    },

    closeExport() {
        document.getElementById('export-modal').style.display = 'none';
    },

    // ── Canvas Settings ─────────────────────────────────────────────────────

    showCanvasSettings() {
        const modal = document.getElementById('canvas-settings-modal');
        if (!modal) return;
        document.getElementById('canvas-width-input').value = CanvasMgr.width;
        document.getElementById('canvas-height-input').value = CanvasMgr.height;
        modal.style.display = '';
    },

    closeCanvasSettings() {
        const modal = document.getElementById('canvas-settings-modal');
        if (modal) modal.style.display = 'none';
    },

    setCanvasPreset(w, h) {
        document.getElementById('canvas-width-input').value = w;
        document.getElementById('canvas-height-input').value = h;
    },

    applyCanvasSettings() {
        const w = parseInt(document.getElementById('canvas-width-input').value, 10);
        const h = parseInt(document.getElementById('canvas-height-input').value, 10);
        if (!w || !h || w < 100 || h < 100 || w > 8192 || h > 8192) {
            this.toast('Canvas size must be between 100 and 8192 pixels.', 'warning');
            return;
        }
        CanvasMgr.resizeCanvas(w, h);
        this.closeCanvasSettings();
        this.toast(`Canvas resized to ${w} x ${h}`, 'success');
    },

    /**
     * Export the canvas as a downloadable image file.
     */
    doExport() {
        if (!CanvasMgr.canvas) {
            this.toast('No canvas to export.', 'error');
            return;
        }

        const format = document.getElementById('export-format').value;
        const quality = parseInt(document.getElementById('export-quality').value, 10) / 100;
        const scale = parseInt(document.getElementById('export-scale').value, 10);

        const dataURL = CanvasMgr.canvas.toDataURL({
            format,
            quality,
            multiplier: scale,
        });

        // Trigger browser download
        const link = document.createElement('a');
        const imageName = this.state.currentImage
            ? this.state.currentImage.name.replace(/\s+/g, '_')
            : 'export';
        link.download = `${imageName}.${format}`;
        link.href = dataURL;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        this.closeExport();
        this.toast(`Exported as ${format.toUpperCase()} at ${scale}x.`, 'success');
    },

    // ── Toast Notifications ──────────────────────────────────────────────────

    /**
     * Show a temporary toast notification.
     * @param {string} message - The message to display
     * @param {'info'|'success'|'error'|'warning'} type - Toast type
     * @param {number} duration - Duration in ms (default 3500)
     */
    toast(message, type = 'info', duration = 3500) {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const icons = {
            info: '\u2139\ufe0f',
            success: '\u2714',
            error: '\u2716',
            warning: '\u26a0',
        };

        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.innerHTML = `
            <span class="toast-icon">${icons[type] || icons.info}</span>
            <span>${this._esc(message)}</span>
        `;
        container.appendChild(el);

        // Auto-dismiss
        setTimeout(() => {
            el.classList.add('toast-out');
            el.addEventListener('animationend', () => el.remove());
        }, duration);
    },

    // ── Helpers ───────────────────────────────────────────────────────────────

    /**
     * Escape HTML to prevent XSS in dynamic content.
     */
    _esc(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    },

    /**
     * Format a date string into a human-friendly relative form.
     */
    _relativeDate(dateStr) {
        if (!dateStr) return '';
        const d = new Date(dateStr);
        const now = new Date();
        const diff = now - d;
        const mins = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);

        if (mins < 1) return 'Just now';
        if (mins < 60) return `${mins}m ago`;
        if (hours < 24) return `${hours}h ago`;
        if (days < 7) return `${days}d ago`;
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    },
};


// ── Bootstrap ────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => App.init());

// Handle inline image name editing (contenteditable)
document.addEventListener('DOMContentLoaded', () => {
    const nameEl = document.getElementById('editor-image-name');
    if (nameEl) {
        nameEl.addEventListener('blur', async () => {
            const newName = nameEl.textContent.trim();
            if (!newName || !App.state.currentImage) return;
            if (newName === App.state.currentImage.name) return;

            try {
                await App.apiFetch(`/api/images/${App.state.currentImage.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ name: newName }),
                });
                App.state.currentImage.name = newName;
                App.renderImagesList();
            } catch (err) {
                App.toast('Failed to rename image.', 'error');
                nameEl.textContent = App.state.currentImage.name;
            }
        });

        nameEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                nameEl.blur();
            }
        });
    }
});
