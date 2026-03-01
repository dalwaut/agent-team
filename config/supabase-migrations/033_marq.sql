-- 033_marq.sql — Marq: App Store Publisher Agent
-- Execution: ./scripts/supabase-sql.sh < config/supabase-migrations/033_marq.sql
--
-- 12 tables, all prefixed mrq_. Manages app store submissions: app registry,
-- credentials, metadata, screenshots, pre-checks, submissions, review events,
-- task relay, review responses, audit log, scheduling.


-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. mrq_apps — App registry
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS mrq_apps (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id                uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  name                    text        NOT NULL,
  slug                    text        UNIQUE NOT NULL,
  bundle_id_ios           text,
  package_name_android    text,
  platform                text        NOT NULL DEFAULT 'both'
                                      CHECK (platform IN ('ios','android','both')),
  status                  text        DEFAULT 'draft'
                                      CHECK (status IN ('draft','active','submitted','in_review','live','suspended','removed')),
  current_version         text,
  project_path            text,
  doc_folder              text,
  teamhub_workspace_id    uuid,
  privacy_policy_url      text,
  support_url             text,
  icon_storage_key        text,
  created_at              timestamptz DEFAULT now(),
  updated_at              timestamptz DEFAULT now()
);
COMMENT ON TABLE mrq_apps IS 'App registry — one row per mobile/web app managed by Marq';


-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. mrq_app_access — Multi-user ACL
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS mrq_app_access (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id        uuid        NOT NULL REFERENCES mrq_apps(id) ON DELETE CASCADE,
  user_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role          text        NOT NULL DEFAULT 'viewer'
                            CHECK (role IN ('owner','editor','viewer')),
  granted_by    uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at    timestamptz DEFAULT now(),
  UNIQUE (app_id, user_id)
);
COMMENT ON TABLE mrq_app_access IS 'Multi-user access control — maps users to apps with role-based permissions';


-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. mrq_store_credentials — Encrypted credential references
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS mrq_store_credentials (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id            uuid        NOT NULL REFERENCES mrq_apps(id) ON DELETE CASCADE,
  store             text        NOT NULL
                                CHECK (store IN ('apple','google')),
  credential_type   text        NOT NULL
                                CHECK (credential_type IN ('api_key','service_account','p8_key')),
  vault_key         text        NOT NULL,
  issuer_id         text,
  key_id            text,
  is_active         bool        DEFAULT true,
  last_verified_at  timestamptz,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now(),
  UNIQUE (app_id, store)
);
COMMENT ON TABLE mrq_store_credentials IS 'Store credential references — no secrets stored here, only pointers to encrypted vault entries';


-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. mrq_metadata — Store listing per version/locale
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS mrq_metadata (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id              uuid        NOT NULL REFERENCES mrq_apps(id) ON DELETE CASCADE,
  version             text        NOT NULL,
  locale              text        NOT NULL DEFAULT 'en-US',
  store               text        NOT NULL
                                  CHECK (store IN ('apple','google')),
  app_name            text,
  subtitle            text,
  short_description   text,
  full_description    text,
  keywords            text,
  whats_new           text,
  privacy_policy_url  text,
  support_url         text,
  content_rating_data jsonb       DEFAULT '{}',
  status              text        DEFAULT 'draft'
                                  CHECK (status IN ('draft','ready','submitted','live')),
  ai_generated        bool        DEFAULT false,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now(),
  UNIQUE (app_id, version, locale, store)
);
COMMENT ON TABLE mrq_metadata IS 'Store listing metadata per version, locale, and store — supports AI generation and manual editing';


-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. mrq_screenshots — Screenshots and previews
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS mrq_screenshots (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id            uuid        NOT NULL REFERENCES mrq_apps(id) ON DELETE CASCADE,
  metadata_id       uuid        REFERENCES mrq_metadata(id) ON DELETE SET NULL,
  store             text        NOT NULL
                                CHECK (store IN ('apple','google')),
  device_type       text        NOT NULL
                                CHECK (device_type IN (
                                  'iphone_6_7','iphone_6_5','ipad_12_9','ipad_11',
                                  'phone','tablet_7','tablet_10','chromebook','tv'
                                )),
  locale            text        DEFAULT 'en-US',
  display_order     int         DEFAULT 0,
  storage_key       text        NOT NULL,
  width             int,
  height            int,
  format            text        CHECK (format IN ('png','jpeg','webp')),
  is_valid          bool        DEFAULT true,
  validation_errors jsonb       DEFAULT '[]',
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);
COMMENT ON TABLE mrq_screenshots IS 'App store screenshots and video previews with dimension validation per device type';


