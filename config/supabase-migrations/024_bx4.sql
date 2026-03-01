-- 024_bx4.sql — Bx4 BoutaByte Business Bot schema
-- Run via: ./scripts/supabase-sql.sh < config/supabase-migrations/024_bx4.sql

-- ─── Tenant + Access ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bx4_companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  name text NOT NULL,
  industry text,
  stage text DEFAULT 'established',
  founded_year int,
  headcount int,
  revenue_model text,
  geo_market text,
  logo_url text,
  is_active bool DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bx4_company_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES bx4_companies(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'viewer',
  granted_by uuid REFERENCES auth.users(id),
  granted_at timestamptz DEFAULT now(),
  UNIQUE (company_id, user_id)
);

-- ─── Goals + Onboarding ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bx4_company_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES bx4_companies(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  target_date date,
  parent_goal_id uuid REFERENCES bx4_company_goals(id),
  status text DEFAULT 'active',
  progress_pct int DEFAULT 0,
  is_primary bool DEFAULT false,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bx4_onboarding_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES bx4_companies(id) ON DELETE CASCADE,
  phase text DEFAULT 'foundation',
  question text NOT NULL,
  answer text,
  asked_at timestamptz DEFAULT now(),
  answered_at timestamptz
);

-- ─── Financial ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bx4_financial_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES bx4_companies(id) ON DELETE CASCADE,
  provider text NOT NULL,
  display_name text NOT NULL,
  credentials_ref text,
  last_sync_at timestamptz,
  status text DEFAULT 'active',
  is_enabled bool DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bx4_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES bx4_companies(id) ON DELETE CASCADE,
  account_id uuid REFERENCES bx4_financial_accounts(id) ON DELETE SET NULL,
  date date NOT NULL,
  amount numeric(12,2) NOT NULL,
  description text,
  category text,
  subcategory text,
  source text,
  raw_data jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bx4_pl_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES bx4_companies(id) ON DELETE CASCADE,
  filename text NOT NULL,
  period_start date,
  period_end date,
  parsed_json jsonb,
  upload_by uuid REFERENCES auth.users(id),
  upload_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bx4_financial_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES bx4_companies(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  revenue numeric(12,2) DEFAULT 0,
  expenses numeric(12,2) DEFAULT 0,
  net numeric(12,2) DEFAULT 0,
  cash_on_hand numeric(12,2) DEFAULT 0,
  burn_rate numeric(12,2) DEFAULT 0,
  runway_months numeric(5,1) DEFAULT 0,
  health_score int DEFAULT 0,
  health_grade text DEFAULT 'F',
  metrics_json jsonb DEFAULT '{}',
  generated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bx4_expense_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES bx4_companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  parent_id uuid REFERENCES bx4_expense_categories(id),
  monthly_budget numeric(12,2),
  created_at timestamptz DEFAULT now()
);

-- ─── Recommendations + Action Log ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bx4_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES bx4_companies(id) ON DELETE CASCADE,
  wing text NOT NULL,
  title text NOT NULL,
  summary text,
  reasoning text,
  urgency text DEFAULT 'medium',
  financial_impact text DEFAULT 'neutral',
  estimated_impact numeric(12,2),
  roi_estimate text,
  action_items jsonb DEFAULT '[]',
  status text DEFAULT 'pending',
  team_hub_item_id uuid,
  generated_at timestamptz DEFAULT now(),
  actioned_at timestamptz
);

CREATE TABLE IF NOT EXISTS bx4_action_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES bx4_companies(id) ON DELETE CASCADE,
  actor text NOT NULL,
  action_type text NOT NULL,
  wing text,
  summary text,
  detail_json jsonb DEFAULT '{}',
  credits_consumed int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- ─── Market + Competitors ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bx4_market_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES bx4_companies(id) ON DELETE CASCADE,
  analysis_type text NOT NULL,
  findings_json jsonb DEFAULT '{}',
  sources jsonb DEFAULT '[]',
  generated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bx4_competitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES bx4_companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  website text,
  notes text,
  last_checked_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- ─── Social ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bx4_social_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES bx4_companies(id) ON DELETE CASCADE,
  platform text NOT NULL,
  handle text,
  credentials_ref text,
  last_sync_at timestamptz,
  status text DEFAULT 'connected',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bx4_social_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES bx4_companies(id) ON DELETE CASCADE,
  social_account_id uuid REFERENCES bx4_social_accounts(id) ON DELETE SET NULL,
  platform text NOT NULL,
  period_start date,
  period_end date,
  followers int DEFAULT 0,
  follower_delta int DEFAULT 0,
  reach int DEFAULT 0,
  impressions int DEFAULT 0,
  engagement_rate numeric(5,2) DEFAULT 0,
  posts_count int DEFAULT 0,
  frequency_score int DEFAULT 0,
  frequency_grade text DEFAULT 'F',
  platform_health_score int DEFAULT 0,
  metrics_json jsonb DEFAULT '{}',
  captured_at timestamptz DEFAULT now()
);

