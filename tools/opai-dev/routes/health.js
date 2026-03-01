/**
 * OPAI Dev — Health check endpoint.
 */

const express = require('express');
const ports = require('../services/port-allocator');

const router = express.Router();

router.get('/health', async (_req, res) => {
  const portStats = ports.stats();
  res.json({
    service: 'opai-dev',
    status: 'ok',
    version: '1.0.0',
    ports: portStats,
    uptime: Math.floor(process.uptime()),
  });
});

module.exports = router;
