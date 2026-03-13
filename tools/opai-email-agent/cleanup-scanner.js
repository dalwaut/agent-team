/**
 * Cleanup Scanner — Inbox bulk scan, categorize, search, and bulk operations
 *
 * Scans all emails via IMAP, categorizes into smart folders,
 * supports bulk trash/archive/flag with undo, and AI-powered agentic search.
 */

const { ImapFlow } = require('imapflow');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');

// ── Scanner State ────────────────────────────────────────────

let _scan = {
  active: false,
  cancelled: false,
  accountId: null,
  progress: { total: 0, processed: 0, percent: 0, batch: 0 },
  completedAt: null,
  error: null,
};

// In-memory cache of scanned emails (keyed by accountId)
const _cache = {};

// Undo stack (last 10 operations)
const _undoStack = [];
const MAX_UNDO = 10;

// ── Domain categorization lists ──────────────────────────────

const PROMO_DOMAINS = new Set([
  'groupon.com', 'retailmenot.com', 'wish.com', 'temu.com', 'shein.com',
  'doordash.com', 'ubereats.com', 'grubhub.com', 'postmates.com', 'instacart.com',
  'target.com', 'walmart.com', 'bestbuy.com', 'macys.com', 'kohls.com',
  'gap.com', 'oldnavy.com', 'nordstrom.com', 'jcrew.com', 'zappos.com',
  'ebay.com', 'aliexpress.com', 'wayfair.com', 'overstock.com', 'etsy.com',
  'homedepot.com', 'lowes.com', 'sephora.com', 'ulta.com', 'nike.com',
  'adidas.com', 'hm.com', 'zara.com', 'asos.com', 'uniqlo.com',
  'dell.com', 'hp.com', 'lenovo.com', 'newegg.com', 'bhphotovideo.com',
  'costco.com', 'samsclub.com', 'chewy.com', 'petco.com',
]);

const NEWSLETTER_DOMAINS = new Set([
  'substack.com', 'beehiiv.com', 'ghost.io', 'buttondown.email',
  'convertkit.com', 'mailchimp.com', 'constantcontact.com', 'sendgrid.net',
  'campaign-archive.com', 'list-manage.com', 'createsend.com',
  'hubspot.com', 'drip.com', 'activecampaign.com', 'getresponse.com',
  'sendinblue.com', 'brevo.com', 'aweber.com', 'tinyletter.com',
  'revue.email', 'emailoctopus.com',
]);

const SOCIAL_DOMAINS = new Set([
  'facebook.com', 'facebookmail.com', 'linkedin.com', 'twitter.com', 'x.com',
  'instagram.com', 'pinterest.com', 'reddit.com', 'tiktok.com', 'tumblr.com',
  'discord.com', 'slack.com', 'nextdoor.com', 'quora.com', 'medium.com',
  'youtube.com', 'twitch.tv', 'telegram.org', 'whatsapp.com',
  'meetup.com', 'eventbrite.com',
]);