-- ─── KPIs + Alerts ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bx4_kpis (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES bx4_companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  wing text,
  formula text,
  target_value numeric,
  current_value numeric,
  unit text DEFAULT '',
  trend text DEFAULT 'flat',
  is_active bool DEFAULT true,
  updated_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bx4_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES bx4_companies(id) ON DELETE CASCADE,
  kpi_id uuid REFERENCES bx4_kpis(id) ON DELETE SET NULL,
  label text NOT NULL,
  condition_expr text,
  threshold_value numeric,
  severity text DEFAULT 'medium',
  fired_at timestamptz,
  resolved_at timestamptz,
  notified_channels jsonb DEFAULT '[]',
  created_at timestamptz DEFAULT now()
);

-- ─── Credits ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bx4_credit_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES bx4_companies(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action text NOT NULL,
  credits_used int DEFAULT 0,
  balance_after int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- Add bx4_credits to profiles if not already there
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'profiles' AND column_name = 'bx4_credits'
  ) THEN
    ALTER TABLE profiles ADD COLUMN bx4_credits int DEFAULT 0;
  END IF;
END $$;

-- ─── Settings ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bx4_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES bx4_companies(id) ON DELETE CASCADE,
  key text NOT NULL,
  value text,
  updated_by uuid REFERENCES auth.users(id),
  updated_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS bx4_settings_company_key_idx
  ON bx4_settings (COALESCE(company_id::text, ''), key);

INSERT INTO bx4_settings (company_id, key, value) VALUES
  (NULL, 'billing_active',            'false'),
  (NULL, 'default_advisor_tone',      'executive'),
  (NULL, 'default_analysis_depth',    'standard'),
  (NULL, 'default_schedule_financial','weekly'),
  (NULL, 'default_schedule_market',   'weekly'),
  (NULL, 'default_schedule_social',   'weekly')
ON CONFLICT DO NOTHING;

-- ─── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS bx4_company_access_user_idx
  ON bx4_company_access(user_id);
CREATE INDEX IF NOT EXISTS bx4_transactions_company_date_idx
  ON bx4_transactions(company_id, date DESC);
CREATE INDEX IF NOT EXISTS bx4_recommendations_company_status_idx
  ON bx4_recommendations(company_id, status);
