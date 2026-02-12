#!/usr/bin/env node
/**
 * OPAI Email Manager — Fetch, classify, extract tasks, draft responses.
 *
 * Modes:
 *   node index.js          — Run continuously on an interval
 *   node index.js --once   — Single check, then exit
 *   require('./index')     — Use as module from Discord bot
 *
 * Outputs:
 *   data/email-tasks.json     — Extracted tasks grouped by sender + email metadata
 *   data/email-responses.json — AI-drafted response queue
 *   data/processed.json       — Dedup tracker (processed Message-IDs)
 *   Console log / Discord webhook notification
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { ImapFlow } = require('imapflow');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const { classifyEmail } = require('./classifier');
const { draftResponse } = require('./response-drafter');
const { saveDraftToAccount, getEnvPrefixForAccount, removeDraftFromAccount, applyTagsToAccount } = require('./sender');

// Try to load work-companion for task routing (optional)
let workCompanion = null;
try { workCompanion = require('../work-companion'); } catch {}

// Try to load task-manager for unified registry (optional)
let taskManager = null;
try { taskManager = require('../../tasks/task-manager'); } catch {}

const CONFIG_FILE = path.join(__dirname, 'config.json');
const PROCESSED_FILE = path.join(__dirname, 'data', 'processed.json');
const TASKS_FILE = path.join(__dirname, 'data', 'email-tasks.json');
const OPAI_ROOT = process.env.OPAI_ROOT || path.resolve(__dirname, '../..');
const DATA_DIR = path.join(__dirname, 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ──────────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────────

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    console.error('[EMAIL] config.json not found. Copy config.example.json → config.json and configure.');
    return null;
  }
}

function getAccountCredentials(account) {
  const prefix = account.env_prefix || '';
  return {
    host: process.env[`IMAP_HOST${prefix}`],
    port: parseInt(process.env[`IMAP_PORT${prefix}`] || '993', 10),
    user: process.env[`IMAP_USER${prefix}`],
    pass: process.env[`IMAP_PASS${prefix}`],
  };
}

// ──────────────────────────────────────────────────────────
// Dedup Tracker
// ──────────────────────────────────────────────────────────

function loadProcessed() {
  try {
    if (fs.existsSync(PROCESSED_FILE)) return JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8'));
  } catch {}
  return { ids: [], lastCheck: null };
}

function saveProcessed(data) {
  // Keep only last 1000 IDs to prevent unbounded growth
  if (data.ids.length > 1000) data.ids = data.ids.slice(-1000);
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function isProcessed(messageId) {
  const data = loadProcessed();
  return data.ids.includes(messageId);
}

function markProcessed(messageId) {
  const data = loadProcessed();
  if (!data.ids.includes(messageId)) data.ids.push(messageId);
  data.lastCheck = new Date().toISOString();
  saveProcessed(data);
}

// ──────────────────────────────────────────────────────────
// Task Storage
// ──────────────────────────────────────────────────────────

function loadTasks() {
  try {
    if (fs.existsSync(TASKS_FILE)) return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  } catch {}
  return { bySender: {}, emails: {}, lastUpdated: null };
}

function saveTasks(tasks) {
  tasks.lastUpdated = new Date().toISOString();
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf8');
}

function addExtractedTasks(senderEmail, senderName, emailSubject, extractedTasks) {
  const data = loadTasks();
  const key = senderEmail.toLowerCase();
  if (!data.bySender[key]) {
    data.bySender[key] = { name: senderName, email: key, tasks: [] };
  }
  for (const task of extractedTasks) {
    data.bySender[key].tasks.push({
      ...task,
      emailSubject,
      extractedAt: new Date().toISOString(),
      status: 'pending',
    });
  }
  saveTasks(data);
  return data.bySender[key].tasks.length;
}

function storeEmailMetadata(email, accountName, classification) {
  const data = loadTasks();
  if (!data.emails) data.emails = {};
  data.emails[email.messageId] = {
    from: email.from,
    fromName: email.fromName,
    subject: email.subject,
    date: email.date,
    account: accountName,
    tags: classification.tags,
    priority: classification.priority,
    urgency: classification.urgency,
    summary: classification.summary,
    requiresResponse: classification.requiresResponse,
    isSystem: classification.isSystem || false,
    needsUserAttention: classification.needsUserAttention || false,
    assigneeHint: classification.assigneeHint,
    responseStatus: classification.isSystem ? 'system' : 'none',
    processedAt: new Date().toISOString(),
  };
  saveTasks(data);
}

function updateResponseStatus(messageId, status) {
  const data = loadTasks();
  if (data.emails && data.emails[messageId]) {
    data.emails[messageId].responseStatus = status;
    saveTasks(data);
  }
}

// ──────────────────────────────────────────────────────────
// IMAP Email Fetching
// ──────────────────────────────────────────────────────────

/**
 * Fetch recent unprocessed emails from an IMAP account.
 *
 * @param {object} account — Account config from config.json
 * @param {number} lookbackHours — How far back to look
 * @returns {Array<{ messageId, from, subject, date, text }>}
 */
