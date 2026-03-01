/**
 * Guild Data Utility — Per-guild data directory management.
 *
 * All guild-specific data lives under data/guilds/{guildId}/.
 * DMs and fallback use 'opai-home' as the guildId.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const GUILDS_DIR = path.join(DATA_DIR, 'guilds');

/**
 * Get the data directory path for a guild.
 * @param {string} guildId - Discord guild ID or 'opai-home' for DMs
 * @returns {string} Absolute path to guild data directory
 */
function getGuildDataDir(guildId) {
  return path.join(GUILDS_DIR, guildId);
}

/**
 * Ensure the guild data directory exists, creating it if needed.
 * @param {string} guildId
 * @returns {string} The guild data directory path
 */
function ensureGuildDir(guildId) {
  const dir = getGuildDataDir(guildId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * List all guild IDs that have data directories.
 * @returns {string[]} Array of guild IDs
 */
function listGuildIds() {
  if (!fs.existsSync(GUILDS_DIR)) return [];
  return fs.readdirSync(GUILDS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

module.exports = { getGuildDataDir, ensureGuildDir, listGuildIds, GUILDS_DIR };
