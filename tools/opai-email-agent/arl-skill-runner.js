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
    const accountId = context.accountId || 'arl-agent-pw';
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

// ── Structured skill: prd-intake ──────────────────────────

/**
 * Classify incoming email as full_spec or short_brief, save to Research/,
 * and submit to PRD Pipeline.
 */
async function runPrdIntakeSkill(skill, email, context) {
  const start = Date.now();

  try {
    const body = (email.body || '').slice(0, 8000);
    const subject = email.subject || '';
    const sender = email.fromAddress || email.from || '';

    // Step 1: Classify via Claude Haiku (cheap)
    const classifyPrompt = `Classify this email as either a full technical spec/PRD or a short project brief/idea.

Return ONLY valid JSON:
{
  "document_type": "full_spec" or "short_brief",
  "title": "extracted project title",
  "summary": "1-2 sentence summary of the idea/spec",
  "slug": "kebab-case-project-slug"
}

Rules:
- "full_spec" = has architecture, tech stack, data models, API design, or detailed implementation details
- "short_brief" = a brief idea description, feature request, or high-level concept

Email from: ${sender}
Subject: ${subject}
Body:
${body}`;

    const classifyResult = execSync(
      `claude -p --model haiku --output-format text`,
      {
        input: classifyPrompt,
        cwd: WORKSPACE,
        encoding: 'utf8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDECODE: '' },
      }
    ).trim();

    let classification;
    try {
      const jsonMatch = classifyResult.match(/\{[\s\S]*\}/);
      classification = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch { classification = null; }

    if (!classification) {
      classification = {
        document_type: body.length > 2000 ? 'full_spec' : 'short_brief',
        title: subject.replace(/^(re:|fwd?:)\s*/gi, '').trim() || 'Untitled Idea',
        summary: body.slice(0, 200),
        slug: (subject || 'untitled').toLowerCase().replace(/[^\w\s-]/g, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 40),
      };
    }

    const slug = (classification.slug || 'untitled').replace(/[^a-z0-9-]/g, '').slice(0, 40);
    const docType = classification.document_type || 'short_brief';
    const title = classification.title || subject || 'Untitled Idea';

    // Step 2: Save to Research/{slug}/
    const researchDir = path.join(WORKSPACE, 'Research', slug);
    fs.mkdirSync(researchDir, { recursive: true });

    // Save the original document
    const docFilename = docType === 'full_spec' ? 'SPEC-original.md' : 'brief.md';
    const docContent = `# ${title}\n\n**From:** ${sender}\n**Date:** ${new Date().toISOString()}\n**Subject:** ${subject}\n\n---\n\n${email.body || ''}`;
    fs.writeFileSync(path.join(researchDir, docFilename), docContent, 'utf8');

    // Save intake metadata
    const metadata = {
      title,
      slug,
      document_type: docType,
      summary: classification.summary || '',
      sender,
      subject,
      received_at: new Date().toISOString(),
      research_path: `Research/${slug}`,
      pipeline_submitted: false,
      pipeline_id: null,
    };
    fs.writeFileSync(path.join(researchDir, 'intake-metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');

    // Step 3: Submit to PRD Pipeline
    let pipelineResult = null;
    try {
      const submitPayload = JSON.stringify({
        title,
        pain_point: '',
        solution: classification.summary || '',
        product_description: (email.body || '').slice(0, 5000),
        target_market: '',
        notes: `Type: ${docType} | Source: email | Sender: ${sender} | Research: Research/${slug}`,
      });

      pipelineResult = await new Promise((resolve, reject) => {
        const req = http.request('http://127.0.0.1:8097/api/submit', {
          method: 'POST',
          timeout: 15000,
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Service': 'email-agent',
          },
        }, (res) => {
          let body = '';
          res.on('data', d => { body += d; });
          res.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch { resolve({ error: `Non-JSON response (HTTP ${res.statusCode})` }); }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('PRD pipeline timeout')); });
        req.end(submitPayload);
      });

      if (pipelineResult.idea_id) {
        metadata.pipeline_submitted = true;
        metadata.pipeline_id = pipelineResult.idea_id;
        fs.writeFileSync(path.join(researchDir, 'intake-metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
      }
    } catch (pipeErr) {
      // Graceful fallback — document is saved to Research/ even if pipeline is down
      pipelineResult = { error: pipeErr.message };
    }

    // Step 4: Return confirmation
    const pipelineStatus = pipelineResult?.idea_id
      ? `Submitted to PRD Pipeline (ID: ${pipelineResult.idea_id})`
      : `Pipeline submit failed: ${pipelineResult?.error || 'unknown'} — document saved to Research/${slug} for manual processing`;

    return {
      skillId: skill.id,
      type: 'structured',
      success: true,
      output: `Project idea/spec received and processed!\n\nTitle: ${title}\nType: ${docType === 'full_spec' ? 'Full Technical Spec' : 'Short Brief'}\nSaved to: Research/${slug}/${docFilename}\nPipeline: ${pipelineStatus}`,
      duration: Date.now() - start,
      details: {
        document_type: docType,
        research_path: `Research/${slug}`,
        pipeline_id: pipelineResult?.idea_id || null,
      },
    };
  } catch (err) {
    return {
      skillId: skill.id,
      type: 'structured',
      success: false,
      output: `PRD intake failed: ${err.message}`,
      duration: Date.now() - start,
    };
  }
}

// ── Structured skill: process-transcript ──────────────────

const PENDING_TRANSCRIPTS_DIR = path.join(__dirname, 'data', 'pending-transcripts');

/**
 * Helper: HTTP request to Team Hub internal API.
 */
function thRequest(method, endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString();
    const url = `http://127.0.0.1:8089/api/internal/${endpoint}${qs ? '?' + qs : ''}`;
    const req = http.request(url, { method, timeout: 10000, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve({ error: `Non-JSON response (HTTP ${res.statusCode}): ${body.slice(0, 200)}` }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('TeamHub timeout')); });
    req.end('{}');
  });
}

