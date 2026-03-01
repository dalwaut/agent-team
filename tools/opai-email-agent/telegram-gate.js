/**
 * Telegram Approval Gate — sends approval requests to Telegram with inline keyboards
 *
 * Used for system change requests that require human approval before execution.
 * Stores pending requests in data/pending-approvals.json with 24h expiry.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const APPROVALS_PATH = path.join(__dirname, 'data', 'pending-approvals.json');
const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

// Dallas's Telegram user ID (admin group)
const ADMIN_CHAT_ID = -1003761890007;
const OWNER_TELEGRAM_ID = 1666403499;

function getBotToken() {
  // Try env first (from vault), then read from Telegram bot's .env
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;

  // Fallback: read from Telegram bot's .env file
  try {
    const envPath = path.join(__dirname, '..', 'opai-telegram', '.env');
    const envContent = fs.readFileSync(envPath, 'utf8');
    const match = envContent.match(/TELEGRAM_BOT_TOKEN=(.+)/);
    if (match) return match[1].trim();
  } catch {}

  return '';
}

function loadApprovals() {
  try {
    return JSON.parse(fs.readFileSync(APPROVALS_PATH, 'utf8'));
  } catch {
    return { pending: [] };
  }
}

function saveApprovals(data) {
  fs.mkdirSync(path.dirname(APPROVALS_PATH), { recursive: true });
  // Prune expired
  const now = Date.now();
  data.pending = (data.pending || []).filter(a => new Date(a.expiresAt).getTime() > now);
  fs.writeFileSync(APPROVALS_PATH, JSON.stringify(data, null, 2));
}

/**
 * Send an approval request to Telegram.
 * @param {object} opts
 * @param {string} opts.requestId - Unique ID for this approval request
 * @param {string} opts.summary - Human-readable description of the proposed change
 * @param {string} opts.requester - Who requested this (email address)
 * @param {string} opts.requesterName - Human name
 * @param {string} opts.emailSubject - Original email subject
 * @param {object} opts.changePayload - The actual change data to execute on approval
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendApprovalRequest(opts) {
  const token = getBotToken();
  if (!token) {
    console.error('[TELEGRAM-GATE] No TELEGRAM_BOT_TOKEN available');
    return { success: false, error: 'No Telegram bot token configured' };
  }

  const { requestId, summary, requester, requesterName, emailSubject, changePayload } = opts;

  // Store pending approval
  const data = loadApprovals();
  data.pending.push({
    id: requestId,
    requester,
    requesterName: requesterName || requester,
    emailSubject,
    summary,
    changePayload,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + EXPIRY_MS).toISOString(),
    status: 'pending',
  });
  saveApprovals(data);

  // Build Telegram message
  const message = `*System Change Request*\n\n` +
    `*From:* ${requesterName || requester}\n` +
    `*Email:* ${emailSubject}\n\n` +
    `*Proposed Change:*\n${summary}\n\n` +
    `_Expires in 24 hours_`;

  const inlineKeyboard = {
    inline_keyboard: [
      [
        { text: 'Approve', callback_data: `syschange:approve:${requestId}` },
        { text: 'Reject', callback_data: `syschange:reject:${requestId}` },
      ],
    ],
  };

  return new Promise((resolve) => {
    const body = JSON.stringify({
      chat_id: OWNER_TELEGRAM_ID,
      text: message,
      parse_mode: 'Markdown',
      reply_markup: inlineKeyboard,
    });

    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (d) => { data += d; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.ok) {
              console.log(`[TELEGRAM-GATE] Approval request ${requestId} sent to Telegram`);
              resolve({ success: true });
            } else {
              console.error(`[TELEGRAM-GATE] Telegram API error:`, parsed.description);
              resolve({ success: false, error: parsed.description });
            }
          } catch (err) {
            resolve({ success: false, error: 'Invalid Telegram response' });
          }
        });
      }
    );

    req.on('error', (err) => {
      console.error('[TELEGRAM-GATE] Request error:', err.message);
      resolve({ success: false, error: err.message });
    });

    req.setTimeout(10000, () => {
      req.destroy();
      resolve({ success: false, error: 'Telegram request timeout' });
    });

    req.write(body);
    req.end();
  });
}

/**
 * Get a pending approval by ID.
 * @param {string} requestId
 * @returns {object|null}
 */
function getApproval(requestId) {
  const data = loadApprovals();
  return data.pending.find(a => a.id === requestId && a.status === 'pending') || null;
}

/**
 * Mark an approval as approved/rejected.
 * @param {string} requestId
 * @param {string} status - 'approved' | 'rejected'
 * @returns {object|null} The approval record, or null if not found
 */
function resolveApproval(requestId, status) {
  const data = loadApprovals();
  const approval = data.pending.find(a => a.id === requestId);
  if (!approval) return null;

  approval.status = status;
  approval.resolvedAt = new Date().toISOString();
  saveApprovals(data);
  return approval;
}

/**
 * Get all pending approvals.
 * @returns {object[]}
 */
function listPendingApprovals() {
  const data = loadApprovals();
  const now = Date.now();
  return (data.pending || []).filter(
    a => a.status === 'pending' && new Date(a.expiresAt).getTime() > now
  );
}

module.exports = {
  sendApprovalRequest,
  getApproval,
  resolveApproval,
  listPendingApprovals,
};
