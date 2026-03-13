/**
 * ARL Engine — Agent Response Loop pipeline orchestrator
 *
 * Flow: email arrives → parseIntent → match skills → execute plan →
 *       synthesize response → send reply → track conversation
 *
 * Triggered from agent-core.js when:
 *   1. Email is from a whitelisted ARL sender
 *   2. ARL is enabled in arl-skills.json
 *   3. Intent is detected (confidence > 0)
 *
 * Two entry modes:
 *   - Fresh email: full pipeline (parse → plan → execute → respond)
 *   - Follow-up reply: re-enter pipeline with conversation context
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const { parseIntent } = require('./arl-intent-parser');
const { executePlan, getSkillById, getArlConfig } = require('./arl-skill-runner');
const {
  startConversation, getConversation, isActiveConversation,
  logArlExecution,
} = require('./arl-conversation');
const { logAction } = require('./action-logger');
const { logAudit } = require('../shared/audit');
const { resolveUser, canPerform } = require('./user-resolver');
const { classifyEmail } = require('../email-checker/classifier');
const { applyLabelsToAccount } = require('../email-checker/sender');
const { getCapabilitiesForAccount } = require('./mode-engine');

const SKILLS_PATH = path.join(__dirname, 'arl-skills.json');
const CONFIG_PATH = path.join(__dirname, 'config.json');

// ── Layer 4: Global outbound rate limiter ──────────────────
// Tracks ARL sends per hour across ALL accounts. Resets hourly.
const MAX_ARL_SENDS_PER_HOUR = 30;
const _arlSendTracker = { count: 0, hourStart: Date.now() };

// NOTE: Layer 1 AI-sent detection is now handled universally in agent-core.js (Step 0.5)
// using a file-persisted tracker (data/ai-sent-tracker.json) that survives restarts.

// ── Layer 5: Thread dedup tracker ────────────────────────
// Only allow 1 ARL reply per unique thread per cycle.
// Key = normalized(sender + subject), Value = timestamp of last reply.
// Also persists across cycles to prevent re-replying to old threads.
const _arlRepliedThreads = new Map();
const THREAD_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour cooldown between replies to same thread

function loadSkillsConfig() {
  try { return JSON.parse(fs.readFileSync(SKILLS_PATH, 'utf8')); }
  catch { return { arlEnabled: false }; }
}

function loadAccountConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return { accounts: [] }; }
}

/**
 * Check if ARL should handle this email.
 * Returns true if ARL is enabled and the sender is whitelisted.
 */
function shouldProcessArl(email, account) {
  const config = loadSkillsConfig();
  if (!config.arlEnabled) return false;

  // ARL processes emails on the Paradise agent account (primary ARL inbox)
  // and dallas@paradisewebfl.com when enabled
  const arlAccounts = ['arl-agent-pw', 'arl-dallas-pw'];
  if (!arlAccounts.includes(account.id)) return false;

  return true;
}

/**
 * Main ARL pipeline — process an email through intent → skills → response.
 *
 * @param {object} email - { messageId, fromAddress, from, subject, body, uid, folder, inReplyTo }
 * @param {object} account - Account object from config.json
 * @returns {{ handled: boolean, response?: string, skillResults?: object[], error?: string }}
 */
