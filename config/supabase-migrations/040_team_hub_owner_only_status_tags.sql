-- Migration 040: Restrict status/tag management to workspace owner only
-- Previously: owner + admin could manage statuses; any member could create tags
-- Now: only owner can INSERT/UPDATE/DELETE on team_statuses and team_tags
-- SELECT policies unchanged (any member can read)
-- team_item_tags policies unchanged (any member can assign/unassign tags)

-- ═══════════════════════════════════════════════════════
-- team_statuses: tighten INSERT/UPDATE/DELETE to owner only
-- ═══════════════════════════════════════════════════════

DROP POLICY IF EXISTS statuses_insert ON team_statuses;
DROP POLICY IF EXISTS statuses_update ON team_statuses;
DROP POLICY IF EXISTS statuses_delete ON team_statuses;

CREATE POLICY statuses_insert ON team_statuses FOR INSERT
    WITH CHECK (workspace_role(workspace_id, auth.uid()) = 'owner');

CREATE POLICY statuses_update ON team_statuses FOR UPDATE
    USING (workspace_role(workspace_id, auth.uid()) = 'owner');

CREATE POLICY statuses_delete ON team_statuses FOR DELETE
    USING (workspace_role(workspace_id, auth.uid()) = 'owner');

-- ═══════════════════════════════════════════════════════
-- team_tags: tighten INSERT/DELETE + add missing UPDATE policy
-- ═══════════════════════════════════════════════════════

DROP POLICY IF EXISTS tags_insert ON team_tags;
DROP POLICY IF EXISTS tags_update ON team_tags;
DROP POLICY IF EXISTS tags_delete ON team_tags;

CREATE POLICY tags_insert ON team_tags FOR INSERT
    WITH CHECK (workspace_role(workspace_id, auth.uid()) = 'owner');

CREATE POLICY tags_update ON team_tags FOR UPDATE
    USING (workspace_role(workspace_id, auth.uid()) = 'owner');

CREATE POLICY tags_delete ON team_tags FOR DELETE
    USING (workspace_role(workspace_id, auth.uid()) = 'owner');
