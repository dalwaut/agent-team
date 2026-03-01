/**
 * ARL Conversation Tracker — manage active reply windows
 *
 * Tracks in-memory conversations with 5-minute TTL.
 * When a whitelisted sender replies within the window, ARL re-triggers immediately.
 * Used by the main loop to decide fast-poll vs normal interval.
 */

const fs = require('fs');
const path = require('path');

const SKILLS_PATH = path.join(__dirname, 'arl-skills.json');
const ARL_LOG_PATH = path.join(__dirname, 'data', 'arl-log.json');

// In-memory conversation map: senderAddress → { threadId, lastActivity, account, email, context }
const activeConversations = new Map();

function loadSkillsConfig() {
  try { return JSON.parse(fs.readFileSync(SKILLS_PATH, 'utf8')); }
  catch { return { replyWindowMinutes: 5, fastPollSeconds: 30 }; }
}

/**
 * Start or refresh a conversation for a sender.
 */
function startConversation(senderAddress, data) {
  activeConversations.set(senderAddress.toLowerCase(), {
    threadId: data.threadId || data.messageId || `thread-${Date.now()}`,
    lastActivity: Date.now(),
    account: data.account,
    originalEmail: data.email,
    context: data.context || {},
    skillResults: data.skillResults || [],
    turns: (getConversation(senderAddress)?.turns || 0) + 1,
  });
}

/**
 * Get active conversation for a sender (null if expired or absent).
 */
function getConversation(senderAddress) {
  const key = senderAddress.toLowerCase();
  const conv = activeConversations.get(key);
  if (!conv) return null;

  const config = loadSkillsConfig();
  const windowMs = (config.replyWindowMinutes || 5) * 60 * 1000;

  if (Date.now() - conv.lastActivity > windowMs) {
    activeConversations.delete(key);
    return null;
  }
  return conv;
}

/**
 * Check if a sender has an active (non-expired) conversation.
 */
function isActiveConversation(senderAddress) {
  return getConversation(senderAddress) !== null;
}

/**
 * Close a conversation explicitly (e.g., sender says "thanks" or "done").
 */
function endConversation(senderAddress) {
  activeConversations.delete(senderAddress.toLowerCase());
}

/**
 * Are there ANY active conversations? Used to decide fast-poll mode.
 */
function hasActiveConversations() {
  // Prune expired entries while checking
  const config = loadSkillsConfig();
  const windowMs = (config.replyWindowMinutes || 5) * 60 * 1000;
  const now = Date.now();

  for (const [key, conv] of activeConversations) {
    if (now - conv.lastActivity > windowMs) {
      activeConversations.delete(key);
    }
  }
  return activeConversations.size > 0;
}

/**
 * Get all active conversations (for TUI/API display).
 */
function listActiveConversations() {
  const config = loadSkillsConfig();
  const windowMs = (config.replyWindowMinutes || 5) * 60 * 1000;
  const now = Date.now();
  const result = [];

  for (const [sender, conv] of activeConversations) {
    const remaining = windowMs - (now - conv.lastActivity);
    if (remaining <= 0) {
      activeConversations.delete(sender);
      continue;
    }
    result.push({
      sender,
      threadId: conv.threadId,
      turns: conv.turns,
      lastActivity: new Date(conv.lastActivity).toISOString(),
      remainingSeconds: Math.ceil(remaining / 1000),
      accountEmail: conv.account?.email || 'unknown',
    });
  }
  return result;
}

// ── ARL Activity Log (persistent) ────────────────────────

function loadArlLog() {
  try { return JSON.parse(fs.readFileSync(ARL_LOG_PATH, 'utf8')); }
  catch { return { entries: [] }; }
}

function saveArlLog(data) {
  fs.mkdirSync(path.dirname(ARL_LOG_PATH), { recursive: true });
  if (data.entries.length > 200) data.entries = data.entries.slice(-200);
  fs.writeFileSync(ARL_LOG_PATH, JSON.stringify(data, null, 2));
}

/**
 * Log an ARL execution (persistent, survives restarts).
 */
function logArlExecution(entry) {
  const data = loadArlLog();
  data.entries.push({
    id: `arl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    ...entry,
  });
  saveArlLog(data);
}

/**
 * Get recent ARL executions for TUI/API display.
 */
function getArlHistory(limit = 50) {
  const data = loadArlLog();
  return data.entries.slice(-limit).reverse();
}

module.exports = {
  startConversation,
  getConversation,
  isActiveConversation,
  endConversation,
  hasActiveConversations,
  listActiveConversations,
  logArlExecution,
  getArlHistory,
};
