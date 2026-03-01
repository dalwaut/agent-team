/**
 * Work Companion — Task classifier and router for the OPAI agent system.
 *
 * Analyzes task descriptions, classifies them by type/complexity/priority,
 * identifies target projects, and recommends the best squad or agents to handle them.
 *
 * Used by:
 *   - Discord bot (`!@ task: fix the login bug in BoutaChat`)
 *   - Standalone CLI (`node tools/work-companion/ "fix the login bug"`)
 *   - Other agents reading tasks/queue.json
 *
 * Philosophy: classify fast, route smart, always propose (never auto-execute
 * without human approval for non-trivial tasks).
 */

const fs = require('fs');
const path = require('path');

const ROUTES_FILE = path.join(__dirname, 'routes.json');
const QUEUE_FILE = path.join(__dirname, '..', '..', 'tasks', 'queue.json');

// Try to load task-manager for unified registry (optional)
let taskManager = null;
try { taskManager = require('../../tasks/task-manager'); } catch {}

let routes = null;

function loadRoutes() {
  if (routes) return routes;
  try {
    routes = JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf8'));
  } catch {
    routes = { type_routes: {}, keywords: {}, priority_keywords: {}, complexity_indicators: {}, known_projects: [] };
  }
  return routes;
}

// ──────────────────────────────────────────────────────────
// Task Classification
// ──────────────────────────────────────────────────────────

/**
 * Classify a task description into type, complexity, priority, and target project.
 * Uses keyword matching — fast and deterministic, no API calls needed.
 *
 * @param {string} description — The raw task description
 * @returns {{ type, confidence, complexity, priority, project, description }}
 */
function classifyTask(description) {
  const r = loadRoutes();
  const lower = description.toLowerCase();

  // 1. Detect task type via keyword matching
  const typeScores = {};
  for (const [type, keywords] of Object.entries(r.keywords || {})) {
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score++;
    }
    if (score > 0) typeScores[type] = score;
  }

  // Pick highest-scoring type
  let taskType = 'feature'; // default fallback
  let confidence = 'low';
  const sorted = Object.entries(typeScores).sort((a, b) => b[1] - a[1]);
  if (sorted.length > 0) {
    taskType = sorted[0][0];
    confidence = sorted[0][1] >= 2 ? 'high' : 'medium';
    // If two types tie, reduce confidence
    if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) {
      confidence = 'low';
    }
  }

  // 2. Detect complexity
  let complexity = 'moderate'; // default
  for (const kw of (r.complexity_indicators?.trivial || [])) {
    if (lower.includes(kw)) { complexity = 'trivial'; break; }
  }
  for (const kw of (r.complexity_indicators?.complex || [])) {
    if (lower.includes(kw)) { complexity = 'complex'; break; }
  }

  // 3. Detect priority
  let priority = 'normal';
  for (const kw of (r.priority_keywords?.urgent || [])) {
    if (lower.includes(kw)) { priority = 'urgent'; break; }
  }
  if (priority === 'normal') {
    for (const kw of (r.priority_keywords?.low || [])) {
      if (lower.includes(kw)) { priority = 'low'; break; }
    }
  }

  // 4. Detect target project
  let project = null;
  for (const p of (r.known_projects || [])) {
    if (lower.includes(p.toLowerCase())) {
      project = p;
      break;
    }
  }

  return { type: taskType, confidence, complexity, priority, project, description };
}

// ──────────────────────────────────────────────────────────
// Task Routing
// ──────────────────────────────────────────────────────────

/**
 * Given a classification, return the recommended execution route.
 *
 * @param {object} classification — Output from classifyTask()
 * @returns {{ squads, agents, specialists, mode, runCommand, summary }}
 */
