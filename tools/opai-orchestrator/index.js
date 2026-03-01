#!/usr/bin/env node
/**
 * OPAI Central Orchestrator
 * 
 * Coordinates all OPAI services, manages task scheduling, monitors health,
 * and provides intelligent resource management for the work/family hub.
 * 
 * Features:
 * - Intelligent task scheduling with priority queue
 * - Service health monitoring and auto-recovery
 * - Resource-aware task execution (CPU/memory throttling)
 * - Event-driven architecture
 * - Discord bot integration
 * - Persistent state management
 * 
 * Usage:
 *   node tools/opai-orchestrator/index.js
 *   npm start (from tools/opai-orchestrator/)
 */

const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const os = require('os');
const { logAudit } = require('../shared/audit');

// ──────────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────────

const OPAI_ROOT = process.env.OPAI_ROOT || path.resolve(__dirname, '../..');
const CONFIG_FILE = path.join(OPAI_ROOT, 'config', 'orchestrator.json');
const STATE_FILE = path.join(__dirname, 'data', 'orchestrator-state.json');
const LOG_FILE = path.join(OPAI_ROOT, 'logs', 'orchestrator.log');

// Default configuration
const DEFAULT_CONFIG = {
    schedules: {
        email_check: '*/30 * * * *',           // Every 30 minutes
        workspace_audit: '0 9 * * 1',          // Monday 9am
        knowledge_sync: '0 18 * * *',          // Daily 6pm
        health_check: '*/5 * * * *',           // Every 5 minutes
    },
    resources: {
        max_cpu_percent: 80,
        max_memory_percent: 85,
        max_parallel_jobs: 3,
        check_interval_seconds: 30,
    },
    services: {
        'discord-bot': { enabled: true, critical: true, restart_on_failure: true },
        email: { enabled: true, critical: false, restart_on_failure: true },
        task_processor: { enabled: true, critical: false, restart_on_failure: true },
    },
    api: {
        enabled: true,
        port: 3737,
        host: 'localhost',
    },
};

// ──────────────────────────────────────────────────────────
// State Management
// ──────────────────────────────────────────────────────────

let config = DEFAULT_CONFIG;
let state = {
    startTime: Date.now(),
    activeJobs: {},
    scheduledTasks: {},
    serviceHealth: {},
    lastResourceCheck: null,
    stats: {
        totalJobsRun: 0,
        totalJobsFailed: 0,
        totalRestarts: 0,
    },
};

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const loaded = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            config = { ...DEFAULT_CONFIG, ...loaded };
            log('info', 'Configuration loaded');
        } else {
            // Create default config
            fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
            log('info', 'Created default configuration');
        }
    } catch (err) {
        log('error', `Failed to load config: ${err.message}`);
    }
}

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            state = { ...state, ...loaded, startTime: Date.now(), activeJobs: {} };
            // Prune stale service entries not in current config
            if (state.serviceHealth) {
                const knownServices = Object.keys(config.services);
                for (const key of Object.keys(state.serviceHealth)) {
                    if (!knownServices.includes(key)) {
                        delete state.serviceHealth[key];
                    }
                }
            }
            log('info', 'State restored from previous session');
        }
    } catch (err) {
        log('warn', `Failed to load state: ${err.message}`);
    }
}

function saveState() {
    try {
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
        log('error', `Failed to save state: ${err.message}`);
    }
}

// ──────────────────────────────────────────────────────────
// Logging
// ──────────────────────────────────────────────────────────

function log(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const logEntry = {
        timestamp,
        level: level.toUpperCase(),
        message,
        ...meta,
    };

    const logLine = `[${timestamp}] [${level.toUpperCase()}] ${message}${Object.keys(meta).length > 0 ? ' ' + JSON.stringify(meta) : ''
        }\n`;

    // Console output
    console.log(logLine.trim());

    // File logging
    try {
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        fs.appendFileSync(LOG_FILE, logLine);
    } catch (err) {
        console.error(`Failed to write log: ${err.message}`);
    }
}

// ──────────────────────────────────────────────────────────
// Resource Monitoring
// ──────────────────────────────────────────────────────────

function getSystemResources() {
    return new Promise((resolve) => {
        const cpus = os.cpus();
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;

        const memoryPercent = (usedMem / totalMem) * 100;

        // CPU usage calculation (average over 1 second)
        exec('top -bn1 | grep "Cpu(s)" | sed "s/.*, *\\([0-9.]*\\)%* id.*/\\1/" | awk \'{print 100 - $1}\'', (err, stdout) => {
            const cpuPercent = err ? 0 : parseFloat(stdout.trim()) || 0;

            resolve({
                cpu: cpuPercent,
                memory: memoryPercent,
                timestamp: Date.now(),
            });
        });
    });
}

