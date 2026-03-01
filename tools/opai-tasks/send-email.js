#!/usr/bin/env node
/**
 * Email Bridge — Calls email-checker's sender.js via stdin JSON.
 *
 * Input (stdin JSON): { to, subject, body, envPrefix }
 * Output (stdout JSON): { success, messageId, error }
 */

const path = require('path');

// Load email-checker's .env
require('dotenv').config({ path: path.join(__dirname, '..', 'email-checker', '.env') });

const { sendResponse } = require('../email-checker/sender');

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({ success: false, error: 'Invalid JSON input' }));
    process.exit(1);
  }

  const { to, subject, body, envPrefix } = payload;

  if (!to || !subject || !body) {
    console.log(JSON.stringify({ success: false, error: 'Missing required fields: to, subject, body' }));
    process.exit(1);
  }

  const result = await sendResponse(
    { to, subject, finalContent: body },
    envPrefix || ''
  );

  console.log(JSON.stringify(result));
}

main().catch(err => {
  console.log(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
