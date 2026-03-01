/**
 * Notifier — Telegram DM notifications for the email agent.
 *
 * Lightweight module that calls the Telegram Bot API directly via HTTPS.
 * No dependency on the Telegram bridge process.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

let _cachedToken = null;

/**
 * Get the Telegram bot token from env or the Telegram bridge .env file.
 */
function getBotToken() {
  if (_cachedToken) return _cachedToken;

  if (process.env.TELEGRAM_BOT_TOKEN) {
    _cachedToken = process.env.TELEGRAM_BOT_TOKEN;
    return _cachedToken;
  }

  // Fallback: read from Telegram bridge .env
  const tgEnvPath = path.join(__dirname, '..', 'opai-telegram', '.env');
  try {
    const envContent = fs.readFileSync(tgEnvPath, 'utf8');
    const match = envContent.match(/^TELEGRAM_BOT_TOKEN=(.+)$/m);
    if (match) {
      _cachedToken = match[1].trim();
      return _cachedToken;
    }
  } catch {}

  return null;
}

/**
 * Send a Telegram message via Bot API.
 * @param {number|string} chatId - Telegram user/chat ID
 * @param {string} text - Message text (Markdown)
 * @param {object} [opts] - Extra options (parse_mode, reply_markup, etc.)
 * @returns {Promise<boolean>} - true if sent, false on error
 */
function sendTelegramMessage(chatId, text, opts = {}) {
  const token = getBotToken();
  if (!token) {
    console.error('[EMAIL-AGENT] [NOTIFY] No Telegram bot token available');
    return Promise.resolve(false);
  }

  const payload = JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    ...opts,
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 10000,
    }, (res) => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(true);
        } else {
          console.error(`[EMAIL-AGENT] [NOTIFY] Telegram API ${res.statusCode}: ${body.substring(0, 200)}`);
          resolve(false);
        }
      });
    });

    req.on('error', (err) => {
      console.error('[EMAIL-AGENT] [NOTIFY] Telegram request error:', err.message);
      resolve(false);
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Notify a user that a draft has been queued for approval.
 * Reads the account's notifications.telegramUserId to determine recipient.
 *
 * @param {object} account - Account object from config.json
 * @param {object} queueItem - { sender, subject, draft }
 * @returns {Promise<boolean>}
 */
function notifyDraftQueued(account, queueItem) {
  const userId = account?.notifications?.telegramUserId;
  if (!userId) return Promise.resolve(false);

  const accountName = account.name || account.email || 'Unknown';
  const sender = queueItem.sender || 'unknown';
  const subject = queueItem.subject || '(no subject)';
  const preview = (queueItem.draft || '').substring(0, 300).replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');

  const text =
    `*Draft Queued for Approval*\n\n` +
    `*Account:* ${accountName}\n` +
    `*From:* ${sender}\n` +
    `*Subject:* ${subject}\n\n` +
    `${preview}${(queueItem.draft || '').length > 300 ? '...' : ''}\n\n` +
    `[Open Email Agent](https://opai.boutabyte.com/email-agent/)`;

  return sendTelegramMessage(userId, text);
}

module.exports = { getBotToken, sendTelegramMessage, notifyDraftQueued };
