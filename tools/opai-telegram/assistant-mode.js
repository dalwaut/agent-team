/**
 * Assistant Mode — Selective topic coordinator for workspace-bound topics.
 *
 * Instead of responding to every message (normal mode), assistant mode only
 * responds when:
 *   - Directly addressed ("OP ...", @mention)
 *   - Work-related content detected (task, deadline, blocker, etc.)
 *   - Quick greeting/thanks/farewell (canned instant response)
 *   - Short ambiguous message with "?" (nudge, rate-limited)
 *
 * Everything else is silently absorbed into the shared topic buffer.
 *
 * SECURITY: Workspace-bound topics use a HARD-LOCKED prompt that restricts
 * Claude to Team Hub API operations ONLY. No filesystem, no system commands,
 * no general knowledge queries. This prevents AI/injection-based intrusion.
 *
 * Shared buffer scope key: chatId:threadId:assistant
 * Per-user scope key: chatId:threadId:userId (normal)
 */

const { askClaude, OPAI_ROOT } = require('./claude-handler');
const { getContextStrategy, recordMessage, buildScopeKey, formatRecentContext } = require('./conversation-state');
const { createJob, completeJob, failJob } = require('./job-manager');
const { detectIntent, handleIntent } = require('./teamhub-fast');
const { getTopicScope } = require('./access-control');
const { logAudit } = require('./handlers/utils');

const MAX_MESSAGE_LENGTH = 4096;

// --- Nudge rate limiter (in-memory, 1 per user per 5 min) ---
const _nudgeCooldown = new Map();
const NUDGE_COOLDOWN_MS = 5 * 60 * 1000;

// --- Message Classifier ---

const WORK_KEYWORDS = /\b(task|deadline|status|update|blocker|sprint|overdue|milestone|progress|assign|priority|due|blocked|standup|backlog|release|deploy|bug|issue|ticket|done|complete|in.progress|review|merge|ship|estimate|roadmap|goal|action.item|follow.up|sync|postpone|reschedule|delay|defer)\b/i;

