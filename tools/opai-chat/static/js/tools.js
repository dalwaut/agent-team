// OPAI Chat - Tool Call Display and Approval

window.Tools = {
    renderToolCall(toolCall, messageId) {
        const container = document.createElement('div');
        container.className = 'tool-call-container';
        container.style.cssText = `
            margin: 1rem 0;
            padding: 1rem;
            background: var(--glass-bg);
            border: 1px solid var(--color-purple-deep);
            border-radius: 12px;
            backdrop-filter: blur(var(--glass-blur));
        `;

        // Tool header
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            align-items: center;
            gap: 0.5rem;
            margin-bottom: 0.75rem;
            font-weight: 600;
        `;

        const icon = toolCall.status === 'executed' ? '✅' :
            toolCall.status === 'denied' ? '❌' : '⚠️';

        header.innerHTML = `
            <span style="font-size: 1.25rem;">${icon}</span>
            <span>Tool: ${toolCall.name}</span>
        `;
        container.appendChild(header);

        // Tool input
        const inputDiv = document.createElement('div');
        inputDiv.style.cssText = `
            background: rgba(0, 0, 0, 0.3);
            padding: 0.75rem;
            border-radius: 8px;
            margin-bottom: 0.75rem;
            font-family: monospace;
            font-size: 0.875rem;
        `;
        inputDiv.innerHTML = `<strong>Parameters:</strong><br><pre style="margin: 0.5rem 0 0 0;">${JSON.stringify(toolCall.input, null, 2)}</pre>`;
        container.appendChild(inputDiv);

        // Approval buttons (if pending)
        if (toolCall.status === 'pending') {
            const actions = document.createElement('div');
            actions.style.cssText = `
                display: flex;
                gap: 0.5rem;
            `;

            const denyBtn = document.createElement('button');
            denyBtn.textContent = '❌ Deny';
            denyBtn.style.cssText = `
                flex: 1;
                padding: 0.75rem;
                background: transparent;
                border: 1px solid var(--color-error);
                border-radius: 8px;
                color: var(--color-error);
                cursor: pointer;
                font-weight: 600;
                transition: all 0.2s;
            `;
            denyBtn.addEventListener('click', () => {
                this.respondToTool(messageId, toolCall.id, false);
            });

            const approveBtn = document.createElement('button');
            approveBtn.textContent = '✅ Approve';
            approveBtn.style.cssText = `
                flex: 1;
                padding: 0.75rem;
                background: var(--color-success);
                border: none;
                border-radius: 8px;
                color: white;
                cursor: pointer;
                font-weight: 600;
                transition: all 0.2s;
            `;
            approveBtn.addEventListener('click', () => {
                this.respondToTool(messageId, toolCall.id, true);
            });

            actions.appendChild(denyBtn);
            actions.appendChild(approveBtn);
            container.appendChild(actions);
        }

        // Tool result (if executed or denied)
        if (toolCall.result) {
            const resultDiv = document.createElement('div');
            resultDiv.style.cssText = `
                background: rgba(0, 0, 0, 0.3);
                padding: 0.75rem;
                border-radius: 8px;
                margin-top: 0.75rem;
                font-family: monospace;
                font-size: 0.875rem;
            `;
            resultDiv.innerHTML = `<strong>Result:</strong><br><pre style="margin: 0.5rem 0 0 0; white-space: pre-wrap;">${this.escapeHtml(toolCall.result)}</pre>`;
            container.appendChild(resultDiv);
        }

        return container;
    },

    async respondToTool(messageId, toolCallId, approved) {
        try {
            const response = await fetch('api/chat/tool-response', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    conversation_id: window.AppState.currentConversationId,
                    message_id: messageId,
                    tool_call_id: toolCallId,
                    approved: approved
                })
            });

            const result = await response.json();

            // Reload conversation to show updated tool status
            if (window.Chat) {
                window.Chat.loadConversation(window.AppState.currentConversationId);
            }
        } catch (error) {
            console.error('Error responding to tool:', error);
        }
    },

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};
