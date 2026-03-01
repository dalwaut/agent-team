/**
 * Job Manager — Track active, completed, and interrupted Claude CLI jobs.
 *
 * Enables async response pattern: messages are acknowledged immediately,
 * Claude runs in the background, results are delivered when ready.
 */

const fs = require('fs');
const path = require('path');

const JOB_RETENTION = 60 * 60 * 1000; // Keep completed jobs for 1 hour
const JOBS_FILE = path.join(__dirname, 'data', 'jobs', 'active-jobs.json');

function ensureDir() {
  const dir = path.dirname(JOBS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  try {
    if (fs.existsSync(JOBS_FILE)) return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  } catch {}
  return { nextId: 1, jobs: {} };
}

function save(data) {
  ensureDir();
  fs.writeFileSync(JOBS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

/** Create a new running job. Returns the job ID. */
function createJob({ chatId, threadId, messageId, userId, query }) {
  const data = load();
  const id = `job-${data.nextId++}`;
  data.jobs[id] = {
    chatId,
    threadId: threadId || 'general',
    messageId,
    userId,
    query: query.substring(0, 200),
    status: 'running',
    startTime: Date.now(),
  };
  save(data);
  return id;
}

/** Mark a job as completed. */
function completeJob(id) {
  const data = load();
  if (data.jobs[id]) {
    data.jobs[id].status = 'completed';
    data.jobs[id].endTime = Date.now();
    save(data);
  }
}

/** Mark a job as failed. */
function failJob(id, error) {
  const data = load();
  if (data.jobs[id]) {
    data.jobs[id].status = 'failed';
    data.jobs[id].error = error;
    data.jobs[id].endTime = Date.now();
    save(data);
  }
}

/** Get all currently running jobs. */
function getActiveJobs() {
  const data = load();
  return Object.entries(data.jobs)
    .filter(([_, j]) => j.status === 'running')
    .map(([id, j]) => ({ id, ...j }));
}

/** On startup, mark running jobs as interrupted and prune old ones. */
function recoverJobs() {
  const data = load();
  const interrupted = [];
  let changed = false;

  for (const [id, job] of Object.entries(data.jobs)) {
    if (job.status === 'running') {
      job.status = 'interrupted';
      job.endTime = Date.now();
      interrupted.push({ id, ...job });
      changed = true;
    }
  }

  // Prune old completed/failed/interrupted jobs
  const cutoff = Date.now() - JOB_RETENTION;
  for (const [id, job] of Object.entries(data.jobs)) {
    if (job.status !== 'running' && (job.endTime || job.startTime) < cutoff) {
      delete data.jobs[id];
      changed = true;
    }
  }

  if (changed) save(data);
  return interrupted;
}

module.exports = { createJob, completeJob, failJob, getActiveJobs, recoverJobs };
