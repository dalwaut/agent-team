/**
 * Session Manager — Reuse Claude CLI sessions within a time window.
 *
 * Uses --resume <sessionId> to continue conversations, avoiding
 * redundant context rebuilding. Sessions expire after 30 min idle.
 * Uses --output-format json to capture session IDs from responses.
 *
 * Per-guild isolation: data/guilds/{guildId}/sessions.json
 */

const fs = require('fs');
const path = require('path');
const { ensureGuildDir, getGuildDataDir } = require('./guild-data');

const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

function getSessionsFile(guildId) {
  return path.join(getGuildDataDir(guildId), 'sessions.json');
}

function load(guildId) {
  try {
    const file = getSessionsFile(guildId);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  return {};
}

function save(guildId, data) {
  ensureGuildDir(guildId);
  fs.writeFileSync(getSessionsFile(guildId), JSON.stringify(data, null, 2), 'utf8');
}

function getSession(guildId, channelId) {
  const sessions = load(guildId);
  const s = sessions[channelId];
  if (!s) return null;
  if (Date.now() - s.lastUsed > SESSION_TTL) {
    delete sessions[channelId];
    save(guildId, sessions);
    return null;
  }
  return s.sessionId;
}

function updateSession(guildId, channelId, sessionId) {
  const sessions = load(guildId);
  sessions[channelId] = { sessionId, lastUsed: Date.now() };
  // Prune expired
  for (const ch of Object.keys(sessions)) {
    if (Date.now() - sessions[ch].lastUsed > SESSION_TTL) delete sessions[ch];
  }
  save(guildId, sessions);
}

function clearSession(guildId, channelId) {
  const sessions = load(guildId);
  delete sessions[channelId];
  save(guildId, sessions);
}

// Build CLI args: always json output, resume if session exists.
// @param {string} guildId
// @param {string} channelId
// @param {object} [opts]
// @param {string} [opts.mcpConfigPath] - Path to MCP config JSON file
// @param {string} [opts.systemPrompt] - Override system prompt
// @param {boolean} [opts.restrictTools] - Disable all built-in tools (Bash, Read, Write, etc.)
function getClaudeArgs(guildId, channelId, opts) {
  const args = ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits'];
  if (opts && opts.mcpConfigPath) {
    args.push('--mcp-config', opts.mcpConfigPath);
  }
  if (opts && opts.systemPrompt) {
    args.push('--system-prompt', opts.systemPrompt);
  }
  if (opts && opts.restrictTools) {
    // Disable all built-in tools — only MCP tools (Team Hub) remain available
    args.push('--allowedTools', 'mcp__teamhub__*');
  }
  const sid = getSession(guildId, channelId);
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
