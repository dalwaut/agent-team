// OPAI Chat — Main App Controller

const AppState = {
    currentConversationId: null,
    currentModel: 'haiku',
    models: [],
    conversations: [],
    isStreaming: false,
    streamingConversationId: null, // tracks which conversation is streaming
    user: null,
    pendingAttachments: [], // [{path, filename, size}]
    mozartMode: false,
};

// ── Initialization ──────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    // Auth init
    try {
        const authCfg = await fetch('api/auth/config').then(r => r.json());
        if (authCfg.supabase_url && authCfg.supabase_anon_key) {
            window.OPAI_SUPABASE_URL = authCfg.supabase_url;
            window.OPAI_SUPABASE_ANON_KEY = authCfg.supabase_anon_key;
            if (typeof opaiAuth !== 'undefined') {
                const user = await opaiAuth.init({ redirectOnFail: true, requireApp: 'chat' });
                if (user) {
                    AppState.user = user;
                }
            }
        }
    } catch (e) {
        console.warn('Auth init skipped:', e.message);
    }

    // Fix viewport: if an external navbar was injected before #app, shrink #app
    adjustForNavbar();

    await loadModels();
    await loadConversations();
    setupEventListeners();

    // Restore model preference
    const saved = localStorage.getItem('opai_chat_model');
    if (saved) {
        AppState.currentModel = saved;
    }
    syncModelDisplay();

    // Restore Mozart mode preference
    if (localStorage.getItem('opai_mozart_mode') === 'true') {
        toggleMozartMode(true);
    }
});

// ── Navbar viewport fix ─────────────────────────────────────────
// The shared navbar.js (FULL_HEIGHT_TOOLS) sets body to flex-column
// and #app to flex:1, so it naturally fills remaining space below the navbar.
// This fallback handles cases where navbar.js hasn't loaded yet or is absent.

function adjustForNavbar() {
    // If body isn't already flexbox (navbar.js didn't run yet), watch for it
    const observer = new MutationObserver(() => {
        const nav = document.querySelector('body > .opai-navbar, body > nav');
        if (nav) {
            // Ensure #app doesn't overflow past the navbar
            const app = document.getElementById('app');
            if (app && !getComputedStyle(document.body).display.includes('flex')) {
                app.style.height = 'calc(100vh - ' + (nav.offsetHeight || 44) + 'px)';
            }
            observer.disconnect();
        }
    });
    observer.observe(document.body, { childList: true });
}

// ── Auth fetch helper ───────────────────────────────────────────

async function authFetch(url, options = {}) {
    if (typeof opaiAuth !== 'undefined' && opaiAuth.getToken) {
        return opaiAuth.fetchWithAuth(url, options);
    }
    return fetch(url, options);
}

// ── Models ──────────────────────────────────────────────────────

async function loadModels() {
    try {
        const response = await authFetch('api/models');
        AppState.models = await response.json();
    } catch (e) {
        console.error('Error loading models:', e);
    }
}

function renderModelDropdown(dropdownId) {
    const dropdown = document.getElementById(dropdownId);
    if (!dropdown) return;
    dropdown.innerHTML = '';

    AppState.models.forEach(model => {
        const opt = document.createElement('div');
        opt.className = 'model-option' + (model.id === AppState.currentModel ? ' active' : '');

        const providerBadge = model.provider === 'gemini'
            ? '<span class="provider-badge gemini">Gemini</span>' : '';

        opt.innerHTML = `
            <span class="model-dot" style="background:${model.color}"></span>
            <div class="model-option-info">
                <div class="model-option-label">${model.label}${providerBadge}</div>
                <div class="model-option-desc">${model.description || ''}</div>
            </div>
        `;

        opt.addEventListener('click', (e) => {
            e.stopPropagation();
            AppState.currentModel = model.id;
            localStorage.setItem('opai_chat_model', model.id);
            syncModelDisplay();
            closeAllDropdowns();
        });

        dropdown.appendChild(opt);
    });
}

// ── Mozart Mode ──────────────────────────────────────────────────

