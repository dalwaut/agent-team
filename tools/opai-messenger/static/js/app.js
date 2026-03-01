// OPAI Messenger - Main App State & Initialization

const App = {
    user: null,
    token: null,
    supabase: null,
    channels: [],
    activeChannel: null,
    users: [],
    onlineUsers: [],
    ws: null,
    realtimeChannel: null,
};

// Auth fetch helper
async function authFetch(url, options = {}) {
    if (!options.headers) options.headers = {};
    if (App.token) {
        options.headers['Authorization'] = `Bearer ${App.token}`;
    }
    return fetch(url, options);
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    console.log('OPAI Messenger initializing...');

    // Get Supabase config
    try {
        const cfg = await fetch('api/auth/config').then(r => r.json());
        if (!cfg.supabase_url || !cfg.supabase_anon_key) {
            document.getElementById('empty-state').innerHTML =
                '<p>Auth not configured</p>';
            return;
        }

        App.supabase = window.supabase.createClient(cfg.supabase_url, cfg.supabase_anon_key);

        // Check session
        const { data: { session } } = await App.supabase.auth.getSession();
        if (!session) {
            window.location.href = '/auth/login';
            return;
        }

        // Check app access (non-admins only)
        if (session.user.app_metadata?.role !== 'admin') {
            try {
                const ar = await fetch('/api/me/apps', { headers: { 'Authorization': `Bearer ${session.access_token}` } });
                if (ar.ok) {
                    const ad = await ar.json();
                    if (!(ad.allowed_apps || []).includes('messenger')) { window.location.href = '/'; return; }
                }
            } catch (e) { /* allow on failure */ }
        }

        App.token = session.access_token;
        App.user = {
            id: session.user.id,
            email: session.user.email,
            display_name: session.user.user_metadata?.display_name || session.user.email.split('@')[0],
            role: session.user.app_metadata?.role || 'user',
        };

        // Keep token fresh
        App.supabase.auth.onAuthStateChange((_event, sess) => {
            if (sess) {
                App.token = sess.access_token;
                window._opaiToken = sess.access_token;
            }
        });

        window._opaiToken = App.token;

        // Set user info in sidebar
        const initials = App.user.display_name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
        document.getElementById('my-avatar').textContent = initials;
        document.getElementById('my-name').textContent = App.user.display_name;

        // Load data
        await loadUsers();
        await loadChannels();

        // Setup Supabase Realtime for messages
        setupRealtime();

        // Connect presence WebSocket
        connectPresence();

        // Setup UI event listeners
        setupEventListeners();

        console.log('OPAI Messenger ready!');
    } catch (e) {
        console.error('Init failed:', e);
        document.getElementById('empty-state').innerHTML =
            '<p>Failed to initialize messenger</p>';
    }
});

async function loadUsers() {
    try {
        const resp = await authFetch('api/users');
        App.users = await resp.json();
    } catch (e) {
        console.error('Failed to load users:', e);
    }
}

function setupRealtime() {
    if (!App.supabase) return;

    // Listen for new messages across all channels
    App.realtimeChannel = App.supabase
        .channel('messenger-realtime')
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'dm_messages',
        }, (payload) => {
            handleNewMessage(payload.new);
        })
        .on('postgres_changes', {
            event: 'UPDATE',
            schema: 'public',
            table: 'dm_messages',
        }, (payload) => {
            handleMessageUpdate(payload.new);
        })
        .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: 'dm_reactions',
        }, (payload) => {
            handleReactionChange(payload);
        })
        .subscribe();
}

function handleNewMessage(msg) {
    // Check if message is for one of our channels
    const channel = App.channels.find(c => c.id === msg.channel_id);
    if (!channel) return;

    // If it's the active channel, render it
    if (App.activeChannel && App.activeChannel.id === msg.channel_id) {
        if (msg.sender_id !== App.user.id) {
            // Fetch full message with sender info
            fetchAndRenderNewMessage(msg.id);
            playNotificationSound();
        }
        // Mark as read
        authFetch(`api/channels/${msg.channel_id}/read`, { method: 'PATCH' });
    } else {
        // Increment unread count
        channel.unread_count = (channel.unread_count || 0) + 1;
        renderChannelList();
        playNotificationSound();
    }

    // Update channel's last message and move to top
    channel.last_message = {
        content: msg.content,
        sender_id: msg.sender_id,
        created_at: msg.created_at,
    };
    App.channels.sort((a, b) => {
        const at = a.last_message?.created_at || '';
        const bt = b.last_message?.created_at || '';
        return bt.localeCompare(at);
    });
    renderChannelList();
}