-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. mrq_submissions — Submission history
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS mrq_submissions (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id              uuid        NOT NULL REFERENCES mrq_apps(id) ON DELETE CASCADE,
  store               text        NOT NULL
                                  CHECK (store IN ('apple','google')),
  version             text        NOT NULL,
  build_number        text,
  status              text        DEFAULT 'preparing'
                                  CHECK (status IN (
                                    'preparing','pre_check_failed','ready',
                                    'uploading','submitted','in_review',
                                    'approved','released','rejected',
                                    'cancelled','suspended','withdrawn'
                                  )),
  submitted_at        timestamptz,
  reviewed_at         timestamptz,
  released_at         timestamptz,
  rejection_reason    text,
  rejection_details   jsonb       DEFAULT '{}',
  pre_check_results   jsonb       DEFAULT '{}',
  pre_check_score     int         DEFAULT 0
                                  CHECK (pre_check_score >= 0 AND pre_check_score <= 100),
  teamhub_task_id     uuid,
  notes               text,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);
COMMENT ON TABLE mrq_submissions IS 'Submission lifecycle — tracks every submission from preparation through review to release or rejection';


-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. mrq_pre_checks — Individual check results
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS mrq_pre_checks (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id   uuid        NOT NULL REFERENCES mrq_submissions(id) ON DELETE CASCADE,
  app_id          uuid        NOT NULL REFERENCES mrq_apps(id) ON DELETE CASCADE,
  check_id        text        NOT NULL,
  category        text        NOT NULL
                              CHECK (category IN ('legal','design','metadata','technical','safety')),
  severity        text        NOT NULL
                              CHECK (severity IN ('blocker','warning','info')),
  status          text        DEFAULT 'pending'
                              CHECK (status IN ('pending','passed','failed','skipped')),
  recommendation  text,
  doc_url         text,
  auto_fixable    bool        DEFAULT false,
  details         jsonb       DEFAULT '{}',
  created_at      timestamptz DEFAULT now()
);
COMMENT ON TABLE mrq_pre_checks IS 'Individual pre-submission check results — 31 automated checks per submission attempt';


-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. mrq_review_events — Status change log (immutable)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS mrq_review_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id          uuid        NOT NULL REFERENCES mrq_apps(id) ON DELETE CASCADE,
  submission_id   uuid        REFERENCES mrq_submissions(id) ON DELETE SET NULL,
  store           text        NOT NULL
                              CHECK (store IN ('apple','google')),
  event_type      text        NOT NULL,
  old_status      text,
  new_status      text,
  source          text        DEFAULT 'manual'
                              CHECK (source IN ('webhook','poll','email','manual')),
  raw_payload     jsonb       DEFAULT '{}',
  parsed_summary  text,
  teamhub_task_id uuid,
  created_at      timestamptz DEFAULT now()
);
COMMENT ON TABLE mrq_review_events IS 'Immutable log of review status changes — from webhooks, polling, email, or manual updates';


-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. mrq_tasks_relay — Maps events to TeamHub tasks
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS mrq_tasks_relay (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id          uuid        NOT NULL REFERENCES mrq_apps(id) ON DELETE CASCADE,
  submission_id   uuid        REFERENCES mrq_submissions(id) ON DELETE SET NULL,
  event_id        uuid        REFERENCES mrq_review_events(id) ON DELETE SET NULL,
  teamhub_item_id uuid,
  task_type       text        NOT NULL
                              CHECK (task_type IN (
                                'fix_app','fix_website','fix_metadata','fix_policy',
                                'resubmit','review_response','general'
                              )),
  status          text        DEFAULT 'open'
                              CHECK (status IN ('open','in_progress','resolved','wont_fix')),
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);
COMMENT ON TABLE mrq_tasks_relay IS 'Maps review events to TeamHub tasks — tracks fix status for rejection-to-resubmission loop';


