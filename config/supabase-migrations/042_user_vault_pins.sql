-- 042: User vault PIN storage for standalone per-user vault
-- Each user has their own PIN to unlock their personal vault

CREATE TABLE IF NOT EXISTS public.user_vault_pins (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    pin_hash TEXT NOT NULL,
    failed_attempts INT DEFAULT 0,
    locked_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.user_vault_pins ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own pin"
    ON public.user_vault_pins FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