async function checkResourceAvailability() {
    const resources = await getSystemResources();
    state.lastResourceCheck = resources;

    const cpuOk = resources.cpu < config.resources.max_cpu_percent;
    const memOk = resources.memory < config.resources.max_memory_percent;

    if (!cpuOk || !memOk) {
        log('warn', 'System resources constrained', {
            cpu: `${resources.cpu.toFixed(1)}%`,
            memory: `${resources.memory.toFixed(1)}%`,
        });
    }

    return cpuOk && memOk;
}

// ──────────────────────────────────────────────────────────
// Service Health Monitoring
// ──────────────────────────────────────────────────────────

function checkServiceHealth(serviceName) {
    return new Promise((resolve) => {
        const serviceConfig = config.services[serviceName] || {};
        // Timer-type services (like email) should check the timer unit, not the oneshot service
        const unitName = serviceConfig.type === 'timer'
            ? `opai-${serviceName}.timer`
            : `opai-${serviceName}`;
        exec(`systemctl --user is-active ${unitName}`, (err, stdout) => {
            const status = stdout.trim();
            const isActive = status === 'active' || status === 'waiting';
            const health = {
                name: serviceName,
                active: isActive,
                timestamp: Date.now(),
            };

            state.serviceHealth[serviceName] = health;
            resolve(health);
        });
    });
}

async function monitorAllServices() {
    const services = Object.keys(config.services).filter(s =>
        config.services[s].enabled && config.services[s].type !== 'internal'
    );

    for (const service of services) {
        const health = await checkServiceHealth(service);

        if (!health.active && config.services[service].restart_on_failure) {
            log('warn', `Service ${service} is down, attempting restart`);
            await restartService(service);
        }
    }
}

function restartService(serviceName) {
    return new Promise((resolve) => {
        log('info', `Restarting service: ${serviceName}`);
        exec(`systemctl --user restart opai-${serviceName}`, (err) => {
            if (err) {
                log('error', `Failed to restart ${serviceName}: ${err.message}`);
                resolve(false);
            } else {
                state.stats.totalRestarts++;
                log('info', `Service ${serviceName} restarted successfully`);
                resolve(true);
            }
        });
    });
}

// ──────────────────────────────────────────────────────────
// Task Scheduling
// ──────────────────────────────────────────────────────────

function parseCronExpression(expr) {
    // Simple cron parser for */N patterns and specific times
    // Format: minute hour day month weekday
    const parts = expr.split(' ');
    return {
        minute: parts[0],
        hour: parts[1],
        day: parts[2],
        month: parts[3],
        weekday: parts[4],
    };
}

function shouldRunNow(cronExpr) {
    const now = new Date();
    const cron = parseCronExpression(cronExpr);

    // Check minute
    if (cron.minute.startsWith('*/')) {
        const interval = parseInt(cron.minute.slice(2));
        if (now.getMinutes() % interval !== 0) return false;
    } else if (cron.minute !== '*' && parseInt(cron.minute) !== now.getMinutes()) {
        return false;
    }

    // Check hour
    if (cron.hour !== '*' && parseInt(cron.hour) !== now.getHours()) {
        return false;
    }

    // Check day of week
    if (cron.weekday !== '*' && parseInt(cron.weekday) !== now.getDay()) {
        return false;
    }

    return true;
}

async function checkScheduledTasks() {
    const now = Date.now();

    for (const [taskName, cronExpr] of Object.entries(config.schedules)) {
        const lastRun = state.scheduledTasks[taskName] || 0;
        const timeSinceLastRun = now - lastRun;

        // Don't run more than once per minute
        if (timeSinceLastRun < 60000) continue;

        if (shouldRunNow(cronExpr)) {
            log('info', `Scheduled task triggered: ${taskName}`);
            await executeScheduledTask(taskName);
            state.scheduledTasks[taskName] = now;
            saveState();
        }
    }
}

async function executeScheduledTask(taskName) {
    // Check if resources are available
    const resourcesOk = await checkResourceAvailability();

    if (!resourcesOk) {
        log('warn', `Deferring ${taskName} due to resource constraints`);
        return;
    }

    // Check parallel job limit
    const activeCount = Object.keys(state.activeJobs).length;
    if (activeCount >= config.resources.max_parallel_jobs) {
        log('warn', `Deferring ${taskName} due to parallel job limit`);
        return;
    }

    // Execute based on task type
    switch (taskName) {
        case 'email_check':
            await runEmailCheck();
            break;
        case 'workspace_audit':
            await runAgentSquad('workspace');
            break;
        case 'knowledge_sync':
            await runAgentSquad('knowledge');
            break;
        case 'health_check':
            await monitorAllServices();
            break;
        case 'task_process':
            await processTaskRegistry();
            break;
        case 'user_sandbox_scan':
            await scanUserSandboxes();
            break;
        case 'feedback_process':
            await runFeedbackProcess();
            break;
        case 'feedback_act':
            await runFeedbackAct();
            break;
        case 'dep_scan_daily':
            await runAgentSquad('dep_scan');
            break;
        case 'secrets_scan_daily':
            await runAgentSquad('secrets_scan');
            break;
        case 'security_quick':
            await runAgentSquad('security_quick');
            break;
        case 'incident_check':
            await runAgentSquad('incident');
            break;
        case 'a11y_weekly':
            await runAgentSquad('a11y');
            break;
        case 'self_assessment':
            await runAgentSquad('evolve');
            break;
        case 'evolution':
            await runEvolutionDryRun();
            break;
        default:
            log('warn', `Unknown scheduled task: ${taskName}`);
    }
}

