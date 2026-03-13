/**
 * Classification Engine — trash tracking, custom classifications, pattern learning
 *
 * Data stored in data/classifications.json per account:
 *   accounts[accountId].trash   — manual[], auto[], patterns { senders, domains }
 *   accounts[accountId].custom  — user-created classifications with assignments + understandings
 */

const fs = require('fs');
const path = require('path');

const CLS_PATH = path.join(__dirname, 'data', 'classifications.json');

function loadClassifications() {
  try { return JSON.parse(fs.readFileSync(CLS_PATH, 'utf8')); }
  catch { return { accounts: {} }; }
}

function saveClassifications(data) {
  fs.mkdirSync(path.dirname(CLS_PATH), { recursive: true });
  fs.writeFileSync(CLS_PATH, JSON.stringify(data, null, 2));
}

function ensureAccount(data, accountId) {
  if (!data.accounts[accountId]) {
    data.accounts[accountId] = {
      blacklist: { domains: [], addresses: [] },
      trash: { manual: [], auto: [], patterns: { senders: {}, domains: {} } },
      custom: [],
    };
  }
  const acct = data.accounts[accountId];
  if (!acct.trash) acct.trash = { manual: [], auto: [], patterns: { senders: {}, domains: {} } };
  if (!acct.trash.patterns) acct.trash.patterns = { senders: {}, domains: {} };
  if (!acct.custom) acct.custom = [];
  if (!acct.scheduledDeletes) acct.scheduledDeletes = [];
  return acct;
}

