/**
 * Mode Engine — capability matrix per operating mode + multi-account management
 *
 * Three modes:
 *   suggestion — classify + tag only, no drafts, no sends
 *   internal   — classify + tag + organize + draft (to queue), no sends
 *   auto       — classify + tag + organize + draft + send (rate-limited)
 *
 * Effective capabilities = MODE_CAPS intersect ACCOUNT_PERMISSIONS
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const STATE_PATH = path.join(__dirname, 'data', 'agent-state.json');

const VALID_MODES = ['suggestion', 'internal', 'auto'];

const MODE_CAPABILITIES = {
  suggestion: { classify: true, label: true, organize: false, draft: false, send: false, moveEmails: false },
  internal:   { classify: true, label: true, organize: true,  draft: true,  send: false, moveEmails: true },
  auto:       { classify: true, label: true, organize: true,  draft: true,  send: true,  moveEmails: true },
};

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { killed: false, autoSendsThisHour: 0, hourStart: null, lastCheck: null };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ── Account Management ──────────────────────────────────────

function getActiveAccountId() {
  const config = loadConfig();
  return config.activeAccountId || (config.accounts && config.accounts[0]?.id) || null;
}

function getActiveAccount() {
  const config = loadConfig();
  const id = config.activeAccountId || (config.accounts && config.accounts[0]?.id);

  if (config.accounts && id) {
    const account = config.accounts.find(a => a.id === id);
    if (account) return account;
  }

  // Legacy fallback (pre-multi-account config)
  return {
    id: 'legacy',
    name: config.account?.name || 'Agent',
    email: config.account?.email || '',
    envPrefix: config.account?.envPrefix || 'AGENT',
    mode: config.mode || 'suggestion',
    permissions: { classify: true, label: true, organize: true, draft: true, send: true, moveEmails: true },
    whitelist: config.whitelist || { domains: [], addresses: [] },
    voiceProfile: config.voiceProfile || '',
    imapFolders: config.imapFolders || ['INBOX'],
  };
}

function setActiveAccount(accountId) {
  const config = loadConfig();
  if (!config.accounts?.find(a => a.id === accountId)) {
    return { success: false, error: 'Account not found' };
  }
  config.activeAccountId = accountId;
  saveConfig(config);
  return { success: true, activeAccountId: accountId };
}

function getAccounts() {
  const config = loadConfig();
  return (config.accounts || []).map(a => sanitizeAccount(a));
}

function getAccountById(id) {
  const config = loadConfig();
  return (config.accounts || []).find(a => a.id === id) || null;
}

function addAccount(accountData) {
  const config = loadConfig();
  if (!config.accounts) config.accounts = [];

  const id = 'acc-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const account = {
    id,
    name: accountData.name || 'New Account',
    email: accountData.email || '',
    imap: accountData.imap || { host: 'imap.gmail.com', port: 993, user: accountData.email || '', pass: '' },
    smtp: accountData.smtp || { host: 'smtp.gmail.com', port: 465, user: accountData.email || '', pass: '' },
    mode: 'suggestion',
    permissions: {
      classify: true,
      label: true,
      organize: false,
      draft: false,
      send: false,
      moveEmails: false,
    },
    whitelist: { domains: [], addresses: [] },
    voiceProfile: accountData.voiceProfile || '',
    imapFolders: ['INBOX'],
    checkIntervalMinutes: 30,
    rateLimitPerHour: 5,
    lookbackMinutes: 60,
    createdAt: new Date().toISOString(),
    needsSetup: !accountData.imap?.pass,
  };

  config.accounts.push(account);
  saveConfig(config);
  return sanitizeAccount(account);
}

function updateAccount(id, updates) {
  const config = loadConfig();
  const account = (config.accounts || []).find(a => a.id === id);
  if (!account) return null;

  if (updates.name != null) account.name = updates.name;
  if (updates.email != null) account.email = updates.email;
  if (updates.imap) {
    if (!account.imap) account.imap = {};
    // Preserve existing password if update sends empty/missing pass
    const existingImapPass = account.imap.pass;
    Object.assign(account.imap, updates.imap);
    if (!updates.imap.pass && existingImapPass) account.imap.pass = existingImapPass;
  }
  if (updates.smtp) {
    if (!account.smtp) account.smtp = {};
    const existingSmtpPass = account.smtp.pass;
    Object.assign(account.smtp, updates.smtp);
    if (!updates.smtp.pass && existingSmtpPass) account.smtp.pass = existingSmtpPass;
  }
  if (updates.mode && VALID_MODES.includes(updates.mode)) account.mode = updates.mode;
  if (updates.permissions) Object.assign(account.permissions, updates.permissions);
  if (updates.whitelist) account.whitelist = updates.whitelist;
  if (updates.voiceProfile != null) account.voiceProfile = updates.voiceProfile;
  if (updates.imapFolders) account.imapFolders = updates.imapFolders;
  if (updates.checkIntervalMinutes != null) account.checkIntervalMinutes = updates.checkIntervalMinutes;
  if (updates.rateLimitPerHour != null) account.rateLimitPerHour = updates.rateLimitPerHour;
  if (updates.lookbackMinutes != null) account.lookbackMinutes = updates.lookbackMinutes;
  if (updates.needsSetup != null) account.needsSetup = updates.needsSetup;

  saveConfig(config);
  return sanitizeAccount(account);
}

function deleteAccount(id) {
  const config = loadConfig();
  const idx = (config.accounts || []).findIndex(a => a.id === id);
  if (idx === -1) return false;
  if (config.accounts.length <= 1) return false;

  config.accounts.splice(idx, 1);
  if (config.activeAccountId === id) {
    config.activeAccountId = config.accounts[0].id;
  }
  saveConfig(config);
  return true;
}

/**
 * Strip sensitive data (passwords) from account for API responses.
 */
