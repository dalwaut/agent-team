#!/usr/bin/env node
/**
 * OPAI Discord Bridge v4
 *
 * Local Discord bot -> Claude Code CLI (Pro Max, zero API cost).
 *
 * v4 adds:
 *   - Per-guild data isolation (conversations, sessions, jobs, persona, logs)
 *   - All data stored in data/guilds/{guildId}/ — zero cross-contamination
 *   - Single bot process, one gateway connection, namespaced by guildId
 *   - DMs and fallback use 'opai-home' as guildId
 *
 * v3.1 added:
 *   - Async response queue (non-blocking message handling)
 *   - Job tracking with status command
 *   - 15-min timeout ceiling
 *   - Restart recovery for interrupted jobs
 *   - Persona system with swappable personalities
 *   - Rotating processing messages while Claude works
 *
 * Usage:
 *   npm start       — run the bridge
 *   npm run dev     — run with auto-restart on file changes
 */

require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { addUserMessage, addBotMessage, getContextBlock } = require('./conversation-memory');
const { initLogger, getRecentLogs, logGuild } = require('./logger');
const { getClaudeArgs, parseResponse, updateSession, clearSession } = require('./session-manager');
const { createJob, completeJob, failJob, getActiveJobs, recoverAllJobs } = require('./job-manager');
const persona = require('./persona');
const channelConfig = require('./channel-config');
const { processTask } = require('../work-companion');
const { logAudit } = require('../shared/audit');
const { isYouTubeUrl, extractYouTubeUrl, processYouTubeUrl, formatDiscordSummary } = require('../shared/youtube');
let emailChecker = null;
try { emailChecker = require('../email-checker'); } catch {}
let responseDrafter = null;
try { responseDrafter = require('../email-checker/response-drafter'); } catch {}
let emailSender = null;
try { emailSender = require('../email-checker/sender'); } catch {}

// Initialize persistent logging (tees console to data/bot.log)
initLogger();

// --- Configuration ---
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '';
const PREFIX = process.env.TRIGGER_PREFIX || '';
const CLAUDE_TIMEOUT = parseInt(process.env.CLAUDE_TIMEOUT || '300000', 10);
const OPAI_ROOT = process.env.OPAI_ROOT || path.resolve(__dirname, '../..');
const HOME_GUILD_ID = process.env.HOME_GUILD_ID || '';
const NOTIFICATION_FILE = path.join(__dirname, 'data', 'pending-notification.json');

/**
 * Check if a guild is the admin (home) guild.
 * DMs ('opai-home') and the configured HOME_GUILD_ID get full access.
 * All other guilds are restricted to Team Hub tools only.
 */
function isAdminGuild(guildId) {
  return guildId === 'opai-home' || (HOME_GUILD_ID && guildId === HOME_GUILD_ID);
}

// Resolve full path to claude CLI (required on Linux where /bin/sh lacks nvm PATH)
let CLAUDE_BIN = 'claude';
try {
  CLAUDE_BIN = execSync('which claude', { encoding: 'utf8' }).trim();
} catch {
  // Fallback: check common nvm/npm global locations
  const candidates = [
    path.join(os.homedir(), '.nvm/versions/node', process.version, 'bin/claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) { CLAUDE_BIN = p; break; }
  }
}

if (!BOT_TOKEN) {
  console.error('[FATAL] DISCORD_BOT_TOKEN not set in .env');
  process.exit(1);
}

// --- Message dedup guard (prevents double-replies from overlapping instances) ---
const recentMessages = new Set();

// --- Review flow state machine ---
// key: `${guildId}:${channelId}` -> { state, fixes, summary, userId }
const reviewStates = new Map();

// --- Channel workspace cache ---
// key: `${guildId}:${channelId}` -> workspace binding
const channelWorkspaceCache = new Map();

// --- Discord Client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

/**
 * Extract guild ID from a message. DMs use 'opai-home'.
 */
function getGuildId(message) {
  return message.guildId || 'opai-home';
}

client.once(Events.ClientReady, async (c) => {
  console.log(`[OPAI] Connected as ${c.user.tag}`);
  console.log(`[OPAI] Channel: ${CHANNEL_ID || 'ALL'}`);
  console.log(`[OPAI] Prefix: "${PREFIX || '(none)'}"`);
  console.log(`[OPAI] OPAI root: ${OPAI_ROOT}`);
  console.log(`[OPAI] Claude CLI: ${CLAUDE_BIN}`);
  console.log(`[OPAI] Home guild: ${HOME_GUILD_ID || '(not set — all guilds get admin access)'}`);
  console.log(`[OPAI] Max timeout: ${CLAUDE_TIMEOUT / 1000}s`);

  try {
    logAudit({ tier: 'health', service: 'opai-discord-bot', event: 'bot-started', status: 'completed', summary: `Discord bot connected as ${c.user.tag}` });
  } catch (_) {}

  // Log channel configs for the home guild
  if (HOME_GUILD_ID) {
    const configs = channelConfig.listChannelConfigs(HOME_GUILD_ID);
    if (configs.length > 0) {
      console.log(`[OPAI] Channel configs (${configs.length}):`);
      for (const cfg of configs) {
        const ws = cfg.workspaceName ? ` → ${cfg.workspaceName}` : '';
        console.log(`[OPAI]   ${cfg.name || cfg.channelId}: ${cfg.role}${ws}`);
      }
    } else {
      console.log(`[OPAI] No channel configs — all admin guild channels default to admin mode`);
    }
  }

  // Send any pending notification from a previous restart
  await sendPendingNotification();

  // Recover interrupted jobs from ALL guilds
  const interrupted = recoverAllJobs();
  for (const job of interrupted) {
    try {
      const channel = await client.channels.fetch(job.channelId);
      if (channel) {
        const guildId = job.guildId || 'opai-home';
        const elapsed = Math.round((job.endTime - job.startTime) / 1000);
        await channel.send(
          `**${persona.getInterruptedMessage(guildId)}:** "${job.query}" (was running for ${formatElapsed(elapsed)})\nPlease resend your request.`
        );
      }
    } catch (err) {
      console.error(`[OPAI] Failed to notify interrupted job ${job.id}:`, err.message);
    }
  }
  if (interrupted.length > 0) {
    console.log(`[OPAI] Recovered ${interrupted.length} interrupted job(s)`);
  }
});

// ──────────────────────────────────────────────────────────
// Message Router
// ──────────────────────────────────────────────────────────

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (CHANNEL_ID && message.channelId !== CHANNEL_ID) return;

  // Dedup: skip if we already handled this exact message
  if (recentMessages.has(message.id)) return;
  recentMessages.add(message.id);
  setTimeout(() => recentMessages.delete(message.id), 60000);

  let content = message.content;
  if (PREFIX) {
    if (!content.startsWith(PREFIX)) return;
    content = content.slice(PREFIX.length).trim();
  }
  if (!content) return;

  const guildId = getGuildId(message);

  console.log(`[OPAI] [${guildId}] ${message.author.username}: "${content}"`);
  logGuild(guildId, 'INFO', `${message.author.username}: "${content}"`);
  addUserMessage(guildId, message.channelId, message.author.username, content);

  const lower = content.toLowerCase().trim();
  const stateKey = `${guildId}:${message.channelId}`;

  // ── Check if we're inside a review flow ──
  const review = reviewStates.get(stateKey);
  if (review && review.state === 'proposed') {
    if (['approve', 'approved', 'yes', 'apply', 'lgtm'].includes(lower)) {
      return handleReviewApproval(message, review, guildId);
    }
    if (['cancel', 'nevermind', 'abort', 'no'].includes(lower)) {
      reviewStates.delete(stateKey);
      clearSession(guildId, message.channelId);
      return message.reply('Review cancelled.');
    }
    // Anything else = edit feedback
    return handleReviewEdits(message, content, review, guildId);
  }

  const admin = isAdminGuild(guildId);

  // ── YouTube URL detection ──
  if (isYouTubeUrl(content)) {
    const ytUrl = extractYouTubeUrl(content);
    if (ytUrl) {
      const userText = content.replace(ytUrl, '').trim();
      return handleYouTubeUrl(message, ytUrl, userText, guildId);
    }
  }

  // ── Resolve channel role (admin vs team-hub) ──
  // Explicit config takes priority, then defaults based on guild type
  const chConfig = channelConfig.getChannelConfig(guildId, message.channelId);
  const channelRole = chConfig
    ? chConfig.role
    : (admin ? 'admin' : 'team-hub'); // unconfigured admin guild channels default to admin

  // ── Admin-only commands (only in admin-role channels) ──
  if (lower.match(/^review\s*(the\s*)?logs?/)) {
    if (channelRole !== 'admin') return message.reply('That command is only available in admin channels.');
    return handleReviewLogs(message, guildId);
  }

  if (lower.startsWith('task:') || lower.startsWith('task ')) {
    if (channelRole !== 'admin') return message.reply('Task routing is only available in admin channels. Use `hub task <text>` instead.');
    const taskDesc = content.replace(/^task[:\s]+/i, '').trim();
    if (taskDesc) return handleTaskCommand(message, taskDesc, channelRole);
  }

  if (lower.match(/^check\s*(my\s*)?(e-?mail|inbox)/)) {
    if (channelRole !== 'admin') return message.reply('Email commands are only available in admin channels.');
    return handleCheckEmail(message);
  }

  if (lower.match(/^e-?mail\s+tasks?/)) {
    if (channelRole !== 'admin') return message.reply('Email commands are only available in admin channels.');
    return handleEmailTasks(message);
  }

  if (lower.match(/^e-?mail\s+drafts?/)) {
    if (channelRole !== 'admin') return message.reply('Email commands are only available in admin channels.');
    return handleEmailDrafts(message);
  }

  if (lower.startsWith('approve ')) {
    if (channelRole !== 'admin') return message.reply('Email approval is only available in admin channels.');
    const id = content.split(/\s+/)[1];
    if (id) return handleEmailApprove(message, id);
  }

  if (lower.startsWith('reject ')) {
    if (channelRole !== 'admin') return message.reply('Email commands are only available in admin channels.');
    const id = content.split(/\s+/)[1];
    if (id) return handleEmailReject(message, id);
  }

  if (lower.startsWith('persona')) {
    if (channelRole !== 'admin') return message.reply('Persona management is only available in admin channels.');
    return handlePersonaCommand(message, content, guildId);
  }

  // ── Command: channel (admin-only — configure channel roles) ──
  if (lower.startsWith('channel ') || lower === 'channel') {
    if (!admin) return message.reply('Channel configuration is only available in the admin server.');
    return handleChannelCommand(message, content, guildId);
  }

  // ── Commands available to ALL channels ──

  // ── Command: hub (Team Hub integration) ──
  if (lower.startsWith('hub ') || lower === 'hub') {
    const hubArgs = content.replace(/^hub\s*/i, '').trim();
    return handleHubCommand(message, hubArgs, guildId);
  }

  // ── Command: status / jobs ──
  if (lower === 'status' || lower === 'jobs') {
    return handleStatusCommand(message, guildId);
  }

  // ── Route based on channel role ──

  if (channelRole === 'team-hub') {
    // Team Hub channel — resolve workspace and route to workspace AI
    const wsBinding = chConfig && chConfig.workspaceId
      ? await resolveChannelWorkspace(guildId, message.channelId, chConfig.workspaceId)
      : await resolveChannelWorkspace(guildId, message.channelId);

    if (wsBinding && wsBinding.workspace_id) {
      return handleWorkspaceAI(message, content, wsBinding, guildId);
    }

    // No workspace bound — show help
    return message.reply(
      "I'm your Team Hub assistant! Here's what I can do:\n" +
      '`hub note <text>` — save a note\n' +
      '`hub task <text>` — create a task\n' +
      '`hub idea <text>` — park an idea\n' +
      '`hub status` — your open items\n' +
      '`hub search <query>` — search your workspace\n\n' +
      '_Ask your admin to connect a workspace to this channel for AI chat._'
    );
  }

  // ── Admin channel — full OPAI access ──
  return handleNormalMessage(message, content, guildId);
});