-- ═══════════════════════════════════════════════════════════════════════════════
-- 10. mrq_review_responses — Drafted review replies
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS mrq_review_responses (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id          uuid        NOT NULL REFERENCES mrq_apps(id) ON DELETE CASCADE,
  store           text        NOT NULL
                              CHECK (store IN ('apple','google')),
  review_id       text        NOT NULL,
  rating          int         CHECK (rating >= 1 AND rating <= 5),
  reviewer_name   text,
  review_text     text,
  response_draft  text,
  response_sent   text,
  status          text        DEFAULT 'pending'
                              CHECK (status IN ('pending','draft_ready','approved','sent','skipped')),
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);
COMMENT ON TABLE mrq_review_responses IS 'Store review responses — AI drafts, human approval gate, then sent via store API';


-- ═══════════════════════════════════════════════════════════════════════════════
-- 11. mrq_audit_log — Action log (immutable)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS mrq_audit_log (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id        uuid        REFERENCES mrq_apps(id) ON DELETE SET NULL,
  actor_id      uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_type    text        DEFAULT 'system'
                            CHECK (actor_type IN ('user','system','scheduler','webhook')),
  action        text        NOT NULL,
  summary       text        NOT NULL,
  details       jsonb       DEFAULT '{}',
  created_at    timestamptz DEFAULT now()
);
COMMENT ON TABLE mrq_audit_log IS 'Immutable audit log — every Marq action is recorded for traceability';


-- ═══════════════════════════════════════════════════════════════════════════════
-- 12. mrq_schedule — Polling job configuration
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS mrq_schedule (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id            uuid        NOT NULL REFERENCES mrq_apps(id) ON DELETE CASCADE,
  job_type          text        NOT NULL
                                CHECK (job_type IN (
                                  'google_status_poll','google_review_poll',
                                  'apple_review_sync','apple_status_poll',
                                  'pre_check_rerun','credential_verify'
                                )),
  enabled           bool        DEFAULT true,
  interval_minutes  int         DEFAULT 30,
  last_run_at       timestamptz,
  next_run_at       timestamptz,
  config            jsonb       DEFAULT '{}',
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now(),
  UNIQUE (app_id, job_type)
);
COMMENT ON TABLE mrq_schedule IS 'Polling job configuration — per-app scheduler for status checks, review syncs, and credential verification';


-- ═══════════════════════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════════════════════

-- mrq_app_access
CREATE INDEX IF NOT EXISTS mrq_access_user_idx
  ON mrq_app_access(user_id);

-- mrq_store_credentials
CREATE INDEX IF NOT EXISTS mrq_creds_app_idx
  ON mrq_store_credentials(app_id) WHERE is_active = true;

-- mrq_metadata
CREATE INDEX IF NOT EXISTS mrq_metadata_app_version_idx
  ON mrq_metadata(app_id, version, store);

-- mrq_screenshots
CREATE INDEX IF NOT EXISTS mrq_screenshots_app_idx
  ON mrq_screenshots(app_id, metadata_id);

-- mrq_submissions
CREATE INDEX IF NOT EXISTS mrq_submissions_app_status_idx
  ON mrq_submissions(app_id, status);
CREATE INDEX IF NOT EXISTS mrq_submissions_store_status_idx
  ON mrq_submissions(store, status) WHERE status IN ('submitted','in_review');

-- mrq_pre_checks
CREATE INDEX IF NOT EXISTS mrq_pre_checks_submission_idx
  ON mrq_pre_checks(submission_id);

