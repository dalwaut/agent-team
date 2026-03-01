-- Migration: 031_helm_website_builds
-- Adds helm_website_builds table to track the "I need a website" builder flow.
-- RLS mirrors existing HELM access pattern via helm_has_access().

CREATE TABLE IF NOT EXISTS helm_website_builds (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          uuid NOT NULL REFERENCES helm_businesses(id) ON DELETE CASCADE,
  domain               text,
  tld                  text,
  platform             text,           -- 'wordpress', 'nextjs', 'static'
  provider             text,           -- 'hostinger', 'netlify'
  hosting_plan         text,           -- 'starter', 'pro', 'business'
  stripe_session_id    text,
  stripe_payment_status text DEFAULT 'pending',   -- 'pending','paid','failed'
  provision_status     text DEFAULT 'pending',    -- 'pending','provisioning','live','failed'
  provision_data       jsonb DEFAULT '{}',        -- URLs, site IDs, task IDs, etc.
  export_only          boolean DEFAULT false,
  wp_pro_addon         boolean DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Index for business lookups
CREATE INDEX IF NOT EXISTS idx_helm_website_builds_business_id
  ON helm_website_builds (business_id);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_helm_website_builds_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_helm_website_builds_updated_at ON helm_website_builds;
CREATE TRIGGER trg_helm_website_builds_updated_at
  BEFORE UPDATE ON helm_website_builds
  FOR EACH ROW EXECUTE FUNCTION update_helm_website_builds_updated_at();

-- RLS
ALTER TABLE helm_website_builds ENABLE ROW LEVEL SECURITY;

-- Service role has full access
CREATE POLICY "helm_website_builds_service_all"
  ON helm_website_builds FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- Authenticated users can read/write builds for their own businesses
CREATE POLICY "helm_website_builds_user_select"
  ON helm_website_builds FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM helm_businesses hb
      WHERE hb.id = helm_website_builds.business_id
        AND helm_has_access(hb.id)
    )
  );

CREATE POLICY "helm_website_builds_user_insert"
  ON helm_website_builds FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM helm_businesses hb
      WHERE hb.id = business_id
        AND helm_has_access(hb.id)
    )
  );

CREATE POLICY "helm_website_builds_user_update"
  ON helm_website_builds FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM helm_businesses hb
      WHERE hb.id = helm_website_builds.business_id
        AND helm_has_access(hb.id)
    )
  );
