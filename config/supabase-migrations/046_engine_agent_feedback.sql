-- Agent Feedback Loop — stores learned insights from agent runs
-- so future runs start with accumulated knowledge instead of cold.

CREATE TABLE IF NOT EXISTS engine_agent_feedback (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_role      text NOT NULL,
  domain          text,
  feedback_type   text NOT NULL,  -- 'retrieval_hint' | 'missing_context' | 'correction'
  content         text NOT NULL,
  source_run      text,           -- report path or squad/date ref
  confidence      float DEFAULT 0.5,
  use_count       int DEFAULT 0,
  success_count   int DEFAULT 0,
  active          boolean DEFAULT true,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

CREATE INDEX idx_agent_feedback_lookup
  ON engine_agent_feedback (agent_role, domain, active, confidence DESC);

CREATE INDEX idx_agent_feedback_type
  ON engine_agent_feedback (feedback_type, active);

ALTER TABLE engine_agent_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON engine_agent_feedback
  FOR ALL USING (auth.role() = 'service_role');
