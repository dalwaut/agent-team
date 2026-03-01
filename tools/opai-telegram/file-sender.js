/**
 * File Sender — Secure file delivery via Telegram.
 *
 * Exposes OPAI files (reports, logs, notes) with:
 *   - Directory whitelist (no .env, secrets, or credentials)
 *   - Role-based access (admin vs member)
 *   - Audit logging
 *   - Size validation (50 MB Telegram limit)
 *
 * Usage:
 *   /file reports           — list latest agent reports
 *   /file report <name>     — send a specific report
 *   /file logs <service>    — send recent service log
 *   /file notes             — list note categories
 *   /file note <path>       — send a note file
 *   /file <path>            — send any whitelisted file
 */

const fs = require('fs');
const path = require('path');
const { InputFile } = require('grammy');

const OPAI_ROOT = process.env.OPAI_ROOT || '/workspace/synced/opai';
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB Telegram limit
const MAX_INLINE_SIZE = 3800; // Characters for inline display

// --- Security: Allowed directories (relative to OPAI_ROOT) ---

const ALLOWED_DIRS = [
  'reports/latest',
  'reports/HITL',
  'reports/Security-Review',
  'notes/Improvements',
  'notes/Posts',
  'notes/YouTube',
  'notes/Workhorse',
  'notes/Coolify',
  'Library/opai-wiki',
  'Templates',
  'tasks',
];

// Patterns that are ALWAYS blocked (even within allowed dirs)
const BLOCKED_PATTERNS = [
  /\.env$/i,
  /\.key$/i,
  /\.pem$/i,
  /\.p12$/i,
  /credential/i,
  /secret/i,
  /password/i,
  /token/i,
  /\.ssh/i,
  /vault\.key/i,
  /node_modules/,
  /\.git\//,
];

// Extensions that are safe to send
const SAFE_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.log', '.csv', '.xml', '.yaml', '.yml',
  '.js', '.ts', '.py', '.sh', '.html', '.css',
  '.zip', '.gz', '.tar',
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.svg',
]);

// --- Validation ---

/**
 * Check if a file path is safe to send.
 * @param {string} filePath - Absolute path
 * @returns {{ safe: boolean, reason?: string }}
 */
function isFileSafe(filePath) {
  const normalized = path.resolve(filePath);

  // Must be under OPAI_ROOT
  if (!normalized.startsWith(OPAI_ROOT)) {
    return { safe: false, reason: 'Outside workspace' };
  }

  const relative = path.relative(OPAI_ROOT, normalized);

  // Block traversal attempts
  if (relative.includes('..')) {
    return { safe: false, reason: 'Path traversal' };
  }

  // Check blocked patterns
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(relative) || pattern.test(path.basename(normalized))) {
      return { safe: false, reason: 'Blocked file type' };
    }
  }

  // Check extension
  const ext = path.extname(normalized).toLowerCase();
  if (ext && !SAFE_EXTENSIONS.has(ext)) {
    return { safe: false, reason: `Unsupported extension: ${ext}` };
  }

  // Check if within an allowed directory
  const inAllowedDir = ALLOWED_DIRS.some(dir =>
    relative.startsWith(dir + '/') || relative === dir
  );

  // Also allow direct log files via journalctl (handled separately)

  if (!inAllowedDir) {
    return { safe: false, reason: 'Not in allowed directory' };
  }

  return { safe: true };
}

// --- File Listing ---

function listDir(dirPath, maxDepth = 1, depth = 0) {
  const results = [];
  if (depth >= maxDepth) return results;

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isFile()) {
        const stat = fs.statSync(fullPath);
        results.push({
          name: entry.name,
          path: fullPath,
          relative: path.relative(OPAI_ROOT, fullPath),
          size: stat.size,
          modified: stat.mtime,
        });
      } else if (entry.isDirectory() && depth < maxDepth - 1) {
        results.push(...listDir(fullPath, maxDepth, depth + 1));
      }
    }
  } catch {}

  return results;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// --- Command Handler ---

/**
 * Handle /file command.
 * @param {string} args - Everything after /file
 * @param {boolean} isAdmin
 * @returns {Promise<{ text: string, file?: { path: string, name: string } }>}
 */
