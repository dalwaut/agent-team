require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const corsMiddleware = require('./middleware/cors');
const { initializeWatchers } = require('./services/file-watcher');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3737;

// Middleware
app.use(morgan('dev')); // Logging
app.use(corsMiddleware); // CORS
app.use(express.json()); // JSON body parsing
app.use(express.urlencoded({ extended: true })); // URL-encoded body parsing

// Routes
app.use('/api/health', require('./routes/health'));
app.use('/api/dashboard', require('./routes/dashboard'));

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'OPAI API Server',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/api/health',
      dashboard: '/api/dashboard',
    },
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[Server] Error:', err);
  res.status(500).json({
    error: err.message || 'Internal server error',
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  });
});

// Start server
const server = app.listen(PORT, () => {
  console.log('╔════════════════════════════════════════╗');
  console.log('║      OPAI API Server Started           ║');
  console.log('╠════════════════════════════════════════╣');
  console.log(`║  Port:        ${PORT.toString().padEnd(24)} ║`);
  console.log(`║  Environment: ${(process.env.NODE_ENV || 'development').padEnd(24)} ║`);
  console.log(`║  OPAI Root:   ${(process.env.OPAI_ROOT || '/home/dallas/SD/OPAI/.agent').substring(0, 18).padEnd(24)} ║`);
  console.log('╚════════════════════════════════════════╝');
});

// Initialize file watchers
let watcher;
try {
  watcher = initializeWatchers();
  console.log('✓ File watchers initialized successfully');
} catch (err) {
  console.error('✗ Failed to initialize file watchers:', err);
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received, shutting down gracefully...');

  if (watcher) {
    watcher.close();
  }

  server.close(() => {
    console.log('[Server] HTTP server closed');
    process.exit(0);
  });

  // Force shutdown after 10s
  setTimeout(() => {
    console.error('[Server] Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
});

process.on('SIGINT', () => {
  console.log('[Server] SIGINT received, shutting down gracefully...');

  if (watcher) {
    watcher.close();
  }

  server.close(() => {
    console.log('[Server] HTTP server closed');
    process.exit(0);
  });
});

module.exports = app;
