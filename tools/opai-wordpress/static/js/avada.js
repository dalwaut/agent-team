/* OP WordPress — Avada Theme Hub */

WP.Avada = {

    _AVADA_ITEM_ID: 2833226,  // ThemeForest item ID for Avada

    render(main) {
        main.innerHTML =
            '<div class="main-header">' +
            '<h2>\uD83C\uDFA8 Envato Theme Manager</h2>' +
            '</div>' +
            '<div id="avada-root"><div class="loading-inline"><div class="spinner"></div></div></div>';

        WP.Avada._renderPage();
    },

    async _renderPage() {
        const root = document.getElementById('avada-root');
        try {
            const cfg = await WP.api('avada/config');
            WP.Avada._drawPage(root, cfg);
        } catch (e) {
            WP.Avada._drawPage(root, { keys: [], cached_version: null, zip_stored: false });
        }
    },

    _drawPage(root, cfg) {
        const keys = cfg.keys || [];
        const cachedVersion = cfg.cached_version || null;
        const zipStored = cfg.zip_stored || false;

        // Sites options for deploy dropdown
        const siteOptions = WP.sites.map(function(s) {
            return '<option value="' + s.id + '">' + WP.stripHtml(s.name) + ' (' + (s.url || '') + ')</option>';
        }).join('');

        let html =
            // ── Top action bar ──
            '<div class="card" style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:20px">' +
            '<div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">' +
            '<div>' +
            '<div style="font-size:12px;color:var(--text-muted);margin-bottom:2px">Latest Available</div>' +
            '<div style="font-size:20px;font-weight:700;color:var(--text)" id="avada-version-display">' +
            (cachedVersion ? 'Avada v' + cachedVersion : '<span style="color:var(--text-muted)">Not checked</span>') +
            '</div>' +
            '</div>' +
            '<button class="btn btn-primary" id="avada-pull-btn" onclick="WP.Avada.checkVersion()"' + (keys.length === 0 ? ' disabled title="Add an Envato API key first"' : '') + '>' +
            '\uD83D\uDD27 Pull Now' +
            '</button>' +
            (zipStored ? '<span class="badge badge-green">\uD83D\uDCBE ZIP Stored</span>' : '<span class="badge badge-orange">No ZIP stored</span>') +
            '</div>' +

            // Deploy section
            '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
            '<span style="font-size:13px;font-weight:500;color:var(--text-muted)">Deploy to:</span>' +
            (WP.sites.length === 0
                ? '<span style="color:var(--text-muted);font-size:13px">No sites connected</span>'
                : '<select class="form-input" id="avada-deploy-site" style="width:220px;min-width:0">' +
                  '<option value="">Select site...</option>' + siteOptions +
                  '</select>' +
                  '<button class="btn btn-primary" onclick="WP.Avada.deploySite()"' + (zipStored ? '' : ' disabled title="Pull theme first"') + '>\u25B6 Deploy</button>'
            ) +
            '</div>' +
            '</div>' +

            // ── Envato API Keys ──
            '<div class="card" style="margin-bottom:20px">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">' +
            '<h3 style="margin:0">Envato / ThemeForest API Keys</h3>' +
            '<button class="btn btn-sm btn-primary" onclick="WP.Avada.showAddKey()">+ Add Key</button>' +
            '</div>' +
            '<p style="color:var(--text-muted);font-size:13px;margin-bottom:16px">' +
            'Add your <a href="https://build.envato.com/create-token/" target="_blank" style="color:var(--blue)">Envato Personal Token</a> to enable theme downloads. ' +
            'The token needs <strong>Download your purchased items</strong> permission.' +
            '</p>';

        if (keys.length === 0) {
            html += '<div class="empty-state" style="padding:24px"><h3>No API keys added</h3>' +
                '<p>Add an Envato Personal Token to pull the latest Avada theme ZIP.</p></div>';
        } else {
            html += '<table class="data-table"><thead><tr><th>Label</th><th>Token</th><th>Added</th><th>Actions</th></tr></thead><tbody>';
            for (const k of keys) {
                html += '<tr>' +
                    '<td><strong>' + WP.stripHtml(k.label) + '</strong></td>' +
                    '<td style="font-family:monospace;color:var(--text-muted)">' + k.masked + '</td>' +
                    '<td style="color:var(--text-muted)">' + WP.formatDate(k.created_at) + '</td>' +
                    '<td><button class="btn btn-sm btn-danger" onclick="WP.Avada.deleteKey(\'' + k.id + '\')">Remove</button></td>' +
                    '</tr>';
            }
            html += '</tbody></table>';
        }
        html += '</div>' +

            // ── Deploy history / info ──
            '<div class="card">' +
            '<h3 style="margin-bottom:12px">How It Works</h3>' +
            '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px">' +
            '<div style="padding:12px;background:var(--bg);border-radius:var(--radius)">' +
            '<div style="font-size:18px;margin-bottom:6px">1\uFE0F\u20E3</div>' +
            '<div style="font-weight:500;margin-bottom:4px">Add API Key</div>' +
            '<div style="font-size:12px;color:var(--text-muted)">Add your Envato Personal Token with download permissions.</div>' +
            '</div>' +
            '<div style="padding:12px;background:var(--bg);border-radius:var(--radius)">' +
            '<div style="font-size:18px;margin-bottom:6px">2\uFE0F\u20E3</div>' +
            '<div style="font-weight:500;margin-bottom:4px">Pull Theme</div>' +
            '<div style="font-size:12px;color:var(--text-muted)">Click Pull Now to download the latest Avada ZIP from ThemeForest.</div>' +
            '</div>' +
            '<div style="padding:12px;background:var(--bg);border-radius:var(--radius)">' +
            '<div style="font-size:18px;margin-bottom:6px">3\uFE0F\u20E3</div>' +
            '<div style="font-weight:500;margin-bottom:4px">Deploy</div>' +
            '<div style="font-size:12px;color:var(--text-muted)">Select a site and click Deploy to install/update Avada on that site.</div>' +
            '</div>' +
            '</div></div>';

        root.innerHTML = html;
    },

    async checkVersion() {
        const btn = document.getElementById('avada-pull-btn');
        const display = document.getElementById('avada-version-display');
        if (btn) { btn.disabled = true; btn.textContent = 'Checking...'; }

        try {
            const result = await WP.api('avada/check-version', { method: 'POST' });
            if (display) display.innerHTML = 'Avada v' + result.version;
            WP.toast('Avada v' + result.version + (result.downloaded ? ' — ZIP downloaded!' : ' — version checked'));
            WP.Avada._renderPage();
        } catch (e) {
            WP.toast('Failed: ' + e.message, 'error');
            if (btn) { btn.disabled = false; btn.textContent = '\uD83D\uDD0D Check Version'; }
        }
    },

    async deploySite() {
        const sel = document.getElementById('avada-deploy-site');
        const siteId = sel?.value;
        if (!siteId) { WP.toast('Select a site to deploy to', 'error'); return; }

        const site = WP.sites.find(function(s) { return s.id === siteId; });
        if (!confirm('Deploy stored Avada theme to "' + (site?.name || siteId) + '"?')) return;

        WP.toast('Deploying Avada...');
        try {
            const result = await WP.api('avada/deploy', { method: 'POST', body: { site_id: siteId } });
            WP.toast('Avada deployed to ' + (site?.name || siteId) + '!');
        } catch (e) {
            WP.toast('Deploy failed: ' + e.message, 'error');
        }
    },

    showAddKey() {
        WP.modal('Add Envato API Key', `
            <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px">
                Generate a token at <a href="https://build.envato.com/create-token/" target="_blank" style="color:var(--blue)">build.envato.com</a>
                with the <strong>"Download your purchased items"</strong> permission enabled.
            </p>
            <div class="form-group">
                <label>Label</label>
                <input type="text" id="avada-key-label" class="form-input" placeholder="e.g. My Envato Account">
            </div>
            <div class="form-group">
                <label>Envato Personal Token</label>
                <input type="password" id="avada-key-token" class="form-input" placeholder="Paste your token here" style="font-family:monospace">
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
                <button class="btn btn-ghost" onclick="WP.closeModal()">Cancel</button>
                <button class="btn btn-primary" onclick="WP.Avada.saveKey()">Save Key</button>
            </div>
        `);
    },

    async saveKey() {
        const label = document.getElementById('avada-key-label')?.value?.trim();
        const token = document.getElementById('avada-key-token')?.value?.trim();
        if (!label) { WP.toast('Enter a label', 'error'); return; }
        if (!token || token.length < 20) { WP.toast('Enter a valid Envato token', 'error'); return; }

        try {
            await WP.api('avada/config/keys', { method: 'POST', body: { label, token } });
            WP.closeModal();
            WP.toast('API key saved');
            WP.Avada._renderPage();
        } catch (e) {
            WP.toast('Failed to save key: ' + e.message, 'error');
        }
    },

    async deleteKey(keyId) {
        if (!confirm('Remove this API key?')) return;
        try {
            await WP.api('avada/config/keys/' + keyId, { method: 'DELETE' });
            WP.toast('Key removed');
            WP.Avada._renderPage();
        } catch (e) {
            WP.toast('Failed: ' + e.message, 'error');
        }
    },
};
