/**
 * ARL Skill Runner — execute skills (direct commands + Claude CLI)
 *
 * Two skill types:
 *   "direct" — shell command, captured output (zero AI cost)
 *   "claude" — prompt piped to `claude -p` via CLI
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const SKILLS_PATH = path.join(__dirname, 'arl-skills.json');
const WORKSPACE = '/workspace/synced/opai';

function loadSkillsConfig() {
  try { return JSON.parse(fs.readFileSync(SKILLS_PATH, 'utf8')); }
  catch { return { skills: [], defaultModel: 'sonnet' }; }
}

function getEnabledSkills() {
  const config = loadSkillsConfig();
  return config.skills.filter(s => s.enabled);
}

function getSkillById(id) {
  const config = loadSkillsConfig();
  return config.skills.find(s => s.id === id) || null;
}

/**
 * Build the prompt string from a skill's template, replacing {{placeholders}}.
 */
function buildPrompt(template, email, context) {
  return template
    .replace(/\{\{sender\}\}/g, email.fromAddress || email.from || '')
    .replace(/\{\{subject\}\}/g, email.subject || '')
    .replace(/\{\{body\}\}/g, email.body || '')
    .replace(/\{\{domain\}\}/g, context.domain || '')
    .replace(/\{\{context\}\}/g, context.context || '')
    .replace(/\{\{goal\}\}/g, context.goal || '');
}

/**
 * Build a command string, replacing {{placeholders}}.
 */
function buildCommand(commandTemplate, context) {
  let cmd = commandTemplate;
  cmd = cmd.replace(/\{\{domain\}\}/g, context.domain || 'example.com');
  return cmd;
}

/**
 * Execute a direct (shell command) skill.
 */
