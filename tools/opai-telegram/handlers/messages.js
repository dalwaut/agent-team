/**
 * Message Handler — Free-text AI conversation via Claude CLI.
 *
 * Uses the tiered conversation-state module to decide:
 *   - ACTIVE: no context injection (--resume has it all, zero waste)
 *   - IDLE: thin 3-message recap + --resume
 *   - COLD: digest summary + last exchange + --resume
 *   - EXPIRED/NEW: digest only or empty, fresh session
 *
 * Also handles YouTube and Instagram URL detection with inline action buttons.
 */

const fs = require('fs');
const path = require('path');
const { InlineKeyboard, InputFile } = require('grammy');
const { askClaude, buildPrompt, OPAI_ROOT } = require('../claude-handler');
const { getContextStrategy, recordMessage, buildScopeKey } = require('../conversation-state');
const { createJob, completeJob, failJob } = require('../job-manager');
const { hasPermission, getTopicScope, hasWorkspaceAccess } = require('../access-control');
const { detectIntent, handleIntent } = require('../teamhub-fast');
const { detectWpIntent, handleWpIntent } = require('../wordpress-fast');
const { cacheVideo, cacheReel, handlePendingTaskInput, cacheDangerResponse } = require('./callbacks');
const { logAudit } = require('./utils');
const { getUserRole } = require('../access-control');
const { transcribeVoice } = require('../voice-transcriber');
const { isFileAllowedForConversation } = require('../file-sender');

// System notification topics — text messages are ignored (notification-only).
// Buttons/callbacks still work via callbacks.js.
const SYSTEM_TOPICS = new Set(
  [process.env.ALERT_THREAD_ID, process.env.SERVER_STATUS_THREAD_ID, process.env.HITL_THREAD_ID]
    .filter(Boolean)
    .map(Number)
);

// Email auto-discovery: track which users we've already prompted (24h cooldown)
const _discoveryPrompted = new Set();
const NOTIFICATION_MAP_PATH = path.join(__dirname, '..', '..', 'opai-email-agent', 'data', 'notification-map.json');

function loadNotificationMap() {
  try { return JSON.parse(fs.readFileSync(NOTIFICATION_MAP_PATH, 'utf8')); }
  catch { return { mappings: {} }; }
}

function isUserMapped(userId) {
  const map = loadNotificationMap();
  return !!map.mappings[String(userId)];
}

function getEmailAccounts() {
  try {
    const configPath = path.join(__dirname, '..', '..', 'opai-email-agent', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return (config.accounts || []).filter(a => a.enabled !== false);
  } catch { return []; }
}

const MAX_MESSAGE_LENGTH = 4096;

// YouTube URL detection
const YT_REGEX = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/i;

// Instagram URL detection
const IG_REGEX = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:reel|reels|p|tv)\/([\w-]+)\/?(?:\?[^\s]*)?/i;

/**
 * Split a message into chunks respecting Telegram's 4096 char limit.
 */
function splitMessage(text, limit = MAX_MESSAGE_LENGTH) {
  if (text.length <= limit) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt < limit * 0.5) splitAt = remaining.lastIndexOf(' ', limit);
    if (splitAt < limit * 0.3) splitAt = limit;

    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }

  return chunks;
}

