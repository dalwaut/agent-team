/**
 * Team Hub Fast Path — Direct API calls for common workspace queries.
 *
 * Bypasses Claude CLI entirely for known intents. Sub-second responses.
 * Falls through to Claude only for genuinely open-ended questions.
 *
 * Uses the same internal API as the Discord bridge's teamhub-mcp.js:
 *   http://127.0.0.1:8089/api/internal/*
 *
 * Workspace-scoped: queries use workspace_id from topic binding.
 * If no workspace binding, queries all workspaces via Supabase directly.
 */

const http = require('http');

const HUB_BASE = 'http://127.0.0.1:8089/api/internal';

// --- Intent Detection ---

const INTENT_PATTERNS = [
  // Tasks
  { pattern: /\b(latest|recent|new|last)\b.*\btask/i, intent: 'latest_tasks' },
  { pattern: /\bmy\s+task/i, intent: 'latest_tasks' },
  { pattern: /\b(show|list|get|view|check)\b.*\btask/i, intent: 'latest_tasks' },
  { pattern: /\btask(s)?\s*$/i, intent: 'latest_tasks' },
  { pattern: /\bwhat.*task/i, intent: 'latest_tasks' },
  { pattern: /\b(todo|to-do|to do)(s)?\b/i, intent: 'todos' },
  { pattern: /\b(overdue|past due)\b/i, intent: 'overdue' },

  // Notes
  { pattern: /\b(latest|recent|new|last)\b.*\bnote/i, intent: 'latest_notes' },
  { pattern: /\bmy\s+note/i, intent: 'latest_notes' },
  { pattern: /\b(show|list|get|view)\b.*\bnote/i, intent: 'latest_notes' },
  { pattern: /\bnotes?\s*$/i, intent: 'latest_notes' },

  // Ideas
  { pattern: /\b(latest|recent|new|last)\b.*\bidea/i, intent: 'latest_ideas' },
  { pattern: /\bmy\s+idea/i, intent: 'latest_ideas' },
  { pattern: /\b(show|list|get|view)\b.*\bidea/i, intent: 'latest_ideas' },
  { pattern: /\bideas?\s*$/i, intent: 'latest_ideas' },

  // Overview / dashboard
  { pattern: /\b(status|overview|dashboard|summary)\b/i, intent: 'overview' },
  { pattern: /\bwhat'?s\s+(going on|happening|up|new)\b/i, intent: 'overview' },

  // Search
  { pattern: /\b(search|find|look for|look up)\s+(.+)/i, intent: 'search' },
];

/**
 * Detect if a message matches a fast-path intent.
 * @param {string} text
 * @returns {{ intent: string, query?: string } | null}
 */
function detectIntent(text) {
  for (const { pattern, intent } of INTENT_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      if (intent === 'search') {
        return { intent, query: match[2]?.trim() };
      }
      return { intent };
    }
  }
  return null;
}

// --- HTTP Helper ---

