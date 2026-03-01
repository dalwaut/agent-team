// OPAI Chat — WebSocket Streaming Chat

window.Chat = {
    ws: null,
    currentConversationId: null,
    currentMessageElement: null,
    reconnectAttempts: 0,
    maxReconnectAttempts: 5,

    init() {
        this.connect();
    },

    connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = protocol + '//' + window.location.host + '/ws/chat';

        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = async () => {
            this.reconnectAttempts = 0;

            // Send auth token
            if (typeof opaiAuth !== 'undefined' && opaiAuth.getAuthMessage) {
                const authMsg = await opaiAuth.getAuthMessage();
                this.ws.send(authMsg);
            }

            // Resume current conversation
            if (window.AppState.currentConversationId) {
                setTimeout(() => {
                    this.send({
                        type: 'init',
                        conversation_id: window.AppState.currentConversationId
                    });
                }, 100);
            }
        };

        this.ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            this.handleMessage(data);
        };

        this.ws.onclose = () => {
            this.reconnect();
        };

        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
        };
    },

    reconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            setTimeout(() => {
                this.connect();
            }, 2000 * this.reconnectAttempts);
        }
    },

    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    },

    handleMessage(data) {
        switch (data.type) {
            case 'conversation_created':
                window.AppState.currentConversationId = data.conversation_id;
                this.currentConversationId = data.conversation_id;
                break;

            case 'session_init':
                break;

            case 'content_delta':
                this.appendToCurrentMessage(data.text);
                break;

            case 'result':
                this.handleResult(data);
                break;

            case 'stream_complete':
                this.handleStreamComplete();
                break;

            case 'error':
                this.addErrorMessage(data.message);
                window.AppState.isStreaming = false;
                window.AppState.streamingConversationId = null;
                if (window.Sidebar) {
                    window.Sidebar.updateStatus(window.AppState.currentConversationId, 'idle');
                }
                break;

            case 'init_success':
                break;
        }
    },

    async loadConversation(conversationId) {
        try {
            const response = await (typeof authFetch !== 'undefined' ? authFetch : fetch)(
                'api/conversations/' + conversationId
            );
            const conversation = await response.json();

            this.currentConversationId = conversationId;
            this.renderMessages(conversation.messages);

            this.send({
                type: 'init',
                conversation_id: conversationId
            });
        } catch (error) {
            console.error('Error loading conversation:', error);
        }
    },

    renderMessages(messages) {
        const container = document.getElementById('messages-container');
        container.innerHTML = '';

        messages.forEach(msg => {
            container.appendChild(this.createMessageElement(msg));
        });

        container.scrollTop = container.scrollHeight;
    },

    createMessageElement(message) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message ' + message.role;

        const avatar = document.createElement('div');
        avatar.className = 'message-avatar';
        if (message.role === 'user') {
            avatar.textContent = 'U';
        } else if (window.AppState.mozartMode) {
            avatar.classList.add('mozart-avatar');
            avatar.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
        } else {
            avatar.textContent = 'OP';
        }

        const content = document.createElement('div');
        content.className = 'message-content';

        const bubble = document.createElement('div');
        bubble.className = 'message-bubble';

        const text = document.createElement('div');
        text.className = 'message-text';

        if (message.role === 'assistant') {
            text.innerHTML = window.Markdown ? window.Markdown.render(message.content) : message.content;
        } else {
            text.textContent = message.content;
        }

        bubble.appendChild(text);
        content.appendChild(bubble);
        messageDiv.appendChild(avatar);
        messageDiv.appendChild(content);

        return messageDiv;
    },

    sendMessage(text, attachments = []) {
        window.AppState.isStreaming = true;
        window.AppState.streamingConversationId = window.AppState.currentConversationId;

        // Build display text with attachment names
        let displayText = text;
        if (attachments.length) {
            const names = attachments.map(a => a.filename).join(', ');
            displayText += '\n[Attached: ' + names + ']';
        }

        // Add user message
        this.addUserMessage(displayText);

        // Show thinking indicator then create streaming message
        this.showThinking();

        // Update sidebar status
        if (window.Sidebar) {
            window.Sidebar.updateStatus(window.AppState.currentConversationId, 'streaming');
        }

        // Send via WebSocket
        const payload = {
            type: 'chat',
            message: text,
            model: window.AppState.currentModel,
            conversation_id: window.AppState.currentConversationId,
            simple_mode: false,
            mozart_mode: window.AppState.mozartMode,
        };
        if (attachments.length) {
            payload.attachments = attachments;
        }
        this.send(payload);
    },

    addUserMessage(text) {
        const container = document.getElementById('messages-container');
        const el = this.createMessageElement({ role: 'user', content: text });
        container.appendChild(el);
        container.scrollTop = container.scrollHeight;
    },

    showThinking() {
        const container = document.getElementById('messages-container');
        const thinking = document.createElement('div');
        thinking.className = 'thinking-indicator';
        thinking.id = 'thinking-indicator';
        const label = window.AppState.mozartMode ? 'Composing...' : 'Thinking...';
        thinking.innerHTML = '<div class="thinking-dots"><span></span><span></span><span></span></div><span>' + label + '</span>';
        container.appendChild(thinking);
        container.scrollTop = container.scrollHeight;
    },

    hideThinking() {
        const el = document.getElementById('thinking-indicator');
        if (el) el.remove();
    },

    createStreamingMessage() {
        const container = document.getElementById('messages-container');
        const msg = { role: 'assistant', content: '' };
        const el = this.createMessageElement(msg);
        el.classList.add('streaming');
        container.appendChild(el);
        container.scrollTop = container.scrollHeight;
        return el;
    },

    appendToCurrentMessage(text) {
        // Remove thinking indicator on first content
        if (!this.currentMessageElement) {
            this.hideThinking();
            this.currentMessageElement = this.createStreamingMessage();
        }

        const textDiv = this.currentMessageElement.querySelector('.message-text');
        const raw = textDiv.getAttribute('data-raw-content') || '';
        const updated = raw + text;
        textDiv.setAttribute('data-raw-content', updated);

        if (window.Markdown) {
            textDiv.innerHTML = window.Markdown.render(updated);
        } else {
            textDiv.textContent = updated;
        }

        const container = document.getElementById('messages-container');
        container.scrollTop = container.scrollHeight;
    },

    handleResult(data) {
        if (data.cost_usd > 0) {
            console.log('Cost: $' + data.cost_usd.toFixed(4));
        }
    },

    handleStreamComplete() {
        window.AppState.isStreaming = false;
        window.AppState.streamingConversationId = null;

        // Remove streaming class
        if (this.currentMessageElement) {
            this.currentMessageElement.classList.remove('streaming');
        }
        this.currentMessageElement = null;
        this.hideThinking();

        // Update sidebar
        if (window.Sidebar) {
            window.Sidebar.updateStatus(window.AppState.currentConversationId, 'idle');
            window.Sidebar.loadConversations();
        }
    },

    addErrorMessage(message) {
        this.hideThinking();
        if (this.currentMessageElement) {
            this.currentMessageElement.classList.remove('streaming');
            this.currentMessageElement = null;
        }

        const container = document.getElementById('messages-container');
        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-message';
        errorDiv.textContent = 'Error: ' + message;
        container.appendChild(errorDiv);
        container.scrollTop = container.scrollHeight;
    }
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    window.Chat.init();
});
