-- 030_helm.sql — HELM: Autonomous Business Runner
-- Execution: ./scripts/supabase-sql.sh < config/supabase-migrations/029_helm.sql
--
-- 21 tables, all prefixed helm_. Manages autonomous businesses: profile, goals,
-- knowledge, websites, content, social, payments, leads, emails, HITL queue,
-- calendar, competitors, scheduling, credentials, onboarding, audit log, reports.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. helm_businesses — Core business profile
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS helm_businesses (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id              uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  name                  text        NOT NULL,
  slug                  text        UNIQUE NOT NULL,
  tagline               text,
  description           text,
  industry              text        NOT NULL,
  stage                 text        DEFAULT 'idea'
                                    CHECK (stage IN ('idea','mvp','growth','established','scaling')),
  country               text        DEFAULT 'US',
  timezone              text        DEFAULT 'America/Chicago',
  personality           text,
  tone_of_voice         text,
  brand_voice_notes     text,
  never_say             text[]      DEFAULT '{}',
  target_audience       text,
  value_proposition     text,
  primary_goal          text,
  monthly_revenue_target numeric(12,2),
  monthly_lead_target   int,
  is_active             bool        DEFAULT true,
  autopilot_enabled     bool        DEFAULT false,
  hitl_required         bool        DEFAULT true,
  autonomy_level        int         DEFAULT 8
                                    CHECK (autonomy_level >= 1 AND autonomy_level <= 10),
  health_score          int         DEFAULT 0
                                    CHECK (health_score >= 0 AND health_score <= 100),
  discord_channel       text,
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);
COMMENT ON TABLE helm_businesses IS 'Core business profile — one row per autonomous business managed by HELM';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. helm_business_access — Multi-user ACL
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS helm_business_access (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid        NOT NULL REFERENCES helm_businesses(id) ON DELETE CASCADE,
  user_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role          text        NOT NULL DEFAULT 'viewer'
                            CHECK (role IN ('owner','editor','viewer')),
  granted_by    uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at    timestamptz DEFAULT now(),
  UNIQUE (business_id, user_id)
);
COMMENT ON TABLE helm_business_access IS 'Multi-user access control — maps users to businesses with role-based permissions';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. helm_business_configs — Flexible key-value configuration
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS helm_business_configs (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid        NOT NULL REFERENCES helm_businesses(id) ON DELETE CASCADE,
  key           text        NOT NULL,
  value         text,
  value_type    text        DEFAULT 'string',
  description   text,
  updated_at    timestamptz DEFAULT now(),
  UNIQUE (business_id, key)
);
COMMENT ON TABLE helm_business_configs IS 'Flexible key-value store for per-business configuration';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. helm_business_goals — Hierarchical business goals with metrics
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS helm_business_goals (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid          NOT NULL REFERENCES helm_businesses(id) ON DELETE CASCADE,
  title           text          NOT NULL,
  description     text,
  category        text          DEFAULT 'revenue'
                                CHECK (category IN ('revenue','growth','content','leads','engagement','product')),
  metric_type     text          CHECK (metric_type IN ('currency','count','percent','boolean')),
  target_value    numeric(14,4),
  current_value   numeric(14,4) DEFAULT 0,
  unit            text,
  target_date     date,
  parent_goal_id  uuid          REFERENCES helm_business_goals(id) ON DELETE SET NULL,
  status          text          DEFAULT 'active'
                                CHECK (status IN ('active','achieved','missed','paused')),
  progress_pct    int           DEFAULT 0
                                CHECK (progress_pct >= 0 AND progress_pct <= 100),
  is_primary      bool          DEFAULT false,
  created_by      uuid          REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz   DEFAULT now(),
  updated_at      timestamptz   DEFAULT now()
);
COMMENT ON TABLE helm_business_goals IS 'Hierarchical business goals with measurable targets, progress tracking, and sub-goal support';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. helm_business_knowledge — AI knowledge base per business
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS helm_business_knowledge (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid          NOT NULL REFERENCES helm_businesses(id) ON DELETE CASCADE,
  topic             text          NOT NULL
                                  CHECK (topic IN ('brand_voice','competitors','pricing','audience','faq','products','industry','custom')),
  title             text          NOT NULL,
  content           text          NOT NULL,
  version           int           DEFAULT 1,
  is_active         bool          DEFAULT true,
  source            text          DEFAULT 'manual'
                                  CHECK (source IN ('manual','ai_generated','imported','scraped')),
  token_count       int,
  confidence_score  numeric(3,2)  DEFAULT 1.0,
  created_by        uuid          REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        timestamptz   DEFAULT now(),
  updated_at        timestamptz   DEFAULT now()
);
COMMENT ON TABLE helm_business_knowledge IS 'AI knowledge base — brand voice, competitor info, FAQs, etc. for context-aware generation';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. helm_business_websites — Connected website configurations
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS helm_business_websites (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid        NOT NULL REFERENCES helm_businesses(id) ON DELETE CASCADE,
  label               text        DEFAULT 'Main Site',
  platform            text        NOT NULL
                                  CHECK (platform IN ('wordpress','nextjs','webflow','shopify','squarespace','custom')),
  domain              text,
  hosting_provider    text        CHECK (hosting_provider IN ('hostinger','netlify','vercel','cloudflare','godaddy','aws','other')),
  deploy_hook_url     text,
  wp_rest_url         text,
  wp_app_password_ref text,
  credentials_ref     text,
  status              text        DEFAULT 'active'
                                  CHECK (status IN ('active','deploying','error','paused','pending_setup')),
  last_deployed_at    timestamptz,
  last_checked_at     timestamptz,
  uptime_status       text        DEFAULT 'unknown'
                                  CHECK (uptime_status IN ('up','down','degraded','unknown')),
  is_primary          bool        DEFAULT true,
  notes               text,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);
