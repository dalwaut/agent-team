-- 013_team_hub_discord_binding.sql — Discord channel binding + AI prompt per workspace

-- Add Discord integration fields to team_workspaces
ALTER TABLE team_workspaces ADD COLUMN IF NOT EXISTS discord_server_id TEXT;
ALTER TABLE team_workspaces ADD COLUMN IF NOT EXISTS discord_channel_id TEXT;
ALTER TABLE team_workspaces ADD COLUMN IF NOT EXISTS bot_prompt TEXT DEFAULT '';

-- Index for fast channel→workspace lookup
CREATE INDEX IF NOT EXISTS idx_team_workspaces_discord_channel
    ON team_workspaces(discord_channel_id) WHERE discord_channel_id IS NOT NULL;

-- Track Discord user mappings per workspace (auto-discovered when they chat)
-- This allows the same Discord user to be in multiple team workspaces
CREATE TABLE IF NOT EXISTS team_discord_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
    discord_id TEXT NOT NULL,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    discord_username TEXT,
    joined_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(workspace_id, discord_id)
);

CREATE INDEX IF NOT EXISTS idx_team_discord_members_discord
    ON team_discord_members(discord_id);

ALTER TABLE team_discord_members ENABLE ROW LEVEL SECURITY;

-- RLS: workspace members can see Discord mappings for their workspaces
CREATE POLICY discord_members_select ON team_discord_members FOR SELECT
    USING (is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY discord_members_insert ON team_discord_members FOR INSERT
    WITH CHECK (workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));

CREATE POLICY discord_members_delete ON team_discord_members FOR DELETE
    USING (workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));
