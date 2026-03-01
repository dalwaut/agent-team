/**
 * Heartbeat — Proactive check-in system for ClawBot.
 *
 * Felix technique: Instead of waiting for messages, the bot periodically
 * "checks in" — reviewing memory for pending tasks, follow-ups, and
 * time-sensitive items.
 *
 * The heartbeat runs on a configurable interval (default: every 30 minutes)
 * and can trigger proactive outreach via the broker callback.
 *
 * Usage:
 *   const heartbeat = require('./lib/heartbeat');
 *   heartbeat.start({ intervalMs: 30 * 60 * 1000 });
 *   heartbeat.stop();
 */

const memory = require('./memory');

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const INSTANCE_SLUG = process.env.INSTANCE_SLUG || 'unknown';

let _timer = null;
let _running = false;
let _lastBeat = null;
let _beatCount = 0;
let _callbacks = [];

function log(level, msg, data) {
    if (level === 'debug' && LOG_LEVEL !== 'debug') return;
    console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level,
        instance: INSTANCE_SLUG,
        msg: `[heartbeat] ${msg}`,
        ...(data || {}),
    }));
}

/**
 * Register a callback to be invoked on each heartbeat tick.
 * @param {function} fn - Async function(context) called on each beat
 */
function onBeat(fn) {
    _callbacks.push(fn);
}

/**
 * Start the heartbeat loop.
 * @param {object} opts
 * @param {number} [opts.intervalMs=1800000] - Heartbeat interval (default 30 min)
 */
function start(opts = {}) {
    if (_running) return;

    const intervalMs = opts.intervalMs || 30 * 60 * 1000;
    _running = true;

    log('info', 'Heartbeat started', { interval_ms: intervalMs });

    _timer = setInterval(async () => {
        await _tick();
    }, intervalMs);

    // First beat after a short delay (let server fully initialize)
    setTimeout(() => _tick(), 5000);
}

/**
 * Stop the heartbeat loop.
 */
function stop() {
    if (_timer) {
        clearInterval(_timer);
        _timer = null;
    }
    _running = false;
    log('info', 'Heartbeat stopped');
}

/**
 * Execute a single heartbeat tick.
 */
async function _tick() {
    _beatCount++;
    _lastBeat = new Date().toISOString();

    const context = _buildBeatContext();

    log('debug', 'Heartbeat tick', {
        beat: _beatCount,
        pending_items: context.pendingItems.length,
    });

    // Run registered callbacks
    for (const fn of _callbacks) {
        try {
            await fn(context);
        } catch (err) {
            log('error', 'Heartbeat callback failed', { error: err.message });
        }
    }

    // Log the heartbeat as a daily note
    if (context.pendingItems.length > 0) {
        memory.addDailyNote(
            `Heartbeat #${_beatCount}: ${context.pendingItems.length} pending items found`,
            ['heartbeat', 'system']
        );
    }
}

/**
 * Build context for the heartbeat — scan memory for actionable items.
 */
function _buildBeatContext() {
    const recentNotes = memory.getDailyNotes(null, 3);
    const insights = memory.getStrongInsights(0.7);

    // Look for pending/follow-up items in recent notes
    const pendingItems = [];
    for (const [date, notes] of Object.entries(recentNotes)) {
        for (const note of notes) {
            const text = note.text.toLowerCase();
            if (
                text.includes('follow up') ||
                text.includes('pending') ||
                text.includes('reminder') ||
                text.includes('todo') ||
                text.includes('deadline') ||
                text.includes('by tomorrow') ||
                text.includes('by end of')
            ) {
                pendingItems.push({ date, text: note.text, tags: note.tags });
            }
        }
    }

    return {
        beatNumber: _beatCount,
        timestamp: _lastBeat,
        pendingItems,
        recentNoteDays: Object.keys(recentNotes).length,
        insightCount: insights.length,
        memoryStats: memory.getStats(),
    };
}

/**
 * Get heartbeat status.
 */
function getStatus() {
    return {
        running: _running,
        last_beat: _lastBeat,
        beat_count: _beatCount,
        callbacks: _callbacks.length,
    };
}

module.exports = { start, stop, onBeat, getStatus };
