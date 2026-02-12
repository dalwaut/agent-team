/**
 * Response Drafter — "Prompt > Response > Improvement Loop > Send" via Claude Haiku.
 *
 * Three-step process:
 *   1. Draft initial response using brand voice
 *   2. Self-critique the draft
 *   3. Refine based on critique
 *
 * All steps use `claude -p --model haiku` (Pro Max, zero API cost).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const OPAI_ROOT = process.env.OPAI_ROOT || path.resolve(__dirname, '../..');
const VOICES_DIR = path.join(__dirname, 'voices');
const RESPONSES_FILE = path.join(__dirname, 'data', 'email-responses.json');
const DATA_DIR = path.join(__dirname, 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ──────────────────────────────────────────────────────────
// Response Storage
// ──────────────────────────────────────────────────────────

function loadResponses() {
  try {
    if (fs.existsSync(RESPONSES_FILE)) return JSON.parse(fs.readFileSync(RESPONSES_FILE, 'utf8'));
  } catch {}
  return { responses: {}, lastUpdated: null };
}

function saveResponses(data) {
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(RESPONSES_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function getResponse(responseId) {
  const data = loadResponses();
  return data.responses[responseId] || null;
}

function getPendingDrafts() {
  const data = loadResponses();
  return Object.entries(data.responses)
    .filter(([, r]) => r.status === 'draft')
    .map(([id, r]) => ({ id, ...r }));
}

function approveResponse(responseId, finalContent) {
  const data = loadResponses();
  const resp = data.responses[responseId];
  if (!resp) return null;

  resp.finalContent = finalContent || resp.refinedDraft;
  resp.status = 'approved';
  resp.approvedAt = new Date().toISOString();
  saveResponses(data);
  return resp;
}

function rejectResponse(responseId) {
  const data = loadResponses();
  const resp = data.responses[responseId];
  if (!resp) return null;

  resp.status = 'cancelled';
  saveResponses(data);
  return resp;
}

function markSent(responseId) {
  const data = loadResponses();
  const resp = data.responses[responseId];
  if (!resp) return null;

  resp.status = 'sent';
  resp.sentAt = new Date().toISOString();
  saveResponses(data);
  return resp;
}

// ──────────────────────────────────────────────────────────
// Voice Loading
// ──────────────────────────────────────────────────────────

function loadVoice(profileName) {
  const voiceFile = path.join(VOICES_DIR, `${profileName}.txt`);
  try {
    return fs.readFileSync(voiceFile, 'utf8').trim();
  } catch {
    console.error(`[DRAFTER] Voice profile "${profileName}" not found at ${voiceFile}`);
    return 'Write a professional email response. Be concise and clear.';
  }
}

// ──────────────────────────────────────────────────────────
// Claude CLI Helper
// ──────────────────────────────────────────────────────────

function callHaiku(prompt, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const tmpFile = path.join(os.tmpdir(), `opai-draft-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`);
    fs.writeFileSync(tmpFile, prompt, 'utf8');

    let stdout = '';
    const proc = spawn('claude', ['-p', '--model', 'haiku', '--output-format', 'text'], {
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
      console.error('[DRAFTER] Haiku call timed out');
      resolve('');
    }, timeoutMs);

    proc.on('close', () => {
      clearTimeout(timer);
      try { fs.unlinkSync(tmpFile); } catch {}
      resolve(stdout.trim());
    });

    proc.on('error', () => {
      clearTimeout(timer);
      try { fs.unlinkSync(tmpFile); } catch {}
      resolve('');
    });
  });
}

// ──────────────────────────────────────────────────────────
// Three-Step Response Loop
// ──────────────────────────────────────────────────────────

/**
 * Draft a response to an email using the 3-step improvement loop.
 *
 * @param {object} email — { from, fromName, subject, text, messageId, date }
 * @param {string} accountName — Which account received this
 * @param {string} voiceProfile — Voice profile name (without .txt)
 * @returns {Promise<string|null>} — Response ID if draft created, null on failure
 */