function formatElapsed(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

function getAckMessage(state, content) {
  // State-aware acknowledgment only — no content keyword matching.
  // Content-aware acks were causing misleading framing (e.g. "Checking tasks..."
  // when the user merely mentioned "task" in a longer message).
  switch (state) {
    case 'ACTIVE':
      return 'On it...';
    case 'COLD':
      return 'Picking up where we left off...';
    case 'EXPIRED':
      return 'Starting fresh...';
    default:
      return 'Thinking...';
  }
}

function getProcessingMessage(elapsed) {
  if (elapsed < 15) return '*Working on it...*';
  if (elapsed < 30) return `*Still working...* (${formatElapsed(elapsed)})`;
  if (elapsed < 60) return `*Deeper analysis in progress...* (${formatElapsed(elapsed)})`;
  if (elapsed < 120) return `*This one's taking a bit — hang tight.* (${formatElapsed(elapsed)})`;
  if (elapsed < 180) return `*Complex task — still running. I'll update you when complete.* (${formatElapsed(elapsed)})`;
  return `*Still working on this — will notify you when done.* (${formatElapsed(elapsed)})`;
}

/**
 * Handle a YouTube URL — fetch transcript and show action buttons.
 * Uses shared/youtube.js (processYouTubeUrl) which spawns the Python library.
 */
async function handleYouTubeUrl(ctx, url, videoId) {
  const ackMsg = await ctx.reply('*Fetching video info...*', {
    parse_mode: 'Markdown',
    message_thread_id: ctx.message.message_thread_id,
  });

  try {
    const ytPath = path.join(__dirname, '..', '..', 'shared', 'youtube.js');
    let title, transcript, author, summary;

    // Ensure the URL has a protocol for the Python library
    const fullUrl = url.startsWith('http') ? url : 'https://' + url;

    if (fs.existsSync(ytPath)) {
      const { processYouTubeUrl } = require(ytPath);
      const result = await processYouTubeUrl(fullUrl, { summarize: false });
      title = result?.title || 'YouTube Video';
      author = result?.author || '';
      transcript = result?.transcript || null;

      // Build a preview from the transcript if available
      if (transcript) {
        const preview = transcript.substring(0, 800).trim();
        summary = preview.length < transcript.length ? preview + '...' : preview;
      } else if (result?.error) {
        summary = result.error;
      } else {
        summary = 'Transcript fetched.';
      }
    } else {
      // Fallback: ask Claude directly (no shared library available)
      const claudeResult = await askClaude({
        prompt: 'Analyze this YouTube video URL: ' + fullUrl + '\nProvide a brief summary of what this video is about.',
        scopeKey: 'yt-' + videoId,
        useResume: false,
      });
      title = 'YouTube Video';
      summary = claudeResult.text || 'No summary available.';
      transcript = null;
    }

    const displayTitle = author ? title + ' — ' + author : title;
    const displaySummary = (summary || 'Transcript fetched.').substring(0, 2000);

    cacheVideo(videoId, {
      title,
      summary: displaySummary,
      transcript,
    });

    const keyboard = new InlineKeyboard()
      .text('Save to Notes', 'yt:save:' + videoId)
      .text('Research', 'yt:research:' + videoId)
      .row()
      .text('Rewrite', 'yt:rewrite:' + videoId)
      .text('PRD Idea', 'yt:prd:' + videoId);

    await ctx.api.editMessageText(
      ctx.chat.id,
      ackMsg.message_id,
      '*' + displayTitle + '*\n\n' + displaySummary,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
  } catch (err) {
    console.error('[TG] YouTube error:', err.message);
    try {
      await ctx.api.editMessageText(ctx.chat.id, ackMsg.message_id, 'Could not fetch video info: ' + err.message);
    } catch {}
  }
}

/**
 * Handle an Instagram URL — fetch metadata/transcript and show action buttons.
 * Uses shared/instagram.js (processInstagramUrl) which spawns the Python library.
 */
async function handleInstagramUrl(ctx, url, shortcode) {
  const ackMsg = await ctx.reply('*Fetching reel info...*', {
    parse_mode: 'Markdown',
    message_thread_id: ctx.message.message_thread_id,
  });

  try {
    const igPath = path.join(__dirname, '..', '..', 'shared', 'instagram.js');
    let caption, transcript, author, summary;

    const fullUrl = url.startsWith('http') ? url : 'https://' + url;

    if (fs.existsSync(igPath)) {
      const { processInstagramUrl } = require(igPath);
      const result = await processInstagramUrl(fullUrl, { mode: 'intel', frames: false });
      author = result?.author ? `@${result.author}` : '';
      caption = result?.caption || '';
      transcript = result?.transcript || null;

      // Build a preview
      const parts = [];
      if (author) parts.push(`*Author:* ${author}`);
      if (result?.likes != null) parts.push(`Likes: ${Number(result.likes).toLocaleString()}`);
      if (result?.views != null) parts.push(`Views: ${Number(result.views).toLocaleString()}`);
      if (caption) parts.push('', caption.substring(0, 600));
      if (transcript) {
        const preview = transcript.substring(0, 400).trim();
        parts.push('', '*Transcript:*', preview + (preview.length < transcript.length ? '...' : ''));
      }
      summary = parts.join('\n') || 'Reel data fetched.';
    } else {
      summary = 'Instagram library not available.';
      caption = '';
      transcript = null;
    }

    const displaySummary = summary.substring(0, 2000);

    cacheReel(shortcode, {
      caption,
      transcript,
      author,
      url: fullUrl,
    });

    const keyboard = new InlineKeyboard()
      .text('Build Guide', 'ig:build:' + shortcode)
      .text('Intel Report', 'ig:intel:' + shortcode)
      .row()
      .text('Save to Brain', 'ig:save:' + shortcode)
      .text('Research', 'ig:research:' + shortcode);

    await ctx.api.editMessageText(
      ctx.chat.id,
      ackMsg.message_id,
      displaySummary,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
  } catch (err) {
    console.error('[TG] Instagram error:', err.message);
    try {
      await ctx.api.editMessageText(ctx.chat.id, ackMsg.message_id, 'Could not fetch reel info: ' + err.message);
    } catch {}
  }
}

/**
 * Process a Claude request in the background (non-blocking).
 * Called fire-and-forget so the webhook can respond immediately.
 */
async function processClaude(bot, { chatId, threadId, ackMessageId, scopeKey, username, content, admin, workspaceName, state, contextBlock, useResume, sessionId }) {
  const startTime = Date.now();
  const jobId = createJob({ chatId, threadId, messageId: ackMessageId, userId: scopeKey.split(':').pop(), query: content });

  // Progress updates every 15s
  const progressInterval = setInterval(async () => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    try {
      await bot.api.editMessageText(chatId, ackMessageId, getProcessingMessage(elapsed), { parse_mode: 'Markdown' });
    } catch {}
  }, 15000);

  const prompt = buildPrompt(username, contextBlock, content, {
    isAdmin: admin,
    workspaceName,
    state,
  });

  try {
    const result = await askClaude({
      prompt,
      scopeKey,
      useResume,
      sessionId,
    });

    clearInterval(progressInterval);
    completeJob(jobId);

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    logAudit('claude-invocation', 'completed', `[${state}] Claude replied (${elapsed}s)`, { username, chatId, state });

    if (result.text && result.text.trim()) {
      let trimmed = result.text.trim();

      // --- Extract <<SEND_FILE:/path>> markers before display ---
      const fileMarkerRegex = /<<SEND_FILE:([^>]+)>>/g;
      const filesToSend = [];
      let match;
      while ((match = fileMarkerRegex.exec(trimmed)) !== null) {
        filesToSend.push(match[1].trim());
      }
      // Strip markers from display text
      trimmed = trimmed.replace(fileMarkerRegex, '').replace(/\n{3,}/g, '\n\n').trim();

      // Record bot response in ring buffer
      recordMessage(scopeKey, 'assistant', 'OPAI Bot', trimmed);

      const chunks = splitMessage(trimmed);
      const threadOpts = threadId !== 'general' ? { message_thread_id: Number(threadId) } : {};

      // Check if this looks like a plan and user is owner — add "Run Dangerously" button
      const userId = scopeKey.split(':').pop();
      const isOwner = getUserRole(Number(userId)) === 'owner';
      const showDangerButton = isOwner && chunks.length === 1 && isPlanLikeResponse(trimmed);

      let dangerKeyboard = undefined;
      if (showDangerButton) {
        const cacheKey = `${chatId}:${ackMessageId}`;
        cacheDangerResponse(cacheKey, trimmed, scopeKey);
        dangerKeyboard = new InlineKeyboard().text('Run Dangerously', `danger:run:${cacheKey}`);
      }

      try {
        await bot.api.editMessageText(chatId, ackMessageId, chunks[0], {
          parse_mode: 'Markdown',
          reply_markup: dangerKeyboard,
        });
      } catch {
        try {
          await bot.api.editMessageText(chatId, ackMessageId, chunks[0], {
            reply_markup: dangerKeyboard,
          });
        } catch {}
      }

      for (let i = 1; i < chunks.length; i++) {
        try {
          await bot.api.sendMessage(chatId, chunks[i], { parse_mode: 'Markdown', ...threadOpts });
        } catch {
          await bot.api.sendMessage(chatId, chunks[i], threadOpts);
        }
      }

      // --- Send extracted files as Telegram documents ---
      if (filesToSend.length > 0) {
        for (const rawPath of filesToSend) {
          try {
            const absPath = path.isAbsolute(rawPath) ? rawPath : path.join(OPAI_ROOT, rawPath);
            const resolved = path.resolve(absPath);
            const check = isFileAllowedForConversation(resolved);
            if (!check.safe) {
              await bot.api.sendMessage(chatId, `File blocked: ${check.reason} (\`${path.basename(resolved)}\`)`, { parse_mode: 'Markdown', ...threadOpts });
              continue;
            }
            if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
              await bot.api.sendMessage(chatId, `File not found: \`${path.basename(rawPath)}\``, { parse_mode: 'Markdown', ...threadOpts });
              continue;
            }
            const stat = fs.statSync(resolved);
            if (stat.size > 50 * 1024 * 1024) {
              await bot.api.sendMessage(chatId, `File too large: \`${path.basename(resolved)}\` (${Math.round(stat.size / 1024 / 1024)}MB, limit 50MB)`, { parse_mode: 'Markdown', ...threadOpts });
              continue;
            }
            await bot.api.sendDocument(chatId, new InputFile(resolved), {
              caption: path.basename(resolved),
              ...threadOpts,
            });
            console.log(`[TG] Sent file: ${path.basename(resolved)} (${stat.size} bytes)`);
          } catch (fileErr) {
            console.error(`[TG] File send error:`, fileErr.message);
            try { await bot.api.sendMessage(chatId, `Failed to send file: ${fileErr.message}`, threadOpts); } catch {}
          }
        }
      }

      console.log(`[TG] Replied (${trimmed.length} chars, ${elapsed}s, state: ${state}${showDangerButton ? ', +danger-btn' : ''}${filesToSend.length ? `, +${filesToSend.length} file(s)` : ''})`);
    } else {
      await bot.api.editMessageText(chatId, ackMessageId, '`No response received.`', { parse_mode: 'Markdown' });
    }
  } catch (err) {
    clearInterval(progressInterval);
    failJob(jobId, err.message);
    console.error(`[TG] Error:`, err.message);
    try { await bot.api.editMessageText(chatId, ackMessageId, `\`Error: ${err.message}\``); } catch {}
  }
}

/**
 * Detect if a Claude response looks like a plan/proposal that could be executed.
 * Must match at least 2 of the heuristics and be from an owner.
 * @param {string} text - Claude response text
 * @returns {boolean}
 */
function isPlanLikeResponse(text) {
  if (!text || text.length < 500) return false;

  let score = 0;

  // Heuristic 1: Contains 3+ numbered list items
  const numberedItems = text.match(/^\s*\d+[\.\)]/gm);
  if (numberedItems && numberedItems.length >= 3) score++;

  // Heuristic 2: Contains plan-related keywords
  const planKeywords = /(?:here'?s (?:a |the )?plan|i'?ll need to|steps:|implementation:|i would|we should|let me|here'?s what|approach:|phase \d)/i;
  if (planKeywords.test(text)) score++;

  // Heuristic 3: Contains file paths
  const filePathPattern = /(?:\/[\w.-]+){2,}(?:\.\w{1,5})?/;
  if (filePathPattern.test(text)) score++;

  // Heuristic 4: Substantial response (> 1000 chars with structure)
  if (text.length > 1000 && (text.includes('```') || text.includes('- '))) score++;

  return score >= 2;
}

/**
 * Register the free-text message handler on the bot.
 * @param {import('grammy').Bot} bot
 */
function registerMessageHandler(bot) {

  bot.on('message:text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;

    // --- Intercept: Pending task creation flow (title, description, custom date) ---
    if (handlePendingTaskInput(ctx, ctx.message.text)) return;

    const userId = ctx.from.id;
    const username = ctx.from.first_name || ctx.from.username || String(userId);
    const chatId = ctx.chat.id;
    const threadId = ctx.message.message_thread_id || 'general';

    // System notification topics (Alerts, Server Status, HITL) are notification-only.
    // Silently ignore text messages — inline button callbacks still work via callbacks.js.
    if (threadId !== 'general' && SYSTEM_TOPICS.has(Number(threadId))) return;

    const scopeKey = buildScopeKey(chatId, threadId, userId);
    const admin = hasPermission(userId, 'admin');
    const content = ctx.message.text;

    // Workspace scoping for forum topics
    let workspaceName = null;
    if (threadId !== 'general') {
      const topicScope = getTopicScope(chatId, threadId);
      if (topicScope && topicScope.workspaceId) {
        if (!hasWorkspaceAccess(userId, topicScope.workspaceId)) {
          return ctx.reply('You do not have access to this workspace topic.');
        }
        workspaceName = topicScope.workspaceName;
      }
    }

    // --- Assistant Mode: selective topic coordinator ---
    if (threadId !== 'general') {
      const { getAssistantMode } = require('../access-control');
      const { handleAssistantMessage } = require('../assistant-mode');
      if (getAssistantMode(chatId, threadId)) {
        return handleAssistantMessage(bot, ctx, {
          chatId, threadId, userId, username, content, workspaceName, admin,
        });
      }
    }

    // YouTube URL detection — intercept before Claude
    const ytMatch = content.match(YT_REGEX);
    if (ytMatch) {
      handleYouTubeUrl(ctx, ytMatch[0], ytMatch[1]).catch(err => console.error('[TG] YouTube bg error:', err.message));
      return;
    }

    // Instagram URL detection — intercept before Claude
    const igMatch = content.match(IG_REGEX);
    if (igMatch) {
      handleInstagramUrl(ctx, igMatch[0], igMatch[1]).catch(err => console.error('[TG] Instagram bg error:', err.message));
      return;
    }

    // --- Email auto-discovery: prompt owner to map new admin group users ---
    const adminGroupId = process.env.ADMIN_GROUP_ID;
    const ownerId = process.env.OWNER_USER_ID;
    if (adminGroupId && String(chatId) === String(adminGroupId) &&
        ownerId && String(userId) !== String(ownerId) &&
        !isUserMapped(userId) && !_discoveryPrompted.has(userId)) {
      _discoveryPrompted.add(userId);
      // Clear after 24h
      setTimeout(() => _discoveryPrompted.delete(userId), 24 * 60 * 60 * 1000);

      const accounts = getEmailAccounts();
      if (accounts.length > 0) {
        const kb = new InlineKeyboard();
        for (const acc of accounts) {
          kb.text(acc.name || acc.email, `email_map:${userId}:${acc.id}`).row();
        }
        kb.text('Skip', `email_map:${userId}:skip`);

        const userName = ctx.from.first_name || ctx.from.username || String(userId);
        // DM the owner
        ctx.api.sendMessage(Number(ownerId),
          `*New user in admin group:* ${userName} (ID: ${userId})\n\nLink them to an email account for notifications?`,
          { parse_mode: 'Markdown', reply_markup: kb }
        ).catch(err => console.error('[TG] Auto-discovery DM failed:', err.message));
      }
    }

    // --- Fast Path: Direct API calls for known workspace intents ---
    // Skip fast path for admin DMs — full Claude conversation takes priority.
    // Fast path is for workspace topics and member queries, not admin comms.
    const isAdminDM = admin && threadId === 'general';

    // Resolve workspace ID from topic binding for scoped queries
    let wsId = null;
    if (threadId !== 'general') {
      const topicScope = getTopicScope(chatId, threadId);
      if (topicScope) wsId = topicScope.workspaceId;
    }

    const intent = !isAdminDM ? detectIntent(content) : null;
    if (intent) {
      console.log(`[TG] [FAST] ${username}: "${content.substring(0, 80)}" -> ${intent.intent} (ws: ${wsId || 'default'})`);
      recordMessage(scopeKey, 'user', username, content);

      try {
        const result = await handleIntent(intent.intent, intent.query, wsId);
        if (result) {
          recordMessage(scopeKey, 'assistant', 'OPAI Bot', result);
          try {
            await ctx.reply(result, { parse_mode: 'Markdown', message_thread_id: ctx.message.message_thread_id });
          } catch {
            // Markdown parse failed — send plain
            await ctx.reply(result, { message_thread_id: ctx.message.message_thread_id });
          }
          console.log(`[TG] [FAST] Replied (${result.length} chars)`);
          return;
        }
        // result was null — fast path couldn't handle it, fall through to Claude
      } catch (err) {
        console.error(`[TG] [FAST] Error:`, err.message);
        // Fall through to Claude
      }
    }

    // --- WordPress Fast Path ---
    const wpIntent = detectWpIntent(content);
    if (wpIntent) {
      console.log(`[TG] [WP-FAST] ${username}: "${content.substring(0, 80)}" -> ${wpIntent.intent}`);
      recordMessage(scopeKey, 'user', username, content);

      try {
        const result = await handleWpIntent(wpIntent.intent);
        if (result) {
          recordMessage(scopeKey, 'assistant', 'OPAI Bot', result);
          try {
            await ctx.reply(result, { parse_mode: 'Markdown', message_thread_id: ctx.message.message_thread_id });
          } catch {
            await ctx.reply(result, { message_thread_id: ctx.message.message_thread_id });
          }
          console.log(`[TG] [WP-FAST] Replied (${result.length} chars)`);
          return;
        }
      } catch (err) {
        console.error(`[TG] [WP-FAST] Error:`, err.message);
        // Fall through to Claude
      }
    }

    // --- Slow Path: Claude CLI for open-ended questions ---
    const { contextBlock, useResume, sessionId, state } = getContextStrategy(scopeKey);
    recordMessage(scopeKey, 'user', username, content);

    console.log(`[TG] [${state}] ${username}: "${content.substring(0, 100)}"`);

    // Send acknowledgment (quick — this is the only await before returning)
    const ackText = `*${getAckMessage(state, content)}*`;
    const ackMsg = await ctx.reply(ackText, {
      parse_mode: 'Markdown',
      message_thread_id: ctx.message.message_thread_id,
    });

    // Fire and forget — Claude runs in background, webhook responds immediately
    processClaude(bot, {
      chatId, threadId: String(threadId), ackMessageId: ackMsg.message_id,
      scopeKey, username, content, admin, workspaceName,
      state, contextBlock, useResume, sessionId,
    }).catch(err => console.error('[TG] Background Claude error:', err.message));
  });
}

