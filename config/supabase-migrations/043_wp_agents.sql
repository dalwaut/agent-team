-- 043: WP Agents — agent instances + link scan results
-- Supports broken-link-scanner and future agent templates

-- ── wp_agents: per-site agent instances ─────────────────────────

CREATE TABLE IF NOT EXISTS wp_agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id UUID NOT NULL REFERENCES wp_sites(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    template_id TEXT NOT NULL,
    name TEXT NOT NULL,
    config JSONB NOT NULL DEFAULT '{}',
    enabled BOOLEAN NOT NULL DEFAULT true,
    schedule TEXT NOT NULL DEFAULT 'manual',
    cron_expression TEXT,
    next_run_at TIMESTAMPTZ,
    last_run_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'idle',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wp_agents_site ON wp_agents(site_id);
CREATE INDEX IF NOT EXISTS idx_wp_agents_user ON wp_agents(user_id);
CREATE INDEX IF NOT EXISTS idx_wp_agents_schedule ON wp_agents(enabled, next_run_at)
    WHERE enabled = true AND next_run_at IS NOT NULL;

ALTER TABLE wp_agents ENABLE ROW LEVEL SECURITY;

CREATE POLICY wp_agents_owner ON wp_agents
    FOR ALL USING (auth.uid() = user_id);

CREATE POLICY wp_agents_service ON wp_agents
    FOR ALL USING (auth.role() = 'service_role');


-- ── wp_link_scans: scan result history ──────────────────────────

CREATE TABLE IF NOT EXISTS wp_link_scans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id UUID NOT NULL REFERENCES wp_sites(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES wp_agents(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'running',
    total_links INT DEFAULT 0,
    broken_links INT DEFAULT 0,
    results JSONB DEFAULT '[]',
    scope TEXT,
    report_sent BOOLEAN DEFAULT false,
    report_email TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wp_link_scans_agent ON wp_link_scans(agent_id);
CREATE INDEX IF NOT EXISTS idx_wp_link_scans_site ON wp_link_scans(site_id);

ALTER TABLE wp_link_scans ENABLE ROW LEVEL SECURITY;

CREATE POLICY wp_link_scans_owner ON wp_link_scans
    FOR ALL USING (auth.uid() = user_id);

CREATE POLICY wp_link_scans_service ON wp_link_scans
    FOR ALL USING (auth.role() = 'service_role');