// ──────────────────────────────────────────────────────────
// Normal Message Handler
// ──────────────────────────────────────────────────────────

async function handleNormalMessage(message, content, guildId) {
  // Immediate acknowledgment — bot returns to event loop right away
  const statusMsg = await message.reply(persona.getAckMessage(guildId));
  const startTime = Date.now();

  // Track the job for status reporting and restart recovery
  const jobId = createJob(guildId, {
    channelId: message.channelId,
    statusMessageId: statusMsg.id,
    userId: message.author.id,
    query: content,
  });

  // Progress updates every 15s with persona-driven rotating messages
  const progressInterval = setInterval(async () => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    let text = `**${persona.getProcessingMessage(guildId, elapsed)}** (${formatElapsed(elapsed)})`;
    if (elapsed > 300) text += `\n${persona.getLongRunningNote(guildId)}`;
    try { await statusMsg.edit(text); } catch {}
  }, 15000);

  // Fire-and-forget — bot remains responsive to other messages
  askClaude(content, message.author.username, guildId, message.channelId)
    .then(async (reply) => {
      clearInterval(progressInterval);
      completeJob(guildId, jobId);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      try { logAudit({ tier: 'execution', service: 'opai-discord-bot', event: 'claude-invocation', status: 'completed', summary: `Claude replied (${elapsed}s)`, duration_ms: Date.now() - startTime, details: { guildId, user: message.author.username, channelId: message.channelId } }); } catch (_) {}

      if (reply && reply.trim()) {
        const trimmed = reply.trim();
        addBotMessage(guildId, message.channelId, trimmed.substring(0, 500));
        const chunks = splitMessage(trimmed, 2000);
        await statusMsg.edit(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await message.channel.send(chunks[i]);
        }
        logGuild(guildId, 'INFO', `Replied (${trimmed.length} chars, ${elapsed}s)`);
        console.log(`[OPAI] [${guildId}] Replied (${trimmed.length} chars, ${elapsed}s)`);
      } else {
        await statusMsg.edit(persona.getNoResponse(guildId));
      }
    })
    .catch(async (err) => {
      clearInterval(progressInterval);
      failJob(guildId, jobId, err.message);
      console.error(`[OPAI] [${guildId}] Error:`, err.message);
      logGuild(guildId, 'ERROR', err.message);
      await statusMsg.edit(persona.getErrorMessage(guildId, err.message)).catch(() => {});
    });

  // Returns immediately — does NOT await Claude
}

// ──────────────────────────────────────────────────────────
// Status Command — Show active jobs (guild-scoped)
// ──────────────────────────────────────────────────────────

async function handleStatusCommand(message, guildId) {
  const active = getActiveJobs(guildId);
  if (active.length === 0) {
    return message.reply('No active jobs running.');
  }
  const lines = active.map((j) => {
    const elapsed = Math.round((Date.now() - j.startTime) / 1000);
    return `- **${j.id}** — "${j.query}" (${formatElapsed(elapsed)})`;
  });
  return message.reply(`**Active Jobs (${active.length}):**\n${lines.join('\n')}`);
}

// ──────────────────────────────────────────────────────────
// Persona Command — Switch or view active persona (per-guild)
// ──────────────────────────────────────────────────────────

async function handlePersonaCommand(message, content, guildId) {
  const parts = content.trim().split(/\s+/);
  const target = parts[1]?.toLowerCase();

  if (!target) {
    const current = persona.getActivePersonaName(guildId);
    const available = persona.listPersonas();
    return message.reply(
      `**Active persona:** ${current}\n**Available:** ${available.join(', ')}\n\nSwitch with: \`${PREFIX}persona <name>\``
    );
  }

  if (persona.setPersona(guildId, target)) {
    return message.reply(`Persona switched to **${target}**.`);
  } else {
    const available = persona.listPersonas();
    return message.reply(`Unknown persona "${target}". Available: ${available.join(', ')}`);
  }
}

// ──────────────────────────────────────────────────────────
// Channel Command — Configure channel roles (admin-only)
// ──────────────────────────────────────────────────────────

