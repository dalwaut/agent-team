-- ============================================================
-- 049: Hub Model — Database Schema + Data Migration
-- Applied: 2026-03-11
-- ============================================================

-- 1.1 — Create team_hubs table
CREATE TABLE team_hubs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  icon TEXT DEFAULT '🏢',
  color TEXT DEFAULT '#6c5ce7',
  created_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 1.2 — Create team_hub_membership table
CREATE TABLE team_hub_membership (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hub_id UUID NOT NULL REFERENCES team_hubs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  role TEXT NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(hub_id, user_id)
);

-- 1.3 — Create team_hub_permissions table
CREATE TABLE team_hub_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hub_id UUID NOT NULL REFERENCES team_hubs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  can_edit_titles BOOLEAN DEFAULT true,
  can_change_status BOOLEAN DEFAULT true,
  can_change_priority BOOLEAN DEFAULT true,
  can_create_items BOOLEAN DEFAULT true,
  can_comment BOOLEAN DEFAULT true,
  can_assign BOOLEAN DEFAULT true,
  can_create_statuses BOOLEAN DEFAULT false,
  can_delete_statuses BOOLEAN DEFAULT false,
  can_create_tags BOOLEAN DEFAULT false,
  can_delete_tags BOOLEAN DEFAULT false,
  can_delete_items BOOLEAN DEFAULT false,
  can_manage_members BOOLEAN DEFAULT false,
  can_create_spaces BOOLEAN DEFAULT false,
  can_delete_spaces BOOLEAN DEFAULT false,
  can_manage_automations BOOLEAN DEFAULT false,
  can_manage_fields BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(hub_id, user_id)
);

-- 1.4 — Add hub_id to team_workspaces
ALTER TABLE team_workspaces ADD COLUMN hub_id UUID REFERENCES team_hubs(id);

-- 1.5 — Add hub_id to team_statuses (make workspace_id nullable for hub-level statuses)
ALTER TABLE team_statuses ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE team_statuses ADD COLUMN hub_id UUID REFERENCES team_hubs(id);

-- 1.6 — Add hub_id to team_tags (make workspace_id nullable for hub-level tags)
ALTER TABLE team_tags ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE team_tags ADD COLUMN hub_id UUID REFERENCES team_hubs(id);

-- 1.7 — RLS helper functions
CREATE OR REPLACE FUNCTION is_hub_member(p_hub_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS(
    SELECT 1 FROM team_hub_membership
    WHERE hub_id = p_hub_id AND user_id = p_user_id
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION hub_role(p_hub_id UUID, p_user_id UUID)
RETURNS TEXT AS $$
  SELECT role FROM team_hub_membership
  WHERE hub_id = p_hub_id AND user_id = p_user_id;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION hub_permission(p_hub_id UUID, p_user_id UUID, p_perm TEXT)
RETURNS BOOLEAN AS $$
DECLARE
  v_role TEXT;
  v_result BOOLEAN;
BEGIN
  SELECT role INTO v_role FROM team_hub_membership
  WHERE hub_id = p_hub_id AND user_id = p_user_id;

  IF v_role = 'admin' THEN RETURN true; END IF;
  IF v_role IS NULL THEN RETURN false; END IF;

  EXECUTE format('SELECT %I FROM team_hub_permissions WHERE hub_id = $1 AND user_id = $2', p_perm)
  INTO v_result USING p_hub_id, p_user_id;

  RETURN COALESCE(v_result, false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- 1.8 — RLS policies for new tables
ALTER TABLE team_hubs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "hub_select" ON team_hubs FOR SELECT
  USING (is_hub_member(id, auth.uid()));
CREATE POLICY "hub_admin_update" ON team_hubs FOR UPDATE
  USING (hub_role(id, auth.uid()) = 'admin');
CREATE POLICY "hub_admin_delete" ON team_hubs FOR DELETE
  USING (hub_role(id, auth.uid()) = 'admin');
CREATE POLICY "hub_insert" ON team_hubs FOR INSERT
  WITH CHECK (created_by = auth.uid());

ALTER TABLE team_hub_membership ENABLE ROW LEVEL SECURITY;
CREATE POLICY "hub_membership_select" ON team_hub_membership FOR SELECT
  USING (is_hub_member(hub_id, auth.uid()));
CREATE POLICY "hub_membership_insert" ON team_hub_membership FOR INSERT
  WITH CHECK (hub_role(hub_id, auth.uid()) = 'admin' OR NOT EXISTS(SELECT 1 FROM team_hub_membership WHERE hub_id = team_hub_membership.hub_id));
CREATE POLICY "hub_membership_update" ON team_hub_membership FOR UPDATE
  USING (hub_role(hub_id, auth.uid()) = 'admin');
CREATE POLICY "hub_membership_delete" ON team_hub_membership FOR DELETE
  USING (hub_role(hub_id, auth.uid()) = 'admin');

ALTER TABLE team_hub_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "hub_perms_select_own" ON team_hub_permissions FOR SELECT
  USING (user_id = auth.uid() OR hub_role(hub_id, auth.uid()) = 'admin');
CREATE POLICY "hub_perms_insert" ON team_hub_permissions FOR INSERT
  WITH CHECK (hub_role(hub_id, auth.uid()) = 'admin');
CREATE POLICY "hub_perms_update" ON team_hub_permissions FOR UPDATE
  USING (hub_role(hub_id, auth.uid()) = 'admin');
CREATE POLICY "hub_perms_delete" ON team_hub_permissions FOR DELETE
  USING (hub_role(hub_id, auth.uid()) = 'admin');

-- 1.9 — Hub visibility for workspaces
CREATE POLICY "hub_workspace_select" ON team_workspaces FOR SELECT
  USING (hub_id IS NOT NULL AND is_hub_member(hub_id, auth.uid()));

-- 1.10 — Indexes
CREATE INDEX idx_team_hub_membership_hub ON team_hub_membership(hub_id);
CREATE INDEX idx_team_hub_membership_user ON team_hub_membership(user_id);
CREATE INDEX idx_team_hub_permissions_hub ON team_hub_permissions(hub_id);
CREATE INDEX idx_team_workspaces_hub ON team_workspaces(hub_id);
CREATE INDEX idx_team_statuses_hub ON team_statuses(hub_id);
CREATE INDEX idx_team_tags_hub ON team_tags(hub_id);

-- ============================================================
-- Data Migration (run after schema)
-- ============================================================

-- Hub: Water's Edge (c6a64240-9d3c-4d82-9624-96dae0f07e1a)
-- Members: Dallas (admin), Denise (admin)
-- 25 non-personal workspaces bound to hub
-- 10 hub-level statuses created
-- 50 hub-level tags consolidated
-- Denise's 14 items status-mapped to hub statuses