function runDirectSkill(skill, context) {
  const start = Date.now();
  const command = buildCommand(skill.command, context);
  const timeout = (skill.timeout || 10) * 1000;

  try {
    const output = execSync(command, {
      timeout,
      cwd: WORKSPACE,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return {
      skillId: skill.id,
      type: 'direct',
      success: true,
      output: output.slice(0, 10000),
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      skillId: skill.id,
      type: 'direct',
      success: false,
      output: (err.stdout || '') + '\n' + (err.stderr || err.message || ''),
      duration: Date.now() - start,
    };
  }
}

/**
 * Execute a Claude CLI skill via `claude -p`.
 */
function runClaudeSkill(skill, email, context) {
  const start = Date.now();
  const config = loadSkillsConfig();
  const model = skill.model || config.defaultModel || 'sonnet';
  const timeout = (skill.timeout || 120) * 1000;
  const prompt = buildPrompt(skill.promptTemplate, email, context);

  return new Promise((resolve) => {
    const tmpFile = path.join(os.tmpdir(), `opai-arl-${Date.now()}-${skill.id}.txt`);
    fs.writeFileSync(tmpFile, prompt, 'utf8');

    let stdout = '';
    let stderr = '';

    const proc = spawn('claude', ['-p', '--model', model, '--output-format', 'text'], {
      cwd: WORKSPACE,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDECODE: '' }, // Clear to allow nested claude
    });

    // Pipe prompt via stdin
    const input = fs.createReadStream(tmpFile);
    input.pipe(proc.stdin);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      cleanup();
      resolve({
        skillId: skill.id,
        type: 'claude',
        success: false,
        output: stdout.slice(0, 10000) || '(timed out after ' + skill.timeout + 's)',
        duration: Date.now() - start,
      });
    }, timeout);

    function cleanup() {
      try { fs.unlinkSync(tmpFile); } catch {}
    }

    proc.on('close', (code) => {
      clearTimeout(timer);
      cleanup();
      resolve({
        skillId: skill.id,
        type: 'claude',
        success: code === 0,
        output: stdout.trim().slice(0, 15000),
        duration: Date.now() - start,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      cleanup();
      resolve({
        skillId: skill.id,
        type: 'claude',
        success: false,
        output: `Spawn error: ${err.message}`,
        duration: Date.now() - start,
      });
    });
  });
}

// ── Structured skill: create-task ─────────────────────────

/**
 * Extract task details from email body using Claude Haiku, then POST to TeamHub.
 */
async function runCreateTaskSkill(skill, email, context) {
  const start = Date.now();
  const { resolveUser, getWorkspaceId, getUserId } = require('./user-resolver');
  const user = resolveUser(email.fromAddress || email.from);

  try {
    // Use Claude Haiku to extract structured task info from email
    const extractPrompt = `Extract task details from this email. Return ONLY valid JSON with these fields:
{
  "title": "short task title",
  "description": "task description with details",
  "priority": "high|medium|low|critical",
  "assignees": ["name1"]
}

Email from: ${email.fromAddress || email.from}
Subject: ${email.subject || ''}
Body:
${(email.body || '').slice(0, 3000)}`;

    const extraction = execSync(
      `claude -p --model haiku --output-format text`,
      {
        input: extractPrompt,
        cwd: WORKSPACE,
        encoding: 'utf8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDECODE: '' },
      }
    ).trim();

    // Parse JSON from Claude response
    let taskData;
    try {
      const jsonMatch = extraction.match(/\{[\s\S]*\}/);
      taskData = jsonMatch ? JSON.parse(jsonMatch[0]) : { title: email.subject, description: email.body, priority: 'medium' };
    } catch {
      taskData = { title: email.subject || 'Email Task', description: (email.body || '').slice(0, 500), priority: 'medium' };
    }

    // POST to TeamHub
    const workspaceId = getWorkspaceId(user);
    const userId = getUserId(user);

    const params = new URLSearchParams({
      workspace_id: workspaceId,
      user_id: userId,
      type: 'task',
      title: (taskData.title || 'Email Task').slice(0, 200),
      description: (taskData.description || '').slice(0, 2000),
      priority: taskData.priority || 'medium',
      source: 'email-agent',
    });

    const hubResult = await new Promise((resolve, reject) => {
      const url = `http://127.0.0.1:8089/api/internal/create-item?${params.toString()}`;
      const req = http.request(url, { method: 'POST', timeout: 10000, headers: { 'Content-Type': 'application/json' } }, (res) => {
        let body = '';
        res.on('data', d => { body += d; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error('Invalid TeamHub response')); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('TeamHub timeout')); });
      req.end('{}');
    });

    return {
      skillId: skill.id,
      type: 'structured',
      success: true,
      output: `Task created successfully!\n\nTitle: ${taskData.title}\nPriority: ${taskData.priority}\nID: ${hubResult.id || '(unknown)'}\nWorkspace: ${workspaceId}\n\nThe task has been added to TeamHub.`,
      duration: Date.now() - start,
      taskId: hubResult.id,
    };
  } catch (err) {
    return {
      skillId: skill.id,
      type: 'structured',
      success: false,
      output: `Failed to create task: ${err.message}`,
      duration: Date.now() - start,
    };
  }
}

// ── Gated skill: system-change ────────────────────────────

/**
 * Queue a system change request and send to Telegram for approval.
 */
async function runSystemChangeSkill(skill, email, context) {
  const start = Date.now();
  const { sendApprovalRequest } = require('./telegram-gate');
  const { resolveUser } = require('./user-resolver');
  const user = resolveUser(email.fromAddress || email.from);

  const requestId = `sc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  // Summarize the change request
  const summary = `${email.subject || 'System Change'}\n\n${(email.body || '').slice(0, 500)}`;

  try {
    const result = await sendApprovalRequest({
      requestId,
      summary: summary.slice(0, 1000),
      requester: email.fromAddress || email.from,
      requesterName: user?.name || email.fromAddress,
      emailSubject: email.subject || '(no subject)',
      changePayload: {
        emailBody: (email.body || '').slice(0, 3000),
        emailSubject: email.subject,
        sender: email.fromAddress || email.from,
      },
    });

    if (result.success) {
      return {
        skillId: skill.id,
        type: 'gated',
        success: true,
        output: `System change request submitted for approval.\n\nRequest ID: ${requestId}\nThe change has been sent to the admin via Telegram for review.\nYou'll receive a follow-up email when the request is approved or rejected.`,
        duration: Date.now() - start,
        requestId,
      };
    } else {
      return {
        skillId: skill.id,
        type: 'gated',
        success: false,
        output: `Failed to send approval request: ${result.error || 'unknown error'}`,
        duration: Date.now() - start,
      };
    }
  } catch (err) {
    return {
      skillId: skill.id,
      type: 'gated',
      success: false,
      output: `Error queuing system change: ${err.message}`,
      duration: Date.now() - start,
    };
  }
}

