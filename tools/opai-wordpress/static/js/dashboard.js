/* OP WordPress — Dashboard: global update command center */

WP.Dashboard = {
    _aggData: null,
    _activeTab: 'plugins',

    render(main) {
        WP.Dashboard.renderOverview(main);
    },

    async renderOverview(main) {
        const totalSites = WP.sites.length;

        main.innerHTML = `
            <div class="main-header">
                <h2>Dashboard</h2>
                <div style="display:flex;gap:8px">
                    ${totalSites > 0 ? '<button class="btn btn-ghost" onclick="WP.Dashboard.refreshAll()">Refresh All Sites</button>' : ''}
                    ${totalSites > 0 ? '<button class="btn btn-primary" onclick="WP.Dashboard.pushConnector()" title="Push latest OPAI Connector plugin to all sites">&#128640; Push OP</button>' : ''}
                </div>
            </div>
            ${totalSites === 0 ? `
                <div class="empty-state">
                    <div class="empty-icon">&#127760;</div>
                    <h3>Welcome to OP WordPress</h3>
                    <p>Connect your WordPress sites to manage them all from one place.</p>
                    <button class="btn btn-primary" onclick="WP.navigate('sites')">Get Started</button>
                </div>
            ` : `
                <div id="dash-stats"></div>
                <div id="dash-updates">
                    <div class="loading-inline"><div class="spinner"></div></div>
                </div>
            `}
        `;

        if (totalSites > 0) {
            WP.Dashboard._loadData();
        }
    },

    async _loadData() {
        try {
            const data = await WP.api('updates/all-sites');
            WP.Dashboard._aggData = data;
            WP.Dashboard._renderStats(data);
            WP.Dashboard._renderUpdates(data);
        } catch (e) {
            document.getElementById('dash-updates').innerHTML =
                '<div class="callout callout-warn"><span class="callout-icon">&#9888;</span><div>Failed to load updates: ' + e.message + '</div></div>';
        }
    },

    _renderStats(data) {
        const el = document.getElementById('dash-stats');
        if (!el) return;
        const totalSites = data.sites.length;
        const healthy = data.sites.filter(s => s.status === 'healthy').length;

        el.innerHTML = `
            <div class="overview-stats">
                <div class="stat-card clickable" onclick="WP.Dashboard._setTab('plugins')">
                    <div class="stat-number ${data.total_plugins > 0 ? 'stat-num-warn' : ''}">${data.total_plugins}</div>
                    <div class="stat-label">Plugin Updates</div>
                </div>
                <div class="stat-card clickable" onclick="WP.Dashboard._setTab('themes')">
                    <div class="stat-number ${data.total_themes > 0 ? 'stat-num-warn' : ''}">${data.total_themes}</div>
                    <div class="stat-label">Theme Updates</div>
                </div>
                <div class="stat-card clickable" onclick="WP.Dashboard._setTab('core')">
                    <div class="stat-number ${data.total_core > 0 ? 'stat-num-warn' : ''}">${data.total_core}</div>
                    <div class="stat-label">Core Updates</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number">${totalSites}</div>
                    <div class="stat-label">Sites</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number" style="color:var(--green)">${healthy}</div>
                    <div class="stat-label">Healthy</div>
                </div>
            </div>
        `;
    },

    _setTab(tab) {
        WP.Dashboard._activeTab = tab;
        const data = WP.Dashboard._aggData;
        if (data) WP.Dashboard._renderUpdates(data);
    },

    _renderUpdates(data) {
        const el = document.getElementById('dash-updates');
        if (!el) return;

        const tab = WP.Dashboard._activeTab;

        if (data.total_updates === 0) {
            el.innerHTML = `
                <div class="callout callout-info" style="margin-top:8px">
                    <span class="callout-icon">&#9989;</span>
                    <div><strong>All sites are up to date.</strong> No pending plugin, theme, or core updates.</div>
                </div>
            `;
            return;
        }

        // Tab bar
        let html = '<div class="dash-tabs">';
        html += '<button class="dash-tab' + (tab === 'plugins' ? ' active' : '') + '" onclick="WP.Dashboard._setTab(\'plugins\')">';
        html += '&#128268; Plugins';
        if (data.total_plugins > 0) html += ' <span class="tab-badge">' + data.total_plugins + '</span>';
        html += '</button>';
        html += '<button class="dash-tab' + (tab === 'themes' ? ' active' : '') + '" onclick="WP.Dashboard._setTab(\'themes\')">';
        html += '&#127912; Themes';
        if (data.total_themes > 0) html += ' <span class="tab-badge">' + data.total_themes + '</span>';
        html += '</button>';
        html += '<button class="dash-tab' + (tab === 'core' ? ' active' : '') + '" onclick="WP.Dashboard._setTab(\'core\')">';
        html += '&#9881; Core';
        if (data.total_core > 0) html += ' <span class="tab-badge">' + data.total_core + '</span>';
        html += '</button>';
        html += '</div>';

        // Tab content
        if (tab === 'plugins') {
            html += WP.Dashboard._renderPluginTab(data);
        } else if (tab === 'themes') {
            html += WP.Dashboard._renderThemeTab(data);
        } else {
            html += WP.Dashboard._renderCoreTab(data);
        }

        el.innerHTML = html;
    },

    // ── Plugin tab ──────────────────────────────────────

    _renderPluginTab(data) {
        const plugins = data.aggregated_plugins;
        if (plugins.length === 0) {
            return '<div class="tab-empty">All plugins are up to date across all sites.</div>';
        }

        let html = '<div class="tab-toolbar">';
        html += '<span class="tab-summary">' + data.total_plugins + ' update' + (data.total_plugins !== 1 ? 's' : '') + ' across ' + plugins.length + ' plugin' + (plugins.length !== 1 ? 's' : '') + '</span>';
        html += '<button class="btn btn-primary" onclick="WP.Dashboard.updateAllPlugins()">Update All Plugins</button>';
        html += '</div>';

        for (const p of plugins) {
            const id = 'ug-p-' + p.plugin.replace(/[^a-z0-9]/gi, '-');
            html += '<div class="update-group" id="' + id + '">';

            // Header row
            html += '<div class="update-group-header" onclick="WP.Dashboard.toggleGroup(\'' + id + '\')">';
            html += '<span class="ug-chevron">&#9654;</span>';
            html += '<span class="ug-icon">&#128268;</span>';
            html += '<span class="ug-name">' + WP.stripHtml(p.name) + '</span>';
            html += '<span class="ug-version">' + p.new_version + '</span>';
            html += '<span class="ug-count">' + p.sites.length + ' site' + (p.sites.length !== 1 ? 's' : '') + '</span>';
            html += '<button class="btn-sm btn-primary" onclick="event.stopPropagation();WP.Dashboard.updatePluginAllSites(\'' + (p.slug || p.plugin).replace(/'/g, "\\'") + '\')">Update All</button>';
            html += '</div>';

            // Expanded site rows
            html += '<div class="update-group-sites">';
            for (const s of p.sites) {
                html += '<div class="update-site-row" data-site-id="' + s.site_id + '">';
                html += '<span class="usr-dot"><span class="health-dot dot-green"></span></span>';
                html += '<span class="usr-name">' + WP.stripHtml(s.site_name) + '</span>';
                html += '<span class="usr-ver">' + s.current_version + ' &#8594; ' + p.new_version + '</span>';
                html += '<button class="btn-sm" onclick="WP.Dashboard.updateSingleSitePlugin(\'' + s.site_id + '\',\'' + (p.slug || p.plugin).replace(/'/g, "\\'") + '\')">Update</button>';
                html += '</div>';
            }
            html += '</div></div>';
        }

        return html;
    },

    // ── Theme tab ───────────────────────────────────────

    _renderThemeTab(data) {
        const themes = data.aggregated_themes;
        if (themes.length === 0) {
            return '<div class="tab-empty">All themes are up to date across all sites.</div>';
        }

        let html = '<div class="tab-toolbar">';
        html += '<span class="tab-summary">' + data.total_themes + ' update' + (data.total_themes !== 1 ? 's' : '') + ' across ' + themes.length + ' theme' + (themes.length !== 1 ? 's' : '') + '</span>';
        html += '<button class="btn btn-primary" onclick="WP.Dashboard.updateAllThemes()">Update All Themes</button>';
        html += '</div>';

        for (const t of themes) {
            const id = 'ug-t-' + t.stylesheet.replace(/[^a-z0-9]/gi, '-');
            html += '<div class="update-group" id="' + id + '">';

            html += '<div class="update-group-header" onclick="WP.Dashboard.toggleGroup(\'' + id + '\')">';
            html += '<span class="ug-chevron">&#9654;</span>';
            html += '<span class="ug-icon">&#127912;</span>';
            html += '<span class="ug-name">' + WP.stripHtml(t.name) + '</span>';
            html += '<span class="ug-version">' + t.new_version + '</span>';
            html += '<span class="ug-count">' + t.sites.length + ' site' + (t.sites.length !== 1 ? 's' : '') + '</span>';
            html += '<button class="btn-sm btn-primary" onclick="event.stopPropagation();WP.Dashboard.updateThemeAllSites(\'' + t.stylesheet.replace(/'/g, "\\'") + '\')">Update All</button>';
            html += '</div>';

            html += '<div class="update-group-sites">';
            for (const s of t.sites) {
                html += '<div class="update-site-row" data-site-id="' + s.site_id + '">';
                html += '<span class="usr-dot"><span class="health-dot dot-green"></span></span>';
                html += '<span class="usr-name">' + WP.stripHtml(s.site_name) + '</span>';
                html += '<span class="usr-ver">' + s.current_version + ' &#8594; ' + t.new_version + '</span>';
                html += '<button class="btn-sm" onclick="WP.Dashboard.updateSingleSiteTheme(\'' + s.site_id + '\',\'' + t.stylesheet.replace(/'/g, "\\'") + '\')">Update</button>';
                html += '</div>';
            }
            html += '</div></div>';
        }

        return html;
    },

    // ── Core tab ────────────────────────────────────────

    _renderCoreTab(data) {
        const cores = data.core_updates || [];
        if (cores.length === 0) {
            return '<div class="tab-empty">All sites are running the latest WordPress core.</div>';
        }

        // Group by target version
        const latest = cores[0]?.latest_version || '?';

        let html = '<div class="tab-toolbar">';
        html += '<span class="tab-summary">' + cores.length + ' site' + (cores.length !== 1 ? 's' : '') + ' need WordPress ' + latest + '</span>';
        html += '<button class="btn btn-primary" onclick="WP.Dashboard.updateAllCore()">Update All Core</button>';
        html += '</div>';

        for (const c of cores) {
            html += '<div class="update-group" id="ug-c-' + c.site_id + '">';
            html += '<div class="update-group-header" style="cursor:default">';
            html += '<span class="ug-icon">&#9881;</span>';
            html += '<span class="ug-name">' + WP.stripHtml(c.site_name) + '</span>';
            html += '<span class="usr-ver">' + c.current_version + ' &#8594; ' + c.latest_version + '</span>';
            html += '<button class="btn-sm btn-primary" onclick="WP.Dashboard.updateSingleSiteCore(\'' + c.site_id + '\')">Update</button>';
            html += '</div>';
            html += '</div>';
        }

        return html;
    },

    // ── Group toggle ────────────────────────────────────

    toggleGroup(id) {
        document.getElementById(id)?.classList.toggle('expanded');
    },

    // ── Animation helper ────────────────────────────────

    _animateOut(el) {
        return new Promise(resolve => {
            const h = el.offsetHeight;
            el.style.height = h + 'px';
            el.style.overflow = 'hidden';
            el.style.pointerEvents = 'none';
            void el.offsetHeight; // force reflow
            el.style.transition = [
                'opacity 0.25s ease',
                'height 0.35s ease 0.2s',
                'padding-top 0.35s ease 0.2s',
                'padding-bottom 0.35s ease 0.2s',
                'margin-bottom 0.35s ease 0.2s',
                'border-top-width 0.35s ease 0.2s',
                'border-bottom-width 0.35s ease 0.2s',
            ].join(', ');
            el.style.opacity = '0';
            el.style.height = '0';
            el.style.paddingTop = '0';
            el.style.paddingBottom = '0';
            el.style.marginBottom = '0';
            el.style.borderTopWidth = '0';
            el.style.borderBottomWidth = '0';
            setTimeout(resolve, 600);
        });
    },

    // ── Update actions: Plugins ─────────────────────────

    async _applyUpdate(siteId, path, body) {
        const resp = await WP.api(path, { method: 'POST', body });
        if (resp.status === 'connector_required') {
            WP.toast('OPAI Connector required — install it from the site Overview page', 'error');
            return false;
        }
        return resp;
    },

    async updateSingleSitePlugin(siteId, pluginSlug) {
        try {
            WP.toast('Updating plugin...');
            const result = await WP.Dashboard._applyUpdate(
                siteId,
                'sites/' + siteId + '/updates/plugins',
                { plugins: [pluginSlug] },
            );
            if (!result) return;
            WP.toast('Plugin updated');

            const groupId = 'ug-p-' + pluginSlug.replace(/[^a-z0-9]/gi, '-');
            const groupEl = document.getElementById(groupId);
            const siteRow = groupEl?.querySelector('.update-site-row[data-site-id="' + siteId + '"]');
            if (siteRow) await WP.Dashboard._animateOut(siteRow);

            const data = WP.Dashboard._aggData;
            if (data) {
                const plugin = data.aggregated_plugins.find(p => (p.slug || p.plugin) === pluginSlug);
                if (plugin) {
                    plugin.sites = plugin.sites.filter(s => s.site_id !== siteId);
                    data.total_plugins = Math.max(0, data.total_plugins - 1);
                    if (plugin.sites.length === 0) {
                        data.aggregated_plugins = data.aggregated_plugins.filter(p => (p.slug || p.plugin) !== pluginSlug);
                        if (groupEl) await WP.Dashboard._animateOut(groupEl);
                    } else if (groupEl) {
                        const countEl = groupEl.querySelector('.ug-count');
                        if (countEl) countEl.textContent = plugin.sites.length + ' site' + (plugin.sites.length !== 1 ? 's' : '');
                    }
                }
            }
        } catch (e) {
            WP.toast('Update failed: ' + e.message, 'error');
        }
    },

    async updatePluginAllSites(pluginSlug) {
        const data = WP.Dashboard._aggData;
        if (!data) return;
        const plugin = data.aggregated_plugins.find(p => (p.slug || p.plugin) === pluginSlug);
        if (!plugin) return;

        WP.toast('Updating ' + WP.stripHtml(plugin.name) + ' on ' + plugin.sites.length + ' site(s)...');
        const groupId = 'ug-p-' + pluginSlug.replace(/[^a-z0-9]/gi, '-');
        const groupEl = document.getElementById(groupId);
        const isExpanded = groupEl?.classList.contains('expanded');

        for (const s of [...plugin.sites]) {
            try {
                await WP.api('sites/' + s.site_id + '/updates/plugins', {
                    method: 'POST', body: { plugins: [pluginSlug] },
                });
                if (isExpanded) {
                    const siteRow = groupEl?.querySelector('.update-site-row[data-site-id="' + s.site_id + '"]');
                    if (siteRow) await WP.Dashboard._animateOut(siteRow);
                }
                plugin.sites = plugin.sites.filter(x => x.site_id !== s.site_id);
                data.total_plugins = Math.max(0, data.total_plugins - 1);
                if (isExpanded && plugin.sites.length > 0 && groupEl) {
                    const countEl = groupEl.querySelector('.ug-count');
                    if (countEl) countEl.textContent = plugin.sites.length + ' site' + (plugin.sites.length !== 1 ? 's' : '');
                }
            } catch (e) {
                WP.toast('Failed on ' + s.site_name + ': ' + e.message, 'error');
            }
        }

        data.aggregated_plugins = data.aggregated_plugins.filter(p => (p.slug || p.plugin) !== pluginSlug);
        if (groupEl) await WP.Dashboard._animateOut(groupEl);
        WP.toast('Done updating ' + WP.stripHtml(plugin.name));
    },

    async updateAllPlugins() {
        const data = WP.Dashboard._aggData;
        if (!data) return;
        WP.toast('Updating all plugins across all sites...');
        for (const p of [...data.aggregated_plugins]) {
            const groupId = 'ug-p-' + (p.slug || p.plugin).replace(/[^a-z0-9]/gi, '-');
            const groupEl = document.getElementById(groupId);
            const isExpanded = groupEl?.classList.contains('expanded');
            for (const s of [...p.sites]) {
                try {
                    await WP.api('sites/' + s.site_id + '/updates/plugins', {
                        method: 'POST', body: { plugins: [p.plugin] },
                    });
                    if (isExpanded) {
                        const siteRow = groupEl?.querySelector('.update-site-row[data-site-id="' + s.site_id + '"]');
                        if (siteRow) await WP.Dashboard._animateOut(siteRow);
                    }
                    p.sites = p.sites.filter(x => x.site_id !== s.site_id);
                    data.total_plugins = Math.max(0, data.total_plugins - 1);
                } catch (e) { /* continue */ }
            }
            data.aggregated_plugins = data.aggregated_plugins.filter(x => (x.slug || x.plugin) !== (p.slug || p.plugin));
            if (groupEl) await WP.Dashboard._animateOut(groupEl);
        }
        WP.toast('All plugin updates requested');
    },

    // ── Update actions: Themes ──────────────────────────

    async updateSingleSiteTheme(siteId, stylesheet) {
        try {
            WP.toast('Updating theme...');
            await WP.api('sites/' + siteId + '/updates/themes', {
                method: 'POST', body: { themes: [stylesheet] },
            });
            WP.toast('Theme updated');

            const groupId = 'ug-t-' + stylesheet.replace(/[^a-z0-9]/gi, '-');
            const groupEl = document.getElementById(groupId);
            const siteRow = groupEl?.querySelector('.update-site-row[data-site-id="' + siteId + '"]');
            if (siteRow) await WP.Dashboard._animateOut(siteRow);

            const data = WP.Dashboard._aggData;
            if (data) {
                const theme = data.aggregated_themes.find(t => t.stylesheet === stylesheet);
                if (theme) {
                    theme.sites = theme.sites.filter(s => s.site_id !== siteId);
                    data.total_themes = Math.max(0, data.total_themes - 1);
                    if (theme.sites.length === 0) {
                        data.aggregated_themes = data.aggregated_themes.filter(t => t.stylesheet !== stylesheet);
                        if (groupEl) await WP.Dashboard._animateOut(groupEl);
                    } else if (groupEl) {
                        const countEl = groupEl.querySelector('.ug-count');
                        if (countEl) countEl.textContent = theme.sites.length + ' site' + (theme.sites.length !== 1 ? 's' : '');
                    }
                }
            }
        } catch (e) {
            WP.toast('Update failed: ' + e.message, 'error');
        }
    },

    async updateThemeAllSites(stylesheet) {
        const data = WP.Dashboard._aggData;
        if (!data) return;
        const theme = data.aggregated_themes.find(t => t.stylesheet === stylesheet);
        if (!theme) return;

        WP.toast('Updating ' + WP.stripHtml(theme.name) + ' on ' + theme.sites.length + ' site(s)...');
        const groupId = 'ug-t-' + stylesheet.replace(/[^a-z0-9]/gi, '-');
        const groupEl = document.getElementById(groupId);
        const isExpanded = groupEl?.classList.contains('expanded');

        for (const s of [...theme.sites]) {
            try {
                await WP.api('sites/' + s.site_id + '/updates/themes', {
                    method: 'POST', body: { themes: [stylesheet] },
                });
                if (isExpanded) {
                    const siteRow = groupEl?.querySelector('.update-site-row[data-site-id="' + s.site_id + '"]');
                    if (siteRow) await WP.Dashboard._animateOut(siteRow);
                }
                theme.sites = theme.sites.filter(x => x.site_id !== s.site_id);
                data.total_themes = Math.max(0, data.total_themes - 1);
                if (isExpanded && theme.sites.length > 0 && groupEl) {
                    const countEl = groupEl.querySelector('.ug-count');
                    if (countEl) countEl.textContent = theme.sites.length + ' site' + (theme.sites.length !== 1 ? 's' : '');
                }
            } catch (e) {
                WP.toast('Failed on ' + s.site_name + ': ' + e.message, 'error');
            }
        }

        data.aggregated_themes = data.aggregated_themes.filter(t => t.stylesheet !== stylesheet);
        if (groupEl) await WP.Dashboard._animateOut(groupEl);
        WP.toast('Done updating ' + WP.stripHtml(theme.name));
    },

    async updateAllThemes() {
        const data = WP.Dashboard._aggData;
        if (!data) return;
        WP.toast('Updating all themes across all sites...');
        for (const t of [...data.aggregated_themes]) {
            const groupId = 'ug-t-' + t.stylesheet.replace(/[^a-z0-9]/gi, '-');
            const groupEl = document.getElementById(groupId);
            const isExpanded = groupEl?.classList.contains('expanded');
            for (const s of [...t.sites]) {
                try {
                    await WP.api('sites/' + s.site_id + '/updates/themes', {
                        method: 'POST', body: { themes: [t.stylesheet] },
                    });
                    if (isExpanded) {
                        const siteRow = groupEl?.querySelector('.update-site-row[data-site-id="' + s.site_id + '"]');
                        if (siteRow) await WP.Dashboard._animateOut(siteRow);
                    }
                    t.sites = t.sites.filter(x => x.site_id !== s.site_id);
                    data.total_themes = Math.max(0, data.total_themes - 1);
                } catch (e) { /* continue */ }
            }
            data.aggregated_themes = data.aggregated_themes.filter(x => x.stylesheet !== t.stylesheet);
            if (groupEl) await WP.Dashboard._animateOut(groupEl);
        }
        WP.toast('All theme updates requested');
    },

    // ── Update actions: Core ────────────────────────────

    async updateSingleSiteCore(siteId) {
        try {
            WP.toast('Requesting core update...');
            await WP.api('sites/' + siteId + '/updates/all', { method: 'POST' });
            WP.toast('Core update requested');

            const groupEl = document.getElementById('ug-c-' + siteId);
            if (groupEl) await WP.Dashboard._animateOut(groupEl);

            const data = WP.Dashboard._aggData;
            if (data) {
                data.core_updates = data.core_updates.filter(c => c.site_id !== siteId);
                data.total_core = Math.max(0, data.total_core - 1);
            }
        } catch (e) {
            WP.toast('Update failed: ' + e.message, 'error');
        }
    },

    async updateAllCore() {
        const data = WP.Dashboard._aggData;
        if (!data) return;
        WP.toast('Updating WordPress core on ' + data.core_updates.length + ' site(s)...');
        for (const c of [...data.core_updates]) {
            try {
                await WP.api('sites/' + c.site_id + '/updates/all', { method: 'POST' });
                const groupEl = document.getElementById('ug-c-' + c.site_id);
                if (groupEl) await WP.Dashboard._animateOut(groupEl);
                data.core_updates = data.core_updates.filter(x => x.site_id !== c.site_id);
                data.total_core = Math.max(0, data.total_core - 1);
            } catch (e) {
                WP.toast('Failed on ' + c.site_name + ': ' + e.message, 'error');
            }
        }
        WP.toast('All core updates requested');
    },

    // ── Refresh all sites ───────────────────────────────

    async refreshAll() {
        WP.toast('Refreshing all sites...');
        for (const site of WP.sites) {
            try {
                await WP.api('sites/' + site.id + '/refresh', { method: 'POST' });
            } catch (e) { /* continue */ }
        }
        await WP.Sites.load();
        WP.navigate('dashboard');
        WP.toast('All sites refreshed');
    },

    // ── Per-site overview (when a site is selected) ─────

    async renderSiteOverview(main) {
        if (!WP.requireSite(main)) return;

        const s = WP.currentSite;
        const statusClass = s.status === 'healthy' ? 'badge-green' :
                            s.status === 'degraded' ? 'badge-orange' : 'badge-red';

        main.innerHTML = `
            <div class="main-header">
                <h2>${s.name}</h2>
                <div>
                    <span class="badge ${statusClass}">${s.status || 'unknown'}</span>
                    <a href="${s.url}" target="_blank" class="btn btn-ghost" style="margin-left:8px;text-decoration:none;">Visit Site &#8599;</a>
                </div>
            </div>
            <div class="overview-stats">
                <div class="stat-card">
                    <div class="stat-number">${s.wp_version || '?'}</div>
                    <div class="stat-label">WordPress</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number">${s.plugins_total || 0}</div>
                    <div class="stat-label">Plugins</div>
                </div>
                <div class="stat-card ${(s.plugins_updates || 0) > 0 ? 'stat-warn' : ''}">
                    <div class="stat-number">${(s.plugins_updates || 0) + (s.themes_updates || 0)}</div>
                    <div class="stat-label">Available Updates</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number">${s.theme || '?'}</div>
                    <div class="stat-label">Active Theme</div>
                </div>
            </div>
            <div style="display:flex;gap:8px;margin-bottom:24px;flex-wrap:wrap;align-items:center">
                <button class="btn-sm btn-wp-login" onclick="WP.loginToAdmin()" title="Open WP Admin">&#128274; WP Admin</button>
                <button class="btn btn-ghost" onclick="WP.Sites.test('${s.id}')">Test Connection</button>
                <button class="btn btn-ghost" onclick="WP.Sites.refresh('${s.id}')">Refresh Info</button>
                <button class="btn btn-ghost" onclick="WP.navigate('updates')">Check Updates</button>
                <span id="connector-status" style="margin-left:auto"></span>
            </div>

            <h3 style="margin-bottom:12px">Quick Actions</h3>
            <div class="card-grid" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr))">
                <div class="card" style="cursor:pointer" onclick="WP.navigate('posts')">
                    <div style="font-size:24px;margin-bottom:8px">&#128221;</div>
                    <div style="font-weight:600;font-size:14px">Posts</div>
                    <div style="font-size:12px;color:var(--text-muted)">Manage blog posts</div>
                </div>
                <div class="card" style="cursor:pointer" onclick="WP.navigate('pages')">
                    <div style="font-size:24px;margin-bottom:8px">&#128196;</div>
                    <div style="font-weight:600;font-size:14px">Pages</div>
                    <div style="font-size:12px;color:var(--text-muted)">Edit site pages</div>
                </div>
                <div class="card" style="cursor:pointer" onclick="WP.navigate('plugins')">
                    <div style="font-size:24px;margin-bottom:8px">&#128268;</div>
                    <div style="font-weight:600;font-size:14px">Plugins</div>
                    <div style="font-size:12px;color:var(--text-muted)">Activate, deactivate</div>
                </div>
                <div class="card" style="cursor:pointer" onclick="WP.navigate('media')">
                    <div style="font-size:24px;margin-bottom:8px">&#128247;</div>
                    <div style="font-weight:600;font-size:14px">Media</div>
                    <div style="font-size:12px;color:var(--text-muted)">Images, files</div>
                </div>
                ${s.is_woocommerce ? `
                <div class="card" style="cursor:pointer" onclick="WP.navigate('products')">
                    <div style="font-size:24px;margin-bottom:8px">&#128722;</div>
                    <div style="font-weight:600;font-size:14px">Products</div>
                    <div style="font-size:12px;color:var(--text-muted)">WooCommerce catalog</div>
                </div>
                <div class="card" style="cursor:pointer" onclick="WP.navigate('orders')">
                    <div style="font-size:24px;margin-bottom:8px">&#128230;</div>
                    <div style="font-weight:600;font-size:14px">Orders</div>
                    <div style="font-size:12px;color:var(--text-muted)">WooCommerce orders</div>
                </div>
                ` : ''}
            </div>
        `;

        // Check connector status asynchronously
        WP.Dashboard._checkConnector(s.id);
    },

    async _checkConnector(siteId) {
        const el = document.getElementById('connector-status');
        if (!el) return;

        el.innerHTML = '<span style="font-size:12px;color:var(--text-muted)">Checking connector...</span>';

        try {
            const status = await WP.api('sites/' + siteId + '/connector/status');
            if (status.reachable) {
                el.innerHTML = '<span class="badge badge-green">OPAI Connector v' + (status.version || '?') + '</span>';
                // Clear any stale push failure banner
                const banner = document.getElementById('connector-push-banner');
                if (banner) banner.remove();
            } else if (status.installed) {
                el.innerHTML = '<span class="badge badge-orange" title="Check the connector key in Site Settings">Connector installed (unreachable)</span>' +
                    ' <a href="#" onclick="event.preventDefault();WP.Sites.showSettings(\'' + siteId + '\')" style="font-size:11px;color:var(--primary)">Check key</a>';
            } else {
                WP.Dashboard._renderConnectorInstall(el, siteId, status.has_admin_password);
            }

            // Show push failure banner if the last Push OP couldn't complete automatically
            if (status.push_status === 'manual_required') {
                WP.Dashboard._renderPushFailureBanner(siteId, status);
            }
        } catch (e) {
            WP.Dashboard._renderConnectorInstall(el, siteId, false);
        }
    },

    _renderPushFailureBanner(siteId, status) {
        const existing = document.getElementById('connector-push-banner');
        if (existing) existing.remove();

        const reason = status.push_reason || 'upload_failed';
        const version = status.push_version_needed || '?';

        const reasonLabel = {
            host_blocks_upload: 'Your host blocks remote plugin uploads (wp-admin/update.php returned 404).',
            no_credentials:     'No admin password or File Manager plugin is configured for this site.',
            upload_failed:      'The automated upload completed but the plugin could not be verified after install.',
            error:              'An unexpected error occurred during the push.',
        }[reason] || 'Automated push could not complete.';

        const banner = document.createElement('div');
        banner.id = 'connector-push-banner';
        banner.style.cssText = 'background:var(--bg-card);border:1px solid var(--yellow);border-radius:8px;padding:14px 16px;margin-bottom:16px';
        banner.innerHTML = '<div style="display:flex;align-items:flex-start;gap:10px">'
            + '<span style="font-size:18px;flex-shrink:0">&#9888;</span>'
            + '<div style="flex:1">'
            + '<strong>OPAI Connector v' + version + ' needs manual update</strong>'
            + '<div style="font-size:13px;color:var(--text-muted);margin-top:4px">' + reasonLabel + '</div>'
            + '</div>'
            + '<button class="btn btn-primary btn-sm" onclick="WP.Dashboard.showPushFixSteps(\'' + siteId + '\',\'' + reason + '\',\'' + version + '\')">View Steps</button>'
            + '</div>';

        // Insert before the quick actions section
        const quickActions = document.querySelector('.main h3');
        if (quickActions) {
            quickActions.closest('.app') ? quickActions.parentNode.insertBefore(banner, quickActions) : document.getElementById('main-content').prepend(banner);
        } else {
            document.getElementById('main-content').querySelector('.overview-stats')?.insertAdjacentElement('afterend', banner);
        }
    },

    showPushFixSteps(siteId, reason, version) {
        const existing = document.getElementById('push-fix-modal');
        if (existing) existing.remove();

        const site = WP.sites.find(s => s.id === siteId) || {};
        const siteUrl = (site.url || '').replace(/\/$/, '');
        const adminUrl = siteUrl + '/wp-admin/plugin-install.php?tab=upload';
        const downloadUrl = '/wordpress/api/connector/download';

        const steps = {
            host_blocks_upload: [
                'Download the OPAI Connector ZIP using the button below.',
                'Log in to your WordPress admin at <a href="' + adminUrl + '" target="_blank" style="color:var(--primary)">' + (siteUrl || 'your-site') + '/wp-admin</a>.',
                'Go to <strong>Plugins &rsaquo; Add New Plugin &rsaquo; Upload Plugin</strong>.',
                'Click <strong>Choose File</strong>, select <code>opai-connector.zip</code>, then click <strong>Install Now</strong>.',
                'If prompted to replace the existing version, click <strong>Replace current with uploaded</strong>.',
                'Click <strong>Activate Plugin</strong> once the upload finishes.',
                'Return here and click <strong>Test Connection</strong> — the connector badge will turn green.',
            ],
            no_credentials: [
                'Download the OPAI Connector ZIP using the button below.',
                'Log in to your WordPress admin at <a href="' + adminUrl + '" target="_blank" style="color:var(--primary)">' + (siteUrl || 'your-site') + '/wp-admin</a>.',
                'Go to <strong>Plugins &rsaquo; Add New Plugin &rsaquo; Upload Plugin</strong>.',
                'Upload <code>opai-connector.zip</code> and click <strong>Install Now</strong>, then <strong>Activate</strong>.',
                '<em>Optional — to enable future auto-push:</em> Go to <strong>Site Settings</strong> here and add your WP admin password.',
                'Return here and click <strong>Test Connection</strong>.',
            ],
            upload_failed: [
                'The plugin ZIP was uploaded but WordPress could not verify it. This is usually a temporary issue.',
                'Click <strong>Retry Push</strong> below — the overwrite confirmation is now handled automatically.',
                'If it fails again, download the ZIP and install manually via <strong>Plugins &rsaquo; Add New Plugin &rsaquo; Upload Plugin</strong>.',
                'After installing, click <strong>Test Connection</strong> on the site overview.',
            ],
            error: [
                'An unexpected error occurred. Try clicking <strong>Retry Push</strong> below first.',
                'If that fails, download the ZIP and install manually via <strong>Plugins &rsaquo; Add New Plugin &rsaquo; Upload Plugin</strong> in your WP admin.',
                'After installing, click <strong>Test Connection</strong> on the site overview.',
            ],
        };

        const stepList = (steps[reason] || steps.error).map((s, i) =>
            '<li style="padding:6px 0;font-size:13px"><span style="font-weight:600;color:var(--primary);margin-right:8px">' + (i + 1) + '.</span>' + s + '</li>'
        ).join('');

        const reasonTitle = {
            host_blocks_upload: 'Host blocks remote uploads',
            no_credentials:     'No automation credentials',
            upload_failed:      'Plugin not found after upload',
            error:              'Unexpected error',
        }[reason] || 'Manual update required';

        const html = '<div id="push-fix-modal" style="position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:1000;display:flex;align-items:center;justify-content:center" onclick="if(event.target===this)this.remove()">'
            + '<div style="background:var(--bg-card);border-radius:12px;padding:24px;min-width:500px;max-width:600px;max-height:85vh;overflow-y:auto;display:flex;flex-direction:column;gap:16px">'
            + '<div style="display:flex;align-items:center;justify-content:space-between">'
            + '<div><h3 style="margin:0">Fix OPAI Connector v' + version + '</h3>'
            + '<div style="font-size:12px;color:var(--text-muted);margin-top:2px">Reason: ' + reasonTitle + '</div></div>'
            + '<button onclick="document.getElementById(\'push-fix-modal\').remove()" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--text-muted)">&times;</button>'
            + '</div>'
            + '<ol style="margin:0;padding-left:0;list-style:none">' + stepList + '</ol>'
            + '<div style="display:flex;gap:10px;padding-top:4px;flex-wrap:wrap">'
            + '<a href="' + downloadUrl + '" class="btn btn-primary" style="text-decoration:none" download>&#11015; Download ZIP</a>'
            + (reason === 'upload_failed' || reason === 'error'
                ? '<button class="btn btn-ghost" onclick="WP.Dashboard.installConnector(\'' + siteId + '\');document.getElementById(\'push-fix-modal\').remove()">&#8635; Retry Push</button>'
                : '')
            + '<a href="' + adminUrl + '" target="_blank" class="btn btn-ghost" style="text-decoration:none">Open WP Admin &#8599;</a>'
            + '</div>'
            + '</div></div>';

        document.body.insertAdjacentHTML('beforeend', html);
    },

    _renderConnectorInstall(el, siteId, hasPassword) {
        var html = '';
        if (hasPassword) {
            html += '<button class="btn-sm btn-primary" onclick="WP.Dashboard.installConnector(\'' + siteId + '\')">Auto-Install Connector</button>';
        } else {
            html +=
                '<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">Admin password needed for auto-install:</div>' +
                '<div style="display:flex;gap:6px;align-items:center;margin-bottom:8px">' +
                '<input type="password" id="connector-admin-pwd" class="form-input" placeholder="WP admin password" style="flex:1;height:30px;font-size:12px">' +
                '<button class="btn-sm btn-primary" onclick="WP.Dashboard.savePasswordAndInstall(\'' + siteId + '\')">Save &amp; Install</button>' +
                '</div>';
        }
        html += '<div style="font-size:11px;color:var(--text-muted);margin-top:6px">';
        html += '<a href="/wordpress/api/connector/download" style="color:var(--primary)">Download ZIP</a>';
        html += ' to install manually, then paste the key in ';
        html += '<a href="#" onclick="event.preventDefault();WP.Sites.showSettings(\'' + siteId + '\')" style="color:var(--primary)">Site Settings</a>';
        html += '</div>';
        el.innerHTML = html;
    },

    async savePasswordAndInstall(siteId) {
        const pwd = document.getElementById('connector-admin-pwd')?.value;
        if (!pwd) { WP.toast('Enter your WordPress admin password', 'error'); return; }

        const el = document.getElementById('connector-status');
        if (el) el.innerHTML = '<span style="font-size:12px;color:var(--text-muted)">Saving password...</span>';

        try {
            await WP.api('sites/' + siteId, { method: 'PUT', body: { admin_password: pwd } });
            await WP.Dashboard.installConnector(siteId);
        } catch (e) {
            WP.toast('Failed: ' + e.message, 'error');
            if (el) WP.Dashboard._renderConnectorInstall(el, siteId, false);
        }
    },

    // ── Push OP Connector to all sites ─────────────────

    async pushConnector() {
        if (!confirm('Push the latest OPAI Connector plugin to all sites?\n\nEach site will use its configured connection method (REST API, Admin Upload, or File Manager). Sites requiring manual install will be flagged.')) return;

        WP.toast('Pushing OPAI Connector to all sites...');

        let result;
        try {
            result = await WP.api('connector/push-all', { method: 'POST' });
        } catch (e) {
            WP.toast('Push failed: ' + e.message, 'error');
            return;
        }

        WP.Dashboard._showPushResults(result);
    },

    _showPushResults(result) {
        const existing = document.getElementById('push-op-modal');
        if (existing) existing.remove();

        const methodLabel = { rest_api: 'REST API', admin_upload: 'Admin Upload', file_manager: 'File Manager', manual: 'Manual', auto: 'Auto', unknown: 'Unknown' };
        const statusIcon = { pushed: '&#9989;', manual_required: '&#9888;', error: '&#10060;' };
        const statusClass = { pushed: 'color:var(--green)', manual_required: 'color:var(--yellow)', error: 'color:var(--red)' };

        let rows = '';
        for (const r of result.results) {
            const icon = statusIcon[r.status] || '&#8212;';
            const color = statusClass[r.status] || '';
            const method = methodLabel[r.method] || r.method;
            rows += '<tr>';
            rows += '<td style="padding:8px 12px">' + WP.stripHtml(r.name) + '</td>';
            rows += '<td style="padding:8px 12px;font-size:12px;color:var(--text-muted)">' + method + '</td>';
            rows += '<td style="padding:8px 12px;' + color + '">' + icon + ' ' + r.status.replace('_', ' ') + '</td>';
            rows += '</tr>';
        }

        const taskLink = result.task_id
            ? ' &nbsp;<a href="/tasks/#' + result.task_id + '" target="_blank" style="font-size:11px;color:var(--primary);font-weight:400">' + result.task_id + ' &#8599;</a>'
            : '';

        const html = '<div id="push-op-modal" style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;display:flex;align-items:center;justify-content:center" onclick="if(event.target===this)this.remove()">'
            + '<div style="background:var(--bg-card);border-radius:12px;padding:24px;min-width:480px;max-width:640px;max-height:80vh;display:flex;flex-direction:column;gap:16px">'
            + '<div style="display:flex;align-items:center;justify-content:space-between">'
            + '<div><h3 style="margin:0">Push OP Results — v' + (result.plugin_version || '?') + taskLink + '</h3>'
            + '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">Logged to Task Control Panel</div></div>'
            + '<button onclick="document.getElementById(\'push-op-modal\').remove()" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--text-muted)">&times;</button>'
            + '</div>'
            + '<div style="display:flex;gap:16px">'
            + '<span style="color:var(--green)">&#9989; ' + result.pushed + ' pushed</span>'
            + '<span style="color:var(--yellow)">&#9888; ' + result.manual_required + ' manual</span>'
            + '<span style="color:var(--red)">&#10060; ' + result.errors + ' errors</span>'
            + '</div>'
            + '<div style="overflow-y:auto;max-height:50vh">'
            + '<table style="width:100%;border-collapse:collapse">'
            + '<thead><tr style="border-bottom:1px solid var(--border)">'
            + '<th style="text-align:left;padding:6px 12px;font-size:12px;color:var(--text-muted)">Site</th>'
            + '<th style="text-align:left;padding:6px 12px;font-size:12px;color:var(--text-muted)">Method</th>'
            + '<th style="text-align:left;padding:6px 12px;font-size:12px;color:var(--text-muted)">Status</th>'
            + '</tr></thead>'
            + '<tbody>' + rows + '</tbody>'
            + '</table>'
            + '</div>'
            + (result.manual_required > 0
                ? '<div style="font-size:12px;color:var(--text-muted)">&#9888; Sites flagged as <em>manual</em> require the plugin to be uploaded manually via WP Admin &rsaquo; Plugins &rsaquo; Add New &rsaquo; Upload. <a href="/wordpress/api/connector/download" style="color:var(--primary)">Download ZIP</a></div>'
                : '')
            + '</div></div>';

        document.body.insertAdjacentHTML('beforeend', html);
        WP.toast('Push complete: ' + result.pushed + ' pushed, ' + result.manual_required + ' manual, ' + result.errors + ' errors');
    },

    async installConnector(siteId) {
        const el = document.getElementById('connector-status');
        if (el) el.innerHTML = '<span style="font-size:12px;color:var(--text-muted)">Installing connector...</span>';

        try {
            const result = await WP.api('sites/' + siteId + '/connector/install', { method: 'POST' });
            if (result.status === 'need_password') {
                WP.toast(result.message, 'error');
                if (el) WP.Dashboard._renderConnectorInstall(el, siteId, false);
                return;
            }
            WP.toast('OPAI Connector installed!');
            if (el) el.innerHTML = '<span class="badge badge-green">OPAI Connector installed</span>';
            await WP.Sites.load();
        } catch (e) {
            WP.toast('Install failed: ' + e.message, 'error');
            if (el) el.innerHTML = '<button class="btn-sm" style="color:var(--red)" onclick="WP.Dashboard.installConnector(\'' + siteId + '\')">Retry Install</button>';
        }
    },
};
