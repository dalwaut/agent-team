-- 039_clawhub.sql — ClawHub Marketplace tables
-- Cached skill catalog from ClawHub + installation tracking

-- ── Skill catalog cache ──────────────────────────────────
CREATE TABLE IF NOT EXISTS ch_skills (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  remote_id TEXT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  tags TEXT[] DEFAULT '{}',
  author TEXT,
  version TEXT,
  install_count INT DEFAULT 0,
  rating NUMERIC(3,2),
  files JSONB DEFAULT '[]',
  required_vault_keys TEXT[] DEFAULT '{}',
  opai_verified BOOLEAN DEFAULT FALSE,
  claude_compat TEXT NOT NULL DEFAULT 'oc_only' CHECK (claude_compat IN ('full', 'partial', 'oc_only')),
  source_url TEXT,
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Installation tracking ────────────────────────────────
CREATE TABLE IF NOT EXISTS ch_installations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  skill_slug TEXT NOT NULL REFERENCES ch_skills(slug) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('oc_instance', 'claude_code')),
  instance_id UUID,
  installed_by UUID,
  status TEXT DEFAULT 'installed' CHECK (status IN ('installed', 'pending', 'failed', 'removed')),
  installed_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (skill_slug, target_type, instance_id)
);

-- ── Indexes ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_ch_skills_category ON ch_skills(category);
CREATE INDEX IF NOT EXISTS idx_ch_skills_claude_compat ON ch_skills(claude_compat);
CREATE INDEX IF NOT EXISTS idx_ch_installations_skill ON ch_installations(skill_slug);
CREATE INDEX IF NOT EXISTS idx_ch_installations_instance ON ch_installations(instance_id);

-- ── RLS ──────────────────────────────────────────────────
ALTER TABLE ch_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE ch_installations ENABLE ROW LEVEL SECURITY;

-- ch_skills: admin + service_role full access, authenticated can SELECT
CREATE POLICY ch_skills_admin ON ch_skills
  FOR ALL USING (
    COALESCE(get_my_role(), 'viewer') = 'admin'
    OR current_setting('role', true) = 'service_role'
  );

CREATE POLICY ch_skills_read ON ch_skills
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- ch_installations: admin + service_role full access
CREATE POLICY ch_installations_admin ON ch_installations
  FOR ALL USING (
    COALESCE(get_my_role(), 'viewer') = 'admin'
    OR current_setting('role', true) = 'service_role'
  );
