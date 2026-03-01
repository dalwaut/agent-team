/**
 * Access Control — Custom RBAC for Telegram bot.
 *
 * Roles:
 *   owner  — Full OPAI access, manage agents, approve, configure
 *   admin  — Full OPAI access, approve, run commands
 *   member — Team Hub only, scoped to assigned workspaces
 *   viewer — Read-only, view status/reports
 *
 * Storage: data/roles.json
 */

const fs = require('fs');
const path = require('path');

const ROLES_FILE = path.join(__dirname, 'data', 'roles.json');

const PERMISSIONS = {
  owner:  { admin: true, approve: true, chat: true, viewLogs: true, manageRoles: true, manageTopics: true },
  admin:  { admin: true, approve: true, chat: true, viewLogs: true, manageRoles: false, manageTopics: true },
  member: { admin: false, approve: false, chat: true, viewLogs: false, manageRoles: false, manageTopics: false },
  viewer: { admin: false, approve: false, chat: false, viewLogs: true, manageRoles: false, manageTopics: false },
};

function load() {
  try {
    if (fs.existsSync(ROLES_FILE)) return JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8'));
  } catch {}
  return { users: {}, topicScopes: {} };
}

function save(data) {
  const dir = path.dirname(ROLES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ROLES_FILE, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Get user's role. Owner ID from env gets 'owner' automatically.
 * @param {number|string} userId - Telegram user ID
 * @returns {string} Role name
 */
function getUserRole(userId) {
  const ownerId = process.env.OWNER_USER_ID;
  if (ownerId && String(userId) === String(ownerId)) return 'owner';

  const data = load();
  const user = data.users[String(userId)];
  return user ? user.role : null; // null = not whitelisted
}

/**
 * Check if a user has a specific permission.
 * @param {number|string} userId
 * @param {string} permission
 * @returns {boolean}
 */
function hasPermission(userId, permission) {
  const role = getUserRole(userId);
  if (!role) return false;
  return PERMISSIONS[role]?.[permission] === true;
}

/**
 * Check if a user is whitelisted (has any role).
 * @param {number|string} userId
 * @returns {boolean}
 */
function isWhitelisted(userId) {
  return getUserRole(userId) !== null;
}

/**
 * Set a user's role.
 * @param {number|string} userId
 * @param {string} role
 * @param {object} [opts]
 * @param {string[]} [opts.workspaces] - Workspace IDs for member role
 * @param {string} [opts.name] - Display name
 */
function setUserRole(userId, role, opts = {}) {
  if (!PERMISSIONS[role]) return false;
  const data = load();
  data.users[String(userId)] = {
    role,
    workspaces: opts.workspaces || ['*'],
    name: opts.name || null,
    updatedAt: new Date().toISOString(),
  };
  save(data);
  return true;
}

/**
 * Remove a user's access.
 * @param {number|string} userId
 */
function removeUser(userId) {
  const data = load();
  delete data.users[String(userId)];
  save(data);
}

/**
 * Get all users with roles.
 * @returns {Array<{userId: string, role: string, name: string}>}
 */
function listUsers() {
  const data = load();
  return Object.entries(data.users).map(([userId, info]) => ({
    userId,
    role: info.role,
    name: info.name,
    workspaces: info.workspaces,
  }));
}

/**
 * Bind a forum topic to a workspace.
 * @param {number} chatId
 * @param {number} threadId
 * @param {string} workspaceId
 * @param {string} [workspaceName]
 */
function setTopicScope(chatId, threadId, workspaceId, workspaceName) {
  const data = load();
  if (!data.topicScopes) data.topicScopes = {};
  data.topicScopes[`${chatId}:${threadId}`] = {
    workspaceId,
    workspaceName: workspaceName || null,
    updatedAt: new Date().toISOString(),
  };
  save(data);
}

/**
 * Get workspace binding for a forum topic.
 * @param {number} chatId
 * @param {number} threadId
 * @returns {{ workspaceId: string, workspaceName: string }|null}
 */
function getTopicScope(chatId, threadId) {
  const data = load();
  return data.topicScopes?.[`${chatId}:${threadId}`] || null;
}

/**
 * Get assistant mode status for a forum topic.
 * @param {number} chatId
 * @param {number} threadId
 * @returns {boolean}
 */
function getAssistantMode(chatId, threadId) {
  const data = load();
  return data.topicScopes?.[`${chatId}:${threadId}`]?.assistant === true;
}

/**
 * Set assistant mode for a forum topic.
 * @param {number} chatId
 * @param {number} threadId
 * @param {boolean} enabled
 */
function setAssistantMode(chatId, threadId, enabled) {
  const data = load();
  if (!data.topicScopes) data.topicScopes = {};
  const key = `${chatId}:${threadId}`;
  if (!data.topicScopes[key]) data.topicScopes[key] = { workspaceId: null, workspaceName: null };
  data.topicScopes[key].assistant = enabled;
  data.topicScopes[key].updatedAt = new Date().toISOString();
  save(data);
}

/**
 * Check if user has access to a specific workspace.
 * @param {number|string} userId
 * @param {string} workspaceId
 * @returns {boolean}
 */
function hasWorkspaceAccess(userId, workspaceId) {
  const role = getUserRole(userId);
  if (!role) return false;
  if (PERMISSIONS[role].admin) return true; // admins access everything
  const data = load();
  const user = data.users[String(userId)];
  if (!user) return false;
  return user.workspaces?.includes('*') || user.workspaces?.includes(workspaceId);
}

module.exports = {
  getUserRole,
  hasPermission,
  isWhitelisted,
  setUserRole,
  removeUser,
  listUsers,
  setTopicScope,
  getTopicScope,
  getAssistantMode,
  setAssistantMode,
  hasWorkspaceAccess,
  PERMISSIONS,
};
