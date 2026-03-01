-- HELM subscriptions — tracks Stripe subscription per business
-- Drives access control for HELM generative features

CREATE TABLE IF NOT EXISTS helm_subscriptions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES helm_businesses(id) ON DELETE CASCADE,
    stripe_customer_id  text,
    stripe_subscription_id text UNIQUE,
    stripe_session_id   text,
    status              text NOT NULL DEFAULT 'active',
    -- status values: active | past_due | canceled | unpaid | paused
    plan                text,         -- 'starter' | 'pro' | 'business'
    current_period_start timestamptz,
    current_period_end   timestamptz,
    cancel_at_period_end boolean DEFAULT false,
    canceled_at          timestamptz,
    metadata             jsonb,
    created_at           timestamptz DEFAULT now(),
    updated_at           timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_helm_subscriptions_business_id ON helm_subscriptions(business_id);
CREATE INDEX IF NOT EXISTS idx_helm_subscriptions_stripe_sub_id ON helm_subscriptions(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_helm_subscriptions_status ON helm_subscriptions(status);

-- RLS
ALTER TABLE helm_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "helm_subscriptions_service_all"
    ON helm_subscriptions FOR ALL
    TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "helm_subscriptions_user_read"
    ON helm_subscriptions FOR SELECT
    TO authenticated
    USING (helm_has_access(business_id));

-- Updated_at trigger
CREATE OR REPLACE FUNCTION helm_subscriptions_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER helm_subscriptions_updated_at
    BEFORE UPDATE ON helm_subscriptions
    FOR EACH ROW EXECUTE FUNCTION helm_subscriptions_set_updated_at();

-- Helper view: is a business's subscription currently active?
CREATE OR REPLACE VIEW helm_subscription_status AS
SELECT
    b.id AS business_id,
    b.name AS business_name,
    s.stripe_subscription_id,
    s.status,
    s.plan,
    s.current_period_end,
    s.cancel_at_period_end,
    CASE
        WHEN s.id IS NULL THEN false
        WHEN s.status IN ('active', 'trialing') THEN true
        ELSE false
    END AS has_active_subscription
FROM helm_businesses b
LEFT JOIN helm_subscriptions s ON s.business_id = b.id
    AND s.status IN ('active', 'trialing', 'past_due');