function sanitizeAccount(account) {
  const safe = { ...account };
  if (safe.imap) safe.imap = { ...safe.imap, pass: safe.imap.pass ? '\u2022\u2022\u2022\u2022' : '' };
  if (safe.smtp) safe.smtp = { ...safe.smtp, pass: safe.smtp.pass ? '\u2022\u2022\u2022\u2022' : '' };
  return safe;
}

/**
 * Get raw account with credentials (for internal use only — never expose to API).
 */
function getAccountCredentials(id) {
  const config = loadConfig();
  return (config.accounts || []).find(a => a.id === id) || null;
}

/**
 * Get all accounts that are enabled and have valid credentials.
 * Used by the multi-account monitoring loop.
 */
function getEnabledAccounts() {
  const config = loadConfig();
  return (config.accounts || []).filter(a => {
    if (a.needsSetup) return false;
    if (a.enabled === false) return false; // explicit disable
    // Check if account has credentials (inline or env)
    if (a.imap?.pass) return true;
    const prefix = a.envPrefix || 'AGENT';
    return !!process.env[`${prefix}_IMAP_PASS`];
  });
}

/**
 * Get effective capabilities for a specific account (mode ∩ permissions).
 */
function getCapabilitiesForAccount(account) {
  const m = account.mode || 'suggestion';
  const modeCaps = MODE_CAPABILITIES[m] || MODE_CAPABILITIES.suggestion;
  const perms = account.permissions || {};
  return {
    classify: modeCaps.classify && (perms.classify !== false),
    label: modeCaps.label && (perms.label !== false),
    organize: (modeCaps.organize || false) && (perms.organize !== false),
    draft: (modeCaps.draft || false) && (perms.draft !== false),
    send: (modeCaps.send || false) && (perms.send !== false),
    moveEmails: (modeCaps.moveEmails || false) && (perms.moveEmails !== false),
  };
}

// ── Mode ──────────────────────────────────────────────────

function getMode() {
  const account = getActiveAccount();
  return account.mode || 'suggestion';
}

function setMode(newMode) {
  if (!VALID_MODES.includes(newMode)) {
    return { success: false, error: `Invalid mode: ${newMode}. Valid: ${VALID_MODES.join(', ')}` };
  }
  const config = loadConfig();
  const activeId = config.activeAccountId || (config.accounts && config.accounts[0]?.id);
  const account = (config.accounts || []).find(a => a.id === activeId);
  if (!account) return { success: false, error: 'No active account' };

  const oldMode = account.mode;
  account.mode = newMode;
  saveConfig(config);

  // Reset rate limit counter on mode change
  if (newMode === 'auto') {
    const state = loadState();
    state.autoSendsThisHour = 0;
    state.hourStart = new Date().toISOString();
    saveState(state);
  }

  return { success: true, mode: newMode, previousMode: oldMode };
}

// ── Capabilities (intersection of mode + account permissions) ──

function getCapabilities(mode) {
  const account = getActiveAccount();
  const m = mode || account.mode || 'suggestion';
  const modeCaps = MODE_CAPABILITIES[m] || MODE_CAPABILITIES.suggestion;
  const perms = account.permissions || {};

  return {
    classify: modeCaps.classify && (perms.classify !== false),
    label: modeCaps.label && (perms.label !== false),
    organize: (modeCaps.organize || false) && (perms.organize !== false),
    draft: (modeCaps.draft || false) && (perms.draft !== false),
    send: (modeCaps.send || false) && (perms.send !== false),
    moveEmails: (modeCaps.moveEmails || false) && (perms.moveEmails !== false),
  };
}