// ──────────────────────────────────────────────────────────
// Task Registry Processing
// ──────────────────────────────────────────────────────────

const REGISTRY_FILE = path.join(OPAI_ROOT, 'tasks', 'registry.json');
const HITL_DIR = path.join('/workspace', 'reports', 'HITL');

let workCompanion = null;
try { workCompanion = require(path.join(OPAI_ROOT, 'tools', 'work-companion')); } catch {}

function loadRegistry() {
    try {
        if (fs.existsSync(REGISTRY_FILE)) {
            return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
        }
    } catch (err) {
        log('error', `Failed to load registry: ${err.message}`);
    }
    return { tasks: {} };
}

function saveRegistry(registry) {
    registry.lastUpdated = new Date().toISOString();
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf8');
}

/**
 * Process the task registry:
 * 1. Auto-route orphaned tasks (assignee: null, no routing squads)
 * 2. Write HITL briefings for propose-mode tasks missing one
 * 3. If auto_execute is on, trigger squads for execute/auto_safe tasks
 */
async function processTaskRegistry() {
    const registry = loadRegistry();
    const tasks = Object.values(registry.tasks);
    const tpConfig = config.task_processor || {};
    const autoExecute = tpConfig.auto_execute || false;
    const maxSquadRuns = tpConfig.max_squad_runs_per_cycle || 2;
    const cooldownMs = (tpConfig.cooldown_minutes || 30) * 60 * 1000;

    let squadRunsThisCycle = 0;
    let routed = 0;
    let briefingsWritten = 0;
    let squadsTriggered = 0;
    let dirty = false;

    for (const task of tasks) {
        if (task.status === 'completed' || task.status === 'cancelled') continue;

        // 1. Auto-route orphaned tasks (no assignee, no routing squads)
        if (!task.assignee && (!task.routing || !task.routing.squads || task.routing.squads.length === 0)) {
            if (workCompanion) {
                try {
                    const classification = workCompanion.classifyTask(task.title + ' ' + (task.description || ''));
                    const routing = workCompanion.routeTask(classification);
                    task.routing = {
                        type: classification.type,
                        squads: routing.squads,
                        mode: routing.mode,
                    };
                    task.assignee = routing.mode === 'auto_safe' ? 'agent' : 'human';
                    task.updatedAt = new Date().toISOString();
                    dirty = true;
                    routed++;
                    log('info', `Auto-routed task ${task.id}: ${classification.type} → [${routing.squads.join(', ')}] (${routing.mode})`);
                } catch (err) {
                    log('error', `Failed to route task ${task.id}: ${err.message}`);
                }
            }
        }

        // 2. Ensure HITL briefing exists for propose-mode tasks
        const mode = task.routing?.mode || 'propose';
        if (mode === 'propose' && task.status === 'pending') {
            const briefingPath = path.join(HITL_DIR, `${task.id}.md`);
            if (!fs.existsSync(briefingPath)) {
                try {
                    fs.mkdirSync(HITL_DIR, { recursive: true });
                    const squads = (task.routing?.squads || []).join(', ') || 'review';
                    const briefing = `# Task: ${task.id}\n\n` +
                        `**Title:** ${task.title}\n` +
                        `**Priority:** ${task.priority || 'normal'}\n` +
                        `**Created:** ${task.createdAt}\n` +
                        `**Source:** ${task.source || 'unknown'}` +
                        (task.sourceRef?.sender ? ` — ${task.sourceRef.senderName || task.sourceRef.sender}` : '') + '\n\n' +
                        `## Description\n${task.description || 'No description provided.'}\n\n` +
                        `## Routing\n- **Recommended Squad:** ${squads}\n- **Mode:** ${mode}\n\n` +
                        `## Delegation\nThis task requires human review before agent execution.\n` +
                        `To run: \`./scripts/run_squad.sh -s ${(task.routing?.squads || ['review'])[0]}\`\n` +
                        `To delegate: \`node tasks/task-manager.js --delegate ${task.id}\`\n`;
                    fs.writeFileSync(briefingPath, briefing, 'utf8');
                    briefingsWritten++;
                    log('info', `Wrote HITL briefing for task ${task.id}`);
                } catch (err) {
                    log('error', `Failed to write HITL briefing for ${task.id}: ${err.message}`);
                }
            }
        }

        // 3. Auto-execute if enabled (only for agent-assigned, execute/auto_safe mode tasks)
        if (autoExecute && task.assignee === 'agent' && task.status === 'pending') {
            if (mode === 'execute' || mode === 'auto_safe') {
                if (squadRunsThisCycle >= maxSquadRuns) continue;

                // Check cooldown — don't re-trigger recently active tasks
                if (task.updatedAt) {
                    const elapsed = Date.now() - new Date(task.updatedAt).getTime();
                    if (elapsed < cooldownMs) continue;
                }

                const squads = task.routing?.squads || [];
                if (squads.length > 0) {
                    const squad = squads[0];
                    task.status = 'running';
                    task.updatedAt = new Date().toISOString();
                    dirty = true;
                    squadRunsThisCycle++;
                    squadsTriggered++;
                    log('info', `Auto-executing task ${task.id} via squad '${squad}'`);

                    // Fire and forget — squad runs async
                    runAgentSquad(squad).then(success => {
                        if (!success) {
                            log('warn', `Squad '${squad}' failed for task ${task.id}`);
                        }
                    });
                }
            }
        }
    }

    if (dirty) saveRegistry(registry);

    if (routed > 0 || briefingsWritten > 0 || squadsTriggered > 0) {
        log('info', `Task processor: routed=${routed}, briefings=${briefingsWritten}, squads_triggered=${squadsTriggered}`);
    }
}

