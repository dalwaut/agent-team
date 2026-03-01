-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 028: Bx4 Phase 5 — Goal Decomposition, Alert Dispatch, Tax Estimate
-- ─────────────────────────────────────────────────────────────────────────────

-- Track when alert notifications were dispatched
ALTER TABLE bx4_alerts ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;

-- Extend bx4_company_goals for milestones (parent_goal_id already exists)
ALTER TABLE bx4_company_goals ADD COLUMN IF NOT EXISTS order_index INT DEFAULT 0;
ALTER TABLE bx4_company_goals ADD COLUMN IF NOT EXISTS team_hub_task_id TEXT;
ALTER TABLE bx4_company_goals ADD COLUMN IF NOT EXISTS is_milestone BOOLEAN DEFAULT FALSE;

-- Extend bx4_financial_snapshots: store quarter label for tax grouping
ALTER TABLE bx4_financial_snapshots ADD COLUMN IF NOT EXISTS quarter TEXT;
