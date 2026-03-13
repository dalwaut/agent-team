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
 *
 * IMPORTANT: Mutation verbs are detected FIRST to prevent misclassification
 * as read intents. Simple mutations (mark done, change status/priority) are
 * handled directly. Complex mutations fall through to Claude with a locked
 * TeamHub-only prompt.
 */

const http = require('http');

const HUB_BASE = 'http://127.0.0.1:8089/api/internal';

// --- Mutation Guard ---
// These verbs indicate the user wants to MODIFY something, not read.
// Must be checked BEFORE read intent patterns.

const MUTATION_VERBS = /\b(postpone|reschedule|delay|defer|push\s+back|assign|reassign|mark\s+(?:as\s+)?(?:done|complete|finished|closed|open|in.progress|blocked)|finish|close|complete|reopen|archive|delete|remove|create\s+(?:a\s+)?(?:task|note|idea|item)|add\s+(?:a\s+)?(?:task|note|idea|item)|new\s+(?:task|note|idea|item)|edit\s+(?:the\s+)?(?:desc|description)|modify|rename|prioritize|deprioritize|escalate|bump|block|unblock|move\s+(?:the\s+)?(?:due|deadline)|change\s+(?:the\s+)?(?:status|priority|assignee|due|deadline)|set\s+(?:the\s+)?(?:status|priority)|update\s+(?:the\s+)?(?:status|priority|due|deadline|description))\b/i;

// --- Read Intent Patterns ---

