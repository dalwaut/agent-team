/**
 * OPAI Dev — Port allocator for IDE containers.
 * Manages ports 9000-9099 (configurable), bound to 127.0.0.1 only.
 */

const PORT_START = parseInt(process.env.PORT_RANGE_START || '9000', 10);
const PORT_END = parseInt(process.env.PORT_RANGE_END || '9099', 10);

const allocated = new Set();

function allocate() {
  for (let port = PORT_START; port <= PORT_END; port++) {
    if (!allocated.has(port)) {
      allocated.add(port);
      return port;
    }
  }
  return null; // No ports available
}

function release(port) {
  allocated.delete(port);
}

function isAllocated(port) {
  return allocated.has(port);
}

/**
 * Rebuild allocated set from database records (call on startup).
 */
function rebuildFromRecords(activeWorkspaces) {
  allocated.clear();
  for (const ws of activeWorkspaces) {
    if (ws.container_port) {
      allocated.add(ws.container_port);
    }
  }
}

function stats() {
  const total = PORT_END - PORT_START + 1;
  return {
    allocated: allocated.size,
    available: total - allocated.size,
    total,
    range: `${PORT_START}-${PORT_END}`,
  };
}

module.exports = { allocate, release, isAllocated, rebuildFromRecords, stats };
