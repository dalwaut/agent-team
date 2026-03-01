/**
 * Handler Utilities — shared helpers for Telegram handlers.
 */

const fs = require('fs');
const path = require('path');
let auditFn = null;
try {
  auditFn = require('../../shared/audit').logAudit;
} catch {}

const DANGER_AUDIT_PATH = path.join(__dirname, '..', 'data', 'danger-audit.json');

/**
 * Log an audit event (if shared audit module is available).
 */
function logAudit(event, status, summary, details = {}) {
  if (auditFn) {
    try {
      auditFn({
        tier: 'execution',
        service: 'opai-telegram',
        event,
        status,
        summary,
        details,
      });
    } catch {}
  }
}

/**
 * Log a dangerous run to data/danger-audit.json (append-only) and shared audit.
 * @param {object} opts
 * @param {number} opts.userId - Telegram user ID
 * @param {string} opts.username - Telegram display name
 * @param {string} opts.instruction - What was executed
 * @param {string} [opts.conversationContext] - Truncated context
 * @param {'success'|'error'|'timeout'|'cancelled'} opts.outcome
 * @param {number} [opts.responseLength] - Length of Claude response
 * @param {number} [opts.durationMs] - Duration of execution
 * @param {string} [opts.error] - Error message if failed
 */
function logDangerousRun(opts) {
  const entry = {
    timestamp: new Date().toISOString(),
    userId: opts.userId,
    username: opts.username,
    instruction: (opts.instruction || '').substring(0, 500),
    conversationContext: (opts.conversationContext || '').substring(0, 300),
    outcome: opts.outcome,
    responseLength: opts.responseLength || 0,
    durationMs: opts.durationMs || 0,
    error: opts.error || null,
  };

  // Append to danger-audit.json
  try {
    const dir = path.dirname(DANGER_AUDIT_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let audit = [];
    if (fs.existsSync(DANGER_AUDIT_PATH)) {
      audit = JSON.parse(fs.readFileSync(DANGER_AUDIT_PATH, 'utf8'));
    }
    audit.push(entry);
    // Keep last 200 entries
    if (audit.length > 200) audit = audit.slice(-200);
    fs.writeFileSync(DANGER_AUDIT_PATH, JSON.stringify(audit, null, 2), 'utf8');
  } catch (err) {
    console.error('[TG] Failed to write danger audit:', err.message);
  }

  // Also log to shared audit
  logAudit('dangerous-run', opts.outcome, `Dangerous run by ${opts.username}: ${(opts.instruction || '').substring(0, 100)}`, {
    userId: opts.userId,
    durationMs: opts.durationMs,
    responseLength: opts.responseLength,
  });
}

module.exports = { logAudit, logDangerousRun };
