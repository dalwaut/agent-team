/**
 * Command Handlers — Admin and system commands for OPAI Telegram Bridge.
 *
 * Commands:
 *   /start        — Welcome message
 *   /help         — Command reference
 *   /status       — Active jobs
 *   /reset        — Clear conversation context
 *   /services     — OPAI service statuses
 *   /logs <svc>   — Tail recent service logs
 *   /health       — System health (CPU, mem, disk)
 *   /task <text>  — Create a task in the registry
 *   /email        — Email management (check, tasks, drafts, approve, reject)
 *   /hub          — Team Hub (task, note, idea, status, search)
 *   /role         — User role management (owner only)
 *   /topic        — Forum topic workspace binding
 *   /config       — Chat configuration
 *   /persona      — Bot personality
 *   /briefing     — Morning briefing (on-demand)
 *   /file         — File manager (reports, logs, notes, wiki)
 *   /apps         — Launch Mini Apps (WordPress, Team Hub)
 *   /approve      — Worker approvals & HITL management
 *   /activity     — Live activity snapshot from engine heartbeat
 *   /usage        — Claude plan utilization
 *   /brain        — 2nd Brain (search, save, inbox, suggestions)
 *   /tasks        — Task registry (summary, list, complete, cancel)
 *   /review       — AI-powered log analysis
 *   /notify       — Personal notification watches (watch task, list, clear)
 *   /newsletter   — Newsletter management (send, preview, list)
 *   /topicid      — Show current forum topic thread ID (for config)
 *   /demo         — Vercel demo platform (deploy, list, teardown, sweep)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { InputFile } = require('grammy');
const { getActiveJobs } = require('../job-manager');
const { clearScope, buildScopeKey, listActiveScopes, getScopeData, setScopeTopic } = require('../conversation-state');
const {
  getUserRole, hasPermission, setUserRole, removeUser, listUsers,
  setTopicScope, getTopicScope, getAssistantMode, setAssistantMode,
} = require('../access-control');
const { OPAI_ROOT } = require('../claude-handler');
const { handleWpCommand } = require('../wordpress-fast');
const { generateBriefing, generatePersonalBriefing, generateTeamBriefing } = require('../alerts');
const { handleFileCommand } = require('../file-sender');
const { startTaskCreation, pendingDangerRuns } = require('./callbacks');
const { InlineKeyboard } = require('grammy');
const { engineGet, enginePost, engineDelete, brainGet, brainPost } = require('../engine-api');
const { askClaude } = require('../claude-handler');
const { createJob, completeJob, failJob } = require('../job-manager');

function formatElapsed(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

function exec(cmd, timeout = 10000) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout, env: { ...process.env, PATH: process.env.PATH } }).trim();
  } catch (err) {
    return err.stderr || err.message || 'Command failed';
  }
}

function isAdmin(userId) {
  const role = getUserRole(userId);
  return role === 'owner' || role === 'admin';
}

/**
 * Register all command handlers on the bot.
 * @param {import('grammy').Bot} bot
 */
