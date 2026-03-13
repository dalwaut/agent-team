/**
 * Email Sender — Send approved responses via SMTP and save drafts to IMAP.
 *
 * Supports Gmail (smtp.gmail.com) and Hostinger (smtp.hostinger.com).
 * Sets proper In-Reply-To and References headers for thread continuity.
 * Can save drafts directly to email account Drafts folder via IMAP APPEND.
 */

const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const CONFIG_FILE = path.join(__dirname, 'config.json');

// ──────────────────────────────────────────────────────────
// Transport Factory
// ──────────────────────────────────────────────────────────

/**
 * Get SMTP credentials for an account by env_prefix.
 *
 * Looks for SMTP_HOST{prefix}, SMTP_PORT{prefix}, SMTP_USER{prefix}, SMTP_PASS{prefix}.
 * Falls back to IMAP_USER{prefix} / IMAP_PASS{prefix} if SMTP-specific vars aren't set
 * (Gmail/Hostinger use same credentials for IMAP and SMTP).
 */
function getSmtpConfig(envPrefix) {
  const prefix = envPrefix || '';
  const host = process.env[`SMTP_HOST${prefix}`] || inferSmtpHost(process.env[`IMAP_HOST${prefix}`]);
  const port = parseInt(process.env[`SMTP_PORT${prefix}`] || '587', 10);
  const user = process.env[`SMTP_USER${prefix}`] || process.env[`IMAP_USER${prefix}`];
  const pass = process.env[`SMTP_PASS${prefix}`] || process.env[`IMAP_PASS${prefix}`];

  return { host, port, user, pass };
}

/**
 * Infer SMTP host from IMAP host.
 */
function inferSmtpHost(imapHost) {
  if (!imapHost) return null;
  if (imapHost.includes('gmail')) return 'smtp.gmail.com';
  if (imapHost.includes('hostinger')) return 'smtp.hostinger.com';
  return imapHost.replace('imap.', 'smtp.');
}

/**
 * Create a nodemailer transport for an account.
 */
function createTransport(envPrefix) {
  const config = getSmtpConfig(envPrefix);

  if (!config.host || !config.user || !config.pass) {
    throw new Error(`Missing SMTP credentials for prefix "${envPrefix}". Check .env`);
  }

  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.user, pass: config.pass },
  });
}

// ──────────────────────────────────────────────────────────
// Send Email
// ──────────────────────────────────────────────────────────

/**
 * Send an approved email response.
 *
 * @param {object} response — Response object from email-responses.json
 * @param {string} envPrefix — Account env_prefix for SMTP credentials
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
async function sendResponse(response, envPrefix) {
  try {
    const transport = createTransport(envPrefix);
    const smtpConfig = getSmtpConfig(envPrefix);

    const mailOptions = {
      from: smtpConfig.user,
      to: response.to,
      subject: response.subject,
      text: response.finalContent || response.refinedDraft,
      headers: {},
    };

    // Merge in any custom headers from the caller (e.g., X-OPAI-ARL-Sent)
    if (response.headers && typeof response.headers === 'object') {
      Object.assign(mailOptions.headers, response.headers);
    }

    // Set In-Reply-To and References for proper threading
    if (response.emailMessageId) {
      mailOptions.headers['In-Reply-To'] = response.emailMessageId;
      mailOptions.headers['References'] = response.emailMessageId;
    }

    const info = await transport.sendMail(mailOptions);

    console.log(`[SENDER] Email sent to ${response.to}: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[SENDER] Failed to send to ${response.to}:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Look up the env_prefix for an account name from config.json.
 */
function getEnvPrefixForAccount(accountName) {
  try {
    const config = JSON.parse(require('fs').readFileSync(CONFIG_FILE, 'utf8'));
    const account = config.accounts.find((a) => a.name === accountName);
    return account ? account.env_prefix : '';
  } catch {
    return '';
  }
}

// ──────────────────────────────────────────────────────────
// IMAP Draft Saving
// ──────────────────────────────────────────────────────────

