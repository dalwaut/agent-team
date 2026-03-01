// OPAI Chat — Sidebar with status excerpts

window.Sidebar = {
    conversations: [],

    async loadConversations() {
        try {
            const response = await (typeof authFetch !== 'undefined' ? authFetch : fetch)('api/conversations');
            this.conversations = await response.json();
            window.AppState.conversations = this.conversations;
            this.render();
        } catch (error) {
            console.error('Error loading conversations:', error);
        }
    },

    render() {
        const container = document.getElementById('conversation-list');
        container.innerHTML = '';

        const groups = this.groupByDate(this.conversations);

        Object.entries(groups).forEach(([groupName, convs]) => {
            if (convs.length === 0) return;

            const groupDiv = document.createElement('div');
            groupDiv.className = 'conversation-group';

            const title = document.createElement('div');
            title.className = 'conversation-group-title';
            title.textContent = groupName;
            groupDiv.appendChild(title);

            convs.forEach(conv => {
                groupDiv.appendChild(this.createConversationItem(conv));
            });

            container.appendChild(groupDiv);
        });
    },

    createConversationItem(conv) {
        const item = document.createElement('div');
        item.className = 'conversation-item';
        if (conv.id === window.AppState.currentConversationId) {
            item.classList.add('active');
        }

        const content = document.createElement('div');
        content.className = 'conversation-content';

        // Title
        const titleEl = document.createElement('div');
        titleEl.className = 'conversation-title';
        titleEl.textContent = conv.title || 'New chat';
        content.appendChild(titleEl);

        // Preview (last message excerpt)
        if (conv.preview) {
            const preview = document.createElement('div');
            preview.className = 'conversation-preview';
            preview.textContent = conv.preview;
            content.appendChild(preview);
        }

        // Status line (streaming indicator or model badge)
        const statusEl = document.createElement('div');
        statusEl.className = 'conversation-status';

        const isStreaming = window.AppState.isStreaming &&
            window.AppState.streamingConversationId === conv.id;

        if (isStreaming) {
            statusEl.innerHTML = '<span class="status-dot streaming"></span><span class="status-text">Generating...</span>';
        } else {
            // Show model badge
            const model = (window.AppState.models || []).find(m => m.id === conv.model);
            const modelLabel = model ? model.label : conv.model || '';
            if (modelLabel) {
                const badge = document.createElement('span');
                badge.className = 'conversation-model-badge';
                badge.textContent = modelLabel;
                if (model) badge.style.color = model.color;
                statusEl.appendChild(badge);
            }
        }

        content.appendChild(statusEl);

        // Click handler — loads chat (does NOT toggle sidebar)
        content.addEventListener('click', (e) => {
            e.stopPropagation();
            window.switchConversation(conv.id);
        });

        // Delete button
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-btn';
        deleteBtn.textContent = '\u00D7'; // ×
        deleteBtn.title = 'Delete';
        deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (confirm('Delete "' + (conv.title || 'this chat') + '"?')) {
                try {
                    await (typeof authFetch !== 'undefined' ? authFetch : fetch)(
                        'api/conversations/' + conv.id, { method: 'DELETE' }
                    );
                    if (conv.id === window.AppState.currentConversationId) {
                        window.startNewChat();
                    }
                    await this.loadConversations();
                } catch (err) {
                    console.error('Delete failed:', err);
                }
            }
        });

        item.appendChild(content);
        item.appendChild(deleteBtn);
        return item;
    },

    // Update a single conversation's status in the sidebar without full re-render
    updateStatus(conversationId, status) {
        const items = document.querySelectorAll('.conversation-item');
        items.forEach(item => {
            const content = item.querySelector('.conversation-content');
            if (!content) return;

            // Find the matching item by checking if its click leads to this conv
            const statusEl = content.querySelector('.conversation-status');
            if (!statusEl) return;

            // Check if this is the right item
            const conv = this.conversations.find(c => c.id === conversationId);
            if (!conv) return;

            const titleEl = content.querySelector('.conversation-title');
            if (titleEl && titleEl.textContent === (conv.title || 'New chat')) {
                if (status === 'streaming') {
                    statusEl.innerHTML = '<span class="status-dot streaming"></span><span class="status-text">Generating...</span>';
                } else {
                    const model = (window.AppState.models || []).find(m => m.id === conv.model);
                    const label = model ? model.label : conv.model || '';
                    statusEl.innerHTML = label
                        ? '<span class="conversation-model-badge" style="color:' + (model ? model.color : '') + '">' + label + '</span>'
                        : '';
                }
            }
        });
    },

    groupByDate(conversations) {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const lastWeek = new Date(today);
        lastWeek.setDate(lastWeek.getDate() - 7);

        const groups = {
            'Today': [],
            'Yesterday': [],
            'Last 7 Days': [],
            'Older': []
        };

        conversations.forEach(conv => {
            const date = new Date(conv.updated_at);
            if (date >= today) groups['Today'].push(conv);
            else if (date >= yesterday) groups['Yesterday'].push(conv);
            else if (date >= lastWeek) groups['Last 7 Days'].push(conv);
            else groups['Older'].push(conv);
        });

        return groups;
    }
};
