-- 025_bx4_phase2.sql — Bx4 Phase 2 additions
-- Run via: ./scripts/supabase-sql.sh < config/supabase-migrations/025_bx4_phase2.sql

-- ─── Transactions: deduplication + source tracking ────────────────────────────

ALTER TABLE bx4_transactions ADD COLUMN IF NOT EXISTS external_id text;
ALTER TABLE bx4_transactions ADD COLUMN IF NOT EXISTS is_internal bool DEFAULT false;

-- Unique index: one external_id per company prevents Stripe double-imports
CREATE UNIQUE INDEX IF NOT EXISTS bx4_transactions_ext_id_idx
  ON bx4_transactions (company_id, external_id)
  WHERE external_id IS NOT NULL;

-- ─── Financial accounts: internal flag + label ────────────────────────────────

ALTER TABLE bx4_financial_accounts ADD COLUMN IF NOT EXISTS is_internal bool DEFAULT false;
ALTER TABLE bx4_financial_accounts ADD COLUMN IF NOT EXISTS account_label text;

-- Internal constraint: only one internal Stripe account per company
CREATE UNIQUE INDEX IF NOT EXISTS bx4_fin_acct_internal_idx
  ON bx4_financial_accounts (company_id, provider)
  WHERE is_internal = true;

-- ─── Cash flow snapshots (daily/monthly aggregation cache) ────────────────────

CREATE TABLE IF NOT EXISTS bx4_cashflow_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES bx4_companies(id) ON DELETE CASCADE,
  period_type text NOT NULL,         -- daily | monthly
  period_date date NOT NULL,
  revenue numeric(12,2) DEFAULT 0,
  expenses numeric(12,2) DEFAULT 0,
  net numeric(12,2) DEFAULT 0,
  cumulative_net numeric(12,2) DEFAULT 0,
  computed_at timestamptz DEFAULT now(),
  UNIQUE (company_id, period_type, period_date)
);

ALTER TABLE bx4_cashflow_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bx4 cashflow admin" ON bx4_cashflow_cache FOR ALL TO authenticated USING (bx4_is_admin());
CREATE POLICY "bx4 cashflow read"  ON bx4_cashflow_cache FOR SELECT TO authenticated USING (bx4_has_access(company_id));

-- ─── Expense audit results ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bx4_expense_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES bx4_companies(id) ON DELETE CASCADE,
  generated_at timestamptz DEFAULT now(),
  findings_json jsonb DEFAULT '[]',
  potential_savings numeric(12,2) DEFAULT 0,
  report_text text
);

ALTER TABLE bx4_expense_audits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bx4 audit admin" ON bx4_expense_audits FOR ALL TO authenticated USING (bx4_is_admin());
CREATE POLICY "bx4 audit read"  ON bx4_expense_audits FOR SELECT TO authenticated USING (bx4_has_access(company_id));

-- ─── Google Analytics accounts ────────────────────────────────────────────────
-- Re-uses bx4_social_accounts with platform='google_analytics'
-- Add property_id column for GA4
ALTER TABLE bx4_social_accounts ADD COLUMN IF NOT EXISTS property_id text;

-- ─── Indexes for Phase 2 queries ──────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS bx4_transactions_source_idx
  ON bx4_transactions (company_id, source, date DESC);

CREATE INDEX IF NOT EXISTS bx4_transactions_category_idx
  ON bx4_transactions (company_id, category, date DESC);
