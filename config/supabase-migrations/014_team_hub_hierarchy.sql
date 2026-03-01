-- 014_team_hub_hierarchy.sql — Folders, lists, statuses, files, dashboards
-- Transforms Team Hub from ClickUp proxy to standalone Supabase-native PM tool

-- ══════════════════════════════════════════════════════════════
-- Schema changes to existing tables
-- ══════════════════════════════════════════════════════════════

-- Drop restrictive status CHECK (custom statuses per workspace now)
ALTER TABLE team_items DROP CONSTRAINT IF EXISTS team_items_status_check;

-- Add hierarchy columns to items
ALTER TABLE team_items ADD COLUMN IF NOT EXISTS list_id UUID;
ALTER TABLE team_items ADD COLUMN IF NOT EXISTS folder_id UUID;

-- Add workspace color + description
ALTER TABLE team_workspaces ADD COLUMN IF NOT EXISTS color TEXT DEFAULT '#6c5ce7';
ALTER TABLE team_workspaces ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';

-- ══════════════════════════════════════════════════════════════
-- New tables
-- ══════════════════════════════════════════════════════════════

-- ── Folders (within a space/workspace) ────────────────────────

CREATE TABLE IF NOT EXISTS team_folders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    orderindex INT DEFAULT 0,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_folders_workspace ON team_folders(workspace_id);
ALTER TABLE team_folders ENABLE ROW LEVEL SECURITY;

-- ── Lists (within a folder OR directly in a workspace) ────────

CREATE TABLE IF NOT EXISTS team_lists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
    folder_id UUID REFERENCES team_folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    orderindex INT DEFAULT 0,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_lists_workspace ON team_lists(workspace_id);
CREATE INDEX IF NOT EXISTS idx_team_lists_folder ON team_lists(folder_id);
ALTER TABLE team_lists ENABLE ROW LEVEL SECURITY;

-- Now add FK constraints on team_items
ALTER TABLE team_items ADD CONSTRAINT fk_items_list
    FOREIGN KEY (list_id) REFERENCES team_lists(id) ON DELETE SET NULL;
ALTER TABLE team_items ADD CONSTRAINT fk_items_folder
    FOREIGN KEY (folder_id) REFERENCES team_folders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_team_items_list ON team_items(list_id);
CREATE INDEX IF NOT EXISTS idx_team_items_folder ON team_items(folder_id);

-- ── Statuses (custom per workspace) ───────────────────────────

CREATE TABLE IF NOT EXISTS team_statuses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#595d66',
    type TEXT DEFAULT 'active' CHECK (type IN ('open', 'active', 'done', 'closed')),
    orderindex INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(workspace_id, name)
);

CREATE INDEX IF NOT EXISTS idx_team_statuses_workspace ON team_statuses(workspace_id);
ALTER TABLE team_statuses ENABLE ROW LEVEL SECURITY;

-- ── Files (attachable to workspace, folder, list, or item) ────

CREATE TABLE IF NOT EXISTS team_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
    folder_id UUID REFERENCES team_folders(id) ON DELETE SET NULL,
    list_id UUID REFERENCES team_lists(id) ON DELETE SET NULL,
    item_id UUID REFERENCES team_items(id) ON DELETE SET NULL,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size BIGINT DEFAULT 0,
    mime_type TEXT DEFAULT 'application/octet-stream',
    uploaded_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    shared BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_files_workspace ON team_files(workspace_id);
CREATE INDEX IF NOT EXISTS idx_team_files_item ON team_files(item_id);
ALTER TABLE team_files ENABLE ROW LEVEL SECURITY;

-- ── Dashboards ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS team_dashboards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT 'Overview',
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_dashboards_workspace ON team_dashboards(workspace_id);
ALTER TABLE team_dashboards ENABLE ROW LEVEL SECURITY;

-- ── Dashboard Widgets ─────────────────────────────────────────
-- widget_type: task_count, status_chart, priority_chart, recent_activity,
--              due_soon, member_workload, custom_text, embed

