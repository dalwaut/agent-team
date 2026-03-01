/**
 * Conversation Memory Module
 *
 * Persists recent Discord conversation history to disk so Claude Code
 * has context of what was discussed. Messages older than 2 hours are
 * automatically pruned on every read/write cycle.
 *
 * Storage: data/guilds/{guildId}/conversations.json (per-guild isolation)
 */

const fs = require('fs');
const path = require('path');
const { ensureGuildDir, getGuildDataDir } = require('./guild-data');

const MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_CONTEXT_MESSAGES = 20; // cap injected into prompt to avoid bloat

function getMemoryFile(guildId) {
  return path.join(getGuildDataDir(guildId), 'conversations.json');
}

function loadMemory(guildId) {
  ensureGuildDir(guildId);
  const file = getMemoryFile(guildId);
  if (!fs.existsSync(file)) return {};
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    return pruneAll(data);
  } catch {
    return {};
  }
}

function saveMemory(guildId, data) {
  ensureGuildDir(guildId);
  fs.writeFileSync(getMemoryFile(guildId), JSON.stringify(data, null, 2), 'utf8');
}

function pruneAll(data) {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const channelId of Object.keys(data)) {
    data[channelId] = data[channelId].filter((m) => m.timestamp > cutoff);
    if (data[channelId].length === 0) delete data[channelId];
  }
  return data;
}

function addUserMessage(guildId, channelId, username, content) {
  const data = loadMemory(guildId);
  if (!data[channelId]) data[channelId] = [];
  data[channelId].push({ role: 'user', username, content, timestamp: Date.now() });
  saveMemory(guildId, data);
}

function addBotMessage(guildId, channelId, content) {
  const data = loadMemory(guildId);
  if (!data[channelId]) data[channelId] = [];
  data[channelId].push({ role: 'assistant', username: 'OPAI Bot', content, timestamp: Date.now() });
  saveMemory(guildId, data);
}

function getContextBlock(guildId, channelId) {
  const data = loadMemory(guildId);
  const messages = data[channelId] || [];
  if (messages.length === 0) return '';

  const recent = messages.slice(-MAX_CONTEXT_MESSAGES);
  const lines = recent.map((m) => {
    const ago = formatAgo(Date.now() - m.timestamp);
    if (m.role === 'user') return `[${ago}] ${m.username}: ${m.content}`;
    return `[${ago}] OPAI Bot: ${m.content}`;
  });

  return [
    '--- Recent conversation history (last 2 hours) ---',
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
  return `${hours}h${remainMin}m ago`;
}

module.exports = { addUserMessage, addBotMessage, getContextBlock, loadMemory };
