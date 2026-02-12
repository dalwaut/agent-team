/**
 * Logger Module — Tees console output to data/bot.log
 * Rotates at 500KB. Provides getRecentLogs() for the review command.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const LOG_FILE = path.join(DATA_DIR, 'bot.log');
const MAX_SIZE = 500 * 1024; // 500KB

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

function getRecentLogs(lines = 100) {
  if (!fs.existsSync(LOG_FILE)) return '(no logs yet)';
  const content = fs.readFileSync(LOG_FILE, 'utf8');
  const all = content.split('\n').filter(l => l.trim());
  return all.slice(-lines).join('\n') || '(log file empty)';
}

module.exports = { initLogger, getRecentLogs, LOG_FILE };
