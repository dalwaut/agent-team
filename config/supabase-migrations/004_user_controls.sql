-- Migration 4: User Controls — preface prompts, access control, system settings
-- Apply to Supabase project: idorgloobxkmlnwnxbej (OPAI Agent System)

-- ── Extend profiles table ───────────────────────────────

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS preface_prompt TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS allowed_apps TEXT[] DEFAULT '{}';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS allowed_agents TEXT[] DEFAULT '{}';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS invited_by UUID REFERENCES public.profiles(id);
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ;

COMMENT ON COLUMN public.profiles.preface_prompt IS 'Admin-set system prompt prepended to all user messages';
COMMENT ON COLUMN public.profiles.allowed_apps IS 'Apps this user can access (empty = all for admins, none for users)';
COMMENT ON COLUMN public.profiles.allowed_agents IS 'Agents this user can invoke (empty = none)';
COMMENT ON COLUMN public.profiles.invited_by IS 'UUID of admin who invited this user';

-- ── System settings table ───────────────────────────────

CREATE TABLE IF NOT EXISTS public.system_settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ DEFAULT now(),
    updated_by UUID REFERENCES public.profiles(id)
);

COMMENT ON TABLE public.system_settings IS 'Global system settings (kill switches, lockdown state)';

-- Seed default settings
INSERT INTO public.system_settings (key, value) VALUES
    ('users_enabled', '{"enabled": true}'::jsonb),
    ('network_locked', '{"locked": false}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── RLS for system_settings ─────────────────────────────

ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read settings" ON public.system_settings
    FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'
    ));

CREATE POLICY "Admins can update settings" ON public.system_settings
    FOR UPDATE
    USING (EXISTS (
        SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'
    ));

CREATE POLICY "Admins can insert settings" ON public.system_settings
    FOR INSERT
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'
    ));

-- ── Update handle_new_user to include new fields ────────

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, email, display_name, role, invited_by, invited_at)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)),
        COALESCE(NEW.raw_app_meta_data->>'role', 'user'),
        (NEW.raw_user_meta_data->>'invited_by')::UUID,
        CASE WHEN NEW.raw_user_meta_data->>'invited_by' IS NOT NULL THEN now() ELSE NULL END
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
