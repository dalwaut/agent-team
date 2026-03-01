/**
 * Conversation Memory — Per-scope message history for context injection.
 *
 * Persists recent conversation so Claude has local context even if the
 * CLI session expires. With --resume keeping full Claude context, this
 * serves as a backup summary and as the "what happened recently" block
 * injected into the system prompt.
 *
 * 48-hour window, last 50 messages per scope.
 * Scope key: chatId:threadId:userId (matches session-manager)
 */

const fs = require('fs');
const path = require('path');

const MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours
const MAX_CONTEXT_MESSAGES = 50;
const MEMORY_DIR = path.join(__dirname, 'data', 'memory');

function ensureDir() {
  if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

function getMemFile(scopeKey) {
  const safe = scopeKey.replace(/:/g, '-');
  return path.join(MEMORY_DIR, `${safe}.json`);
}

function loadScope(scopeKey) {
  try {
    const file = getMemFile(scopeKey);
    if (fs.existsSync(file)) {
      const messages = JSON.parse(fs.readFileSync(file, 'utf8'));
      return prune(messages);
    }
  } catch {}
  return [];
}

function saveScope(scopeKey, messages) {
  ensureDir();
  fs.writeFileSync(getMemFile(scopeKey), JSON.stringify(messages, null, 2), 'utf8');
}

function prune(messages) {
  const cutoff = Date.now() - MAX_AGE_MS;
  return messages.filter(m => m.timestamp > cutoff).slice(-MAX_CONTEXT_MESSAGES);
}

function addUserMessage(scopeKey, username, content) {
  const messages = loadScope(scopeKey);
  messages.push({ role: 'user', username, content, timestamp: Date.now() });
  saveScope(scopeKey, prune(messages));
}

function addBotMessage(scopeKey, content) {
  const messages = loadScope(scopeKey);
  messages.push({ role: 'assistant', username: 'OPAI Bot', content, timestamp: Date.now() });
  saveScope(scopeKey, prune(messages));
}

function getContextBlock(scopeKey) {
  const messages = loadScope(scopeKey);
  if (messages.length === 0) return '';

  const recent = messages.slice(-MAX_CONTEXT_MESSAGES);
  const lines = recent.map(m => {
    const ago = formatAgo(Date.now() - m.timestamp);
    if (m.role === 'user') return `[${ago}] ${m.username}: ${m.content}`;
    return `[${ago}] OPAI Bot: ${m.content}`;
  });

  return [
    '--- Recent conversation history (last 48 hours) ---',
    ...lines,
    '--- End of history ---',
  ].join('\n');
}

function formatAgo(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  if (hours < 24) return `${hours}h${remainMin}m ago`;
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return `${days}d${remainHours}h ago`;
}

module.exports = { addUserMessage, addBotMessage, getContextBlock };
