/**
 * Bx4 -- Advisor Chat View
 * Chat interface with the AI business advisor.
 */

'use strict';

var _advisorHistory = [];

async function initAdvisor() {
    var root = document.getElementById('view-root');
    var co = window.BX4.currentCompany;
    if (!co) { root.innerHTML = '<div class="empty-state"><div class="empty-state-title">Select a company</div></div>'; return; }

    root.innerHTML = buildAdvisorShell(co);
    _advisorHistory = [];

    // Load chat history
    try {
        var data = await companyApi('/advisor/history?limit=50');
        var messages = data && data.messages ? data.messages : (Array.isArray(data) ? data : []);
        _advisorHistory = messages.map(function(m) {
            return { role: m.role || (m.action_type === 'user_message' ? 'user' : 'assistant'), content: m.content || m.message || '' };
        });
        renderChatMessages();
    } catch (err) {
        // No history -- that is fine
    }

    setupAdvisorEventListeners();
}

function buildAdvisorShell(co) {
    return '' +
        '<div class="view-header">' +
            '<div><h1 class="view-title">AI Business Advisor</h1>' +
            '<div class="view-subtitle">' + esc(co.name) + '</div></div>' +
            '<button class="btn btn-sm btn-outline" onclick="openGoalOverride()">Set Goal</button>' +
        '</div>' +

        '<div class="card">' +
            '<div class="chat-container">' +
                // Prompt Chips
                '<div class="chat-prompt-chips">' +
                    '<span class="prompt-chip" onclick="sendPromptChip(this)">What needs attention today?</span>' +
                    '<span class="prompt-chip" onclick="sendPromptChip(this)">How healthy is our cash position?</span>' +
                    '<span class="prompt-chip" onclick="sendPromptChip(this)">What are competitors doing?</span>' +
                    '<span class="prompt-chip" onclick="sendPromptChip(this)">Should I hire right now?</span>' +
                '</div>' +

                // Messages area
                '<div class="chat-messages" id="advisor-messages">' +
                    '<div class="empty-state" style="padding:40px;">' +
                        '<span class="empty-state-icon">&#x1F916;</span>' +
                        '<div class="empty-state-title">Ask your advisor anything</div>' +
                        '<div class="empty-state-msg">Get strategic insights about your business.</div>' +
                    '</div>' +
                '</div>' +

                // Input Bar
                '<div class="chat-input-bar">' +
                    '<textarea id="advisor-input" placeholder="Ask a question about your business..." rows="1"></textarea>' +
                    '<button class="btn btn-primary" id="advisor-send-btn" onclick="sendAdvisorMessage()">Send</button>' +
                '</div>' +
            '</div>' +
        '</div>' +

        // Goal Override Modal
        '<div id="goal-override-modal" class="modal-overlay hidden">' +
            '<div class="modal-box">' +
                '<div class="modal-header">' +
                    '<h2>Set Primary Goal</h2>' +
                    '<button class="modal-close" onclick="closeGoalOverride()">&times;</button>' +
                '</div>' +
                '<div class="modal-body">' +
                    '<form id="goal-override-form" class="form">' +
                        '<label class="form-label">' +
                            'Primary Goal' +
                            '<textarea class="form-textarea" id="goal-override-text" placeholder="e.g. Reach $10K MRR by end of Q2" rows="3"></textarea>' +
                        '</label>' +
                        '<div style="text-align:right;">' +
                            '<button type="button" class="btn btn-ghost" onclick="closeGoalOverride()">Cancel</button>' +
                            '<button type="submit" class="btn btn-primary" style="margin-left:8px;">Save Goal</button>' +
                        '</div>' +
                    '</form>' +
                '</div>' +
            '</div>' +
        '</div>';
}