function handleMessageUpdate(msg) {
    // Update in DOM if visible
    const el = document.querySelector(`[data-msg-id="${msg.id}"] .msg-content`);
    if (!el) return;

    if (msg.deleted_at) {
        el.textContent = 'This message was deleted';
        el.closest('.msg-wrapper')?.classList.add('msg-deleted');
    } else {
        el.innerHTML = formatContent(msg.content);
        // Show edited indicator
        const header = el.closest('.msg-body')?.querySelector('.msg-header');
        if (header && msg.edited_at && !header.querySelector('.msg-edited')) {
            const edited = document.createElement('span');
            edited.className = 'msg-edited';
            edited.textContent = '(edited)';
            header.appendChild(edited);
        }
    }
}

async function fetchAndRenderNewMessage(messageId) {
    if (!App.activeChannel) return;
    // Re-fetch latest messages (simpler than fetching one and inserting)
    const resp = await authFetch(`api/channels/${App.activeChannel.id}/messages?limit=1`);
    const data = await resp.json();
    if (data.messages && data.messages.length) {
        appendMessage(data.messages[data.messages.length - 1]);
        scrollToBottom();
    }
}

function playNotificationSound() {
    try {
        const audio = new Audio('static/sounds/notification.mp3');
        audio.volume = 0.3;
        audio.play().catch(() => {});
    } catch (e) {}
}

function formatContent(text) {
    if (!text) return '';
    // Escape HTML
    text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Linkify URLs
    text = text.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    // Bold
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic
    text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // Code
    text = text.replace(/`(.+?)`/g, '<code>$1</code>');
    return text;
}

function formatTime(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = d.toDateString() === yesterday.toDateString();

    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (isToday) return time;
    if (isYesterday) return 'Yesterday ' + time;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
}

function formatDate(isoString) {
    const d = new Date(isoString);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Today';
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

function getInitials(name) {
    if (!name) return '?';
    return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

function scrollToBottom() {
    const el = document.getElementById('messages');
    if (el) el.scrollTop = el.scrollHeight;
}

function closeModal(id) {
    document.getElementById(id)?.classList.remove('visible');
}

function setupEventListeners() {
    // New DM button
    document.getElementById('btn-new-dm').addEventListener('click', () => {
        showNewDMModal();
    });

    // New Group button
    document.getElementById('btn-new-group').addEventListener('click', () => {
        showNewGroupModal();
    });

    // Search button
    document.getElementById('btn-search').addEventListener('click', () => {
        toggleSearchPanel();
    });

    document.getElementById('btn-chat-search')?.addEventListener('click', () => {
        toggleSearchPanel();
    });

    // Channel filter
    document.getElementById('channel-filter').addEventListener('input', (e) => {
        filterChannels(e.target.value);
    });

    // Message input
    const input = document.getElementById('message-input');
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    input.addEventListener('input', () => {
        // Auto-resize
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        // Send typing indicator
        sendTyping();
    });

    // Send button
    document.getElementById('btn-send').addEventListener('click', sendMessage);

    // Reply close
    document.getElementById('reply-close').addEventListener('click', () => {
        clearReply();
    });

    // Upload button
    document.getElementById('btn-upload').addEventListener('click', () => {
        document.getElementById('file-input').click();
    });

    document.getElementById('file-input').addEventListener('change', (e) => {
        if (e.target.files.length) uploadFile(e.target.files[0]);
    });

    // Emoji button
    document.getElementById('btn-emoji').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleEmojiPicker();
    });

    // Close emoji picker on outside click
    document.addEventListener('click', () => {
        document.getElementById('emoji-picker')?.classList.remove('visible');
    });

    // Drag and drop
    setupDragDrop();

    // Close search
    document.getElementById('btn-close-search')?.addEventListener('click', () => {
        document.getElementById('search-panel').classList.remove('visible');
    });

    // Modal overlay clicks
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.classList.remove('visible');
        });
    });
}
