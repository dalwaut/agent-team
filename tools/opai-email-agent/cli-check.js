#!/usr/bin/env node
/**
 * CLI Email Checker — Check emails from any configured account on demand.
 *
 * Usage:
 *   node cli-check.js                           # Check all enabled accounts (today)
 *   node cli-check.js --account paradise         # Check specific account
 *   node cli-check.js --days 3                   # Look back 3 days
 *   node cli-check.js --all                      # All unseen (no date filter)
 *   node cli-check.js --search "denise"          # Search sender/subject
 *   node cli-check.js --read <uid>               # Read full email body by UID
 *   node cli-check.js --account paradise --read 5 # Read specific email
 *
 * Account matching: matches on id, name (partial), or email (partial), case-insensitive.
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const fs = require('fs');
const path = require('path');
const { ImapFlow } = require('imapflow');

const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function resolveCredentials(account) {
  if (account.imap?.pass) {
    return {
      host: account.imap.host || 'imap.gmail.com',
      port: account.imap.port || 993,
      user: account.imap.user || account.email,
      pass: account.imap.pass,
    };
  }
  const prefix = account.envPrefix || 'AGENT';
  return {
    host: process.env[`${prefix}_IMAP_HOST`] || 'imap.gmail.com',
    port: parseInt(process.env[`${prefix}_IMAP_PORT`] || '993', 10),
    user: process.env[`${prefix}_IMAP_USER`] || '',
    pass: process.env[`${prefix}_IMAP_PASS`] || '',
  };
}

function findAccount(config, query) {
  if (!query) return null;
  const q = query.toLowerCase();
  return config.accounts.find(a =>
    a.id.toLowerCase() === q ||
    a.id.toLowerCase().includes(q) ||
    (a.name || '').toLowerCase().includes(q) ||
    (a.email || '').toLowerCase().includes(q)
  );
}

function extractTextFromSource(source) {
  const raw = source.toString('utf8');
  const boundaryMatch = raw.match(/boundary="?([^"\r\n]+)"?/i);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = raw.split('--' + boundary);
    for (const part of parts) {
      if (part.includes('text/plain')) {
        const bodyStart = part.indexOf('\r\n\r\n');
        if (bodyStart > -1) {
          let text = part.slice(bodyStart + 4);
          const endIdx = text.indexOf('--' + boundary);
          if (endIdx > -1) text = text.slice(0, endIdx);
          if (part.toLowerCase().includes('quoted-printable')) {
            text = text.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
          }
          if (part.toLowerCase().includes('base64')) {
            try { text = Buffer.from(text.trim(), 'base64').toString('utf8'); } catch {}
          }
          return text.trim();
        }
      }
    }
  }
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd > -1) return raw.slice(headerEnd + 4).trim().slice(0, 10000);
  return raw.slice(0, 5000);
}

async function checkAccount(account, options = {}) {
  const creds = resolveCredentials(account);
  if (!creds.user || !creds.pass) {
    console.log(`  [SKIP] ${account.name} — no credentials`);
    return [];
  }

  const client = new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: true,
    auth: { user: creds.user, pass: creds.pass },
    logger: false,
  });

  const emails = [];

  try {
    await client.connect();
    const folders = account.imapFolders || ['INBOX'];

    for (const folder of folders) {
      const lock = await client.getMailboxLock(folder);
      try {
        const status = await client.status(folder, { messages: true, unseen: true });
        console.log(`  ${folder}: ${status.messages} total, ${status.unseen} unseen`);

        // Read a specific email by UID
        if (options.readUid) {
          const uid = parseInt(options.readUid, 10);
          const msgs = client.fetch([uid], { envelope: true, source: true, uid: true }, { uid: true });
          for await (const msg of msgs) {
            const body = msg.source ? extractTextFromSource(msg.source) : '(no body)';
            const from = msg.envelope?.from?.[0];
            console.log('\n--- EMAIL ---');
            console.log(`From:    ${from?.name || ''} <${from?.address || 'unknown'}>`);
            console.log(`To:      ${msg.envelope?.to?.map(t => t.address).join(', ') || ''}`);
            console.log(`Date:    ${msg.envelope?.date?.toISOString() || 'unknown'}`);
            console.log(`Subject: ${msg.envelope?.subject || '(no subject)'}`);
            console.log(`UID:     ${msg.uid}`);
            console.log(`ID:      ${msg.envelope?.messageId || ''}`);
            console.log('---');
            console.log(body);
            console.log('--- END ---\n');
          }
          lock.release();
          continue;
        }

        // Build search criteria
        const searchCriteria = { seen: false };
        if (!options.fetchAll) {
          const since = new Date();
          since.setDate(since.getDate() - (options.days || 1) + 1);
          since.setHours(0, 0, 0, 0);
          searchCriteria.since = since;
        }

        const messages = client.fetch(
          searchCriteria,
          { envelope: true, uid: true }
        );

        for await (const msg of messages) {
          const from = msg.envelope?.from?.[0];
          const fromStr = from ? `${from.name || ''} <${from.address}>`.trim() : 'unknown';
          const subject = msg.envelope?.subject || '(no subject)';
          const date = msg.envelope?.date;

          // Apply search filter if specified
          if (options.search) {
            const term = options.search.toLowerCase();
            const match = fromStr.toLowerCase().includes(term) ||
                          subject.toLowerCase().includes(term);
            if (!match) continue;
          }

          emails.push({
            uid: msg.uid,
            messageId: msg.envelope?.messageId || '',
            from: fromStr,
            fromAddress: from?.address || '',
            subject,
            date: date?.toISOString() || '',
          });
        }
      } finally {
        lock.release();
      }
    }

    await client.logout();
  } catch (err) {
    console.error(`  ERROR: ${err.message}`);
    try { await client.logout(); } catch {}
  }

  return emails;
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--account': case '-a': options.account = args[++i]; break;
      case '--days': case '-d': options.days = parseInt(args[++i], 10); break;
      case '--all': options.fetchAll = true; break;
      case '--search': case '-s': options.search = args[++i]; break;
      case '--read': case '-r': options.readUid = args[++i]; break;
      case '--help': case '-h':
        console.log('Usage: node cli-check.js [--account <name>] [--days <n>] [--all] [--search <term>] [--read <uid>]');
        process.exit(0);
    }
  }

  const config = loadConfig();

  // Resolve target accounts
  let accounts;
  if (options.account) {
    const found = findAccount(config, options.account);
    if (!found) {
      console.error(`Account not found: "${options.account}"`);
      console.log('Available accounts:');
      config.accounts.forEach(a => console.log(`  ${a.id} — ${a.name} (${a.email})`));
      process.exit(1);
    }
    accounts = [found];
  } else {
    // All accounts with credentials
    accounts = config.accounts.filter(a => {
      if (a.needsSetup) return false;
      if (a.imap?.pass) return true;
      const prefix = a.envPrefix || 'AGENT';
      return !!process.env[`${prefix}_IMAP_PASS`];
    });
  }

  const dateRange = options.fetchAll ? 'all unseen' : `last ${options.days || 1} day(s)`;
  console.log(`\nChecking ${accounts.length} account(s) — ${dateRange}${options.search ? ` — search: "${options.search}"` : ''}\n`);

  for (const account of accounts) {
    console.log(`=== ${account.name} (${account.email}) ===`);
    const emails = await checkAccount(account, options);

    if (options.readUid) continue; // already printed inline

    if (emails.length === 0) {
      console.log('  (no matching emails)\n');
      continue;
    }

    // Sort by date descending
    emails.sort((a, b) => new Date(b.date) - new Date(a.date));

    for (const e of emails) {
      const d = e.date ? new Date(e.date).toLocaleString() : 'unknown';
      console.log(`  [UID:${e.uid}] ${d}`);
      console.log(`    From:    ${e.from}`);
      console.log(`    Subject: ${e.subject}`);
    }
    console.log(`  --- ${emails.length} email(s) ---\n`);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