// ── Context-loader skill: remember-context ────────────────

/**
 * Fetch prior email chain and inject as context.
 */
async function runRememberContextSkill(skill, email, context) {
  const start = Date.now();

  try {
    const { fetchChainEmails, buildChainContext } = require('./chain-context');
    const modeEngine = require('./mode-engine');

    // Get the account for IMAP access
    const accountId = context.accountId || 'acc-paradise';
    const account = modeEngine.getAccountById(accountId) || modeEngine.getActiveAccount();

    const chainEmails = await fetchChainEmails(account, email, 5);
    const chainContext = buildChainContext(chainEmails);

    if (chainEmails.length === 0) {
      return {
        skillId: skill.id,
        type: 'context-loader',
        success: true,
        output: 'No prior email chain found. This appears to be a standalone email.',
        duration: Date.now() - start,
        chainContext: '',
      };
    }

    return {
      skillId: skill.id,
      type: 'context-loader',
      success: true,
      output: `Found ${chainEmails.length} prior email(s) in the chain. Context loaded.`,
      duration: Date.now() - start,
      chainContext,
      chainEmails,
    };
  } catch (err) {
    return {
      skillId: skill.id,
      type: 'context-loader',
      success: false,
      output: `Failed to load email chain: ${err.message}`,
      duration: Date.now() - start,
      chainContext: '',
    };
  }
}

// ── Structured skill: manage-files ────────────────────────