/**
 * Manually trigger a squad run for a specific task.
 * Called via API. Updates task status and launches the squad.
 */
async function runTaskSquad(taskId, squadOverride) {
    const registry = loadRegistry();
    const task = registry.tasks[taskId];
    if (!task) return { success: false, error: `Task ${taskId} not found` };

    const squad = squadOverride || (task.routing?.squads || [])[0];
    if (!squad) return { success: false, error: `No squad configured for task ${taskId}` };

    task.status = 'running';
    task.updatedAt = new Date().toISOString();
    saveRegistry(registry);

    log('info', `Manual squad run for task ${taskId}: squad '${squad}'`);
    runAgentSquad(squad);

    return { success: true, task_id: taskId, squad };
}

// ──────────────────────────────────────────────────────────
// Task Execution
// ──────────────────────────────────────────────────────────

function runEmailCheck() {
    return new Promise((resolve) => {
        const jobId = `email-${Date.now()}`;
        const startTime = Date.now();
        const JOB_TIMEOUT_MS = 5 * 60 * 1000; // 5 minute timeout

        log('info', 'Starting email check', { jobId });

        state.activeJobs[jobId] = {
            type: 'email_check',
            startTime,
        };

        const proc = spawn('node', ['index.js', '--check'], {
            cwd: path.join(OPAI_ROOT, 'tools', 'email-checker'),
            stdio: 'pipe',
        });

        let output = '';
        let finished = false;
        proc.stdout.on('data', (data) => { output += data.toString(); });
        proc.stderr.on('data', (data) => { output += data.toString(); });

        // Kill job if it exceeds timeout
        const timer = setTimeout(() => {
            if (!finished) {
                log('warn', 'Email check timed out, killing process', { jobId, timeoutMs: JOB_TIMEOUT_MS });
                proc.kill('SIGTERM');
                setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
            }
        }, JOB_TIMEOUT_MS);

        proc.on('close', (code) => {
            finished = true;
            clearTimeout(timer);
            delete state.activeJobs[jobId];
            const duration = Date.now() - startTime;

            if (code === 0) {
                state.stats.totalJobsRun++;
                log('info', 'Email check completed', { jobId, duration });
            } else {
                state.stats.totalJobsFailed++;
                log('error', 'Email check failed', { jobId, code, duration, output: output.slice(-500) });
            }

            logAudit({
                tier: 'system',
                service: 'opai-orchestrator',
                event: 'email-check',
                status: code === 0 ? 'completed' : 'failed',
                summary: `Email check ${code === 0 ? 'completed' : 'failed'} — ${Math.round(duration / 1000)}s`,
                duration_ms: duration,
                details: { jobId, exitCode: code },
            });

            saveState();
            resolve(code === 0);
        });
    });
}

function runFeedbackProcess() {
    return new Promise((resolve) => {
        const jobId = `feedback-${Date.now()}`;
        const startTime = Date.now();
        const JOB_TIMEOUT_MS = 5 * 60 * 1000;

        log('info', 'Starting feedback processor', { jobId });

        state.activeJobs[jobId] = {
            type: 'feedback_process',
            startTime,
        };

        const proc = spawn('node', ['index.js'], {
            cwd: path.join(OPAI_ROOT, 'tools', 'feedback-processor'),
            stdio: 'pipe',
        });

        let output = '';
        let finished = false;
        proc.stdout.on('data', (data) => { output += data.toString(); });
        proc.stderr.on('data', (data) => { output += data.toString(); });

        const timer = setTimeout(() => {
            if (!finished) {
                log('warn', 'Feedback processor timed out, killing process', { jobId, timeoutMs: JOB_TIMEOUT_MS });
                proc.kill('SIGTERM');
                setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
            }
        }, JOB_TIMEOUT_MS);

        proc.on('close', (code) => {
            finished = true;
            clearTimeout(timer);
            delete state.activeJobs[jobId];
            const duration = Date.now() - startTime;

            if (code === 0) {
                state.stats.totalJobsRun++;
                log('info', 'Feedback processor completed', { jobId, duration });
            } else {
                state.stats.totalJobsFailed++;
                log('error', 'Feedback processor failed', { jobId, code, duration, output: output.slice(-500) });
            }

            logAudit({
                tier: 'system',
                service: 'opai-orchestrator',
                event: 'feedback-cycle',
                status: code === 0 ? 'completed' : 'failed',
                summary: `Feedback processor ${code === 0 ? 'completed' : 'failed'} — ${Math.round(duration / 1000)}s`,
                duration_ms: duration,
                details: { jobId, exitCode: code },
            });

            saveState();
            resolve(code === 0);
        });
    });
}

