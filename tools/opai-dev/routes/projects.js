/**
 * OPAI Dev — Project file explorer + CRUD routes.
 *
 * GET    /dev/api/projects              List top-level project folders
 * GET    /dev/api/projects/browse?path=  Browse any directory (returns entries with types)
 * POST   /dev/api/projects              Create a new project folder
 * POST   /dev/api/projects/mkdir        Create a subfolder at any depth
 * PATCH  /dev/api/projects/:name        Rename a top-level project folder
 * DELETE /dev/api/projects/:name        Delete a top-level project folder
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const NFS_ROOT = process.env.NFS_WORKSPACE_ROOT || '/workspace/users';
const OPAI_ROOT = process.env.OPAI_ROOT || '/workspace/synced/opai';

router.use(requireAuth);

/**
 * Resolve the projects root for a user.
 * Admin users → OPAI workspace Projects/ (local dev projects).
 * Regular users → their sandbox Projects/.
 */
function resolveProjectsDir(user) {
  if (user.role === 'admin') {
    return path.join(OPAI_ROOT, 'Projects');
  }
  const uuidPath = path.join(NFS_ROOT, user.id);
  try {
    const sandboxDir = fs.realpathSync(uuidPath);
    return path.join(sandboxDir, 'Projects');
  } catch {
    return null;
  }
}

/**
 * Validate a relative path has no traversal attacks.
 */
function safePath(projRoot, relPath) {
  const resolved = path.resolve(projRoot, relPath);
  if (!resolved.startsWith(projRoot)) return null;
  return resolved;
}

// Allow spaces, ampersands, parens — existing OPAI project names use these
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9 .&_()-]{0,63}$/;

// GET /dev/api/projects — list top-level project folders
router.get('/', async (req, res) => {
  try {
    const dir = resolveProjectsDir(req.user);
    if (!dir) return res.status(404).json({ error: 'Sandbox not provisioned' });

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const projects = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort();

    res.json({ projects });
  } catch (err) {
    console.error('[projects] List error:', err.message);
    res.status(500).json({ error: 'Failed to list projects' });
  }
});

// GET /dev/api/projects/browse?path= — browse directory contents
router.get('/browse', async (req, res) => {
  try {
    const projRoot = resolveProjectsDir(req.user);
    if (!projRoot) return res.status(404).json({ error: 'Sandbox not provisioned' });

    const relPath = (req.query.path || '').replace(/^\/+/, '');
    const browsePath = relPath ? safePath(projRoot, relPath) : projRoot;

    if (!browsePath) return res.status(400).json({ error: 'Invalid path' });
    if (!fs.existsSync(browsePath)) return res.status(404).json({ error: 'Path not found' });

    const stat = fs.statSync(browsePath);
    if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a directory' });

    const entries = fs.readdirSync(browsePath, { withFileTypes: true });
    const items = entries
      .filter(e => !e.name.startsWith('.'))
      .map(e => {
        const fullPath = path.join(browsePath, e.name);
        try {
          const s = fs.statSync(fullPath);
          return {
            name: e.name,
            type: e.isDirectory() ? 'dir' : 'file',
            size: e.isDirectory() ? null : s.size,
            modified: s.mtime.toISOString(),
          };
        } catch {
          return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: null, modified: null };
        }
      })
      .sort((a, b) => {
        // Directories first, then alphabetical
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    res.json({ path: relPath || '', entries: items });
  } catch (err) {
    console.error('[projects] Browse error:', err.message);
    res.status(500).json({ error: 'Failed to browse directory' });
  }
});

// POST /dev/api/projects — create a new top-level project folder
router.post('/', async (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Project name is required' });
  }
  if (!NAME_RE.test(name)) {
    return res.status(400).json({
      error: 'Invalid project name. Use alphanumeric, hyphens, dots, underscores (max 64 chars, must start with alphanumeric).',
    });
  }

  try {
    const projRoot = resolveProjectsDir(req.user);
    if (!projRoot) return res.status(404).json({ error: 'Sandbox not provisioned' });

    const dir = path.join(projRoot, name);
    if (fs.existsSync(dir)) {
      return res.status(409).json({ error: 'Project already exists', name });
    }

    fs.mkdirSync(dir, { recursive: true });
    res.status(201).json({ name });
  } catch (err) {
    console.error('[projects] Create error:', err.message);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

// POST /dev/api/projects/mkdir — create a subfolder at any depth
router.post('/mkdir', async (req, res) => {
  const { path: relPath } = req.body || {};
  if (!relPath || typeof relPath !== 'string') {
    return res.status(400).json({ error: 'path is required' });
  }

  try {
    const projRoot = resolveProjectsDir(req.user);
    if (!projRoot) return res.status(404).json({ error: 'Sandbox not provisioned' });

    const target = safePath(projRoot, relPath);
    if (!target) return res.status(400).json({ error: 'Invalid path' });

    if (fs.existsSync(target)) {
      return res.status(409).json({ error: 'Folder already exists' });
    }

    fs.mkdirSync(target, { recursive: true });
    res.status(201).json({ path: relPath });
  } catch (err) {
    console.error('[projects] Mkdir error:', err.message);
    res.status(500).json({ error: 'Failed to create folder' });
  }
});

// PATCH /dev/api/projects/:name — rename a top-level project folder
router.patch('/:name', async (req, res) => {
  const oldName = req.params.name;
  const { name: newName } = req.body || {};

  if (!newName || typeof newName !== 'string') {
    return res.status(400).json({ error: 'New project name is required' });
  }
  if (!NAME_RE.test(newName)) {
    return res.status(400).json({
      error: 'Invalid project name. Use alphanumeric, hyphens, dots, underscores (max 64 chars, must start with alphanumeric).',
    });
  }
  if (oldName === newName) {
    return res.status(400).json({ error: 'New name is the same as the old name' });
  }

  try {
    const projRoot = resolveProjectsDir(req.user);
    if (!projRoot) return res.status(404).json({ error: 'Sandbox not provisioned' });

    const oldDir = path.join(projRoot, oldName);
    if (!fs.existsSync(oldDir)) {
      return res.status(404).json({ error: `Project not found: ${oldName}` });
    }

    const newDir = path.join(projRoot, newName);
    if (fs.existsSync(newDir)) {
      return res.status(409).json({ error: `Project already exists: ${newName}` });
    }

    fs.renameSync(oldDir, newDir);
    res.json({ old_name: oldName, name: newName });
  } catch (err) {
    console.error('[projects] Rename error:', err.message);
    res.status(500).json({ error: 'Failed to rename project' });
  }
});

// DELETE /dev/api/projects/:name — delete a top-level project folder
router.delete('/:name', async (req, res) => {
  const { name } = req.params;

  try {
    const projRoot = resolveProjectsDir(req.user);
    if (!projRoot) return res.status(404).json({ error: 'Sandbox not provisioned' });

    const dir = path.join(projRoot, name);
    if (!fs.existsSync(dir)) {
      return res.status(404).json({ error: `Project not found: ${name}` });
    }

    fs.rmSync(dir, { recursive: true, force: true });
    res.json({ deleted: name });
  } catch (err) {
    console.error('[projects] Delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

module.exports = router;
