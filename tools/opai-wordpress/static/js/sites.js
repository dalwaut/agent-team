/* OP WordPress — Site connection management */

WP.Sites = {
    async load() {
        try {
            WP.sites = await WP.api('sites');
            WP.Sites.updateSelect();
        } catch (e) {
            console.error('Failed to load sites:', e);
            WP.sites = [];
        }
    },

    updateSelect() {
        const sel = document.getElementById('site-select');
        sel.innerHTML = '<option value="">Select a site...</option>' +
            WP.sites.map(s =>
                `<option value="${s.id}" ${WP.currentSite?.id === s.id ? 'selected' : ''}>${s.name}</option>`
            ).join('');
    },

    render(main) {
        main.innerHTML = `
            <div class="main-header">
                <h2>Connected Sites</h2>
                <button class="btn btn-primary" onclick="WP.Sites.showConnect()">+ Connect Site</button>
            </div>
            ${WP.sites.length === 0 ? `
                <div class="empty-state">
                    <div class="empty-icon">&#127760;</div>
                    <h3>No sites connected</h3>
                    <p>Connect your first WordPress site to get started.</p>
                    <button class="btn btn-primary" onclick="WP.Sites.showConnect()">Connect Site</button>
                </div>
            ` : `
                <div class="card-grid">
                    ${WP.sites.map(s => WP.Sites.cardHtml(s)).join('')}
                </div>
            `}
        `;
    },

    cardHtml(s) {
        const statusClass = s.status === 'healthy' ? 'dot-green' :
                            s.status === 'degraded' ? 'dot-orange' : 'dot-red';
        const initial = (s.name || 'W')[0].toUpperCase();
        const wooLabel = s.is_woocommerce
            ? (s.woo_key ? '<span class="badge badge-purple">WooCommerce</span>'
                         : '<span class="badge badge-purple" style="opacity:0.6" title="WC enabled but no API keys — limited access">WooCommerce (basic)</span>')
            : '';
        return `
            <div class="card site-card" onclick="WP.Sites.select('${s.id}')">
                <div class="site-header">
                    <div class="site-favicon">${initial}</div>
                    <div>
                        <div class="site-name">${s.name} <span class="health-dot ${statusClass}"></span></div>
                        <div class="site-url">${s.url}</div>
                    </div>
                </div>
                <div class="site-stats">
                    <div>WP <span class="stat-value">${s.wp_version || '?'}</span></div>
                    <div>Plugins <span class="stat-value">${s.plugins_total || 0}</span></div>
                    <div>Updates <span class="stat-value" style="color:${(s.plugins_updates || 0) > 0 ? 'var(--orange)' : 'inherit'}">${(s.plugins_updates || 0) + (s.themes_updates || 0)}</span></div>
                    ${wooLabel ? '<div>' + wooLabel + '</div>' : ''}
                </div>
                <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
                    <button class="btn-sm btn-wp-login" onclick="event.stopPropagation();WP.Sites.loginToSite('${s.id}')" title="Open WP Admin">&#128274; WP Admin</button>
                    <button class="btn-sm" onclick="event.stopPropagation();WP.Sites.test('${s.id}')">Test</button>
                    <button class="btn-sm" onclick="event.stopPropagation();WP.Sites.refresh('${s.id}')">Refresh</button>
                    <button class="btn-sm" onclick="event.stopPropagation();WP.Sites.showSettings('${s.id}')" title="Site Settings">&#9881; Settings</button>
                    <button class="btn-sm" style="color:var(--red)" onclick="event.stopPropagation();WP.Sites.remove('${s.id}')">Remove</button>
                </div>
            </div>
        `;
    },

    select(siteId) {
        document.getElementById('site-select').value = siteId;
        WP.switchSite(siteId);
    },

    async loginToSite(siteId) {
        // Temporarily switch context if needed, then use shared auto-login
        const site = WP.sites.find(s => s.id === siteId);
        if (!site) return;
        const prev = WP.currentSite;
        WP.currentSite = site;
        await WP.wpAdminOpen(null, siteId);
        WP.currentSite = prev;
    },

    async test(siteId) {
        try {
            const result = await WP.api(`sites/${siteId}/test`, { method: 'POST' });
            WP.toast(result.success ? 'Connection OK!' : 'Connection failed: ' + (result.error || 'Unknown'), result.success ? 'success' : 'error');
            await WP.Sites.load();
            if (WP.currentView === 'sites') WP.navigate('sites');
        } catch (e) {
            WP.toast('Test failed: ' + e.message, 'error');
        }
    },

    async refresh(siteId) {
        try {
            await WP.api(`sites/${siteId}/refresh`, { method: 'POST' });
            WP.toast('Site info refreshed');
            await WP.Sites.load();
            if (WP.currentView === 'sites') WP.navigate('sites');
        } catch (e) {
            WP.toast('Refresh failed: ' + e.message, 'error');
        }
    },

    async remove(siteId) {
        if (!confirm('Remove this site? This only removes it from OP WordPress, not the actual site.')) return;
        try {
            await WP.api(`sites/${siteId}`, { method: 'DELETE' });
            WP.toast('Site removed');
            if (WP.currentSite?.id === siteId) WP.switchSite('');
            await WP.Sites.load();
            if (WP.currentView === 'sites') WP.navigate('sites');
        } catch (e) {
            WP.toast('Remove failed: ' + e.message, 'error');
        }
    },

    showManagePopup() {
        let listHtml = '';
        if (WP.sites.length === 0) {
            listHtml = '<p style="color:var(--text-muted);font-size:13px;text-align:center;padding:20px 0">No sites connected yet.</p>';
        } else {
            listHtml = '<div style="max-height:300px;overflow-y:auto">';
            for (const s of WP.sites) {
                const dotClass = s.status === 'healthy' ? 'dot-green' :
                                 s.status === 'degraded' ? 'dot-orange' : 'dot-red';
                listHtml += '<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)">';
                listHtml += '<span class="health-dot ' + dotClass + '"></span>';
                listHtml += '<div style="flex:1;min-width:0">';
                listHtml += '<div style="font-weight:500;font-size:13px">' + WP.stripHtml(s.name) + '</div>';
                listHtml += '<div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + WP.stripHtml(s.url) + '</div>';
                listHtml += '</div>';
                listHtml += '<button class="btn-sm" onclick="WP.closeModal();WP.Sites.select(\'' + s.id + '\')">Select</button>';
                listHtml += '<button class="btn-sm" style="color:var(--red)" onclick="WP.Sites.removeFromPopup(\'' + s.id + '\')">Remove</button>';
                listHtml += '</div>';
            }
            listHtml += '</div>';
        }
        listHtml += '<div style="margin-top:16px;text-align:center">';
        listHtml += '<button class="btn btn-primary" onclick="WP.closeModal();WP.Sites.showConnect()">+ Connect Site</button>';
        listHtml += '</div>';

        WP.modal('Manage Sites', listHtml);
    },

    async removeFromPopup(siteId) {
        if (!confirm('Remove this site? This only removes it from OP WordPress, not the actual site.')) return;
        try {
            await WP.api('sites/' + siteId, { method: 'DELETE' });
            WP.toast('Site removed');
            if (WP.currentSite?.id === siteId) WP.switchSite('');
            await WP.Sites.load();
            WP.Sites.showManagePopup(); // Refresh the popup
        } catch (e) {
            WP.toast('Remove failed: ' + e.message, 'error');
        }
    },

    showConnect() {
        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';
        backdrop.id = 'connect-modal';
        backdrop.innerHTML = `
            <div class="modal">
                <h3>Connect WordPress Site</h3>
                <div class="form-group">
                    <label>Site Name</label>
                    <input type="text" class="form-input" id="conn-name" placeholder="My WordPress Site">
                </div>
                <div class="form-group">
                    <label>Site URL</label>
                    <input type="text" class="form-input" id="conn-url" placeholder="https://example.com">
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>WordPress Username</label>
                        <input type="text" class="form-input" id="conn-user" placeholder="admin">
                    </div>
                    <div class="form-group">
                        <label>Application Password</label>
                        <input type="password" class="form-input" id="conn-pass" placeholder="xxxx xxxx xxxx xxxx">
                        <div class="form-hint">Generate at WP Admin &rarr; Users &rarr; Profile &rarr; Application Passwords</div>
                    </div>
                </div>
                <div class="form-group">
                    <label>Admin Password <span style="color:var(--text-muted)">(optional)</span></label>
                    <input type="password" class="form-input" id="conn-admin-pass" placeholder="WordPress login password">
                    <div class="form-hint">Required for auto-installing the OPAI Connector plugin. This is your regular WP login password (not Application Password).</div>
                </div>
                <div class="form-group">
                    <label>API Base Path</label>
                    <input type="text" class="form-input" id="conn-api" value="/wp-json">
                </div>
                <div class="form-group">
                    <label>Connector Key <span style="color:var(--text-muted)">(optional)</span></label>
                    <input type="text" class="form-input" id="conn-connector-key" placeholder="Paste from WP Admin &rarr; Settings &rarr; OPAI Connector" style="font-family:monospace">
                    <div class="form-hint">If you've already installed the OPAI Connector plugin, paste the key here. Otherwise, you can auto-install it later or add the key in Site Settings.</div>
                </div>

                <div style="border-top:1px solid var(--border);margin:20px 0 16px;padding-top:16px">
                    <div class="form-check" style="margin-bottom:12px;">
                        <input type="checkbox" id="conn-woo" onchange="WP.Sites._toggleWoo(this.checked)">
                        <label for="conn-woo" style="margin:0;font-size:13px;font-weight:500;color:var(--text)">This site has WooCommerce</label>
                    </div>
                    <div id="woo-section" style="display:none">
                        <div class="callout callout-info" style="margin-bottom:16px">
                            <span class="callout-icon">&#9432;</span>
                            <div>
                                <strong>WooCommerce API Keys are optional.</strong><br>
                                Without them, you still get:
                                <ul>
                                    <li>Product browsing (via WP REST API)</li>
                                    <li>Basic product management</li>
                                </ul>
                                With WC API keys, you also get:
                                <ul>
                                    <li>Full order management</li>
                                    <li>Customer data and reports</li>
                                    <li>Coupon management</li>
                                    <li>Sales reports and analytics</li>
                                    <li>Bulk product operations</li>
                                </ul>
                                <div style="margin-top:6px;font-size:11px;color:var(--text-muted)">
                                    Generate keys at WP Admin &rarr; WooCommerce &rarr; Settings &rarr; Advanced &rarr; REST API
                                </div>
                            </div>
                        </div>
                        <div class="form-row">
                            <div class="form-group">
                                <label>WC Consumer Key <span style="color:var(--text-muted)">(optional)</span></label>
                                <input type="text" class="form-input" id="conn-woo-key" placeholder="ck_...">
                            </div>
                            <div class="form-group">
                                <label>WC Consumer Secret <span style="color:var(--text-muted)">(optional)</span></label>
                                <input type="password" class="form-input" id="conn-woo-secret" placeholder="cs_...">
                            </div>
                        </div>
                    </div>
                </div>

                <div class="modal-actions">
                    <button class="btn btn-ghost" onclick="document.getElementById('connect-modal').remove()">Cancel</button>
                    <button class="btn btn-primary" onclick="WP.Sites.doConnect()">Connect</button>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);
    },

    _toggleWoo(checked) {
        document.getElementById('woo-section').style.display = checked ? '' : 'none';
    },

    async doConnect() {
        const adminPass = document.getElementById('conn-admin-pass')?.value || null;
        const connectorKey = document.getElementById('conn-connector-key')?.value?.trim() || null;
        const body = {
            name: document.getElementById('conn-name').value,
            url: document.getElementById('conn-url').value,
            username: document.getElementById('conn-user').value,
            app_password: document.getElementById('conn-pass').value,
            admin_password: adminPass || undefined,
            api_base: document.getElementById('conn-api').value || '/wp-json',
            connector_secret: connectorKey || undefined,
            is_woocommerce: document.getElementById('conn-woo').checked,
            woo_key: document.getElementById('conn-woo-key')?.value || null,
            woo_secret: document.getElementById('conn-woo-secret')?.value || null,
        };

        if (!body.name || !body.url || !body.username || !body.app_password) {
            WP.toast('Please fill in all required fields', 'error');
            return;
        }

        try {
            await WP.api('sites', { method: 'POST', body });
            WP.toast('Site connected!');
            document.getElementById('connect-modal').remove();
            await WP.Sites.load();
            WP.navigate('sites');
        } catch (e) {
            WP.toast('Connection failed: ' + e.message, 'error');
        }
    },

    async showSettings(siteId) {
        const s = WP.sites.find(x => x.id === siteId);
        if (!s) return;

        const hasAdminPwd = !!s.admin_password;
        const hasWooKey = !!s.woo_key;
        const hasConnectorKey = !!s.connector_secret;

        // Load backup folders
        let backupFolders = [];
        try { backupFolders = await WP.api('backup-folders'); } catch (e) { /* ok */ }
        const currentFolder = s.backup_folder || '';
        let folderOptions = '<option value="">-- Not set --</option>';
        for (const f of backupFolders) {
            folderOptions += '<option value="' + WP.stripHtml(f) + '"' +
                (currentFolder === f ? ' selected' : '') + '>' + WP.stripHtml(f) + '</option>';
        }

        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';
        backdrop.id = 'settings-modal';
        backdrop.innerHTML = `
            <div class="modal" style="max-width:520px">
                <h3>&#9881; Site Settings</h3>
                <div class="form-group">
                    <label>Site Name</label>
                    <input type="text" class="form-input" id="set-name" value="${WP.stripHtml(s.name)}">
                </div>
                <div class="form-group">
                    <label>Site URL</label>
                    <input type="text" class="form-input" id="set-url" value="${WP.stripHtml(s.url)}">
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>WordPress Username</label>
                        <input type="text" class="form-input" id="set-user" value="${WP.stripHtml(s.username)}">
                    </div>
                    <div class="form-group">
                        <label>Application Password</label>
                        <input type="password" class="form-input" id="set-app-pass" placeholder="&#x2022;&#x2022;&#x2022;&#x2022; (leave blank to keep)">
                    </div>
                </div>
                <div class="form-group" style="padding:12px;background:var(--bg);border-radius:var(--radius);border:1px solid var(--border)">
                    <label>Admin Password ${hasAdminPwd
                        ? '<span class="badge badge-green" style="font-size:10px;margin-left:6px">Saved</span>'
                        : '<span class="badge badge-orange" style="font-size:10px;margin-left:6px">Not set</span>'}</label>
                    <input type="password" class="form-input" id="set-admin-pass" placeholder="${hasAdminPwd ? '\u2022\u2022\u2022\u2022 (leave blank to keep)' : 'Enter your WP login password'}">
                    <div class="form-hint">Your regular WordPress login password (not Application Password). Required for auto-login to WP Admin and auto-installing the OPAI Connector plugin.</div>
                </div>
                <div class="form-group">
                    <label>API Base Path</label>
                    <input type="text" class="form-input" id="set-api" value="${WP.stripHtml(s.api_base || '/wp-json')}">
                </div>

                <div class="form-group" style="padding:12px;background:var(--bg);border-radius:var(--radius);border:1px solid var(--border)">
                    <label>Connector Key ${hasConnectorKey
                        ? '<span class="badge badge-green" style="font-size:10px;margin-left:6px">Saved</span>'
                        : '<span class="badge badge-orange" style="font-size:10px;margin-left:6px">Not set</span>'}</label>
                    <input type="text" class="form-input" id="set-connector-key" placeholder="${hasConnectorKey ? '\u2022\u2022\u2022\u2022 (leave blank to keep)' : 'Paste key from WP Admin \u2192 Settings \u2192 OPAI Connector'}" style="font-family:monospace">
                    <div class="form-hint">The OPAI Connector plugin generates this key. Install the plugin on your WP site, then copy the key from <strong>Settings &rarr; OPAI Connector</strong> in WP Admin.</div>
                </div>

                <div class="form-group" style="padding:12px;background:var(--bg);border-radius:var(--radius);border:1px solid var(--border)">
                    <label>Backup Storage Folder
                        ${currentFolder
                            ? '<span class="badge badge-green" style="font-size:10px;margin-left:6px">' + WP.stripHtml(currentFolder) + '</span>'
                            : '<span class="badge badge-orange" style="font-size:10px;margin-left:6px">Not set</span>'}
                    </label>
                    <div style="display:flex;gap:8px">
                        <select class="form-input" id="set-backup-folder" style="flex:1">${folderOptions}</select>
                        <button class="btn btn-ghost" onclick="WP.Sites._promptBackupFolder()" title="Create new folder">+ New</button>
                    </div>
                    <div class="form-hint">Local folder where backups are stored. Synced to NAS via Synology Drive.</div>
                </div>

                <div style="border-top:1px solid var(--border);margin:16px 0 12px;padding-top:12px">
                    <div class="form-check" style="margin-bottom:12px">
                        <input type="checkbox" id="set-woo" ${s.is_woocommerce ? 'checked' : ''} onchange="document.getElementById('set-woo-section').style.display=this.checked?'':'none'">
                        <label for="set-woo" style="margin:0;font-size:13px;font-weight:500;color:var(--text)">WooCommerce enabled</label>
                    </div>
                    <div id="set-woo-section" style="display:${s.is_woocommerce ? '' : 'none'}">
                        <div class="form-row">
                            <div class="form-group">
                                <label>WC Consumer Key <span style="color:var(--text-muted)">(optional)</span></label>
                                <input type="text" class="form-input" id="set-woo-key" placeholder="${hasWooKey ? 'ck_\u2022\u2022\u2022 (leave blank to keep)' : 'ck_...'}" value="">
                            </div>
                            <div class="form-group">
                                <label>WC Consumer Secret <span style="color:var(--text-muted)">(optional)</span></label>
                                <input type="password" class="form-input" id="set-woo-secret" placeholder="${hasWooKey ? 'cs_\u2022\u2022\u2022 (leave blank to keep)' : 'cs_...'}" value="">
                            </div>
                        </div>
                    </div>
                </div>

                <div class="modal-actions">
                    <button class="btn btn-ghost" onclick="document.getElementById('settings-modal').remove()">Cancel</button>
                    <button class="btn btn-primary" onclick="WP.Sites.saveSettings('${s.id}')">Save Changes</button>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);
    },

    _promptBackupFolder() {
        const name = prompt('New folder name:');
        if (!name || !name.trim()) return;
        const sel = document.getElementById('set-backup-folder');
        const opt = document.createElement('option');
        opt.value = name.trim();
        opt.textContent = name.trim();
        opt.selected = true;
        sel.appendChild(opt);
    },

    async saveSettings(siteId) {
        const body = {};

        const name = document.getElementById('set-name').value.trim();
        const url = document.getElementById('set-url').value.trim();
        const username = document.getElementById('set-user').value.trim();
        const appPass = document.getElementById('set-app-pass').value;
        const adminPass = document.getElementById('set-admin-pass').value;
        const apiBase = document.getElementById('set-api').value.trim();
        const connectorKey = document.getElementById('set-connector-key')?.value?.trim();
        const isWoo = document.getElementById('set-woo').checked;
        const wooKey = document.getElementById('set-woo-key')?.value?.trim();
        const wooSecret = document.getElementById('set-woo-secret')?.value?.trim();

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

        const backupFolder = document.getElementById('set-backup-folder')?.value?.trim() || '';

        if (!body.name && !body.url && !body.username && !body.app_password && !body.admin_password && !body.api_base && !body.is_woocommerce && !body.woo_key && !body.woo_secret && !backupFolder) {
            WP.toast('No changes to save', 'error');
            return;
        }

        try {
            await WP.api('sites/' + siteId, { method: 'PUT', body });

            // Save backup folder via dedicated endpoint
            if (backupFolder) {
                await WP.api('sites/' + siteId + '/backup-folder', {
                    method: 'PUT', body: { backup_folder: backupFolder },
                });
            }

            WP.toast('Settings saved!');
            document.getElementById('settings-modal').remove();
            await WP.Sites.load();
            if (WP.currentView === 'sites') WP.navigate('sites');
        } catch (e) {
            WP.toast('Save failed: ' + e.message, 'error');
        }
    },
};
