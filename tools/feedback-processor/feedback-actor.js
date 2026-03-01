#!/usr/bin/env node
/**
 * OPAI Feedback Actor
 *
 * Scans Feedback-*.md files for HIGH and MEDIUM severity items that
 * haven't been acted on yet, and creates tasks in the central registry.
 *
 * Runs on a 15-minute schedule via the orchestrator.
 *
 * Usage:
 *   node tools/feedback-processor/feedback-actor.js
 */

const fs = require('fs');
const path = require('path');

// ── Paths ──────────────────────────────────────────────────
const OPAI_ROOT = process.env.OPAI_ROOT || path.resolve(__dirname, '../..');
const IMPROVEMENTS_DIR = path.join(OPAI_ROOT, 'notes', 'Improvements');
const REGISTRY_FILE = path.join(OPAI_ROOT, 'tasks', 'registry.json');

// ── Helpers ────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [feedback-actor] ${msg}`);
}

function loadRegistry() {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    }
  } catch (err) {
    log(`Failed to load registry: ${err.message}`);
  }
  return { tasks: {} };
}

function saveRegistry(registry) {
  registry.lastUpdated = new Date().toISOString();
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf8');
}

function generateTaskId(registry) {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const existing = Object.keys(registry.tasks).filter(k => k.startsWith(`t-${dateStr}-`));
  let num = existing.length + 1;
  while (registry.tasks[`t-${dateStr}-${String(num).padStart(3, '0')}`]) {
    num++;
  }
  return `t-${dateStr}-${String(num).padStart(3, '0')}`;
}

// ── Parse feedback files ───────────────────────────────────

function parseFeedbackFiles() {
  const items = [];

  let files;
  try {
    files = fs.readdirSync(IMPROVEMENTS_DIR)
      .filter(f => f.startsWith('Feedback-') && f.endsWith('.md'));
  } catch {
    return items;
  }

  for (const file of files) {
    const filePath = path.join(IMPROVEMENTS_DIR, file);
    const content = fs.readFileSync(filePath, 'utf8');
    // Extract tool name from filename: Feedback-TeamHub.md -> TeamHub
    const toolName = file.replace('Feedback-', '').replace('.md', '');

    // Parse all severity sections (threshold filtering happens in main())
    for (const severity of ['HIGH', 'MEDIUM', 'LOW']) {
      const sectionRegex = new RegExp(`## ${severity}\\n([\\s\\S]*?)(?=\\n## |$)`);
      const match = content.match(sectionRegex);
      if (!match) continue;

      const sectionContent = match[1];
      // Match non-struck-through items: lines starting with "- **[" but NOT "- ~~**["
      const lineRegex = /^- \*\*\[([^\]]+)\]\*\* (.+?) _\(([^,]+),/gm;
      let lineMatch;
      while ((lineMatch = lineRegex.exec(sectionContent)) !== null) {
        // Skip struck-through lines (already implemented)
        const lineStart = sectionContent.lastIndexOf('\n', lineMatch.index) + 1;
        const fullLine = sectionContent.slice(lineStart, sectionContent.indexOf('\n', lineMatch.index + 1));
        if (fullLine.trimStart().startsWith('- ~~')) continue;

        items.push({
          feedbackId: lineMatch[3].trim(),
          tool: toolName,
          severity,
          category: lineMatch[1],
          description: lineMatch[2].trim(),
          file,
        });
      }
    }
  }

  return items;
}

// ── Auto-routing via work-companion ─────────────────────────