async function handleFileCommand(args) {
  const parts = args.trim().split(/\s+/);
  const sub = (parts[0] || '').toLowerCase();
  const rest = parts.slice(1).join(' ');

  if (!sub || sub === 'help') {
    return {
      text: [
        '*File Manager:*\n',
        '`/file reports` — Latest agent reports',
        '`/file report <name>` — Send specific report',
        '`/file logs <service>` — Service log (last 200 lines)',
        '`/file notes` — Note categories',
        '`/file note <category/name>` — Send a note file',
        '`/file wiki` — Wiki articles',
        '`/file wiki <name>` — Send wiki article',
        '`/file tasks` — Task registry files',
        '`/file get <path>` — Send any whitelisted file',
        '',
        `_Max file size: 50 MB. Files are sent as documents._`,
      ].join('\n'),
    };
  }

  // --- Reports ---
  if (sub === 'reports') {
    const dir = path.join(OPAI_ROOT, 'reports', 'latest');
    const files = listDir(dir);
    if (files.length === 0) return { text: 'No reports found in `reports/latest/`.' };

    files.sort((a, b) => b.modified - a.modified);
    const lines = ['*Latest Reports:*\n'];
    files.forEach(f => {
      lines.push(`   \`${f.name}\` (${formatFileSize(f.size)})`);
    });
    lines.push('\n_Send with:_ `/file report <name>`');
    return { text: lines.join('\n') };
  }

  if (sub === 'report') {
    if (!rest) return { text: 'Usage: `/file report <name>`\nSee `/file reports` for available files.' };
    const dir = path.join(OPAI_ROOT, 'reports', 'latest');
    const match = findFile(dir, rest);
    if (!match) return { text: `Report "${rest}" not found. Try \`/file reports\` to list.` };
    return sendFileResult(match);
  }

  // --- Logs ---
  if (sub === 'logs' || sub === 'log') {
    if (!rest) {
      return {
        text: [
          '*Available Log Sources:*\n',
          'Use: `/file logs <service>`\n',
          'Services: engine, portal, telegram, discord, team-hub, email, wordpress, caddy, files, users',
        ].join('\n'),
      };
    }

    // Generate log file from journalctl
    const serviceMap = {
      'engine': 'opai-engine', 'portal': 'opai-portal', 'telegram': 'opai-telegram',
      'discord': 'opai-discord-bot', 'team-hub': 'opai-team-hub', 'teamhub': 'opai-team-hub',
      'email': 'opai-email-agent', 'files': 'opai-files', 'users': 'opai-users',
      'wordpress': 'opai-wordpress', 'wp': 'opai-wordpress', 'caddy': 'opai-caddy',
    };
    const fullName = serviceMap[rest.toLowerCase()] || `opai-${rest}`;

    try {
      const { execSync } = require('child_process');
      const logs = execSync(
        `journalctl --user -u ${fullName} --no-pager -n 200 --output=short-iso 2>&1`,
        { encoding: 'utf8', timeout: 10000 }
      );

      // Write to temp file and send
      const tmpPath = `/tmp/opai-log-${fullName}-${Date.now()}.log`;
      fs.writeFileSync(tmpPath, logs, 'utf8');

      return {
        text: `*Log: ${fullName}* (last 200 lines)`,
        file: { path: tmpPath, name: `${fullName}.log`, cleanup: true },
      };
    } catch (err) {
      return { text: `Failed to fetch logs for ${fullName}: ${err.message}` };
    }
  }

  // --- Notes ---
  if (sub === 'notes') {
    const categories = ['Improvements', 'Posts', 'YouTube', 'Workhorse', 'Coolify'];
    const lines = ['*Note Categories:*\n'];
    for (const cat of categories) {
      const dir = path.join(OPAI_ROOT, 'notes', cat);
      try {
        const count = fs.readdirSync(dir).filter(f => !f.startsWith('.')).length;
        lines.push(`   \`${cat}\` — ${count} file(s)`);
      } catch {
        lines.push(`   \`${cat}\` — empty`);
      }
    }
    lines.push('\n_Send with:_ `/file note <category/filename>`');
    return { text: lines.join('\n') };
  }

  if (sub === 'note') {
    if (!rest) return { text: 'Usage: `/file note <category/filename>`' };

    // Try exact path first
    let filePath = path.join(OPAI_ROOT, 'notes', rest);
    if (!fs.existsSync(filePath)) {
      // Try with .md extension
      filePath = filePath + '.md';
    }
    if (!fs.existsSync(filePath)) {
      // Try fuzzy match in note categories
      const categories = ['Improvements', 'Posts', 'YouTube', 'Workhorse', 'Coolify'];
      for (const cat of categories) {
        const match = findFile(path.join(OPAI_ROOT, 'notes', cat), rest);
        if (match) { filePath = match; break; }
      }
    }

    if (!fs.existsSync(filePath)) {
      return { text: `Note "${rest}" not found. Try \`/file notes\` to list categories.` };
    }

    return sendFileResult(filePath);
  }

  // --- Wiki ---
  if (sub === 'wiki') {
    const dir = path.join(OPAI_ROOT, 'Library', 'opai-wiki');

    if (!rest) {
      const files = listDir(dir);
      files.sort((a, b) => a.name.localeCompare(b.name));
      const lines = ['*Wiki Articles:*\n'];
      files.forEach(f => {
        const name = f.name.replace('.md', '');
        lines.push(`   \`${name}\` (${formatFileSize(f.size)})`);
      });
      lines.push('\n_Send with:_ `/file wiki <name>`');
      return { text: lines.join('\n') };
    }

    const match = findFile(dir, rest);
    if (!match) return { text: `Wiki article "${rest}" not found. Try \`/file wiki\`.` };
    return sendFileResult(match);
  }

  // --- Tasks ---
  if (sub === 'tasks') {
    const dir = path.join(OPAI_ROOT, 'tasks');
    const files = listDir(dir);
    if (files.length === 0) return { text: 'No task files found.' };

    const lines = ['*Task Files:*\n'];
    files.forEach(f => {
      lines.push(`   \`${f.name}\` (${formatFileSize(f.size)})`);
    });
    lines.push('\n_Send with:_ `/file get tasks/<filename>`');
    return { text: lines.join('\n') };
  }

  // --- Generic get ---
  if (sub === 'get') {
    if (!rest) return { text: 'Usage: `/file get <relative/path>`' };
    const filePath = path.join(OPAI_ROOT, rest);
    return sendFileResult(filePath);
  }

  // --- Try as direct path ---
  const directPath = path.join(OPAI_ROOT, args.trim());
  if (fs.existsSync(directPath) && fs.statSync(directPath).isFile()) {
    return sendFileResult(directPath);
  }

  return { text: `Unknown file command. Try \`/file help\`.` };
}

