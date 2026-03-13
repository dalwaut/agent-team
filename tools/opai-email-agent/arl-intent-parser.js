/**
 * ARL Intent Parser — detect actionable intent from email content
 *
 * Two-tier detection:
 *   1. Fast regex scan against skill intentPatterns (zero AI cost)
 *   2. Structured context extraction (Context:, Goal:, etc.)
 *
 * Priority ordering: new skills (create-task, system-change, remember-context,
 * manage-files, generate-report) are checked BEFORE generic skills (research,
 * service-status) to prevent false matches on broad patterns.
 *
 * Returns: { detected, intents[], confidence, context }
 */

const fs = require('fs');
const path = require('path');

const SKILLS_PATH = path.join(__dirname, 'arl-skills.json');

// Skills that should be matched FIRST (high-priority, specific intent)
const HIGH_PRIORITY_SKILLS = [
  'prd-intake',
  'create-task',
  'system-change',
  'remember-context',
  'manage-files',
  'generate-report',
  'process-transcript',
  'approve-transcript',
];

function loadSkills() {
  try { return JSON.parse(fs.readFileSync(SKILLS_PATH, 'utf8')); }
  catch { return { skills: [], arlEnabled: false }; }
}

// Structured block patterns in email body
const CONTEXT_EXTRACTORS = {
  context: /(?:^|\n)\s*context\s*:\s*(.+?)(?=\n\s*(?:goal|fix|diagnose|explain|research)\s*:|$)/is,
  goal: /(?:^|\n)\s*goal\s*:\s*(.+?)(?=\n\s*(?:context|fix|diagnose|explain|research)\s*:|$)/is,
  fix: /(?:^|\n)\s*fix\s*(?:this)?\s*:\s*(.+?)(?=\n\s*(?:context|goal|diagnose|explain|research)\s*:|$)/is,
  diagnose: /(?:^|\n)\s*diagnose\s*(?:this)?\s*:\s*(.+?)(?=\n\s*(?:context|goal|fix|explain|research)\s*:|$)/is,
};

// Domain extraction for dns-lookup skill
const DOMAIN_PATTERN = /(?:domain|dns|mx|resolve|check)\s+(?:for\s+)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z]{2,})+)/i;
const URL_DOMAIN_PATTERN = /https?:\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z]{2,})+)/i;

// Pending transcript directory
const PENDING_TRANSCRIPTS_DIR = path.join(__dirname, 'data', 'pending-transcripts');

/**
 * Check if sender has a pending transcript approval waiting.
 * Returns the pending file path if found, null otherwise.
 */
function checkPendingTranscriptApproval(senderAddress) {
  try {
    if (!fs.existsSync(PENDING_TRANSCRIPTS_DIR)) return null;
    const files = fs.readdirSync(PENDING_TRANSCRIPTS_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const data = JSON.parse(fs.readFileSync(path.join(PENDING_TRANSCRIPTS_DIR, file), 'utf8'));
      if (data.status === 'pending_approval' && data.sender?.toLowerCase() === senderAddress?.toLowerCase()) {
        return file;
      }
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Parse email for ARL-actionable intent.
 * @param {object} email - { fromAddress, subject, body }
 * @returns {{ detected: boolean, intents: string[], confidence: number, context: object, matchedSkills: string[] }}
 */
function parseIntent(email) {
  const config = loadSkills();
  if (!config.arlEnabled) {
    return { detected: false, intents: [], confidence: 0, context: {}, matchedSkills: [] };
  }

  const text = `${email.subject || ''}\n${email.body || ''}`.toLowerCase();
  const fullText = `${email.subject || ''}\n${email.body || ''}`;

  // ── Pre-check: pending transcript approval from this sender ──
  const approvalPatterns = /\b(approve\s*(all|[\d,\s]+)|reject\b|edit\b)/i;
  if (approvalPatterns.test(text)) {
    const pendingFile = checkPendingTranscriptApproval(email.fromAddress);
    if (pendingFile) {
      return {
        detected: true,
        intents: ['approve-transcript'],
        confidence: 0.95,
        context: { pendingFile },
        matchedSkills: ['approve-transcript'],
      };
    }
  }

  const matchedIntents = [];
  const matchedSkillIds = [];

  // Sort skills: high-priority first, then the rest
  const enabledSkills = config.skills.filter(s => s.enabled);
  const sorted = [
    ...enabledSkills.filter(s => HIGH_PRIORITY_SKILLS.includes(s.id)),
    ...enabledSkills.filter(s => !HIGH_PRIORITY_SKILLS.includes(s.id)),
  ];

  // Scan each enabled skill's intent patterns
  for (const skill of sorted) {
    for (const pattern of skill.intentPatterns || []) {
      try {
        const re = new RegExp(pattern, 'i');
        if (re.test(text)) {
          if (!matchedIntents.includes(skill.id)) {
            matchedIntents.push(skill.id);
            matchedSkillIds.push(skill.id);
          }
          break; // One match per skill is enough
        }
      } catch {
        // Invalid regex in config — skip
      }
    }
  }

  // Extract structured context blocks
  const context = {};
  for (const [key, re] of Object.entries(CONTEXT_EXTRACTORS)) {
    const match = fullText.match(re);
    if (match) {
      context[key] = match[1].trim();
      // Structured blocks boost confidence
      if (!matchedIntents.includes(key) && ['fix', 'diagnose'].includes(key)) {
        matchedIntents.push(key === 'fix' ? 'diagnose' : key);
        if (!matchedSkillIds.includes('diagnose')) matchedSkillIds.push('diagnose');
      }
    }
  }

  // Extract domain for dns-lookup
  const domainMatch = fullText.match(DOMAIN_PATTERN) || fullText.match(URL_DOMAIN_PATTERN);
  if (domainMatch) {
    context.domain = domainMatch[1].toLowerCase();
  }

  // If a high-priority skill matched, remove overlapping low-priority matches
  // e.g., if "create-task" matched, don't also match "research" from "task"
  const hasHighPriority = matchedSkillIds.some(id => HIGH_PRIORITY_SKILLS.includes(id));
  if (hasHighPriority) {
    // Remove generic skills that matched due to broad patterns
    const genericsToRemove = ['research', 'service-status'];
    for (const generic of genericsToRemove) {
      const idx = matchedSkillIds.indexOf(generic);
      if (idx > -1) {
        matchedSkillIds.splice(idx, 1);
        const intentIdx = matchedIntents.indexOf(generic);
        if (intentIdx > -1) matchedIntents.splice(intentIdx, 1);
      }
    }
  }

  // Confidence calculation
  let confidence = 0;
  if (matchedIntents.length > 0) confidence = 0.6;
  if (matchedIntents.length > 1) confidence = 0.75;
  if (Object.keys(context).length > 0) confidence = Math.max(confidence, 0.8);
  if (context.goal || context.context) confidence = 0.95;
  // High-priority skill match = higher confidence
  if (hasHighPriority) confidence = Math.max(confidence, 0.85);

  return {
    detected: matchedIntents.length > 0,
    intents: matchedIntents,
    confidence,
    context,
    matchedSkills: matchedSkillIds,
  };
}

module.exports = { parseIntent };
