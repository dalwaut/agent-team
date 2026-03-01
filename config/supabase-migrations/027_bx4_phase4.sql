-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 027: Bx4 Phase 4 — Briefings, KPI History, Anomaly Detection
-- ─────────────────────────────────────────────────────────────────────────────

-- ── bx4_briefings ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bx4_briefings (
    id               UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id       UUID        NOT NULL REFERENCES bx4_companies(id) ON DELETE CASCADE,
    type             TEXT        NOT NULL DEFAULT 'daily' CHECK (type IN ('daily', 'weekly', 'pulse')),
    title            TEXT,
    summary          TEXT,
    content          TEXT,
    dispatched_discord  BOOLEAN  DEFAULT FALSE,
    dispatched_email    BOOLEAN  DEFAULT FALSE,
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bx4_briefings_company_idx
    ON bx4_briefings(company_id, created_at DESC);

ALTER TABLE bx4_briefings ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'bx4_briefings_select' AND tablename = 'bx4_briefings') THEN
        CREATE POLICY "bx4_briefings_select" ON bx4_briefings FOR SELECT USING (bx4_has_access(company_id));
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'bx4_briefings_insert' AND tablename = 'bx4_briefings') THEN
        CREATE POLICY "bx4_briefings_insert" ON bx4_briefings FOR INSERT WITH CHECK (bx4_has_access(company_id));
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'bx4_briefings_update' AND tablename = 'bx4_briefings') THEN
        CREATE POLICY "bx4_briefings_update" ON bx4_briefings FOR UPDATE USING (bx4_has_access(company_id));
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'bx4_briefings_delete' AND tablename = 'bx4_briefings') THEN
        CREATE POLICY "bx4_briefings_delete" ON bx4_briefings FOR DELETE USING (bx4_is_admin());
    END IF;
END $$;


-- ── bx4_kpi_history ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bx4_kpi_history (
    id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    kpi_id      UUID        NOT NULL REFERENCES bx4_kpis(id) ON DELETE CASCADE,
    company_id  UUID        NOT NULL,
    value       NUMERIC     NOT NULL,
    recorded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bx4_kpi_history_kpi_idx
    ON bx4_kpi_history(kpi_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS bx4_kpi_history_company_idx
    ON bx4_kpi_history(company_id);

ALTER TABLE bx4_kpi_history ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'bx4_kpi_history_select' AND tablename = 'bx4_kpi_history') THEN
        CREATE POLICY "bx4_kpi_history_select" ON bx4_kpi_history FOR SELECT USING (bx4_has_access(company_id));
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'bx4_kpi_history_insert' AND tablename = 'bx4_kpi_history') THEN
        CREATE POLICY "bx4_kpi_history_insert" ON bx4_kpi_history FOR INSERT WITH CHECK (bx4_has_access(company_id));
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'bx4_kpi_history_delete' AND tablename = 'bx4_kpi_history') THEN
        CREATE POLICY "bx4_kpi_history_delete" ON bx4_kpi_history FOR DELETE USING (bx4_is_admin());
    END IF;
END $$;


-- ── Extend bx4_kpis with anomaly columns ─────────────────────────────────────
ALTER TABLE bx4_kpis ADD COLUMN IF NOT EXISTS anomaly_flag      BOOLEAN   DEFAULT FALSE;
ALTER TABLE bx4_kpis ADD COLUMN IF NOT EXISTS z_score           NUMERIC;
ALTER TABLE bx4_kpis ADD COLUMN IF NOT EXISTS anomaly_checked_at TIMESTAMPTZ;

-- ── Extend bx4_recommendations with ROI score ─────────────────────────────────
ALTER TABLE bx4_recommendations ADD COLUMN IF NOT EXISTS roi_score NUMERIC;