async function processArlEmail(email, account) {
  const start = Date.now();
  const sender = email.fromAddress || '';
  const label = account.name || account.email;

  console.log(`[ARL] [${label}] Processing email from ${sender}: "${email.subject}"`);

  // NOTE: Layer 1 (AI-sent detection) is now handled universally in agent-core.js Step 0.5.
  // By the time we reach here, the email has already passed the AI-sent check.

  // ── Layer 5: Thread dedup — max 1 ARL reply per thread per hour ──
  // Prevents the agent from replying to multiple emails in the same thread
  // in one cycle (e.g., 8 old emails in "Re: Response issues").
  const threadKey = `${sender.toLowerCase()}|${email.subject.replace(/^(Re:\s*)+/gi, '').trim().toLowerCase()}`;
  const lastReply = _arlRepliedThreads.get(threadKey);
  if (lastReply && (Date.now() - lastReply) < THREAD_COOLDOWN_MS) {
    console.log(`[ARL] [${label}] BLOCKED: thread dedup — already replied to "${email.subject}" from ${sender} within cooldown`);
    logAction({
      accountId: account.id,
      action: 'arl-thread-dedup',
      emailId: email.messageId,
      sender,
      subject: email.subject,
      reasoning: `[${label}] Thread dedup: already replied to this thread within ${THREAD_COOLDOWN_MS / 60000}min cooldown`,
      mode: 'arl',
    });
    return { handled: true }; // handled:true so agent-core skips it entirely
  }

  // ── Layer 3: Reply-chain depth limit — cap runaway threads ──
  const reDepth = (email.subject.match(/Re:/gi) || []).length;
  const MAX_REPLY_DEPTH = 3;
  if (reDepth > MAX_REPLY_DEPTH) {
    console.log(`[ARL] [${label}] BLOCKED: reply chain depth ${reDepth} exceeds limit ${MAX_REPLY_DEPTH}`);
    logAction({
      accountId: account.id,
      action: 'arl-depth-block',
      emailId: email.messageId,
      sender,
      subject: email.subject,
      reasoning: `[${label}] Blocked: reply depth ${reDepth} > max ${MAX_REPLY_DEPTH}`,
      mode: 'arl',
    });
    return { handled: false };
  }

  // ── Step 0: Resolve user identity ──
  const user = resolveUser(sender);
  if (user) {
    console.log(`[ARL] [${label}] User resolved: ${user.name} (${user.role})`);
  }

  // ── Step 0.5: Classify + Tag (same as normal pipeline Steps 2-3) ──
  const caps = getCapabilitiesForAccount(account);
  let classification = null;
  if (caps.classify) {
    try {
      classification = await classifyEmail(
        email.from, email.subject, email.body || '', account.name || 'Agent'
      );
      logAction({
        accountId: account.id, action: 'classify',
        emailId: email.messageId, sender, subject: email.subject,
        reasoning: `[${label}] Classified: tags=[${(classification.labels || []).join(', ')}], priority=${classification.priority}, urgency=${classification.urgency}`,
        mode: 'arl', details: { classification },
      });
    } catch (err) {
      console.error(`[ARL] [${label}] Classification error (non-fatal):`, err.message);
    }
  }
  if (caps.label && classification) {
    try {
      const { setEnvBridgeForAccount } = require('./agent-core');
      setEnvBridgeForAccount(account);
      await applyLabelsToAccount(
        email.uid, classification.labels || [], classification.priority || 'normal',
        classification.isSystem || false, '', email.folder || 'INBOX'
      );
      logAction({
        accountId: account.id, action: 'label',
        emailId: email.messageId, sender, subject: email.subject,
        reasoning: `[${label}] Applied IMAP labels: ${(classification.labels || []).join(', ')}`,
        mode: 'arl',
      });
    } catch (labelErr) {
      console.error(`[ARL] [${label}] Label error (non-fatal):`, labelErr.message);
    }
  }

  // ── Step 1: Check for follow-up in active conversation ──
  const existingConv = getConversation(sender);
  const isFollowUp = !!existingConv;

  if (isFollowUp) {
    console.log(`[ARL] [${label}] Follow-up detected (turn ${existingConv.turns + 1}) from ${sender}`);
  }

  // ── Step 2: Parse intent ──
  const intent = parseIntent(email);

  if (!intent.detected && !isFollowUp) {
    if (user) {
      // Known internal user — always respond, fallback to research skill
      console.log(`[ARL] [${label}] No specific intent from known user ${user.name} — defaulting to research skill`);
      intent.detected = true;
      intent.intents = ['research'];
      intent.matchedSkills = ['research'];
      intent.confidence = 0.5;
    } else {
      console.log(`[ARL] [${label}] No actionable intent detected from unknown sender — skipping ARL`);
      return { handled: false };
    }
  }

  // For follow-ups with no explicit intent, use the previous conversation's skills
  let skillIds = intent.matchedSkills.length > 0
    ? intent.matchedSkills
    : (isFollowUp && existingConv.skillResults?.length > 0
      ? existingConv.skillResults.map(r => r.skillId).filter(Boolean)
      : ['research']); // fallback to research skill

  // Permission check: non-admin users can't run system-change directly
  // (it still goes through Telegram gate, but we enforce the check)
  if (user && !canPerform(user, 'system-change') && skillIds.includes('system-change')) {
    // Still allowed — but it goes through gate anyway
    console.log(`[ARL] [${label}] User ${user.name} system change request — routing through Telegram gate`);
  }

  // If remember-context is in the skill list, handle it first to load chain context
  let chainContext = '';
  if (skillIds.includes('remember-context')) {
    try {
      const { fetchChainEmails, buildChainContext } = require('./chain-context');
      const chainEmails = await fetchChainEmails(account, email, 5);
      chainContext = buildChainContext(chainEmails);
      console.log(`[ARL] [${label}] Chain context loaded: ${chainEmails.length} prior emails`);
      // Remove remember-context from execution list — it's been handled
      skillIds = skillIds.filter(id => id !== 'remember-context');
      // If no other skills remain, fallback to research with the chain context
      if (skillIds.length === 0) skillIds = ['research'];
    } catch (err) {
      console.error(`[ARL] [${label}] Chain context error:`, err.message);
    }
  }

  console.log(`[ARL] [${label}] Intent: ${intent.intents.join(', ') || 'follow-up'} | Skills: ${skillIds.join(', ')} | Confidence: ${intent.confidence}`);

  logAction({
    accountId: account.id,
    action: 'arl-intent',
    emailId: email.messageId,
    sender,
    subject: email.subject,
    reasoning: `[${label}] ARL intent detected: ${intent.intents.join(', ') || 'follow-up'} (confidence: ${intent.confidence}). Skills: ${skillIds.join(', ')}. User: ${user?.name || 'unknown'}`,
    mode: 'arl',
    details: { intent, isFollowUp, user: user?.name },
  });

  // ── Step 3: Build context for skill execution ──
  const context = {
    ...intent.context,
    domain: intent.context.domain || extractDomainFromSender(sender),
    sender,
    isFollowUp,
    previousResults: isFollowUp ? existingConv.skillResults : [],
    user,
    accountId: account.id,
    chainContext,
  };

  // If chain context was loaded, inject it into the email body for downstream skills
  if (chainContext) {
    email = { ...email, body: chainContext + '\n\n--- Current Email ---\n' + (email.body || '') };
  }

  // ── Step 4: Execute skill plan ──
  let skillResults;
  try {
    skillResults = await executePlan(skillIds, email, context);
    console.log(`[ARL] [${label}] Skills executed: ${skillResults.length} results`);

    for (const r of skillResults) {
      console.log(`[ARL]   ${r.skillId}: ${r.success ? 'OK' : 'FAIL'} (${r.duration}ms)`);
    }
  } catch (err) {
    console.error(`[ARL] [${label}] Skill execution error:`, err.message);
    logArlExecution({
      sender,
      subject: email.subject,
      accountEmail: account.email,
      intents: intent.intents,
      skills: skillIds,
      success: false,
      error: err.message,
      duration: Date.now() - start,
    });
    return { handled: true, error: err.message };
  }

  // ── Step 5: Synthesize response via Claude ──
  let responseText;
  try {
    responseText = synthesizeResponse(email, skillResults, context, isFollowUp);
    console.log(`[ARL] [${label}] Response synthesized (${responseText.length} chars)`);
  } catch (err) {
    console.error(`[ARL] [${label}] Synthesis error:`, err.message);
    // Fallback: concatenate skill outputs
    responseText = buildFallbackResponse(email, skillResults);
  }

  // ── Step 6: Save draft + send based on mode ──
  let sendSuccess = false;
  let draftSaved = false;

  // Save draft to IMAP Drafts folder
  try {
    const { saveDraftToAccount } = require('../email-checker/sender');
    const { setEnvBridgeForAccount } = require('./agent-core');
    setEnvBridgeForAccount(account);
    const replySubject = email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject}`;
    await saveDraftToAccount(replySubject, responseText, sender, '');
    draftSaved = true;
    console.log(`[ARL] [${label}] Draft saved to account`);
  } catch (err) {
    console.error(`[ARL] [${label}] Draft save error (non-fatal):`, err.message);
  }

  // Determine if we should auto-send based on mode + permissions
  const accountMode = account.mode || 'suggestion';
  const canAutoSend = (accountMode === 'internal' || accountMode === 'auto') &&
    (!account.permissions || account.permissions.send !== false);

  if (canAutoSend) {
    // Auto-send (all safety layers still enforced inside sendArlReply)
    try {
      const didSend = await sendArlReply(email, account, responseText);
      if (didSend) {
        sendSuccess = true;
        console.log(`[ARL] [${label}] Reply sent to ${sender}`);
      } else {
        console.log(`[ARL] [${label}] Reply skipped (blocked by send permission or rate limit)`);
      }
    } catch (err) {
      console.error(`[ARL] [${label}] Send error:`, err.message);
    }
  } else {
    // Queue for manual approval
    const { addToQueue } = require('./agent-core');
    addToQueue({
      accountId: account.id,
      emailId: email.messageId,
      uid: email.uid,
      folder: email.folder,
      sender,
      subject: email.subject,
      draft: responseText,
      draftId: `arl-${Date.now()}`,
      reason: `ARL draft — ${accountMode} mode, awaiting approval`,
    });
    console.log(`[ARL] [${label}] Draft queued for approval (${accountMode} mode, send=${account.permissions?.send})`);
  }

  // ── Step 6.5: Mark original email as read ──
  try {
    const { markEmailSeen } = require('./agent-core');
    await markEmailSeen(email.uid, email.folder || 'INBOX', account);
  } catch (err) {
    console.error(`[ARL] [${label}] markEmailSeen error (non-fatal):`, err.message);
  }

  // ── Step 7: Track conversation for follow-up window ──
  startConversation(sender, {
    messageId: email.messageId,
    account,
    email,
    context,
    skillResults,
  });

  const duration = Date.now() - start;

  // ── Step 8: Log everything ──
  logAction({
    accountId: account.id,
    action: sendSuccess ? 'arl-respond' : (draftSaved ? 'arl-draft' : 'arl-respond-failed'),
    emailId: email.messageId,
    sender,
    subject: email.subject,
    reasoning: `[${label}] ARL ${isFollowUp ? 'follow-up' : 'response'}: ${skillResults.length} skills, ${duration}ms. ${sendSuccess ? 'Sent.' : (draftSaved ? 'Draft saved.' : 'Failed.')}${!canAutoSend ? ' Queued for approval.' : ''}`,
    mode: 'arl',
    details: {
      skills: skillResults.map(r => ({ id: r.skillId, success: r.success, duration: r.duration })),
      responsePreview: responseText.slice(0, 300),
      isFollowUp,
    },
  });

  logArlExecution({
    sender,
    subject: email.subject,
    accountEmail: account.email,
    intents: intent.intents,
    skills: skillIds,
    skillResults: skillResults.map(r => ({ id: r.skillId, success: r.success, type: r.type, duration: r.duration })),
    responseLength: responseText.length,
    sendSuccess,
    isFollowUp,
    duration,
    success: true,
  });

  try {
    logAudit({
      tier: 'execution',
      service: 'opai-email-agent',
      event: 'arl-response',
      status: sendSuccess ? 'completed' : 'partial',
      summary: `ARL ${isFollowUp ? 'follow-up' : 'response'} to ${sender}: ${skillIds.join(', ')} (${duration}ms)`,
      duration_ms: duration,
      details: {
        sender,
        subject: email.subject,
        intents: intent.intents,
        skills: skillIds,
        sendSuccess,
      },
    });
  } catch { }

  return {
    handled: true,
    response: responseText,
    skillResults,
    sendSuccess,
    duration,
  };
}

// ── Response synthesis ──────────────────────────────────────

/**
 * Synthesize a human-readable response from skill results using Claude CLI.
 * Falls back to concatenation if Claude fails.
 */
function synthesizeResponse(email, skillResults, context, isFollowUp) {
  const config = loadSkillsConfig();
  const model = config.plannerModel || 'haiku'; // use cheap model for synthesis

  const skillSummaries = skillResults.map(r => {
    const skill = getSkillById(r.skillId);
    return `### ${skill?.name || r.skillId} (${r.success ? 'success' : 'failed'}, ${r.duration}ms)\n${r.output || '(no output)'}`;
  }).join('\n\n');

  const prompt = `You are OPAI's email agent responding to ${email.fromAddress}.
${isFollowUp ? 'This is a FOLLOW-UP in an ongoing conversation. Be concise and reference prior context.' : 'This is a NEW request.'}

Original email subject: ${email.subject}
Original email body:
${(email.body || '').slice(0, 3000)}

Below are the results from the skills that were executed to answer this request:

${skillSummaries}

Write a clear, professional email response that:
1. Directly answers their question/request using the skill results above
2. Includes specific data, findings, or diagnostics from the results
3. Is concise but thorough — no fluff
4. Ends with a note that they can reply within 30 minutes for follow-up questions
5. Sign off as "OPAI Agent" (automated email assistant)

Do NOT include a subject line. Just the response body.`;

  try {
    const result = execSync(
      `claude -p --model ${model} --output-format text`,
      {
        input: prompt,
        cwd: '/workspace/synced/opai',
        encoding: 'utf8',
        timeout: 60000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDECODE: '' },
      }
    );
    return result.trim();
  } catch (err) {
    console.error('[ARL] Synthesis via Claude failed:', err.message);
    return buildFallbackResponse(email, skillResults);
  }
}

