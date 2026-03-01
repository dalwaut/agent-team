-- 009_forum_tables.sql — Forum tables for OPAI community
-- Tables: categories, posts, comments, votes, reactions, polls

-- ── Categories ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS forum_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    icon TEXT,
    sort_order INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE forum_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read categories"
    ON forum_categories FOR SELECT
    USING (true);

CREATE POLICY "Admins can manage categories"
    ON forum_categories FOR ALL
    USING (
        (SELECT raw_app_meta_data->>'role' FROM auth.users WHERE id = auth.uid()) = 'admin'
    );

-- ── Posts ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS forum_posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    author_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    category_id UUID NOT NULL REFERENCES forum_categories(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    content_format TEXT DEFAULT 'markdown' CHECK (content_format IN ('markdown', 'plain')),
    image_url TEXT,
    image_name TEXT,
    code_snippet TEXT,
    code_language TEXT,
    is_pinned BOOLEAN DEFAULT false,
    is_locked BOOLEAN DEFAULT false,
    view_count INT DEFAULT 0,
    vote_score INT DEFAULT 0,
    comment_count INT DEFAULT 0,
    tags TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

ALTER TABLE forum_posts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read non-deleted posts"
    ON forum_posts FOR SELECT
    USING (deleted_at IS NULL);

CREATE POLICY "Authenticated users can create posts"
    ON forum_posts FOR INSERT
    WITH CHECK (auth.uid() = author_id);

CREATE POLICY "Users can update own posts"
    ON forum_posts FOR UPDATE
    USING (auth.uid() = author_id)
    WITH CHECK (auth.uid() = author_id);

CREATE POLICY "Admins can manage all posts"
    ON forum_posts FOR ALL
    USING (
        (SELECT raw_app_meta_data->>'role' FROM auth.users WHERE id = auth.uid()) = 'admin'
    );

-- ── Comments ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS forum_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id UUID NOT NULL REFERENCES forum_posts(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES forum_comments(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    content_format TEXT DEFAULT 'markdown' CHECK (content_format IN ('markdown', 'plain')),
    vote_score INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

ALTER TABLE forum_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read non-deleted comments"
    ON forum_comments FOR SELECT
    USING (deleted_at IS NULL);

CREATE POLICY "Authenticated users can create comments"
    ON forum_comments FOR INSERT
    WITH CHECK (auth.uid() = author_id);

CREATE POLICY "Users can update own comments"
    ON forum_comments FOR UPDATE
    USING (auth.uid() = author_id AND deleted_at IS NULL)
    WITH CHECK (auth.uid() = author_id);

CREATE POLICY "Admins can manage all comments"
    ON forum_comments FOR ALL
    USING (
        (SELECT raw_app_meta_data->>'role' FROM auth.users WHERE id = auth.uid()) = 'admin'
    );

-- ── Votes ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS forum_votes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    post_id UUID REFERENCES forum_posts(id) ON DELETE CASCADE,
    comment_id UUID REFERENCES forum_comments(id) ON DELETE CASCADE,
    value INT NOT NULL CHECK (value IN (1, -1)),
    created_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT vote_target CHECK (
        (post_id IS NOT NULL AND comment_id IS NULL) OR
        (post_id IS NULL AND comment_id IS NOT NULL)
    ),
    CONSTRAINT unique_post_vote UNIQUE (user_id, post_id),
    CONSTRAINT unique_comment_vote UNIQUE (user_id, comment_id)
);

ALTER TABLE forum_votes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read votes"
    ON forum_votes FOR SELECT
    USING (true);

CREATE POLICY "Authenticated users can vote"
    ON forum_votes FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can change own votes"
    ON forum_votes FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can remove own votes"
    ON forum_votes FOR DELETE
    USING (auth.uid() = user_id);

-- ── Reactions ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS forum_reactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    post_id UUID REFERENCES forum_posts(id) ON DELETE CASCADE,
    comment_id UUID REFERENCES forum_comments(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT reaction_target CHECK (
        (post_id IS NOT NULL AND comment_id IS NULL) OR
        (post_id IS NULL AND comment_id IS NOT NULL)
    ),
    CONSTRAINT unique_post_reaction UNIQUE (user_id, post_id, emoji),
    CONSTRAINT unique_comment_reaction UNIQUE (user_id, comment_id, emoji)
);

ALTER TABLE forum_reactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read reactions"
    ON forum_reactions FOR SELECT
    USING (true);

CREATE POLICY "Authenticated users can react"
    ON forum_reactions FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can remove own reactions"
    ON forum_reactions FOR DELETE
    USING (auth.uid() = user_id);

-- ── Polls ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS forum_polls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id UUID NOT NULL UNIQUE REFERENCES forum_posts(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    allow_multiple BOOLEAN DEFAULT false,
    closes_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE forum_polls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read polls"
    ON forum_polls FOR SELECT
    USING (true);

CREATE POLICY "Post author can create poll"
    ON forum_polls FOR INSERT
    WITH CHECK (
        EXISTS (SELECT 1 FROM forum_posts WHERE id = post_id AND author_id = auth.uid())
    );

-- ── Poll Options ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS forum_poll_options (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    poll_id UUID NOT NULL REFERENCES forum_polls(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    sort_order INT DEFAULT 0,
    vote_count INT DEFAULT 0
);

ALTER TABLE forum_poll_options ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read poll options"
    ON forum_poll_options FOR SELECT
    USING (true);

CREATE POLICY "Poll creator can add options"
    ON forum_poll_options FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM forum_polls p
            JOIN forum_posts fp ON fp.id = p.post_id
            WHERE p.id = poll_id AND fp.author_id = auth.uid()
        )
    );

-- ── Poll Votes ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS forum_poll_votes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    poll_id UUID NOT NULL REFERENCES forum_polls(id) ON DELETE CASCADE,
    option_id UUID NOT NULL REFERENCES forum_poll_options(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT unique_poll_vote UNIQUE (poll_id, option_id, user_id)
);

ALTER TABLE forum_poll_votes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read poll votes"
    ON forum_poll_votes FOR SELECT
    USING (true);

CREATE POLICY "Authenticated users can vote in polls"
    ON forum_poll_votes FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can remove own poll votes"
    ON forum_poll_votes FOR DELETE
    USING (auth.uid() = user_id);

-- ── Indexes ───────────────────────────────────────────────────

CREATE INDEX idx_forum_posts_category ON forum_posts(category_id, created_at DESC);
CREATE INDEX idx_forum_posts_author ON forum_posts(author_id);
CREATE INDEX idx_forum_posts_search ON forum_posts USING gin(to_tsvector('english', title || ' ' || content));
CREATE INDEX idx_forum_comments_post ON forum_comments(post_id, created_at);
CREATE INDEX idx_forum_votes_post ON forum_votes(post_id);
CREATE INDEX idx_forum_votes_comment ON forum_votes(comment_id);
CREATE INDEX idx_forum_reactions_post ON forum_reactions(post_id);
CREATE INDEX idx_forum_reactions_comment ON forum_reactions(comment_id);

-- ── Seed Categories ───────────────────────────────────────────

INSERT INTO forum_categories (name, slug, description, icon, sort_order) VALUES
    ('General', 'general', 'General discussion and announcements', '💬', 1),
    ('Dev', 'dev', 'Development topics, code questions, and technical discussions', '💻', 2),
    ('Showcase', 'showcase', 'Show off your projects and builds', '🚀', 3),
    ('Feedback', 'feedback', 'Suggestions, feature requests, and bug reports', '📝', 4),
    ('Off-Topic', 'off-topic', 'Casual conversation and fun stuff', '🎲', 5)
ON CONFLICT (slug) DO NOTHING;