async function handleChannelCommand(message, content, guildId) {
  const parts = content.trim().split(/\s+/);
  const sub = (parts[1] || '').toLowerCase();

  // channel list — show all configured channels
  if (sub === 'list' || !sub) {
    const configs = channelConfig.listChannelConfigs(guildId);
    if (configs.length === 0) {
      return message.reply(
        '**No channels configured.** All channels in this server default to **admin** mode.\n\n' +
        'Use `channel set admin` or `channel set team-hub` to configure this channel.'
      );
    }
    const lines = ['**Configured Channels:**\n'];
    for (const cfg of configs) {
      const name = cfg.name || cfg.channelId;
      const ws = cfg.workspaceName ? ` (workspace: ${cfg.workspaceName})` : '';
      lines.push(`- <#${cfg.channelId}> — **${cfg.role}**${ws}`);
    }
    lines.push('\n_Unconfigured channels default to **admin** mode._');
    return message.reply(lines.join('\n'));
  }

  // channel set admin — make this channel an admin channel
  if (sub === 'set' && parts[2]?.toLowerCase() === 'admin') {
    const channelName = message.channel.name || message.channelId;
    channelConfig.setChannelConfig(guildId, message.channelId, 'admin', {
      name: channelName,
    });
    // Clear cached workspace binding so it doesn't interfere
    channelWorkspaceCache.delete(`${guildId}:${message.channelId}`);
    return message.reply(
      `**Channel set to admin mode.** This channel now has full OPAI access (filesystem, orchestrator, all tools).`
    );
  }

  // channel set team-hub [workspace-name] — make this channel a team hub channel
  if (sub === 'set' && parts[2]?.toLowerCase() === 'team-hub') {
    const wsSearch = parts.slice(3).join(' ').trim();
    let workspaceId = null;
    let workspaceName = null;

    // If a workspace name/id was provided, try to find it
    if (wsSearch) {
      try {
        const resp = await fetch(HUB_API + '/internal/resolve-channel?channel_id=' + message.channelId);
        const data = await resp.json();
        if (data.found) {
          workspaceId = data.workspace_id;
          workspaceName = data.workspace_name;
        }
      } catch {}

      // If no match from channel binding, the workspace name is saved for reference
      if (!workspaceId) {
        workspaceName = wsSearch;
      }
    }

    const channelName = message.channel.name || message.channelId;
    channelConfig.setChannelConfig(guildId, message.channelId, 'team-hub', {
      name: channelName,
      workspaceId,
      workspaceName: workspaceName || 'auto-detect',
    });
    // Clear cached workspace binding
    channelWorkspaceCache.delete(`${guildId}:${message.channelId}`);

    const wsNote = workspaceName ? ` (workspace: **${workspaceName}**)` : ' (workspace: auto-detect from Team Hub)';
    return message.reply(
      `**Channel set to team-hub mode.**${wsNote}\nThis channel will use Team Hub workspace AI with scoped MCP tools.`
    );
  }

  // channel clear — remove config, revert to default
  if (sub === 'clear' || sub === 'reset') {
    channelConfig.clearChannelConfig(guildId, message.channelId);
    channelWorkspaceCache.delete(`${guildId}:${message.channelId}`);
    return message.reply('**Channel config cleared.** This channel will use default behavior (admin mode in this server).');
  }

  // Help
  return message.reply(
    '**Channel Configuration:**\n' +
    '`channel list` — show all configured channels\n' +
    '`channel set admin` — make this channel an admin channel (full OPAI access)\n' +
    '`channel set team-hub [workspace]` — make this channel a Team Hub channel\n' +
    '`channel clear` — remove config (revert to default)\n\n' +
    '_Unconfigured channels in the admin server default to **admin** mode._'
  );
}

// ──────────────────────────────────────────────────────────
// Task Command — Classify and route via Work Companion
// ──────────────────────────────────────────────────────────

async function handleTaskCommand(message, taskDescription, channelRole = 'admin') {
  try {
    const gid = message.guildId || 'opai-home';
    const result = processTask(taskDescription, {
      queue: true,
      source: 'discord',
      channel_role: channelRole,
      guild_id: gid,
      is_home_guild: isAdminGuild(gid),
    });
    const { classification, routing, queueId } = result;

    const response = [
      `**Task Classified:**`,
      routing.summary,
      ``,
      queueId ? `**Queued as:** \`${queueId}\`` : '',
      ``,
      routing.mode === 'auto_safe'
        ? '`This task is queued for auto-safe execution.`'
        : '`Queued — awaiting approval. Run the suggested command when ready.`',
    ].filter(Boolean).join('\n');

    const chunks = splitMessage(response, 2000);
    await message.reply(chunks[0]);
    for (let i = 1; i < chunks.length; i++) {
      await message.channel.send(chunks[i]);
    }

    console.log(`[OPAI] Task routed: ${classification.type} (${classification.priority}) → ${routing.squads.join(',') || 'specialist'} [${queueId}]`);
  } catch (err) {
    console.error('[OPAI] Task routing error:', err.message);
    await message.reply(`\`Error routing task: ${err.message}\``);
  }
}

// ──────────────────────────────────────────────────────────
// Email Check Command
// ──────────────────────────────────────────────────────────

async function handleCheckEmail(message) {
  if (!emailChecker) {
    return message.reply('`Email checker not available. Run npm install in tools/email-checker/ first.`');
  }

  const statusMsg = await message.reply('`Checking email...`');

  try {
    const result = await emailChecker.checkEmails();
    const chunks = splitMessage(result.summary, 2000);
    await statusMsg.edit(chunks[0]);
    for (let i = 1; i < chunks.length; i++) {
      await message.channel.send(chunks[i]);
    }
    console.log(`[OPAI] Email check: ${result.totalEmails} emails, ${result.totalTasks} tasks`);
  } catch (err) {
    console.error('[OPAI] Email check error:', err.message);
    await statusMsg.edit(`\`Error checking email: ${err.message}\``).catch(() => {});
  }
}

// ──────────────────────────────────────────────────────────
// Email Tasks Command — Show pending tasks by sender
// ──────────────────────────────────────────────────────────

async function handleEmailTasks(message) {
  if (!emailChecker) {
    return message.reply('`Email checker not available.`');
  }

  try {
    const data = emailChecker.loadTasks();
    const senders = Object.entries(data.bySender || {});
    if (senders.length === 0) {
      return message.reply('No email tasks found. Run `check email` first.');
    }

    const lines = ['**Email Tasks by Sender:**\n'];
    for (const [email, info] of senders) {
      const pending = info.tasks.filter(t => t.status === 'pending');
      if (pending.length === 0) continue;
      lines.push(`**${info.name}** (${email}) — ${pending.length} task(s)`);
      for (const task of pending.slice(0, 5)) {
        const pri = task.priority === 'high' ? '!' : task.priority === 'critical' ? '!!' : '';
        lines.push(`  ${pri}- ${task.task}${task.deadline ? ` (by ${task.deadline})` : ''}`);
      }
      if (pending.length > 5) lines.push(`  ...and ${pending.length - 5} more`);
      lines.push('');
    }

    const text = lines.join('\n');
    const chunks = splitMessage(text, 2000);
    await message.reply(chunks[0]);
    for (let i = 1; i < chunks.length; i++) await message.channel.send(chunks[i]);
  } catch (err) {
    await message.reply(`\`Error loading tasks: ${err.message}\``);
  }
}

// ──────────────────────────────────────────────────────────
// Email Drafts Command — Show pending response drafts
// ──────────────────────────────────────────────────────────

async function handleEmailDrafts(message) {
  if (!responseDrafter) {
    return message.reply('`Response drafter not available.`');
  }

  try {
    const drafts = responseDrafter.getPendingDrafts();
    if (drafts.length === 0) {
      return message.reply('No pending response drafts.');
    }

    const lines = [`**Pending Response Drafts (${drafts.length}):**\n`];
    for (const d of drafts) {
      const preview = (d.refinedDraft || d.initialDraft || '').substring(0, 100);
      lines.push(`**\`${d.id}\`** — Re: ${d.subject}`);
      lines.push(`  To: ${d.toName || d.to} | Account: ${d.account}`);
      lines.push(`  Preview: ${preview}...`);
      lines.push(`  \`approve ${d.id}\` | \`reject ${d.id}\``);
      lines.push('');
    }

    const text = lines.join('\n');
    const chunks = splitMessage(text, 2000);
    await message.reply(chunks[0]);
    for (let i = 1; i < chunks.length; i++) await message.channel.send(chunks[i]);
  } catch (err) {
    await message.reply(`\`Error loading drafts: ${err.message}\``);
  }
}

// ──────────────────────────────────────────────────────────
// Email Approve Command — Approve and send a draft
// ──────────────────────────────────────────────────────────