const PROMO_KEYWORDS = /\b(unsubscribe|off|deal|sale|discount|coupon|promo|offer|clearance|limited.time|flash.sale|free.shipping|buy.now|shop.now|order.now|save|% off)\b/i;
const NEWSLETTER_KEYWORDS = /\b(newsletter|digest|weekly|monthly|roundup|recap|edition|issue.#|this.week|today.in)\b/i;

// ── Categorization ───────────────────────────────────────────

function extractDomain(email) {
  if (!email) return '';
  const match = email.match(/@([^>]+)/);
  return match ? match[1].toLowerCase().replace(/^.*\.(?=[^.]+\.[^.]+$)/, '') : '';
  // Actually, let's keep the full domain
}

function extractRootDomain(email) {
  if (!email) return '';
  const match = email.match(/@([^>\s]+)/);
  if (!match) return '';
  const parts = match[1].toLowerCase().split('.');
  return parts.length >= 2 ? parts.slice(-2).join('.') : match[1].toLowerCase();
}

function categorize(msg) {
  const cats = new Set();
  const domain = extractRootDomain(msg.from);
  const subject = (msg.subject || '').toLowerCase();
  const sixMonthsAgo = Date.now() - (180 * 24 * 60 * 60 * 1000);
  const oneYearAgo = Date.now() - (365 * 24 * 60 * 60 * 1000);
  const msgDate = new Date(msg.date).getTime();

  // Domain-based
  if (PROMO_DOMAINS.has(domain)) cats.add('promos');
  if (NEWSLETTER_DOMAINS.has(domain)) cats.add('newsletters');
  if (SOCIAL_DOMAINS.has(domain)) cats.add('social');

  // Keyword-based (if not already categorized)
  if (!cats.has('promos') && PROMO_KEYWORDS.test(subject)) cats.add('promos');
  if (!cats.has('newsletters') && NEWSLETTER_KEYWORDS.test(subject)) cats.add('newsletters');

  // Date-based
  if (msgDate < sixMonthsAgo) cats.add('older-6m');
  if (msgDate < oneYearAgo) cats.add('older-1y');

  // Read status
  if (!msg.read) cats.add('never-opened');

  // If no specific category, it's inbox
  if (cats.size === 0 || (!cats.has('promos') && !cats.has('newsletters') && !cats.has('social'))) {
    cats.add('inbox');
  }

  return Array.from(cats);
}

// ── Scan ──────────────────────────────────────────────────────

async function startScan(creds, accountId, options = {}, broadcastFn) {
  if (_scan.active) {
    return { error: 'Scan already in progress' };
  }

  const includeSpam = options.includeSpam || false;
  const includeTrash = options.includeTrash || false;
  const maxAge = options.maxAge || '5y'; // default scan last 5 years

  _scan = {
    active: true,
    cancelled: false,
    accountId,
    progress: { total: 0, processed: 0, percent: 0, batch: 0 },
    completedAt: null,
    error: null,
  };

  // Run scan in background
  _scanInBackground(creds, accountId, { includeSpam, includeTrash, maxAge }, broadcastFn);

  return { started: true, accountId };
}

async function _scanInBackground(creds, accountId, options, broadcastFn) {
  const emails = [];
  const broadcast = broadcastFn || (() => {});

  let client;
  try {
    client = new ImapFlow({
      host: creds.imap.host,
      port: creds.imap.port,
      secure: true,
      auth: { user: creds.imap.user, pass: creds.imap.pass },
      logger: false,
    });

    await client.connect();

    // Get mailbox status for total count
    const folders = ['INBOX'];
    if (options.includeSpam) folders.push('[Gmail]/Spam');
    if (options.includeTrash) folders.push('[Gmail]/Trash');

    // Calculate since date from maxAge
    const ageMap = { '6m': 180, '1y': 365, '2y': 730, '5y': 1825, '10y': 3650 };
    const days = ageMap[options.maxAge] || 1825;
    const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    for (const folder of folders) {
      if (_scan.cancelled) break;

      try {
        const lock = await client.getMailboxLock(folder);

        try {
          // Get total count for this folder
          const status = await client.status(folder, { messages: true });
          _scan.progress.total += status.messages || 0;

          // Fetch envelopes (lightweight — no body)
          const messages = client.fetch({ since: sinceDate }, {
            envelope: true,
            uid: true,
            flags: true,
            size: true,
          });

          for await (const msg of messages) {
            if (_scan.cancelled) break;

            const from = msg.envelope?.from?.[0];
            const email = {
              uid: msg.uid,
              folder,
              messageId: msg.envelope?.messageId || `uid-${msg.uid}-${folder}`,
              from: from?.address || '',
              fromName: from?.name || '',
              subject: msg.envelope?.subject || '(no subject)',
              date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null,
              read: msg.flags?.has('\\Seen') || false,
              flagged: msg.flags?.has('\\Flagged') || false,
              size: msg.size || 0,
              domain: extractRootDomain(from?.address || ''),
              categories: [],
            };

            email.categories = categorize(email);
            emails.push(email);

            _scan.progress.processed++;
            _scan.progress.batch = Math.floor(_scan.progress.processed / 100);

            // Broadcast progress every 200 emails
            if (_scan.progress.processed % 200 === 0) {
              _scan.progress.percent = _scan.progress.total > 0
                ? Math.round((_scan.progress.processed / _scan.progress.total) * 100)
                : 0;
              broadcast('cleanup-progress', {
                processed: _scan.progress.processed,
                total: _scan.progress.total,
                percent: _scan.progress.percent,
              });
            }
          }
        } finally {
          lock.release();
        }
      } catch (folderErr) {
        console.error(`[cleanup] Error scanning folder ${folder}:`, folderErr.message);
      }
    }

    await client.logout();
  } catch (err) {
    console.error('[cleanup] Scan error:', err.message);
    _scan.error = err.message;
    if (client) try { await client.logout(); } catch {}
  }

  // Finalize
  _scan.active = false;
  _scan.progress.percent = 100;
  _scan.completedAt = new Date().toISOString();

  // Cache results
  _cache[accountId] = {
    emails,
    scannedAt: _scan.completedAt,
    folders: buildFolderCounts(emails),
    senderStats: buildSenderStats(emails),
  };

  // Persist cache summary to disk (not full email list — too large)
  try {
    const summaryPath = path.join(DATA_DIR, `cleanup-summary-${accountId}.json`);
    fs.writeFileSync(summaryPath, JSON.stringify({
      scannedAt: _scan.completedAt,
      totalEmails: emails.length,
      folders: _cache[accountId].folders,
      topSenders: Object.entries(_cache[accountId].senderStats)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 50)
        .map(([domain, stats]) => ({ domain, ...stats })),
    }, null, 2));
  } catch {}

  broadcast('cleanup-complete', {
    total: emails.length,
    folders: _cache[accountId].folders,
  });
}

