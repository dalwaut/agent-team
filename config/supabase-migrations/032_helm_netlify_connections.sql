-- 032 — HELM Netlify Connections
-- Stores per-business GitHub repo config for Git-based Netlify content publishing

CREATE TABLE IF NOT EXISTS helm_netlify_connections (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid        NOT NULL REFERENCES helm_businesses(id) ON DELETE CASCADE,
  site_name       text        NOT NULL DEFAULT 'Netlify Site',
  github_repo     text        NOT NULL,          -- 'owner/repo' format
  github_branch   text        NOT NULL DEFAULT 'main',
  github_token    text        NOT NULL,           -- PAT with repo write scope
  content_path    text        NOT NULL DEFAULT 'content/posts',
  netlify_site_id text,                           -- optional, for deploy status
  is_active       boolean     DEFAULT true,
  last_tested_at  timestamptz,
  last_test_ok    boolean,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

ALTER TABLE helm_netlify_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "helm_netlify_connections_access" ON helm_netlify_connections
  USING (helm_has_access(business_id));

COMMENT ON TABLE helm_netlify_connections IS
  'GitHub repo connections for HELM Git-based Netlify content publishing';