function toggleMozartMode(enabled) {
    AppState.mozartMode = enabled;
    localStorage.setItem('opai_mozart_mode', enabled ? 'true' : 'false');

    document.body.classList.toggle('mozart-mode', enabled);

    // Update topbar title
    const topbarTitle = document.getElementById('topbar-title');
    if (!AppState.currentConversationId) {
        topbarTitle.textContent = enabled ? 'Mozart' : 'OPAI Chat';
    }

    // Show/hide exit button
    const exitBtn = document.getElementById('exit-mozart-btn');
    if (exitBtn) exitBtn.classList.toggle('hidden', !enabled);

    // Switch welcome variants
    const normalWelcome = document.querySelector('.welcome-content:not(.mozart-welcome)');
    const mozartWelcome = document.getElementById('mozart-welcome');
    if (normalWelcome && mozartWelcome) {
        normalWelcome.classList.toggle('hidden', enabled);
        mozartWelcome.classList.toggle('hidden', !enabled);
    }

    // Sync model display for Mozart inputs
    if (enabled) {
        renderModelDropdown('mozart-model-dropdown');
    }
}

function syncModelDisplay() {
    const model = AppState.models.find(m => m.id === AppState.currentModel);
    if (!model) return;

    // Update both model pills (welcome + chat)
    document.querySelectorAll('.model-pill-dot').forEach(dot => {
        dot.style.background = model.color;
    });
    document.querySelectorAll('.model-pill-label').forEach(label => {
        label.textContent = model.label;
    });

    // Re-render both dropdowns
    renderModelDropdown('welcome-model-dropdown');
    renderModelDropdown('chat-model-dropdown');
}

function toggleDropdown(dropdownId, e) {
    if (e) e.stopPropagation();
    const dropdown = document.getElementById(dropdownId);
    const wasHidden = dropdown.classList.contains('hidden');
    closeAllDropdowns();
    if (wasHidden) {
        renderModelDropdown(dropdownId);
        dropdown.classList.remove('hidden');
    }
}

function closeAllDropdowns() {
    document.querySelectorAll('.model-dropdown').forEach(d => d.classList.add('hidden'));
}

// ── Event Listeners ─────────────────────────────────────────────

function setupEventListeners() {
    // Sidebar toggle (hamburger)
    document.getElementById('sidebar-toggle').addEventListener('click', () => {
        window.SidebarCtrl.togglePinned();
    });

    // New chat
    document.getElementById('new-chat-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        startNewChat();
    });

    // Model pills — both welcome and chat
    document.getElementById('welcome-model-btn').addEventListener('click', (e) => toggleDropdown('welcome-model-dropdown', e));
    document.getElementById('chat-model-btn').addEventListener('click', (e) => toggleDropdown('chat-model-dropdown', e));

    // Close dropdowns on outside click
    document.addEventListener('click', () => closeAllDropdowns());

    // Welcome input
    const welcomeInput = document.getElementById('welcome-message-input');
    welcomeInput.addEventListener('keydown', handleInputKeydown);
    welcomeInput.addEventListener('input', autoResize);
    document.getElementById('welcome-send-btn').addEventListener('click', () => sendFromInput('welcome'));

    // Chat input
    const chatInput = document.getElementById('chat-message-input');
    chatInput.addEventListener('keydown', handleInputKeydown);
    chatInput.addEventListener('input', autoResize);
    document.getElementById('chat-send-btn').addEventListener('click', () => sendFromInput('chat'));

    // Hidden file input for uploads
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'file-upload-input';
    fileInput.style.display = 'none';
    fileInput.accept = '.txt,.md,.csv,.json,.xml,.yaml,.yml,.toml,.py,.js,.ts,.jsx,.tsx,.html,.css,.sql,.sh,.rb,.go,.rs,.java,.c,.cpp,.h,.log,.ini,.cfg,.conf';
    document.body.appendChild(fileInput);

    fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        if (!file) return;
        fileInput.value = '';
        await uploadFile(file);
    });

    // Attach buttons trigger file picker
    ['welcome-attach-btn', 'chat-attach-btn'].forEach(id => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            fileInput.click();
        });
    });

    // Mozart mode buttons
    const tryMozartBtn = document.getElementById('try-mozart-btn');
    if (tryMozartBtn) {
        tryMozartBtn.addEventListener('click', () => toggleMozartMode(true));
    }
    const exitMozartBtn = document.getElementById('exit-mozart-btn');
    if (exitMozartBtn) {
        exitMozartBtn.addEventListener('click', () => {
            toggleMozartMode(false);
            startNewChat();
        });
    }

    // Mozart input handlers
    const mozartInput = document.getElementById('mozart-message-input');
    if (mozartInput) {
        mozartInput.addEventListener('keydown', handleInputKeydown);
        mozartInput.addEventListener('input', autoResize);
    }
    const mozartSendBtn = document.getElementById('mozart-send-btn');
    if (mozartSendBtn) {
        mozartSendBtn.addEventListener('click', () => sendFromInput('mozart'));
    }
    const mozartModelBtn = document.getElementById('mozart-model-btn');
    if (mozartModelBtn) {
        mozartModelBtn.addEventListener('click', (e) => toggleDropdown('mozart-model-dropdown', e));
    }

    // Mozart attach button
    const mozartAttachBtn = document.getElementById('mozart-attach-btn');
    if (mozartAttachBtn) {
        mozartAttachBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            document.getElementById('file-upload-input').click();
        });
    }

    // Suggestion chips (both normal and Mozart)
    document.querySelectorAll('.suggestion-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const prompt = chip.dataset.prompt;
            if (prompt) {
                const targetInput = AppState.mozartMode
                    ? document.getElementById('mozart-message-input')
                    : welcomeInput;
                targetInput.value = prompt;
                autoResize.call(targetInput);
                targetInput.focus();
            }
        });
    });

    // Sidebar overlay (close on click)
    document.getElementById('sidebar-overlay').addEventListener('click', () => {
        window.SidebarCtrl.close();
    });
}

function handleInputKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const context = this.id.startsWith('welcome') ? 'welcome' : 'chat';
        sendFromInput(context);
    }
}

function autoResize() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 200) + 'px';
}

// ── File Upload ─────────────────────────────────────────────────

async function uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);

    try {
        const res = await authFetch('api/files/upload', { method: 'POST', body: formData });
        if (res.status === 403) {
            const err = await res.json();
            alert(err.detail || 'File rejected');
            return;
        }
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            alert(err.detail || 'Upload failed');
            return;
        }
        const data = await res.json();
        AppState.pendingAttachments.push(data);
        renderAttachmentChips();
    } catch (e) {
        console.error('Upload error:', e);
        alert('File upload failed');
    }
}

function renderAttachmentChips() {
    // Ensure chip container exists in both views
    ['welcome', 'chat'].forEach(ctx => {
        const wrapper = document.querySelector(
            ctx === 'welcome' ? '.welcome-input-wrapper .input-box' : '.chat-input-wrapper .input-box'
        );
        if (!wrapper) return;

        let container = wrapper.querySelector('.attachment-chips');
        if (!container) {
            container = document.createElement('div');
            container.className = 'attachment-chips';
            wrapper.querySelector('.input-box-top').before(container);
        }

        if (!AppState.pendingAttachments.length) {
            container.innerHTML = '';
            return;
        }

        container.innerHTML = AppState.pendingAttachments.map((att, i) =>
            '<span class="attachment-chip">' +
                '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>' +
                att.filename +
                '<button class="attachment-chip-remove" onclick="removeAttachment(' + i + ')">&times;</button>' +
            '</span>'
        ).join('');
    });
}

function removeAttachment(index) {
    AppState.pendingAttachments.splice(index, 1);
    renderAttachmentChips();
}

// ── Send Message ────────────────────────────────────────────────

async function sendFromInput(context) {
    const inputMap = { welcome: 'welcome-message-input', chat: 'chat-message-input', mozart: 'mozart-message-input' };
    const inputId = inputMap[context] || 'chat-message-input';
    const input = document.getElementById(inputId);
    const message = input.value.trim();
    if (!message || AppState.isStreaming) return;

    input.value = '';
    input.style.height = 'auto';

    // Create conversation if needed (welcome view)
    if (!AppState.currentConversationId) {
        await createNewChat();
    }

    // Switch to chat view
    showChatView();

    // Focus the chat input
    document.getElementById('chat-message-input').focus();

    // Grab and clear pending attachments
    const attachments = [...AppState.pendingAttachments];
    AppState.pendingAttachments = [];
    renderAttachmentChips();

    // Send to chat handler
    if (window.Chat) {
        window.Chat.sendMessage(message, attachments);
    }
}

// ── Conversation Management ─────────────────────────────────────

async function createNewChat() {
    try {
        const response = await authFetch('api/conversations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: AppState.currentModel })
        });
        const conversation = await response.json();
        AppState.currentConversationId = conversation.id;
        await loadConversations();
    } catch (e) {
        console.error('Error creating conversation:', e);
    }
}

function startNewChat() {
    AppState.currentConversationId = null;
    showWelcomeView();
    const focusId = AppState.mozartMode ? 'mozart-message-input' : 'welcome-message-input';
    document.getElementById(focusId).focus();
    if (window.Sidebar) window.Sidebar.render();
}

