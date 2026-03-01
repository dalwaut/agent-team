const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const {
  syncTasks,
  syncAgents,
  syncEmailTasks,
  syncEmailDrafts,
  syncChatMessages,
  syncSystemHealth,
} = require('./supabase-sync');

const OPAI_ROOT = process.env.OPAI_ROOT || '/home/dallas/SD/OPAI';

// File paths to watch (all at root level now)
const WATCH_PATHS = {
  tasks: path.join(OPAI_ROOT, 'tasks/queue.json'),
  team: path.join(OPAI_ROOT, 'team.json'),
  emailTasks: path.join(OPAI_ROOT, 'tools/email-checker/data/email-tasks.json'),
  emailDrafts: path.join(OPAI_ROOT, 'tools/email-checker/data/email-responses.json'),
  conversations: path.join(OPAI_ROOT, 'tools/discord-bridge/data/conversations.json'),
  orchestratorState: path.join(OPAI_ROOT, 'tools/opai-orchestrator/data/orchestrator-state.json'),
};

/**
 * Safely read and parse JSON file
 * @param {string} filePath - Path to JSON file
 * @returns {Object|null} Parsed JSON or null if error
 */
function readJSONFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      console.log(`[File Watcher] File not found: ${filePath}`);
      return null;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    console.error(`[File Watcher] Error reading ${filePath}:`, err.message);
    return null;
  }
}

/**
 * Handle task queue file changes
 * @param {string} filePath - Path to file
 */
async function handleTasksChange(filePath) {
  console.log(`[File Watcher] Tasks file changed: ${filePath}`);
  const data = readJSONFile(filePath);

  if (data && data.queue && Array.isArray(data.queue)) {
    await syncTasks(data.queue);
  }
}

/**
 * Handle team.json file changes
 * @param {string} filePath - Path to file
 */
async function handleTeamChange(filePath) {
  console.log(`[File Watcher] Team file changed: ${filePath}`);
  const data = readJSONFile(filePath);

  if (data && data.roles) {
    // Transform roles object to array for DB
    const agents = Object.entries(data.roles).map(([id, agent]) => ({
      id,
      name: agent.name,
      emoji: agent.emoji || null,
      description: agent.description || null,
      category: agent.category || null,
      run_order: agent.run_order || null,
      prompt_file: agent.prompt_file || null,
    }));

    await syncAgents(agents);
  }
}

/**
 * Handle email tasks file changes
 * @param {string} filePath - Path to file
 */
async function handleEmailTasksChange(filePath) {
  console.log(`[File Watcher] Email tasks file changed: ${filePath}`);
  const data = readJSONFile(filePath);

  if (data && data.bySender) {
    // Flatten tasks from bySender structure
    const allTasks = [];

    for (const [senderEmail, senderData] of Object.entries(data.bySender)) {
      if (senderData.tasks && Array.isArray(senderData.tasks)) {
        senderData.tasks.forEach(task => {
          allTasks.push({
            sender_email: senderEmail,
            sender_name: senderData.name || senderEmail,
            task_description: task.task,
            priority: task.priority || 'normal',
            deadline: task.deadline || null,
            context: task.context || null,
            routing: task.routing || null,
            status: task.status || 'pending',
            email_subject: task.emailSubject || null,
            extracted_at: task.extractedAt || new Date().toISOString(),
          });
        });
      }
    }

    if (allTasks.length > 0) {
      await syncEmailTasks(allTasks);
    }
  }
}

/**
 * Handle email drafts file changes
 * @param {string} filePath - Path to file
 */
async function handleEmailDraftsChange(filePath) {
  console.log(`[File Watcher] Email drafts file changed: ${filePath}`);
  const data = readJSONFile(filePath);

  if (data && data.responses) {
    // Transform responses object to array
    const drafts = Object.entries(data.responses).map(([id, draft]) => ({
      id,
      email_message_id: draft.emailMessageId || null,
      account: draft.account,
      to_email: draft.to,
      to_name: draft.toName || null,
      subject: draft.subject,
      initial_draft: draft.initialDraft || null,
      critique: draft.critique || null,
      refined_draft: draft.refinedDraft || null,
      final_content: draft.finalContent || null,
      status: draft.status || 'draft',
      created_at: draft.createdAt,
      approved_at: draft.approvedAt || null,
      sent_at: draft.sentAt || null,
    }));

    if (drafts.length > 0) {
      await syncEmailDrafts(drafts);
    }
  }
}

