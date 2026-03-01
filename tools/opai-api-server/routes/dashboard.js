const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase-sync');

/**
 * Get dashboard overview
 * GET /api/dashboard
 */
router.get('/', async (req, res) => {
  try {
    // Fetch aggregated data from Supabase
    const [tasksResult, healthResult, emailTasksResult] = await Promise.all([
      supabase.from('opai_tasks').select('id, status, priority'),
      supabase.from('opai_system_health')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(5),
      supabase.from('opai_email_tasks').select('id, status, priority'),
    ]);

    // Calculate stats
    const tasks = tasksResult.data || [];
    const emailTasks = emailTasksResult.data || [];

    const stats = {
      tasks: {
        total: tasks.length,
        queued: tasks.filter(t => t.status === 'queued').length,
        in_progress: tasks.filter(t => t.status === 'in_progress').length,
        completed: tasks.filter(t => t.status === 'completed').length,
        failed: tasks.filter(t => t.status === 'failed').length,
        blocked: tasks.filter(t => t.status === 'blocked').length,
      },
      emailTasks: {
        total: emailTasks.length,
        pending: emailTasks.filter(t => t.status === 'pending').length,
        completed: emailTasks.filter(t => t.status === 'completed').length,
      },
      systemHealth: healthResult.data || [],
    };

    res.json(stats);
  } catch (error) {
    console.error('[Dashboard] Error fetching dashboard data:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

module.exports = router;
