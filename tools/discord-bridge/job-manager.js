/**
 * Job Manager — Track active, completed, and interrupted Claude CLI jobs.
 *
 * Enables the async response queue: messages are acknowledged immediately,
 * Claude runs in the background, and results are delivered when ready.
 * Jobs persist to data/active-jobs.json so interrupted jobs are detected on restart.
 */

const fs = require('fs');
const path = require('path');

const JOBS_FILE = path.join(__dirname, 'data', 'active-jobs.json');
const JOB_RETENTION = 60 * 60 * 1000; // Keep completed jobs for 1 hour

function load() {
  try {
    if (fs.existsSync(JOBS_FILE)) return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  } catch {}
  return { nextId: 1, jobs: {} };
}

function save(data) {
  const dir = path.dirname(JOBS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(JOBS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

/** Create a new running job. Returns the job ID. */
function createJob({ channelId, statusMessageId, userId, query }) {
  const data = load();
  const id = `job-${data.nextId++}`;
  data.jobs[id] = {
    channelId,
    statusMessageId,
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

/** Mark a job as failed with an error message. */
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

/**
 * On startup, mark any running jobs as interrupted and prune old entries.
 * Returns the list of interrupted jobs so the bot can notify users.
 */
function recoverJobs() {
  const data = load();
  const interrupted = [];

  for (const [id, job] of Object.entries(data.jobs)) {
    if (job.status === 'running') {
      job.status = 'interrupted';
      job.endTime = Date.now();
      interrupted.push({ id, ...job });
    }
  }

  // Prune completed/failed/interrupted jobs older than retention period
  const cutoff = Date.now() - JOB_RETENTION;
  for (const [id, job] of Object.entries(data.jobs)) {
    if (job.status !== 'running' && (job.endTime || job.startTime) < cutoff) {
      delete data.jobs[id];
    }
  }

  save(data);
  return interrupted;
}

module.exports = { createJob, completeJob, failJob, getActiveJobs, recoverJobs };