function routeTask(classification) {
  const r = loadRoutes();
  const route = r.type_routes?.[classification.type] || r.type_routes?.feature;

  const squads = route?.recommended_squads || [];
  const agents = route?.recommended_agents || [];
  const specialists = route?.specialist_templates || [];

  // Determine execution mode based on complexity
  let mode = route?.default_mode || 'propose';
  if (classification.complexity === 'trivial' && mode === 'propose') {
    mode = 'auto_safe'; // Trivial tasks can run safely
  }
  if (classification.complexity === 'complex') {
    mode = 'propose'; // Always propose for complex tasks
  }
  if (classification.priority === 'urgent') {
    // Urgent tasks still propose but are flagged
    mode = mode === 'auto_safe' ? 'auto_safe' : 'propose';
  }

  // Build run command suggestion
  let runCommand = '';
  if (squads.length > 0) {
    const squad = squads[0];
    const projectFlag = classification.project
      ? ` (target: ${classification.project})`
      : '';
    runCommand = `.\\scripts\\run_squad.ps1 -Squad "${squad}" -SkipPreflight${projectFlag}`;
  } else if (specialists.length > 0) {
    runCommand = `Use specialist template: ${specialists[0]}`;
  }

  const summary = [
    `**Type:** ${classification.type.replace('_', ' ')} (${classification.confidence} confidence)`,
    `**Complexity:** ${classification.complexity}`,
    `**Priority:** ${classification.priority}`,
    classification.project ? `**Project:** ${classification.project}` : null,
    `**Recommended:** ${route?.description || 'General task'}`,
    `**Mode:** ${mode}`,
    squads.length > 0 ? `**Squad:** ${squads.join(', ')}` : null,
    agents.length > 0 ? `**Agents:** ${agents.join(', ')}` : null,
    specialists.length > 0 ? `**Specialists:** ${specialists.join(', ')}` : null,
    runCommand ? `**Run:** \`${runCommand}\`` : null,
  ].filter(Boolean).join('\n');

  return { squads, agents, specialists, mode, runCommand, summary };
}

// ──────────────────────────────────────────────────────────
// Queue Integration
// ──────────────────────────────────────────────────────────

/**
 * Add a classified task to the OPAI task queue.
 *
 * @param {object} classification — Output from classifyTask()
 * @param {object} routing — Output from routeTask()
 * @param {string} source — Where this task came from (e.g., 'discord', 'cli', 'inbox')
 * @returns {string} — The queue item ID
 */
function queueTask(classification, routing, source = 'discord') {
  let queue;
  try {
    queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  } catch {
    queue = { version: '1.0.0', queue: [], completed: [] };
  }

  // Generate next ID
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const existing = queue.queue.filter(q => q.id?.startsWith(`q-${today}`));
  const nextNum = String(existing.length + 1).padStart(3, '0');
  const id = `q-${today}-${nextNum}`;

  const now = new Date().toISOString();
  const item = {
    id,
    type: 'agent-task',
    status: routing.mode === 'auto_safe' ? 'queued' : 'blocked',
    priority: classification.priority === 'urgent' ? 'high' : classification.priority,
    created: now,
    updated: now,
    description: classification.description,
    payload: {
      task_type: classification.type,
      complexity: classification.complexity,
      confidence: classification.confidence,
      project: classification.project,
      recommended_squads: routing.squads,
      recommended_agents: routing.agents,
      specialist_templates: routing.specialists,
      execution_mode: routing.mode,
      run_command: routing.runCommand,
      source,
    },
    blocked_reason: routing.mode === 'propose' ? 'Awaiting human approval' : null,
    retry_count: 0,
    max_retries: 3,
  };

  queue.queue.push(item);
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf8');

  return id;
}

// ──────────────────────────────────────────────────────────
// Full Pipeline
// ──────────────────────────────────────────────────────────

/**
 * Full pipeline: classify → route → (optionally queue).
 *
 * @param {string} description — The raw task description
 * @param {{ queue?: boolean, source?: string }} options
 * @returns {{ classification, routing, queueId? }}
 */
function processTask(description, options = {}) {
  const classification = classifyTask(description);
  const routing = routeTask(classification);
  let queueId = null;

  if (options.queue) {
    queueId = queueTask(classification, routing, options.source || 'cli');
  }

  // Write to unified task registry (unless source is 'email' — email checker writes its own)
  if (taskManager && options.source !== 'email') {
    try {
      const registryId = taskManager.addTask({
        title: description,
        source: options.source || 'cli',
        project: classification.project,
        assignee: routing.mode === 'auto_safe' ? 'agent' : 'human',
        priority: classification.priority === 'urgent' ? 'high' : classification.priority,
        routing: { type: classification.type, squads: routing.squads, mode: routing.mode },
      });
      // Attach registry ID to return value
      return { classification, routing, queueId, registryId };
    } catch {}
  }

  return { classification, routing, queueId };
}

// ──────────────────────────────────────────────────────────
// CLI Entry Point
// ──────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Usage: node tools/work-companion/ "task description"');
    console.log('  --queue    Also add to tasks/queue.json');
    process.exit(0);
  }

  const doQueue = args.includes('--queue');
  const description = args.filter(a => !a.startsWith('--')).join(' ');

  if (!description) {
    console.error('No task description provided.');
    process.exit(1);
  }

  const result = processTask(description, { queue: doQueue, source: 'cli' });

  console.log('\n' + result.routing.summary);
  if (result.queueId) {
    console.log(`\nQueued as: ${result.queueId}`);
  }
}

module.exports = { classifyTask, routeTask, queueTask, processTask };
