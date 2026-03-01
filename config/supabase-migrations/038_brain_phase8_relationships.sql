-- 038: Brain Phase 8.1 — Relationship Intelligence
-- Adds provenance tracking to brain_links and enrichment columns to brain_nodes.

-- Track who/what created each link: 'user' (manual), 'suggestion' (accepted), 'agent' (future)
ALTER TABLE brain_links ADD COLUMN IF NOT EXISTS created_by text DEFAULT 'user';

-- Node enrichment for Phase 8.1
-- confidence: 1=speculative .. 5=certain
ALTER TABLE brain_nodes ADD COLUMN IF NOT EXISTS confidence integer DEFAULT 3;
-- source: how the node was created
ALTER TABLE brain_nodes ADD COLUMN IF NOT EXISTS source text DEFAULT 'manual';
