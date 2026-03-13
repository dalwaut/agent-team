-- 047_eliza_integration.sql
-- ElizaOS integration: agent registry, knowledge branches, interactions, audit log
-- Phase 0 of Eliza integration plan

-- ============================================================
-- 1. Add info_layer column to brain_nodes
-- ============================================================
ALTER TABLE brain_nodes
  ADD COLUMN IF NOT EXISTS info_layer text DEFAULT 'internal'
  CHECK (info_layer IN ('internal', 'public', 'agent_specific'));

-- ============================================================
-- 2. eliza_knowledge_branches — named prunable subsets of brain_nodes
-- ============================================================
CREATE TABLE IF NOT EXISTS eliza_knowledge_branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name text NOT NULL,
  slug text NOT NULL,
  root_node_id uuid REFERENCES brain_nodes(id) ON DELETE SET NULL,
  info_layer text DEFAULT 'public' CHECK (info_layer IN ('internal', 'public', 'agent_specific')),
  auto_sync boolean DEFAULT false,
  sync_criteria jsonb DEFAULT '{}',
  description text DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(owner_id, slug)
);

-- ============================================================
-- 3. eliza_agents — agent registry
-- ============================================================
CREATE TABLE IF NOT EXISTS eliza_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name text NOT NULL,
  slug text NOT NULL,
  character_file jsonb DEFAULT '{}',
  status text DEFAULT 'stopped' CHECK (status IN ('stopped', 'starting', 'running', 'error', 'disabled')),
  deployment_tier text DEFAULT 'local' CHECK (deployment_tier IN ('local', 'docker', 'cloud')),
  model text DEFAULT 'claude-sonnet-4-6',
  plugins text[] DEFAULT '{}',
  knowledge_branch_id uuid REFERENCES eliza_knowledge_branches(id) ON DELETE SET NULL,
  workspace_id uuid,
  platforms text[] DEFAULT '{}',
  rate_limit_rpm integer DEFAULT 60,
  rate_limit_daily integer DEFAULT 1000,
  max_tokens integer DEFAULT 4096,
  temperature numeric(3,2) DEFAULT 0.7,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(owner_id, slug)
);

-- ============================================================
-- 4. eliza_knowledge_branch_nodes — junction table
-- ============================================================
CREATE TABLE IF NOT EXISTS eliza_knowledge_branch_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid REFERENCES eliza_knowledge_branches(id) ON DELETE CASCADE NOT NULL,
  node_id uuid REFERENCES brain_nodes(id) ON DELETE CASCADE NOT NULL,
  added_at timestamptz DEFAULT now(),
  added_by text DEFAULT 'manual',
  UNIQUE(branch_id, node_id)
);

-- ============================================================
-- 5. eliza_interactions — every message in/out
-- ============================================================
CREATE TABLE IF NOT EXISTS eliza_interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid REFERENCES eliza_agents(id) ON DELETE CASCADE NOT NULL,
  owner_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  channel text DEFAULT 'rest',
  sender_id text DEFAULT '',
  content text DEFAULT '',
  info_class text DEFAULT 'public_response' CHECK (info_class IN (
    'internal_command', 'public_response', 'escalation', 'system_event', 'knowledge_query', 'blocked'
  )),
  tokens_used integer DEFAULT 0,
  latency_ms integer DEFAULT 0,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

-- Index for analytics queries
CREATE INDEX IF NOT EXISTS idx_eliza_interactions_agent_created
  ON eliza_interactions(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eliza_interactions_info_class
  ON eliza_interactions(info_class);

-- ============================================================
-- 6. eliza_audit_log — lifecycle events, config changes, escalations
-- ============================================================
CREATE TABLE IF NOT EXISTS eliza_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid REFERENCES eliza_agents(id) ON DELETE CASCADE,
  owner_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  action text NOT NULL,
  actor text DEFAULT 'system',
  details jsonb DEFAULT '{}',
  severity text DEFAULT 'info' CHECK (severity IN ('info', 'warn', 'error', 'critical')),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_eliza_audit_agent_created
  ON eliza_audit_log(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eliza_audit_severity
  ON eliza_audit_log(severity);

-- ============================================================
-- 7. RLS Policies
-- ============================================================

-- Enable RLS on all new tables
ALTER TABLE eliza_knowledge_branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliza_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliza_knowledge_branch_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliza_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliza_audit_log ENABLE ROW LEVEL SECURITY;

-- Knowledge branches: owner can CRUD
CREATE POLICY eliza_kb_owner ON eliza_knowledge_branches
  FOR ALL USING (owner_id = auth.uid());

-- Agents: owner can CRUD
CREATE POLICY eliza_agents_owner ON eliza_agents
  FOR ALL USING (owner_id = auth.uid());

-- Branch nodes: owner of the branch can manage
CREATE POLICY eliza_branch_nodes_owner ON eliza_knowledge_branch_nodes
  FOR ALL USING (
    branch_id IN (SELECT id FROM eliza_knowledge_branches WHERE owner_id = auth.uid())
  );

-- Interactions: owner can read/insert
CREATE POLICY eliza_interactions_owner ON eliza_interactions
  FOR ALL USING (owner_id = auth.uid());

-- Audit log: owner can read, system can insert
CREATE POLICY eliza_audit_owner ON eliza_audit_log
  FOR ALL USING (owner_id = auth.uid());

-- ============================================================
-- 8. Updated_at triggers
-- ============================================================
CREATE OR REPLACE FUNCTION update_eliza_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_eliza_agents_updated
  BEFORE UPDATE ON eliza_agents
  FOR EACH ROW EXECUTE FUNCTION update_eliza_updated_at();

CREATE TRIGGER trg_eliza_kb_updated
  BEFORE UPDATE ON eliza_knowledge_branches
  FOR EACH ROW EXECUTE FUNCTION update_eliza_updated_at();

-- ============================================================
-- 9. Service role bypass for internal API operations
-- ============================================================
CREATE POLICY eliza_agents_service ON eliza_agents
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY eliza_kb_service ON eliza_knowledge_branches
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY eliza_branch_nodes_service ON eliza_knowledge_branch_nodes
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY eliza_interactions_service ON eliza_interactions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY eliza_audit_service ON eliza_audit_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);
