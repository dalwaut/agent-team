/**
 * Chain Context — scrape email thread history via IMAP for "remember" intent
 *
 * When a user says "remember" or references prior emails, this module
 * fetches the email thread by parsing In-Reply-To / References headers
 * and builds a context block for Claude.
 */

const { ImapFlow } = require('imapflow');
const fs = require('fs');
const path = require('path');

/**
 * Resolve IMAP credentials for an account.
 * @param {object} account - Account from config.json
 * @returns {{ host, port, user, pass }}
 */
function resolveImapCreds(account) {
  const imap = account.imap || {};
  const prefix = account.envPrefix || '';
  return {
    host: imap.host || (prefix ? process.env[`${prefix}_IMAP_HOST`] : '') || 'imap.gmail.com',
    port: imap.port || parseInt(prefix ? process.env[`${prefix}_IMAP_PORT`] : '993', 10),
    user: imap.user || (prefix ? process.env[`${prefix}_IMAP_USER`] : '') || '',
    pass: imap.pass || (prefix ? process.env[`${prefix}_IMAP_PASS`] : '') || '',
  };
}

/**
 * Extract Message-IDs from References and In-Reply-To headers.
 * @param {object} email - { inReplyTo, references }
 * @returns {string[]} Array of Message-IDs to look up
 */
function extractChainIds(email) {
  const ids = new Set();

  if (email.inReplyTo) {
    // In-Reply-To can be a single Message-ID
    const cleaned = email.inReplyTo.trim().replace(/^<|>$/g, '');
    if (cleaned) ids.add(cleaned);
  }

  if (email.references) {
    // References is a space-separated list of Message-IDs
    const refs = typeof email.references === 'string'
      ? email.references.split(/\s+/)
      : (Array.isArray(email.references) ? email.references : []);

    for (const ref of refs) {
      const cleaned = ref.trim().replace(/^<|>$/g, '');
      if (cleaned) ids.add(cleaned);
    }
  }

  return Array.from(ids);
}

/**
 * Fetch parent emails from a thread via IMAP.
 * @param {object} account - Account from config.json
 * @param {object} email - Current email with { inReplyTo, references }
 * @param {number} maxDepth - Maximum number of parent emails to fetch
 * @returns {Promise<object[]>} Array of { from, subject, date, body } ordered oldest-first
 */
async function fetchChainEmails(account, email, maxDepth = 5) {
  const chainIds = extractChainIds(email);
  if (chainIds.length === 0) return [];

  const creds = resolveImapCreds(account);
  if (!creds.user || !creds.pass) {
    console.warn('[CHAIN-CONTEXT] No IMAP credentials available');
    return [];
  }

  const client = new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: true,
    auth: { user: creds.user, pass: creds.pass },
    logger: false,
  });

  const results = [];

  try {
    await client.connect();

    // Search in INBOX and Sent
    for (const folder of ['INBOX', '[Gmail]/Sent Mail', 'Sent']) {
      if (results.length >= maxDepth) break;

      try {
        const lock = await client.getMailboxLock(folder);
        try {
          for (const messageId of chainIds) {
            if (results.length >= maxDepth) break;

            // Search by Message-ID header
            const searchResult = await client.search({
              header: { 'Message-ID': `<${messageId}>` },
            });

            if (searchResult.length > 0) {
              const msg = await client.fetchOne(searchResult[0], {
                envelope: true,
                bodyStructure: true,
                source: { maxLength: 10000 },
              });

              if (msg) {
                const envelope = msg.envelope || {};
                const fromAddr = envelope.from?.[0]?.address || 'unknown';
                const fromName = envelope.from?.[0]?.name || fromAddr;
                const subject = envelope.subject || '(no subject)';
                const date = envelope.date ? new Date(envelope.date).toISOString() : '';

                // Extract text body from source
                let bodyText = '';
                if (msg.source) {
                  const sourceStr = msg.source.toString('utf8');
                  // Simple body extraction — find blank line after headers
                  const bodyStart = sourceStr.indexOf('\r\n\r\n');
                  if (bodyStart > -1) {
                    bodyText = sourceStr.slice(bodyStart + 4, bodyStart + 4 + 3000).trim();
                  }
                }

                results.push({
                  messageId,
                  from: `${fromName} <${fromAddr}>`,
                  subject,
                  date,
                  body: bodyText.slice(0, 2000),
                });
              }
            }
          }
        } finally {
          lock.release();
        }
      } catch (err) {
        // Folder may not exist — skip
        if (!err.message.includes('not found') && !err.message.includes('Mailbox doesn')) {
          console.warn(`[CHAIN-CONTEXT] Error searching ${folder}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error('[CHAIN-CONTEXT] IMAP connection error:', err.message);
  } finally {
    try { await client.logout(); } catch {}
  }

  // Sort oldest-first
  results.sort((a, b) => new Date(a.date) - new Date(b.date));
  return results;
}

/**
 * Build a context block from chain emails for injection into Claude prompt.
 * @param {object[]} chainEmails - Array from fetchChainEmails
 * @returns {string} Formatted context string
 */
function buildChainContext(chainEmails) {
  if (!chainEmails || chainEmails.length === 0) return '';

  const lines = ['[Previous conversation history]', ''];

  for (const email of chainEmails) {
    lines.push(`--- Email from ${email.from} (${email.date}) ---`);
    lines.push(`Subject: ${email.subject}`);
    lines.push('');
    lines.push(email.body || '(no body)');
    lines.push('');
  }

  lines.push('[End of conversation history]');
  return lines.join('\n');
}

module.exports = {
  extractChainIds,
  fetchChainEmails,
  buildChainContext,
};