CREATE INDEX IF NOT EXISTS bx4_action_log_company_idx
  ON bx4_action_log(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bx4_market_analyses_company_idx
  ON bx4_market_analyses(company_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS bx4_social_snapshots_company_idx
  ON bx4_social_snapshots(company_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS bx4_kpis_company_idx
  ON bx4_kpis(company_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS bx4_alerts_company_active_idx
  ON bx4_alerts(company_id, fired_at) WHERE resolved_at IS NULL;

-- ─── RLS Enable ────────────────────────────────────────────────────────────────

ALTER TABLE bx4_companies           ENABLE ROW LEVEL SECURITY;
ALTER TABLE bx4_company_access      ENABLE ROW LEVEL SECURITY;
ALTER TABLE bx4_company_goals       ENABLE ROW LEVEL SECURITY;
ALTER TABLE bx4_onboarding_log      ENABLE ROW LEVEL SECURITY;
ALTER TABLE bx4_financial_accounts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE bx4_transactions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE bx4_pl_documents        ENABLE ROW LEVEL SECURITY;
ALTER TABLE bx4_financial_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE bx4_expense_categories  ENABLE ROW LEVEL SECURITY;
ALTER TABLE bx4_recommendations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE bx4_action_log          ENABLE ROW LEVEL SECURITY;
ALTER TABLE bx4_market_analyses     ENABLE ROW LEVEL SECURITY;
ALTER TABLE bx4_competitors         ENABLE ROW LEVEL SECURITY;
ALTER TABLE bx4_social_accounts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE bx4_social_snapshots    ENABLE ROW LEVEL SECURITY;
ALTER TABLE bx4_kpis                ENABLE ROW LEVEL SECURITY;
ALTER TABLE bx4_alerts              ENABLE ROW LEVEL SECURITY;
ALTER TABLE bx4_credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bx4_settings            ENABLE ROW LEVEL SECURITY;

-- ─── Helper Functions ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION bx4_is_admin()
RETURNS bool LANGUAGE sql SECURITY DEFINER AS $$
  SELECT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin');
$$;

CREATE OR REPLACE FUNCTION bx4_has_access(cid uuid, required_role text DEFAULT 'viewer')
RETURNS bool LANGUAGE sql SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM bx4_company_access
    WHERE company_id = cid
      AND user_id = auth.uid()
      AND (
        required_role = 'viewer'
        OR (required_role = 'manager' AND role IN ('owner', 'manager'))
        OR (required_role = 'owner'   AND role = 'owner')
      )
  );
$$;

CREATE OR REPLACE FUNCTION bx4_get_role(cid uuid)
RETURNS text LANGUAGE sql SECURITY DEFINER AS $$
  SELECT role FROM bx4_company_access
  WHERE company_id = cid AND user_id = auth.uid()
  LIMIT 1;
$$;

-- ─── RLS Policies ──────────────────────────────────────────────────────────────

-- bx4_companies
CREATE POLICY "bx4 companies admin"        ON bx4_companies FOR ALL    TO authenticated USING (bx4_is_admin());
CREATE POLICY "bx4 companies member read"  ON bx4_companies FOR SELECT TO authenticated USING (bx4_has_access(id));
CREATE POLICY "bx4 companies owner update" ON bx4_companies FOR UPDATE TO authenticated USING (bx4_has_access(id, 'owner'));

-- bx4_company_access
CREATE POLICY "bx4 access admin"        ON bx4_company_access FOR ALL    TO authenticated USING (bx4_is_admin());
CREATE POLICY "bx4 access member read"  ON bx4_company_access FOR SELECT TO authenticated USING (user_id = auth.uid() OR bx4_has_access(company_id, 'owner'));
CREATE POLICY "bx4 access owner manage" ON bx4_company_access FOR ALL    TO authenticated USING (bx4_has_access(company_id, 'owner'));

-- bx4_company_goals
CREATE POLICY "bx4 goals admin"  ON bx4_company_goals FOR ALL    TO authenticated USING (bx4_is_admin());
CREATE POLICY "bx4 goals read"   ON bx4_company_goals FOR SELECT TO authenticated USING (bx4_has_access(company_id));
CREATE POLICY "bx4 goals insert" ON bx4_company_goals FOR INSERT TO authenticated WITH CHECK (bx4_has_access(company_id, 'manager'));
CREATE POLICY "bx4 goals update" ON bx4_company_goals FOR UPDATE TO authenticated USING (bx4_has_access(company_id, 'manager'));

-- bx4_onboarding_log
CREATE POLICY "bx4 onboarding admin"  ON bx4_onboarding_log FOR ALL    TO authenticated USING (bx4_is_admin());
CREATE POLICY "bx4 onboarding read"   ON bx4_onboarding_log FOR SELECT TO authenticated USING (bx4_has_access(company_id));
CREATE POLICY "bx4 onboarding insert" ON bx4_onboarding_log FOR INSERT TO authenticated WITH CHECK (bx4_has_access(company_id, 'manager'));
CREATE POLICY "bx4 onboarding update" ON bx4_onboarding_log FOR UPDATE TO authenticated USING (bx4_has_access(company_id, 'manager'));

-- bx4_financial_accounts
CREATE POLICY "bx4 fin_acct admin"  ON bx4_financial_accounts FOR ALL    TO authenticated USING (bx4_is_admin());
CREATE POLICY "bx4 fin_acct read"   ON bx4_financial_accounts FOR SELECT TO authenticated USING (bx4_has_access(company_id));
CREATE POLICY "bx4 fin_acct insert" ON bx4_financial_accounts FOR INSERT TO authenticated WITH CHECK (bx4_has_access(company_id, 'manager'));
CREATE POLICY "bx4 fin_acct update" ON bx4_financial_accounts FOR UPDATE TO authenticated USING (bx4_has_access(company_id, 'manager'));

-- bx4_transactions
CREATE POLICY "bx4 txns admin"  ON bx4_transactions FOR ALL    TO authenticated USING (bx4_is_admin());
CREATE POLICY "bx4 txns read"   ON bx4_transactions FOR SELECT TO authenticated USING (bx4_has_access(company_id));
CREATE POLICY "bx4 txns insert" ON bx4_transactions FOR INSERT TO authenticated WITH CHECK (bx4_has_access(company_id, 'manager'));

-- bx4_pl_documents
CREATE POLICY "bx4 pl admin"  ON bx4_pl_documents FOR ALL    TO authenticated USING (bx4_is_admin());
CREATE POLICY "bx4 pl read"   ON bx4_pl_documents FOR SELECT TO authenticated USING (bx4_has_access(company_id));
CREATE POLICY "bx4 pl insert" ON bx4_pl_documents FOR INSERT TO authenticated WITH CHECK (bx4_has_access(company_id, 'manager'));

-- bx4_financial_snapshots
CREATE POLICY "bx4 snaps admin" ON bx4_financial_snapshots FOR ALL    TO authenticated USING (bx4_is_admin());
CREATE POLICY "bx4 snaps read"  ON bx4_financial_snapshots FOR SELECT TO authenticated USING (bx4_has_access(company_id));

-- bx4_expense_categories
CREATE POLICY "bx4 exp_cat admin"  ON bx4_expense_categories FOR ALL    TO authenticated USING (bx4_is_admin());
CREATE POLICY "bx4 exp_cat read"   ON bx4_expense_categories FOR SELECT TO authenticated USING (bx4_has_access(company_id));
CREATE POLICY "bx4 exp_cat insert" ON bx4_expense_categories FOR INSERT TO authenticated WITH CHECK (bx4_has_access(company_id, 'manager'));

-- bx4_recommendations
CREATE POLICY "bx4 recs admin"  ON bx4_recommendations FOR ALL    TO authenticated USING (bx4_is_admin());
CREATE POLICY "bx4 recs read"   ON bx4_recommendations FOR SELECT TO authenticated USING (bx4_has_access(company_id));
CREATE POLICY "bx4 recs update" ON bx4_recommendations FOR UPDATE TO authenticated USING (bx4_has_access(company_id, 'manager'));

-- bx4_action_log
CREATE POLICY "bx4 log admin" ON bx4_action_log FOR ALL    TO authenticated USING (bx4_is_admin());
CREATE POLICY "bx4 log read"  ON bx4_action_log FOR SELECT TO authenticated USING (bx4_has_access(company_id));

-- bx4_market_analyses
CREATE POLICY "bx4 market admin" ON bx4_market_analyses FOR ALL    TO authenticated USING (bx4_is_admin());
CREATE POLICY "bx4 market read"  ON bx4_market_analyses FOR SELECT TO authenticated USING (bx4_has_access(company_id));

-- bx4_competitors
CREATE POLICY "bx4 comp admin"  ON bx4_competitors FOR ALL    TO authenticated USING (bx4_is_admin());
CREATE POLICY "bx4 comp read"   ON bx4_competitors FOR SELECT TO authenticated USING (bx4_has_access(company_id));
CREATE POLICY "bx4 comp insert" ON bx4_competitors FOR INSERT TO authenticated WITH CHECK (bx4_has_access(company_id, 'manager'));
CREATE POLICY "bx4 comp update" ON bx4_competitors FOR UPDATE TO authenticated USING (bx4_has_access(company_id, 'manager'));

-- bx4_social_accounts
CREATE POLICY "bx4 social_acct admin"  ON bx4_social_accounts FOR ALL    TO authenticated USING (bx4_is_admin());
CREATE POLICY "bx4 social_acct read"   ON bx4_social_accounts FOR SELECT TO authenticated USING (bx4_has_access(company_id));
CREATE POLICY "bx4 social_acct insert" ON bx4_social_accounts FOR INSERT TO authenticated WITH CHECK (bx4_has_access(company_id, 'manager'));

-- bx4_social_snapshots
CREATE POLICY "bx4 social_snap admin" ON bx4_social_snapshots FOR ALL    TO authenticated USING (bx4_is_admin());
CREATE POLICY "bx4 social_snap read"  ON bx4_social_snapshots FOR SELECT TO authenticated USING (bx4_has_access(company_id));

-- bx4_kpis
CREATE POLICY "bx4 kpis admin"  ON bx4_kpis FOR ALL    TO authenticated USING (bx4_is_admin());
CREATE POLICY "bx4 kpis read"   ON bx4_kpis FOR SELECT TO authenticated USING (bx4_has_access(company_id));
CREATE POLICY "bx4 kpis insert" ON bx4_kpis FOR INSERT TO authenticated WITH CHECK (bx4_has_access(company_id, 'manager'));
CREATE POLICY "bx4 kpis update" ON bx4_kpis FOR UPDATE TO authenticated USING (bx4_has_access(company_id, 'manager'));

-- bx4_alerts
CREATE POLICY "bx4 alerts admin" ON bx4_alerts FOR ALL    TO authenticated USING (bx4_is_admin());
CREATE POLICY "bx4 alerts read"  ON bx4_alerts FOR SELECT TO authenticated USING (bx4_has_access(company_id));

-- bx4_credit_transactions
CREATE POLICY "bx4 credits admin" ON bx4_credit_transactions FOR ALL    TO authenticated USING (bx4_is_admin());
CREATE POLICY "bx4 credits own"   ON bx4_credit_transactions FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR bx4_has_access(company_id, 'owner'));

-- bx4_settings
CREATE POLICY "bx4 settings admin"  ON bx4_settings FOR ALL    TO authenticated USING (bx4_is_admin());
CREATE POLICY "bx4 settings read"   ON bx4_settings FOR SELECT TO authenticated
  USING (company_id IS NULL OR bx4_has_access(company_id));
CREATE POLICY "bx4 settings write"  ON bx4_settings FOR ALL    TO authenticated
  USING (bx4_has_access(company_id, 'owner'));