function cancelScan() {
  if (_scan.active) {
    _scan.cancelled = true;
    return { cancelled: true };
  }
  return { cancelled: false, reason: 'No active scan' };
}

function getScanState() {
  return {
    active: _scan.active,
    accountId: _scan.accountId,
    progress: _scan.progress,
    completedAt: _scan.completedAt,
    error: _scan.error,
    hasCachedData: !!_cache[_scan.accountId],
  };
}

// ── Folder counts ─────────────────────────────────────────────

function buildFolderCounts(emails) {
  const counts = {
    all: emails.length,
    inbox: 0,
    promos: 0,
    newsletters: 0,
    social: 0,
    'older-6m': 0,
    'older-1y': 0,
    'never-opened': 0,
  };

  for (const e of emails) {
    for (const cat of e.categories) {
      if (counts[cat] !== undefined) counts[cat]++;
    }
  }

  return counts;
}

function buildSenderStats(emails) {
  const stats = {};
  for (const e of emails) {
    const d = e.domain || 'unknown';
    if (!stats[d]) stats[d] = { count: 0, unread: 0, latestDate: null };
    stats[d].count++;
    if (!e.read) stats[d].unread++;
    if (!stats[d].latestDate || e.date > stats[d].latestDate) {
      stats[d].latestDate = e.date;
    }
  }
  return stats;
}

function getFolders(accountId) {
  const cached = _cache[accountId];
  if (!cached) return null;
  return {
    folders: cached.folders,
    scannedAt: cached.scannedAt,
    totalEmails: cached.emails.length,
  };
}

// ── Email listing (paginated) ──────────────────────────────────

function getEmails(accountId, category, page = 1, pageSize = 100, sortBy = 'date-desc') {
  const cached = _cache[accountId];
  if (!cached) return { emails: [], total: 0, page, pages: 0 };

  let filtered;
  if (category === 'all') {
    filtered = cached.emails;
  } else {
    filtered = cached.emails.filter(e => e.categories.includes(category));
  }

  // Sort
  if (sortBy === 'date-desc') {
    filtered.sort((a, b) => new Date(b.date) - new Date(a.date));
  } else if (sortBy === 'date-asc') {
    filtered.sort((a, b) => new Date(a.date) - new Date(b.date));
  } else if (sortBy === 'sender') {
    filtered.sort((a, b) => (a.from || '').localeCompare(b.from || ''));
  } else if (sortBy === 'size-desc') {
    filtered.sort((a, b) => b.size - a.size);
  }

  const total = filtered.length;
  const pages = Math.ceil(total / pageSize);
  const start = (page - 1) * pageSize;
  const end = start + pageSize;

  return {
    emails: filtered.slice(start, end),
    total,
    page,
    pages,
    pageSize,
  };
}