const GREETING_PATTERNS = /^(hi|hey|hello|howdy|morning|good morning|good afternoon|good evening|gm|yo|sup|what'?s up|hola)\b/i;
const THANKS_PATTERNS = /^(thanks|thank you|thx|ty|cheers|appreciated|much appreciated)\b/i;
const FAREWELL_PATTERNS = /^(bye|goodbye|later|see you|see ya|cya|gtg|gotta go|night|good night|gn)\b/i;

/**
 * Classify a message into tiers.
 * @param {string} text - Raw message text
 * @param {object} ctx - grammY context (for @mention detection)
 * @returns {{ tier: string, subtype?: string }}
 */
function classifyMessage(text, ctx) {
  const trimmed = text.trim();

  // Tier 1: Direct address — OP prefix or @mention
  if (/^OP[\s,:!]/i.test(trimmed) || /^hey\s+op\b/i.test(trimmed) || /^yo\s+op\b/i.test(trimmed)) {
    return { tier: 'op' };
  }
  if (ctx?.message?.entities) {
    const botUsername = ctx.me?.username;
    for (const ent of ctx.message.entities) {
      if (ent.type === 'mention' && botUsername) {
        const mention = text.substring(ent.offset, ent.offset + ent.length);
        if (mention.toLowerCase() === `@${botUsername.toLowerCase()}`) {
          return { tier: 'op' };
        }
      }
    }
  }

  // Tier 2: Work-related keywords (including mutation verbs)
  if (WORK_KEYWORDS.test(trimmed)) {
    return { tier: 'work' };
  }

  // Tier 3: Quick greeting/thanks/farewell
  if (GREETING_PATTERNS.test(trimmed)) return { tier: 'quick', subtype: 'greeting' };
  if (THANKS_PATTERNS.test(trimmed)) return { tier: 'quick', subtype: 'thanks' };
  if (FAREWELL_PATTERNS.test(trimmed)) return { tier: 'quick', subtype: 'farewell' };

  // Tier 4: Any question (contains ?) — respond in workspace topics
  if (trimmed.includes('?')) {
    return { tier: 'work' };
  }

  // Tier 5: Longer messages (5+ words) — likely conversational, respond
  const words = trimmed.split(/\s+/).length;
  if (words >= 5) {
    return { tier: 'work' };
  }

  // Tier 6: Short ambiguous messages — silent
  return { tier: 'silent' };
}

// --- Canned Responses ---

const QUICK_RESPONSES = {
  greeting: [
    "Hey! I'm here if you need anything. Just say OP!",
    "Hi there! Need something? Just start with OP.",
    "Hello! Watching the workspace — ping me with OP anytime.",
  ],
  thanks: [
    "Anytime!",
    "No problem!",
    "You got it!",
    "Happy to help!",
  ],
  farewell: [
    "See you! I'll keep an eye on things.",
    "Later! I'm still here if anything comes up.",
    "Catch you later — workspace is in good hands.",
  ],
};

const NUDGE_RESPONSES = [
  "Need something? Just say OP and I'm on it!",
  "I'm here! Start your message with OP if you need me.",
  "Ping me with OP if you want me to jump in.",
];

function getQuickResponse(subtype) {
  const pool = QUICK_RESPONSES[subtype] || QUICK_RESPONSES.greeting;
  return pool[Math.floor(Math.random() * pool.length)];
}

function getNudgeResponse() {
  return NUDGE_RESPONSES[Math.floor(Math.random() * NUDGE_RESPONSES.length)];
}

// --- Prompt Builders ---

/**
 * Build a HARD-LOCKED TeamHub-only prompt for workspace-bound topics.
 * Claude can ONLY perform Team Hub API operations — no filesystem, no system
 * commands, no general knowledge, no other services.
 *
 * This is a SECURITY boundary to prevent AI/hacker intrusion via topic messages.
 */
function buildLockedTeamHubPrompt(username, contextBlock, userMessage, workspaceName, workspaceId) {
  const wsParam = workspaceId ? `workspace_id=${workspaceId}` : '';
  const lines = [
    `You are OP — a Team Hub assistant for the "${workspaceName}" workspace.`,
    `You are responding to "${username}" in a Telegram group topic.`,
    '',
    'HARD SECURITY LOCK — READ CAREFULLY:',
    'You are in a WORKSPACE-LOCKED topic. You may ONLY perform Team Hub operations.',
    '',
    'FORBIDDEN (absolute — no exceptions):',
    '- Do NOT access the filesystem (no reading files, no ls, no cat, no writing)',
    '- Do NOT run system commands (no bash, no shell, no scripts)',
    '- Do NOT access other services, APIs, or databases directly',
    '- Do NOT discuss system internals, infrastructure, or code',
    '- Do NOT execute code or run processes',
    '- If asked to do any of the above, politely decline and explain this is a workspace topic',
    '',
    'ALLOWED (Team Hub operations ONLY):',
    `- The Team Hub API is at http://127.0.0.1:8089/api/internal`,
    `- All queries use ${wsParam ? wsParam : 'the current workspace'}`,
    '',
    'Available endpoints (use curl via bash ONLY for these):',
    `- GET  /list-items?${wsParam}&limit=N — List items`,
    `- GET  /search-items?${wsParam}&q=QUERY — Search items`,
    `- GET  /get-item?item_id=ID — Get item details with comments`,
    `- PATCH /update-item?item_id=ID&status=VALUE&priority=VALUE&due_date=VALUE — Update item`,
    `- POST /assign-item?item_id=ID&assignee_id=USER_ID — Assign item`,
    `- GET  /workspace-summary?${wsParam} — Workspace overview`,
    '',
    'Supported update fields: title, description, status, priority, due_date, follow_up_date',
    'Status values: open, in-progress, in-review, blocked, done, closed',
    'Priority values: low, medium, high, critical, urgent',
    'Pass "none" as due_date value to clear a due date.',
    '',
    'When a user asks to modify an item:',
    '1. Search for the item by title or keywords',
    '2. If multiple matches, confirm which item they mean',
    '3. Apply the requested change via PATCH /update-item',
    '4. Show the updated item details to confirm',
    '',
    'Personality:',
    '- Friendly, concise, and helpful — like a great project manager',
    '- Address people by name',
    '- Keep responses under 3000 chars, Telegram-friendly',
    '- Use Telegram markdown: *bold*, `code`, - lists',
  ];

  if (contextBlock) {
    lines.push('', contextBlock);
  }

  lines.push('', `User message: ${userMessage}`);
  return lines.join('\n');
}

/**
 * Build an open coordinator prompt (for topics WITHOUT workspace binding).
 * Used for general/non-locked topics where the bot acts as a coordinator
 * with full OPAI access.
 */
function buildCoordinatorPrompt(username, contextBlock, userMessage, workspaceName) {
  const lines = [
    `You are OP — a friendly project coordinator for the "${workspaceName}" Team Hub workspace.`,
    `You are responding to "${username}" in a Telegram group topic.`,
    '',
    'Personality:',
    '- Friendly, concise, and helpful — like a great project manager',
    '- Address people by name',
    '- You are NOT an admin — you are a coordinator who helps the team stay organized',
    '- Keep responses under 3000 chars, Telegram-friendly',
    '- Use Telegram markdown: *bold*, `code`, - lists',
    '',
    `The Team Hub API is at http://127.0.0.1:8089. Use it to look up tasks, notes, ideas, and workspace status for this workspace.`,
    `When someone asks about tasks, notes, or items — they mean Team Hub items for "${workspaceName}".`,
    '',
    `OPAI workspace: ${OPAI_ROOT}. Wiki docs: Library/opai-wiki/. Config: config/.`,
    'Only use filesystem tools if the user explicitly asks for system-level info.',
    'For simple questions, just respond directly without using tools.',
  ];

  if (contextBlock) {
    lines.push('', contextBlock);
  }

  lines.push('', `User message: ${userMessage}`);
  return lines.join('\n');
}

// --- Message Splitter (matches messages.js) ---

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

function getProcessingMessage(elapsed) {
  if (elapsed < 15) return '*Working on it...*';
  if (elapsed < 30) return `*Still working...* (${formatElapsed(elapsed)})`;
  if (elapsed < 60) return `*Deeper analysis in progress...* (${formatElapsed(elapsed)})`;
  if (elapsed < 120) return `*This one's taking a bit — hang tight.* (${formatElapsed(elapsed)})`;
  if (elapsed < 180) return `*Complex task — still running. I'll update you when complete.* (${formatElapsed(elapsed)})`;
  return `*Still working on this — will notify you when done.* (${formatElapsed(elapsed)})`;
}

// --- Claude Fire-and-Forget ---

async function processAssistantClaude(bot, { chatId, threadId, ackMessageId, scopeKey, username, content, workspaceName, workspaceId, isLocked, state, contextBlock, useResume, sessionId }) {
  const startTime = Date.now();
  const jobId = createJob({ chatId, threadId, messageId: ackMessageId, userId: scopeKey.split(':').pop(), query: content });

  const progressInterval = setInterval(async () => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    try {
      await bot.api.editMessageText(chatId, ackMessageId, getProcessingMessage(elapsed), { parse_mode: 'Markdown' });
    } catch {}
  }, 15000);

  // Choose prompt based on workspace lock status
  const prompt = isLocked
    ? buildLockedTeamHubPrompt(username, contextBlock, content, workspaceName, workspaceId)
    : buildCoordinatorPrompt(username, contextBlock, content, workspaceName);

  const label = isLocked ? 'LOCKED' : 'COORD';

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
    logAudit('assistant-claude', 'completed', `[${state}][${label}] Replied (${elapsed}s)`, { username, chatId, state, isLocked });

    if (result.text && result.text.trim()) {
      const trimmed = result.text.trim();

      // Record to shared assistant buffer
      const sharedKey = `${chatId}:${threadId}:assistant`;
      recordMessage(sharedKey, 'assistant', 'OP', trimmed);

      const chunks = splitMessage(trimmed);
      const threadOpts = threadId !== 'general' ? { message_thread_id: Number(threadId) } : {};

      try {
        await bot.api.editMessageText(chatId, ackMessageId, chunks[0], { parse_mode: 'Markdown' });
      } catch {
        try { await bot.api.editMessageText(chatId, ackMessageId, chunks[0]); } catch {}
      }

      for (let i = 1; i < chunks.length; i++) {
        try {
          await bot.api.sendMessage(chatId, chunks[i], { parse_mode: 'Markdown', ...threadOpts });
        } catch {
          await bot.api.sendMessage(chatId, chunks[i], threadOpts);
        }
      }

      console.log(`[TG] [ASST] [${label}] Replied (${trimmed.length} chars, ${elapsed}s, state: ${state})`);
    } else {
      await bot.api.editMessageText(chatId, ackMessageId, '`No response received.`', { parse_mode: 'Markdown' });
    }
  } catch (err) {
    clearInterval(progressInterval);
    failJob(jobId, err.message);
    console.error(`[TG] [ASST] [${label}] Error:`, err.message);
    try { await bot.api.editMessageText(chatId, ackMessageId, `\`Error: ${err.message}\``); } catch {}
  }
}

