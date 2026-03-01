/**
 * Job Manager — Track active, completed, and interrupted Claude CLI jobs.
 *
 * Enables the async response queue: messages are acknowledged immediately,
 * Claude runs in the background, and results are delivered when ready.
 * Jobs persist to data/guilds/{guildId}/active-jobs.json per-guild.
 */

const fs = require('fs');
const path = require('path');
const { ensureGuildDir, getGuildDataDir, listGuildIds } = require('./guild-data');

const JOB_RETENTION = 60 * 60 * 1000; // Keep completed jobs for 1 hour

function getJobsFile(guildId) {
  return path.join(getGuildDataDir(guildId), 'active-jobs.json');
}

function load(guildId) {
  try {
    const file = getJobsFile(guildId);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  return { nextId: 1, jobs: {} };
}

function save(guildId, data) {
  ensureGuildDir(guildId);
  fs.writeFileSync(getJobsFile(guildId), JSON.stringify(data, null, 2), 'utf8');
}

/** Create a new running job. Returns the job ID. */
function createJob(guildId, { channelId, statusMessageId, userId, query }) {
  const data = load(guildId);
  const id = `job-${data.nextId++}`;
  data.jobs[id] = {
    channelId,
    statusMessageId,
    userId,
    query: query.substring(0, 200),
    status: 'running',
    startTime: Date.now(),
  };
  save(guildId, data);
  return id;
}

/** Mark a job as completed. */
function completeJob(guildId, id) {
  const data = load(guildId);
  if (data.jobs[id]) {
    data.jobs[id].status = 'completed';
    data.jobs[id].endTime = Date.now();
    save(guildId, data);
  }
}

/** Mark a job as failed with an error message. */
function failJob(guildId, id, error) {
  const data = load(guildId);
  if (data.jobs[id]) {
    data.jobs[id].status = 'failed';
    data.jobs[id].error = error;
    data.jobs[id].endTime = Date.now();
    save(guildId, data);
  }
}

/** Get all currently running jobs for a specific guild. */
function getActiveJobs(guildId) {
  const data = load(guildId);
  return Object.entries(data.jobs)
    .filter(([_, j]) => j.status === 'running')
    .map(([id, j]) => ({ id, ...j }));
}

/**
 * On startup, scan ALL guild directories and mark running jobs as interrupted.
 * Returns the list of interrupted jobs so the bot can notify users.
 */
function recoverAllJobs() {
  const interrupted = [];
  const guildIds = listGuildIds();

  for (const guildId of guildIds) {
    const data = load(guildId);
    let changed = false;

    for (const [id, job] of Object.entries(data.jobs)) {
      if (job.status === 'running') {
        job.status = 'interrupted';
        job.endTime = Date.now();
        interrupted.push({ id, guildId, ...job });
        changed = true;
      }
    }

    // Prune completed/failed/interrupted jobs older than retention period
    const cutoff = Date.now() - JOB_RETENTION;
    for (const [id, job] of Object.entries(data.jobs)) {
      if (job.status !== 'running' && (job.endTime || job.startTime) < cutoff) {
        delete data.jobs[id];
        changed = true;
      }
    }

    if (changed) save(guildId, data);
  }

  return interrupted;
}

module.exports = { createJob, completeJob, failJob, getActiveJobs, recoverAllJobs };
