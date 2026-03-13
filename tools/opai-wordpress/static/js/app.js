/* OP WordPress — Main app logic, router, auth */

window.WP = {
    supabase: null,
    session: null,
    user: null,
    currentView: 'dashboard',
    currentSite: null,
    sites: [],

    // ── Init ──────────────────────────────────────────
    async init() {
        try {
            const resp = await fetch('api/auth/config');
            const cfg = await resp.json();
            if (!cfg.supabase_url || !cfg.supabase_anon_key) {
                document.getElementById('loading').innerHTML = '<p style="color:var(--red)">Auth not configured</p>';
                return;
            }

            WP.supabase = window.supabase.createClient(cfg.supabase_url, cfg.supabase_anon_key);
            const { data: { session } } = await WP.supabase.auth.getSession();

            if (!session) {
                window.location.href = '/auth/login?redirect=/wordpress/';
                return;
            }

            WP.session = session;
            WP.user = session.user;

            WP.supabase.auth.onAuthStateChange((_event, s) => {
                WP.session = s;
                if (!s) window.location.href = '/auth/login?redirect=/wordpress/';
            });

            document.getElementById('user-name').textContent = session.user.email;
            document.getElementById('loading').classList.add('hidden');
            document.getElementById('app-root').classList.remove('hidden');

            await WP.Sites.load();
            WP.navigate('dashboard');
        } catch (e) {
            document.getElementById('loading').innerHTML =
                '<p style="color:var(--red)">Failed to initialize: ' + e.message + '</p>';
        }
    },

    // ── Auth header ───────────────────────────────────
    authHeaders() {
        return {
            'Authorization': 'Bearer ' + (WP.session?.access_token || ''),
            'Content-Type': 'application/json',
        };
    },

    // ── API helper ────────────────────────────────────
    async api(path, opts = {}) {
        const resp = await fetch('api/' + path, {
            method: opts.method || 'GET',
            headers: WP.authHeaders(),
            body: opts.body ? JSON.stringify(opts.body) : undefined,
        });
        if (!resp.ok) {
            const err = await resp.text();
            throw new Error(err);
        }
        return resp.json();
    },

    // ── Navigation ────────────────────────────────────
    navigate(view) {
        WP.currentView = view;

        document.querySelectorAll('.sidebar-item').forEach(el => {
            el.classList.toggle('active', el.dataset.view === view);
        });

        const main = document.getElementById('main-content');

        try {
            switch (view) {
                case 'dashboard':      WP.Dashboard.render(main); break;
                case 'site-overview':  WP.Dashboard.renderSiteOverview(main); break;
                case 'sites':          WP.Sites.render(main); break;
                case 'updates':   WP.Updates.render(main); break;
                case 'posts':     WP.Content.renderPosts(main); break;
                case 'pages':     WP.Content.renderPages(main); break;
                case 'media':     WP.Content.renderMedia(main); break;
                case 'plugins':   WP.Management.renderPlugins(main); break;
                case 'themes':    WP.Management.renderThemes(main); break;
                case 'wp-users':  WP.Management.renderUsers(main); break;
                case 'comments':  WP.Management.renderComments(main); break;
                case 'settings':  WP.Management.renderSettings(main); break;
                case 'schedules':    WP.Automation.renderSchedules(main); break;
                case 'backups':      WP.Automation.renderBackups(main); break;
                case 'activity-log': WP.Automation.renderLogs(main); break;
                case 'agents':    WP.Agents.render(main); break;
                case 'avada':     WP.Avada.render(main); break;
                case 'products':  WP.Woo.renderProducts(main); break;
                case 'orders':    WP.Woo.renderOrders(main); break;
                case 'customers': WP.Woo.renderCustomers(main); break;
                default:          main.innerHTML = '<div class="empty-state"><h3>Unknown view</h3></div>';
            }
        } catch (e) {
            console.error('View render error [' + view + ']:', e);
            main.innerHTML = '<div class="empty-state"><h3>Failed to load view</h3><p style="color:var(--text-muted);font-size:13px">' + e.message + '</p></div>';
        }
    },

    // ── Site switching ────────────────────────────────
    switchSite(siteId) {
        const loginBtn = document.getElementById('btn-wp-login');

        if (!siteId) {
            WP.currentSite = null;
            document.getElementById('site-nav').style.display = 'none';
            document.getElementById('woo-nav').style.display = 'none';
            loginBtn.classList.add('hidden');
            WP.navigate('dashboard');
            return;
        }

        WP.currentSite = WP.sites.find(s => s.id === siteId);
        document.getElementById('site-nav').style.display = '';

        // Show WooCommerce nav for any site marked as WC (even without consumer keys)
        document.getElementById('woo-nav').style.display =
            WP.currentSite?.is_woocommerce ? '' : 'none';

        // Show WP Admin button
        loginBtn.classList.remove('hidden');

        WP.navigate('site-overview');
    },

    // ── WP Admin Auto-Login ───────────────────────────

    /**
     * Open a WP admin page with auto-login via backend-served form.
     * @param {string} [redirectPath] — path after the site URL (e.g. '/wp-admin/post.php?post=123&action=edit').
     *                                  Defaults to '/wp-admin/'.
     * @param {string} [siteId]       — override site ID (defaults to WP.currentSite.id)
     */
    wpAdminOpen(redirectPath, siteId) {
        const site = WP.currentSite;
        if (!site) {
            WP.toast('Select a site first', 'error');
            return;
        }

        const sid = siteId || site.id;
        const redirect = encodeURIComponent(redirectPath || '/wp-admin/');
        const token = WP.session?.access_token || '';
        const loginPageUrl = `api/sites/${sid}/wp-login?redirect=${redirect}&token=${encodeURIComponent(token)}`;

        const win = window.open(loginPageUrl, '_blank');
        if (!win) {
            WP.toast('Pop-up blocked — please allow pop-ups for this site', 'error');
        }
    },

    async loginToAdmin() {
        WP.wpAdminOpen();
    },

    // ── Sign out ──────────────────────────────────────
    async signOut() {
        await WP.supabase.auth.signOut();
        window.location.href = '/auth/login';
    },

    // ── AI toggle ─────────────────────────────────────
    toggleAI() {
        document.getElementById('ai-panel').classList.toggle('open');
    },

    // ── Toast ─────────────────────────────────────────
    toast(msg, type = 'success') {
        const el = document.createElement('div');
        el.className = 'toast toast-' + type;
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 3000);
    },

    // ── Require site selected ─────────────────────────
    requireSite(main) {
        if (!WP.currentSite) {
            main.innerHTML = `<div class="empty-state">
                <div class="empty-icon">&#127760;</div>
                <h3>No site selected</h3>
                <p>Select a WordPress site from the dropdown above to manage it.</p>
            </div>`;
            return false;
        }
        return true;
    },

    // ── Format date ───────────────────────────────────
    formatDate(d) {
        if (!d) return '--';
        return new Date(d).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
        });
    },

    // ── Truncate ──────────────────────────────────────
    truncate(str, len = 60) {
        if (!str) return '';
        return str.length > len ? str.substring(0, len) + '...' : str;
    },

    // ── Strip HTML ────────────────────────────────────
    stripHtml(html) {
        if (!html) return '';
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        return tmp.textContent || '';
    },

    // ── Modal helpers ──────────────────────────────────
    modal(title, bodyHtml) {
        document.getElementById('wp-modal')?.remove();
        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';
        backdrop.id = 'wp-modal';
        backdrop.onclick = function(e) { if (e.target === backdrop) backdrop.remove(); };
        backdrop.innerHTML = '<div class="modal"><h3>' + title + '</h3>' + bodyHtml + '</div>';
        document.body.appendChild(backdrop);
    },
    closeModal() {
        document.getElementById('wp-modal')?.remove();
    },
};

// Boot
document.addEventListener('DOMContentLoaded', () => WP.init());