function registerCommands(bot) {

  // /start — Welcome message (also handles deep-link params like ?start=apps)
  bot.command('start', async (ctx) => {
    const role = getUserRole(ctx.from.id);
    if (!role) {
      return ctx.reply(
        'Welcome to OPAI Bot.\n\n' +
        'You are not yet whitelisted. Contact the admin to get access.\n' +
        `Your user ID: \`${ctx.from.id}\``,
        { parse_mode: 'Markdown' }
      );
    }

    // Handle deep-link: /start apps → show Mini App buttons
    const param = (ctx.match || '').trim();
    if (param === 'apps' && isAdmin(ctx.from.id) && ctx.chat?.type === 'private') {
      const baseUrl = process.env.WEBHOOK_URL
        ? process.env.WEBHOOK_URL.replace('/telegram/webhook', '')
        : 'https://opai.boutabyte.com';
      return ctx.reply('Tap a button below to launch a Mini App:', {
        reply_markup: {
          keyboard: [[{
            text: 'WordPress Manager',
            web_app: { url: baseUrl + '/telegram/mini-apps/wordpress.html' },
          }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      });
    }

    if (isAdmin(ctx.from.id)) {
      return ctx.reply(
        '*Welcome back, admin.* Full OPAI access enabled.\n\n' +
        'Send any message to chat with Claude, or use commands:\n\n' +
        '*System:*\n' +
        '`/services` — Service statuses\n' +
        '`/health` — System resources\n' +
        '`/logs <service>` — Recent logs\n\n' +
        '*Work:*\n' +
        '`/task <text>` — Create a task\n' +
        '`/email check` — Check inbox\n' +
        '`/hub status` — Team Hub overview\n\n' +
        '`/help` — Full command list\n' +
        '`/reset` — Clear conversation',
        { parse_mode: 'Markdown' }
      );
    }

    return ctx.reply(
      '*Welcome to OPAI.*\n\n' +
      'You have Team Hub access. Use:\n' +
      '`/hub task <text>` — Create a task\n' +
      '`/hub note <text>` — Add a note\n' +
      '`/hub status` — Your workspace\n' +
      '`/help` — All commands',
      { parse_mode: 'Markdown' }
    );
  });

  // /help — Command reference
  bot.command('help', async (ctx) => {
    const admin = isAdmin(ctx.from.id);
    const lines = ['*OPAI Bot — Command Reference*\n'];

    lines.push(
      '*General:*',
      '`/start` — Welcome message',
      '`/help` — This help message',
      '`/status` — Show active jobs',
      '`/sessions` — List active conversations',
      '`/label <text>` — Name this conversation',
      '`/reset` — Clear conversation context',
    );

    if (admin) {
      lines.push(
        '\n*System (admin):*',
        '`/services` — All OPAI service statuses',
        '`/health` — CPU, memory, disk usage',
        '`/logs <service>` — Last 30 log lines',
        '   Services: engine, portal, telegram, discord, team-hub, email, files, users, wordpress, caddy, vault, brain, oc, browser',
        '\n*Tasks & Email (admin):*',
        '`/task <text>` — Create task in registry',
        '`/email check` — Check inbox for new mail',
        '`/email tasks` — Pending email tasks',
        '`/email drafts` — Pending response drafts',
        '`/email approve <id>` — Send approved draft',
        '`/email reject <id>` — Reject draft',
        '\n*Team Hub:*',
        '`/hub status` — Workspace overview',
        '`/hub task <text>` — Create task',
        '`/hub note <text>` — Add note',
        '`/hub idea <text>` — Log idea',
        '`/hub search <query>` — Search workspace',
        '\n*WordPress (admin):*',
        '`/wp sites` — Connected site statuses',
        '`/wp status <site>` — Detailed site info',
        '`/wp updates` — Pending updates',
        '`/wp update <site>` — Apply updates',
        '`/wp backup <site>` — Create backup',
        '\n*Approvals (admin):*',
        '`/approve` — Pending worker approvals',
        '`/approve hitl` — HITL briefings awaiting response',
        '`/approve <id>` — View + approve/deny',
        '\n*Intelligence (admin):*',
        '`/usage` — Claude plan utilization',
        '`/rag <question>` — Query RAG knowledge base (free)',
        '`/brain search <q>` — Search 2nd Brain',
        '`/brain save <text>` — Quick-capture to inbox',
        '`/brain inbox` — Pending inbox items',
        '`/review [service]` — AI log analysis',
        '\n*Task Registry (admin):*',
        '`/tasks` — Summary by status',
        '`/tasks list` — Pending tasks',
        '`/tasks complete <id>` — Mark complete',
        '`/tasks cancel <id>` — Cancel task',
        '\n*Tools (admin):*',
        '`/activity` — Live activity snapshot (workers, tasks, resources)',
        '`/briefing` — Morning briefing (services, sites, tasks)',
        '`/file reports` — Latest agent reports',
        '`/file logs <service>` — Download service log',
        '`/file notes` — Note categories',
        '`/file wiki` — Wiki articles',
        '\n*Configuration (admin):*',
        '`/role set <userId> <role>` — Set user role',
        '`/role list` — List all users',
        '`/role remove <userId>` — Remove access',
        '`/topic bind <wsId>` — Bind topic to workspace',
        '`/topic info` — Show topic binding',
        '`/topic assistant on|off` — Toggle assistant mode',
        '`/topicid` — Show this topic\'s thread ID',
        '`/persona list` — Show personalities',
        '`/persona set <name>` — Change personality',
        '\n*Newsletter (admin):*',
        '`/newsletter send` — Send pending announcements now',
        '`/newsletter preview` — Preview what would be sent',
        '`/newsletter list` — All announcements + status',
        '\n*Notifications (admin):*',
        '`/notify <task-id>` — Watch task for completion',
        '`/notify list` — Active watches',
        '`/notify clear` — Clear fired watches',
        '\n*Autonomous:*',
        '`/danger <instruction>` — Execute autonomously (owner)',
        '`/danger` — Execute last plan autonomously (owner)',
        '\n*Free Text:*',
        'Just type anything — Claude handles it with full OPAI access.',
        'Send a YouTube URL — auto-transcripts with action buttons.',
      );
    } else {
      lines.push(
        '\n*Team Hub:*',
        '`/hub task <text>` — Create task',
        '`/hub note <text>` — Add note',
        '`/hub status` — Workspace overview',
        '\n*Free Text:*',
        'Type anything to chat with the AI assistant.',
      );
    }

    return ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  });

  // /status — Show active jobs
  bot.command('status', async (ctx) => {
    const active = getActiveJobs();
    if (active.length === 0) {
      return ctx.reply('No active jobs running.');
    }
    const lines = active.map(j => {
      const elapsed = Math.round((Date.now() - j.startTime) / 1000);
      return `- *${j.id}* — "${j.query}" (${formatElapsed(elapsed)})`;
    });
    return ctx.reply(`*Active Jobs (${active.length}):*\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
  });

  // /topicid — Show the current forum topic's thread ID (for config)
  bot.command('topicid', async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) {
      return ctx.reply('No thread ID — this is the General topic (no `message_thread_id`).');
    }
    return ctx.reply(
      `*Topic Thread ID:* \`${threadId}\`\n\nChat ID: \`${ctx.chat.id}\`\nUse this as \`ALERT_THREAD_ID\` in \`.env\` to route alerts here.`,
      { parse_mode: 'Markdown' }
    );
  });

  // /reset — Clear conversation context and session
  bot.command('reset', async (ctx) => {
    const threadId = ctx.message?.message_thread_id || 'general';
    const scopeKey = buildScopeKey(ctx.chat.id, threadId, ctx.from.id);
    clearScope(scopeKey);
    return ctx.reply('Conversation context cleared. Starting fresh.');
  });

  // /services — OPAI service statuses
  bot.command('services', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Admin only.');

    const services = [
      'opai-vault', 'opai-caddy', 'opai-portal', 'opai-engine',
      'opai-brain', 'opai-files', 'opai-team-hub', 'opai-users',
      'opai-wordpress', 'opai-oc-broker', 'opai-browser',
      'opai-discord-bot', 'opai-telegram',
    ];

    const lines = ['*OPAI Services:*\n'];
    for (const svc of services) {
      try {
        const out = exec(`systemctl --user is-active ${svc}.service 2>/dev/null`);
        const icon = out === 'active' ? '🟢' : out === 'inactive' ? '⚪' : '🔴';
        lines.push(`${icon} \`${svc}\` — ${out}`);
      } catch {
        lines.push(`⚪ \`${svc}\` — unknown`);
      }
    }

    return ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  });

  // /health — System resource overview
  bot.command('health', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Admin only.');

    const cpu = exec("top -bn1 | grep 'Cpu(s)' | awk '{print $2}' | cut -d'%' -f1");
    const memLine = exec("free -m | grep Mem");
    const memParts = memLine.split(/\s+/);
    const memTotal = memParts[1] || '?';
    const memUsed = memParts[2] || '?';
    const disk = exec("df -h / | tail -1 | awk '{print $3 \"/\" $2 \" (\" $5 \")\"}'");
    const uptime = exec("uptime -p");
    const load = exec("cat /proc/loadavg | awk '{print $1, $2, $3}'");

    return ctx.reply(
      '*System Health:*\n\n' +
      `CPU: \`${cpu}%\`\n` +
      `Memory: \`${memUsed}/${memTotal} MB\`\n` +
      `Disk: \`${disk}\`\n` +
      `Load: \`${load}\`\n` +
      `Uptime: ${uptime}`,
      { parse_mode: 'Markdown' }
    );
  });

  // /logs <service> — Tail recent logs
  bot.command('logs', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Admin only.');

    const svcName = (ctx.match || '').trim();
    if (!svcName) {
      return ctx.reply(
        '*Usage:* `/logs <service>`\n\n' +
        'Services: engine, portal, telegram, discord, team-hub, email, files, users, wordpress, caddy, vault, brain, oc, browser',
        { parse_mode: 'Markdown' }
      );
    }

    // Map shorthand to full service names
    const serviceMap = {
      'engine': 'opai-engine', 'portal': 'opai-portal', 'telegram': 'opai-telegram',
      'discord': 'opai-discord-bot', 'team-hub': 'opai-team-hub', 'teamhub': 'opai-team-hub',
      'email': 'opai-email-agent', 'files': 'opai-files', 'users': 'opai-users',
      'wordpress': 'opai-wordpress', 'wp': 'opai-wordpress', 'caddy': 'opai-caddy',
      'vault': 'opai-vault', 'brain': 'opai-brain',
      'oc': 'opai-oc-broker', 'oc-broker': 'opai-oc-broker', 'openclaw': 'opai-oc-broker',
      'browser': 'opai-browser',
    };
    const fullName = serviceMap[svcName.toLowerCase()] || `opai-${svcName}`;

    const logs = exec(`journalctl --user -u ${fullName} --no-pager -n 30 --output=short-iso 2>&1`, 15000);

    // Truncate to fit Telegram limit
    const trimmed = logs.length > 3800 ? logs.substring(logs.length - 3800) : logs;

    return ctx.reply(`*Logs: ${fullName}*\n\`\`\`\n${trimmed}\n\`\`\``, { parse_mode: 'Markdown' });
  });

  // /task <text> — Create task in registry
  bot.command('task', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Admin only.');

    const taskText = (ctx.match || '').trim();
    if (!taskText) return ctx.reply('*Usage:* `/task <description>`', { parse_mode: 'Markdown' });

    try {
      const tasksFile = path.join(OPAI_ROOT, 'tasks', 'queue.json');
      let queue = [];
      if (fs.existsSync(tasksFile)) {
        queue = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
      }

      const task = {
        id: `tg-${Date.now()}`,
        title: taskText,
        source: 'telegram',
        createdBy: ctx.from.first_name || ctx.from.username || String(ctx.from.id),
        createdAt: new Date().toISOString(),
        status: 'pending',
      };

      queue.push(task);
      fs.writeFileSync(tasksFile, JSON.stringify(queue, null, 2), 'utf8');

      return ctx.reply(`Task created: *${taskText}*\nID: \`${task.id}\``, { parse_mode: 'Markdown' });
    } catch (err) {
      return ctx.reply(`Error creating task: ${err.message}`);
    }
  });

  // /email — Email management
  bot.command('email', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Admin only.');

    const args = (ctx.match || '').trim().split(/\s+/);
    const sub = args[0]?.toLowerCase();

    if (!sub || sub === 'help') {
      return ctx.reply(
        '*Email Commands:*\n\n' +
        '`/email check` — Check inbox for new mail\n' +
        '`/email tasks` — Pending email-extracted tasks\n' +
        '`/email drafts` — Pending response drafts\n' +
        '`/email approve <id>` — Send approved draft\n' +
        '`/email reject <id>` — Reject a draft',
        { parse_mode: 'Markdown' }
      );
    }

    if (sub === 'check') {
      await ctx.reply('Checking inbox...');
      try {
        const result = exec(
          `node -e "require('${OPAI_ROOT}/tools/email-checker/checker.js').checkNow().then(r => console.log(JSON.stringify(r)))" 2>&1`,
          30000
        );
        return ctx.reply(`*Email Check:*\n\`\`\`\n${result.substring(0, 3800)}\n\`\`\``, { parse_mode: 'Markdown' });
      } catch (err) {
        return ctx.reply(`Email check failed: ${err.message}`);
      }
    }

    if (sub === 'tasks') {
      try {
        const file = path.join(OPAI_ROOT, 'tools/email-checker/data/email-tasks.json');
        if (!fs.existsSync(file)) return ctx.reply('No email tasks found.');
        const tasks = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!tasks.length) return ctx.reply('No pending email tasks.');
        const lines = tasks.slice(0, 10).map((t, i) =>
          `${i + 1}. *${t.subject || 'No subject'}*\n   From: ${t.from || '?'} | ${t.status || 'pending'}`
        );
        return ctx.reply(`*Email Tasks (${tasks.length}):*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
      } catch (err) {
        return ctx.reply(`Error reading email tasks: ${err.message}`);
      }
    }

    if (sub === 'drafts') {
      try {
        const file = path.join(OPAI_ROOT, 'tools/email-checker/data/processed.json');
        if (!fs.existsSync(file)) return ctx.reply('No drafts found.');
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const drafts = (data.drafts || []).filter(d => d.status === 'pending');
        if (!drafts.length) return ctx.reply('No pending drafts.');
        const lines = drafts.slice(0, 10).map(d =>
          `ID: \`${d.id}\`\nTo: ${d.to}\nSubject: *${d.subject || '?'}*\nPreview: ${(d.body || '').substring(0, 100)}...`
        );
        return ctx.reply(`*Pending Drafts (${drafts.length}):*\n\n${lines.join('\n\n')}`, { parse_mode: 'Markdown' });
      } catch (err) {
        return ctx.reply(`Error reading drafts: ${err.message}`);
      }
    }

    if (sub === 'approve' && args[1]) {
      return ctx.reply(`Approving draft \`${args[1]}\`... (connecting to email-agent)`, { parse_mode: 'Markdown' });
    }

    if (sub === 'reject' && args[1]) {
      return ctx.reply(`Rejecting draft \`${args[1]}\`.`, { parse_mode: 'Markdown' });
    }

    return ctx.reply('Unknown email subcommand. Try `/email help`.');
  });

  // /hub — Team Hub integration
  bot.command('hub', async (ctx) => {
    const args = (ctx.match || '').trim();
    const parts = args.split(/\s+/);
    const sub = parts[0]?.toLowerCase();
    const content = parts.slice(1).join(' ');

    if (!sub || sub === 'help') {
      return ctx.reply(
        '*Team Hub Commands:*\n\n' +
        '`/hub status` — Workspace overview\n' +
        '`/hub task <text>` — Create a task\n' +
        '`/hub note <text>` — Add a note\n' +
        '`/hub idea <text>` — Log an idea\n' +
        '`/hub search <query>` — Search workspace',
        { parse_mode: 'Markdown' }
      );
    }

    // Route to Team Hub API
    const hubUrl = 'http://127.0.0.1:8089';

    if (sub === 'status') {
      try {
        const result = exec(`curl -s ${hubUrl}/api/workspaces 2>/dev/null`);
        const workspaces = JSON.parse(result);
        if (!Array.isArray(workspaces) || !workspaces.length) {
          return ctx.reply('No workspaces found in Team Hub.');
        }
        const lines = workspaces.slice(0, 10).map(ws =>
          `- *${ws.name || ws.id}* — ${ws.task_count || 0} tasks`
        );
        return ctx.reply(`*Team Hub Workspaces:*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
      } catch (err) {
        return ctx.reply(`Team Hub unavailable: ${err.message}`);
      }
    }

    if (sub === 'task') {
      if (!isAdmin(ctx.from.id)) return ctx.reply('Admin only.');
      return startTaskCreation(ctx, content || null);
    }

    if (['note', 'idea'].includes(sub)) {
      if (!content) return ctx.reply(`*Usage:* \`/hub ${sub} <text>\``, { parse_mode: 'Markdown' });

      try {
        const http = require('http');
        const params = new URLSearchParams({
          workspace_id: '80753c5a-beb5-498c-8d71-393a0342af27',
          user_id: '1c93c5fe-d304-40f2-9169-765d0d2b7638',
          type: sub,
          title: content,
          source: 'telegram',
        });
        const url = `${hubUrl}/api/internal/create-item?${params.toString()}`;
        exec(`curl -s -X POST "${url}" 2>/dev/null`, 10000);
        return ctx.reply(`${sub.charAt(0).toUpperCase() + sub.slice(1)} added: *${content}*`, { parse_mode: 'Markdown' });
      } catch (err) {
        return ctx.reply(`Error: ${err.message}`);
      }
    }

    if (sub === 'search' && content) {
      try {
        const result = exec(`curl -s "${hubUrl}/api/search?q=${encodeURIComponent(content)}" 2>/dev/null`);
        const items = JSON.parse(result);
        if (!Array.isArray(items) || !items.length) return ctx.reply(`No results for "${content}".`);
        const lines = items.slice(0, 8).map(item =>
          `- *${item.title || item.content?.substring(0, 60) || '?'}* (${item.type || '?'})`
        );
        return ctx.reply(`*Search: "${content}"*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
      } catch (err) {
        return ctx.reply(`Search failed: ${err.message}`);
      }
    }

    return ctx.reply('Unknown hub subcommand. Try `/hub help`.');
  });

  // /persona — Bot personality management
  bot.command('persona', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Admin only.');

    const args = (ctx.match || '').trim().split(/\s+/);
    const sub = args[0]?.toLowerCase();
    const personaFile = path.join(__dirname, '..', 'data', 'persona.json');

    // Load personas
    const defaultPersonas = {
      professional: {
        name: 'Professional',
        acknowledgment: 'Processing your request...',
        processing: ['Working on it...', 'Analyzing...', 'Almost there...'],
        style: 'Concise, direct, professional tone.',
      },
      friendly: {
        name: 'Friendly',
        acknowledgment: 'On it! Give me a moment...',
        processing: ['Thinking about this...', 'Working my magic...', 'Almost ready!'],
        style: 'Warm, conversational, helpful tone.',
      },
      technical: {
        name: 'Technical',
        acknowledgment: 'Executing request...',
        processing: ['Processing...', 'Computing...', 'Compiling results...'],
        style: 'Precise, technical, detail-oriented tone.',
      },
    };

    if (!sub || sub === 'help' || sub === 'list') {
      let active = 'professional';
      try {
        const saved = JSON.parse(fs.readFileSync(personaFile, 'utf8'));
        active = saved.active || 'professional';
      } catch {}

      const lines = Object.entries(defaultPersonas).map(([key, p]) =>
        `${key === active ? '>' : '-'} *${p.name}* (\`${key}\`)${key === active ? ' — active' : ''}`
      );
      return ctx.reply(`*Personas:*\n\n${lines.join('\n')}\n\nUse \`/persona set <name>\` to switch.`, { parse_mode: 'Markdown' });
    }

    if (sub === 'set' && args[1]) {
      const name = args[1].toLowerCase();
      if (!defaultPersonas[name]) {
        return ctx.reply(`Unknown persona. Options: ${Object.keys(defaultPersonas).join(', ')}`);
      }
      const dir = path.dirname(personaFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(personaFile, JSON.stringify({ active: name }, null, 2), 'utf8');
      return ctx.reply(`Persona set to *${defaultPersonas[name].name}*.`, { parse_mode: 'Markdown' });
    }

    return ctx.reply('Unknown persona subcommand. Try `/persona list`.');
  });

  // /role — User role management (owner/admin only)
  bot.command('role', async (ctx) => {
    if (!hasPermission(ctx.from.id, 'manageRoles') && !hasPermission(ctx.from.id, 'admin')) {
      return ctx.reply('You do not have permission to manage roles.');
    }

    const args = ctx.match?.split(/\s+/) || [];
    const sub = args[0]?.toLowerCase();

    if (sub === 'list') {
      const users = listUsers();
      if (users.length === 0) {
        return ctx.reply('No users configured. Only the owner (from env) has access.');
      }
      const lines = users.map(u =>
        `- \`${u.userId}\` — *${u.role}*${u.name ? ` (${u.name})` : ''}`
      );
      return ctx.reply(`*Users (${users.length}):*\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
    }

    if (sub === 'set' && args[1] && args[2]) {
      const targetId = args[1];
      const role = args[2].toLowerCase();
      const name = args.slice(3).join(' ') || null;

      if (!['owner', 'admin', 'member', 'viewer'].includes(role)) {
        return ctx.reply('Invalid role. Options: `owner`, `admin`, `member`, `viewer`');
      }

      setUserRole(targetId, role, { name });
      return ctx.reply(`User \`${targetId}\` set to *${role}*${name ? ` (${name})` : ''}.`, { parse_mode: 'Markdown' });
    }

    if (sub === 'remove' && args[1]) {
      removeUser(args[1]);
      return ctx.reply(`User \`${args[1]}\` removed.`);
    }

    return ctx.reply(
      '*Role Management:*\n' +
      '`/role list` — List all users\n' +
      '`/role set <userId> <role> [name]` — Set user role\n' +
      '`/role remove <userId>` — Remove user access\n\n' +
      'Roles: `owner`, `admin`, `member`, `viewer`',
      { parse_mode: 'Markdown' }
    );
  });

  // /topic — Forum topic management (admin only)
  bot.command('topic', async (ctx) => {
    if (!hasPermission(ctx.from.id, 'manageTopics')) {
      return ctx.reply('You do not have permission to manage topics.');
    }

    const args = ctx.match?.split(/\s+/) || [];
    const sub = args[0]?.toLowerCase();
    const threadId = ctx.message?.message_thread_id;

    if (!threadId) {
      return ctx.reply('This command only works inside a forum topic.');
    }

    if (sub === 'bind' && args[1]) {
      const wsId = args[1];
      const wsName = args.slice(2).join(' ') || null;
      setTopicScope(ctx.chat.id, threadId, wsId, wsName);
      return ctx.reply(
        `Topic bound to workspace \`${wsId}\`${wsName ? ` (${wsName})` : ''}.\n` +
        'Members with access to this workspace can now chat here.',
        { parse_mode: 'Markdown' }
      );
    }

    if (sub === 'info') {
      const scope = getTopicScope(ctx.chat.id, threadId);
      if (!scope) {
        return ctx.reply('This topic is not bound to any workspace. Use `/topic bind <workspaceId>`.');
      }
      return ctx.reply(
        `*Topic Binding:*\n` +
        `Workspace: \`${scope.workspaceId}\`${scope.workspaceName ? ` (${scope.workspaceName})` : ''}`,
        { parse_mode: 'Markdown' }
      );
    }

    if (sub === 'unbind') {
      setTopicScope(ctx.chat.id, threadId, null, null);
      return ctx.reply('Topic unbound from workspace.');
    }

    if (sub === 'assistant') {
      const action = args[1]?.toLowerCase();
      const scope = getTopicScope(ctx.chat.id, threadId);

      if (!scope || !scope.workspaceId) {
        return ctx.reply(
          'Assistant mode requires a workspace binding first.\n' +
          'Use `/topic bind <workspaceId> [name]` first.',
          { parse_mode: 'Markdown' }
        );
      }

      if (action === 'on') {
        setAssistantMode(ctx.chat.id, threadId, true);
        return ctx.reply(
          '*Assistant mode enabled.*\n\n' +
          'OP is now a selective coordinator for this topic:\n' +
          '- Say *OP ...* to ask me something directly\n' +
          '- Work-related messages (tasks, deadlines, etc.) get a response\n' +
          '- Greetings get a quick reply\n' +
          '- Everything else is silently absorbed\n\n' +
          'Use `/topic assistant off` to return to full-response mode.',
          { parse_mode: 'Markdown' }
        );
      }

      if (action === 'off') {
        setAssistantMode(ctx.chat.id, threadId, false);
        return ctx.reply(
          '*Assistant mode disabled.* Every message will now get a full Claude response.',
          { parse_mode: 'Markdown' }
        );
      }

      if (action === 'reset') {
        const sharedKey = `${ctx.chat.id}:${threadId}:assistant`;
        clearScope(sharedKey);
        return ctx.reply('Assistant shared buffer cleared.');
      }

      // No arg — show status
      const isOn = getAssistantMode(ctx.chat.id, threadId);
      return ctx.reply(
        `*Assistant mode:* ${isOn ? 'ON' : 'OFF'}\n` +
        `Workspace: ${scope.workspaceName || scope.workspaceId}\n\n` +
        '`/topic assistant on` — Enable selective mode\n' +
        '`/topic assistant off` — Disable (full response)\n' +
        '`/topic assistant reset` — Clear shared buffer',
        { parse_mode: 'Markdown' }
      );
    }

    return ctx.reply(
      '*Topic Management:*\n' +
      '`/topic bind <workspaceId> [name]` — Bind topic to workspace\n' +
      '`/topic info` — Show current binding\n' +
      '`/topic unbind` — Remove binding\n' +
      '`/topic assistant on|off` — Toggle assistant mode\n' +
      '`/topic assistant reset` — Clear assistant buffer',
      { parse_mode: 'Markdown' }
    );
  });

  // /config — Chat/conversation configuration
  bot.command('config', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Admin only.');

    const chatType = ctx.chat.type;
    const threadId = ctx.message?.message_thread_id || 'general';
    const scopeKey = buildScopeKey(ctx.chat.id, threadId, ctx.from.id);

    const sessionData = getScopeData(scopeKey);
    const topicScope = threadId !== 'general'
      ? getTopicScope(ctx.chat.id, threadId)
      : null;

    return ctx.reply(
      '*Chat Configuration:*\n\n' +
      `Chat type: \`${chatType}\`\n` +
      `Chat ID: \`${ctx.chat.id}\`\n` +
      `Thread: \`${threadId}\`\n` +
      `Scope key: \`${scopeKey}\`\n` +
      `Your role: \`${getUserRole(ctx.from.id)}\`\n` +
      `Session: ${sessionData ? `active (${sessionData.messageCount || 0} msgs)` : 'none'}\n` +
      `Label: ${sessionData?.topic || 'unlabeled'}\n` +
      `Topic workspace: ${topicScope ? `\`${topicScope.workspaceId}\` (${topicScope.workspaceName || '-'})` : 'None'}`,
      { parse_mode: 'Markdown' }
    );
  });

  // /sessions — List all active conversation sessions
  bot.command('sessions', async (ctx) => {
    const sessions = listActiveScopes();
    if (sessions.length === 0) {
      return ctx.reply('No active sessions. Start a conversation and it will appear here.');
    }

    const stateIcon = { ACTIVE: '🟢', IDLE: '🟡', COLD: '🔵' };
    const lines = sessions.map(s => {
      const age = formatSessionAge(Date.now() - s.lastActivity);
      const label = s.topic ? `*${s.topic}*` : '_unlabeled_';
      const icon = stateIcon[s.state] || '⚪';
      return `${icon} ${label} — ${s.messageCount || 0} msgs, ${age} ago (${s.state})`;
    });

    return ctx.reply(
      `*Active Sessions (${sessions.length}):*\n` +
      '_Sessions persist for 7 days. Use /label to name them._\n\n' +
      lines.join('\n'),
      { parse_mode: 'Markdown' }
    );
  });

  // /wp — WordPress site management
  bot.command('wp', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Admin only.');

    const args = ctx.match || '';
    try {
      const result = await handleWpCommand(args);
      if (typeof result === 'string') {
        try {
          return ctx.reply(result, { parse_mode: 'Markdown', message_thread_id: ctx.message?.message_thread_id });
        } catch {
          return ctx.reply(result, { message_thread_id: ctx.message?.message_thread_id });
        }
      }
      // Result with inline keyboard
      if (result && result.text) {
        return ctx.reply(result.text, {
          parse_mode: 'Markdown',
          reply_markup: result.keyboard,
          message_thread_id: ctx.message?.message_thread_id,
        });
      }
    } catch (err) {
      return ctx.reply(`WordPress error: ${err.message}`);
    }
  });

  // /briefing — On-demand morning briefing
  // /briefing [system|personal|team] — On-demand morning briefing
  bot.command('briefing', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Admin only.');

    const arg = (ctx.match || '').trim().toLowerCase();
    const generators = {
      system: { fn: generateBriefing, label: 'System' },
      personal: { fn: generatePersonalBriefing, label: 'Personal' },
      team: { fn: generateTeamBriefing, label: 'Team' },
    };

    // If a specific type is requested, show just that one
    const types = arg && generators[arg] ? [arg] : ['system', 'personal', 'team'];

    const ack = await ctx.reply(`*Generating ${types.length > 1 ? 'all briefings' : generators[types[0]].label + ' briefing'}...*`, {
      parse_mode: 'Markdown',
      message_thread_id: ctx.message?.message_thread_id,
    });

    try {
      for (const type of types) {
        const { fn, label } = generators[type];
        const text = await fn();
        try {
          await ctx.reply(text, {
            parse_mode: 'Markdown',
            message_thread_id: ctx.message?.message_thread_id,
          });
        } catch {
          await ctx.reply(text, {
            message_thread_id: ctx.message?.message_thread_id,
          });
        }
      }
      await ctx.api.deleteMessage(ctx.chat.id, ack.message_id).catch(() => {});
    } catch (err) {
      await ctx.api.editMessageText(ctx.chat.id, ack.message_id, `Briefing error: ${err.message}`);
    }
  });

  // /activity — Live activity snapshot (same style as periodic digest)
  bot.command('activity', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Admin only.');

    function bar(pct) {
      const filled = Math.round(Math.min(pct, 100) / 10);
      return '\u25B0'.repeat(filled) + '\u25B1'.repeat(10 - filled);
    }
    function lvl(pct) {
      if (pct < 60) return '\uD83D\uDFE2';
      if (pct < 85) return '\uD83D\uDFE1';
      return '\uD83D\uDD34';
    }
    function fmtUp(sec) {
      if (sec > 86400) return `${Math.floor(sec / 86400)}d`;
      if (sec > 3600) return `${Math.floor(sec / 3600)}h`;
      return `${Math.floor(sec / 60)}m`;
    }
    function trunc(s, n) { return s && s.length > n ? s.substring(0, n - 1) + '\u2026' : (s || '?'); }

    try {
      const data = await engineGet('/heartbeat/latest');
      const s = data.summary || {};
      const items = data.work_items || {};
      const cpu = Math.round(s.cpu || 0);
      const mem = Math.round(s.memory || 0);
      const healthy = s.healthy || 0;
      const wTotal = s.worker_total || 0;

      // Disk usage
      let diskPct = 0, diskUsed = '?', diskTotal = '?';
      try {
        const { execSync } = require('child_process');
        const df = execSync("df -h / | tail -1", { encoding: 'utf8', timeout: 3000 }).trim().split(/\s+/);
        diskUsed = df[2] || '?';
        diskTotal = df[1] || '?';
        diskPct = parseInt((df[4] || '0').replace('%', '')) || 0;
      } catch {}

      // Uptime
      let uptimeStr = '';
      try {
        const { execSync } = require('child_process');
        uptimeStr = execSync('uptime -p', { encoding: 'utf8', timeout: 3000 }).trim().replace('up ', '');
      } catch {}

      const svcIcon = healthy === wTotal ? '\uD83D\uDFE2' : '\uD83D\uDD34';
      const lines = [
        '\u2699\uFE0F *OPAI Status*',
        '',
        `${svcIcon} Services  ${healthy}/${wTotal} healthy`,
        `${lvl(cpu)} CPU   \`${String(cpu).padStart(3)}%\`  ${bar(cpu)}`,
        `${lvl(mem)} Mem   \`${String(mem).padStart(3)}%\`  ${bar(mem)}`,
        `${lvl(diskPct)} Disk  \`${String(diskPct).padStart(3)}%\`  ${bar(diskPct)}`,
        `       ${diskUsed} / ${diskTotal}`,
      ];

      if (uptimeStr) lines.push(`\u23F1 Up ${uptimeStr}`);
      lines.push(`\uD83D\uDCBB Sessions: ${s.active_sessions || 0}  |  Tasks: ${s.running_tasks || 0}`);

      // Active workers only
      const workers = Object.entries(items)
        .filter(([, v]) => v.source === 'worker' && v.status === 'healthy')
        .map(([k, v]) => `\`${k.replace('worker:', '')}\` (${fmtUp(v.uptime_sec || 0)})`);
      if (workers.length) {
        lines.push('', `\uD83E\uDD16 ${workers.join(', ')}`);
      }

      // Running tasks
      const running = Object.entries(items)
        .filter(([, v]) => v.source === 'task_registry' && v.status === 'running');
      if (running.length) {
        lines.push('');
        running.slice(0, 3).forEach(([, v]) => {
          lines.push(`  \u25B6\uFE0F ${trunc(v.title, 28)}`);
        });
      }

      // Usage
      try {
        const usage = await engineGet('/claude/plan-usage', 15000);
        const sPct = usage.session?.utilization ?? 0;
        const wPct = usage.weekAll?.utilization ?? 0;
        if (sPct || wPct) {
          lines.push('');
          lines.push(`${lvl(sPct)} Session \`${String(Math.round(sPct)).padStart(3)}%\`  ${bar(sPct)}`);
          lines.push(`${lvl(wPct)} Week    \`${String(Math.round(wPct)).padStart(3)}%\`  ${bar(wPct)}`);
        }
      } catch {}

      await ctx.reply(lines.join('\n'), {
        parse_mode: 'Markdown',
        message_thread_id: ctx.message?.message_thread_id,
      });
    } catch (err) {
      await ctx.reply(`Activity check failed: ${err.message}`, {
        message_thread_id: ctx.message?.message_thread_id,
      });
    }
  });

  // /file — File manager (reports, logs, notes, wiki)
  bot.command('file', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Admin only.');

    const args = ctx.match || '';
    try {
      const result = await handleFileCommand(args);
      const threadOpts = ctx.message?.message_thread_id
        ? { message_thread_id: ctx.message.message_thread_id }
        : {};

      // Send text response
      if (result.text) {
        try {
          await ctx.reply(result.text, { parse_mode: 'Markdown', ...threadOpts });
        } catch {
          await ctx.reply(result.text, threadOpts);
        }
      }

      // Send file if present
      if (result.file) {
        const file = new InputFile(result.file.path, result.file.name);
        await ctx.replyWithDocument(file, {
          caption: result.file.name,
          ...threadOpts,
        });

        // Clean up temp files
        if (result.file.cleanup) {
          try { fs.unlinkSync(result.file.path); } catch {}
        }
      }
    } catch (err) {
      return ctx.reply(`File error: ${err.message}`);
    }
  });

  // /apps — Launch Mini Apps
  // web_app buttons only work in private chats; groups get a deep link to DM
  bot.command('apps', async (ctx) => {
    const baseUrl = process.env.WEBHOOK_URL
      ? process.env.WEBHOOK_URL.replace('/telegram/webhook', '')
      : 'https://opai.boutabyte.com';
    const isPrivate = ctx.chat?.type === 'private';

    if (!isAdmin(ctx.from.id)) {
      return ctx.reply('No Mini Apps available for your role.');
    }

    if (isPrivate) {
      // Private chat: send web_app keyboard buttons directly
      return ctx.reply('Tap a button below to launch a Mini App:', {
        reply_markup: {
          keyboard: [[{
            text: 'WordPress Manager',
            web_app: { url: baseUrl + '/telegram/mini-apps/wordpress.html' },
          }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      });
    }

    // Group/supergroup: web_app buttons not allowed, provide DM link
    const botInfo = await ctx.api.getMe();
    return ctx.reply(
      '*OPAI Mini Apps*\n\n' +
      'Mini Apps can only be launched from a direct message with the bot.\n\n' +
      'Tap the button below to open a DM, then use `/apps` there.',
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{
            text: 'Open DM with OPAI Bot',
            url: `https://t.me/${botInfo.username}?start=apps`,
          }]],
        },
        message_thread_id: ctx.message?.message_thread_id,
      }
    );
  });

  // /danger — Autonomous execution (owner only)
  bot.command('danger', async (ctx) => {
    if (getUserRole(ctx.from.id) !== 'owner') {
      return ctx.reply('Owner only. Dangerous runs require owner-level access.');
    }

    const threadId = ctx.message?.message_thread_id || 'general';
    const scopeKey = buildScopeKey(ctx.chat.id, threadId, ctx.from.id);
    const args = (ctx.match || '').trim();
    const username = ctx.from.first_name || ctx.from.username || String(ctx.from.id);

    let instruction;
    let conversationContext = '';

    if (args) {
      // Explicit instruction provided
      instruction = args;
    } else {
      // Pull from conversation context — last Claude response + recent messages
      const scopeData = getScopeData(scopeKey);
      if (!scopeData || !scopeData.recentMessages || scopeData.recentMessages.length === 0) {
        return ctx.reply(
          '*Usage:* `/danger <instruction>`\n' +
          'Or chat about a plan first, then `/danger` to execute it.',
          { parse_mode: 'Markdown' }
        );
      }

      // Find the last assistant message as the "plan"
      const msgs = scopeData.recentMessages;
      const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant');
      const lastUser = [...msgs].reverse().find(m => m.role === 'user');

      if (!lastAssistant) {
        return ctx.reply('No previous Claude response found. Send a message first or use `/danger <instruction>`.');
      }

      instruction = lastAssistant.content;

      // Build context from recent user messages
      const recentUserMsgs = msgs.filter(m => m.role === 'user').slice(-3);
      if (recentUserMsgs.length > 0) {
        conversationContext = recentUserMsgs.map(m => `${m.username}: ${m.content}`).join('\n');
      }
    }

    // Show confirmation gate
    const actionId = `dr-${Date.now()}`;
    const truncated = instruction.length > 300 ? instruction.substring(0, 300) + '...' : instruction;

    pendingDangerRuns.set(actionId, {
      instruction,
      conversationContext,
      scopeKey,
      requestedBy: ctx.from.id,
      chatId: ctx.chat.id,
      threadId: String(threadId),
      username,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    const kb = new InlineKeyboard()
      .text('Backup First', `danger:backup:${actionId}`)
      .row()
      .text('Confirm', `danger:confirm:${actionId}`)
      .text('Cancel', `danger:cancel:${actionId}`);

    return ctx.reply(
      '*DANGEROUS RUN*\n\n' +
      '*Execute autonomously?*\n\n' +
      '```\n' + truncated + '\n```\n\n' +
      '*Access:* Full (Bash, files, MCP)\n' +
      '*Timeout:* 10 minutes\n\n' +
      'This will run with --dangerously-skip-permissions.',
      {
        parse_mode: 'Markdown',
        reply_markup: kb,
        message_thread_id: ctx.message?.message_thread_id,
      }
    );
  });

  // /approve — Worker approvals and HITL management
  bot.command('approve', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Admin only.');

    const args = (ctx.match || '').trim().toLowerCase();

    // /approve hitl — list HITL files
    if (args === 'hitl') {
      try {
        const data = await engineGet('/hitl');
        const items = Array.isArray(data) ? data : (data.files || data.items || []);
        if (!items.length) return ctx.reply('No HITL briefings awaiting response.');

        const lines = ['*HITL Awaiting Response:*\n'];
        for (const item of items.slice(0, 10)) {
          const name = typeof item === 'string' ? item : (item.filename || item.name || '?');
          lines.push(`- \`${name}\``);
        }

        // Send list header
        await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });

        // Send action buttons for each item (4 buttons: Run, Approve, Dismiss, Reject)
        for (const item of items.slice(0, 5)) {
          const name = typeof item === 'string' ? item : (item.filename || item.name || '?');
          const kb = new InlineKeyboard()
            .text('Run', `hitl:run:${name}`)
            .text('Approve', `hitl:approve:${name}`)
            .text('Dismiss', `hitl:dismiss:${name}`)
            .text('Reject', `hitl:reject:${name}`);
          await ctx.reply(`\`${name}\``, { parse_mode: 'Markdown', reply_markup: kb });
        }
      } catch (err) {
        return ctx.reply(`HITL check failed: ${err.message}`);
      }
      return;
    }

    // /approve <id> — detail view with approve/deny
    if (args && args !== 'hitl') {
      try {
        const data = await engineGet(`/workers/approvals/${args}`);
        const a = data;
        const detail =
          `*Approval: ${a.id || args}*\n\n` +
          `Worker: \`${a.worker || a.agent || '?'}\`\n` +
          `Action: ${a.action || a.type || '?'}\n` +
          `Params: \`${JSON.stringify(a.params || a.payload || {}).substring(0, 300)}\`\n` +
          `Time: ${a.created_at || a.timestamp || '?'}`;

        const kb = new InlineKeyboard()
          .text('Approve', `appr:yes:${args}`)
          .text('Deny', `appr:no:${args}`);

        return ctx.reply(detail, { parse_mode: 'Markdown', reply_markup: kb });
      } catch (err) {
        return ctx.reply(`Approval lookup failed: ${err.message}`);
      }
    }

    // /approve — list pending approvals
    try {
      const data = await engineGet('/workers/approvals');
      const items = Array.isArray(data) ? data : (data.approvals || data.items || []);
      if (!items.length) return ctx.reply('No pending approvals.');

      const lines = ['*Pending Approvals:*\n'];
      items.slice(0, 10).forEach((a, i) => {
        lines.push(
          `${i + 1}. *${a.worker || a.agent || '?'}* — ${a.action || a.type || '?'}` +
          `\n   ID: \`${a.id || '?'}\` | ${a.created_at || a.timestamp || ''}`
        );
      });
      lines.push('\nUse `/approve <id>` to view details.');

      return ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    } catch (err) {
      return ctx.reply(`Approvals check failed: ${err.message}`);
    }
  });

  // /usage — Claude plan utilization
  bot.command('usage', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Admin only.');

    try {
      const data = await engineGet('/claude/plan-usage', 15000);

      function bar(pct) {
        const filled = Math.round(Math.min(pct, 100) / 10);
        return '\u25B0'.repeat(filled) + '\u25B1'.repeat(10 - filled);
      }

      function lvl(pct) {
        if (pct < 60) return '\uD83D\uDFE2';
        if (pct < 85) return '\uD83D\uDFE1';
        return '\uD83D\uDD34';
      }

      const lines = ['*Claude Usage*\n'];

      // Extract utilization % from nested objects
      const session = data.session?.utilization ?? 0;
      const week = data.weekAll?.utilization ?? 0;
      const opus = data.weekOpus?.utilization ?? null;
      const sonnet = data.weekSonnet?.utilization ?? null;

      lines.push(`${lvl(session)} Session    ${session}%  ${bar(session)}`);
      lines.push(`${lvl(week)} Week       ${week}%  ${bar(week)}`);
      if (opus != null) lines.push(`   Opus       ${opus}%  ${bar(opus)}`);
      if (sonnet != null) lines.push(`   Sonnet     ${sonnet}%  ${bar(sonnet)}`);

      // Extra usage (overages)
      const extra = data.extraUsage;
      if (extra?.isEnabled && extra.usedCredits != null) {
        const limit = extra.monthlyLimit ? `/$${extra.monthlyLimit}` : '';
        lines.push(`\n💳 Extra: $${extra.usedCredits.toFixed(2)}${limit}`);
      }

      // Reset times
      const resetAt = data.session?.resetsAt || data.weekAll?.resetsAt;
      if (resetAt) {
        const resetDate = new Date(resetAt);
        const now = new Date();
        const diffMs = resetDate - now;
        if (diffMs > 0) {
          const hours = Math.floor(diffMs / 3600000);
          const mins = Math.floor((diffMs % 3600000) / 60000);
          lines.push(`\n⏳ Session resets in ${hours}h ${mins}m`);
        }
      }

      return ctx.reply(lines.join('\n'), {
        parse_mode: 'Markdown',
        message_thread_id: ctx.message?.message_thread_id,
      });
    } catch (err) {
      return ctx.reply(`Usage check failed: ${err.message}`, {
        message_thread_id: ctx.message?.message_thread_id,
      });
    }
  });

  // /brain — 2nd Brain search, save, inbox, suggestions
  bot.command('brain', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Admin only.');

    const args = (ctx.match || '').trim();
    const parts = args.split(/\s+/);
    const sub = parts[0]?.toLowerCase();
    const content = parts.slice(1).join(' ');

    if (!sub) {
      return ctx.reply(
        '*2nd Brain Commands:*\n\n' +
        '`/brain search <query>` — Search nodes\n' +
        '`/brain save <text>` — Quick-capture to inbox\n' +
        '`/brain inbox` — Pending inbox items\n' +
        '`/brain suggest` — Pending suggestions',
        { parse_mode: 'Markdown' }
      );
    }

    if (sub === 'search') {
      if (!content) return ctx.reply('*Usage:* `/brain search <query>`', { parse_mode: 'Markdown' });
      try {
        const data = await brainGet(`/search?q=${encodeURIComponent(content)}&limit=5`);
        const items = Array.isArray(data) ? data : (data.results || data.nodes || []);
        if (!items.length) return ctx.reply(`No results for "${content}".`);

        const lines = [`*Brain Search: "${content}"*\n`];
        items.slice(0, 5).forEach((item, i) => {
          const title = item.title || item.name || 'Untitled';
          const type = item.type || item.node_type || '';
          const preview = (item.content || item.body || '').substring(0, 100);
          lines.push(`${i + 1}. *${title}*${type ? ` (${type})` : ''}`);
          if (preview) lines.push(`   ${preview}...`);
        });
        return ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
      } catch (err) {
        return ctx.reply(`Brain search failed: ${err.message}`);
      }
    }

    if (sub === 'save') {
      if (!content) return ctx.reply('*Usage:* `/brain save <text>`', { parse_mode: 'Markdown' });
      try {
        const data = await brainPost('/inbox', { content });
        const title = data.title || content.substring(0, 40);
        return ctx.reply(`Saved to Brain inbox: *${title}*`, { parse_mode: 'Markdown' });
      } catch (err) {
        return ctx.reply(`Brain save failed: ${err.message}`);
      }
    }

    if (sub === 'inbox') {
      try {
        const data = await brainGet('/inbox');
        const items = Array.isArray(data) ? data : (data.items || data.inbox || []);
        if (!items.length) return ctx.reply('Brain inbox is empty.');

        const lines = ['*Brain Inbox:*\n'];
        items.slice(0, 10).forEach((item, i) => {
          const title = item.title || item.content?.substring(0, 50) || 'Untitled';
          const date = item.created_at ? ` — ${item.created_at.split('T')[0]}` : '';
          lines.push(`${i + 1}. *${title}*${date}`);
        });
        return ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
      } catch (err) {
        return ctx.reply(`Brain inbox failed: ${err.message}`);
      }
    }

    if (sub === 'suggest' || sub === 'suggestions') {
      try {
        const data = await brainGet('/suggestions/pending');
        const items = Array.isArray(data) ? data : (data.suggestions || []);
        if (!items.length) return ctx.reply('No pending suggestions.');

        const lines = ['*Brain Suggestions:*\n'];
        items.slice(0, 10).forEach((item, i) => {
          const target = item.target_title || item.title || '?';
          const score = item.score ? ` (${Math.round(item.score * 100)}%)` : '';
          const reason = item.reason || item.description || '';
          lines.push(`${i + 1}. *${target}*${score}`);
          if (reason) lines.push(`   ${reason}`);
        });
        return ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
      } catch (err) {
        return ctx.reply(`Brain suggestions failed: ${err.message}`);
      }
    }

    return ctx.reply('Unknown brain subcommand. Try `/brain` for help.', { parse_mode: 'Markdown' });
  });

  // /rag — Query organized RAG notebooks (NotebookLM)
  bot.command('rag', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Admin only.');

    const args = (ctx.match || '').trim();
    if (!args) {
      return ctx.reply(
        '*RAG Knowledge Base (NotebookLM):*\n\n' +
        '`/rag <question>` — Auto-route to best notebook\n' +
        '`/rag tech <question>` — Technical reference\n' +
        '`/rag business <question>` — Business & HELM\n' +
        '`/rag client <question>` — Client portfolio\n' +
        '`/rag agent <question>` — Agent ops & prompts\n\n' +
        '_Free queries via Google NotebookLM — saves Claude tokens._',
        { parse_mode: 'Markdown' }
      );
    }

    // Check if first word is a topic hint
    const parts = args.split(/\s+/);
    const topicHints = ['tech', 'technical', 'business', 'helm', 'client', 'agent', 'drive', 'api', 'pricing', 'squad'];
    let topicHint = '';
    let question = args;
    if (topicHints.includes(parts[0]?.toLowerCase()) && parts.length > 1) {
      topicHint = parts[0];
      question = parts.slice(1).join(' ');
    }

    try {
      await ctx.reply('Querying RAG knowledge base...');
      const data = await enginePost('/notebooklm/rag/ask', {
        question,
        topic_hint: topicHint || null,
      }, 30000);

      const answer = data.answer || data.raw || 'No answer returned.';
      // Truncate for Telegram (4096 char limit)
      const truncated = answer.length > 3800
        ? answer.substring(0, 3800) + '\n\n_(truncated)_'
        : answer;

      return ctx.reply(truncated, { parse_mode: 'Markdown' });
    } catch (err) {
      const msg = err.message || String(err);
      if (msg.includes('404')) {
        return ctx.reply('No matching RAG notebook for this topic. Try adding a topic hint: tech, business, client, or agent.');
      }
      return ctx.reply(`RAG query failed: ${msg}`);
    }
  });

  // /tasks — Task registry management
  bot.command('tasks', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Admin only.');

    const args = (ctx.match || '').trim();
    const parts = args.split(/\s+/);
    const sub = parts[0]?.toLowerCase();

    // /tasks complete <id> or /tasks cancel <id>
    if ((sub === 'complete' || sub === 'cancel') && parts[1]) {
      const taskId = parts[1];
      try {
        const endpoint = sub === 'complete' ? `/tasks/${taskId}/complete` : `/tasks/${taskId}/cancel`;
        const data = await enginePost(endpoint);
        const title = data.title || data.name || taskId;
        const action = sub === 'complete' ? 'completed' : 'cancelled';
        return ctx.reply(`Task *${title}* ${action}.`, { parse_mode: 'Markdown' });
      } catch (err) {
        return ctx.reply(`Failed to ${sub} task: ${err.message}`);
      }
    }

    // /tasks list — pending tasks
    if (sub === 'list') {
      try {
        const data = await engineGet('/tasks?status=pending&limit=10');
        const items = Array.isArray(data) ? data : (data.tasks || data.items || []);
        if (!items.length) return ctx.reply('No pending tasks.');

        const lines = ['*Pending Tasks:*\n'];
        items.slice(0, 10).forEach((t, i) => {
          const id = (t.id || '?').toString().substring(0, 8);
          const title = t.title || t.name || 'Untitled';
          const priority = t.priority ? ` | ${t.priority}` : '';
          const source = t.source ? ` | ${t.source}` : '';
          const date = t.created_at ? t.created_at.split('T')[0] : '';
          lines.push(`${i + 1}. \`${id}\` *${title}*${priority}${source}`);
          if (date) lines.push(`   ${date}`);
        });
        lines.push('\n`/tasks complete <id>` | `/tasks cancel <id>`');
        return ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
      } catch (err) {
        return ctx.reply(`Task list failed: ${err.message}`);
      }
    }

    // /tasks or /tasks summary — counts by status
    try {
      const data = await engineGet('/tasks/summary');
      const counts = data.by_status || data.summary || data.counts || data;

      const lines = ['*Task Registry Summary:*\n'];
      const statuses = ['pending', 'scheduled', 'running', 'completed', 'failed', 'cancelled'];
      for (const status of statuses) {
        const count = counts[status] || 0;
        if (count > 0 || ['pending', 'running', 'completed'].includes(status)) {
          const icon = {
            pending: '\u23F3', scheduled: '\uD83D\uDCC5', running: '\u25B6\uFE0F',
            completed: '\u2705', failed: '\u274C', cancelled: '\u26D4',
          }[status] || '\u2022';
          lines.push(`${icon} ${status}: *${count}*`);
        }
      }
      const total = data.total || Object.values(counts).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
      if (total) lines.push(`\nTotal: ${total}`);
      if (data.overdue) lines.push(`\u26A0\uFE0F Overdue: *${data.overdue}*`);
      lines.push('\n`/tasks list` — View pending');
      return ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    } catch (err) {
      return ctx.reply(`Task summary failed: ${err.message}`);
    }
  });

  // /review [service] — AI-powered log analysis
  bot.command('review', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Admin only.');

    const svcArg = (ctx.match || '').trim().toLowerCase() || 'telegram';

    // Reuse the same service map as /logs
    const svcMap = {
      'engine': 'opai-engine', 'portal': 'opai-portal', 'telegram': 'opai-telegram',
      'discord': 'opai-discord-bot', 'team-hub': 'opai-team-hub', 'teamhub': 'opai-team-hub',
      'email': 'opai-email-agent', 'files': 'opai-files', 'users': 'opai-users',
      'wordpress': 'opai-wordpress', 'wp': 'opai-wordpress', 'caddy': 'opai-caddy',
      'vault': 'opai-vault', 'brain': 'opai-brain',
      'oc': 'opai-oc-broker', 'oc-broker': 'opai-oc-broker', 'openclaw': 'opai-oc-broker',
      'browser': 'opai-browser',
    };
    const fullName = svcMap[svcArg] || `opai-${svcArg}`;

    const ack = await ctx.reply(`Analyzing *${fullName}* logs...`, {
      parse_mode: 'Markdown',
      message_thread_id: ctx.message?.message_thread_id,
    });

    // Fire and forget
    (async () => {
      try {
        const logContent = exec(
          `journalctl --user -u ${fullName} --no-pager -n 100 --output=short-iso 2>&1`,
          15000
        );

        if (!logContent || logContent.length < 20) {
          await ctx.api.editMessageText(ctx.chat.id, ack.message_id,
            `No meaningful logs found for *${fullName}*.`, { parse_mode: 'Markdown' });
          return;
        }

        const threadId = ctx.message?.message_thread_id || 'general';
        const scopeKey = buildScopeKey(ctx.chat.id, threadId, ctx.from.id);
        const jobId = createJob({
          chatId: ctx.chat.id,
          threadId: String(threadId),
          messageId: ack.message_id,
          userId: String(ctx.from.id),
          query: `[REVIEW] ${fullName}`,
        });

        const prompt = [
          `Review the logs for OPAI service "${fullName}". Report concisely (mobile display):`,
          '1. Errors or warnings with timestamps',
          '2. Patterns of concern',
          '3. Fix recommendations',
          '4. Health assessment (healthy/degraded/unhealthy)',
          '',
          'LOGS:',
          logContent.substring(0, 6000),
        ].join('\n');

        const result = await askClaude({ prompt, scopeKey: `review-${fullName}` });
        completeJob(jobId);

        const text = (result.text || 'No analysis available.').substring(0, 3800);
        try {
          await ctx.api.editMessageText(ctx.chat.id, ack.message_id,
            `*Log Review: ${fullName}*\n\n${text}`, { parse_mode: 'Markdown' });
        } catch {
          await ctx.api.editMessageText(ctx.chat.id, ack.message_id,
            `Log Review: ${fullName}\n\n${text}`);
        }
      } catch (err) {
        try {
          await ctx.api.editMessageText(ctx.chat.id, ack.message_id,
            `Review failed: ${err.message}`);
        } catch {}
      }
    })().catch(err => console.error('[TG] [REVIEW] Background error:', err.message));
  });

  // /label — Name the current conversation
  bot.command('label', async (ctx) => {
    const label = (ctx.match || '').trim();
    if (!label) {
      return ctx.reply('*Usage:* `/label <name>`\nExample: `/label HELM development`', { parse_mode: 'Markdown' });
    }

    const threadId = ctx.message?.message_thread_id || 'general';
    const scopeKey = buildScopeKey(ctx.chat.id, threadId, ctx.from.id);

    setScopeTopic(scopeKey, label);
    return ctx.reply(`Conversation labeled: *${label}*`, { parse_mode: 'Markdown' });
  });

  // /notify — Register a personal notification watch on a task
  bot.command('notify', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Admin only.');

    const args = (ctx.match || '').trim();
    if (!args) {
      return ctx.reply(
        '*Personal Notifications*\n\n' +
        '`/notify <task-id> [message]` — Watch a task\n' +
        '`/notify list` — Show active watches\n' +
        '`/notify clear` — Clear fired watches\n\n' +
        'You\'ll get a formatted notification when the task completes.',
        { parse_mode: 'Markdown' }
      );
    }

    // Subcommands
    if (args === 'list') {
      try {
        const resp = await engineGet('/notifications/watches?status=watching');
        const watches = resp?.watches || [];
        if (!watches.length) return ctx.reply('No active watches.');
        const lines = watches.map(w =>
          `• \`${w.task_id || w.teamhub_item_id || '?'}\` — ${w.title || 'Untitled'}`
        );
        return ctx.reply(`*Active Watches (${watches.length})*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
      } catch (e) {
        return ctx.reply(`Failed to fetch watches: ${e.message}`);
      }
    }

    if (args === 'clear') {
      try {
        const resp = await engineDelete('/notifications/watches/fired');
        return ctx.reply(`Cleared ${resp?.removed_count || 0} fired watches.`);
      } catch (e) {
        return ctx.reply(`Failed: ${e.message}`);
      }
    }

    // Register a watch: /notify TASK-123 optional message
    const parts = args.split(/\s+/);
    const taskId = parts[0];
    const message = parts.slice(1).join(' ') || '';

    try {
      const resp = await enginePost('/notifications/watch', {
        task_id: taskId,
        title: '',
        message: message || null,
        source: 'telegram',
      });
      const w = resp?.watch;
      return ctx.reply(
        `👁 *Watch registered*\n\nTask: \`${taskId}\`${message ? `\nMessage: ${message}` : ''}\n\nYou'll be notified when it completes.`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      return ctx.reply(`Failed to register watch: ${e.message}`);
    }
  });

  // ── /newsletter — Send, preview, create newsletters ─────
  bot.command('newsletter', async (ctx) => {
    const role = getUserRole(ctx);
    if (!hasPermission(role, 'admin')) return ctx.reply('Admin only.');

    const args = (ctx.message.text.split(/\s+/).slice(1).join(' ') || '').trim();
    const sub = args.split(/\s+/)[0]?.toLowerCase();

    if (!sub || sub === 'help') {
      return ctx.reply(
        `📨 *Newsletter*\n\n` +
        `/newsletter send — Send pending announcements now\n` +
        `/newsletter preview — Show what would be sent\n` +
        `/newsletter list — Show all announcements\n` +
        `/newsletter status — Pending count`,
        { parse_mode: 'Markdown' }
      );
    }

    if (sub === 'send') {
      try {
        await ctx.reply('📨 Sending newsletter...');
        const resp = await enginePost('/newsletter/send', {}, 30000);
        if (resp?.status === 'sent') {
          const headlines = (resp.headlines || []).join(', ');
          return ctx.reply(
            `✅ *Newsletter sent*\n\n` +
            `Announcements: ${resp.announcement_count}\n` +
            `Headlines: ${headlines}`,
            { parse_mode: 'Markdown' }
          );
        }
        return ctx.reply(`⚠️ ${resp?.detail || 'Unknown error'}`);
      } catch (e) {
        return ctx.reply(`❌ Send failed: ${e.message}`);
      }
    }

    if (sub === 'preview') {
      try {
        const resp = await engineGet('/newsletter/preview');
        if (resp?.status === 'empty') {
          return ctx.reply('No pending announcements.');
        }
        const headlines = (resp.headlines || []).map((h, i) => `${i + 1}. ${h}`).join('\n');
        const recipients = (resp.recipients || []).join(', ');
        return ctx.reply(
          `📋 *Newsletter Preview*\n\n` +
          `*Headlines:*\n${headlines}\n\n` +
          `*Recipients:* ${recipients}\n` +
          `*Announcements:* ${resp.announcement_count}`,
          { parse_mode: 'Markdown' }
        );
      } catch (e) {
        return ctx.reply(`❌ Preview failed: ${e.message}`);
      }
    }

    if (sub === 'list' || sub === 'status') {
      try {
        const resp = await engineGet('/newsletter/list');
        if (!resp?.announcements?.length) {
          return ctx.reply('No announcements found.');
        }
        const lines = resp.announcements.map(a => {
          const status = a.announced ? '✅' : '⏳';
          const date = a.date || '?';
          return `${status} ${date} — ${a.headline || 'Untitled'}`;
        });
        return ctx.reply(
          `📨 *Announcements* (${resp.pending} pending)\n\n${lines.join('\n')}`,
          { parse_mode: 'Markdown' }
        );
      } catch (e) {
        return ctx.reply(`❌ ${e.message}`);
      }
    }

    return ctx.reply('Unknown subcommand. Try: /newsletter help');
  });

  // Assembly Line pipeline
  registerAssemblyCommand(bot);

  // Vercel Demo Platform
  registerDemoCommand(bot);
}

