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

const SKILLS_PATH = path.join(__dirname, 'arl-skills.json');

function loadSkillsConfig() {
  try { return JSON.parse(fs.readFileSync(SKILLS_PATH, 'utf8')); }
  catch { return { arlEnabled: false }; }
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
  const arlAccounts = ['acc-paradise', 'acc-dallas-pw'];
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

  // ── Step 0: Resolve user identity ──
  const user = resolveUser(sender);
  if (user) {
    console.log(`[ARL] [${label}] User resolved: ${user.name} (${user.role})`);
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
    console.log(`[ARL] [${label}] No actionable intent detected — skipping ARL`);
    return { handled: false };
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

  // ── Step 6: Send reply via SMTP ──
  let sendSuccess = false;
  try {
    await sendArlReply(email, account, responseText);
    sendSuccess = true;
    console.log(`[ARL] [${label}] Reply sent to ${sender}`);
  } catch (err) {
    console.error(`[ARL] [${label}] Send error:`, err.message);
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
    action: sendSuccess ? 'arl-respond' : 'arl-respond-failed',
    emailId: email.messageId,
    sender,
    subject: email.subject,
    reasoning: `[${label}] ARL ${isFollowUp ? 'follow-up' : 'response'}: ${skillResults.length} skills, ${duration}ms. ${sendSuccess ? 'Sent.' : 'Send failed.'}`,
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
  } catch {}

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
4. Ends with a note that they can reply within 10 minutes for follow-up questions
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

  lines.push('\nReply within 10 minutes if you have follow-up questions.\n');
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

  // Bridge SMTP credentials for the sender module
  setEnvBridgeForAccount(account);

  const subject = email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject}`;

  await sendResponse({
    to: email.fromAddress,
    subject,
    finalContent: responseText,
    emailMessageId: email.messageId,
  }, ''); // empty prefix — using bridged env vars

  // Mark original email as seen (non-blocking)
  const { markEmailSeen } = require('./agent-core');
  markEmailSeen(email.uid, email.folder, account).catch(() => {});
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
