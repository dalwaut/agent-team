-- 012_team_hub.sql — OPAI Team Hub schema
-- ClickUp-style task/project management with workspaces, items, assignments, comments, tags

-- Add discord_id to profiles for Discord↔OPAI user mapping
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS discord_id TEXT;

-- ── Workspaces ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS team_workspaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    icon TEXT DEFAULT '📁',
    owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    is_personal BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE team_workspaces ENABLE ROW LEVEL SECURITY;

-- ── Membership ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS team_membership (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, workspace_id)
);

ALTER TABLE team_membership ENABLE ROW LEVEL SECURITY;

-- ── Items (tasks, notes, ideas, decisions) ──────────────────

CREATE TABLE IF NOT EXISTS team_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
    type TEXT NOT NULL DEFAULT 'task' CHECK (type IN ('task', 'note', 'idea', 'decision', 'bug')),
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'review', 'done', 'archived')),
    priority TEXT DEFAULT 'medium' CHECK (priority IN ('critical', 'high', 'medium', 'low', 'none')),
    due_date DATE,
    created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    source TEXT DEFAULT 'web',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_items_workspace ON team_items(workspace_id);
CREATE INDEX IF NOT EXISTS idx_team_items_status ON team_items(status);
CREATE INDEX IF NOT EXISTS idx_team_items_created_by ON team_items(created_by);
CREATE INDEX IF NOT EXISTS idx_team_items_type ON team_items(type);

ALTER TABLE team_items ENABLE ROW LEVEL SECURITY;

-- ── Assignments ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS team_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id UUID NOT NULL REFERENCES team_items(id) ON DELETE CASCADE,
    assignee_type TEXT NOT NULL DEFAULT 'user' CHECK (assignee_type IN ('user', 'agent', 'squad')),
    assignee_id TEXT NOT NULL,
    assigned_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(item_id, assignee_type, assignee_id)
);

CREATE INDEX IF NOT EXISTS idx_team_assignments_item ON team_assignments(item_id);
CREATE INDEX IF NOT EXISTS idx_team_assignments_assignee ON team_assignments(assignee_type, assignee_id);

ALTER TABLE team_assignments ENABLE ROW LEVEL SECURITY;

-- ── Comments ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS team_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id UUID NOT NULL REFERENCES team_items(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    is_agent_report BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_comments_item ON team_comments(item_id);

ALTER TABLE team_comments ENABLE ROW LEVEL SECURITY;

-- ── Tags ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS team_tags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#6366f1',
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(workspace_id, name)
);

ALTER TABLE team_tags ENABLE ROW LEVEL SECURITY;

-- ── Item-Tag junction ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS team_item_tags (
    item_id UUID NOT NULL REFERENCES team_items(id) ON DELETE CASCADE,
    tag_id UUID NOT NULL REFERENCES team_tags(id) ON DELETE CASCADE,
    PRIMARY KEY (item_id, tag_id)
);

ALTER TABLE team_item_tags ENABLE ROW LEVEL SECURITY;

-- ── Notifications ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS team_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    type TEXT NOT NULL DEFAULT 'info',
    title TEXT NOT NULL,
    body TEXT DEFAULT '',
    item_id UUID REFERENCES team_items(id) ON DELETE CASCADE,
    workspace_id UUID REFERENCES team_workspaces(id) ON DELETE CASCADE,
    read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_notifications_user ON team_notifications(user_id, read);

ALTER TABLE team_notifications ENABLE ROW LEVEL SECURITY;

-- ── Activity Log ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS team_activity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id UUID REFERENCES team_items(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
    actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    details JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_activity_workspace ON team_activity(workspace_id);
CREATE INDEX IF NOT EXISTS idx_team_activity_item ON team_activity(item_id);

ALTER TABLE team_activity ENABLE ROW LEVEL SECURITY;

-- ── Invitations ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS team_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
    inviter_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    invitee_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    invitee_email TEXT,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member', 'viewer')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE team_invitations ENABLE ROW LEVEL SECURITY;


-- ════════════════════════════════════════════════════════════
-- RLS Policies
-- ════════════════════════════════════════════════════════════

-- Helper: check if user is member of workspace
CREATE OR REPLACE FUNCTION is_workspace_member(ws_id UUID, usr_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM team_membership
        WHERE workspace_id = ws_id AND user_id = usr_id
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Helper: check workspace role
CREATE OR REPLACE FUNCTION workspace_role(ws_id UUID, usr_id UUID)
RETURNS TEXT AS $$
    SELECT role FROM team_membership
    WHERE workspace_id = ws_id AND user_id = usr_id
    LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Workspaces: members can read, owners can modify
CREATE POLICY workspace_select ON team_workspaces FOR SELECT
    USING (is_workspace_member(id, auth.uid()));

CREATE POLICY workspace_insert ON team_workspaces FOR INSERT
    WITH CHECK (owner_id = auth.uid());

CREATE POLICY workspace_update ON team_workspaces FOR UPDATE
    USING (workspace_role(id, auth.uid()) IN ('owner', 'admin'));

CREATE POLICY workspace_delete ON team_workspaces FOR DELETE
    USING (owner_id = auth.uid());

-- Membership: members can see who's in their workspaces
CREATE POLICY membership_select ON team_membership FOR SELECT
    USING (is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY membership_insert ON team_membership FOR INSERT
    WITH CHECK (workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));

CREATE POLICY membership_update ON team_membership FOR UPDATE
    USING (workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));

CREATE POLICY membership_delete ON team_membership FOR DELETE
    USING (workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));