// --- Main Handler ---

/**
 * Handle a message in assistant mode.
 * @param {import('grammy').Bot} bot
 * @param {import('grammy').Context} ctx
 * @param {object} opts
 */
async function handleAssistantMessage(bot, ctx, opts) {
  const { chatId, threadId, userId, username, content, workspaceName } = opts;

  // Shared assistant buffer key
  const sharedKey = `${chatId}:${threadId}:assistant`;
  // Per-user key (so their personal context survives if assistant mode is turned off)
  const userKey = buildScopeKey(chatId, threadId, userId);

  // Record to both buffers
  recordMessage(sharedKey, 'user', username, content);
  recordMessage(userKey, 'user', username, content);

  // Determine workspace binding (security boundary)
  const topicScope = getTopicScope(chatId, threadId);
  const wsId = topicScope?.workspaceId || null;
  const isLocked = !!wsId; // Workspace-bound topics are HARD LOCKED

  // Classify
  const { tier, subtype } = classifyMessage(content, ctx);
  console.log(`[TG] [ASST] ${username}: "${content.substring(0, 80)}" -> ${tier}${subtype ? ':' + subtype : ''} [${isLocked ? 'LOCKED' : 'open'}]`);

  // --- Route by tier ---

  if (tier === 'op' || tier === 'work') {
    // Strip "OP" prefix for cleaner query
    let cleanContent = content;
    if (tier === 'op') {
      cleanContent = content.replace(/^(OP[\s,:!]+|hey\s+op[\s,:!]*|yo\s+op[\s,:!]*)/i, '').trim() || content;
    }

    // Try fast-path first (Team Hub direct API)
    const intent = detectIntent(cleanContent);

    if (intent) {
      console.log(`[TG] [ASST] [FAST] "${cleanContent.substring(0, 60)}" -> ${intent.intent}${intent.action ? ':' + intent.action : ''}`);
      try {
        // Pass all parsed data from intent detection to the handler
        const result = await handleIntent(intent.intent, intent.query, wsId, intent);
        if (result) {
          recordMessage(sharedKey, 'assistant', 'OP', result);
          try {
            await ctx.reply(result, { parse_mode: 'Markdown', message_thread_id: ctx.message.message_thread_id });
          } catch {
            await ctx.reply(result, { message_thread_id: ctx.message.message_thread_id });
          }
          console.log(`[TG] [ASST] [FAST] Replied (${result.length} chars)`);
          return;
        }
      } catch (err) {
        console.error(`[TG] [ASST] [FAST] Error:`, err.message);
      }
    }

    // Fall through to Claude — locked or open depending on workspace binding
    const { contextBlock: strategyContext, useResume, sessionId, state } = getContextStrategy(sharedKey);

    // Always inject last 5 messages as topic context, regardless of state.
    // In ACTIVE state, getContextStrategy returns empty (relies on --resume),
    // but we still want recent messages visible in the prompt for continuity.
    const recentContext = formatRecentContext(sharedKey, 5);
    const contextBlock = [recentContext, strategyContext].filter(Boolean).join('\n\n');

    const ackMsg = await ctx.reply('*On it...*', {
      parse_mode: 'Markdown',
      message_thread_id: ctx.message.message_thread_id,
    });

    processAssistantClaude(bot, {
      chatId, threadId: String(threadId), ackMessageId: ackMsg.message_id,
      scopeKey: sharedKey, username, content: cleanContent,
      workspaceName, workspaceId: wsId, isLocked,
      state, contextBlock, useResume, sessionId,
    }).catch(err => console.error('[TG] [ASST] Background Claude error:', err.message));
    return;
  }

  if (tier === 'quick') {
    const response = getQuickResponse(subtype);
    recordMessage(sharedKey, 'assistant', 'OP', response);
    await ctx.reply(response, { message_thread_id: ctx.message.message_thread_id });
    return;
  }

  if (tier === 'unsure') {
    // Rate-limited nudge: 1 per user per 5 min
    const cooldownKey = `${chatId}:${threadId}:${userId}`;
    const lastNudge = _nudgeCooldown.get(cooldownKey) || 0;
    if (Date.now() - lastNudge > NUDGE_COOLDOWN_MS) {
      _nudgeCooldown.set(cooldownKey, Date.now());
      const response = getNudgeResponse();
      recordMessage(sharedKey, 'assistant', 'OP', response);
      await ctx.reply(response, { message_thread_id: ctx.message.message_thread_id });
    }
    return;
  }

  // tier === 'silent' — just absorb. Message already recorded to buffers above.
}

module.exports = {
  classifyMessage,
  handleAssistantMessage,
  getQuickResponse,
  getNudgeResponse,
  buildCoordinatorPrompt,
  buildLockedTeamHubPrompt,
};