function canPerform(action) {
  const caps = getCapabilities();
  return caps[action] === true;
}

// ── Rate Limiting (per-account) ─────────────────────────────

function checkRateLimit(accountId = null) {
  const config = loadConfig();
  const id = accountId || config.activeAccountId || (config.accounts && config.accounts[0]?.id);
  const account = (config.accounts || []).find(a => a.id === id);
  const limit = account?.rateLimitPerHour ?? config.maxAutoSendsPerHour ?? config.rateLimitPerHour ?? 5;
  const state = loadState();
  const now = new Date();

  // Per-account rate tracking
  if (!state.rateLimits) state.rateLimits = {};
  if (!state.rateLimits[id]) state.rateLimits[id] = { sends: 0, hourStart: null };
  const rl = state.rateLimits[id];

  const hourStart = rl.hourStart ? new Date(rl.hourStart) : null;
  if (!hourStart || (now - hourStart) >= 3600000) {
    rl.sends = 0;
    rl.hourStart = now.toISOString();
  }

  const remaining = Math.max(0, limit - rl.sends);
  if (remaining <= 0) {
    saveState(state);
    return { allowed: false, remaining: 0, limit };
  }

  rl.sends++;
  saveState(state);
  return { allowed: true, remaining: remaining - 1, limit };
}

function getRateLimitStatus(accountId = null) {
  const config = loadConfig();
  const id = accountId || config.activeAccountId || (config.accounts && config.accounts[0]?.id);
  const account = (config.accounts || []).find(a => a.id === id);
  const limit = account?.rateLimitPerHour ?? config.maxAutoSendsPerHour ?? config.rateLimitPerHour ?? 5;
  const state = loadState();
  const now = new Date();

  const rl = state.rateLimits?.[id] || { sends: 0, hourStart: null };
  const hourStart = rl.hourStart ? new Date(rl.hourStart) : null;
  let used = rl.sends || 0;
  if (!hourStart || (now - hourStart) >= 3600000) {
    used = 0;
  }

  return { used, remaining: Math.max(0, limit - used), limit };
}

// ── Kill Switch ────────────────────────────────────────────

function kill() {
  const state = loadState();
  state.killed = true;
  state.killedAt = new Date().toISOString();
  saveState(state);
  return { success: true, killedAt: state.killedAt };
}

function resume() {
  const state = loadState();
  state.killed = false;
  state.resumedAt = new Date().toISOString();
  saveState(state);
  return { success: true, resumedAt: state.resumedAt };
}

function isKilled() {
  const state = loadState();
  return state.killed === true;
}

// ── Settings (per-account) ───────────────────────────────────

function getSettings(accountId = null) {
  const config = loadConfig();
  const id = accountId || config.activeAccountId || (config.accounts && config.accounts[0]?.id);
  const account = (config.accounts || []).find(a => a.id === id) || getActiveAccount();
  return {
    mode: account.mode || 'suggestion',
    checkIntervalMinutes: account.checkIntervalMinutes ?? config.checkIntervalMinutes ?? 5,
    rateLimitPerHour: account.rateLimitPerHour ?? config.maxAutoSendsPerHour ?? config.rateLimitPerHour ?? 5,
    voiceProfile: account.voiceProfile || '',
    lookbackMinutes: account.lookbackMinutes ?? config.lookbackMinutes ?? 60,
  };
}

function updateSettings(updates, accountId = null) {
  const config = loadConfig();
  const id = accountId || config.activeAccountId || (config.accounts && config.accounts[0]?.id);
  const account = (config.accounts || []).find(a => a.id === id);
  if (!account) return { success: false, error: 'Account not found' };

  if (updates.checkIntervalMinutes != null) account.checkIntervalMinutes = updates.checkIntervalMinutes;
  if (updates.rateLimitPerHour != null) account.rateLimitPerHour = updates.rateLimitPerHour;
  if (updates.voiceProfile != null) account.voiceProfile = updates.voiceProfile;
  if (updates.lookbackMinutes != null) account.lookbackMinutes = updates.lookbackMinutes;
  saveConfig(config);
  return { success: true, settings: getSettings(id) };
}

module.exports = {
  VALID_MODES,
  MODE_CAPABILITIES,
  getMode,
  setMode,
  getCapabilities,
  canPerform,
  checkRateLimit,
  getRateLimitStatus,
  kill,
  resume,
  isKilled,
  getSettings,
  updateSettings,
  // Account management
  getActiveAccount,
  getActiveAccountId,
  setActiveAccount,
  getAccounts,
  getAccountById,
  getAccountCredentials,
  addAccount,
  updateAccount,
  deleteAccount,
  sanitizeAccount,
  // Multi-account
  getEnabledAccounts,
  getCapabilitiesForAccount,
};
