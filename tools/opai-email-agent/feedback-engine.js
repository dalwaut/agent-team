/**
 * Feedback Engine — admin feedback storage and injection into future prompts
 *
 * When an admin comments on an action (e.g., "too formal" or "always CC accounting"),
 * that feedback becomes a persistent rule that influences future drafts.
 */

const fs = require('fs');
const path = require('path');

const FEEDBACK_PATH = path.join(__dirname, 'data', 'feedback.json');

function loadFeedback() {
  try {
    return JSON.parse(fs.readFileSync(FEEDBACK_PATH, 'utf8'));
  } catch {
    return { rules: [], corrections: [] };
  }
}

function saveFeedback(data) {
  fs.mkdirSync(path.dirname(FEEDBACK_PATH), { recursive: true });
  fs.writeFileSync(FEEDBACK_PATH, JSON.stringify(data, null, 2));
}

// Valid rule types with prompt injection behavior
const RULE_TYPES = ['tone', 'routing', 'cc', 'always-respond', 'never-respond', 'general'];

/**
 * Add a feedback rule from an admin comment.
 * @param {Object} opts
 * @param {string} opts.actionId - The action this feedback references
 * @param {string} opts.comment - Admin's feedback comment
 * @param {string} [opts.type] - tone | routing | cc | always-respond | never-respond | general
 * @param {string} [opts.sender] - If feedback applies to a specific sender
 */
function addRule(opts) {
  const data = loadFeedback();
  const rule = {
    id: `fb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    accountId: opts.accountId || null,
    actionId: opts.actionId || null,
    comment: opts.comment,
    type: RULE_TYPES.includes(opts.type) ? opts.type : (opts.category || 'general'),
    sender: opts.sender || null,
    active: true,
    createdAt: new Date().toISOString(),
  };
  data.rules.push(rule);
  saveFeedback(data);
  return rule;
}

/**
 * Record a draft correction (when admin edits a draft before approving).
 */
function addCorrection(opts) {
  const data = loadFeedback();
  const correction = {
    id: `cor-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    accountId: opts.accountId || null,
    actionId: opts.actionId || null,
    originalDraft: opts.originalDraft || '',
    correctedDraft: opts.correctedDraft || '',
    sender: opts.sender || null,
    createdAt: new Date().toISOString(),
  };
  data.corrections.push(correction);

  // Cap corrections at 100 (oldest removed)
  if (data.corrections.length > 100) {
    data.corrections = data.corrections.slice(-100);
  }

  saveFeedback(data);
  return correction;
}

/**
 * Get all active rules, optionally filtered by sender.
 */
function getActiveRules(sender = null, accountId = null) {
  const data = loadFeedback();
  let rules = (data.rules || []).filter(r => r.active);
  if (accountId) {
    rules = rules.filter(r => r.accountId === accountId || !r.accountId);
  }
  if (sender) {
    rules = rules.filter(r => !r.sender || r.sender.toLowerCase() === sender.toLowerCase());
  }
  return rules;
}

/**
 * Build a feedback context string for injection into drafting prompts.
 * Returns a text block summarizing all applicable rules and recent corrections.
 */
function buildPromptContext(sender = null, accountId = null) {
  const rules = getActiveRules(sender, accountId);
  const data = loadFeedback();
  let corrections = (data.corrections || [])
    .filter(c => !sender || !c.sender || c.sender.toLowerCase() === sender.toLowerCase());
  if (accountId) {
    corrections = corrections.filter(c => c.accountId === accountId || !c.accountId);
  }
  corrections = corrections.slice(-5);

  if (rules.length === 0 && corrections.length === 0) return '';

  // Group rules by type for cleaner injection
  const byType = {};
  for (const r of rules) {
    const t = r.type || r.category || 'general';
    if (!byType[t]) byType[t] = [];
    const scope = r.sender ? ` [for ${r.sender}]` : '';
    byType[t].push(`- ${r.comment}${scope}`);
  }

  const typeLabels = {
    tone: 'TONE & STYLE',
    routing: 'ROUTING',
    cc: 'CC RULES',
    'always-respond': 'ALWAYS RESPOND',
    'never-respond': 'NEVER RESPOND',
    general: 'GENERAL RULES',
  };

  let context = '\n\n--- ADMIN FEEDBACK (follow all of these) ---\n';
  for (const [type, lines] of Object.entries(byType)) {
    context += `\n${typeLabels[type] || type.toUpperCase()}:\n${lines.join('\n')}\n`;
  }

  if (corrections.length > 0) {
    context += '\nDRAFT CORRECTIONS (learn from these patterns):\n';
    for (const c of corrections) {
      const scope = c.sender ? ` [for ${c.sender}]` : '';
      context += `- Was: "${c.originalDraft.slice(0, 100)}..."${scope}\n`;
      context += `  Now: "${c.correctedDraft.slice(0, 100)}..."\n`;
    }
  }

  context += '--- END FEEDBACK ---\n';
  return context;
}

/**
 * Get all feedback data for UI display, optionally filtered by accountId.
 */
function getAllFeedback(accountId = null) {
  const data = loadFeedback();
  if (!accountId) return data;
  return {
    rules: (data.rules || []).filter(r => r.accountId === accountId || !r.accountId),
    corrections: (data.corrections || []).filter(c => c.accountId === accountId || !c.accountId),
  };
}

/**
 * Deactivate a rule.
 */
function deactivateRule(ruleId) {
  const data = loadFeedback();
  const rule = (data.rules || []).find(r => r.id === ruleId);
  if (!rule) return null;
  rule.active = false;
  rule.deactivatedAt = new Date().toISOString();
  saveFeedback(data);
  return rule;
}

module.exports = { addRule, addCorrection, getActiveRules, buildPromptContext, getAllFeedback, deactivateRule, RULE_TYPES };
