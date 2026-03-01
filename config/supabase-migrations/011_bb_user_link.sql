-- 011: Add BoutaByte user association columns to profiles
-- Links OPAI users to their BB2.0 counterparts for tier sync

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS bb_user_id UUID;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS bb_linked_at TIMESTAMPTZ;