COMMENT ON TABLE helm_business_websites IS 'Connected websites — WordPress, Next.js, Shopify, etc. with deploy hooks and health monitoring';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. helm_business_content — Generated and managed content
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS helm_business_content (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid        NOT NULL REFERENCES helm_businesses(id) ON DELETE CASCADE,
  website_id        uuid        REFERENCES helm_business_websites(id) ON DELETE SET NULL,
  content_type      text        DEFAULT 'blog_post'
                                CHECK (content_type IN ('blog_post','page','landing_page','email','social_caption','ad_copy')),
  title             text        NOT NULL,
  slug              text,
  excerpt           text,
  body              text,
  seo_title         text,
  seo_description   text,
  focus_keyword     text,
  tags              text[]      DEFAULT '{}',
  categories        text[]      DEFAULT '{}',
  status            text        DEFAULT 'draft'
                                CHECK (status IN ('idea','draft','review','approved','scheduled','published','archived')),
  scheduled_at      timestamptz,
  published_at      timestamptz,
  published_url     text,
  external_id       text,
  ai_generated      bool        DEFAULT true,
  ai_model          text,
  word_count        int,
  reading_time_min  int,
  view_count        int         DEFAULT 0,
  comment_count     int         DEFAULT 0,
  share_count       int         DEFAULT 0,
  created_by        uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);
COMMENT ON TABLE helm_business_content IS 'All generated and managed content — blog posts, pages, emails, social captions, ad copy';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. helm_business_social_accounts — Connected social media accounts
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS helm_business_social_accounts (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           uuid          NOT NULL REFERENCES helm_businesses(id) ON DELETE CASCADE,
  platform              text          NOT NULL
                                      CHECK (platform IN ('twitter','linkedin','instagram','facebook','tiktok','youtube','pinterest')),
  handle                text          NOT NULL,
  profile_url           text,
  account_type          text          DEFAULT 'profile'
                                      CHECK (account_type IN ('profile','page','business','channel')),
  credentials_ref       text,
  access_token_ref      text,
  refresh_token_ref     text,
  token_expires_at      timestamptz,
  is_active             bool          DEFAULT true,
  auto_post_enabled     bool          DEFAULT false,
  followers_count       int           DEFAULT 0,
  following_count       int           DEFAULT 0,
  posts_count           int           DEFAULT 0,
  avg_engagement_rate   numeric(5,2)  DEFAULT 0,
  last_synced_at        timestamptz,
  created_at            timestamptz   DEFAULT now(),
  updated_at            timestamptz   DEFAULT now(),
  UNIQUE (business_id, platform, handle)
);
COMMENT ON TABLE helm_business_social_accounts IS 'Connected social media accounts with credentials, follower counts, and engagement metrics';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. helm_business_social_posts — Scheduled and published social posts
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS helm_business_social_posts (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid        NOT NULL REFERENCES helm_businesses(id) ON DELETE CASCADE,
  account_id          uuid        NOT NULL REFERENCES helm_business_social_accounts(id) ON DELETE CASCADE,
  content_id          uuid        REFERENCES helm_business_content(id) ON DELETE SET NULL,
  platform            text        NOT NULL,
  caption             text        NOT NULL,
  media_urls          text[]      DEFAULT '{}',
  hashtags            text[]      DEFAULT '{}',
  link_url            text,
  link_preview        jsonb       DEFAULT '{}',
  status              text        DEFAULT 'draft'
                                  CHECK (status IN ('draft','approved','scheduled','posting','published','failed','cancelled')),
  scheduled_at        timestamptz,
  published_at        timestamptz,
  external_post_id    text,
  metrics             jsonb       DEFAULT '{}',
  metrics_updated_at  timestamptz,
  ai_generated        bool        DEFAULT true,
  ai_model            text,
  campaign_tag        text,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);