CREATE TABLE IF NOT EXISTS team_dashboard_widgets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dashboard_id UUID NOT NULL REFERENCES team_dashboards(id) ON DELETE CASCADE,
    widget_type TEXT NOT NULL,
    title TEXT DEFAULT '',
    config JSONB DEFAULT '{}',
    position JSONB DEFAULT '{"x": 0, "y": 0, "w": 4, "h": 3}',
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_widgets_dashboard ON team_dashboard_widgets(dashboard_id);
ALTER TABLE team_dashboard_widgets ENABLE ROW LEVEL SECURITY;


-- ══════════════════════════════════════════════════════════════
-- RLS Policies for new tables
-- ══════════════════════════════════════════════════════════════

-- Folders
CREATE POLICY folders_select ON team_folders FOR SELECT
    USING (is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY folders_insert ON team_folders FOR INSERT
    WITH CHECK (is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY folders_update ON team_folders FOR UPDATE
    USING (workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin', 'member'));
CREATE POLICY folders_delete ON team_folders FOR DELETE
    USING (workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));

-- Lists
CREATE POLICY lists_select ON team_lists FOR SELECT
    USING (is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY lists_insert ON team_lists FOR INSERT
    WITH CHECK (is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY lists_update ON team_lists FOR UPDATE
    USING (workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin', 'member'));
CREATE POLICY lists_delete ON team_lists FOR DELETE
    USING (workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));

-- Statuses
CREATE POLICY statuses_select ON team_statuses FOR SELECT
    USING (is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY statuses_insert ON team_statuses FOR INSERT
    WITH CHECK (workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));
CREATE POLICY statuses_update ON team_statuses FOR UPDATE
    USING (workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));
CREATE POLICY statuses_delete ON team_statuses FOR DELETE
    USING (workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));

-- Files
CREATE POLICY files_select ON team_files FOR SELECT
    USING (is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY files_insert ON team_files FOR INSERT
    WITH CHECK (is_workspace_member(workspace_id, auth.uid()) AND uploaded_by = auth.uid());
CREATE POLICY files_delete ON team_files FOR DELETE
    USING (uploaded_by = auth.uid() OR workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));

-- Dashboards
CREATE POLICY dashboards_select ON team_dashboards FOR SELECT
    USING (is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY dashboards_insert ON team_dashboards FOR INSERT
    WITH CHECK (workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));
CREATE POLICY dashboards_update ON team_dashboards FOR UPDATE
    USING (workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));
CREATE POLICY dashboards_delete ON team_dashboards FOR DELETE
    USING (workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));

-- Dashboard Widgets
CREATE POLICY widgets_select ON team_dashboard_widgets FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM team_dashboards d
        WHERE d.id = dashboard_id AND is_workspace_member(d.workspace_id, auth.uid())
    ));
CREATE POLICY widgets_insert ON team_dashboard_widgets FOR INSERT
    WITH CHECK (EXISTS (
        SELECT 1 FROM team_dashboards d
        WHERE d.id = dashboard_id AND workspace_role(d.workspace_id, auth.uid()) IN ('owner', 'admin')
    ));
CREATE POLICY widgets_update ON team_dashboard_widgets FOR UPDATE
    USING (EXISTS (
        SELECT 1 FROM team_dashboards d
        WHERE d.id = dashboard_id AND workspace_role(d.workspace_id, auth.uid()) IN ('owner', 'admin')
    ));
CREATE POLICY widgets_delete ON team_dashboard_widgets FOR DELETE
    USING (EXISTS (
        SELECT 1 FROM team_dashboards d
        WHERE d.id = dashboard_id AND workspace_role(d.workspace_id, auth.uid()) IN ('owner', 'admin')
    ));


-- ══════════════════════════════════════════════════════════════
-- Triggers: auto-create defaults for new workspaces
-- ══════════════════════════════════════════════════════════════

