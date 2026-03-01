-- Migration 032: Add extended fields to helm_businesses
-- Stores goals, content strategy, products, competitors, and brand info
-- previously only stored in onboarding step_data

ALTER TABLE helm_businesses
  ADD COLUMN IF NOT EXISTS goals_3mo text,
  ADD COLUMN IF NOT EXISTS goals_6mo text,
  ADD COLUMN IF NOT EXISTS goals_12mo text,
  ADD COLUMN IF NOT EXISTS content_pillars text,
  ADD COLUMN IF NOT EXISTS avoid_topics text,
  ADD COLUMN IF NOT EXISTS revenue_model text,
  ADD COLUMN IF NOT EXISTS pain_points text,
  ADD COLUMN IF NOT EXISTS products jsonb,
  ADD COLUMN IF NOT EXISTS competitors jsonb,
  ADD COLUMN IF NOT EXISTS website text,
  ADD COLUMN IF NOT EXISTS brand_color_primary text DEFAULT '#e11d48',
  ADD COLUMN IF NOT EXISTS logo_url text;