function runFeedbackAct() {
    return new Promise((resolve) => {
        const jobId = `feedback-act-${Date.now()}`;
        const startTime = Date.now();
        const JOB_TIMEOUT_MS = 2 * 60 * 1000;

        log('info', 'Starting feedback actor', { jobId });

        state.activeJobs[jobId] = {
            type: 'feedback_act',
            startTime,
        };

        const proc = spawn('node', ['feedback-actor.js'], {
            cwd: path.join(OPAI_ROOT, 'tools', 'feedback-processor'),
            stdio: 'pipe',
        });

        let output = '';
        let finished = false;
        proc.stdout.on('data', (data) => { output += data.toString(); });
        proc.stderr.on('data', (data) => { output += data.toString(); });

        const timer = setTimeout(() => {
            if (!finished) {
                log('warn', 'Feedback actor timed out, killing process', { jobId, timeoutMs: JOB_TIMEOUT_MS });
                proc.kill('SIGTERM');
                setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
            }
        }, JOB_TIMEOUT_MS);

        proc.on('close', (code) => {
            finished = true;
            clearTimeout(timer);
            delete state.activeJobs[jobId];
            const duration = Date.now() - startTime;

            if (code === 0) {
                state.stats.totalJobsRun++;
                log('info', 'Feedback actor completed', { jobId, duration });
            } else {
                state.stats.totalJobsFailed++;
                log('error', 'Feedback actor failed', { jobId, code, duration, output: output.slice(-500) });
            }

            logAudit({
                tier: 'system',
                service: 'opai-orchestrator',
                event: 'feedback-act',
                status: code === 0 ? 'completed' : 'failed',
                summary: `Feedback actor ${code === 0 ? 'completed' : 'failed'} — ${Math.round(duration / 1000)}s`,
                duration_ms: duration,
                details: { jobId, exitCode: code },
            });

            saveState();
            resolve(code === 0);
        });
    });
}

function runAgentSquad(squadName) {
    return new Promise((resolve) => {
        const jobId = `squad-${squadName}-${Date.now()}`;
        const startTime = Date.now();
        const SQUAD_TIMEOUT_MS = 15 * 60 * 1000; // 15 minute timeout

        log('info', `Starting agent squad: ${squadName}`, { jobId });

        state.activeJobs[jobId] = {
            type: 'agent_squad',
            squad: squadName,
            startTime,
        };

        const scriptPath = path.join(OPAI_ROOT, 'scripts', 'run_squad.sh');
        const proc = spawn(scriptPath, ['-s', squadName], {
            cwd: OPAI_ROOT,
            stdio: 'pipe',
        });

        let output = '';
        let finished = false;
        proc.stdout.on('data', (data) => { output += data.toString(); });
        proc.stderr.on('data', (data) => { output += data.toString(); });

        const timer = setTimeout(() => {
            if (!finished) {
                log('warn', `Agent squad ${squadName} timed out, killing`, { jobId, timeoutMs: SQUAD_TIMEOUT_MS });
                proc.kill('SIGTERM');
                setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
            }
        }, SQUAD_TIMEOUT_MS);

        proc.on('close', (code) => {
            finished = true;
            clearTimeout(timer);
            delete state.activeJobs[jobId];
            const duration = Date.now() - startTime;

            if (code === 0) {
                state.stats.totalJobsRun++;
                log('info', `Agent squad ${squadName} completed`, { jobId, duration });
            } else {
                state.stats.totalJobsFailed++;
                log('error', `Agent squad ${squadName} failed`, { jobId, code, duration });
            }

            saveState();
            resolve(code === 0);
        });
    });
}

// ──────────────────────────────────────────────────────────
// Evolution Dry-Run
// Reads the latest agent reports, generates a safe-mode plan (no writes),
// writes the plan doc to reports/<date>/, creates a task entry, and
// appends an audit record so both the Tasks and Audit tabs reflect the run.
// ──────────────────────────────────────────────────────────

function appendAuditRecord(record) {
    // Legacy wrapper — delegates to shared audit module
    try {
        logAudit({
            tier: record.tier || 'system',
            service: record.service || 'opai-orchestrator',
            event: record.event || 'unknown',
            status: record.status || 'completed',
            summary: record.summary || '',
            duration_ms: record.duration_ms || null,
            details: record.details || {},
        });
    } catch (err) {
        log('error', `Failed to write audit record: ${err.message}`);
    }
}

