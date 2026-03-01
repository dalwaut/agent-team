/**
 * Audit Server — Express REST API for the email agent moderation UI
 *
 * Endpoints:
 *   GET  /health           — service health check
 *   GET  /api/status       — agent status (mode, killed, last check, stats)
 *   GET  /api/mode         — current mode
 *   POST /api/mode         — set mode { mode: "suggestion"|"internal"|"auto" }
 *   GET  /api/settings     — agent settings
 *   PATCH /api/settings    — update settings
 *   GET  /api/emails       — actions grouped by emailId (inbox view)
 *   GET  /api/actions      — action log (query: ?limit=50&filter=classify)
 *   GET  /api/actions/:id  — single action detail
 *   GET  /api/queue        — approval queue
 *   POST /api/queue/:id/approve — approve a queued draft
 *   POST /api/queue/:id/reject  — reject a queued draft
 *   POST /api/queue/:id/edit    — edit then approve
 *   GET  /api/feedback     — all feedback rules
 *   POST /api/feedback     — add feedback rule
 *   POST /api/feedback/:id/deactivate — deactivate a rule
 *   POST /api/kill         — kill the agent loop
 *   POST /api/resume       — resume after kill
 *   GET  /api/stats        — today's stats
 *   GET  /api/whitelist    — current whitelist
 *   GET  /api/auth/config  — Supabase config for frontend
 */

const express = require('express');
const path = require('path');
const os = require('os');

const modeEngine = require('./mode-engine');
const actionLogger = require('./action-logger');
const feedbackEngine = require('./feedback-engine');
const { getWhitelist, addToWhitelist, removeFromWhitelist } = require('./whitelist-gate');
const { getBlacklist, addToBlacklist, removeFromBlacklist } = require('./blacklist-gate');
const classificationEngine = require('./classification-engine');
const { logAudit } = require('../shared/audit');
const arlSkillRunner = require('./arl-skill-runner');
const arlConversation = require('./arl-conversation');

// ── SSE broadcast (module-level so index.js can import it) ──
const sseClients = new Set();

function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch {}
  }
}

// Grouping helper — used by both date-aware and default email endpoints
function groupActions(actions) {
  const map = new Map();

  for (const a of actions) {
    if (!a.emailId) continue;

    if (!map.has(a.emailId)) {
      map.set(a.emailId, {
        emailId: a.emailId,
        sender: a.sender || '--',
        subject: a.subject || '(no subject)',
        date: a.timestamp,
        actions: [],
        tags: [],
        outcome: 'classified',
        draft: null,
      });
    }

    const group = map.get(a.emailId);
    group.actions.push(a);
    if (a.timestamp < group.date) group.date = a.timestamp;

    const extractTags = (details) => {
      if (!details) return [];
      const found = [];
      if (Array.isArray(details.tags)) details.tags.forEach(t => { if (typeof t === 'string') found.push(t); });
      if (Array.isArray(details.labels)) details.labels.forEach(t => { if (typeof t === 'string') found.push(t); });
      if (details.classification && typeof details.classification === 'object') {
        if (Array.isArray(details.classification.tags)) details.classification.tags.forEach(t => { if (typeof t === 'string') found.push(t); });
        if (typeof details.classification.priority === 'string' && details.classification.priority !== 'normal') found.push(details.classification.priority);
      }
      if (typeof details.category === 'string') found.push(details.category);
      if (typeof details.classification === 'string') found.push(details.classification);
      return found;
    };

    if (a.action === 'tag' || a.action === 'classify' || a.action === 'suggest') {
      for (const t of extractTags(a.details)) {
        if (!group.tags.includes(t)) group.tags.push(t);
      }
    }

    // Action → outcome mapping with priority for resolution
    const actionPri = { skip: 1, blacklist: 2, 'manual-trash': 2, 'auto-trash': 2, classify: 3, tag: 4, suggest: 4, organize: 4, queue: 5, draft: 6, send: 7, error: 8 };
    const outcomePri = { classified: 0, skipped: 1, blacklisted: 2, trashed: 2, 'auto-trash': 2, tagged: 4, draft: 6, sent: 7, error: 8 };
    const actionToOutcome = { skip: 'skipped', blacklist: 'blacklisted', 'manual-trash': 'trashed', 'auto-trash': 'auto-trash', classify: 'classified', tag: 'tagged', suggest: 'classified', organize: 'classified', queue: 'draft', draft: 'draft', send: 'sent', error: 'error' };

    // Undo actions always reset regardless of priority
    if (a.action === 'trash-undo' || a.action === 'classify-undo') {
      group.outcome = 'skipped';
    } else {
      const newOutcome = actionToOutcome[a.action];
      if (newOutcome) {
        const currentPri = outcomePri[group.outcome] || 0;
        const newPri = actionPri[a.action] || 0;
        if (newPri >= currentPri) {
          group.outcome = newOutcome;
        }
      }
    }

    if ((a.action === 'draft' || a.action === 'queue') && a.details && a.details.draft) {
      group.draft = a.details.draft;
    }
  }

  for (const group of map.values()) {
    group.actions.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  }

  return Array.from(map.values()).sort((a, b) => new Date(b.date) - new Date(a.date));
}

const startTime = Date.now();