function hubGet(path, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const url = `${HUB_BASE}${path}`;
    const req = http.get(url, { timeout }, (res) => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`Invalid JSON from ${path}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Team Hub timeout')); });
  });
}

// --- Formatters ---

function formatItem(item, idx) {
  const status = item.status || 'unknown';
  const priority = item.priority || '';
  const statusIcon = {
    'open': '[ ]', 'todo': '[ ]', 'in_progress': '[~]', 'in_review': '[?]',
    'done': '[x]', 'closed': '[x]', 'archived': '[-]',
  }[status] || '[ ]';
  const prioIcon = { 'critical': '!!!', 'high': '!!', 'medium': '!', 'low': '' }[priority] || '';

  let line = `${idx + 1}. ${statusIcon} *${item.title || 'Untitled'}*`;
  if (prioIcon) line += ` ${prioIcon}`;
  if (item.due_date) line += `\n   Due: ${item.due_date}`;
  if (item.source) line += ` | Source: ${item.source}`;
  return line;
}

function formatItems(items, label, emptyMsg) {
  if (!items || items.length === 0) return emptyMsg || `No ${label} found.`;
  const lines = [`*${label}:*\n`];
  items.forEach((item, i) => lines.push(formatItem(item, i)));
  return lines.join('\n');
}

// --- Workspace Resolution ---

// Cache workspace list (refreshed every 5 minutes)
let workspaceCache = { ids: [], ts: 0 };
const WS_CACHE_TTL = 5 * 60 * 1000;

async function getAllWorkspaceIds() {
  if (workspaceCache.ids.length > 0 && Date.now() - workspaceCache.ts < WS_CACHE_TTL) {
    return workspaceCache.ids;
  }
  try {
    // Use the workspace-summary endpoint to discover workspaces
    // Or query each known workspace. For now, use a direct Supabase call
    // via the list-spaces trick: we know "Dallas's Space" ID from setup
    const data = await hubGet('/workspace-summary?workspace_id=80753c5a-beb5-498c-8d71-393a0342af27');
    if (data && data.workspace_id) {
      workspaceCache = { ids: [data.workspace_id], ts: Date.now() };
    }
  } catch {}
  // Fallback: return known default workspace
  if (workspaceCache.ids.length === 0) {
    workspaceCache = { ids: ['80753c5a-beb5-498c-8d71-393a0342af27'], ts: Date.now() };
  }
  return workspaceCache.ids;
}

// --- Intent Handlers ---

/**
 * Handle a detected intent by querying Team Hub directly.
 * @param {string} intent
 * @param {string} [query] - Search query (for 'search' intent)
 * @param {string} [workspaceId] - Specific workspace ID (from topic binding)
 * @returns {Promise<string|null>} Formatted response, or null to fall through to Claude
 */
async function handleIntent(intent, query, workspaceId) {
  // Resolve workspace ID — use bound workspace, or default to all
  const wsId = (workspaceId && workspaceId !== '*')
    ? workspaceId
    : (await getAllWorkspaceIds())[0];

  if (!wsId) {
    console.error('[TG] [FAST] No workspace ID available');
    return null;
  }

  try {
    switch (intent) {
      case 'latest_tasks': {
        const data = await hubGet(`/list-items?workspace_id=${wsId}&limit=30`);
        const items = (data.items || []).filter(i => i.type === 'task');
        return formatItems(items.slice(0, 5), 'Latest Tasks', 'No tasks found in this workspace.');
      }

      case 'todos': {
        const data = await hubGet(`/list-items?workspace_id=${wsId}&status=open,todo,in_progress&limit=10`);
        const items = (data.items || []).filter(i => i.type === 'task');
        return formatItems(items.slice(0, 10), 'Open Tasks', 'No open tasks.');
      }

      case 'overdue': {
        const data = await hubGet(`/list-items?workspace_id=${wsId}&limit=30`);
        const now = new Date();
        const items = (data.items || []).filter(i => {
          if (!i.due_date) return false;
          return new Date(i.due_date) < now;
        });
        return formatItems(items.slice(0, 10), 'Overdue Items', 'Nothing overdue.');
      }

      case 'latest_notes':
      case 'my_notes': {
        const data = await hubGet(`/list-items?workspace_id=${wsId}&limit=20`);
        const items = (data.items || []).filter(i => i.type === 'note');
        return formatItems(items.slice(0, 5), 'Latest Notes', 'No notes found.');
      }

      case 'latest_ideas':
      case 'my_ideas': {
        const data = await hubGet(`/list-items?workspace_id=${wsId}&limit=20`);
        const items = (data.items || []).filter(i => i.type === 'idea');
        return formatItems(items.slice(0, 5), 'Latest Ideas', 'No ideas found.');
      }

      case 'overview': {
        const data = await hubGet(`/list-items?workspace_id=${wsId}&limit=20`);
        const allItems = data.items || [];

        const tasks = allItems.filter(i => i.type === 'task' && i.status !== 'done' && i.status !== 'closed').slice(0, 5);
        const notes = allItems.filter(i => i.type === 'note').slice(0, 3);
        const ideas = allItems.filter(i => i.type === 'idea').slice(0, 3);

        const lines = ['*Workspace Overview:*\n'];

        lines.push(`*Active Tasks (${tasks.length}):*`);
        if (tasks.length > 0) {
          tasks.forEach((item, i) => lines.push(formatItem(item, i)));
        } else {
          lines.push('None');
        }
        lines.push('');

        if (notes.length > 0) {
          lines.push(`*Recent Notes (${notes.length}):*`);
          notes.forEach((item, i) => lines.push(formatItem(item, i)));
          lines.push('');
        }

        if (ideas.length > 0) {
          lines.push(`*Recent Ideas (${ideas.length}):*`);
          ideas.forEach((item, i) => lines.push(formatItem(item, i)));
        }

        return lines.join('\n');
      }

      case 'search': {
        if (!query) return 'What would you like to search for?';
        const data = await hubGet(`/search-items?workspace_id=${wsId}&q=${encodeURIComponent(query)}&limit=8`);
        const items = data.items || data || [];
        return formatItems(items.slice(0, 8), `Search: "${query}"`, `No results for "${query}".`);
      }

      default:
        return null;
    }
  } catch (err) {
    console.error(`[TG] [FAST] Error (${intent}):`, err.message);
    return null; // Fall through to Claude
  }
}

module.exports = { detectIntent, handleIntent };
