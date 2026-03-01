-- 034_dam_bot.sql — DAM Bot (Do Anything Mode) tables
-- 9 tables, dam_ prefix, RLS via dam_has_access()

-- ── Helper function ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION dam_has_access(p_session_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM dam_sessions
    WHERE id = p_session_id
      AND user_id = auth.uid()
  )
  OR get_my_role() = 'admin';
$$;

-- ── 1. dam_sessions ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dam_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) DEFAULT auth.uid(),
  title       text NOT NULL,
  goal        text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','planning','executing','paused','completed','failed','cancelled')),
  autonomy_level int NOT NULL DEFAULT 7 CHECK (autonomy_level BETWEEN 1 AND 10),
  context     jsonb NOT NULL DEFAULT '{}',
  source      text DEFAULT 'portal',
  source_ref  text,
  tags        text[] DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE dam_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dam_sessions_select" ON dam_sessions FOR SELECT
  USING (user_id = auth.uid() OR get_my_role() = 'admin');
CREATE POLICY "dam_sessions_insert" ON dam_sessions FOR INSERT
  WITH CHECK (user_id = auth.uid() OR get_my_role() = 'admin');
CREATE POLICY "dam_sessions_update" ON dam_sessions FOR UPDATE
  USING (user_id = auth.uid() OR get_my_role() = 'admin');
CREATE POLICY "dam_sessions_delete" ON dam_sessions FOR DELETE
  USING (user_id = auth.uid() OR get_my_role() = 'admin');

-- ── 2. dam_plans ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dam_plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES dam_sessions(id) ON DELETE CASCADE,
  version     int NOT NULL DEFAULT 1,
  is_active   boolean NOT NULL DEFAULT true,
  plan_tree   jsonb NOT NULL DEFAULT '[]',
  summary     text DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE dam_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dam_plans_select" ON dam_plans FOR SELECT
  USING (dam_has_access(session_id));
CREATE POLICY "dam_plans_insert" ON dam_plans FOR INSERT
  WITH CHECK (dam_has_access(session_id));
CREATE POLICY "dam_plans_update" ON dam_plans FOR UPDATE
  USING (dam_has_access(session_id));

-- ── 3. dam_steps ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dam_steps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id     uuid NOT NULL REFERENCES dam_plans(id) ON DELETE CASCADE,
  session_id  uuid NOT NULL REFERENCES dam_sessions(id) ON DELETE CASCADE,
  parent_id   uuid REFERENCES dam_steps(id),
  ordinal     int NOT NULL DEFAULT 0,
  title       text NOT NULL,
  description text DEFAULT '',
  step_type   text NOT NULL DEFAULT 'agent_run'
                CHECK (step_type IN ('agent_run','squad_run','tool_call','approval_gate','hook','skill_call')),
  status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','running','completed','failed','skipped','blocked','awaiting_approval')),
  config      jsonb NOT NULL DEFAULT '{}',
  result      jsonb,
  depends_on  uuid[] DEFAULT '{}',
  approval_required boolean NOT NULL DEFAULT false,
  started_at  timestamptz,
  completed_at timestamptz,
  duration_ms int,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE dam_steps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dam_steps_select" ON dam_steps FOR SELECT
  USING (dam_has_access(session_id));
CREATE POLICY "dam_steps_insert" ON dam_steps FOR INSERT
  WITH CHECK (dam_has_access(session_id));
CREATE POLICY "dam_steps_update" ON dam_steps FOR UPDATE
  USING (dam_has_access(session_id));

CREATE INDEX idx_dam_steps_plan ON dam_steps(plan_id);
CREATE INDEX idx_dam_steps_session ON dam_steps(session_id);
CREATE INDEX idx_dam_steps_status ON dam_steps(status);

-- ── 4. dam_approvals ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dam_approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES dam_sessions(id) ON DELETE CASCADE,
  step_id       uuid REFERENCES dam_steps(id) ON DELETE SET NULL,
  approval_type text NOT NULL DEFAULT 'confirm'
                  CHECK (approval_type IN ('confirm','ceo_gate','block')),
  risk_level    text NOT NULL DEFAULT 'medium'
                  CHECK (risk_level IN ('low','medium','high','critical')),
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','expired')),
  title         text NOT NULL,
  description   text DEFAULT '',
  payload       jsonb NOT NULL DEFAULT '{}',
  decided_by    uuid REFERENCES auth.users(id),
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE dam_approvals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dam_approvals_select" ON dam_approvals FOR SELECT
  USING (dam_has_access(session_id));
CREATE POLICY "dam_approvals_insert" ON dam_approvals FOR INSERT
  WITH CHECK (dam_has_access(session_id));
CREATE POLICY "dam_approvals_update" ON dam_approvals FOR UPDATE
  USING (dam_has_access(session_id));

CREATE INDEX idx_dam_approvals_session ON dam_approvals(session_id);
CREATE INDEX idx_dam_approvals_status ON dam_approvals(status) WHERE status = 'pending';

