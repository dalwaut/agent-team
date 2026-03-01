-- 007: Dev workspaces — tracks IDE container lifecycle per user
-- Used by opai-dev workspace manager to manage Theia containers.

CREATE TABLE IF NOT EXISTS public.dev_workspaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    container_id TEXT,
    container_port INTEGER,
    status TEXT NOT NULL DEFAULT 'creating'
        CHECK (status IN ('creating', 'running', 'stopped', 'destroying', 'destroyed', 'error')),
    image_tag TEXT NOT NULL DEFAULT 'opai-theia:latest',
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    stopped_at TIMESTAMPTZ,
    destroyed_at TIMESTAMPTZ
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_dev_workspaces_user_id ON public.dev_workspaces(user_id);
CREATE INDEX IF NOT EXISTS idx_dev_workspaces_status ON public.dev_workspaces(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dev_workspaces_active_port
    ON public.dev_workspaces(container_port)
    WHERE status IN ('creating', 'running');

-- RLS
ALTER TABLE public.dev_workspaces ENABLE ROW LEVEL SECURITY;

-- Users can view their own workspaces
CREATE POLICY dev_workspaces_select_own ON public.dev_workspaces
    FOR SELECT USING (auth.uid() = user_id);

-- Users can update their own workspaces (for activity tracking)
CREATE POLICY dev_workspaces_update_own ON public.dev_workspaces
    FOR UPDATE USING (auth.uid() = user_id);

-- Admins can see all workspaces
CREATE POLICY dev_workspaces_admin_select ON public.dev_workspaces
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
        )
    );

-- Admins can do everything
CREATE POLICY dev_workspaces_admin_all ON public.dev_workspaces
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
        )
    );

-- Service role bypasses RLS (used by workspace manager)
-- (This is automatic in Supabase — service_role key bypasses RLS)