/**
 * Fallback response when Claude synthesis fails — structured concatenation.
 */
function buildFallbackResponse(email, skillResults) {
  const lines = [`Hi,\n\nHere are the results for your request "${email.subject}":\n`];

  for (const r of skillResults) {
    const skill = getSkillById(r.skillId);
    lines.push(`--- ${skill?.name || r.skillId} ${r.success ? '(OK)' : '(Failed)'} ---`);
    lines.push(r.output || '(no output)');
    lines.push('');
  }

  lines.push('\nReply within 30 minutes if you have follow-up questions.\n');
  lines.push('— OPAI Agent');
  return lines.join('\n');
}

// ── Email sending ──────────────────────────────────────────

/**
 * Send the ARL reply via SMTP using the account's credentials.
 */
async function sendArlReply(email, account, responseText) {
  const { sendResponse } = require('../email-checker/sender');
  const { setEnvBridgeForAccount } = require('./agent-core');

  // ── Layer 2: Enforce account send permissions ──
  // arl-dallas-pw has send:false — ARL must respect this.
  // Only accounts with explicit send:true can send ARL replies.
  if (account.permissions && account.permissions.send === false) {
    console.log(`[ARL] [${account.name || account.email}] BLOCKED: account does not have send permission — skipping ARL reply`);
    logAction({
      accountId: account.id,
      action: 'arl-send-blocked',
      emailId: email.messageId,
      sender: email.fromAddress,
      subject: email.subject,
      reasoning: `[${account.name}] ARL send blocked: account.permissions.send is false`,
      mode: 'arl',
    });
    return false;
  }

  // ── Layer 4: Global outbound rate limit ──
  const now = Date.now();
  if (now - _arlSendTracker.hourStart > 3600000) {
    _arlSendTracker.count = 0;
    _arlSendTracker.hourStart = now;
  }
  if (_arlSendTracker.count >= MAX_ARL_SENDS_PER_HOUR) {
    console.log(`[ARL] RATE LIMIT HIT: ${_arlSendTracker.count} ARL sends this hour — blocking further sends until next hour`);
    logAction({
      accountId: account.id,
      action: 'arl-rate-limited',
      emailId: email.messageId,
      sender: email.fromAddress,
      subject: email.subject,
      reasoning: `ARL rate limit: ${_arlSendTracker.count}/${MAX_ARL_SENDS_PER_HOUR} sends this hour — blocked`,
      mode: 'arl',
    });
    return false;
  }

  // Bridge SMTP credentials for the sender module
  setEnvBridgeForAccount(account);

  const subject = email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject}`;

  const result = await sendResponse({
    to: email.fromAddress,
    subject,
    finalContent: responseText,
    emailMessageId: email.messageId,
    headers: { 'X-OPAI-ARL-Sent': 'true' }, // Tag so receiving accounts can detect AI-sent emails
  }, ''); // empty prefix — using bridged env vars

  // Check if the SMTP send actually succeeded
  if (!result?.success) {
    console.error(`[ARL] [${account.name || account.email}] SMTP send failed: ${result?.error || 'unknown error'}`);
    return false;
  }

  // Record in file-persisted AI-sent tracker (survives restarts)
  const { recordAiSent } = require('./agent-core');
  recordAiSent({ messageId: result?.messageId, to: email.fromAddress, subject });

  // Increment rate tracker after successful send
  _arlSendTracker.count++;
  console.log(`[ARL] Send tracker: ${_arlSendTracker.count}/${MAX_ARL_SENDS_PER_HOUR} this hour`);

  // Record in thread dedup tracker (Layer 5)
  const threadKey = `${email.fromAddress.toLowerCase()}|${subject.replace(/^(Re:\s*)+/gi, '').trim().toLowerCase()}`;
  _arlRepliedThreads.set(threadKey, Date.now());

  // NOTE: markEmailSeen is now called in Step 6.5 of processArlEmail (runs regardless of send outcome)

  return true;
}

// ── Helpers ────────────────────────────────────────────────

function extractDomainFromSender(senderAddress) {
  const match = senderAddress.match(/@([a-z0-9.-]+)/i);
  return match ? match[1] : '';
}

module.exports = {
  shouldProcessArl,
  processArlEmail,
};
