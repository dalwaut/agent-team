-- 010_marketplace_and_n8n.sql — Marketplace catalog + n8n provisioning
-- Extends profiles with marketplace tier + n8n status
-- New tables: marketplace_products, marketplace_user_access

-- ── Profile Extensions ──────────────────────────────────────

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS marketplace_tier TEXT DEFAULT 'free';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS n8n_provisioned BOOLEAN DEFAULT FALSE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS n8n_username TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS n8n_provisioned_at TIMESTAMPTZ;

-- ── Marketplace Products (cached catalog from BoutaByte) ────

CREATE TABLE IF NOT EXISTS marketplace_products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bb_id TEXT UNIQUE,
    product_type TEXT NOT NULL CHECK (product_type IN ('webapp', 'automation', 'plugin', 'mobile')),
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    icon TEXT,
    tier_requirement TEXT DEFAULT 'free' CHECK (tier_requirement IN ('free', 'starter', 'pro', 'unlimited')),
    category TEXT,
    tags TEXT[] DEFAULT '{}',
    bb_url TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE marketplace_products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read active products"
    ON marketplace_products FOR SELECT
    USING (is_active = TRUE);

CREATE POLICY "Admins can manage products"
    ON marketplace_products FOR ALL
    USING (
        (SELECT raw_app_meta_data->>'role' FROM auth.users WHERE id = auth.uid()) = 'admin'
    );

CREATE INDEX idx_marketplace_products_type ON marketplace_products(product_type);
CREATE INDEX idx_marketplace_products_tier ON marketplace_products(tier_requirement);
CREATE INDEX idx_marketplace_products_slug ON marketplace_products(slug);

-- ── Marketplace User Access (per-user product overrides) ────

CREATE TABLE IF NOT EXISTS marketplace_user_access (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES marketplace_products(id) ON DELETE CASCADE,
    granted_by UUID REFERENCES profiles(id),
    granted_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT unique_user_product UNIQUE (user_id, product_id)
);

ALTER TABLE marketplace_user_access ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can see own grants"
    ON marketplace_user_access FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Admins can manage all grants"
    ON marketplace_user_access FOR ALL
    USING (
        (SELECT raw_app_meta_data->>'role' FROM auth.users WHERE id = auth.uid()) = 'admin'
    );

CREATE INDEX idx_marketplace_user_access_user ON marketplace_user_access(user_id);
CREATE INDEX idx_marketplace_user_access_product ON marketplace_user_access(product_id);
