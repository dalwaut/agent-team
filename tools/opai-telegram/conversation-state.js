/**
 * Conversation State Manager — Tiered memory with intelligent context injection.
 *
 * Replaces both session-manager.js and conversation-memory.js with a single
 * state machine that decides WHAT context to inject and WHEN to use --resume.
 *
 * States:
 *   NEW     — First message ever in this scope. No context, fresh session.
 *   ACTIVE  — Messages within 5 min. Claude --resume has full context.
 *             Inject NOTHING — zero wasted tokens.
 *   IDLE    — 5min-2hr gap. Inject last 3 messages as a thin recap + --resume.
 *   COLD    — 2hr+ gap. Inject digest summary + last exchange + --resume.
 *   EXPIRED — 7d+ gap. Inject digest if available, fresh session.
 *
 * Scope key: chatId:threadId:userId (per-conversation isolation)
 */

const fs = require('fs');
const path = require('path');

// --- Thresholds ---
const ACTIVE_MAX_GAP  = 5 * 60 * 1000;           // 5 minutes
const IDLE_MAX_GAP    = 2 * 60 * 60 * 1000;      // 2 hours
const SESSION_TTL     = 7 * 24 * 60 * 60 * 1000; // 7 days

const MAX_RECENT       = 10;   // ring buffer size
const BOT_TRIM         = 300;  // chars to keep for assistant messages in buffer
const MAX_DIGEST_LEN   = 800;  // max digest length

const SCOPES_DIR = path.join(__dirname, 'data', 'scopes');

function ensureDir() {
  if (!fs.existsSync(SCOPES_DIR)) fs.mkdirSync(SCOPES_DIR, { recursive: true });
}

function scopeFile(scopeKey) {
  return path.join(SCOPES_DIR, `${scopeKey.replace(/:/g, '-')}.json`);
}

function loadScope(scopeKey) {
  try {
    const file = scopeFile(scopeKey);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}

  // Try migrating from old session-manager format
  return migrateOldData(scopeKey);
}