/**
 * Analyze meeting transcript and extract multi-type action items.
 */
async function runProcessTranscriptSkill(skill, email, context) {
  const start = Date.now();
  const { resolveUser, getUserId } = require('./user-resolver');
  const user = resolveUser(email.fromAddress || email.from);

  try {
    // Step 1: Read transcript content
    let transcriptText = '';
    if (email._transcriptPath && !email._isAudioTranscript) {
      try {
        transcriptText = fs.readFileSync(email._transcriptPath, 'utf8');
      } catch { /* fall back to body */ }
    }
    if (email._isAudioTranscript) {
      return {
        skillId: skill.id,
        type: 'structured',
        success: true,
        output: `Audio recording saved to: ${email._transcriptPath}\n\nPlease provide a text transcript for processing. Audio-to-text conversion (Whisper) is not yet integrated.\n\nYou can reply with the text transcript and it will be processed.`,
        duration: Date.now() - start,
      };
    }
    if (!transcriptText) {
      transcriptText = email.body || '';
    }
    if (!transcriptText.trim()) {
      return {
        skillId: skill.id,
        type: 'structured',
        success: false,
        output: 'No transcript content found in the email body or attachment.',
        duration: Date.now() - start,
      };
    }

    // Step 2: Claude analysis — extract multi-type action items
    const analysisPrompt = `Analyze this meeting transcript and extract actionable items. Return ONLY valid JSON.

IMPORTANT: Classify each item by type:
- "task": concrete work to be done (build, fix, update, create, deploy)
- "quote": client asked for pricing, estimate, or proposal
- "research": someone needs information gathered, compared, or analyzed
- "follow_up": revisit/check back on something at a future date
- "email": someone needs to be contacted/notified about something

Return JSON:
{
  "overview": "2-3 sentence summary of the meeting",
  "client_name": "detected client/company name or null",
  "participants": ["names mentioned"],
  "action_items": [
    {
      "type": "task|quote|research|follow_up|email",
      "title": "imperative action title",
      "description": "detailed description with context from transcript",
      "priority": "high|medium|low",
      "assignee_hint": "person mentioned or null",
      "due_hint": "any deadline mentioned or null",
      "follow_up_hint": "follow-up date if applicable or null",
      "checklist": ["sub-steps if task type"],
      "category": "development|marketing|admin|sales|support|other",
      "recipient_hint": "email recipient for email type or null",
      "pricing_details": "any pricing info for quote type or null",
      "research_question": "what to research for research type or null"
    }
  ],
  "key_decisions": ["decisions made during the meeting"]
}

Transcript:
${transcriptText.slice(0, 12000)}`;

    const analysisResult = execSync(
      `claude -p --model sonnet --output-format text`,
      {
        input: analysisPrompt,
        cwd: WORKSPACE,
        encoding: 'utf8',
        timeout: 120000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDECODE: '' },
      }
    ).trim();

    let analysis;
    try {
      const jsonMatch = analysisResult.match(/\{[\s\S]*\}/);
      analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch { analysis = null; }

    if (!analysis || !analysis.action_items?.length) {
      return {
        skillId: skill.id,
        type: 'structured',
        success: true,
        output: `Transcript analyzed but no actionable items were detected.\n\nOverview: ${analysis?.overview || 'Could not parse transcript analysis.'}`,
        duration: Date.now() - start,
      };
    }

    // Step 3: Check TH for existing client workspace
    let thWorkspace = null;
    if (analysis.client_name) {
      try {
        const searchResult = await thRequest('GET', 'search-workspaces', { q: analysis.client_name, limit: '3' });
        if (searchResult.workspaces?.length > 0) {
          thWorkspace = searchResult.workspaces[0];
        }
      } catch (err) {
        console.log(`[ARL] TH workspace search failed (non-fatal): ${err.message}`);
      }
    }

    // Step 4: Save pending proposal
    fs.mkdirSync(PENDING_TRANSCRIPTS_DIR, { recursive: true });
    const proposalId = `ta-${Date.now()}`;
    const proposal = {
      id: proposalId,
      status: 'pending_approval',
      sender: email.fromAddress,
      senderName: user?.name || email.from,
      userId: getUserId(user),
      subject: email.subject,
      messageId: email.messageId,
      transcriptPath: email._transcriptPath || null,
      analysis,
      thWorkspace,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(PENDING_TRANSCRIPTS_DIR, `${proposalId}.json`),
      JSON.stringify(proposal, null, 2),
      'utf8'
    );

    // Step 5: Build typed approval summary
    const TYPE_ICONS = { task: 'T', quote: 'Q', research: 'R', follow_up: 'F', email: 'E' };
    const lines = [];
    lines.push(`TRANSCRIPT ANALYSIS — ${analysis.overview?.split('.')[0] || email.subject}`);
    lines.push('');
    if (analysis.client_name) {
      const wsInfo = thWorkspace ? `${thWorkspace.name} (existing)` : '(new — will be created on approval)';
      lines.push(`Client: ${analysis.client_name} | TH Space: ${wsInfo}`);
    }
    if (analysis.participants?.length) {
      lines.push(`Participants: ${analysis.participants.join(', ')}`);
    }
    lines.push('');
    lines.push(`=== ${analysis.action_items.length} ACTION ITEMS ===`);
    lines.push('');

    analysis.action_items.forEach((item, i) => {
      const icon = TYPE_ICONS[item.type] || '?';
      lines.push(`[${i + 1}] [${icon}] ${item.title}`);

      if (item.type === 'task' || item.type === 'follow_up') {
        const parts = [];
        if (item.priority) parts.push(`Priority: ${item.priority}`);
        if (item.assignee_hint) parts.push(`Assignee: ${item.assignee_hint}`);
        if (item.due_hint) parts.push(`Due: ${item.due_hint}`);
        if (item.follow_up_hint) parts.push(`Follow-up: ${item.follow_up_hint}`);
        if (parts.length) lines.push(`    ${parts.join(' | ')}`);
        if (item.checklist?.length) {
          lines.push(`    ${item.checklist.map(c => `[ ] ${c}`).join('  ')}`);
        }
      } else if (item.type === 'quote') {
        if (item.pricing_details) lines.push(`    Pricing mentioned: ${item.pricing_details}`);
      } else if (item.type === 'research') {
        if (item.research_question) lines.push(`    Question: ${item.research_question}`);
      } else if (item.type === 'follow_up') {
        if (item.follow_up_hint) lines.push(`    Follow-up: ${item.follow_up_hint}`);
      } else if (item.type === 'email') {
        if (item.recipient_hint) lines.push(`    Recipient: ${item.recipient_hint}`);
      }
      lines.push('');
    });

    if (analysis.key_decisions?.length) {
      lines.push('KEY DECISIONS:');
      analysis.key_decisions.forEach(d => lines.push(`  - ${d}`));
      lines.push('');
    }

    lines.push('---');
    lines.push('ACTIONS: Reply with one of:');
    lines.push('  "approve all" — execute all items');
    lines.push('  "approve 1,3,6" — execute specific items by number');
    lines.push('  "reject" — discard all');
    lines.push('  "edit" — reply with corrections');

    return {
      skillId: skill.id,
      type: 'structured',
      success: true,
      output: lines.join('\n'),
      duration: Date.now() - start,
      details: {
        proposalId,
        itemCount: analysis.action_items.length,
        clientName: analysis.client_name,
      },
    };
  } catch (err) {
    return {
      skillId: skill.id,
      type: 'structured',
      success: false,
      output: `Transcript processing failed: ${err.message}`,
      duration: Date.now() - start,
    };
  }
}

