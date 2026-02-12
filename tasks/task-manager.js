/**
 * OPAI Task Manager — Unified task registry for all workspace tasks.
 *
 * Single source of truth: tasks/registry.json
 * Supports human tasks (HITL), agent-delegated tasks, and auto-approved recurring work.
 *
 * Sources feed in:
 *   - Email checker: extracted tasks → addTask({ source: 'email' })
 *   - Work companion: classified tasks → addTask({ source: 'discord' | 'cli' })
 *   - Report dispatcher: HITL items → addTask({ source: 'report' })
 *   - Manual: user-created → addTask({ source: 'manual' })
 *
 * Delegation flow:
 *   assignee: "human"  → your task board
 *   assignee: "agent"  → work-companion routes it, optionally queues to queue.json
 *
 * CLI:
 *   node tasks/task-manager.js --mine               Show your tasks
 *   node tasks/task-manager.js --agents              Show agent/delegated tasks
 *   node tasks/task-manager.js --all                 Show everything
 *   node tasks/task-manager.js --add "description"   Add a manual task
 *   node tasks/task-manager.js --delegate t-001      Delegate task to agent
 *   node tasks/task-manager.js --complete t-001      Mark task complete
 *   node tasks/task-manager.js --reject t-001        Reject/cancel task
 *   node tasks/task-manager.js --project BoutaCare   Filter by project
 *   node tasks/task-manager.js --priority high       Filter by priority
 *   node tasks/task-manager.js --import-email        Import existing email tasks
 */

const fs = require('fs');
const path = require('path');

const REGISTRY_FILE = path.join(__dirname, 'registry.json');
const QUEUE_FILE = path.join(__dirname, 'queue.json');

// ──────────────────────────────────────────────────────────
// Registry I/O
// ──────────────────────────────────────────────────────────

function loadRegistry() {
  try {
    if (fs.existsSync(REGISTRY_FILE)) return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
  } catch {}
  return { version: '1.0.0', tasks: {}, lastUpdated: null };
}

function saveRegistry(registry) {
  registry.lastUpdated = new Date().toISOString();
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf8');
}

// ──────────────────────────────────────────────────────────
// ID Generation
// ──────────────────────────────────────────────────────────

function generateId(registry) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `t-${today}`;
  const existing = Object.keys(registry.tasks).filter(k => k.startsWith(prefix));
  const nextNum = String(existing.length + 1).padStart(3, '0');
  return `${prefix}-${nextNum}`;
}

// ──────────────────────────────────────────────────────────
// Core CRUD
// ──────────────────────────────────────────────────────────

/**
 * Add a task to the registry.
 *
 * @param {object} task
 * @param {string} task.title — Short task title
 * @param {string} [task.description] — Longer description/context
 * @param {string} [task.source='manual'] — email | discord | report | manual | agent
 * @param {object} [task.sourceRef] — Trace back to origin (e.g., { messageId, sender, subject })
 * @param {string} [task.project] — Target project name
 * @param {string} [task.assignee='human'] — 'human' or 'agent'
 * @param {string} [task.priority='normal'] — critical | high | normal | low
 * @param {string} [task.deadline] — ISO date or descriptive (e.g., "end of week")
 * @param {object} [task.routing] — { type, squads, mode } from work-companion
 * @returns {string} — The task ID
 */
function addTask(task) {
  const registry = loadRegistry();
  const id = generateId(registry);
  const now = new Date().toISOString();

  registry.tasks[id] = {
    id,
    title: task.title,
    description: task.description || '',
    source: task.source || 'manual',
    sourceRef: task.sourceRef || null,
    project: task.project || null,
    assignee: task.assignee || 'human',
    status: 'pending',
    priority: task.priority || 'normal',
    deadline: task.deadline || null,
    routing: task.routing || null,
    queueId: null,
    createdAt: now,
    updatedAt: null,
    completedAt: null,
  };

  // If assignee is agent, auto-route via work-companion
  if (task.assignee === 'agent') {
    routeToAgent(registry, id);
  }

  saveRegistry(registry);
  return id;
}

/**
 * Get a single task by ID.
 */
function getTask(taskId) {
  const registry = loadRegistry();
  return registry.tasks[taskId] || null;
}

/**
 * List tasks with optional filters.
 *
 * @param {object} [filters]
 * @param {string} [filters.assignee] — 'human' or 'agent'
 * @param {string} [filters.status] — pending | in_progress | delegated | completed | rejected
 * @param {string} [filters.project] — Project name (case-insensitive partial match)
 * @param {string} [filters.source] — email | discord | report | manual | agent
 * @param {string} [filters.priority] — critical | high | normal | low
 * @returns {object[]}
 */
