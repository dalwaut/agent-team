// OPAI Messenger - Chat message rendering and sending

let _replyTo = null;

async function loadMessages(before = null) {
    if (!App.activeChannel) return;

    const container = document.getElementById('messages');
    if (!before) {
        container.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';
    }

    try {
        let url = `api/channels/${App.activeChannel.id}/messages?limit=50`;
        if (before) url += `&before=${before}`;

        const resp = await authFetch(url);
        const data = await resp.json();

        if (!before) container.innerHTML = '';

        renderMessages(data.messages, !before);

        if (!before) scrollToBottom();

        // Setup infinite scroll for older messages
        if (data.has_more && !before) {
            setupInfiniteScroll(data.messages);
        }
    } catch (e) {
        console.error('Failed to load messages:', e);
        container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--color-text-tertiary);">Failed to load messages</div>';
    }
}

function setupInfiniteScroll(messages) {
    const container = document.getElementById('messages');
    let loading = false;

    container.addEventListener('scroll', async () => {
        if (loading || container.scrollTop > 50) return;

        const firstMsg = container.querySelector('[data-msg-id]');
        if (!firstMsg) return;

        const firstMsgData = messages[0];
        if (!firstMsgData) return;

        loading = true;
        const oldHeight = container.scrollHeight;

        try {
            const resp = await authFetch(
                `api/channels/${App.activeChannel.id}/messages?limit=50&before=${firstMsgData.created_at}`
            );
            const data = await resp.json();
            if (data.messages.length) {
                renderMessages(data.messages, false, true);
                messages.unshift(...data.messages);
                // Maintain scroll position
                container.scrollTop = container.scrollHeight - oldHeight;
            }
        } catch (e) {
            console.error('Failed to load older messages:', e);
        }

        loading = false;
    });
}

function renderMessages(messages, isInitial = true, prepend = false) {
    const container = document.getElementById('messages');
    let html = '';
    let lastDate = '';
    let lastSenderId = '';

    for (const msg of messages) {
        const msgDate = formatDate(msg.created_at);
        if (msgDate !== lastDate) {
            html += `<div class="date-separator">${msgDate}</div>`;
            lastDate = msgDate;
            lastSenderId = ''; // Reset grouping on date change
        }

        const isSelf = msg.sender_id === App.user.id;
        const senderName = msg.sender?.display_name || 'Unknown';
        const initials = getInitials(senderName);
        const isDeleted = !!msg.deleted_at;
        const showHeader = msg.sender_id !== lastSenderId;

        html += renderMessageHTML(msg, isSelf, senderName, initials, isDeleted, showHeader);
        lastSenderId = msg.sender_id;
    }

    if (prepend) {
        container.insertAdjacentHTML('afterbegin', html);
    } else {
        container.insertAdjacentHTML('beforeend', html);
    }
}

function renderMessageHTML(msg, isSelf, senderName, initials, isDeleted, showHeader) {
    const replyHtml = msg.reply_message ? `
        <div class="msg-reply-preview" onclick="scrollToMessage('${msg.reply_to}')">
            <span class="reply-sender">${escapeHtml(msg.reply_message.sender?.display_name || 'Unknown')}</span>
            <span>${escapeHtml(truncate(msg.reply_message.content, 50))}</span>
        </div>
    ` : '';

    const actionsHtml = isDeleted ? '' : `
        <div class="msg-actions">
            <button class="msg-action-btn" onclick="setReply('${msg.id}', '${escapeAttr(senderName)}', '${escapeAttr(truncate(msg.content, 50))}')" title="Reply">↩</button>
            <button class="msg-action-btn" onclick="showEmojiPickerForMessage('${msg.id}')" title="React">😀</button>
            ${isSelf ? `<button class="msg-action-btn" onclick="editMessage('${msg.id}')" title="Edit">✏</button>` : ''}
            ${isSelf ? `<button class="msg-action-btn" onclick="deleteMessage('${msg.id}')" title="Delete">🗑</button>` : ''}
        </div>
    `;

    const contentHtml = isDeleted
        ? '<span style="font-style:italic;color:var(--color-text-tertiary);">This message was deleted</span>'
        : formatContent(msg.content);

    const fileHtml = msg.file_url && !isDeleted ? renderFileAttachment(msg) : '';
    const reactionsHtml = msg.reactions?.length ? renderReactionPills(msg) : '';
    const editedHtml = msg.edited_at && !isDeleted ? '<span class="msg-edited">(edited)</span>' : '';

    const avatarHtml = showHeader
        ? `<div class="msg-avatar ${isSelf ? 'self' : ''}">${initials}</div>`
        : '<div style="width:32px;flex-shrink:0;"></div>';

    const headerHtml = showHeader ? `
        <div class="msg-header">
            <span class="msg-sender ${isSelf ? 'self' : ''}">${escapeHtml(senderName)}</span>
            <span class="msg-time">${formatTime(msg.created_at)}</span>
            ${editedHtml}
        </div>
    ` : '';

    return `
        <div class="msg-wrapper ${isDeleted ? 'msg-deleted' : ''} ${isSelf ? 'msg-self' : ''}" data-msg-id="${msg.id}">
            <div class="msg-group ${isSelf ? 'self' : ''}">
                ${isSelf ? '' : avatarHtml}
                <div class="msg-body">
                    ${headerHtml}
                    ${replyHtml}
                    <div class="msg-content">${contentHtml}</div>
                    ${fileHtml}
                    ${reactionsHtml}
                </div>
                ${isSelf ? avatarHtml : ''}
            </div>
            ${actionsHtml}
        </div>
    `;
}

