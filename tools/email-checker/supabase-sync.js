/**
 * Supabase Sync — Optional persistence layer for email-checker data.
 *
 * Syncs local JSON files (email-tasks.json, email-responses.json) to the
 * OPAI Agent System Supabase project. Falls back gracefully if Supabase
 * is not configured.
 *
 * Usage:
 *   node supabase-sync.js          — Sync once
 *   require('./supabase-sync')     — Use as module
 *
 * Requires: SUPABASE_URL and SUPABASE_SERVICE_KEY in .env
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const fs = require('fs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TASKS_FILE = path.join(__dirname, 'data', 'email-tasks.json');
const RESPONSES_FILE = path.join(__dirname, 'data', 'email-responses.json');

let supabase = null;

/**
 * Initialize the Supabase client. Returns null if not configured.
 */
function getClient() {
  if (supabase) return supabase;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return null;
  }

  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    return supabase;
  } catch {
    console.error('[SYNC] @supabase/supabase-js not installed. Run: npm install @supabase/supabase-js');
    return null;
  }
}

/**
 * Check if Supabase sync is available.
 */
function isAvailable() {
  return !!getClient();
}

// ──────────────────────────────────────────────────────────
// Email Sync
// ──────────────────────────────────────────────────────────

/**
 * Sync email metadata from local JSON to Supabase em_emails table.
 */
async function syncEmails() {
  const client = getClient();
  if (!client) return { synced: 0, errors: 0 };

  let data;
  try {
    data = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  } catch {
    return { synced: 0, errors: 0 };
  }

  const emails = data.emails || {};
  let synced = 0;
  let errors = 0;

  for (const [messageId, email] of Object.entries(emails)) {
    try {
      const { error } = await client.from('em_emails').upsert({
        message_id: messageId,
        from_address: email.from,
        from_name: email.fromName,
        subject: email.subject,
        received_at: email.date,
        account_name: email.account,
        tags: email.tags || [],
        priority: email.priority || 'normal',
        urgency: email.urgency || 'standard',
        summary: email.summary || '',
        requires_response: email.requiresResponse || false,
        assignee_hint: email.assigneeHint || 'human',
        response_status: email.responseStatus || 'none',
        processed_at: email.processedAt,
      }, { onConflict: 'message_id' });

      if (error) {
        console.error(`[SYNC] Email upsert error (${messageId}):`, error.message);
        errors++;
      } else {
        synced++;
      }
    } catch (err) {
      console.error(`[SYNC] Email sync error:`, err.message);
      errors++;
    }
  }

  return { synced, errors };
}

// ──────────────────────────────────────────────────────────
// Task Sync
// ──────────────────────────────────────────────────────────

/**
 * Sync tasks from local JSON to Supabase em_tasks table.
 */
async function syncTasks() {
  const client = getClient();
  if (!client) return { synced: 0, errors: 0 };

  let data;
  try {
    data = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  } catch {
    return { synced: 0, errors: 0 };
  }

  const bySender = data.bySender || {};
  let synced = 0;
  let errors = 0;

  for (const [senderEmail, senderData] of Object.entries(bySender)) {
    for (const task of senderData.tasks || []) {
      try {
        const { error } = await client.from('em_tasks').insert({
          sender_email: senderEmail,
          sender_name: senderData.name,
          email_subject: task.emailSubject,
          title: task.task,
          description: task.context || '',
          priority: task.priority || 'normal',
          status: task.status || 'pending',
          assignee_type: task.assignee_type || 'human',
          deadline: task.deadline || null,
          context: task.context || '',
          routing: task.routing || null,
          queue_id: task.queueId || null,
          created_at: task.extractedAt || new Date().toISOString(),
        });

        if (error) {
          // Skip duplicate inserts silently
          if (!error.message.includes('duplicate')) {
            console.error(`[SYNC] Task insert error:`, error.message);
            errors++;
          }
        } else {
          synced++;
        }
      } catch (err) {
        console.error(`[SYNC] Task sync error:`, err.message);
        errors++;
      }
    }
  }

  return { synced, errors };
}

// ──────────────────────────────────────────────────────────
// Response Sync
// ──────────────────────────────────────────────────────────

/**
 * Sync response drafts from local JSON to Supabase em_responses table.
 */
async function syncResponses() {
  const client = getClient();
  if (!client) return { synced: 0, errors: 0 };

  let data;
  try {
    data = JSON.parse(fs.readFileSync(RESPONSES_FILE, 'utf8'));
  } catch {
    return { synced: 0, errors: 0 };
  }

  const responses = data.responses || {};
  let synced = 0;
  let errors = 0;

  for (const [id, resp] of Object.entries(responses)) {
    try {
      const { error } = await client.from('em_responses').upsert({
        id,
        email_message_id: resp.emailMessageId,
        account_name: resp.account,
        to_address: resp.to,
        to_name: resp.toName,
        subject: resp.subject,
        original_body: resp.originalBody,
        initial_draft: resp.initialDraft,
        critique: resp.critique,
        refined_draft: resp.refinedDraft,
        final_content: resp.finalContent,
        status: resp.status,
        created_at: resp.createdAt,
        approved_at: resp.approvedAt,
        sent_at: resp.sentAt,
      }, { onConflict: 'id' });

      if (error) {
        console.error(`[SYNC] Response upsert error (${id}):`, error.message);
        errors++;
      } else {
        synced++;
      }
    } catch (err) {
      console.error(`[SYNC] Response sync error:`, err.message);
      errors++;
    }
  }

  return { synced, errors };
}

// ──────────────────────────────────────────────────────────
// Full Sync
// ──────────────────────────────────────────────────────────

/**
 * Run a full sync of all data to Supabase.
 */
async function syncAll() {
  if (!isAvailable()) {
    console.log('[SYNC] Supabase not configured. Skipping sync.');
    return { available: false };
  }

  console.log('[SYNC] Syncing to Supabase...');

  const [emails, tasks, responses] = await Promise.all([
    syncEmails(),
    syncTasks(),
    syncResponses(),
  ]);

  console.log(`[SYNC] Done: ${emails.synced} emails, ${tasks.synced} tasks, ${responses.synced} responses synced`);
  if (emails.errors + tasks.errors + responses.errors > 0) {
    console.error(`[SYNC] Errors: ${emails.errors} emails, ${tasks.errors} tasks, ${responses.errors} responses`);
  }

  return { available: true, emails, tasks, responses };
}

// ──────────────────────────────────────────────────────────
// CLI Entry Point
// ──────────────────────────────────────────────────────────

if (require.main === module) {
  syncAll().then((result) => {
    if (!result.available) {
      console.log('Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env to enable sync.');
    }
    process.exit(0);
  }).catch((err) => {
    console.error('[SYNC] Fatal:', err.message);
    process.exit(1);
  });
}

module.exports = { syncAll, syncEmails, syncTasks, syncResponses, isAvailable };