COMMENT ON TABLE helm_business_social_posts IS 'Social media posts — drafts, scheduled, and published with per-post metrics';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 10. helm_business_stripe_config — Stripe integration per business
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS helm_business_stripe_config (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           uuid          NOT NULL UNIQUE REFERENCES helm_businesses(id) ON DELETE CASCADE,
  stripe_account_id     text,
  secret_key_ref        text,
  publishable_key_ref   text,
  webhook_secret_ref    text,
  mode                  text          DEFAULT 'test'
                                      CHECK (mode IN ('test','live')),
  currency              text          DEFAULT 'usd',
  is_active             bool          DEFAULT false,
  onboarding_complete   bool          DEFAULT false,
  mrr                   numeric(12,2) DEFAULT 0,
  arr                   numeric(12,2) DEFAULT 0,
  total_revenue_30d     numeric(12,2) DEFAULT 0,
  customer_count        int           DEFAULT 0,
  last_synced_at        timestamptz,
  created_at            timestamptz   DEFAULT now(),
  updated_at            timestamptz   DEFAULT now()
);
COMMENT ON TABLE helm_business_stripe_config IS 'Stripe configuration per business — keys stored as vault refs, revenue metrics synced periodically';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 11. helm_business_products — Products and pricing
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS helm_business_products (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid          NOT NULL REFERENCES helm_businesses(id) ON DELETE CASCADE,
  stripe_config_id  uuid          REFERENCES helm_business_stripe_config(id) ON DELETE SET NULL,
  name              text          NOT NULL,
  description       text,
  product_type      text          DEFAULT 'one_time'
                                  CHECK (product_type IN ('one_time','subscription','usage','free')),
  price             numeric(12,2),
  currency          text          DEFAULT 'usd',
  billing_interval  text          CHECK (billing_interval IN ('month','year') OR billing_interval IS NULL),
  stripe_product_id text,
  stripe_price_id   text,
  status            text          DEFAULT 'active'
                                  CHECK (status IN ('active','archived','draft')),
  is_featured       bool          DEFAULT false,
  sort_order        int           DEFAULT 0,
  metadata          jsonb         DEFAULT '{}',
  created_at        timestamptz   DEFAULT now(),
  updated_at        timestamptz   DEFAULT now()
);
COMMENT ON TABLE helm_business_products IS 'Products and pricing — synced with Stripe, supports one-time, subscription, usage-based, and free';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 12. helm_business_actions — Immutable audit log of all HELM actions
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS helm_business_actions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid        NOT NULL REFERENCES helm_businesses(id) ON DELETE CASCADE,
  actor           text        NOT NULL DEFAULT 'helm'
                              CHECK (actor IN ('helm','scheduler','user','webhook','system')),
  actor_user_id   uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  action_type     text        NOT NULL,
  resource_type   text,
  resource_id     uuid,
  summary         text        NOT NULL,
  detail          jsonb       DEFAULT '{}',
  status          text        DEFAULT 'success'
                              CHECK (status IN ('success','failed','partial','skipped','pending')),
  error_message   text,
  duration_ms     int,
  tokens_used     int,
  cost_usd        numeric(8,6),
  created_at      timestamptz DEFAULT now()
);
COMMENT ON TABLE helm_business_actions IS 'Immutable audit log — every action HELM takes is recorded here for traceability';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 13. helm_business_reports — Generated analytics reports
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS helm_business_reports (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid        NOT NULL REFERENCES helm_businesses(id) ON DELETE CASCADE,
  report_type     text        CHECK (report_type IN (
                                'weekly_summary','monthly_review','content_performance',
                                'social_analytics','revenue_snapshot','lead_pipeline',
                                'seo_audit','competitor_watch','onboarding_summary'
                              )),
  period_start    date,
  period_end      date,
  title           text        NOT NULL,
  content         text        NOT NULL,
  metrics         jsonb       DEFAULT '{}',
  highlights      jsonb       DEFAULT '[]',
  recommendations jsonb       DEFAULT '[]',
  ai_model        text,
  tokens_used     int,
  status          text        DEFAULT 'ready'
                              CHECK (status IN ('generating','ready','failed')),
  created_at      timestamptz DEFAULT now()
);
COMMENT ON TABLE helm_business_reports IS 'Generated analytics reports — weekly summaries, revenue snapshots, SEO audits, etc.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 14. helm_business_leads — Lead tracking and pipeline
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS helm_business_leads (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           uuid          NOT NULL REFERENCES helm_businesses(id) ON DELETE CASCADE,
  first_name            text,
  last_name             text,
  email                 text,
  phone                 text,
  company               text,
  job_title             text,
  website               text,
  linkedin_url          text,
  source                text          DEFAULT 'unknown'
                                      CHECK (source IN ('website_form','social_dm','email_reply','referral','ad','manual','import')),
  source_detail         text,
  status                text          DEFAULT 'new'
                                      CHECK (status IN ('new','contacted','qualified','proposal','won','lost','unsubscribed')),
  score                 int           DEFAULT 50
                                      CHECK (score >= 0 AND score <= 100),
  tags                  text[]        DEFAULT '{}',
  notes                 text,
  estimated_value       numeric(12,2),
  ai_summary            text,
  ai_recommended_action text,
  enriched_at           timestamptz,
  last_contacted_at     timestamptz,
  next_followup_at      timestamptz,
  assigned_to           uuid          REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at            timestamptz   DEFAULT now(),
  updated_at            timestamptz   DEFAULT now()
);
COMMENT ON TABLE helm_business_leads IS 'Lead pipeline — captured from forms, social, email with AI scoring and enrichment';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 15. helm_business_emails_sent — Outbound email tracking
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS helm_business_emails_sent (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           uuid        NOT NULL REFERENCES helm_businesses(id) ON DELETE CASCADE,
  lead_id               uuid        REFERENCES helm_business_leads(id) ON DELETE SET NULL,
  campaign_tag          text,
  to_email              text        NOT NULL,
  to_name               text,
  from_email            text        NOT NULL,
  from_name             text,
  subject               text        NOT NULL,
  body_text             text,
  body_html             text,
  provider              text        DEFAULT 'resend'
                                    CHECK (provider IN ('sendgrid','mailgun','ses','resend','smtp')),
  provider_message_id   text,
  status                text        DEFAULT 'queued'
                                    CHECK (status IN ('queued','sent','delivered','opened','clicked','bounced','failed')),
  sent_at               timestamptz,
  opened_at             timestamptz,
  clicked_at            timestamptz,
  ai_generated          bool        DEFAULT true,
  created_at            timestamptz DEFAULT now()
);
COMMENT ON TABLE helm_business_emails_sent IS 'Outbound email log — tracks delivery, opens, clicks per recipient';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 16. helm_business_hitl_queue — Human-in-the-loop approval queue
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS helm_business_hitl_queue (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid        NOT NULL REFERENCES helm_businesses(id) ON DELETE CASCADE,
  action_type         text        NOT NULL,
  resource_type       text,
  resource_id         uuid,
  title               text        NOT NULL,
  description         text,
  preview_data        jsonb       DEFAULT '{}',
  priority            int         DEFAULT 5
                                  CHECK (priority >= 1 AND priority <= 10),
  risk_level          text        DEFAULT 'medium'
                                  CHECK (risk_level IN ('low','medium','high','critical')),
  expires_at          timestamptz,
  status              text        DEFAULT 'pending'
                                  CHECK (status IN ('pending','approved','rejected','expired','auto_approved')),
  reviewed_by         uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at         timestamptz,
  reviewer_notes      text,
  execution_hook      text,
  execution_payload   jsonb       DEFAULT '{}',
  created_at          timestamptz DEFAULT now()
);
COMMENT ON TABLE helm_business_hitl_queue IS 'Human-in-the-loop approval queue — risky or expensive actions wait here for human review';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 17. helm_business_calendar — Content and activity calendar
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS helm_business_calendar (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid        NOT NULL REFERENCES helm_businesses(id) ON DELETE CASCADE,
  scheduled_date  date        NOT NULL,
  scheduled_time  time,
  item_type       text        NOT NULL
                              CHECK (item_type IN ('content','social_post','email_campaign','report','task')),
  content_id      uuid        REFERENCES helm_business_content(id) ON DELETE SET NULL,
  social_post_id  uuid        REFERENCES helm_business_social_posts(id) ON DELETE SET NULL,
  title           text        NOT NULL,
  notes           text,
  status          text        DEFAULT 'planned'
                              CHECK (status IN ('planned','completed','skipped','rescheduled')),
  created_at      timestamptz DEFAULT now()
);
COMMENT ON TABLE helm_business_calendar IS 'Unified calendar — content, social posts, email campaigns, reports, and tasks';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 18. helm_business_competitors — Competitor intelligence
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS helm_business_competitors (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid        NOT NULL REFERENCES helm_businesses(id) ON DELETE CASCADE,
  name              text        NOT NULL,
  website           text,
  notes             text,
  strengths         text,
  weaknesses        text,
  is_active         bool        DEFAULT true,
  monitor_enabled   bool        DEFAULT true,
  last_checked_at   timestamptz,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);
