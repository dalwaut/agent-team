-- OP WordPress — wp_sites table for multi-site management
-- Migration: 018_create_wp_sites_table

CREATE TABLE IF NOT EXISTS wp_sites (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    api_base TEXT DEFAULT '/wp-json',
    username TEXT NOT NULL,
    app_password TEXT NOT NULL,
    is_woocommerce BOOLEAN DEFAULT false,
    woo_key TEXT,
    woo_secret TEXT,
    last_check TIMESTAMPTZ,
    status TEXT DEFAULT 'unknown',
    wp_version TEXT,
    php_version TEXT,
    theme TEXT,
    plugins_total INT DEFAULT 0,
    plugins_updates INT DEFAULT 0,
    themes_updates INT DEFAULT 0,
    core_update BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE wp_sites ENABLE ROW LEVEL SECURITY;

-- Users can manage their own sites
CREATE POLICY "Users manage own sites" ON wp_sites
    FOR ALL USING (auth.uid() = user_id);

-- Admins can see all sites
CREATE POLICY "Admins see all sites" ON wp_sites
    FOR ALL USING (
        EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
    );
