/**
 * OPAI Dev — Extension management API routes.
 *
 * GET  /dev/api/extensions/available  — List library extensions with user enabled status
 * GET  /dev/api/extensions/enabled    — User's enabled extension IDs
 * POST /dev/api/extensions/enable     — Enable an extension for the user
 * POST /dev/api/extensions/disable    — Disable an extension for the user
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const extensions = require('../services/extensions');

const router = express.Router();
router.use(requireAuth);

// GET /dev/api/extensions/available
router.get('/available', (req, res) => {
  try {
    const list = extensions.getAvailableExtensions(req.user.id, req.user.role);
    res.json(list);
  } catch (err) {
    console.error('[extensions] Error listing available:', err.message);
    res.status(500).json({ error: 'Failed to list extensions' });
  }
});

// GET /dev/api/extensions/enabled
router.get('/enabled', (req, res) => {
  try {
    const enabled = extensions.getUserExtensions(req.user.id, req.user.role);
    res.json({ enabled });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get enabled extensions' });
  }
});

// POST /dev/api/extensions/enable
router.post('/enable', (req, res) => {
  const { extension_id } = req.body;
  if (!extension_id) {
    return res.status(400).json({ error: 'extension_id is required' });
  }

  try {
    const ok = extensions.enableExtension(req.user.id, req.user.role, extension_id);
    if (!ok) {
      return res.status(404).json({ error: 'Extension not found in registry' });
    }
    res.json({ enabled: true, extension_id });
  } catch (err) {
    console.error('[extensions] Error enabling:', err.message);
    res.status(500).json({ error: 'Failed to enable extension' });
  }
});

// POST /dev/api/extensions/disable
router.post('/disable', (req, res) => {
  const { extension_id } = req.body;
  if (!extension_id) {
    return res.status(400).json({ error: 'extension_id is required' });
  }

  try {
    extensions.disableExtension(req.user.id, req.user.role, extension_id);
    res.json({ enabled: false, extension_id });
  } catch (err) {
    console.error('[extensions] Error disabling:', err.message);
    res.status(500).json({ error: 'Failed to disable extension' });
  }
});

module.exports = router;