COMMENT ON TABLE helm_business_competitors IS 'Competitor profiles — strengths, weaknesses, monitoring state for competitive intelligence';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 19. helm_business_schedule — Recurring job scheduler configuration
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS helm_business_schedule (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid        NOT NULL REFERENCES helm_businesses(id) ON DELETE CASCADE,
  job_type        text        NOT NULL
                              CHECK (job_type IN (
                                'content_generate','social_post','report_weekly','report_monthly',
                                'stripe_sync','lead_enrich','site_health_check','email_campaign',
                                'social_stats_sync','hitl_expiry','knowledge_update'
                              )),
  enabled         bool        DEFAULT true,
  cron_expr       text,
  interval_hours  int,
  last_run_at     timestamptz,
  next_run_at     timestamptz,
  run_count       int         DEFAULT 0,
  fail_count      int         DEFAULT 0,
  config          jsonb       DEFAULT '{}',
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),
  UNIQUE (business_id, job_type)
);
COMMENT ON TABLE helm_business_schedule IS 'Recurring job scheduler — cron expressions or interval-based, per-business job configuration';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 20. helm_business_credential_refs — Vault credential references
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS helm_business_credential_refs (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid        NOT NULL REFERENCES helm_businesses(id) ON DELETE CASCADE,
  label             text        NOT NULL,
  vault_key         text        NOT NULL UNIQUE,
  service           text        NOT NULL,
  credential_type   text        DEFAULT 'oauth_tokens'
                                CHECK (credential_type IN ('oauth_tokens','api_key','app_password','service_account','connection_string')),
  expires_at        timestamptz,
  is_active         bool        DEFAULT true,
  last_verified_at  timestamptz,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);
