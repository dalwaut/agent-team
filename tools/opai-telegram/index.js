#!/usr/bin/env node
/**
 * OPAI Telegram Bridge v1
 *
 * grammY-based Telegram bot -> Claude Code CLI (Pro Max, zero API cost).
 *
 * Features:
 *   - Multi-conversation isolation (per chat:topic:user sessions)
 *   - Custom RBAC (owner/admin/member/viewer)
 *   - Forum topic workspace scoping
 *   - Inline keyboard confirmation gates
 *   - Message streaming simulation via editMessageText
 *   - Job tracking with restart recovery
 *   - Conversation memory (2-hour context window)
 *
 * Modes:
 *   - Production: Webhook via Express (port 8110)
 *   - Development: Long polling (no HTTPS needed)
 *
 * Usage:
 *   npm start       — run in production (webhook)
 *   npm run dev     — run in dev (polling)
 */

require('dotenv').config();
const { Bot, webhookCallback } = require('grammy');
const express = require('express');
const { autoRetry } = require('@grammyjs/auto-retry');

const { registerCommands } = require('./handlers/commands');
const { registerMessageHandler, registerVoiceHandler } = require('./handlers/messages');
const { registerCallbacks } = require('./handlers/callbacks');
const { isWhitelisted } = require('./access-control');
const { recoverJobs } = require('./job-manager');
const { CLAUDE_BIN, OPAI_ROOT } = require('./claude-handler');
const { startAlerts, stopAlerts } = require('./alerts');
const { createAuthHandler, requireMiniAppAuth, requireAdmin } = require('./mini-app-auth');
const { createProxyHandler } = require('./mini-app-proxy');

// --- Configuration ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = parseInt(process.env.PORT || '8110', 10);
const IS_DEV = process.env.NODE_ENV !== 'production';

if (!BOT_TOKEN) {
  console.error('[TG] FATAL: TELEGRAM_BOT_TOKEN not set in .env');
  process.exit(1);
}

// --- Bot Setup ---
const bot = new Bot(BOT_TOKEN);

// Auto-retry on rate limits (429 errors)
bot.api.config.use(autoRetry({
  maxRetryAttempts: 3,
  maxDelaySeconds: 10,
}));

// --- Middleware: Whitelist Check ---
// Only whitelisted users can interact with the bot
bot.use(async (ctx, next) => {
  // Allow callback queries (they have their own auth in the handler)
  if (ctx.callbackQuery) return next();

  // Require a user
  if (!ctx.from) return;

  // Check whitelist
  if (!isWhitelisted(ctx.from.id)) {
    // Silently ignore non-whitelisted users in groups
    if (ctx.chat?.type !== 'private') return;
    // In DMs, tell them they need access
    return ctx.reply('You are not whitelisted for OPAI Bot. Contact the admin for access.');
  }

  return next();
});

// --- Middleware: Logging ---
bot.use(async (ctx, next) => {
  if (ctx.message?.text) {
    const user = ctx.from?.first_name || ctx.from?.username || 'unknown';
    const chatType = ctx.chat?.type || 'unknown';
    const threadId = ctx.message.message_thread_id || '-';
    console.log(`[TG] [${chatType}:${threadId}] ${user}: "${ctx.message.text.substring(0, 80)}"`);
  } else if (ctx.message?.voice) {
    const user = ctx.from?.first_name || ctx.from?.username || 'unknown';
    const chatType = ctx.chat?.type || 'unknown';
    const threadId = ctx.message.message_thread_id || '-';
    console.log(`[TG] [${chatType}:${threadId}] ${user}: [voice ${ctx.message.voice.duration}s]`);
  }
  return next();
});

// --- Register Handlers (order matters!) ---
// 1. Commands first (exact match, fast)
registerCommands(bot);

// 2. Callback queries (inline keyboard buttons)
registerCallbacks(bot);

// 3. Voice messages (transcribe → process as text)
registerVoiceHandler(bot);

// 4. Free-text messages last (catch-all)
registerMessageHandler(bot);

// --- Error Handler ---
bot.catch((err) => {
  console.error('[TG] Bot error:', err.message);
  if (err.ctx) {
    try {
      err.ctx.reply('An internal error occurred. Please try again.').catch(() => {});
    } catch {}
  }
});

