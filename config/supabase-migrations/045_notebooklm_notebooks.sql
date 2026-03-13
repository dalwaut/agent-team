-- NotebookLM notebook registry — maps OPAI concepts to NotebookLM notebooks
-- Used by wiki sync, Brain deliverables, HELM research

CREATE TABLE IF NOT EXISTS notebooklm_notebooks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notebook_id   text NOT NULL UNIQUE,
  title         text NOT NULL,
  purpose       text NOT NULL DEFAULT 'general',    -- system, research, helm, wiki
  owner_type    text NOT NULL DEFAULT 'system',     -- system, business, user
  owner_id      text,
  source_count  int DEFAULT 0,
  last_synced   timestamptz,
  metadata      jsonb DEFAULT '{}',
  created_at    timestamptz DEFAULT now()
);

-- Index for lookups by purpose and owner
CREATE INDEX IF NOT EXISTS idx_nlm_notebooks_purpose ON notebooklm_notebooks (purpose);
CREATE INDEX IF NOT EXISTS idx_nlm_notebooks_owner ON notebooklm_notebooks (owner_type, owner_id);

-- RLS: admin-only access (system tables)
ALTER TABLE notebooklm_notebooks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON notebooklm_notebooks
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Admins can read" ON notebooklm_notebooks
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );
