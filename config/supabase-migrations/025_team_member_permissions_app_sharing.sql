-- Migration 025: Team Member Permissions + App Sharing
-- Part of TeamHub Settings Overhaul + Cross-Tool Sharing

-- Granular admin permissions per member per workspace
CREATE TABLE IF NOT EXISTS team_member_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    can_manage_statuses BOOLEAN DEFAULT false,
    can_manage_priorities BOOLEAN DEFAULT false,
    can_manage_tags BOOLEAN DEFAULT false,
    can_manage_members BOOLEAN DEFAULT false,
    can_manage_fields BOOLEAN DEFAULT false,
    can_manage_automations BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(workspace_id, user_id)
);

-- Cross-tool app sharing per member per workspace
CREATE TABLE IF NOT EXISTS team_app_sharing (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    app_name TEXT NOT NULL,  -- 'op-wordpress', future: 'brain', 'prd', etc.
    access_level TEXT NOT NULL DEFAULT 'full' CHECK (access_level IN ('view', 'manage', 'full')),
    config JSONB DEFAULT '{}',  -- future: { site_ids: [...] } for per-site restrictions
    shared_by UUID NOT NULL REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(workspace_id, user_id, app_name)
);

-- RLS
ALTER TABLE team_member_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_app_sharing ENABLE ROW LEVEL SECURITY;

CREATE POLICY tmp_select ON team_member_permissions FOR SELECT
    USING (is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY tmp_all ON team_member_permissions FOR ALL
    USING (is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY tas_select ON team_app_sharing FOR SELECT
    USING (is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY tas_all ON team_app_sharing FOR ALL
    USING (is_workspace_member(workspace_id, auth.uid()));