function autoRouteTask(task) {
  const text = (task.title + ' ' + task.description).trim();
  if (!text) return task;

  const companionPath = path.join(OPAI_ROOT, 'tools', 'work-companion', 'index.js');
  if (!fs.existsSync(companionPath)) {
    log('work-companion not found, skipping auto-route');
    return task;
  }

  try {
    const { execSync } = require('child_process');
    const script = `const wc = require('${companionPath.replace(/\\/g, '/')}');` +
      `const c = wc.classifyTask(${JSON.stringify(text)});` +
      `const r = wc.routeTask(c);` +
      `console.log(JSON.stringify({c, r}));`;

    const output = execSync(`node -e "${script.replace(/"/g, '\\"')}"`, {
      cwd: OPAI_ROOT,
      timeout: 10000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const result = JSON.parse(output);
    const routing = result.r || {};
    const classification = result.c || {};

    const squads = routing.squads || [];
    const agents = routing.agents || [];
    const mode = routing.mode || 'propose';

    task.routing = {
      type: classification.type || 'feature',
      squads,
      mode,
    };

    // Try to find a valid agent/squad from team.json
    let teamData;
    const teamFile = path.join(OPAI_ROOT, 'team.json');
    try {
      teamData = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
    } catch {
      return task;
    }

    if (squads.length > 0) {
      const squadId = squads[0];
      if (teamData.squads && teamData.squads[squadId]) {
        task.assignee = 'agent';
        task.agentConfig = {
          agentId: squadId,
          agentType: 'squad',
          agentName: squadId,
          instructions: '',
        };
        return task;
      }
    }

    if (agents.length > 0) {
      for (const agentId of agents) {
        if (teamData.roles && teamData.roles[agentId]) {
          task.assignee = 'agent';
          task.agentConfig = {
            agentId,
            agentType: 'agent',
            agentName: teamData.roles[agentId].name || agentId,
            instructions: '',
          };
          return task;
        }
      }
    }
  } catch (err) {
    log(`Auto-route failed: ${err.message}`);
  }

  return task;
}

// ── Main ───────────────────────────────────────────────────

function loadAutofixThreshold() {
  // Read the feedback_autofix_threshold from orchestrator config
  const orchFile = path.join(OPAI_ROOT, 'config', 'orchestrator.json');
  try {
    if (fs.existsSync(orchFile)) {
      const data = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
      const tp = data.task_processor || {};
      return (tp.feedback_autofix_threshold || 'HIGH').toUpperCase();
    }
  } catch {}
  return 'HIGH';
}

function main() {
  log('Starting');

  // Determine which severity levels to process based on threshold
  const threshold = loadAutofixThreshold();
  if (threshold === 'NONE') {
    log('Auto-fix disabled (threshold: NONE)');
    return;
  }
  const severityLevels = { HIGH: ['HIGH'], MEDIUM: ['HIGH', 'MEDIUM'], LOW: ['HIGH', 'MEDIUM', 'LOW'] };
  const activeLevels = severityLevels[threshold] || ['HIGH'];
  log(`Auto-fix threshold: ${threshold} (processing: ${activeLevels.join(', ')})`);

  const items = parseFeedbackFiles().filter(i => activeLevels.includes(i.severity));
  if (items.length === 0) {
    log(`No feedback items at threshold ${threshold} or above`);
    return;
  }

  log(`Found ${items.length} item(s) at ${threshold}+ severity`);

  const registry = loadRegistry();
  let created = 0;

  // Check which feedback IDs already have tasks
  const existingFeedbackIds = new Set();
  for (const task of Object.values(registry.tasks)) {
    const ref = task.sourceRef || {};
    if (ref.feedbackId) {
      existingFeedbackIds.add(ref.feedbackId);
    }
  }

  for (const item of items) {
    if (existingFeedbackIds.has(item.feedbackId)) {
      continue; // Task already exists for this feedback
    }

    const taskId = generateTaskId(registry);
    const now = new Date().toISOString();

    let task = {
      id: taskId,
      title: `[${item.tool}] ${item.description.slice(0, 120)}`,
      description: item.description,
      source: 'feedback',
      sourceRef: {
        feedbackId: item.feedbackId,
        tool: item.tool,
        severity: item.severity,
        category: item.category,
        file: item.file,
      },
      project: null,
      client: null,
      assignee: null,
      status: 'pending',
      priority: item.severity === 'HIGH' ? 'critical' : 'high',
      deadline: null,
      routing: { type: 'feedback', squads: [], mode: 'propose' },
      queueId: null,
      createdAt: now,
      updatedAt: null,
      completedAt: null,
      agentConfig: null,
      attachments: [],
    };

    // Auto-route to find best agent/squad
    task = autoRouteTask(task);

    // At or above threshold: set mode to execute (auto-run eligible)
    if (activeLevels.includes(item.severity) && task.routing) {
      task.routing.mode = 'execute';
      task.routing.type = 'feedback-fix';
      // Also set up feedback-fixer agent config so auto_execute_cycle picks it up
      if (!task.agentConfig) {
        task.assignee = 'agent';
        task.agentConfig = {
          agentId: 'feedback-fixer',
          agentType: 'claude-direct',
          agentName: 'Feedback Fixer',
          instructions: '',
        };
      }
    }

    registry.tasks[taskId] = task;
    created++;
    const agentInfo = task.agentConfig ? ` → ${task.agentConfig.agentType}:${task.agentConfig.agentId}` : ' (no agent matched)';
    log(`Created task ${taskId} for feedback ${item.feedbackId} (${item.severity})${agentInfo}`);
  }

  if (created > 0) {
    saveRegistry(registry);
    log(`Created ${created} task(s) from feedback`);
  } else {
    log('All HIGH/MEDIUM items already have tasks');
  }
}

main();