function createAuditServer(agentRef) {
  const app = express();

  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'static')));

  // Helper: extract accountId from request (query, body, or fallback to active)
  function reqAccountId(req) {
    return req.query.accountId || req.body?.accountId || modeEngine.getActiveAccountId();
  }

  // ── Accounts ──────────────────────────────────────────────

  app.get('/api/accounts', (req, res) => {
    res.json({ accounts: modeEngine.getAccounts(), activeId: modeEngine.getActiveAccountId() });
  });

  app.post('/api/accounts', (req, res) => {
    const account = modeEngine.addAccount(req.body);
    try { logAudit({ tier: 'system', service: 'opai-email-agent', event: 'account-created', status: 'completed', summary: `Email account created: ${req.body.email}`, details: { accountId: account.id } }); } catch (_) {}
    res.json({ success: true, account });
  });

  app.get('/api/accounts/active', (req, res) => {
    const account = modeEngine.getActiveAccount();
    res.json(modeEngine.sanitizeAccount(account));
  });

  app.post('/api/accounts/active', (req, res) => {
    const { accountId } = req.body;
    const result = modeEngine.setActiveAccount(accountId);
    if (!result.success) return res.status(400).json(result);
    // Restart agent loop for new account credentials
    if (agentRef && agentRef.restart) agentRef.restart();
    try { logAudit({ tier: 'system', service: 'opai-email-agent', event: 'account-switched', status: 'completed', summary: `Switched to account: ${accountId}` }); } catch (_) {}
    res.json(result);
  });

  app.patch('/api/accounts/:id', (req, res) => {
    const account = modeEngine.updateAccount(req.params.id, req.body);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    res.json({ success: true, account });
  });

  app.delete('/api/accounts/:id', (req, res) => {
    const deleted = modeEngine.deleteAccount(req.params.id);
    if (!deleted) return res.status(400).json({ error: 'Cannot delete (last account or not found)' });
    res.json({ success: true });
  });

  app.patch('/api/accounts/:id/permissions', (req, res) => {
    const account = modeEngine.updateAccount(req.params.id, { permissions: req.body });
    if (!account) return res.status(404).json({ error: 'Account not found' });
    res.json({ success: true, account });
  });

  app.post('/api/accounts/:id/test-connection', async (req, res) => {
    const account = modeEngine.getAccountCredentials(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const { ImapFlow } = require('imapflow');
    // Resolve credentials: inline first, then env prefix fallback
    const imap = account.imap || {};
    const prefix = account.envPrefix || '';
    const host = imap.host || (prefix ? process.env[`${prefix}_IMAP_HOST`] : '') || 'imap.gmail.com';
    const port = imap.port || parseInt(prefix ? process.env[`${prefix}_IMAP_PORT`] : '993', 10);
    const user = imap.user || (prefix ? process.env[`${prefix}_IMAP_USER`] : '') || '';
    const pass = imap.pass || (prefix ? process.env[`${prefix}_IMAP_PASS`] : '') || '';

    if (!user || !pass) {
      return res.json({ success: false, error: 'No credentials configured. Add an app password to connect.' });
    }

    const client = new ImapFlow({ host, port, secure: true, auth: { user, pass }, logger: false });
    try {
      await client.connect();
      await client.logout();
      // Mark account as set up if test passes
      modeEngine.updateAccount(req.params.id, { needsSetup: false });
      res.json({ success: true, message: 'Connection successful' });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // ── Health ──────────────────────────────────────────────

  app.get('/health', (req, res) => {
    res.json({
      status: 'healthy',
      service: 'opai-email-agent',
      version: '1.0.0',
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
      memory_mb: Math.round(process.memoryUsage().rss / 1048576),
      mode: modeEngine.getMode(),
      killed: modeEngine.isKilled(),
    });
  });

  // ── Auth config (for frontend Supabase init) ───────────

  app.get('/api/auth/config', (req, res) => {
    res.json({
      supabase_url: process.env.SUPABASE_URL || '',
      supabase_anon_key: process.env.SUPABASE_ANON_KEY || '',
    });
  });

  // ── Status ─────────────────────────────────────────────

  app.get('/api/status', (req, res) => {
    const acctId = reqAccountId(req);
    const stats = actionLogger.getStats(acctId);
    const rateLimit = modeEngine.getRateLimitStatus(acctId);
    const activeAccount = modeEngine.getActiveAccount();
    res.json({
      mode: modeEngine.getMode(),
      killed: modeEngine.isKilled(),
      settings: modeEngine.getSettings(acctId),
      stats,
      rateLimit,
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
      activeAccount: modeEngine.sanitizeAccount(activeAccount),
    });
  });

  // ── Mode ───────────────────────────────────────────────

  app.get('/api/mode', (req, res) => {
    res.json({ mode: modeEngine.getMode(), capabilities: modeEngine.getCapabilities() });
  });

  app.post('/api/mode', (req, res) => {
    const { mode } = req.body;
    const result = modeEngine.setMode(mode);
    if (!result.success) return res.status(400).json(result);
    try { logAudit({ tier: 'system', service: 'opai-email-agent', event: 'mode-change', status: 'completed', summary: `Email agent mode changed to ${mode}`, details: { mode } }); } catch (_) {}
    res.json(result);
  });

  // ── Settings ───────────────────────────────────────────

  app.get('/api/settings', (req, res) => {
    res.json(modeEngine.getSettings(reqAccountId(req)));
  });

  app.patch('/api/settings', (req, res) => {
    const acctId = reqAccountId(req);
    const before = modeEngine.getSettings(acctId);
    const result = modeEngine.updateSettings(req.body, acctId);
    // Hot-reload the agent loop if the check interval changed
    if (req.body.checkIntervalMinutes != null &&
        req.body.checkIntervalMinutes !== before.checkIntervalMinutes &&
        agentRef && agentRef.restart) {
      agentRef.restart();
    }
    res.json(result);
  });

  // ── Log date navigation ────────────────────────────────

  app.get('/api/logs/dates', (req, res) => {
    res.json({ dates: actionLogger.listAllDates(), today: actionLogger.today() });
  });

  // ── Emails (grouped by emailId) — supports ?date=YYYY-MM-DD ──

  app.get('/api/emails', (req, res) => {
    const acctId = reqAccountId(req);
    let actions;
    if (req.query.date) {
      actions = actionLogger.getActionsForDate(req.query.date, null, acctId);
    } else {
      actions = actionLogger.getActions(200, null, acctId);
    }
    const emails = groupActions(actions);

    // Enrich with classification data from email-meta + classification assignments
    try {
      const { getEmailMeta } = require('./agent-core');
      const acctCls = classificationEngine.getClassifications(acctId);
      for (const group of emails) {
        const meta = getEmailMeta(group.emailId);
        if (meta?.classificationSuggestions) {
          group.classificationSuggestions = meta.classificationSuggestions;
        }
        // Check if this email has been assigned to a custom classification
        for (const cls of acctCls) {
          if ((cls.assignments || []).some(a => a.emailId === group.emailId)) {
            group.outcome = 'cls:' + cls.name;
            group.classificationColor = cls.color;
            group.classificationId = cls.id;
            break;
          }
        }
      }
    } catch {}

    res.json({ emails });
  });

  // ── Actions ────────────────────────────────────────────

  app.get('/api/actions', (req, res) => {
    const limit = parseInt(req.query.limit || '50', 10);
    const filter = req.query.filter || null;
    const acctId = reqAccountId(req);
    if (req.query.date) {
      res.json({ actions: actionLogger.getActionsForDate(req.query.date, filter, acctId) });
    } else {
      res.json({ actions: actionLogger.getActions(limit, filter, acctId) });
    }
  });

  app.get('/api/actions/:id', (req, res) => {
    const action = actionLogger.getAction(req.params.id);
    if (!action) return res.status(404).json({ error: 'Action not found' });
    res.json(action);
  });

  // Add feedback to an action
  app.post('/api/actions/:id/feedback', (req, res) => {
    const { comment, type, category, sender } = req.body;
    if (!comment) return res.status(400).json({ error: 'Comment required' });

    // Add feedback to the action log entry
    const updated = actionLogger.addFeedback(req.params.id, comment);
    if (!updated) return res.status(404).json({ error: 'Action not found' });

    // Also create a persistent feedback rule
    const rule = feedbackEngine.addRule({
      accountId: reqAccountId(req),
      actionId: req.params.id,
      comment,
      type: type || category || 'general',
      sender: sender || null,
    });

    res.json({ action: updated, rule });
  });

  // ── Approval Queue ─────────────────────────────────────

  app.get('/api/queue', (req, res) => {
    const { getQueueItems } = require('./agent-core');
    const status = req.query.status || null;
    const acctId = reqAccountId(req);
    res.json({ items: getQueueItems(status, acctId) });
  });

  app.post('/api/queue/:id/approve', async (req, res) => {
    const { updateQueueItem, markEmailSeen } = require('./agent-core');
    const item = updateQueueItem(req.params.id, { status: 'approved' });
    if (!item) return res.status(404).json({ error: 'Queue item not found' });

    // Attempt to send the approved draft
    try {
      const { sendResponse, removeDraftFromAccount } = require('../email-checker/sender');
      const { setEnvBridgeForAccount } = require('./agent-core');

      // Bridge the queue item's account credentials to env for sender module
      const account = modeEngine.getAccountById(item.accountId) || modeEngine.getActiveAccount();
      setEnvBridgeForAccount(account);

      const replySubject = item.subject.startsWith('Re:') ? item.subject : `Re: ${item.subject}`;
      await sendResponse({
        to: item.sender,
        subject: replySubject,
        finalContent: item.draft,
        emailMessageId: item.emailId,
      }, '');

      // Mark source email as read in Gmail (non-blocking)
      markEmailSeen(item.uid, item.folder || 'INBOX').catch(() => {});

      // Clean up the Gmail draft now that it's sent (non-blocking)
      removeDraftFromAccount(replySubject, '').catch(() => {});

      updateQueueItem(req.params.id, { status: 'sent' });
      actionLogger.logAction({
        accountId: item.accountId || reqAccountId(req),
        action: 'send',
        emailId: item.emailId,
        sender: item.sender,
        subject: item.subject,
        reasoning: 'Approved and sent by admin from queue.',
        mode: modeEngine.getMode(),
      });

      res.json({ success: true, status: 'sent' });
    } catch (err) {
      res.status(500).json({ error: `Send failed: ${err.message}` });
    }
  });

  app.post('/api/queue/:id/reject', (req, res) => {
    const { updateQueueItem } = require('./agent-core');
    const { reason } = req.body;
    const item = updateQueueItem(req.params.id, { status: 'rejected', rejectReason: reason || '' });
    if (!item) return res.status(404).json({ error: 'Queue item not found' });

    actionLogger.logAction({
      accountId: item.accountId || reqAccountId(req),
      action: 'reject',
      emailId: item.emailId,
      sender: item.sender,
      subject: item.subject,
      reasoning: `Admin rejected draft: ${reason || 'no reason given'}`,
      mode: modeEngine.getMode(),
    });

    res.json({ success: true });
  });

  app.post('/api/queue/:id/edit', async (req, res) => {
    const { updateQueueItem } = require('./agent-core');
    const { draft } = req.body;
    if (!draft) return res.status(400).json({ error: 'Draft body required' });

    const item = updateQueueItem(req.params.id, { draft, status: 'edited' });
    if (!item) return res.status(404).json({ error: 'Queue item not found' });

    // Record the correction for learning
    feedbackEngine.addCorrection({
      accountId: item.accountId || reqAccountId(req),
      actionId: item.id,
      originalDraft: item.draft,
      correctedDraft: draft,
      sender: item.sender,
    });

    res.json({ success: true, item });
  });

  // ── Feedback ───────────────────────────────────────────

  app.get('/api/feedback', (req, res) => {
    res.json(feedbackEngine.getAllFeedback(reqAccountId(req)));
  });

  app.post('/api/feedback', (req, res) => {
    const { comment, type, category, sender, actionId } = req.body;
    if (!comment) return res.status(400).json({ error: 'Comment required' });
    const rule = feedbackEngine.addRule({ accountId: reqAccountId(req), actionId, comment, type: type || category, sender });
    res.json(rule);
  });

  app.post('/api/feedback/:id/deactivate', (req, res) => {
    const rule = feedbackEngine.deactivateRule(req.params.id);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    res.json(rule);
  });

  // ── Kill / Resume ──────────────────────────────────────

  app.post('/api/kill', (req, res) => {
    const result = modeEngine.kill();
    // Also signal the agent loop to stop
    if (agentRef && agentRef.stop) agentRef.stop();
    actionLogger.logAction({
      action: 'kill',
      reasoning: 'Admin triggered kill switch.',
      mode: modeEngine.getMode(),
    });
    res.json(result);
  });

  app.post('/api/resume', (req, res) => {
    const result = modeEngine.resume();
    // Signal the agent loop to restart
    if (agentRef && agentRef.start) agentRef.start();
    actionLogger.logAction({
      action: 'resume',
      reasoning: 'Admin resumed agent.',
      mode: modeEngine.getMode(),
    });
    res.json(result);
  });

  // ── Stats ──────────────────────────────────────────────

  app.get('/api/stats', (req, res) => {
    const acctId = reqAccountId(req);
    const stats = actionLogger.getStats(acctId);
    const rateLimit = modeEngine.getRateLimitStatus(acctId);
    const queue = require('./agent-core').getQueueItems('pending', acctId);
    res.json({
      ...stats,
      rateLimit,
      pendingApprovals: queue.length,
      mode: modeEngine.getMode(),
    });
  });

  // ── Whitelist ──────────────────────────────────────────

  app.get('/api/whitelist', (req, res) => {
    res.json(getWhitelist());
  });

  app.post('/api/whitelist/add', (req, res) => {
    const { address, domain } = req.body;
    if (!address && !domain) {
      return res.status(400).json({ error: 'Provide address or domain' });
    }
    const result = addToWhitelist({ address, domain });
    res.json(result);
  });

  app.post('/api/whitelist/remove', (req, res) => {
    const { address, domain } = req.body;
    if (!address && !domain) {
      return res.status(400).json({ error: 'Provide address or domain' });
    }
    const result = removeFromWhitelist({ address, domain });
    res.json(result);
  });

  // ── Blacklist ──────────────────────────────────────────

  app.get('/api/blacklist', (req, res) => {
    res.json(getBlacklist(reqAccountId(req)));
  });

  app.post('/api/blacklist/add', async (req, res) => {
    const { address, domain } = req.body;
    if (!address && !domain) {
      return res.status(400).json({ error: 'Provide address or domain' });
    }
    const acctId = reqAccountId(req);
    const result = addToBlacklist({ address, domain }, acctId);
    try { logAudit({ tier: 'system', service: 'opai-email-agent', event: 'blacklist-add', status: 'completed', summary: `Blacklisted: ${address || '@' + domain}`, details: { address, domain, accountId: acctId } }); } catch (_) {}
    res.json(result);
  });

  app.post('/api/blacklist/remove', (req, res) => {
    const { address, domain } = req.body;
    if (!address && !domain) {
      return res.status(400).json({ error: 'Provide address or domain' });
    }
    const result = removeFromBlacklist({ address, domain }, reqAccountId(req));
    res.json(result);
  });

  // ── Trash ──────────────────────────────────────────────

  app.post('/api/trash', async (req, res) => {
    const { emailId, sender, subject } = req.body;
    if (!emailId) return res.status(400).json({ error: 'emailId required' });
    const acctId = reqAccountId(req);

    // Record manual trash
    const entry = classificationEngine.manualTrash(emailId, sender, subject, acctId);

    // Attempt immediate IMAP move
    try {
      const { getEmailMeta, setEnvBridgeForAccount } = require('./agent-core');
      const meta = getEmailMeta(emailId);
      if (meta?.uid) {
        const account = modeEngine.getAccountById(acctId) || modeEngine.getActiveAccount();
        setEnvBridgeForAccount(account);
        const { moveToTrash } = require('../email-checker/sender');
        await moveToTrash(meta.uid, meta.folder || 'INBOX', '');
      }
    } catch (err) {
      console.error('[EMAIL-AGENT] Manual trash IMAP move failed:', err.message);
    }

    actionLogger.logAction({
      accountId: acctId,
      action: 'manual-trash',
      emailId,
      sender,
      subject,
      reasoning: `Manual trash: ${sender}. Pattern recorded.`,
      mode: modeEngine.getMode(),
    });

    res.json({ success: true, entry });
  });

  app.post('/api/trash/undo', (req, res) => {
    const { emailId } = req.body;
    if (!emailId) return res.status(400).json({ error: 'emailId required' });
    const acctId = reqAccountId(req);
    const removed = classificationEngine.removeManualTrash(emailId, acctId);
    if (!removed) return res.status(404).json({ error: 'Entry not found' });
    actionLogger.logAction({
      accountId: acctId,
      action: 'trash-undo',
      emailId,
      sender: removed.sender,
      subject: removed.subject,
      reasoning: 'Manual trash undone by admin.',
      mode: modeEngine.getMode(),
    });
    res.json({ success: true });
  });

  app.get('/api/trash/pending', (req, res) => {
    const items = classificationEngine.getPendingAutoTrash(reqAccountId(req));
    res.json({ items });
  });

  app.post('/api/trash/:id/override', (req, res) => {
    const entry = classificationEngine.overrideAutoTrash(req.params.id, reqAccountId(req));
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    actionLogger.logAction({
      accountId: reqAccountId(req),
      action: 'trash-override',
      emailId: entry.emailId,
      sender: entry.sender,
      subject: entry.subject,
      reasoning: `Auto-trash overridden (rescued) by admin.`,
      mode: modeEngine.getMode(),
    });
    res.json({ success: true, entry });
  });

  // ── Classifications ───────────────────────────────────

  app.get('/api/classifications', (req, res) => {
    const classifications = classificationEngine.getClassifications(reqAccountId(req));
    res.json({ classifications });
  });

  app.post('/api/classifications', (req, res) => {
    const { name, color } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const cls = classificationEngine.createClassification({ name, color }, reqAccountId(req));
    res.json(cls);
  });

  app.delete('/api/classifications/:id', (req, res) => {
    const result = classificationEngine.deleteClassification(req.params.id, reqAccountId(req));
    if (!result.success) return res.status(404).json({ error: 'Not found' });
    res.json(result);
  });

  app.post('/api/classifications/:id/assign', async (req, res) => {
    const { emailId, sender, subject, tags, needsReply, actions } = req.body;
    if (!emailId) return res.status(400).json({ error: 'emailId required' });
    const acctId = reqAccountId(req);
    const result = classificationEngine.assignToClassification(
      req.params.id,
      { emailId, sender, subject, tags },
      acctId
    );
    if (!result.success) return res.status(400).json(result);

    // Log classification action
    const cls = classificationEngine.getClassifications(acctId).find(c => c.id === req.params.id);
    const actionParts = [];
    if (needsReply) actionParts.push('needs reply');
    if (actions?.length) actionParts.push(actions.map(a => a.type).join(', '));
    actionLogger.logAction({
      accountId: acctId,
      action: 'classify',
      emailId,
      sender,
      subject,
      reasoning: `Manually classified as "${cls?.name || req.params.id}"` + (actionParts.length ? ` (${actionParts.join('; ')})` : ''),
      mode: modeEngine.getMode(),
      details: { classificationId: req.params.id, classificationName: cls?.name, needsReply: !!needsReply, actions: actions || [] },
    });

    const { getEmailMeta, setEnvBridgeForAccount, addToQueue } = require('./agent-core');
    const meta = getEmailMeta(emailId);
    const account = modeEngine.getAccountById(acctId) || modeEngine.getActiveAccount();

    // ── Needs Reply → draft generation ──
    if (needsReply && meta) {
      try {
        const { draftResponse } = require('../email-checker/response-drafter');
        const feedbackEngine = require('./feedback-engine');
        const feedbackContext = feedbackEngine.buildPromptContext(sender, acctId);
        const voiceProfile = account.voiceProfile || 'paradise-web-agent';

        setEnvBridgeForAccount(account);
        const draft = await draftResponse(
          {
            from: sender,
            fromName: meta.from || sender,
            subject: subject || meta.subject,
            text: (meta.bodyPreview || '') + feedbackContext,
            date: meta.date,
          },
          account.name || 'Agent',
          voiceProfile
        );

        if (draft) {
          addToQueue({
            accountId: acctId,
            emailId,
            uid: meta.uid,
            folder: meta.folder,
            sender,
            subject: subject || meta.subject,
            draft: draft.finalContent || draft.refinedDraft || draft.initialDraft,
            draftId: draft.id,
            reason: 'Needs reply (manual classification)',
          });

          actionLogger.logAction({
            accountId: acctId,
            action: 'queue',
            emailId,
            sender,
            subject,
            reasoning: `Draft queued from manual classification (needs reply).`,
            mode: modeEngine.getMode(),
            details: { draftId: draft.id, draftPreview: (draft.finalContent || draft.refinedDraft || '').slice(0, 200) },
          });
        }
      } catch (err) {
        console.error('[EMAIL-AGENT] Needs-reply draft generation failed:', err.message);
      }
    }

    // ── Needs Action — execute each action ──
    if (Array.isArray(actions) && actions.length > 0) {
      for (const act of actions) {
        try {
          if (act.type === 'move-to-folder' && act.folder && meta?.uid) {
            setEnvBridgeForAccount(account);
            const { moveToFolder } = require('../email-checker/sender');
            await moveToFolder(meta.uid, meta.folder || 'INBOX', act.folder, '');
            actionLogger.logAction({
              accountId: acctId, action: 'organize', emailId, sender, subject,
              reasoning: `Moved to folder: ${act.folder}`,
              mode: modeEngine.getMode(),
              details: { actionType: 'move-to-folder', folder: act.folder },
            });
          }

          if (act.type === 'forward-to' && act.email && meta?.uid) {
            setEnvBridgeForAccount(account);
            const { forwardEmail } = require('../email-checker/sender');
            await forwardEmail(meta.uid, meta.folder || 'INBOX', act.email, '');
            actionLogger.logAction({
              accountId: acctId, action: 'organize', emailId, sender, subject,
              reasoning: `Forwarded to: ${act.email}`,
              mode: modeEngine.getMode(),
              details: { actionType: 'forward-to', forwardTo: act.email },
            });
          }

          if (act.type === 'delete-after') {
            const multiplier = act.unit === 'weeks' ? 7 : act.unit === 'months' ? 30 : 1;
            const deleteAfterMs = (act.value || 30) * multiplier * 24 * 60 * 60 * 1000;
            const deleteAt = new Date(Date.now() + deleteAfterMs).toISOString();
            classificationEngine.scheduleDelete(emailId, deleteAt, acctId);
            actionLogger.logAction({
              accountId: acctId, action: 'organize', emailId, sender, subject,
              reasoning: `Scheduled deletion: ${act.value} ${act.unit}`,
              mode: modeEngine.getMode(),
              details: { actionType: 'delete-after', deleteAt, value: act.value, unit: act.unit },
            });
          }

          if (act.type === 'create-task') {
            try {
              const http = require('http');
              const excerpt = (meta?.bodyPreview || subject || '').slice(0, 300);
              const taskTitle = `Email: ${(subject || '(no subject)').slice(0, 80)}`;
              const taskDesc = `From: ${sender}\nSubject: ${subject}\n\n${excerpt}\n\n[Email ID: ${emailId}]`;
              const qs = new URLSearchParams({
                user_id: 'service-role',
                workspace_type: 'personal',
                type: 'task',
                title: taskTitle,
                description: taskDesc,
                source: 'email-agent',
                priority: 'medium',
              });
              const url = `http://localhost:8089/hub/api/internal/create-item?${qs.toString()}`;
              await new Promise((resolve, reject) => {
                const r = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (resp) => {
                  let body = '';
                  resp.on('data', c => body += c);
                  resp.on('end', () => resolve(body));
                });
                r.on('error', reject);
                r.end('{}');
              });
              actionLogger.logAction({
                accountId: acctId, action: 'organize', emailId, sender, subject,
                reasoning: `Created TeamHub task: ${taskTitle}`,
                mode: modeEngine.getMode(),
                details: { actionType: 'create-task', taskTitle },
              });
            } catch (taskErr) {
              console.error('[EMAIL-AGENT] TeamHub task creation failed:', taskErr.message);
            }
          }
        } catch (actErr) {
          console.error(`[EMAIL-AGENT] Action ${act.type} failed:`, actErr.message);
        }
      }
    }

    res.json(result);
  });

  app.post('/api/classifications/:id/unassign', (req, res) => {
    const { emailId } = req.body;
    if (!emailId) return res.status(400).json({ error: 'emailId required' });
    const acctId = reqAccountId(req);
    const result = classificationEngine.unassignFromClassification(
      req.params.id,
      emailId,
      acctId
    );
    if (!result.success) return res.status(400).json(result);
    actionLogger.logAction({
      accountId: acctId,
      action: 'classify-undo',
      emailId,
      reasoning: 'Classification removed by admin.',
      mode: modeEngine.getMode(),
    });
    res.json(result);
  });

  // ── Reprocess ──────────────────────────────────────────

  app.post('/api/reprocess', async (req, res) => {
    const { sender, domain, draftGuidance } = req.body;
    if (!sender && !domain) {
      return res.status(400).json({ error: 'Provide sender or domain' });
    }
    try {
      const { unmarkProcessed, runCycle } = require('./agent-core');
      const unmark = unmarkProcessed({ sender, domain });
      console.log(`[EMAIL-AGENT] Recompose: unmarked ${unmark.removed} entries for ${sender || '@' + domain}`);
      const cycle = await runCycle({ fetchAll: true, draftGuidance });
      broadcastSSE('cycle', cycle);
      res.json({ success: true, removed: unmark.removed, messageIds: unmark.messageIds, cycle });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Recompose single email with guidance ──────────────

  app.post('/api/recompose', async (req, res) => {
    const { emailId, sender, subject, draftGuidance } = req.body;
    if (!emailId) return res.status(400).json({ error: 'emailId required' });
    const acctId = reqAccountId(req);

    try {
      const { getEmailMeta, setEnvBridgeForAccount, addToQueue } = require('./agent-core');
      const meta = getEmailMeta(emailId);
      if (!meta) return res.status(404).json({ error: 'Email metadata not found' });

      const account = modeEngine.getAccountById(acctId) || modeEngine.getActiveAccount();
      setEnvBridgeForAccount(account);

      const { draftResponse, getResponse } = require('../email-checker/response-drafter');
      const { saveDraftToAccount } = require('../email-checker/sender');
      const feedbackEngine = require('./feedback-engine');
      const feedbackContext = feedbackEngine.buildPromptContext(sender, acctId);
      const voiceProfile = account.voiceProfile || 'paradise-web-agent';

      // Build email body with guidance prepended
      let bodyText = meta.bodyPreview || '';
      if (feedbackContext) bodyText += feedbackContext;
      if (draftGuidance) bodyText = '[DRAFT GUIDANCE FROM ADMIN: ' + draftGuidance + ']\n\n' + bodyText;

      // draftResponse returns a responseId string, not an object
      const responseId = await draftResponse(
        {
          from: sender || meta.from,
          fromName: meta.fromName || meta.from || sender,
          subject: subject || meta.subject,
          text: bodyText,
          date: meta.date,
        },
        account.name || 'Agent',
        voiceProfile
      );

      if (responseId) {
        const draft = getResponse(responseId);
        const draftContent = draft ? (draft.refinedDraft || draft.initialDraft || '') : '';
        const draftSubject = draft ? draft.subject : ('Re: ' + (subject || meta.subject || '').replace(/^Re:\s*/i, ''));

        // Save draft to Gmail drafts folder via IMAP
        try {
          const saveResult = await saveDraftToAccount({
            refinedDraft: draftContent,
            subject: draftSubject,
            to: sender || meta.from,
            emailMessageId: emailId,
          }, '');
          if (saveResult.success) {
            console.log('[EMAIL-AGENT] Recompose draft saved to Gmail:', saveResult.folder);
          } else {
            console.warn('[EMAIL-AGENT] Failed to save draft to Gmail:', saveResult.error);
          }
        } catch (saveErr) {
          console.warn('[EMAIL-AGENT] Gmail draft save error:', saveErr.message);
        }

        addToQueue({
          accountId: acctId,
          emailId,
          uid: meta.uid,
          folder: meta.folder,
          sender: sender || meta.from,
          subject: draftSubject,
          draft: draftContent,
          draftId: responseId,
          reason: 'Recompose' + (draftGuidance ? ': ' + draftGuidance.slice(0, 100) : ''),
        });

        actionLogger.logAction({
          accountId: acctId,
          action: 'draft',
          emailId,
          sender,
          subject,
          reasoning: 'Recompose with guidance: ' + (draftGuidance || '(none)').slice(0, 200),
          mode: modeEngine.getMode(),
          details: { draftId: responseId, draftGuidance, draftPreview: draftContent.slice(0, 200) },
        });

        res.json({ success: true, draftId: responseId });
      } else {
        res.status(500).json({ error: 'Draft generation returned empty' });
      }
    } catch (err) {
      console.error('[EMAIL-AGENT] Recompose failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Manual trigger ─────────────────────────────────────

  app.post('/api/check-now', async (req, res) => {
    if (modeEngine.isKilled()) {
      return res.status(409).json({ error: 'Agent is killed. Resume first.' });
    }
    try {
      const { runCycle } = require('./agent-core');
      const result = await runCycle();
      broadcastSSE('cycle', result);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Email metadata ─────────────────────────────────────

  app.get('/api/email-meta/:messageId', (req, res) => {
    const { getEmailMeta } = require('./agent-core');
    // messageId may contain special chars — decode it
    const id = decodeURIComponent(req.params.messageId);
    const meta = getEmailMeta(id);
    if (!meta) return res.status(404).json({ error: 'Not found' });
    res.json(meta);
  });

  // ── SSE push ───────────────────────────────────────────

  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write('event: connected\ndata: {"ok":true}\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  // ── Alerts ─────────────────────────────────────────────

  app.get('/api/alerts', (req, res) => {
    const { loadAlerts } = require('./agent-core');
    const data = loadAlerts();
    const acctId = reqAccountId(req);
    const alerts = (data.alerts || [])
      .filter(a => !a.dismissed)
      .filter(a => a.accountId === acctId || !a.accountId);
    res.json({ alerts });
  });

  app.post('/api/alerts/:id/dismiss', (req, res) => {
    const fs = require('fs');
    const ALERTS_PATH = path.join(__dirname, 'data', 'alerts.json');
    try {
      const data = JSON.parse(fs.readFileSync(ALERTS_PATH, 'utf8'));
      const alert = (data.alerts || []).find(a => a.id === req.params.id);
      if (!alert) return res.status(404).json({ error: 'Alert not found' });
      alert.dismissed = true;
      alert.dismissedAt = new Date().toISOString();
      fs.writeFileSync(ALERTS_PATH, JSON.stringify(data, null, 2));
      res.json({ success: true });
    } catch {
      res.status(404).json({ error: 'Alert not found' });
    }
  });

  // ── Compose ────────────────────────────────────────────

  app.post('/api/compose', async (req, res) => {
    const { to, subject, body } = req.body;
    if (!to || !subject || !body) {
      return res.status(400).json({ error: 'to, subject, and body are required' });
    }
    try {
      const { sendResponse } = require('../email-checker/sender');
      const { setEnvBridge } = require('./agent-core');
      setEnvBridge();
      await sendResponse({ to, subject, finalContent: body, emailMessageId: null }, '');
      actionLogger.logAction({
        accountId: reqAccountId(req),
        action: 'send',
        sender: to,
        subject,
        reasoning: 'Manual compose from admin UI.',
        mode: modeEngine.getMode(),
      });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── ARL (Agent Response Loop) ────────────────────────────

  // ARL config (enabled, model, timeouts)
  app.get('/api/arl/config', (req, res) => {
    res.json(arlSkillRunner.getArlConfig());
  });

  // Toggle ARL on/off
  app.post('/api/arl/toggle', (req, res) => {
    const { enabled } = req.body;
    const result = arlSkillRunner.setArlEnabled(!!enabled);
    try { logAudit({ tier: 'system', service: 'opai-email-agent', event: 'arl-toggle', status: 'completed', summary: `ARL ${enabled ? 'enabled' : 'disabled'}` }); } catch (_) {}
    res.json({ success: true, arlEnabled: result });
  });

  // List all skills
  app.get('/api/arl/skills', (req, res) => {
    res.json({ skills: arlSkillRunner.getAllSkills() });
  });

  // Get single skill
  app.get('/api/arl/skills/:id', (req, res) => {
    const skill = arlSkillRunner.getSkillById(req.params.id);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    res.json(skill);
  });

  // Add a new skill
  app.post('/api/arl/skills', (req, res) => {
    const skill = arlSkillRunner.addSkill(req.body);
    res.json({ success: true, skill });
  });

  // Toggle skill enabled/disabled
  app.patch('/api/arl/skills/:id/toggle', (req, res) => {
    const { enabled } = req.body;
    const skill = arlSkillRunner.toggleSkill(req.params.id, !!enabled);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    res.json({ success: true, skill });
  });

  // Delete a skill (non-builtIn only)
  app.delete('/api/arl/skills/:id', (req, res) => {
    const deleted = arlSkillRunner.deleteSkill(req.params.id);
    if (!deleted) return res.status(400).json({ error: 'Cannot delete (built-in or not found)' });
    res.json({ success: true });
  });

  // Active conversations
  app.get('/api/arl/conversations', (req, res) => {
    res.json({ conversations: arlConversation.listActiveConversations() });
  });

  // ARL execution history
  app.get('/api/arl/history', (req, res) => {
    const limit = parseInt(req.query.limit || '50', 10);
    res.json({ history: arlConversation.getArlHistory(limit) });
  });

  // ── Approval Gate (system changes via Telegram) ──────────

  app.get('/api/approval/pending', (req, res) => {
    const { listPendingApprovals } = require('./telegram-gate');
    res.json({ approvals: listPendingApprovals() });
  });

  app.post('/api/approval/:id/execute', async (req, res) => {
    const { resolveApproval, getApproval } = require('./telegram-gate');
    const approval = getApproval(req.params.id);
    if (!approval) return res.status(404).json({ error: 'Approval not found or expired' });

    // Mark as approved
    resolveApproval(req.params.id, 'approved');

    // Log the approval
    actionLogger.logAction({
      action: 'system-change-approved',
      sender: approval.requester,
      subject: approval.emailSubject,
      reasoning: `System change approved via Telegram: ${approval.summary.slice(0, 200)}`,
      mode: 'arl',
      details: { requestId: req.params.id, approvedBy: 'telegram-admin' },
    });

    try {
      logAudit({
        tier: 'execution',
        service: 'opai-email-agent',
        event: 'system-change-approved',
        status: 'completed',
        summary: `System change approved: ${approval.emailSubject}`,
        details: { requestId: req.params.id, requester: approval.requester },
      });
    } catch {}

    // Send confirmation email back to requester
    try {
      const { sendResponse } = require('../email-checker/sender');
      const { setEnvBridgeForAccount } = require('./agent-core');
      const account = modeEngine.getAccountById('acc-paradise') || modeEngine.getActiveAccount();
      setEnvBridgeForAccount(account);

      await sendResponse({
        to: approval.requester,
        subject: `Re: ${approval.emailSubject}`,
        finalContent: `Your system change request has been approved by the admin.\n\nRequest: ${approval.summary}\n\nThe change will be implemented. You'll be notified when complete.\n\n— OPAI Agent`,
        emailMessageId: null,
      }, '');
    } catch (err) {
      console.error('[APPROVAL] Email notification failed:', err.message);
    }

    res.json({ success: true, approval });
  });

  app.post('/api/approval/:id/reject', async (req, res) => {
    const { resolveApproval, getApproval } = require('./telegram-gate');
    const approval = getApproval(req.params.id);
    if (!approval) return res.status(404).json({ error: 'Approval not found or expired' });

    resolveApproval(req.params.id, 'rejected');

    actionLogger.logAction({
      action: 'system-change-rejected',
      sender: approval.requester,
      subject: approval.emailSubject,
      reasoning: `System change rejected via Telegram: ${approval.summary.slice(0, 200)}`,
      mode: 'arl',
      details: { requestId: req.params.id, rejectedBy: 'telegram-admin' },
    });

    try {
      logAudit({
        tier: 'execution',
        service: 'opai-email-agent',
        event: 'system-change-rejected',
        status: 'completed',
        summary: `System change rejected: ${approval.emailSubject}`,
        details: { requestId: req.params.id, requester: approval.requester },
      });
    } catch {}

    // Send rejection email
    try {
      const { sendResponse } = require('../email-checker/sender');
      const { setEnvBridgeForAccount } = require('./agent-core');
      const account = modeEngine.getAccountById('acc-paradise') || modeEngine.getActiveAccount();
      setEnvBridgeForAccount(account);

      await sendResponse({
        to: approval.requester,
        subject: `Re: ${approval.emailSubject}`,
        finalContent: `Your system change request has been reviewed and was not approved at this time.\n\nRequest: ${approval.summary}\n\nPlease reach out to discuss further if needed.\n\n— OPAI Agent`,
        emailMessageId: null,
      }, '');
    } catch (err) {
      console.error('[APPROVAL] Rejection email failed:', err.message);
    }

    res.json({ success: true, approval });
  });

  // ── Classify Test ──────────────────────────────────────

  app.post('/api/classify-test', async (req, res) => {
    const { from, subject, body } = req.body;
    if (!from || !subject) return res.status(400).json({ error: 'from and subject required' });
    try {
      const { classifyEmail } = require('../email-checker/classifier');
      const fs = require('fs');
      const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
      const result = await classifyEmail(from, subject, body || '', config.account?.name || 'Agent');
      res.json({ classification: result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Bulk Actions ───────────────────────────────────────

  app.post('/api/bulk/clear-queue', (req, res) => {
    const { getQueueItems, updateQueueItem } = require('./agent-core');
    const pending = getQueueItems('pending', reqAccountId(req));
    for (const item of pending) {
      updateQueueItem(item.id, { status: 'rejected', rejectReason: 'Bulk cleared by admin' });
    }
    actionLogger.logAction({
      action: 'reject',
      reasoning: `Bulk cleared ${pending.length} pending queue items.`,
      mode: modeEngine.getMode(),
    });
    res.json({ success: true, cleared: pending.length });
  });

  return app;
}

module.exports = { createAuditServer, broadcastSSE };
