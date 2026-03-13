/**
 * Email Classifier — Classify emails using Claude CLI (Haiku model).
 *
 * Labels emails with: type labels, priority, urgency, requires_response, summary.
 * Uses `claude -p --model haiku` for cost-optimized classification.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const OPAI_ROOT = process.env.OPAI_ROOT || path.resolve(__dirname, '../..');

// Valid classification values
const VALID_LABELS = [
  'urgent', 'action-required', 'informational', 'follow-up', 'scheduling',
  'invoice', 'support', 'client-communication', 'internal', 'automated',
  'marketing', 'personal', 'notification', 'approval-needed', 'time-sensitive',
  'newsletter', 'fyi', 'no-response-needed', 'thread-update', 'proposal',
  // System message labels
  'system-alert', 'security-alert', 'service-notification', 'password-reset',
  'billing', 'verification',
];
const VALID_PRIORITIES = ['critical', 'high', 'normal', 'low'];
const VALID_URGENCIES = ['immediate', 'soon', 'standard', 'none'];

// Labels that indicate a system/automated message (no human response needed)
const SYSTEM_LABELS = [
  'automated', 'notification', 'newsletter', 'system-alert', 'security-alert',
  'service-notification', 'password-reset', 'billing', 'verification',
  'no-response-needed', 'marketing',
];

// System labels that warrant flagging the user (important system messages)
const ALERT_LABELS = ['system-alert', 'security-alert', 'billing'];

/**
 * Classify a single email using Claude Haiku.
 *
 * @param {string} from — Sender email address
 * @param {string} subject — Email subject
 * @param {string} body — Email text body
 * @param {string} accountName — Which account received this
 * @returns {Promise<{labels: string[], priority: string, urgency: string, requiresResponse: boolean, summary: string, assigneeHint: string}>}
 */
function classifyEmail(from, subject, body, accountName) {
  return new Promise((resolve) => {
    const prompt = [
      `You are an email classifier. Analyze the email below and return ONLY a JSON object (no markdown, no explanation).`,
      ``,
      `Return this exact structure:`,
      `{`,
      `  "labels": ["label1", "label2"],`,
      `  "priority": "critical|high|normal|low",`,
      `  "urgency": "immediate|soon|standard|none",`,
      `  "requiresResponse": true|false,`,
      `  "isSystem": true|false,`,
      `  "needsUserAttention": true|false,`,
      `  "summary": "one-line summary",`,
      `  "assigneeHint": "human|agent"`,
      `}`,
      ``,
      `Label taxonomy (use 1-4 labels):`,
      `  HUMAN CORRESPONDENCE:`,
      `    urgent, action-required, informational, follow-up, scheduling,`,
      `    invoice, support, client-communication, internal, personal,`,
      `    approval-needed, time-sensitive, thread-update, proposal`,
      `  SYSTEM / AUTOMATED:`,
      `    automated, notification, newsletter, marketing, fyi, no-response-needed,`,
      `    system-alert, security-alert, service-notification, password-reset,`,
      `    billing, verification`,
      ``,
      `isSystem rules (set true if):`,
      `  - Sender is noreply@, no-reply@, notifications@, alerts@, support@, mailer-daemon@`,
      `  - Email is a newsletter, marketing blast, automated report, password reset, 2FA code`,
      `  - Email is a service notification (GitHub, Stripe, Vercel, Supabase, Google, AWS, etc.)`,
      `  - Email is a billing receipt, subscription confirmation, shipping notification`,
      `  - DO NOT set requiresResponse=true for system messages`,
      ``,
      `needsUserAttention rules (set true if):`,
      `  - Security alert: password changed, unauthorized login, suspicious activity`,
      `  - Billing issue: payment failed, subscription expiring, overdue invoice`,
      `  - Service down: outage notification, degraded performance alert`,
      `  - Account action required: verify email, confirm identity, expiring certificate`,
      `  - Important deadline: domain expiring, SSL certificate renewal, trial ending`,
      `  - This is DIFFERENT from requiresResponse. System emails never need a reply,`,
      `    but some need the user to take action (e.g., fix a payment method).`,
      ``,
      `Priority rules:`,
      `  critical — "urgent", "ASAP", "emergency", deadline today, payment issues, security alerts`,
      `  high — needs response within 24h, client questions, scheduling requests, billing issues`,
      `  normal — standard correspondence, general inquiries, routine notifications`,
      `  low — newsletters, marketing, automated notifications, CC'd emails, FYI`,
      ``,
      `Urgency rules:`,
      `  immediate — explicit "today" deadline, payment issues, security breaches, service outages`,
      `  soon — "this week", "next few days", client follow-ups, expiring subscriptions`,
      `  standard — no explicit deadline, general correspondence`,
      `  none — newsletters, FYI, automated reports, marketing`,
      ``,
      `assigneeHint: "agent" if the task can be fully automated (e.g., filing, forwarding, data lookup), "human" otherwise.`,
      ``,
      `Account: ${accountName}`,
      `From: ${from}`,
      `Subject: ${subject}`,
      ``,
      `--- EMAIL BODY ---`,
      body.substring(0, 4000),
      `--- END EMAIL ---`,
    ].join('\n');

    const tmpFile = path.join(os.tmpdir(), `opai-classify-${Date.now()}.txt`);
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
      console.error('[CLASSIFY] Haiku classification timed out');
      resolve(defaultClassification());
    }, 60000); // 1 min timeout

    proc.on('close', () => {
      clearTimeout(timer);
      try { fs.unlinkSync(tmpFile); } catch {}

      try {
        const match = stdout.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          resolve(sanitizeClassification(parsed));
          return;
        }
      } catch (err) {
        console.error('[CLASSIFY] Parse error:', err.message);
      }

      resolve(defaultClassification());
    });

    proc.on('error', () => {
      clearTimeout(timer);
      try { fs.unlinkSync(tmpFile); } catch {}
      resolve(defaultClassification());
    });
  });
}

