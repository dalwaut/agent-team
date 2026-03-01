/**
 * Blacklist Gate — sender blacklist enforcement
 *
 * Mirrors whitelist-gate.js pattern. Reads/writes data/classifications.json.
 * Blacklisted senders have emails moved straight to IMAP Trash (no processing).
 * Mutual exclusion: adding to blacklist removes from whitelist and vice versa.
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
  if (!data.accounts[accountId].blacklist) {
    data.accounts[accountId].blacklist = { domains: [], addresses: [] };
  }
  return data.accounts[accountId];
}

/**
 * Parse a sender address, stripping display name if present.
 */
function parseAddress(senderAddress) {
  if (!senderAddress || typeof senderAddress !== 'string') return { email: '', domain: '' };
  const addr = senderAddress.toLowerCase().trim();
  const match = addr.match(/<([^>]+)>/);
  const email = match ? match[1] : addr;
  const domain = email.split('@')[1] || '';
  return { email, domain };
}

/**
 * Check if a sender is blacklisted for a specific account.
 * @param {string} senderAddress
 * @param {object} account - Account object with .id
 * @returns {{ blocked: boolean, reason: string }}
 */
function checkBlacklistForAccount(senderAddress, account) {
  const { email, domain } = parseAddress(senderAddress);
  if (!email) return { blocked: false, reason: 'No sender address' };

  const data = loadClassifications();
  const acct = data.accounts[account.id];
  if (!acct || !acct.blacklist) return { blocked: false, reason: 'No blacklist configured' };

  const bl = acct.blacklist;
  const domains = (bl.domains || []).map(d => d.toLowerCase());
  const addresses = (bl.addresses || []).map(a => a.toLowerCase());

  if (addresses.includes(email)) {
    return { blocked: true, reason: `Address blacklisted: ${email}` };
  }
  if (domain && domains.includes(domain)) {
    return { blocked: true, reason: `Domain blacklisted: ${domain}` };
  }

  return { blocked: false, reason: 'Not blacklisted' };
}

/**
 * Add a sender or domain to the blacklist.
 * Also removes from whitelist for mutual exclusion.
 * @param {{ address?: string, domain?: string }} opts
 * @param {string} accountId
 * @returns {{ success: boolean, added: string|null, blacklist: object }}
 */
function addToBlacklist(opts, accountId) {
  const data = loadClassifications();
  const acct = ensureAccount(data, accountId);
  const bl = acct.blacklist;

  let added = null;

  if (opts.domain) {
    const d = opts.domain.toLowerCase().trim();
    if (!bl.domains.includes(d)) {
      bl.domains.push(d);
      added = d;
    }
  } else if (opts.address) {
    const a = opts.address.toLowerCase().trim();
    if (!bl.addresses.includes(a)) {
      bl.addresses.push(a);
      added = a;
    }
  }

  if (added) {
    saveClassifications(data);
    // Mutual exclusion: remove from whitelist
    try {
      const { removeFromWhitelist } = require('./whitelist-gate');
      if (opts.domain) removeFromWhitelist({ domain: opts.domain });
      else if (opts.address) removeFromWhitelist({ address: opts.address });
    } catch (err) {
      console.error('[BLACKLIST] Failed to remove from whitelist:', err.message);
    }
  }

  return { success: true, added, blacklist: bl };
}

/**
 * Remove a sender or domain from the blacklist.
 * @param {{ address?: string, domain?: string }} opts
 * @param {string} accountId
 * @returns {{ success: boolean, removed: string|null, blacklist: object }}
 */
function removeFromBlacklist(opts, accountId) {
  const data = loadClassifications();
  const acct = ensureAccount(data, accountId);
  const bl = acct.blacklist;

  let removed = null;

  if (opts.domain) {
    const d = opts.domain.toLowerCase().trim();
    const idx = bl.domains.indexOf(d);
    if (idx !== -1) { bl.domains.splice(idx, 1); removed = d; }
  } else if (opts.address) {
    const a = opts.address.toLowerCase().trim();
    const idx = bl.addresses.indexOf(a);
    if (idx !== -1) { bl.addresses.splice(idx, 1); removed = a; }
  }

  if (removed) saveClassifications(data);

  return { success: true, removed, blacklist: bl };
}

/**
 * Get the blacklist for a specific account.
 * @param {string} accountId
 * @returns {{ domains: string[], addresses: string[] }}
 */
function getBlacklist(accountId) {
  const data = loadClassifications();
  const acct = data.accounts[accountId];
  if (!acct || !acct.blacklist) return { domains: [], addresses: [] };
  return {
    domains: acct.blacklist.domains || [],
    addresses: acct.blacklist.addresses || [],
  };
}

module.exports = { checkBlacklistForAccount, addToBlacklist, removeFromBlacklist, getBlacklist };