function appendTaskRegistryEntry(task) {
    try {
        const registry = loadRegistry();
        registry.tasks[task.id] = task;
        saveRegistry(registry);
    } catch (err) {
        log('error', `Failed to write evolution task: ${err.message}`);
    }
}

function runEvolutionDryRun() {
    return new Promise((resolve) => {
        const jobId = `evolution-${Date.now()}`;
        const startTime = Date.now();
        const startedAt = new Date().toISOString();
        const JOB_TIMEOUT_MS = 20 * 60 * 1000; // 20 min

        log('info', 'Starting evolution dry-run (safe-mode plan generation)', { jobId });

        state.activeJobs[jobId] = { type: 'evolution', startTime };

        const dateStamp = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
        const planFile = path.join(OPAI_ROOT, 'reports', dateStamp, 'evolve_safe_plan.md');
        const scriptPath = path.join(OPAI_ROOT, 'scripts', 'run_auto.sh');

        const nvmBin = path.join(process.env.HOME || '/home/dallas', '.nvm', 'versions', 'node', 'v20.19.5', 'bin');
        const evolveEnv = { ...process.env, PATH: `${nvmBin}:${process.env.PATH || ''}` };
        const proc = spawn(scriptPath,
            ['--mode', 'safe', '--dry-run', '--yes', '--skip-preflight'],
            { cwd: OPAI_ROOT, stdio: 'pipe', env: evolveEnv }
        );

        let output = '';
        let finished = false;
        proc.stdout.on('data', (d) => { output += d.toString(); });
        proc.stderr.on('data', (d) => { output += d.toString(); });

        const timer = setTimeout(() => {
            if (!finished) {
                log('warn', 'Evolution dry-run timed out', { jobId });
                proc.kill('SIGTERM');
                setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
            }
        }, JOB_TIMEOUT_MS);

        proc.on('close', (code) => {
            finished = true;
            clearTimeout(timer);
            delete state.activeJobs[jobId];

            const duration = Date.now() - startTime;
            const completedAt = new Date().toISOString();
            const success = code === 0;
            const dateStr = new Date().toLocaleDateString('en-CA');

            if (success) {
                state.stats.totalJobsRun++;
                log('info', 'Evolution dry-run completed', { jobId, duration, planFile });
            } else {
                state.stats.totalJobsFailed++;
                log('error', 'Evolution dry-run failed', { jobId, code, duration });
            }

            // Write audit record
            const rand = Math.floor(Math.random() * 900) + 100;
            const ts = Math.floor(Date.now() / 1000) % 100000;
            const auditId = `audit-${dateStr.replace(/-/g, '')}-${rand}-${ts}`;
            appendAuditRecord({
                id: auditId,
                timestamp: completedAt,
                tier: 'system',
                service: 'opai-orchestrator',
                event: 'evolution-dry-run',
                status: success ? 'completed' : 'failed',
                summary: success
                    ? `Evolution dry-run completed — plan written to ${planFile}`
                    : `Evolution dry-run failed (exit code ${code})`,
                duration_ms: duration,
                details: {
                    agentId: 'evolution',
                    agentName: 'Evolution Dry-Run (safe-mode plan)',
                    reportFile: success ? planFile : null,
                    isError: !success,
                    errorMessage: success ? null : `Exit code ${code}`,
                    outputSizeChars: output.length,
                },
            });

            // Write task registry entry so Tasks tab shows it
            if (success && fs.existsSync(planFile)) {
                const now = new Date().toISOString();
                const taskDate = dateStr.replace(/-/g, '');
                const registry = loadRegistry();
                const existingKeys = Object.keys(registry.tasks).filter(k => k.startsWith(`t-${taskDate}-`));
                let n = existingKeys.length + 1;
                while (registry.tasks[`t-${taskDate}-${String(n).padStart(3, '0')}`]) n++;
                const taskId = `t-${taskDate}-${String(n).padStart(3, '0')}`;

                // Only create if one doesn't already exist for today's evolution plan
                const alreadyExists = Object.values(registry.tasks).some(t =>
                    (t.title || '').includes('Evolution Plan') &&
                    (t.createdAt || '').startsWith(dateStr) &&
                    t.status !== 'completed' && t.status !== 'cancelled'
                );
                if (!alreadyExists) {
                    appendTaskRegistryEntry({
                        id: taskId,
                        title: `[EVOLUTION] Review safe-mode plan — ${dateStr}`,
                        description: `**Daily Evolution Dry-Run**\n\nThe auto-executor generated a safe-mode plan from the latest agent reports.\n\n**Plan file:** ${planFile}\n\nReview the plan and run \`./scripts/run_auto.sh --mode safe --yes\` to apply, or dismiss this task if no action is needed.`,
                        source: 'evolution',
                        sourceRef: { planFile, dateStr },
                        project: null,
                        client: null,
                        assignee: 'human',
                        status: 'pending',
                        priority: 'normal',
                        deadline: null,
                        routing: { type: 'run-report', squads: [], mode: 'log' },
                        queueId: null,
                        createdAt: now,
                        updatedAt: null,
                        completedAt: null,
                        agentConfig: null,
                        attachments: [{ name: 'evolve_safe_plan.md', path: planFile, addedAt: now }],
                    });
                    log('info', `Evolution task created: ${taskId}`);
                }
            }

            saveState();
            resolve(success);
        });
    });
}

