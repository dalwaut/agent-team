/**
 * Bx4 -- Settings View
 * Company, Users, Connectors, Schedule, Alerts, AI Advisor, Credits tabs.
 */

'use strict';

var _settingsTab = 'company';

async function initSettings() {
    var root = document.getElementById('view-root');
    var co = window.BX4.currentCompany;
    if (!co) { root.innerHTML = '<div class="empty-state"><div class="empty-state-title">Select a company</div></div>'; return; }

    root.innerHTML = buildSettingsShell(co);
    switchSettingsTab(_settingsTab);
}

function buildSettingsShell(co) {
    return '' +
        '<div class="view-header">' +
            '<div><h1 class="view-title">Settings</h1>' +
            '<div class="view-subtitle">' + esc(co.name) + '</div></div>' +
        '</div>' +

        '<div class="tabs">' +
            '<div class="tab active" data-tab="company" onclick="switchSettingsTab(\'company\')">Company</div>' +
            '<div class="tab" data-tab="users" onclick="switchSettingsTab(\'users\')">Users</div>' +
            '<div class="tab" data-tab="connectors" onclick="switchSettingsTab(\'connectors\')">Connectors</div>' +
            '<div class="tab" data-tab="schedule" onclick="switchSettingsTab(\'schedule\')">Schedule</div>' +
            '<div class="tab" data-tab="alerts" onclick="switchSettingsTab(\'alerts\')">Alerts</div>' +
            '<div class="tab" data-tab="ai-advisor" onclick="switchSettingsTab(\'ai-advisor\')">AI Advisor</div>' +
            '<div class="tab" data-tab="notifications" onclick="switchSettingsTab(\'notifications\')">Notifications</div>' +
            (window.BX4.isAdmin ? '<div class="tab" data-tab="credits" onclick="switchSettingsTab(\'credits\')">Credits</div>' : '') +
        '</div>' +

        '<div id="settings-panel"></div>';
}

function switchSettingsTab(tab) {
    _settingsTab = tab;

    // Update tab active state
    document.querySelectorAll('.tabs .tab').forEach(function(t) {
        t.classList.toggle('active', t.dataset.tab === tab);
    });

    var panel = document.getElementById('settings-panel');
    panel.innerHTML = '<div class="flex-center" style="padding:40px;"><div class="spinner"></div></div>';

    switch (tab) {
        case 'company': loadCompanyTab(); break;
        case 'users': loadUsersTab(); break;
        case 'connectors': loadConnectorsTab(); break;
        case 'schedule': loadScheduleTab(); break;
        case 'alerts': loadAlertsTab(); break;
        case 'ai-advisor': loadAIAdvisorTab(); break;
        case 'notifications': loadNotificationsTab(); break;
        case 'credits': loadCreditsTab(); break;
    }
}

// ── Company Tab ──────────────────────────────────────────────────────────────
async function loadCompanyTab() {
    var panel = document.getElementById('settings-panel');
    var co = window.BX4.currentCompany;

    panel.innerHTML =
        '<div class="card"><div class="card-body">' +
            '<form id="settings-company-form" class="form">' +
                '<div class="form-row">' +
                    '<label class="form-label">Company Name<input type="text" class="form-input" id="set-name" value="' + esc(co.name || '') + '" required></label>' +
                    '<label class="form-label">Industry<input type="text" class="form-input" id="set-industry" value="' + esc(co.industry || '') + '"></label>' +
                '</div>' +
                '<div class="form-row">' +
                    '<label class="form-label">Stage<select class="form-select" id="set-stage">' +
                        buildStageOptions(co.stage) +
                    '</select></label>' +
                    '<label class="form-label">Headcount<input type="number" class="form-input" id="set-headcount" value="' + (co.headcount || '') + '"></label>' +
                '</div>' +
                '<div class="form-row">' +
                    '<label class="form-label">Geographic Market<input type="text" class="form-input" id="set-geo" value="' + esc(co.geo_market || '') + '"></label>' +
                    '<label class="form-label">Revenue Model<input type="text" class="form-input" id="set-revenue-model" value="' + esc(co.revenue_model || '') + '"></label>' +
                '</div>' +
                '<label class="form-label">Logo URL<input type="url" class="form-input" id="set-logo" value="' + esc(co.logo_url || '') + '" placeholder="https://..."></label>' +
                '<div style="display:flex;gap:12px;">' +
                    '<button type="submit" class="btn btn-primary">Save Changes</button>' +
                    '<button type="button" class="btn btn-outline" onclick="initIntake(window.BX4.currentCompany.id)">Re-run Onboarding</button>' +
                '</div>' +
            '</form>' +
        '</div></div>';

    document.getElementById('settings-company-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        try {
            var updated = await api('/bx4/api/companies/' + co.id, {
                method: 'PATCH',
                body: {
                    name: document.getElementById('set-name').value.trim(),
                    industry: document.getElementById('set-industry').value.trim() || null,
                    stage: document.getElementById('set-stage').value,
                    headcount: parseInt(document.getElementById('set-headcount').value) || null,
                    geo_market: document.getElementById('set-geo').value.trim() || null,
                    revenue_model: document.getElementById('set-revenue-model').value.trim() || null,
                    logo_url: document.getElementById('set-logo').value.trim() || null
                }
            });
            var newCo = updated.company || updated;
            // Update in-memory
            Object.assign(co, newCo);
            populateCompanySwitcher();
            showToast('Company profile saved', 'success');
        } catch (err) {
            showToast('Failed: ' + err.message, 'error');
        }
    });
}