function saveScope(scopeKey, data) {
  ensureDir();
  fs.writeFileSync(scopeFile(scopeKey), JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Migrate from old session-manager + conversation-memory files.
 */
function migrateOldData(scopeKey) {
  const safeName = scopeKey.replace(/:/g, '-');
  const empty = { recentMessages: [], messageCount: 0 };

  // Try old session file
  try {
    const oldSession = path.join(__dirname, 'data', 'sessions', `${safeName}.json`);
    if (fs.existsSync(oldSession)) {
      const old = JSON.parse(fs.readFileSync(oldSession, 'utf8'));
      return {
        ...empty,
        sessionId: old.sessionId || null,
        lastActivity: old.lastUsed || null,
        createdAt: old.lastUsed || Date.now(),
        topic: old.topic || null,
        messageCount: old.messageCount || 0,
      };
    }
  } catch {}

  return empty;
}

// --- State Machine ---

function computeState(lastActivity) {
  if (!lastActivity) return 'NEW';
  const gap = Date.now() - lastActivity;
  if (gap <= ACTIVE_MAX_GAP)  return 'ACTIVE';
  if (gap <= IDLE_MAX_GAP)    return 'IDLE';
  if (gap <= SESSION_TTL)     return 'COLD';
  return 'EXPIRED';
}

// --- Context Strategy ---

/**
 * Determine what context to inject and whether to use --resume.
 * This is the core intelligence of the system.
 *
 * @param {string} scopeKey
 * @returns {{ contextBlock: string, useResume: boolean, sessionId: string|null, state: string }}
 */
function getContextStrategy(scopeKey) {
  const data = loadScope(scopeKey);
  const state = computeState(data.lastActivity);

  // Lazy digest generation on IDLE/COLD
  if ((state === 'IDLE' || state === 'COLD') && data.recentMessages?.length > 2) {
    const newestMsg = data.recentMessages[data.recentMessages.length - 1]?.timestamp || 0;
    if (!data.digest || (data.digestGeneratedAt || 0) < newestMsg) {
      data.digest = generateDigest(data.recentMessages, data.topic);
      data.digestGeneratedAt = Date.now();
      saveScope(scopeKey, data);
    }
  }

  switch (state) {

    case 'NEW':
      return { contextBlock: '', useResume: false, sessionId: null, state };

    case 'ACTIVE':
      // Claude's --resume has full context. Inject NOTHING.
      return {
        contextBlock: '',
        useResume: true,
        sessionId: data.sessionId,
        state,
      };

    case 'IDLE': {
      // Thin recap: last 3 messages
      const recent = data.recentMessages || [];
      const tail = recent.slice(-3);
      let block = '';
      if (tail.length > 0) {
        const lines = tail.map(m => {
          const who = m.role === 'user' ? m.username : 'OPAI Bot';
          return `[${formatAgo(Date.now() - m.timestamp)}] ${who}: ${m.content}`;
        });
        block = '--- Quick recap ---\n' + lines.join('\n') + '\n--- End recap ---';
      }
      return {
        contextBlock: block,
        useResume: true,
        sessionId: data.sessionId,
        state,
      };
    }

    case 'COLD': {
      // Digest + last exchange
      const parts = [];
      if (data.digest) {
        parts.push(
          `--- Conversation summary (${formatAgo(Date.now() - (data.digestGeneratedAt || data.lastActivity))}) ---`,
          data.digest,
          '--- End summary ---'
        );
      }
      const recent = data.recentMessages || [];
      if (recent.length > 0) {
        const last = recent[recent.length - 1];
        const who = last.role === 'user' ? last.username : 'OPAI Bot';
        parts.push(`\nLast message (${formatAgo(Date.now() - last.timestamp)}): ${who}: ${last.content}`);
      }
      return {
        contextBlock: parts.join('\n'),
        useResume: true,
        sessionId: data.sessionId,
        state,
      };
    }

    case 'EXPIRED': {
      // Digest only, fresh session
      let block = '';
      if (data.digest) {
        block = `--- Previous conversation summary ---\n${data.digest}\n--- End summary ---`;
      }
      return {
        contextBlock: block,
        useResume: false,
        sessionId: null,
        state,
      };
    }

    default:
      return { contextBlock: '', useResume: false, sessionId: null, state: 'NEW' };
  }
}

// --- Message Recording ---

/**
 * Record a message into the scope's ring buffer.
 * @param {string} scopeKey
 * @param {'user'|'assistant'} role
 * @param {string} username
 * @param {string} content
 */
function recordMessage(scopeKey, role, username, content) {
  const data = loadScope(scopeKey);
  if (!data.recentMessages) data.recentMessages = [];

  const trimmed = role === 'assistant' ? truncate(content, BOT_TRIM) : content;

  data.recentMessages.push({
    role,
    username: role === 'user' ? username : 'OPAI Bot',
    content: trimmed,
    timestamp: Date.now(),
  });

  // Enforce ring buffer — when messages roll off, update digest
  if (data.recentMessages.length > MAX_RECENT) {
    const dropping = data.recentMessages.slice(0, data.recentMessages.length - MAX_RECENT);
    data.recentMessages = data.recentMessages.slice(-MAX_RECENT);

    // Regenerate digest from all available messages
    data.digest = generateDigest([...dropping, ...data.recentMessages], data.topic);
    data.digestGeneratedAt = Date.now();
  }

  data.lastActivity = Date.now();
  data.messageCount = (data.messageCount || 0) + 1;
  if (!data.createdAt) data.createdAt = Date.now();

  saveScope(scopeKey, data);
}

// --- Session Lifecycle ---

function updateSessionId(scopeKey, sessionId) {
  const data = loadScope(scopeKey);
  data.sessionId = sessionId;
  data.lastActivity = Date.now();
  saveScope(scopeKey, data);
}

function clearScope(scopeKey) {
  try { fs.unlinkSync(scopeFile(scopeKey)); } catch {}
}

// --- Metadata ---

function getScopeData(scopeKey) {
  const data = loadScope(scopeKey);
  if (!data.lastActivity) return null;
  return {
    ...data,
    state: computeState(data.lastActivity),
  };
}

function setScopeTopic(scopeKey, topic) {
  const data = loadScope(scopeKey);
  data.topic = topic;
  saveScope(scopeKey, data);
}

function listActiveScopes() {
  ensureDir();
  const scopes = [];
  try {
    const files = fs.readdirSync(SCOPES_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(SCOPES_DIR, file), 'utf8'));
        if (data.lastActivity) {
          const state = computeState(data.lastActivity);
          if (state !== 'EXPIRED') {
            scopes.push({
              scopeKey: file.replace('.json', '').replace(/-/g, ':'),
              sessionId: data.sessionId,
              topic: data.topic || null,
              lastActivity: data.lastActivity,
              createdAt: data.createdAt,
              messageCount: data.messageCount || 0,
              state,
            });
          }
        }
      } catch {}
    }
  } catch {}
  return scopes.sort((a, b) => b.lastActivity - a.lastActivity);
}