COMMENT ON TABLE helm_business_credential_refs IS 'Vault credential references — no secrets stored here, only pointers to encrypted vault entries';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 21. helm_business_onboarding — Resumable wizard state
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS helm_business_onboarding (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid        NOT NULL UNIQUE REFERENCES helm_businesses(id) ON DELETE CASCADE,
  current_step    int         DEFAULT 1
                              CHECK (current_step >= 1 AND current_step <= 8),
  step_data       jsonb       DEFAULT '{}',
  completed_at    timestamptz,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);
COMMENT ON TABLE helm_business_onboarding IS 'Resumable onboarding wizard — tracks current step and in-progress answers per step';


-- ═══════════════════════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════════════════════

-- helm_business_access
CREATE INDEX IF NOT EXISTS helm_access_user_idx
  ON helm_business_access(user_id);

-- helm_business_knowledge
CREATE INDEX IF NOT EXISTS helm_knowledge_active_idx
  ON helm_business_knowledge(business_id, is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS helm_knowledge_topic_idx
  ON helm_business_knowledge(business_id, topic);

-- helm_business_content
CREATE INDEX IF NOT EXISTS helm_content_status_idx
  ON helm_business_content(business_id, status);
CREATE INDEX IF NOT EXISTS helm_content_scheduled_idx
  ON helm_business_content(scheduled_at) WHERE status = 'scheduled';

-- helm_business_social_posts
CREATE INDEX IF NOT EXISTS helm_social_posts_scheduled_idx
  ON helm_business_social_posts(scheduled_at) WHERE status = 'scheduled';

-- helm_business_actions
CREATE INDEX IF NOT EXISTS helm_actions_business_time_idx
  ON helm_business_actions(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS helm_actions_business_type_idx
  ON helm_business_actions(business_id, action_type);

-- helm_business_leads
CREATE INDEX IF NOT EXISTS helm_leads_status_idx
  ON helm_business_leads(business_id, status);
CREATE INDEX IF NOT EXISTS helm_leads_followup_idx
  ON helm_business_leads(next_followup_at)
  WHERE status NOT IN ('won','lost','unsubscribed');

-- helm_business_hitl_queue
CREATE INDEX IF NOT EXISTS helm_hitl_pending_idx
  ON helm_business_hitl_queue(status, created_at) WHERE status = 'pending';

-- helm_business_schedule
CREATE INDEX IF NOT EXISTS helm_schedule_next_run_idx
  ON helm_business_schedule(next_run_at, enabled) WHERE enabled = true;

-- helm_business_calendar
CREATE INDEX IF NOT EXISTS helm_calendar_date_idx
  ON helm_business_calendar(business_id, scheduled_date);

-- helm_business_reports
CREATE INDEX IF NOT EXISTS helm_reports_business_type_idx
  ON helm_business_reports(business_id, report_type, created_at DESC);

-- helm_business_emails_sent
CREATE INDEX IF NOT EXISTS helm_emails_business_idx
  ON helm_business_emails_sent(business_id, created_at DESC);

-- helm_business_products
CREATE INDEX IF NOT EXISTS helm_products_business_idx
  ON helm_business_products(business_id, status) WHERE status = 'active';

-- helm_business_competitors
CREATE INDEX IF NOT EXISTS helm_competitors_business_idx
  ON helm_business_competitors(business_id) WHERE is_active = true;

-- helm_business_credential_refs
CREATE INDEX IF NOT EXISTS helm_creds_business_idx
  ON helm_business_credential_refs(business_id) WHERE is_active = true;


-- ═══════════════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY — Enable on all tables
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE helm_businesses              ENABLE ROW LEVEL SECURITY;
ALTER TABLE helm_business_access         ENABLE ROW LEVEL SECURITY;
ALTER TABLE helm_business_configs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE helm_business_goals          ENABLE ROW LEVEL SECURITY;
ALTER TABLE helm_business_knowledge      ENABLE ROW LEVEL SECURITY;
ALTER TABLE helm_business_websites       ENABLE ROW LEVEL SECURITY;
ALTER TABLE helm_business_content        ENABLE ROW LEVEL SECURITY;
ALTER TABLE helm_business_social_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE helm_business_social_posts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE helm_business_stripe_config  ENABLE ROW LEVEL SECURITY;
ALTER TABLE helm_business_products       ENABLE ROW LEVEL SECURITY;
ALTER TABLE helm_business_actions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE helm_business_reports        ENABLE ROW LEVEL SECURITY;
ALTER TABLE helm_business_leads          ENABLE ROW LEVEL SECURITY;
ALTER TABLE helm_business_emails_sent    ENABLE ROW LEVEL SECURITY;
ALTER TABLE helm_business_hitl_queue     ENABLE ROW LEVEL SECURITY;
ALTER TABLE helm_business_calendar       ENABLE ROW LEVEL SECURITY;
ALTER TABLE helm_business_competitors    ENABLE ROW LEVEL SECURITY;
ALTER TABLE helm_business_schedule       ENABLE ROW LEVEL SECURITY;
ALTER TABLE helm_business_credential_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE helm_business_onboarding     ENABLE ROW LEVEL SECURITY;


-- ═══════════════════════════════════════════════════════════════════════════════
-- HELPER FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Access check: returns true if user has any role on the business, or is admin
CREATE OR REPLACE FUNCTION helm_has_access(p_business_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM helm_business_access
    WHERE business_id = p_business_id AND user_id = auth.uid()
  ) OR get_my_role() = 'admin';
$$;

-- Access check with minimum role requirement
CREATE OR REPLACE FUNCTION helm_has_role(p_business_id uuid, p_required_role text DEFAULT 'viewer')
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM helm_business_access
    WHERE business_id = p_business_id
      AND user_id = auth.uid()
      AND (
        p_required_role = 'viewer'
        OR (p_required_role = 'editor' AND role IN ('owner','editor'))
        OR (p_required_role = 'owner'  AND role = 'owner')
      )
  ) OR get_my_role() = 'admin';
$$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- RLS POLICIES — Full policies for core tables, template for child tables
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── helm_businesses ──────────────────────────────────────────────────────────

CREATE POLICY "imp businesses admin all"
  ON helm_businesses FOR ALL TO authenticated
  USING (get_my_role() = 'admin');

CREATE POLICY "imp businesses member read"
  ON helm_businesses FOR SELECT TO authenticated
  USING (helm_has_access(id));

CREATE POLICY "imp businesses owner insert"
  ON helm_businesses FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid() OR get_my_role() = 'admin');

