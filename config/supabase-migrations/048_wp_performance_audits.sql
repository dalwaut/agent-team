-- Performance Auditor agent — audit results storage
CREATE TABLE IF NOT EXISTS wp_performance_audits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id UUID NOT NULL REFERENCES wp_sites(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES wp_agents(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'running',
    -- Overall metrics
    overall_score INT,
    pages_audited INT DEFAULT 0,
    pages_checked INT DEFAULT 0,
    issues_found INT DEFAULT 0,
    critical_issues INT DEFAULT 0,
    -- Core Web Vitals (site-wide averages)
    avg_lcp NUMERIC,
    avg_fcp NUMERIC,
    avg_cls NUMERIC,
    avg_ttfb NUMERIC,
    avg_tbt NUMERIC,
    -- Detailed results
    results JSONB DEFAULT '{}',
    -- Config snapshot
    scope TEXT,
    report_sent BOOLEAN DEFAULT false,
    report_email TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wp_perf_audits_agent ON wp_performance_audits(agent_id);
CREATE INDEX IF NOT EXISTS idx_wp_perf_audits_site ON wp_performance_audits(site_id);

ALTER TABLE wp_performance_audits ENABLE ROW LEVEL SECURITY;

CREATE POLICY wp_perf_audits_owner ON wp_performance_audits
    FOR ALL USING (auth.uid() = user_id);
CREATE POLICY wp_perf_audits_service ON wp_performance_audits
    FOR ALL USING (auth.role() = 'service_role');