/**
 * Get IMAP credentials for an account by env_prefix.
 */
function getImapConfig(envPrefix) {
  const prefix = envPrefix || '';
  return {
    host: process.env[`IMAP_HOST${prefix}`],
    port: parseInt(process.env[`IMAP_PORT${prefix}`] || '993', 10),
    user: process.env[`IMAP_USER${prefix}`],
    pass: process.env[`IMAP_PASS${prefix}`],
  };
}

/**
 * Determine the Drafts folder name based on the IMAP host.
 * Gmail uses '[Gmail]/Drafts', Hostinger uses 'Drafts'.
 */
function getDraftsFolder(imapHost) {
  if (imapHost && imapHost.includes('gmail')) return '[Gmail]/Drafts';
  return 'Drafts';
}

/**
 * Build a raw RFC 2822 email message string for IMAP APPEND.
 */
function buildRawEmail(from, to, subject, body, inReplyTo) {
  const date = new Date().toUTCString();
  const messageId = `<draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@opai.local>`;

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
  ];

  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`);
    headers.push(`References: ${inReplyTo}`);
  }

  return headers.join('\r\n') + '\r\n\r\n' + body;
}

/**
 * Save a draft email directly to the account's Drafts folder via IMAP APPEND.
 * This makes the draft visible in Gmail app, webmail, etc.
 *
 * @param {object} response — Response object from email-responses.json
 * @param {string} envPrefix — Account env_prefix for IMAP credentials
 * @returns {Promise<{success: boolean, folder?: string, error?: string}>}
 */
async function saveDraftToAccount(response, envPrefix) {
  const imap = getImapConfig(envPrefix);

  if (!imap.host || !imap.user || !imap.pass) {
    return { success: false, error: `Missing IMAP credentials for prefix "${envPrefix}"` };
  }

  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: true,
    auth: { user: imap.user, pass: imap.pass },
    logger: false,
    socketTimeout: 30000,
    greetingTimeout: 15000,
  });

  const draftsFolder = getDraftsFolder(imap.host);
  const content = response.refinedDraft || response.initialDraft || '';
  const subject = response.subject || '(no subject)';

  const rawEmail = buildRawEmail(imap.user, response.to, subject, content, response.emailMessageId);

  try {
    await client.connect();
    await client.append(draftsFolder, rawEmail, ['\\Draft']);
    await client.logout();

    console.log(`[SENDER] Draft saved to ${draftsFolder} for ${imap.user}`);
    return { success: true, folder: draftsFolder };
  } catch (err) {
    // Some servers use different folder names — try fallbacks
    const fallbacks = ['INBOX.Drafts', 'Drafts', '[Gmail]/Drafts'];
    for (const fallback of fallbacks) {
      if (fallback === draftsFolder) continue;
      try {
        if (!client.usable) await client.connect();
        await client.append(fallback, rawEmail, ['\\Draft']);
        await client.logout();
        console.log(`[SENDER] Draft saved to ${fallback} for ${imap.user} (fallback)`);
        return { success: true, folder: fallback };
      } catch {
        continue;
      }
    }

    try { await client.logout(); } catch { }
    console.error(`[SENDER] Failed to save draft for ${imap.user}:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Remove a draft from the account's Drafts folder by subject match.
 * Used after sending via OPAI to clean up the IMAP draft.
 *
 * @param {string} subject — Subject line to match
 * @param {string} envPrefix — Account env_prefix
 * @returns {Promise<boolean>}
 */
