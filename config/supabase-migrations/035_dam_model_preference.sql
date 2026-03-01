-- DAM Bot: Add model_preference column to sessions
-- Stores the user's model routing preference per session:
--   "auto"   = planner assigns optimal model per step
--   "haiku"  = force all steps to use Haiku
--   "sonnet" = force all steps to use Sonnet
--   "opus"   = force all steps to use Opus

ALTER TABLE dam_sessions
  ADD COLUMN IF NOT EXISTS model_preference TEXT NOT NULL DEFAULT 'auto';
