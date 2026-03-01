-- 037_openclaw_access_manifest.sql
-- OpenClaw credential access control: tracks which vault keys each instance may receive.
-- The ClawBot Manager (vault broker) checks this table before injecting credentials.

-- Instance registry (lightweight — full instance management comes later)
CREATE TABLE IF NOT EXISTS oc_instances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL,                  -- "opai-main", "client-acme", used as container name
    display_name TEXT NOT NULL DEFAULT 'ClawBot',
    owner_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'provisioning'
        CHECK (status IN ('provisioning', 'running', 'stopped', 'error', 'archived')),
    tier TEXT NOT NULL DEFAULT 'internal'
        CHECK (tier IN ('internal', 'starter', 'pro', 'enterprise')),
    autonomy_level SMALLINT NOT NULL DEFAULT 3
        CHECK (autonomy_level BETWEEN 0 AND 10),  -- 0 = no autonomy, 10 = full autonomous
    config JSONB NOT NULL DEFAULT '{}',         -- personality, model preferences, limits
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Access manifest: explicit whitelist of vault keys per instance
CREATE TABLE IF NOT EXISTS oc_access_manifest (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_id UUID NOT NULL REFERENCES oc_instances(id) ON DELETE CASCADE,
    vault_key TEXT NOT NULL,                     -- exact key name in vault, e.g. "DISCORD_TOKEN"
    vault_section TEXT NOT NULL DEFAULT 'credentials'
        CHECK (vault_section IN ('shared', 'services', 'credentials')),
    vault_service TEXT,                          -- if section=services, which service sub-key
    scope TEXT NOT NULL DEFAULT 'read'
        CHECK (scope IN ('read', 'inject')),    -- read = API access, inject = env var at start
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    granted_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
    reason TEXT,                                 -- "Phase 2: Discord integration"
    expires_at TIMESTAMPTZ,                      -- optional TTL on the grant
    revoked_at TIMESTAMPTZ,                      -- soft-delete: set to revoke without losing history
    UNIQUE (instance_id, vault_key, vault_service)
);

-- Credential access audit log (separate from vault's own audit — tracks OC-specific broker requests)
CREATE TABLE IF NOT EXISTS oc_credential_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_id UUID REFERENCES oc_instances(id) ON DELETE SET NULL,
    instance_slug TEXT NOT NULL,
    action TEXT NOT NULL
        CHECK (action IN ('inject', 'fetch', 'grant', 'revoke', 'deny', 'expire')),
    vault_keys TEXT[] NOT NULL DEFAULT '{}',     -- which keys were involved
    success BOOLEAN NOT NULL DEFAULT true,
    detail TEXT,
    actor_id UUID REFERENCES profiles(id) ON DELETE SET NULL,  -- who triggered (null = system/cron)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_oc_manifest_instance ON oc_access_manifest(instance_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_oc_manifest_key ON oc_access_manifest(vault_key) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_oc_credential_log_instance ON oc_credential_log(instance_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oc_credential_log_action ON oc_credential_log(action, created_at DESC);

-- RLS
ALTER TABLE oc_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE oc_access_manifest ENABLE ROW LEVEL SECURITY;
ALTER TABLE oc_credential_log ENABLE ROW LEVEL SECURITY;

-- Admin full access (using get_my_role() to avoid RLS recursion on profiles)
CREATE POLICY "admin_all_oc_instances" ON oc_instances
    FOR ALL USING (get_my_role() = 'admin');

CREATE POLICY "admin_all_oc_manifest" ON oc_access_manifest
    FOR ALL USING (get_my_role() = 'admin');

CREATE POLICY "admin_all_oc_credential_log" ON oc_credential_log
    FOR ALL USING (get_my_role() = 'admin');

-- Owner can view their own instances (read-only)
CREATE POLICY "owner_view_oc_instances" ON oc_instances
    FOR SELECT USING (owner_id = auth.uid());

-- Service role full access (for broker service-to-service calls)
CREATE POLICY "service_all_oc_instances" ON oc_instances
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "service_all_oc_manifest" ON oc_access_manifest
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "service_all_oc_credential_log" ON oc_credential_log
    FOR ALL USING (auth.role() = 'service_role');

-- updated_at trigger
CREATE OR REPLACE FUNCTION oc_update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER oc_instances_updated_at
    BEFORE UPDATE ON oc_instances
    FOR EACH ROW EXECUTE FUNCTION oc_update_timestamp();