function renderFileAttachment(msg) {
    const isImage = msg.file_type?.startsWith('image/');
    if (isImage) {
        return `<img class="msg-image" src="${msg.file_url}" alt="${escapeHtml(msg.file_name)}" onclick="window.open('${msg.file_url}', '_blank')">`;
    }

    const icon = getFileIcon(msg.file_type);
    return `
        <a class="msg-file" href="${msg.file_url}" target="_blank" rel="noopener">
            <span class="msg-file-icon">${icon}</span>
            <div class="msg-file-info">
                <div class="msg-file-name">${escapeHtml(msg.file_name || 'File')}</div>
                <div class="msg-file-type">${msg.file_type || 'Unknown'}</div>
            </div>
        </a>
    `;
}

function getFileIcon(type) {
    if (!type) return '📄';
    if (type.includes('pdf')) return '📕';
    if (type.includes('zip') || type.includes('archive')) return '📦';
    if (type.includes('json')) return '📋';
    if (type.includes('text') || type.includes('csv')) return '📝';
    if (type.includes('word') || type.includes('document')) return '📄';
    return '📎';
}

function appendMessage(msg) {
    const container = document.getElementById('messages');
    const isSelf = msg.sender_id === App.user.id;
    const senderName = msg.sender?.display_name || 'Unknown';
    const initials = getInitials(senderName);
    const isDeleted = !!msg.deleted_at;

    // Check if we should show header (different sender from last)
    const lastWrapper = container.querySelector('.msg-wrapper:last-child');
    const lastSenderId = lastWrapper?.querySelector('.msg-sender') ? msg.sender_id : null;
    const showHeader = !lastWrapper || true; // Always show for safety with realtime

    const html = renderMessageHTML(msg, isSelf, senderName, initials, isDeleted, showHeader);
    container.insertAdjacentHTML('beforeend', html);
}

async function sendMessage() {
    const input = document.getElementById('message-input');
    const content = input.value.trim();
    if (!content || !App.activeChannel) return;

    input.value = '';
    input.style.height = 'auto';

    const body = { content };
    if (_replyTo) {
        body.reply_to = _replyTo;
        clearReply();
    }

    try {
        const resp = await authFetch(`api/channels/${App.activeChannel.id}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const msg = await resp.json();

        // Append immediately (Realtime will also fire, but we dedup by ID)
        if (!document.querySelector(`[data-msg-id="${msg.id}"]`)) {
            msg.sender = { display_name: App.user.display_name, email: App.user.email };
            appendMessage(msg);
            scrollToBottom();
        }
    } catch (e) {
        console.error('Failed to send message:', e);
    }
}

function setReply(msgId, senderName, preview) {
    _replyTo = msgId;
    document.getElementById('reply-text').textContent = `Replying to ${senderName}: ${preview}`;
    document.getElementById('reply-bar').classList.add('visible');
    document.getElementById('message-input').focus();
}

function clearReply() {
    _replyTo = null;
    document.getElementById('reply-bar').classList.remove('visible');
}

async function editMessage(msgId) {
    const el = document.querySelector(`[data-msg-id="${msgId}"] .msg-content`);
    if (!el) return;

    const currentText = el.textContent;
    const newText = prompt('Edit message:', currentText);
    if (newText === null || newText === currentText) return;

    try {
        await authFetch(`api/messages/${msgId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: newText }),
        });
        el.innerHTML = formatContent(newText);
    } catch (e) {
        console.error('Failed to edit message:', e);
    }
}

async function deleteMessage(msgId) {
    if (!confirm('Delete this message?')) return;

    try {
        await authFetch(`api/messages/${msgId}`, { method: 'DELETE' });
        const el = document.querySelector(`[data-msg-id="${msgId}"]`);
        if (el) {
            el.classList.add('msg-deleted');
            const content = el.querySelector('.msg-content');
            if (content) content.textContent = 'This message was deleted';
            const actions = el.querySelector('.msg-actions');
            if (actions) actions.remove();
        }
    } catch (e) {
        console.error('Failed to delete message:', e);
    }
}

function scrollToMessage(msgId) {
    const el = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.style.background = 'rgba(168, 85, 247, 0.1)';
        setTimeout(() => { el.style.background = ''; }, 2000);
    }
}

function escapeAttr(str) {
    if (!str) return '';
    return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}
