-- 019: WP Automation — schedules, execution logs, backups
-- Depends on: 018_create_wp_sites_table.sql

-- ── Add connector fields to wp_sites ─────────────────────
ALTER TABLE public.wp_sites
  ADD COLUMN IF NOT EXISTS connector_secret TEXT,
  ADD COLUMN IF NOT EXISTS connector_installed BOOLEAN DEFAULT false;

-- ── wp_schedules ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wp_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES public.wp_sites(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  task_type TEXT NOT NULL CHECK (task_type IN (
    'update_all', 'update_plugins', 'update_themes', 'update_core',
    'backup', 'health_check'
  )),
  task_config JSONB DEFAULT '{}'::jsonb,
  cron_expression TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Chicago',
  enabled BOOLEAN NOT NULL DEFAULT true,
  auto_rollback BOOLEAN NOT NULL DEFAULT true,
  pre_backup BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wp_schedules_site ON public.wp_schedules(site_id);
CREATE INDEX IF NOT EXISTS idx_wp_schedules_next_run ON public.wp_schedules(next_run_at) WHERE enabled = true;

-- ── wp_execution_logs ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wp_execution_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id UUID REFERENCES public.wp_schedules(id) ON DELETE SET NULL,
  site_id UUID NOT NULL REFERENCES public.wp_sites(id) ON DELETE CASCADE,
  task_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN (
    'running', 'success', 'failed', 'rolled_back'
  )),
  trigger TEXT NOT NULL DEFAULT 'schedule' CHECK (trigger IN ('schedule', 'manual')),
  steps JSONB DEFAULT '[]'::jsonb,
  rollback_backup_id UUID,
  started_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wp_exec_logs_site ON public.wp_execution_logs(site_id);
CREATE INDEX IF NOT EXISTS idx_wp_exec_logs_schedule ON public.wp_execution_logs(schedule_id);

-- ── wp_backups ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wp_backups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES public.wp_sites(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN (
    'manual', 'pre_update', 'scheduled'
  )),
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN (
    'in_progress', 'completed', 'failed', 'restoring', 'restored'
  )),
  backup_type TEXT NOT NULL DEFAULT 'full' CHECK (backup_type IN (
    'full', 'database', 'files'
  )),
  size_bytes BIGINT,
  storage_path TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wp_backups_site ON public.wp_backups(site_id);

-- ── RLS ──────────────────────────────────────────────────
ALTER TABLE public.wp_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wp_execution_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wp_backups ENABLE ROW LEVEL SECURITY;

-- Schedules: users see own, admins see all
CREATE POLICY wp_schedules_select ON public.wp_schedules FOR SELECT
  USING (user_id = auth.uid() OR EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'
  ));
CREATE POLICY wp_schedules_insert ON public.wp_schedules FOR INSERT
  WITH CHECK (user_id = auth.uid());
CREATE POLICY wp_schedules_update ON public.wp_schedules FOR UPDATE
  USING (user_id = auth.uid() OR EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'
  ));
CREATE POLICY wp_schedules_delete ON public.wp_schedules FOR DELETE
  USING (user_id = auth.uid() OR EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'
  ));

-- Execution logs: same pattern
CREATE POLICY wp_exec_logs_select ON public.wp_execution_logs FOR SELECT
  USING (site_id IN (
    SELECT id FROM public.wp_sites WHERE user_id = auth.uid()
  ) OR EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'
  ));

-- Backups: same pattern
CREATE POLICY wp_backups_select ON public.wp_backups FOR SELECT
  USING (user_id = auth.uid() OR EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'
  ));
CREATE POLICY wp_backups_insert ON public.wp_backups FOR INSERT
  WITH CHECK (user_id = auth.uid());
CREATE POLICY wp_backups_update ON public.wp_backups FOR UPDATE
  USING (user_id = auth.uid() OR EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'
  ));

-- Service role bypass for all three tables
CREATE POLICY wp_schedules_service ON public.wp_schedules FOR ALL
  USING (auth.role() = 'service_role');
CREATE POLICY wp_exec_logs_service ON public.wp_execution_logs FOR ALL
  USING (auth.role() = 'service_role');
CREATE POLICY wp_backups_service ON public.wp_backups FOR ALL
  USING (auth.role() = 'service_role');