async function removeDraftFromAccount(subject, envPrefix) {
  const imap = getImapConfig(envPrefix);
  if (!imap.host || !imap.user || !imap.pass) return false;

  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: true,
    auth: { user: imap.user, pass: imap.pass },
    logger: false,
    socketTimeout: 30000,
    greetingTimeout: 15000,
  });

  const draftsFolder = getDraftsFolder(imap.host);

  try {
    await client.connect();
    const lock = await client.getMailboxLock(draftsFolder);
    try {
      const uids = await client.search({ subject, draft: true });
      if (uids.length > 0) {
        await client.messageDelete(uids[uids.length - 1]); // Delete most recent match
        console.log(`[SENDER] Removed draft "${subject}" from ${draftsFolder}`);
      }
    } finally {
      lock.release();
    }
    await client.logout();
    return true;
  } catch (err) {
    try { await client.logout(); } catch { }
    console.error(`[SENDER] Failed to remove draft:`, err.message);
    return false;
  }
}

// ──────────────────────────────────────────────────────────
// IMAP Email Tagging
// ──────────────────────────────────────────────────────────

/**
 * Map internal classification tags to display-friendly label names.
 * These become Gmail labels (under OPAI/) or IMAP keywords.
 */
const LABEL_DISPLAY_MAP = {
  'urgent': 'OPAI/Urgent',
  'action-required': 'OPAI/Action-Required',
  'informational': 'OPAI/Informational',
  'follow-up': 'OPAI/Follow-Up',
  'scheduling': 'OPAI/Scheduling',
  'invoice': 'OPAI/Invoice',
  'support': 'OPAI/Support',
  'client-communication': 'OPAI/Client',
  'internal': 'OPAI/Internal',
  'automated': 'OPAI/System',
  'marketing': 'OPAI/Marketing',
  'personal': 'OPAI/Personal',
  'notification': 'OPAI/System',
  'approval-needed': 'OPAI/Action-Required',
  'time-sensitive': 'OPAI/Urgent',
  'newsletter': 'OPAI/Newsletter',
  'fyi': 'OPAI/Informational',
  'no-response-needed': 'OPAI/Informational',
  'thread-update': 'OPAI/Follow-Up',
  'proposal': 'OPAI/Action-Required',
  'system-alert': 'OPAI/System-Alert',
  'security-alert': 'OPAI/Security-Alert',
  'service-notification': 'OPAI/System',
  'password-reset': 'OPAI/System',
  'billing': 'OPAI/Billing',
  'verification': 'OPAI/System',
};

/**
 * Map priority levels to labels.
 */
const PRIORITY_LABEL_MAP = {
  'critical': 'OPAI/Priority-Critical',
  'high': 'OPAI/Priority-High',
};

/**
 * Apply classification labels to an email on the IMAP server.
 *
 * For Gmail: Adds Gmail labels (e.g., "OPAI/Urgent", "OPAI/Marketing").
 *   These appear as labels in the Gmail app and web interface.
 *
 * For standard IMAP (Hostinger): Adds IMAP keywords (custom flags).
 *   Some clients show these, some don't. Best-effort.
 *
 * @param {number} uid — The IMAP UID of the message
 * @param {string[]} labels — Classification labels from classifier.js
 * @param {string} priority — Priority level (critical/high/normal/low)
 * @param {boolean} isSystem — Whether this is a system/automated message
 * @param {string} envPrefix — Account env_prefix
 * @param {string} [mailbox='INBOX'] — Mailbox the message is in
 * @returns {Promise<{success: boolean, labels?: string[], error?: string}>}
 */
