/**
 * OPAI Dev — Extension library manager.
 *
 * Manages the shared vetted extension library (Layer B):
 * - Loads and caches registry.json
 * - Reads/writes per-user extension preferences
 * - Stages selected extensions as symlinks for container mounting
 */

const fs = require('fs');
const path = require('path');

const EXTENSIONS_PATH = process.env.EXTENSIONS_LIBRARY_PATH || '/workspace/shared/extensions';
const NFS_ROOT = process.env.NFS_WORKSPACE_ROOT || '/workspace/users';
const OPAI_ROOT = process.env.OPAI_ROOT || '/workspace/synced/opai';
const REGISTRY_FILE = path.join(EXTENSIONS_PATH, 'registry.json');
const VSIX_DIR = path.join(EXTENSIONS_PATH, 'vsix');

// Registry cache
let registryCache = null;
let registryCacheMtime = 0;

/**
 * Load the extension registry, with file-mtime-based caching.
 */
function loadRegistry() {
  try {
    const stat = fs.statSync(REGISTRY_FILE);
    if (registryCache && stat.mtimeMs === registryCacheMtime) {
      return registryCache;
    }
    const raw = fs.readFileSync(REGISTRY_FILE, 'utf8');
    registryCache = JSON.parse(raw);
    registryCacheMtime = stat.mtimeMs;
    return registryCache;
  } catch (err) {
    console.error('[extensions] Failed to load registry:', err.message);
    return { version: 1, extensions: [] };
  }
}

/**
 * Resolve the user's .opai config directory.
 */
function userConfigDir(userId, role) {
  let baseRoot;
  if (role === 'admin') {
    baseRoot = OPAI_ROOT;
  } else {
    const uuidPath = path.join(NFS_ROOT, userId);
    try {
      baseRoot = fs.realpathSync(uuidPath);
    } catch {
      baseRoot = path.join(NFS_ROOT, userId);
    }
  }
  return path.join(baseRoot, '.opai');
}

/**
 * Get the user's enabled extensions list.
 */
function getUserExtensions(userId, role) {
  const configDir = userConfigDir(userId, role);
  const prefsFile = path.join(configDir, 'extensions.json');
  try {
    const raw = fs.readFileSync(prefsFile, 'utf8');
    const prefs = JSON.parse(raw);
    return prefs.enabled || [];
  } catch {
    return [];
  }
}

/**
 * Save the user's enabled extensions list.
 */
function setUserExtensions(userId, role, enabledList) {
  const configDir = userConfigDir(userId, role);
  fs.mkdirSync(configDir, { recursive: true });
  const prefsFile = path.join(configDir, 'extensions.json');
  fs.writeFileSync(prefsFile, JSON.stringify({ enabled: enabledList }, null, 2), 'utf8');
}

/**
 * Enable an extension for a user. Returns true if the extension exists.
 */
function enableExtension(userId, role, extensionId) {
  const registry = loadRegistry();
  const ext = registry.extensions.find(e => e.id === extensionId);
  if (!ext) return false;

  const current = getUserExtensions(userId, role);
  if (!current.includes(extensionId)) {
    current.push(extensionId);
    setUserExtensions(userId, role, current);
  }
  return true;
}

/**
 * Disable an extension for a user.
 */
function disableExtension(userId, role, extensionId) {
  const current = getUserExtensions(userId, role);
  const filtered = current.filter(id => id !== extensionId);
  setUserExtensions(userId, role, filtered);
}

/**
 * Get the full available list with user enabled status merged in.
 */
function getAvailableExtensions(userId, role) {
  const registry = loadRegistry();
  const enabled = new Set(getUserExtensions(userId, role));

  return registry.extensions.map(ext => ({
    ...ext,
    enabled: enabled.has(ext.id),
    vsix_exists: fs.existsSync(path.join(VSIX_DIR, ext.filename)),
  }));
}

/**
 * Stage user's enabled extensions into their active-plugins directory.
 * Creates symlinks from the shared VSIX library into the user's staging dir.
 * Returns the absolute path to the staging directory, or null if no extensions.
 */
function stageExtensions(userId, role) {
  const registry = loadRegistry();
  const enabled = getUserExtensions(userId, role);
  if (enabled.length === 0) return null;

  const configDir = userConfigDir(userId, role);
  const stagingDir = path.join(configDir, 'active-plugins');

  // Clear and recreate staging directory
  if (fs.existsSync(stagingDir)) {
    const existing = fs.readdirSync(stagingDir);
    for (const f of existing) {
      fs.unlinkSync(path.join(stagingDir, f));
    }
  } else {
    fs.mkdirSync(stagingDir, { recursive: true });
  }

  // Symlink enabled extensions that exist in the VSIX library
  let staged = 0;
  for (const extId of enabled) {
    const ext = registry.extensions.find(e => e.id === extId);
    if (!ext) continue;

    const vsixPath = path.join(VSIX_DIR, ext.filename);
    if (!fs.existsSync(vsixPath)) {
      console.warn(`[extensions] VSIX not found for ${extId}: ${ext.filename}`);
      continue;
    }

    const linkPath = path.join(stagingDir, ext.filename);
    try {
      fs.symlinkSync(vsixPath, linkPath);
      staged++;
    } catch (err) {
      console.error(`[extensions] Failed to symlink ${ext.filename}:`, err.message);
    }
  }

  return staged > 0 ? stagingDir : null;
}

module.exports = {
  loadRegistry,
  getUserExtensions,
  setUserExtensions,
  enableExtension,
  disableExtension,
  getAvailableExtensions,
  stageExtensions,
};