async function handleEmailApprove(message, responseId) {
  if (!responseDrafter || !emailSender) {
    return message.reply('`Email modules not available.`');
  }

  const statusMsg = await message.reply('`Approving and sending...`');

  try {
    const response = responseDrafter.approveResponse(responseId);
    if (!response) {
      return statusMsg.edit(`\`Response "${responseId}" not found. Use "email drafts" to see IDs.\``);
    }

    const envPrefix = emailSender.getEnvPrefixForAccount(response.account);
    const result = await emailSender.sendResponse(response, envPrefix);

    if (result.success) {
      responseDrafter.markSent(responseId);
      // Clean up IMAP draft since it was sent via OPAI
      if (emailSender.removeDraftFromAccount) {
        emailSender.removeDraftFromAccount(response.subject, envPrefix).catch(() => {});
      }
      await statusMsg.edit(`**Sent!** Response to ${response.to} (${response.subject}) delivered.`);
    } else {
      await statusMsg.edit(`**Approved** but send failed: ${result.error}\nRetry: \`approve ${responseId}\``);
    }
  } catch (err) {
    await statusMsg.edit(`\`Error: ${err.message}\``);
  }
}

// ──────────────────────────────────────────────────────────
// Email Reject Command — Cancel a draft
// ──────────────────────────────────────────────────────────

async function handleEmailReject(message, responseId) {
  if (!responseDrafter) {
    return message.reply('`Response drafter not available.`');
  }

  try {
    const response = responseDrafter.rejectResponse(responseId);
    if (!response) {
      return message.reply(`\`Response "${responseId}" not found.\``);
    }
    await message.reply(`Draft response to ${response.to} rejected.`);
  } catch (err) {
    await message.reply(`\`Error: ${err.message}\``);
  }
}

// ──────────────────────────────────────────────────────────
// Review Logs Flow
// ──────────────────────────────────────────────────────────

async function handleReviewLogs(message, guildId) {
  const statusMsg = await message.reply('`Analyzing bot logs...`');
  const startTime = Date.now();
  const progressInterval = setInterval(async () => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    try { await statusMsg.edit(`\`Reviewing logs... (${elapsed}s)\``); } catch {}
  }, 15000);

  try {
    const logs = getRecentLogs(150);

    // Fresh session for review analysis
    clearSession(guildId, message.channelId);

    const prompt = [
      `You are OPAI Bot's self-diagnostic system. Review the bot logs below.`,
      `Identify errors, recurring issues, or improvements.`,
      ``,
      `RESPOND IN THIS EXACT FORMAT:`,
      ``,
      `**Analysis:**`,
      `<describe issues found>`,
      ``,
      `**Proposed Fixes:**`,
      `<describe each fix>`,
      ``,
      `**Fix Data:**`,
      '```json',
      `[`,
      `  { "file": "index.js", "search": "exact text to find", "replace": "replacement text" }`,
      `]`,
      '```',
      ``,
      `**Summary:** <one-line description>`,
      ``,
      `Rules:`,
      `- Only fix files inside tools/discord-bridge/`,
      `- Use relative paths from the bridge directory`,
      `- "search" must be an exact substring of the current file`,
      `- If no issues found, return empty array [] and say so`,
      ``,
      `--- BOT LOGS ---`,
      logs,
      `--- END LOGS ---`,
    ].join('\n');

    const reply = await askClaude(prompt, message.author.username, guildId, message.channelId);
    clearInterval(progressInterval);

    if (!reply || !reply.trim()) {
      return statusMsg.edit('`No response from log analysis.`');
    }

    const trimmed = reply.trim();
    addBotMessage(guildId, message.channelId, trimmed.substring(0, 500));

    const fixes = extractFixes(trimmed);
    const summary = extractSummary(trimmed);
    const stateKey = `${guildId}:${message.channelId}`;

    if (fixes.length > 0) {
      reviewStates.set(stateKey, {
        state: 'proposed',
        fixes,
        summary,
        userId: message.author.id,
      });
      const full = trimmed + '\n\n`Reply "approve" to apply, provide feedback to revise, or "cancel".`';
      const chunks = splitMessage(full, 2000);
      await statusMsg.edit(chunks[0]);
      for (let i = 1; i < chunks.length; i++) await message.channel.send(chunks[i]);
    } else {
      const chunks = splitMessage(trimmed, 2000);
      await statusMsg.edit(chunks[0]);
      for (let i = 1; i < chunks.length; i++) await message.channel.send(chunks[i]);
    }

    console.log(`[OPAI] [${guildId}] Review complete (${fixes.length} fixes, ${Math.round((Date.now() - startTime) / 1000)}s)`);
  } catch (err) {
    clearInterval(progressInterval);
    console.error(`[OPAI] [${guildId}] Review error:`, err.message);
    await statusMsg.edit(`\`Error reviewing logs: ${err.message}\``).catch(() => {});
  }
}

// ──────────────────────────────────────────────────────────
// Review Approval — Apply fixes, write notification, restart
// ──────────────────────────────────────────────────────────

async function handleReviewApproval(message, review, guildId) {
  const statusMsg = await message.reply('`Applying fixes...`');
  const stateKey = `${guildId}:${message.channelId}`;

  try {
    review.state = 'applying';
    const results = applyFixes(review.fixes);
    const ok = results.filter(r => r.success).length;
    const fail = results.filter(r => !r.success).length;

    let details = `${ok} fix(es) applied`;
    if (fail > 0) details += `, ${fail} failed`;
    details += ` — ${review.summary || 'system update'}`;

    if (ok > 0) {
      // Write notification for after restart
      writePendingNotification(message.channelId, details, results);

      reviewStates.delete(stateKey);
      clearSession(guildId, message.channelId);
      await statusMsg.edit('`Fixes applied. Restarting bot in 3s...`');
      console.log(`[OPAI] Applied ${ok} fix(es). Restarting...`);

      setTimeout(() => process.exit(0), 3000); // Wrapper bat restarts us
    } else {
      const errDetails = results.map(r => `- ${r.file}: ${r.error}`).join('\n');
      await statusMsg.edit(`\`All fixes failed.\`\n${errDetails}`);
      reviewStates.delete(stateKey);
    }
  } catch (err) {
    console.error('[OPAI] Apply error:', err.message);
    await statusMsg.edit(`\`Error applying fixes: ${err.message}\``).catch(() => {});
    reviewStates.delete(stateKey);
  }
}

// ──────────────────────────────────────────────────────────
// Review Edits — User provides feedback, Claude revises
// ──────────────────────────────────────────────────────────

async function handleReviewEdits(message, feedback, review, guildId) {
  const statusMsg = await message.reply('`Revising based on your feedback...`');
  const startTime = Date.now();
  const progressInterval = setInterval(async () => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    try { await statusMsg.edit(`\`Revising... (${elapsed}s)\``); } catch {}
  }, 15000);

  try {
    // Session resume gives Claude full context of the prior proposal
    const prompt = [
      `The user reviewed your proposed fixes and gave this feedback:`,
      `"${feedback}"`,
      ``,
      `Revise your proposal. Use the same format: Analysis, Proposed Fixes, Fix Data (JSON), Summary.`,
    ].join('\n');

    const reply = await askClaude(prompt, message.author.username, guildId, message.channelId);
    clearInterval(progressInterval);

    if (!reply || !reply.trim()) {
      return statusMsg.edit('`No response from revision.`');
    }

    const trimmed = reply.trim();
    addBotMessage(guildId, message.channelId, trimmed.substring(0, 500));

    const fixes = extractFixes(trimmed);
    const summary = extractSummary(trimmed);

    if (fixes.length > 0) {
      review.fixes = fixes;
      review.summary = summary;
    }

    const full = trimmed + '\n\n`Reply "approve" to apply, or keep providing feedback.`';
    const chunks = splitMessage(full, 2000);
    await statusMsg.edit(chunks[0]);
    for (let i = 1; i < chunks.length; i++) await message.channel.send(chunks[i]);
  } catch (err) {
    clearInterval(progressInterval);
    console.error(`[OPAI] [${guildId}] Revision error:`, err.message);
    await statusMsg.edit(`\`Error: ${err.message}\``).catch(() => {});
  }
}

// ──────────────────────────────────────────────────────────
// Fix Application Engine
// ──────────────────────────────────────────────────────────

