/**
 * ClawBot Runtime Server — Autonomous Agent Container
 *
 * This is the core runtime for each OpenClaw container instance.
 * It provides:
 *   - POST /message — Main conversation endpoint (LLM via broker proxy)
 *   - GET  /health  — Docker healthcheck + orchestrator monitoring
 *   - GET  /status  — Detailed instance info + memory stats
 *   - GET  /ready   — Readiness probe
 *   - GET  /memory  — Memory layer stats
 *   - POST /memory/note  — Add a daily note externally
 *
 * Architecture:
 *   Container --(callback token)--> Broker /oc/api/llm/chat --(claude -p)--> Host CLI
 *
 * The bot uses 3-layer memory (knowledge graph, daily notes, tacit knowledge)
 * and a read-only knowledge base for grounded responses.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const llm = require('./lib/llm');
const memory = require('./lib/memory');
const kb = require('./lib/knowledge');
const heartbeat = require('./lib/heartbeat');
const ralph = require('./lib/ralph');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = parseInt(process.env.PORT || '3000', 10);
const BOT_NAME = process.env.BOT_NAME || 'ClawBot';
const INSTANCE_SLUG = process.env.INSTANCE_SLUG || 'unknown';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const startedAt = new Date().toISOString();

// ── Logger ──────────────────────────────────────────────────

function log(level, msg, data) {
    if (level === 'debug' && LOG_LEVEL !== 'debug') return;
    const entry = {
        ts: new Date().toISOString(),
        level,
        instance: INSTANCE_SLUG,
        msg,
        ...(data || {}),
    };
    const line = JSON.stringify(entry);
    console.log(line);
    try {
        fs.appendFileSync('/app/logs/clawbot.log', line + '\n');
    } catch {
        // logs dir may not be writable in some configs
    }
}

// ── Instance Config ─────────────────────────────────────────

let instanceConfig = {};
try {
    const configPath = '/app/config/instance.json';
    if (fs.existsSync(configPath)) {
        instanceConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        log('info', 'Loaded instance config', { keys: Object.keys(instanceConfig) });
    }
} catch (e) {
    log('warn', 'Failed to load instance config', { error: e.message });
}

// ── Initialize Memory + Knowledge ───────────────────────────

memory.init();
kb.index();
log('info', 'Memory initialized', memory.getStats());
log('info', 'Knowledge indexed', kb.getStats());

// ── Conversation History (in-memory, per-session) ───────────

// Map<conversationId, Array<{role, content}>>
const conversations = new Map();
const MAX_HISTORY = 20;  // Max messages per conversation to keep in context

function getConversation(id) {
    if (!conversations.has(id)) {
        conversations.set(id, []);
    }
    return conversations.get(id);
}

// ── System Prompt Builder ───────────────────────────────────

function buildSystemPrompt(userMessage) {
    const personality = instanceConfig.personality || 'default';
    const autonomy = instanceConfig.autonomy_level || 3;
    const clientName = instanceConfig.client_name || 'the client';

    // Build memory context based on the user's message
    const memoryContext = memory.buildContext(userMessage);

    // Search knowledge base for relevant docs
    const kbResults = kb.search(userMessage, 3);
    let kbContext = '';
    if (kbResults.length > 0) {
        kbContext = '\n## Relevant Knowledge Base Documents\n';
        for (const r of kbResults) {
            const content = kb.getFile(r.file);
            if (content) {
                // Include up to 500 chars of each relevant doc
                const excerpt = content.length > 500 ? content.substring(0, 500) + '...' : content;
                kbContext += `\n### ${r.title} (${r.file})\n${excerpt}\n`;
            }
        }
    }

    // Tacit knowledge — strong insights about communication style
    const insights = memory.getStrongInsights(0.7);
    let tacitSection = '';
    if (insights.length > 0) {
        tacitSection = '\n## Known Preferences\n';
        for (const i of insights.slice(0, 5)) {
            tacitSection += `- ${i.insight}\n`;
        }
    }

    return `You are ${BOT_NAME}, a personal AI assistant for ${clientName}.
Instance: ${INSTANCE_SLUG}
Autonomy Level: ${autonomy}/10
Personality: ${personality}

## Your Role
You are a knowledgeable, helpful assistant with persistent memory. You remember
previous conversations and learn the client's preferences over time. You have
access to the client's knowledge base and can reference specific documents.

## Guidelines
- Be concise and actionable
- Reference specific knowledge base documents when relevant
- Remember and build on previous interactions
- If you learn something new about the client's preferences, acknowledge it
- Autonomy ${autonomy}: ${autonomy >= 7 ? 'Act independently, report after' : autonomy >= 4 ? 'Suggest actions, confirm before proceeding' : 'Always confirm before taking any action'}

${memoryContext ? '## Memory Context\n' + memoryContext : ''}
${kbContext}
${tacitSection}`.trim();
}

// ── Endpoints ───────────────────────────────────────────────

// POST /message — Main conversation endpoint
app.post('/message', async (req, res) => {
    const { message, conversation_id } = req.body;

    if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'message field required (string)' });
    }

    const convId = conversation_id || 'default';
    const history = getConversation(convId);

    log('info', 'Message received', { conversation: convId, length: message.length });

    try {
        // Build system prompt with memory + knowledge context
        const systemPrompt = buildSystemPrompt(message);

        // Add user message to history
        history.push({ role: 'user', content: message });

        // Trim history to max
        while (history.length > MAX_HISTORY) {
            history.shift();
        }

        // Call LLM via broker proxy
        const result = await llm.chatWithHistory(history, systemPrompt);

        // Add assistant reply to history
        history.push({ role: 'assistant', content: result.reply });

        // Log the interaction as a daily note
        memory.addDailyNote(
            `User: ${message.substring(0, 100)}${message.length > 100 ? '...' : ''} | Bot: ${result.reply.substring(0, 100)}${result.reply.length > 100 ? '...' : ''}`,
            ['conversation', convId]
        );

        log('info', 'Reply sent', {
            conversation: convId,
            input_tokens: result.input_tokens,
            output_tokens: result.output_tokens,
            duration_ms: result.duration_ms,
        });

        res.json({
            reply: result.reply,
            conversation_id: convId,
            model: result.model,
            tokens: {
                input: result.input_tokens,
                output: result.output_tokens,
            },
            duration_ms: result.duration_ms,
        });

    } catch (err) {
        log('error', 'Message handling failed', { error: err.message, status: err.status });

        const status = err.status || 500;
        res.status(status).json({
            error: err.message,
            conversation_id: convId,
        });
    }
});

// GET /health — Docker HEALTHCHECK + orchestrator monitoring
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'clawbot',
        instance: INSTANCE_SLUG,
        name: BOT_NAME,
        uptime: process.uptime(),
        memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    });
});

// GET /status — Detailed instance info
app.get('/status', (req, res) => {
    const memStats = memory.getStats();
    const kbStats = kb.getStats();

    res.json({
        instance: INSTANCE_SLUG,
        name: BOT_NAME,
        started_at: startedAt,
        uptime_seconds: Math.round(process.uptime()),
        config: {
            autonomy_level: instanceConfig.autonomy_level || 3,
            personality: instanceConfig.personality || 'default',
            model: instanceConfig.model || 'haiku',
            client_name: instanceConfig.client_name || null,
        },
        memory: memStats,
        knowledge: kbStats,
        conversations: conversations.size,
        memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        has_callback_token: !!process.env.OC_CALLBACK_TOKEN,
        has_broker_url: !!process.env.OC_BROKER_URL,
        log_level: LOG_LEVEL,
    });
});

// GET /memory — Memory layer details
app.get('/memory', (req, res) => {
    const stats = memory.getStats();
    const recentNotes = memory.getDailyNotes(null, 3);
    const insights = memory.getStrongInsights(0.6);

    res.json({
        stats,
        recent_notes: recentNotes,
        strong_insights: insights.slice(0, 20),
    });
});

// POST /memory/note — Add a daily note externally
app.post('/memory/note', (req, res) => {
    const { text, tags } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });
    memory.addDailyNote(text, tags || []);
    res.json({ status: 'ok' });
});

// POST /memory/entity — Add a knowledge graph entity externally
app.post('/memory/entity', (req, res) => {
    const { type, name, properties } = req.body;
    if (!type || !name) return res.status(400).json({ error: 'type and name required' });
    memory.addEntity(type, name, properties || {});
    res.json({ status: 'ok' });
});

// POST /memory/insight — Add a tacit knowledge insight externally
app.post('/memory/insight', (req, res) => {
    const { category, insight, confidence } = req.body;
    if (!category || !insight) return res.status(400).json({ error: 'category and insight required' });
    memory.addTacitKnowledge(category, insight, confidence || 0.7);
    res.json({ status: 'ok' });
});

// GET /knowledge — Knowledge base info
app.get('/knowledge', (req, res) => {
    res.json({
        stats: kb.getStats(),
        files: kb.listFiles(),
    });
});

// GET /knowledge/search?q=query — Search the knowledge base
app.get('/knowledge/search', (req, res) => {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'q query parameter required' });
    const results = kb.search(q, parseInt(req.query.limit || '5', 10));
    res.json({ query: q, results });
});

// GET /heartbeat — Heartbeat status
app.get('/heartbeat', (req, res) => {
    res.json(heartbeat.getStatus());
});

// GET /tasks — List RALPH tasks
app.get('/tasks', (req, res) => {
    const status = req.query.status || null;
    res.json({ tasks: ralph.list(status) });
});

// GET /tasks/:id — Get RALPH task detail
app.get('/tasks/:id', (req, res) => {
    const task = ralph.get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json({ task });
});

// GET /ready — Readiness probe
let ready = false;
app.get('/ready', (req, res) => {
    if (ready) {
        res.json({ ready: true });
    } else {
        res.status(503).json({ ready: false, reason: 'initializing' });
    }
});

// ── Start Server ────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
    log('info', `${BOT_NAME} started`, {
        port: PORT,
        slug: INSTANCE_SLUG,
        has_broker: !!process.env.OC_BROKER_URL,
        has_token: !!process.env.OC_CALLBACK_TOKEN,
        memory: memory.getStats(),
        knowledge: kb.getStats(),
    });
    ready = true;

    // Start heartbeat (default: 30 min interval)
    const heartbeatInterval = parseInt(instanceConfig.heartbeat_interval_ms || '1800000', 10);
    heartbeat.start({ intervalMs: heartbeatInterval });
});
