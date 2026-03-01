#!/usr/bin/env node
/**
 * Team Hub MCP Server — stdio JSON-RPC server for Claude CLI.
 *
 * Exposes workspace-scoped Team Hub tools so Claude can manage
 * tasks, folders, lists, and items within a specific workspace.
 *
 * Usage:
 *   node teamhub-mcp.js --workspace <workspace-uuid>
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (MCP stdio transport).
 * No npm dependencies — uses Node built-in http module.
 */

const http = require('http');
const readline = require('readline');

// ── Parse CLI args ──────────────────────────────────────────
// Supports multiple --workspace flags: --workspace <id1> --workspace <id2>
const cliArgs = process.argv.slice(2);
const WORKSPACE_IDS = [];
for (let i = 0; i < cliArgs.length; i++) {
  if (cliArgs[i] === '--workspace' && cliArgs[i + 1]) {
    WORKSPACE_IDS.push(cliArgs[i + 1]);
    i++; // skip next arg
  }
}
if (WORKSPACE_IDS.length === 0) {
  process.stderr.write('ERROR: --workspace <id> is required (one or more)\n');
  process.exit(1);
}
const MULTI_WORKSPACE = WORKSPACE_IDS.length > 1;
// Default to first workspace for single-workspace mode
const DEFAULT_WORKSPACE_ID = WORKSPACE_IDS[0];

const HUB_BASE = 'http://127.0.0.1:8089/api/internal';

// ── HTTP helper (Node built-in, no deps) ────────────────────
function hubRequest(method, path, queryParams, workspaceId) {
  return new Promise((resolve, reject) => {
    const url = new URL(HUB_BASE + path);
    // Inject workspace_id (from tool arg or default)
    url.searchParams.set('workspace_id', workspaceId || DEFAULT_WORKSPACE_ID);
    if (queryParams) {
      for (const [k, v] of Object.entries(queryParams)) {
        if (v !== undefined && v !== null && v !== '') {
          url.searchParams.set(k, String(v));
        }
      }
    }

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method.toUpperCase(),
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve({ raw: body });
        }
      });
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.end();
  });
}

// ── Tool definitions ────────────────────────────────────────

// When multiple workspaces, add workspace_id to tool schemas
const WS_PROP = MULTI_WORKSPACE
  ? { workspace_id: { type: 'string', description: 'Workspace ID (use list_workspaces to see available IDs). Required when multiple workspaces are connected.' } }
  : {};