function buildStageOptions(current) {
    var stages = ['idea', 'mvp', 'growth', 'scale', 'mature'];
    return stages.map(function(s) {
        return '<option value="' + s + '"' + (s === current ? ' selected' : '') + '>' + s.charAt(0).toUpperCase() + s.slice(1) + '</option>';
    }).join('');
}

// ── Users Tab ────────────────────────────────────────────────────────────────
async function loadUsersTab() {
    var panel = document.getElementById('settings-panel');
    try {
        var data = await companyApi('/access');
        var users = data && data.access ? data.access : (Array.isArray(data) ? data : []);

        var html = '<div class="card"><div class="card-header"><h3>Team Access</h3></div><div class="card-body">';

        if (users.length === 0) {
            html += '<div class="text-muted text-sm mb-16">No team members with access yet.</div>';
        } else {
            html += '<div class="table-wrap"><table><thead><tr><th>Email</th><th>Role</th><th>Granted By</th><th>Date</th><th></th></tr></thead><tbody>';
            users.forEach(function(u) {
                html += '<tr>' +
                    '<td>' + esc(u.email || u.user_email || '') + '</td>' +
                    '<td><span class="badge badge-info">' + esc(u.role || 'viewer') + '</span></td>' +
                    '<td class="text-muted">' + esc(u.granted_by || '--') + '</td>' +
                    '<td class="text-muted">' + fmtDate(u.created_at) + '</td>' +
                    '<td><button class="btn btn-sm btn-ghost" onclick="revokeAccess(\'' + esc(u.id) + '\')" style="color:var(--danger);">Revoke</button></td>' +
                '</tr>';
            });
            html += '</tbody></table></div>';
        }

        html += '<div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border);">' +
            '<h4 class="text-sm mb-8" style="font-weight:600;">Grant Access</h4>' +
            '<form id="grant-access-form" class="form-inline">' +
                '<input type="email" class="form-input" id="grant-email" placeholder="user@email.com" required style="flex:2;">' +
                '<select class="form-select" id="grant-role"><option value="manager">Manager</option><option value="viewer">Viewer</option></select>' +
                '<button type="submit" class="btn btn-sm btn-primary">Grant</button>' +
            '</form>' +
        '</div></div></div>';

        panel.innerHTML = html;

        document.getElementById('grant-access-form').addEventListener('submit', async function(e) {
            e.preventDefault();
            try {
                await companyApi('/access', {
                    method: 'POST',
                    body: {
                        email: document.getElementById('grant-email').value.trim(),
                        role: document.getElementById('grant-role').value
                    }
                });
                showToast('Access granted', 'success');
                loadUsersTab();
            } catch (err) {
                showToast('Failed: ' + err.message, 'error');
            }
        });
    } catch (err) {
        panel.innerHTML = '<div class="text-sm" style="color:var(--danger);">Failed to load users: ' + esc(err.message) + '</div>';
    }
}