async function applyLabelsToAccount(uid, labels, priority, isSystem, envPrefix, mailbox = 'INBOX') {
  const imap = getImapConfig(envPrefix);
  if (!imap.host || !imap.user || !imap.pass) {
    return { success: false, error: `Missing IMAP credentials for prefix "${envPrefix}"` };
  }

  // Build the set of labels to apply
  const labelsToApply = new Set();
  for (const tag of labels) {
    const gmailLabel = LABEL_DISPLAY_MAP[tag];
    if (gmailLabel) {
      labelsToApply.add(gmailLabel);
    } else if (tag.startsWith('OPAI/')) {
      // Pre-formatted label — pass through directly
      labelsToApply.add(tag);
    } else if (tag && !tag.includes(' ') && tag.length > 1) {
      // Custom label — prefix with OPAI/
      labelsToApply.add('OPAI/' + tag.charAt(0).toUpperCase() + tag.slice(1));
    }
  }

  // Add priority label for critical/high
  if (PRIORITY_LABEL_MAP[priority]) {
    labelsToApply.add(PRIORITY_LABEL_MAP[priority]);
  }

  // Add system flag
  if (isSystem) {
    labelsToApply.add('OPAI/System');
  }

  if (labelsToApply.size === 0) return { success: true, labels: [] };

  const appliedLabels = Array.from(labelsToApply);
  const isGmail = imap.host.includes('gmail');

  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: true,
    auth: { user: imap.user, pass: imap.pass },
    logger: false,
    socketTimeout: 30000,
    greetingTimeout: 15000,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock(mailbox);

    try {
      if (isGmail) {
        // Gmail: Use X-GM-LABELS to add labels
        // ImapFlow supports this via store with custom data items
        for (const lbl of appliedLabels) {
          try {
            await client.messageFlagsAdd(uid, { gmailLabels: [lbl] });
          } catch {
            // Label may not exist yet — Gmail auto-creates labels on first use
            // but some edge cases fail. Try as keyword fallback.
            try {
              const keyword = lbl.replace(/\//g, '-').replace(/\s/g, '_');
              await client.messageFlagsAdd(uid, [keyword]);
            } catch { }
          }
        }
      } else {
        // Standard IMAP: Add as keywords (custom flags)
        // Convert label names to IMAP-safe keywords (no spaces, no special chars)
        const keywords = appliedLabels.map(l =>
          l.replace('OPAI/', 'OPAI_').replace(/-/g, '_').replace(/\s/g, '_')
        );
        await client.messageFlagsAdd(uid, keywords);
      }
    } finally {
      lock.release();
    }

    await client.logout();
    console.log(`[SENDER] Labels applied to UID ${uid}: [${appliedLabels.join(', ')}]`);
    return { success: true, labels: appliedLabels };
  } catch (err) {
    try { await client.logout(); } catch { }
    console.error(`[SENDER] Failed to apply labels to UID ${uid}:`, err.message);
    return { success: false, error: err.message };
  }
}

// ──────────────────────────────────────────────────────────
// IMAP Move to Trash
// ──────────────────────────────────────────────────────────

/**
 * Determine the Trash folder name based on the IMAP host.
 * Gmail uses '[Gmail]/Trash', Hostinger/others use 'Trash'.
 */
function getTrashFolder(imapHost) {
  if (imapHost && imapHost.includes('gmail')) return '[Gmail]/Trash';
  return 'Trash';
}

/**
 * Move an email to the Trash folder via IMAP.
 *
 * @param {number} uid — The IMAP UID of the message
 * @param {string} sourceMailbox — Mailbox the message is in (e.g. 'INBOX')
 * @param {string} envPrefix — Account env_prefix for IMAP credentials
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function moveToTrash(uid, sourceMailbox, envPrefix) {
  const imap = getImapConfig(envPrefix);
  if (!imap.host || !imap.user || !imap.pass) {
    return { success: false, error: `Missing IMAP credentials for prefix "${envPrefix}"` };
  }

  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: true,
    auth: { user: imap.user, pass: imap.pass },
    logger: false,
    socketTimeout: 30000,
    greetingTimeout: 15000,
  });

  const trashFolder = getTrashFolder(imap.host);

  try {
    await client.connect();
    const lock = await client.getMailboxLock(sourceMailbox);
    try {
      await client.messageMove(uid, trashFolder, { uid: true });
    } finally {
      lock.release();
    }
    await client.logout();
    console.log(`[SENDER] Moved UID ${uid} from ${sourceMailbox} to ${trashFolder}`);
    return { success: true };
  } catch (err) {
    try { await client.logout(); } catch { }
    console.error(`[SENDER] Failed to move UID ${uid} to trash:`, err.message);
    return { success: false, error: err.message };
  }
}

async function moveToFolder(uid, sourceMailbox, targetFolder, envPrefix) {
  const imap = getImapConfig(envPrefix);
  if (!imap.host || !imap.user || !imap.pass) {
    return { success: false, error: `Missing IMAP credentials for prefix "${envPrefix}"` };
  }

  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: true,
    auth: { user: imap.user, pass: imap.pass },
    logger: false,
    socketTimeout: 30000,
    greetingTimeout: 15000,
  });

  try {
    await client.connect();
    // Ensure target folder exists (creates if missing)
    try { await client.mailboxCreate(targetFolder); } catch { }
    const lock = await client.getMailboxLock(sourceMailbox);
    try {
      await client.messageMove(uid, targetFolder, { uid: true });
    } finally {
      lock.release();
    }
    await client.logout();
    console.log(`[SENDER] Moved UID ${uid} from ${sourceMailbox} to ${targetFolder}`);
    return { success: true };
  } catch (err) {
    try { await client.logout(); } catch { }
    console.error(`[SENDER] Failed to move UID ${uid} to ${targetFolder}:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Mark an email as spam — moves to Gmail's Spam folder and reports it.
 * For Gmail: moves to [Gmail]/Spam. For standard IMAP: moves to Junk/Spam folder.
 */
