/**
 * Claude CLI Handler — Spawns Claude Code CLI and returns the response.
 *
 * Session resume is now controlled by the conversation-state module.
 * When forceNewSession is true, starts a fresh Claude session.
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { updateSessionId } = require('./conversation-state');

const OPAI_ROOT = process.env.OPAI_ROOT || path.resolve(__dirname, '../..');
const CLAUDE_TIMEOUT = parseInt(process.env.CLAUDE_TIMEOUT || '300000', 10);

// Resolve claude CLI binary path
let CLAUDE_BIN = 'claude';
try {
  CLAUDE_BIN = execSync('which claude', { encoding: 'utf8' }).trim();
} catch {
  const candidates = [
    path.join(os.homedir(), '.nvm/versions/node', process.version, 'bin/claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) { CLAUDE_BIN = p; break; }
  }
}

/**
 * Parse JSON output from claude --output-format json.
 */
function parseResponse(stdout) {
  try {
    const data = JSON.parse(stdout.trim());
    return {
      text: data.result || '',
      sessionId: data.session_id || null,
      error: data.is_error || false,
    };
  } catch {
    return { text: stdout, sessionId: null, error: false };
  }
}

/**
 * Invoke Claude Code CLI with a prompt.
 *
 * @param {object} opts
 * @param {string} opts.prompt - Full prompt text
 * @param {string} opts.scopeKey - Session scope key (chatId:threadId:userId)
 * @param {boolean} [opts.useResume] - Whether to use --resume (from state machine)
 * @param {string} [opts.sessionId] - Session ID to resume (from state machine)
 * @param {string} [opts.cwd] - Working directory (default: OPAI_ROOT)
 * @param {string} [opts.mcpConfigPath] - Path to MCP config
 * @param {string} [opts.systemPrompt] - System prompt override
 * @param {boolean} [opts.restrictTools] - Only allow MCP tools
 * @returns {Promise<{text: string, sessionId: string|null}>}
 */
function askClaude(opts) {
  const { prompt, scopeKey, useResume, sessionId, cwd, mcpConfigPath, systemPrompt, restrictTools } = opts;

  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits'];

    if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath);
    if (systemPrompt) args.push('--system-prompt', systemPrompt);
    if (restrictTools) args.push('--allowedTools', 'mcp__teamhub__*');

    // Resume session only when the state machine says to
    if (useResume && sessionId) {
      args.push('--resume', sessionId);
    }

    const tmpFile = path.join(os.tmpdir(), `opai-tg-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, prompt, 'utf8');

    let stdout = '';
    let stderr = '';

    // Clean env to prevent nested Claude detection
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

    const proc = spawn(CLAUDE_BIN, args, {
      cwd: cwd || OPAI_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnv,
    });

    const input = fs.createReadStream(tmpFile);
    input.pipe(proc.stdin);

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      cleanup();
      console.error(`[TG] Timed out. stdout(${stdout.length}), stderr: ${stderr.substring(0, 300)}`);
      resolve({ text: 'Request timed out. Try breaking it into smaller parts.', sessionId: null });
    }, CLAUDE_TIMEOUT);

    function cleanup() {
      clearTimeout(timer);
      try { fs.unlinkSync(tmpFile); } catch {}
    }

    proc.on('close', code => {
      cleanup();
      if (code !== 0) {
        console.error(`[TG] Claude exit ${code} | stderr: ${stderr.substring(0, 300)}`);
      }

      const parsed = parseResponse(stdout);
      if (parsed.sessionId && scopeKey) {
        updateSessionId(scopeKey, parsed.sessionId);
      }

      const resumeLabel = useResume && sessionId ? 'resumed' : 'new';
      console.log(`[TG] Claude done (exit ${code}, ${(parsed.text || stdout).length} chars, session: ${resumeLabel})`);
      resolve({ text: parsed.text || stdout || stderr || '', sessionId: parsed.sessionId });
    });

    proc.on('error', err => {
      cleanup();
      reject(err);
    });
  });
}

/**
 * Build the system prompt for a Telegram message.
 * @param {string} username
 * @param {string} conversationContext - Context block from state machine (may be empty)
 * @param {string} userMessage
 * @param {object} [opts]
 * @param {boolean} [opts.isAdmin]
 * @param {string} [opts.workspaceName]
 * @param {string} [opts.state] - Conversation state (NEW/ACTIVE/IDLE/COLD)
 * @returns {string}
 */
function buildPrompt(username, conversationContext, userMessage, opts = {}) {
  const lines = [
    `You are OPAI Bot — an AI assistant on the OPAI platform. You are responding via Telegram to user "${username}".`,
    `Keep responses concise and Telegram-friendly (under 4000 chars when possible).`,
    `Use Telegram markdown: *bold*, \`code\`, \`\`\`code blocks\`\`\`, - lists.`,
  ];

  const inWorkspace = !!opts.workspaceName;

  if (opts.isAdmin && inWorkspace) {
    // Option B: Admin in a workspace-bound topic — Team Hub is primary context, admin is secondary
    lines.push(
      ``,
      `WORKSPACE CONTEXT: You are in the "${opts.workspaceName}" workspace.`,
      `When the user asks about "tasks", "notes", "ideas", or "items" — they mean Team Hub items for this workspace, NOT system tasks or task queue files.`,
      `The Team Hub API is at http://127.0.0.1:8089. Use it for workspace queries.`,
      ``,
      `You also have admin-level access to the OPAI platform if the user explicitly asks about system operations, services, logs, or infrastructure.`,
      `OPAI workspace: ${OPAI_ROOT}. Key paths: tools/, config/, scripts/, Library/opai-wiki/.`,
      `Only use filesystem tools or system commands when the user specifically asks for system-level operations.`,
      `Do NOT use tools unless the user explicitly asks you to perform an action.`,
      `For simple greetings or questions, just respond directly.`,
    );
  } else if (opts.isAdmin) {
    // Pure admin context (DM, general topic, unbound topic)
    lines.push(
      ``,
      `You are running in an ADMIN conversation with full access to the OPAI workspace filesystem, tools, and orchestrator.`,
      `You have access to the OPAI workspace at ${OPAI_ROOT}, n8n workflows (via MCP), and local files.`,
      `Key paths: tools/ (platform services), config/ (configs), scripts/ (control scripts), Library/opai-wiki/ (docs).`,
      `Do NOT use tools unless the user explicitly asks you to perform an action.`,
      `For simple greetings or questions, just respond directly.`,
    );
  } else if (inWorkspace) {
    // Member in a workspace topic — Team Hub only
    lines.push(
      ``,
      `You are a Team Hub assistant for the "${opts.workspaceName}" workspace.`,
      `You can help manage tasks, notes, and ideas within this workspace.`,
      `The Team Hub API is at http://127.0.0.1:8089.`,
      `You do NOT have access to system files, services, or admin functions.`,
    );
  } else {
    // Member outside a workspace topic
    lines.push(
      ``,
      `You are a Team Hub assistant.`,
      `Keep responses concise and helpful. You can manage tasks, notes, and ideas.`,
    );
  }

  lines.push('');
  if (conversationContext) {
    lines.push(conversationContext, '');
  }
  lines.push(`User message: ${userMessage}`);

  return lines.join('\n');
}