function genId(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

// ── Trash Functions ──────────────────────────────────────

/**
 * Record a trash pattern for learning (sender + domain counts).
 */
function recordTrashPattern(sender, accountId) {
  const data = loadClassifications();
  const acct = ensureAccount(data, accountId);
  const addr = (sender || '').toLowerCase().trim();
  if (!addr) return;

  const domain = addr.split('@')[1] || '';

  if (!acct.trash.patterns.senders[addr]) {
    acct.trash.patterns.senders[addr] = { count: 0, lastSeen: null };
  }
  acct.trash.patterns.senders[addr].count++;
  acct.trash.patterns.senders[addr].lastSeen = new Date().toISOString();

  if (domain) {
    if (!acct.trash.patterns.domains[domain]) {
      acct.trash.patterns.domains[domain] = { count: 0, lastSeen: null };
    }
    acct.trash.patterns.domains[domain].count++;
    acct.trash.patterns.domains[domain].lastSeen = new Date().toISOString();
  }

  saveClassifications(data);
}

/**
 * Manually trash an email. Records pattern and marks for immediate IMAP move.
 */
function manualTrash(emailId, sender, subject, accountId) {
  const data = loadClassifications();
  const acct = ensureAccount(data, accountId);

  const entry = {
    id: genId('mt'),
    emailId,
    sender: (sender || '').toLowerCase().trim(),
    subject: subject || '',
    trashedAt: new Date().toISOString(),
    movedToTrash: true,
  };
  acct.trash.manual.push(entry);

  // Cap at 500
  if (acct.trash.manual.length > 500) acct.trash.manual = acct.trash.manual.slice(-500);

  saveClassifications(data);
  recordTrashPattern(sender, accountId);
  return entry;
}

/**
 * Remove a manual trash entry (undo trash).
 */
function removeManualTrash(emailId, accountId) {
  const data = loadClassifications();
  const acct = ensureAccount(data, accountId);
  const idx = acct.trash.manual.findIndex(e => e.emailId === emailId);
  if (idx === -1) return null;
  const removed = acct.trash.manual.splice(idx, 1)[0];
  saveClassifications(data);
  return removed;
}

/**
 * Auto-trash an email. Sets a 48h delay before IMAP move.
 */
function autoTrash(emailId, sender, subject, accountId) {
  const data = loadClassifications();
  const acct = ensureAccount(data, accountId);

  const moveAfter = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

  const entry = {
    id: genId('at'),
    emailId,
    sender: (sender || '').toLowerCase().trim(),
    subject: subject || '',
    classifiedAt: new Date().toISOString(),
    moveAfter,
    overridden: false,
    movedToTrash: false,
  };
  acct.trash.auto.push(entry);

  // Cap at 500
  if (acct.trash.auto.length > 500) acct.trash.auto = acct.trash.auto.slice(-500);

  saveClassifications(data);
  return entry;
}

/**
 * Override (rescue) an auto-trash entry so it won't be moved.
 */
function overrideAutoTrash(entryId, accountId) {
  const data = loadClassifications();
  const acct = ensureAccount(data, accountId);
  const entry = acct.trash.auto.find(e => e.id === entryId);
  if (!entry) return null;
  entry.overridden = true;
  entry.overriddenAt = new Date().toISOString();

  // Reduce pattern counts to unlearn
  const addr = entry.sender;
  const domain = addr.split('@')[1] || '';
  if (acct.trash.patterns.senders[addr]) {
    acct.trash.patterns.senders[addr].count = Math.max(0, acct.trash.patterns.senders[addr].count - 1);
  }
  if (domain && acct.trash.patterns.domains[domain]) {
    acct.trash.patterns.domains[domain].count = Math.max(0, acct.trash.patterns.domains[domain].count - 1);
  }

  saveClassifications(data);
  return entry;
}

/**
 * Get all pending auto-trash entries (not overridden, not yet moved).
 */
function getPendingAutoTrash(accountId) {
  const data = loadClassifications();
  const acct = data.accounts[accountId];
  if (!acct || !acct.trash) return [];
  return (acct.trash.auto || []).filter(e => !e.overridden && !e.movedToTrash);
}

/**
 * Get auto-trash entries ready to be moved (past 48h delay, not overridden).
 */
function getReadyToMove(accountId) {
  const now = Date.now();
  const data = loadClassifications();
  const acct = data.accounts[accountId];
  if (!acct || !acct.trash) return [];
  return (acct.trash.auto || []).filter(e =>
    !e.overridden && !e.movedToTrash && new Date(e.moveAfter).getTime() < now
  );
}

/**
 * Mark an auto-trash entry as moved to trash.
 */
function markAutoTrashMoved(entryId, accountId) {
  const data = loadClassifications();
  const acct = ensureAccount(data, accountId);
  const entry = acct.trash.auto.find(e => e.id === entryId);
  if (!entry) return null;
  entry.movedToTrash = true;
  entry.movedAt = new Date().toISOString();
  saveClassifications(data);
  return entry;
}

/**
 * Check if a sender matches trash patterns.
 * Returns { shouldTrash, confidence, reason } — true if sender has 3+ hits OR domain has 5+ hits.
 */
function checkTrashPatterns(sender, accountId) {
  const addr = (sender || '').toLowerCase().trim();
  if (!addr) return { shouldTrash: false, confidence: 0, reason: 'No sender' };

  const data = loadClassifications();
  const acct = data.accounts[accountId];
  if (!acct || !acct.trash || !acct.trash.patterns) return { shouldTrash: false, confidence: 0, reason: 'No patterns' };

  const senderPattern = acct.trash.patterns.senders[addr];
  if (senderPattern && senderPattern.count >= 3) {
    return {
      shouldTrash: true,
      confidence: Math.min(1, senderPattern.count / 5),
      reason: `Sender ${addr} trashed ${senderPattern.count} times`,
    };
  }

  const domain = addr.split('@')[1] || '';
  const domainPattern = domain ? acct.trash.patterns.domains[domain] : null;
  if (domainPattern && domainPattern.count >= 5) {
    return {
      shouldTrash: true,
      confidence: Math.min(1, domainPattern.count / 8),
      reason: `Domain ${domain} trashed ${domainPattern.count} times`,
    };
  }

  return { shouldTrash: false, confidence: 0, reason: 'Below threshold' };
}

// ── Custom Classification Functions ─────────────────────

/**
 * Create a new custom classification.
 */
function createClassification({ name, color }, accountId) {
  const data = loadClassifications();
  const acct = ensureAccount(data, accountId);

  const cls = {
    id: genId('cls'),
    name: name || 'Unnamed',
    color: color || '#6c5ce7',
    createdAt: new Date().toISOString(),
    assignments: [],
    understandings: [],
  };
  acct.custom.push(cls);
  saveClassifications(data);
  return cls;
}

/**
 * Delete a custom classification.
 */
function deleteClassification(id, accountId) {
  const data = loadClassifications();
  const acct = ensureAccount(data, accountId);
  const idx = acct.custom.findIndex(c => c.id === id);
  if (idx === -1) return { success: false };
  acct.custom.splice(idx, 1);
  saveClassifications(data);
  return { success: true };
}

/**
 * Get all classifications for an account.
 */
function getClassifications(accountId) {
  const data = loadClassifications();
  const acct = data.accounts[accountId];
  if (!acct) return [];
  return acct.custom || [];
}

/**
 * Assign an email to a classification and rebuild understandings.
 */
function assignToClassification(clsId, { emailId, sender, subject, tags }, accountId) {
  const data = loadClassifications();
  const acct = ensureAccount(data, accountId);
  const cls = acct.custom.find(c => c.id === clsId);
  if (!cls) return { success: false, error: 'Classification not found' };

  // Don't duplicate
  if (cls.assignments.some(a => a.emailId === emailId)) {
    return { success: true, duplicate: true };
  }

  cls.assignments.push({
    emailId,
    sender: (sender || '').toLowerCase().trim(),
    subject: subject || '',
    tags: tags || [],
    assignedAt: new Date().toISOString(),
  });

  // Cap assignments at 200
  if (cls.assignments.length > 200) cls.assignments = cls.assignments.slice(-200);

  // Rebuild understandings
  rebuildUnderstandingsInPlace(cls);

  saveClassifications(data);
  return { success: true };
}

/**
 * Remove an email from a classification and rebuild understandings.
 */
function unassignFromClassification(clsId, emailId, accountId) {
  const data = loadClassifications();
  const acct = ensureAccount(data, accountId);
  const cls = acct.custom.find(c => c.id === clsId);
  if (!cls) return { success: false, error: 'Classification not found' };

  cls.assignments = cls.assignments.filter(a => a.emailId !== emailId);
  rebuildUnderstandingsInPlace(cls);

  saveClassifications(data);
  return { success: true };
}

/**
 * Rebuild understandings from assignments (in-place).
 * Confidence = matchCount / totalAssignments.
 */
function rebuildUnderstandingsInPlace(cls) {
  const total = cls.assignments.length;
  if (total === 0) { cls.understandings = []; return; }

  const senderCounts = {};
  const domainCounts = {};
  const tagCounts = {};

  for (const a of cls.assignments) {
    const addr = a.sender;
    if (addr) {
      senderCounts[addr] = (senderCounts[addr] || 0) + 1;
      const domain = addr.split('@')[1];
      if (domain) domainCounts[domain] = (domainCounts[domain] || 0) + 1;
    }
    for (const t of (a.labels || a.tags || [])) {
      tagCounts[t] = (tagCounts[t] || 0) + 1;
    }
  }

  const understandings = [];
  const now = new Date().toISOString();

  for (const [value, count] of Object.entries(senderCounts)) {
    if (count >= 2) {
      understandings.push({ type: 'sender', value, confidence: count / total, matchCount: count, learnedAt: now });
    }
  }
  for (const [value, count] of Object.entries(domainCounts)) {
    if (count >= 2) {
      understandings.push({ type: 'domain', value, confidence: count / total, matchCount: count, learnedAt: now });
    }
  }
  for (const [value, count] of Object.entries(tagCounts)) {
    if (count >= 2) {
      understandings.push({ type: 'tag', value, confidence: count / total, matchCount: count, learnedAt: now });
    }
  }

  cls.understandings = understandings;
}

/**
 * Rebuild understandings for a specific classification (public API).
 */
function rebuildUnderstandings(clsId, accountId) {
  const data = loadClassifications();
  const acct = ensureAccount(data, accountId);
  const cls = acct.custom.find(c => c.id === clsId);
  if (!cls) return null;
  rebuildUnderstandingsInPlace(cls);
  saveClassifications(data);
  return cls.understandings;
}

/**
 * Suggest classifications for an email based on learned understandings.
 * @param {{ sender: string, tags: string[] }} emailInfo
 * @param {string} accountId
 * @returns {Array<{ classificationId, name, confidence, reason }>}
 */
function suggestClassifications({ sender, tags }, accountId) {
  const data = loadClassifications();
  const acct = data.accounts[accountId];
  if (!acct || !acct.custom) return [];

  const addr = (sender || '').toLowerCase().trim();
  const domain = addr.split('@')[1] || '';
  const suggestions = [];

  for (const cls of acct.custom) {
    if (!cls.understandings || cls.understandings.length === 0) continue;

    let bestMatch = null;
    for (const u of cls.understandings) {
      if (u.type === 'sender' && u.value === addr) {
        if (!bestMatch || u.confidence > bestMatch.confidence) {
          bestMatch = { confidence: u.confidence, reason: `Sender match: ${addr}` };
        }
      } else if (u.type === 'domain' && u.value === domain) {
        if (!bestMatch || u.confidence > bestMatch.confidence) {
          bestMatch = { confidence: u.confidence, reason: `Domain match: ${domain}` };
        }
      } else if (u.type === 'tag' && (tags || []).includes(u.value)) {
        if (!bestMatch || u.confidence > bestMatch.confidence) {
          bestMatch = { confidence: u.confidence, reason: `Tag match: ${u.value}` };
        }
      }
    }

    if (bestMatch && bestMatch.confidence >= 0.3) {
      suggestions.push({
        classificationId: cls.id,
        name: cls.name,
        confidence: bestMatch.confidence,
        reason: bestMatch.reason,
      });
    }
  }

  return suggestions.sort((a, b) => b.confidence - a.confidence);
}

// ── Scheduled Deletes ────────────────────────────────────

function scheduleDelete(emailId, deleteAt, accountId) {
  const data = loadClassifications();
  const acct = ensureAccount(data, accountId);
  acct.scheduledDeletes.push({
    id: genId('sd'),
    emailId,
    deleteAt,
    scheduledAt: new Date().toISOString(),
    executed: false,
  });
  saveClassifications(data);
}

function getReadyToDelete(accountId) {
  const data = loadClassifications();
  const acct = ensureAccount(data, accountId);
  const now = new Date().toISOString();
  return acct.scheduledDeletes.filter(e => !e.executed && e.deleteAt <= now);
}

function markDeleteExecuted(entryId, accountId) {
  const data = loadClassifications();
  const acct = ensureAccount(data, accountId);
  const entry = acct.scheduledDeletes.find(e => e.id === entryId);
  if (entry) {
    entry.executed = true;
    saveClassifications(data);
  }
  return entry;
}

module.exports = {
  // Trash
  manualTrash,
  removeManualTrash,
  autoTrash,
  overrideAutoTrash,
  getPendingAutoTrash,
  getReadyToMove,
  markAutoTrashMoved,
  checkTrashPatterns,
  recordTrashPattern,
  // Scheduled deletes
  scheduleDelete,
  getReadyToDelete,
  markDeleteExecuted,
  // Custom classifications
  createClassification,
  deleteClassification,
  getClassifications,
  assignToClassification,
  unassignFromClassification,
  rebuildUnderstandings,
  suggestClassifications,
};