function applyFixes(fixes) {
  const results = [];
  const bridgeDir = path.resolve(__dirname);

  for (const fix of fixes) {
    try {
      const filePath = path.resolve(bridgeDir, fix.file);

      // Security: block writes outside discord-bridge/
      if (!filePath.startsWith(bridgeDir)) {
        results.push({ file: fix.file, success: false, error: 'Blocked: outside bridge directory' });
        continue;
      }

      if (fix.search && fix.replace !== undefined) {
        // Search-and-replace edit
        if (!fs.existsSync(filePath)) {
          results.push({ file: fix.file, success: false, error: 'File not found' });
          continue;
        }
        const content = fs.readFileSync(filePath, 'utf8');
        if (!content.includes(fix.search)) {
          results.push({ file: fix.file, success: false, error: 'Search text not found' });
          continue;
        }
        fs.writeFileSync(filePath, content.replace(fix.search, fix.replace), 'utf8');
        results.push({ file: fix.file, success: true, action: 'edited' });
      } else if (fix.content) {
        // Full file write
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, fix.content, 'utf8');
        results.push({ file: fix.file, success: true, action: 'created' });
      } else {
        results.push({ file: fix.file, success: false, error: 'No search/replace or content provided' });
      }
    } catch (err) {
      results.push({ file: fix.file, success: false, error: err.message });
    }
  }

  return results;
}

function extractFixes(text) {
  const match = text.match(/```json\s*\n?([\s\S]*?)```/);
  if (!match) return [];
  try { return JSON.parse(match[1]); } catch { return []; }
}

function extractSummary(text) {
  const match = text.match(/\*\*Summary:\*\*\s*(.*)/i);
  return match ? match[1].trim() : '';
}

// ──────────────────────────────────────────────────────────
// Post-Restart Notification
// ──────────────────────────────────────────────────────────

function writePendingNotification(channelId, details, results) {
  const notification = {
    channelId,
    message: `**Update Complete:** ${details}`,
    timestamp: Date.now(),
    results,
  };
  fs.writeFileSync(NOTIFICATION_FILE, JSON.stringify(notification, null, 2), 'utf8');
}

async function sendPendingNotification() {
  try {
    if (!fs.existsSync(NOTIFICATION_FILE)) return;
    const notification = JSON.parse(fs.readFileSync(NOTIFICATION_FILE, 'utf8'));
    fs.unlinkSync(NOTIFICATION_FILE);

    // Skip if older than 5 minutes (stale restart)
    if (Date.now() - notification.timestamp > 5 * 60 * 1000) return;

    const channel = await client.channels.fetch(notification.channelId);
    if (channel) {
      await channel.send(notification.message);
      console.log('[OPAI] Sent post-restart notification');
    }
  } catch (err) {
    console.error('[OPAI] Notification error:', err.message);
  }
}

// ──────────────────────────────────────────────────────────
// Claude CLI Invocation (session-aware, guild-scoped)
// ──────────────────────────────────────────────────────────

