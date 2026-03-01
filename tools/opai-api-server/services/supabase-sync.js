const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Create Supabase client with service role key for admin access
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/**
 * Sync tasks from queue.json to Supabase
 * @param {Array} tasks - Array of task objects
 * @returns {Object} Sync result with count and errors
 */
async function syncTasks(tasks) {
  try {
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return { synced: 0, error: null };
    }

    const { data, error } = await supabase
      .from('opai_tasks')
      .upsert(tasks, { onConflict: 'id' });

    if (error) {
      console.error('[Supabase Sync] Task sync error:', error);
      return { synced: 0, error };
    }

    console.log(`[Supabase Sync] Synced ${tasks.length} tasks`);
    return { synced: tasks.length, error: null };
  } catch (err) {
    console.error('[Supabase Sync] Task sync exception:', err);
    return { synced: 0, error: err };
  }
}

/**
 * Sync agents from team.json to Supabase
 * @param {Array} agents - Array of agent objects
 * @returns {Object} Sync result
 */
async function syncAgents(agents) {
  try {
    if (!Array.isArray(agents) || agents.length === 0) {
      return { synced: 0, error: null };
    }

    const { data, error } = await supabase
      .from('opai_agents')
      .upsert(agents, { onConflict: 'id' });

    if (error) {
      console.error('[Supabase Sync] Agent sync error:', error);
      return { synced: 0, error };
    }

    console.log(`[Supabase Sync] Synced ${agents.length} agents`);
    return { synced: agents.length, error: null };
  } catch (err) {
    console.error('[Supabase Sync] Agent sync exception:', err);
    return { synced: 0, error: err };
  }
}

/**
 * Sync email tasks to Supabase
 * @param {Array} emailTasks - Array of email task objects
 * @returns {Object} Sync result
 */
async function syncEmailTasks(emailTasks) {
  try {
    if (!Array.isArray(emailTasks) || emailTasks.length === 0) {
      return { synced: 0, error: null };
    }

    const { data, error } = await supabase
      .from('opai_email_tasks')
      .upsert(emailTasks, { onConflict: 'id' });

    if (error) {
      console.error('[Supabase Sync] Email tasks sync error:', error);
      return { synced: 0, error };
    }

    console.log(`[Supabase Sync] Synced ${emailTasks.length} email tasks`);
    return { synced: emailTasks.length, error: null };
  } catch (err) {
    console.error('[Supabase Sync] Email tasks sync exception:', err);
    return { synced: 0, error: err };
  }
}

/**
 * Sync email drafts to Supabase
 * @param {Array} drafts - Array of email draft objects
 * @returns {Object} Sync result
 */
async function syncEmailDrafts(drafts) {
  try {
    if (!Array.isArray(drafts) || drafts.length === 0) {
      return { synced: 0, error: null };
    }

    const { data, error } = await supabase
      .from('opai_email_drafts')
      .upsert(drafts, { onConflict: 'id' });

    if (error) {
      console.error('[Supabase Sync] Email drafts sync error:', error);
      return { synced: 0, error };
    }

    console.log(`[Supabase Sync] Synced ${drafts.length} email drafts`);
    return { synced: drafts.length, error: null };
  } catch (err) {
    console.error('[Supabase Sync] Email drafts sync exception:', err);
    return { synced: 0, error: err };
  }
}

/**
 * Sync chat messages to Supabase
 * @param {Array} messages - Array of chat message objects
 * @returns {Object} Sync result
 */
async function syncChatMessages(messages) {
  try {
    if (!Array.isArray(messages) || messages.length === 0) {
      return { synced: 0, error: null };
    }

    // Transform messages to match DB schema
    const formattedMessages = messages.map(msg => ({
      channel_id: msg.channelId || 'default',
      role: msg.role,
      username: msg.username,
      content: msg.content,
      timestamp: msg.timestamp,
    }));

    const { data, error } = await supabase
      .from('opai_chat_messages')
      .insert(formattedMessages);

    if (error) {
      console.error('[Supabase Sync] Chat messages sync error:', error);
      return { synced: 0, error };
    }

    console.log(`[Supabase Sync] Synced ${messages.length} chat messages`);
    return { synced: messages.length, error: null };
  } catch (err) {
    console.error('[Supabase Sync] Chat messages sync exception:', err);
    return { synced: 0, error: err };
  }
}

/**
 * Sync system health data to Supabase
 * @param {Object} healthData - System health object
 * @returns {Object} Sync result
 */
async function syncSystemHealth(healthData) {
  try {
    if (!healthData) {
      return { synced: 0, error: null };
    }

    // Transform orchestrator state to health records
    const healthRecords = [];

    if (healthData.serviceHealth) {
      for (const [serviceName, serviceData] of Object.entries(healthData.serviceHealth)) {
        healthRecords.push({
          service_name: serviceName,
          status: serviceData.active ? 'active' : 'inactive',
          cpu_percent: healthData.lastResourceCheck?.cpu || null,
          memory_percent: healthData.lastResourceCheck?.memory || null,
          active_jobs: healthData.activeJobs || {},
          last_check: new Date(serviceData.timestamp).toISOString(),
        });
      }
    }

    if (healthRecords.length === 0) {
      return { synced: 0, error: null };
    }

    const { data, error } = await supabase
      .from('opai_system_health')
      .insert(healthRecords);

    if (error) {
      console.error('[Supabase Sync] System health sync error:', error);
      return { synced: 0, error };
    }

    console.log(`[Supabase Sync] Synced ${healthRecords.length} system health records`);
    return { synced: healthRecords.length, error: null };
  } catch (err) {
    console.error('[Supabase Sync] System health sync exception:', err);
    return { synced: 0, error: err };
  }
}

module.exports = {
  supabase,
  syncTasks,
  syncAgents,
  syncEmailTasks,
  syncEmailDrafts,
  syncChatMessages,
  syncSystemHealth,
};
