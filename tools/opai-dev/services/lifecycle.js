/**
 * OPAI Dev — Container lifecycle manager.
 *
 * Runs on an interval to:
 * 1. Stop containers idle > IDLE_TIMEOUT (default 30min)
 * 2. Destroy containers stopped > STALE_TIMEOUT (default 24h)
 * 3. Reconcile orphan Docker containers not tracked in DB
 */

const db = require('./supabase');
const docker = require('./docker-manager');
const ports = require('./port-allocator');

const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800', 10) * 1000;
const STALE_TIMEOUT = parseInt(process.env.STALE_TIMEOUT || '86400', 10) * 1000;
const INTERVAL = parseInt(process.env.LIFECYCLE_INTERVAL || '60', 10) * 1000;

let timer = null;

async function tick() {
  try {
    await stopIdleContainers();
    await destroyStaleContainers();
    await reconcileOrphans();
  } catch (err) {
    console.error('[lifecycle] Error during tick:', err.message);
  }
}

async function stopIdleContainers() {
  const running = await db.getRunningWorkspaces();
  const now = Date.now();

  for (const ws of running) {
    const lastActive = new Date(ws.last_active_at).getTime();
    if (now - lastActive > IDLE_TIMEOUT) {
      console.log(`[lifecycle] Stopping idle workspace ${ws.id} (idle ${Math.round((now - lastActive) / 60000)}min)`);
      try {
        if (ws.container_id) await docker.destroyContainer(ws.container_id);
        if (ws.container_port) ports.release(ws.container_port);
        await db.updateWorkspace(ws.id, {
          status: 'stopped',
          container_id: null,
          container_port: null,
          stopped_at: new Date().toISOString(),
        });
      } catch (err) {
        console.error(`[lifecycle] Failed to stop workspace ${ws.id}:`, err.message);
        await db.updateWorkspace(ws.id, {
          status: 'error',
          error_message: `Lifecycle stop failed: ${err.message}`,
        });
      }
    }
  }
}

async function destroyStaleContainers() {
  const stopped = await db.getStoppedWorkspaces();
  const now = Date.now();

  for (const ws of stopped) {
    const stoppedAt = new Date(ws.stopped_at || ws.last_active_at).getTime();
    if (now - stoppedAt > STALE_TIMEOUT) {
      console.log(`[lifecycle] Destroying stale workspace ${ws.id} (stopped ${Math.round((now - stoppedAt) / 3600000)}h ago)`);
      try {
        if (ws.container_id) await docker.destroyContainer(ws.container_id);
        if (ws.container_port) ports.release(ws.container_port);
        await db.updateWorkspace(ws.id, {
          status: 'destroyed',
          container_id: null,
          container_port: null,
          destroyed_at: new Date().toISOString(),
        });
      } catch (err) {
        console.error(`[lifecycle] Failed to destroy workspace ${ws.id}:`, err.message);
      }
    }
  }
}

async function reconcileOrphans() {
  const active = await db.getActiveWorkspaces();
  const knownIds = active.map(ws => ws.container_id).filter(Boolean);
  const removed = await docker.cleanupOrphans(knownIds);
  if (removed > 0) {
    console.log(`[lifecycle] Cleaned up ${removed} orphan container(s)`);
  }
}

function start() {
  if (timer) return;
  console.log(`[lifecycle] Starting (idle=${IDLE_TIMEOUT / 1000}s, stale=${STALE_TIMEOUT / 1000}s, interval=${INTERVAL / 1000}s)`);
  timer = setInterval(tick, INTERVAL);
  // Run once immediately after a short delay (let server start first)
  setTimeout(tick, 5000);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, tick };
