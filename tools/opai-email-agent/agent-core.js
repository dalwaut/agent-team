/**
 * Agent Core — main pipeline: fetch → gate → classify → mode-check → act → log
 *
 * Multi-account email agent. Checks ALL enabled accounts each cycle.
 * Day-of-only by default: only fetches unseen emails from today unless fetchAll is set.
 * Imports classifier, drafter, and sender from ../email-checker/ as libraries.
 */

const fs = require('fs');
const path = require('path');
const { ImapFlow } = require('imapflow');

const { checkSender, checkSenderForAccount } = require('./whitelist-gate');
const { checkBlacklistForAccount } = require('./blacklist-gate');
const { checkTrashPatterns, autoTrash, getReadyToMove, markAutoTrashMoved, suggestClassifications, getReadyToDelete, markDeleteExecuted } = require('./classification-engine');
const {
  getMode, getCapabilities, getCapabilitiesForAccount, canPerform,
  checkRateLimit, isKilled, getEnabledAccounts, getActiveAccount,
} = require('./mode-engine');
const { logAction, getStats } = require('./action-logger');
const { buildPromptContext } = require('./feedback-engine');
const { logAudit } = require('../shared/audit');
const { shouldProcessArl, processArlEmail } = require('./arl-engine');
const { hasActiveConversations } = require('./arl-conversation');
const { notifyDraftQueued } = require('./notifier');

// Reuse email-checker modules
const { classifyEmail } = require('../email-checker/classifier');
const { draftResponse, loadResponses, approveResponse } = require('../email-checker/response-drafter');
const { applyTagsToAccount, sendResponse, saveDraftToAccount, moveToTrash } = require('../email-checker/sender');

const CONFIG_PATH = path.join(__dirname, 'config.json');

// ── Credential loading (multi-account aware) ─────────────────

/**
 * Resolve IMAP/SMTP credentials for a specific account object.
 */
function getCredentialsForAccount(account) {
  // Inline credentials (accounts created via UI)
  if (account.imap?.pass) {
    return {
      imap: {
        host: account.imap.host || 'imap.gmail.com',
        port: account.imap.port || 993,
        user: account.imap.user || account.email,
        pass: account.imap.pass,
      },
      smtp: {
        host: account.smtp?.host || 'smtp.gmail.com',
        port: account.smtp?.port || 465,
        user: account.smtp?.user || account.email,
        pass: account.smtp?.pass || account.imap.pass,
      },
    };
  }
  // Env var credentials (legacy/existing accounts with envPrefix)
  const prefix = account.envPrefix || 'AGENT';
  return {
    imap: {
      host: process.env[`${prefix}_IMAP_HOST`] || 'imap.gmail.com',
      port: parseInt(process.env[`${prefix}_IMAP_PORT`] || '993', 10),
      user: process.env[`${prefix}_IMAP_USER`] || '',
      pass: process.env[`${prefix}_IMAP_PASS`] || '',
    },
    smtp: {
      host: process.env[`${prefix}_SMTP_HOST`] || 'smtp.gmail.com',
      port: parseInt(process.env[`${prefix}_SMTP_PORT`] || '465', 10),
      user: process.env[`${prefix}_SMTP_USER`] || '',
      pass: process.env[`${prefix}_SMTP_PASS`] || '',
    },
  };
}

/**
 * Get credentials for the active account (backwards compat for audit-server).
 */
function getCredentials() {
  return getCredentialsForAccount(getActiveAccount());
}

/**
 * Bridge env vars for email-checker modules using a specific account's credentials.
 */
function setEnvBridgeForAccount(account) {
  const creds = getCredentialsForAccount(account);
  process.env.IMAP_HOST = creds.imap.host;
  process.env.IMAP_PORT = String(creds.imap.port);
  process.env.IMAP_USER = creds.imap.user;
  process.env.IMAP_PASS = creds.imap.pass;
  process.env.SMTP_HOST = creds.smtp.host;
  process.env.SMTP_PORT = String(creds.smtp.port);
  process.env.SMTP_USER = creds.smtp.user;
  process.env.SMTP_PASS = creds.smtp.pass;
}

/**
 * Bridge env vars for the active account (backwards compat for audit-server).
 */
function setEnvBridge() {
  setEnvBridgeForAccount(getActiveAccount());
}