/**
 * Sanitize and validate classification output from Haiku.
 */
function sanitizeClassification(raw) {
  // Accept both "labels" and legacy "tags" field from AI output
  const rawLabels = Array.isArray(raw.labels) ? raw.labels : (Array.isArray(raw.tags) ? raw.tags : []);
  const validLabels = rawLabels.filter((t) => VALID_LABELS.includes(t)).slice(0, 4);

  const finalLabels = validLabels.length > 0 ? validLabels : ['informational'];

  // Determine if system message based on labels or explicit flag
  const isSystem = raw.isSystem === true || finalLabels.some(t => SYSTEM_LABELS.includes(t));

  // Determine if user needs to be alerted (important system messages)
  const needsUserAttention = raw.needsUserAttention === true || finalLabels.some(t => ALERT_LABELS.includes(t));

  // System messages should never require a human email response
  const requiresResponse = isSystem ? false
    : (typeof raw.requiresResponse === 'boolean' ? raw.requiresResponse : false);

  return {
    labels: finalLabels,
    tags: finalLabels, // backward compat alias
    priority: VALID_PRIORITIES.includes(raw.priority) ? raw.priority : 'normal',
    urgency: VALID_URGENCIES.includes(raw.urgency) ? raw.urgency : 'standard',
    requiresResponse,
    isSystem,
    needsUserAttention,
    summary: typeof raw.summary === 'string' ? raw.summary.substring(0, 200) : '',
    assigneeHint: raw.assigneeHint === 'agent' ? 'agent' : 'human',
  };
}

/**
 * Default classification when Haiku fails or times out.
 */
function defaultClassification() {
  return {
    labels: ['informational'],
    tags: ['informational'], // backward compat alias
    priority: 'normal',
    urgency: 'standard',
    requiresResponse: false,
    isSystem: false,
    needsUserAttention: false,
    summary: '',
    assigneeHint: 'human',
  };
}

module.exports = { classifyEmail, VALID_LABELS, VALID_PRIORITIES, VALID_URGENCIES, SYSTEM_LABELS, ALERT_LABELS };
