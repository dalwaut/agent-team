/**
 * Action Logger — structured action log with reasoning trail + daily rotation
 *
 * Every agent action gets a structured entry with:
 *   - what it did (action type)
 *   - why it did it (reasoning)
 *   - what triggered it (email metadata)
 *   - what mode was active
 *   - admin feedback (injected later)
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const LOG_PATH = path.join(DATA_DIR, 'action-log.json');
const ARCHIVE_DIR = path.join(DATA_DIR, 'logs');
const INDEX_PATH = path.join(ARCHIVE_DIR, 'index.json');

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
}

// ── Archive index (fast date→count lookup) ────────────────

function loadIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')); }
  catch { return {}; }
}

function saveIndex(index) {
  ensureDirs();
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
}

function rebuildIndex() {
  ensureDirs();
  const index = {};
  try {
    const files = fs.readdirSync(ARCHIVE_DIR)
      .filter(f => f.endsWith('.json') && f !== 'index.json');
    for (const f of files) {
      const date = f.replace('.json', '');
      try {
        const content = JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, f), 'utf8'));
        index[date] = (content.entries || []).length;
      } catch {}
    }
  } catch {}
  saveIndex(index);
  return index;
}

function loadLog() {
  try {
    return JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
  } catch {
    return { entries: [], date: today() };
  }
}

function saveLog(log) {
  ensureDirs();
  fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
}

function today() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Rotate log if the date has changed. Archives to data/logs/YYYY-MM-DD.json.
 */
function maybeRotate() {
  const log = loadLog();
  if (log.date && log.date !== today() && log.entries.length > 0) {
    ensureDirs();
    const archivePath = path.join(ARCHIVE_DIR, `${log.date}.json`);
    fs.writeFileSync(archivePath, JSON.stringify(log, null, 2));
    // Update archive index
    const index = loadIndex();
    index[log.date] = log.entries.length;
    saveIndex(index);
    saveLog({ entries: [], date: today() });
  }
}

/**
 * Log an agent action.
 * @param {Object} entry
 * @param {string} entry.action - Action type: classify, tag, draft, send, skip, organize, suggest
 * @param {string} entry.emailId - Message-ID or subject identifier
 * @param {string} entry.sender - Sender address
 * @param {string} entry.subject - Email subject
 * @param {string} entry.reasoning - Why the agent took this action
 * @param {string} entry.mode - Active mode when action was taken
 * @param {Object} [entry.details] - Additional action-specific details
 * @returns {Object} The created log entry with id and timestamp
 */
function logAction(entry) {
  maybeRotate();
  const log = loadLog();
  if (!log.date) log.date = today();

  const logEntry = {
    id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    accountId: entry.accountId || null,
    action: entry.action,
    emailId: entry.emailId || null,
    sender: entry.sender || null,
    subject: entry.subject || null,
    reasoning: entry.reasoning || '',
    mode: entry.mode || 'unknown',
    details: entry.details || {},
    feedback: null,
  };

  log.entries.push(logEntry);

  // Cap at 500 entries per day before auto-archiving
  if (log.entries.length > 500) {
    log.entries = log.entries.slice(-500);
  }

  saveLog(log);
  return logEntry;
}

/**
 * Get recent actions (for UI display).
 * Reads today's log first, then falls back to archives (newest first) if more entries are needed.
 * @param {number} [limit=50]
 * @param {string} [filter] - Filter by action type
 */
function getActions(limit = 50, filter = null, accountId = null) {
  maybeRotate();
  const log = loadLog();
  let entries = log.entries || [];

  // Pull from archives if today's log doesn't cover the requested limit
  if (entries.length < limit) {
    const archives = listArchives(); // sorted newest-first
    for (const date of archives) {
      try {
        const archivePath = path.join(ARCHIVE_DIR, `${date}.json`);
        const archived = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
        entries = (archived.entries || []).concat(entries);
      } catch {}
      if (entries.length >= limit) break;
    }
  }

  if (accountId) {
    entries = entries.filter(e => e.accountId === accountId);
  }
  if (filter) {
    entries = entries.filter(e => e.action === filter);
  }
  return entries.slice(-limit).reverse();
}

/**
 * Get a specific action by ID.
 */
function getAction(actionId) {
  const log = loadLog();
  return (log.entries || []).find(e => e.id === actionId) || null;
}

/**
 * Attach feedback to an action entry.
 */
function addFeedback(actionId, feedback) {
  const log = loadLog();
  const entry = (log.entries || []).find(e => e.id === actionId);
  if (!entry) return null;
  entry.feedback = {
    comment: feedback,
    timestamp: new Date().toISOString(),
  };
  saveLog(log);
  return entry;
}

/**
 * Get today's stats.
 */
function getStats(accountId = null) {
  maybeRotate();
  const log = loadLog();
  let entries = log.entries || [];
  if (accountId) entries = entries.filter(e => e.accountId === accountId);
  const counts = {};
  for (const e of entries) {
    counts[e.action] = (counts[e.action] || 0) + 1;
  }
  return {
    date: log.date || today(),
    total: entries.length,
    byAction: counts,
    lastAction: entries.length ? entries[entries.length - 1].timestamp : null,
  };
}

/**
 * Get actions for a specific date string (YYYY-MM-DD).
 * Returns today's log if date matches today, otherwise reads from archive.
 */
function getActionsForDate(date, filter = null, accountId = null) {
  let entries = [];
  if (date === today()) {
    const log = loadLog();
    entries = log.entries || [];
  } else {
    try {
      const archivePath = path.join(ARCHIVE_DIR, `${date}.json`);
      const archived = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
      entries = archived.entries || [];
    } catch {
      entries = [];
    }
  }
  if (accountId) entries = entries.filter(e => e.accountId === accountId);
  if (filter) entries = entries.filter(e => e.action === filter);
  return entries.reverse();
}

/**
 * List archived log dates, newest first. Uses index.json for O(1) lookup.
 * Falls back to directory scan and rebuilds index if index is missing/empty.
 */
function listArchives() {
  ensureDirs();
  let index = loadIndex();
  if (Object.keys(index).length === 0) index = rebuildIndex();
  const t = today();
  return Object.keys(index).filter(d => d !== t).sort().reverse();
}

/**
 * List all available dates (today + archived), newest first.
 */
function listAllDates() {
  ensureDirs();
  let index = loadIndex();
  if (Object.keys(index).length === 0) index = rebuildIndex();
  const t = today();
  const all = Object.keys(index).sort().reverse();
  return all.includes(t) ? all : [t, ...all];
}

module.exports = { logAction, getActions, getActionsForDate, getAction, addFeedback, getStats, listArchives, listAllDates, today };
