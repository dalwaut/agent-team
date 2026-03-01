/**
 * WordPress Fast Path — Direct API calls for site management.
 *
 * Bypasses Claude CLI for WordPress status, updates, backups, and content.
 * Uses OP WordPress API at localhost:8096 with Supabase service key auth.
 *
 * Intent detection for free text + structured /wp command handler.
 */

const http = require('http');
const { InlineKeyboard } = require('grammy');

const WP_BASE = 'http://127.0.0.1:8096/api';

// Auth token — loaded from env or vault at startup
let AUTH_TOKEN = process.env.SUPABASE_SERVICE_KEY || '';

// Site cache (refreshed every 5 min)
let siteCache = { sites: [], ts: 0 };
const CACHE_TTL = 5 * 60 * 1000;

// --- HTTP Helpers ---

function wpGet(path, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const url = `${WP_BASE}${path}`;
    const req = http.get(url, {
      timeout,
      headers: { 'Authorization': `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' },
    }, (res) => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`Invalid JSON from ${path}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('WP API timeout')); });
  });
}

function wpPost(path, data = {}, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const url = new URL(`${WP_BASE}${path}`);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      timeout,
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = http.request(options, (res) => {
      let respBody = '';
      res.on('data', d => { respBody += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(respBody)); }
        catch { reject(new Error(`Invalid JSON from POST ${path}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('WP API timeout')); });
    req.write(body);
    req.end();
  });
}

// --- Site Resolution ---

async function getSites() {
  if (siteCache.sites.length > 0 && Date.now() - siteCache.ts < CACHE_TTL) {
    return siteCache.sites;
  }
  try {
    const sites = await wpGet('/sites');
    if (Array.isArray(sites)) {
      siteCache = { sites, ts: Date.now() };
      return sites;
    }
  } catch (err) {
    console.error('[TG] [WP] Failed to fetch sites:', err.message);
  }
  return siteCache.sites;
}

function findSite(sites, query) {
  if (!query) return null;
  const q = query.toLowerCase().trim();
  return sites.find(s =>
    s.name?.toLowerCase().includes(q) ||
    s.url?.toLowerCase().includes(q)
  );
}

// --- Formatters ---

function formatSiteStatus(site) {
  const statusIcon = { 'healthy': '🟢', 'degraded': '🟡', 'offline': '🔴', 'unknown': '⚪' }[site.status] || '⚪';
  const updates = (site.plugins_updates || 0) + (site.themes_updates || 0);
  const coreFlag = site.core_update ? ' | Core update available' : '';
  let line = `${statusIcon} *${site.name}*\n`;
  line += `   ${site.url}\n`;
  line += `   WP ${site.wp_version || '?'} | Theme: ${site.theme || '?'}\n`;
  line += `   Updates: ${updates > 0 ? `${updates} pending` : 'up to date'}${coreFlag}`;
  return line;
}

function formatUpdate(u, idx) {
  const name = u.title || u.name || u.slug || 'Unknown';
  const from = u.version || u.current_version || '?';
  const to = u.new_version || u.update_version || '?';
  return `${idx + 1}. *${name}* (${from} → ${to})`;
}

function formatBackup(b, idx) {
  const date = b.created_at ? new Date(b.created_at).toLocaleDateString() : '?';
  const size = b.size_bytes ? `${(b.size_bytes / 1024 / 1024).toFixed(1)}MB` : '?';
  const type = b.type || 'full';
  return `${idx + 1}. ${type} — ${date} (${size}) \`${b.status || '?'}\``;
}

function formatPost(p, idx) {
  const title = p.title?.rendered || p.title || 'Untitled';
  const status = p.status || '?';
  const date = p.date ? new Date(p.date).toLocaleDateString() : '?';
  return `${idx + 1}. *${title}* — ${status} (${date})`;
}

// --- Intent Detection (free text) ---

const WP_INTENT_PATTERNS = [
  { pattern: /\b(site|website)(s)?\s*(status|health|check)/i, intent: 'wp_sites' },
  { pattern: /\b(show|list|get|view|check)\b.*\b(site|website)(s)?\b/i, intent: 'wp_sites' },
  { pattern: /\bword ?press\b.*\b(status|site|update)/i, intent: 'wp_sites' },
  { pattern: /\b(pending|available)\s*update/i, intent: 'wp_updates_all' },
  { pattern: /\bupdate(s)?\b.*\b(site|website|plugin|theme|wordpress)/i, intent: 'wp_updates_all' },
  { pattern: /\bbackup(s)?\b.*\b(site|website|list|show)/i, intent: 'wp_backups' },
];

function detectWpIntent(text) {
  for (const { pattern, intent } of WP_INTENT_PATTERNS) {
    if (pattern.test(text)) return { intent };
  }
  return null;
}

// --- Intent Handlers ---

async function handleWpIntent(intent) {
  try {
    switch (intent) {
      case 'wp_sites': {
        const sites = await getSites();
        if (sites.length === 0) return 'No WordPress sites connected.';
        const lines = ['*Connected WordPress Sites:*\n'];
        sites.forEach(s => lines.push(formatSiteStatus(s)));
        return lines.join('\n');
      }

      case 'wp_updates_all': {
        const data = await wpGet('/updates/all-sites');
        if (!data.sites || data.sites.length === 0) return 'No sites found.';

        const lines = ['*WordPress Updates Summary:*\n'];
        for (const site of data.sites) {
          const pCount = site.plugin_updates?.length || 0;
          const tCount = site.theme_updates?.length || 0;
          const total = pCount + tCount;
          const icon = total > 0 ? '🔄' : '✅';
          lines.push(`${icon} *${site.name}* — ${total > 0 ? `${total} updates` : 'up to date'}`);
          if (pCount > 0) lines.push(`   Plugins: ${pCount}`);
          if (tCount > 0) lines.push(`   Themes: ${tCount}`);
        }

        if (data.totals) {
          lines.push(`\n*Total:* ${data.totals.plugins || 0} plugin + ${data.totals.themes || 0} theme updates`);
        }
        return lines.join('\n');
      }

      case 'wp_backups': {
        const sites = await getSites();
        const lines = ['*Recent Backups:*\n'];
        for (const site of sites) {
          try {
            const backups = await wpGet(`/sites/${site.id}/backups`);
            const list = Array.isArray(backups) ? backups : [];
            lines.push(`*${site.name}:*`);
            if (list.length === 0) {
              lines.push('   No backups');
            } else {
              list.slice(0, 3).forEach((b, i) => lines.push(`   ${formatBackup(b, i)}`));
            }
            lines.push('');
          } catch {
            lines.push(`*${site.name}:* Error fetching backups\n`);
          }
        }
        return lines.join('\n');
      }

      default:
        return null;
    }
  } catch (err) {
    console.error(`[TG] [WP] Intent error (${intent}):`, err.message);
    return null;
  }
}

// --- /wp Command Handler ---

/**
 * Handle /wp <subcommand> from Telegram.
 * @param {string} args - Everything after /wp
 * @param {number} userId - Telegram user ID
 * @returns {Promise<{ text: string, keyboard?: InlineKeyboard } | string>}
 */
async function handleWpCommand(args) {
  const parts = args.trim().split(/\s+/);
  const sub = (parts[0] || '').toLowerCase();
  const rest = parts.slice(1).join(' ');

  if (!sub || sub === 'help') {
    return [
      '*WordPress Management:*\n',
      '`/wp sites` — List connected sites',
      '`/wp status <site>` — Detailed site status',
      '`/wp updates` — Show all pending updates',
      '`/wp updates <site>` — Updates for a specific site',
      '`/wp update <site>` — Apply all updates (with confirmation)',
      '`/wp backup <site>` — Create a backup (with confirmation)',
      '`/wp backups <site>` — List backups for a site',
      '`/wp posts <site>` — Recent posts',
      '`/wp plugins <site>` — List plugins',
      '`/wp logs <site>` — Recent execution logs',
      '',
      '_Site names can be partial matches (e.g., "wauters" for WautersEdge)_',
    ].join('\n');
  }

  const sites = await getSites();

  if (sub === 'sites' || sub === 'list') {
    if (sites.length === 0) return 'No WordPress sites connected.';
    const lines = ['*Connected Sites:*\n'];
    sites.forEach(s => lines.push(formatSiteStatus(s)));
    return lines.join('\n');
  }

  if (sub === 'updates' && !rest) {
    return await handleWpIntent('wp_updates_all') || 'Could not fetch updates.';
  }

  // All remaining commands need a site
  const siteName = rest || (sub !== 'updates' ? '' : '');
  const site = siteName ? findSite(sites, siteName) : (sites.length === 1 ? sites[0] : null);

  if (sub === 'updates' && !site) {
    return await handleWpIntent('wp_updates_all') || 'Could not fetch updates.';
  }

  if (!site && ['status', 'update', 'backup', 'backups', 'posts', 'plugins', 'logs'].includes(sub)) {
    if (!siteName) {
      if (sites.length > 1) {
        const names = sites.map(s => `\`${s.name}\``).join(', ');
        return `Which site? Available: ${names}`;
      }
      return 'No sites found.';
    }
    return `Site "${siteName}" not found. Available: ${sites.map(s => `\`${s.name}\``).join(', ')}`;
  }

  switch (sub) {
    case 'status': {
      const info = await wpGet(`/sites/${site.id}`);
      const updates = await wpGet(`/sites/${site.id}/updates`).catch(() => null);
      const lines = [formatSiteStatus(info)];

      if (updates) {
        const plugins = updates.plugins || [];
        const themes = updates.themes || [];
        if (plugins.length > 0) {
          lines.push('\n*Plugin Updates:*');
          plugins.slice(0, 10).forEach((u, i) => lines.push(formatUpdate(u, i)));
        }
        if (themes.length > 0) {
          lines.push('\n*Theme Updates:*');
          themes.slice(0, 5).forEach((u, i) => lines.push(formatUpdate(u, i)));
        }
        if (plugins.length === 0 && themes.length === 0) {
          lines.push('\nAll plugins and themes are up to date.');
        }
      }
      return lines.join('\n');
    }

    case 'updates': {
      const updates = await wpGet(`/sites/${site.id}/updates`);
      const plugins = updates.plugins || [];
      const themes = updates.themes || [];
      const lines = [`*Updates for ${site.name}:*\n`];

      if (plugins.length > 0) {
        lines.push('*Plugins:*');
        plugins.forEach((u, i) => lines.push(formatUpdate(u, i)));
      }
      if (themes.length > 0) {
        lines.push('\n*Themes:*');
        themes.forEach((u, i) => lines.push(formatUpdate(u, i)));
      }
      if (plugins.length === 0 && themes.length === 0) {
        lines.push('Everything is up to date.');
      }
      return lines.join('\n');
    }

    case 'update': {
      // Return with confirmation keyboard
      const text = `Apply all updates to *${site.name}*?\nThis will update all plugins and themes.`;
      const keyboard = new InlineKeyboard()
        .text('Yes, update all', `wp:update-all:${site.id}`)
        .text('Cancel', `wp:cancel:${site.id}`);
      return { text, keyboard };
    }

    case 'backup': {
      const text = `Create a full backup of *${site.name}*?\nThis may take a few minutes.`;
      const keyboard = new InlineKeyboard()
        .text('Full backup', `wp:backup:${site.id}:full`)
        .text('Database only', `wp:backup:${site.id}:database`)
        .row()
        .text('Cancel', `wp:cancel:${site.id}`);
      return { text, keyboard };
    }

    case 'backups': {
      const backups = await wpGet(`/sites/${site.id}/backups`);
      const list = Array.isArray(backups) ? backups : [];
      if (list.length === 0) return `No backups found for *${site.name}*.`;
      const lines = [`*Backups for ${site.name}:*\n`];
      list.slice(0, 10).forEach((b, i) => lines.push(formatBackup(b, i)));
      return lines.join('\n');
    }

    case 'posts': {
      const result = await wpGet(`/sites/${site.id}/posts?per_page=10`);
      const posts = result.data || result || [];
      if (!Array.isArray(posts) || posts.length === 0) return `No posts found on *${site.name}*.`;
      const lines = [`*Recent Posts — ${site.name}:*\n`];
      posts.slice(0, 10).forEach((p, i) => lines.push(formatPost(p, i)));
      return lines.join('\n');
    }

    case 'plugins': {
      const result = await wpGet(`/sites/${site.id}/plugins`);
      const plugins = result.data || result || [];
      if (!Array.isArray(plugins) || plugins.length === 0) return `No plugins found on *${site.name}*.`;
      const active = plugins.filter(p => p.status === 'active');
      const inactive = plugins.filter(p => p.status !== 'active');
      const lines = [`*Plugins — ${site.name}:*\n`];
      lines.push(`*Active (${active.length}):*`);
      active.forEach(p => {
        const name = p.name || p.plugin || '?';
        const ver = p.version || '?';
        lines.push(`   ✅ ${name} (${ver})`);
      });
      if (inactive.length > 0) {
        lines.push(`\n*Inactive (${inactive.length}):*`);
        inactive.forEach(p => {
          const name = p.name || p.plugin || '?';
          lines.push(`   ⚪ ${name}`);
        });
      }
      return lines.join('\n');
    }

    case 'logs': {
      const result = await wpGet(`/sites/${site.id}/logs?limit=5`);
      const logs = result.logs || result || [];
      if (!Array.isArray(logs) || logs.length === 0) return `No execution logs for *${site.name}*.`;
      const lines = [`*Recent Logs — ${site.name}:*\n`];
      logs.slice(0, 5).forEach((log, i) => {
        const icon = { 'success': '✅', 'failed': '❌', 'rolled_back': '⏪', 'running': '🔄' }[log.status] || '⚪';
        const date = log.started_at ? new Date(log.started_at).toLocaleString() : '?';
        const dur = log.duration_ms ? `${(log.duration_ms / 1000).toFixed(1)}s` : '?';
        lines.push(`${i + 1}. ${icon} *${log.task_type}* — ${log.status} (${dur})\n   ${date} | ${log.trigger || 'manual'}`);
      });
      return lines.join('\n');
    }

    default:
      return `Unknown subcommand "${sub}". Try \`/wp help\`.`;
  }
}

// --- Callback Handlers (inline keyboard actions) ---

/**
 * Handle wp:* callback queries from inline keyboards.
 * @param {string} action - The action (update-all, backup, cancel)
 * @param {string} siteId - WordPress site UUID
 * @param {string} [extra] - Extra data (backup type, etc.)
 * @returns {Promise<string>} Response text
 */
async function handleWpCallback(action, siteId, extra) {
  try {
    switch (action) {
      case 'update-all': {
        const result = await wpPost(`/sites/${siteId}/updates/all`);
        if (result.status === 'success' || result.results) {
          return '✅ Updates applied successfully.';
        }
        return `Update result: ${JSON.stringify(result).substring(0, 500)}`;
      }

      case 'backup': {
        const backupType = extra || 'full';
        const result = await wpPost(`/sites/${siteId}/backups`, { backup_type: backupType });
        if (result.ok) {
          return `✅ ${backupType} backup started. Check progress with \`/wp backups\`.`;
        }
        return `Backup result: ${JSON.stringify(result).substring(0, 500)}`;
      }

      case 'cancel':
        return 'Action cancelled.';

      default:
        return `Unknown action: ${action}`;
    }
  } catch (err) {
    console.error(`[TG] [WP] Callback error (${action}):`, err.message);
    return `Error: ${err.message}`;
  }
}

/**
 * Set auth token (called at startup from env).
 */
function setAuthToken(token) {
  if (token) AUTH_TOKEN = token;
}

module.exports = {
  detectWpIntent,
  handleWpIntent,
  handleWpCommand,
  handleWpCallback,
  setAuthToken,
};