async function markAsSpam(uid, sourceMailbox, envPrefix) {
  const imap = getImapConfig(envPrefix);
  if (!imap.host || !imap.user || !imap.pass) {
    return { success: false, error: `Missing IMAP credentials for prefix "${envPrefix}"` };
  }

  const isGmail = imap.host.includes('gmail');
  const spamFolder = isGmail ? '[Gmail]/Spam' : 'Junk';

  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: true,
    auth: { user: imap.user, pass: imap.pass },
    logger: false,
    socketTimeout: 30000,
    greetingTimeout: 15000,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock(sourceMailbox);
    try {
      await client.messageMove(uid, spamFolder, { uid: true });
    } finally {
      lock.release();
    }
    await client.logout();
    console.log(`[SENDER] Marked UID ${uid} as spam (moved to ${spamFolder})`);
    return { success: true, folder: spamFolder };
  } catch (err) {
    try { await client.logout(); } catch { }
    console.error(`[SENDER] Failed to mark UID ${uid} as spam:`, err.message);
    return { success: false, error: err.message };
  }
}

async function forwardEmail(uid, sourceMailbox, forwardTo, envPrefix) {
  const imap = getImapConfig(envPrefix);
  if (!imap.host || !imap.user || !imap.pass) {
    return { success: false, error: `Missing IMAP credentials for prefix "${envPrefix}"` };
  }

  // Fetch the raw message via IMAP then forward via SMTP
  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: true,
    auth: { user: imap.user, pass: imap.pass },
    logger: false,
    socketTimeout: 30000,
    greetingTimeout: 15000,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock(sourceMailbox);
    let rawMessage;
    try {
      const msg = await client.fetchOne(uid, { source: true }, { uid: true });
      rawMessage = msg?.source;
    } finally {
      lock.release();
    }
    await client.logout();

    if (!rawMessage) return { success: false, error: 'Could not fetch message source' };

    const transport = createTransport(envPrefix);
    await transport.sendMail({
      from: imap.user,
      to: forwardTo,
      subject: 'Fwd: (forwarded by email agent)',
      text: 'Forwarded message attached.',
      attachments: [{ filename: 'forwarded.eml', content: rawMessage }],
    });

    console.log(`[SENDER] Forwarded UID ${uid} to ${forwardTo}`);
    return { success: true };
  } catch (err) {
    try { await client.logout(); } catch { }
    console.error(`[SENDER] Failed to forward UID ${uid}:`, err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { sendResponse, saveDraftToAccount, removeDraftFromAccount, applyLabelsToAccount, applyTagsToAccount: applyLabelsToAccount, getEnvPrefixForAccount, createTransport, moveToTrash, moveToFolder, markAsSpam, forwardEmail };