const INTENT_PATTERNS = [
  // Tasks
  { pattern: /\b(latest|recent|new|last)\b.*\btask/i, intent: 'latest_tasks' },
  { pattern: /\bmy\s+task/i, intent: 'latest_tasks' },
  { pattern: /\b(show|list|get|view|check)\b.*\btask/i, intent: 'latest_tasks' },
  { pattern: /\bwhat.*\btask/i, intent: 'latest_tasks' },
  { pattern: /\b(todo|to-do|to do)(s)?\b/i, intent: 'todos' },
  { pattern: /\b(overdue|past due)\b/i, intent: 'overdue' },

  // Notes
  { pattern: /\b(latest|recent|new|last)\b.*\bnote/i, intent: 'latest_notes' },
  { pattern: /\bmy\s+note/i, intent: 'latest_notes' },
  { pattern: /\b(show|list|get|view)\b.*\bnote/i, intent: 'latest_notes' },

  // Ideas
  { pattern: /\b(latest|recent|new|last)\b.*\bidea/i, intent: 'latest_ideas' },
  { pattern: /\bmy\s+idea/i, intent: 'latest_ideas' },
  { pattern: /\b(show|list|get|view)\b.*\bidea/i, intent: 'latest_ideas' },

  // Overview / dashboard
  { pattern: /\b(overview|dashboard|summary)\b/i, intent: 'overview' },
  { pattern: /\bwhat'?s\s+(going on|happening|up|new)\b/i, intent: 'overview' },

  // Search
  { pattern: /\b(search|find|look for|look up)\s+(.+)/i, intent: 'search' },
];

/**
 * Detect if a message matches a fast-path intent.
 * @param {string} text
 * @returns {{ intent: string, query?: string, action?: string } | null}
 */
function detectIntent(text) {
  // GUARD: Mutation verbs take priority — never let these match as read
  if (MUTATION_VERBS.test(text)) {
    return classifyMutation(text);
  }

  // Read intents
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

/**
 * Classify a mutation into a specific action.
 * Returns intent + action + extracted item title.
 */
function classifyMutation(text) {
  const t = text.trim();

  // Mark done / complete / close / finish
  if (/\b(mark\b.*\b(?:done|complete|completed|finished|closed)|close\s+(?:the\s+)?|finish\s+(?:the\s+)?|complete\s+(?:the\s+)?)\b/i.test(t)) {
    return { intent: 'update_status', action: 'done', query: extractItemTitle(t, 'done') };
  }

  // Reopen
  if (/\breopen\b/i.test(t)) {
    return { intent: 'update_status', action: 'open', query: extractItemTitle(t, 'reopen') };
  }

  // Block / unblock
  if (/\bunblock\b/i.test(t)) {
    return { intent: 'update_status', action: 'in-progress', query: extractItemTitle(t, 'unblock') };
  }
  if (/\bblock\b/i.test(t)) {
    return { intent: 'update_status', action: 'blocked', query: extractItemTitle(t, 'block') };
  }

  // Explicit status change: "set status to X" / "change status to X"
  const statusMatch = t.match(/\b(?:set|change|move|update)\s+(?:the\s+)?status\s+(?:of\s+)?(?:["']?(.+?)["']?\s+)?to\s+(\w[\w-]*)/i)
    || t.match(/\b(?:set|change|move|update)\s+(?:["']?(.+?)["']?\s+)?(?:to\s+)?(?:status\s+)?(\w[\w-]*)\s*$/i);
  if (statusMatch) {
    const title = statusMatch[1]?.trim();
    const status = normalizeStatus(statusMatch[2]);
    if (status) return { intent: 'update_status', action: status, query: title || t };
  }

  // Priority change
  const prioMatch = t.match(/\b(?:set|change)\s+(?:the\s+)?priority\s+(?:of\s+)?(?:["']?(.+?)["']?\s+)?to\s+(\w+)/i)
    || t.match(/\b(?:prioritize|bump|escalate)\s+(?:the\s+)?["']?(.+?)["']?\s*$/i);
  if (prioMatch) {
    const title = prioMatch[1]?.trim();
    const prio = normalizePriority(prioMatch[2] || 'high');
    return { intent: 'update_priority', action: prio, query: title || extractItemTitle(t, 'priority') };
  }
  if (/\bdeprioritize\b/i.test(t)) {
    return { intent: 'update_priority', action: 'low', query: extractItemTitle(t, 'deprioritize') };
  }

  // Postpone / reschedule / delay / defer
  if (/\b(postpone|reschedule|delay|defer|push\s+back)\b/i.test(t)) {
    // Try to extract a date hint: "postpone X to March 15"
    const dateMatch = t.match(/\b(?:postpone|reschedule|delay|defer|push\s+back)\s+(?:the\s+)?["']?(.+?)["']?\s+(?:to|until|by|for)\s+(.+)$/i);
    if (dateMatch) {
      return { intent: 'update_date', query: dateMatch[1].replace(/\s+task\s*$/i, '').trim(), dateHint: dateMatch[2].trim() };
    }
    return { intent: 'update_date', query: extractItemTitle(t, 'postpone') };
  }

  // Due date change: "move due date of X to Y"
  const dueMatch = t.match(/\b(?:move|change|set|update)\s+(?:the\s+)?(?:due\s+date|deadline)\s+(?:of\s+)?(?:["']?(.+?)["']?\s+)?(?:to|for)\s+(.+)$/i);
  if (dueMatch) {
    return { intent: 'update_date', query: (dueMatch[1] || t).trim(), dateHint: dueMatch[2].trim() };
  }

  // Assign / reassign
  const assignMatch = t.match(/\b(?:assign|reassign)\s+(?:the\s+)?["']?(.+?)["']?\s+to\s+(\w+)/i);
  if (assignMatch) {
    return { intent: 'update_assignee', query: assignMatch[1].replace(/\s+task\s*$/i, '').trim(), assignee: assignMatch[2].trim() };
  }

  // Create item
  if (/\b(create|add|new)\s+(?:a\s+)?(?:task|note|idea|item)\b/i.test(t)) {
    return { intent: 'create_item', query: t };
  }

  // Generic mutation — fall through to Claude with locked prompt
  return { intent: 'teamhub_mutation', query: t };
}

/**
 * Extract item title from a mutation message.
 * Tries quoted strings first, then strips verb prefixes and suffixes.
 */
function extractItemTitle(text, verb) {
  // Quoted title: "the 'RKJ quote' task"
  const quoted = text.match(/["'\u201C\u201D](.+?)["'\u201C\u201D]/);
  if (quoted) return quoted[1].trim();

  // Strip known verb patterns and modifiers
  let t = text.trim();
  // Remove verb prefix
  t = t.replace(/^(?:lets?\s+|please\s+|can\s+you\s+|could\s+you\s+|go\s+ahead\s+and\s+)?/i, '');
  t = t.replace(/^(?:postpone|reschedule|delay|defer|push\s+back|mark|close|finish|complete|reopen|block|unblock|assign|reassign|set|change|edit|update|move|bump|escalate|deprioritize|prioritize|create|add|new|archive|delete|remove)\s+/i, '');
  // Remove "the"
  t = t.replace(/^the\s+/i, '');
  // Remove trailing modifiers
  t = t.replace(/\s+(?:as\s+)?(?:done|complete|completed|finished|closed|open|in.progress|blocked|to\s+.+)\s*$/i, '');
  // Remove trailing "task" / "item" / "note" / "idea"
  t = t.replace(/\s+(?:task|item|note|idea)\s*$/i, '');
  return t.trim() || text;
}

function normalizeStatus(raw) {
  const s = (raw || '').toLowerCase().replace(/[\s_]+/g, '-');
  const map = {
    'open': 'open', 'todo': 'open', 'new': 'open',
    'in-progress': 'in-progress', 'inprogress': 'in-progress', 'wip': 'in-progress', 'working': 'in-progress',
    'in-review': 'in-review', 'review': 'in-review',
    'blocked': 'blocked', 'stuck': 'blocked',
    'done': 'done', 'complete': 'done', 'completed': 'done', 'finished': 'done',
    'closed': 'closed',
  };
  return map[s] || null;
}

function normalizePriority(raw) {
  const p = (raw || '').toLowerCase();
  const map = {
    'low': 'low', 'medium': 'medium', 'med': 'medium', 'normal': 'medium',
    'high': 'high', 'critical': 'critical', 'urgent': 'urgent',
  };
  return map[p] || 'high';
}

// --- HTTP Helpers ---

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

function hubPatch(path, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const fullUrl = `${HUB_BASE}${path}`;
    const parsed = new URL(fullUrl);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'PATCH',
      timeout,
    }, (res) => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Team Hub PATCH timeout')); });
    req.end();
  });
}

// --- Formatters ---

const STATUS_ICONS = {
  'open': '\u26AA', 'todo': '\u26AA', 'in-progress': '\uD83D\uDD35',
  'in_progress': '\uD83D\uDD35', 'in-review': '\uD83D\uDFE3',
  'in_review': '\uD83D\uDFE3', 'blocked': '\uD83D\uDD34',
  'done': '\u2705', 'closed': '\u2705', 'archived': '\u26AB',
};
const PRIO_ICONS = {
  'critical': '\uD83D\uDD25', 'urgent': '\uD83D\uDD25', 'high': '\u26A1',
  'medium': '\uD83D\uDFE1', 'low': '\u2B55',
};

/**
 * Compact list format — for showing multiple items.
 */
function formatItemCompact(item, idx) {
  const status = item.status || 'unknown';
  const priority = item.priority || '';
  const sIcon = STATUS_ICONS[status] || '\u26AA';
  const pIcon = PRIO_ICONS[priority] || '';

  let line = `${idx + 1}. ${sIcon} *${item.title || 'Untitled'}*`;
  if (pIcon) line += ` ${pIcon}`;
  if (item.due_date) {
    const due = formatDueDate(item.due_date);
    line += `\n   \uD83D\uDCC5 ${due}`;
  }
  if (item.status) {
    line += item.due_date ? ` | ${capitalize(item.status)}` : `\n   ${capitalize(item.status)}`;
  }
  return line;
}

/**
 * Rich detail format — for showing a single item.
 * Includes title, status, priority, due date, assignees, description excerpt,
 * latest comment, and progress info.
 */
function formatItemDetail(item) {
  const status = item.status || 'unknown';
  const priority = item.priority || '';
  const sIcon = STATUS_ICONS[status] || '\u26AA';
  const pIcon = PRIO_ICONS[priority] || '';

  const lines = [];
  lines.push(`\uD83D\uDCCB *${item.title || 'Untitled'}*`);
  lines.push('');

  // Status + Priority row
  let statusLine = `${sIcon} ${capitalize(status)}`;
  if (pIcon) statusLine += `  |  ${pIcon} ${capitalize(priority)}`;
  lines.push(statusLine);

  // Due date
  if (item.due_date) {
    const due = formatDueDate(item.due_date);
    const overdue = new Date(item.due_date) < new Date() && status !== 'done' && status !== 'closed';
    lines.push(`\uD83D\uDCC5 Due: ${due}${overdue ? ' \u26A0\uFE0F OVERDUE' : ''}`);
  }

  // Assignees
  if (item.assignments && item.assignments.length > 0) {
    const names = item.assignments.map(a => a.assignee_name || a.assignee_id || '?');
    lines.push(`\uD83D\uDC64 ${names.join(', ')}`);
  }

  // Description excerpt
  if (item.description) {
    const excerpt = item.description.substring(0, 200).replace(/\n/g, ' ').trim();
    const truncated = item.description.length > 200 ? excerpt + '\u2026' : excerpt;
    lines.push('');
    lines.push(`> ${truncated}`);
  }

  // Latest comment (skip if it's an agent report and there's also a description)
  if (item.comments && item.comments.length > 0) {
    const latest = item.comments[0]; // Ordered by created_at desc
    if (latest.content) {
      const isAgentReport = latest.is_agent_report;
      const commentExcerpt = latest.content.substring(0, 150).replace(/\n/g, ' ').trim();
      const truncated = latest.content.length > 150 ? commentExcerpt + '\u2026' : commentExcerpt;
      const timeAgo = formatTimeAgo(latest.created_at);
      const author = latest.author_name || 'System';
      lines.push('');
      lines.push(`\uD83D\uDCAC ${isAgentReport ? 'Progress' : author}: "${truncated}" (${timeAgo})`);
    }
  }

  // Updated timestamp
  if (item.updated_at) {
    const ago = formatTimeAgo(item.updated_at);
    lines.push(`\n\u23F1 Updated ${ago}`);
  }

  return lines.join('\n');
}

function formatItemsList(items, label, emptyMsg) {
  if (!items || items.length === 0) return emptyMsg || `No ${label} found.`;
  const lines = [`*${label}:*\n`];
  items.forEach((item, i) => lines.push(formatItemCompact(item, i)));
  return lines.join('\n');
}

function formatDueDate(dateStr) {
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diff = Math.round((d - now) / (1000 * 60 * 60 * 24));
    const formatted = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    if (diff === 0) return `${formatted} (today)`;
    if (diff === 1) return `${formatted} (tomorrow)`;
    if (diff === -1) return `${formatted} (yesterday)`;
    if (diff > 0 && diff <= 7) return `${formatted} (${diff}d)`;
    if (diff < 0) return `${formatted} (${Math.abs(diff)}d ago)`;
    return formatted;
  } catch { return dateStr; }
}

function formatTimeAgo(dateStr) {
  try {
    const d = new Date(dateStr);
    const diff = Math.round((Date.now() - d.getTime()) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  } catch { return ''; }
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/[-_]/g, ' ') : '';
}

// --- Workspace Resolution ---

let workspaceCache = { ids: [], ts: 0 };
const WS_CACHE_TTL = 5 * 60 * 1000;

async function getAllWorkspaceIds() {
  if (workspaceCache.ids.length > 0 && Date.now() - workspaceCache.ts < WS_CACHE_TTL) {
    return workspaceCache.ids;
  }
  try {
    const data = await hubGet('/workspace-summary?workspace_id=80753c5a-beb5-498c-8d71-393a0342af27');
    if (data && data.workspace_id) {
      workspaceCache = { ids: [data.workspace_id], ts: Date.now() };
    }
  } catch {}
  if (workspaceCache.ids.length === 0) {
    workspaceCache = { ids: ['80753c5a-beb5-498c-8d71-393a0342af27'], ts: Date.now() };
  }
  return workspaceCache.ids;
}

// --- Update Handlers ---

/**
 * Search for an item by title fragment and update it.
 * Returns formatted confirmation or null to fall through.
 */
async function searchAndUpdate(titleFragment, updates, wsId, actionLabel) {
  // Search for the item
  const cleanTitle = titleFragment.replace(/\s+task\s*$/i, '').replace(/\s+item\s*$/i, '').trim();
  if (!cleanTitle || cleanTitle.length < 2) return null;

  const data = await hubGet(`/search-items?workspace_id=${wsId}&q=${encodeURIComponent(cleanTitle)}&limit=5`);
  const items = data.items || data || [];

  if (items.length === 0) {
    return `No item found matching "${cleanTitle}".`;
  }

  // Best match: prefer exact title contains, then first result
  let target = items.find(i => i.title && i.title.toLowerCase().includes(cleanTitle.toLowerCase()));
  if (!target) target = items[0];

  // Build update query string
  const params = new URLSearchParams({ item_id: target.id });
  for (const [key, val] of Object.entries(updates)) {
    if (val !== undefined && val !== null) params.set(key, val);
  }

  const result = await hubPatch(`/update-item?${params.toString()}`);
  if (result.status >= 200 && result.status < 300) {
    // Fetch updated item for detail display
    try {
      const detail = await hubGet(`/get-item?item_id=${target.id}`);
      return `\u2705 *${actionLabel}*\n\n${formatItemDetail(detail)}`;
    } catch {
      return `\u2705 *${actionLabel}:* ${target.title}`;
    }
  }
  return `\u274C Failed to update "${target.title}": ${JSON.stringify(result.data).substring(0, 200)}`;
}

// --- Intent Handlers ---

/**
 * Handle a detected intent by querying Team Hub directly.
 * @param {string} intent
 * @param {string} [query] - Search query or raw text
 * @param {string} [workspaceId] - Specific workspace ID (from topic binding)
 * @param {object} [extra] - Extra parsed data (action, dateHint, assignee)
 * @returns {Promise<string|null>} Formatted response, or null to fall through to Claude
 */
async function handleIntent(intent, query, workspaceId, extra = {}) {
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
        return formatItemsList(items.slice(0, 5), 'Latest Tasks', 'No tasks found in this workspace.');
      }

      case 'todos': {
        const data = await hubGet(`/list-items?workspace_id=${wsId}&status=open,todo,in_progress&limit=10`);
        const items = (data.items || []).filter(i => i.type === 'task');
        return formatItemsList(items.slice(0, 10), 'Open Tasks', 'No open tasks.');
      }

      case 'overdue': {
        const data = await hubGet(`/list-items?workspace_id=${wsId}&limit=30`);
        const now = new Date();
        const items = (data.items || []).filter(i => {
          if (!i.due_date) return false;
          return new Date(i.due_date) < now;
        });
        return formatItemsList(items.slice(0, 10), 'Overdue Items', 'Nothing overdue.');
      }

      case 'latest_notes':
      case 'my_notes': {
        const data = await hubGet(`/list-items?workspace_id=${wsId}&limit=20`);
        const items = (data.items || []).filter(i => i.type === 'note');
        return formatItemsList(items.slice(0, 5), 'Latest Notes', 'No notes found.');
      }

      case 'latest_ideas':
      case 'my_ideas': {
        const data = await hubGet(`/list-items?workspace_id=${wsId}&limit=20`);
        const items = (data.items || []).filter(i => i.type === 'idea');
        return formatItemsList(items.slice(0, 5), 'Latest Ideas', 'No ideas found.');
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
          tasks.forEach((item, i) => lines.push(formatItemCompact(item, i)));
        } else {
          lines.push('None');
        }
        lines.push('');

        if (notes.length > 0) {
          lines.push(`*Recent Notes (${notes.length}):*`);
          notes.forEach((item, i) => lines.push(formatItemCompact(item, i)));
          lines.push('');
        }

        if (ideas.length > 0) {
          lines.push(`*Recent Ideas (${ideas.length}):*`);
          ideas.forEach((item, i) => lines.push(formatItemCompact(item, i)));
        }

        return lines.join('\n');
      }

      case 'search': {
        if (!query) return 'What would you like to search for?';
        const data = await hubGet(`/search-items?workspace_id=${wsId}&q=${encodeURIComponent(query)}&limit=8`);
        const items = data.items || data || [];
        if (items.length === 1) {
          // Single result — show rich detail
          try {
            const detail = await hubGet(`/get-item?item_id=${items[0].id}`);
            return formatItemDetail(detail);
          } catch {
            return formatItemDetail(items[0]);
          }
        }
        return formatItemsList(items.slice(0, 8), `Search: "${query}"`, `No results for "${query}".`);
      }

      // --- Mutation handlers ---

      case 'update_status': {
        const action = extra.action || query?.action;
        const title = extra.query || query;
        if (!action || !title) return null;
        return await searchAndUpdate(title, { status: action }, wsId, `Status \u2192 ${capitalize(action)}`);
      }

      case 'update_priority': {
        const prio = extra.action || 'high';
        const title = extra.query || query;
        if (!title) return null;
        return await searchAndUpdate(title, { priority: prio }, wsId, `Priority \u2192 ${capitalize(prio)}`);
      }

      case 'update_date': {
        // If a date hint was provided, try to parse it
        const dateHint = extra.dateHint;
        const title = extra.query || query;
        if (!title) return null;

        if (dateHint) {
          const parsedDate = tryParseDate(dateHint);
          if (parsedDate) {
            return await searchAndUpdate(title, { due_date: parsedDate }, wsId, `Due date \u2192 ${parsedDate}`);
          }
        }
        // No date or couldn't parse — fall through to Claude
        return null;
      }

      case 'create_item':
      case 'update_assignee':
      case 'teamhub_mutation':
        // Complex mutations — fall through to Claude with locked prompt
        return null;

      default:
        return null;
    }
  } catch (err) {
    console.error(`[TG] [FAST] Error (${intent}):`, err.message);
    return null;
  }
}

/**
 * Try to parse a natural language date string into YYYY-MM-DD.
 */
function tryParseDate(hint) {
  const t = hint.trim().toLowerCase();

  // "tomorrow"
  if (t === 'tomorrow') {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0];
  }

  // "next week" / "next monday"
  if (t === 'next week') {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().split('T')[0];
  }

  // "in X days"
  const inDays = t.match(/^in\s+(\d+)\s+days?$/);
  if (inDays) {
    const d = new Date();
    d.setDate(d.getDate() + parseInt(inDays[1]));
    return d.toISOString().split('T')[0];
  }

  // "March 15" / "Mar 15" / "march 15th"
  const monthDay = t.match(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{1,2})(?:st|nd|rd|th)?$/i);
  if (monthDay) {
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const m = months[monthDay[1].toLowerCase().substring(0, 3)];
    const d = parseInt(monthDay[2]);
    const year = new Date().getFullYear();
    const date = new Date(year, m, d);
    // If the date is in the past, use next year
    if (date < new Date()) date.setFullYear(year + 1);
    return date.toISOString().split('T')[0];
  }

  // "YYYY-MM-DD" or "MM/DD" or "M/D"
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return t;

  const slashDate = t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (slashDate) {
    const month = parseInt(slashDate[1]) - 1;
    const day = parseInt(slashDate[2]);
    let year = slashDate[3] ? parseInt(slashDate[3]) : new Date().getFullYear();
    if (year < 100) year += 2000;
    return new Date(year, month, day).toISOString().split('T')[0];
  }

  return null;
}

module.exports = { detectIntent, handleIntent, formatItemDetail, formatItemCompact, formatItemsList };
