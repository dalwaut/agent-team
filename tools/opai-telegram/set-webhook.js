#!/usr/bin/env node
/**
 * Set Webhook — One-time setup script to register the Telegram webhook.
 *
 * Usage:
 *   node set-webhook.js
 *   npm run set-webhook
 */

require('dotenv').config();
const { Bot } = require('grammy');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://opai.boutabyte.com/telegram/webhook';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN not set in .env');
  process.exit(1);
}

async function main() {
  const bot = new Bot(BOT_TOKEN);

  console.log(`Setting webhook to: ${WEBHOOK_URL}`);

  await bot.api.setWebhook(WEBHOOK_URL, {
    secret_token: WEBHOOK_SECRET || undefined,
    allowed_updates: ['message', 'callback_query', 'my_chat_member'],
    drop_pending_updates: true,
  });

  // Verify
  const info = await bot.api.getWebhookInfo();
  console.log('Webhook info:', JSON.stringify(info, null, 2));

  // Set bot commands (visible in Telegram UI)
  // Admin commands (shown only to owner/admins in DMs)
  await bot.api.setMyCommands([
    { command: 'start', description: 'Welcome message' },
    { command: 'help', description: 'Show all commands' },
    { command: 'status', description: 'Active jobs' },
    { command: 'sessions', description: 'List active conversations' },
    { command: 'label', description: 'Name this conversation' },
    { command: 'reset', description: 'Clear conversation context' },
    { command: 'services', description: 'OPAI service statuses' },
    { command: 'health', description: 'System health (CPU, mem, disk)' },
    { command: 'logs', description: 'Tail service logs' },
    { command: 'task', description: 'Create a task' },
    { command: 'email', description: 'Email management' },
    { command: 'hub', description: 'Team Hub commands' },
    { command: 'persona', description: 'Bot personality' },
    { command: 'role', description: 'User role management' },
    { command: 'topic', description: 'Forum topic workspace binding' },
    { command: 'wp', description: 'WordPress site management' },
    { command: 'briefing', description: 'Morning briefing summary' },
    { command: 'file', description: 'File manager (reports, logs, notes)' },
    { command: 'apps', description: 'Launch Mini Apps (WordPress, etc.)' },
    { command: 'config', description: 'Chat configuration' },
    { command: 'danger', description: 'Execute autonomously (owner only)' },
    { command: 'approve', description: 'Worker approvals & HITL' },
    { command: 'usage', description: 'Claude plan utilization' },
    { command: 'brain', description: '2nd Brain search & inbox' },
    { command: 'tasks', description: 'Task registry management' },
    { command: 'review', description: 'AI-powered log analysis' },
  ]);
  console.log('Bot commands set.');

  console.log('Done!');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
