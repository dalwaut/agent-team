/**
 * Session Manager — Reuse Claude CLI sessions within a time window.
 *
 * Uses --resume <sessionId> to continue conversations, avoiding
 * redundant context rebuilding. Sessions expire after 30 min idle.
 * Uses --output-format json to capture session IDs from responses.
 */

const fs = require('fs');
const path = require('path');

const SESSIONS_FILE = path.join(__dirname, 'data', 'sessions.json');
const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

function load() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch {}
  return {};
}

function save(data) {
  const dir = path.dirname(SESSIONS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function getSession(channelId) {
  const sessions = load();
  const s = sessions[channelId];
  if (!s) return null;
  if (Date.now() - s.lastUsed > SESSION_TTL) {
    delete sessions[channelId];
    save(sessions);
    return null;
  }
  return s.sessionId;
}

function updateSession(channelId, sessionId) {
  const sessions = load();
  sessions[channelId] = { sessionId, lastUsed: Date.now() };
  // Prune expired
  for (const ch of Object.keys(sessions)) {
    if (Date.now() - sessions[ch].lastUsed > SESSION_TTL) delete sessions[ch];
  }
  save(sessions);
}

function clearSession(channelId) {
  const sessions = load();
  delete sessions[channelId];
  save(sessions);
}

/** Build CLI args: always json output, resume if session exists */
function getClaudeArgs(channelId) {
  const args = ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits'];
  const sid = getSession(channelId);
  if (sid) args.push('--resume', sid);
  return args;
}

/** Parse JSON response from claude --output-format json */
function parseResponse(stdout) {
  try {
    const data = JSON.parse(stdout.trim());
    return {
      text: data.result || '',
      sessionId: data.session_id || null,
      error: data.is_error || false,
    };
  } catch {
    // Fallback: treat as plain text (happens if claude outputs text format)
    return { text: stdout, sessionId: null, error: false };
  }
}

module.exports = { getSession, updateSession, clearSession, getClaudeArgs, parseResponse };