async function revokeAccess(accessId) {
    if (!confirm('Revoke this user\'s access?')) return;
    try {
        await companyApi('/access/' + accessId, { method: 'DELETE' });
        showToast('Access revoked', 'success');
        loadUsersTab();
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
}

// ── Connectors Tab ───────────────────────────────────────────────────────────
async function loadConnectorsTab() {
    var panel = document.getElementById('settings-panel');
    panel.innerHTML = '<div class="flex-center" style="padding:40px;"><div class="spinner"></div></div>';

    var accounts = [];
    try {
        accounts = await companyApi('/financial/accounts');
        if (!Array.isArray(accounts)) accounts = [];
    } catch (_) {}

    var stripeAccounts = accounts.filter(function(a) { return a.provider === 'stripe'; });
    var internalAccount = stripeAccounts.find(function(a) { return a.is_internal; });

    var html = '';

    // ── Tier 0: Always Active ────────────────────────────────────────────────
    html += '<div class="card mb-16"><div class="card-header"><h3>Tier 0 — Always Active</h3></div><div class="card-body">' +
        '<div class="action-item">' +
            '<div class="action-item-body">' +
                '<div class="action-item-title">CSV / Manual Entry <span class="badge badge-success">Always Active</span></div>' +
                '<div class="action-item-summary">Upload P&amp;L CSVs or enter transactions manually. No setup required.</div>' +
            '</div>' +
        '</div>' +
    '</div></div>';

    // ── Tier 1: Stripe (full multi-account UI) ───────────────────────────────
    html += '<div class="card mb-16"><div class="card-header"><div><h3>Stripe <span class="badge badge-tier">Tier 1</span></h3>' +
        '<div class="text-sm text-muted">Revenue tracking. Multiple accounts supported.</div></div></div><div class="card-body">';

    // Internal account (admin only)
    if (window.BX4.isAdmin) {
        html += '<div class="section-label mb-8">Internal Account (OPAI Stripe)</div>';
        if (internalAccount) {
            html += _stripeAccountRow(internalAccount, true);
        } else {
            html += '<div class="action-item" style="margin-bottom:8px;">' +
                '<div class="action-item-body">' +
                    '<div class="action-item-title">OPAI Internal <span class="badge badge-neutral">Not connected</span></div>' +
                    '<div class="action-item-summary">Auto-connect using the OPAI Stripe account (no key entry required).</div>' +
                '</div>' +
                '<div class="action-item-actions">' +
                    '<button class="btn btn-sm btn-primary" onclick="stripeSetupInternal()">Auto-Connect</button>' +
                '</div></div>';
        }
        html += '<hr style="border-color:var(--border);margin:16px 0;">';
    }

    // External Stripe accounts
    html += '<div class="section-label mb-8">Additional Stripe Accounts</div>';
    var externalAccounts = stripeAccounts.filter(function(a) { return !a.is_internal; });
    if (externalAccounts.length === 0) {
        html += '<div class="empty-state" style="padding:16px;"><div class="empty-state-title" style="font-size:14px;">No additional accounts</div>' +
            '<div class="empty-state-sub">Connect a Stripe account to start syncing revenue automatically.</div></div>';
    } else {
        externalAccounts.forEach(function(acct) { html += _stripeAccountRow(acct, false); });
    }

    html += '<div style="margin-top:12px;">' +
        '<button class="btn btn-outline btn-sm" onclick="showAddStripeModal()">+ Add Stripe Account</button>' +
        '<span class="text-sm text-muted" style="margin-left:12px;">Enter your own Stripe restricted key — Bx4 does not supply one.</span>' +
    '</div>';

    html += '</div></div>';

    // ── Tier 1: Google Analytics ─────────────────────────────────────────────
    var gaAccounts = accounts.filter(function(a) { return a.provider === 'google_analytics'; });
    html += '<div class="card mb-16"><div class="card-header"><div><h3>Google Analytics (GA4) <span class="badge badge-tier">Tier 1</span></h3>' +
        '<div class="text-sm text-muted">Website traffic and engagement metrics.</div></div></div><div class="card-body">';
    if (gaAccounts.length === 0) {
        html += '<div class="empty-state" style="padding:16px;"><div class="empty-state-title" style="font-size:14px;">Not connected</div>' +
            '<div class="empty-state-sub">Paste your GA4 service account JSON to connect.</div></div>';
    } else {
        gaAccounts.forEach(function(a) {
            html += '<div class="action-item" style="margin-bottom:8px;">' +
                '<div class="action-item-body">' +
                    '<div class="action-item-title">' + esc(a.display_name) + ' ' +
                        '<span class="badge ' + (a.status === 'active' ? 'badge-success' : 'badge-danger') + '">' + esc(a.status) + '</span>' +
                        (a.last_sync_at ? ' <span class="text-sm text-muted">Synced ' + timeAgo(a.last_sync_at) + '</span>' : '') +
                    '</div>' +
                '</div>' +
                '<div class="action-item-actions">' +
                    '<button class="btn btn-sm btn-ghost btn-danger" onclick="disconnectAccount(\'' + a.id + '\')">Disconnect</button>' +
                '</div></div>';
        });
    }
    html += '<div style="margin-top:12px;"><button class="btn btn-outline btn-sm" onclick="showAddGAModal()">+ Connect GA4</button></div>';
    html += '</div></div>';

    // ── Tier 2–3: Future connectors ──────────────────────────────────────────
    html += '<div class="card"><div class="card-header"><h3>More Connectors <span class="badge badge-neutral">Phase 3</span></h3></div><div class="card-body">' +
        '<div class="text-sm text-muted" style="margin-bottom:8px;">These connectors are coming in Phase 3:</div>';
    [
        ['QuickBooks / Xero', 'Tier 2', 'Full accounting sync — P&L, balance sheet, invoicing'],
        ['PayPal', 'Tier 2', 'PayPal transaction feed and payout data'],
        ['Meta Business Suite', 'Tier 2', 'Facebook + Instagram analytics'],
        ['X / Twitter Analytics', 'Tier 2', 'Engagement and reach data'],
        ['LinkedIn Page', 'Tier 2', 'B2B audience analytics'],
        ['Plaid', 'Tier 3', 'Bank account aggregation — connect when needed'],
    ].forEach(function(c) {
        html += '<div class="action-item" style="margin-bottom:6px;opacity:0.6;">' +
            '<div class="action-item-body">' +
                '<div class="action-item-title">' + c[0] + ' <span class="badge badge-tier">' + c[1] + '</span></div>' +
                '<div class="action-item-summary">' + c[2] + '</div>' +
            '</div>' +
            '<div class="action-item-actions"><button class="btn btn-sm btn-ghost" disabled>Coming Soon</button></div>' +
        '</div>';
    });
    html += '</div></div>';

    // ── Modals ───────────────────────────────────────────────────────────────
    html += '<div id="stripe-add-modal" class="modal-overlay hidden">' +
        '<div class="modal-box" style="max-width:480px;">' +
            '<div class="modal-header"><h2>Add Stripe Account</h2>' +
                '<button class="modal-close" onclick="closeStripeModal()">&times;</button></div>' +
            '<div class="modal-body">' +
                '<form id="stripe-add-form" class="form">' +
                    '<label class="form-label">Display Name' +
                        '<input type="text" class="form-input" id="stripe-display-name" placeholder="e.g. Acme Corp Stripe">' +
                    '</label>' +
                    '<label class="form-label">Stripe API Key' +
                        '<input type="password" class="form-input" id="stripe-api-key" placeholder="sk_live_... or rk_live_..." required>' +
                        '<span class="form-hint">Use a restricted key with read-only access to balance_transactions. ' +
                            'Bx4 does not provide Stripe keys — you must supply your own.</span>' +
                    '</label>' +
                    '<div id="stripe-validate-result" style="margin-bottom:8px;"></div>' +
                    '<div class="flex" style="gap:8px;justify-content:flex-end;">' +
                        '<button type="button" class="btn btn-ghost" onclick="closeStripeModal()">Cancel</button>' +
                        '<button type="button" class="btn btn-outline" onclick="validateStripeKey()">Validate Key</button>' +
                        '<button type="submit" class="btn btn-primary" id="stripe-save-btn" disabled>Save &amp; Connect</button>' +
                    '</div>' +
                '</form>' +
            '</div>' +
        '</div></div>';

    html += '<div id="ga-add-modal" class="modal-overlay hidden">' +
        '<div class="modal-box" style="max-width:520px;">' +
            '<div class="modal-header"><h2>Connect Google Analytics (GA4)</h2>' +
                '<button class="modal-close" onclick="closeGAModal()">&times;</button></div>' +
            '<div class="modal-body">' +
                '<form id="ga-add-form" class="form">' +
                    '<label class="form-label">GA4 Property ID' +
                        '<input type="text" class="form-input" id="ga-property-id" placeholder="e.g. 123456789" required>' +
                        '<span class="form-hint">Found in GA4 → Admin → Property Settings.</span>' +
                    '</label>' +
                    '<label class="form-label">Display Name' +
                        '<input type="text" class="form-input" id="ga-display-name" placeholder="e.g. Main Website">' +
                    '</label>' +
                    '<label class="form-label">Service Account JSON' +
                        '<textarea class="form-input" id="ga-credentials" rows="6" placeholder=\'{"type":"service_account",...}\' required></textarea>' +
                        '<span class="form-hint">Download from Google Cloud Console → Service Accounts → Keys. Grant Viewer access in GA4.</span>' +
                    '</label>' +
                    '<div id="ga-validate-result" style="margin-bottom:8px;"></div>' +
                    '<div class="flex" style="gap:8px;justify-content:flex-end;">' +
                        '<button type="button" class="btn btn-ghost" onclick="closeGAModal()">Cancel</button>' +
                        '<button type="submit" class="btn btn-primary">Validate &amp; Connect</button>' +
                    '</div>' +
                '</form>' +
            '</div>' +
        '</div></div>';

    panel.innerHTML = html;
    _bindConnectorEvents();
}

function _stripeAccountRow(acct, isInternal) {
    var statusClass = acct.status === 'active' ? 'badge-success' : (acct.status === 'error' ? 'badge-danger' : 'badge-neutral');
    var syncInfo = acct.last_sync_at ? ' <span class="text-sm text-muted">Synced ' + timeAgo(acct.last_sync_at) + '</span>' : '';
    var internalBadge = isInternal ? ' <span class="badge badge-tier">Internal</span>' : '';
    return '<div class="action-item" style="margin-bottom:8px;">' +
        '<div class="action-item-body">' +
            '<div class="action-item-title">' + esc(acct.display_name) + internalBadge +
                ' <span class="badge ' + statusClass + '">' + esc(acct.status || 'connected') + '</span>' + syncInfo +
            '</div>' +
            (acct.account_label && !isInternal ? '<div class="action-item-summary text-sm text-muted">Account: ' + esc(acct.account_label) + '</div>' : '') +
        '</div>' +
        '<div class="action-item-actions" style="gap:6px;">' +
            '<button class="btn btn-sm btn-outline" onclick="syncStripeAccount(\'' + acct.id + '\')">Sync Now</button>' +
            '<button class="btn btn-sm btn-ghost" onclick="viewStripeBalance(\'' + acct.id + '\')">Balance</button>' +
            (!isInternal ? '<button class="btn btn-sm btn-ghost btn-danger" onclick="disconnectAccount(\'' + acct.id + '\')">Disconnect</button>' : '') +
        '</div>' +
    '</div>';
}

function _bindConnectorEvents() {
    var form = document.getElementById('stripe-add-form');
    if (form) {
        form.addEventListener('submit', async function(e) {
            e.preventDefault();
            var btn = document.getElementById('stripe-save-btn');
            btn.disabled = true;
            btn.textContent = 'Connecting...';
            try {
                await companyApi('/financial/stripe/connect', {
                    method: 'POST',
                    body: {
                        api_key: document.getElementById('stripe-api-key').value.trim(),
                        display_name: document.getElementById('stripe-display-name').value.trim(),
                    }
                });
                showToast('Stripe account connected', 'success');
                closeStripeModal();
                loadConnectorsTab();
            } catch (err) {
                showToast('Failed: ' + err.message, 'error');
                btn.disabled = false;
                btn.textContent = 'Save & Connect';
            }
        });
    }

    var gaForm = document.getElementById('ga-add-form');
    if (gaForm) {
        gaForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            var btn = gaForm.querySelector('button[type="submit"]');
            btn.disabled = true;
            btn.textContent = 'Connecting...';
            try {
                await companyApi('/social/accounts', {
                    method: 'POST',
                    body: {
                        platform: 'google_analytics',
                        handle: document.getElementById('ga-display-name').value.trim() || 'GA4',
                        display_name: document.getElementById('ga-display-name').value.trim() || 'Google Analytics',
                        property_id: document.getElementById('ga-property-id').value.trim(),
                        credentials_json: document.getElementById('ga-credentials').value.trim(),
                    }
                });
                showToast('Google Analytics connected', 'success');
                closeGAModal();
                loadConnectorsTab();
            } catch (err) {
                showToast('Failed: ' + err.message, 'error');
                btn.disabled = false;
                btn.textContent = 'Validate & Connect';
            }
        });
    }
}

