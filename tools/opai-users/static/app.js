/* OPAI User Controls — Standalone Dashboard */

const API = '';

// ── State ──────────────────────────────────────────────
let _usersData = [];
let _agentsList = [];
let _appsList = [];
let _networkLocked = false;
let _pinAction = null;
let _authReady = false;

// ── Auth ───────────────────────────────────────────────

async function authFetch(url, opts = {}) {
    if (typeof opaiAuth !== 'undefined') {
        return opaiAuth.fetchWithAuth(url, opts);
    }
    return fetch(url, opts);
}

// ── Utilities ──────────────────────────────────────────

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function showToast(msg, color) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = `toast visible toast-${color || 'blue'}`;
    setTimeout(() => { el.className = 'toast'; }, 5000);
}

// ── Apps ──────────────────────────────────────────────

async function loadApps() {
    try {
        const res = await fetch(API + 'api/apps');
        const data = await res.json();
        _appsList = data.apps || [];
    } catch (e) {
        _appsList = [];
    }
    renderAppCheckboxes('invite-apps', []);
    renderAppCheckboxes('edit-user-apps', []);
}

function renderAppCheckboxes(containerId, checkedApps) {
    const container = document.getElementById(containerId);
    if (!_appsList.length) {
        container.innerHTML = '<span class="text-muted">No apps available</span>';
        return;
    }
    container.innerHTML = _appsList.map(a =>
        `<label class="checkbox-label"><input type="checkbox" value="${a.id}" ${checkedApps.includes(a.id) ? 'checked' : ''}> ${escapeHtml(a.label)}</label>`
    ).join('');
}

// ── Users ──────────────────────────────────────────────

async function loadUsers() {
    if (!_authReady) return;
    try {
        const res = await authFetch(API + 'api/users');
        if (!res.ok) return;
        const data = await res.json();
        _usersData = data.users || [];
        const badge = document.getElementById('users-badge');
        const activeCount = _usersData.filter(u => u.is_active).length;
        badge.textContent = `${activeCount}/${_usersData.length}`;
        renderUsersTable();

        // Check kill switch
        const settingRes = await authFetch(API + 'api/system/settings/users_enabled').catch(() => null);
        if (settingRes && settingRes.ok) {
            const setting = await settingRes.json();
            const enabled = setting.value?.enabled !== false;
            document.getElementById('drop-banner').style.display = enabled ? 'none' : '';
            document.getElementById('dropAllBtn').textContent = enabled ? 'Drop All Users' : 'Users Dropped';
        }
    } catch (e) {
        document.getElementById('users-content').innerHTML =
            '<div class="empty-state">Failed to load users</div>';
    }
}

function renderUsersTable() {
    const container = document.getElementById('users-content');
    if (!_usersData.length) {
        container.innerHTML = '<div class="empty-state">No users found</div>';
        return;
    }

    let html = '<table class="data-table"><thead><tr>' +
        '<th></th><th>Name</th><th>Email</th><th>Role</th><th>Active</th>' +
        '<th>Apps</th><th>Preface</th><th>Actions</th>' +
        '</tr></thead><tbody>';

    for (const u of _usersData) {
        const dotCls = u.is_active ? 'active' : 'inactive';
        const roleCls = u.role === 'admin' ? 'chip-running' : 'chip-queued';
        const apps = (u.allowed_apps || []).map(a =>
            `<span class="chip chip-active">${escapeHtml(a)}</span>`
        ).join(' ') || '<span class="text-muted">--</span>';
        const hasPreface = u.preface_prompt ? '<span class="preface-indicator" title="Has preface prompt">P</span>' : '';
        const rowClass = u.ai_locked ? ' class="ai-locked-row"' : '';
        const lockIcon = u.ai_locked ? '<span class="lock-icon" title="AI Locked">&#128274;</span> ' : '';

        html += `<tr${rowClass}>
            <td>${lockIcon}<span class="status-dot ${dotCls}"></span></td>
            <td>${escapeHtml(u.display_name || '--')}</td>
            <td>${escapeHtml(u.email)}</td>
            <td><span class="chip ${roleCls}">${u.role}</span></td>
            <td>
                <button class="btn ${u.is_active ? 'btn-success' : 'btn-danger'} user-toggle"
                    onclick="toggleUserActive('${u.id}', ${!u.is_active})">
                    ${u.is_active ? 'ON' : 'OFF'}
                </button>
            </td>
            <td>${apps}</td>
            <td>${hasPreface}</td>
            <td>
                <button class="btn btn-primary" onclick="openEditUserModal('${u.id}')">Edit</button>
            </td>
        </tr>`;
    }

    html += '</tbody></table>';
    container.innerHTML = html;
}