CREATE POLICY "imp businesses owner update"
  ON helm_businesses FOR UPDATE TO authenticated
  USING (helm_has_role(id, 'owner'));

CREATE POLICY "imp businesses owner delete"
  ON helm_businesses FOR DELETE TO authenticated
  USING (helm_has_role(id, 'owner'));

-- ─── helm_business_access ─────────────────────────────────────────────────────

CREATE POLICY "imp access admin all"
  ON helm_business_access FOR ALL TO authenticated
  USING (get_my_role() = 'admin');

CREATE POLICY "imp access member read own"
  ON helm_business_access FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR helm_has_role(business_id, 'owner'));

CREATE POLICY "imp access owner manage"
  ON helm_business_access FOR INSERT TO authenticated
  WITH CHECK (helm_has_role(business_id, 'owner'));

CREATE POLICY "imp access owner update"
  ON helm_business_access FOR UPDATE TO authenticated
  USING (helm_has_role(business_id, 'owner'));

CREATE POLICY "imp access owner delete"
  ON helm_business_access FOR DELETE TO authenticated
  USING (helm_has_role(business_id, 'owner'));

-- ─── helm_business_actions (immutable audit log) ──────────────────────────────

CREATE POLICY "imp actions admin all"
  ON helm_business_actions FOR ALL TO authenticated
  USING (get_my_role() = 'admin');