function listTasks(filters = {}) {
  const registry = loadRegistry();
  let tasks = Object.values(registry.tasks);

  if (filters.assignee) {
    tasks = tasks.filter(t => t.assignee === filters.assignee);
  }
  if (filters.status) {
    tasks = tasks.filter(t => t.status === filters.status);
  }
  if (filters.project) {
    const p = filters.project.toLowerCase();
    tasks = tasks.filter(t => t.project && t.project.toLowerCase().includes(p));
  }
  if (filters.source) {
    tasks = tasks.filter(t => t.source === filters.source);
  }
  if (filters.priority) {
    tasks = tasks.filter(t => t.priority === filters.priority);
  }

  // Sort: critical first, then high, then by date
  const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
  tasks.sort((a, b) => {
    const pa = priorityOrder[a.priority] ?? 2;
    const pb = priorityOrder[b.priority] ?? 2;
    if (pa !== pb) return pa - pb;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  return tasks;
}

/**
 * Delegate a task to agents. Sets assignee to "agent" and routes via work-companion.
 * The system decides which squad/agents handle it.
 *
 * @param {string} taskId
 * @returns {{ success: boolean, routing?: object, queueId?: string, error?: string }}
 */
function delegateToAgent(taskId) {
  const registry = loadRegistry();
  const task = registry.tasks[taskId];
  if (!task) return { success: false, error: `Task ${taskId} not found` };
  if (task.status === 'completed' || task.status === 'rejected') {
    return { success: false, error: `Task ${taskId} is already ${task.status}` };
  }

  task.assignee = 'agent';
  task.status = 'delegated';
  task.updatedAt = new Date().toISOString();

  const result = routeToAgent(registry, taskId);
  saveRegistry(registry);

  return { success: true, routing: task.routing, queueId: task.queueId };
}

/**
 * Internal: Route a task to an agent via work-companion and optionally queue it.
 */
function routeToAgent(registry, taskId) {
  const task = registry.tasks[taskId];
  if (!task) return;

  let workCompanion = null;
  try {
    workCompanion = require(path.join(__dirname, '..', 'tools', 'work-companion'));
  } catch {}

  if (workCompanion) {
    const result = workCompanion.processTask(task.title, { queue: true, source: task.source || 'registry' });
    task.routing = {
      type: result.classification.type,
      squads: result.routing.squads,
      agents: result.routing.agents,
      mode: result.routing.mode,
      runCommand: result.routing.runCommand,
    };
    if (result.queueId) {
      task.queueId = result.queueId;
    }
  } else {
    // No work-companion available — just mark as delegated
    task.routing = task.routing || { type: 'unknown', squads: [], mode: 'propose' };
  }
}

/**
 * Escalate a task back to human (from agent).
 */
function escalateToHuman(taskId) {
  const registry = loadRegistry();
  const task = registry.tasks[taskId];
  if (!task) return { success: false, error: `Task ${taskId} not found` };

  task.assignee = 'human';
  task.status = 'pending';
  task.updatedAt = new Date().toISOString();
  saveRegistry(registry);

  return { success: true };
}

/**
 * Mark a task as complete.
 */
function completeTask(taskId) {
  const registry = loadRegistry();
  const task = registry.tasks[taskId];
  if (!task) return { success: false, error: `Task ${taskId} not found` };

  task.status = 'completed';
  task.updatedAt = new Date().toISOString();
  task.completedAt = new Date().toISOString();
  saveRegistry(registry);

  return { success: true };
}

/**
 * Reject/cancel a task.
 */
function rejectTask(taskId) {
  const registry = loadRegistry();
  const task = registry.tasks[taskId];
  if (!task) return { success: false, error: `Task ${taskId} not found` };

  task.status = 'rejected';
  task.updatedAt = new Date().toISOString();
  saveRegistry(registry);

  return { success: true };
}

/**
 * Update a task's status.
 */
function updateTask(taskId, updates) {
  const registry = loadRegistry();
  const task = registry.tasks[taskId];
  if (!task) return { success: false, error: `Task ${taskId} not found` };

  const allowed = ['status', 'priority', 'assignee', 'project', 'deadline', 'description'];
  for (const key of allowed) {
    if (updates[key] !== undefined) task[key] = updates[key];
  }
  task.updatedAt = new Date().toISOString();

  // If assignee changed to agent, auto-route
  if (updates.assignee === 'agent' && task.assignee === 'agent') {
    routeToAgent(registry, taskId);
    task.status = 'delegated';
  }

  saveRegistry(registry);
  return { success: true };
}

// ──────────────────────────────────────────────────────────
// Import: Migrate existing email tasks into registry
// ──────────────────────────────────────────────────────────

/**
 * Import tasks from tools/email-checker/data/email-tasks.json into the registry.
 * Deduplicates by checking sourceRef.messageId + title.
 *
 * @returns {{ imported: number, skipped: number }}
 */
function importEmailTasks() {
  const emailTasksFile = path.join(__dirname, '..', 'tools', 'email-checker', 'data', 'email-tasks.json');
  let emailData;
  try {
    emailData = JSON.parse(fs.readFileSync(emailTasksFile, 'utf8'));
  } catch {
    return { imported: 0, skipped: 0, error: 'Could not read email-tasks.json' };
  }

  const registry = loadRegistry();
  let imported = 0;
  let skipped = 0;

  // Build a set of existing task titles + sourceRefs for dedup
  const existingKeys = new Set();
  for (const task of Object.values(registry.tasks)) {
    if (task.source === 'email' && task.sourceRef?.sender) {
      existingKeys.add(`${task.sourceRef.sender}|${task.title}`);
    }
  }

  for (const [senderEmail, senderData] of Object.entries(emailData.bySender || {})) {
    for (const task of senderData.tasks || []) {
      const key = `${senderEmail}|${task.task}`;
      if (existingKeys.has(key)) {
        skipped++;
        continue;
      }

      const id = generateId(registry);
      const now = new Date().toISOString();

      registry.tasks[id] = {
        id,
        title: task.task,
        description: task.context || '',
        source: 'email',
        sourceRef: {
          sender: senderEmail,
          senderName: senderData.name,
          subject: task.emailSubject,
        },
        project: task.routing?.type === 'wordpress' ? 'Lace & Pearl'
          : detectProject(task.task, senderData.name),
        assignee: task.assignee_type === 'agent' ? 'agent' : 'human',
        status: task.status || 'pending',
        priority: task.priority || 'normal',
        deadline: task.deadline || null,
        routing: task.routing || null,
        queueId: task.queueId || null,
        createdAt: task.extractedAt || now,
        updatedAt: null,
        completedAt: null,
      };

      existingKeys.add(key);
      imported++;
    }
  }

  if (imported > 0) saveRegistry(registry);
  return { imported, skipped };
}

/**
 * Best-effort project detection from task title and sender name.
 */
function detectProject(title, senderName) {
  const lower = (title + ' ' + (senderName || '')).toLowerCase();

  const projectMap = [
    ['boutacare', 'BoutaCare'],
    ['boutachat', 'BoutaChat'],
    ['boutabyte', 'Boutabyte'],
    ['everglades news', 'Everglades-News'],
    ['everglades-news', 'Everglades-News'],
    ['google play', 'Everglades-News'], // Google Play issues are usually Everglades News
    ['lace & pearl', 'Lace & Pearl'],
    ['laceandpearl', 'Lace & Pearl'],
    ['avada bakery', 'Lace & Pearl'],
    ['woocommerce', 'Lace & Pearl'],
    ['farmview', 'FarmView'],
    ['kitchencraft', 'KitchenCraft'],
    ['thiskitchen', 'ThisKitchen'],
    ['hytale', 'HytaleCompanion'],
    ['bytespace', 'ByteSpace'],
    ['nurturenet', 'NurtureNet'],
    ['droneapp', 'DroneApp'],
    ['flipper', 'Flipper'],
    ['ngrok', null], // system tool, not a project
    ['supabase', null], // infrastructure
    ['claude code', null], // tool
  ];

  for (const [keyword, project] of projectMap) {
    if (lower.includes(keyword)) return project;
  }
  return null;
}

// ──────────────────────────────────────────────────────────
// CLI Formatting
// ──────────────────────────────────────────────────────────

const PRIORITY_ICONS = { critical: '!!!', high: '!!', normal: '', low: '~' };
const STATUS_ICONS = { pending: '[ ]', in_progress: '[>]', delegated: '[A]', completed: '[x]', rejected: '[-]' };

function formatTaskLine(task) {
  const pri = PRIORITY_ICONS[task.priority] || '';
  const status = STATUS_ICONS[task.status] || '[ ]';
  const project = task.project ? ` (${task.project})` : '';
  const deadline = task.deadline ? ` [due: ${task.deadline}]` : '';
  const priLabel = pri ? ` ${pri}` : '';
  return `  ${status} ${task.id}${priLabel} ${task.title}${project}${deadline}`;
}

function formatTaskDetail(task) {
  const lines = [
    `  ID:          ${task.id}`,
    `  Title:       ${task.title}`,
    task.description ? `  Description: ${task.description}` : null,
    `  Assignee:    ${task.assignee}`,
    `  Status:      ${task.status}`,
    `  Priority:    ${task.priority}`,
    task.project ? `  Project:     ${task.project}` : null,
    task.deadline ? `  Deadline:    ${task.deadline}` : null,
    `  Source:      ${task.source}`,
    task.sourceRef?.sender ? `  From:        ${task.sourceRef.senderName || ''} <${task.sourceRef.sender}>` : null,
    task.sourceRef?.subject ? `  Subject:     ${task.sourceRef.subject}` : null,
    task.routing ? `  Routing:     ${task.routing.type} → [${(task.routing.squads || []).join(', ')}] (${task.routing.mode})` : null,
    task.queueId ? `  Queue ID:    ${task.queueId}` : null,
    `  Created:     ${task.createdAt}`,
    task.updatedAt ? `  Updated:     ${task.updatedAt}` : null,
    task.completedAt ? `  Completed:   ${task.completedAt}` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

// ──────────────────────────────────────────────────────────
// CLI Entry Point
// ──────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log(`
OPAI Task Manager — Unified task registry

Usage:
  node tasks/task-manager.js --mine               Your pending tasks (HITL)
  node tasks/task-manager.js --agents              Agent/delegated tasks
  node tasks/task-manager.js --all                 All tasks
  node tasks/task-manager.js --add "description"   Add a manual task
  node tasks/task-manager.js --delegate <id>       Delegate task to agent
  node tasks/task-manager.js --escalate <id>       Escalate back to human
  node tasks/task-manager.js --complete <id>       Mark task complete
  node tasks/task-manager.js --reject <id>         Cancel/reject task
  node tasks/task-manager.js --detail <id>         Show task details
  node tasks/task-manager.js --project <name>      Filter by project
  node tasks/task-manager.js --priority <level>    Filter by priority
  node tasks/task-manager.js --import-email        Import existing email tasks
  node tasks/task-manager.js --stats               Show task statistics
`);
    process.exit(0);
  }

  // --import-email
  if (args.includes('--import-email')) {
    const result = importEmailTasks();
    console.log(`[TASKS] Imported ${result.imported} task(s), skipped ${result.skipped} duplicate(s)`);
    if (result.error) console.error(`[TASKS] Error: ${result.error}`);
    process.exit(0);
  }

  // --add "description"
  if (args.includes('--add')) {
    const idx = args.indexOf('--add');
    const desc = args.slice(idx + 1).filter(a => !a.startsWith('--')).join(' ');
    if (!desc) { console.error('Provide a task description after --add'); process.exit(1); }

    const priority = args.includes('--priority') ? args[args.indexOf('--priority') + 1] : 'normal';
    const project = args.includes('--project') ? args[args.indexOf('--project') + 1] : null;

    const id = addTask({ title: desc, source: 'manual', priority, project });
    console.log(`[TASKS] Added: ${id} — "${desc}"`);
    process.exit(0);
  }

  // --delegate <id>
  if (args.includes('--delegate')) {
    const id = args[args.indexOf('--delegate') + 1];
    const result = delegateToAgent(id);
    if (result.success) {
      console.log(`[TASKS] Delegated ${id} to agents`);
      if (result.routing) {
        console.log(`  Route: ${result.routing.type} → [${(result.routing.squads || []).join(', ')}] (${result.routing.mode})`);
      }
      if (result.queueId) console.log(`  Queue ID: ${result.queueId}`);
    } else {
      console.error(`[TASKS] ${result.error}`);
    }
    process.exit(0);
  }

  // --escalate <id>
  if (args.includes('--escalate')) {
    const id = args[args.indexOf('--escalate') + 1];
    const result = escalateToHuman(id);
    console.log(result.success ? `[TASKS] Escalated ${id} to human` : `[TASKS] ${result.error}`);
    process.exit(0);
  }

  // --complete <id>
  if (args.includes('--complete')) {
    const id = args[args.indexOf('--complete') + 1];
    const result = completeTask(id);
    console.log(result.success ? `[TASKS] Completed ${id}` : `[TASKS] ${result.error}`);
    process.exit(0);
  }

  // --reject <id>
  if (args.includes('--reject')) {
    const id = args[args.indexOf('--reject') + 1];
    const result = rejectTask(id);
    console.log(result.success ? `[TASKS] Rejected ${id}` : `[TASKS] ${result.error}`);
    process.exit(0);
  }

  // --detail <id>
  if (args.includes('--detail')) {
    const id = args[args.indexOf('--detail') + 1];
    const task = getTask(id);
    if (task) {
      console.log(`\n${formatTaskDetail(task)}\n`);
    } else {
      console.error(`Task ${id} not found`);
    }
    process.exit(0);
  }

  // --stats
  if (args.includes('--stats')) {
    const all = listTasks();
    const human = all.filter(t => t.assignee === 'human');
    const agent = all.filter(t => t.assignee === 'agent');
    const pending = all.filter(t => t.status === 'pending');
    const delegated = all.filter(t => t.status === 'delegated');
    const completed = all.filter(t => t.status === 'completed');

    const byProject = {};
    for (const t of all) {
      const p = t.project || '(no project)';
      byProject[p] = (byProject[p] || 0) + 1;
    }

    const bySource = {};
    for (const t of all) {
      bySource[t.source] = (bySource[t.source] || 0) + 1;
    }

    console.log(`\nOPAI Task Registry — Statistics`);
    console.log(`  Total:      ${all.length}`);
    console.log(`  Human:      ${human.length} (${pending.filter(t => t.assignee === 'human').length} pending)`);
    console.log(`  Agent:      ${agent.length} (${delegated.length} delegated)`);
    console.log(`  Completed:  ${completed.length}`);
    console.log(`\n  By project:`);
    for (const [p, count] of Object.entries(byProject).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${p}: ${count}`);
    }
    console.log(`\n  By source:`);
    for (const [s, count] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${s}: ${count}`);
    }
    console.log('');
    process.exit(0);
  }

  // List views: --mine, --agents, --all + optional filters
  const filters = {};

  if (args.includes('--mine')) {
    filters.assignee = 'human';
    filters.status = 'pending';
  } else if (args.includes('--agents')) {
    filters.assignee = 'agent';
  }
  // --all = no assignee filter

  if (args.includes('--project')) {
    filters.project = args[args.indexOf('--project') + 1];
  }
  if (args.includes('--priority')) {
    filters.priority = args[args.indexOf('--priority') + 1];
  }
  if (args.includes('--status')) {
    filters.status = args[args.indexOf('--status') + 1];
  }
  if (args.includes('--source')) {
    filters.source = args[args.indexOf('--source') + 1];
  }

  const tasks = listTasks(filters);

  if (tasks.length === 0) {
    console.log('\nNo tasks match your filters.');
    console.log('Run with --import-email to import existing email tasks, or --add to create one.\n');
    process.exit(0);
  }

  // Group by assignee for display
  const humanTasks = tasks.filter(t => t.assignee === 'human');
  const agentTasks = tasks.filter(t => t.assignee === 'agent');

  const label = filters.assignee === 'human' ? 'Your Tasks (HITL)'
    : filters.assignee === 'agent' ? 'Agent Tasks'
    : 'All Tasks';

  console.log(`\n${label} — ${tasks.length} total`);

  if (humanTasks.length > 0 && !filters.assignee) {
    console.log(`\n  YOUR TASKS (${humanTasks.length}):`);
    for (const t of humanTasks) console.log(formatTaskLine(t));
  } else if (humanTasks.length > 0) {
    for (const t of humanTasks) console.log(formatTaskLine(t));
  }

  if (agentTasks.length > 0 && !filters.assignee) {
    console.log(`\n  AGENT TASKS (${agentTasks.length}):`);
    for (const t of agentTasks) console.log(formatTaskLine(t));
  } else if (agentTasks.length > 0) {
    for (const t of agentTasks) console.log(formatTaskLine(t));
  }

  console.log(`\nActions: --delegate <id> | --complete <id> | --reject <id> | --detail <id>\n`);
}

module.exports = {
  addTask,
  getTask,
  listTasks,
  delegateToAgent,
  escalateToHuman,
  completeTask,
  rejectTask,
  updateTask,
  importEmailTasks,
  loadRegistry,
};
