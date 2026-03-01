/**
 * Persona Manager — Configurable personality layer for the Discord bot.
 *
 * Loads persona.json and provides message functions that adapt to the
 * active persona. Personas affect tone, status messages, error messages,
 * and emoji usage — not the underlying logic.
 *
 * Global persona definitions in persona.json.
 * Per-guild active selection in data/guilds/{guildId}/persona-active.json.
 *
 * Switch at runtime via `!@ persona <name>` or edit persona.json directly.
 */

const fs = require('fs');
const path = require('path');
const { ensureGuildDir, getGuildDataDir } = require('./guild-data');

const PERSONA_FILE = path.join(__dirname, 'persona.json');

let globalConfig = null;

function loadGlobal() {
  try {
    globalConfig = JSON.parse(fs.readFileSync(PERSONA_FILE, 'utf8'));
  } catch {
    globalConfig = { active: 'professional', personas: {} };
  }
  return globalConfig;
}

function getActivePersonaFile(guildId) {
  return path.join(getGuildDataDir(guildId), 'persona-active.json');
}

function getActivePersonaName(guildId) {
  if (guildId) {
    try {
      const file = getActivePersonaFile(guildId);
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data.active) return data.active;
      }
    } catch {}
  }
  // Fallback to global default
  const c = loadGlobal();
  return c.active || 'professional';
}

function getActive(guildId) {
  const c = loadGlobal();
  const name = getActivePersonaName(guildId);
  return c.personas[name] || c.personas.professional || {};
}

/** Get the acknowledgment message sent immediately when a request comes in. */
function getAckMessage(guildId) {
  const p = getActive(guildId);
  return p.acknowledgment || '**Working on it...** I\'ll update this message when ready.';
}

/** Get a rotating processing message based on elapsed seconds. Changes every ~30s. */
function getProcessingMessage(guildId, elapsedSeconds) {
  const p = getActive(guildId);
  const msgs = p.processing_messages || ['Processing...'];
  const index = Math.floor(elapsedSeconds / 30) % msgs.length;
  return msgs[index];
}

/** Get a note appended to progress when a task runs over 5 minutes. */
function getLongRunningNote(guildId) {
  const p = getActive(guildId);
  return p.long_running_note || '_Complex task — still processing..._';
}

/** Get persona-toned error message. */
function getErrorMessage(guildId, error) {
  const p = getActive(guildId);
  const prefix = p.error_prefix || 'Error';
  return `\`${prefix}: ${error}\``;
}

/** Get the "no response" message. */
function getNoResponse(guildId) {
  const p = getActive(guildId);
  return p.no_response || '`No response from Claude Code.`';
}

/** Get the timeout message. */
function getTimeoutMessage(guildId) {
  const p = getActive(guildId);
  return p.timeout_message || 'Request timed out. Try breaking it into smaller tasks.';
}

/** Get the interrupted job notification prefix. */
function getInterruptedMessage(guildId) {
  const p = getActive(guildId);
  return p.interrupted_message || 'Job interrupted by restart';
}

/** List all available persona names. */
function listPersonas() {
  const c = loadGlobal();
  return Object.keys(c.personas || {});
}

/** Switch to a different persona for a specific guild. Returns true on success. */
function setPersona(guildId, name) {
  const c = loadGlobal();
  if (!c.personas[name]) return false;
  ensureGuildDir(guildId);
  const file = getActivePersonaFile(guildId);
  fs.writeFileSync(file, JSON.stringify({ active: name }, null, 2), 'utf8');
  return true;
}

module.exports = {
  getAckMessage,
  getProcessingMessage,
  getLongRunningNote,
  getErrorMessage,
  getNoResponse,
  getTimeoutMessage,
  getInterruptedMessage,
  getActivePersonaName,
  listPersonas,
  setPersona,
};
