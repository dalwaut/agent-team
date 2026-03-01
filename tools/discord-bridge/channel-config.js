/**
 * Channel Configuration — Per-channel role management.
 *
 * Each channel in a guild can be assigned a role:
 *   - "admin"    — Full OPAI filesystem + orchestrator access (cwd = OPAI_ROOT)
 *   - "team-hub" — Team Hub workspace AI only (MCP tools, scoped to workspace)
 *
 * Unconfigured channels in the admin guild default to "admin".
 * Unconfigured channels in other guilds default to "team-hub".
 *
 * Storage: data/guilds/{guildId}/channel-config.json
 */

const fs = require('fs');
const path = require('path');
const { ensureGuildDir, getGuildDataDir } = require('./guild-data');

function getConfigFile(guildId) {
  return path.join(getGuildDataDir(guildId), 'channel-config.json');
}

function load(guildId) {
  try {
    const file = getConfigFile(guildId);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  return {};
}

function save(guildId, data) {
  ensureGuildDir(guildId);
  fs.writeFileSync(getConfigFile(guildId), JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Get the configured role for a channel.
 * @param {string} guildId
 * @param {string} channelId
 * @returns {{ role: string, workspaceId?: string, name?: string, systemPrompt?: string } | null}
 */
function getChannelConfig(guildId, channelId) {
  const data = load(guildId);
  return data[channelId] || null;
}

/**
 * Set a channel's role configuration.
 * @param {string} guildId
 * @param {string} channelId
 * @param {string} role - "admin" or "team-hub"
 * @param {object} [opts]
 * @param {string} [opts.workspaceId] - Team Hub workspace ID (for team-hub role)
 * @param {string} [opts.workspaceName] - Workspace display name
 * @param {string} [opts.name] - Channel display name
 * @param {string} [opts.systemPrompt] - Custom system prompt override
 */
function setChannelConfig(guildId, channelId, role, opts = {}) {
  const data = load(guildId);
  data[channelId] = {
    role,
    ...(opts.workspaceId && { workspaceId: opts.workspaceId }),
    ...(opts.workspaceName && { workspaceName: opts.workspaceName }),
    ...(opts.name && { name: opts.name }),
    ...(opts.systemPrompt && { systemPrompt: opts.systemPrompt }),
    updatedAt: new Date().toISOString(),
  };
  save(guildId, data);
  return data[channelId];
}

/**
 * Remove a channel's configuration (revert to default behavior).
 * @param {string} guildId
 * @param {string} channelId
 */
function clearChannelConfig(guildId, channelId) {
  const data = load(guildId);
  delete data[channelId];
  save(guildId, data);
}

/**
 * List all configured channels for a guild.
 * @param {string} guildId
 * @returns {Array<{ channelId: string, role: string, name?: string, workspaceName?: string }>}
 */
function listChannelConfigs(guildId) {
  const data = load(guildId);
  return Object.entries(data).map(([channelId, cfg]) => ({
    channelId,
    role: cfg.role,
    name: cfg.name || null,
    workspaceName: cfg.workspaceName || null,
    workspaceId: cfg.workspaceId || null,
  }));
}

module.exports = {
  getChannelConfig,
  setChannelConfig,
  clearChannelConfig,
  listChannelConfigs,
};
