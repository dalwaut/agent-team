/**
 * Whitelist Gate — sender whitelist enforcement (safety layer)
 *
 * Non-bypassable. Runs before ANY action, even classification display.
 * Returns { allowed, reason } for every sender address.
 *
 * Multi-account aware: reads whitelist from the active account in config.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadWhitelist() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  // Multi-account: read from active account
  if (config.accounts && config.activeAccountId) {
    const account = config.accounts.find(a => a.id === config.activeAccountId);
    if (account && account.whitelist) {
      return {
        domains: (account.whitelist.domains || []).map(d => d.toLowerCase()),
        addresses: (account.whitelist.addresses || []).map(a => a.toLowerCase()),
      };
    }
  }

  // Legacy fallback
  return {
    domains: (config.whitelist?.domains || []).map(d => d.toLowerCase()),
    addresses: (config.whitelist?.addresses || []).map(a => a.toLowerCase()),
  };
}

/**
 * Check if a sender address is whitelisted.
 * @param {string} senderAddress - Email address to check (e.g. "user@domain.com")
 * @returns {{ allowed: boolean, reason: string }}
 */
function checkSender(senderAddress) {
  if (!senderAddress || typeof senderAddress !== 'string') {
    return { allowed: false, reason: 'No sender address provided' };
  }

  const addr = senderAddress.toLowerCase().trim();
  // Strip display name if present: "Name <email>" -> "email"
  const match = addr.match(/<([^>]+)>/);
  const email = match ? match[1] : addr;

  const whitelist = loadWhitelist();

  // Check exact address match
  if (whitelist.addresses.includes(email)) {
    return { allowed: true, reason: `Address whitelisted: ${email}` };
  }

  // Check domain match
  const domain = email.split('@')[1];
  if (domain && whitelist.domains.includes(domain)) {
    return { allowed: true, reason: `Domain whitelisted: ${domain}` };
  }

  return { allowed: false, reason: `Not whitelisted: ${email} (domain: ${domain || 'unknown'})` };
}

/**
 * Batch check multiple sender addresses.
 * @param {string[]} addresses
 * @returns {Map<string, { allowed: boolean, reason: string }>}
 */
function checkSenders(addresses) {
  const results = new Map();
  for (const addr of addresses) {
    results.set(addr, checkSender(addr));
  }
  return results;
}

/**
 * Get current whitelist for display in the UI.
 */
function getWhitelist() {
  return loadWhitelist();
}

/**
 * Add an address or domain to the active account's whitelist and persist.
 * @param {{ address?: string, domain?: string }} opts
 * @returns {{ success: boolean, added: string, whitelist: object }}
 */
function addToWhitelist(opts) {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  // Find active account whitelist
  let wl;
  if (config.accounts && config.activeAccountId) {
    const account = config.accounts.find(a => a.id === config.activeAccountId);
    if (account) {
      if (!account.whitelist) account.whitelist = { domains: [], addresses: [] };
      wl = account.whitelist;
    }
  }
  if (!wl) {
    // Legacy fallback
    if (!config.whitelist) config.whitelist = { domains: [], addresses: [] };
    wl = config.whitelist;
  }

  let added = null;

  if (opts.domain) {
    const d = opts.domain.toLowerCase().trim();
    if (!wl.domains.includes(d)) {
      wl.domains.push(d);
      added = d;
    }
  } else if (opts.address) {
    const a = opts.address.toLowerCase().trim();
    if (!wl.addresses.includes(a)) {
      wl.addresses.push(a);
      added = a;
    }
  }

  if (added) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    // Mutual exclusion: remove from blacklist
    try {
      const { removeFromBlacklist } = require('./blacklist-gate');
      const activeId = config.activeAccountId;
      if (activeId) {
        if (opts.domain) removeFromBlacklist({ domain: opts.domain }, activeId);
        else if (opts.address) removeFromBlacklist({ address: opts.address }, activeId);
      }
    } catch (err) {
      console.error('[WHITELIST] Failed to remove from blacklist:', err.message);
    }
  }

  return { success: true, added, whitelist: wl };
}

/**
 * Check if a sender is whitelisted using a specific account's whitelist.
 * Used by multi-account cycle to avoid reading activeAccountId.
 * @param {string} senderAddress
 * @param {object} account - Account object with .whitelist
 * @returns {{ allowed: boolean, reason: string }}
 */
function checkSenderForAccount(senderAddress, account) {
  if (!senderAddress || typeof senderAddress !== 'string') {
    return { allowed: false, reason: 'No sender address provided' };
  }

  const addr = senderAddress.toLowerCase().trim();
  const match = addr.match(/<([^>]+)>/);
  const email = match ? match[1] : addr;

  const wl = account.whitelist || { domains: [], addresses: [] };
  const domains = (wl.domains || []).map(d => d.toLowerCase());
  const addresses = (wl.addresses || []).map(a => a.toLowerCase());

  if (addresses.includes(email)) {
    return { allowed: true, reason: `Address whitelisted: ${email}` };
  }

  const domain = email.split('@')[1];
  if (domain && domains.includes(domain)) {
    return { allowed: true, reason: `Domain whitelisted: ${domain}` };
  }

  return { allowed: false, reason: `Not whitelisted: ${email} (domain: ${domain || 'unknown'})` };
}

/**
 * Remove an address or domain from the active account's whitelist and persist.
 * @param {{ address?: string, domain?: string }} opts
 * @returns {{ success: boolean, removed: string|null, whitelist: object }}
 */
function removeFromWhitelist(opts) {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  let wl;
  if (config.accounts && config.activeAccountId) {
    const account = config.accounts.find(a => a.id === config.activeAccountId);
    if (account) {
      if (!account.whitelist) account.whitelist = { domains: [], addresses: [] };
      wl = account.whitelist;
    }
  }
  if (!wl) {
    if (!config.whitelist) config.whitelist = { domains: [], addresses: [] };
    wl = config.whitelist;
  }

  let removed = null;

  if (opts.domain) {
    const d = opts.domain.toLowerCase().trim();
    const idx = wl.domains.indexOf(d);
    if (idx !== -1) {
      wl.domains.splice(idx, 1);
      removed = d;
    }
  } else if (opts.address) {
    const a = opts.address.toLowerCase().trim();
    const idx = wl.addresses.indexOf(a);
    if (idx !== -1) {
      wl.addresses.splice(idx, 1);
      removed = a;
    }
  }

  if (removed) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  }

  return { success: true, removed, whitelist: wl };
}

module.exports = { checkSender, checkSenders, checkSenderForAccount, getWhitelist, addToWhitelist, removeFromWhitelist };
