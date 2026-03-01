/**
 * OPAI Shared YouTube — Node.js wrapper for Discord bot.
 *
 * Spawns the Python shared library as the single source of truth.
 *
 * Usage:
 *   const { isYouTubeUrl, extractYouTubeUrl, processYouTubeUrl, formatDiscordSummary } = require('../shared/youtube');
 */

const { spawn } = require('child_process');
const path = require('path');

const YOUTUBE_PY = path.join(__dirname, 'youtube.py');

// Matches youtube.com/watch, youtu.be/, shorts, embed, live
const YOUTUBE_REGEX = /https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?[^\s]*v=|shorts\/|embed\/|live\/|v\/)|youtu\.be\/)([\w-]{11})\S*/;

/**
 * Quick check if text contains a YouTube URL.
 */
function isYouTubeUrl(text) {
  return YOUTUBE_REGEX.test(text);
}

/**
 * Extract the first YouTube URL from text.
 * Returns the URL string or null.
 */
function extractYouTubeUrl(text) {
  const match = text.match(YOUTUBE_REGEX);
  return match ? match[0] : null;
}

/**
 * Process a YouTube URL via the shared Python library.
 * Optionally summarize via Claude CLI.
 *
 * Returns a Promise that resolves to the parsed JSON result.
 */
function processYouTubeUrl(url, { summarize = false } = {}) {
  return new Promise((resolve, reject) => {
    const args = [YOUTUBE_PY, url];
    if (summarize) args.push('--summarize');

    // Clean env to avoid nested Claude session issues
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    const proc = spawn('python3', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      timeout: summarize ? 180000 : 30000,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        // Try to parse partial JSON from stdout
        try {
          const result = JSON.parse(stdout);
          if (result.error) return resolve(result);
        } catch {}
        return reject(new Error(`YouTube processor exited ${code}: ${stderr.substring(0, 300)}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`Failed to parse YouTube result: ${e.message}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn YouTube processor: ${err.message}`));
    });
  });
}

/**
 * Format a YouTube processing result for Discord (under 2000 chars).
 */
function formatDiscordSummary(result) {
  if (result.error && !result.title) {
    return `**YouTube Error:** ${result.error}`;
  }

  const lines = [];

  // Title and author
  const title = result.title || 'Unknown Video';
  const author = result.author || 'Unknown';
  lines.push(`**${title}**`);
  lines.push(`*by ${author}*`);
  lines.push('');

  // Summary data (from Claude analysis)
  const sd = result.summary_data;
  if (sd) {
    if (sd.description) {
      lines.push(sd.description);
      lines.push('');
    }

    if (sd.key_points && sd.key_points.length > 0) {
      lines.push('**Key Points:**');
      for (const point of sd.key_points.slice(0, 6)) {
        lines.push(`- ${point}`);
      }
      lines.push('');
    }

    if (sd.topics && sd.topics.length > 0) {
      lines.push(`**Topics:** ${sd.topics.join(', ')}`);
    }
  } else if (result.transcript) {
    // No summary — show transcript preview
    const preview = result.transcript.substring(0, 300).trim();
    lines.push('**Transcript Preview:**');
    lines.push(`> ${preview}...`);
  }

  if (result.error) {
    lines.push(`\n*Note: ${result.error}*`);
  }

  // Reaction legend
  lines.push('');
  lines.push('**React to act:**');
  lines.push('\uD83D\uDCDD Save to Brain \u2022 \uD83D\uDD2C Research \u2022 \u270D\uFE0F Re-Write \u2022 \uD83D\uDCA1 PRD Idea');

  // Trim to Discord limit
  let text = lines.join('\n');
  if (text.length > 1900) {
    text = text.substring(0, 1897) + '...';
  }
  return text;
}

module.exports = {
  YOUTUBE_REGEX,
  isYouTubeUrl,
  extractYouTubeUrl,
  processYouTubeUrl,
  formatDiscordSummary,
};
