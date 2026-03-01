-- 022_wp_sites_admin_password.sql — Add admin_password column to wp_sites
-- The admin_password is the real WP login password (not Application Password).
-- Used for auto-login to wp-admin and auto-installing the OPAI Connector plugin.

ALTER TABLE public.wp_sites ADD COLUMN IF NOT EXISTS admin_password TEXT;
