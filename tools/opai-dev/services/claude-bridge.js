/**
 * OPAI Dev — Claude Code CLI Bridge (WebSocket over Unix socket)
 *
 * Bridges Theia IDE containers to the Claude Code CLI on the host.
 * Uses a Unix domain socket (mounted into containers) to bypass firewall issues.
 *
 * Protocol:
 *   Client sends: { type: "prompt", prompt: "...", cwd: "/home/project/..." }
 *   Server sends: { type: "token", content: "..." }         (streaming)
 *   Server sends: { type: "result", content: "..." }        (final)
 *   Server sends: { type: "error", message: "..." }         (error)
 *
 * Socket paths:
 *   Host:      /tmp/opai-claude-bridge.sock (configurable via CLAUDE_BRIDGE_SOCKET)
 *   Container: /tmp/opai-claude-bridge.sock (mounted read-write)
 *
 * Start separately:  node services/claude-bridge.js
 * Or import and call: require('./claude-bridge').start()
 */

const http = require('http');
const fs = require('fs');
const { WebSocketServer, WebSocket } = require('ws');
const { spawn } = require('child_process');
const path = require('path');

// Load env if running standalone
if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
}

const SOCKET_PATH = process.env.CLAUDE_BRIDGE_SOCKET || '/tmp/opai-claude-bridge.sock';
const REQUEST_TIMEOUT = parseInt(process.env.CLAUDE_BRIDGE_TIMEOUT || '300000', 10); // 5 min
const NFS_ROOT = process.env.NFS_WORKSPACE_ROOT || '/workspace/users';
const OPAI_ROOT = process.env.OPAI_ROOT || '/workspace/synced/opai';

// Track active sessions: userId → child process
const activeSessions = new Map();

/**
 * Resolve the Claude CLI path (may need nvm).
 */
function findClaudeCli() {
  const nvmPath = path.join(process.env.HOME || '/home/dallas', '.nvm/versions/node/v20.19.5/bin/claude');
  if (fs.existsSync(nvmPath)) return nvmPath;
  return 'claude'; // fallback to PATH
}

/**
 * Resolve the working directory for a user's prompt.
 * Maps container paths back to host paths.
 */
function resolveHostCwd(userId, containerCwd, role) {
  let baseRoot;
  if (role === 'admin') {
    baseRoot = OPAI_ROOT;
  } else {
    const uuidPath = path.join(NFS_ROOT, userId);
    try {
      baseRoot = fs.realpathSync(uuidPath);
    } catch {
      baseRoot = path.join(NFS_ROOT, userId);
    }
  }

  // If cwd starts with /home/project, map it relative to Projects/
  if (containerCwd && containerCwd.startsWith('/home/project')) {
    const relative = containerCwd.replace('/home/project', '');
    return path.join(baseRoot, 'Projects', relative);
  }

  return baseRoot;
}

/**
 * Handle a prompt request from a WebSocket client.
 */
function handlePrompt(ws, userId, role, data) {
  const { prompt, cwd } = data;

  if (!prompt || typeof prompt !== 'string') {
    ws.send(JSON.stringify({ type: 'error', message: 'prompt is required' }));
    return;
  }

  // One session per user at a time
  if (activeSessions.has(userId)) {
    ws.send(JSON.stringify({ type: 'error', message: 'A request is already in progress. Wait for it to complete.' }));
    return;
  }

  const hostCwd = resolveHostCwd(userId, cwd, role);
  const claudePath = findClaudeCli();

  const env = {
    ...process.env,
    HOME: process.env.HOME || '/home/dallas',
  };
  // Strip Claude session vars to avoid nested-session detection
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  const child = spawn(claudePath, ['-p', '--output-format', 'stream-json', '--verbose'], {
    cwd: hostCwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  activeSessions.set(userId, child);

  // Write prompt to stdin
  child.stdin.write(prompt);
  child.stdin.end();

  let output = '';
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    ws.send(JSON.stringify({ type: 'error', message: 'Request timed out' }));
  }, REQUEST_TIMEOUT);

  // Stream stdout line-by-line (stream-json outputs one JSON object per line)
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === 'content_block_delta' || event.type === 'assistant') {
          const text = event.content_block?.text || event.delta?.text || '';
          if (text) {
            output += text;
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'token', content: text }));
            }
          }
        } else if (event.type === 'result') {
          output = event.result || output;
        }
      } catch {
        // Not JSON or unrecognized format — send raw as token
        if (ws.readyState === WebSocket.OPEN) {
          output += line;
          ws.send(JSON.stringify({ type: 'token', content: line }));
        }
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    console.error(`[claude-bridge] stderr (${userId.substring(0, 8)}):`, chunk.toString().trim());
  });

  child.on('close', (code) => {
    clearTimeout(timeout);
    activeSessions.delete(userId);

    if (timedOut) return;

    // Process any remaining buffer
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer);
        if (event.type === 'result') {
          output = event.result || output;
        }
      } catch {
        output += buffer;
      }
    }

    if (ws.readyState === WebSocket.OPEN) {
      if (code === 0) {
        ws.send(JSON.stringify({ type: 'result', content: output }));
      } else {
        ws.send(JSON.stringify({ type: 'error', message: `Claude CLI exited with code ${code}` }));
      }
    }
  });

  // If WebSocket disconnects, kill the child process
  ws.on('close', () => {
    if (activeSessions.get(userId) === child) {
      child.kill('SIGTERM');
      activeSessions.delete(userId);
      clearTimeout(timeout);
    }
  });
}