CREATE POLICY "imp actions member read"
  ON helm_business_actions FOR SELECT TO authenticated
  USING (helm_has_access(business_id));

-- Insert allowed for any member (system inserts via service role bypass RLS)
CREATE POLICY "imp actions member insert"
  ON helm_business_actions FOR INSERT TO authenticated
  WITH CHECK (helm_has_access(business_id));

-- No UPDATE or DELETE policies — audit log is immutable for non-admins

-- ─── helm_business_hitl_queue ─────────────────────────────────────────────────

CREATE POLICY "imp hitl admin all"
  ON helm_business_hitl_queue FOR ALL TO authenticated
  USING (get_my_role() = 'admin');

CREATE POLICY "imp hitl member read"
  ON helm_business_hitl_queue FOR SELECT TO authenticated
  USING (helm_has_access(business_id));

CREATE POLICY "imp hitl member insert"
  ON helm_business_hitl_queue FOR INSERT TO authenticated
  WITH CHECK (helm_has_access(business_id));

CREATE POLICY "imp hitl editor review"
  ON helm_business_hitl_queue FOR UPDATE TO authenticated
  USING (helm_has_role(business_id, 'editor'));

-- ─── Child tables: standard pattern (admin + member read + editor write) ─────
-- Applied to all remaining child tables that reference business_id

