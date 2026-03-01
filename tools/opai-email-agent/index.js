/**
 * OPAI Email Agent — Entry Point
 *
 * Starts the agent check loop (setInterval) + audit server.
 * The agent checks email on a configurable interval and processes
 * through the pipeline: fetch → gate → classify → mode-check → act → log.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');

// Prevent EPIPE / socket errors from crashing the process (e.g. dropped IMAP connections)
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEOUT') {
    console.error('[EMAIL-AGENT] Transient socket error (ignored):', err.code, err.message);
    return;
  }
  // Re-throw non-transient errors
  console.error('[EMAIL-AGENT] Uncaught exception:', err);
  process.exit(1);
});
const { createAuditServer, broadcastSSE } = require('./audit-server');
const { runCycle, hasActiveConversations } = require('./agent-core');
const { getSettings, isKilled } = require('./mode-engine');
const { logAction } = require('./action-logger');
const { logAudit } = require('../shared/audit');

const PORT = parseInt(process.env.PORT || '8093', 10);

// ── Agent Loop ───────────────────────────────────────────

let checkInterval = null;
let fastPollInterval = null;

const agentRef = {
  start() {
    if (checkInterval) return;
    const settings = getSettings();
    const intervalMs = (settings.checkIntervalMinutes || 5) * 60 * 1000;

    console.log(`[EMAIL-AGENT] Starting agent loop (every ${settings.checkIntervalMinutes}m)`);
    logAction({
      action: 'resume',
      reasoning: `Agent loop started. Mode: ${settings.mode}, interval: ${settings.checkIntervalMinutes}m`,
      mode: settings.mode,
    });

    // Run immediately on start
    runCycle()
      .then(r => broadcastSSE('cycle', r))
      .catch(err => console.error('[EMAIL-AGENT] Cycle error:', err.message));

    checkInterval = setInterval(async () => {
      if (isKilled()) {
        console.log('[EMAIL-AGENT] Agent is killed — skipping scheduled cycle');
        return;
      }
      try {
        const result = await runCycle();
        broadcastSSE('cycle', result);
      } catch (err) {
        console.error('[EMAIL-AGENT] Scheduled cycle error:', err.message);
      }
    }, intervalMs);

    // Start ARL fast-poll watcher (checks every 10s if fast-poll is needed)
    agentRef._startFastPollWatcher();
  },

  stop() {
    if (checkInterval) {
      clearInterval(checkInterval);
      checkInterval = null;
      console.log('[EMAIL-AGENT] Agent loop stopped');
    }
    if (fastPollInterval) {
      clearInterval(fastPollInterval);
      fastPollInterval = null;
    }
  },

  restart() {
    agentRef.stop();
    agentRef.start();
  },

  // ARL fast-poll: when conversations are active, check email every 30s
  _fastPollActive: false,
  _fastPollTimer: null,

  _startFastPollWatcher() {
    // Check every 10s if we need fast-poll mode
    fastPollInterval = setInterval(() => {
      const needsFastPoll = hasActiveConversations();

      if (needsFastPoll && !agentRef._fastPollActive) {
        // Enter fast-poll mode
        agentRef._fastPollActive = true;
        const fastPollMs = 30 * 1000; // 30 seconds
        console.log('[EMAIL-AGENT] [ARL] Entering fast-poll mode (30s interval)');

        agentRef._fastPollTimer = setInterval(async () => {
          if (isKilled() || !hasActiveConversations()) return;
          try {
            const result = await runCycle();
            broadcastSSE('cycle', result);
          } catch (err) {
            console.error('[EMAIL-AGENT] [ARL] Fast-poll cycle error:', err.message);
          }
        }, fastPollMs);

      } else if (!needsFastPoll && agentRef._fastPollActive) {
        // Exit fast-poll mode
        agentRef._fastPollActive = false;
        if (agentRef._fastPollTimer) {
          clearInterval(agentRef._fastPollTimer);
          agentRef._fastPollTimer = null;
        }
        console.log('[EMAIL-AGENT] [ARL] Exiting fast-poll mode (no active conversations)');
      }
    }, 10000);
  },
};

// ── Initialize data directory ────────────────────────────

const dataDir = path.join(__dirname, 'data');
const logsDir = path.join(dataDir, 'logs');
fs.mkdirSync(logsDir, { recursive: true });

// Initialize empty data files if they don't exist
const dataFiles = {
  'action-log.json': { entries: [], date: new Date().toISOString().split('T')[0] },
  'agent-state.json': { killed: false, autoSendsThisHour: 0, hourStart: null, lastCheck: null },
  'feedback.json': { rules: [], corrections: [] },
  'approval-queue.json': { items: [] },
  'processed.json': { entries: [] },
};

for (const [file, defaultContent] of Object.entries(dataFiles)) {
  const filePath = path.join(dataDir, file);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultContent, null, 2));
  }
}

// ── Start ────────────────────────────────────────────────

const app = createAuditServer(agentRef);

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[EMAIL-AGENT] Audit server listening on 127.0.0.1:${PORT}`);
  console.log(`[EMAIL-AGENT] UI: http://127.0.0.1:${PORT}/`);
  try { logAudit({ tier: 'health', service: 'opai-email-agent', event: 'agent-started', status: 'completed', summary: 'Email agent started' }); } catch (_) {}

  // Start the agent loop (unless killed)
  // Multi-account: each account resolves its own credentials.
  // The cycle will skip accounts without valid creds automatically.
  if (!isKilled()) {
    agentRef.start();
  } else {
    console.log('[EMAIL-AGENT] Agent was previously killed — not starting loop. Use resume to restart.');
  }
});