// ──────────────────────────────────────────────────────────
// User Sandbox Scanning
// ──────────────────────────────────────────────────────────

const USERS_ROOT = config.sandbox?.scan_root || '/workspace/users';

// Scan user sandboxes for pending tasks and execute them.
// Reads each user's tasks/queue.json for pending tasks,
// validates against per-user limits, and executes within the user's sandbox.
async function scanUserSandboxes() {
    const sandboxConfig = config.sandbox || {};
    if (!sandboxConfig.enabled) return;

    const scanRoot = sandboxConfig.scan_root || '/workspace/users';
    const maxUserJobs = sandboxConfig.max_user_jobs_parallel || 2;
    const timeoutSec = sandboxConfig.timeout_seconds || 300;

    // Check if scan root exists
    if (!fs.existsSync(scanRoot)) return;

    let userDirs;
    try {
        userDirs = fs.readdirSync(scanRoot, { withFileTypes: true })
            .filter(d => d.isDirectory() || d.isSymbolicLink())
            .map(d => d.name);
    } catch (err) {
        log('error', `Failed to read user sandbox root: ${err.message}`);
        return;
    }

    // Count active user jobs toward global limit
    const activeUserJobs = Object.values(state.activeJobs)
        .filter(j => j.type === 'user_sandbox').length;

    if (activeUserJobs >= maxUserJobs) return;

    const globalActiveCount = Object.keys(state.activeJobs).length;
    if (globalActiveCount >= config.resources.max_parallel_jobs) return;

    let tasksPickedUp = 0;

    for (const userDir of userDirs) {
        // Skip UUID symlinks (they point to named dirs)
        const fullPath = path.join(scanRoot, userDir);
        try {
            const stat = fs.lstatSync(fullPath);
            if (stat.isSymbolicLink()) continue;
        } catch { continue; }

        const queueFile = path.join(fullPath, 'tasks', 'queue.json');
        if (!fs.existsSync(queueFile)) continue;

        let queue;
        try {
            queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
        } catch (err) {
            log('warn', `Failed to parse queue for user ${userDir}: ${err.message}`);
            continue;
        }

        const tasks = queue.tasks || [];
        const pendingTasks = tasks.filter(t => t.status === 'pending');

        for (const task of pendingTasks) {
            // Check limits
            if (globalActiveCount + tasksPickedUp >= config.resources.max_parallel_jobs) break;
            if (activeUserJobs + tasksPickedUp >= maxUserJobs) break;

            log('info', `Picking up user task: ${task.id} from ${userDir}`, {
                title: task.title,
                user: task.source_name || userDir,
            });

            // Mark as in_progress in user queue
            task.status = 'running';
            task.updated_at = new Date().toISOString();
            fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2), 'utf8');

            // Create entry in central registry
            const registry = loadRegistry();
            registry.tasks[task.id] = {
                id: task.id,
                title: task.title,
                description: task.description || '',
                status: 'running',
                source: 'user-sandbox',
                sourceRef: {
                    user_id: task.source_user,
                    user_name: task.source_name,
                    sandbox_dir: fullPath,
                },
                createdAt: task.created_at,
                updatedAt: new Date().toISOString(),
            };
            saveRegistry(registry);

            // Execute in sandbox (fire and forget)
            const jobId = `user-${userDir}-${task.id}`;
            state.activeJobs[jobId] = {
                type: 'user_sandbox',
                user: userDir,
                taskId: task.id,
                startTime: Date.now(),
            };

            const sandboxDir = fullPath;
            const proc = spawn('timeout', [String(timeoutSec), 'claude', '-p', task.title, '--output-format', 'text'], {
                cwd: sandboxDir,
                stdio: 'pipe',
                env: { ...process.env, HOME: process.env.HOME },
            });

            let output = '';
            proc.stdout.on('data', (data) => { output += data.toString(); });
            proc.stderr.on('data', (data) => { output += data.toString(); });

            proc.on('close', (code) => {
                delete state.activeJobs[jobId];

                // Write report to user's sandbox
                const reportDir = path.join(sandboxDir, 'reports', 'latest');
                try {
                    fs.mkdirSync(reportDir, { recursive: true });
                    fs.writeFileSync(
                        path.join(reportDir, `task-${task.id}.md`),
                        output || '(no output)',
                        'utf8'
                    );
                } catch (err) {
                    log('error', `Failed to write user task report: ${err.message}`);
                }

                // Update user queue
                try {
                    const q = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
                    const t = (q.tasks || []).find(x => x.id === task.id);
                    if (t) {
                        t.status = code === 0 ? 'completed' : 'failed';
                        t.updated_at = new Date().toISOString();
                        t.exit_code = code;
                        fs.writeFileSync(queueFile, JSON.stringify(q, null, 2), 'utf8');
                    }
                } catch {}

                // Update central registry
                try {
                    const reg = loadRegistry();
                    if (reg.tasks[task.id]) {
                        reg.tasks[task.id].status = code === 0 ? 'completed' : 'failed';
                        reg.tasks[task.id].updatedAt = new Date().toISOString();
                        saveRegistry(reg);
                    }
                } catch {}

                if (code === 0) {
                    state.stats.totalJobsRun++;
                    log('info', `User task ${task.id} completed`, { user: userDir });
                } else {
                    state.stats.totalJobsFailed++;
                    log('warn', `User task ${task.id} failed`, { user: userDir, code });
                }

                saveState();
            });

            tasksPickedUp++;
        }
    }

    if (tasksPickedUp > 0) {
        log('info', `Sandbox scan: picked up ${tasksPickedUp} user task(s)`);
    }
}


