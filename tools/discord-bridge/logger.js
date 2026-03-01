/**
 * Logger Module — Tees console output to data/bot.log
 * Rotates at 500KB. Provides getRecentLogs() for the review command.
 *
 * Guild-scoped logging: logGuild() writes to data/guilds/{guildId}/bot.log
 */

const fs = require('fs');
const path = require('path');
const { ensureGuildDir, getGuildDataDir } = require('./guild-data');

const DATA_DIR = path.join(__dirname, 'data');
const LOG_FILE = path.join(DATA_DIR, 'bot.log');
const MAX_SIZE = 500 * 1024; // 500KB
const GUILD_MAX_SIZE = 200 * 1024; // 200KB per guild log

function initLogger() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // Rotate if oversized
  if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_SIZE) {
    const old = LOG_FILE + '.old';
    try { if (fs.existsSync(old)) fs.unlinkSync(old); } catch {}
    try { fs.renameSync(LOG_FILE, old); } catch {}
  }

  const origLog = console.log;
  const origError = console.error;

  function append(level, args) {
    const ts = new Date().toISOString();
    const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    try { fs.appendFileSync(LOG_FILE, `[${ts}] [${level}] ${msg}\n`); } catch {}
  }

  console.log = (...args) => { origLog.apply(console, args); append('INFO', args); };
  console.error = (...args) => { origError.apply(console, args); append('ERROR', args); };
}

/** Log a message to a guild-specific log file. */
function logGuild(guildId, level, msg) {
  ensureGuildDir(guildId);
  const guildLog = path.join(getGuildDataDir(guildId), 'bot.log');

  // Rotate guild log if oversized
  if (fs.existsSync(guildLog) && fs.statSync(guildLog).size > GUILD_MAX_SIZE) {
    const old = guildLog + '.old';
    try { if (fs.existsSync(old)) fs.unlinkSync(old); } catch {}
    try { fs.renameSync(guildLog, old); } catch {}
  }

  const ts = new Date().toISOString();
  try { fs.appendFileSync(guildLog, `[${ts}] [${level}] ${msg}\n`); } catch {}
}

/**
 * Get recent logs. If guildId is provided, reads guild-specific log.
 * Otherwise reads global bot.log.
 */
function getRecentLogs(linesOrGuildId, lines) {
  let logFile, lineCount;
  if (typeof linesOrGuildId === 'string') {
    // getRecentLogs(guildId, lines)
    logFile = path.join(getGuildDataDir(linesOrGuildId), 'bot.log');
    lineCount = lines || 100;
  } else {
    // getRecentLogs(lines) — global log
    logFile = LOG_FILE;
    lineCount = linesOrGuildId || 100;
  }

  if (!fs.existsSync(logFile)) return '(no logs yet)';
  const content = fs.readFileSync(logFile, 'utf8');
  const all = content.split('\n').filter(l => l.trim());
  return all.slice(-lineCount).join('\n') || '(log file empty)';
}

module.exports = { initLogger, getRecentLogs, logGuild, LOG_FILE };
