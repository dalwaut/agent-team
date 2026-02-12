#!/usr/bin/env node
/**
 * OPAI Discord Bridge v3
 *
 * Local Discord bot → Claude Code CLI (Pro Max, zero API cost).
 *
 * v3 adds:
 *   - Persistent logging (data/bot.log)
 *   - Session reuse (30-min window via --resume)
 *   - "review logs" command with approve/edit/restart flow
 *   - Post-restart "Update Complete" notification
 *
 * v3.1 adds:
 *   - Async response queue (non-blocking message handling)
 *   - Job tracking with status command (`!@ status`)
 *   - 15-min timeout ceiling (up from 5 min)
 *   - Restart recovery for interrupted jobs
 *   - Persona system with swappable personalities (`!@ persona`)
 *   - Rotating processing messages while Claude works
 *
 * Usage:
 *   npm start       — run the bridge
 *   npm run dev     — run with auto-restart on file changes
 */

require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { addUserMessage, addBotMessage, getContextBlock } = require('./conversation-memory');
const { initLogger, getRecentLogs } = require('./logger');
const { getClaudeArgs, parseResponse, updateSession, clearSession } = require('./session-manager');
const { createJob, completeJob, failJob, getActiveJobs, recoverJobs } = require('./job-manager');
const persona = require('./persona');
const { processTask } = require('../work-companion');
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
const NOTIFICATION_FILE = path.join(__dirname, 'data', 'pending-notification.json');

if (!BOT_TOKEN) {
  console.error('[FATAL] DISCORD_BOT_TOKEN not set in .env');
  process.exit(1);
}

// --- Review flow state machine ---
// channelId → { state: 'proposed'|'applying', fixes: [], summary: '', userId: '' }
const reviewStates = new Map();