/**
 * Handle conversations file changes
 * @param {string} filePath - Path to file
 */
async function handleConversationsChange(filePath) {
  console.log(`[File Watcher] Conversations file changed: ${filePath}`);
  const data = readJSONFile(filePath);

  if (data) {
    // Flatten all channel messages
    const allMessages = [];

    for (const [channelId, messages] of Object.entries(data)) {
      if (Array.isArray(messages)) {
        messages.forEach(msg => {
          allMessages.push({
            channelId,
            role: msg.role,
            username: msg.username,
            content: msg.content,
            timestamp: new Date(msg.timestamp).toISOString(),
          });
        });
      }
    }

    // Only sync new messages (implement deduplication if needed)
    if (allMessages.length > 0) {
      await syncChatMessages(allMessages);
    }
  }
}

/**
 * Handle orchestrator state file changes
 * @param {string} filePath - Path to file
 */
async function handleOrchestratorStateChange(filePath) {
  console.log(`[File Watcher] Orchestrator state file changed: ${filePath}`);
  const data = readJSONFile(filePath);

  if (data) {
    await syncSystemHealth(data);
  }
}

/**
 * Initialize file watchers
 * @returns {Object} Watcher instance
 */
function initializeWatchers() {
  console.log('[File Watcher] Initializing file watchers...');

  // Create watcher for all paths
  const watcher = chokidar.watch(Object.values(WATCH_PATHS), {
    persistent: true,
    ignoreInitial: false, // Sync on startup
    awaitWriteFinish: {
      stabilityThreshold: 1000,
      pollInterval: 100,
    },
  });

  // Handle file changes
  watcher.on('change', async (filePath) => {
    try {
      if (filePath === WATCH_PATHS.tasks) {
        await handleTasksChange(filePath);
      } else if (filePath === WATCH_PATHS.team) {
        await handleTeamChange(filePath);
      } else if (filePath === WATCH_PATHS.emailTasks) {
        await handleEmailTasksChange(filePath);
      } else if (filePath === WATCH_PATHS.emailDrafts) {
        await handleEmailDraftsChange(filePath);
      } else if (filePath === WATCH_PATHS.conversations) {
        await handleConversationsChange(filePath);
      } else if (filePath === WATCH_PATHS.orchestratorState) {
        await handleOrchestratorStateChange(filePath);
      }
    } catch (err) {
      console.error(`[File Watcher] Error handling change for ${filePath}:`, err);
    }
  });

  // Handle initial add (sync on startup)
  watcher.on('add', async (filePath) => {
    console.log(`[File Watcher] Initial sync for: ${filePath}`);
    try {
      if (filePath === WATCH_PATHS.tasks) {
        await handleTasksChange(filePath);
      } else if (filePath === WATCH_PATHS.team) {
        await handleTeamChange(filePath);
      } else if (filePath === WATCH_PATHS.emailTasks) {
        await handleEmailTasksChange(filePath);
      } else if (filePath === WATCH_PATHS.emailDrafts) {
        await handleEmailDraftsChange(filePath);
      } else if (filePath === WATCH_PATHS.orchestratorState) {
        await handleOrchestratorStateChange(filePath);
      }
    } catch (err) {
      console.error(`[File Watcher] Error during initial sync for ${filePath}:`, err);
    }
  });

  watcher.on('ready', () => {
    console.log('[File Watcher] Initial scan complete. Watching for changes...');
  });

  watcher.on('error', (error) => {
    console.error('[File Watcher] Watcher error:', error);
  });

  return watcher;
}

module.exports = {
  initializeWatchers,
  WATCH_PATHS,
};
