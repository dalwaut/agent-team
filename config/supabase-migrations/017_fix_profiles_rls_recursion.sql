-- ============================================================
-- 017: Fix infinite recursion in profiles RLS policies
-- Applied: 2026-02-18
--
-- Problem: Admin policies on `profiles` used EXISTS subqueries
-- that read `profiles` itself, causing infinite recursion when
-- evaluated via anon key + user JWT (mobile app direct access).
-- Backend services were unaffected (service role key bypasses RLS).
--
-- Solution: SECURITY DEFINER function `get_my_role()` reads role
-- bypassing RLS, replaces all self-referencing subqueries.
--
-- Tables fixed: profiles, conversations, messages, dev_workspaces,
--               system_settings (8 policies total)
-- ============================================================

-- Step 1: Create the helper function
CREATE OR REPLACE FUNCTION get_my_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM profiles WHERE id = auth.uid();
$$;

-- Step 2: Fix profiles table policies
DROP POLICY IF EXISTS "Admins can read all profiles" ON profiles;
DROP POLICY IF EXISTS "Admins can update any profile" ON profiles;

CREATE POLICY "Admins can read all profiles" ON profiles
  FOR SELECT USING (auth.uid() = id OR get_my_role() = 'admin');

CREATE POLICY "Admins can update any profile" ON profiles
  FOR UPDATE USING (auth.uid() = id OR get_my_role() = 'admin');

-- Step 3: Fix conversations table policies
DROP POLICY IF EXISTS "Admins can read all conversations" ON conversations;

CREATE POLICY "Admins can read all conversations" ON conversations
  FOR SELECT USING (auth.uid() = user_id OR get_my_role() = 'admin');

-- Step 4: Fix messages table policies
DROP POLICY IF EXISTS "Admins can read all messages" ON messages;

CREATE POLICY "Admins can read all messages" ON messages
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM conversations c WHERE c.id = messages.conversation_id AND c.user_id = auth.uid())
    OR get_my_role() = 'admin'
  );

-- Step 5: Fix dev_workspaces table policies
DROP POLICY IF EXISTS "dev_workspaces_admin_all" ON dev_workspaces;
DROP POLICY IF EXISTS "dev_workspaces_admin_select" ON dev_workspaces;

CREATE POLICY "dev_workspaces_admin_all" ON dev_workspaces
  FOR ALL USING (get_my_role() = 'admin');

CREATE POLICY "dev_workspaces_admin_select" ON dev_workspaces
  FOR SELECT USING (auth.uid() = user_id OR get_my_role() = 'admin');

-- Step 6: Fix system_settings table policies
DROP POLICY IF EXISTS "Admins can read settings" ON system_settings;
DROP POLICY IF EXISTS "Admins can update settings" ON system_settings;
DROP POLICY IF EXISTS "Admins can insert settings" ON system_settings;

CREATE POLICY "Admins can read settings" ON system_settings
  FOR SELECT USING (get_my_role() = 'admin');

CREATE POLICY "Admins can update settings" ON system_settings
  FOR UPDATE USING (get_my_role() = 'admin');

CREATE POLICY "Admins can insert settings" ON system_settings
  FOR INSERT WITH CHECK (get_my_role() = 'admin');