async function stripeSetupInternal() {
    try {
        var btn = event.target;
        btn.disabled = true;
        btn.textContent = 'Connecting...';
        await companyApi('/financial/stripe/setup-internal', { method: 'POST' });
        showToast('OPAI internal Stripe connected', 'success');
        loadConnectorsTab();
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
        event.target.disabled = false;
        event.target.textContent = 'Auto-Connect';
    }
}

async function validateStripeKey() {
    var key = document.getElementById('stripe-api-key').value.trim();
    var result = document.getElementById('stripe-validate-result');
    var saveBtn = document.getElementById('stripe-save-btn');
    result.innerHTML = '<span class="text-sm text-muted">Validating...</span>';
    saveBtn.disabled = true;

    try {
        var data = await companyApi('/financial/stripe/validate-key', {
            method: 'POST',
            body: { api_key: key }
        });
        if (data.valid) {
            result.innerHTML = '<span class="badge badge-success">✓ Valid</span> ' +
                '<span class="text-sm">' + esc(data.account_name || 'Stripe Account') + '</span>';
            saveBtn.disabled = false;
        } else {
            result.innerHTML = '<span class="badge badge-danger">✗ Invalid</span> ' +
                '<span class="text-sm text-muted">' + esc(data.error || 'Key rejected') + '</span>';
        }
    } catch (err) {
        result.innerHTML = '<span class="text-sm" style="color:var(--danger);">' + esc(err.message) + '</span>';
    }
}

