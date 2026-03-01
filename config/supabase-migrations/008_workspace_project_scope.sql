-- 008: Add project scope columns to dev_workspaces
-- Supports project-scoped IDE workspaces (mount specific project folder).

ALTER TABLE public.dev_workspaces
    ADD COLUMN IF NOT EXISTS project_name TEXT,
    ADD COLUMN IF NOT EXISTS project_path TEXT;
