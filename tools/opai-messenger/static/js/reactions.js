// OPAI Messenger - Emoji reactions

const EMOJI_LIST = [
    '👍', '👎', '❤️', '😂', '😮', '😢', '🔥', '🎉',
    '👏', '🙏', '💯', '✅', '❌', '👀', '🤔', '💪',
    '🚀', '⭐', '💡', '🎯', '🐛', '🔧', '📝', '💜',
];

let _activeReactionMsgId = null;

function toggleEmojiPicker() {
    const picker = document.getElementById('emoji-picker');
    if (!picker.innerHTML) {
        picker.innerHTML = EMOJI_LIST.map(e =>
            `<button class="emoji-btn" onclick="insertEmoji('${e}')">${e}</button>`
        ).join('');
    }
    picker.classList.toggle('visible');
}

function insertEmoji(emoji) {
    const input = document.getElementById('message-input');
    const start = input.selectionStart;
    const end = input.selectionEnd;
    input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
    input.focus();
    input.selectionStart = input.selectionEnd = start + emoji.length;
    document.getElementById('emoji-picker')?.classList.remove('visible');
}

function showEmojiPickerForMessage(msgId) {
    _activeReactionMsgId = msgId;
    const wrapper = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (!wrapper) return;

    // Remove existing picker
    document.querySelectorAll('.reaction-picker-popup').forEach(el => el.remove());

    const picker = document.createElement('div');
    picker.className = 'reaction-picker-popup';
    picker.style.cssText = `
        position: absolute; top: -40px; right: 8px; z-index: 70;
        background: var(--color-bg-secondary); border: 1px solid var(--glass-border);
        border-radius: 20px; padding: 4px 8px; display: flex; gap: 2px;
    `;

    const quickEmojis = ['👍', '❤️', '😂', '🔥', '👀', '✅'];
    picker.innerHTML = quickEmojis.map(e =>
        `<button class="emoji-btn" style="width:28px;height:28px;font-size:0.9rem;" onclick="addReaction('${msgId}', '${e}')">${e}</button>`
    ).join('');

    wrapper.appendChild(picker);

    // Remove on outside click
    const handler = (e) => {
        if (!picker.contains(e.target)) {
            picker.remove();
            document.removeEventListener('click', handler);
        }
    };
    setTimeout(() => document.addEventListener('click', handler), 0);
}

async function addReaction(msgId, emoji) {
    // Remove picker
    document.querySelectorAll('.reaction-picker-popup').forEach(el => el.remove());

    try {
        await authFetch(`api/messages/${msgId}/reactions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ emoji }),
        });
        // Optimistic update
        addReactionToDOM(msgId, emoji, App.user.id, App.user.display_name);
    } catch (e) {
        console.error('Failed to add reaction:', e);
    }
}

async function removeReaction(msgId, emoji) {
    try {
        await authFetch(`api/messages/${msgId}/reactions/${encodeURIComponent(emoji)}`, {
            method: 'DELETE',
        });
        removeReactionFromDOM(msgId, emoji, App.user.id);
    } catch (e) {
        console.error('Failed to remove reaction:', e);
    }
}

function toggleReaction(msgId, emoji) {
    const wrapper = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (!wrapper) return;

    const pill = wrapper.querySelector(`.reaction-pill[data-emoji="${emoji}"]`);
    if (pill?.classList.contains('own')) {
        removeReaction(msgId, emoji);
    } else {
        addReaction(msgId, emoji);
    }
}

function renderReactionPills(msg) {
    if (!msg.reactions?.length) return '';

    // Group by emoji
    const groups = {};
    for (const r of msg.reactions) {
        if (!groups[r.emoji]) groups[r.emoji] = [];
        groups[r.emoji].push(r);
    }

    return '<div class="msg-reactions">' +
        Object.entries(groups).map(([emoji, reactions]) => {
            const isOwn = reactions.some(r => r.user_id === App.user?.id);
            const names = reactions.map(r => r.user?.display_name || 'Unknown').join(', ');
            return `<button class="reaction-pill ${isOwn ? 'own' : ''}" data-emoji="${emoji}"
                onclick="toggleReaction('${msg.id}', '${emoji}')" title="${names}">
                ${emoji} <span class="reaction-count">${reactions.length}</span>
            </button>`;
        }).join('') +
    '</div>';
}

function addReactionToDOM(msgId, emoji, userId, displayName) {
    const wrapper = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (!wrapper) return;

    let reactionsDiv = wrapper.querySelector('.msg-reactions');
    if (!reactionsDiv) {
        reactionsDiv = document.createElement('div');
        reactionsDiv.className = 'msg-reactions';
        wrapper.querySelector('.msg-body')?.appendChild(reactionsDiv);
    }

    const existing = reactionsDiv.querySelector(`[data-emoji="${emoji}"]`);
    if (existing) {
        const count = existing.querySelector('.reaction-count');
        count.textContent = parseInt(count.textContent) + 1;
        if (userId === App.user?.id) existing.classList.add('own');
    } else {
        const pill = document.createElement('button');
        pill.className = `reaction-pill ${userId === App.user?.id ? 'own' : ''}`;
        pill.dataset.emoji = emoji;
        pill.onclick = () => toggleReaction(msgId, emoji);
        pill.title = displayName;
        pill.innerHTML = `${emoji} <span class="reaction-count">1</span>`;
        reactionsDiv.appendChild(pill);
    }
}

function removeReactionFromDOM(msgId, emoji, userId) {
    const wrapper = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (!wrapper) return;

    const pill = wrapper.querySelector(`[data-emoji="${emoji}"]`);
    if (!pill) return;

    const count = pill.querySelector('.reaction-count');
    const newCount = parseInt(count.textContent) - 1;
    if (newCount <= 0) {
        pill.remove();
    } else {
        count.textContent = newCount;
        if (userId === App.user?.id) pill.classList.remove('own');
    }
}

function handleReactionChange(payload) {
    if (payload.eventType === 'INSERT') {
        const r = payload.new;
        addReactionToDOM(r.message_id, r.emoji, r.user_id, '');
    } else if (payload.eventType === 'DELETE') {
        const r = payload.old;
        if (r) removeReactionFromDOM(r.message_id, r.emoji, r.user_id);
    }
}