const PROCESSED_PATH = path.join(__dirname, 'data', 'processed.json');
const QUEUE_PATH = path.join(__dirname, 'data', 'approval-queue.json');
const ALERTS_PATH = path.join(__dirname, 'data', 'alerts.json');
const EMAIL_META_PATH = path.join(__dirname, 'data', 'email-meta.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// ── Dedup tracker (with 90-day age expiry) ───────────────────

const PROCESSED_EXPIRY_DAYS = 90;

function loadProcessed() {
  try { return JSON.parse(fs.readFileSync(PROCESSED_PATH, 'utf8')); }
  catch { return { entries: [] }; }
}

function saveProcessed(data) {
  fs.mkdirSync(path.dirname(PROCESSED_PATH), { recursive: true });
  if ((data.entries || []).length > 2000) data.entries = data.entries.slice(-2000);
  fs.writeFileSync(PROCESSED_PATH, JSON.stringify(data, null, 2));
}

// Remove entries older than PROCESSED_EXPIRY_DAYS and migrate legacy { ids: [] } format.
function pruneOldProcessed() {
  const data = loadProcessed();
  if (data.ids && !data.entries) {
    data.entries = (data.ids || []).map(id => ({ id, processedAt: new Date().toISOString() }));
    delete data.ids;
  }
  if (!data.entries) data.entries = [];
  const cutoff = Date.now() - PROCESSED_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  const before = data.entries.length;
  data.entries = data.entries.filter(e => !e.processedAt || new Date(e.processedAt).getTime() > cutoff);
  const pruned = before - data.entries.length;
  if (pruned > 0) console.log(`[EMAIL-AGENT] Pruned ${pruned} processed entries older than ${PROCESSED_EXPIRY_DAYS}d`);
  saveProcessed(data);
  return data;
}

function isProcessed(messageId) {
  const data = loadProcessed();
  if (data.ids) return data.ids.includes(messageId); // legacy format
  return (data.entries || []).some(e => e.id === messageId);
}

function markProcessed(messageId) {
  const data = loadProcessed();
  if (data.ids && !data.entries) {
    data.entries = (data.ids || []).map(id => ({ id, processedAt: new Date().toISOString() }));
    delete data.ids;
  }
  if (!data.entries) data.entries = [];
  if (!data.entries.some(e => e.id === messageId)) {
    data.entries.push({ id: messageId, processedAt: new Date().toISOString() });
    saveProcessed(data);
  }
}

/**
 * Remove processed entries matching a sender or domain.
 * Uses email-meta.json to reverse-lookup which message IDs belong to the sender.
 * @param {{ sender?: string, domain?: string }} opts
 * @returns {{ removed: number, messageIds: string[] }}
 */
function unmarkProcessed(opts) {
  const meta = loadEmailMeta();
  const processed = loadProcessed();
  if (!processed.entries) processed.entries = [];

  // Find message IDs that match the sender/domain from email metadata
  const matchingIds = [];
  for (const [msgId, info] of Object.entries(meta)) {
    const addr = (info.fromAddress || '').toLowerCase();
    if (opts.sender && addr === opts.sender.toLowerCase()) {
      matchingIds.push(msgId);
    } else if (opts.domain && addr.endsWith('@' + opts.domain.toLowerCase())) {
      matchingIds.push(msgId);
    }
  }

  const before = processed.entries.length;
  processed.entries = processed.entries.filter(e => !matchingIds.includes(e.id));
  const removed = before - processed.entries.length;

  if (removed > 0) saveProcessed(processed);

  return { removed, messageIds: matchingIds };
}

// ── Approval queue ───────────────────────────────────────────

function loadQueue() {
  try { return JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8')); }
  catch { return { items: [] }; }
}

function saveQueue(data) {
  fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(data, null, 2));
}

function addToQueue(item) {
  const queue = loadQueue();
  queue.items.push({
    id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    ...item,
    status: 'pending',
    createdAt: new Date().toISOString(),
  });
  saveQueue(queue);
  return queue.items[queue.items.length - 1];
}

// ── Alerts ───────────────────────────────────────────────────

function loadAlerts() {
  try { return JSON.parse(fs.readFileSync(ALERTS_PATH, 'utf8')); }
  catch { return { alerts: [] }; }
}

function addAlert(alert) {
  const data = loadAlerts();
  data.alerts.push({
    id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    ...alert,
    dismissed: false,
    createdAt: new Date().toISOString(),
  });
  if (data.alerts.length > 100) data.alerts = data.alerts.slice(-100);
  fs.mkdirSync(path.dirname(ALERTS_PATH), { recursive: true });
  fs.writeFileSync(ALERTS_PATH, JSON.stringify(data, null, 2));
}

// ── Email metadata store ──────────────────────────────────

function loadEmailMeta() {
  try { return JSON.parse(fs.readFileSync(EMAIL_META_PATH, 'utf8')); }
  catch { return {}; }
}

function saveEmailMeta(data) {
  fs.mkdirSync(path.dirname(EMAIL_META_PATH), { recursive: true });
  fs.writeFileSync(EMAIL_META_PATH, JSON.stringify(data, null, 2));
}

/**
 * Extract attachment filenames from raw email source (no content downloaded).
 * Looks for Content-Disposition: attachment headers.
 */
function extractAttachments(source) {
  const raw = source ? source.toString('utf8') : '';
  const attachments = [];
  // Match: Content-Disposition: attachment; filename="foo.pdf" or filename*=UTF-8''foo.pdf
  const re = /Content-Disposition:\s*attachment[^\n]*(?:\n[ \t]+[^\n]*)*/gi;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const block = m[0];
    // filename="..."
    let name = (block.match(/filename="([^"]+)"/i) || [])[1];
    // filename*=UTF-8''encoded-name
    if (!name) name = (block.match(/filename\*=UTF-8''([^\s;"\r\n]+)/i) || [])[1];
    if (!name) name = (block.match(/filename=([^\s;"\r\n]+)/i) || [])[1];
    if (name) attachments.push(decodeURIComponent(name).trim());
  }
  return attachments;
}

/**
 * Persist email metadata for later UI display. Capped at 500 entries (oldest evicted).
 */
function storeEmailMeta(email, rawSource, accountId = null) {
  const data = loadEmailMeta();
  const attachments = rawSource ? extractAttachments(rawSource) : [];
  data[email.messageId] = {
    messageId: email.messageId,
    accountId: accountId || null,
    from: email.from,
    fromAddress: email.fromAddress,
    to: email.to,
    subject: email.subject,
    date: email.date,
    bodyPreview: (email.body || '').slice(0, 600),
    attachments,
    uid: email.uid || null,
    folder: email.folder || null,
    storedAt: new Date().toISOString(),
  };
  // Cap at 500 entries — evict oldest by storedAt
  const entries = Object.values(data);
  if (entries.length > 500) {
    entries.sort((a, b) => new Date(a.storedAt) - new Date(b.storedAt));
    const toRemove = entries.slice(0, entries.length - 500);
    for (const e of toRemove) delete data[e.messageId];
  }
  saveEmailMeta(data);
}

function getEmailMeta(messageId) {
  return loadEmailMeta()[messageId] || null;
}

// ── IMAP mark-seen (account-aware) ────────────────────────────

/**
 * Mark an email as \Seen in the IMAP mailbox after it has been sent.
 * Silently fails (logs only) — never blocks the send pipeline.
 * @param {number} uid
 * @param {string} folder
 * @param {object} [account] - Account object. Falls back to active account.
 */
async function markEmailSeen(uid, folder = 'INBOX', account = null) {
  if (!uid) return;
  const creds = account ? getCredentialsForAccount(account) : getCredentials();
  if (!creds.imap.user || !creds.imap.pass) return;

  const label = account?.name || 'active';
  const client = new ImapFlow({
    host: creds.imap.host,
    port: creds.imap.port,
    secure: true,
    auth: { user: creds.imap.user, pass: creds.imap.pass },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock(folder);
    try {
      await client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true });
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    console.error(`[EMAIL-AGENT] [${label}] markEmailSeen failed (non-fatal):`, err.message);
    try { await client.logout(); } catch {}
  }
}

function getQueueItems(status = null, accountId = null) {
  const queue = loadQueue();
  let items = queue.items;
  if (accountId) {
    items = items.filter(i => i.accountId === accountId || !i.accountId);
  }
  if (status) {
    items = items.filter(i => i.status === status);
  }
  return items;
}

function updateQueueItem(itemId, updates) {
  const queue = loadQueue();
  const item = queue.items.find(i => i.id === itemId);
  if (!item) return null;
  Object.assign(item, updates, { updatedAt: new Date().toISOString() });
  saveQueue(queue);
  return item;
}

// ── IMAP fetch (account-aware, day-of-only by default) ────────

/**
 * Fetch unseen emails from a specific account's IMAP inbox.
 * By default only fetches today's emails (dayOnly=true).
 * Pass { dayOnly: false } to fetch all unseen emails.
 *
 * @param {object} [account] - Account object. Falls back to active account.
 * @param {object} [options] - { dayOnly: boolean (default true) }
 */
async function fetchEmails(account = null, options = {}) {
  const targetAccount = account || getActiveAccount();
  const creds = getCredentialsForAccount(targetAccount);
  const label = targetAccount.name || targetAccount.email || 'unknown';

  if (!creds.imap.user || !creds.imap.pass) {
    console.log(`[EMAIL-AGENT] [${label}] Missing IMAP credentials — skipping`);
    return [];
  }

  const dayOnly = options.dayOnly !== false; // default true

  const client = new ImapFlow({
    host: creds.imap.host,
    port: creds.imap.port,
    secure: true,
    auth: { user: creds.imap.user, pass: creds.imap.pass },
    logger: false,
  });

  const emails = [];

  try {
    await client.connect();

    const folders = targetAccount.imapFolders || ['INBOX'];
    for (const folder of folders) {
      const lock = await client.getMailboxLock(folder);
      try {
        const status = await client.status(folder, { messages: true, unseen: true });
        console.log(`[EMAIL-AGENT] [${label}] Mailbox ${folder}: ${status.messages} total, ${status.unseen} unseen`);

        // Build search criteria: UNSEEN + optional date filter
        const searchCriteria = { seen: false };
        if (dayOnly) {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          searchCriteria.since = today;
        }

        const messages = client.fetch(
          searchCriteria,
          { envelope: true, source: true, uid: true }
        );

        let imapCount = 0, dedupSkipped = 0;
        for await (const msg of messages) {
          imapCount++;
          const messageId = msg.envelope?.messageId || `uid-${msg.uid}`;
          if (isProcessed(messageId)) { dedupSkipped++; continue; }

          const from = msg.envelope?.from?.[0];
          const senderAddr = from ? `${from.name || ''} <${from.address}>`.trim() : 'unknown';

          // Extract body text from source
          let body = '';
          if (msg.source) {
            body = extractTextFromSource(msg.source);
          }

          emails.push({
            messageId,
            uid: msg.uid,
            folder,
            from: senderAddr,
            fromAddress: from?.address || '',
            to: msg.envelope?.to?.map(t => t.address).join(', ') || '',
            subject: msg.envelope?.subject || '(no subject)',
            date: msg.envelope?.date?.toISOString() || new Date().toISOString(),
            body,
            inReplyTo: msg.envelope?.inReplyTo || null,
            _rawSource: msg.source, // carried for meta storage, not persisted
          });
        }
        if (imapCount > 0) console.log(`[EMAIL-AGENT] [${label}] IMAP returned ${imapCount} messages, ${dedupSkipped} already processed, ${imapCount - dedupSkipped} new`);
      } finally {
        lock.release();
      }
    }

    await client.logout();
  } catch (err) {
    console.error(`[EMAIL-AGENT] [${label}] IMAP fetch error:`, err.message);
    try { await client.logout(); } catch {}
  }

  return emails;
}

/**
 * Extract plain text from raw email source.
 */
function extractTextFromSource(source) {
  const raw = source.toString('utf8');

  // Try to find text/plain boundary
  const boundaryMatch = raw.match(/boundary="?([^"\r\n]+)"?/i);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = raw.split('--' + boundary);
    for (const part of parts) {
      if (part.includes('text/plain')) {
        const bodyStart = part.indexOf('\r\n\r\n');
        if (bodyStart > -1) {
          let text = part.slice(bodyStart + 4);
          // Remove trailing boundary marker
          const endIdx = text.indexOf('--' + boundary);
          if (endIdx > -1) text = text.slice(0, endIdx);
          // Handle quoted-printable
          if (part.toLowerCase().includes('quoted-printable')) {
            text = text.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
          }
          // Handle base64
          if (part.toLowerCase().includes('base64')) {
            try { text = Buffer.from(text.trim(), 'base64').toString('utf8'); } catch {}
          }
          return text.trim();
        }
      }
    }
  }

  // Fallback: everything after the first blank line
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd > -1) {
    return raw.slice(headerEnd + 4).trim().slice(0, 5000);
  }
  return raw.slice(0, 3000);
}

// ── Thread context fetch (account-aware) ──────────────────────

/**
 * Fetch the body of an email by Message-ID (for thread context injection).
 * Used when the incoming email has an inReplyTo header.
 * Silently returns null on any failure.
 */
async function fetchThreadEmail(inReplyToId, account = null) {
  if (!inReplyToId) return null;
  const creds = account ? getCredentialsForAccount(account) : getCredentials();
  if (!creds.imap.user || !creds.imap.pass) return null;

  const client = new ImapFlow({
    host: creds.imap.host,
    port: creds.imap.port,
    secure: true,
    auth: { user: creds.imap.user, pass: creds.imap.pass },
    logger: false,
  });

  let body = null;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const results = await client.search({ header: ['Message-ID', inReplyToId] });
      if (results && results.length > 0) {
        const msgs = client.fetch([results[results.length - 1]], { source: true });
        for await (const msg of msgs) {
          if (msg.source) body = extractTextFromSource(msg.source);
          break;
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    console.error('[EMAIL-AGENT] fetchThreadEmail failed (non-fatal):', err.message);
    try { await client.logout(); } catch {}
  }
  return body;
}

// ── Main pipeline (multi-account) ────────────────────────────

/**
 * Process a single email through the full pipeline for a given account.
 * Returns 'processed' | 'skipped' | 'error'
 */
async function processEmail(email, account, mode, caps) {
  const acctId = account.id;

  // Store email metadata for UI display (body preview + attachment names)
  storeEmailMeta(email, email._rawSource, acctId);

  const label = account.name || account.email;

  // ── Step 0: Blacklist gate (before everything else) ──
  const blacklistResult = checkBlacklistForAccount(email.fromAddress, account);
  if (blacklistResult.blocked) {
    try {
      setEnvBridgeForAccount(account);
      await moveToTrash(email.uid, email.folder || 'INBOX', '');
    } catch (err) {
      console.error(`[EMAIL-AGENT] [${label}] Blacklist trash-move failed:`, err.message);
    }
    logAction({
      accountId: acctId,
      action: 'blacklist',
      emailId: email.messageId,
      sender: email.fromAddress,
      subject: email.subject,
      reasoning: `[${label}] Blacklisted: ${blacklistResult.reason}. Moved to trash.`,
      mode,
    });
    markProcessed(email.messageId);
    return 'blacklisted';
  }

  // ── ARL intercept: check if this email triggers the Agent Response Loop ──
  if (shouldProcessArl(email, account)) {
    const gateCheck = checkSenderForAccount(email.fromAddress, account);
    if (gateCheck.allowed) {
      try {
        const arlResult = await processArlEmail(email, account);
        if (arlResult.handled) {
          markProcessed(email.messageId);
          return 'processed';
        }
        // ARL didn't handle it (no intent detected) — fall through to normal pipeline
      } catch (arlErr) {
        console.error(`[EMAIL-AGENT] [${label}] ARL error (falling back to normal pipeline):`, arlErr.message);
      }
    }
  }

  // ── Step 1: Whitelist gate (account-specific) ──
  const gateResult = checkSenderForAccount(email.fromAddress, account);

  if (!gateResult.allowed) {
    logAction({
      accountId: acctId,
      action: 'skip',
      emailId: email.messageId,
      sender: email.fromAddress,
      subject: email.subject,
      reasoning: `[${label}] Whitelist gate: ${gateResult.reason}`,
      mode,
    });
    markProcessed(email.messageId);
    return 'skipped';
  }

  // ── Step 2: Classify ──
  let classification = null;
  if (caps.classify) {
    classification = await classifyEmail(
      email.from,
      email.subject,
      email.body || '',
      account.name || 'Agent'
    );

    logAction({
      accountId: acctId,
      action: 'classify',
      emailId: email.messageId,
      sender: email.fromAddress,
      subject: email.subject,
      reasoning: `[${label}] Classified: tags=[${(classification.tags || []).join(', ')}], priority=${classification.priority}, urgency=${classification.urgency}`,
      mode,
      details: { classification },
    });

    // Create alert for urgent or attention-needed emails
    if (classification.urgency === 'urgent' || classification.needsUserAttention) {
      addAlert({
        accountId: acctId,
        emailId: email.messageId,
        sender: email.fromAddress,
        subject: email.subject,
        reason: classification.urgency === 'urgent' ? 'Urgent email detected' : 'Email needs your attention',
        tags: classification.tags || [],
        priority: classification.priority,
      });
    }

    // ── Step 2.5: Trash pattern check ──
    const trashCheck = checkTrashPatterns(email.fromAddress, acctId);
    if (trashCheck.shouldTrash) {
      autoTrash(email.messageId, email.fromAddress, email.subject, acctId);
      logAction({
        accountId: acctId,
        action: 'auto-trash',
        emailId: email.messageId,
        sender: email.fromAddress,
        subject: email.subject,
        reasoning: `[${label}] Auto-trash queued (48h delay): ${trashCheck.reason}`,
        mode,
      });
      // Does NOT return early — email still gets classified/tagged for record keeping
    }
  }

  // ── Step 3: Tag (IMAP labels) ──
  if (caps.tag && classification) {
    try {
      setEnvBridgeForAccount(account);
      await applyTagsToAccount(
        email.uid,
        classification.tags || [],
        classification.priority || 'normal',
        classification.isSystem || false,
        '',  // envPrefix — empty, using bridged env vars
        email.folder || 'INBOX'
      );

      logAction({
        accountId: acctId,
        action: 'tag',
        emailId: email.messageId,
        sender: email.fromAddress,
        subject: email.subject,
        reasoning: `[${label}] Applied IMAP tags: ${(classification.tags || []).join(', ')}`,
        mode,
      });
    } catch (tagErr) {
      console.error(`[EMAIL-AGENT] [${label}] Tag error:`, tagErr.message);
    }
  }

  // ── Step 3.5: Classification suggestions ──
  if (classification) {
    const suggestions = suggestClassifications({ sender: email.fromAddress, tags: classification.tags }, acctId);
    if (suggestions.length > 0) {
      const meta = loadEmailMeta();
      if (meta[email.messageId]) {
        meta[email.messageId].classificationSuggestions = suggestions;
        saveEmailMeta(meta);
      }
    }
  }

  // ── Step 4: Draft response (internal + auto modes) ──
  if (caps.draft && classification?.requiresResponse) {
    const feedbackContext = buildPromptContext(email.fromAddress, acctId);
    const voiceProfile = account.voiceProfile || 'paradise-web-agent';

    // Fetch thread context if this is a reply
    let threadContext = '';
    if (email.inReplyTo) {
      const threadBody = await fetchThreadEmail(email.inReplyTo, account);
      if (threadBody) {
        threadContext = `\n\n--- PREVIOUS MESSAGE ---\n${threadBody.slice(0, 1000)}\n--- END PREVIOUS MESSAGE ---`;
      }
    }

    const draft = await draftResponse(
      {
        from: email.fromAddress,
        fromName: email.from,
        subject: email.subject,
        text: (email.body || '') + feedbackContext + threadContext,
        date: email.date,
      },
      account.name || 'Agent',
      voiceProfile
    );

    if (draft) {
      logAction({
        accountId: acctId,
        action: 'draft',
        emailId: email.messageId,
        sender: email.fromAddress,
        subject: email.subject,
        reasoning: `[${label}] Drafted response (${draft.steps || 3} step process). priority=${classification.priority}`,
        mode,
        details: { draftId: draft.id, draftPreview: (draft.final || draft.draft || '').slice(0, 200) },
      });

      // ── Step 5: Send or queue ──
      if (caps.send) {
        const rateCheck = checkRateLimit();
        if (rateCheck.allowed) {
          setEnvBridgeForAccount(account);
          await sendResponse({
            to: email.fromAddress,
            subject: email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject}`,
            finalContent: draft.finalContent || draft.refinedDraft || draft.initialDraft,
            emailMessageId: email.messageId,
          }, '');

          markEmailSeen(email.uid, email.folder, account).catch(() => {});

          logAction({
            accountId: acctId,
            action: 'send',
            emailId: email.messageId,
            sender: email.fromAddress,
            subject: email.subject,
            reasoning: `[${label}] Auto-sent response. Rate limit: ${rateCheck.remaining} remaining.`,
            mode,
            details: { draftId: draft.id, rateLimitRemaining: rateCheck.remaining },
          });
        } else {
          addToQueue({
            accountId: acctId,
            emailId: email.messageId,
            uid: email.uid,
            folder: email.folder,
            sender: email.fromAddress,
            subject: email.subject,
            draft: draft.final || draft.draft,
            draftId: draft.id,
            reason: 'Rate limit reached',
          });

          notifyDraftQueued(account, { sender: email.fromAddress, subject: email.subject, draft: draft.final || draft.draft })
            .catch(err => console.error('[EMAIL-AGENT] Notify error:', err.message));

          logAction({
            accountId: acctId,
            action: 'queue',
            emailId: email.messageId,
            sender: email.fromAddress,
            subject: email.subject,
            reasoning: `[${label}] Rate limit reached (${rateCheck.limit}/hour). Draft queued.`,
            mode,
          });
        }
      } else {
        // Internal mode — always queue for approval
        addToQueue({
          accountId: acctId,
          emailId: email.messageId,
          uid: email.uid,
          folder: email.folder,
          sender: email.fromAddress,
          subject: email.subject,
          draft: draft.final || draft.draft,
          draftId: draft.id,
          reason: 'Internal mode — requires approval',
        });

        notifyDraftQueued(account, { sender: email.fromAddress, subject: email.subject, draft: draft.final || draft.draft })
          .catch(err => console.error('[EMAIL-AGENT] Notify error:', err.message));

        logAction({
          accountId: acctId,
          action: 'queue',
          emailId: email.messageId,
          sender: email.fromAddress,
          subject: email.subject,
          reasoning: `[${label}] Internal mode: queued for admin approval.`,
          mode,
        });
      }
    }
  } else if (caps.classify && classification && !classification.requiresResponse) {
    logAction({
      accountId: acctId,
      action: 'suggest',
      emailId: email.messageId,
      sender: email.fromAddress,
      subject: email.subject,
      reasoning: `[${label}] No response required. ${classification.summary || 'system/informational'}`,
      mode,
      details: { classification },
    });
  }

  markProcessed(email.messageId);
  return 'processed';
}

/**
 * Run one check cycle across ALL enabled accounts.
 * This is the core agent pipeline entry point.
 *
 * @param {object} [options] - { fetchAll: boolean } — if true, fetches all unseen (no date filter)
 * @returns {{ processed: number, skipped: number, errors: number, killed: boolean }}
 */
async function runCycle(options = {}) {
  if (isKilled()) {
    console.log('[EMAIL-AGENT] Agent is killed — skipping cycle');
    return { processed: 0, skipped: 0, errors: 0, killed: true };
  }

  const cycleStart = Date.now();
  pruneOldProcessed();

  const enabledAccounts = getEnabledAccounts();
  if (enabledAccounts.length === 0) {
    console.log('[EMAIL-AGENT] No enabled accounts with valid credentials — skipping cycle');
    return { processed: 0, skipped: 0, errors: 0, killed: false };
  }

  let totalProcessed = 0, totalSkipped = 0, totalErrors = 0;

  for (const account of enabledAccounts) {
    if (isKilled()) break;

    const mode = account.mode || 'suggestion';
    const caps = getCapabilitiesForAccount(account);
    const label = account.name || account.email;

    console.log(`[EMAIL-AGENT] [${label}] Starting in ${mode} mode`);

    let processed = 0, skipped = 0, errors = 0;

    try {
      const emails = await fetchEmails(account, { dayOnly: options.fetchAll !== true });
      console.log(`[EMAIL-AGENT] [${label}] Fetched ${emails.length} new emails`);

      for (const email of emails) {
        if (isKilled()) break;

        try {
          const result = await processEmail(email, account, mode, caps);
          if (result === 'skipped') skipped++;
          else processed++;
        } catch (emailErr) {
          console.error(`[EMAIL-AGENT] [${label}] Error processing ${email.subject}:`, emailErr.message);
          logAction({
            action: 'error',
            emailId: email.messageId,
            sender: email.fromAddress,
            subject: email.subject,
            reasoning: `[${label}] Processing error: ${emailErr.message}`,
            mode,
          });
          markProcessed(email.messageId);
          errors++;
        }
      }
    } catch (fetchErr) {
      console.error(`[EMAIL-AGENT] [${label}] Cycle error:`, fetchErr.message);
      logAction({
        action: 'error',
        reasoning: `[${label}] Cycle-level error: ${fetchErr.message}`,
        mode,
      });
      errors++;
    }

    console.log(`[EMAIL-AGENT] [${label}] Done: ${processed} processed, ${skipped} skipped, ${errors} errors`);
    totalProcessed += processed;
    totalSkipped += skipped;
    totalErrors += errors;
  }

  // ── Process delayed auto-trash moves ──
  for (const account of enabledAccounts) {
    try {
      const ready = getReadyToMove(account.id);
      if (ready.length > 0) {
        console.log(`[EMAIL-AGENT] [${account.name}] Processing ${ready.length} delayed trash moves`);
        setEnvBridgeForAccount(account);
        for (const entry of ready) {
          const meta = getEmailMeta(entry.emailId);
          if (meta?.uid) {
            try {
              await moveToTrash(meta.uid, meta.folder || 'INBOX', '');
              markAutoTrashMoved(entry.id, account.id);
              logAction({
                accountId: account.id,
                action: 'manual-trash',
                emailId: entry.emailId,
                sender: entry.sender,
                subject: entry.subject,
                reasoning: `[${account.name}] Auto-trash delay expired. Moved to trash.`,
                mode: account.mode || 'suggestion',
              });
            } catch (moveErr) {
              console.error(`[EMAIL-AGENT] [${account.name}] Auto-trash move failed:`, moveErr.message);
            }
          } else {
            // No UID available — mark as moved anyway to prevent retry loop
            markAutoTrashMoved(entry.id, account.id);
          }
        }
      }
    } catch (trashErr) {
      console.error(`[EMAIL-AGENT] [${account.name}] Delayed trash processing error:`, trashErr.message);
    }

    // Process scheduled deletes
    try {
      const deletes = getReadyToDelete(account.id);
      if (deletes.length > 0) {
        console.log(`[EMAIL-AGENT] [${account.name}] Processing ${deletes.length} scheduled deletions`);
        setEnvBridgeForAccount(account);
        for (const entry of deletes) {
          const meta = getEmailMeta(entry.emailId);
          if (meta?.uid) {
            try {
              await moveToTrash(meta.uid, meta.folder || 'INBOX', '');
              markDeleteExecuted(entry.id, account.id);
              logAction({
                accountId: account.id,
                action: 'organize',
                emailId: entry.emailId,
                reasoning: `[${account.name}] Scheduled deletion executed.`,
                mode: account.mode || 'suggestion',
                details: { actionType: 'scheduled-delete' },
              });
            } catch (delErr) {
              console.error(`[EMAIL-AGENT] [${account.name}] Scheduled delete failed:`, delErr.message);
            }
          } else {
            markDeleteExecuted(entry.id, account.id);
          }
        }
      }
    } catch (delErr) {
      console.error(`[EMAIL-AGENT] [${account.name}] Scheduled delete processing error:`, delErr.message);
    }
  }

  const cycleDuration = Date.now() - cycleStart;
  console.log(`[EMAIL-AGENT] Cycle complete: ${totalProcessed} processed, ${totalSkipped} skipped, ${totalErrors} errors across ${enabledAccounts.length} account(s) (${cycleDuration}ms)`);

  // Audit: log cycle summary (only when something happened)
  if (totalProcessed > 0 || totalErrors > 0) {
    try {
      logAudit({
        tier: 'execution',
        service: 'opai-email-agent',
        event: 'email-cycle',
        status: totalErrors > 0 ? (totalProcessed > 0 ? 'partial' : 'failed') : 'completed',
        summary: `Email cycle: ${totalProcessed} processed, ${totalSkipped} skipped, ${totalErrors} errors (${enabledAccounts.length} accounts)`,
        duration_ms: cycleDuration,
        details: {
          accountsChecked: enabledAccounts.map(a => a.name),
          emailsProcessed: totalProcessed,
          emailsSkipped: totalSkipped,
          emailsErrors: totalErrors,
        },
      });
    } catch (auditErr) {
      console.error('[EMAIL-AGENT] Audit write failed:', auditErr.message);
    }
  }

  return { processed: totalProcessed, skipped: totalSkipped, errors: totalErrors, killed: false };
}

module.exports = {
  runCycle,
  fetchEmails,
  getQueueItems,
  updateQueueItem,
  loadQueue,
  markEmailSeen,
  loadAlerts,
  addAlert,
  getEmailMeta,
  getCredentials,
  getCredentialsForAccount,
  setEnvBridge,
  setEnvBridgeForAccount,
  hasActiveConversations,
  unmarkProcessed,
  addToQueue,
};
