/**
 * Persona Manager — Configurable personality layer for the Discord bot.
 *
 * Loads persona.json and provides message functions that adapt to the
 * active persona. Personas affect tone, status messages, error messages,
 * and emoji usage — not the underlying logic.
 *
 * Switch at runtime via `!@ persona <name>` or edit persona.json directly.
 */

const fs = require('fs');
const path = require('path');

const PERSONA_FILE = path.join(__dirname, 'persona.json');

let config = null;

function load() {
  try {
    config = JSON.parse(fs.readFileSync(PERSONA_FILE, 'utf8'));
  } catch {
    config = { active: 'professional', personas: {} };
  }
  return config;
}

function getActive() {
  const c = load();
  return c.personas[c.active] || c.personas.professional || {};
}

/** Get the acknowledgment message sent immediately when a request comes in. */
function getAckMessage() {
  const p = getActive();
  return p.acknowledgment || '**Working on it...** I\'ll update this message when ready.';
}

/** Get a rotating processing message based on elapsed seconds. Changes every ~30s. */
function getProcessingMessage(elapsedSeconds) {
  const p = getActive();
  const msgs = p.processing_messages || ['Processing...'];
  const index = Math.floor(elapsedSeconds / 30) % msgs.length;
  return msgs[index];
}

/** Get a note appended to progress when a task runs over 5 minutes. */
function getLongRunningNote() {
  const p = getActive();
  return p.long_running_note || '_Complex task — still processing..._';
}

/** Get persona-toned error message. */
function getErrorMessage(error) {
  const p = getActive();
  const prefix = p.error_prefix || 'Error';
  return `\`${prefix}: ${error}\``;
}

/** Get the "no response" message. */
function getNoResponse() {
  const p = getActive();
  return p.no_response || '`No response from Claude Code.`';
}

/** Get the timeout message. */
function getTimeoutMessage() {
  const p = getActive();
  return p.timeout_message || 'Request timed out. Try breaking it into smaller tasks.';
}

/** Get the interrupted job notification prefix. */
function getInterruptedMessage() {
  const p = getActive();
  return p.interrupted_message || 'Job interrupted by restart';
}

/** Get the name of the active persona. */
function getActivePersonaName() {
  const c = load();
  return c.active || 'professional';
}

/** List all available persona names. */
function listPersonas() {
  const c = load();
  return Object.keys(c.personas || {});
}

/** Switch to a different persona. Returns true on success. */
function setPersona(name) {
  const c = load();
  if (!c.personas[name]) return false;
  c.active = name;
  fs.writeFileSync(PERSONA_FILE, JSON.stringify(c, null, 2), 'utf8');
  config = c;
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