// ── /assembly — Assembly Line pipeline ──────────────────
function registerAssemblyCommand(bot) {
  bot.command('assembly', async (ctx) => {
    if (!hasPermission(ctx, 'admin')) {
      return ctx.reply('Admin access required.');
    }

    const text = (ctx.message.text || '').replace(/^\/assembly\s*/, '').trim();

    // /assembly status
    if (text === 'status' || text === '') {
      try {
        const resp = await engineGet('/assembly/stats');
        if (resp?.error) return ctx.reply(`⚠️ ${resp.error}`);
        const lines = [
          '🏭 *Assembly Line*',
          '',
          `Running: ${resp.running || 0}`,
          `Paused: ${resp.paused || 0}`,
          `Completed: ${resp.completed || 0}`,
          `Failed: ${resp.failed || 0}`,
          `Total: ${resp.total_runs || 0}`,
        ];
        return ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
      } catch (e) {
        return ctx.reply(`❌ ${e.message}`);
      }
    }

    // /assembly list
    if (text === 'list') {
      try {
        const resp = await engineGet('/assembly/runs?limit=20');
        const runs = resp?.runs || [];
        if (!runs.length) return ctx.reply('No assembly runs found.');
        const lines = ['🏭 *Assembly Runs*', ''];
        for (const r of runs.slice(0, 20)) {
          const phase = r.current_phase ?? '?';
          const status = r.phase_status || r.status;
          lines.push(`\`${r.id}\` — Phase ${phase} (${status})`);
        }
        return ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
      } catch (e) {
        return ctx.reply(`❌ ${e.message}`);
      }
    }

    // /assembly resume <id>
    if (text.startsWith('resume ')) {
      const runId = text.replace('resume ', '').trim();
      try {
        const resp = await enginePost(`/assembly/resume/${runId}`);
        if (resp?.success) return ctx.reply(`▶️ Resumed assembly run \`${runId}\``, { parse_mode: 'Markdown' });
        return ctx.reply(`⚠️ ${resp?.error || 'Resume failed'}`);
      } catch (e) {
        return ctx.reply(`❌ ${e.message}`);
      }
    }

    // /assembly abort <id>
    if (text.startsWith('abort ')) {
      const runId = text.replace('abort ', '').trim();
      try {
        const resp = await enginePost(`/assembly/abort/${runId}`);
        if (resp?.success) return ctx.reply(`🛑 Aborted assembly run \`${runId}\``, { parse_mode: 'Markdown' });
        return ctx.reply(`⚠️ ${resp?.error || 'Abort failed'}`);
      } catch (e) {
        return ctx.reply(`❌ ${e.message}`);
      }
    }

    // /assembly prd (reply to a message containing a PRD)
    if (text === 'prd') {
      const replied = ctx.message.reply_to_message;
      if (!replied?.text) return ctx.reply('Reply to a message containing a PRD.');
      try {
        const resp = await enginePost('/assembly/start', {
          input_type: 'prd',
          input_text: replied.text,
        });
        if (resp?.success) {
          return ctx.reply(
            `🏭 Assembly run \`${resp.run_id}\` started from PRD\nPhase 0 (Intake) in progress...`,
            { parse_mode: 'Markdown' }
          );
        }
        return ctx.reply(`⚠️ ${resp?.error || 'Start failed'}`);
      } catch (e) {
        return ctx.reply(`❌ ${e.message}`);
      }
    }

    // /assembly <idea text> — start from idea
    if (text.length > 3) {
      try {
        const resp = await enginePost('/assembly/start', {
          input_type: 'idea',
          input_text: text,
        });
        if (resp?.success) {
          return ctx.reply(
            `🏭 Assembly run \`${resp.run_id}\` started\nIdea: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"\nPhase 0 (Intake) in progress...`,
            { parse_mode: 'Markdown' }
          );
        }
        return ctx.reply(`⚠️ ${resp?.error || 'Start failed'}`);
      } catch (e) {
        return ctx.reply(`❌ ${e.message}`);
      }
    }

    return ctx.reply(
      '🏭 *Assembly Line*\n\n' +
      '`/assembly <idea>` — Start from idea\n' +
      '`/assembly prd` — Start from PRD (reply)\n' +
      '`/assembly status` — Pipeline stats\n' +
      '`/assembly list` — Recent runs\n' +
      '`/assembly resume <id>` — Resume paused\n' +
      '`/assembly abort <id>` — Abort run',
      { parse_mode: 'Markdown' }
    );
  });
}