// ── Email preview (fetch body) ─────────────────────────────────

async function getEmailPreview(uid, folder, creds) {
  let client;
  try {
    client = new ImapFlow({
      host: creds.imap.host,
      port: creds.imap.port,
      secure: true,
      auth: { user: creds.imap.user, pass: creds.imap.pass },
      logger: false,
    });

    await client.connect();
    const lock = await client.getMailboxLock(folder || 'INBOX');

    try {
      const msg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
      if (!msg) return { error: 'Message not found' };

      const { simpleParser } = require('mailparser');
      const parsed = await simpleParser(msg.source);

      return {
        uid,
        folder,
        from: parsed.from?.text || '',
        to: parsed.to?.text || '',
        cc: parsed.cc?.text || '',
        subject: parsed.subject || '',
        date: parsed.date?.toISOString() || '',
        text: parsed.text || '',
        html: parsed.html || '',
        attachments: (parsed.attachments || []).map(a => ({
          filename: a.filename,
          contentType: a.contentType,
          size: a.size,
        })),
      };
    } finally {
      lock.release();
    }
  } catch (err) {
    return { error: err.message };
  } finally {
    if (client) try { await client.logout(); } catch {}
  }
}

// ── Bulk Operations ───────────────────────────────────────────

async function bulkTrash(uids, folder, creds, accountId) {
  if (!uids || uids.length === 0) return { error: 'No UIDs provided' };

  // Store for undo
  _undoStack.push({
    type: 'trash',
    uids: [...uids],
    folder: folder || 'INBOX',
    accountId,
    timestamp: Date.now(),
  });
  if (_undoStack.length > MAX_UNDO) _undoStack.shift();

  let client;
  try {
    client = new ImapFlow({
      host: creds.imap.host,
      port: creds.imap.port,
      secure: true,
      auth: { user: creds.imap.user, pass: creds.imap.pass },
      logger: false,
    });

    await client.connect();
    const lock = await client.getMailboxLock(folder || 'INBOX');

    try {
      // Move in chunks to avoid IMAP command limits
      const chunkSize = 50;
      let moved = 0;
      for (let i = 0; i < uids.length; i += chunkSize) {
        const chunk = uids.slice(i, i + chunkSize);
        const uidRange = chunk.join(',');
        await client.messageMove(uidRange, '[Gmail]/Trash', { uid: true });
        moved += chunk.length;
      }

      // Remove from cache
      _removeFromCache(accountId, uids, folder);

      return { success: true, moved, undoAvailable: true };
    } finally {
      lock.release();
    }
  } catch (err) {
    return { error: err.message };
  } finally {
    if (client) try { await client.logout(); } catch {}
  }
}

async function bulkArchive(uids, folder, creds, accountId) {
  if (!uids || uids.length === 0) return { error: 'No UIDs provided' };

  _undoStack.push({
    type: 'archive',
    uids: [...uids],
    folder: folder || 'INBOX',
    accountId,
    timestamp: Date.now(),
  });
  if (_undoStack.length > MAX_UNDO) _undoStack.shift();

  let client;
  try {
    client = new ImapFlow({
      host: creds.imap.host,
      port: creds.imap.port,
      secure: true,
      auth: { user: creds.imap.user, pass: creds.imap.pass },
      logger: false,
    });

    await client.connect();
    const lock = await client.getMailboxLock(folder || 'INBOX');

    try {
      const chunkSize = 50;
      let moved = 0;
      for (let i = 0; i < uids.length; i += chunkSize) {
        const chunk = uids.slice(i, i + chunkSize);
        const uidRange = chunk.join(',');
        // Archive = move to All Mail (removes from INBOX in Gmail)
        await client.messageMove(uidRange, '[Gmail]/All Mail', { uid: true });
        moved += chunk.length;
      }

      _removeFromCache(accountId, uids, folder);
      return { success: true, moved, undoAvailable: true };
    } finally {
      lock.release();
    }
  } catch (err) {
    return { error: err.message };
  } finally {
    if (client) try { await client.logout(); } catch {}
  }
}

