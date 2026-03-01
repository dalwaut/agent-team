-- 016_forumbot.sql — ForumBot tables for AI content generation pipeline

-- ForumBot Drafts
CREATE TABLE IF NOT EXISTS forumbot_drafts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'published', 'discarded')),
    post_type TEXT NOT NULL DEFAULT 'general' CHECK (post_type IN ('dev-note', 'poll', 'feature', 'announcement', 'general')),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    content_format TEXT NOT NULL DEFAULT 'markdown',
    tags TEXT[] DEFAULT '{}',
    category_id UUID REFERENCES forum_categories(id) ON DELETE SET NULL,
    poll_data JSONB,
    prompt TEXT,
    batch_id TEXT,
    schedule_id UUID,
    published_post_id UUID REFERENCES forum_posts(id) ON DELETE SET NULL,
    published_at TIMESTAMPTZ,
    published_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ForumBot Schedules
CREATE TABLE IF NOT EXISTS forumbot_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    cron_expr TEXT NOT NULL,
    post_type TEXT NOT NULL DEFAULT 'general' CHECK (post_type IN ('dev-note', 'poll', 'feature', 'announcement', 'general')),
    prompt_template TEXT NOT NULL,
    category_id UUID REFERENCES forum_categories(id) ON DELETE SET NULL,
    tags TEXT[] DEFAULT '{}',
    auto_publish BOOLEAN NOT NULL DEFAULT false,
    conditions JSONB DEFAULT '[]',
    max_drafts INT NOT NULL DEFAULT 1 CHECK (max_drafts BETWEEN 1 AND 5),
    last_run_at TIMESTAMPTZ,
    last_result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ForumBot History
CREATE TABLE IF NOT EXISTS forumbot_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    draft_id UUID REFERENCES forumbot_drafts(id) ON DELETE SET NULL,
    post_id UUID REFERENCES forum_posts(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    details JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- FK from drafts to schedules
ALTER TABLE forumbot_drafts
    ADD CONSTRAINT fk_forumbot_drafts_schedule
    FOREIGN KEY (schedule_id) REFERENCES forumbot_schedules(id) ON DELETE SET NULL;

-- Indexes
CREATE INDEX idx_forumbot_drafts_status ON forumbot_drafts(status);
CREATE INDEX idx_forumbot_drafts_batch ON forumbot_drafts(batch_id);
CREATE INDEX idx_forumbot_history_draft ON forumbot_history(draft_id);
CREATE INDEX idx_forumbot_history_action ON forumbot_history(action);

-- Updated_at triggers
CREATE OR REPLACE FUNCTION update_forumbot_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_forumbot_drafts_updated
    BEFORE UPDATE ON forumbot_drafts
    FOR EACH ROW EXECUTE FUNCTION update_forumbot_updated_at();

CREATE TRIGGER trg_forumbot_schedules_updated
    BEFORE UPDATE ON forumbot_schedules
    FOR EACH ROW EXECUTE FUNCTION update_forumbot_updated_at();

-- RLS (service role only — no public/anon access needed)
ALTER TABLE forumbot_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE forumbot_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE forumbot_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_forumbot_drafts" ON forumbot_drafts FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all_forumbot_schedules" ON forumbot_schedules FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all_forumbot_history" ON forumbot_history FOR ALL USING (auth.role() = 'service_role');
