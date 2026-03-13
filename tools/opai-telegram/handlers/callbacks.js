/**
 * Callback Handler — Inline keyboard button interactions.
 *
 * Handles confirmation gates, YouTube actions, email actions,
 * and multi-step Team Hub task creation flow.
 * Callback data format: "action:context:subaction" (max 64 bytes)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');
const { InlineKeyboard } = require('grammy');
const { hasPermission, getUserRole } = require('../access-control');
const { askClaude, askClaudeDangerous, OPAI_ROOT } = require('../claude-handler');
const { handleWpCallback } = require('../wordpress-fast');
const { logDangerousRun } = require('./utils');
const { engineGet, enginePost } = require('../engine-api');

// Pending confirmations: actionId -> { type, payload, requestedBy, chatId, threadId, expiresAt }
const pendingActions = new Map();

// Cache video info from the message handler so callbacks can access it
const videoCache = new Map();

// Cache reel info from the message handler so callbacks can access it
const reelCache = new Map();

// --- Dangerous Runs ---
// Key: actionId -> { instruction, conversationContext, scopeKey, requestedBy, chatId, threadId, username, expiresAt }
const pendingDangerRuns = new Map();
// Key: `${chatId}:${msgId}` -> { text, scopeKey, expiresAt }
const dangerResponseCache = new Map();

// --- Multi-step Task Creation ---
// Key: `${chatId}:${userId}` -> { step, title, priority, due_date, description, messageId, expiresAt }
const pendingTasks = new Map();

function taskKey(chatId, userId) {
  return `${chatId}:${userId}`;
}

// Auto-expire pending actions after 5 minutes, video cache after 1 hour, pending tasks after 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, action] of pendingActions) {
    if (action.expiresAt < now) pendingActions.delete(id);
  }
  for (const [id, entry] of videoCache) {
    if (entry.expiresAt < now) videoCache.delete(id);
  }
  for (const [id, entry] of reelCache) {
    if (entry.expiresAt < now) reelCache.delete(id);
  }
  for (const [id, entry] of pendingTasks) {
    if (entry.expiresAt < now) pendingTasks.delete(id);
  }
  for (const [id, entry] of pendingDangerRuns) {
    if (entry.expiresAt < now) pendingDangerRuns.delete(id);
  }
  for (const [id, entry] of dangerResponseCache) {
    if (entry.expiresAt < now) dangerResponseCache.delete(id);
  }
}, 60000);

/**
 * Store video info for callback access.
 */
function cacheVideo(videoId, data) {
  videoCache.set(videoId, {
    ...data,
    expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour
  });
}

/**
 * Store reel info for callback access.
 */
function cacheReel(shortcode, data) {
  reelCache.set(shortcode, {
    ...data,
    expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour
  });
}

/**
 * Create a confirmation keyboard for an action.
 */
function confirmKeyboard(actionId, confirmText = 'Yes, proceed', cancelText = 'Cancel') {
  return new InlineKeyboard()
    .text(confirmText, `confirm:${actionId}`)
    .text(cancelText, `cancel:${actionId}`);
}

/**
 * Queue an action for confirmation.
 */