const DANGEROUS_TIMEOUT = 600000; // 10 minutes

/**
 * Invoke Claude Code CLI with FULL autonomous permissions (--dangerously-skip-permissions).
 * Owner-only. Used by the /danger command and "Run Dangerously" button.
 *
 * @param {object} opts
 * @param {string} opts.instruction - The task to execute
 * @param {string} opts.conversationContext - Recent conversation for context
 * @param {string} opts.scopeKey - Session scope key
 * @param {boolean} [opts.useResume] - Whether to use --resume
 * @param {string} [opts.sessionId] - Session ID to resume
 * @param {string} [opts.cwd] - Working directory (default: OPAI_ROOT)
 * @returns {Promise<{text: string, sessionId: string|null}>}
 */
function askClaudeDangerous(opts) {
  const { instruction, conversationContext, scopeKey, useResume, sessionId, cwd } = opts;

  const dangerPrompt = [
    'You are executing a task AUTONOMOUSLY — no human is watching the terminal.',
    'You have FULL access: file read/write/edit, Bash commands, MCP tools.',
    '',
    'TASK:',
    instruction,
    '',
  ];

  if (conversationContext) {
    dangerPrompt.push(
      'CONTEXT (from the ongoing Telegram conversation):',
      conversationContext,
      '',
    );
  }

  dangerPrompt.push(
    'GUIDELINES:',
    '- Execute the task completely. Do not ask for clarification.',
    '- If you encounter an error, try to fix it and continue.',
    '- Log what you changed so we can report back.',
    '- Do NOT push to git, delete branches, or run destructive git ops unless explicitly instructed.',
    `- Work in the OPAI workspace at ${OPAI_ROOT}.`,
    '- Be thorough but measured — accomplish the goal, don\'t over-engineer.',
    '',
    'Report your results as a concise summary of what was done.',
  );

  const prompt = dangerPrompt.join('\n');

  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', '--dangerously-skip-permissions'];

    if (useResume && sessionId) {
      args.push('--resume', sessionId);
    }

    const tmpFile = path.join(os.tmpdir(), `opai-tg-danger-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, prompt, 'utf8');

    let stdout = '';
    let stderr = '';

    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

    const proc = spawn(CLAUDE_BIN, args, {
      cwd: cwd || OPAI_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnv,
    });

    const input = fs.createReadStream(tmpFile);
    input.pipe(proc.stdin);

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      cleanup();
      console.error(`[TG] [DANGER] Timed out after 10m. stdout(${stdout.length}), stderr: ${stderr.substring(0, 300)}`);
      resolve({ text: 'Dangerous run timed out after 10 minutes.', sessionId: null });
    }, DANGEROUS_TIMEOUT);

    function cleanup() {
      clearTimeout(timer);
      try { fs.unlinkSync(tmpFile); } catch {}
    }

    proc.on('close', code => {
      cleanup();
      if (code !== 0) {
        console.error(`[TG] [DANGER] Claude exit ${code} | stderr: ${stderr.substring(0, 300)}`);
      }

      const parsed = parseResponse(stdout);
      if (parsed.sessionId && scopeKey) {
        updateSessionId(scopeKey, parsed.sessionId);
      }

      console.log(`[TG] [DANGER] Claude done (exit ${code}, ${(parsed.text || stdout).length} chars)`);
      resolve({ text: parsed.text || stdout || stderr || '', sessionId: parsed.sessionId });
    });

    proc.on('error', err => {
      cleanup();
      reject(err);
    });
  });
}

module.exports = { askClaude, askClaudeDangerous, buildPrompt, CLAUDE_BIN, OPAI_ROOT };
