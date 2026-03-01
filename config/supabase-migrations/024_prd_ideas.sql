-- 024_prd_ideas.sql
-- PRD Pipeline: idea storage, evaluation results, and generated PRDs
-- Replaces the flat tools/opai-prd/data/ideas.json file

CREATE TABLE IF NOT EXISTS prd_ideas (
  id TEXT PRIMARY KEY DEFAULT 'idea-' || substring(replace(gen_random_uuid()::text, '-', ''), 1, 8),

  -- Core fields (shared between admin/mobile/csv sources)
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  target_market   TEXT NOT NULL DEFAULT '',
  notes           TEXT NOT NULL DEFAULT '',
  source          TEXT NOT NULL DEFAULT 'manual',  -- manual | csv | mobile | json | sheets

  -- Lifecycle status
  status TEXT NOT NULL DEFAULT 'pending',
  -- pending → evaluated (good) or reviewed (not_ready/poor) → approved | rejected → moved

  -- Mobile-origin rich fields (null for admin/CSV submitted ideas)
  pain_point      TEXT,
  solution        TEXT,

  -- Evaluation output (JSONB — PRDgent scores, verdict, analysis)
  evaluation JSONB,

  -- Full PRD markdown (auto-generated on good verdict via second agent pass)
  full_prd TEXT,

  -- Attribution
  submitted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Timestamps
  submitted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  evaluated_at  TIMESTAMPTZ,
  project_path  TEXT,
  moved_at      TIMESTAMPTZ
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS prd_ideas_status_idx       ON prd_ideas(status);
CREATE INDEX IF NOT EXISTS prd_ideas_submitted_by_idx ON prd_ideas(submitted_by);
CREATE INDEX IF NOT EXISTS prd_ideas_submitted_at_idx ON prd_ideas(submitted_at DESC);

-- ── Row Level Security ──────────────────────────────────────────────────────
ALTER TABLE prd_ideas ENABLE ROW LEVEL SECURITY;

-- Admins have full access to all ideas
CREATE POLICY "prd_ideas_admin_all" ON prd_ideas
  FOR ALL
  USING (get_my_role() = 'admin')
  WITH CHECK (get_my_role() = 'admin');

-- Any authenticated user can submit their own idea
CREATE POLICY "prd_ideas_user_insert" ON prd_ideas
  FOR INSERT
  WITH CHECK (auth.uid() = submitted_by);

-- Users can view their own submissions (see status, evaluation results)
CREATE POLICY "prd_ideas_user_select_own" ON prd_ideas
  FOR SELECT
  USING (auth.uid() = submitted_by);
