/**
 * Proactive Alerts — Periodic monitoring with Telegram notifications.
 *
 * Polls OPAI services for state changes and sends alerts to the admin group.
 * Does NOT poll emails (excluded per user request).
 *
 * Alert sources:
 *   - Engine health summary (service up/down transitions)
 *   - WordPress site health (offline/degraded transitions)
 *   - Morning briefing (8 AM) — services, WordPress, tasks, system info
 *
 * Task deadlines (overdue/upcoming) are ONLY reported in the morning briefing,
 * not as standalone periodic alerts.
 *
 * All alerts go to ADMIN_GROUP_ID with optional thread routing.
 */

const http = require('http');

// --- Configuration ---
const HEALTH_INTERVAL = 5 * 60 * 1000;    // 5 minutes
const WP_INTERVAL = 10 * 60 * 1000;       // 10 minutes
const BRIEFING_HOUR = 8;                    // 8 AM local time

// --- State Tracking ---
// Previous states for change detection
let prevServiceStates = {};   // { serviceName: 'healthy'|'unreachable' }
let prevSiteStates = {};      // { siteId: 'healthy'|'degraded'|'offline' }
let lastBriefingDate = null;  // YYYY-MM-DD of last auto-briefing
let alertsStarted = false;

// --- HTTP Helpers ---