async function syncStripeAccount(accountId) {
    try {
        var data = await companyApi('/financial/accounts/' + accountId + '/sync', { method: 'POST' });
        showToast(
            'Synced ' + (data.synced_count || 0) + ' transactions' +
            (data.skipped_count ? ' (' + data.skipped_count + ' already imported)' : '') +
            '. Revenue: $' + (data.revenue_total || 0).toLocaleString(),
            'success'
        );
        loadConnectorsTab();
    } catch (err) {
        showToast('Sync failed: ' + err.message, 'error');
    }
}

async function viewStripeBalance(accountId) {
    try {
        var data = await companyApi('/financial/accounts/' + accountId + '/balance');
        if (data.error) {
            showToast('Balance error: ' + data.error, 'error');
        } else {
            showToast(
                'Available: $' + (data.available || 0).toLocaleString('en-US', {minimumFractionDigits: 2}) +
                ' | Pending: $' + (data.pending || 0).toLocaleString('en-US', {minimumFractionDigits: 2}),
                'info'
            );
        }
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
}

async function disconnectAccount(accountId) {
    if (!confirm('Disconnect this account? Existing imported transactions will be kept.')) return;
    try {
        await companyApi('/financial/accounts/' + accountId, { method: 'DELETE' });
        showToast('Account disconnected', 'success');
        loadConnectorsTab();
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
}

function showAddStripeModal() { document.getElementById('stripe-add-modal').classList.remove('hidden'); }
function closeStripeModal()   { document.getElementById('stripe-add-modal').classList.add('hidden'); }
function showAddGAModal()     { document.getElementById('ga-add-modal').classList.remove('hidden'); }
function closeGAModal()       { document.getElementById('ga-add-modal').classList.add('hidden'); }

// ── Schedule Tab ─────────────────────────────────────────────────────────────
async function loadScheduleTab() {
    var panel = document.getElementById('settings-panel');

    var scheduleData = {};
    try {
        var data = await companyApi('/settings/schedule');
        scheduleData = data && data.schedule ? data.schedule : (data || {});
    } catch (_) { /* defaults */ }

    var wings = ['financial', 'market', 'social', 'operations'];
    var html = '<div class="card"><div class="card-header"><h3>Analysis Schedule</h3></div><div class="card-body">';
    html += '<form id="schedule-form" class="form">';

    wings.forEach(function(wing) {
        var current = scheduleData[wing] || 'manual';
        html += '<div class="form-row" style="align-items:center;">' +
            '<label class="form-label" style="flex:1;">' + wing.charAt(0).toUpperCase() + wing.slice(1) + ' Analysis</label>' +
            '<select class="form-select" id="sched-' + wing + '" style="flex:1;">' +
                '<option value="daily"' + (current === 'daily' ? ' selected' : '') + '>Daily</option>' +
                '<option value="weekly"' + (current === 'weekly' ? ' selected' : '') + '>Weekly</option>' +
                '<option value="manual"' + (current === 'manual' ? ' selected' : '') + '>Manual</option>' +
            '</select>' +
        '</div>';
    });

    html += '<div style="margin-top:16px;"><button type="submit" class="btn btn-primary">Save Schedule</button></div>';
    html += '</form></div></div>';
    panel.innerHTML = html;

    document.getElementById('schedule-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        var schedule = {};
        wings.forEach(function(w) { schedule[w] = document.getElementById('sched-' + w).value; });
        try {
            await companyApi('/settings/schedule', { method: 'PUT', body: { schedule: schedule } });
            showToast('Schedule saved', 'success');
        } catch (err) {
            showToast('Failed: ' + err.message, 'error');
        }
    });
}

// ── Alerts Tab ───────────────────────────────────────────────────────────────
async function loadAlertsTab() {
    var panel = document.getElementById('settings-panel');

    var alerts = [];
    try {
        var data = await companyApi('/settings/alerts');
        alerts = data && data.alerts ? data.alerts : (Array.isArray(data) ? data : []);
    } catch (_) { /* defaults */ }

    // Default alerts if none exist
    if (alerts.length === 0) {
        alerts = [
            { id: 'default-1', metric: 'runway_months', operator: '<', threshold: 3, label: 'Runway below 3 months' },
            { id: 'default-2', metric: 'burn_rate_change', operator: '>', threshold: 20, label: 'Burn rate increases >20%' },
            { id: 'default-3', metric: 'revenue_drop', operator: '>', threshold: 15, label: 'Revenue drops >15%' }
        ];
    }

    var html = '<div class="card"><div class="card-header"><h3>Alert Thresholds</h3></div><div class="card-body">';

    html += '<div class="table-wrap"><table><thead><tr><th>Alert</th><th>Metric</th><th>Condition</th><th>Threshold</th><th></th></tr></thead><tbody>';
    alerts.forEach(function(a) {
        html += '<tr>' +
            '<td>' + esc(a.label || a.metric) + '</td>' +
            '<td class="text-muted">' + esc(a.metric) + '</td>' +
            '<td class="text-muted">' + esc(a.operator || '>') + '</td>' +
            '<td>' + esc(a.threshold) + '</td>' +
            '<td><button class="btn btn-sm btn-ghost" onclick="deleteAlert(\'' + esc(a.id) + '\')" style="color:var(--danger);">Delete</button></td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';

    html += '<div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border);">' +
        '<h4 class="text-sm mb-8" style="font-weight:600;">Add Alert</h4>' +
        '<form id="add-alert-form" class="form-inline">' +
            '<input type="text" class="form-input" id="alert-label" placeholder="Alert label" required>' +
            '<input type="text" class="form-input" id="alert-metric" placeholder="Metric name" required style="width:140px;">' +
            '<select class="form-select" id="alert-operator" style="width:60px;">' +
                '<option value="<">&lt;</option><option value=">">&gt;</option><option value="=">=</option>' +
            '</select>' +
            '<input type="number" step="0.01" class="form-input" id="alert-threshold" placeholder="Value" required style="width:100px;">' +
            '<button type="submit" class="btn btn-sm btn-primary">Add</button>' +
        '</form>' +
    '</div></div></div>';

    panel.innerHTML = html;

    document.getElementById('add-alert-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        try {
            await companyApi('/settings/alerts', {
                method: 'POST',
                body: {
                    label: document.getElementById('alert-label').value.trim(),
                    metric: document.getElementById('alert-metric').value.trim(),
                    operator: document.getElementById('alert-operator').value,
                    threshold: parseFloat(document.getElementById('alert-threshold').value)
                }
            });
            showToast('Alert added', 'success');
            loadAlertsTab();
        } catch (err) {
            showToast('Failed: ' + err.message, 'error');
        }
    });
}

async function deleteAlert(alertId) {
    try {
        await companyApi('/settings/alerts/' + alertId, { method: 'DELETE' });
        showToast('Alert deleted', 'success');
        loadAlertsTab();
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
}

// ── AI Advisor Tab ───────────────────────────────────────────────────────────
async function loadAIAdvisorTab() {
    var panel = document.getElementById('settings-panel');

    var config = {};
    try {
        var data = await companyApi('/settings/advisor');
        config = data && data.config ? data.config : (data || {});
    } catch (_) { /* defaults */ }

    var tone = config.tone || 'executive';
    var depth = config.depth || 'standard';
    var blocked = config.blocked_topics || '';

    var html = '<div class="card"><div class="card-header"><h3>AI Advisor Configuration</h3></div><div class="card-body">' +
        '<form id="advisor-config-form" class="form">' +
            '<label class="form-label">Tone' +
                '<select class="form-select" id="adv-tone">' +
                    '<option value="executive"' + (tone === 'executive' ? ' selected' : '') + '>Executive -- Concise, strategic</option>' +
                    '<option value="detailed"' + (tone === 'detailed' ? ' selected' : '') + '>Detailed -- Thorough explanations</option>' +
                    '<option value="coaching"' + (tone === 'coaching' ? ' selected' : '') + '>Coaching -- Supportive, educational</option>' +
                '</select>' +
            '</label>' +
            '<label class="form-label">Depth' +
                '<select class="form-select" id="adv-depth">' +
                    '<option value="quick"' + (depth === 'quick' ? ' selected' : '') + '>Quick -- Top-line insights</option>' +
                    '<option value="standard"' + (depth === 'standard' ? ' selected' : '') + '>Standard -- Balanced analysis</option>' +
                    '<option value="deep"' + (depth === 'deep' ? ' selected' : '') + '>Deep -- Comprehensive deep-dive</option>' +
                '</select>' +
            '</label>' +
            '<label class="form-label">Blocked Topics' +
                '<textarea class="form-textarea" id="adv-blocked" placeholder="Enter topics the advisor should avoid, one per line">' + esc(blocked) + '</textarea>' +
                '<span class="form-hint">One topic per line. The advisor will not discuss these subjects.</span>' +
            '</label>' +
            '<div><button type="submit" class="btn btn-primary">Save Configuration</button></div>' +
        '</form>' +
    '</div></div>';

    panel.innerHTML = html;

    document.getElementById('advisor-config-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        try {
            await companyApi('/settings/advisor', {
                method: 'PUT',
                body: {
                    tone: document.getElementById('adv-tone').value,
                    depth: document.getElementById('adv-depth').value,
                    blocked_topics: document.getElementById('adv-blocked').value.trim()
                }
            });
            showToast('Advisor configuration saved', 'success');
        } catch (err) {
            showToast('Failed: ' + err.message, 'error');
        }
    });
}

