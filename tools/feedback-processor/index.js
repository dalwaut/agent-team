#!/usr/bin/env node
/**
 * OPAI Feedback Processor
 *
 * Reads feedback-queue.json, classifies each item via Claude CLI,
 * checks against wiki docs for existing functionality, writes per-tool
 * Feedback-{Tool}.md files, and appends to FEEDBACK-IMPROVEMENTS-LOG.md.
 *
 * Usage:
 *   node tools/feedback-processor/index.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── Paths ──────────────────────────────────────────────────
const OPAI_ROOT = process.env.OPAI_ROOT || path.resolve(__dirname, '../..');
const QUEUE_FILE = path.join(OPAI_ROOT, 'notes', 'Improvements', 'feedback-queue.json');
const LOG_FILE = path.join(OPAI_ROOT, 'notes', 'Improvements', 'FEEDBACK-IMPROVEMENTS-LOG.md');
const WIKI_DIR = path.join(OPAI_ROOT, 'Library', 'opai-wiki');
const IMPROVEMENTS_DIR = path.join(OPAI_ROOT, 'notes', 'Improvements');

// ── Tool → wiki file mapping ───────────────────────────────
const TOOL_WIKI_MAP = {
  chat: ['chat.md'],
  monitor: ['monitor.md'],
  tasks: ['task-control-panel.md'],
  terminal: ['terminal.md'],
  claude: ['terminal.md'],
  messenger: ['messenger.md'],
  users: ['user-controls.md'],
  dev: ['dev-ide.md'],
  files: ['opai-files.md'],
  forum: ['forum.md'],
  docs: ['docs.md'],
  agents: ['agent-studio.md'],
  'team-hub': ['team-hub.md'],
};

// ── Stop words for keyword extraction ──────────────────────
const STOP_WORDS = new Set([
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'it', 'its', 'this', 'that',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'can', 'may', 'might', 'shall', 'must', 'need', 'want',
  'wish', 'like', 'just', 'also', 'very', 'really', 'so', 'too',
  'and', 'or', 'but', 'if', 'then', 'than', 'when', 'while', 'for',
  'to', 'from', 'in', 'on', 'at', 'by', 'of', 'with', 'about',
  'not', 'no', 'nor', 'up', 'out', 'off', 'more', 'some', 'any',
  'all', 'each', 'every', 'both', 'few', 'most', 'other', 'such',
  'only', 'own', 'same', 'here', 'there', 'how', 'what', 'which',
  'who', 'where', 'why', 'app', 'page', 'thing', 'stuff', 'make',
]);

// ── Helpers ────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function loadQueue() {
  if (!fs.existsSync(QUEUE_FILE)) return { version: 1, items: [] };
  return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
}

function saveQueue(queue) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf8');
}

function claudeCall(prompt) {
  try {
    const result = execSync(
      `claude -p --output-format json`,
      {
        input: prompt,
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, CLAUDECODE: undefined },
      }
    );
    // Parse JSON response — claude outputs {result: "..."} or similar
    const parsed = JSON.parse(result);
    return parsed.result || parsed.text || result;
  } catch (err) {
    log(`Claude call failed: ${err.message}`);
    return null;
  }
}

function extractKeywords(text) {
  const words = text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));

  // Deduplicate and take top 5
  const unique = [...new Set(words)];
  return unique.slice(0, 5);
}

function grepWikiFile(keyword, wikiFile) {
  const filePath = path.join(WIKI_DIR, wikiFile);
  if (!fs.existsSync(filePath)) return null;

  try {
    const result = execSync(
      `grep -i -C 2 ${JSON.stringify(keyword)} ${JSON.stringify(filePath)}`,
      { encoding: 'utf8', timeout: 5000 }
    );
    return result.trim().slice(0, 500); // cap excerpt length
  } catch {
    return null; // grep returns non-zero when no match
  }
}

// ── Classification ─────────────────────────────────────────

function classifyFeedback(item) {
  const prompt = `You are a feedback classifier. Given the following user feedback about the "${item.tool}" tool, respond with ONLY a valid JSON object (no markdown, no explanation).

Feedback: "${item.user_text}"

Classify into:
- severity: "HIGH" (crash/unusable/data loss/broken core), "MEDIUM" (usable but missing expected functionality), "LOW" (works fine, wants enhancement)
- category: one of "bug-fix", "feature-request", "ux-improvement", "performance", "accessibility", "content", "integration", "documentation"

Response format: {"severity":"...","category":"..."}`;

  const response = claudeCall(prompt);
  if (!response) return null;

  try {
    // Try to extract JSON from response
    const jsonMatch = response.match(/\{[^}]+\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch {}

  return null;
}

// ── Wiki check ─────────────────────────────────────────────

function checkWikiForExisting(item) {
  const wikiFiles = TOOL_WIKI_MAP[item.tool] || [];
  if (wikiFiles.length === 0) return { exists: false, excerpt: null };

  const keywords = extractKeywords(item.user_text);
  if (keywords.length === 0) return { exists: false, excerpt: null };

  // Try each keyword against each wiki file
  let bestExcerpt = null;
  for (const kw of keywords) {
    for (const wf of wikiFiles) {
      const excerpt = grepWikiFile(kw, wf);
      if (excerpt && excerpt.length > 20) {
        bestExcerpt = excerpt;
        break;
      }
    }
    if (bestExcerpt) break;
  }

  if (!bestExcerpt) return { exists: false, excerpt: null };

  // Verify with Claude
  const prompt = `A user submitted this feedback about the "${item.tool}" tool:
"${item.user_text}"

Here is an excerpt from the tool's documentation:
${bestExcerpt}

Does this documentation show that the feature or fix the user is requesting ALREADY EXISTS? Reply with ONLY "yes" or "no".`;

  const response = claudeCall(prompt);
  if (!response) return { exists: false, excerpt: bestExcerpt };

  const answer = response.toLowerCase().trim();
  return {
    exists: answer.startsWith('yes'),
    excerpt: bestExcerpt,
  };
}

// ── Per-tool file management ───────────────────────────────

function getToolFileName(tool) {
  // Capitalize first letter of each word
  const name = tool.replace(/[-_]/g, ' ')
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  return `Feedback-${name}.md`;
}

function writeToToolFile(item) {
  const fileName = getToolFileName(item.tool);
  const filePath = path.join(IMPROVEMENTS_DIR, fileName);

  let content;
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, 'utf8');
  } else {
    const toolLabel = (TOOL_WIKI_MAP[item.tool] ? item.tool : item.tool).toUpperCase();
    content = `# Feedback — ${toolLabel}

User feedback items organized by severity.

## HIGH

## MEDIUM

## LOW

`;
  }

  const severity = item.severity || 'LOW';
  const entry = `- **[${item.category || 'uncategorized'}]** ${item.user_text} _(${item.id}, ${item.timestamp})_`;

  // Find the section and append
  const sectionHeader = `## ${severity}`;
  const sectionIdx = content.indexOf(sectionHeader);
  if (sectionIdx !== -1) {
    const insertPos = sectionIdx + sectionHeader.length;
    content = content.slice(0, insertPos) + '\n' + entry + content.slice(insertPos);
  } else {
    // Section not found — append at end
    content += `\n${sectionHeader}\n${entry}\n`;
  }

  fs.writeFileSync(filePath, content, 'utf8');
  return fileName;
}

function updateExistingEntry(filePath, item) {
  // If the classifier assigned a different severity/category, update the entry in-place
  let content = fs.readFileSync(filePath, 'utf8');
  const oldSeverity = item._originalSeverity || 'MEDIUM';
  const newSeverity = item.severity || 'LOW';
  const newCategory = item.category || 'uncategorized';

  // Find the line with this feedback ID
  const lineRegex = new RegExp(`^- \\*\\*\\[[^\\]]*\\]\\*\\* .+? _\\(${item.id},`, 'm');
  const match = content.match(lineRegex);
  if (!match) return;

  const oldLine = match[0];
  // Build the updated line prefix with new category
  const newLinePrefix = `- **[${newCategory}]** ${item.user_text} _(${item.id},`;

  // Replace the old category in the line
  const fullLineRegex = new RegExp(`^- \\*\\*\\[[^\\]]*\\]\\*\\* .+? _\\(${item.id}, [^)]+\\)_.*$`, 'm');
  const fullMatch = content.match(fullLineRegex);
  if (!fullMatch) return;

  const updatedLine = `- **[${newCategory}]** ${item.user_text} _(${item.id}, ${item.timestamp})_`;

  // If severity changed, move the line to the correct section
  if (oldSeverity !== newSeverity) {
    // Remove from old location
    content = content.replace(fullMatch[0] + '\n', '');
    // Add to new section
    const sectionHeader = `## ${newSeverity}`;
    const sectionIdx = content.indexOf(sectionHeader);
    if (sectionIdx !== -1) {
      const insertPos = sectionIdx + sectionHeader.length;
      content = content.slice(0, insertPos) + '\n' + updatedLine + content.slice(insertPos);
    }
  } else {
    content = content.replace(fullMatch[0], updatedLine);
  }

  fs.writeFileSync(filePath, content, 'utf8');
}

// ── Log append ─────────────────────────────────────────────

function appendLog(item, outcome) {
  const line = `| ${item.timestamp.slice(0, 10)} | ${item.id} | ${item.tool} | ${item.severity || '?'} | ${item.category || '?'} | ${outcome} |\n`;

  // Ensure table header exists
  let content = '';
  if (fs.existsSync(LOG_FILE)) {
    content = fs.readFileSync(LOG_FILE, 'utf8');
  }

  if (!content.includes('| Date ')) {
    content += '| Date | ID | Tool | Severity | Category | Outcome |\n';
    content += '|------|-----|------|----------|----------|---------|\n';
  }

  content += line;
  fs.writeFileSync(LOG_FILE, content, 'utf8');
}

// ── Cleanup ────────────────────────────────────────────────

function cleanupQueue(queue) {
  queue.items = queue.items.filter(
    item => item.status !== 'complete' && item.status !== 'null'
  );
}

// ── Main pipeline ──────────────────────────────────────────

async function main() {
  log('Feedback processor starting');

  const queue = loadQueue();
  const newItems = queue.items.filter(item => item.status === 'new');

  if (newItems.length === 0) {
    log('No new feedback items');
    return;
  }

  log(`Processing ${newItems.length} new item(s)`);

  for (const item of newItems) {
    log(`Processing ${item.id}: "${item.user_text.slice(0, 60)}..."`);

    // Step 1: Classify
    const classification = classifyFeedback(item);
    if (classification) {
      item.severity = classification.severity;
      item.category = classification.category;
      item.status = 'classified';
      log(`  Classified: ${item.severity} / ${item.category}`);
    } else {
      item.severity = 'LOW';
      item.category = 'feature-request';
      item.status = 'classified';
      item.processor_notes = 'Classification failed — defaults applied';
      log('  Classification failed, defaults applied');
    }

    // Step 2: Wiki check
    const wikiResult = checkWikiForExisting(item);
    item.wiki_match = wikiResult.exists ? wikiResult.excerpt : null;

    if (wikiResult.exists) {
      item.status = 'null';
      item.processor_notes = (item.processor_notes || '') + ' Feature already exists in docs.';
      log('  Wiki match: feature already exists — marking null');
      appendLog(item, 'Duplicate (wiki match)');
      saveQueue(queue);
      continue;
    }

    // Step 3: Write to per-tool file (skip if already written by instant-write in portal)
    const toolFile = getToolFileName(item.tool);
    const toolFilePath = path.join(IMPROVEMENTS_DIR, toolFile);
    const alreadyWritten = fs.existsSync(toolFilePath) &&
      fs.readFileSync(toolFilePath, 'utf8').includes(item.id);

    if (alreadyWritten) {
      // Entry was already written by portal instant-write; update severity/category if classifier changed them
      updateExistingEntry(toolFilePath, item);
      log(`  Already in ${toolFile} — updated classification`);
    } else {
      writeToToolFile(item);
      log(`  Written to ${toolFile}`);
    }
    item.files_modified = [toolFile];
    item.status = 'complete';

    // Step 4: Append log
    appendLog(item, 'Filed');

    saveQueue(queue);
  }

  // Step 5: Cleanup
  cleanupQueue(queue);
  saveQueue(queue);

  log('Feedback processor done');
}

main().catch(err => {
  console.error(`Feedback processor error: ${err.message}`);
  process.exit(1);
});
