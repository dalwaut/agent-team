-- 031 — HELM WordPress Connections
-- Stores per-business WP site credentials for autonomous posting

CREATE TABLE IF NOT EXISTS helm_wp_connections (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid        NOT NULL REFERENCES helm_businesses(id) ON DELETE CASCADE,
  site_name       text        NOT NULL DEFAULT 'WordPress Site',
  site_url        text        NOT NULL,
  username        text        NOT NULL,
  app_password    text        NOT NULL,
  default_status  text        NOT NULL DEFAULT 'draft'
                              CHECK (default_status IN ('draft','publish','pending')),
  default_category text,
  is_active       boolean     DEFAULT true,
  last_tested_at  timestamptz,
  last_test_ok    boolean,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

ALTER TABLE helm_wp_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "helm_wp_connections_access" ON helm_wp_connections
  USING (helm_has_access(business_id));

COMMENT ON TABLE helm_wp_connections IS
  'WordPress site connections for HELM autonomous content publishing';