async function fetchEmails(account, lookbackHours = 24) {
  const creds = getAccountCredentials(account);

  if (!creds.host || !creds.user || !creds.pass) {
    console.error(`[EMAIL] Missing credentials for account "${account.name}". Check .env`);
    return [];
  }

  const client = new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: true,
    auth: { user: creds.user, pass: creds.pass },
    logger: false,
  });

  const emails = [];

  try {
    await client.connect();
    console.log(`[EMAIL] Connected to ${creds.host} as ${creds.user}`);

    const lock = await client.getMailboxLock(account.mailbox || 'INBOX');

    try {
      // Search for recent emails
      const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
      const searchResults = await client.search({ since });

      if (searchResults.length === 0) {
        console.log(`[EMAIL] No emails found in last ${lookbackHours}h`);
        return [];
      }

      // Limit to max_emails most recent
      const maxEmails = account.max_emails || 20;
      const uids = searchResults.slice(-maxEmails);

      console.log(`[EMAIL] Found ${searchResults.length} emails, processing ${uids.length}`);

      for (const uid of uids) {
        try {
          const msg = await client.fetchOne(uid, {
            envelope: true,
            bodyStructure: true,
            source: true,
          });

          if (!msg || !msg.envelope) continue;

          const messageId = msg.envelope.messageId;
          if (isProcessed(messageId)) continue;

          const from = msg.envelope.from?.[0];
          const senderEmail = from ? `${from.address}` : 'unknown';
          const senderName = from ? (from.name || from.address) : 'Unknown';

          // Apply sender filter
          if (account.watched_senders && account.watched_senders.length > 0) {
            const match = account.watched_senders.some(
              (s) => senderEmail.toLowerCase().includes(s.toLowerCase())
            );
            if (!match) continue;
          }

          // Extract text body from source
          let textBody = '';
          if (msg.source) {
            textBody = extractTextFromSource(msg.source.toString());
          }

          emails.push({
            uid,
            messageId,
            from: senderEmail,
            fromName: senderName,
            subject: msg.envelope.subject || '(no subject)',
            date: msg.envelope.date,
            text: textBody.substring(0, 5000), // Limit to 5KB for Claude
          });
        } catch (err) {
          console.error(`[EMAIL] Error fetching UID ${uid}:`, err.message);
        }
      }
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (err) {
    console.error(`[EMAIL] IMAP error for ${account.name}:`, err.message);
  }

  return emails;
}

/**
 * Extract plain text from raw email source (simplified parser).
 * Handles multipart/alternative by preferring text/plain.
 */
function extractTextFromSource(source) {
  // Try to find text/plain boundary
  const plainMatch = source.match(/Content-Type:\s*text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\n\.\r?\n|$)/i);
  if (plainMatch) {
    return cleanEmailText(plainMatch[1]);
  }

  // Fallback: strip HTML tags from text/html
  const htmlMatch = source.match(/Content-Type:\s*text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\n\.\r?\n|$)/i);
  if (htmlMatch) {
    return cleanEmailText(htmlMatch[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' '));
  }

  // Last resort: take everything after first blank line
  const bodyStart = source.indexOf('\r\n\r\n');
  if (bodyStart > -1) {
    return cleanEmailText(source.substring(bodyStart + 4));
  }

  return source.substring(0, 2000);
}

function cleanEmailText(text) {
  return text
    .replace(/=\r?\n/g, '')           // Quoted-printable soft breaks
    .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')       // Collapse excessive newlines
    .trim();
}

// ──────────────────────────────────────────────────────────
// Task Extraction via Claude CLI
// ──────────────────────────────────────────────────────────

/**
 * Use Claude CLI to extract actionable tasks from an email body.
 *
 * @param {string} from — Sender email
 * @param {string} subject — Email subject
 * @param {string} body — Email text body
 * @returns {Array<{ task, priority, deadline, context }>}
 */
function extractTasks(from, subject, body) {
  return new Promise((resolve) => {
    const prompt = [
      `Extract actionable tasks from this email. Return ONLY a JSON array.`,
      `Each task object: { "task": "description", "priority": "high|normal|low", "deadline": "date or null", "context": "brief context" }`,
      `If no actionable tasks found, return: []`,
      `Do NOT include greetings, sign-offs, or general statements as tasks.`,
      `Only include items that require someone to DO something.`,
      ``,
      `From: ${from}`,
      `Subject: ${subject}`,
      ``,
      `--- EMAIL BODY ---`,
      body,
      `--- END EMAIL ---`,
    ].join('\n');

    const tmpFile = path.join(os.tmpdir(), `opai-email-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, prompt, 'utf8');

    let stdout = '';
    const proc = spawn('claude', ['-p', '--output-format', 'text'], {
      cwd: OPAI_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    const input = fs.createReadStream(tmpFile);
    input.pipe(proc.stdin);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      try { fs.unlinkSync(tmpFile); } catch {}
      console.error('[EMAIL] Claude extraction timed out');
      resolve([]);
    }, 120000); // 2 min timeout for extraction

    proc.on('close', () => {
      clearTimeout(timer);
      try { fs.unlinkSync(tmpFile); } catch {}

      // Parse JSON array from Claude's response
      try {
        const match = stdout.match(/\[[\s\S]*\]/);
        if (match) {
          const tasks = JSON.parse(match[0]);
          if (Array.isArray(tasks)) {
            resolve(tasks);
            return;
          }
        }
      } catch {}

      resolve([]);
    });

    proc.on('error', () => {
      clearTimeout(timer);
      try { fs.unlinkSync(tmpFile); } catch {}
      resolve([]);
    });
  });
}

// ──────────────────────────────────────────────────────────
// Discord Notification
// ──────────────────────────────────────────────────────────

async function notifyDiscord(webhookUrl, summary) {
  if (!webhookUrl) return;

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: summary }),
    });
    if (!response.ok) {
      console.error(`[EMAIL] Discord webhook failed: ${response.status}`);
    }
  } catch (err) {
    console.error(`[EMAIL] Discord notification error:`, err.message);
  }
}

// ──────────────────────────────────────────────────────────
// Main Check Pipeline
// ──────────────────────────────────────────────────────────

/**
 * Process a single email through the AI pipeline:
 *   classify → apply IMAP tags → [if human] extract tasks + route + draft
 *                                [if system] flag user if important, skip drafting
 */
async function processEmail(email, account, config) {
  const result = { tasks: 0, drafted: false, classified: false, isSystem: false, flagged: false, senderInfo: null };

  console.log(`[EMAIL] Processing: "${email.subject}" from ${email.from} (${account.name})`);

  // Step 1: Classify email (tags, priority, urgency, isSystem)
  let classification = null;
  if (config.classify_emails !== false && email.text) {
    console.log(`[EMAIL]   → Classifying...`);
    classification = await classifyEmail(email.from, email.subject, email.text, account.name);
    storeEmailMetadata(email, account.name, classification);
    result.classified = true;
    result.isSystem = classification.isSystem;

    const systemLabel = classification.isSystem ? ' [SYSTEM]' : '';
    const flagLabel = classification.needsUserAttention ? ' ⚠ FLAGGED' : '';
    console.log(`[EMAIL]   → Tags: [${classification.tags.join(', ')}] Priority: ${classification.priority}${systemLabel}${flagLabel}`);
  }

  // Step 2: Apply tags to the actual email on the IMAP server
  if (classification && config.apply_tags_to_account !== false && email.uid) {
    const envPrefix = account.env_prefix || '';
    const mailbox = account.mailbox || 'INBOX';
    console.log(`[EMAIL]   → Applying IMAP tags...`);
    const tagResult = await applyTagsToAccount(
      email.uid, classification.tags, classification.priority,
      classification.isSystem, envPrefix, mailbox
    );
    if (!tagResult.success) {
      console.error(`[EMAIL]   → IMAP tagging failed: ${tagResult.error}`);
    }
  }

  // Step 3: Handle system messages — flag user if important, skip task extraction and drafting
  if (classification?.isSystem) {
    if (classification.needsUserAttention) {
      result.flagged = true;
      console.log(`[EMAIL]   → ⚠ USER ATTENTION NEEDED: ${classification.summary}`);
    } else {
      console.log(`[EMAIL]   → System message — skipping task extraction and response drafting`);
    }
    markProcessed(email.messageId);
    return result;
  }

  // Step 4: Extract actionable tasks (human correspondence only)
  let tasks = [];
  if (config.extract_tasks !== false && email.text) {
    tasks = await extractTasks(email.from, email.subject, email.text);
    console.log(`[EMAIL]   → ${tasks.length} task(s) extracted`);
  }

  // Step 5: Store tasks and route through work-companion
  if (tasks.length > 0) {
    if (classification) {
      for (const task of tasks) {
        task.assignee_type = classification.assigneeHint || 'human';
      }
    }

    if (workCompanion) {
      for (const task of tasks) {
        try {
          const shouldQueue = task.assignee_type === 'agent';
          const wcResult = workCompanion.processTask(task.task, { queue: shouldQueue, source: 'email' });
          task.routing = {
            type: wcResult.classification.type,
            squads: wcResult.routing.squads,
            mode: wcResult.routing.mode,
          };
          if (wcResult.queueId) task.queueId = wcResult.queueId;
        } catch (err) {
          console.error(`[EMAIL]   → Work-companion routing failed: ${err.message}`);
        }
      }
    }

    const count = addExtractedTasks(email.from, email.fromName, email.subject, tasks);
    result.tasks = tasks.length;
    result.senderInfo = { email: email.from, name: email.fromName, taskCount: tasks.length, totalTasks: count };

    // Step 5b: Write tasks to unified registry (tasks/registry.json)
    if (taskManager) {
      for (const task of tasks) {
        try {
          taskManager.addTask({
            title: task.task,
            description: task.context || '',
            source: 'email',
            sourceRef: { sender: email.from, senderName: email.fromName, subject: email.subject, messageId: email.messageId },
            project: task.routing?.type === 'wordpress' ? 'Lace & Pearl' : null,
            assignee: task.assignee_type === 'agent' ? 'agent' : 'human',
            priority: task.priority || (classification?.priority) || 'normal',
            deadline: task.deadline || null,
            routing: task.routing || null,
          });
        } catch (err) {
          console.error(`[EMAIL]   → Registry write failed: ${err.message}`);
        }
      }
    }
  }

  // Step 6: Draft response if needed (never for system messages — already returned above)
  if (config.draft_responses !== false && classification?.requiresResponse) {
    console.log(`[EMAIL]   → Drafting response...`);
    try {
      const responseId = await draftResponse(email, account.name, config.voice_profile || 'boutabyte-professional');
      if (responseId) {
        result.drafted = true;
        updateResponseStatus(email.messageId, 'draft');
        console.log(`[EMAIL]   → Response draft created: ${responseId}`);

        // Step 6b: Save draft to email account's Drafts folder (visible in Gmail app, webmail)
        if (config.save_drafts_to_account !== false) {
          const envPrefix = account.env_prefix || '';
          const { loadResponses } = require('./response-drafter');
          const responses = loadResponses();
          const resp = responses.responses?.[responseId];
          if (resp) {
            console.log(`[EMAIL]   → Saving draft to ${account.name} Drafts folder...`);
            const saveResult = await saveDraftToAccount(resp, envPrefix);
            if (saveResult.success) {
              console.log(`[EMAIL]   → Draft visible in ${saveResult.folder}`);
            } else {
              console.error(`[EMAIL]   → Could not save to Drafts: ${saveResult.error}`);
            }
          }
        }
      }
    } catch (err) {
      console.error(`[EMAIL]   → Response drafting failed: ${err.message}`);
    }
  }

  markProcessed(email.messageId);
  return result;
}

/**
 * Run a full email check: fetch (parallel) → classify → extract tasks → route → draft responses → notify.
 * Returns a summary suitable for display.
 *
 * @param {object} [options]
 * @param {string} [options.mailbox] — Override mailbox for all accounts (e.g., 'INBOX', '[Gmail]/Sent Mail')
 * @param {string[]} [options.folders] — Additional folders to check after INBOX
 * @returns {{ totalEmails, totalTasks, totalDrafts, bySender: [{email, name, taskCount}], summary }}
 */
async function checkEmails(options = {}) {
  const config = loadConfig();
  if (!config) return { totalEmails: 0, totalTasks: 0, totalDrafts: 0, bySender: [], summary: 'No config found.' };

  let totalEmails = 0;
  let totalTasks = 0;
  let totalDrafts = 0;
  let totalClassified = 0;
  let totalSystem = 0;
  let totalFlagged = 0;
  const bySender = [];
  const flaggedAlerts = [];

  // Determine which folders to check
  const foldersToCheck = ['INBOX'];
  if (options.folders) {
    for (const f of options.folders) {
      if (!foldersToCheck.includes(f)) foldersToCheck.push(f);
    }
  }

  for (const folder of foldersToCheck) {
    const isInbox = folder === 'INBOX';
    if (!isInbox) console.log(`\n[EMAIL] ── Expanding to folder: ${folder} ──`);

    // Phase 1: Fetch from ALL accounts in parallel
    console.log(`[EMAIL] Fetching ${isInbox ? 'INBOX' : folder} from ${config.accounts.length} accounts in parallel...`);
    const fetchStart = Date.now();

    const fetchResults = await Promise.all(
      config.accounts.map(async (account) => {
        const accountWithFolder = { ...account, mailbox: options.mailbox || folder };
        console.log(`[EMAIL]   → Connecting: ${account.name}`);
        const emails = await fetchEmails(accountWithFolder, config.lookback_hours || 24);
        console.log(`[EMAIL]   → ${account.name}: ${emails.length} new email(s)`);
        return { account, emails };
      })
    );

    const fetchMs = Date.now() - fetchStart;
    const totalFetched = fetchResults.reduce((sum, r) => sum + r.emails.length, 0);
    console.log(`[EMAIL] Fetched ${totalFetched} email(s) across ${config.accounts.length} accounts in ${(fetchMs / 1000).toFixed(1)}s`);

    // Phase 2: Process emails through AI pipeline (sequential — Claude CLI is the bottleneck)
    for (const { account, emails } of fetchResults) {
      totalEmails += emails.length;

      for (const email of emails) {
        const result = await processEmail(email, account, config);

        if (result.classified) totalClassified++;
        if (result.isSystem) totalSystem++;
        if (result.flagged) {
          totalFlagged++;
          flaggedAlerts.push({ from: email.from, subject: email.subject, account: account.name });
        }
        totalTasks += result.tasks;
        if (result.drafted) totalDrafts++;
        if (result.senderInfo) bySender.push(result.senderInfo);
      }
    }
  }

  // Build summary
  const lines = [];
  if (totalEmails === 0) {
    lines.push('No new emails to process.');
  } else {
    const humanCount = totalEmails - totalSystem;
    lines.push(`**Email Check Complete:** ${totalEmails} email(s) processed (${humanCount} human, ${totalSystem} system), ${totalTasks} task(s), ${totalDrafts} draft(s).`);

    if (flaggedAlerts.length > 0) {
      lines.push(`\n**⚠ ${totalFlagged} FLAGGED ALERT(S) — needs your attention:**`);
      for (const alert of flaggedAlerts) {
        lines.push(`  - [${alert.account}] "${alert.subject}" from ${alert.from}`);
      }
    }

    if (bySender.length > 0) {
      lines.push(`\n**Tasks by sender:**`);
      for (const s of bySender) {
        lines.push(`- ${s.name} (${s.email}): ${s.taskCount} new task(s)`);
      }
    }

    if (totalDrafts > 0) {
      lines.push(`\n${totalDrafts} response draft(s) awaiting review.`);
    }
  }
  const summary = lines.join('\n');

  // Discord notification (also notify on flagged alerts)
  if ((totalTasks > 0 || totalDrafts > 0 || totalFlagged > 0) && config.notifications?.discord_webhook_url) {
    await notifyDiscord(config.notifications.discord_webhook_url, summary);
  }

  console.log(`[EMAIL] Done: ${totalEmails} emails (${totalSystem} system, ${totalFlagged} flagged), ${totalClassified} classified, ${totalTasks} tasks, ${totalDrafts} drafts`);
  return { totalEmails, totalTasks, totalDrafts, totalClassified, totalSystem, totalFlagged, flaggedAlerts, bySender, summary };
}

// ──────────────────────────────────────────────────────────
// CLI Entry Point
// ──────────────────────────────────────────────────────────

// Common additional folders to expand into
const EXPAND_FOLDERS = [
  '[Gmail]/Sent Mail', '[Gmail]/All Mail',     // Gmail
  'Sent', 'INBOX.Sent', 'Sent Items',          // Hostinger / generic
  'Drafts', 'INBOX.Drafts',
];

if (require.main === module) {
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const expand = args.includes('--expand');

  async function run() {
    const options = {};
    if (expand) options.folders = EXPAND_FOLDERS;

    const result = await checkEmails(options);
    console.log('\n' + result.summary);

    if (once && !expand && result.totalEmails > 0) {
      console.log('\nTip: Run with --expand to also check Sent, Drafts, and All Mail folders.');
    }
    return result;
  }

  if (once) {
    run().then(() => process.exit(0)).catch((err) => {
      console.error('[EMAIL] Fatal:', err.message);
      process.exit(1);
    });
  } else {
    const config = loadConfig();
    const interval = (config?.check_interval_minutes || 30) * 60 * 1000;

    console.log(`[EMAIL] Starting email checker (interval: ${config?.check_interval_minutes || 30}min)`);
    run(); // First check immediately

    setInterval(run, interval);

    process.on('SIGINT', () => {
      console.log('\n[EMAIL] Shutting down.');
      process.exit(0);
    });
  }
}

module.exports = {
  checkEmails,
  fetchEmails,
  extractTasks,
  loadTasks,
  loadConfig,
  storeEmailMetadata,
  updateResponseStatus,
};
