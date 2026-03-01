/**
 * LLM Client — Container-side module for calling the broker's LLM proxy.
 *
 * The container NEVER calls the Anthropic API directly. All LLM requests
 * go through the broker's /oc/api/llm/chat endpoint, which runs `claude -p`
 * on the host machine.
 *
 * Auth: Uses OC_CALLBACK_TOKEN env var (set at provisioning time).
 *
 * Usage:
 *   const llm = require('./lib/llm');
 *   const reply = await llm.chat('What is 2+2?');
 *   const reply = await llm.chatWithHistory(messages, systemPrompt);
 */

const BROKER_URL = process.env.OC_BROKER_URL || 'http://host.docker.internal:8106';
const CALLBACK_TOKEN = process.env.OC_CALLBACK_TOKEN || '';

/**
 * Send a single prompt to the LLM via the broker proxy.
 * @param {string} prompt - The user message
 * @param {string} [system] - Optional system prompt
 * @param {number} [maxTokens=4096] - Max tokens in response
 * @returns {Promise<{reply: string, model: string, input_tokens: number, output_tokens: number, duration_ms: number}>}
 */
async function chat(prompt, system = null, maxTokens = 4096) {
    const messages = [{ role: 'user', content: prompt }];
    return chatWithHistory(messages, system, maxTokens);
}

/**
 * Send a multi-turn conversation to the LLM via the broker proxy.
 * @param {Array<{role: string, content: string}>} messages - Conversation history
 * @param {string} [system] - Optional system prompt
 * @param {number} [maxTokens=4096] - Max tokens in response
 * @returns {Promise<{reply: string, model: string, input_tokens: number, output_tokens: number, duration_ms: number}>}
 */
async function chatWithHistory(messages, system = null, maxTokens = 4096) {
    if (!CALLBACK_TOKEN) {
        throw new Error('OC_CALLBACK_TOKEN not set — cannot authenticate with broker');
    }

    const url = `${BROKER_URL}/oc/api/llm/chat`;
    const body = { messages, max_tokens: maxTokens };
    if (system) body.system = system;

    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${CALLBACK_TOKEN}`,
        },
        body: JSON.stringify(body),
    });

    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        let detail = `${resp.status} ${resp.statusText}`;
        try { const j = JSON.parse(text); detail = j.detail || detail; } catch {}

        const err = new Error(`LLM proxy error: ${detail}`);
        err.status = resp.status;
        throw err;
    }

    return resp.json();
}

/**
 * Get current LLM usage stats for this container.
 * @returns {Promise<{requests_this_minute: number, requests_this_hour: number, tokens_today: number, limits: object}>}
 */
async function getUsage() {
    if (!CALLBACK_TOKEN) {
        throw new Error('OC_CALLBACK_TOKEN not set');
    }

    const resp = await fetch(`${BROKER_URL}/oc/api/llm/usage`, {
        headers: { 'Authorization': `Bearer ${CALLBACK_TOKEN}` },
    });

    if (!resp.ok) {
        throw new Error(`Usage check failed: ${resp.status}`);
    }

    return resp.json();
}

module.exports = { chat, chatWithHistory, getUsage };
