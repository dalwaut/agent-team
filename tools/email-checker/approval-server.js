/**
 * Approval Server — Tiny Express API for the approval UI.
 *
 * Serves the HTML approval interface and provides REST endpoints
 * for reading/updating email responses and tasks.
 *
 * Usage:
 *   node approval-server.js           — Start on port 3847
 *   node approval-server.js --port N  — Start on custom port
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const { loadResponses, getResponse, getPendingDrafts, approveResponse, rejectResponse, markSent } = require('./response-drafter');
const { sendResponse, getEnvPrefixForAccount, removeDraftFromAccount } = require('./sender');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'approval-ui')));

const TASKS_FILE = path.join(__dirname, 'data', 'email-tasks.json');

// ── API Routes ──

// Get all responses
app.get('/api/responses', (req, res) => {
  const data = loadResponses();
  res.json(data);
});

// Get all tasks + email metadata
app.get('/api/tasks', (req, res) => {
  try {
    const data = fs.existsSync(TASKS_FILE)
      ? JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'))
      : { bySender: {}, emails: {} };
    res.json(data);
  } catch {
    res.json({ bySender: {}, emails: {} });
  }
});

// Get pending drafts
app.get('/api/responses/pending', (req, res) => {
  res.json(getPendingDrafts());
});

// Approve a response (optionally with edited content)
app.post('/api/responses/:id/approve', async (req, res) => {
  const { id } = req.params;
  const { finalContent } = req.body || {};

  const response = approveResponse(id, finalContent);
  if (!response) {
    return res.status(404).json({ error: 'Response not found' });
  }

  // Auto-send after approval
  const envPrefix = getEnvPrefixForAccount(response.account);
  const sendResult = await sendResponse(response, envPrefix);

  if (sendResult.success) {
    markSent(id);
    // Clean up the IMAP draft now that it's been sent via OPAI
    removeDraftFromAccount(response.subject, envPrefix).catch(() => {});
    res.json({ success: true, status: 'sent', messageId: sendResult.messageId });
  } else {
    // Approved but send failed — keep as approved for retry
    res.json({ success: true, status: 'approved', sendError: sendResult.error });
  }
});

// Reject a response
app.post('/api/responses/:id/reject', (req, res) => {
  const { id } = req.params;
  const response = rejectResponse(id);
  if (!response) {
    return res.status(404).json({ error: 'Response not found' });
  }
  res.json({ success: true, status: 'cancelled' });
});

// ── Start Server ──

const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const PORT = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : 3847;

app.listen(PORT, () => {
  console.log(`[APPROVAL] Server running at http://localhost:${PORT}`);
  console.log(`[APPROVAL] Open in browser to review email response drafts.`);
});