async function runManageFilesSkill(skill, email, context) {
  const start = Date.now();
  const { resolveUser } = require('./user-resolver');
  const user = resolveUser(email.fromAddress || email.from);

  if (!user || !user.workspace) {
    return {
      skillId: skill.id,
      type: 'structured',
      success: false,
      output: 'No workspace configured for this user. Contact admin to set up file access.',
      duration: Date.now() - start,
    };
  }

  // For now, list files in user's workspace
  try {
    const files = execSync(`ls -la "${user.workspace}" 2>/dev/null | head -30`, {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();

    return {
      skillId: skill.id,
      type: 'structured',
      success: true,
      output: `Files in your workspace (${user.workspace}):\n\n${files || '(empty)'}`,
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      skillId: skill.id,
      type: 'structured',
      success: false,
      output: `Could not access workspace: ${err.message}`,
      duration: Date.now() - start,
    };
  }
}

// ── Structured skill: generate-report ─────────────────────

async function runGenerateReportSkill(skill, email, context) {
  const start = Date.now();

  try {
    // Generate a summary report using Claude
    const reportPrompt = `Generate a concise status report for the OPAI platform. Include:
1. Active services status (check systemctl --user list-units 'opai-*')
2. Recent activity summary
3. Any alerts or issues

This report was requested by ${email.fromAddress || 'unknown'} via email.
Subject: ${email.subject || 'Report Request'}
Additional context: ${(email.body || '').slice(0, 500)}`;

    const report = execSync(
      `claude -p --model haiku --output-format text`,
      {
        input: reportPrompt,
        cwd: WORKSPACE,
        encoding: 'utf8',
        timeout: 60000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDECODE: '' },
      }
    ).trim();

    return {
      skillId: skill.id,
      type: 'structured',
      success: true,
      output: report || 'Report generated but empty.',
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      skillId: skill.id,
      type: 'structured',
      success: false,
      output: `Report generation failed: ${err.message}`,
      duration: Date.now() - start,
    };
  }
}

/**
 * Run a single skill by ID with context.
 */
async function runSkill(skillId, email, context) {
  const skill = getSkillById(skillId);
  if (!skill) return { skillId, success: false, output: `Skill not found: ${skillId}`, duration: 0 };
  if (!skill.enabled) return { skillId, success: false, output: `Skill disabled: ${skillId}`, duration: 0 };

  switch (skill.type) {
    case 'direct':
      return runDirectSkill(skill, context);
    case 'claude':
      return await runClaudeSkill(skill, email, context);
    case 'structured':
      return await runStructuredSkill(skill, email, context);
    case 'gated':
      return await runSystemChangeSkill(skill, email, context);
    case 'context-loader':
      return await runRememberContextSkill(skill, email, context);
    default:
      return { skillId, success: false, output: `Unknown skill type: ${skill.type}`, duration: 0 };
  }
}

/**
 * Route structured skills to their specific handlers.
 */
async function runStructuredSkill(skill, email, context) {
  switch (skill.id) {
    case 'create-task':
      return await runCreateTaskSkill(skill, email, context);
    case 'manage-files':
      return await runManageFilesSkill(skill, email, context);
    case 'generate-report':
      return await runGenerateReportSkill(skill, email, context);
    default:
      return { skillId: skill.id, success: false, output: `No handler for structured skill: ${skill.id}`, duration: 0 };
  }
}

/**
 * Execute a plan (array of skill IDs) sequentially.
 * Direct skills run first (fast), then claude skills.
 */
async function executePlan(skillIds, email, context) {
  const config = loadSkillsConfig();
  const maxSkills = config.maxSkillsPerRequest || 5;
  const toRun = skillIds.slice(0, maxSkills);

  // Sort: direct skills first (fast), then claude (slow)
  const skills = toRun.map(id => getSkillById(id)).filter(Boolean);
  const directSkills = skills.filter(s => s.type === 'direct').map(s => s.id);
  const claudeSkills = skills.filter(s => s.type === 'claude').map(s => s.id);
  const ordered = [...directSkills, ...claudeSkills];

  const results = [];
  for (const skillId of ordered) {
    const result = await runSkill(skillId, email, context);
    results.push(result);
  }
  return results;
}

// ── Skills CRUD ──────────────────────────────────────────

function addSkill(skillData) {
  const config = loadSkillsConfig();
  const id = skillData.id || 'skill-' + Date.now().toString(36);
  const skill = {
    id,
    name: skillData.name || id,
    description: skillData.description || '',
    enabled: skillData.enabled !== false,
    type: skillData.type || 'direct',
    builtIn: false,
    intentPatterns: skillData.intentPatterns || [],
    timeout: skillData.timeout || (skillData.type === 'claude' ? 120 : 10),
  };
  if (skill.type === 'claude') {
    skill.model = skillData.model || config.defaultModel || 'sonnet';
    skill.promptTemplate = skillData.promptTemplate || '';
  } else {
    skill.command = skillData.command || 'echo "no command"';
  }
  config.skills.push(skill);
  fs.writeFileSync(SKILLS_PATH, JSON.stringify(config, null, 2));
  return skill;
}

function toggleSkill(id, enabled) {
  const config = loadSkillsConfig();
  const skill = config.skills.find(s => s.id === id);
  if (!skill) return null;
  skill.enabled = enabled;
  fs.writeFileSync(SKILLS_PATH, JSON.stringify(config, null, 2));
  return skill;
}

function deleteSkill(id) {
  const config = loadSkillsConfig();
  const idx = config.skills.findIndex(s => s.id === id);
  if (idx === -1) return false;
  if (config.skills[idx].builtIn) return false;
  config.skills.splice(idx, 1);
  fs.writeFileSync(SKILLS_PATH, JSON.stringify(config, null, 2));
  return true;
}

function getAllSkills() {
  return loadSkillsConfig().skills;
}

function getArlConfig() {
  const config = loadSkillsConfig();
  return {
    arlEnabled: config.arlEnabled,
    defaultModel: config.defaultModel,
    maxSkillsPerRequest: config.maxSkillsPerRequest,
    globalTimeout: config.globalTimeout,
    replyWindowMinutes: config.replyWindowMinutes,
    fastPollSeconds: config.fastPollSeconds,
  };
}

function setArlEnabled(enabled) {
  const config = loadSkillsConfig();
  config.arlEnabled = enabled;
  fs.writeFileSync(SKILLS_PATH, JSON.stringify(config, null, 2));
  return enabled;
}

module.exports = {
  getEnabledSkills,
  getSkillById,
  runSkill,
  executePlan,
  addSkill,
  toggleSkill,
  deleteSkill,
  getAllSkills,
  getArlConfig,
  setArlEnabled,
};
