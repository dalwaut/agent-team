-- 028_brain.sql — 2nd Brain cognitive layer schema
-- Run via: ./scripts/supabase-sql.sh < config/supabase-migrations/028_brain.sql

-- ─── Enable pgvector ──────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS vector;

-- ─── Core nodes (notes, concepts, questions, inbox items) ────────────────────

CREATE TABLE IF NOT EXISTS brain_nodes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type        text NOT NULL DEFAULT 'note',   -- 'note' | 'concept' | 'question' | 'inbox'
  title       text NOT NULL DEFAULT '',
  content     text NOT NULL DEFAULT '',
  metadata    jsonb NOT NULL DEFAULT '{}',
  embedding   vector(1536),                   -- nullable; populated in Phase 2
  fts_vector  tsvector,                       -- auto-populated via trigger
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- ─── Links between nodes ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS brain_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_id   uuid NOT NULL REFERENCES brain_nodes(id) ON DELETE CASCADE,
  target_id   uuid NOT NULL REFERENCES brain_nodes(id) ON DELETE CASCADE,
  label       text,
  link_type   text DEFAULT 'related',        -- 'related' | 'supports' | 'contradicts' | 'derived_from'
  strength    float DEFAULT 1.0,
  created_at  timestamptz DEFAULT now(),
  UNIQUE (source_id, target_id)
);

-- ─── Tags ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS brain_tags (
  node_id     uuid NOT NULL REFERENCES brain_nodes(id) ON DELETE CASCADE,
  tag         text NOT NULL,
  PRIMARY KEY (node_id, tag)
);

-- ─── Agentic research sessions (Phase 2) ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS brain_research (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  query       text NOT NULL,
  status      text DEFAULT 'pending',        -- 'pending' | 'running' | 'done' | 'failed'
  result_node uuid REFERENCES brain_nodes(id) ON DELETE SET NULL,
  sources     jsonb DEFAULT '[]',
  created_at  timestamptz DEFAULT now()
);

-- ─── Node snapshots / version history ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS brain_snapshots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id     uuid NOT NULL REFERENCES brain_nodes(id) ON DELETE CASCADE,
  content     text NOT NULL DEFAULT '',
  summary     text,
  created_at  timestamptz DEFAULT now()
);

-- ─── User API keys for AI providers (Phase 2) ────────────────────────────────

CREATE TABLE IF NOT EXISTS brain_api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider      text NOT NULL,               -- 'anthropic' | 'openai' | 'voyage'
  key_encrypted text NOT NULL,
  created_at    timestamptz DEFAULT now(),
  UNIQUE (user_id, provider)
);

-- ─── Full-text search trigger ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION brain_nodes_fts_update()
RETURNS trigger AS $$
BEGIN
  NEW.fts_vector := to_tsvector('english',
    coalesce(NEW.title, '') || ' ' || coalesce(NEW.content, '')
  );
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS brain_nodes_fts_trigger ON brain_nodes;
CREATE TRIGGER brain_nodes_fts_trigger
  BEFORE INSERT OR UPDATE ON brain_nodes
  FOR EACH ROW EXECUTE FUNCTION brain_nodes_fts_update();

-- ─── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS brain_nodes_fts_idx    ON brain_nodes USING GIN (fts_vector);
CREATE INDEX IF NOT EXISTS brain_nodes_user_idx   ON brain_nodes (user_id, type, updated_at DESC);
CREATE INDEX IF NOT EXISTS brain_links_source_idx ON brain_links (source_id);
CREATE INDEX IF NOT EXISTS brain_links_target_idx ON brain_links (target_id);
CREATE INDEX IF NOT EXISTS brain_tags_tag_idx     ON brain_tags (tag);

-- HNSW vector index (only useful once embeddings are populated in Phase 2)
-- CREATE INDEX IF NOT EXISTS brain_nodes_embedding_idx ON brain_nodes
--   USING hnsw (embedding vector_cosine_ops);

-- ─── Row Level Security ───────────────────────────────────────────────────────

ALTER TABLE brain_nodes     ENABLE ROW LEVEL SECURITY;
ALTER TABLE brain_links     ENABLE ROW LEVEL SECURITY;
ALTER TABLE brain_tags      ENABLE ROW LEVEL SECURITY;
ALTER TABLE brain_research  ENABLE ROW LEVEL SECURITY;
ALTER TABLE brain_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE brain_api_keys  ENABLE ROW LEVEL SECURITY;

-- brain_nodes
CREATE POLICY "brain_nodes_own" ON brain_nodes
  FOR ALL USING (auth.uid() = user_id);

-- brain_links
CREATE POLICY "brain_links_own" ON brain_links
  FOR ALL USING (auth.uid() = user_id);

-- brain_tags (join through brain_nodes to check ownership)
CREATE POLICY "brain_tags_own" ON brain_tags
  FOR ALL USING (
    EXISTS (SELECT 1 FROM brain_nodes n WHERE n.id = node_id AND n.user_id = auth.uid())
  );

-- brain_research
CREATE POLICY "brain_research_own" ON brain_research
  FOR ALL USING (auth.uid() = user_id);

-- brain_snapshots (join through brain_nodes)
CREATE POLICY "brain_snapshots_own" ON brain_snapshots
  FOR ALL USING (
    EXISTS (SELECT 1 FROM brain_nodes n WHERE n.id = node_id AND n.user_id = auth.uid())
  );

-- brain_api_keys
CREATE POLICY "brain_api_keys_own" ON brain_api_keys
  FOR ALL USING (auth.uid() = user_id);
