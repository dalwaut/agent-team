/**
 * Proactive Alerts — Periodic monitoring with Telegram notifications.
 *
 * Polls OPAI services for state changes and sends alerts to the admin group.
 * Does NOT poll emails (excluded per user request).
 *
 * Alert sources:
 *   - Engine watchdog (lightweight /health ping — detects Engine death)
 *   - WordPress site health (offline/degraded transitions)
 *   - Morning briefing (8 AM) — services, WordPress, tasks, system info
 *
 * Per-service health monitoring (individual service up/down) is handled by the
 * Engine's heartbeat + notifier (tools/opai-engine/background/). Telegram only
 * checks if the Engine ITSELF is reachable — the one thing the Engine can't
 * self-report. See: Library/opai-wiki/infra/scheduling-architecture.md
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
// Engine watchdog state (only tracks Engine reachability, not per-service)
let prevServiceStates = {};   // { '_engine_http': 'healthy'|'unreachable' }
let prevSiteStates = {};      // { siteId: 'healthy'|'degraded'|'offline' }
let serviceDownSince = {};    // { '_engine_http': timestamp } — 10min grace period
let lastBriefingDate = null;  // YYYY-MM-DD of last auto-briefing
let alertsStarted = false;
const ALERT_GRACE_MS = 10 * 60 * 1000;  // 10 minutes before alerting

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
let _serverStatusThreadId = null; // optional: route status/briefings to Server Status topic
let _personalChatId = null; // DM chat for personal briefing (owner user ID)
let _teamGroupId = null; // WautersEdge team group chat ID

function sendAlert(text, opts = {}) {
  if (!_bot || !_chatId) return;
  const msgOpts = { parse_mode: 'Markdown' };
  if (_alertThreadId) msgOpts.message_thread_id = _alertThreadId;
  Object.assign(msgOpts, opts);

  _bot.api.sendMessage(_chatId, text, msgOpts).catch(err => {
    console.error('[TG] [ALERT] Failed to send:', err.message);
  });
}

function sendToServerStatus(text, opts = {}) {
  if (!_bot || !_chatId) return;
  const msgOpts = { parse_mode: 'Markdown' };
  if (_serverStatusThreadId) msgOpts.message_thread_id = _serverStatusThreadId;
  Object.assign(msgOpts, opts);

  _bot.api.sendMessage(_chatId, text, msgOpts).catch(err => {
    console.error('[TG] [ALERT] Failed to send to Server Status:', err.message);
  });
}

function sendToPersonal(text, opts = {}) {
  if (!_bot || !_personalChatId) return;
  const msgOpts = { parse_mode: 'Markdown' };
  Object.assign(msgOpts, opts);

  _bot.api.sendMessage(_personalChatId, text, msgOpts).catch(err => {
    console.error('[TG] [ALERT] Failed to send personal briefing:', err.message);
  });
}

function sendToTeamGroup(text, opts = {}) {
  if (!_bot || !_teamGroupId) return;
  const msgOpts = { parse_mode: 'Markdown' };
  Object.assign(msgOpts, opts);

  _bot.api.sendMessage(_teamGroupId, text, msgOpts).catch(err => {
    console.error('[TG] [ALERT] Failed to send team briefing:', err.message);
  });
}

// --- Service Health Monitor ---

async function checkServiceHealth() {
  // Step 1: Check engine reachability with the lightweight /health endpoint.
  // The heavy /api/health/summary probes 10+ services and can time out under
  // load (Google API polling saturates the event loop). Using /health (2ms vs
  // 650ms+) prevents false "unreachable" alerts.
  let engineReachable = false;
  try {
    await httpGet('http://127.0.0.1:8080/health');
    engineReachable = true;
  } catch {
    // Engine process is genuinely unreachable
  }

  if (!engineReachable) {
    // Engine is truly down — track grace period
    if (!serviceDownSince['_engine_http']) {
      serviceDownSince['_engine_http'] = Date.now();
      console.log('[TG] [ALERT] Engine unreachable — grace period started');
    }

    const downFor = Date.now() - serviceDownSince['_engine_http'];
    if (prevServiceStates['_engine_http'] !== 'unreachable' && downFor >= ALERT_GRACE_MS) {
      sendAlert('*Service Alert*\n\n`opai-engine` is unreachable.');
      prevServiceStates['_engine_http'] = 'unreachable';
      console.log('[TG] [ALERT] Engine unreachable alert sent (after grace)');
    }
    return;
  }

  // Engine is reachable — handle recovery
  if (serviceDownSince['_engine_http'] && prevServiceStates['_engine_http'] === 'unreachable') {
    const wasDown = Date.now() - serviceDownSince['_engine_http'];
    if (wasDown >= ALERT_GRACE_MS) {
      sendAlert('*Service Recovered:* `engine` is now reachable');
      console.log('[TG] [ALERT] Engine recovered alert sent');
    }
    delete serviceDownSince['_engine_http'];
    prevServiceStates['_engine_http'] = 'healthy';
    console.log('[TG] [ALERT] Engine HTTP recovered');
  }

  // Per-service health monitoring (individual service up/down transitions) is
  // handled by Engine's heartbeat + notifier. Telegram only checks Engine
  // reachability — the one thing the Engine can't self-report.
  // See: Library/opai-wiki/infra/scheduling-architecture.md
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
    const health = await httpGet('http://127.0.0.1:8080/api/health/summary');
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

  // ── 3. Tasks (count only — details go to personal/team briefings) ──
  try {
    const wsId = '80753c5a-beb5-498c-8d71-393a0342af27';
    const data = await httpGet(`http://127.0.0.1:8089/api/internal/list-items?workspace_id=${wsId}&limit=200`);
    const items = data.items || [];
    const today = new Date().toISOString().split('T')[0];

    const openTasks = items.filter(i =>
      !['done', 'closed', 'archived', 'completed'].includes((i.status || '').toLowerCase())
    );
    const overdue = openTasks.filter(i => i.due_date && i.due_date < today);

    lines.push('', SEP, '');
    lines.push(`📋 *Tasks*  ${openTasks.length} open`);
    if (overdue.length > 0) {
      lines.push(`  🔴 ${overdue.length} overdue`);
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

// --- Personal Morning Briefing ---

/**
 * Generate a personal morning briefing for the owner — tasks, deadlines, decisions.
 * Sent as a DM, not to any group.
 * @returns {Promise<string>} Formatted personal briefing text
 */