-- Items: workspace members can read, creators/admins can modify
CREATE POLICY items_select ON team_items FOR SELECT
    USING (is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY items_insert ON team_items FOR INSERT
    WITH CHECK (is_workspace_member(workspace_id, auth.uid()) AND created_by = auth.uid());

CREATE POLICY items_update ON team_items FOR UPDATE
    USING (
        created_by = auth.uid()
        OR workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin')
    );

CREATE POLICY items_delete ON team_items FOR DELETE
    USING (
        created_by = auth.uid()
        OR workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin')
    );

-- Assignments: workspace members can read, admins/creators can modify
CREATE POLICY assignments_select ON team_assignments FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM team_items i
        WHERE i.id = item_id AND is_workspace_member(i.workspace_id, auth.uid())
    ));

CREATE POLICY assignments_insert ON team_assignments FOR INSERT
    WITH CHECK (EXISTS (
        SELECT 1 FROM team_items i
        WHERE i.id = item_id AND is_workspace_member(i.workspace_id, auth.uid())
    ));

CREATE POLICY assignments_delete ON team_assignments FOR DELETE
    USING (EXISTS (
        SELECT 1 FROM team_items i
        WHERE i.id = item_id AND (
            i.created_by = auth.uid()
            OR workspace_role(i.workspace_id, auth.uid()) IN ('owner', 'admin')
        )
    ));

-- Comments: workspace members can read and create
CREATE POLICY comments_select ON team_comments FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM team_items i
        WHERE i.id = item_id AND is_workspace_member(i.workspace_id, auth.uid())
    ));

CREATE POLICY comments_insert ON team_comments FOR INSERT
    WITH CHECK (author_id = auth.uid() AND EXISTS (
        SELECT 1 FROM team_items i
        WHERE i.id = item_id AND is_workspace_member(i.workspace_id, auth.uid())
    ));

CREATE POLICY comments_update ON team_comments FOR UPDATE
    USING (author_id = auth.uid());

CREATE POLICY comments_delete ON team_comments FOR DELETE
    USING (author_id = auth.uid());

-- Tags: workspace members can read, admins can manage
CREATE POLICY tags_select ON team_tags FOR SELECT
    USING (is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY tags_insert ON team_tags FOR INSERT
    WITH CHECK (is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY tags_delete ON team_tags FOR DELETE
    USING (workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));

-- Item Tags: same as items
CREATE POLICY item_tags_select ON team_item_tags FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM team_items i
        WHERE i.id = item_id AND is_workspace_member(i.workspace_id, auth.uid())
    ));

CREATE POLICY item_tags_insert ON team_item_tags FOR INSERT
    WITH CHECK (EXISTS (
        SELECT 1 FROM team_items i
        WHERE i.id = item_id AND is_workspace_member(i.workspace_id, auth.uid())
    ));

CREATE POLICY item_tags_delete ON team_item_tags FOR DELETE
    USING (EXISTS (
        SELECT 1 FROM team_items i
        WHERE i.id = item_id AND is_workspace_member(i.workspace_id, auth.uid())
    ));

-- Notifications: users can only see their own
CREATE POLICY notifications_select ON team_notifications FOR SELECT
    USING (user_id = auth.uid());

CREATE POLICY notifications_update ON team_notifications FOR UPDATE
    USING (user_id = auth.uid());

-- Activity: workspace members can read
CREATE POLICY activity_select ON team_activity FOR SELECT
    USING (is_workspace_member(workspace_id, auth.uid()));

-- Invitations: inviter and invitee can see
CREATE POLICY invitations_select ON team_invitations FOR SELECT
    USING (inviter_id = auth.uid() OR invitee_id = auth.uid());

CREATE POLICY invitations_insert ON team_invitations FOR INSERT
    WITH CHECK (workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));

CREATE POLICY invitations_update ON team_invitations FOR UPDATE
    USING (invitee_id = auth.uid());


-- ════════════════════════════════════════════════════════════
-- Auto-create personal workspace on first login
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION create_personal_workspace()
RETURNS TRIGGER AS $$
DECLARE
    ws_id UUID;
    display TEXT;
BEGIN
    -- Check if personal workspace already exists
    IF EXISTS (SELECT 1 FROM team_workspaces WHERE owner_id = NEW.id AND is_personal = TRUE) THEN
        RETURN NEW;
    END IF;

    display := COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1));

    INSERT INTO team_workspaces (name, slug, icon, owner_id, is_personal)
    VALUES (display || '''s Space', 'personal-' || REPLACE(NEW.id::TEXT, '-', ''), '🏠', NEW.id, TRUE)
    RETURNING id INTO ws_id;

    INSERT INTO team_membership (user_id, workspace_id, role)
    VALUES (NEW.id, ws_id, 'owner');

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger on auth.users insert (new signups)
DROP TRIGGER IF EXISTS on_auth_user_created_team_hub ON auth.users;
CREATE TRIGGER on_auth_user_created_team_hub
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION create_personal_workspace();

-- Create personal workspaces for existing users who don't have one
DO $$
DECLARE
    u RECORD;
    ws_id UUID;
    display TEXT;
BEGIN
    FOR u IN SELECT id, email, raw_user_meta_data FROM auth.users
             WHERE id NOT IN (SELECT owner_id FROM team_workspaces WHERE is_personal = TRUE)
    LOOP
        display := COALESCE(u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1));
        INSERT INTO team_workspaces (name, slug, icon, owner_id, is_personal)
        VALUES (display || '''s Space', 'personal-' || REPLACE(u.id::TEXT, '-', ''), '🏠', u.id, TRUE)
        RETURNING id INTO ws_id;

        INSERT INTO team_membership (user_id, workspace_id, role)
        VALUES (u.id, ws_id, 'owner');
    END LOOP;
END;
$$;