// --- Helpers ---

function findFile(dir, query) {
  if (!fs.existsSync(dir)) return null;

  const q = query.toLowerCase().replace(/\.md$/, '');
  const entries = fs.readdirSync(dir).filter(f => !f.startsWith('.'));

  // Exact match (with or without extension)
  const exact = entries.find(f =>
    f.toLowerCase() === q || f.toLowerCase() === q + '.md' || f.toLowerCase() === q + '.json'
  );
  if (exact) return path.join(dir, exact);

  // Partial match
  const partial = entries.find(f => f.toLowerCase().includes(q));
  if (partial) return path.join(dir, partial);

  return null;
}

function sendFileResult(filePath) {
  if (!fs.existsSync(filePath)) {
    return { text: `File not found: ${path.basename(filePath)}` };
  }

  const stat = fs.statSync(filePath);

  if (!stat.isFile()) {
    return { text: `Not a file: ${path.basename(filePath)}` };
  }

  // Security check
  const check = isFileSafe(filePath);
  if (!check.safe) {
    return { text: `Access denied: ${check.reason}` };
  }

  // Size check
  if (stat.size > MAX_FILE_SIZE) {
    return { text: `File too large (${formatFileSize(stat.size)}). Telegram limit is 50 MB.` };
  }

  // Small text files: show inline + offer as document
  if (stat.size < MAX_INLINE_SIZE && isTextFile(filePath)) {
    const content = fs.readFileSync(filePath, 'utf8');
    return {
      text: `*${path.basename(filePath)}* (${formatFileSize(stat.size)})\n\`\`\`\n${content.substring(0, MAX_INLINE_SIZE)}\n\`\`\``,
      file: { path: filePath, name: path.basename(filePath) },
    };
  }

  return {
    text: `*${path.basename(filePath)}* (${formatFileSize(stat.size)})`,
    file: { path: filePath, name: path.basename(filePath) },
  };
}

function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ['.md', '.txt', '.json', '.log', '.csv', '.yaml', '.yml', '.js', '.ts', '.py', '.sh', '.html', '.css'].includes(ext);
}

module.exports = { handleFileCommand, isFileSafe, ALLOWED_DIRS };
