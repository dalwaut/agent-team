-- 021_team_docs.sql — Team Hub Docs (ClickUp Docs import + native docs)
-- Rich-text documents attached to workspace, folder, list, or task

-- ══════════════════════════════════════════════════════════════
-- team_docs — document headers
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS team_docs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
    folder_id UUID REFERENCES team_folders(id) ON DELETE SET NULL,
    list_id UUID REFERENCES team_lists(id) ON DELETE SET NULL,
    item_id UUID REFERENCES team_items(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    content TEXT DEFAULT '',
    source TEXT DEFAULT 'native',  -- 'native' or 'clickup'
    source_id TEXT,                -- original ClickUp doc ID
    created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_docs_workspace ON team_docs(workspace_id);
CREATE INDEX IF NOT EXISTS idx_team_docs_folder ON team_docs(folder_id);
CREATE INDEX IF NOT EXISTS idx_team_docs_list ON team_docs(list_id);
CREATE INDEX IF NOT EXISTS idx_team_docs_item ON team_docs(item_id);
CREATE INDEX IF NOT EXISTS idx_team_docs_source_id ON team_docs(source_id);
ALTER TABLE team_docs ENABLE ROW LEVEL SECURITY;

-- ══════════════════════════════════════════════════════════════
-- team_doc_pages — individual pages within a doc
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS team_doc_pages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_id UUID NOT NULL REFERENCES team_docs(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'Untitled',
    content TEXT DEFAULT '',
    orderindex INT DEFAULT 0,
    source_id TEXT,               -- original ClickUp page ID
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_doc_pages_doc ON team_doc_pages(doc_id);
ALTER TABLE team_doc_pages ENABLE ROW LEVEL SECURITY;


-- ══════════════════════════════════════════════════════════════
-- RLS Policies
-- ══════════════════════════════════════════════════════════════

-- Docs: workspace members can read, creators/admins can modify
CREATE POLICY docs_select ON team_docs FOR SELECT
    USING (is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY docs_insert ON team_docs FOR INSERT
    WITH CHECK (is_workspace_member(workspace_id, auth.uid()) AND created_by = auth.uid());

CREATE POLICY docs_update ON team_docs FOR UPDATE
    USING (
        created_by = auth.uid()
        OR workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin')
    );

CREATE POLICY docs_delete ON team_docs FOR DELETE
    USING (
        created_by = auth.uid()
        OR workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin')
    );

-- Doc Pages: inherit access from parent doc
CREATE POLICY doc_pages_select ON team_doc_pages FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM team_docs d
        WHERE d.id = doc_id AND is_workspace_member(d.workspace_id, auth.uid())
    ));

CREATE POLICY doc_pages_insert ON team_doc_pages FOR INSERT
    WITH CHECK (EXISTS (
        SELECT 1 FROM team_docs d
        WHERE d.id = doc_id AND is_workspace_member(d.workspace_id, auth.uid())
    ));

CREATE POLICY doc_pages_update ON team_doc_pages FOR UPDATE
    USING (EXISTS (
        SELECT 1 FROM team_docs d
        WHERE d.id = doc_id AND (
            d.created_by = auth.uid()
            OR workspace_role(d.workspace_id, auth.uid()) IN ('owner', 'admin')
        )
    ));

CREATE POLICY doc_pages_delete ON team_doc_pages FOR DELETE
    USING (EXISTS (
        SELECT 1 FROM team_docs d
        WHERE d.id = doc_id AND (
            d.created_by = auth.uid()
            OR workspace_role(d.workspace_id, auth.uid()) IN ('owner', 'admin')
        )
    ));