// --- Startup ---
async function start() {
  console.log('[TG] OPAI Telegram Bridge v1 starting...');
  console.log(`[TG] OPAI root: ${OPAI_ROOT}`);
  console.log(`[TG] Claude CLI: ${CLAUDE_BIN}`);
  console.log(`[TG] Mode: ${IS_DEV ? 'polling (dev)' : 'webhook (production)'}`);

  // Recover interrupted jobs from previous run
  const interrupted = recoverJobs();
  if (interrupted.length > 0) {
    console.log(`[TG] Recovered ${interrupted.length} interrupted job(s)`);
    // Notify users about interrupted jobs (in the correct topic)
    for (const job of interrupted) {
      try {
        const elapsed = Math.round((job.endTime - job.startTime) / 1000);
        const opts = { parse_mode: 'Markdown' };
        if (job.threadId && job.threadId !== 'general') {
          opts.message_thread_id = Number(job.threadId);
        }
        await bot.api.sendMessage(
          job.chatId,
          `*Job interrupted by restart:* "${job.query}" (was running for ${elapsed}s)\nPlease resend your request.`,
          opts,
        );
      } catch (err) {
        console.error(`[TG] Failed to notify interrupted job ${job.id}:`, err.message);
      }
    }
  }

  if (IS_DEV) {
    // Development: long polling (no HTTPS needed)
    console.log('[TG] Starting in polling mode...');
    await bot.start({
      drop_pending_updates: true,
      onStart: () => console.log('[TG] Bot is running (polling mode)'),
    });
  } else {
    // Production: webhook via Express
    const app = express();
    app.use(express.json());

    // Webhook endpoint
    const callbackOpts = WEBHOOK_SECRET ? { secretToken: WEBHOOK_SECRET } : {};
    app.post('/telegram/webhook', webhookCallback(bot, 'express', callbackOpts));

    // Health check
    app.get('/health', (req, res) => res.json({ status: 'ok', service: 'opai-telegram', uptime: process.uptime() }));
    app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'opai-telegram', uptime: process.uptime() }));

    // --- Mini App Auth + API ---
    // Auth endpoint: validate Telegram initData, issue session token
    app.post('/telegram/auth', createAuthHandler(BOT_TOKEN));

    // Mini App API proxy (authenticated)
    const proxy = createProxyHandler();
    app.get('/telegram/api/wp/*', requireMiniAppAuth, requireAdmin, proxy);
    app.post('/telegram/api/wp/*', requireMiniAppAuth, requireAdmin, proxy);
    app.get('/telegram/api/hub/*', requireMiniAppAuth, proxy);
    app.post('/telegram/api/hub/*', requireMiniAppAuth, proxy);

    // Mini App static files
    const path = require('path');
    app.use('/telegram/mini-apps', express.static(path.join(__dirname, 'mini-apps')));
    console.log('[TG] Mini App routes registered (/telegram/auth, /telegram/api/*, /telegram/mini-apps/)');

    app.listen(PORT, '127.0.0.1', () => {
      console.log(`[TG] Webhook server listening on 127.0.0.1:${PORT}`);
      console.log(`[TG] Webhook URL: ${WEBHOOK_URL || 'not set'}`);

      // Start proactive alerts if admin group is configured
      const adminGroupId = process.env.ADMIN_GROUP_ID;
      if (adminGroupId) {
        startAlerts(bot, Number(adminGroupId), {
          alertThreadId: process.env.ALERT_THREAD_ID ? Number(process.env.ALERT_THREAD_ID) : null,
          serverStatusThreadId: process.env.SERVER_STATUS_THREAD_ID ? Number(process.env.SERVER_STATUS_THREAD_ID) : null,
          personalChatId: process.env.PERSONAL_CHAT_ID ? Number(process.env.PERSONAL_CHAT_ID) : null,
          teamGroupId: process.env.WAUTERSEDGE_GROUP_ID ? Number(process.env.WAUTERSEDGE_GROUP_ID) : null,
        });
      }
    });
  }
}

start().catch(err => {
  console.error('[TG] Fatal startup error:', err);
  process.exit(1);
});

// --- Graceful Shutdown ---
process.on('SIGTERM', () => {
  console.log('[TG] Received SIGTERM, shutting down...');
  stopAlerts();
  bot.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[TG] Received SIGINT, shutting down...');
  stopAlerts();
  bot.stop();
  process.exit(0);
});