async function generatePersonalBriefing() {
  const now = new Date();
  const dateStr = `${MONTHS[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const lines = [];

  lines.push(`☀️ *Good morning, Dallas*`);
  lines.push(`${dayNames[now.getDay()]}, ${dateStr}`);

  try {
    const wsId = '80753c5a-beb5-498c-8d71-393a0342af27';
    const data = await httpGet(`http://127.0.0.1:8089/api/internal/list-items?workspace_id=${wsId}&limit=200`);
    const items = data.items || [];
    const today = new Date().toISOString().split('T')[0];
    const DONE = ['done', 'closed', 'archived', 'completed'];

    const openItems = items.filter(i => !DONE.includes((i.status || '').toLowerCase()));

    const overdue = openItems.filter(i =>
      i.due_date && i.due_date < today
    ).sort((a, b) => a.due_date.localeCompare(b.due_date));

    const dueToday = openItems.filter(i =>
      i.due_date && i.due_date === today
    );

    const upcoming = openItems.filter(i => {
      if (!i.due_date || i.due_date <= today) return false;
      const diff = (new Date(i.due_date + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000;
      return diff <= 7;
    }).sort((a, b) => a.due_date.localeCompare(b.due_date));

    const needsDecision = openItems.filter(i =>
      ['awaiting-human', 'manager review', 'back to you'].includes((i.status || '').toLowerCase())
    );

    if (overdue.length > 0) {
      lines.push('', SEP, '');
      lines.push(`🔴 *Overdue (${overdue.length})*`);
      overdue.slice(0, 8).forEach(i => {
        const late = daysAgo(i.due_date);
        const pIcon = { high: '🔺', urgent: '🔺', medium: '🔸', low: '🔹' }[(i.priority || '').toLowerCase()] || '▫️';
        lines.push(`  ${pIcon} ${trunc(i.title, 34)}`);
        lines.push(`       ${fmtDate(i.due_date)} · ${late}d late`);
      });
      if (overdue.length > 8) {
        lines.push(`  _+${overdue.length - 8} more_`);
      }
    }

    if (dueToday.length > 0) {
      lines.push('', SEP, '');
      lines.push(`🟡 *Due Today (${dueToday.length})*`);
      dueToday.slice(0, 5).forEach(i => {
        const pIcon = { high: '🔺', urgent: '🔺', medium: '🔸', low: '🔹' }[(i.priority || '').toLowerCase()] || '▫️';
        lines.push(`  ${pIcon} ${trunc(i.title, 34)}`);
      });
    }

    if (upcoming.length > 0) {
      lines.push('', SEP, '');
      lines.push(`🔵 *This Week (${upcoming.length})*`);
      upcoming.slice(0, 5).forEach(i => {
        lines.push(`  📅 ${trunc(i.title, 30)}`);
        lines.push(`       ${fmtDate(i.due_date)}`);
      });
      if (upcoming.length > 5) {
        lines.push(`  _+${upcoming.length - 5} more_`);
      }
    }

    if (needsDecision.length > 0) {
      lines.push('', SEP, '');
      lines.push(`⚡ *Needs Your Decision (${needsDecision.length})*`);
      needsDecision.slice(0, 5).forEach(i => {
        lines.push(`  🔔 ${trunc(i.title, 34)}`);
        lines.push(`       Status: ${i.status}`);
      });
    }

    if (overdue.length === 0 && dueToday.length === 0 && upcoming.length === 0 && needsDecision.length === 0) {
      lines.push('', SEP, '');
      lines.push('✨ Clear schedule — no deadlines or decisions pending');
    }

    // Summary footer
    lines.push('', SEP, '');
    lines.push(`📊 ${openItems.length} open items total`);
  } catch {
    lines.push('', SEP, '');
    lines.push('📋 _Could not load tasks_');
  }

  return lines.join('\n');
}


// --- Team Morning Briefing (WautersEdge) ---

/**
 * Generate a team morning briefing for the WautersEdge group.
 * Shows workspace status, overdue, coming up, stuck, and recently updated items.
 * @returns {Promise<string>} Formatted team briefing text
 */
async function generateTeamBriefing() {
  const now = new Date();
  const dateStr = `${MONTHS[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const lines = [];

  lines.push(`📋 *Team Briefing*`);
  lines.push(`${dayNames[now.getDay()]}, ${dateStr}`);

  try {
    const wsId = '80753c5a-beb5-498c-8d71-393a0342af27';
    const data = await httpGet(`http://127.0.0.1:8089/api/internal/list-items?workspace_id=${wsId}&limit=200`);
    const items = data.items || [];
    const today = new Date().toISOString().split('T')[0];
    const DONE = ['done', 'closed', 'archived', 'completed'];

    const openItems = items.filter(i => !DONE.includes((i.status || '').toLowerCase()));

    const overdue = openItems.filter(i =>
      i.due_date && i.due_date < today
    ).sort((a, b) => a.due_date.localeCompare(b.due_date));

    const dueToday = openItems.filter(i =>
      i.due_date && i.due_date === today
    );

    const upcoming = openItems.filter(i => {
      if (!i.due_date || i.due_date <= today) return false;
      const diff = (new Date(i.due_date + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000;
      return diff <= 7;
    }).sort((a, b) => a.due_date.localeCompare(b.due_date));

    const stuck = openItems.filter(i =>
      ['stuck', 'blocked', 'waiting on client', 'client reviewing'].includes((i.status || '').toLowerCase())
    );

    const inProgress = openItems.filter(i =>
      ['in-progress', 'working on', 'in progress'].includes((i.status || '').toLowerCase())
    );

    // Status summary bar
    lines.push('', SEP, '');
    lines.push(`📊 *Workspace Overview*`);
    lines.push(`  ${openItems.length} open · ${overdue.length} overdue · ${stuck.length} stuck`);
    if (inProgress.length > 0) {
      lines.push(`  ${inProgress.length} in progress`);
    }

    if (overdue.length > 0) {
      lines.push('', SEP, '');
      lines.push(`🔴 *Overdue (${overdue.length})*`);
      overdue.slice(0, 5).forEach(i => {
        const late = daysAgo(i.due_date);
        const pIcon = { high: '🔺', urgent: '🔺', medium: '🔸', low: '🔹' }[(i.priority || '').toLowerCase()] || '▫️';
        lines.push(`  ${pIcon} ${trunc(i.title, 30)}`);
        lines.push(`       ${fmtDate(i.due_date)} · ${late}d late`);
      });
      if (overdue.length > 5) {
        lines.push(`  _+${overdue.length - 5} more_`);
      }
    }

    if (stuck.length > 0) {
      lines.push('', SEP, '');
      lines.push(`🟠 *Stuck / Waiting (${stuck.length})*`);
      stuck.slice(0, 5).forEach(i => {
        lines.push(`  🚧 ${trunc(i.title, 30)}`);
        lines.push(`       Status: ${i.status}`);
      });
      if (stuck.length > 5) {
        lines.push(`  _+${stuck.length - 5} more_`);
      }
    }

    if (dueToday.length > 0) {
      lines.push('', SEP, '');
      lines.push(`🟡 *Due Today (${dueToday.length})*`);
      dueToday.slice(0, 5).forEach(i => {
        lines.push(`  📌 ${trunc(i.title, 30)}`);
      });
    }

    if (upcoming.length > 0) {
      lines.push('', SEP, '');
      lines.push(`🔵 *Coming Up (${upcoming.length})*`);
      upcoming.slice(0, 5).forEach(i => {
        lines.push(`  📅 ${trunc(i.title, 30)}`);
        lines.push(`       ${fmtDate(i.due_date)}`);
      });
      if (upcoming.length > 5) {
        lines.push(`  _+${upcoming.length - 5} more_`);
      }
    }

    if (inProgress.length > 0) {
      lines.push('', SEP, '');
      lines.push(`🟢 *In Progress (${inProgress.length})*`);
      inProgress.slice(0, 5).forEach(i => {
        lines.push(`  🔨 ${trunc(i.title, 30)}`);
      });
      if (inProgress.length > 5) {
        lines.push(`  _+${inProgress.length - 5} more_`);
      }
    }

    if (openItems.length === 0) {
      lines.push('', SEP, '');
      lines.push('✨ All clear — no open items');
    }
  } catch {
    lines.push('', SEP, '');
    lines.push('_Could not load workspace data_');
  }

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

  // Send briefings ONLY during the 8 AM hour (8:00–8:59), not later in the day
  if (hour === BRIEFING_HOUR && lastBriefingDate !== today) {
    lastBriefingDate = today;

    // 1. System briefing → Server Status topic (admin group)
    try {
      const text = await generateBriefing();
      sendToServerStatus(text);
      console.log(`[TG] [ALERT] System briefing → Server Status (${today})`);
    } catch (err) {
      console.error('[TG] [ALERT] System briefing error:', err.message);
    }

    // 2. Personal briefing → DM to owner
    if (_personalChatId) {
      try {
        const text = await generatePersonalBriefing();
        sendToPersonal(text);
        console.log(`[TG] [ALERT] Personal briefing → DM (${today})`);
      } catch (err) {
        console.error('[TG] [ALERT] Personal briefing error:', err.message);
      }
    }

    // 3. Team briefing → WautersEdge group
    if (_teamGroupId) {
      try {
        const text = await generateTeamBriefing();
        sendToTeamGroup(text);
        console.log(`[TG] [ALERT] Team briefing → WautersEdge group (${today})`);
      } catch (err) {
        console.error('[TG] [ALERT] Team briefing error:', err.message);
      }
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
 * @param {Object} opts - Optional thread/chat IDs
 * @param {number} [opts.alertThreadId] - Forum topic for alerts
 * @param {number} [opts.serverStatusThreadId] - Forum topic for server status / briefings
 * @param {number} [opts.personalChatId] - DM chat ID for personal briefing
 * @param {number} [opts.teamGroupId] - Team group chat ID for team briefing
 */
function startAlerts(bot, chatId, opts = {}) {
  if (alertsStarted) return;
  alertsStarted = true;

  _bot = bot;
  _chatId = chatId;
  _alertThreadId = opts.alertThreadId || null;
  _serverStatusThreadId = opts.serverStatusThreadId || null;
  _personalChatId = opts.personalChatId || null;
  _teamGroupId = opts.teamGroupId || null;

  console.log(`[TG] [ALERT] Starting proactive alerts (admin: ${chatId}, personal: ${_personalChatId || 'none'}, team: ${_teamGroupId || 'none'})`);

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
  generatePersonalBriefing,
  generateTeamBriefing,
  checkServiceHealth,
  checkWordPressHealth,
};