-- mrq_review_events
CREATE INDEX IF NOT EXISTS mrq_events_app_time_idx
  ON mrq_review_events(app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mrq_events_submission_idx
  ON mrq_review_events(submission_id);

-- mrq_tasks_relay
CREATE INDEX IF NOT EXISTS mrq_tasks_relay_app_idx
  ON mrq_tasks_relay(app_id, status) WHERE status IN ('open','in_progress');

-- mrq_review_responses
CREATE INDEX IF NOT EXISTS mrq_responses_app_status_idx
  ON mrq_review_responses(app_id, status) WHERE status IN ('pending','draft_ready');

-- mrq_audit_log
CREATE INDEX IF NOT EXISTS mrq_audit_app_time_idx
  ON mrq_audit_log(app_id, created_at DESC);

-- mrq_schedule
CREATE INDEX IF NOT EXISTS mrq_schedule_next_run_idx
  ON mrq_schedule(next_run_at, enabled) WHERE enabled = true;


-- ═══════════════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY — Enable on all tables
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE mrq_apps              ENABLE ROW LEVEL SECURITY;
ALTER TABLE mrq_app_access        ENABLE ROW LEVEL SECURITY;
ALTER TABLE mrq_store_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE mrq_metadata          ENABLE ROW LEVEL SECURITY;
ALTER TABLE mrq_screenshots       ENABLE ROW LEVEL SECURITY;
ALTER TABLE mrq_submissions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE mrq_pre_checks        ENABLE ROW LEVEL SECURITY;
ALTER TABLE mrq_review_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE mrq_tasks_relay       ENABLE ROW LEVEL SECURITY;
ALTER TABLE mrq_review_responses  ENABLE ROW LEVEL SECURITY;
ALTER TABLE mrq_audit_log         ENABLE ROW LEVEL SECURITY;
ALTER TABLE mrq_schedule          ENABLE ROW LEVEL SECURITY;


-- ═══════════════════════════════════════════════════════════════════════════════
-- HELPER FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Access check: returns true if user has any role on the app, or is admin
CREATE OR REPLACE FUNCTION mrq_has_access(p_app_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM mrq_app_access
    WHERE app_id = p_app_id AND user_id = auth.uid()
  ) OR get_my_role() = 'admin';
$$;

-- Access check with minimum role requirement
CREATE OR REPLACE FUNCTION mrq_has_role(p_app_id uuid, p_required_role text DEFAULT 'viewer')
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM mrq_app_access
    WHERE app_id = p_app_id
      AND user_id = auth.uid()
      AND (
        p_required_role = 'viewer'
        OR (p_required_role = 'editor' AND role IN ('owner','editor'))
        OR (p_required_role = 'owner'  AND role = 'owner')
      )
  ) OR get_my_role() = 'admin';
$$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- RLS POLICIES
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── mrq_apps ───────────────────────────────────────────────────────────────

CREATE POLICY "mrq apps admin all"
  ON mrq_apps FOR ALL TO authenticated
  USING (get_my_role() = 'admin');

CREATE POLICY "mrq apps member read"
  ON mrq_apps FOR SELECT TO authenticated
  USING (mrq_has_access(id));

CREATE POLICY "mrq apps owner insert"
  ON mrq_apps FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid() OR get_my_role() = 'admin');

CREATE POLICY "mrq apps owner update"
  ON mrq_apps FOR UPDATE TO authenticated
  USING (mrq_has_role(id, 'owner'));

CREATE POLICY "mrq apps owner delete"
  ON mrq_apps FOR DELETE TO authenticated
  USING (mrq_has_role(id, 'owner'));

-- ─── mrq_app_access ─────────────────────────────────────────────────────────

CREATE POLICY "mrq access admin all"
  ON mrq_app_access FOR ALL TO authenticated
  USING (get_my_role() = 'admin');

CREATE POLICY "mrq access member read own"
  ON mrq_app_access FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR mrq_has_role(app_id, 'owner'));

CREATE POLICY "mrq access owner manage"
  ON mrq_app_access FOR INSERT TO authenticated
  WITH CHECK (mrq_has_role(app_id, 'owner'));

CREATE POLICY "mrq access owner update"
  ON mrq_app_access FOR UPDATE TO authenticated
  USING (mrq_has_role(app_id, 'owner'));

CREATE POLICY "mrq access owner delete"
  ON mrq_app_access FOR DELETE TO authenticated
  USING (mrq_has_role(app_id, 'owner'));

-- ─── mrq_audit_log (immutable) ──────────────────────────────────────────────

CREATE POLICY "mrq audit admin all"
  ON mrq_audit_log FOR ALL TO authenticated
  USING (get_my_role() = 'admin');

CREATE POLICY "mrq audit member read"
  ON mrq_audit_log FOR SELECT TO authenticated
  USING (mrq_has_access(app_id));