function httpGet(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`Invalid JSON from ${url}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function httpGetAuth(url, token, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.get({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      timeout,
      headers: { 'Authorization': `Bearer ${token}` },
    }, (res) => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`Invalid JSON from ${url}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// --- Alert Sender ---

let _bot = null;
let _chatId = null;
let _alertThreadId = null; // optional: route alerts to a specific forum topic

function sendAlert(text, opts = {}) {
  if (!_bot || !_chatId) return;
  const msgOpts = { parse_mode: 'Markdown' };
  if (_alertThreadId) msgOpts.message_thread_id = _alertThreadId;
  Object.assign(msgOpts, opts);

  _bot.api.sendMessage(_chatId, text, msgOpts).catch(err => {
    console.error('[TG] [ALERT] Failed to send:', err.message);
  });
}

// --- Service Health Monitor ---

async function checkServiceHealth() {
  try {
    const data = await httpGet('http://127.0.0.1:8080/health/summary');
    if (!data || !data.services) return;

    const services = data.services;
    const alerts = [];

    for (const [name, info] of Object.entries(services)) {
      const status = info.status || 'unknown';
      const prev = prevServiceStates[name];

      if (prev && prev !== status) {
        if (status === 'unreachable' || status === 'error') {
          alerts.push(`*Service Down:* \`${name}\` went from ${prev} to ${status}`);
        } else if (prev === 'unreachable' || prev === 'error') {
          alerts.push(`*Service Recovered:* \`${name}\` is now ${status}`);
        }
      }

      prevServiceStates[name] = status;
    }

    if (alerts.length > 0) {
      sendAlert(`*Service Alert*\n\n${alerts.join('\n')}`);
      console.log(`[TG] [ALERT] ${alerts.length} service state change(s)`);
    }
  } catch (err) {
    // Engine itself might be down — only alert if it was previously up
    if (prevServiceStates['engine'] === 'healthy') {
      sendAlert('*Service Alert*\n\n`opai-engine` is unreachable.');
      prevServiceStates['engine'] = 'unreachable';
    }
  }
}

// --- WordPress Site Health ---

async function checkWordPressHealth() {
  const token = process.env.SUPABASE_SERVICE_KEY;
  if (!token) return;

  try {
    const sites = await httpGetAuth('http://127.0.0.1:8096/api/sites', token);
    if (!Array.isArray(sites)) return;

    const alerts = [];

    for (const site of sites) {
      const status = site.status || 'unknown';
      const prev = prevSiteStates[site.id];

      if (prev && prev !== status) {
        const icon = { 'healthy': '🟢', 'degraded': '🟡', 'offline': '🔴' }[status] || '⚪';

        if (status === 'offline' || status === 'degraded') {
          alerts.push(`${icon} *${site.name}* went ${status}\n   ${site.url}`);
        } else if (prev === 'offline' || prev === 'degraded') {
          alerts.push(`${icon} *${site.name}* recovered (now ${status})\n   ${site.url}`);
        }
      }

      prevSiteStates[site.id] = status;
    }

    // Also check for pending updates (aggregate alert, not per-change)
    const totalUpdates = sites.reduce((sum, s) => sum + (s.plugins_updates || 0) + (s.themes_updates || 0), 0);
    const coreUpdates = sites.filter(s => s.core_update);

    if (alerts.length > 0) {
      let msg = `*WordPress Alert*\n\n${alerts.join('\n')}`;
      if (totalUpdates > 0) {
        msg += `\n\n_${totalUpdates} pending update(s) across ${sites.length} site(s)_`;
      }
      sendAlert(msg);
      console.log(`[TG] [ALERT] ${alerts.length} WordPress state change(s)`);
    }
  } catch (err) {
    // WP service might be down — handled by service health monitor
  }
}

// --- Briefing Helpers ---

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const SEP = '━━━━━━━━━━━━━━━━━━';

function fmtDate(iso) {
  if (!iso) return '?';
  const d = new Date(iso + 'T00:00:00');
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function daysAgo(iso) {
  const due = new Date(iso + 'T00:00:00');
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.floor((now - due) / 86400000);
}

function bar(pct) {
  const filled = Math.round(Math.min(pct, 100) / 10);
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

function lvlIcon(pct) {
  if (pct < 60) return '🟢';
  if (pct < 85) return '🟡';
  return '🔴';
}

function trunc(str, len) {
  if (!str) return 'Untitled';
  return str.length > len ? str.substring(0, len - 1) + '…' : str;
}

// --- Morning Briefing ---

/**
 * Generate a morning briefing message — formatted for phone display.
 * @returns {Promise<string>} Formatted briefing text
 */
async function generateBriefing() {
  const now = new Date();
  const dateStr = `${MONTHS[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
  const lines = [];
  const token = process.env.SUPABASE_SERVICE_KEY;

  lines.push(`☀️ *Morning Briefing*`);
  lines.push(`${dateStr}`);

  // ── 1. Services ──
  try {
    const health = await httpGet('http://127.0.0.1:8080/health/summary');
    if (health && health.services) {
      const svcs = Object.entries(health.services);
      const down = svcs.filter(([, v]) => v.status !== 'healthy');
      const up = svcs.filter(([, v]) => v.status === 'healthy');

      lines.push('', SEP, '');
      if (down.length === 0) {
        lines.push(`🖥 *Services*  ✅ All ${svcs.length} healthy`);
      } else {
        lines.push(`🖥 *Services*  ${up.length}/${svcs.length} up`);
        lines.push('');
        down.forEach(([name, v]) => {
          lines.push(`  🔴 \`${name}\`  ${v.status}`);
        });
      }
    }
  } catch {
    lines.push('', SEP, '');
    lines.push('🖥 *Services*  🔴 Engine unreachable');
  }

  // ── 2. WordPress ──
  if (token) {
    try {
      const sites = await httpGetAuth('http://127.0.0.1:8096/api/sites', token);
      if (Array.isArray(sites) && sites.length > 0) {
        const needsAttention = sites.filter(s =>
          s.status !== 'healthy' || (s.plugins_updates || 0) > 0 ||
          (s.themes_updates || 0) > 0 || s.core_update
        );

        lines.push('', SEP, '');  // separator only when we have sites to show

        if (needsAttention.length === 0) {
          lines.push(`🌐 *WordPress*  ✅ All ${sites.length} sites clean`);
        } else {
          lines.push(`🌐 *WordPress*`);
          lines.push('');

          for (const site of sites) {
            const pUp = site.plugins_updates || 0;
            const tUp = site.themes_updates || 0;
            const cUp = site.core_update ? 1 : 0;
            const hasIssues = site.status !== 'healthy' || pUp > 0 || tUp > 0 || cUp > 0;

            if (!hasIssues) {
              lines.push(`  ✅ *${trunc(site.name, 28)}*`);
              continue;
            }

            const sIcon = { 'healthy': '🟢', 'degraded': '🟡', 'offline': '🔴' }[site.status] || '⚪';
            lines.push(`  ${sIcon} *${trunc(site.name, 28)}*`);

            if (site.status !== 'healthy') {
              lines.push(`     └ Status: ${site.status}`);
            }
            if (cUp)   lines.push(`     └ 🔄 Core update available`);
            if (pUp)   lines.push(`     └ 📦 ${pUp} plugin update${pUp > 1 ? 's' : ''}`);
            if (tUp)   lines.push(`     └ 🎨 ${tUp} theme update${tUp > 1 ? 's' : ''}`);
            lines.push('');
          }
        }
      }
      // If sites is empty array or not an array, skip WordPress section entirely
    } catch {
      // WP service unreachable — skip section silently
    }
  }

  // ── 3. Tasks ──
  try {
    const wsId = '80753c5a-beb5-498c-8d71-393a0342af27';
    const data = await httpGet(`http://127.0.0.1:8089/api/internal/list-items?workspace_id=${wsId}&limit=50`);
    const items = data.items || [];
    const today = new Date().toISOString().split('T')[0];

    const overdue = items.filter(i =>
      i.due_date && i.due_date < today && !['done', 'closed', 'archived'].includes(i.status)
    ).sort((a, b) => a.due_date.localeCompare(b.due_date));

    const dueToday = items.filter(i =>
      i.due_date && i.due_date === today && !['done', 'closed', 'archived'].includes(i.status)
    );

    const upcoming = items.filter(i => {
      if (!i.due_date || i.due_date <= today) return false;
      if (['done', 'closed', 'archived'].includes(i.status)) return false;
      const diff = (new Date(i.due_date + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000;
      return diff <= 7;
    }).sort((a, b) => a.due_date.localeCompare(b.due_date));

    const openTasks = items.filter(i =>
      i.type === 'task' && !['done', 'closed', 'archived'].includes(i.status)
    );

    lines.push('', SEP, '');
    lines.push(`📋 *Tasks*  ${openTasks.length} open`);

    if (overdue.length > 0) {
      lines.push('');
      lines.push(`🔴 *Overdue (${overdue.length})*`);
      overdue.slice(0, 5).forEach(i => {
        const late = daysAgo(i.due_date);
        lines.push(`  ⏰ ${trunc(i.title, 30)}`);
        lines.push(`       ${fmtDate(i.due_date)} · ${late}d late`);
      });
      if (overdue.length > 5) {
        lines.push(`  _+${overdue.length - 5} more_`);
      }
    }

    if (dueToday.length > 0) {
      lines.push('');
      lines.push(`🟡 *Due Today (${dueToday.length})*`);
      dueToday.slice(0, 5).forEach(i => {
        lines.push(`  📌 ${trunc(i.title, 30)}`);
      });
    }

    if (upcoming.length > 0) {
      lines.push('');
      lines.push(`🔵 *This Week (${upcoming.length})*`);
      upcoming.slice(0, 5).forEach(i => {
        lines.push(`  📅 ${trunc(i.title, 30)}`);
        lines.push(`       ${fmtDate(i.due_date)}`);
      });
    }

    if (overdue.length === 0 && dueToday.length === 0 && upcoming.length === 0) {
      lines.push('');
      lines.push('  ✨ No deadlines this week');
    }
  } catch {}

  // ── 4. System ──
  try {
    const { execSync } = require('child_process');
    const sh = (cmd) => execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim();

    const memLine = sh('free -m | grep Mem');
    const mp = memLine.split(/\s+/);
    const memUsed = parseInt(mp[2]) || 0;
    const memTotal = parseInt(mp[1]) || 1;
    const memPct = Math.round((memUsed / memTotal) * 100);
    const memUsedGB = (memUsed / 1024).toFixed(1);
    const memTotalGB = (memTotal / 1024).toFixed(1);

    const diskLine = sh("df -h / | tail -1");
    const dp = diskLine.split(/\s+/);
    const diskUsed = dp[2] || '?';
    const diskTotal = dp[1] || '?';
    const diskPctStr = (dp[4] || '0%').replace('%', '');
    const diskPct = parseInt(diskPctStr) || 0;

    const cpuStr = sh("top -bn1 | grep 'Cpu(s)' | awk '{print $2}' | cut -d'%' -f1");
    const cpuPct = Math.round(parseFloat(cpuStr) || 0);

    const load = sh("cat /proc/loadavg | awk '{print $1, $2, $3}'");
    const uptime = sh('uptime -p').replace('up ', '');

    lines.push('', SEP, '');
    lines.push('⚙️ *System*');
    lines.push('');
    lines.push(`${lvlIcon(cpuPct)} CPU   \`${String(cpuPct).padStart(3)}%\`  ${bar(cpuPct)}`);
    lines.push(`${lvlIcon(memPct)} Mem  \`${String(memPct).padStart(3)}%\`  ${bar(memPct)}`);
    lines.push(`       ${memUsedGB} / ${memTotalGB} GB`);
    lines.push(`${lvlIcon(diskPct)} Disk  \`${String(diskPct).padStart(3)}%\`  ${bar(diskPct)}`);
    lines.push(`       ${diskUsed} / ${diskTotal}`);
    lines.push('');
    lines.push(`📊 Load  ${load}`);
    lines.push(`⏱ Up ${uptime}`);
  } catch {}

  return lines.join('\n');
}

// --- Auto-Briefing Check ---

// Local date string (YYYY-MM-DD) — avoids UTC rollover mismatch with getHours()
function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function checkAutoBriefing() {
  const now = new Date();
  const today = localDateStr(now);
  const hour = now.getHours();

  // Send briefing ONLY during the 8 AM hour (8:00–8:59), not later in the day
  if (hour === BRIEFING_HOUR && lastBriefingDate !== today) {
    lastBriefingDate = today;
    try {
      const text = await generateBriefing();
      sendAlert(text);
      console.log(`[TG] [ALERT] Auto-briefing sent (${today} ${hour}:00 local)`);
    } catch (err) {
      console.error('[TG] [ALERT] Briefing error:', err.message);
    }
  }
}

// --- Start/Stop ---

let healthTimer = null;
let wpTimer = null;
let briefingTimer = null;

/**
 * Start the alert system.
 * @param {import('grammy').Bot} bot
 * @param {string|number} chatId - Admin group chat ID
 * @param {number} [alertThreadId] - Optional forum topic for alerts
 */
function startAlerts(bot, chatId, alertThreadId = null) {
  if (alertsStarted) return;
  alertsStarted = true;

  _bot = bot;
  _chatId = chatId;
  _alertThreadId = alertThreadId;

  console.log(`[TG] [ALERT] Starting proactive alerts (chat: ${chatId}, thread: ${alertThreadId || 'general'})`);

  // If we're starting after briefing hour, mark today as already sent
  // so a service restart mid-day doesn't re-send the morning briefing
  const startNow = new Date();
  const startHour = startNow.getHours();
  if (startHour >= BRIEFING_HOUR) {
    lastBriefingDate = localDateStr(startNow);
    console.log(`[TG] [ALERT] Started after ${BRIEFING_HOUR}AM (${startHour}:00 local, date=${lastBriefingDate}) — skipping today's briefing`);
  }

  // Initial health snapshot (no alerts on first run — just record state)
  checkServiceHealth().catch(() => {});
  setTimeout(() => checkWordPressHealth().catch(() => {}), 5000);

  // Start polling loops
  // Task deadlines are only reported in the 8 AM morning briefing — no standalone deadline alerts
  healthTimer = setInterval(() => checkServiceHealth().catch(e => console.error('[TG] [ALERT] Health error:', e.message)), HEALTH_INTERVAL);
  wpTimer = setInterval(() => checkWordPressHealth().catch(e => console.error('[TG] [ALERT] WP error:', e.message)), WP_INTERVAL);
  briefingTimer = setInterval(() => checkAutoBriefing().catch(e => console.error('[TG] [ALERT] Briefing error:', e.message)), 60000); // Check every minute for briefing time
}

function stopAlerts() {
  if (healthTimer) clearInterval(healthTimer);
  if (wpTimer) clearInterval(wpTimer);
  if (briefingTimer) clearInterval(briefingTimer);
  alertsStarted = false;
  console.log('[TG] [ALERT] Alerts stopped');
}

module.exports = {
  startAlerts,
  stopAlerts,
  generateBriefing,
  checkServiceHealth,
  checkWordPressHealth,
};
