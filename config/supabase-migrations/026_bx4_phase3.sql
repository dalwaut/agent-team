-- Bx4 Phase 3 migration: social snapshots index, competitor columns,
-- market_news table, swot_analyses table

-- 1. Index on bx4_social_snapshots(account_id, created_at DESC)
CREATE INDEX IF NOT EXISTS idx_bx4_social_snapshots_account_created
    ON bx4_social_snapshots(social_account_id, captured_at DESC);

-- 2. Add columns to bx4_competitors
ALTER TABLE bx4_competitors
    ADD COLUMN IF NOT EXISTS last_research_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS intel_summary TEXT;

-- 3. Create bx4_market_news
CREATE TABLE IF NOT EXISTS bx4_market_news (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id   UUID REFERENCES bx4_companies(id) ON DELETE CASCADE,
    headline     TEXT,
    summary      TEXT,
    source       TEXT,
    published_date DATE,
    created_at   TIMESTAMPTZ DEFAULT now()
);

-- 4. Create bx4_swot_analyses
CREATE TABLE IF NOT EXISTS bx4_swot_analyses (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id    UUID REFERENCES bx4_companies(id) ON DELETE CASCADE,
    strengths     JSONB DEFAULT '[]',
    weaknesses    JSONB DEFAULT '[]',
    opportunities JSONB DEFAULT '[]',
    threats       JSONB DEFAULT '[]',
    raw_text      TEXT,
    created_at    TIMESTAMPTZ DEFAULT now()
);

-- 5. Enable RLS
ALTER TABLE bx4_market_news ENABLE ROW LEVEL SECURITY;
ALTER TABLE bx4_swot_analyses ENABLE ROW LEVEL SECURITY;

-- 6. RLS policies for bx4_market_news
CREATE POLICY "bx4_market_news_select" ON bx4_market_news
    FOR SELECT USING (bx4_has_access(company_id));

CREATE POLICY "bx4_market_news_insert" ON bx4_market_news
    FOR INSERT WITH CHECK (bx4_has_access(company_id));

CREATE POLICY "bx4_market_news_update" ON bx4_market_news
    FOR UPDATE USING (bx4_has_access(company_id));

CREATE POLICY "bx4_market_news_delete" ON bx4_market_news
    FOR DELETE USING (bx4_is_admin());

-- 7. RLS policies for bx4_swot_analyses
CREATE POLICY "bx4_swot_analyses_select" ON bx4_swot_analyses
    FOR SELECT USING (bx4_has_access(company_id));

CREATE POLICY "bx4_swot_analyses_insert" ON bx4_swot_analyses
    FOR INSERT WITH CHECK (bx4_has_access(company_id));

CREATE POLICY "bx4_swot_analyses_update" ON bx4_swot_analyses
    FOR UPDATE USING (bx4_has_access(company_id));

CREATE POLICY "bx4_swot_analyses_delete" ON bx4_swot_analyses
    FOR DELETE USING (bx4_is_admin());

-- 8. Index on bx4_market_news(company_id, created_at DESC)
CREATE INDEX IF NOT EXISTS idx_bx4_market_news_company_created
    ON bx4_market_news(company_id, created_at DESC);