async function loadConversations() {
    if (window.Sidebar) {
        await window.Sidebar.loadConversations();
    }
}

function switchConversation(conversationId) {
    AppState.currentConversationId = conversationId;
    showChatView();
    if (window.Chat) {
        window.Chat.loadConversation(conversationId);
    }
    if (window.Sidebar) window.Sidebar.render();

    // Update topbar title
    const conv = AppState.conversations.find(c => c.id === conversationId);
    if (conv) {
        document.getElementById('topbar-title').textContent = conv.title || 'OPAI Chat';
    }
}

// ── View switching ──────────────────────────────────────────────

function showChatView() {
    document.getElementById('welcome-view').classList.add('hidden');
    document.getElementById('chat-view').classList.remove('hidden');
}

function showWelcomeView() {
    document.getElementById('welcome-view').classList.remove('hidden');
    document.getElementById('chat-view').classList.add('hidden');
    document.getElementById('topbar-title').textContent = AppState.mozartMode ? 'Mozart' : 'OPAI Chat';
    document.getElementById('messages-container').innerHTML = '';

    // Show correct welcome variant
    const normalWelcome = document.querySelector('.welcome-content:not(.mozart-welcome)');
    const mozartWelcome = document.getElementById('mozart-welcome');
    if (normalWelcome && mozartWelcome) {
        normalWelcome.classList.toggle('hidden', AppState.mozartMode);
        mozartWelcome.classList.toggle('hidden', !AppState.mozartMode);
    }
}

// ── Sidebar Controller ──────────────────────────────────────────

window.SidebarCtrl = {
    pinned: false,
    hoverOpen: false,
    hoverTimeout: null,

    init() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebar-overlay');

        // Hover: expand when not pinned
        sidebar.addEventListener('mouseenter', () => {
            if (!this.pinned) {
                clearTimeout(this.hoverTimeout);
                this.hoverOpen = true;
                sidebar.classList.add('open');
            }
        });

        sidebar.addEventListener('mouseleave', () => {
            if (!this.pinned && this.hoverOpen) {
                this.hoverTimeout = setTimeout(() => {
                    this.hoverOpen = false;
                    sidebar.classList.remove('open');
                    overlay.classList.remove('visible');
                }, 200);
            }
        });

        // Click on blank sidebar area toggles pinned
        sidebar.addEventListener('click', (e) => {
            // Only toggle if clicking blank area (not buttons, items, etc.)
            const clickable = e.target.closest('.conversation-item, .new-chat-btn, .delete-btn, button, a');
            if (!clickable) {
                this.togglePinned();
            }
        });

        // Hover trigger zone (left edge when sidebar is closed)
        document.addEventListener('mousemove', (e) => {
            if (!this.pinned && !this.hoverOpen && e.clientX <= 8) {
                this.hoverOpen = true;
                sidebar.classList.add('open');
            }
        });
    },

    togglePinned() {
        this.pinned = !this.pinned;
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebar-overlay');

        if (this.pinned) {
            sidebar.classList.add('open', 'pinned');
            document.body.classList.add('sidebar-pinned');
            overlay.classList.remove('visible');
        } else {
            sidebar.classList.remove('open', 'pinned');
            document.body.classList.remove('sidebar-pinned');
            overlay.classList.remove('visible');
            this.hoverOpen = false;
        }
    },

    close() {
        this.pinned = false;
        this.hoverOpen = false;
        const sidebar = document.getElementById('sidebar');
        sidebar.classList.remove('open', 'pinned');
        document.body.classList.remove('sidebar-pinned');
        document.getElementById('sidebar-overlay').classList.remove('visible');
    },

    open() {
        this.pinned = true;
        const sidebar = document.getElementById('sidebar');
        sidebar.classList.add('open', 'pinned');
        document.body.classList.add('sidebar-pinned');
    }
};

// Init sidebar controller
document.addEventListener('DOMContentLoaded', () => {
    window.SidebarCtrl.init();
});

// ── Exports ─────────────────────────────────────────────────────

window.AppState = AppState;
window.switchConversation = switchConversation;
window.showWelcomeView = showWelcomeView;
window.showChatView = showChatView;
window.startNewChat = startNewChat;
window.syncModelDisplay = syncModelDisplay;
window.toggleMozartMode = toggleMozartMode;
