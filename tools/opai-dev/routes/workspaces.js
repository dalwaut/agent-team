/**
 * OPAI Dev — Workspace CRUD routes (project-scoped).
 *
 * POST   /dev/api/workspaces          Create or switch workspace (requires project_name)
 * GET    /dev/api/workspaces          List user's workspaces
 * GET    /dev/api/workspaces/:id/status  Workspace status + Docker inspect
 * DELETE /dev/api/workspaces/:id      Stop or destroy (?action=stop|destroy)
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const db = require('../services/supabase');
const docker = require('../services/docker-manager');
const ports = require('../services/port-allocator');
const extensions = require('../services/extensions');

const router = express.Router();
const NFS_ROOT = process.env.NFS_WORKSPACE_ROOT || '/workspace/users';
const OPAI_ROOT = process.env.OPAI_ROOT || '/workspace/synced/opai';

// All workspace routes require auth
router.use(requireAuth);

/**
 * Resolve a project path for a user. Accepts relative paths (e.g. "Boutabyte" or "Boutabyte/src").
 * Admin → OPAI workspace Projects/.
 * Regular users → their sandbox Projects/.
 * Returns null if path is invalid or doesn't exist.
 */
function resolveProjectDir(user, relPath) {
  let projRoot;
  if (user.role === 'admin') {
    projRoot = path.join(OPAI_ROOT, 'Projects');
  } else {
    const uuidPath = path.join(NFS_ROOT, user.id);
    try {
      const sandboxDir = fs.realpathSync(uuidPath);
      projRoot = path.join(sandboxDir, 'Projects');
    } catch {
      return null;
    }
  }
  const resolved = path.resolve(projRoot, relPath);
  // Guard against path traversal
  if (!resolved.startsWith(projRoot)) return null;
  return fs.existsSync(resolved) ? resolved : null;
}

// POST /dev/api/workspaces — Create or switch project workspace
router.post('/', async (req, res) => {
  const userId = req.user.id;
  // Accept project_path (browse path like "Boutabyte/src") or project_name (top-level)
  const projectName = (req.body.project_path || req.body.project_name || '').trim();

  if (!projectName) {
    return res.status(400).json({ error: 'project_name or project_path is required' });
  }

  // Validate project folder exists on disk
  const projectDir = resolveProjectDir(req.user, projectName);
  if (!projectDir) {
    return res.status(404).json({ error: `Project folder not found: ${projectName}` });
  }

  try {
    const existing = await db.getWorkspacesByUser(userId);
    const active = existing.find(ws => ['creating', 'running'].includes(ws.status));

    if (active) {
      // Same project already running → return its URL
      if (active.project_name === projectName) {
        return res.status(409).json({
          error: 'Workspace already running for this project',
          workspace: {
            id: active.id,
            status: active.status,
            project_name: active.project_name,
            ide_url: `/dev/ide/${active.id}/`,
          },
        });
      }

      // Different project running → auto-stop old, start new
      console.log(`[workspaces] Switching project: ${active.project_name} → ${projectName}`);
      if (active.container_id) {
        await docker.destroyContainer(active.container_id);
      }
      if (active.container_port) {
        ports.release(active.container_port);
      }
      await db.updateWorkspace(active.id, {
        status: 'stopped',
        container_id: null,
        container_port: null,
        stopped_at: new Date().toISOString(),
      });
    }

    // Clean up any error-status workspaces (mark as destroyed so they stop appearing)
    const errorWorkspaces = existing.filter(ws => ws.status === 'error');
    for (const ew of errorWorkspaces) {
      if (ew.container_id) await docker.destroyContainer(ew.container_id).catch(() => {});
      if (ew.container_port) ports.release(ew.container_port);
      await db.updateWorkspace(ew.id, {
        status: 'destroyed',
        container_id: null,
        container_port: null,
        destroyed_at: new Date().toISOString(),
      });
    }

    // Check for stopped workspace for this project — reuse its DB row
    const stopped = existing.find(ws => ws.status === 'stopped' && ws.project_name === projectName);

    // Also look for any stopped workspace we can reuse (different project)
    const stoppedAny = stopped || existing.find(ws => ws.status === 'stopped');

    if (stoppedAny) {
      // Reuse this DB row: allocate new port, create new container
      const port = ports.allocate();
      if (!port) return res.status(503).json({ error: 'No ports available' });

      try {
        if (stoppedAny.container_id) {
          await docker.destroyContainer(stoppedAny.container_id);
        }
        const userPluginsDir = extensions.stageExtensions(userId, req.user.role);
        const { containerId } = await docker.createContainer(userId, port, projectName, { role: req.user.role, userPluginsDir });
        const ws = await db.updateWorkspace(stoppedAny.id, {
          status: 'running',
          container_id: containerId,
          container_port: port,
          project_name: projectName,
          project_path: projectDir,
          last_active_at: new Date().toISOString(),
          stopped_at: null,
          error_message: null,
        });

        return res.status(200).json({
          workspace_id: ws.id,
          status: 'running',
          project_name: ws.project_name,
          ide_url: `/dev/ide/${ws.id}/`,
        });
      } catch (err) {
        ports.release(port);
        await db.updateWorkspace(stoppedAny.id, {
          status: 'error',
          error_message: err.message,
        });
        throw err;
      }
    }

    // Create new workspace
    const port = ports.allocate();
    if (!port) return res.status(503).json({ error: 'No ports available' });

    const workspaceId = uuidv4();

    const ws = await db.createWorkspace({
      id: workspaceId,
      user_id: userId,
      status: 'creating',
      container_port: port,
      image_tag: process.env.THEIA_IMAGE || 'opai-theia:latest',
      project_name: projectName,
      project_path: projectDir,
    });

    try {
      const userPluginsDir = extensions.stageExtensions(userId, req.user.role);
      const { containerId } = await docker.createContainer(userId, port, projectName, { role: req.user.role, userPluginsDir });
      const updated = await db.updateWorkspace(ws.id, {
        status: 'running',
        container_id: containerId,
      });

      res.status(201).json({
        workspace_id: updated.id,
        status: 'running',
        project_name: updated.project_name,
        ide_url: `/dev/ide/${updated.id}/`,
      });
    } catch (err) {
      ports.release(port);
      await db.updateWorkspace(ws.id, {
        status: 'error',
        error_message: err.message,
      });
      throw err;
    }
  } catch (err) {
    if (!res.headersSent) {
      console.error('[workspaces] Create error:', err.message);
      res.status(500).json({ error: 'Failed to create workspace', detail: err.message });
    }
  }
});

