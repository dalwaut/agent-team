-- Migration 5: Messenger tables for OPAI internal messaging
-- Apply to Supabase project: idorgloobxkmlnwnxbej (OPAI Agent System)
-- Run via: Supabase Dashboard → SQL Editor → paste and execute

-- ── DM Channels ──────────────────────────────────────────

CREATE TABLE public.dm_channels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type TEXT NOT NULL DEFAULT 'dm' CHECK (type IN ('dm', 'group')),
    name TEXT,  -- NULL for DMs, required for groups
    created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE public.dm_channels IS 'Messenger conversation channels (DM or group)';

CREATE INDEX idx_dm_channels_type ON public.dm_channels(type);
CREATE INDEX idx_dm_channels_updated ON public.dm_channels(updated_at DESC);

-- ── Channel Members ──────────────────────────────────────

CREATE TABLE public.dm_channel_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES public.dm_channels(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    last_read_at TIMESTAMPTZ DEFAULT now(),
    joined_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(channel_id, user_id)
);

COMMENT ON TABLE public.dm_channel_members IS 'Channel membership and read tracking';

CREATE INDEX idx_dm_members_channel ON public.dm_channel_members(channel_id);
CREATE INDEX idx_dm_members_user ON public.dm_channel_members(user_id);

-- ── Messages ─────────────────────────────────────────────

CREATE TABLE public.dm_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES public.dm_channels(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    content TEXT NOT NULL DEFAULT '',
    reply_to UUID REFERENCES public.dm_messages(id) ON DELETE SET NULL,
    file_url TEXT,
    file_name TEXT,
    file_type TEXT,
    edited_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE public.dm_messages IS 'Messenger messages with reply and file support';

CREATE INDEX idx_dm_messages_channel ON public.dm_messages(channel_id, created_at DESC);
CREATE INDEX idx_dm_messages_sender ON public.dm_messages(sender_id);
CREATE INDEX idx_dm_messages_search ON public.dm_messages USING gin(to_tsvector('english', content));

-- ── Reactions ────────────────────────────────────────────

CREATE TABLE public.dm_reactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES public.dm_messages(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(message_id, user_id, emoji)
);

COMMENT ON TABLE public.dm_reactions IS 'Emoji reactions on messages';

CREATE INDEX idx_dm_reactions_message ON public.dm_reactions(message_id);

-- ── Updated_at triggers ──────────────────────────────────

CREATE TRIGGER dm_channels_updated_at
    BEFORE UPDATE ON public.dm_channels FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at();

-- ── Row Level Security ───────────────────────────────────

ALTER TABLE public.dm_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dm_channel_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dm_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dm_reactions ENABLE ROW LEVEL SECURITY;

-- Channels: users can see channels they're members of
CREATE POLICY "Users can view their channels"
    ON public.dm_channels FOR SELECT
    USING (id IN (SELECT channel_id FROM public.dm_channel_members WHERE user_id = auth.uid()));

CREATE POLICY "Users can create channels"
    ON public.dm_channels FOR INSERT
    WITH CHECK (created_by = auth.uid());

CREATE POLICY "Channel creators can update"
    ON public.dm_channels FOR UPDATE
    USING (created_by = auth.uid());

-- Channel members: users can see memberships for their channels
CREATE POLICY "Users can view channel members"
    ON public.dm_channel_members FOR SELECT
    USING (channel_id IN (SELECT channel_id FROM public.dm_channel_members WHERE user_id = auth.uid()));

CREATE POLICY "Users can add members to channels they created"
    ON public.dm_channel_members FOR INSERT
    WITH CHECK (
        channel_id IN (SELECT id FROM public.dm_channels WHERE created_by = auth.uid())
        OR user_id = auth.uid()
    );

CREATE POLICY "Users can update their own read status"
    ON public.dm_channel_members FOR UPDATE
    USING (user_id = auth.uid());

-- Messages: users can see messages in their channels
CREATE POLICY "Users can view messages in their channels"
    ON public.dm_messages FOR SELECT
    USING (channel_id IN (SELECT channel_id FROM public.dm_channel_members WHERE user_id = auth.uid()));

CREATE POLICY "Users can send messages to their channels"
    ON public.dm_messages FOR INSERT
    WITH CHECK (
        sender_id = auth.uid()
        AND channel_id IN (SELECT channel_id FROM public.dm_channel_members WHERE user_id = auth.uid())
    );

CREATE POLICY "Users can edit their own messages"
    ON public.dm_messages FOR UPDATE
    USING (sender_id = auth.uid());

-- Reactions: users can see reactions in their channels
CREATE POLICY "Users can view reactions in their channels"
    ON public.dm_reactions FOR SELECT
    USING (message_id IN (
        SELECT id FROM public.dm_messages WHERE channel_id IN (
            SELECT channel_id FROM public.dm_channel_members WHERE user_id = auth.uid()
        )
    ));

CREATE POLICY "Users can add reactions"
    ON public.dm_reactions FOR INSERT
    WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can remove their own reactions"
    ON public.dm_reactions FOR DELETE
    USING (user_id = auth.uid());

-- ── Enable Realtime ──────────────────────────────────────

ALTER PUBLICATION supabase_realtime ADD TABLE public.dm_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.dm_reactions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.dm_channel_members;