const TOOLS = [
  // Only present in multi-workspace mode
  ...(MULTI_WORKSPACE ? [{
    name: 'list_workspaces',
    description: 'List all workspaces this bot has access to. Use this first to discover workspace IDs.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  }] : []),
  {
    name: 'workspace_summary',
    description: 'Get workspace overview: name, description, member count, item stats by status.',
    inputSchema: { type: 'object', properties: { ...WS_PROP }, required: [] },
  },
  {
    name: 'list_spaces',
    description: 'List all spaces in the workspace with folder/list counts.',
    inputSchema: { type: 'object', properties: { ...WS_PROP }, required: [] },
  },
  {
    name: 'list_folders',
    description: 'List all folders in the workspace.',
    inputSchema: { type: 'object', properties: { ...WS_PROP }, required: [] },
  },
  {
    name: 'list_lists',
    description: 'List all lists in the workspace, optionally filtered by folder.',
    inputSchema: {
      type: 'object',
      properties: {
        ...WS_PROP,
        folder_id: { type: 'string', description: 'Filter lists by folder ID' },
      },
      required: [],
    },
  },
  {
    name: 'list_items',
    description: 'List items/tasks in the workspace with optional filters.',
    inputSchema: {
      type: 'object',
      properties: {
        ...WS_PROP,
        list_id: { type: 'string', description: 'Filter by list ID' },
        status: { type: 'string', description: 'Filter by status (comma-separated for multiple)' },
        assignee_id: { type: 'string', description: 'Filter by assignee user ID' },
        limit: { type: 'number', description: 'Max results (default 50, max 200)' },
      },
      required: [],
    },
    input_examples: [
      {status: 'open'},
      {status: 'open,in_progress', limit: 10},
      {assignee_id: 'user-uuid-here', status: 'in_progress'},
    ],
  },
  {
    name: 'search_items',
    description: 'Search items by text (title/description) across the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        ...WS_PROP,
        q: { type: 'string', description: 'Search query text' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: ['q'],
    },
    input_examples: [
      {q: 'login bug'},
      {q: 'dark mode', limit: 5},
    ],
  },
  {
    name: 'get_item',
    description: 'Get full details for a specific item including assignments, tags, and comments.',
    inputSchema: {
      type: 'object',
      properties: {
        ...WS_PROP,
        item_id: { type: 'string', description: 'The item UUID' },
      },
      required: ['item_id'],
    },
  },
  {
    name: 'create_item',
    description: 'Create a new task/item in the workspace. Can auto-assign to a user.',
    inputSchema: {
      type: 'object',
      properties: {
        ...WS_PROP,
        title: { type: 'string', description: 'Item title' },
        type: { type: 'string', description: 'Item type: task, note, idea, bug', default: 'task' },
        description: { type: 'string', description: 'Item description (markdown supported)' },
        priority: { type: 'string', description: 'Priority: critical, high, medium, low', default: 'medium' },
        status: { type: 'string', description: 'Status (e.g. open, in_progress, done)', default: 'open' },
        due_date: { type: 'string', description: 'Due date in YYYY-MM-DD format' },
        list_id: { type: 'string', description: 'List ID to place the item in' },
        list_name: { type: 'string', description: 'List name (fuzzy-matched) — alternative to list_id' },
        assignee_id: { type: 'string', description: 'User ID to assign item to (use list_members to find IDs)' },
      },
      required: ['title'],
    },
    input_examples: [
      {title: 'Fix login page 500 error', type: 'bug', priority: 'critical', status: 'open', list_name: 'Development'},
      {title: 'Add dark mode toggle to settings', type: 'task', priority: 'medium', description: 'User-facing preference in Settings > Appearance. Follow existing theme system.'},
      {title: 'Evaluate Stripe Connect for marketplace', type: 'idea', priority: 'low'},
    ],
  },
  {
    name: 'update_item',
    description: 'Update an existing item (status, priority, title, description, due_date, list_id).',
    inputSchema: {
      type: 'object',
      properties: {
        ...WS_PROP,
        item_id: { type: 'string', description: 'The item UUID to update' },
        title: { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'New description' },
        status: { type: 'string', description: 'New status' },
        priority: { type: 'string', description: 'New priority' },
        due_date: { type: 'string', description: 'New due date (YYYY-MM-DD) or "none" to clear' },
        list_id: { type: 'string', description: 'Move to list ID, or "none" to unset' },
      },
      required: ['item_id'],
    },
    input_examples: [
      {item_id: 'abc-123', status: 'done'},
      {item_id: 'abc-123', priority: 'critical', due_date: '2026-03-01'},
      {item_id: 'abc-123', title: 'Updated title', description: 'More details added'},
    ],
  },
  {
    name: 'create_folder',
    description: 'Create a new folder in the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        ...WS_PROP,
        name: { type: 'string', description: 'Folder name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'create_list',
    description: 'Create a new list in the workspace (optionally inside a folder).',
    inputSchema: {
      type: 'object',
      properties: {
        ...WS_PROP,
        name: { type: 'string', description: 'List name' },
        folder_id: { type: 'string', description: 'Parent folder ID (optional)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'add_comment',
    description: 'Add a comment to an item.',
    inputSchema: {
      type: 'object',
      properties: {
        ...WS_PROP,
        item_id: { type: 'string', description: 'The item UUID' },
        content: { type: 'string', description: 'Comment text (markdown supported)' },
      },
      required: ['item_id', 'content'],
    },
    input_examples: [
      {item_id: 'abc-123', content: 'Investigated — root cause is a missing null check in `auth.py:42`. Fix incoming.'},
      {item_id: 'abc-123', content: 'Moved to Done. Tested on staging, confirmed fix.'},
    ],
  },
  {
    name: 'create_space',
    description: 'Create a new space (top-level folder) in the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        ...WS_PROP,
        name: { type: 'string', description: 'Space name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'assign_item',
    description: 'Assign a user to an item/task. Use list_members to find user IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        ...WS_PROP,
        item_id: { type: 'string', description: 'The item UUID to assign' },
        assignee_id: { type: 'string', description: 'User ID to assign (use list_members to discover)' },
      },
      required: ['item_id', 'assignee_id'],
    },
    input_examples: [
      {item_id: 'abc-123', assignee_id: 'user-uuid-from-list-members'},
    ],
  },
  {
    name: 'list_members',
    description: 'List all members of the workspace with user IDs, names, and Discord IDs.',
    inputSchema: {
      type: 'object',
      properties: { ...WS_PROP },
      required: [],
    },
  },
];

// ── Tool execution ──────────────────────────────────────────

// Helper to validate workspace_id when in multi-workspace mode
function resolveWsId(args) {
  if (!MULTI_WORKSPACE) return DEFAULT_WORKSPACE_ID;
  const wsId = args.workspace_id;
  if (wsId && WORKSPACE_IDS.includes(wsId)) return wsId;
  if (wsId && !WORKSPACE_IDS.includes(wsId)) {
    throw new Error('Invalid workspace_id. Use list_workspaces to see available IDs.');
  }
  // Default to first if not specified
  return DEFAULT_WORKSPACE_ID;
}

async function executeTool(name, args) {
  const wsId = name === 'list_workspaces' ? null : resolveWsId(args);

  switch (name) {
    case 'list_workspaces': {
      // Fetch summary for each workspace
      const results = [];
      for (const id of WORKSPACE_IDS) {
        try {
          const summary = await hubRequest('GET', '/workspace-summary', {}, id);
          results.push({ workspace_id: id, ...summary });
        } catch {
          results.push({ workspace_id: id, error: 'Failed to fetch' });
        }
      }
      return { workspaces: results };
    }

    case 'workspace_summary':
      return hubRequest('GET', '/workspace-summary', {}, wsId);

    case 'list_spaces':
      return hubRequest('GET', '/list-spaces', {}, wsId);

    case 'list_folders':
      return hubRequest('GET', '/list-folders', {}, wsId);

    case 'list_lists':
      return hubRequest('GET', '/list-lists', { folder_id: args.folder_id }, wsId);

    case 'list_items':
      return hubRequest('GET', '/list-items', {
        list_id: args.list_id,
        status: args.status,
        assignee_id: args.assignee_id,
        limit: args.limit,
      }, wsId);

    case 'search_items':
      return hubRequest('GET', '/search-items', { q: args.q, limit: args.limit }, wsId);

    case 'get_item':
      return hubRequest('GET', '/get-item', { item_id: args.item_id }, wsId);

    case 'create_item':
      return hubRequest('POST', '/create-item', {
        title: args.title,
        type: args.type || 'task',
        description: args.description || '',
        priority: args.priority || 'medium',
        status: args.status || 'open',
        due_date: args.due_date,
        list_id: args.list_id,
        list_name: args.list_name,
        assignee_id: args.assignee_id,
        source: 'discord-ai',
        user_id: 'ai-assistant',
      }, wsId);

    case 'update_item':
      return hubRequest('PATCH', '/update-item', {
        item_id: args.item_id,
        title: args.title,
        description: args.description,
        status: args.status,
        priority: args.priority,
        due_date: args.due_date,
        list_id: args.list_id,
      }, wsId);

    case 'create_folder':
      return hubRequest('POST', '/create-folder', { name: args.name }, wsId);

    case 'create_list':
      return hubRequest('POST', '/create-list', { name: args.name, folder_id: args.folder_id }, wsId);

    case 'create_space':
      return hubRequest('POST', '/create-space', { name: args.name }, wsId);

    case 'add_comment':
      return hubRequest('POST', '/add-comment', { item_id: args.item_id, content: args.content }, wsId);

    case 'assign_item':
      return hubRequest('POST', '/assign-item', {
        item_id: args.item_id,
        assignee_id: args.assignee_id,
        assigned_by: 'discord-ai',
      }, wsId);

    case 'list_members':
      return hubRequest('GET', '/list-members', {}, wsId);

    default:
      throw new Error('Unknown tool: ' + name);
  }
}

// ── JSON-RPC handler ────────────────────────────────────────
async function handleMessage(msg) {
  const { jsonrpc, id, method, params } = msg;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'teamhub-mcp', version: '1.0.0' },
      },
    };
  }

  if (method === 'notifications/initialized') {
    // Client acknowledgment — no response needed
    return null;
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS },
    };
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};

    try {
      const result = await executeTool(toolName, toolArgs);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        },
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: 'Error: ' + err.message }],
          isError: true,
        },
      };
    }
  }

  // Unknown method
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: 'Method not found: ' + method },
  };
}

// ── Stdio transport ─────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, terminal: false });
let buffer = '';

rl.on('line', async (line) => {
  buffer += line;
  // Try to parse complete JSON messages
  try {
    const msg = JSON.parse(buffer);
    buffer = '';
    const response = await handleMessage(msg);
    if (response) {
      process.stdout.write(JSON.stringify(response) + '\n');
    }
  } catch (e) {
    // Not valid JSON yet — might be multi-line, keep buffering
    if (e instanceof SyntaxError) {
      // Check if it's truly incomplete or just bad JSON
      // Reset buffer on obviously bad input
      if (buffer.length > 100000) buffer = '';
    } else {
      process.stderr.write('Handler error: ' + e.message + '\n');
      buffer = '';
    }
  }
});

process.stderr.write(`[teamhub-mcp] Started for ${WORKSPACE_IDS.length} workspace(s): ${WORKSPACE_IDS.join(', ')}\n`);
