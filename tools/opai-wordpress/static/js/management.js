/* OP WordPress — Plugins, Themes, Users, Comments, Settings (full control) */

WP.Management = {

    // ── Plugins ───────────────────────────────────

    pluginsData: null,

    async renderPlugins(main) {
        if (!WP.requireSite(main)) return;

        main.innerHTML = `
            <div class="main-header">
                <h2>Plugins — ${WP.currentSite.name}</h2>
                <div style="display:flex;gap:8px">
                    <button class="btn btn-primary" onclick="WP.Management.showInstallPlugin()">Install Plugin</button>
                    <button class="btn" onclick="WP.Management.showOPPlugins()">OP Plugins</button>
                </div>
            </div>
            <div id="plugins-content"><div class="loading-inline"><div class="spinner"></div></div></div>
        `;

        try {
            const result = await WP.api('sites/' + WP.currentSite.id + '/plugins');
            WP.Management.pluginsData = result.data || result || [];
            WP.Management.renderPluginsTable();
        } catch (e) {
            document.getElementById('plugins-content').innerHTML =
                '<p style="color:var(--red)">Failed to load plugins: ' + e.message + '</p>';
        }
    },

    renderPluginsTable() {
        const plugins = WP.Management.pluginsData;
        const el = document.getElementById('plugins-content');
        if (!Array.isArray(plugins) || plugins.length === 0) {
            el.innerHTML = '<div class="empty-state"><h3>No plugins found</h3></div>';
            return;
        }

        var active = plugins.filter(function(p) { return p.status === 'active'; });
        var inactive = plugins.filter(function(p) { return p.status !== 'active'; });

        var html = '<div class="overview-stats" style="margin-bottom:24px">';
        html += '<div class="stat-card"><div class="stat-number">' + plugins.length + '</div>';
        html += '<div class="stat-label">Total</div></div>';
        html += '<div class="stat-card"><div class="stat-number">' + active.length + '</div>';
        html += '<div class="stat-label">Active</div></div>';
        html += '<div class="stat-card"><div class="stat-number">' + inactive.length + '</div>';
        html += '<div class="stat-label">Inactive</div></div></div>';

        html += '<table class="data-table"><thead><tr>';
        html += '<th>Plugin</th><th>Version</th><th>Status</th><th>Actions</th>';
        html += '</tr></thead><tbody>';

        for (var i = 0; i < plugins.length; i++) {
            var p = plugins[i];
            var name = typeof p.name === 'object' ? (p.name.raw || '') : (p.name || p.plugin || '');
            var desc = typeof p.description === 'object' ? (p.description.raw || '') : (p.description || '');
            var isActive = p.status === 'active';
            var slug = (p.plugin || '').replace(/['"]/g, '');
            var safeName = WP.stripHtml(name).replace(/['"]/g, '');

            html += '<tr>';
            html += '<td><div style="font-weight:500">' + WP.stripHtml(name) + '</div>';
            html += '<div style="font-size:11px;color:var(--text-muted)">' + WP.truncate(WP.stripHtml(desc), 100) + '</div>';
            if (p.author) {
                var author = typeof p.author === 'object' ? (p.author.raw || '') : p.author;
                html += '<div style="font-size:11px;color:var(--text-muted)">by ' + WP.stripHtml(author) + '</div>';
            }
            html += '</td>';
            html += '<td>' + (p.version || '--') + '</td>';
            html += '<td><span class="badge ' + (isActive ? 'badge-green' : 'badge-orange') + '">' + (p.status || 'unknown') + '</span></td>';
            var ignoredData = WP.Management.getIgnored();
            var isIgnored = !!ignoredData[slug];
            html += '<td style="white-space:nowrap">';
            if (isActive) {
                html += '<button class="btn btn-sm" onclick="WP.Management.togglePlugin(\'' + slug + '\',\'deactivate\')">Deactivate</button>';
            } else {
                html += '<button class="btn btn-sm" onclick="WP.Management.togglePlugin(\'' + slug + '\',\'activate\')">Activate</button>';
            }
            html += ' <button class="btn btn-sm btn-danger" title="Deactivate and permanently remove this plugin" onclick="WP.Management.deletePlugin(\'' + slug + '\',\'' + safeName + '\')">Delete</button>';
            if (isIgnored) {
                html += ' <button class="btn btn-sm" style="background:var(--yellow,#f59e0b);color:#000;border-color:var(--yellow,#f59e0b)" title="Updates are ignored — click to un-ignore" onclick="WP.Management.ignorePlugin(\'' + slug + '\',\'' + safeName + '\');WP.Management.renderPluginsTable()">Ignored ✕</button>';
            } else {
                html += ' <button class="btn btn-sm btn-ghost" title="Silence update notifications until a newer version is released" onclick="WP.Management.ignorePlugin(\'' + slug + '\',\'' + safeName + '\');WP.Management.renderPluginsTable()">Ignore</button>';
            }
            html += '</td></tr>';
        }

        html += '</tbody></table>';
        el.innerHTML = html;
    },

    async togglePlugin(slug, action) {
        try {
            WP.toast((action === 'activate' ? 'Activating' : 'Deactivating') + ' plugin...');
            await WP.api('sites/' + WP.currentSite.id + '/plugins/' + encodeURIComponent(slug) + '/' + action, { method: 'POST' });
            WP.toast('Plugin ' + action + 'd');
            WP.Management.renderPlugins(document.getElementById('main-content'));
        } catch (e) {
            WP.toast('Failed to ' + action + ': ' + e.message, 'error');
        }
    },

    async deletePlugin(slug, name) {
        if (!confirm('Delete plugin "' + name + '"?\n\nThis will deactivate and permanently remove the plugin. This cannot be undone.')) return;
        try {
            WP.toast('Deactivating and deleting plugin...');
            // Deactivate first if active, then delete
            const plugins = WP.Management.pluginsData || [];
            const plugin = plugins.find(function(p) { return (p.plugin || '') === slug; });
            if (plugin && plugin.status === 'active') {
                await WP.api('sites/' + WP.currentSite.id + '/plugins/' + encodeURIComponent(slug) + '/deactivate', { method: 'POST' }).catch(function() {});
            }
            await WP.api('sites/' + WP.currentSite.id + '/plugins/' + encodeURIComponent(slug), { method: 'DELETE' });
            // Also clear any ignore entry for this plugin
            WP.Management.clearIgnore(slug);
            WP.toast('Plugin deleted');
            WP.Management.renderPlugins(document.getElementById('main-content'));
        } catch (e) {
            WP.toast('Failed to delete: ' + e.message, 'error');
        }
    },

    // ── Plugin Ignore (localStorage-based, version-scoped) ───

    _ignoredKey() {
        return 'wp_ignored_plugins_' + (WP.currentSite ? WP.currentSite.id : 'global');
    },

    getIgnored() {
        try { return JSON.parse(localStorage.getItem(WP.Management._ignoredKey()) || '{}'); }
        catch (e) { return {}; }
    },

    saveIgnored(data) {
        try { localStorage.setItem(WP.Management._ignoredKey(), JSON.stringify(data)); } catch (e) {}
    },

    isIgnored(slug, newVersion) {
        var ignored = WP.Management.getIgnored();
        if (!ignored[slug]) return false;
        // Auto-lift: if the version we ignored is no longer the new_version, the ignore expires
        return ignored[slug].ignoredVersion === newVersion;
    },

    ignorePlugin(slug, name) {
        // When called from plugin list (no specific version), ignore all current update notifications
        var ignored = WP.Management.getIgnored();
        if (ignored[slug]) {
            if (!confirm('Un-ignore updates for "' + name + '"? You will start seeing update notifications again.')) return;
            delete ignored[slug];
            WP.Management.saveIgnored(ignored);
            WP.toast('Updates un-ignored for ' + name);
        } else {
            if (!confirm('Ignore update notifications for "' + name + '"?\n\nYou won\'t see update alerts for this plugin until a newer version is released or a critical update is flagged.')) return;
            ignored[slug] = { ignoredVersion: '*', ignoredAt: Date.now(), name: name };
            WP.Management.saveIgnored(ignored);
            WP.toast('Updates ignored for ' + name);
        }
    },

    ignorePluginVersion(slug, name, version) {
        // Called from Updates page — ignore this specific version
        var ignored = WP.Management.getIgnored();
        ignored[slug] = { ignoredVersion: version, ignoredAt: Date.now(), name: name };
        WP.Management.saveIgnored(ignored);
        WP.toast('Ignored update for ' + name + ' v' + version + '. Will re-surface when a newer version is available.');
    },

    clearIgnore(slug) {
        var ignored = WP.Management.getIgnored();
        if (ignored[slug]) {
            delete ignored[slug];
            WP.Management.saveIgnored(ignored);
        }
    },

    showInstallPlugin() {
        WP.modal('Install Plugin', `
            <div class="form-group">
                <label>Plugin Slug (from WordPress.org)</label>
                <input type="text" id="install-plugin-slug" class="form-input" placeholder="e.g. akismet, wordfence, contact-form-7">
                <div style="font-size:12px;color:var(--text-muted);margin-top:4px">
                    Enter the plugin slug as it appears in the WordPress.org URL.
                    For example, for wordpress.org/plugins/<strong>wordfence</strong>/ enter "wordfence".
                </div>
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
                <button class="btn btn-ghost" onclick="WP.closeModal()">Cancel</button>
                <button class="btn btn-primary" onclick="WP.Management.installPlugin()">Install</button>
            </div>
        `);
    },

    async installPlugin() {
        var slug = document.getElementById('install-plugin-slug').value.trim();
        if (!slug) { WP.toast('Enter a plugin slug', 'error'); return; }
        WP.closeModal();
        WP.toast('Installing ' + slug + '...');
        try {
            await WP.api('sites/' + WP.currentSite.id + '/plugins/install', {
                method: 'POST', body: { slug: slug },
            });
            WP.toast('Plugin installed successfully');
            WP.Management.renderPlugins(document.getElementById('main-content'));
        } catch (e) {
            WP.toast('Install failed: ' + e.message, 'error');
        }
    },

    // ── OP Plugins (internal plugin library) ──────

    async showOPPlugins() {
        WP.toast('Loading OP Plugins...');
        try {
            var plugins = await WP.api('op-plugins');
            if (!Array.isArray(plugins) || plugins.length === 0) {
                WP.modal('OP Plugins', '<p style="color:var(--text-muted)">No internal plugins configured.</p>');
                return;
            }
            var html = '<p style="color:var(--text-muted);font-size:13px;margin-bottom:16px">Internal plugins managed by OPAI. One-click install to <strong>' + WP.stripHtml(WP.currentSite.name) + '</strong>.</p>';
            html += '<div style="display:flex;flex-direction:column;gap:12px">';
            for (var i = 0; i < plugins.length; i++) {
                var p = plugins[i];
                html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px;background:var(--bg);border-radius:var(--radius);border:1px solid var(--border)">';
                html += '<div>';
                html += '<div style="font-weight:600">' + WP.stripHtml(p.name) + '</div>';
                html += '<div style="font-size:12px;color:var(--text-muted);margin-top:2px">' + WP.stripHtml(p.description || '') + '</div>';
                html += '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">v' + (p.version || '?') + (p.author ? ' &middot; ' + WP.stripHtml(p.author) : '') + '</div>';
                html += '</div>';
                html += '<button class="btn btn-primary btn-sm" style="margin-left:16px;white-space:nowrap" onclick="WP.Management.installOPPlugin(\'' + p.slug + '\',\'' + WP.stripHtml(p.name).replace(/'/g, '') + '\')">Install</button>';
                html += '</div>';
            }
            html += '</div>';
            WP.modal('OP Plugins', html);
        } catch (e) {
            WP.toast('Failed to load OP Plugins: ' + e.message, 'error');
        }
    },

    async installOPPlugin(slug, name) {
        WP.closeModal();
        WP.toast('Installing ' + name + '...');
        try {
            await WP.api('sites/' + WP.currentSite.id + '/op-plugins/install', {
                method: 'POST', body: { slug: slug },
            });
            WP.toast(name + ' installed successfully');
            WP.Management.renderPlugins(document.getElementById('main-content'));
        } catch (e) {
            WP.toast('Install failed: ' + e.message, 'error');
        }
    },

    // ── Themes ────────────────────────────────────

    async renderThemes(main) {
        if (!WP.requireSite(main)) return;

        main.innerHTML = `
            <div class="main-header">
                <h2>Themes — ${WP.currentSite.name}</h2>
                <button class="btn btn-primary" onclick="WP.Management.showUploadTheme()">&#128190; Upload Theme</button>
            </div>
            <div id="themes-content"><div class="loading-inline"><div class="spinner"></div></div></div>
        `;

        try {
            var result = await WP.api('sites/' + WP.currentSite.id + '/themes');
            var themes = result.data || result || [];
            var el = document.getElementById('themes-content');

            if (!Array.isArray(themes) || themes.length === 0) {
                el.innerHTML = '<div class="empty-state"><h3>No themes found</h3></div>';
                return;
            }

            var html = '<div class="card-grid">';
            for (var i = 0; i < themes.length; i++) {
                var t = themes[i];
                var name = typeof t.name === 'object' ? (t.name.raw || '') : (t.name || '');
                var isActive = t.status === 'active';
                var screenshot = t.screenshot || '';
                var stylesheet = (t.stylesheet || '').replace(/['"]/g, '');
                var safeName = WP.stripHtml(name).replace(/['"]/g, '');
                var desc = typeof t.description === 'object' ? (t.description.raw || '') : (t.description || '');

                html += '<div class="card" style="position:relative">';
                if (isActive) {
                    html += '<div style="position:absolute;top:8px;right:8px"><span class="badge badge-green">Active</span></div>';
                }
                if (screenshot) {
                    html += '<img src="' + screenshot + '" style="width:100%;height:160px;object-fit:cover;border-radius:6px;margin-bottom:12px" onerror="this.style.display=\'none\'">';
                } else {
                    html += '<div style="width:100%;height:160px;background:var(--bg-secondary);border-radius:6px;margin-bottom:12px;display:flex;align-items:center;justify-content:center;color:var(--text-muted)">No Preview</div>';
                }
                html += '<div style="font-weight:600">' + WP.stripHtml(name) + '</div>';
                html += '<div style="font-size:12px;color:var(--text-muted);margin-top:4px">v' + (t.version || '?') + '</div>';
                if (desc) {
                    html += '<div style="font-size:12px;color:var(--text-muted);margin-top:4px">' + WP.truncate(WP.stripHtml(desc), 80) + '</div>';
                }
                html += '<div style="margin-top:12px;display:flex;gap:6px">';
                if (!isActive) {
                    html += '<button class="btn btn-sm btn-primary" onclick="WP.Management.activateTheme(\'' + stylesheet + '\')">Activate</button>';
                    html += '<button class="btn btn-sm btn-danger" onclick="WP.Management.deleteTheme(\'' + stylesheet + '\',\'' + safeName + '\')">Delete</button>';
                } else {
                    html += '<span style="font-size:12px;color:var(--green)">Currently Active</span>';
                }
                html += '</div></div>';
            }
            html += '</div>';
            el.innerHTML = html;
        } catch (e) {
            document.getElementById('themes-content').innerHTML =
                '<p style="color:var(--red)">Failed to load themes: ' + e.message + '</p>';
        }
    },

    async activateTheme(stylesheet) {
        try {
            WP.toast('Activating theme...');
            await WP.api('sites/' + WP.currentSite.id + '/themes/' + encodeURIComponent(stylesheet) + '/activate', { method: 'POST' });
            WP.toast('Theme activated');
            WP.Management.renderThemes(document.getElementById('main-content'));
        } catch (e) {
            WP.toast('Failed: ' + e.message, 'error');
        }
    },

    async deleteTheme(stylesheet, name) {
        if (!confirm('Delete theme "' + name + '"? This cannot be undone.')) return;
        try {
            WP.toast('Deleting theme...');
            await WP.api('sites/' + WP.currentSite.id + '/themes/' + encodeURIComponent(stylesheet), { method: 'DELETE' });
            WP.toast('Theme deleted');
            WP.Management.renderThemes(document.getElementById('main-content'));
        } catch (e) {
            WP.toast('Failed to delete: ' + e.message, 'error');
        }
    },

    showUploadTheme() {
        WP.modal('Upload Theme', `
            <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px">
                Upload a theme ZIP file to install it on <strong>${WP.currentSite.name}</strong>.
            </p>
            <div class="form-group">
                <label>Theme ZIP File</label>
                <input type="file" id="theme-upload-file" class="form-input" accept=".zip">
            </div>
            <div id="theme-upload-status" style="display:none;font-size:13px;color:var(--text-muted);margin-top:8px"></div>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
                <button class="btn btn-ghost" onclick="WP.closeModal()">Cancel</button>
                <button class="btn btn-primary" id="theme-upload-btn" onclick="WP.Management.uploadTheme()">Upload</button>
            </div>
        `);
    },

    async uploadTheme() {
        var fileInput = document.getElementById('theme-upload-file');
        var status = document.getElementById('theme-upload-status');
        var btn = document.getElementById('theme-upload-btn');

        if (!fileInput || !fileInput.files || !fileInput.files[0]) {
            WP.toast('Please select a ZIP file', 'error');
            return;
        }

        var file = fileInput.files[0];
        if (!file.name.endsWith('.zip')) {
            WP.toast('File must be a .zip archive', 'error');
            return;
        }

        btn.disabled = true;
        btn.textContent = 'Uploading...';
        status.style.display = 'block';
        status.textContent = 'Uploading ' + file.name + ' (' + (file.size / 1024 / 1024).toFixed(1) + ' MB)...';

        try {
            var formData = new FormData();
            formData.append('file', file);

            var resp = await fetch('api/sites/' + WP.currentSite.id + '/themes/upload', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + (WP.session?.access_token || '') },
                body: formData,
            });

            if (!resp.ok) {
                var err = await resp.text();
                throw new Error(err);
            }

            var result = await resp.json();
            WP.closeModal();
            WP.toast('Theme uploaded: ' + (result.theme_name || file.name));
            WP.Management.renderThemes(document.getElementById('main-content'));
        } catch (e) {
            btn.disabled = false;
            btn.textContent = 'Upload';
            status.style.color = 'var(--red)';
            status.textContent = 'Upload failed: ' + e.message;
        }
    },

    // ── Users ────────────────────────────────────

    usersData: null,

    async renderUsers(main) {
        if (!WP.requireSite(main)) return;

        main.innerHTML = `
            <div class="main-header">
                <h2>Users — ${WP.currentSite.name}</h2>
                <button class="btn btn-primary" onclick="WP.Management.showAddUser()">Add User</button>
            </div>
            <div id="users-content"><div class="loading-inline"><div class="spinner"></div></div></div>
        `;

        try {
            var result = await WP.api('sites/' + WP.currentSite.id + '/users');
            WP.Management.usersData = result.data || result || [];
            WP.Management.renderUsersTable();
        } catch (e) {
            document.getElementById('users-content').innerHTML =
                '<p style="color:var(--red)">Failed to load users: ' + e.message + '</p>';
        }
    },

    renderUsersTable() {
        var users = WP.Management.usersData;
        var el = document.getElementById('users-content');

        if (!Array.isArray(users) || users.length === 0) {
            el.innerHTML = '<div class="empty-state"><h3>No users found</h3></div>';
            return;
        }

        var html = '<table class="data-table"><thead><tr>';
        html += '<th>User</th><th>Email</th><th>Roles</th><th>Registered</th><th>Actions</th>';
        html += '</tr></thead><tbody>';

        for (var i = 0; i < users.length; i++) {
            var u = users[i];
            var displayName = u.name || u.slug || '';
            var avatar = '';
            if (u.avatar_urls) {
                avatar = u.avatar_urls['48'] || u.avatar_urls['24'] || '';
            }

            html += '<tr>';
            html += '<td><div style="display:flex;align-items:center;gap:8px">';
            if (avatar) {
                html += '<img src="' + avatar + '" style="width:32px;height:32px;border-radius:50%" onerror="this.style.display=\'none\'">';
            }
            html += '<div>';
            html += '<div style="font-weight:500">' + WP.stripHtml(displayName) + '</div>';
            html += '<div style="font-size:11px;color:var(--text-muted)">@' + (u.slug || '') + '</div>';
            html += '</div></div></td>';
            html += '<td style="color:var(--text-muted)">' + (u.email || '--') + '</td>';
            html += '<td>' + (u.roles || []).map(function(r) { return '<span class="badge badge-blue">' + r + '</span>'; }).join(' ') + '</td>';
            html += '<td style="color:var(--text-muted)">' + (u.registered_date ? WP.formatDate(u.registered_date) : '--') + '</td>';
            html += '<td style="white-space:nowrap">';
            html += '<button class="btn btn-sm" onclick="WP.Management.showEditUser(' + u.id + ')">Edit</button>';
            html += ' <button class="btn btn-sm btn-danger" onclick="WP.Management.showDeleteUser(' + u.id + ',\'' + WP.stripHtml(displayName).replace(/'/g, '') + '\')">Delete</button>';
            html += '</td></tr>';
        }

        html += '</tbody></table>';
        el.innerHTML = html;
    },

    showAddUser() {
        WP.modal('Add New User', `
            <div class="form-group">
                <label>Username</label>
                <input type="text" id="new-user-username" class="form-input" placeholder="username" required>
            </div>
            <div class="form-group">
                <label>Email</label>
                <input type="email" id="new-user-email" class="form-input" placeholder="user@example.com" required>
            </div>
            <div class="form-group">
                <label>Password</label>
                <input type="password" id="new-user-password" class="form-input" placeholder="Strong password" required>
            </div>
            <div class="form-group" style="display:flex;gap:12px">
                <div style="flex:1">
                    <label>First Name</label>
                    <input type="text" id="new-user-first" class="form-input" placeholder="First">
                </div>
                <div style="flex:1">
                    <label>Last Name</label>
                    <input type="text" id="new-user-last" class="form-input" placeholder="Last">
                </div>
            </div>
            <div class="form-group">
                <label>Role</label>
                <select id="new-user-role" class="form-input">
                    <option value="subscriber">Subscriber</option>
                    <option value="contributor">Contributor</option>
                    <option value="author">Author</option>
                    <option value="editor">Editor</option>
                    <option value="administrator">Administrator</option>
                </select>
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
                <button class="btn btn-ghost" onclick="WP.closeModal()">Cancel</button>
                <button class="btn btn-primary" onclick="WP.Management.addUser()">Create User</button>
            </div>
        `);
    },

    async addUser() {
        var username = document.getElementById('new-user-username').value.trim();
        var email = document.getElementById('new-user-email').value.trim();
        var password = document.getElementById('new-user-password').value;
        var first = document.getElementById('new-user-first').value.trim();
        var last = document.getElementById('new-user-last').value.trim();
        var role = document.getElementById('new-user-role').value;

        if (!username || !email || !password) {
            WP.toast('Username, email, and password are required', 'error');
            return;
        }

        WP.closeModal();
        WP.toast('Creating user...');
        try {
            await WP.api('sites/' + WP.currentSite.id + '/users', {
                method: 'POST',
                body: {
                    username: username,
                    email: email,
                    password: password,
                    first_name: first,
                    last_name: last,
                    roles: [role],
                },
            });
            WP.toast('User created');
            WP.Management.renderUsers(document.getElementById('main-content'));
        } catch (e) {
            WP.toast('Failed to create user: ' + e.message, 'error');
        }
    },

    showEditUser(userId) {
        var user = null;
        if (WP.Management.usersData) {
            for (var i = 0; i < WP.Management.usersData.length; i++) {
                if (WP.Management.usersData[i].id === userId) {
                    user = WP.Management.usersData[i];
                    break;
                }
            }
        }
        if (!user) { WP.toast('User not found', 'error'); return; }

        var currentRole = (user.roles && user.roles[0]) || 'subscriber';
        var roles = ['subscriber', 'contributor', 'author', 'editor', 'administrator'];
        var roleOptions = roles.map(function(r) {
            return '<option value="' + r + '"' + (r === currentRole ? ' selected' : '') + '>' + r.charAt(0).toUpperCase() + r.slice(1) + '</option>';
        }).join('');

        WP.modal('Edit User — ' + WP.stripHtml(user.name || user.slug), `
            <div class="form-group">
                <label>Email</label>
                <input type="email" id="edit-user-email" class="form-input" value="${user.email || ''}">
            </div>
            <div class="form-group" style="display:flex;gap:12px">
                <div style="flex:1">
                    <label>First Name</label>
                    <input type="text" id="edit-user-first" class="form-input" value="${user.first_name || ''}">
                </div>
                <div style="flex:1">
                    <label>Last Name</label>
                    <input type="text" id="edit-user-last" class="form-input" value="${user.last_name || ''}">
                </div>
            </div>
            <div class="form-group">
                <label>Display Name</label>
                <input type="text" id="edit-user-display" class="form-input" value="${WP.stripHtml(user.name || '')}">
            </div>
            <div class="form-group">
                <label>Role</label>
                <select id="edit-user-role" class="form-input">${roleOptions}</select>
            </div>
            <div class="form-group">
                <label>New Password (leave blank to keep current)</label>
                <input type="password" id="edit-user-password" class="form-input" placeholder="Leave blank to keep current">
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
                <button class="btn btn-ghost" onclick="WP.closeModal()">Cancel</button>
                <button class="btn btn-primary" onclick="WP.Management.saveEditUser(${userId})">Save Changes</button>
            </div>
        `);
    },

    async saveEditUser(userId) {
        var body = {
            email: document.getElementById('edit-user-email').value.trim(),
            first_name: document.getElementById('edit-user-first').value.trim(),
            last_name: document.getElementById('edit-user-last').value.trim(),
            name: document.getElementById('edit-user-display').value.trim(),
            roles: [document.getElementById('edit-user-role').value],
        };
        var pw = document.getElementById('edit-user-password').value;
        if (pw) body.password = pw;

        WP.closeModal();
        WP.toast('Saving user...');
        try {
            await WP.api('sites/' + WP.currentSite.id + '/users/' + userId, {
                method: 'PUT', body: body,
            });
            WP.toast('User updated');
            WP.Management.renderUsers(document.getElementById('main-content'));
        } catch (e) {
            WP.toast('Failed to update user: ' + e.message, 'error');
        }
    },

    showDeleteUser(userId, name) {
        // Build reassign dropdown from other users
        var others = (WP.Management.usersData || []).filter(function(u) { return u.id !== userId; });
        var options = others.map(function(u) {
            return '<option value="' + u.id + '">' + WP.stripHtml(u.name || u.slug) + '</option>';
        }).join('');

        WP.modal('Delete User — ' + name, `
            <p>Are you sure you want to delete this user? This cannot be undone.</p>
            <div class="form-group">
                <label>Reassign posts to:</label>
                <select id="delete-user-reassign" class="form-input">
                    <option value="">-- Do not reassign --</option>
                    ${options}
                </select>
                <div style="font-size:12px;color:var(--text-muted);margin-top:4px">
                    Choose a user to reassign this user's posts to, or leave empty to delete their content.
                </div>
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
                <button class="btn btn-ghost" onclick="WP.closeModal()">Cancel</button>
                <button class="btn btn-danger" onclick="WP.Management.deleteUser(${userId})">Delete User</button>
            </div>
        `);
    },

    async deleteUser(userId) {
        var reassign = document.getElementById('delete-user-reassign').value;
        WP.closeModal();
        WP.toast('Deleting user...');
        try {
            var url = 'sites/' + WP.currentSite.id + '/users/' + userId;
            if (reassign) url += '?reassign=' + reassign;
            await WP.api(url, { method: 'DELETE' });
            WP.toast('User deleted');
            WP.Management.renderUsers(document.getElementById('main-content'));
        } catch (e) {
            WP.toast('Failed to delete: ' + e.message, 'error');
        }
    },

    // ── Comments ──────────────────────────────────

    commentsFilter: 'all',

    async renderComments(main) {
        if (!WP.requireSite(main)) return;

        main.innerHTML = `
            <div class="main-header">
                <h2>Comments — ${WP.currentSite.name}</h2>
            </div>
            <div style="display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap" id="comment-filters">
                <button class="btn btn-sm ${WP.Management.commentsFilter === 'all' ? 'btn-primary' : 'btn-ghost'}" onclick="WP.Management.filterComments('all')">All</button>
                <button class="btn btn-sm ${WP.Management.commentsFilter === 'hold' ? 'btn-primary' : 'btn-ghost'}" onclick="WP.Management.filterComments('hold')">Pending</button>
                <button class="btn btn-sm ${WP.Management.commentsFilter === 'approved' ? 'btn-primary' : 'btn-ghost'}" onclick="WP.Management.filterComments('approved')">Approved</button>
                <button class="btn btn-sm ${WP.Management.commentsFilter === 'spam' ? 'btn-primary' : 'btn-ghost'}" onclick="WP.Management.filterComments('spam')">Spam</button>
                <button class="btn btn-sm ${WP.Management.commentsFilter === 'trash' ? 'btn-primary' : 'btn-ghost'}" onclick="WP.Management.filterComments('trash')">Trash</button>
            </div>
            <div id="comments-content"><div class="loading-inline"><div class="spinner"></div></div></div>
        `;

        await WP.Management.loadComments();
    },

    async filterComments(status) {
        WP.Management.commentsFilter = status;
        // Update filter button styles
        var btns = document.querySelectorAll('#comment-filters button');
        var filters = ['all', 'hold', 'approved', 'spam', 'trash'];
        for (var i = 0; i < btns.length; i++) {
            btns[i].className = 'btn btn-sm ' + (filters[i] === status ? 'btn-primary' : 'btn-ghost');
        }
        document.getElementById('comments-content').innerHTML = '<div class="loading-inline"><div class="spinner"></div></div>';
        await WP.Management.loadComments();
    },

    async loadComments() {
        try {
            var url = 'sites/' + WP.currentSite.id + '/comments';
            if (WP.Management.commentsFilter !== 'all') {
                url += '?status=' + WP.Management.commentsFilter;
            }
            var result = await WP.api(url);
            var comments = result.data || result || [];
            var el = document.getElementById('comments-content');

            if (!Array.isArray(comments) || comments.length === 0) {
                el.innerHTML = '<div class="empty-state"><h3>No comments found</h3></div>';
                return;
            }

            var html = '<table class="data-table"><thead><tr>';
            html += '<th>Author</th><th>Comment</th><th>On</th><th>Status</th><th>Date</th><th>Actions</th>';
            html += '</tr></thead><tbody>';

            for (var i = 0; i < comments.length; i++) {
                var c = comments[i];
                var content = typeof c.content === 'object' ? (c.content.rendered || '') : (c.content || '');
                var statusCls = c.status === 'approved' ? 'badge-green' :
                                c.status === 'spam' ? 'badge-red' :
                                c.status === 'trash' ? 'badge-red' : 'badge-orange';
                var statusLabel = c.status === 'hold' ? 'pending' : c.status;

                html += '<tr>';
                html += '<td><div style="font-weight:500">' + (c.author_name || 'Anonymous') + '</div>';
                if (c.author_email) {
                    html += '<div style="font-size:11px;color:var(--text-muted)">' + c.author_email + '</div>';
                }
                html += '</td>';
                html += '<td style="max-width:300px">' + WP.truncate(WP.stripHtml(content), 120) + '</td>';
                html += '<td style="color:var(--text-muted)">Post #' + (c.post || '--') + '</td>';
                html += '<td><span class="badge ' + statusCls + '">' + statusLabel + '</span></td>';
                html += '<td style="color:var(--text-muted);white-space:nowrap">' + WP.formatDate(c.date) + '</td>';
                html += '<td style="white-space:nowrap">';

                // Action buttons based on current status
                if (c.status !== 'approved') {
                    html += '<button class="btn btn-sm" onclick="WP.Management.commentAction(' + c.id + ',\'approve\')" title="Approve">Approve</button> ';
                }
                if (c.status === 'approved') {
                    html += '<button class="btn btn-sm" onclick="WP.Management.commentAction(' + c.id + ',\'unapprove\')" title="Unapprove">Unapprove</button> ';
                }
                if (c.status !== 'spam') {
                    html += '<button class="btn btn-sm" onclick="WP.Management.commentAction(' + c.id + ',\'spam\')" title="Spam">Spam</button> ';
                }
                if (c.status !== 'trash') {
                    html += '<button class="btn btn-sm" onclick="WP.Management.commentAction(' + c.id + ',\'trash\')" title="Trash">Trash</button> ';
                }
                if (c.status === 'trash' || c.status === 'spam') {
                    html += '<button class="btn btn-sm btn-danger" onclick="WP.Management.commentAction(' + c.id + ',\'delete\')" title="Permanent Delete">Delete</button>';
                }

                html += '</td></tr>';
            }

            html += '</tbody></table>';
            el.innerHTML = html;
        } catch (e) {
            document.getElementById('comments-content').innerHTML =
                '<p style="color:var(--red)">Failed to load comments: ' + e.message + '</p>';
        }
    },

    async commentAction(id, action) {
        var labels = {
            approve: 'Approving', unapprove: 'Setting to pending',
            spam: 'Marking as spam', trash: 'Trashing', delete: 'Deleting permanently',
        };
        try {
            WP.toast(labels[action] + '...');
            await WP.api('sites/' + WP.currentSite.id + '/comments/' + id + '/' + action, { method: 'POST' });
            WP.toast('Done');
            await WP.Management.loadComments();
        } catch (e) {
            WP.toast('Failed: ' + e.message, 'error');
        }
    },

    // ── Settings ──────────────────────────────────

    settingsData: null,

    async renderSettings(main) {
        if (!WP.requireSite(main)) return;

        main.innerHTML = `
            <div class="main-header">
                <h2>Settings — ${WP.currentSite.name}</h2>
                <div style="display:flex;gap:8px">
                    <button class="btn btn-primary" onclick="WP.Management.saveSettings()">Save Changes</button>
                </div>
            </div>
            <div id="settings-content"><div class="loading-inline"><div class="spinner"></div></div></div>
        `;

        try {
            var result = await WP.api('sites/' + WP.currentSite.id + '/settings');
            WP.Management.settingsData = result.data || result || {};
            WP.Management.renderSettingsForm();
        } catch (e) {
            document.getElementById('settings-content').innerHTML =
                '<p style="color:var(--red)">Failed to load settings: ' + e.message + '</p>';
        }
    },

    renderSettingsForm() {
        var s = WP.Management.settingsData;
        var el = document.getElementById('settings-content');

        var html = '<div style="display:flex;gap:24px;flex-wrap:wrap">';

        // General settings card
        html += '<div class="card" style="flex:1;min-width:300px">';
        html += '<h3 style="margin-bottom:16px">General</h3>';

        html += '<div class="form-group"><label>Site Title</label>';
        html += '<input type="text" id="setting-title" class="form-input" value="' + WP.stripHtml(s.title || '') + '"></div>';

        html += '<div class="form-group"><label>Tagline</label>';
        html += '<input type="text" id="setting-description" class="form-input" value="' + WP.stripHtml(s.description || '') + '"></div>';

        html += '<div class="form-group"><label>Timezone</label>';
        html += '<input type="text" id="setting-timezone" class="form-input" value="' + (s.timezone_string || '') + '" placeholder="America/Chicago"></div>';

        html += '<div class="form-group"><label>Language</label>';
        html += '<input type="text" id="setting-language" class="form-input" value="' + (s.language || '') + '" placeholder="en_US"></div>';

        html += '</div>';

        // Reading & Discussion card
        html += '<div class="card" style="flex:1;min-width:300px">';
        html += '<h3 style="margin-bottom:16px">Reading & Discussion</h3>';

        html += '<div class="form-group"><label>Date Format</label>';
        html += '<input type="text" id="setting-date_format" class="form-input" value="' + (s.date_format || '') + '"></div>';

        html += '<div class="form-group"><label>Time Format</label>';
        html += '<input type="text" id="setting-time_format" class="form-input" value="' + (s.time_format || '') + '"></div>';

        html += '<div class="form-group"><label>Posts Per Page</label>';
        html += '<input type="number" id="setting-posts_per_page" class="form-input" value="' + (s.posts_per_page || 10) + '"></div>';

        html += '<div class="form-group"><label>Default Comment Status</label>';
        html += '<select id="setting-default_comment_status" class="form-input">';
        html += '<option value="open"' + (s.default_comment_status === 'open' ? ' selected' : '') + '>Open</option>';
        html += '<option value="closed"' + (s.default_comment_status === 'closed' ? ' selected' : '') + '>Closed</option>';
        html += '</select></div>';

        html += '</div></div>';

        // Site info card (read-only)
        html += '<div class="card" style="margin-top:16px">';
        html += '<h3 style="margin-bottom:16px">Site Information</h3>';
        html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px">';

        var siteUrl = WP.currentSite.url || '';
        html += '<div><div style="font-weight:500;margin-bottom:4px">URL</div>';
        html += '<div style="color:var(--text-muted)">' + siteUrl + '</div></div>';

        html += '<div><div style="font-weight:500;margin-bottom:4px">WordPress Version</div>';
        html += '<div style="color:var(--text-muted)">' + (WP.currentSite.wp_version || '--') + '</div></div>';

        html += '<div><div style="font-weight:500;margin-bottom:4px">PHP Version</div>';
        html += '<div style="color:var(--text-muted)">' + (WP.currentSite.php_version || '--') + '</div></div>';

        html += '<div><div style="font-weight:500;margin-bottom:4px">Connected</div>';
        html += '<div style="color:var(--text-muted)">' + WP.formatDate(WP.currentSite.created_at) + '</div></div>';

        html += '</div></div>';

        // Connection settings card
        var cs = WP.currentSite;
        var hasAdminPwd = !!cs.admin_password;
        var hasConnectorKey = !!cs.connector_secret;
        var hasWooKey = !!cs.woo_key;

        html += '<div class="card" style="margin-top:16px">';
        html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">';
        html += '<h3 style="margin:0">Connection Settings</h3>';
        html += '<button class="btn btn-primary" onclick="WP.Management.saveConnectionSettings()">Save Connection</button>';
        html += '</div>';
        html += '<p style="color:var(--text-muted);margin-bottom:16px;font-size:13px">Manage how OP WordPress connects to this site. Changes here affect authentication and API access.</p>';

        html += '<div style="display:flex;gap:24px;flex-wrap:wrap">';

        // Left column: core connection
        html += '<div style="flex:1;min-width:280px">';

        html += '<div class="form-group"><label>Site Name</label>';
        html += '<input type="text" id="conn-setting-name" class="form-input" value="' + WP.stripHtml(cs.name || '') + '"></div>';

        html += '<div class="form-group"><label>Site URL</label>';
        html += '<input type="text" id="conn-setting-url" class="form-input" value="' + WP.stripHtml(cs.url || '') + '"></div>';

        html += '<div class="form-group"><label>WordPress Username</label>';
        html += '<input type="text" id="conn-setting-username" class="form-input" value="' + WP.stripHtml(cs.username || '') + '"></div>';

        html += '<div class="form-group"><label>Application Password</label>';
        html += '<input type="password" id="conn-setting-app-pass" class="form-input" placeholder="&#x2022;&#x2022;&#x2022;&#x2022; (leave blank to keep)">';
        html += '<div class="form-hint">Generate at WP Admin &rarr; Users &rarr; Profile &rarr; Application Passwords</div></div>';

        html += '<div class="form-group"><label>Admin Password ';
        html += hasAdminPwd
            ? '<span class="badge badge-green" style="font-size:10px;margin-left:6px">Saved</span>'
            : '<span class="badge badge-orange" style="font-size:10px;margin-left:6px">Not set</span>';
        html += '</label>';
        html += '<input type="password" id="conn-setting-admin-pass" class="form-input" placeholder="' + (hasAdminPwd ? '&#x2022;&#x2022;&#x2022;&#x2022; (leave blank to keep)' : 'Enter your WP login password') + '">';
        html += '<div class="form-hint">Your regular WP login password. Required for auto-login and connector auto-install.</div></div>';

        html += '<div class="form-group"><label>API Base Path</label>';
        html += '<input type="text" id="conn-setting-api-base" class="form-input" value="' + WP.stripHtml(cs.api_base || '/wp-json') + '"></div>';

        html += '</div>';

        // Right column: connector + woo
        html += '<div style="flex:1;min-width:280px">';

        html += '<div class="form-group" style="padding:12px;background:var(--bg);border-radius:var(--radius);border:1px solid var(--border)">';
        html += '<label>Connector Key ';
        html += hasConnectorKey
            ? '<span class="badge badge-green" style="font-size:10px;margin-left:6px">Saved</span>'
            : '<span class="badge badge-orange" style="font-size:10px;margin-left:6px">Not set</span>';
        html += '</label>';
        html += '<input type="text" id="conn-setting-connector-key" class="form-input" placeholder="' + (hasConnectorKey ? '&#x2022;&#x2022;&#x2022;&#x2022; (leave blank to keep)' : 'Paste key from WP Admin') + '" style="font-family:monospace">';
        html += '<div class="form-hint">Install the OPAI Connector plugin on your WP site, then copy the key from <strong>Settings &rarr; OPAI Connector</strong> in WP Admin.</div>';
        html += '<div style="margin-top:8px;display:flex;gap:8px">';
        html += '<a href="/wordpress/api/connector/download" class="btn-sm" style="text-decoration:none">Download Plugin ZIP</a>';
        html += '<button class="btn-sm btn-primary" onclick="WP.Management.autoInstallConnector()">Auto-Install Connector</button>';
        html += '</div></div>';

        html += '<div style="border-top:1px solid var(--border);margin:16px 0 12px;padding-top:12px">';
        html += '<div class="form-check" style="margin-bottom:12px">';
        html += '<input type="checkbox" id="conn-setting-woo" ' + (cs.is_woocommerce ? 'checked' : '') + ' onchange="document.getElementById(\'conn-setting-woo-section\').style.display=this.checked?\'\':\'none\'">';
        html += '<label for="conn-setting-woo" style="margin:0;font-size:13px;font-weight:500;color:var(--text)">WooCommerce enabled</label>';
        html += '</div>';
        html += '<div id="conn-setting-woo-section" style="display:' + (cs.is_woocommerce ? '' : 'none') + '">';
        html += '<div class="form-group"><label>WC Consumer Key <span style="color:var(--text-muted)">(optional)</span></label>';
        html += '<input type="text" id="conn-setting-woo-key" class="form-input" placeholder="' + (hasWooKey ? 'ck_&#x2022;&#x2022;&#x2022; (leave blank to keep)' : 'ck_...') + '"></div>';
        html += '<div class="form-group"><label>WC Consumer Secret <span style="color:var(--text-muted)">(optional)</span></label>';
        html += '<input type="password" id="conn-setting-woo-secret" class="form-input" placeholder="' + (hasWooKey ? 'cs_&#x2022;&#x2022;&#x2022; (leave blank to keep)' : 'cs_...') + '"></div>';
        html += '</div></div>';

        html += '</div></div></div>';

        // Danger zone
        html += '<div class="card" style="margin-top:16px;border:1px solid var(--red)">';
        html += '<h3 style="margin-bottom:8px;color:var(--red)">Danger Zone</h3>';
        html += '<p style="color:var(--text-muted);margin-bottom:16px">Disconnect this site from OP WordPress. This will remove it from your management console. The site itself will not be affected.</p>';
        html += '<button class="btn btn-danger" onclick="WP.Management.disconnectSite()">Disconnect Site</button>';
        html += '</div>';

        el.innerHTML = html;
    },

    async saveConnectionSettings() {
        var body = {};
        var name = document.getElementById('conn-setting-name')?.value?.trim();
        var url = document.getElementById('conn-setting-url')?.value?.trim();
        var username = document.getElementById('conn-setting-username')?.value?.trim();
        var appPass = document.getElementById('conn-setting-app-pass')?.value;
        var adminPass = document.getElementById('conn-setting-admin-pass')?.value;
        var apiBase = document.getElementById('conn-setting-api-base')?.value?.trim();
        var connectorKey = document.getElementById('conn-setting-connector-key')?.value?.trim();
        var isWoo = document.getElementById('conn-setting-woo')?.checked;
        var wooKey = document.getElementById('conn-setting-woo-key')?.value?.trim();
        var wooSecret = document.getElementById('conn-setting-woo-secret')?.value?.trim();

        if (name) body.name = name;
        if (url) body.url = url;
        if (username) body.username = username;
        if (appPass) body.app_password = appPass;
        if (adminPass) body.admin_password = adminPass;
        if (apiBase) body.api_base = apiBase;
        if (connectorKey) body.connector_secret = connectorKey;
        body.is_woocommerce = isWoo;
        if (wooKey) body.woo_key = wooKey;
        if (wooSecret) body.woo_secret = wooSecret;

        WP.toast('Saving connection settings...');
        try {
            await WP.api('sites/' + WP.currentSite.id, { method: 'PUT', body: body });
            WP.toast('Connection settings saved');
            await WP.Sites.load();
            WP.currentSite = WP.sites.find(function(s) { return s.id === WP.currentSite.id; });
            WP.Management.renderSettingsForm();
        } catch (e) {
            WP.toast('Failed to save: ' + e.message, 'error');
        }
    },

    async autoInstallConnector() {
        WP.toast('Installing connector...');
        try {
            var result = await WP.api('sites/' + WP.currentSite.id + '/connector/install', { method: 'POST' });
            if (result.status === 'need_password') {
                WP.toast(result.message, 'error');
                return;
            }
            if (result.status === 'manual_required') {
                WP.toast('Auto-install failed: ' + (result.message || 'Manual install required'), 'error');
                return;
            }
            WP.toast('OPAI Connector installed!');
            await WP.Sites.load();
            WP.currentSite = WP.sites.find(function(s) { return s.id === WP.currentSite.id; });
            WP.Management.renderSettingsForm();
        } catch (e) {
            WP.toast('Install failed: ' + e.message, 'error');
        }
    },

    async saveSettings() {
        var body = {};
        var fields = [
            ['title', 'setting-title'],
            ['description', 'setting-description'],
            ['timezone_string', 'setting-timezone'],
            ['language', 'setting-language'],
            ['date_format', 'setting-date_format'],
            ['time_format', 'setting-time_format'],
            ['posts_per_page', 'setting-posts_per_page'],
            ['default_comment_status', 'setting-default_comment_status'],
        ];

        for (var i = 0; i < fields.length; i++) {
            var el = document.getElementById(fields[i][1]);
            if (el) {
                var val = el.value;
                if (fields[i][0] === 'posts_per_page') val = parseInt(val) || 10;
                body[fields[i][0]] = val;
            }
        }

        WP.toast('Saving settings...');
        try {
            await WP.api('sites/' + WP.currentSite.id + '/settings', {
                method: 'PUT', body: body,
            });
            WP.toast('Settings saved');
        } catch (e) {
            WP.toast('Failed to save: ' + e.message, 'error');
        }
    },

    async disconnectSite() {
        if (!confirm('Disconnect "' + WP.currentSite.name + '" from OP WordPress?\n\nThis removes the site from your management console. The WordPress site itself will not be affected.')) return;
        if (!confirm('Are you sure? This cannot be undone.')) return;

        WP.toast('Disconnecting site...');
        try {
            await WP.api('sites/' + WP.currentSite.id, { method: 'DELETE' });
            WP.toast('Site disconnected');
            WP.currentSite = null;
            await WP.Sites.load();
            WP.navigate('overview');
        } catch (e) {
            WP.toast('Failed to disconnect: ' + e.message, 'error');
        }
    },
};