// ── Notifications Tab ─────────────────────────────────────────────────────────
async function loadNotificationsTab() {
    var panel = document.getElementById('settings-panel');

    var settings = {};
    try {
        var data = await companyApi('/settings/notifications');
        settings = data || {};
    } catch (_) { /* defaults */ }

    var notifyDiscord = settings.notify_discord === true;
    var notifyEmail   = settings.notify_email === true;
    var emailAddr     = settings.notify_email_address || '';
    var guildId       = settings.discord_guild_id || '';

    var html = '<div class="card"><div class="card-header"><h3>Notification Channels</h3></div><div class="card-body">' +
        '<p class="text-sm text-muted mb-16">Alerts and briefings will be dispatched via the channels you enable below.</p>' +
        '<form id="notifications-form" class="form">' +

        '<div class="form-row" style="align-items:center;justify-content:space-between;">' +
            '<div><strong>Discord Alerts</strong><div class="text-muted text-sm">Post alerts to a Discord server</div></div>' +
            '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">' +
                '<input type="checkbox" id="notif-discord"' + (notifyDiscord ? ' checked' : '') + ' style="width:18px;height:18px;">' +
                '<span>' + (notifyDiscord ? 'Enabled' : 'Disabled') + '</span>' +
            '</label>' +
        '</div>' +

        '<div id="notif-discord-fields"' + (notifyDiscord ? '' : ' class="hidden"') + ' style="margin:12px 0 16px 0;padding:12px;background:var(--surface-2);border-radius:var(--radius);">' +
            '<label class="form-label">Discord Server ID (Guild ID)' +
                '<input type="text" class="form-input" id="notif-guild-id" value="' + esc(guildId) + '" placeholder="e.g. 1234567890123456789">' +
                '<span class="form-hint">Right-click your Discord server icon → Copy Server ID (Developer Mode must be on).</span>' +
            '</label>' +
        '</div>' +

        '<div class="form-row" style="align-items:center;justify-content:space-between;border-top:1px solid var(--border);padding-top:16px;">' +
            '<div><strong>Email Alerts</strong><div class="text-muted text-sm">Send alerts to an email address</div></div>' +
            '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">' +
                '<input type="checkbox" id="notif-email"' + (notifyEmail ? ' checked' : '') + ' style="width:18px;height:18px;">' +
                '<span>' + (notifyEmail ? 'Enabled' : 'Disabled') + '</span>' +
            '</label>' +
        '</div>' +

        '<div id="notif-email-fields"' + (notifyEmail ? '' : ' class="hidden"') + ' style="margin:12px 0 16px 0;padding:12px;background:var(--surface-2);border-radius:var(--radius);">' +
            '<label class="form-label">Notification Email Address' +
                '<input type="email" class="form-input" id="notif-email-addr" value="' + esc(emailAddr) + '" placeholder="alerts@yourcompany.com">' +
            '</label>' +
        '</div>' +

        '<div style="display:flex;gap:12px;margin-top:8px;">' +
            '<button type="submit" class="btn btn-primary">Save Settings</button>' +
            '<button type="button" class="btn btn-ghost" onclick="sendTestNotification()">Send Test</button>' +
        '</div>' +
        '</form>' +
    '</div></div>';

    panel.innerHTML = html;

    document.getElementById('notif-discord').addEventListener('change', function() {
        document.getElementById('notif-discord-fields').classList.toggle('hidden', !this.checked);
        this.nextElementSibling.textContent = this.checked ? 'Enabled' : 'Disabled';
    });

    document.getElementById('notif-email').addEventListener('change', function() {
        document.getElementById('notif-email-fields').classList.toggle('hidden', !this.checked);
        this.nextElementSibling.textContent = this.checked ? 'Enabled' : 'Disabled';
    });

    document.getElementById('notifications-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        try {
            await companyApi('/settings/notifications', {
                method: 'PUT',
                body: {
                    notify_discord: document.getElementById('notif-discord').checked,
                    notify_email: document.getElementById('notif-email').checked,
                    notify_email_address: document.getElementById('notif-email-addr').value.trim(),
                    discord_guild_id: document.getElementById('notif-guild-id').value.trim(),
                }
            });
            showToast('Notification settings saved', 'success');
        } catch (err) {
            showToast('Failed: ' + err.message, 'error');
        }
    });
}

