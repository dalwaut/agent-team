/**
 * Shared audit logger for Node.js OPAI services.
 *
 * Usage:
 *   const { logAudit } = require('../shared/audit');
 *   logAudit({
 *     tier: 'system',
 *     service: 'opai-orchestrator',
 *     event: 'email-check',
 *     status: 'completed',
 *     summary: 'Email check completed — 3 processed',
 *     duration_ms: 5200,
 *     details: { emailsProcessed: 3 },
 *   });
 */

const fs = require('fs');
const path = require('path');

const AUDIT_PATH = path.join(__dirname, '..', '..', 'tasks', 'audit.json');
const MAX_RECORDS = 2000;

function generateAuditId() {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(Math.random() * 900) + 100;
  const ts = String(Date.now()).slice(-6);
  return `audit-${dateStr}-${rand}-${ts}`;
}

/**
 * Append a tiered audit record to audit.json.
 * @param {Object} opts
 * @param {string} opts.tier - "execution", "system", or "health"
 * @param {string} opts.service - originating service name
 * @param {string} opts.event - event type
 * @param {string} [opts.status="completed"] - "completed", "failed", "partial", "skipped"
 * @param {string} [opts.summary=""] - human-readable one-liner
 * @param {number} [opts.duration_ms] - execution duration
 * @param {Object} [opts.details={}] - tier-specific additional data
 * @returns {string} The generated audit ID
 */
function logAudit({ tier, service, event, status = 'completed', summary = '', duration_ms = null, details = {} }) {
  const validTiers = ['execution', 'system', 'health'];
  if (!validTiers.includes(tier)) tier = 'system';

  const auditId = generateAuditId();
  const record = {
    id: auditId,
    timestamp: new Date().toISOString(),
    tier,
    service,
    event,
    status,
    summary,
    duration_ms,
    details,
  };

  let records = [];
  try {
    if (fs.existsSync(AUDIT_PATH)) {
      records = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8'));
    }
  } catch (_) {}

  records.unshift(record); // newest first
  if (records.length > MAX_RECORDS) {
    records = records.slice(0, MAX_RECORDS);
  }

  try {
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
    fs.writeFileSync(AUDIT_PATH, JSON.stringify(records, null, 2));
  } catch (err) {
    console.error(`[AUDIT] Failed to write record: ${err.message}`);
  }

  return auditId;
}

module.exports = { logAudit };
