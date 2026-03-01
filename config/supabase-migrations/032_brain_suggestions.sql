-- 032_brain_suggestions.sql — Smart Suggestions for 2nd Brain
-- Stores AI-generated similarity suggestions between brain nodes.

CREATE TABLE brain_suggestions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  source_id uuid NOT NULL REFERENCES brain_nodes(id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES brain_nodes(id) ON DELETE CASCADE,
  score float NOT NULL DEFAULT 0,
  reason text,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz DEFAULT now(),
  UNIQUE(source_id, target_id)
);

CREATE INDEX idx_brain_suggestions_source ON brain_suggestions(source_id, status);
CREATE INDEX idx_brain_suggestions_user ON brain_suggestions(user_id, status);

ALTER TABLE brain_suggestions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own suggestions" ON brain_suggestions
  FOR ALL USING (user_id = auth.uid());