// --- Discord Client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`[OPAI] Connected as ${c.user.tag}`);
  console.log(`[OPAI] Channel: ${CHANNEL_ID || 'ALL'}`);
  console.log(`[OPAI] Prefix: "${PREFIX || '(none)'}"`);
  console.log(`[OPAI] OPAI root: ${OPAI_ROOT}`);
  console.log(`[OPAI] Max timeout: ${CLAUDE_TIMEOUT / 1000}s`);

  // Send any pending notification from a previous restart
  await sendPendingNotification();

  // Recover interrupted jobs from previous session
  const interrupted = recoverJobs();
  for (const job of interrupted) {
    try {
      const channel = await client.channels.fetch(job.channelId);
      if (channel) {
        const elapsed = Math.round((job.endTime - job.startTime) / 1000);
        await channel.send(
          `**${persona.getInterruptedMessage()}:** "${job.query}" (was running for ${formatElapsed(elapsed)})\nPlease resend your request.`
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

  let content = message.content;
  if (PREFIX) {
    if (!content.startsWith(PREFIX)) return;
    content = content.slice(PREFIX.length).trim();
  }
  if (!content) return;

  console.log(`[OPAI] ${message.author.username}: "${content}"`);
  addUserMessage(message.channelId, message.author.username, content);

  const lower = content.toLowerCase().trim();

  // ── Check if we're inside a review flow ──
  const review = reviewStates.get(message.channelId);
  if (review && review.state === 'proposed') {
    if (['approve', 'approved', 'yes', 'apply', 'lgtm'].includes(lower)) {
      return handleReviewApproval(message, review);
    }
    if (['cancel', 'nevermind', 'abort', 'no'].includes(lower)) {
      reviewStates.delete(message.channelId);
      clearSession(message.channelId);
      return message.reply('Review cancelled.');
    }
    // Anything else = edit feedback
    return handleReviewEdits(message, content, review);
  }

  // ── Command: review logs ──
  if (lower.match(/^review\s*(the\s*)?logs?/)) {
    return handleReviewLogs(message);
  }

  // ── Command: task routing ──
  if (lower.startsWith('task:') || lower.startsWith('task ')) {
    const taskDesc = content.replace(/^task[:\s]+/i, '').trim();
    if (taskDesc) return handleTaskCommand(message, taskDesc);
  }

  // ── Command: check email ──
  if (lower.match(/^check\s*(my\s*)?(e-?mail|inbox)/)) {
    return handleCheckEmail(message);
  }

  // ── Command: email tasks ──
  if (lower.match(/^e-?mail\s+tasks?/)) {
    return handleEmailTasks(message);
  }

  // ── Command: email drafts ──
  if (lower.match(/^e-?mail\s+drafts?/)) {
    return handleEmailDrafts(message);
  }

  // ── Command: approve <id> ──
  if (lower.startsWith('approve ')) {
    const id = content.split(/\s+/)[1];
    if (id) return handleEmailApprove(message, id);
  }

  // ── Command: reject <id> ──
  if (lower.startsWith('reject ')) {
    const id = content.split(/\s+/)[1];
    if (id) return handleEmailReject(message, id);
  }

  // ── Command: persona ──
  if (lower.startsWith('persona')) {
    return handlePersonaCommand(message, content);
  }

  // ── Command: status / jobs ──
  if (lower === 'status' || lower === 'jobs') {
    return handleStatusCommand(message);
  }

  // ── Default: normal conversation ──
  return handleNormalMessage(message, content);
});

// ──────────────────────────────────────────────────────────
// Normal Message Handler
// ──────────────────────────────────────────────────────────

async function handleNormalMessage(message, content) {
  // Immediate acknowledgment — bot returns to event loop right away
  const statusMsg = await message.reply(persona.getAckMessage());
  const startTime = Date.now();

  // Track the job for status reporting and restart recovery
  const jobId = createJob({
    channelId: message.channelId,
    statusMessageId: statusMsg.id,
    userId: message.author.id,
    query: content,
  });

  // Progress updates every 15s with persona-driven rotating messages
  const progressInterval = setInterval(async () => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    let text = `**${persona.getProcessingMessage(elapsed)}** (${formatElapsed(elapsed)})`;
    if (elapsed > 300) text += `\n${persona.getLongRunningNote()}`;
    try { await statusMsg.edit(text); } catch {}
  }, 15000);

  // Fire-and-forget — bot remains responsive to other messages
  askClaude(content, message.author.username, message.channelId)
    .then(async (reply) => {
      clearInterval(progressInterval);
      completeJob(jobId);
      const elapsed = Math.round((Date.now() - startTime) / 1000);

      if (reply && reply.trim()) {
        const trimmed = reply.trim();
        addBotMessage(message.channelId, trimmed.substring(0, 500));
        const chunks = splitMessage(trimmed, 2000);
        await statusMsg.edit(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await message.channel.send(chunks[i]);
        }
        console.log(`[OPAI] Replied (${trimmed.length} chars, ${elapsed}s)`);
      } else {
        await statusMsg.edit(persona.getNoResponse());
      }
    })
    .catch(async (err) => {
      clearInterval(progressInterval);
      failJob(jobId, err.message);
      console.error('[OPAI] Error:', err.message);
      await statusMsg.edit(persona.getErrorMessage(err.message)).catch(() => {});
    });

  // Returns immediately — does NOT await Claude
}

// ──────────────────────────────────────────────────────────
// Status Command — Show active jobs
// ──────────────────────────────────────────────────────────

async function handleStatusCommand(message) {
  const active = getActiveJobs();
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
// Persona Command — Switch or view active persona
// ──────────────────────────────────────────────────────────

async function handlePersonaCommand(message, content) {
  const parts = content.trim().split(/\s+/);
  const target = parts[1]?.toLowerCase();

  if (!target) {
    const current = persona.getActivePersonaName();
    const available = persona.listPersonas();
    return message.reply(
      `**Active persona:** ${current}\n**Available:** ${available.join(', ')}\n\nSwitch with: \`${PREFIX}persona <name>\``
    );
  }

  if (persona.setPersona(target)) {
    return message.reply(`Persona switched to **${target}**.`);
  } else {
    const available = persona.listPersonas();
    return message.reply(`Unknown persona "${target}". Available: ${available.join(', ')}`);
  }
}

// ──────────────────────────────────────────────────────────
// Task Command — Classify and route via Work Companion
// ──────────────────────────────────────────────────────────

async function handleTaskCommand(message, taskDescription) {
  try {
    const result = processTask(taskDescription, { queue: true, source: 'discord' });
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

async function handleReviewLogs(message) {
  const statusMsg = await message.reply('`Analyzing bot logs...`');
  const startTime = Date.now();
  const progressInterval = setInterval(async () => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    try { await statusMsg.edit(`\`Reviewing logs... (${elapsed}s)\``); } catch {}
  }, 15000);

  try {
    const logs = getRecentLogs(150);

    // Fresh session for review analysis
    clearSession(message.channelId);

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

    const reply = await askClaude(prompt, message.author.username, message.channelId);
    clearInterval(progressInterval);

    if (!reply || !reply.trim()) {
      return statusMsg.edit('`No response from log analysis.`');
    }

    const trimmed = reply.trim();
    addBotMessage(message.channelId, trimmed.substring(0, 500));

    const fixes = extractFixes(trimmed);
    const summary = extractSummary(trimmed);

    if (fixes.length > 0) {
      reviewStates.set(message.channelId, {
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

    console.log(`[OPAI] Review complete (${fixes.length} fixes, ${Math.round((Date.now() - startTime) / 1000)}s)`);
  } catch (err) {
    clearInterval(progressInterval);
    console.error('[OPAI] Review error:', err.message);
    await statusMsg.edit(`\`Error reviewing logs: ${err.message}\``).catch(() => {});
  }
}

// ──────────────────────────────────────────────────────────
// Review Approval — Apply fixes, write notification, restart
// ──────────────────────────────────────────────────────────

async function handleReviewApproval(message, review) {
  const statusMsg = await message.reply('`Applying fixes...`');

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

      reviewStates.delete(message.channelId);
      clearSession(message.channelId);
      await statusMsg.edit('`Fixes applied. Restarting bot in 3s...`');
      console.log(`[OPAI] Applied ${ok} fix(es). Restarting...`);

      setTimeout(() => process.exit(0), 3000); // Wrapper bat restarts us
    } else {
      const errDetails = results.map(r => `- ${r.file}: ${r.error}`).join('\n');
      await statusMsg.edit(`\`All fixes failed.\`\n${errDetails}`);
      reviewStates.delete(message.channelId);
    }
  } catch (err) {
    console.error('[OPAI] Apply error:', err.message);
    await statusMsg.edit(`\`Error applying fixes: ${err.message}\``).catch(() => {});
    reviewStates.delete(message.channelId);
  }
}

// ──────────────────────────────────────────────────────────
// Review Edits — User provides feedback, Claude revises
// ──────────────────────────────────────────────────────────

async function handleReviewEdits(message, feedback, review) {
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

    const reply = await askClaude(prompt, message.author.username, message.channelId);
    clearInterval(progressInterval);

    if (!reply || !reply.trim()) {
      return statusMsg.edit('`No response from revision.`');
    }

    const trimmed = reply.trim();
    addBotMessage(message.channelId, trimmed.substring(0, 500));

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
    console.error('[OPAI] Revision error:', err.message);
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
// Claude CLI Invocation (session-aware)
// ──────────────────────────────────────────────────────────

function askClaude(userMessage, username, channelId) {
  return new Promise((resolve, reject) => {
    const conversationContext = getContextBlock(channelId);
    const claudeArgs = getClaudeArgs(channelId);

    const prompt = [
      `You are OPAI Bot responding via Discord to user "${username}".`,
      `Keep responses concise and Discord-friendly (under 1500 chars when possible).`,
      `Use Discord markdown: **bold**, \`code\`, \`\`\`code blocks\`\`\`, - lists.`,
      `You have access to the OPAI workspace, n8n workflows (via MCP), and local files.`,
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

    const proc = spawn('claude', claudeArgs, {
      cwd: OPAI_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    const input = fs.createReadStream(tmpFile);
    input.pipe(proc.stdin);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      cleanup();
      console.error(`[OPAI] Timed out. stdout(${stdout.length}), stderr: ${stderr.substring(0, 300)}`);
      resolve(stdout || persona.getTimeoutMessage());
    }, CLAUDE_TIMEOUT);

    function cleanup() {
      clearTimeout(timer);
      try { fs.unlinkSync(tmpFile); } catch {}
    }

    proc.on('close', (code) => {
      cleanup();
      if (code !== 0) {
        console.error(`[OPAI] Claude exit ${code} | stderr: ${stderr.substring(0, 300)}`);
      }

      // Parse JSON output → extract text + session ID
      const parsed = parseResponse(stdout);
      if (parsed.sessionId) {
        updateSession(channelId, parsed.sessionId);
      }

      console.log(`[OPAI] Claude done (exit ${code}, ${(parsed.text || stdout).length} chars, session: ${parsed.sessionId ? 'reused' : 'new'})`);
      resolve(parsed.text || stdout || stderr || '');
    });

    proc.on('error', (err) => {
      cleanup();
      reject(err);
    });
  });
}

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
