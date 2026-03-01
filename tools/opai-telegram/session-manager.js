/**
 * Session Manager — Claude CLI session reuse for Telegram conversations.
 *
 * Uses --resume <sessionId> to continue conversations. Claude CLI sessions
 * persist on disk indefinitely — this manager just tracks the mapping from
 * scope key to session ID. Long TTL so conversations survive across days.
 *
 * Key: chatId:threadId:userId (full conversation isolation)
 *
 * Each scope gets its own Claude session, so you can have:
 *   - DM: one ongoing conversation with full OPAI access
 *   - Forum Topic "HELM": separate session about HELM development
 *   - Forum Topic "Mobile App": separate session about mobile work
 *   - Forum Topic "TeamHub": scoped to a workspace
 * All running in parallel, each remembering their own context.
 */

const fs = require('fs');
const path = require('path');

const SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days — Claude sessions persist on disk
const SESSIONS_DIR = path.join(__dirname, 'data', 'sessions');

function ensureDir() {
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function getSessionFile(scopeKey) {
  const safe = scopeKey.replace(/:/g, '-');
  return path.join(SESSIONS_DIR, `${safe}.json`);
}

function load(scopeKey) {
  try {
    const file = getSessionFile(scopeKey);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  return {};
}

function save(scopeKey, data) {
  ensureDir();
  fs.writeFileSync(getSessionFile(scopeKey), JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Get session ID for a conversation scope.
 * @param {string} scopeKey - "chatId:threadId:userId"
 * @returns {string|null} Claude session ID or null
 */
function getSession(scopeKey) {
  const data = load(scopeKey);
  if (!data.sessionId) return null;
  if (Date.now() - data.lastUsed > SESSION_TTL) {
    try { fs.unlinkSync(getSessionFile(scopeKey)); } catch {}
    return null;
  }
  return data.sessionId;
}

/**
 * Get full session data (including label/topic).
 * @param {string} scopeKey
 * @returns {object|null}
 */
function getSessionData(scopeKey) {
  const data = load(scopeKey);
  if (!data.sessionId) return null;
  if (Date.now() - data.lastUsed > SESSION_TTL) {
    try { fs.unlinkSync(getSessionFile(scopeKey)); } catch {}
    return null;
  }
  return data;
}

/**
 * Update session after a Claude response.
 * @param {string} scopeKey
 * @param {string} sessionId
 * @param {object} [opts]
 * @param {string} [opts.topic] - Conversation topic/label
 */
function updateSession(scopeKey, sessionId, opts = {}) {
  const existing = load(scopeKey);
  save(scopeKey, {
    sessionId,
    lastUsed: Date.now(),
    createdAt: existing.createdAt || Date.now(),
    topic: opts.topic || existing.topic || null,
    messageCount: (existing.messageCount || 0) + 1,
  });
}

/**
 * Set the topic/label for a session.
 * @param {string} scopeKey
 * @param {string} topic
 */
function setSessionTopic(scopeKey, topic) {
  const data = load(scopeKey);
  if (data.sessionId) {
    data.topic = topic;
    save(scopeKey, data);
  }
}

/**
 * Clear a session (e.g., on /reset command).
 * @param {string} scopeKey
 */
function clearSession(scopeKey) {
  try { fs.unlinkSync(getSessionFile(scopeKey)); } catch {}
}

/**
 * List all active sessions (for /sessions command).
 * @returns {Array<{scopeKey: string, sessionId: string, topic: string, lastUsed: number, messageCount: number}>}
 */
function listSessions() {
  ensureDir();
  const sessions = [];
  try {
    const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
        if (data.sessionId && (Date.now() - data.lastUsed) < SESSION_TTL) {
          const scopeKey = file.replace('.json', '').replace(/-/g, ':');
          sessions.push({
            scopeKey,
            sessionId: data.sessionId,
            topic: data.topic || null,
            lastUsed: data.lastUsed,
            createdAt: data.createdAt,
            messageCount: data.messageCount || 0,
          });
        }
      } catch {}
    }
  } catch {}
  return sessions.sort((a, b) => b.lastUsed - a.lastUsed);
}

/**
 * Build a scope key from Telegram context.
 * @param {number} chatId
 * @param {number|string} threadId - message_thread_id or 'general'
 * @param {number} userId
 * @returns {string}
 */
function buildScopeKey(chatId, threadId, userId) {
  return `${chatId}:${threadId || 'general'}:${userId}`;
}

module.exports = {
  getSession, getSessionData, updateSession, setSessionTopic,
  clearSession, listSessions, buildScopeKey,
};
