// OPAI Messenger - Channel management

async function loadChannels() {
    try {
        const resp = await authFetch('api/channels');
        App.channels = await resp.json();
        renderChannelList();
    } catch (e) {
        console.error('Failed to load channels:', e);
    }
}

function renderChannelList() {
    const list = document.getElementById('channel-list');
    const filter = document.getElementById('channel-filter')?.value?.toLowerCase() || '';

    const filtered = filter
        ? App.channels.filter(c => (c.name || '').toLowerCase().includes(filter))
        : App.channels;

    if (!filtered.length) {
        list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--color-text-tertiary);font-size:0.8125rem;">No conversations yet</div>';
        return;
    }

    list.innerHTML = filtered.map(ch => {
        const isActive = App.activeChannel?.id === ch.id;
        const initials = getInitials(ch.name);
        const preview = ch.last_message
            ? truncate(ch.last_message.content || 'Attachment', 35)
            : 'No messages yet';
        const time = ch.last_message ? formatTime(ch.last_message.created_at) : '';

        // Online status for DMs
        let onlineDot = '';
        if (ch.type === 'dm' && ch.members) {
            const other = ch.members.find(m => m && m.id !== App.user.id);
            if (other) {
                const isOnline = App.onlineUsers.some(u => u.user_id === other.id);
                onlineDot = `<div class="online-dot ${isOnline ? '' : 'offline'}"></div>`;
            }
        }

        const unreadBadge = ch.unread_count > 0
            ? `<div class="unread-badge">${ch.unread_count > 99 ? '99+' : ch.unread_count}</div>`
            : '';

        return `
            <div class="channel-item ${isActive ? 'active' : ''}" onclick="selectChannel('${ch.id}')">
                <div class="channel-avatar">
                    ${ch.type === 'group' ? '👥' : initials}
                    ${onlineDot}
                </div>
                <div class="channel-info">
                    <div class="channel-name">${escapeHtml(ch.name || 'Unknown')}</div>
                    <div class="channel-preview">${escapeHtml(preview)}</div>
                </div>
                <div class="channel-meta">
                    <div class="channel-time">${time}</div>
                    ${unreadBadge}
                </div>
            </div>
        `;
    }).join('');
}

function filterChannels(query) {
    renderChannelList();
}

async function selectChannel(channelId) {
    const channel = App.channels.find(c => c.id === channelId);
    if (!channel) return;

    App.activeChannel = channel;

    // Reset unread
    channel.unread_count = 0;
    renderChannelList();

    // Show chat UI
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('chat-header').style.display = 'flex';
    document.getElementById('messages').style.display = 'flex';
    document.getElementById('typing-indicator').style.display = 'block';
    document.getElementById('input-area').style.display = 'block';

    // Set header
    document.getElementById('chat-avatar').textContent =
        channel.type === 'group' ? '👥' : getInitials(channel.name);
    document.getElementById('chat-name').textContent = channel.name || 'Unknown';

    // Status line
    if (channel.type === 'dm' && channel.members) {
        const other = channel.members.find(m => m && m.id !== App.user.id);
        if (other) {
            const isOnline = App.onlineUsers.some(u => u.user_id === other.id);
            document.getElementById('chat-status').textContent = isOnline ? 'Online' : 'Offline';
        }
    } else if (channel.type === 'group' && channel.members) {
        document.getElementById('chat-status').textContent =
            `${channel.members.length} members`;
    }

    // Load messages
    await loadMessages();

    // Mark as read
    authFetch(`api/channels/${channelId}/read`, { method: 'PATCH' });

    // Focus input
    document.getElementById('message-input').focus();
}

// New DM Modal
function showNewDMModal() {
    const modal = document.getElementById('dm-modal');
    const list = document.getElementById('dm-user-list');

    // Filter out self
    const others = App.users.filter(u => u.id !== App.user.id);

    list.innerHTML = others.map(u => `
        <div class="modal-user-item" data-user-id="${u.id}" onclick="toggleDMUser(this)">
            <div class="user-check"></div>
            <span>${escapeHtml(u.display_name || u.email)}</span>
        </div>
    `).join('');

    document.getElementById('dm-user-search').value = '';
    modal.classList.add('visible');

    // Start DM button
    document.getElementById('btn-start-dm').onclick = async () => {
        const selected = list.querySelector('.modal-user-item.selected');
        if (!selected) return;
        const userId = selected.dataset.userId;
        await startDM(userId);
        modal.classList.remove('visible');
    };

    // Search filter
    document.getElementById('dm-user-search').oninput = (e) => {
        const q = e.target.value.toLowerCase();
        list.querySelectorAll('.modal-user-item').forEach(item => {
            const name = item.textContent.toLowerCase();
            item.style.display = name.includes(q) ? '' : 'none';
        });
    };
}

function toggleDMUser(el) {
    // Single select for DMs
    el.parentElement.querySelectorAll('.modal-user-item').forEach(i => i.classList.remove('selected'));
    el.classList.add('selected');
    el.querySelector('.user-check').textContent = '✓';
}

async function startDM(userId) {
    try {
        const resp = await authFetch('api/channels', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'dm', member_ids: [userId] }),
        });
        const data = await resp.json();
        await loadChannels();
        selectChannel(data.id);
    } catch (e) {
        console.error('Failed to create DM:', e);
    }
}

// New Group Modal
function showNewGroupModal() {
    const modal = document.getElementById('group-modal');
    const list = document.getElementById('group-user-list');

    const others = App.users.filter(u => u.id !== App.user.id);
    list.innerHTML = others.map(u => `
        <div class="modal-user-item" data-user-id="${u.id}" onclick="toggleGroupUser(this)">
            <div class="user-check"></div>
            <span>${escapeHtml(u.display_name || u.email)}</span>
        </div>
    `).join('');

    document.getElementById('group-name-input').value = '';
    document.getElementById('group-user-search').value = '';
    modal.classList.add('visible');

    document.getElementById('btn-create-group').onclick = async () => {
        const name = document.getElementById('group-name-input').value.trim();
        if (!name) {
            document.getElementById('group-name-input').focus();
            return;
        }
        const selected = [...list.querySelectorAll('.modal-user-item.selected')]
            .map(el => el.dataset.userId);
        if (!selected.length) return;

        await createGroup(name, selected);
        modal.classList.remove('visible');
    };

    document.getElementById('group-user-search').oninput = (e) => {
        const q = e.target.value.toLowerCase();
        list.querySelectorAll('.modal-user-item').forEach(item => {
            const name = item.textContent.toLowerCase();
            item.style.display = name.includes(q) ? '' : 'none';
        });
    };
}

function toggleGroupUser(el) {
    el.classList.toggle('selected');
    el.querySelector('.user-check').textContent = el.classList.contains('selected') ? '✓' : '';
}

async function createGroup(name, memberIds) {
    try {
        const resp = await authFetch('api/channels', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'group', name, member_ids: memberIds }),
        });
        const data = await resp.json();
        await loadChannels();
        selectChannel(data.id);
    } catch (e) {
        console.error('Failed to create group:', e);
    }
}

// Helpers
function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len) + '...' : str;
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