async function sendTestNotification() {
    try {
        await companyApi('/settings/notifications/test', { method: 'POST' });
        showToast('Test notification sent', 'success');
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
}

// ── Credits Tab (Admin Only) ─────────────────────────────────────────────────
async function loadCreditsTab() {
    var panel = document.getElementById('settings-panel');

    if (!window.BX4.isAdmin) {
        panel.innerHTML = '<div class="text-muted text-center" style="padding:40px;">Admin access required.</div>';
        return;
    }

    var creditData = {};
    try {
        var data = await companyApi('/credits');
        creditData = data || {};
    } catch (_) { /* defaults */ }

    var billingStatus = { billing_active: false };
    try {
        billingStatus = await api('/bx4/api/admin/billing/status') || billingStatus;
    } catch (_) { /* defaults */ }

    var usage = creditData.usage || [];
    var total = creditData.total_consumed || 0;
    var billingActive = billingStatus.billing_active === true;

    var html = '<div class="card"><div class="card-header"><h3>Credit Usage</h3></div><div class="card-body">';

    html += '<div class="snapshot-grid" style="margin-bottom:24px;">' +
        '<div class="snapshot-item"><div class="snapshot-label">Total Credits Used</div><div class="snapshot-value">' + fmtNum(total) + '</div></div>' +
        '<div class="snapshot-item"><div class="snapshot-label">Billing Status</div>' +
            '<div class="snapshot-value" style="font-size:14px;color:' + (billingActive ? 'var(--warning)' : 'var(--success)') + ';">' +
                (billingActive ? 'ACTIVE' : 'INACTIVE') +
            '</div>' +
        '</div>' +
    '</div>';

    if (usage.length > 0) {
        html += '<div class="section-title mb-8">Per-Action Breakdown</div>' +
            '<div class="table-wrap"><table><thead><tr><th>Action</th><th class="text-right">Count</th><th class="text-right">Credits</th></tr></thead><tbody>';
        usage.forEach(function(u) {
            html += '<tr><td>' + esc(u.action || u.type) + '</td><td class="text-right">' + fmtNum(u.count) + '</td><td class="text-right">' + fmtNum(u.credits) + '</td></tr>';
        });
        html += '</tbody></table></div>';
    } else {
        html += '<div class="text-muted text-sm">No credit usage recorded yet.</div>';
    }

    // Billing activation toggle (admin only)
    html += '<div style="margin-top:24px;padding:16px;border:1px solid var(--border);border-radius:var(--radius);">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:16px;">' +
            '<div>' +
                '<div style="font-weight:600;margin-bottom:4px;">Billing Activation</div>' +
                '<div class="text-muted text-sm">' +
                    (billingActive
                        ? 'Credits are metered — deducted per analysis run.'
                        : 'Billing is inactive. Credits are unlimited during beta.') +
                '</div>' +
            '</div>' +
            '<button id="billing-toggle-btn" class="btn ' + (billingActive ? 'btn-danger' : 'btn-primary') + '" onclick="toggleBillingActive(this)">' +
                (billingActive ? 'Deactivate Billing' : 'Activate Billing') +
            '</button>' +
        '</div>' +
    '</div>';

    html += '</div></div>';
    panel.innerHTML = html;
}

async function toggleBillingActive(btn) {
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
        var result = await api('/bx4/api/admin/billing/toggle', { method: 'POST' });
        showToast('Billing ' + (result.billing_active ? 'activated' : 'deactivated'), 'success');
        loadCreditsTab();
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
        btn.disabled = false;
    }
}

// Expose globally
window.switchSettingsTab = switchSettingsTab;
window.revokeAccess = revokeAccess;
window.configureConnector = configureConnector;
window.closeConnectorConfig = closeConnectorConfig;
window.deleteAlert = deleteAlert;
window.sendTestNotification = sendTestNotification;
window.toggleBillingActive = toggleBillingActive;