-- Default statuses for new workspaces
CREATE OR REPLACE FUNCTION create_default_statuses()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO team_statuses (workspace_id, name, color, type, orderindex) VALUES
        (NEW.id, 'open', '#d3d3d3', 'open', 0),
        (NEW.id, 'to do', '#74b9ff', 'open', 1),
        (NEW.id, 'in progress', '#fdcb6e', 'active', 2),
        (NEW.id, 'review', '#6c5ce7', 'active', 3),
        (NEW.id, 'done', '#00b894', 'done', 4),
        (NEW.id, 'closed', '#8b8e96', 'closed', 5);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_workspace_default_statuses
    AFTER INSERT ON team_workspaces
    FOR EACH ROW
    EXECUTE FUNCTION create_default_statuses();

-- Default dashboard for new workspaces
CREATE OR REPLACE FUNCTION create_default_dashboard()
RETURNS TRIGGER AS $$
DECLARE
    dash_id UUID;
BEGIN
    INSERT INTO team_dashboards (workspace_id, name, created_by)
    VALUES (NEW.id, 'Overview', NEW.owner_id)
    RETURNING id INTO dash_id;

    -- Seed default widgets
    INSERT INTO team_dashboard_widgets (dashboard_id, widget_type, title, position) VALUES
        (dash_id, 'status_chart', 'Tasks by Status', '{"x":0,"y":0,"w":6,"h":4}'),
        (dash_id, 'priority_chart', 'Priority Breakdown', '{"x":6,"y":0,"w":6,"h":4}'),
        (dash_id, 'due_soon', 'Due Soon', '{"x":0,"y":4,"w":6,"h":4}'),
        (dash_id, 'recent_activity', 'Recent Activity', '{"x":6,"y":4,"w":6,"h":4}');

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_workspace_default_dashboard
    AFTER INSERT ON team_workspaces
    FOR EACH ROW
    EXECUTE FUNCTION create_default_dashboard();


-- ══════════════════════════════════════════════════════════════
-- Seed statuses + dashboards for existing workspaces
-- ══════════════════════════════════════════════════════════════

INSERT INTO team_statuses (workspace_id, name, color, type, orderindex)
SELECT w.id, s.name, s.color, s.type, s.orderindex
FROM team_workspaces w
CROSS JOIN (VALUES
    ('open', '#d3d3d3', 'open', 0),
    ('to do', '#74b9ff', 'open', 1),
    ('in progress', '#fdcb6e', 'active', 2),
    ('review', '#6c5ce7', 'active', 3),
    ('done', '#00b894', 'done', 4),
    ('closed', '#8b8e96', 'closed', 5)
) AS s(name, color, type, orderindex)
ON CONFLICT (workspace_id, name) DO NOTHING;

-- Create default dashboards for existing workspaces that don't have one
INSERT INTO team_dashboards (workspace_id, name, created_by)
SELECT w.id, 'Overview', w.owner_id
FROM team_workspaces w
WHERE NOT EXISTS (SELECT 1 FROM team_dashboards d WHERE d.workspace_id = w.id);


-- ══════════════════════════════════════════════════════════════
-- Supabase Storage bucket for team files
-- ══════════════════════════════════════════════════════════════

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('team-files', 'team-files', false, 52428800, NULL)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS: authenticated users can read/write team files
CREATE POLICY storage_team_files_select ON storage.objects FOR SELECT
    USING (bucket_id = 'team-files' AND auth.role() = 'authenticated');

CREATE POLICY storage_team_files_insert ON storage.objects FOR INSERT
    WITH CHECK (bucket_id = 'team-files' AND auth.role() = 'authenticated');

CREATE POLICY storage_team_files_update ON storage.objects FOR UPDATE
    USING (bucket_id = 'team-files' AND auth.role() = 'authenticated');

CREATE POLICY storage_team_files_delete ON storage.objects FOR DELETE
    USING (bucket_id = 'team-files' AND auth.role() = 'authenticated');


-- ══════════════════════════════════════════════════════════════
-- Enable Realtime for key tables
-- ══════════════════════════════════════════════════════════════

ALTER PUBLICATION supabase_realtime ADD TABLE team_items;
ALTER PUBLICATION supabase_realtime ADD TABLE team_comments;
ALTER PUBLICATION supabase_realtime ADD TABLE team_notifications;
ALTER PUBLICATION supabase_realtime ADD TABLE team_activity;
