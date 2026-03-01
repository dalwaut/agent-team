-- Email Manager & Task Creator — Supabase Migration
-- Target project: OPAI Agent System (idorgloobxkmlnwnxbej)
-- Apply via: Supabase Dashboard > SQL Editor, or supabase db push

-- Email accounts being monitored
CREATE TABLE em_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email_address TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('gmail', 'imap', 'hostinger')),
    env_prefix TEXT NOT NULL DEFAULT '',
    is_active BOOLEAN NOT NULL DEFAULT true,
    poll_interval_minutes INTEGER NOT NULL DEFAULT 15,
    last_polled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Raw/classified emails
CREATE TABLE em_emails (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID REFERENCES em_accounts(id) ON DELETE SET NULL,
    message_id TEXT NOT NULL UNIQUE,
    from_address TEXT NOT NULL,
    from_name TEXT,
    subject TEXT,
    body_text TEXT,
    received_at TIMESTAMPTZ,
    account_name TEXT,
    tags TEXT[] DEFAULT '{}',
    priority TEXT DEFAULT 'normal' CHECK (priority IN ('critical', 'high', 'normal', 'low')),
    urgency TEXT DEFAULT 'standard' CHECK (urgency IN ('immediate', 'soon', 'standard', 'none')),
    summary TEXT,
    requires_response BOOLEAN DEFAULT false,
    assignee_hint TEXT DEFAULT 'human',
    response_status TEXT DEFAULT 'none' CHECK (response_status IN ('none', 'draft', 'approved', 'sent', 'skipped')),
    processed_at TIMESTAMPTZ DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_em_emails_from ON em_emails(from_address);
CREATE INDEX idx_em_emails_priority ON em_emails(priority);
CREATE INDEX idx_em_emails_response ON em_emails(response_status);
CREATE INDEX idx_em_emails_received ON em_emails(received_at DESC);

-- Email tags (many-to-many)
CREATE TABLE em_email_tags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email_id UUID NOT NULL REFERENCES em_emails(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    confidence REAL DEFAULT 1.0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(email_id, tag)
);

CREATE INDEX idx_em_email_tags_tag ON em_email_tags(tag);

-- Tasks extracted from emails
CREATE TABLE em_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email_id UUID REFERENCES em_emails(id) ON DELETE SET NULL,
    sender_email TEXT NOT NULL,
    sender_name TEXT,
    email_subject TEXT,
    title TEXT NOT NULL,
    description TEXT,
    priority TEXT DEFAULT 'normal' CHECK (priority IN ('critical', 'high', 'normal', 'low')),
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled', 'deferred')),
    assignee_type TEXT DEFAULT 'human' CHECK (assignee_type IN ('human', 'agent')),
    deadline TEXT,
    context TEXT,
    routing JSONB,
    queue_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_em_tasks_sender ON em_tasks(sender_email);
CREATE INDEX idx_em_tasks_status ON em_tasks(status);
CREATE INDEX idx_em_tasks_priority ON em_tasks(priority);

-- Email response drafts
CREATE TABLE em_responses (
    id TEXT PRIMARY KEY,
    email_message_id TEXT,
    account_name TEXT,
    to_address TEXT NOT NULL,
    to_name TEXT,
    subject TEXT,
    original_body TEXT,
    initial_draft TEXT,
    critique TEXT,
    refined_draft TEXT,
    final_content TEXT,
    status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'sent', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ
);

CREATE INDEX idx_em_responses_status ON em_responses(status);

-- Brand voice configuration
CREATE TABLE em_voice_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID REFERENCES em_accounts(id) ON DELETE SET NULL,
    voice_name TEXT NOT NULL DEFAULT 'default',
    system_prompt TEXT NOT NULL,
    tone_keywords TEXT[] DEFAULT '{}',
    example_responses JSONB DEFAULT '[]',
    signature_template TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE em_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE em_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE em_email_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE em_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE em_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE em_voice_config ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS. Authenticated users can read all email data.
CREATE POLICY "authenticated_read" ON em_accounts FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read" ON em_emails FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read" ON em_email_tags FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read" ON em_tasks FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read" ON em_responses FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read" ON em_voice_config FOR SELECT TO authenticated USING (true);

CREATE POLICY "authenticated_update_tasks" ON em_tasks FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_update_responses" ON em_responses FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- Seed accounts
INSERT INTO em_accounts (email_address, display_name, provider, env_prefix) VALUES
  ('dalwaut@gmail.com', 'Gmail Personal', 'gmail', ''),
  ('dallas@paradisewebfl.com', 'Paradise Web', 'gmail', '_PW'),
  ('dallas@boutabyte.com', 'BoutaByte', 'hostinger', '_BB'),
  ('dallas@boutacare.com', 'BoutaCare', 'hostinger', '_BC');

-- Seed default voice config
INSERT INTO em_voice_config (voice_name, system_prompt, tone_keywords, signature_template) VALUES
  ('boutabyte-professional',
   'You are writing professional emails on behalf of Dallas at Boutabyte, a software development and digital solutions company. Tone: Professional yet approachable. Warm but not casual. Confident, not arrogant. Be concise (2-3 paragraphs max). Lead with value. End with clear next steps. Match the formality of the incoming email.',
   ARRAY['professional', 'warm', 'concise', 'solution-oriented'],
   E'Best regards,\nDallas\nBoutabyte | Software & Digital Solutions');