// GET /dev/api/workspaces — List user's workspaces
router.get('/', async (req, res) => {
  try {
    const workspaces = await db.getWorkspacesByUser(req.user.id);
    res.json(workspaces.map(ws => ({
      id: ws.id,
      status: ws.status,
      project_name: ws.project_name || null,
      created_at: ws.created_at,
      last_active_at: ws.last_active_at,
      ide_url: ['creating', 'running'].includes(ws.status) ? `/dev/ide/${ws.id}/` : null,
    })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to list workspaces' });
  }
});

// GET /dev/api/workspaces/:id/status — Workspace status with Docker info
router.get('/:id/status', async (req, res) => {
  try {
    const ws = await db.getWorkspace(req.params.id);
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });

    // Ownership check
    if (ws.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    let dockerInfo = null;
    if (ws.container_id) {
      const info = await docker.inspectContainer(ws.container_id);
      if (info) {
        dockerInfo = {
          running: info.State.Running,
          started_at: info.State.StartedAt,
          finished_at: info.State.FinishedAt,
        };
      }
    }

    res.json({
      id: ws.id,
      status: ws.status,
      project_name: ws.project_name || null,
      created_at: ws.created_at,
      last_active_at: ws.last_active_at,
      stopped_at: ws.stopped_at,
      error_message: ws.error_message,
      docker: dockerInfo,
      ide_url: ['creating', 'running'].includes(ws.status) ? `/dev/ide/${ws.id}/` : null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get workspace status' });
  }
});

// DELETE /dev/api/workspaces/:id — Stop or destroy
router.delete('/:id', async (req, res) => {
  const action = req.query.action || 'stop';

  try {
    const ws = await db.getWorkspace(req.params.id);
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });

    if (ws.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    if (action === 'destroy') {
      if (ws.container_id) await docker.destroyContainer(ws.container_id);
      if (ws.container_port) ports.release(ws.container_port);
      await db.updateWorkspace(ws.id, {
        status: 'destroyed',
        container_id: null,
        container_port: null,
        destroyed_at: new Date().toISOString(),
      });
      return res.json({ status: 'destroyed' });
    }

    // Default: stop — destroy the container (we always create fresh ones)
    if (ws.container_id) {
      await docker.destroyContainer(ws.container_id);
    }
    if (ws.container_port) ports.release(ws.container_port);
    await db.updateWorkspace(ws.id, {
      status: 'stopped',
      container_id: null,
      container_port: null,
      stopped_at: new Date().toISOString(),
    });
    res.json({ status: 'stopped' });
  } catch (err) {
    console.error('[workspaces] Delete error:', err.message);
    res.status(500).json({ error: 'Failed to stop/destroy workspace' });
  }
});

module.exports = router;
