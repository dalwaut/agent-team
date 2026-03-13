/**
 * OPAI Shared Instagram — Node.js wrapper for Telegram bot.
 *
 * Spawns the Python shared library as the single source of truth.
 *
 * Usage:
 *   const { isInstagramUrl, extractInstagramUrl, processInstagramUrl } = require('../shared/instagram');
 */

const { spawn } = require('child_process');
const path = require('path');

const INSTAGRAM_PY = path.join(__dirname, 'instagram.py');

// Matches instagram.com/reel/, /reels/, /p/, /tv/
const INSTAGRAM_REGEX = /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels|p|tv)\/([\w-]+)\/?(?:\?[^\s]*)?/i;

/**
 * Quick check if text contains an Instagram URL.
 */
function isInstagramUrl(text) {
  return INSTAGRAM_REGEX.test(text);
}

/**
 * Extract the first Instagram URL from text.
 * Returns the URL string or null.
 */
function extractInstagramUrl(text) {
  const match = text.match(INSTAGRAM_REGEX);
  return match ? match[0] : null;
}

/**
 * Extract the shortcode from an Instagram URL.
 * Returns the shortcode string or null.
 */
function extractShortcode(text) {
  const match = text.match(INSTAGRAM_REGEX);
  return match ? match[1] : null;
}

/**
 * Process an Instagram URL via the shared Python library.
 *
 * Options:
 *   mode: 'intel' (default) or 'build'
 *   frames: boolean (default false) — download + extract frames
 *   metadataOnly: boolean (default false) — only fetch metadata
 *
 * Returns a Promise that resolves to the parsed JSON result.
 */
function processInstagramUrl(url, { mode = 'intel', frames = false, metadataOnly = false } = {}) {
  return new Promise((resolve, reject) => {
    const args = [INSTAGRAM_PY, url];
    if (mode) args.push('--mode', mode);
    if (frames) args.push('--frames');
    if (metadataOnly) args.push('--metadata-only');

    // Clean env to avoid nested Claude session issues
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    const timeoutMs = frames ? 180000 : 60000;

    const proc = spawn('python3', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      timeout: timeoutMs,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        try {
          const result = JSON.parse(stdout);
          if (result.error) return resolve(result);
        } catch {}
        return reject(new Error(`Instagram processor exited ${code}: ${stderr.substring(0, 300)}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`Failed to parse Instagram result: ${e.message}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn Instagram processor: ${err.message}`));
    });
  });
}

module.exports = {
  INSTAGRAM_REGEX,
  isInstagramUrl,
  extractInstagramUrl,
  extractShortcode,
  processInstagramUrl,
};
