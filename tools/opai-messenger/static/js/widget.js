// OPAI Messenger Widget - Self-contained floating chat bubble
// Usage: <script src="/messenger/static/js/widget.js" defer></script>
//
// Behavior:
// - Bubble starts hidden (dismissed state)
// - When a new message arrives, bubble appears with unread badge
// - User can click bubble to open panel, or right-click / long-press to dismiss
// - Dismiss hides bubble until the next incoming message
// - State persisted in sessionStorage so refreshes don't re-show

(function() {
    'use strict';

    // Don't load widget on the messenger page itself
    if (location.pathname.startsWith('/messenger')) return;

    const MESSENGER_URL = '/messenger/';
    const API_BASE = '/messenger/api';
    const P = 'opai-msgr-widget'; // style prefix

    let _token = null;
    let _supabase = null;
    let _channels = [];
    let _activeChannel = null;
    let _isOpen = false;
    let _unreadTotal = 0;
    let _user = null;
    let _dismissed = sessionStorage.getItem('opai_msgr_dismissed') === '1';

    // ── Inject Styles ────────────────────────────────────────

    const style = document.createElement('style');
    style.textContent = `
        .${P}-bubble {
            position: fixed; bottom: 24px; right: 24px;
            width: 56px; height: 56px; border-radius: 50%;
            background: linear-gradient(135deg, #a855f7, #d946ef);
            border: none; cursor: pointer;
            display: none; align-items: center; justify-content: center;
            font-size: 1.5rem; color: white;
            box-shadow: 0 4px 16px rgba(168, 85, 247, 0.4);
            z-index: 9999;
            transition: transform 150ms ease, box-shadow 150ms ease, opacity 200ms ease;
        }
        .${P}-bubble.visible { display: flex; }
        .${P}-bubble:hover {
            transform: scale(1.08);
            box-shadow: 0 6px 24px rgba(168, 85, 247, 0.5);
        }
        .${P}-bubble.pop-in {
            animation: ${P}-popIn 400ms cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        }
        @keyframes ${P}-popIn {
            0% { transform: scale(0); opacity: 0; }
            100% { transform: scale(1); opacity: 1; }
        }
        .${P}-badge {
            position: absolute; top: -4px; right: -4px;
            min-width: 20px; height: 20px; border-radius: 10px;
            background: #ef4444; color: white;
            font-size: 0.6875rem; font-weight: 700;
            display: none; align-items: center; justify-content: center;
            padding: 0 5px;
        }
        .${P}-badge.visible { display: flex; }
        .${P}-dismiss-hint {
            position: absolute; bottom: -22px; left: 50%;
            transform: translateX(-50%); white-space: nowrap;
            font-size: 0.5625rem; color: #a1a1aa;
            opacity: 0; transition: opacity 200ms ease;
            pointer-events: none;
        }
        .${P}-bubble:hover .${P}-dismiss-hint { opacity: 1; }
        .${P}-panel {
            position: fixed; bottom: 88px; right: 24px;
            width: 360px; height: 500px;
            background: #18181b;
            border: 1px solid rgba(168, 85, 247, 0.2);
            border-radius: 16px;
            display: none; flex-direction: column; overflow: hidden;
            z-index: 9998;
            box-shadow: 0 8px 32px rgba(0,0,0,0.5);
            font-family: 'Inter', -apple-system, sans-serif;
            color: #f4f4f5;
        }
        .${P}-panel.open { display: flex; }
        .${P}-panel-header {
            padding: 12px 16px;
            border-bottom: 1px solid rgba(168, 85, 247, 0.2);
            display: flex; align-items: center; gap: 8px;
        }
        .${P}-panel-title {
            font-size: 0.9375rem; font-weight: 600; flex: 1;
            background: linear-gradient(135deg, #a855f7, #d946ef);
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
        }
        .${P}-panel-link {
            font-size: 0.75rem; color: #a1a1aa; text-decoration: none;
        }
        .${P}-panel-link:hover { color: #c084fc; }
        .${P}-panel-close {
            background: none; border: none; color: #71717a;
            cursor: pointer; font-size: 1.125rem; padding: 2px 6px;
            border-radius: 4px; transition: color 150ms ease;
        }
        .${P}-panel-close:hover { color: #f4f4f5; }
        .${P}-channel-list { flex: 1; overflow-y: auto; }
        .${P}-channel-item {
            display: flex; align-items: center; gap: 10px;
            padding: 10px 16px; cursor: pointer;
            transition: background 150ms ease;
            border-bottom: 1px solid rgba(255,255,255,0.03);
        }
        .${P}-channel-item:hover { background: rgba(39, 39, 42, 0.6); }
        .${P}-ch-avatar {
            width: 32px; height: 32px; border-radius: 50%;
            background: linear-gradient(135deg, #8b5cf6, #d946ef);
            display: flex; align-items: center; justify-content: center;
            font-size: 0.75rem; font-weight: 600; flex-shrink: 0;
        }
        .${P}-ch-info { flex: 1; min-width: 0; }
        .${P}-ch-name {
            font-size: 0.8125rem; font-weight: 500;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .${P}-ch-preview {
            font-size: 0.6875rem; color: #71717a;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .${P}-ch-badge {
            background: #a855f7; color: white; font-size: 0.625rem;
            min-width: 16px; height: 16px; border-radius: 8px;
            display: flex; align-items: center; justify-content: center;
            padding: 0 4px; font-weight: 600;
        }
        .${P}-chat-view { display: none; flex-direction: column; flex: 1; }
        .${P}-chat-view.active { display: flex; }
        .${P}-chat-header {
            padding: 10px 16px;
            border-bottom: 1px solid rgba(168, 85, 247, 0.2);
            display: flex; align-items: center; gap: 8px;
        }
        .${P}-back-btn {
            background: none; border: none; color: #a1a1aa;
            cursor: pointer; font-size: 1rem; padding: 4px;
        }
        .${P}-chat-msgs {
            flex: 1; overflow-y: auto; padding: 8px 12px;
            display: flex; flex-direction: column; gap: 4px;
        }
        .${P}-msg { padding: 4px 0; }
        .${P}-msg-sender { font-size: 0.6875rem; font-weight: 600; color: #c084fc; }
        .${P}-msg-sender.self { color: #60a5fa; }
        .${P}-msg-time { font-size: 0.5625rem; color: #71717a; margin-left: 6px; }
        .${P}-msg-text { font-size: 0.8125rem; line-height: 1.4; word-wrap: break-word; }
        .${P}-input-area {
            padding: 8px 12px;
            border-top: 1px solid rgba(168, 85, 247, 0.2);
            display: flex; gap: 8px; align-items: flex-end;
        }
        .${P}-input {
            flex: 1; padding: 8px 10px; border-radius: 8px;
            border: 1px solid rgba(168, 85, 247, 0.2);
            background: #000; color: #f4f4f5; font-size: 0.8125rem;
            font-family: inherit; outline: none; resize: none;
            min-height: 36px; max-height: 80px;
        }
        .${P}-input:focus { border-color: #a855f7; }
        .${P}-send-btn {
            width: 36px; height: 36px; border-radius: 8px; border: none;
            background: linear-gradient(135deg, #a855f7, #d946ef);
            color: white; cursor: pointer; font-size: 0.875rem;
            display: flex; align-items: center; justify-content: center;
            flex-shrink: 0;
        }
        .${P}-empty {
            padding: 24px; text-align: center; color: #71717a; font-size: 0.8125rem;
        }
    `;
    document.head.appendChild(style);

    // ── Create DOM ───────────────────────────────────────────

    const bubble = document.createElement('button');
    bubble.className = `${P}-bubble`;
    bubble.innerHTML = '💬';
    bubble.onclick = togglePanel;
    // Right-click to dismiss
    bubble.oncontextmenu = (e) => { e.preventDefault(); dismiss(); };

    const badge = document.createElement('div');
    badge.className = `${P}-badge`;
    bubble.appendChild(badge);

    const hint = document.createElement('div');
    hint.className = `${P}-dismiss-hint`;
    hint.textContent = 'right-click to dismiss';
    bubble.appendChild(hint);

    const panel = document.createElement('div');
    panel.className = `${P}-panel`;
    panel.innerHTML = `
        <div class="${P}-panel-header">
            <span class="${P}-panel-title">Messenger</span>
            <a class="${P}-panel-link" href="${MESSENGER_URL}" target="_blank">Open full &#8599;</a>
            <button class="${P}-panel-close" onclick="window._opaiMsgrWidget.dismiss()" title="Dismiss">&times;</button>
        </div>
        <div class="${P}-channel-list" id="${P}-channels"></div>
        <div class="${P}-chat-view" id="${P}-chat">
            <div class="${P}-chat-header">
                <button class="${P}-back-btn" onclick="window._opaiMsgrWidget.back()">&larr;</button>
                <span id="${P}-chat-name" style="font-size:0.875rem;font-weight:500;"></span>
            </div>
            <div class="${P}-chat-msgs" id="${P}-msgs"></div>
            <div class="${P}-input-area">
                <textarea class="${P}-input" id="${P}-input"
                    placeholder="Type a message..." rows="1"></textarea>
                <button class="${P}-send-btn" onclick="window._opaiMsgrWidget.send()">&#10148;</button>
            </div>
        </div>
    `;

    document.body.appendChild(bubble);
    document.body.appendChild(panel);

    // ── Visibility Control ───────────────────────────────────

    function showBubble() {
        _dismissed = false;
        sessionStorage.setItem('opai_msgr_dismissed', '0');
        bubble.classList.add('visible', 'pop-in');
        // Remove pop-in class after animation
        setTimeout(() => bubble.classList.remove('pop-in'), 500);
    }

    function dismiss() {
        _dismissed = true;
        _isOpen = false;
        sessionStorage.setItem('opai_msgr_dismissed', '1');
        panel.classList.remove('open');
        bubble.classList.remove('visible');
    }

    // ── Auth & Init ──────────────────────────────────────────

    async function init() {
        try {
            const cfg = await fetch(`${API_BASE}/auth/config`).then(r => r.json());
            if (!cfg.supabase_url || !cfg.supabase_anon_key) return;

            if (!window.supabase) {
                const script = document.createElement('script');
                script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
                document.head.appendChild(script);
                await new Promise(resolve => { script.onload = resolve; });
            }

            _supabase = window.supabase.createClient(cfg.supabase_url, cfg.supabase_anon_key);
            const { data: { session } } = await _supabase.auth.getSession();
            if (!session) return;

            _token = session.access_token;
            _user = {
                id: session.user.id,
                display_name: session.user.user_metadata?.display_name || session.user.email?.split('@')[0] || 'User',
            };

            _supabase.auth.onAuthStateChange((_ev, sess) => {
                if (sess) _token = sess.access_token;
            });

            _supabase.channel('widget-realtime')
                .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'dm_messages' }, (p) => {
                    handleNewMsg(p.new);
                })
                .subscribe();

            await loadWidgetChannels();

            // Show bubble on load only if there are unreads and not dismissed
            if (_unreadTotal > 0 && !_dismissed) {
                showBubble();
            }
        } catch (e) {
            console.warn('Messenger widget init failed:', e);
        }
    }

    async function wFetch(url, opts = {}) {
        if (!opts.headers) opts.headers = {};
        if (_token) opts.headers['Authorization'] = `Bearer ${_token}`;
        return fetch(url, opts);
    }

    // ── Data ─────────────────────────────────────────────────

    async function loadWidgetChannels() {
        try {
            const resp = await wFetch(`${API_BASE}/channels`);
            _channels = await resp.json();
            _unreadTotal = _channels.reduce((s, c) => s + (c.unread_count || 0), 0);
            updateBadge();
            if (_isOpen && !_activeChannel) renderChannels();
        } catch (e) {
            console.warn('Widget: failed to load channels:', e);
        }
    }

    function handleNewMsg(msg) {
        if (msg.sender_id === _user?.id) return;
        const ch = _channels.find(c => c.id === msg.channel_id);
        if (!ch) return;

        if (_activeChannel?.id === msg.channel_id && _isOpen) {
            appendWidgetMsg(msg);
            wFetch(`${API_BASE}/channels/${msg.channel_id}/read`, { method: 'PATCH' });
        } else {
            ch.unread_count = (ch.unread_count || 0) + 1;
            _unreadTotal++;
            updateBadge();
            if (_isOpen && !_activeChannel) renderChannels();

            // New message arrives — show bubble regardless of dismissed state
            showBubble();
        }
    }

    // ── Rendering ────────────────────────────────────────────

    function updateBadge() {
        badge.textContent = _unreadTotal > 99 ? '99+' : _unreadTotal;
        badge.classList.toggle('visible', _unreadTotal > 0);
    }

    function renderChannels() {
        const el = document.getElementById(`${P}-channels`);
        if (!_channels.length) {
            el.innerHTML = `<div class="${P}-empty">No conversations</div>`;
            return;
        }

        const recent = _channels.slice(0, 8);
        el.innerHTML = recent.map(ch => {
            const initials = (ch.name || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
            const preview = ch.last_message ? (ch.last_message.content || '').slice(0, 30) : '';
            const badgeHtml = ch.unread_count > 0
                ? `<div class="${P}-ch-badge">${ch.unread_count}</div>` : '';

            return `
                <div class="${P}-channel-item" onclick="window._opaiMsgrWidget.open('${ch.id}')">
                    <div class="${P}-ch-avatar">${ch.type === 'group' ? '&#128101;' : esc(initials)}</div>
                    <div class="${P}-ch-info">
                        <div class="${P}-ch-name">${esc(ch.name || 'Unknown')}</div>
                        <div class="${P}-ch-preview">${esc(preview)}</div>
                    </div>
                    ${badgeHtml}
                </div>
            `;
        }).join('');
    }

    async function openChat(channelId) {
        const ch = _channels.find(c => c.id === channelId);
        if (!ch) return;
        _activeChannel = ch;

        ch.unread_count = 0;
        _unreadTotal = _channels.reduce((s, c) => s + (c.unread_count || 0), 0);
        updateBadge();

        document.getElementById(`${P}-channels`).style.display = 'none';
        const chatView = document.getElementById(`${P}-chat`);
        chatView.classList.add('active');
        document.getElementById(`${P}-chat-name`).textContent = ch.name || 'Unknown';

        const msgsEl = document.getElementById(`${P}-msgs`);
        msgsEl.innerHTML = '<div style="padding:16px;text-align:center;color:#71717a;">Loading...</div>';

        try {
            const resp = await wFetch(`${API_BASE}/channels/${channelId}/messages?limit=30`);
            const data = await resp.json();
            msgsEl.innerHTML = '';
            (data.messages || []).forEach(m => appendWidgetMsg(m));
            msgsEl.scrollTop = msgsEl.scrollHeight;
        } catch (e) {
            msgsEl.innerHTML = `<div style="padding:16px;text-align:center;color:#71717a;">Failed to load</div>`;
        }

        wFetch(`${API_BASE}/channels/${channelId}/read`, { method: 'PATCH' });

        const input = document.getElementById(`${P}-input`);
        input.value = '';
        input.focus();
        input.onkeydown = (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                window._opaiMsgrWidget.send();
            }
        };
    }

    function appendWidgetMsg(msg) {
        const msgsEl = document.getElementById(`${P}-msgs`);
        if (!msgsEl) return;

        const isSelf = msg.sender_id === _user?.id;
        const name = msg.sender?.display_name || (isSelf ? _user.display_name : 'Unknown');
        const time = new Date(msg.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

        const div = document.createElement('div');
        div.className = `${P}-msg`;
        div.innerHTML = `
            <span class="${P}-msg-sender ${isSelf ? 'self' : ''}">${esc(name)}</span>
            <span class="${P}-msg-time">${time}</span>
            <div class="${P}-msg-text">${esc(msg.content || '')}</div>
        `;
        msgsEl.appendChild(div);
        msgsEl.scrollTop = msgsEl.scrollHeight;
    }

    function goBack() {
        _activeChannel = null;
        document.getElementById(`${P}-chat`).classList.remove('active');
        document.getElementById(`${P}-channels`).style.display = '';
        renderChannels();
    }

    async function sendMsg() {
        if (!_activeChannel) return;
        const input = document.getElementById(`${P}-input`);
        const content = input.value.trim();
        if (!content) return;
        input.value = '';

        try {
            const resp = await wFetch(`${API_BASE}/channels/${_activeChannel.id}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content }),
            });
            const msg = await resp.json();
            msg.sender = { display_name: _user.display_name };
            appendWidgetMsg(msg);
        } catch (e) {
            console.error('Widget send failed:', e);
        }
    }

    // ── Toggle ───────────────────────────────────────────────

    function togglePanel() {
        _isOpen = !_isOpen;
        panel.classList.toggle('open', _isOpen);
        if (_isOpen) {
            if (!_activeChannel) {
                loadWidgetChannels();
                renderChannels();
            }
        }
    }

    function esc(s) {
        if (!s) return '';
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ── Public API ───────────────────────────────────────────

    window._opaiMsgrWidget = {
        open: openChat,
        back: goBack,
        send: sendMsg,
        dismiss: dismiss,
        show: showBubble,
        refresh: loadWidgetChannels,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    setInterval(loadWidgetChannels, 30000);
})();
