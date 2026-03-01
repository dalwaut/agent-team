// OPAI Messenger - Presence WebSocket client

let _typingTimeout = null;
let _lastTypingSent = 0;
const TYPING_THROTTLE = 2000; // 2 seconds

function connectPresence() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // When behind Caddy, WebSocket path is /ws/messenger
    // When direct, it's also /ws/messenger
    const wsUrl = `${protocol}//${location.host}/ws/messenger`;

    App.ws = new WebSocket(wsUrl);

    App.ws.onopen = () => {
        console.log('Presence WebSocket connected');
        // Send auth
        App.ws.send(JSON.stringify({
            type: 'auth',
            token: App.token,
        }));
    };

    App.ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handlePresenceMessage(data);
        } catch (e) {
            console.error('WS parse error:', e);
        }
    };

    App.ws.onclose = () => {
        console.log('Presence WebSocket closed, reconnecting in 5s...');
        setTimeout(connectPresence, 5000);
    };

    App.ws.onerror = (e) => {
        console.error('Presence WebSocket error:', e);
    };

    // Ping every 30 seconds
    setInterval(() => {
        if (App.ws?.readyState === WebSocket.OPEN) {
            App.ws.send(JSON.stringify({ type: 'ping' }));
        }
    }, 30000);
}

function handlePresenceMessage(data) {
    switch (data.type) {
        case 'connected':
            App.onlineUsers = data.online_users || [];
            updateOnlineStatus();
            break;

        case 'presence_update':
            App.onlineUsers = data.online_users || [];
            updateOnlineStatus();
            break;

        case 'user_typing':
            showTypingIndicator(data);
            break;

        case 'pong':
            break;
    }
}

function updateOnlineStatus() {
    // Update channel list online dots
    renderChannelList();

    // Update chat header status
    if (App.activeChannel?.type === 'dm' && App.activeChannel.members) {
        const other = App.activeChannel.members.find(m => m && m.id !== App.user.id);
        if (other) {
            const isOnline = App.onlineUsers.some(u => u.user_id === other.id);
            const statusEl = document.getElementById('chat-status');
            if (statusEl) statusEl.textContent = isOnline ? 'Online' : 'Offline';
        }
    }
}

function showTypingIndicator(data) {
    if (!App.activeChannel || data.channel_id !== App.activeChannel.id) return;

    const el = document.getElementById('typing-indicator');
    if (!el) return;

    el.innerHTML = `
        ${data.display_name || 'Someone'} is typing
        <span class="typing-dots"><span></span><span></span><span></span></span>
    `;

    // Clear after 3 seconds
    clearTimeout(_typingTimeout);
    _typingTimeout = setTimeout(() => {
        el.innerHTML = '';
    }, 3000);
}

function sendTyping() {
    if (!App.ws || App.ws.readyState !== WebSocket.OPEN) return;
    if (!App.activeChannel) return;

    const now = Date.now();
    if (now - _lastTypingSent < TYPING_THROTTLE) return;
    _lastTypingSent = now;

    App.ws.send(JSON.stringify({
        type: 'typing',
        channel_id: App.activeChannel.id,
    }));
}
