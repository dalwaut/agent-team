-- 006: Add sandbox and onboarding fields to profiles
-- Supports user sandbox provisioning and onboarding wizard flow.

-- Sandbox provisioning state
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS sandbox_provisioned BOOLEAN DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS sandbox_provisioned_at TIMESTAMPTZ;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS sandbox_nas_path TEXT;

-- Onboarding wizard state
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

-- User profile fields collected during onboarding
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS expertise_level TEXT CHECK (expertise_level IN ('beginner', 'intermediate', 'advanced'));
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS primary_use_case TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS notification_preferences JSONB DEFAULT '{}';