// ── Structured skill: approve-transcript ──────────────────

/**
 * Process approval/rejection of extracted transcript action items.
 */
async function runApproveTranscriptSkill(skill, email, context) {
  const start = Date.now();
  const { resolveUser, getUserId, getWorkspaceId } = require('./user-resolver');
  const user = resolveUser(email.fromAddress || email.from);
  const userId = getUserId(user);

  try {
    // Step 1: Load pending proposal matching this sender
    if (!fs.existsSync(PENDING_TRANSCRIPTS_DIR)) {
      return { skillId: skill.id, type: 'structured', success: false,
        output: 'No pending transcript proposals found.', duration: Date.now() - start };
    }

    let proposal = null;
    let proposalFile = null;

    // Use pendingFile from context if intent parser found it
    if (context.pendingFile) {
      proposalFile = path.join(PENDING_TRANSCRIPTS_DIR, context.pendingFile);
      try {
        proposal = JSON.parse(fs.readFileSync(proposalFile, 'utf8'));
      } catch { /* will search below */ }
    }

    if (!proposal) {
      const files = fs.readdirSync(PENDING_TRANSCRIPTS_DIR).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const data = JSON.parse(fs.readFileSync(path.join(PENDING_TRANSCRIPTS_DIR, file), 'utf8'));
        if (data.status === 'pending_approval' && data.sender?.toLowerCase() === (email.fromAddress || '').toLowerCase()) {
          proposal = data;
          proposalFile = path.join(PENDING_TRANSCRIPTS_DIR, file);
          break;
        }
      }
    }

    if (!proposal) {
      return { skillId: skill.id, type: 'structured', success: false,
        output: 'No pending transcript proposal found for your email address.', duration: Date.now() - start };
    }

    // Step 2: Parse approval intent from email body
    const body = (email.body || '').toLowerCase().trim();
    const items = proposal.analysis?.action_items || [];
    let approvedIndices = [];

    if (/reject/.test(body)) {
      // Rejection
      proposal.status = 'rejected';
      proposal.resolvedAt = new Date().toISOString();
      fs.writeFileSync(proposalFile, JSON.stringify(proposal, null, 2), 'utf8');
      return { skillId: skill.id, type: 'structured', success: true,
        output: 'All transcript items have been rejected. No actions taken.', duration: Date.now() - start };
    } else if (/approve\s*all/.test(body)) {
      approvedIndices = items.map((_, i) => i);
    } else {
      // Parse "approve 1,3,5"
      const numMatch = body.match(/approve\s+([\d,\s]+)/);
      if (numMatch) {
        approvedIndices = numMatch[1].split(/[,\s]+/).map(n => parseInt(n, 10) - 1).filter(n => n >= 0 && n < items.length);
      }
    }

    if (approvedIndices.length === 0) {
      return { skillId: skill.id, type: 'structured', success: false,
        output: 'Could not parse approval. Reply with "approve all", "approve 1,3,5", or "reject".', duration: Date.now() - start };
    }

    // Step 3: Execute each approved item by type
    const results = { tasks: [], quotes: [], research: [], emails: [], follow_ups: [], errors: [] };
    const workspaceId = getWorkspaceId(user);

    // Find or create folder for meeting action items
    let folderId = null;
    try {
      const folders = await thRequest('GET', 'list-folders', { workspace_id: workspaceId });
      const existing = (folders || []).find?.(f => f.name === 'Meeting Action Items') ||
                       (Array.isArray(folders) ? folders.find(f => f.name === 'Meeting Action Items') : null);
      if (existing) {
        folderId = existing.id;
      } else {
        const newFolder = await thRequest('POST', 'create-folder', { workspace_id: workspaceId, name: 'Meeting Action Items' });
        folderId = newFolder?.id || null;
      }
    } catch (err) {
      console.log(`[ARL] Folder creation failed (non-fatal): ${err.message}`);
    }

    // Create a list for this meeting
    let listId = null;
    try {
      const dateStr = new Date().toISOString().split('T')[0];
      const listName = `${dateStr} — ${proposal.analysis?.overview?.split('.')[0] || 'Meeting Items'}`.slice(0, 100);
      const listParams = { workspace_id: workspaceId, name: listName };
      if (folderId) listParams.folder_id = folderId;
      const newList = await thRequest('POST', 'create-list', listParams);
      listId = newList?.id || null;
    } catch (err) {
      console.log(`[ARL] List creation failed (non-fatal): ${err.message}`);
    }

    for (const idx of approvedIndices) {
      const item = items[idx];
      if (!item) continue;

      try {
        switch (item.type) {
          case 'task':
          case 'follow_up': {
            // Create TH item
            const itemParams = {
              workspace_id: workspaceId,
              user_id: userId,
              type: 'task',
              title: item.title.slice(0, 200),
              description: item.description?.slice(0, 2000) || '',
              priority: item.priority || 'medium',
              source: 'transcript-agent',
            };
            if (item.due_hint) itemParams.due_date = item.due_hint;
            if (item.follow_up_hint) itemParams.due_date = item.follow_up_hint;
            if (listId) itemParams.list_id = listId;

            const thItem = await thRequest('POST', 'create-item', itemParams);

            // Add context comment with transcript excerpt
            if (thItem?.id) {
              try {
                await thRequest('POST', 'add-comment', {
                  item_id: thItem.id,
                  content: `[Transcript Agent] ${item.description || item.title}`.slice(0, 1000),
                  author_id: userId,
                });
              } catch { /* non-fatal */ }
            }

            const bucket = item.type === 'follow_up' ? 'follow_ups' : 'tasks';
            results[bucket].push({ title: item.title, id: thItem?.id });
            break;
          }

          case 'quote': {
            // Generate quote via Claude
            const quotePrompt = `Generate a professional pricing quote/proposal based on the following details.
Client: ${proposal.analysis?.client_name || 'Client'}
Pricing details mentioned: ${item.pricing_details || 'None specified'}
Context: ${item.description || item.title}

Format as a clean text document with:
- Client name and date
- Line items with pricing
- Terms and conditions (Net 30, standard)
- Validity period (30 days)
Keep it concise and professional.`;

            const quoteText = execSync(
              `claude -p --model sonnet --output-format text`,
              {
                input: quotePrompt,
                cwd: WORKSPACE,
                encoding: 'utf8',
                timeout: 60000,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, CLAUDECODE: '' },
              }
            ).trim();

            results.quotes.push({ title: item.title, quote: quoteText });
            break;
          }

          case 'research': {
            // Run research via Claude
            const researchPrompt = `Research the following topic thoroughly and provide a structured findings summary.

Research question: ${item.research_question || item.title}
Context: ${item.description || ''}

Provide:
1. Key findings (bullet points)
2. Recommendations
3. Sources/references if applicable
Keep it actionable and concise.`;

            const researchText = execSync(
              `claude -p --model sonnet --output-format text`,
              {
                input: researchPrompt,
                cwd: WORKSPACE,
                encoding: 'utf8',
                timeout: 90000,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, CLAUDECODE: '' },
              }
            ).trim();

            results.research.push({ title: item.title, findings: researchText });
            break;
          }

          case 'email': {
            // Draft email and queue for approval
            const draftPrompt = `Draft a professional email based on the following context.

To: ${item.recipient_hint || 'recipient'}
Subject context: ${item.title}
Details: ${item.description || ''}

Write ONLY the email body (no subject line). Keep it concise and professional.`;

            const draftText = execSync(
              `claude -p --model haiku --output-format text`,
              {
                input: draftPrompt,
                cwd: WORKSPACE,
                encoding: 'utf8',
                timeout: 30000,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, CLAUDECODE: '' },
              }
            ).trim();

            // Queue to email agent's approval queue
            const { addToQueue } = require('./agent-core');
            const queueItem = addToQueue({
              sender: email.fromAddress,
              subject: `[Transcript Action] ${item.title}`,
              draft: draftText,
              reason: 'Transcript agent — email draft requires review',
              recipientHint: item.recipient_hint,
            });

            results.emails.push({ title: item.title, recipient: item.recipient_hint, queueId: queueItem?.id });
            break;
          }
        }
      } catch (err) {
        results.errors.push({ title: item.title, error: err.message });
      }
    }

    // Step 4: Update pending file
    proposal.status = 'approved';
    proposal.resolvedAt = new Date().toISOString();
    proposal.approvedIndices = approvedIndices.map(i => i + 1);
    proposal.results = results;
    fs.writeFileSync(proposalFile, JSON.stringify(proposal, null, 2), 'utf8');

    // Step 5: Build confirmation response
    const confirmLines = [];
    confirmLines.push('TRANSCRIPT ITEMS — EXECUTION COMPLETE');
    confirmLines.push('');

    if (results.tasks.length > 0) {
      confirmLines.push(`TASKS CREATED (${results.tasks.length}):`);
      results.tasks.forEach(t => confirmLines.push(`  - ${t.title} (ID: ${t.id || 'pending'})`));
      confirmLines.push('');
    }
    if (results.follow_ups.length > 0) {
      confirmLines.push(`FOLLOW-UPS CREATED (${results.follow_ups.length}):`);
      results.follow_ups.forEach(t => confirmLines.push(`  - ${t.title} (ID: ${t.id || 'pending'})`));
      confirmLines.push('');
    }
    if (results.quotes.length > 0) {
      confirmLines.push(`QUOTES GENERATED (${results.quotes.length}):`);
      results.quotes.forEach(q => {
        confirmLines.push(`  - ${q.title}`);
        confirmLines.push('');
        confirmLines.push(q.quote);
        confirmLines.push('');
      });
    }
    if (results.research.length > 0) {
      confirmLines.push(`RESEARCH COMPLETED (${results.research.length}):`);
      results.research.forEach(r => {
        confirmLines.push(`  - ${r.title}`);
        confirmLines.push('');
        confirmLines.push(r.findings);
        confirmLines.push('');
      });
    }
    if (results.emails.length > 0) {
      confirmLines.push(`EMAILS DRAFTED (${results.emails.length}):`);
      results.emails.forEach(e => confirmLines.push(`  - ${e.title} → ${e.recipient || 'TBD'} (queued for review)`));
      confirmLines.push('');
    }
    if (results.errors.length > 0) {
      confirmLines.push(`ERRORS (${results.errors.length}):`);
      results.errors.forEach(e => confirmLines.push(`  - ${e.title}: ${e.error}`));
      confirmLines.push('');
    }

    return {
      skillId: skill.id,
      type: 'structured',
      success: true,
      output: confirmLines.join('\n'),
      duration: Date.now() - start,
      details: {
        approved: approvedIndices.length,
        tasksCreated: results.tasks.length + results.follow_ups.length,
        quotesGenerated: results.quotes.length,
        researchDone: results.research.length,
        emailsDrafted: results.emails.length,
        errors: results.errors.length,
      },
    };
  } catch (err) {
    return {
      skillId: skill.id,
      type: 'structured',
      success: false,
      output: `Approval processing failed: ${err.message}`,
      duration: Date.now() - start,
    };
  }
}

/**
 * Route structured skills to their specific handlers.
 */
async function runStructuredSkill(skill, email, context) {
  switch (skill.id) {
    case 'prd-intake':
      return await runPrdIntakeSkill(skill, email, context);
    case 'create-task':
      return await runCreateTaskSkill(skill, email, context);
    case 'manage-files':
      return await runManageFilesSkill(skill, email, context);
    case 'generate-report':
      return await runGenerateReportSkill(skill, email, context);
    case 'process-transcript':
      return await runProcessTranscriptSkill(skill, email, context);
    case 'approve-transcript':
      return await runApproveTranscriptSkill(skill, email, context);
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