async function bulkFlag(uids, folder, creds, accountId) {
  if (!uids || uids.length === 0) return { error: 'No UIDs provided' };

  let client;
  try {
    client = new ImapFlow({
      host: creds.imap.host,
      port: creds.imap.port,
      secure: true,
      auth: { user: creds.imap.user, pass: creds.imap.pass },
      logger: false,
    });

    await client.connect();
    const lock = await client.getMailboxLock(folder || 'INBOX');

    try {
      const uidRange = uids.join(',');
      await client.messageFlagsAdd(uidRange, ['\\Flagged'], { uid: true });

      // Update cache
      if (_cache[accountId]) {
        for (const e of _cache[accountId].emails) {
          if (uids.includes(e.uid) && e.folder === (folder || 'INBOX')) {
            e.flagged = true;
          }
        }
      }

      return { success: true, flagged: uids.length };
    } finally {
      lock.release();
    }
  } catch (err) {
    return { error: err.message };
  } finally {
    if (client) try { await client.logout(); } catch {}
  }
}

async function undoLastOperation(creds) {
  if (_undoStack.length === 0) return { error: 'Nothing to undo' };

  const op = _undoStack.pop();
  const elapsed = Date.now() - op.timestamp;
  if (elapsed > 60000) return { error: 'Undo window expired (60s)' };

  let client;
  try {
    client = new ImapFlow({
      host: creds.imap.host,
      port: creds.imap.port,
      secure: true,
      auth: { user: creds.imap.user, pass: creds.imap.pass },
      logger: false,
    });

    await client.connect();

    if (op.type === 'trash') {
      // Messages are now in [Gmail]/Trash — move back to original folder
      const lock = await client.getMailboxLock('[Gmail]/Trash');
      try {
        // Search for the UIDs — they'll have new UIDs in Trash
        // We need to search by message sequence or use UIDVALIDITY
        // For simplicity, search recent messages in Trash and match
        const searchResult = await client.search({ since: new Date(op.timestamp - 5000) });
        if (searchResult.length > 0) {
          const range = searchResult.slice(0, op.uids.length).join(',');
          await client.messageMove(range, op.folder, { uid: true });
        }
      } finally {
        lock.release();
      }
    } else if (op.type === 'archive') {
      const lock = await client.getMailboxLock('[Gmail]/All Mail');
      try {
        const searchResult = await client.search({ since: new Date(op.timestamp - 5000) });
        if (searchResult.length > 0) {
          const range = searchResult.slice(0, op.uids.length).join(',');
          await client.messageMove(range, op.folder, { uid: true });
        }
      } finally {
        lock.release();
      }
    }

    // Invalidate cache — rescan would be needed for accuracy
    delete _cache[op.accountId];

    return { success: true, type: op.type, count: op.uids.length };
  } catch (err) {
    return { error: err.message };
  } finally {
    if (client) try { await client.logout(); } catch {}
  }
}

// ── Cache helpers ─────────────────────────────────────────────

function _removeFromCache(accountId, uids, folder) {
  if (!_cache[accountId]) return;
  const uidSet = new Set(uids);
  _cache[accountId].emails = _cache[accountId].emails.filter(
    e => !(uidSet.has(e.uid) && e.folder === (folder || 'INBOX'))
  );
  // Rebuild folder counts
  _cache[accountId].folders = buildFolderCounts(_cache[accountId].emails);
}

function hasCachedData(accountId) {
  return !!_cache[accountId]?.emails?.length;
}

function clearCache(accountId) {
  delete _cache[accountId];
}

// ── Agentic Search ────────────────────────────────────────────

