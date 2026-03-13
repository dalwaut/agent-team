/**
 * User Resolver — maps email senders to OPAI user profiles
 *
 * Provides identity, role, permissions, and workspace scoping
 * for multi-user email agent access.
 */

const USER_MAP = {
  'denise@paradisewebfl.com': {
    userId: '26911c84-2f83-44f2-ab70-0748a5911c41',
    name: 'Denise',
    role: 'member',
    systemAccess: false,
    workspace: '/workspace/users/Denise/',
    defaultTeamHubWs: '80753c5a-beb5-498c-8d71-393a0342af27',
    telegramNotify: 1666403499,
  },
  'dallas@paradisewebfl.com': {
    userId: '1c93c5fe-d304-40f2-9169-765d0d2b7638',
    name: 'Dallas',
    role: 'admin',
    systemAccess: true,
    workspace: null,
    defaultTeamHubWs: '80753c5a-beb5-498c-8d71-393a0342af27',
    telegramNotify: 1666403499,
  },
  'dalwaut@gmail.com': {
    userId: '1c93c5fe-d304-40f2-9169-765d0d2b7638',
    name: 'Dallas',
    role: 'admin',
    systemAccess: true,
    workspace: null,
    defaultTeamHubWs: '80753c5a-beb5-498c-8d71-393a0342af27',
    telegramNotify: 1666403499,
  },
  'dallas@wautersedge.com': {
    userId: '1c93c5fe-d304-40f2-9169-765d0d2b7638',
    name: 'Dallas',
    role: 'admin',
    systemAccess: true,
    workspace: null,
    defaultTeamHubWs: '80753c5a-beb5-498c-8d71-393a0342af27',
    telegramNotify: 1666403499,
  },
};

/**
 * Resolve an email address to an OPAI user profile.
 * @param {string} emailAddress
 * @returns {object|null} User profile or null if unknown
 */
function resolveUser(emailAddress) {
  if (!emailAddress) return null;
  const key = emailAddress.toLowerCase().trim();
  return USER_MAP[key] || null;
}

/**
 * Check if a user can perform an action.
 * @param {object} user - resolved user profile
 * @param {string} action - 'create-task' | 'system-change' | 'manage-files' | 'generate-report'
 * @returns {boolean}
 */
function canPerform(user, action) {
  if (!user) return false;

  switch (action) {
    case 'create-task':
    case 'manage-files':
    case 'generate-report':
    case 'research':
    case 'explain':
    case 'diagnose':
    case 'process-transcript':
    case 'approve-transcript':
      return true; // All recognized users can do these

    case 'system-change':
      // System changes always go through Telegram gate, but user must be recognized
      return true;

    default:
      return user.role === 'admin';
  }
}

/**
 * Get the TeamHub workspace ID for a user.
 * @param {object} user - resolved user profile
 * @returns {string} workspace UUID
 */
function getWorkspaceId(user) {
  return (user && user.defaultTeamHubWs) || '80753c5a-beb5-498c-8d71-393a0342af27';
}

/**
 * Get the user ID to use for TeamHub operations.
 * @param {object} user - resolved user profile
 * @returns {string} Supabase user UUID
 */
function getUserId(user) {
  return (user && user.userId) || '1c93c5fe-d304-40f2-9169-765d0d2b7638';
}

module.exports = { resolveUser, canPerform, getWorkspaceId, getUserId, USER_MAP };