DO $$
DECLARE
  tbl text;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'helm_business_configs',
      'helm_business_goals',
      'helm_business_knowledge',
      'helm_business_websites',
      'helm_business_content',
      'helm_business_social_accounts',
      'helm_business_social_posts',
      'helm_business_stripe_config',
      'helm_business_products',
      'helm_business_reports',
      'helm_business_leads',
      'helm_business_emails_sent',
      'helm_business_calendar',
      'helm_business_competitors',
      'helm_business_schedule',
      'helm_business_credential_refs',
      'helm_business_onboarding'
    ])
  LOOP
    -- Admin full access
    EXECUTE format(
      'CREATE POLICY "imp %s admin all" ON %I FOR ALL TO authenticated USING (get_my_role() = ''admin'')',
      replace(tbl, 'helm_business_', ''), tbl
    );
    -- Member read
    EXECUTE format(
      'CREATE POLICY "imp %s member read" ON %I FOR SELECT TO authenticated USING (helm_has_access(business_id))',
      replace(tbl, 'helm_business_', ''), tbl
    );
    -- Editor insert
    EXECUTE format(
      'CREATE POLICY "imp %s editor insert" ON %I FOR INSERT TO authenticated WITH CHECK (helm_has_role(business_id, ''editor''))',
      replace(tbl, 'helm_business_', ''), tbl
    );
    -- Editor update
    EXECUTE format(
      'CREATE POLICY "imp %s editor update" ON %I FOR UPDATE TO authenticated USING (helm_has_role(business_id, ''editor''))',
      replace(tbl, 'helm_business_', ''), tbl
    );
    -- Owner delete
    EXECUTE format(
      'CREATE POLICY "imp %s owner delete" ON %I FOR DELETE TO authenticated USING (helm_has_role(business_id, ''owner''))',
      replace(tbl, 'helm_business_', ''), tbl
    );
  END LOOP;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- UPDATED_AT TRIGGER
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION update_helm_timestamp()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Apply to all tables that have an updated_at column
DO $$
DECLARE
  tbl text;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'helm_businesses',
      'helm_business_configs',
      'helm_business_goals',
      'helm_business_knowledge',
      'helm_business_websites',
      'helm_business_content',
      'helm_business_social_accounts',
      'helm_business_social_posts',
      'helm_business_stripe_config',
      'helm_business_products',
      'helm_business_leads',
      'helm_business_competitors',
      'helm_business_schedule',
      'helm_business_credential_refs',
      'helm_business_onboarding'
    ])
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%s_updated_at ON %I', tbl, tbl
    );
    EXECUTE format(
      'CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_helm_timestamp()',
      tbl, tbl
    );
  END LOOP;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- DEFAULT SCHEDULE SEEDER
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION helm_seed_default_schedule(p_business_id uuid)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO helm_business_schedule (business_id, job_type, enabled, cron_expr, next_run_at) VALUES
    (p_business_id, 'site_health_check',  true,  NULL,            now() + interval '30 minutes'),
    (p_business_id, 'hitl_expiry',        true,  NULL,            now() + interval '15 minutes'),
    (p_business_id, 'stripe_sync',        false, NULL,            now() + interval '6 hours'),
    (p_business_id, 'social_stats_sync',  false, NULL,            now() + interval '24 hours'),
    (p_business_id, 'content_generate',   false, '0 6 * * *',    now() + interval '24 hours'),
    (p_business_id, 'social_post',        false, '0 10,14 * * *', now() + interval '12 hours'),
    (p_business_id, 'report_weekly',      false, '0 7 * * 1',    now() + interval '7 days'),
    (p_business_id, 'report_monthly',     false, '0 8 1 * *',    now() + interval '30 days'),
    (p_business_id, 'knowledge_update',   false, '0 9 * * 0',    now() + interval '7 days'),
    (p_business_id, 'lead_enrich',        false, NULL,            now() + interval '12 hours'),
    (p_business_id, 'email_campaign',     false, NULL,            now() + interval '24 hours')
  ON CONFLICT (business_id, job_type) DO NOTHING;
$$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- DONE
-- ═══════════════════════════════════════════════════════════════════════════════
-- Tables created: 21 (helm_ prefix)
-- Indexes created: 15
-- RLS enabled: all 21 tables
-- Policies: 4 core tables fully specified + 17 child tables via DO block
-- Functions: helm_has_access(), helm_has_role(), update_helm_timestamp(), helm_seed_default_schedule()
-- Triggers: updated_at on 15 tables