function askClaude(userMessage, username, guildId, channelId) {
  return new Promise((resolve, reject) => {
    const conversationContext = getContextBlock(guildId, channelId);
    const claudeArgs = getClaudeArgs(guildId, channelId);

    const prompt = [
      `You are OPAI Bot — the admin assistant for the OPAI platform. You are responding via Discord to user "${username}".`,
      `You are running in an ADMIN channel with full access to the OPAI workspace filesystem, tools, and orchestrator.`,
      `Keep responses concise and Discord-friendly (under 1500 chars when possible).`,
      `Use Discord markdown: **bold**, \`code\`, \`\`\`code blocks\`\`\`, - lists.`,
      `You have access to the OPAI workspace at ${OPAI_ROOT}, n8n workflows (via MCP), and local files.`,
      `Key paths: tools/ (platform services), config/ (configs), scripts/ (control scripts), Library/opai-wiki/ (docs).`,
      `Do NOT use tools unless the user explicitly asks you to perform an action.`,
      `For simple greetings or questions, just respond directly.`,
      ``,
      ...(conversationContext ? [conversationContext, ''] : []),
      `User message: ${userMessage}`,
    ].join('\n');

    const tmpFile = path.join(os.tmpdir(), `opai-discord-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, prompt, 'utf8');

    let stdout = '';
    let stderr = '';

    // Clean env: remove Claude session vars so spawned claude doesn't think it's nested
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

    const proc = spawn(CLAUDE_BIN, claudeArgs, {
      cwd: OPAI_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnv,
    });

    const input = fs.createReadStream(tmpFile);
    input.pipe(proc.stdin);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      cleanup();
      console.error(`[OPAI] [${guildId}] Timed out. stdout(${stdout.length}), stderr: ${stderr.substring(0, 300)}`);
      resolve(stdout || persona.getTimeoutMessage(guildId));
    }, CLAUDE_TIMEOUT);

    function cleanup() {
      clearTimeout(timer);
      try { fs.unlinkSync(tmpFile); } catch {}
    }

    proc.on('close', (code) => {
      cleanup();
      if (code !== 0) {
        console.error(`[OPAI] [${guildId}] Claude exit ${code} | stderr: ${stderr.substring(0, 300)}`);
      }

      // Parse JSON output -> extract text + session ID
      const parsed = parseResponse(stdout);
      if (parsed.sessionId) {
        updateSession(guildId, channelId, parsed.sessionId);
      }

      console.log(`[OPAI] [${guildId}] Claude done (exit ${code}, ${(parsed.text || stdout).length} chars, session: ${parsed.sessionId ? 'reused' : 'new'})`);
      resolve(parsed.text || stdout || stderr || '');
    });

    proc.on('error', (err) => {
      cleanup();
      reject(err);
    });
  });
}

// ──────────────────────────────────────────────────────────
// Hub Command — Team Hub integration
// ──────────────────────────────────────────────────────────

const HUB_API = 'http://127.0.0.1:8089/api';

async function resolveChannelWorkspace(guildId, channelId, workspaceIdOverride) {
  const cacheKey = `${guildId}:${channelId}`;
  const cached = channelWorkspaceCache.get(cacheKey);
  if (cached && Date.now() - cached._ts < 300000) return cached;

  try {
    // If a workspace ID override is provided (from channel config), fetch that workspace directly
    if (workspaceIdOverride) {
      const resp = await fetch(HUB_API + '/internal/resolve-channel?channel_id=' + channelId);
      const data = await resp.json();
      if (data.found) {
        data._ts = Date.now();
        channelWorkspaceCache.set(cacheKey, data);
        return data;
      }
      // Fallback: build a minimal binding from the workspace ID
      return {
        found: true,
        workspace_id: workspaceIdOverride,
        workspace_name: 'Workspace',
        bot_prompt: '',
        _ts: Date.now(),
      };
    }

    const resp = await fetch(HUB_API + '/internal/resolve-channel?channel_id=' + channelId);
    const data = await resp.json();
    if (data.found) {
      data._ts = Date.now();
      channelWorkspaceCache.set(cacheKey, data);
      return data;
    }
  } catch {}
  return null;
}

async function resolveHubUser(discordId) {
  try {
    const resp = await fetch(HUB_API + '/internal/resolve-discord-user?discord_id=' + discordId);
    const data = await resp.json();
    if (data.found) return data;
  } catch {}
  return null;
}

async function resolveOrCreateMember(workspaceId, discordId, discordUsername) {
  try {
    const params = new URLSearchParams({
      workspace_id: workspaceId,
      discord_id: discordId,
      discord_username: discordUsername,
    });
    const resp = await fetch(HUB_API + '/internal/resolve-or-create-discord-member?' + params.toString(), { method: 'POST' });
    return await resp.json();
  } catch {}
  return null;
}

async function handleHubCommand(message, args, guildId) {
  const parts = args.split(/\s+/);
  const sub = (parts[0] || '').toLowerCase();
  const rest = parts.slice(1).join(' ').trim();

  // Check if this channel is bound to a workspace
  const channelWs = await resolveChannelWorkspace(guildId, message.channelId);

  // Resolve Discord user — try linked profile first, then workspace member
  let userId = null;
  let displayName = message.author.username;
  let workspaceId = channelWs ? channelWs.workspace_id : null;

  const hubUser = await resolveHubUser(message.author.id);
  if (hubUser) {
    userId = hubUser.user_id;
    displayName = hubUser.display_name || displayName;
  }

  // If channel has a workspace binding, auto-discover the Discord user as a member
  if (channelWs && channelWs.workspace_id) {
    const member = await resolveOrCreateMember(
      channelWs.workspace_id, message.author.id, message.author.username
    );
    if (member && member.user_id && !userId) {
      userId = member.user_id;
    }
  }

  if (!userId) {
    return message.reply(
      '**Not linked.** Your Discord account is not linked to an OPAI profile.\n' +
      'Ask an admin to set your `discord_id` in the profiles table.'
    );
  }

  if (sub === 'note' && rest) {
    return hubCreateItem(message, userId, 'note', rest, workspaceId);
  }
  if (sub === 'task' && rest) {
    return hubCreateItem(message, userId, 'task', rest, workspaceId);
  }
  if (sub === 'idea' && rest) {
    return hubCreateItem(message, userId, 'idea', rest, workspaceId);
  }
  if (sub === 'status') {
    return hubStatus(message, userId, displayName);
  }
  if (sub === 'search' && rest) {
    return hubSearch(message, userId, rest);
  }

  // Help
  const wsNote = channelWs ? '\n_This channel is linked to workspace: **' + channelWs.workspace_name + '**_' : '';
  return message.reply(
    '**Team Hub Commands:**\n' +
    '`hub task <text>` — create a task\n' +
    '`hub note <text>` — save a note\n' +
    '`hub idea <text>` — park an idea\n' +
    '`hub status` — your open items\n' +
    '`hub search <query>` — search across workspaces\n\n' +
    '**Flags** (optional on task/note/idea):\n' +
    '`--priority high` — set priority (critical/high/medium/low)\n' +
    '`--due 2026-03-15` — set due date\n' +
    '`--list "List Name"` — route to a list\n' +
    '`@user` — assign to a mentioned user' +
    wsNote
  );
}

/**
 * Parse structured args from hub commands.
 * Supports: --assign @user, --priority high, --due 2026-03-15, --list "List Name"
 * Returns { title, flags } where title is the text without flags.
 */
function parseHubArgs(input) {
  const flags = {};
  // Extract --key value pairs (value can be quoted or single-word)
  let cleaned = input.replace(/--(\w+)\s+"([^"]+)"/g, (_, key, val) => {
    flags[key] = val;
    return '';
  });
  cleaned = cleaned.replace(/--(\w+)\s+(\S+)/g, (_, key, val) => {
    flags[key] = val;
    return '';
  });
  // Extract @mention for assignment (Discord mention format: <@123456>)
  cleaned = cleaned.replace(/<@!?(\d+)>/g, (_, discordId) => {
    flags.assign_discord_id = discordId;
    return '';
  });
  const title = cleaned.replace(/\s+/g, ' ').trim();
  return { title, flags };
}

async function hubCreateItem(message, userId, type, rawInput, workspaceId) {
  try {
    const { title, flags } = parseHubArgs(rawInput);

    if (!title) {
      return message.reply('Please provide a title. Example: `hub task Fix login --priority high --assign @user`');
    }

    const gid = message.guildId || 'opai-home';
    const params = new URLSearchParams({
      user_id: userId,
      type: type,
      title: title,
      source: 'discord',
      guild_id: gid,
      is_home_guild: isAdminGuild(gid) ? 'true' : 'false',
    });

    // Workspace routing
    if (workspaceId) {
      params.set('workspace_id', workspaceId);
    } else {
      params.set('workspace_type', 'personal');
    }

    // Structured flags
    if (flags.priority) params.set('priority', flags.priority);
    if (flags.due) params.set('due_date', flags.due);
    if (flags.list) params.set('list_name', flags.list);
    if (flags.description || flags.desc) params.set('description', flags.description || flags.desc);

    // Resolve @mention to OPAI user ID for assignment
    if (flags.assign_discord_id) {
      const assignee = await resolveHubUser(flags.assign_discord_id);
      if (assignee && assignee.user_id) {
        params.set('assignee_id', assignee.user_id);
        flags._assignee_name = assignee.display_name || 'user';
      }
    } else if (flags.assign) {
      // --assign with a user ID directly
      params.set('assignee_id', flags.assign);
    }

    const resp = await fetch(HUB_API + '/internal/create-item?' + params.toString(), { method: 'POST' });
    const data = await resp.json();

    if (data.id) {
      const label = type === 'task' ? 'Task' : type === 'idea' ? 'Idea' : 'Note';
      let reply = '**' + label + ' created:** "' + title + '"\nID: `' + data.id.substring(0, 8) + '`';
      const extras = [];
      if (flags.priority) extras.push('Priority: **' + flags.priority + '**');
      if (flags.due) extras.push('Due: **' + flags.due + '**');
      if (flags._assignee_name) extras.push('Assigned: **' + flags._assignee_name + '**');
      if (flags.list) extras.push('List: **' + flags.list + '**');
      if (extras.length) reply += '\n' + extras.join(' | ');
      return message.reply(reply);
    } else {
      return message.reply('Failed to create ' + type + ': ' + (data.detail || 'unknown error'));
    }
  } catch (err) {
    console.error('[OPAI] Hub create error:', err.message);
    return message.reply('`Hub API error: ' + err.message + '`');
  }
}

async function hubStatus(message, userId, displayName) {
  try {
    const resp = await fetch(HUB_API + '/internal/user-items?user_id=' + userId + '&limit=10');
    const data = await resp.json();
    const items = data.items || [];

    if (items.length === 0) {
      return message.reply('No open items. Use `hub task` or `hub note` to create one.');
    }

    const lines = ['**' + (displayName || 'Your') + "'s Open Items:**\n"];
    for (const item of items) {
      const icon = item.type === 'task' ? '[ ]' : item.type === 'idea' ? '**Idea**' : '**Note**';
      const pri = item.priority === 'high' ? '!' : item.priority === 'critical' ? '!!' : '';
      lines.push(icon + ' ' + pri + item.title + ' — *' + item.status + '*');
    }
    if (items.length >= 10) lines.push('\n_Showing first 10..._');

    const text = lines.join('\n');
    const chunks = splitMessage(text, 2000);
    await message.reply(chunks[0]);
    for (let i = 1; i < chunks.length; i++) await message.channel.send(chunks[i]);
  } catch (err) {
    console.error('[OPAI] Hub status error:', err.message);
    return message.reply('`Hub API error: ' + err.message + '`');
  }
}

async function hubSearch(message, userId, query) {
  try {
    const params = new URLSearchParams({ user_id: userId, q: query, limit: '10' });
    const resp = await fetch(HUB_API + '/internal/search?' + params.toString());
    const data = await resp.json();
    const items = data.items || [];

    if (items.length === 0) {
      return message.reply('No results for "' + query + '".');
    }

    const lines = ['**Search: "' + query + '"** (' + items.length + ' results)\n'];
    for (const item of items) {
      const icon = item.type === 'task' ? '[ ]' : item.type === 'idea' ? '**Idea**' : '**Note**';
      lines.push(icon + ' ' + item.title + ' — *' + item.status + '* `' + item.id.substring(0, 8) + '`');
    }

    const text = lines.join('\n');
    const chunks = splitMessage(text, 2000);
    await message.reply(chunks[0]);
    for (let i = 1; i < chunks.length; i++) await message.channel.send(chunks[i]);
  } catch (err) {
    console.error('[OPAI] Hub search error:', err.message);
    return message.reply('`Hub API error: ' + err.message + '`');
  }
}

// ──────────────────────────────────────────────────────────
// Workspace AI — Claude CLI with Team Hub MCP tools
// ──────────────────────────────────────────────────────────

// Track temp MCP config files for cleanup
const mcpTempFiles = new Set();

function generateMcpConfig(workspaceIds) {
  // workspaceIds can be a single ID string or an array of IDs
  const ids = Array.isArray(workspaceIds) ? workspaceIds : [workspaceIds];
  const args = [path.join(__dirname, 'teamhub-mcp.js')];
  for (const id of ids) {
    args.push('--workspace', id);
  }
  const config = {
    mcpServers: {
      teamhub: {
        command: 'node',
        args: args,
      },
    },
  };
  const tmpPath = path.join(os.tmpdir(), 'opai-mcp-' + ids[0].substring(0, 8) + '-' + Date.now() + '.json');
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf8');
  mcpTempFiles.add(tmpPath);
  return tmpPath;
}

function cleanupMcpConfig(tmpPath) {
  try { fs.unlinkSync(tmpPath); } catch {}
  mcpTempFiles.delete(tmpPath);
}

// Cleanup all temp files on exit
process.on('exit', () => {
  for (const f of mcpTempFiles) {
    try { fs.unlinkSync(f); } catch {}
  }
});

async function handleWorkspaceAI(message, content, workspace, guildId) {
  const statusMsg = await message.reply(persona.getAckMessage(guildId));
  const startTime = Date.now();

  const jobId = createJob(guildId, {
    channelId: message.channelId,
    statusMessageId: statusMsg.id,
    userId: message.author.id,
    query: content,
  });

  const progressInterval = setInterval(async () => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    let text = '**' + persona.getProcessingMessage(guildId, elapsed) + '** (' + formatElapsed(elapsed) + ')';
    if (elapsed > 300) text += '\n' + persona.getLongRunningNote(guildId);
    try { await statusMsg.edit(text); } catch {}
  }, 15000);

  // Collect all workspace IDs bound to this channel
  const wsIds = [workspace.workspace_id];
  const wsNames = [workspace.workspace_name];
  if (workspace.workspaces && workspace.workspaces.length > 0) {
    for (const ws of workspace.workspaces) {
      if (ws.workspace_id !== workspace.workspace_id) {
        wsIds.push(ws.workspace_id);
        wsNames.push(ws.workspace_name);
      }
    }
  }

  // Generate MCP config scoped to all bound workspaces
  const mcpConfigPath = generateMcpConfig(wsIds);

  // Build system prompt
  const admin = isAdminGuild(guildId);
  const wsList = wsNames.map(n => "'" + n + "'").join(', ');
  const defaultPrompt = "You are a Team Hub AI assistant with access to " + wsIds.length + " workspace(s): " + wsList + ". "
    + "You help manage tasks, spaces, folders, and lists. Use the teamhub tools to read and modify workspace data. "
    + "When multiple workspaces are available, use workspace_summary to understand each one, and ask the user which workspace they mean if unclear. "
    + "Be concise and helpful. Use Discord markdown for formatting.";
  let systemPrompt = workspace.bot_prompt || defaultPrompt;

  // Non-admin guilds: reinforce tool restrictions in the system prompt
  if (!admin) {
    systemPrompt += "\n\nIMPORTANT: You ONLY have access to Team Hub MCP tools (teamhub_*). "
      + "Do NOT attempt to use Bash, Read, Write, Edit, Glob, Grep, or any filesystem tools. "
      + "You cannot access the filesystem. Only use the teamhub tools to manage workspace data.";
  }

  // Fire-and-forget
  askClaudeWithMcp(content, message.author.username, guildId, message.channelId, mcpConfigPath, systemPrompt)
    .then(async (reply) => {
      clearInterval(progressInterval);
      cleanupMcpConfig(mcpConfigPath);
      completeJob(guildId, jobId);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      try { logAudit({ tier: 'execution', service: 'opai-discord-bot', event: 'claude-invocation', status: 'completed', summary: `Workspace AI replied (${elapsed}s)`, duration_ms: Date.now() - startTime, details: { guildId, channelId: message.channelId } }); } catch (_) {}

      if (reply && reply.trim()) {
        const trimmed = reply.trim();
        addBotMessage(guildId, message.channelId, trimmed.substring(0, 500));
        const chunks = splitMessage(trimmed, 2000);
        await statusMsg.edit(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await message.channel.send(chunks[i]);
        }
        logGuild(guildId, 'INFO', 'Workspace AI replied (' + trimmed.length + ' chars, ' + elapsed + 's, ws: ' + workspace.workspace_name + ')');
        console.log('[OPAI] [' + guildId + '] Workspace AI replied (' + trimmed.length + ' chars, ' + elapsed + 's, ws: ' + workspace.workspace_name + ')');
      } else {
        await statusMsg.edit(persona.getNoResponse(guildId));
      }
    })
    .catch(async (err) => {
      clearInterval(progressInterval);
      cleanupMcpConfig(mcpConfigPath);
      failJob(guildId, jobId, err.message);
      console.error('[OPAI] [' + guildId + '] Workspace AI error:', err.message);
      logGuild(guildId, 'ERROR', 'Workspace AI: ' + err.message);
      await statusMsg.edit(persona.getErrorMessage(guildId, err.message)).catch(() => {});
    });
}

function askClaudeWithMcp(userMessage, username, guildId, channelId, mcpConfigPath, systemPrompt) {
  return new Promise((resolve, reject) => {
    const conversationContext = getContextBlock(guildId, channelId);
    const admin = isAdminGuild(guildId);

    const claudeArgs = getClaudeArgs(guildId, channelId, {
      mcpConfigPath,
      systemPrompt,
      restrictTools: !admin,
    });

    const prompt = [
      'User "' + username + '" says: ' + userMessage,
      '',
      ...(conversationContext ? [conversationContext, ''] : []),
    ].join('\n');

    const tmpFile = path.join(os.tmpdir(), 'opai-wsai-' + Date.now() + '.txt');
    fs.writeFileSync(tmpFile, prompt, 'utf8');

    let stdout = '';
    let stderr = '';

    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

    // Non-admin guilds run in a sandbox directory (no OPAI filesystem access)
    let cwd = OPAI_ROOT;
    if (!admin) {
      cwd = path.join(os.tmpdir(), 'opai-guild-' + guildId);
      if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true });
    }

    const proc = spawn(CLAUDE_BIN, claudeArgs, {
      cwd: cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnv,
    });

    const input = fs.createReadStream(tmpFile);
    input.pipe(proc.stdin);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      cleanup();
      resolve(stdout || persona.getTimeoutMessage(guildId));
    }, CLAUDE_TIMEOUT);

    function cleanup() {
      clearTimeout(timer);
      try { fs.unlinkSync(tmpFile); } catch {}
    }

    proc.on('close', (code) => {
      cleanup();
      if (code !== 0) {
        console.error('[OPAI] [' + guildId + '] Claude (MCP) exit ' + code + ' | stderr: ' + stderr.substring(0, 300));
      }
      const parsed = parseResponse(stdout);
      if (parsed.sessionId) {
        updateSession(guildId, channelId, parsed.sessionId);
      }
      resolve(parsed.text || stdout || stderr || '');
    });

    proc.on('error', (err) => {
      cleanup();
      reject(err);
    });
  });
}

// ──────────────────────────────────────────────────────────
// YouTube URL Handler
// ──────────────────────────────────────────────────────────

// Cache video data for reaction handling: messageId -> video info
const youtubeCache = new Map();
const YT_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

async function handleYouTubeUrl(message, url, userQuestion, guildId) {
  const statusMsg = await message.reply('`Analyzing video...`');
  const startTime = Date.now();

  try {
    // If user typed a question alongside the URL, process differently
    const doSummarize = !userQuestion;
    const result = await processYouTubeUrl(url, { summarize: doSummarize });

    if (result.error && !result.title) {
      return statusMsg.edit('`' + result.error + '`');
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const admin = isAdminGuild(guildId);

    if (userQuestion) {
      // User asked a specific question about the video — route to Claude
      const transcript = result.transcript || '';
      const truncated = transcript.length > 60000 ? transcript.substring(0, 60000) + '...' : transcript;
      const prompt = [
        'The user shared a YouTube video and asked a question about it.',
        '',
        'Video: "' + (result.title || 'Unknown') + '" by ' + (result.author || 'Unknown'),
        '',
        'Transcript:',
        truncated,
        '',
        'User question: ' + userQuestion,
        '',
        'Answer the question based on the video content. Be concise and Discord-friendly.',
      ].join('\n');

      const reply = await askClaude(prompt, message.author.username, guildId, message.channelId);
      const text = reply && reply.trim() ? reply.trim() : 'Could not analyze the video.';

      const header = '**' + (result.title || 'Video') + '** by *' + (result.author || 'Unknown') + '*\n\n';
      const full = header + text;
      const chunks = splitMessage(full, 2000);
      await statusMsg.edit(chunks[0]);
      for (let i = 1; i < chunks.length; i++) {
        await message.channel.send(chunks[i]);
      }
    } else {
      // Standard summary
      const summary = formatDiscordSummary(result);
      const chunks = splitMessage(summary, 2000);
      await statusMsg.edit(chunks[0]);
      for (let i = 1; i < chunks.length; i++) {
        await message.channel.send(chunks[i]);
      }
    }

    // Cache video data and add reaction menu
    youtubeCache.set(statusMsg.id, {
      ...result,
      guildId,
      timestamp: Date.now(),
    });

    // Cleanup old cache entries
    for (const [key, val] of youtubeCache) {
      if (Date.now() - val.timestamp > YT_CACHE_TTL) youtubeCache.delete(key);
    }

    // Add reaction menu
    try {
      await statusMsg.react('\uD83D\uDCDD'); // memo - Save to Brain
      await statusMsg.react('\uD83D\uDD2C'); // microscope - Research
      await statusMsg.react('\u270D\uFE0F');  // writing hand - Re-Write
      if (admin) {
        await statusMsg.react('\uD83D\uDCA1'); // bulb - PRD Pipeline
      }
    } catch {}

    console.log('[OPAI] [' + guildId + '] YouTube processed: ' + (result.title || url) + ' (' + elapsed + 's)');
    try { logAudit({ tier: 'execution', service: 'opai-discord-bot', event: 'youtube-processed', status: 'completed', summary: 'YouTube: ' + (result.title || url), duration_ms: Date.now() - startTime, details: { guildId, videoId: result.video_id, url } }); } catch (_) {}

  } catch (err) {
    console.error('[OPAI] [' + guildId + '] YouTube error:', err.message);
    await statusMsg.edit('`Error analyzing video: ' + err.message + '`').catch(() => {});
  }
}

// ── YouTube Reaction Handler ──

// Reaction action definitions
const REACTION_ACTIONS = {
  '\uD83D\uDCDD': {
    label: 'Save to Brain',
    description: 'Save this video transcript and summary as a Brain node for future reference.',
    endpoint: 'http://127.0.0.1:8101/brain/api/youtube/save',
    adminOnly: false,
    buildBody: (cached) => ({
      url: cached.url, title: cached.title, author: cached.author,
      transcript: (cached.transcript || '').substring(0, 100000),
      summary_data: cached.summary_data || null,
    }),
    onSuccess: (data, cached) => '**Saved to Brain** — node `' + data.id.substring(0, 8) + '`: ' + (cached.title || 'Video'),
    onFailure: (detail) => '`Failed to save to Brain: ' + (detail || 'unknown error') + '`',
  },
  '\uD83D\uDD2C': {
    label: 'Research',
    description: 'Start a deep-dive research session using this video as source material.',
    endpoint: 'http://127.0.0.1:8101/brain/api/youtube/research',
    adminOnly: false,
    buildBody: (cached) => ({
      url: cached.url, title: cached.title,
      transcript: (cached.transcript || '').substring(0, 100000),
    }),
    onSuccess: (data, cached) => '**Research session started** for "' + (cached.title || 'Video') + '" — session `' + data.id.substring(0, 8) + '`',
    onFailure: (detail) => '`Failed to start research: ' + (detail || 'unknown error') + '`',
  },
  '\u270D\uFE0F': {
    label: 'Re-Write',
    description: 'Generate original content (video script, blog post & social posts) from this video.',
    endpoint: 'http://127.0.0.1:8101/brain/api/youtube/rewrite',
    adminOnly: false,
    buildBody: (cached) => ({
      url: cached.url, title: cached.title, author: cached.author,
      transcript: (cached.transcript || '').substring(0, 100000),
      summary_data: cached.summary_data || null,
    }),
    onSuccess: (data, cached) => '**Re-Write started** for "' + (cached.title || 'Video') + '" — generating video script, blog post & social posts. Session `' + data.id.substring(0, 8) + '`',
    onFailure: (detail) => '`Failed to start re-write: ' + (detail || 'unknown error') + '`',
  },
  '\u270D': {  // variant without variation selector
    aliasOf: '\u270D\uFE0F',
  },
  '\uD83D\uDCA1': {
    label: 'PRD Idea',
    description: 'Create a new PRD idea from this video for the product pipeline.',
    endpoint: 'http://127.0.0.1:8093/prd/api/ideas/from-youtube',
    adminOnly: true,
    buildBody: (cached) => ({
      url: cached.url, title: cached.title, author: cached.author,
      transcript: (cached.transcript || '').substring(0, 50000),
      summary_data: cached.summary_data || null,
    }),
    onSuccess: (data, cached) => '**PRD idea created** from "' + (cached.title || 'Video') + '" — idea `' + data.id.substring(0, 8) + '`',
    onFailure: (detail) => '`Failed to create PRD idea: ' + (detail || 'unknown error') + '`',
  },
};

// Safe fetch helper — returns { ok, data, error } instead of throwing
async function safeFetch(url, options) {
  try {
    const resp = await fetch(url, options);
    if (!resp.ok) {
      let detail = 'HTTP ' + resp.status;
      try { const body = await resp.json(); detail = body.detail || detail; } catch {}
      return { ok: false, data: null, error: detail };
    }
    const data = await resp.json();
    return { ok: true, data, error: null };
  } catch (err) {
    // Network errors (ECONNREFUSED, DNS failure, timeout)
    const msg = err.cause ? (err.cause.code || err.cause.message || err.message) : err.message;
    return { ok: false, data: null, error: msg };
  }
}

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;

  // Fetch partial reactions
  if (reaction.partial) {
    try { await reaction.fetch(); } catch { return; }
  }

  const cached = youtubeCache.get(reaction.message.id);
  if (!cached) return;

  let emoji = reaction.emoji.name;
  const guildId = cached.guildId;
  const admin = isAdminGuild(guildId);
  const channel = reaction.message.channel;

  // Resolve alias (writing hand variant)
  let action = REACTION_ACTIONS[emoji];
  if (action && action.aliasOf) action = REACTION_ACTIONS[action.aliasOf];
  if (!action) return;

  // Admin-only check
  if (action.adminOnly && !admin) return;

  try {
    // ── Confirmation Gateway ──
    const confirmMsg = await channel.send(
      '**' + action.label + '** — ' + action.description +
      '\n\nReact \u2705 to confirm or \u274C to cancel. *(15s timeout)*'
    );
    await confirmMsg.react('\u2705');
    await confirmMsg.react('\u274C');

    const filter = (r, u) => u.id === user.id && (r.emoji.name === '\u2705' || r.emoji.name === '\u274C');
    let collected;
    try {
      collected = await confirmMsg.awaitReactions({ filter, max: 1, time: 15000, errors: ['time'] });
    } catch {
      // Timeout — no response
      await confirmMsg.edit('`' + action.label + ' cancelled (timed out).`').catch(() => {});
      try { await confirmMsg.reactions.removeAll(); } catch {}
      return;
    }

    const confirmed = collected.first() && collected.first().emoji.name === '\u2705';
    try { await confirmMsg.reactions.removeAll(); } catch {}

    if (!confirmed) {
      await confirmMsg.edit('`' + action.label + ' cancelled.`').catch(() => {});
      return;
    }

    // ── Execute the action ──
    await confirmMsg.edit('`Processing ' + action.label + '...`');

    const body = action.buildBody(cached);
    const result = await safeFetch(action.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!result.ok) {
      const errMsg = result.error === 'ECONNREFUSED'
        ? 'Service is offline. Start it with `opai-control.sh start`.'
        : result.error;
      await confirmMsg.edit('`' + action.label + ' failed: ' + errMsg + '`');
      return;
    }

    if (result.data && result.data.id) {
      await confirmMsg.edit(action.onSuccess(result.data, cached));
    } else {
      await confirmMsg.edit(action.onFailure(result.data ? result.data.detail : 'no id in response'));
    }
  } catch (err) {
    console.error('[OPAI] YouTube reaction error:', err.message);
    await channel.send('`Error handling reaction: ' + err.message + '`').catch(() => {});
  }
});

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

function formatElapsed(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

function splitMessage(text, maxLength) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt < maxLength / 2) splitAt = maxLength;
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }
  return chunks;
}

// --- Graceful shutdown ---
process.on('SIGINT', () => {
  console.log('\n[OPAI] Shutting down...');
  client.destroy();
  process.exit(0);
});

client.login(BOT_TOKEN);