/**
 * Handle an OpenAI-compatible /v1/chat/completions request.
 * Converts the OpenAI format to a Claude CLI prompt, streams the response back
 * as Server-Sent Events in OpenAI streaming format.
 */
function handleOpenAIRequest(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }));
    }

    const messages = parsed.messages || [];
    const stream = parsed.stream !== false; // default to streaming

    // Convert OpenAI messages to a single prompt for Claude CLI
    const prompt = messages
      .map(m => {
        if (m.role === 'system') return `[System]: ${m.content}`;
        if (m.role === 'user') return m.content;
        if (m.role === 'assistant') return `[Previous assistant response]: ${m.content}`;
        return m.content;
      })
      .join('\n\n');

    if (!prompt.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'No messages provided' } }));
    }

    // Default user for socket connections (trusted)
    const userId = 'openai-compat';
    const role = 'admin';
    const hostCwd = resolveHostCwd('1c93c5fe-d304-40f2-9169-765d0d2b7638', '/home/project', role);
    const claudePath = findClaudeCli();

    const env = { ...process.env, HOME: process.env.HOME || '/home/dallas' };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    const child = spawn(claudePath, ['-p', '--output-format', 'text'], {
      cwd: hostCwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    console.log(`[claude-bridge] openai-compat: spawning ${claudePath} in ${hostCwd}`);
    console.log(`[claude-bridge] openai-compat: prompt length=${prompt.length}, stream=${stream}`);

    child.stdin.write(prompt);
    child.stdin.end();

    const requestId = `chatcmpl-${Date.now()}`;

    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      let buffer = '';
      child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        // Send as OpenAI streaming delta
        const event = {
          id: requestId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'claude-code',
          choices: [{
            index: 0,
            delta: { content: text },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      });

      child.stderr.on('data', (chunk) => {
        console.error(`[claude-bridge] openai-compat stderr:`, chunk.toString().trim());
      });

      child.on('close', (code) => {
        // Send final event
        const done = {
          id: requestId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'claude-code',
          choices: [{
            index: 0,
            delta: {},
            finish_reason: 'stop',
          }],
        };
        res.write(`data: ${JSON.stringify(done)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
    } else {
      // Non-streaming: collect full response
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk.toString(); });
      child.stderr.on('data', (chunk) => {
        console.error(`[claude-bridge] openai-compat stderr:`, chunk.toString().trim());
      });
      child.on('close', (code) => {
        console.log(`[claude-bridge] openai-compat: claude exited code=${code}, output length=${output.length}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: requestId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'claude-code',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: output },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }));
      });
    }

    // Timeout
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
    }, REQUEST_TIMEOUT);
    child.on('close', () => clearTimeout(timeout));

    // If client disconnects before response is sent, kill the process
    res.on('close', () => {
      if (!res.writableFinished) {
        console.log('[claude-bridge] openai-compat: client disconnected, killing child');
        child.kill('SIGTERM');
        clearTimeout(timeout);
      }
    });
  });
}

/**
 * Start the WebSocket bridge server on a Unix domain socket.
 */
function start() {
  // Remove stale socket file
  try {
    if (fs.existsSync(SOCKET_PATH)) {
      fs.unlinkSync(SOCKET_PATH);
    }
  } catch (err) {
    console.error(`[claude-bridge] Could not remove stale socket: ${err.message}`);
  }

  // Create HTTP server on Unix socket with OpenAI-compatible API + WebSocket
  const httpServer = http.createServer((req, res) => {
    // OpenAI-compatible chat completions endpoint for Theia AI Chat
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      return handleOpenAIRequest(req, res);
    }
    // Model listing for Theia provider discovery
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        object: 'list',
        data: [{
          id: 'claude-code',
          object: 'model',
          created: Date.now(),
          owned_by: 'opai',
        }],
      }));
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OPAI Claude Bridge');
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on('error', (err) => {
    console.error(`[claude-bridge] Server error:`, err.message);
  });

  wss.on('connection', (ws, req) => {
    // Unix socket connections are inherently trusted — only containers with the
    // socket mounted can connect. Auth is handled at the container creation level
    // (only authenticated users can create containers that get the socket mount).
    // Default to admin for now; future: pass user identity via container labels.
    let userId = '1c93c5fe-d304-40f2-9169-765d0d2b7638';
    let userRole = 'admin';

    console.log(`[claude-bridge] New connection`);

    ws.on('message', async (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }

      if (data.type === 'prompt') {
        handlePrompt(ws, userId, userRole, data);
      } else {
        ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${data.type}` }));
      }
    });

    ws.on('close', () => {
      if (activeSessions.has(userId)) {
        const child = activeSessions.get(userId);
        child.kill('SIGTERM');
        activeSessions.delete(userId);
      }
    });
  });

  httpServer.on('error', (err) => {
    console.error(`[claude-bridge] Failed to start: ${err.message}`);
  });

  httpServer.listen(SOCKET_PATH, () => {
    // Make socket world-readable/writable so container user can access it
    fs.chmodSync(SOCKET_PATH, 0o777);
    console.log(`[claude-bridge] Listening on Unix socket: ${SOCKET_PATH}`);
  });

  return wss;
}

// Standalone execution
if (require.main === module) {
  start();
}

module.exports = { start };