// ──────────────────────────────────────────────────────────
// Main Loop
// ──────────────────────────────────────────────────────────

async function mainLoop() {
    log('info', 'Orchestrator main loop started');

    // Check scheduled tasks every minute
    setInterval(async () => {
        await checkScheduledTasks();
    }, 60000);

    // Monitor services every 5 minutes
    setInterval(async () => {
        await monitorAllServices();
    }, 300000);

    // Resource check every 30 seconds
    setInterval(async () => {
        await checkResourceAvailability();
    }, config.resources.check_interval_seconds * 1000);

    // Save state every 5 minutes
    setInterval(() => {
        saveState();
    }, 300000);

    // Sweep stale jobs every 2 minutes
    setInterval(() => {
        sweepStaleJobs();
    }, 120000);

    // Initial checks
    await monitorAllServices();
    await checkResourceAvailability();
}

// Sweep stale jobs whose processes are no longer running.
// Prevents zombie entries from blocking the parallel job limit.
// Interactive sessions (IDE, terminal, claude code) are exempt from
// age-based sweeping — they use lastActivity tracking instead.
function sweepStaleJobs() {
    const now = Date.now();
    const stale = [];

    // Job types that are interactive user sessions — never kill by age alone
    const INTERACTIVE_TYPES = new Set(['interactive', 'ide_session', 'terminal', 'claude_session']);
    // Stale interaction timeout for interactive sessions (no user activity)
    const INTERACTIVE_STALE_MS = 20 * 60 * 1000; // 20 min no interaction = stale
    // Max age for batch jobs (orchestrator-spawned)
    const BATCH_MAX_AGE_MS = 20 * 60 * 1000;

    for (const [jobId, job] of Object.entries(state.activeJobs)) {
        if (INTERACTIVE_TYPES.has(job.type)) {
            // Interactive sessions: only sweep if no user interaction for 20 min
            const lastActivity = job.lastActivity || job.startTime;
            if (now - lastActivity > INTERACTIVE_STALE_MS) {
                stale.push(jobId);
            }
        } else {
            // Batch jobs: sweep if older than max age
            if (now - job.startTime > BATCH_MAX_AGE_MS) {
                stale.push(jobId);
            }
        }
    }

    if (stale.length > 0) {
        for (const jobId of stale) {
            const job = state.activeJobs[jobId];
            const isInteractive = INTERACTIVE_TYPES.has(job.type);
            log('warn', `Sweeping stale ${isInteractive ? 'interactive' : 'batch'} job ${jobId} (type: ${job.type}, age: ${Math.round((now - job.startTime) / 60000)}m)`);
            state.stats.totalJobsFailed++;
            delete state.activeJobs[jobId];
        }
        saveState();
    }
}

// ──────────────────────────────────────────────────────────
// Startup
// ──────────────────────────────────────────────────────────

function startup() {
    log('info', '=== OPAI Orchestrator Starting ===');
    log('info', `OPAI Root: ${OPAI_ROOT}`);
    log('info', `Node version: ${process.version}`);
    log('info', `Platform: ${os.platform()} ${os.release()}`);

    loadConfig();
    loadState();

    // Graceful shutdown
    process.on('SIGTERM', () => {
        log('info', 'Received SIGTERM, shutting down gracefully');
        saveState();
        process.exit(0);
    });

    process.on('SIGINT', () => {
        log('info', 'Received SIGINT, shutting down gracefully');
        saveState();
        process.exit(0);
    });

    mainLoop().catch((err) => {
        log('error', `Main loop error: ${err.message}`);
        process.exit(1);
    });

    log('info', 'Orchestrator ready');
}

// Start the orchestrator
startup();

// Export for testing
module.exports = {
    getSystemResources,
    checkServiceHealth,
    runEmailCheck,
    runFeedbackProcess,
    runFeedbackAct,
    runAgentSquad,
    runEvolutionDryRun,
    processTaskRegistry,
    runTaskSquad,
    scanUserSandboxes,
};