CREATE POLICY "mrq audit member insert"
  ON mrq_audit_log FOR INSERT TO authenticated
  WITH CHECK (app_id IS NULL OR mrq_has_access(app_id));

-- ─── mrq_review_events (immutable) ─────────────────────────────────────────

CREATE POLICY "mrq events admin all"
  ON mrq_review_events FOR ALL TO authenticated
  USING (get_my_role() = 'admin');

CREATE POLICY "mrq events member read"
  ON mrq_review_events FOR SELECT TO authenticated
  USING (mrq_has_access(app_id));

CREATE POLICY "mrq events member insert"
  ON mrq_review_events FOR INSERT TO authenticated
  WITH CHECK (mrq_has_access(app_id));

-- ─── Child tables: standard pattern (admin + member read + editor write) ────
-- Applied to all remaining child tables that reference app_id

DO $$
DECLARE
  tbl text;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'mrq_store_credentials',
      'mrq_metadata',
      'mrq_screenshots',
      'mrq_submissions',
      'mrq_pre_checks',
      'mrq_tasks_relay',
      'mrq_review_responses',
      'mrq_schedule'
    ])
  LOOP
    -- Admin full access
    EXECUTE format(
      'CREATE POLICY "mrq %s admin all" ON %I FOR ALL TO authenticated USING (get_my_role() = ''admin'')',
      replace(tbl, 'mrq_', ''), tbl
    );
    -- Member read
    EXECUTE format(
      'CREATE POLICY "mrq %s member read" ON %I FOR SELECT TO authenticated USING (mrq_has_access(app_id))',
      replace(tbl, 'mrq_', ''), tbl
    );
    -- Editor insert
    EXECUTE format(
      'CREATE POLICY "mrq %s editor insert" ON %I FOR INSERT TO authenticated WITH CHECK (mrq_has_role(app_id, ''editor''))',
      replace(tbl, 'mrq_', ''), tbl
    );
    -- Editor update
    EXECUTE format(
      'CREATE POLICY "mrq %s editor update" ON %I FOR UPDATE TO authenticated USING (mrq_has_role(app_id, ''editor''))',
      replace(tbl, 'mrq_', ''), tbl
    );
    -- Owner delete
    EXECUTE format(
      'CREATE POLICY "mrq %s owner delete" ON %I FOR DELETE TO authenticated USING (mrq_has_role(app_id, ''owner''))',
      replace(tbl, 'mrq_', ''), tbl
    );
  END LOOP;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- UPDATED_AT TRIGGER
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION update_mrq_timestamp()
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
      'mrq_apps',
      'mrq_store_credentials',
      'mrq_metadata',
      'mrq_screenshots',
      'mrq_submissions',
      'mrq_tasks_relay',
      'mrq_review_responses',
      'mrq_schedule'
    ])
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%s_updated_at ON %I', tbl, tbl
    );
    EXECUTE format(
      'CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_mrq_timestamp()',
      tbl, tbl
    );
  END LOOP;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- DEFAULT SCHEDULE SEEDER
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION mrq_seed_default_schedule(p_app_id uuid)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO mrq_schedule (app_id, job_type, enabled, interval_minutes, next_run_at) VALUES
    (p_app_id, 'google_status_poll',  true,  15,  now() + interval '15 minutes'),
    (p_app_id, 'google_review_poll',  true,  30,  now() + interval '30 minutes'),
    (p_app_id, 'apple_status_poll',   true,  15,  now() + interval '15 minutes'),
    (p_app_id, 'apple_review_sync',   true,  30,  now() + interval '30 minutes'),
    (p_app_id, 'pre_check_rerun',     false, 60,  now() + interval '1 hour'),
    (p_app_id, 'credential_verify',   false, 1440, now() + interval '24 hours')
  ON CONFLICT (app_id, job_type) DO NOTHING;
$$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- DONE
-- ═══════════════════════════════════════════════════════════════════════════════
-- Tables created: 12 (mrq_ prefix)
-- Indexes created: 12
-- RLS enabled: all 12 tables
-- Policies: 3 core tables fully specified + 8 child tables via DO block
-- Functions: mrq_has_access(), mrq_has_role(), update_mrq_timestamp(), mrq_seed_default_schedule()
-- Triggers: updated_at on 8 tables
