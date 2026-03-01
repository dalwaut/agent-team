-- 041_user_vault.sql — Per-user encrypted secret storage
-- Provides isolated, app-level encrypted credential storage per user.
-- RLS enforces strict isolation: users see ONLY their own secrets, admins CANNOT see others'.

-- ── User Vault Secrets ──────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_vault_secrets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    encrypted_value TEXT NOT NULL,
    category TEXT DEFAULT 'general',
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    last_accessed_at TIMESTAMPTZ,
    UNIQUE(user_id, name)
);

ALTER TABLE public.user_vault_secrets ENABLE ROW LEVEL SECURITY;

-- True isolation: users manage ONLY their own secrets. No admin override.
CREATE POLICY "Users manage own secrets"
    ON public.user_vault_secrets FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_user_vault_user_id
    ON public.user_vault_secrets(user_id);
CREATE INDEX IF NOT EXISTS idx_user_vault_name
    ON public.user_vault_secrets(user_id, name);

-- ── User Vault Audit Log ────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_vault_audit (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id),
    action TEXT NOT NULL,
    secret_name TEXT,
    ip_address TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.user_vault_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own audit log"
    ON public.user_vault_audit FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "System inserts audit"
    ON public.user_vault_audit FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_user_vault_audit_user
    ON public.user_vault_audit(user_id, created_at DESC);
