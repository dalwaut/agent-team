/* OP WordPress — Update management views (full control) */

WP.Updates = {
    data: null,

    async render(main) {
        if (!WP.requireSite(main)) return;

        main.innerHTML = `
            <div class="main-header">
                <h2>Updates — ${WP.currentSite.name}</h2>
                <div style="display:flex;gap:8px">
                    <button class="btn btn-primary" onclick="WP.Updates.updateAll()">Update All</button>
                    <button class="btn btn-ghost" onclick="WP.Updates.checkNow()">Check Now</button>
                </div>
            </div>
            <div id="updates-content"><div class="loading-inline"><div class="spinner"></div></div></div>
        `;

        try {
            WP.Updates.data = await WP.api(`sites/${WP.currentSite.id}/updates`);
            WP.Updates.renderContent();
        } catch (e) {
            document.getElementById('updates-content').innerHTML =
                '<p style="color:var(--red)">Failed to load updates: ' + e.message + '</p>';
        }
    },

    renderContent() {
        const d = WP.Updates.data;
        if (!d) return;

        const el = document.getElementById('updates-content');
        const totalUpdates = (d.plugins_count || 0) + (d.themes_count || 0) + (d.core_update ? 1 : 0);

        let html = '<div class="overview-stats" style="margin-bottom:24px">';
        html += '<div class="stat-card ' + (d.plugins_count > 0 ? 'stat-warn' : '') + '">';
        html += '<div class="stat-number">' + (d.plugins_count || 0) + '</div>';
        html += '<div class="stat-label">Plugin Updates</div></div>';
        html += '<div class="stat-card ' + (d.themes_count > 0 ? 'stat-warn' : '') + '">';
        html += '<div class="stat-number">' + (d.themes_count || 0) + '</div>';
        html += '<div class="stat-label">Theme Updates</div></div>';
        html += '<div class="stat-card ' + (d.core_update ? 'stat-danger' : '') + '">';
        html += '<div class="stat-number">' + (d.core_update ? 'Yes' : 'No') + '</div>';
        html += '<div class="stat-label">Core Update</div></div>';
        html += '<div class="stat-card"><div class="stat-number">' + totalUpdates + '</div>';
        html += '<div class="stat-label">Total</div></div></div>';

        if (totalUpdates === 0) {
            html += '<div class="empty-state"><div class="empty-icon">&#9989;</div>';
            html += '<h3>Everything is up to date!</h3>';
            html += '<p>All plugins and themes are running the latest versions.</p></div>';
        } else {
            // Plugin updates
            if (d.plugins && d.plugins.length > 0) {
                // Filter out ignored plugins (version-scoped; '*' ignores all versions)
                const visiblePlugins = d.plugins.filter(function(p) {
                    const slug = p.slug || p.plugin || '';
                    const newVer = p.new_version || '';
                    const ignored = WP.Management && WP.Management.getIgnored ? WP.Management.getIgnored() : {};
                    if (!ignored[slug]) return true;
                    // critical flag always shows through
                    if (p.critical) return true;
                    if (ignored[slug].ignoredVersion === '*') return false;
                    return ignored[slug].ignoredVersion !== newVer;
                });

                if (visiblePlugins.length > 0) {
                    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">';
                    html += '<h3>Plugin Updates (' + visiblePlugins.length + (visiblePlugins.length < d.plugins.length ? ' of ' + d.plugins.length : '') + ')</h3>';
                    html += '<button class="btn btn-sm" onclick="WP.Updates.updateType(\'plugins\')">Update All Plugins</button>';
                    html += '</div>';

                    for (const p of visiblePlugins) {
                        const name = p.name || p.plugin || 'Unknown';
                        const slug = WP.stripHtml(p.slug || p.plugin || '');
                        const safeName = WP.stripHtml(name).replace(/['"]/g, '');
                        const newVer = p.new_version || '?';
                        html += '<div class="update-item" data-type="plugin" data-slug="' + slug + '">';
                        html += '<div class="update-info">';
                        html += '<div class="update-name">' + WP.stripHtml(name) + '</div>';
                        html += '<div class="update-version">' + (p.version || '?') + ' &rarr; ' + newVer + '</div>';
                        html += '</div>';
                        html += '<div style="display:flex;gap:6px;align-items:center">';
                        html += '<button class="btn btn-sm" onclick="WP.Updates.updateSingle(\'plugin\',\'' + slug + '\',\'' + safeName + '\')">Update</button>';
                        html += '<button class="btn btn-sm btn-ghost" title="Silence this update until a newer version is released" onclick="WP.Management.ignorePluginVersion(\'' + slug + '\',\'' + safeName + '\',\'' + newVer + '\');WP.Updates.renderContent()">Ignore</button>';
                        html += '</div>';
                        html += '</div>';
                    }
                } else {
                    html += '<div style="margin-bottom:12px"><h3>Plugin Updates</h3>';
                    html += '<p style="color:var(--text-muted);font-size:13px">All plugin updates are ignored. <a href="#" onclick="WP.nav(\'plugins\');return false">Manage ignores</a> on the Plugins page.</p></div>';
                }
            }

            // Theme updates
            if (d.themes && d.themes.length > 0) {
                html += '<div style="display:flex;align-items:center;justify-content:space-between;margin:20px 0 12px">';
                html += '<h3>Theme Updates (' + d.themes.length + ')</h3>';
                html += '<button class="btn btn-sm" onclick="WP.Updates.updateType(\'themes\')">Update All Themes</button>';
                html += '</div>';

                for (const t of d.themes) {
                    const name = t.name || t.stylesheet || 'Unknown';
                    const tSlug = WP.stripHtml(t.stylesheet || t.slug || '');
                    html += '<div class="update-item" data-type="theme" data-slug="' + tSlug + '">';
                    html += '<div class="update-info">';
                    html += '<div class="update-name">' + WP.stripHtml(name) + '</div>';
                    html += '<div class="update-version">' + (t.version || '?') + ' &rarr; ' + (t.new_version || '?') + '</div>';
                    html += '</div>';
                    html += '<button class="btn btn-sm" onclick="WP.Updates.updateSingle(\'theme\',\'' + WP.stripHtml(t.stylesheet || '') + '\',\'' + WP.stripHtml(name) + '\')">Update</button>';
                    html += '</div>';
                }
            }

            // Core update
            if (d.core_update) {
                html += '<div style="display:flex;align-items:center;justify-content:space-between;margin:20px 0 12px">';
                html += '<h3>Core Update</h3></div>';
                html += '<div class="update-item" data-type="core" data-slug="wp-core">';
                html += '<div class="update-info">';
                html += '<div class="update-name">WordPress Core</div>';
                html += '<div class="update-version">Update available</div>';
                html += '</div>';
                html += '<button class="btn btn-sm" onclick="WP.Updates.updateType(\'core\')">Update Core</button>';
                html += '</div>';
            }
        }

        el.innerHTML = html;
    },

    _animateOut(el) {
        return new Promise(resolve => {
            el.classList.add('removing');
            el.addEventListener('animationend', resolve, { once: true });
        });
    },

    async _animateOutAll(els) {
        if (!els || !els.length) return;
        await Promise.all(Array.from(els).map(el => WP.Updates._animateOut(el)));
    },

    async checkNow() {
        try {
            WP.toast('Checking for updates...');
            WP.Updates.data = await WP.api('sites/' + WP.currentSite.id + '/updates/check', { method: 'POST' });
            WP.Updates.renderContent();
            await WP.Sites.load();
        } catch (e) {
            WP.toast('Update check failed: ' + e.message, 'error');
        }
    },

    async updateAll() {
        if (!confirm('Update all plugins, themes, and core? A pre-backup is recommended.')) return;
        WP.toast('Applying all updates...');
        try {
            // Check if connector is available
            const connector = await WP.api('sites/' + WP.currentSite.id + '/connector/status').catch(() => null);
            if (connector && connector.reachable) {
                // Use connector for real updates
                const result = await WP.api('schedules', {
                    method: 'POST',
                    body: {
                        site_id: WP.currentSite.id,
                        name: 'Manual Update All',
                        task_type: 'update_all',
                        cron_expression: '0 0 31 2 *',  // Never auto-runs
                        enabled: false,
                        auto_rollback: true,
                        pre_backup: true,
                    },
                });
                // Trigger it immediately
                await WP.api('schedules/' + result.id + '/run', { method: 'POST' });
                WP.toast('Update started — check Activity Log for progress');
            } else {
                await WP.api('sites/' + WP.currentSite.id + '/updates/all', { method: 'POST' });
                WP.toast('Updates initiated');
            }
            setTimeout(() => WP.Updates.checkNow(), 5000);
        } catch (e) {
            WP.toast('Update failed: ' + e.message, 'error');
        }
    },

    async updateType(type) {
        WP.toast('Updating ' + type + '...');
        try {
            if (type === 'plugins') {
                const slugs = (WP.Updates.data.plugins || []).map(p => p.slug || p.plugin).filter(Boolean);
                await WP.api('sites/' + WP.currentSite.id + '/updates/plugins', {
                    method: 'POST', body: { plugins: slugs },
                });
                const rows = document.querySelectorAll('.update-item[data-type="plugin"]');
                await WP.Updates._animateOutAll(rows);
                if (WP.Updates.data) {
                    WP.Updates.data.plugins = [];
                    WP.Updates.data.plugins_count = 0;
                    WP.Updates.renderContent();
                }
            } else if (type === 'themes') {
                const slugs = (WP.Updates.data.themes || []).map(t => t.stylesheet || t.slug).filter(Boolean);
                await WP.api('sites/' + WP.currentSite.id + '/updates/themes', {
                    method: 'POST', body: { themes: slugs },
                });
                const rows = document.querySelectorAll('.update-item[data-type="theme"]');
                await WP.Updates._animateOutAll(rows);
                if (WP.Updates.data) {
                    WP.Updates.data.themes = [];
                    WP.Updates.data.themes_count = 0;
                    WP.Updates.renderContent();
                }
            } else if (type === 'core') {
                await WP.api('sites/' + WP.currentSite.id + '/updates/all', { method: 'POST' });
                const row = document.querySelector('.update-item[data-type="core"]');
                if (row) await WP.Updates._animateOut(row);
                if (WP.Updates.data) {
                    WP.Updates.data.core_update = null;
                    WP.Updates.renderContent();
                }
            }
            WP.toast(type + ' update initiated');
            setTimeout(() => WP.Updates.checkNow(), 5000);
        } catch (e) {
            WP.toast('Update failed: ' + e.message, 'error');
        }
    },

    async updateSingle(type, slug, name) {
        WP.toast('Updating ' + name + '...');
        try {
            if (type === 'plugin') {
                await WP.api('sites/' + WP.currentSite.id + '/updates/plugins', {
                    method: 'POST', body: { plugins: [slug] },
                });
                const row = document.querySelector('.update-item[data-slug="' + slug + '"]');
                if (row) await WP.Updates._animateOut(row);
                if (WP.Updates.data && WP.Updates.data.plugins) {
                    WP.Updates.data.plugins = WP.Updates.data.plugins.filter(
                        p => (p.slug || p.plugin) !== slug
                    );
                    WP.Updates.data.plugins_count = WP.Updates.data.plugins.length;
                    WP.Updates.renderContent();
                }
            } else {
                await WP.api('sites/' + WP.currentSite.id + '/updates/themes', {
                    method: 'POST', body: { themes: [slug] },
                });
                const row = document.querySelector('.update-item[data-slug="' + slug + '"]');
                if (row) await WP.Updates._animateOut(row);
                if (WP.Updates.data && WP.Updates.data.themes) {
                    WP.Updates.data.themes = WP.Updates.data.themes.filter(
                        t => (t.stylesheet || t.slug) !== slug
                    );
                    WP.Updates.data.themes_count = WP.Updates.data.themes.length;
                    WP.Updates.renderContent();
                }
            }
            WP.toast(name + ' updated successfully');
            setTimeout(() => WP.Updates.checkNow(), 5000);
        } catch (e) {
            WP.toast('Update failed: ' + e.message, 'error');
        }
    },
};
