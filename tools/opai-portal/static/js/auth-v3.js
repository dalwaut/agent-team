/**
 * OPAI Auth Client — shared across all frontends.
 *
 * Provides Supabase auth session management, auto-redirect to login,
 * authenticated fetch, and WebSocket auth helpers.
 *
 * Usage:
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *   <script src="/auth/static/js/auth.js"></script>
 *   <script>
 *     await opaiAuth.init();
 *     const data = await opaiAuth.fetchJSON('/api/conversations');
 *   </script>
 */

const opaiAuth = (() => {
    let supabase = null;
    let currentUser = null;
    let currentSession = null;

    /**
     * Initialize auth. Call once on page load.
     * Redirects to /auth/login if no valid session.
     * @param {Object} opts
     * @param {boolean} opts.requireAdmin - If true, redirect non-admins to /chat
     * @param {string}  opts.requireApp - App ID (e.g. 'chat', 'dev'); redirects to / if user lacks access
     * @param {boolean} opts.allowAnonymous - If true, don't redirect on no session
     * @returns {Object|null} user object or null
     */
    async function init(opts = {}) {
        // Read config at call time (not module load time) so window vars set by app.js are available
        const SUPABASE_URL = document.querySelector('meta[name="supabase-url"]')?.content
            || window.OPAI_SUPABASE_URL || '';
        const SUPABASE_ANON_KEY = document.querySelector('meta[name="supabase-anon-key"]')?.content
            || window.OPAI_SUPABASE_ANON_KEY || '';

        if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
            console.warn('[OPAI Auth] Supabase config missing — auth disabled');
            return null;
        }

        // Reuse existing client if already initialized with same URL
        if (!supabase) {
            supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        }

        // Check existing session
        const { data: { session }, error } = await supabase.auth.getSession();

        console.log('[OPAI Auth] getSession result:', { hasSession: !!session, error: error?.message || null });

        if (error || !session) {
            if (!opts.allowAnonymous) {
                const returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
                console.log('[OPAI Auth] No session, redirecting to login. Return URL:', returnUrl);
                window.location.href = `/auth/login?return=${returnUrl}`;
                return null;
            }
            return null;
        }

        currentSession = session;
        currentUser = session.user;

        // Check access: requireApp takes precedence over requireAdmin
        // This ensures users with explicit app access can reach admin tools
        if (opts.requireApp) {
            const role = currentUser.app_metadata?.role || 'user';
            if (role !== 'admin') {
                try {
                    const appsResp = await fetch('/api/me/apps', {
                        headers: { 'Authorization': `Bearer ${currentSession.access_token}` },
                    });
                    if (appsResp.ok) {
                        const appsData = await appsResp.json();
                        const allowed = appsData.allowed_apps || [];
                        // Only deny if we got a real list that doesn't include this app
                        // Empty list means the server couldn't verify — fail open
                        if (allowed.length > 0 && !allowed.includes(opts.requireApp)) {
                            window.location.href = '/';
                            return null;
                        }
                    }
                } catch (e) {
                    // On fetch failure, allow access rather than locking users out
                }
            }
        } else if (opts.requireAdmin) {
            const role = currentUser.app_metadata?.role || 'user';
            if (role !== 'admin') {
                window.location.href = '/';
                return null;
            }
        }

        // Listen for session changes (token refresh, sign out)
        supabase.auth.onAuthStateChange((event, session) => {
            if (event === 'SIGNED_OUT') {
                currentSession = null;
                currentUser = null;
                window.location.href = '/auth/login';
            } else if (session) {
                currentSession = session;
                currentUser = session.user;
            }
            // Ignore INITIAL_SESSION / TOKEN_REFRESHED with null session — don't redirect
        });

        return currentUser;
    }

    /**
     * Get current access token (JWT).
     * Auto-refreshes if expired.
     */
    async function getToken() {
        if (!supabase) return null;
        const { data: { session } } = await supabase.auth.getSession();
        return session?.access_token || null;
    }

    /**
     * Fetch with auth header automatically added.
     */
    async function fetchWithAuth(url, options = {}) {
        const token = await getToken();
        if (!token) {
            window.location.href = '/auth/login';
            throw new Error('Not authenticated');
        }

        const headers = {
            ...options.headers,
            'Authorization': `Bearer ${token}`,
        };

        return fetch(url, { ...options, headers });
    }

    /**
     * Convenience: fetch JSON with auth.
     */
    async function fetchJSON(url, options = {}) {
        const resp = await fetchWithAuth(url, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers,
            },
        });

        if (resp.status === 401) {
            window.location.href = '/auth/login';
            throw new Error('Session expired');
        }
        if (resp.status === 403) {
            throw new Error('Forbidden — insufficient permissions');
        }
        if (!resp.ok) {
            const body = await resp.text();
            throw new Error(`HTTP ${resp.status}: ${body}`);
        }
        return resp.json();
    }

    /**
     * Get WebSocket auth message payload.
     * Send this as the first message after WS connect.
     */
    async function getAuthMessage() {
        const token = await getToken();
        return JSON.stringify({ type: 'auth', token });
    }

    /**
     * Sign out and redirect to login.
     */
    async function signOut() {
        if (supabase) {
            await supabase.auth.signOut();
        }
        currentSession = null;
        currentUser = null;
        window.location.href = '/auth/login';
    }

    /**
     * Get current user info.
     */
    function getUser() {
        return currentUser;
    }

    /**
     * Check if current user is admin.
     */
    function isAdmin() {
        return currentUser?.app_metadata?.role === 'admin';
    }

    return {
        init,
        getToken,
        fetchWithAuth,
        fetchJSON,
        getAuthMessage,
        signOut,
        getUser,
        isAdmin,
    };
})();