function renderChatMessages() {
    var el = document.getElementById('advisor-messages');
    if (_advisorHistory.length === 0) {
        el.innerHTML =
            '<div class="empty-state" style="padding:40px;">' +
                '<span class="empty-state-icon">&#x1F916;</span>' +
                '<div class="empty-state-title">Ask your advisor anything</div>' +
                '<div class="empty-state-msg">Get strategic insights about your business.</div>' +
            '</div>';
        return;
    }

    var html = '';
    _advisorHistory.forEach(function(msg) {
        var cls = msg.role === 'user' ? 'user' : 'bot';
        html += '<div class="chat-bubble ' + cls + '">' +
            formatChatContent(msg.content) +
        '</div>';
    });
    el.innerHTML = html;
    el.scrollTop = el.scrollHeight;
}

function formatChatContent(text) {
    if (!text) return '';
    // Basic markdown-like formatting: bold, links
    var escaped = esc(text);
    // Convert **bold** to <strong>
    escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Convert newlines to <br>
    escaped = escaped.replace(/\n/g, '<br>');
    return escaped;
}

function addTypingIndicator() {
    var el = document.getElementById('advisor-messages');
    var indicator = document.createElement('div');
    indicator.className = 'typing-indicator';
    indicator.id = 'typing-indicator';
    indicator.innerHTML = '<span></span><span></span><span></span>';
    el.appendChild(indicator);
    el.scrollTop = el.scrollHeight;
}

function removeTypingIndicator() {
    var ind = document.getElementById('typing-indicator');
    if (ind) ind.remove();
}

async function sendAdvisorMessage() {
    var input = document.getElementById('advisor-input');
    var message = input.value.trim();
    if (!message) return;

    // Disable input
    input.value = '';
    input.disabled = true;
    document.getElementById('advisor-send-btn').disabled = true;

    // Add user message
    _advisorHistory.push({ role: 'user', content: message });
    renderChatMessages();

    // Show typing indicator
    addTypingIndicator();

    try {
        var result = await companyApi('/advisor/chat', {
            method: 'POST',
            body: {
                message: message,
                history: _advisorHistory.slice(-20) // Last 20 messages for context
            }
        });

        removeTypingIndicator();

        var response = result.response || result.message || result.content || '';
        _advisorHistory.push({ role: 'assistant', content: response });
        renderChatMessages();
    } catch (err) {
        removeTypingIndicator();
        _advisorHistory.push({ role: 'assistant', content: 'Sorry, I encountered an error: ' + err.message });
        renderChatMessages();
    }

    // Re-enable input
    input.disabled = false;
    document.getElementById('advisor-send-btn').disabled = false;
    input.focus();
}

function sendPromptChip(chipEl) {
    var input = document.getElementById('advisor-input');
    input.value = chipEl.textContent;
    sendAdvisorMessage();
}

function setupAdvisorEventListeners() {
    var input = document.getElementById('advisor-input');
    if (input) {
        // Enter to send, Shift+Enter for newline
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendAdvisorMessage();
            }
        });

        // Auto-resize textarea
        input.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 120) + 'px';
        });
    }

    // Goal override form
    var goalForm = document.getElementById('goal-override-form');
    if (goalForm) {
        goalForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            var text = document.getElementById('goal-override-text').value.trim();
            if (!text) return;
            try {
                await companyApi('/goals/primary', {
                    method: 'PUT',
                    body: { title: text, type: 'primary', progress: 0 }
                });
                showToast('Primary goal updated', 'success');
                closeGoalOverride();
            } catch (err) {
                showToast('Failed: ' + err.message, 'error');
            }
        });
    }
}

function openGoalOverride() {
    document.getElementById('goal-override-modal').classList.remove('hidden');
    document.getElementById('goal-override-text').focus();
}

function closeGoalOverride() {
    document.getElementById('goal-override-modal').classList.add('hidden');
}

// Expose globally
window.sendAdvisorMessage = sendAdvisorMessage;
window.sendPromptChip = sendPromptChip;
window.openGoalOverride = openGoalOverride;
window.closeGoalOverride = closeGoalOverride;
