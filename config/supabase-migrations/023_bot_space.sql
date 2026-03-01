-- 023_bot_space.sql
-- OPAI Bot Space — Database schema
-- Tables: bot_space_catalog, bot_space_installations, bot_space_runs, bot_space_credit_transactions
-- Also extends profiles with agent_credits column.

-- ── Extend profiles ──────────────────────────────────────────────────────────
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS agent_credits INT NOT NULL DEFAULT 0;

-- ── bot_space_catalog ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bot_space_catalog (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug            TEXT UNIQUE NOT NULL,
    name            TEXT NOT NULL,
    tagline         TEXT NOT NULL DEFAULT '',
    description     TEXT NOT NULL DEFAULT '',
    icon            TEXT NOT NULL DEFAULT '🤖',
    category        TEXT NOT NULL DEFAULT 'productivity',
    tags            TEXT[] NOT NULL DEFAULT '{}',
    unlock_credits  INT NOT NULL DEFAULT 0,
    run_credits     INT NOT NULL DEFAULT 1,
    cron_options    JSONB NOT NULL DEFAULT '[]',
    setup_schema    JSONB NOT NULL DEFAULT '{}',
    dashboard_url   TEXT NOT NULL DEFAULT '',
    features        TEXT[] NOT NULL DEFAULT '{}',
    screenshots     TEXT[] NOT NULL DEFAULT '{}',
    is_admin_only   BOOLEAN NOT NULL DEFAULT false,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    author          TEXT NOT NULL DEFAULT 'OPAI',
    version         TEXT NOT NULL DEFAULT '1.0.0',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── bot_space_installations ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bot_space_installations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    agent_slug          TEXT NOT NULL REFERENCES bot_space_catalog(slug) ON DELETE CASCADE,
    status              TEXT NOT NULL DEFAULT 'pending_setup'
                            CHECK (status IN ('pending_setup','active','paused','error')),
    cron_expr           TEXT NOT NULL DEFAULT '0 * * * *',
    next_run_at         TIMESTAMPTZ,
    last_run_at         TIMESTAMPTZ,
    last_run_status     TEXT,
    config              JSONB NOT NULL DEFAULT '{}',
    credits_spent_total INT NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, agent_slug)
);

-- ── bot_space_runs ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bot_space_runs (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    installation_id  UUID REFERENCES bot_space_installations(id) ON DELETE SET NULL,
    user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    agent_slug       TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued','running','completed','failed','skipped_credits')),
    credits_charged  INT NOT NULL DEFAULT 0,
    started_at       TIMESTAMPTZ,
    completed_at     TIMESTAMPTZ,
    result_summary   TEXT,
    error_message    TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── bot_space_credit_transactions ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bot_space_credit_transactions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    amount              INT NOT NULL,
    type                TEXT NOT NULL
                            CHECK (type IN ('purchase','unlock','run','grant','refund')),
    description         TEXT NOT NULL DEFAULT '',
    related_agent_slug  TEXT,
    related_run_id      UUID REFERENCES bot_space_runs(id) ON DELETE SET NULL,
    stripe_payment_id   TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── updated_at triggers ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'set_bot_space_catalog_updated_at'
    ) THEN
        CREATE TRIGGER set_bot_space_catalog_updated_at
            BEFORE UPDATE ON bot_space_catalog
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'set_bot_space_installations_updated_at'
    ) THEN
        CREATE TRIGGER set_bot_space_installations_updated_at
            BEFORE UPDATE ON bot_space_installations
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- ── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_installations_user_id ON bot_space_installations(user_id);
CREATE INDEX IF NOT EXISTS idx_installations_status_next_run
    ON bot_space_installations(status, next_run_at)
    WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_runs_user_id ON bot_space_runs(user_id);
CREATE INDEX IF NOT EXISTS idx_runs_installation_id ON bot_space_runs(installation_id);
CREATE INDEX IF NOT EXISTS idx_credit_tx_user_id ON bot_space_credit_transactions(user_id);

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE bot_space_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_space_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_space_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_space_credit_transactions ENABLE ROW LEVEL SECURITY;

-- service_role bypasses RLS (backend always uses service_role key)
-- Catalog: read-only for authenticated users
CREATE POLICY "catalog_read_all" ON bot_space_catalog
    FOR SELECT TO authenticated USING (true);

-- Installations: users see only their own
CREATE POLICY "installations_own" ON bot_space_installations
    FOR ALL TO authenticated USING (user_id = auth.uid());

-- Runs: users see only their own
CREATE POLICY "runs_own" ON bot_space_runs
    FOR ALL TO authenticated USING (user_id = auth.uid());

-- Credit transactions: users see only their own
CREATE POLICY "credit_tx_own" ON bot_space_credit_transactions
    FOR ALL TO authenticated USING (user_id = auth.uid());