function buildScopeKey(chatId, threadId, userId) {
  return `${chatId}:${threadId || 'general'}:${userId}`;
}

// --- Digest Generator (no AI calls) ---

function generateDigest(messages, topic) {
  if (!messages || messages.length === 0) return null;

  const lines = [];
  let totalLen = 0;

  // Topic header
  if (topic) {
    const line = `Topic: ${topic}`;
    lines.push(line);
    totalLen += line.length;
  }

  // First user message sets the context
  const firstUser = messages.find(m => m.role === 'user');
  if (firstUser) {
    const line = `Started with: "${truncate(firstUser.content, 120)}"`;
    lines.push(line);
    totalLen += line.length;
  }

  // Walk through picking key exchanges
  for (let i = 1; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === 'user') {
      // Pick topic shifts: questions, long messages, gaps > 2 min
      const prev = messages[i - 1];
      const gap = msg.timestamp - prev.timestamp;
      const isQuestion = msg.content.includes('?');
      const isSubstantial = msg.content.length > 80;

      if (isQuestion || gap > 120000 || isSubstantial) {
        const line = `Asked: "${truncate(msg.content, 100)}"`;
        if (totalLen + line.length > MAX_DIGEST_LEN) break;
        lines.push(line);
        totalLen += line.length;
      }
    } else if (msg.role === 'assistant') {
      // Extract first meaningful sentence from bot responses
      const firstSentence = msg.content.split(/[.!?\n]/)[0]?.trim();
      if (firstSentence && firstSentence.length > 15) {
        const line = `Answered: ${truncate(firstSentence, 80)}`;
        if (totalLen + line.length > MAX_DIGEST_LEN) break;
        lines.push(line);
        totalLen += line.length;
      }
    }
  }

  // Footer
  const span = messages[messages.length - 1].timestamp - messages[0].timestamp;
  lines.push(`(${messages.length} messages over ${formatDuration(span)})`);

  return lines.join('\n');
}

// --- Formatting Helpers ---

function truncate(str, max) {
  if (!str) return '';
  if (str.length <= max) return str;
  return str.substring(0, max - 3) + '...';
}

function formatAgo(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * Get the N most recent messages from a scope's ring buffer.
 * Used to always inject recent topic context into prompts.
 *
 * @param {string} scopeKey
 * @param {number} count - Number of messages to retrieve (default 5)
 * @returns {Array<{role: string, username: string, content: string, timestamp: number}>}
 */
function getRecentMessages(scopeKey, count = 5) {
  const data = loadScope(scopeKey);
  const msgs = data.recentMessages || [];
  return msgs.slice(-count);
}

/**
 * Format recent messages as a concise context block for prompt injection.
 *
 * @param {string} scopeKey
 * @param {number} count - Number of messages to include (default 5)
 * @returns {string} Formatted context block (empty string if no messages)
 */
function formatRecentContext(scopeKey, count = 5) {
  const msgs = getRecentMessages(scopeKey, count);
  if (msgs.length === 0) return '';

  const lines = msgs.map(m => {
    const who = m.role === 'user' ? m.username : 'OP';
    const ago = formatAgo(Date.now() - m.timestamp);
    return `[${ago}] ${who}: ${m.content}`;
  });

  return '--- Recent messages ---\n' + lines.join('\n') + '\n--- End recent ---';
}

module.exports = {
  getContextStrategy,
  recordMessage,
  updateSessionId,
  clearScope,
  getScopeData,
  setScopeTopic,
  listActiveScopes,
  buildScopeKey,
  computeState,
  getRecentMessages,
  formatRecentContext,
};