// ── /demo — Vercel Demo Platform ────────────────────────
function registerDemoCommand(bot) {
  bot.command('demo', async (ctx) => {
    if (!hasPermission(ctx, 'admin')) {
      return ctx.reply('Admin access required.');
    }

    const text = (ctx.message.text || '').replace(/^\/demo\s*/, '').trim();

    // /demo list (default)
    if (text === 'list' || text === '') {
      try {
        const resp = await engineGet('/demos');
        const demos = resp?.demos || [];
        if (!demos.length) return ctx.reply('No active demos.');
        const lines = ['🚀 *Active Demos*', ''];
        for (const d of demos) {
          const stale = d.age_hours > d.max_age_hours ? ' ⚠️ STALE' : '';
          lines.push(`*${d.slug}*${stale}`);
          lines.push(`  ${d.url}`);
          lines.push(`  Age: ${d.age_hours}h / ${d.max_age_hours}h`);
          if (d.notes) lines.push(`  Note: ${d.notes}`);
          lines.push('');
        }
        lines.push(`${demos.length}/3 slots used`);
        return ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
      } catch (e) {
        return ctx.reply(`❌ ${e.message}`);
      }
    }

    // /demo deploy <path> <slug> [notes]
    if (text.startsWith('deploy ')) {
      const parts = text.replace('deploy ', '').trim().split(/\s+/);
      if (parts.length < 2) {
        return ctx.reply('Usage: `/demo deploy <path> <slug> [notes]`', { parse_mode: 'Markdown' });
      }
      const dir = parts[0];
      const slug = parts[1];
      const notes = parts.slice(2).join(' ');
      await ctx.reply(`⏳ Deploying \`${slug}\` from ${dir}...`, { parse_mode: 'Markdown' });
      try {
        const resp = await enginePost('/demos/deploy', { directory: dir, slug, notes }, 120000);
        if (resp?.success) {
          return ctx.reply(
            `✅ *Demo deployed*\n\n` +
            `*Slug:* \`${resp.slug}\`\n` +
            `*URL:* ${resp.url}\n` +
            `*Project:* ${resp.project}`,
            { parse_mode: 'Markdown' }
          );
        }
        return ctx.reply(`⚠️ ${resp?.error || 'Deploy failed'}`);
      } catch (e) {
        return ctx.reply(`❌ ${e.message}`);
      }
    }

    // /demo teardown <slug>
    if (text.startsWith('teardown-all')) {
      try {
        const resp = await enginePost('/demos/teardown-all');
        if (resp?.success) return ctx.reply('🗑️ All demos removed.');
        return ctx.reply(`⚠️ ${resp?.error || 'Teardown failed'}`);
      } catch (e) {
        return ctx.reply(`❌ ${e.message}`);
      }
    }

    if (text.startsWith('teardown ')) {
      const slug = text.replace('teardown ', '').trim();
      try {
        const resp = await enginePost(`/demos/${slug}/teardown`);
        if (resp?.success) return ctx.reply(`🗑️ Demo \`${slug}\` removed.`, { parse_mode: 'Markdown' });
        return ctx.reply(`⚠️ ${resp?.error || 'Teardown failed'}`);
      } catch (e) {
        return ctx.reply(`❌ ${e.message}`);
      }
    }

    // /demo sweep
    if (text === 'sweep') {
      try {
        const resp = await enginePost('/demos/sweep');
        return ctx.reply(resp?.output || 'Sweep complete.');
      } catch (e) {
        return ctx.reply(`❌ ${e.message}`);
      }
    }

    // Help
    return ctx.reply(
      '🚀 *Vercel Demo Platform*\n\n' +
      '`/demo list` — Active demos\n' +
      '`/demo deploy <path> <slug>` — Deploy\n' +
      '`/demo teardown <slug>` — Remove one\n' +
      '`/demo teardown-all` — Remove all\n' +
      '`/demo sweep` — Clean stale (>48h)',
      { parse_mode: 'Markdown' }
    );
  });
}

function formatSessionAge(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

module.exports = { registerCommands };