async function draftResponse(email, accountName, voiceProfile = 'boutabyte-professional') {
  const voice = loadVoice(voiceProfile);

  console.log(`[DRAFTER] Step 1/3: Generating initial draft for "${email.subject}"`);

  // STEP 1: Initial Draft
  const draftPrompt = [
    voice,
    ``,
    `Write a professional email response to the following email. Output ONLY the email body text (no subject line, no metadata). Do NOT include a signature block or sign-off (e.g. "Best regards, Dallas") — the email client appends the signature automatically.`,
    ``,
    `From: ${email.fromName || email.from} <${email.from}>`,
    `Subject: ${email.subject}`,
    `Date: ${email.date || 'today'}`,
    ``,
    `--- ORIGINAL EMAIL ---`,
    email.text,
    `--- END ---`,
  ].join('\n');

  const initialDraft = await callHaiku(draftPrompt);
  if (!initialDraft) {
    console.error('[DRAFTER] Failed to generate initial draft');
    return null;
  }

  console.log(`[DRAFTER] Step 2/3: Self-critiquing draft...`);

  // STEP 2: Critique
  const critiquePrompt = [
    `You are a professional email communication reviewer. Critique the following draft response for:`,
    ``,
    `1. Does it address all points raised in the original email?`,
    `2. Is the tone professional yet approachable?`,
    `3. Is it appropriately concise without being curt?`,
    `4. Does it include clear next steps or a call to action?`,
    `5. Are there any awkward phrasings or potential misunderstandings?`,
    `6. Is the greeting appropriate for the formality level? (Note: Do NOT critique the sign-off — no signature block should be included since Gmail auto-appends it.)`,
    ``,
    `Provide specific, actionable improvement suggestions. Be concise.`,
    ``,
    `ORIGINAL EMAIL:`,
    `From: ${email.from}`,
    `Subject: ${email.subject}`,
    `${email.text}`,
    ``,
    `DRAFT RESPONSE:`,
    initialDraft,
  ].join('\n');

  const critique = await callHaiku(critiquePrompt);

  console.log(`[DRAFTER] Step 3/3: Refining based on critique...`);

  // STEP 3: Refine
  const refinePrompt = [
    voice,
    ``,
    `Improve the following email draft based on the review feedback below.`,
    `Address every point in the critique. Maintain the same overall structure but improve clarity, tone, and completeness.`,
    `Output ONLY the improved email body text (no subject line, no metadata, no explanation of changes). Do NOT include a signature block or sign-off — Gmail auto-appends the signature.`,
    ``,
    `ORIGINAL EMAIL:`,
    `From: ${email.from}`,
    `Subject: ${email.subject}`,
    `${email.text}`,
    ``,
    `CURRENT DRAFT:`,
    initialDraft,
    ``,
    `CRITIQUE:`,
    critique || 'No critique available — improve the draft independently.',
  ].join('\n');

  const refinedDraft = await callHaiku(refinePrompt);

  // Store all three outputs
  const responseId = `resp-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const data = loadResponses();

  data.responses[responseId] = {
    emailMessageId: email.messageId,
    account: accountName,
    to: email.from,
    toName: email.fromName || email.from,
    subject: `Re: ${email.subject.replace(/^Re:\s*/i, '')}`,
    originalBody: email.text.substring(0, 2000),
    initialDraft,
    critique: critique || '',
    refinedDraft: refinedDraft || initialDraft,
    finalContent: null,
    status: 'draft',
    createdAt: new Date().toISOString(),
    approvedAt: null,
    sentAt: null,
  };

  saveResponses(data);
  console.log(`[DRAFTER] Draft stored: ${responseId}`);

  return responseId;
}

module.exports = {
  draftResponse,
  loadResponses,
  getResponse,
  getPendingDrafts,
  approveResponse,
  rejectResponse,
  markSent,
};