/**
 * Register the voice message handler on the bot.
 * Downloads OGG from Telegram, transcribes via Groq Whisper, then feeds into Claude pipeline.
 * @param {import('grammy').Bot} bot
 */
function registerVoiceHandler(bot) {
  bot.on('message:voice', async (ctx) => {
    const userId = ctx.from.id;
    const username = ctx.from.first_name || ctx.from.username || String(userId);
    const chatId = ctx.chat.id;
    const threadId = ctx.message.message_thread_id || 'general';

    // System topics — ignore voice too
    if (threadId !== 'general' && SYSTEM_TOPICS.has(Number(threadId))) return;

    const scopeKey = buildScopeKey(chatId, threadId, userId);
    const admin = hasPermission(userId, 'admin');
    const duration = ctx.message.voice.duration || 0;

    console.log(`[TG] [VOICE] ${username}: voice message (${duration}s)`);

    // Workspace scoping
    let workspaceName = null;
    if (threadId !== 'general') {
      const topicScope = getTopicScope(chatId, threadId);
      if (topicScope && topicScope.workspaceId) {
        if (!hasWorkspaceAccess(userId, topicScope.workspaceId)) {
          return ctx.reply('You do not have access to this workspace topic.');
        }
        workspaceName = topicScope.workspaceName;
      }
    }

    // Send transcription ack
    const ackMsg = await ctx.reply('*Transcribing...*', {
      parse_mode: 'Markdown',
      message_thread_id: ctx.message.message_thread_id,
    });

    try {
      // Download voice file from Telegram
      const file = await ctx.api.getFile(ctx.message.voice.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const res = await fetch(fileUrl);
      if (!res.ok) throw new Error(`Failed to download voice file: ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());

      // Transcribe
      const transcript = await transcribeVoice(buffer);
      if (transcript.error) {
        await ctx.api.editMessageText(chatId, ackMsg.message_id, `Transcription failed: ${transcript.error}`);
        return;
      }

      if (!transcript.text || !transcript.text.trim()) {
        await ctx.api.editMessageText(chatId, ackMsg.message_id, 'Could not transcribe — no speech detected.');
        return;
      }

      const content = transcript.text.trim();
      const langLabel = transcript.language ? ` [${transcript.language}]` : '';

      // Show transcript to user
      await ctx.api.editMessageText(chatId, ackMsg.message_id,
        `*You said${langLabel}:* ${content}`,
        { parse_mode: 'Markdown' }
      );

      console.log(`[TG] [VOICE] Transcribed (${content.length} chars${langLabel}): "${content.substring(0, 80)}"`);

      // Record as user message
      recordMessage(scopeKey, 'user', username, `[voice] ${content}`);

      // --- Fast paths (same as text) ---
      const isAdminDM = admin && threadId === 'general';
      let wsId = null;
      if (threadId !== 'general') {
        const topicScope = getTopicScope(chatId, threadId);
        if (topicScope) wsId = topicScope.workspaceId;
      }

      const intent = !isAdminDM ? detectIntent(content) : null;
      if (intent) {
        try {
          const result = await handleIntent(intent.intent, intent.query, wsId);
          if (result) {
            recordMessage(scopeKey, 'assistant', 'OPAI Bot', result);
            try {
              await ctx.reply(result, { parse_mode: 'Markdown', message_thread_id: ctx.message.message_thread_id });
            } catch {
              await ctx.reply(result, { message_thread_id: ctx.message.message_thread_id });
            }
            return;
          }
        } catch {}
      }

      const wpIntent = detectWpIntent(content);
      if (wpIntent) {
        try {
          const result = await handleWpIntent(wpIntent.intent);
          if (result) {
            recordMessage(scopeKey, 'assistant', 'OPAI Bot', result);
            try {
              await ctx.reply(result, { parse_mode: 'Markdown', message_thread_id: ctx.message.message_thread_id });
            } catch {
              await ctx.reply(result, { message_thread_id: ctx.message.message_thread_id });
            }
            return;
          }
        } catch {}
      }

      // --- Slow path: Claude ---
      const { contextBlock, useResume, sessionId, state } = getContextStrategy(scopeKey);

      const claudeAck = await ctx.reply(`*${getAckMessage(state, content)}*`, {
        parse_mode: 'Markdown',
        message_thread_id: ctx.message.message_thread_id,
      });

      processClaude(bot, {
        chatId, threadId: String(threadId), ackMessageId: claudeAck.message_id,
        scopeKey, username, content, admin, workspaceName,
        state, contextBlock, useResume, sessionId,
      }).catch(err => console.error('[TG] Background Claude (voice) error:', err.message));

    } catch (err) {
      console.error('[TG] [VOICE] Error:', err.message);
      try {
        await ctx.api.editMessageText(chatId, ackMsg.message_id, `Voice processing failed: ${err.message}`);
      } catch {}
    }
  });
}

module.exports = { registerMessageHandler, registerVoiceHandler, splitMessage };
