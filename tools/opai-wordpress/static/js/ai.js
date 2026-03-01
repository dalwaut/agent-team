/* OP WordPress — AI assistant chat panel */

WP.AI = {
    history: [],

    async send() {
        const input = document.getElementById('ai-input');
        const msg = input.value.trim();
        if (!msg) return;

        if (!WP.currentSite) {
            WP.AI.addMessage('assistant', 'Please select a WordPress site first.');
            return;
        }

        input.value = '';
        WP.AI.addMessage('user', msg);
        WP.AI.history.push({ role: 'user', content: msg });

        // Show typing indicator
        const typingId = 'ai-typing-' + Date.now();
        WP.AI.addMessage('assistant', 'Thinking...', typingId);

        try {
            const result = await WP.api('ai/chat', {
                method: 'POST',
                body: {
                    site_id: WP.currentSite.id,
                    message: msg,
                    history: WP.AI.history.slice(-10),
                },
            });

            // Remove typing indicator
            const typingEl = document.getElementById(typingId);
            if (typingEl) typingEl.remove();

            const response = result.response || 'No response';
            WP.AI.addMessage('assistant', response);
            WP.AI.history.push({ role: 'assistant', content: response });
        } catch (e) {
            const typingEl = document.getElementById(typingId);
            if (typingEl) typingEl.remove();
            WP.AI.addMessage('assistant', 'Error: ' + e.message);
        }
    },

    addMessage(role, text, id) {
        const container = document.getElementById('ai-messages');
        const el = document.createElement('div');
        el.className = 'ai-msg ' + role;
        if (id) el.id = id;
        el.textContent = text;
        container.appendChild(el);
        container.scrollTop = container.scrollHeight;
    },

    // Plan/execute workflow
    async generatePlan(prompt) {
        if (!WP.currentSite) {
            WP.toast('Select a site first', 'error');
            return null;
        }

        try {
            const plan = await WP.api('ai/plan', {
                method: 'POST',
                body: {
                    site_id: WP.currentSite.id,
                    prompt: prompt,
                },
            });
            return plan;
        } catch (e) {
            WP.toast('Plan generation failed: ' + e.message, 'error');
            return null;
        }
    },

    async executePlan(plan) {
        if (!WP.currentSite) {
            WP.toast('Select a site first', 'error');
            return null;
        }

        try {
            const result = await WP.api('ai/execute', {
                method: 'POST',
                body: {
                    site_id: WP.currentSite.id,
                    plan: plan,
                },
            });
            return result;
        } catch (e) {
            WP.toast('Plan execution failed: ' + e.message, 'error');
            return null;
        }
    },

    async loadTemplates() {
        try {
            return await WP.api('ai/templates');
        } catch (e) {
            return [];
        }
    },
};
