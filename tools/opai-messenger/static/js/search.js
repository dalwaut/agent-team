// OPAI Messenger - Full-text message search

let _searchTimeout = null;

function toggleSearchPanel() {
    const panel = document.getElementById('search-panel');
    panel.classList.toggle('visible');

    if (panel.classList.contains('visible')) {
        const input = document.getElementById('search-input');
        input.value = '';
        input.focus();
        document.getElementById('search-results').innerHTML = '';

        // Setup search input handler
        input.oninput = () => {
            clearTimeout(_searchTimeout);
            _searchTimeout = setTimeout(() => performSearch(input.value), 300);
        };

        input.onkeydown = (e) => {
            if (e.key === 'Escape') {
                panel.classList.remove('visible');
            }
        };
    }
}

async function performSearch(query) {
    if (!query || query.length < 2) {
        document.getElementById('search-results').innerHTML = '';
        return;
    }

    try {
        const resp = await authFetch(`api/messages/search?q=${encodeURIComponent(query)}`);
        const data = await resp.json();
        renderSearchResults(data.results || []);
    } catch (e) {
        console.error('Search failed:', e);
        document.getElementById('search-results').innerHTML =
            '<div style="padding:12px;color:var(--color-text-tertiary);text-align:center;">Search failed</div>';
    }
}

function renderSearchResults(results) {
    const container = document.getElementById('search-results');

    if (!results.length) {
        container.innerHTML = '<div style="padding:12px;color:var(--color-text-tertiary);text-align:center;">No results found</div>';
        return;
    }

    container.innerHTML = results.map(r => {
        const channelName = r.channel?.name || 'Unknown';
        const senderName = r.sender?.display_name || 'Unknown';
        const time = formatTime(r.created_at);

        return `
            <div class="search-result-item" onclick="jumpToSearchResult('${r.channel_id}', '${r.id}')">
                <div class="search-result-channel"># ${escapeHtml(channelName)}</div>
                <div class="search-result-content">${escapeHtml(truncate(r.content, 80))}</div>
                <div class="search-result-meta">${escapeHtml(senderName)} · ${time}</div>
            </div>
        `;
    }).join('');
}

async function jumpToSearchResult(channelId, messageId) {
    // Close search panel
    document.getElementById('search-panel').classList.remove('visible');

    // Switch to channel if needed
    if (!App.activeChannel || App.activeChannel.id !== channelId) {
        await selectChannel(channelId);
    }

    // Try to scroll to the message
    setTimeout(() => scrollToMessage(messageId), 300);
}