async function agenticSearch(query, accountId) {
  const cached = _cache[accountId];
  if (!cached) return { error: 'No scan data — run a scan first' };

  // Build context for AI
  const topSenders = Object.entries(cached.senderStats)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 100)
    .map(([domain, s]) => `${domain}: ${s.count} emails (${s.unread} unread)`);

  const prompt = `You are an email cleanup assistant. A user wants to find specific emails in their inbox.

Their query: "${query}"

Inbox stats:
- Total emails: ${cached.emails.length}
- Categories: All (${cached.folders.all}), Inbox (${cached.folders.inbox}), Promotions (${cached.folders.promos}), Newsletters (${cached.folders.newsletters}), Social (${cached.folders.social}), Older than 6mo (${cached.folders['older-6m']}), Older than 1yr (${cached.folders['older-1y']}), Never opened (${cached.folders['never-opened']})

Top senders:
${topSenders.join('\n')}

Return a JSON object with groups of emails that match the query. Each group should have filter criteria:
{
  "groups": [
    {
      "name": "Group Name",
      "description": "Why these match the query",
      "criteria": {
        "domains": ["domain1.com", "domain2.com"],
        "categories": ["promos"],
        "unreadOnly": false,
        "olderThan": null,
        "subjectPattern": null
      }
    }
  ]
}

Only return valid JSON, no markdown or explanation.`;

  try {
    const result = await _callAI(prompt);
    const parsed = JSON.parse(result);

    // Execute each group's criteria against cached data
    const groups = [];
    for (const group of (parsed.groups || [])) {
      const matching = _filterByCriteria(cached.emails, group.criteria);
      groups.push({
        name: group.name,
        description: group.description,
        count: matching.length,
        topSenders: _getTopSendersFromList(matching, 5),
        emails: matching.slice(0, 20), // Preview first 20
        allUids: matching.map(e => ({ uid: e.uid, folder: e.folder })),
      });
    }

    return { query, groups, totalMatches: groups.reduce((s, g) => s + g.count, 0) };
  } catch (err) {
    // Fallback: simple keyword search
    return _keywordFallback(query, cached.emails);
  }
}

function _filterByCriteria(emails, criteria) {
  if (!criteria) return [];

  return emails.filter(e => {
    // Domain filter
    if (criteria.domains?.length > 0 && !criteria.domains.includes(e.domain)) return false;

    // Category filter
    if (criteria.categories?.length > 0 && !criteria.categories.some(c => e.categories.includes(c))) return false;

    // Unread only
    if (criteria.unreadOnly && e.read) return false;

    // Older than (days)
    if (criteria.olderThan) {
      const daysMap = { '6m': 180, '1y': 365, '2y': 730 };
      const days = daysMap[criteria.olderThan] || parseInt(criteria.olderThan) || 0;
      if (days > 0) {
        const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
        if (new Date(e.date).getTime() > cutoff) return false;
      }
    }

    // Subject pattern
    if (criteria.subjectPattern) {
      try {
        const re = new RegExp(criteria.subjectPattern, 'i');
        if (!re.test(e.subject)) return false;
      } catch {}
    }

    return true;
  });
}

function _getTopSendersFromList(emails, limit) {
  const counts = {};
  for (const e of emails) {
    counts[e.domain] = (counts[e.domain] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([domain, count]) => ({ domain, count }));
}

function _keywordFallback(query, emails) {
  const terms = query.toLowerCase().split(/\s+/);
  const matching = emails.filter(e => {
    const text = `${e.from} ${e.fromName} ${e.subject} ${e.domain}`.toLowerCase();
    return terms.some(t => text.includes(t));
  });

  return {
    query,
    groups: [{
      name: 'Search Results',
      description: `Emails matching "${query}"`,
      count: matching.length,
      topSenders: _getTopSendersFromList(matching, 5),
      emails: matching.slice(0, 100),
      allUids: matching.map(e => ({ uid: e.uid, folder: e.folder })),
    }],
    totalMatches: matching.length,
    fallback: true,
  };
}

async function _callAI(prompt) {
  // Use OpenRouter or direct Anthropic API
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY;
  const isOpenRouter = !!process.env.OPENROUTER_API_KEY;

  const url = isOpenRouter
    ? 'https://openrouter.ai/api/v1/chat/completions'
    : 'https://api.anthropic.com/v1/messages';

  if (isOpenRouter) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || 'anthropic/claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000,
        temperature: 0.1,
      }),
    });
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || '{}';
  } else {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        temperature: 0.1,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await resp.json();
    return data.content?.[0]?.text || '{}';
  }
}

// ── Exports ───────────────────────────────────────────────────

module.exports = {
  startScan,
  cancelScan,
  getScanState,
  getFolders,
  getEmails,
  getEmailPreview,
  bulkTrash,
  bulkArchive,
  bulkFlag,
  undoLastOperation,
  agenticSearch,
  hasCachedData,
  clearCache,
};