function queueAction(actionId, opts) {
  pendingActions.set(actionId, {
    ...opts,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
}

/**
 * Save a YouTube video to notes as a markdown file.
 */
function saveVideoToNotes(videoId, data) {
  const notesDir = path.join(OPAI_ROOT, 'notes', 'YouTube');
  if (!fs.existsSync(notesDir)) fs.mkdirSync(notesDir, { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  const safeTitle = (data.title || videoId).replace(/[^a-zA-Z0-9 _-]/g, '').substring(0, 80).trim();
  const filename = `${date} — ${safeTitle}.md`;
  const filepath = path.join(notesDir, filename);

  const lines = [
    `# ${data.title || 'YouTube Video'}`,
    '',
    `- **Video ID**: ${videoId}`,
    `- **URL**: https://youtube.com/watch?v=${videoId}`,
    `- **Saved**: ${new Date().toISOString()}`,
    `- **Source**: Telegram Bot`,
  ];

  if (data.summary) {
    lines.push('', '## Summary', '', data.summary);
  }

  if (data.transcript) {
    lines.push('', '## Transcript', '', data.transcript);
  }

  lines.push('');
  fs.writeFileSync(filepath, lines.join('\n'), 'utf8');
  return { filepath, filename };
}

/**
 * Register callback query handlers on the bot.
 * @param {import('grammy').Bot} bot
 */
function registerCallbacks(bot) {

  // Confirm action
  bot.callbackQuery(/^confirm:(.+)$/, async (ctx) => {
    const actionId = ctx.match[1];
    const action = pendingActions.get(actionId);

    if (!action) {
      await ctx.answerCallbackQuery({ text: 'This action has expired.', show_alert: true });
      return;
    }

    if (ctx.from.id !== action.requestedBy && !hasPermission(ctx.from.id, 'approve')) {
      await ctx.answerCallbackQuery({ text: 'Only the requester or an admin can confirm this.', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery({ text: 'Confirmed!' });
    pendingActions.delete(actionId);

    await ctx.editMessageText(
      `Confirmed by ${ctx.from.first_name}. Executing...`,
      { reply_markup: undefined }
    );

    try {
      await executeAction(ctx, action);
    } catch (err) {
      await ctx.editMessageText(`Error executing action: ${err.message}`);
    }
  });

  // Cancel action
  bot.callbackQuery(/^cancel:(.+)$/, async (ctx) => {
    const actionId = ctx.match[1];
    pendingActions.delete(actionId);
    await ctx.answerCallbackQuery({ text: 'Cancelled.' });
    await ctx.editMessageText('Action cancelled.', { reply_markup: undefined });
  });

  // YouTube action buttons
  bot.callbackQuery(/^yt:(\w+):(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    const videoId = ctx.match[2];
    await ctx.answerCallbackQuery();

    // Get cached video data or create minimal entry
    const cached = videoCache.get(videoId) || { title: 'YouTube Video', videoId };
    const originalText = ctx.callbackQuery.message?.text || '';

    switch (action) {
      case 'save': {
        // Save to notes/YouTube/
        try {
          // Extract summary from the original message text
          const summaryText = originalText.split('\n').slice(2).join('\n').trim();
          const saveData = {
            title: cached.title || originalText.split('\n')[0]?.replace(/^\*|\*$/g, '') || 'YouTube Video',
            summary: summaryText || cached.summary || null,
            transcript: cached.transcript || null,
          };

          const { filename } = saveVideoToNotes(videoId, saveData);

          await ctx.editMessageText(
            `${originalText}\n\n---\nSaved to \`notes/YouTube/${filename}\``,
            { reply_markup: undefined, parse_mode: 'Markdown' }
          );
        } catch (err) {
          await ctx.editMessageText(
            `${originalText}\n\nFailed to save: ${err.message}`,
            { reply_markup: undefined }
          );
        }
        break;
      }

      case 'research': {
        await ctx.editMessageText(`Researching video... Claude is analyzing.`, { reply_markup: undefined });
        try {
          const result = await askClaude({
            prompt: `Research this YouTube video in depth: https://youtube.com/watch?v=${videoId}\n\nTitle: ${cached.title || 'unknown'}\n\n${cached.summary ? 'Summary: ' + cached.summary : ''}\n\nProvide key insights, actionable takeaways, and how this relates to our OPAI platform work.`,
            scopeKey: `yt-research-${videoId}`,
          });
          const response = (result.text || 'No analysis available.').substring(0, 3800);
          await ctx.editMessageText(`*Research: ${cached.title || videoId}*\n\n${response}`, {
            parse_mode: 'Markdown',
            reply_markup: undefined,
          });
        } catch (err) {
          await ctx.editMessageText(`Research failed: ${err.message}`, { reply_markup: undefined });
        }
        break;
      }

      case 'rewrite': {
        await ctx.editMessageText(`Rewriting video content...`, { reply_markup: undefined });
        try {
          const result = await askClaude({
            prompt: `Rewrite the content from this YouTube video as a clean, well-structured article or document:\n\nTitle: ${cached.title || 'unknown'}\nURL: https://youtube.com/watch?v=${videoId}\n${cached.summary ? '\nSummary:\n' + cached.summary : ''}\n\nRewrite as a clear, professional document.`,
            scopeKey: `yt-rewrite-${videoId}`,
          });
          const response = (result.text || 'No rewrite available.').substring(0, 3800);
          await ctx.editMessageText(response, { parse_mode: 'Markdown', reply_markup: undefined });
        } catch (err) {
          await ctx.editMessageText(`Rewrite failed: ${err.message}`, { reply_markup: undefined });
        }
        break;
      }

      case 'prd': {
        await ctx.editMessageText(`Extracting PRD idea from video...`, { reply_markup: undefined });
        try {
          const result = await askClaude({
            prompt: `Extract a product/feature idea from this YouTube video and write it as a brief PRD (Product Requirements Document) outline:\n\nTitle: ${cached.title || 'unknown'}\nURL: https://youtube.com/watch?v=${videoId}\n${cached.summary ? '\nSummary:\n' + cached.summary : ''}\n\nFormat: Problem, Solution, Key Features, Target Users, Success Metrics.`,
            scopeKey: `yt-prd-${videoId}`,
          });
          const response = (result.text || 'No PRD generated.').substring(0, 3800);
          await ctx.editMessageText(`*PRD from: ${cached.title || videoId}*\n\n${response}`, {
            parse_mode: 'Markdown',
            reply_markup: undefined,
          });
        } catch (err) {
          await ctx.editMessageText(`PRD extraction failed: ${err.message}`, { reply_markup: undefined });
        }
        break;
      }

      default:
        await ctx.editMessageText(`Unknown action: ${action}`, { reply_markup: undefined });
    }
  });

  // --- Instagram Reel Actions ---

  bot.callbackQuery(/^ig:(\w+):(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    const shortcode = ctx.match[2];
    await ctx.answerCallbackQuery();

    const cached = reelCache.get(shortcode) || { shortcode, url: `https://www.instagram.com/reel/${shortcode}/` };
    const reelUrl = cached.url || `https://www.instagram.com/reel/${shortcode}/`;
    const originalText = ctx.callbackQuery.message?.text || '';

    switch (action) {
      case 'build': {
        // Heavy: download + frames + Vision analysis
        await ctx.editMessageText(`*Extracting build guide...* This downloads the video and analyzes frames — may take a minute.`, {
          parse_mode: 'Markdown', reply_markup: undefined,
        });
        try {
          const igPath = path.join(__dirname, '..', '..', 'shared', 'instagram.js');
          const { processInstagramUrl } = require(igPath);
          const result = await processInstagramUrl(reelUrl, { mode: 'build', frames: true });
          const analysis = result?.analysis || {};

          let response;
          if (analysis.error) {
            response = `Build analysis error: ${analysis.error}`;
          } else if (analysis.raw_analysis) {
            response = analysis.raw_analysis.substring(0, 3800);
          } else {
            const parts = [];
            if (analysis.title) parts.push(`*${analysis.title}*`);
            if (analysis.difficulty) parts.push(`Difficulty: ${analysis.difficulty}`);
            if (analysis.estimated_time) parts.push(`Time: ${analysis.estimated_time}`);
            if (analysis.materials?.length) parts.push(`\n*Materials:*\n${analysis.materials.map(m => `- ${m}`).join('\n')}`);
            if (analysis.tools?.length) parts.push(`\n*Tools:*\n${analysis.tools.map(t => `- ${t}`).join('\n')}`);
            if (analysis.steps?.length) {
              parts.push(`\n*Steps:*`);
              for (const s of analysis.steps) {
                parts.push(`${s.step}. ${s.description}`);
              }
            }
            if (analysis.safety_notes?.length) parts.push(`\n*Safety:*\n${analysis.safety_notes.map(n => `- ${n}`).join('\n')}`);
            response = parts.join('\n').substring(0, 3800) || 'No build guide generated.';
          }

          await ctx.editMessageText(response, { parse_mode: 'Markdown', reply_markup: undefined });
        } catch (err) {
          await ctx.editMessageText(`Build guide failed: ${err.message}`, { reply_markup: undefined });
        }
        break;
      }

      case 'intel': {
        // Light: transcript + metadata + text analysis
        await ctx.editMessageText(`*Analyzing reel for content strategy...*`, {
          parse_mode: 'Markdown', reply_markup: undefined,
        });
        try {
          const igPath = path.join(__dirname, '..', '..', 'shared', 'instagram.js');
          const { processInstagramUrl } = require(igPath);
          const result = await processInstagramUrl(reelUrl, { mode: 'intel', frames: false });
          const analysis = result?.analysis || {};

          let response;
          if (analysis.error) {
            response = `Intel analysis error: ${analysis.error}`;
          } else if (analysis.raw_analysis) {
            response = analysis.raw_analysis.substring(0, 3800);
          } else {
            const parts = [];
            if (analysis.hook_analysis) parts.push(`*Hook:* ${analysis.hook_analysis}`);
            if (analysis.content_structure) parts.push(`\n*Structure:* ${analysis.content_structure}`);
            if (analysis.content_format) parts.push(`*Format:* ${analysis.content_format}`);
            if (analysis.target_audience) parts.push(`*Audience:* ${analysis.target_audience}`);
            if (analysis.engagement_ratio) parts.push(`*Engagement:* ${analysis.engagement_ratio}`);
            if (analysis.estimated_production_effort) parts.push(`*Effort:* ${analysis.estimated_production_effort}`);
            if (analysis.virality_factors?.length) parts.push(`\n*Virality Factors:*\n${analysis.virality_factors.map(f => `- ${f}`).join('\n')}`);
            if (analysis.replication_tips?.length) parts.push(`\n*Replication Tips:*\n${analysis.replication_tips.map(t => `- ${t}`).join('\n')}`);
            response = parts.join('\n').substring(0, 3800) || 'No intel report generated.';
          }

          await ctx.editMessageText(response, { parse_mode: 'Markdown', reply_markup: undefined });
        } catch (err) {
          await ctx.editMessageText(`Intel report failed: ${err.message}`, { reply_markup: undefined });
        }
        break;
      }

      case 'save': {
        // Save to Brain via Brain API
        await ctx.editMessageText(`Saving reel to Brain...`, { reply_markup: undefined });
        try {
          const payload = {
            url: reelUrl,
            caption: cached.caption || null,
            author: cached.author || null,
            transcript: cached.transcript || null,
          };

          const saveResult = await enginePost('/brain/api/instagram/save', payload);
          const nodeId = saveResult?.id || '?';
          await ctx.editMessageText(
            `${originalText}\n\n---\nSaved to Brain (node: \`${String(nodeId).substring(0, 8)}\`)`,
            { reply_markup: undefined, parse_mode: 'Markdown' }
          );
        } catch (err) {
          // Fallback: save as notes file
          try {
            const notesDir = path.join(OPAI_ROOT, 'notes', 'Instagram');
            if (!fs.existsSync(notesDir)) fs.mkdirSync(notesDir, { recursive: true });
            const date = new Date().toISOString().split('T')[0];
            const filename = `${date} — reel-${shortcode}.md`;
            const content = [
              `# Instagram Reel: ${shortcode}`,
              '', `- **URL**: ${reelUrl}`,
              `- **Saved**: ${new Date().toISOString()}`,
              cached.author ? `- **Author**: ${cached.author}` : '',
              '', cached.caption ? `## Caption\n\n${cached.caption}` : '',
              '', cached.transcript ? `## Transcript\n\n${cached.transcript}` : '',
            ].filter(Boolean).join('\n');
            fs.writeFileSync(path.join(notesDir, filename), content, 'utf8');
            await ctx.editMessageText(
              `${originalText}\n\n---\nSaved to \`notes/Instagram/${filename}\``,
              { reply_markup: undefined, parse_mode: 'Markdown' }
            );
          } catch (saveErr) {
            await ctx.editMessageText(`Save failed: ${err.message}`, { reply_markup: undefined });
          }
        }
        break;
      }

      case 'research': {
        await ctx.editMessageText(`Researching reel... Claude is analyzing.`, { reply_markup: undefined });
        try {
          const context = [
            cached.author ? `Author: ${cached.author}` : '',
            cached.caption ? `Caption: ${cached.caption.substring(0, 500)}` : '',
            cached.transcript ? `Transcript: ${cached.transcript.substring(0, 2000)}` : '',
          ].filter(Boolean).join('\n');

          const result = await askClaude({
            prompt: `Research this Instagram reel in depth: ${reelUrl}\n\n${context}\n\nProvide key insights, content strategy analysis, and how we could create similar content.`,
            scopeKey: `ig-research-${shortcode}`,
          });
          const response = (result.text || 'No analysis available.').substring(0, 3800);
          await ctx.editMessageText(`*Research: reel/${shortcode}*\n\n${response}`, {
            parse_mode: 'Markdown', reply_markup: undefined,
          });
        } catch (err) {
          await ctx.editMessageText(`Research failed: ${err.message}`, { reply_markup: undefined });
        }
        break;
      }

      default:
        await ctx.editMessageText(`Unknown Instagram action: ${action}`, { reply_markup: undefined });
    }
  });

  // --- Team Hub Task Creation Flow ---

  // Priority selection
  bot.callbackQuery(/^hub:pri:(\w+)$/, async (ctx) => {
    const priority = ctx.match[1];
    const key = taskKey(ctx.chat.id, ctx.from.id);
    const task = pendingTasks.get(key);
    if (!task) {
      await ctx.answerCallbackQuery({ text: 'Task expired. Start again with /hub task', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();
    task.priority = priority;
    task.step = 'due';

    const prioLabel = { critical: '🔴 Critical', high: '🟠 High', medium: '🟡 Medium', low: '🟢 Low' }[priority] || priority;

    const kb = new InlineKeyboard()
      .text('Today', 'hub:due:today').text('Tomorrow', 'hub:due:tmrw')
      .row()
      .text('This Friday', 'hub:due:fri').text('Next Week', 'hub:due:nxtw')
      .row()
      .text('Custom Date', 'hub:due:custom').text('No Due Date', 'hub:due:skip')
      .row()
      .text('Cancel', 'hub:cancel');

    await ctx.editMessageText(
      `📋 *New Task*\n\n` +
      `*Title:* ${task.title}\n` +
      `*Priority:* ${prioLabel}\n\n` +
      `When is this due?`,
      { parse_mode: 'Markdown', reply_markup: kb }
    );
  });

  // Due date selection
  bot.callbackQuery(/^hub:due:(\w+)$/, async (ctx) => {
    const choice = ctx.match[1];
    const key = taskKey(ctx.chat.id, ctx.from.id);
    const task = pendingTasks.get(key);
    if (!task) {
      await ctx.answerCallbackQuery({ text: 'Task expired. Start again with /hub task', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();

    if (choice === 'custom') {
      task.step = 'due_custom';
      await ctx.editMessageText(
        `📋 *New Task*\n\n` +
        `*Title:* ${task.title}\n\n` +
        `Type a due date (e.g. \`Mar 15\`, \`2026-03-15\`, \`in 3 days\`):`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const now = new Date();
    let dueDate = null;

    if (choice === 'today') {
      dueDate = now.toISOString().split('T')[0];
    } else if (choice === 'tmrw') {
      const d = new Date(now); d.setDate(d.getDate() + 1);
      dueDate = d.toISOString().split('T')[0];
    } else if (choice === 'fri') {
      const d = new Date(now);
      const daysToFri = (5 - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + daysToFri);
      dueDate = d.toISOString().split('T')[0];
    } else if (choice === 'nxtw') {
      const d = new Date(now);
      const daysToMon = (1 - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + daysToMon);
      dueDate = d.toISOString().split('T')[0];
    }
    // 'skip' → dueDate stays null

    task.due_date = dueDate;
    task.step = 'description';
    showDescriptionPrompt(ctx, task);
  });

  // Description skip
  bot.callbackQuery('hub:desc:skip', async (ctx) => {
    const key = taskKey(ctx.chat.id, ctx.from.id);
    const task = pendingTasks.get(key);
    if (!task) {
      await ctx.answerCallbackQuery({ text: 'Task expired.', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();
    task.description = '';
    task.step = 'confirm';
    showTaskSummary(ctx, task);
  });

  // Create task
  bot.callbackQuery('hub:create', async (ctx) => {
    const key = taskKey(ctx.chat.id, ctx.from.id);
    const task = pendingTasks.get(key);
    if (!task) {
      await ctx.answerCallbackQuery({ text: 'Task expired.', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery({ text: 'Creating task...' });
    pendingTasks.delete(key);

    try {
      const item = await createHubTask(task);
      const prioLabel = { critical: '🔴 Critical', high: '🟠 High', medium: '🟡 Medium', low: '🟢 Low' }[task.priority] || task.priority;

      let msg = `✅ *Task Created*\n\n` +
        `*${task.title}*\n` +
        `Priority: ${prioLabel}`;
      if (task.due_date) msg += `\nDue: ${task.due_date}`;
      if (task.description) msg += `\n\n${task.description}`;
      msg += `\n\nID: \`${item.id?.substring(0, 8) || '?'}\``;

      await ctx.editMessageText(msg, { parse_mode: 'Markdown', reply_markup: undefined });
    } catch (err) {
      await ctx.editMessageText(`Failed to create task: ${err.message}`, { reply_markup: undefined });
    }
  });

  // Cancel task creation
  bot.callbackQuery('hub:cancel', async (ctx) => {
    const key = taskKey(ctx.chat.id, ctx.from.id);
    pendingTasks.delete(key);
    await ctx.answerCallbackQuery({ text: 'Cancelled.' });
    await ctx.editMessageText('Task creation cancelled.', { reply_markup: undefined });
  });

  // WordPress action buttons (update, backup, cancel)
  bot.callbackQuery(/^wp:([^:]+):([^:]+)(?::(.+))?$/, async (ctx) => {
    const action = ctx.match[1];
    const siteId = ctx.match[2];
    const extra = ctx.match[3] || '';

    if (!hasPermission(ctx.from.id, 'admin')) {
      await ctx.answerCallbackQuery({ text: 'Admin only.', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();

    if (action === 'cancel') {
      await ctx.editMessageText('Action cancelled.', { reply_markup: undefined });
      return;
    }

    await ctx.editMessageText('Executing...', { reply_markup: undefined });
    const result = await handleWpCallback(action, siteId, extra);
    try {
      await ctx.editMessageText(result, { parse_mode: 'Markdown' });
    } catch {
      await ctx.editMessageText(result);
    }
  });

  // Email auto-discovery mapping
  bot.callbackQuery(/^email_map:(\d+):(.+)$/, async (ctx) => {
    const targetUserId = ctx.match[1];
    const accountId = ctx.match[2];

    // Only owner can respond
    const ownerId = process.env.OWNER_USER_ID;
    if (!ownerId || String(ctx.from.id) !== String(ownerId)) {
      await ctx.answerCallbackQuery({ text: 'Only the owner can do this.', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();

    if (accountId === 'skip') {
      await ctx.editMessageText('Skipped — no email account linked.', { reply_markup: undefined });
      return;
    }

    // Write to notification-map.json
    const mapPath = path.join(__dirname, '..', '..', 'opai-email-agent', 'data', 'notification-map.json');
    let map;
    try { map = JSON.parse(fs.readFileSync(mapPath, 'utf8')); }
    catch { map = { mappings: {} }; }

    const userName = ctx.callbackQuery.message?.text?.match(/\*New user.*:\*\s*(.+?)\s*\(ID/)?.[1] || 'Unknown';
    map.mappings[targetUserId] = {
      accountId,
      telegramName: userName,
      addedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(mapPath), { recursive: true });
    fs.writeFileSync(mapPath, JSON.stringify(map, null, 2));

    // Also update config.json with the user's notification preference
    const configPath = path.join(__dirname, '..', '..', 'opai-email-agent', 'config.json');
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const account = (config.accounts || []).find(a => a.id === accountId);
      if (account) {
        if (!account.notifications) account.notifications = {};
        account.notifications.telegramUserId = Number(targetUserId);
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      }
    } catch (err) {
      console.error('[TG] Failed to update email config:', err.message);
    }

    const accName = accountId;
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const account = (config.accounts || []).find(a => a.id === accountId);
      if (account) {
        await ctx.editMessageText(
          `Linked *${userName}* (${targetUserId}) to *${account.name || account.email}* for email notifications.`,
          { parse_mode: 'Markdown', reply_markup: undefined }
        );
        return;
      }
    } catch {}

    await ctx.editMessageText(
      `Linked user ${targetUserId} to account ${accountId}.`,
      { reply_markup: undefined }
    );
  });

  // ── System Change Approval Gate (from Email Agent) ──────

  bot.callbackQuery(/^syschange:(approve|reject):(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    const requestId = ctx.match[2];

    // Only owner can approve/reject system changes
    if (getUserRole(ctx.from.id) !== 'owner') {
      await ctx.answerCallbackQuery({ text: 'Only the owner can approve system changes.', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery({ text: action === 'approve' ? 'Approving...' : 'Rejecting...' });

    const endpoint = action === 'approve' ? 'execute' : 'reject';

    try {
      const result = await new Promise((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:8093/api/approval/${requestId}/${endpoint}`,
          { method: 'POST', timeout: 10000, headers: { 'Content-Type': 'application/json' } },
          (res) => {
            let body = '';
            res.on('data', d => { body += d; });
            res.on('end', () => {
              try { resolve(JSON.parse(body)); }
              catch { resolve({ success: res.statusCode < 400 }); }
            });
          }
        );
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end('{}');
      });

      const statusEmoji = action === 'approve' ? '\u2705' : '\u274C';
      const statusText = action === 'approve' ? 'APPROVED' : 'REJECTED';

      await ctx.editMessageText(
        `${statusEmoji} *System Change ${statusText}*\n\n` +
        `By: ${ctx.from.first_name}\n` +
        `Request: \`${requestId}\`\n\n` +
        `${action === 'approve' ? 'Confirmation email sent to requester.' : 'Rejection notification sent.'}`,
        { parse_mode: 'Markdown', reply_markup: undefined }
      );
    } catch (err) {
      await ctx.editMessageText(
        `Failed to ${action} system change: ${err.message}`,
        { reply_markup: undefined }
      );
    }
  });

  // ── Worker Approval Gate ──────

  bot.callbackQuery(/^appr:(yes|no):(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    const approvalId = ctx.match[2];

    if (getUserRole(ctx.from.id) !== 'owner' && !hasPermission(ctx.from.id, 'admin')) {
      await ctx.answerCallbackQuery({ text: 'Admin only.', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery({ text: action === 'yes' ? 'Approving...' : 'Denying...' });

    try {
      const endpoint = action === 'yes'
        ? `/workers/approvals/${approvalId}/approve`
        : `/workers/approvals/${approvalId}/deny`;
      await enginePost(endpoint);

      const icon = action === 'yes' ? '\u2705' : '\u274C';
      const label = action === 'yes' ? 'APPROVED' : 'DENIED';
      await ctx.editMessageText(
        `${icon} *${label}* by ${ctx.from.first_name}\nApproval: \`${approvalId}\``,
        { parse_mode: 'Markdown', reply_markup: undefined }
      );
    } catch (err) {
      await ctx.editMessageText(
        `Failed to ${action === 'yes' ? 'approve' : 'deny'}: ${err.message}`,
        { reply_markup: undefined }
      );
    }
  });

  // ── HITL Briefing Actions ──────
  // Supports both legacy filename-based and Team Hub UUID-based items.
  // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  // "gc" action = "Picked up in GravityClaw" — acknowledges, suppresses escalation.

  bot.callbackQuery(/^hitl:(run|approve|dismiss|reject|gc):(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    const itemKey = ctx.match[2];

    if (getUserRole(ctx.from.id) !== 'owner' && !hasPermission(ctx.from.id, 'admin')) {
      await ctx.answerCallbackQuery({ text: 'Admin only.', show_alert: true });
      return;
    }

    const ackMap = {
      run: 'Running...',
      approve: 'Approving...',
      dismiss: 'Dismissing...',
      reject: 'Rejecting...',
      gc: 'Acknowledged — handling in GravityClaw',
    };
    await ctx.answerCallbackQuery({ text: ackMap[action] || 'Processing...' });

    // Detect if this is a Team Hub UUID or legacy filename
    const isTeamHub = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(itemKey);

    try {
      if (action === 'gc') {
        // "Picked up in GC" — acknowledge escalation, don't change item status
        if (isTeamHub) {
          // Tell Engine to acknowledge (clears escalation timer)
          await enginePost(`/action-items/th:${itemKey}/act`, { action: 'gc' }).catch(() => {});
        }
        await ctx.editMessageText(
          `\uD83D\uDCBB \`${itemKey.substring(0, 8)}...\` — *Picked up in GravityClaw*\n\nBy ${ctx.from.first_name}`,
          { parse_mode: 'Markdown', reply_markup: undefined }
        );
      } else if (isTeamHub) {
        // Route through Engine action-items API → Team Hub
        await enginePost(`/action-items/th:${itemKey}/act`, { action });

        const iconMap = { run: '\u25B6\uFE0F', approve: '\u2705', dismiss: '\uD83D\uDDD1\uFE0F', reject: '\u274C' };
        const labelMap = { run: 'Running...', approve: 'Approved', dismiss: 'Dismissed', reject: 'Rejected' };
        const icon = iconMap[action] || '\u2699\uFE0F';
        const label = labelMap[action] || action;
        await ctx.editMessageText(
          `${icon} \`${itemKey.substring(0, 8)}...\` — ${label}\n\nBy ${ctx.from.first_name}`,
          { parse_mode: 'Markdown', reply_markup: undefined }
        );
      } else {
        // Legacy: route to old HITL endpoint
        await enginePost(`/hitl/${encodeURIComponent(itemKey)}/respond`, { action });

        const iconMap = { run: '\u25B6\uFE0F', approve: '\u2705', dismiss: '\uD83D\uDDD1\uFE0F', reject: '\u274C' };
        const labelMap = { run: 'Running...', approve: 'Approved', dismiss: 'Dismissed', reject: 'Rejected' };
        const icon = iconMap[action] || '\u2699\uFE0F';
        const label = labelMap[action] || action;
        await ctx.editMessageText(
          `${icon} \`${itemKey}\` — ${label}`,
          { parse_mode: 'Markdown', reply_markup: undefined }
        );
      }
    } catch (err) {
      await ctx.editMessageText(
        `HITL ${action} failed: ${err.message}`,
        { reply_markup: undefined }
      );
    }
  });

  // ── Service Restart from Alerts ──────

  bot.callbackQuery(/^svc:restart:(.+)$/, async (ctx) => {
    const workerId = ctx.match[1];

    if (getUserRole(ctx.from.id) !== 'owner' && !hasPermission(ctx.from.id, 'admin')) {
      await ctx.answerCallbackQuery({ text: 'Admin only.', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery({ text: `Restarting ${workerId}...` });

    try {
      await enginePost(`/workers/${encodeURIComponent(workerId)}/tg-restart`);
      await ctx.editMessageText(
        `\u{1F504} \`${workerId}\` \u2014 *Restarting...*\n\nTriggered by ${ctx.from.first_name}`,
        { parse_mode: 'Markdown', reply_markup: undefined }
      );

      // Poll for recovery — check every 5s for up to 60s
      const pollStart = Date.now();
      const pollInterval = setInterval(async () => {
        try {
          if (Date.now() - pollStart > 60000) {
            clearInterval(pollInterval);
            await ctx.editMessageText(
              `\u{26A0}\u{FE0F} \`${workerId}\` \u2014 *Restart sent but not yet confirmed healthy*\nCheck /status in a few minutes.`,
              { parse_mode: 'Markdown' }
            );
            return;
          }
          const detail = await engineGet(`/workers/${encodeURIComponent(workerId)}`);
          if (detail && detail.healthy === true) {
            clearInterval(pollInterval);
            await ctx.editMessageText(
              `\u{2705} \`${workerId}\` \u2014 *Back Online*\n\nRestarted by ${ctx.from.first_name}`,
              { parse_mode: 'Markdown' }
            );
          }
        } catch {
          // Worker may not be queryable yet — keep polling
        }
      }, 5000);
    } catch (err) {
      await ctx.editMessageText(
        `\u{274C} Failed to restart \`${workerId}\`: ${err.message}`,
        { parse_mode: 'Markdown', reply_markup: undefined }
      );
    }
  });

  bot.callbackQuery(/^svc:restartall:(.+)$/, async (ctx) => {
    const workerIds = ctx.match[1].split(',');

    if (getUserRole(ctx.from.id) !== 'owner' && !hasPermission(ctx.from.id, 'admin')) {
      await ctx.answerCallbackQuery({ text: 'Admin only.', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery({ text: `Restarting ${workerIds.length} services...` });

    const results = [];
    const pendingIds = [];
    for (const wid of workerIds) {
      try {
        await enginePost(`/workers/${encodeURIComponent(wid)}/tg-restart`);
        results.push(`\u{1F504} \`${wid}\` restarting`);
        pendingIds.push(wid);
      } catch (err) {
        results.push(`\u{274C} \`${wid}\` failed: ${err.message}`);
      }
    }

    await ctx.editMessageText(
      `*Restart All*\n\n${results.join('\n')}\n\nTriggered by ${ctx.from.first_name}`,
      { parse_mode: 'Markdown', reply_markup: undefined }
    );

    // Poll for recovery of all restarted workers
    if (pendingIds.length > 0) {
      const remaining = new Set(pendingIds);
      const pollStart = Date.now();
      const pollInterval = setInterval(async () => {
        try {
          if (Date.now() - pollStart > 60000) {
            clearInterval(pollInterval);
            if (remaining.size > 0) {
              const finalResults = pendingIds.map(wid =>
                remaining.has(wid)
                  ? `\u{26A0}\u{FE0F} \`${wid}\` not yet confirmed`
                  : `\u{2705} \`${wid}\` back online`
              );
              await ctx.editMessageText(
                `*Restart All*\n\n${finalResults.join('\n')}\n\nRestarted by ${ctx.from.first_name}`,
                { parse_mode: 'Markdown' }
              );
            }
            return;
          }
          for (const wid of [...remaining]) {
            try {
              const detail = await engineGet(`/workers/${encodeURIComponent(wid)}`);
              if (detail && detail.healthy === true) {
                remaining.delete(wid);
              }
            } catch {
              // Worker may not be queryable yet
            }
          }
          if (remaining.size === 0) {
            clearInterval(pollInterval);
            const allOnline = pendingIds.map(wid => `\u{2705} \`${wid}\` back online`);
            await ctx.editMessageText(
              `*Restart All*\n\n${allOnline.join('\n')}\n\nRestarted by ${ctx.from.first_name}`,
              { parse_mode: 'Markdown' }
            );
          }
        } catch {
          // Keep polling
        }
      }, 5000);
    }
  });

  // Email action buttons
  bot.callbackQuery(/^email:(\w+):(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    const emailId = ctx.match[2];
    await ctx.answerCallbackQuery();

    switch (action) {
      case 'approve':
        await ctx.editMessageText(`Approving email draft ${emailId}...`, { reply_markup: undefined });
        break;
      case 'reject':
        await ctx.editMessageText(`Rejecting email draft ${emailId}.`, { reply_markup: undefined });
        break;
      default:
        await ctx.editMessageText(`Unknown action: ${action}`, { reply_markup: undefined });
    }
  });

  // --- Dangerous Run Callbacks ---

  // Confirm dangerous execution
  bot.callbackQuery(/^danger:confirm:(.+)$/, async (ctx) => {
    const actionId = ctx.match[1];
    const run = pendingDangerRuns.get(actionId);

    if (!run) {
      await ctx.answerCallbackQuery({ text: 'This action has expired.', show_alert: true });
      return;
    }

    if (getUserRole(ctx.from.id) !== 'owner') {
      await ctx.answerCallbackQuery({ text: 'Only the owner can confirm dangerous runs.', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery({ text: 'Executing...' });
    pendingDangerRuns.delete(actionId);

    await ctx.editMessageText('*Autonomous execution in progress...*', {
      parse_mode: 'Markdown',
      reply_markup: undefined,
    });

    // Fire and forget
    executeDangerousRun(bot, ctx.chat.id, run.threadId, ctx.callbackQuery.message.message_id, run)
      .catch(err => console.error('[TG] [DANGER] Background error:', err.message));
  });

  // Cancel dangerous execution
  bot.callbackQuery(/^danger:cancel:(.+)$/, async (ctx) => {
    const actionId = ctx.match[1];
    const run = pendingDangerRuns.get(actionId);
    pendingDangerRuns.delete(actionId);

    if (run) {
      logDangerousRun({
        userId: ctx.from.id,
        username: run.username || ctx.from.first_name,
        instruction: run.instruction,
        outcome: 'cancelled',
      });
    }

    await ctx.answerCallbackQuery({ text: 'Cancelled.' });
    await ctx.editMessageText('Dangerous run cancelled.', { reply_markup: undefined });
  });

  // Backup before dangerous run — git add/commit/push, then show confirm gate
  bot.callbackQuery(/^danger:backup:(.+)$/, async (ctx) => {
    const actionId = ctx.match[1];
    const run = pendingDangerRuns.get(actionId);

    if (!run) {
      await ctx.answerCallbackQuery({ text: 'This action has expired.', show_alert: true });
      return;
    }

    if (getUserRole(ctx.from.id) !== 'owner') {
      await ctx.answerCallbackQuery({ text: 'Only the owner can do this.', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery({ text: 'Backing up...' });
    await ctx.editMessageText('*Backing up OPAI to GitHub...*', {
      parse_mode: 'Markdown',
      reply_markup: undefined,
    });

    try {
      // Check if there's anything to commit
      const status = execSync('git status --porcelain', { cwd: OPAI_ROOT, encoding: 'utf8', timeout: 10000 }).trim();

      if (!status) {
        // Nothing to commit — just push any unpushed commits
        try {
          const pushResult = execSync('git push 2>&1', { cwd: OPAI_ROOT, encoding: 'utf8', timeout: 30000 }).trim();
          await ctx.editMessageText(
            '*Backup complete* — nothing new to commit, pushed any pending commits.\n\n' +
            `\`${pushResult || 'Already up to date.'}\``,
            { parse_mode: 'Markdown', reply_markup: undefined }
          );
        } catch (pushErr) {
          await ctx.editMessageText(
            '*Backup complete* — nothing new to commit.\n' +
            `Push note: \`${(pushErr.message || '').substring(0, 200)}\``,
            { parse_mode: 'Markdown', reply_markup: undefined }
          );
        }
      } else {
        // Stage everything, commit, push
        const fileCount = status.split('\n').length;
        execSync('git add -A', { cwd: OPAI_ROOT, timeout: 15000 });

        const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
        const commitMsg = `chore: pre-danger backup (${timestamp})`;
        execSync(`git commit -m "${commitMsg}"`, { cwd: OPAI_ROOT, encoding: 'utf8', timeout: 15000 });

        let pushNote = '';
        try {
          execSync('git push 2>&1', { cwd: OPAI_ROOT, encoding: 'utf8', timeout: 30000 });
          pushNote = 'Pushed to remote.';
        } catch (pushErr) {
          pushNote = `Push failed: ${(pushErr.message || '').substring(0, 150)}`;
        }

        await ctx.editMessageText(
          `*Backup complete*\n\n` +
          `Committed ${fileCount} file(s): \`${commitMsg}\`\n` +
          pushNote,
          { parse_mode: 'Markdown', reply_markup: undefined }
        );
      }

      // Now show the dangerous run confirmation gate
      const truncated = run.instruction.length > 300 ? run.instruction.substring(0, 300) + '...' : run.instruction;

      const kb = new InlineKeyboard()
        .text('Confirm', `danger:confirm:${actionId}`)
        .text('Cancel', `danger:cancel:${actionId}`);

      await ctx.reply(
        '*DANGEROUS RUN*\n\n' +
        '*Backup done. Execute autonomously?*\n\n' +
        '```\n' + truncated + '\n```\n\n' +
        '*Access:* Full (Bash, files, MCP)\n' +
        '*Timeout:* 10 minutes',
        {
          parse_mode: 'Markdown',
          reply_markup: kb,
          message_thread_id: ctx.callbackQuery.message?.message_thread_id,
        }
      );
    } catch (err) {
      console.error('[TG] [BACKUP] Git backup failed:', err.message);

      // Backup failed — still show the confirm gate but warn
      const truncated = run.instruction.length > 300 ? run.instruction.substring(0, 300) + '...' : run.instruction;

      const kb = new InlineKeyboard()
        .text('Confirm Anyway', `danger:confirm:${actionId}`)
        .text('Cancel', `danger:cancel:${actionId}`);

      await ctx.editMessageText(
        `*Backup failed:* \`${err.message.substring(0, 200)}\`\n\n` +
        'You can still proceed or cancel.',
        { parse_mode: 'Markdown', reply_markup: undefined }
      );

      await ctx.reply(
        '*DANGEROUS RUN*\n\n' +
        '*Backup failed. Still execute?*\n\n' +
        '```\n' + truncated + '\n```',
        {
          parse_mode: 'Markdown',
          reply_markup: kb,
          message_thread_id: ctx.callbackQuery.message?.message_thread_id,
        }
      );
    }
  });

  // "Run Dangerously" button on plan-like Claude responses
  bot.callbackQuery(/^danger:run:(.+)$/, async (ctx) => {
    const cacheKey = ctx.match[1];

    if (getUserRole(ctx.from.id) !== 'owner') {
      await ctx.answerCallbackQuery({ text: 'Only the owner can run dangerously.', show_alert: true });
      return;
    }

    const cached = dangerResponseCache.get(cacheKey);
    if (!cached) {
      await ctx.answerCallbackQuery({ text: 'Response expired. Send the instruction again.', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();

    // Build confirmation gate
    const actionId = `dr-${Date.now()}`;
    const instruction = cached.text;
    const truncated = instruction.length > 300 ? instruction.substring(0, 300) + '...' : instruction;

    pendingDangerRuns.set(actionId, {
      instruction,
      conversationContext: '',
      scopeKey: cached.scopeKey,
      requestedBy: ctx.from.id,
      chatId: ctx.chat.id,
      threadId: String(ctx.callbackQuery.message?.message_thread_id || 'general'),
      username: ctx.from.first_name || ctx.from.username || String(ctx.from.id),
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    const kb = new InlineKeyboard()
      .text('Backup First', `danger:backup:${actionId}`)
      .row()
      .text('Confirm', `danger:confirm:${actionId}`)
      .text('Cancel', `danger:cancel:${actionId}`);

    await ctx.reply(
      '*DANGEROUS RUN*\n\n' +
      '*Execute Claude\'s plan autonomously?*\n\n' +
      '```\n' + truncated + '\n```\n\n' +
      '*Access:* Full (Bash, files, MCP)\n' +
      '*Timeout:* 10 minutes\n\n' +
      'This will run with --dangerously-skip-permissions.',
      {
        parse_mode: 'Markdown',
        reply_markup: kb,
        message_thread_id: ctx.callbackQuery.message?.message_thread_id,
      }
    );
  });

  // ── Assembly Line gate callbacks ──────────────────────
  bot.callbackQuery(/^asm:(approve|reject|ship|abort):(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    const runId = ctx.match[2];
    await ctx.answerCallbackQuery();

    try {
      let resp;
      if (action === 'approve') {
        resp = await enginePost(`/assembly/gate/${runId}/plan`, { action: 'approve' });
      } else if (action === 'reject') {
        resp = await enginePost(`/assembly/gate/${runId}/plan`, { action: 'reject' });
      } else if (action === 'ship') {
        resp = await enginePost(`/assembly/gate/${runId}/ship`, { action: 'approve' });
      } else if (action === 'abort') {
        resp = await enginePost(`/assembly/abort/${runId}`);
      }

      const statusEmoji = (action === 'approve' || action === 'ship') ? '✅' : '🛑';
      const statusText = {
        approve: 'Plan approved — building...',
        reject: 'Plan rejected — run aborted.',
        ship: 'Ship approved — run complete!',
        abort: 'Run aborted.',
      }[action];

      await ctx.editMessageText(
        `${statusEmoji} Assembly \`${runId}\` — ${statusText}`,
        { reply_markup: undefined, parse_mode: 'Markdown' }
      );
    } catch (e) {
      await ctx.editMessageText(
        `❌ Assembly action failed: ${e.message}`,
        { reply_markup: undefined }
      );
    }
  });
}

/**
 * Execute a confirmed action.
 */
async function executeAction(ctx, action) {
  switch (action.type) {
    case 'service_restart':
      await ctx.editMessageText(`Service restart for ${action.payload.service}... (Phase 3)`);
      break;
    case 'task_execute':
      await ctx.editMessageText(`Executing task: ${action.payload.task}... (Phase 3)`);
      break;
    default:
      await ctx.editMessageText(`Executed: ${action.type}`);
  }
}

// --- Hub Task Creation Helpers ---

const OWNER_SUPABASE_ID = '1c93c5fe-d304-40f2-9169-765d0d2b7638';
const DEFAULT_WORKSPACE_ID = '80753c5a-beb5-498c-8d71-393a0342af27';
const HUB_BASE = 'http://127.0.0.1:8089/api/internal';

function showDescriptionPrompt(ctx, task) {
  const prioLabel = { critical: '🔴 Critical', high: '🟠 High', medium: '🟡 Medium', low: '🟢 Low' }[task.priority] || task.priority;

  const kb = new InlineKeyboard()
    .text('No Description', 'hub:desc:skip')
    .row()
    .text('Cancel', 'hub:cancel');

  let msg = `📋 *New Task*\n\n` +
    `*Title:* ${task.title}\n` +
    `*Priority:* ${prioLabel}`;
  if (task.due_date) msg += `\n*Due:* ${task.due_date}`;
  msg += `\n\nType a description for this task, or tap Skip:`;

  ctx.editMessageText(msg, { parse_mode: 'Markdown', reply_markup: kb });
}

function showTaskSummary(ctx, task) {
  const prioLabel = { critical: '🔴 Critical', high: '🟠 High', medium: '🟡 Medium', low: '🟢 Low' }[task.priority] || task.priority;

  const kb = new InlineKeyboard()
    .text('Create Task', 'hub:create')
    .text('Cancel', 'hub:cancel');

  let msg = `📋 *Ready to Create*\n\n` +
    `*Title:* ${task.title}\n` +
    `*Priority:* ${prioLabel}`;
  if (task.due_date) msg += `\n*Due:* ${task.due_date}`;
  if (task.description) msg += `\n*Description:*\n${task.description}`;
  msg += `\n\nLook good?`;

  ctx.editMessageText(msg, { parse_mode: 'Markdown', reply_markup: kb });
}

function createHubTask(task) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      workspace_id: DEFAULT_WORKSPACE_ID,
      user_id: OWNER_SUPABASE_ID,
      type: 'task',
      title: task.title,
      description: task.description || '',
      priority: task.priority || 'medium',
      source: 'telegram',
    });
    if (task.due_date) params.set('due_date', task.due_date);

    const url = `${HUB_BASE}/create-item?${params.toString()}`;
    const req = http.request(url, { method: 'POST', timeout: 10000 }, (res) => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (res.statusCode >= 400) {
            reject(new Error(data.detail || `HTTP ${res.statusCode}`));
          } else {
            resolve(data);
          }
        } catch {
          reject(new Error(`Invalid response from Team Hub`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Team Hub timeout')); });
    req.end();
  });
}

/**
 * Start the task creation flow — called from /hub task command.
 */
function startTaskCreation(ctx, title) {
  const key = taskKey(ctx.chat.id, ctx.from.id);

  const task = {
    step: title ? 'priority' : 'title',
    title: title || null,
    priority: null,
    due_date: null,
    description: null,
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 min
  };

  pendingTasks.set(key, task);

  if (!title) {
    // No title given — ask for it
    return ctx.reply(
      '📋 *New Task*\n\nWhat\'s the task title?',
      { parse_mode: 'Markdown', message_thread_id: ctx.message?.message_thread_id }
    );
  }

  // Title provided — show priority picker
  const kb = new InlineKeyboard()
    .text('🔴 Critical', 'hub:pri:critical').text('🟠 High', 'hub:pri:high')
    .row()
    .text('🟡 Medium', 'hub:pri:medium').text('🟢 Low', 'hub:pri:low')
    .row()
    .text('Cancel', 'hub:cancel');

  return ctx.reply(
    `📋 *New Task*\n\n*Title:* ${title}\n\nSelect priority:`,
    { parse_mode: 'Markdown', reply_markup: kb, message_thread_id: ctx.message?.message_thread_id }
  );
}

/**
 * Handle text input during task creation (title, description, custom due date).
 * Returns true if the message was consumed, false if it should pass through.
 */
function handlePendingTaskInput(ctx, text) {
  const key = taskKey(ctx.chat.id, ctx.from.id);
  const task = pendingTasks.get(key);
  if (!task) return false;

  const threadOpts = ctx.message?.message_thread_id
    ? { message_thread_id: ctx.message.message_thread_id }
    : {};

  if (task.step === 'title') {
    task.title = text.trim();
    task.step = 'priority';

    const kb = new InlineKeyboard()
      .text('🔴 Critical', 'hub:pri:critical').text('🟠 High', 'hub:pri:high')
      .row()
      .text('🟡 Medium', 'hub:pri:medium').text('🟢 Low', 'hub:pri:low')
      .row()
      .text('Cancel', 'hub:cancel');

    ctx.reply(
      `📋 *New Task*\n\n*Title:* ${task.title}\n\nSelect priority:`,
      { parse_mode: 'Markdown', reply_markup: kb, ...threadOpts }
    );
    return true;
  }

  if (task.step === 'due_custom') {
    const parsed = parseFlexDate(text.trim());
    if (!parsed) {
      ctx.reply(
        `Couldn't parse that date. Try \`YYYY-MM-DD\`, \`Mar 15\`, or \`in 3 days\`:`,
        { parse_mode: 'Markdown', ...threadOpts }
      );
      return true;
    }
    task.due_date = parsed;
    task.step = 'description';

    const prioLabel = { critical: '🔴 Critical', high: '🟠 High', medium: '🟡 Medium', low: '🟢 Low' }[task.priority] || task.priority;

    const kb = new InlineKeyboard()
      .text('No Description', 'hub:desc:skip')
      .row()
      .text('Cancel', 'hub:cancel');

    ctx.reply(
      `📋 *New Task*\n\n` +
      `*Title:* ${task.title}\n` +
      `*Priority:* ${prioLabel}\n` +
      `*Due:* ${task.due_date}\n\n` +
      `Type a description, or tap Skip:`,
      { parse_mode: 'Markdown', reply_markup: kb, ...threadOpts }
    );
    return true;
  }

  if (task.step === 'description') {
    task.description = text.trim();
    task.step = 'confirm';

    const prioLabel = { critical: '🔴 Critical', high: '🟠 High', medium: '🟡 Medium', low: '🟢 Low' }[task.priority] || task.priority;

    const kb = new InlineKeyboard()
      .text('Create Task', 'hub:create')
      .text('Cancel', 'hub:cancel');

    let msg = `📋 *Ready to Create*\n\n` +
      `*Title:* ${task.title}\n` +
      `*Priority:* ${prioLabel}`;
    if (task.due_date) msg += `\n*Due:* ${task.due_date}`;
    if (task.description) msg += `\n*Description:*\n${task.description}`;
    msg += `\n\nLook good?`;

    ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: kb, ...threadOpts });
    return true;
  }

  return false;
}

/**
 * Parse flexible date input: "Mar 15", "2026-03-15", "in 3 days", "next friday", etc.
 */
function parseFlexDate(input) {
  // ISO format: 2026-03-15
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;

  const lower = input.toLowerCase();
  const now = new Date();

  // "today", "tomorrow"
  if (lower === 'today') return now.toISOString().split('T')[0];
  if (lower === 'tomorrow') {
    now.setDate(now.getDate() + 1);
    return now.toISOString().split('T')[0];
  }

  // "in N days/weeks"
  const inMatch = lower.match(/^in\s+(\d+)\s+(day|days|week|weeks)$/);
  if (inMatch) {
    const n = parseInt(inMatch[1]);
    const unit = inMatch[2].startsWith('week') ? 7 : 1;
    now.setDate(now.getDate() + n * unit);
    return now.toISOString().split('T')[0];
  }

  // "next monday/tuesday/..." etc
  const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const nextMatch = lower.match(/^next\s+(\w+)$/);
  if (nextMatch) {
    const dayIdx = dayNames.indexOf(nextMatch[1]);
    if (dayIdx >= 0) {
      const diff = (dayIdx - now.getDay() + 7) % 7 || 7;
      now.setDate(now.getDate() + diff);
      return now.toISOString().split('T')[0];
    }
  }

  // "Mar 15", "March 15", "Feb 28" etc
  const months = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
    apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
    aug: 7, august: 7, sep: 8, september: 8, oct: 9, october: 9,
    nov: 10, november: 10, dec: 11, december: 11,
  };
  const monthMatch = lower.match(/^(\w+)\s+(\d{1,2})$/);
  if (monthMatch && months[monthMatch[1]] !== undefined) {
    const month = months[monthMatch[1]];
    const day = parseInt(monthMatch[2]);
    let year = now.getFullYear();
    const candidate = new Date(year, month, day);
    if (candidate < now) candidate.setFullYear(year + 1);
    return candidate.toISOString().split('T')[0];
  }

  // "15 Mar", "28 Feb"
  const dayMonthMatch = lower.match(/^(\d{1,2})\s+(\w+)$/);
  if (dayMonthMatch && months[dayMonthMatch[2]] !== undefined) {
    const month = months[dayMonthMatch[2]];
    const day = parseInt(dayMonthMatch[1]);
    let year = now.getFullYear();
    const candidate = new Date(year, month, day);
    if (candidate < now) candidate.setFullYear(year + 1);
    return candidate.toISOString().split('T')[0];
  }

  return null;
}

// --- Dangerous Run Execution ---

const { createJob, completeJob, failJob } = require('../job-manager');

/**
 * Execute a dangerous Claude run in the background.
 * @param {import('grammy').Bot} bot
 * @param {number} chatId
 * @param {string} threadId
 * @param {number} statusMessageId - Message to edit with progress/results
 * @param {object} run - The pending danger run config
 */
async function executeDangerousRun(bot, chatId, threadId, statusMessageId, run) {
  const startTime = Date.now();
  const jobId = createJob({
    chatId,
    threadId,
    messageId: statusMessageId,
    userId: String(run.requestedBy),
    query: `[DANGER] ${(run.instruction || '').substring(0, 80)}`,
  });

  const progressMsgs = [
    '*Autonomous execution in progress...*',
    '*Still building...*',
    '*Working autonomously...*',
    '*Deep in execution...*',
    '*Almost there...*',
    '*Complex task — still going...*',
  ];
  let progressIdx = 0;

  const progressInterval = setInterval(async () => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const msg = progressMsgs[Math.min(progressIdx, progressMsgs.length - 1)];
    progressIdx++;
    try {
      await bot.api.editMessageText(chatId, statusMessageId, `${msg} (${elapsed}s)`, { parse_mode: 'Markdown' });
    } catch {}
  }, 15000);

  try {
    const result = await askClaudeDangerous({
      instruction: run.instruction,
      conversationContext: run.conversationContext || '',
      scopeKey: run.scopeKey,
    });

    clearInterval(progressInterval);
    completeJob(jobId);

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const text = (result.text || '').trim();

    logDangerousRun({
      userId: run.requestedBy,
      username: run.username,
      instruction: run.instruction,
      conversationContext: run.conversationContext,
      outcome: 'success',
      responseLength: text.length,
      durationMs: Date.now() - startTime,
    });

    if (text) {
      // Split for Telegram limits
      const header = `*DANGEROUS RUN COMPLETE* (${elapsed}s)\n\n`;
      const maxBody = 4096 - header.length - 10;
      const body = text.length > maxBody ? text.substring(0, maxBody) + '...' : text;

      try {
        await bot.api.editMessageText(chatId, statusMessageId, header + body, { parse_mode: 'Markdown' });
      } catch {
        try { await bot.api.editMessageText(chatId, statusMessageId, header + body); } catch {}
      }
    } else {
      await bot.api.editMessageText(chatId, statusMessageId, '*DANGEROUS RUN COMPLETE*\n\nNo output received.', { parse_mode: 'Markdown' });
    }
  } catch (err) {
    clearInterval(progressInterval);
    failJob(jobId, err.message);

    logDangerousRun({
      userId: run.requestedBy,
      username: run.username,
      instruction: run.instruction,
      conversationContext: run.conversationContext,
      outcome: 'error',
      durationMs: Date.now() - startTime,
      error: err.message,
    });

    try {
      await bot.api.editMessageText(chatId, statusMessageId, `*DANGEROUS RUN FAILED*\n\n\`${err.message}\``, { parse_mode: 'Markdown' });
    } catch {}
  }
}

/**
 * Cache a Claude response for "Run Dangerously" button retrieval.
 * @param {string} cacheKey - `${chatId}:${msgId}`
 * @param {string} text - Full Claude response text
 * @param {string} scopeKey - Conversation scope key
 */
function cacheDangerResponse(cacheKey, text, scopeKey) {
  dangerResponseCache.set(cacheKey, {
    text,
    scopeKey,
    expiresAt: Date.now() + 30 * 60 * 1000, // 30 minutes
  });
}

module.exports = {
  registerCallbacks, confirmKeyboard, queueAction, cacheVideo, cacheReel, pendingActions,
  pendingTasks, pendingDangerRuns, startTaskCreation, handlePendingTaskInput,
  cacheDangerResponse,
};