-- ── 5. dam_skills ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dam_skills (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL UNIQUE,
  description  text DEFAULT '',
  skill_type   text NOT NULL DEFAULT 'prompt'
                 CHECK (skill_type IN ('prompt','script','workflow','tool_config')),
  definition   jsonb NOT NULL DEFAULT '{}',
  tags         text[] DEFAULT '{}',
  usage_count  int NOT NULL DEFAULT 0,
  success_rate float DEFAULT 0,
  is_verified  boolean NOT NULL DEFAULT false,
  created_by   uuid REFERENCES auth.users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE dam_skills ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dam_skills_select" ON dam_skills FOR SELECT
  USING (true);
CREATE POLICY "dam_skills_insert" ON dam_skills FOR INSERT
  WITH CHECK (get_my_role() = 'admin');
CREATE POLICY "dam_skills_update" ON dam_skills FOR UPDATE
  USING (get_my_role() = 'admin');

-- ── 6. dam_skill_runs ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS dam_skill_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id    uuid NOT NULL REFERENCES dam_skills(id) ON DELETE CASCADE,
  session_id  uuid REFERENCES dam_sessions(id) ON DELETE SET NULL,
  step_id     uuid REFERENCES dam_steps(id) ON DELETE SET NULL,
  status      text NOT NULL DEFAULT 'running'
                CHECK (status IN ('running','completed','failed')),
  duration_ms int,
  result      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE dam_skill_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dam_skill_runs_select" ON dam_skill_runs FOR SELECT
  USING (session_id IS NULL OR dam_has_access(session_id));
CREATE POLICY "dam_skill_runs_insert" ON dam_skill_runs FOR INSERT
  WITH CHECK (true);

-- ── 7. dam_hooks ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dam_hooks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL UNIQUE,
  description     text DEFAULT '',
  hook_point      text NOT NULL
                    CHECK (hook_point IN ('before_step','after_step','before_plan','after_plan','on_error','on_approval')),
  handler_type    text NOT NULL DEFAULT 'python_func'
                    CHECK (handler_type IN ('python_func','skill','agent_run','webhook')),
  handler_config  jsonb NOT NULL DEFAULT '{}',
  priority        int NOT NULL DEFAULT 100,
  conditions      jsonb DEFAULT '{}',
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE dam_hooks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dam_hooks_select" ON dam_hooks FOR SELECT
  USING (true);
CREATE POLICY "dam_hooks_insert" ON dam_hooks FOR INSERT
  WITH CHECK (get_my_role() = 'admin');
CREATE POLICY "dam_hooks_update" ON dam_hooks FOR UPDATE
  USING (get_my_role() = 'admin');

-- ── 8. dam_session_logs ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS dam_session_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES dam_sessions(id) ON DELETE CASCADE,
  step_id     uuid REFERENCES dam_steps(id) ON DELETE SET NULL,
  level       text NOT NULL DEFAULT 'info'
                CHECK (level IN ('debug','info','warn','error')),
  message     text NOT NULL,
  data        jsonb DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE dam_session_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dam_session_logs_select" ON dam_session_logs FOR SELECT
  USING (dam_has_access(session_id));
CREATE POLICY "dam_session_logs_insert" ON dam_session_logs FOR INSERT
  WITH CHECK (true);

CREATE INDEX idx_dam_session_logs_session ON dam_session_logs(session_id);
CREATE INDEX idx_dam_session_logs_created ON dam_session_logs(created_at DESC);

-- ── 9. dam_improvement_requests ─────────────────────────────
CREATE TABLE IF NOT EXISTS dam_improvement_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id            uuid REFERENCES dam_sessions(id) ON DELETE SET NULL,
  step_id               uuid REFERENCES dam_steps(id) ON DELETE SET NULL,
  trigger_type          text NOT NULL DEFAULT 'failure'
                          CHECK (trigger_type IN ('failure','gap','repeated_error','manual')),
  title                 text NOT NULL,
  description           text DEFAULT '',
  research_result       jsonb,
  proposed_skill        jsonb,
  implementation_status text NOT NULL DEFAULT 'pending'
                          CHECK (implementation_status IN ('pending','researching','building','testing','review','approved','rejected','archived')),
  reviewed_by           uuid REFERENCES auth.users(id),
  review_notes          text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE dam_improvement_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dam_improvements_select" ON dam_improvement_requests FOR SELECT
  USING (get_my_role() = 'admin');
CREATE POLICY "dam_improvements_insert" ON dam_improvement_requests FOR INSERT
  WITH CHECK (true);
CREATE POLICY "dam_improvements_update" ON dam_improvement_requests FOR UPDATE
  USING (get_my_role() = 'admin');

-- ── Updated_at triggers ─────────────────────────────────────
CREATE OR REPLACE FUNCTION dam_update_timestamp()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_dam_sessions_updated
  BEFORE UPDATE ON dam_sessions
  FOR EACH ROW EXECUTE FUNCTION dam_update_timestamp();

CREATE TRIGGER trg_dam_skills_updated
  BEFORE UPDATE ON dam_skills
  FOR EACH ROW EXECUTE FUNCTION dam_update_timestamp();

CREATE TRIGGER trg_dam_improvements_updated
  BEFORE UPDATE ON dam_improvement_requests
  FOR EACH ROW EXECUTE FUNCTION dam_update_timestamp();
