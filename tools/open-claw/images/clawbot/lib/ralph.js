/**
 * RALPH Loop — Read-Act-Log-Plan-Heal execution pattern.
 *
 * Felix technique: For multi-step tasks, ClawBot follows the RALPH cycle:
 *   R — Read: Gather context (memory, knowledge, current state)
 *   A — Act: Execute the current step
 *   L — Log: Record what happened
 *   P — Plan: Determine the next step
 *   H — Heal: Handle errors, retry, or escalate
 *
 * RALPH tasks are stored in /app/workspace/ralph/ and survive container restarts.
 *
 * Usage:
 *   const ralph = require('./lib/ralph');
 *   const task = ralph.create('Send weekly report', [
 *     { id: 'gather', description: 'Gather report data' },
 *     { id: 'draft', description: 'Draft the report' },
 *     { id: 'send', description: 'Send via email' },
 *   ]);
 *   await ralph.advance(task.id, stepExecutor);
 */

const fs = require('fs');
const path = require('path');

const RALPH_DIR = '/app/workspace/ralph';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const INSTANCE_SLUG = process.env.INSTANCE_SLUG || 'unknown';

function log(level, msg, data) {
    if (level === 'debug' && LOG_LEVEL !== 'debug') return;
    console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level,
        instance: INSTANCE_SLUG,
        msg: `[ralph] ${msg}`,
        ...(data || {}),
    }));
}

function _ensureDir() {
    if (!fs.existsSync(RALPH_DIR)) {
        fs.mkdirSync(RALPH_DIR, { recursive: true });
    }
}

function _taskPath(taskId) {
    return path.join(RALPH_DIR, `${taskId}.json`);
}

function _loadTask(taskId) {
    const p = _taskPath(taskId);
    if (!fs.existsSync(p)) return null;
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
        return null;
    }
}

function _saveTask(task) {
    _ensureDir();
    fs.writeFileSync(_taskPath(task.id), JSON.stringify(task, null, 2) + '\n');
}

// ── Task Management ─────────────────────────────────────────

/**
 * Create a new RALPH task with defined steps.
 * @param {string} title - Task description
 * @param {Array<{id: string, description: string}>} steps - Ordered steps
 * @param {object} [context={}] - Initial context data
 * @returns {object} The created task
 */
function create(title, steps, context = {}) {
    const id = `ralph-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const task = {
        id,
        title,
        status: 'pending',  // pending, running, completed, failed, paused
        current_step: 0,
        steps: steps.map((s, i) => ({
            ...s,
            index: i,
            status: 'pending',  // pending, running, completed, failed, skipped
            started_at: null,
            completed_at: null,
            result: null,
            error: null,
            retries: 0,
        })),
        context,
        log: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        max_retries: 3,
    };

    _saveTask(task);
    log('info', 'Task created', { task_id: id, title, steps: steps.length });
    return task;
}

/**
 * Advance a RALPH task by one step using the executor function.
 * @param {string} taskId - Task ID
 * @param {function} executor - Async function(step, context) that returns {result, nextContext}
 * @returns {object} Updated task state
 */
async function advance(taskId, executor) {
    const task = _loadTask(taskId);
    if (!task) throw new Error(`RALPH task ${taskId} not found`);
    if (task.status === 'completed' || task.status === 'failed') {
        return task;
    }

    const stepIndex = task.current_step;
    if (stepIndex >= task.steps.length) {
        task.status = 'completed';
        task.updated_at = new Date().toISOString();
        _saveTask(task);
        return task;
    }

    const step = task.steps[stepIndex];
    task.status = 'running';
    step.status = 'running';
    step.started_at = new Date().toISOString();

    // R — Read: Log the read phase
    _addLog(task, 'read', `Reading context for step: ${step.description}`);

    try {
        // A — Act: Execute the step
        _addLog(task, 'act', `Executing: ${step.description}`);
        const result = await executor(step, task.context);

        // L — Log: Record the result
        step.status = 'completed';
        step.completed_at = new Date().toISOString();
        step.result = result.result || null;
        _addLog(task, 'log', `Completed: ${step.description}`, result.result);

        // P — Plan: Advance to next step
        if (result.nextContext) {
            task.context = { ...task.context, ...result.nextContext };
        }
        task.current_step = stepIndex + 1;

        if (task.current_step >= task.steps.length) {
            task.status = 'completed';
            _addLog(task, 'plan', 'All steps completed');
        } else {
            _addLog(task, 'plan', `Next: ${task.steps[task.current_step].description}`);
        }

    } catch (err) {
        // H — Heal: Handle the error
        step.error = err.message;
        step.retries++;
        _addLog(task, 'heal', `Error on step ${step.id}: ${err.message}`, { retries: step.retries });

        if (step.retries >= task.max_retries) {
            step.status = 'failed';
            task.status = 'failed';
            _addLog(task, 'heal', `Step ${step.id} failed after ${step.retries} retries — task failed`);
        } else {
            step.status = 'pending';  // Will retry on next advance()
            _addLog(task, 'heal', `Will retry step ${step.id} (attempt ${step.retries + 1}/${task.max_retries})`);
        }
    }

    task.updated_at = new Date().toISOString();
    _saveTask(task);
    return task;
}

/**
 * Run all remaining steps of a task to completion.
 * @param {string} taskId - Task ID
 * @param {function} executor - Step executor function
 * @returns {object} Final task state
 */
async function runToCompletion(taskId, executor) {
    let task = _loadTask(taskId);
    if (!task) throw new Error(`RALPH task ${taskId} not found`);

    while (task.status !== 'completed' && task.status !== 'failed') {
        task = await advance(taskId, executor);
    }

    return task;
}

function _addLog(task, phase, message, data = null) {
    task.log.push({
        ts: new Date().toISOString(),
        phase,
        message,
        ...(data ? { data } : {}),
    });
    log('debug', `[${task.id}] ${phase}: ${message}`);
}

// ── Query ───────────────────────────────────────────────────

/**
 * Get a task by ID.
 */
function get(taskId) {
    return _loadTask(taskId);
}

/**
 * List all RALPH tasks.
 * @param {string} [status] - Filter by status
 */
function list(status = null) {
    _ensureDir();
    const files = fs.readdirSync(RALPH_DIR).filter(f => f.startsWith('ralph-') && f.endsWith('.json'));
    const tasks = [];

    for (const file of files) {
        try {
            const task = JSON.parse(fs.readFileSync(path.join(RALPH_DIR, file), 'utf8'));
            if (!status || task.status === status) {
                tasks.push({
                    id: task.id,
                    title: task.title,
                    status: task.status,
                    current_step: task.current_step,
                    total_steps: task.steps.length,
                    created_at: task.created_at,
                    updated_at: task.updated_at,
                });
            }
        } catch {
            // Skip corrupt files
        }
    }

    return tasks.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/**
 * Pause a running task.
 */
function pause(taskId) {
    const task = _loadTask(taskId);
    if (!task) return null;
    if (task.status === 'running') {
        task.status = 'paused';
        task.updated_at = new Date().toISOString();
        _addLog(task, 'plan', 'Task paused');
        _saveTask(task);
    }
    return task;
}

/**
 * Resume a paused task.
 */
function resume(taskId) {
    const task = _loadTask(taskId);
    if (!task) return null;
    if (task.status === 'paused') {
        task.status = 'pending';
        task.updated_at = new Date().toISOString();
        _addLog(task, 'plan', 'Task resumed');
        _saveTask(task);
    }
    return task;
}

module.exports = { create, advance, runToCompletion, get, list, pause, resume };