async function toggleUserActive(userId, newState) {
    try {
        const res = await authFetch(`${API}api/users/${userId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_active: newState }),
        });
        const data = await res.json();
        if (data.success) {
            showToast(`User ${newState ? 'enabled' : 'disabled'}`, 'green');
            await loadUsers();
        } else {
            showToast('Failed to update user', 'red');
        }
    } catch (e) {
        showToast('Failed to update user', 'red');
    }
}

// ── Invite Modal ──────────────────────────────────────

function openInviteModal() {
    document.getElementById('invite-email').value = '';
    document.getElementById('invite-name').value = '';
    document.getElementById('invite-role').value = 'user';
    document.getElementById('invite-preface').value = '';
    document.getElementById('invite-tailscale').value = '';
    document.getElementById('invite-message').value = '';
    renderAppCheckboxes('invite-apps', []);
    document.getElementById('invite-modal').classList.add('visible');
}

function closeInviteModal() {
    document.getElementById('invite-modal').classList.remove('visible');
}

async function sendInvite() {
    const email = document.getElementById('invite-email').value.trim();
    if (!email) { alert('Email is required'); return; }

    const allowedApps = [];
    document.querySelectorAll('#invite-apps input[type=checkbox]:checked').forEach(cb => {
        allowedApps.push(cb.value);
    });

    const body = {
        email,
        display_name: document.getElementById('invite-name').value.trim(),
        role: document.getElementById('invite-role').value,
        preface_prompt: document.getElementById('invite-preface').value.trim(),
        allowed_apps: allowedApps,
        tailscale_invite: document.getElementById('invite-tailscale').value.trim(),
        custom_message: document.getElementById('invite-message').value.trim(),
    };

    try {
        const res = await authFetch(`${API}api/users/invite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json();
        if (data.success) {
            showToast(`Invite sent to ${email}`, 'green');
            closeInviteModal();
            await loadUsers();
        } else {
            showToast(`Invite failed: ${data.detail || 'unknown'}`, 'red');
        }
    } catch (e) {
        showToast('Failed to send invite', 'red');
    }
}

// ── Edit User Modal ───────────────────────────────────

async function openEditUserModal(userId) {
    const user = _usersData.find(u => u.id === userId);
    if (!user) return;

    document.getElementById('edit-user-id').value = userId;
    document.getElementById('edit-user-name').value = user.display_name || '';
    document.getElementById('edit-user-role').value = user.role || 'user';
    document.getElementById('edit-user-active').value = user.is_active ? 'true' : 'false';
    document.getElementById('edit-user-preface').value = user.preface_prompt || '';
    document.getElementById('edit-user-sandbox').value = user.sandbox_path || '';
    document.getElementById('edit-user-marketplace-tier').value = user.marketplace_tier || 'free';

    // BB link status
    const bbBadge = document.getElementById('bb-link-badge');
    const bbLinkBtn = document.getElementById('bb-link-btn');
    const bbSyncedBadge = document.getElementById('bb-tier-synced-badge');
    const tierSelect = document.getElementById('edit-user-marketplace-tier');
    if (user.bb_user_id) {
        bbBadge.textContent = 'Linked';
        bbBadge.style.background = '#6c5ce722';
        bbBadge.style.color = '#a29bfe';
        bbLinkBtn.textContent = 'Re-sync Tier';
        bbSyncedBadge.style.display = '';
        tierSelect.disabled = true;
    } else {
        bbBadge.textContent = 'Not Linked';
        bbBadge.style.background = '#2a2d35';
        bbBadge.style.color = '#8b8e96';
        bbLinkBtn.textContent = 'Link by Email';
        bbSyncedBadge.style.display = 'none';
        tierSelect.disabled = false;
    }

    // n8n status
    const n8nBadge = document.getElementById('n8n-status-badge');
    const n8nLinkControls = document.getElementById('n8n-link-controls');
    const n8nUnlinkBtn = document.getElementById('n8n-unlink-btn');
    const n8nCreds = document.getElementById('n8n-credentials');
    n8nCreds.style.display = 'none';
    if (user.n8n_provisioned) {
        n8nBadge.textContent = 'Linked: ' + (user.n8n_username || '');
        n8nBadge.style.background = '#00b89422';
        n8nBadge.style.color = '#00b894';
        n8nLinkControls.style.display = 'none';
        n8nUnlinkBtn.style.display = '';
    } else {
        n8nBadge.textContent = 'Not Linked';
        n8nBadge.style.background = '#2a2d35';
        n8nBadge.style.color = '#8b8e96';
        n8nLinkControls.style.display = 'flex';
        n8nUnlinkBtn.style.display = 'none';
        loadN8nAccounts();
    }

    const apps = user.allowed_apps || [];
    renderAppCheckboxes('edit-user-apps', apps);

    await loadAgentsList();
    const agentsContainer = document.getElementById('edit-user-agents');
    const userAgents = user.allowed_agents || [];
    if (_agentsList.length) {
        agentsContainer.innerHTML = _agentsList.map(a =>
            `<label class="checkbox-label"><input type="checkbox" value="${a}" ${userAgents.includes(a) ? 'checked' : ''}> ${a}</label>`
        ).join('');
    } else {
        agentsContainer.innerHTML = '<span class="text-muted">No agents found</span>';
    }

    // AI lock banner and unlock button
    const lockBanner = document.getElementById('ai-lock-banner');
    const unlockBtn = document.getElementById('unlock-ai-btn');
    if (user.ai_locked) {
        lockBanner.style.display = 'flex';
        document.getElementById('ai-lock-reason').textContent = user.ai_locked_reason || 'No reason recorded';
        unlockBtn.style.display = '';
    } else {
        lockBanner.style.display = 'none';
        unlockBtn.style.display = 'none';
    }

    // Hide delete for admin users
    const deleteBtn = document.getElementById('hard-delete-btn');
    deleteBtn.style.display = user.role === 'admin' ? 'none' : '';

    document.getElementById('edit-user-title').textContent = `Edit: ${user.display_name || user.email}`;
    document.getElementById('edit-user-modal').classList.add('visible');
}

function closeEditUserModal() {
    document.getElementById('edit-user-modal').classList.remove('visible');
}

async function loadAgentsList() {
    if (_agentsList.length) return;
    try {
        const res = await fetch(API + 'api/team');
        const data = await res.json();
        if (data.agents) {
            _agentsList = data.agents.map(a => a.name || a.role).filter(Boolean);
        }
    } catch (e) { /* ignore */ }
}

async function saveUser() {
    const userId = document.getElementById('edit-user-id').value;
    if (!userId) return;

    const allowedApps = [];
    document.querySelectorAll('#edit-user-apps input[type=checkbox]:checked').forEach(cb => {
        allowedApps.push(cb.value);
    });

    const allowedAgents = [];
    document.querySelectorAll('#edit-user-agents input[type=checkbox]:checked').forEach(cb => {
        allowedAgents.push(cb.value);
    });

    const body = {
        display_name: document.getElementById('edit-user-name').value.trim(),
        role: document.getElementById('edit-user-role').value,
        is_active: document.getElementById('edit-user-active').value === 'true',
        preface_prompt: document.getElementById('edit-user-preface').value,
        allowed_apps: allowedApps,
        allowed_agents: allowedAgents,
        sandbox_path: document.getElementById('edit-user-sandbox').value.trim(),
        marketplace_tier: document.getElementById('edit-user-marketplace-tier').value,
    };

    try {
        const res = await authFetch(`${API}api/users/${userId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json();
        if (data.success) {
            showToast('User updated', 'green');
            closeEditUserModal();
            await loadUsers();
        } else {
            showToast(`Update failed: ${data.detail || 'unknown'}`, 'red');
        }
    } catch (e) {
        showToast('Failed to update user', 'red');
    }
}

// ── n8n Account Linking & Provisioning ─────────────────

let _n8nAccounts = [];

async function loadN8nAccounts() {
    const select = document.getElementById('n8n-account-select');
    select.innerHTML = '<option value="">Loading...</option>';
    try {
        const res = await authFetch('/marketplace/api/n8n/accounts');
        if (!res.ok) {
            console.error('n8n accounts fetch failed:', res.status, await res.text());
            select.innerHTML = '<option value="">Error: ' + res.status + '</option>';
            return;
        }
        const data = await res.json();
        _n8nAccounts = data.accounts || [];

        // Get emails already linked to other OPAI users
        const linkedEmails = new Set(
            _usersData
                .filter(u => u.n8n_provisioned && u.n8n_username)
                .map(u => u.n8n_username.toLowerCase())
        );

        select.innerHTML = '<option value="">-- Select account --</option>';
        for (const acc of _n8nAccounts) {
            if (linkedEmails.has(acc.email.toLowerCase())) continue;
            const label = acc.first_name ? acc.email + ' (' + acc.first_name + ')' : acc.email;
            select.innerHTML += '<option value="' + escapeHtml(acc.email) + '">' + escapeHtml(label) + '</option>';
        }
    } catch (e) {
        select.innerHTML = '<option value="">Failed to load</option>';
    }
}

async function linkN8nAccount() {
    const userId = document.getElementById('edit-user-id').value;
    const email = document.getElementById('n8n-account-select').value;
    if (!userId || !email) { showToast('Select an n8n account first', 'red'); return; }

    const btn = document.getElementById('n8n-link-btn');
    btn.disabled = true;
    btn.textContent = 'Linking...';

    try {
        const res = await authFetch('/marketplace/api/n8n/link', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId, n8n_email: email }),
        });
        const data = await res.json();
        if (data.ok) {
            showToast('Linked n8n account: ' + email, 'green');
            const badge = document.getElementById('n8n-status-badge');
            badge.textContent = 'Linked: ' + email;
            badge.style.background = '#00b89422';
            badge.style.color = '#00b894';
            document.getElementById('n8n-link-controls').style.display = 'none';
            document.getElementById('n8n-unlink-btn').style.display = '';
            await loadUsers();
        } else {
            showToast('Link failed: ' + (data.detail || 'unknown'), 'red');
        }
    } catch (e) {
        showToast('n8n link failed', 'red');
    }
    btn.disabled = false;
    btn.textContent = 'Link';
}

async function unlinkN8n() {
    const userId = document.getElementById('edit-user-id').value;
    if (!userId) return;
    if (!confirm('Unlink this n8n account?')) return;

    try {
        const res = await authFetch('/marketplace/api/n8n/link', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId, n8n_email: '' }),
        });
        const data = await res.json();
        if (data.ok) {
            showToast('n8n account unlinked', 'green');
            const badge = document.getElementById('n8n-status-badge');
            badge.textContent = 'Not Linked';
            badge.style.background = '#2a2d35';
            badge.style.color = '#8b8e96';
            document.getElementById('n8n-link-controls').style.display = 'flex';
            document.getElementById('n8n-unlink-btn').style.display = 'none';
            loadN8nAccounts();
            await loadUsers();
        } else {
            showToast('Unlink failed', 'red');
        }
    } catch (e) {
        showToast('Unlink failed', 'red');
    }
}

async function provisionN8n() {
    const userId = document.getElementById('edit-user-id').value;
    if (!userId) return;
    if (!confirm('Create a NEW n8n account for this user?')) return;

    const btn = document.getElementById('n8n-provision-btn');
    btn.disabled = true;
    btn.textContent = 'Provisioning...';

    try {
        const res = await authFetch('/marketplace/api/n8n/provision', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId }),
        });
        const data = await res.json();
        if (data.success) {
            showToast('n8n account created', 'green');
            document.getElementById('n8n-username').textContent = data.username || '';
            document.getElementById('n8n-password').textContent = data.password || '';
            document.getElementById('n8n-credentials').style.display = 'block';
            const badge = document.getElementById('n8n-status-badge');
            badge.textContent = 'Linked: ' + (data.username || '');
            badge.style.background = '#00b89422';
            badge.style.color = '#00b894';
            document.getElementById('n8n-link-controls').style.display = 'none';
            document.getElementById('n8n-unlink-btn').style.display = '';
            await loadUsers();
        } else {
            showToast('n8n provisioning failed: ' + (data.detail || 'unknown'), 'red');
            btn.disabled = false;
            btn.textContent = 'Provision New';
        }
    } catch (e) {
        showToast('n8n provisioning failed', 'red');
        btn.disabled = false;
        btn.textContent = 'Provision New';
    }
}

async function syncAllN8n() {
    if (!confirm('Sync all OPAI users with n8n accounts by email match?')) return;

    const btn = document.getElementById('syncN8nBtn');
    btn.disabled = true;
    btn.textContent = 'Syncing...';

    try {
        const res = await authFetch('/marketplace/api/n8n/sync-all', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
            showToast('n8n Sync: ' + data.linked_count + ' linked, ' + data.skipped_count + ' skipped', 'green');
            await loadUsers();
        } else {
            showToast('n8n sync failed: ' + (data.detail || 'unknown'), 'red');
        }
    } catch (e) {
        showToast('n8n sync failed', 'red');
    }
    btn.disabled = false;
    btn.textContent = 'Sync n8n';
}

// ── BoutaByte Linking ─────────────────────────────────

async function linkBBAccount() {
    const userId = document.getElementById('edit-user-id').value;
    if (!userId) return;

    const user = _usersData.find(u => u.id === userId);
    if (!user) return;

    const btn = document.getElementById('bb-link-btn');
    btn.disabled = true;
    btn.textContent = 'Looking up...';

    try {
        // If already linked, just re-sync
        if (user.bb_user_id) {
            const res = await authFetch('/marketplace/api/bb/link', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: userId, bb_user_id: user.bb_user_id }),
            });
            const data = await res.json();
            if (data.ok) {
                showToast('Tier re-synced from BoutaByte: ' + data.synced_tier, 'green');
                document.getElementById('edit-user-marketplace-tier').value = data.synced_tier;
                await loadUsers();
            } else {
                showToast('Re-sync failed: ' + (data.detail || 'unknown'), 'red');
            }
            btn.disabled = false;
            btn.textContent = 'Re-sync Tier';
            return;
        }

        // Lookup by email
        const lookupRes = await authFetch('/marketplace/api/bb/lookup?email=' + encodeURIComponent(user.email));
        const lookup = await lookupRes.json();

        if (!lookup.found) {
            showToast('No BoutaByte account found for ' + user.email, 'red');
            btn.disabled = false;
            btn.textContent = 'Link by Email';
            return;
        }

        // Auto-link
        const linkRes = await authFetch('/marketplace/api/bb/link', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId, bb_user_id: lookup.bb_user_id }),
        });
        const linkData = await linkRes.json();

        if (linkData.ok) {
            showToast('Linked to BB: ' + (lookup.bb_display_name || lookup.bb_email) + ' (tier: ' + linkData.synced_tier + ')', 'green');
            // Update UI
            const bbBadge = document.getElementById('bb-link-badge');
            bbBadge.textContent = 'Linked';
            bbBadge.style.background = '#6c5ce722';
            bbBadge.style.color = '#a29bfe';
            btn.textContent = 'Re-sync Tier';
            document.getElementById('bb-tier-synced-badge').style.display = '';
            document.getElementById('edit-user-marketplace-tier').value = linkData.synced_tier;
            document.getElementById('edit-user-marketplace-tier').disabled = true;
            await loadUsers();
        } else {
            showToast('Link failed: ' + (linkData.detail || 'unknown'), 'red');
            btn.textContent = 'Link by Email';
        }
    } catch (e) {
        showToast('BB link failed', 'red');
        btn.textContent = user.bb_user_id ? 'Re-sync Tier' : 'Link by Email';
    }
    btn.disabled = false;
}

async function syncAllBB() {
    if (!confirm('Sync all OPAI users with BoutaByte accounts by email match?')) return;

    const btn = document.getElementById('syncBBBtn');
    btn.disabled = true;
    btn.textContent = 'Syncing...';

    try {
        const res = await authFetch('/marketplace/api/bb/sync-all', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
            showToast('BB Sync: ' + data.linked_count + ' linked, ' + data.skipped_count + ' skipped, ' + data.failed_count + ' failed', 'green');
            await loadUsers();
        } else {
            showToast('BB sync failed: ' + (data.detail || 'unknown'), 'red');
        }
    } catch (e) {
        showToast('BB sync failed', 'red');
    }
    btn.disabled = false;
    btn.textContent = 'Sync BB';
}

// ── Unlock AI / Hard Delete ───────────────────────────

async function unlockAI() {
    const userId = document.getElementById('edit-user-id').value;
    if (!userId) return;
    if (!confirm('Unlock AI access for this user?')) return;

    try {
        const res = await authFetch(`${API}api/users/${userId}/unlock-ai`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast('AI access unlocked', 'green');
            closeEditUserModal();
            await loadUsers();
        } else {
            showToast('Unlock failed: ' + (data.detail || 'unknown'), 'red');
        }
    } catch (e) {
        showToast('Unlock failed', 'red');
    }
}

async function hardDeleteUser() {
    const userId = document.getElementById('edit-user-id').value;
    if (!userId) return;

    const user = _usersData.find(u => u.id === userId);
    if (user && user.role === 'admin') {
        alert('Cannot delete admin users');
        return;
    }

    if (!confirm('PERMANENTLY DELETE this user? This removes their profile, auth account, and sandbox. This cannot be undone.')) return;
    if (!confirm('Are you absolutely sure? Type the button again to confirm.')) return;

    try {
        const res = await authFetch(`${API}api/users/${userId}/hard-delete`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            showToast('User permanently deleted', 'red');
            closeEditUserModal();
            await loadUsers();
        } else {
            showToast('Delete failed: ' + (data.detail || 'unknown'), 'red');
        }
    } catch (e) {
        showToast('Delete failed', 'red');
    }
}

// ── Drop All / Restore All ────────────────────────────

async function dropAllUsers() {
    if (!confirm('Deactivate ALL non-admin users? This is a global kill switch.')) return;
    if (!confirm('Are you sure? All non-admin users will lose access immediately.')) return;

    try {
        const res = await authFetch(`${API}api/users/drop-all`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast('All non-admin users deactivated', 'red');
            await loadUsers();
        } else {
            showToast(`Drop failed: ${data.detail || 'unknown'}`, 'red');
        }
    } catch (e) {
        showToast('Failed to drop users', 'red');
    }
}

async function restoreAllUsers() {
    if (!confirm('Re-enable ALL users?')) return;
    try {
        const res = await authFetch(`${API}api/users/restore-all`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast('All users re-enabled', 'green');
            await loadUsers();
        } else {
            showToast(`Restore failed: ${data.detail || 'unknown'}`, 'red');
        }
    } catch (e) {
        showToast('Failed to restore users', 'red');
    }
}

// ── Network Lockdown ──────────────────────────────────

async function checkNetworkStatus() {
    if (!_authReady) return;
    try {
        const res = await authFetch(API + 'api/system/network/status');
        if (!res.ok) return;
        const data = await res.json();
        _networkLocked = data.locked === true;
        updateNetworkButton();
    } catch (e) { /* ignore */ }
}

function updateNetworkButton() {
    const btn = document.getElementById('killNetBtn');
    if (_networkLocked) {
        btn.textContent = 'LOCKED';
        btn.className = 'header-btn header-btn-danger active';
    } else {
        btn.textContent = 'Kill Net';
        btn.className = 'header-btn header-btn-danger';
    }
}

function toggleNetworkLockdown() {
    _pinAction = _networkLocked ? 'restore' : 'lockdown';
    document.getElementById('pin-modal-title').textContent =
        _networkLocked ? 'Restore Networking' : 'Confirm Network Lockdown';
    document.getElementById('pin-modal-desc').textContent =
        _networkLocked ? 'Enter PIN to restore all network connectivity'
                       : 'Enter PIN to kill ALL external connections (Tailscale, UFW, RustDesk)';
    document.getElementById('pin-confirm-btn').textContent = _networkLocked ? 'Restore' : 'Lock Down';
    document.getElementById('pin-confirm-btn').className = _networkLocked ? 'btn btn-success' : 'btn btn-danger';
    document.getElementById('pin-input').value = '';
    document.getElementById('pin-modal').classList.add('visible');
    setTimeout(() => document.getElementById('pin-input').focus(), 100);
}

function closePinModal() {
    document.getElementById('pin-modal').classList.remove('visible');
    _pinAction = null;
}

async function confirmPinAction() {
    const pin = document.getElementById('pin-input').value;
    if (!pin) { alert('PIN is required'); return; }

    const endpoint = _pinAction === 'restore'
        ? 'api/system/network/restore'
        : 'api/system/network/lockdown';

    try {
        const res = await authFetch(`${API}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin }),
        });
        const data = await res.json();
        if (data.success) {
            showToast(
                _pinAction === 'restore' ? 'Network restored' : 'Network LOCKED DOWN',
                _pinAction === 'restore' ? 'green' : 'red'
            );
            _networkLocked = _pinAction === 'lockdown';
            updateNetworkButton();
            closePinModal();
        } else {
            showToast(`Failed: ${data.detail || 'Invalid PIN'}`, 'red');
        }
    } catch (e) {
        showToast('Network action failed', 'red');
    }
}

// ── Keyboard / Modal ──────────────────────────────────

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeInviteModal();
        closeEditUserModal();
        closePinModal();
    }
});

document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
        if (e.target.classList.contains('modal-overlay')) {
            e.target.classList.remove('visible');
            _pinAction = null;
        }
    });
});

// ── Initialization ─────────────────────────────────────

(async () => {
    try {
        const cfg = await fetch('api/auth/config').then(r => r.json());
        if (cfg.supabase_url && cfg.supabase_anon_key) {
            window.OPAI_SUPABASE_URL = cfg.supabase_url;
            window.OPAI_SUPABASE_ANON_KEY = cfg.supabase_anon_key;
            if (typeof opaiAuth !== 'undefined') {
                const user = await opaiAuth.init({ requireApp: 'users' });
                if (user) {
                    _authReady = true;
                    document.getElementById('user-email').textContent = user.email;
                    await loadApps();
                    loadUsers();
                    checkNetworkStatus();
                    setInterval(loadUsers, 15000);
                    setInterval(checkNetworkStatus, 10000);
                }
            }
        }
    } catch (e) {
        console.warn('Auth init failed:', e.message);
    }
})();
