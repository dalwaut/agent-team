"""HELM — Website Builder routes.

Mounted at /api/website-builder/

Handles domain search (Hostinger API), platform recommendation, Stripe checkout,
provisioning (Hostinger HITL), and export.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
import textwrap
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx
import stripe
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

import config
from core.supabase import _sb_get, _sb_post, _sb_patch
from core.vault import store_credential
import connectors.hostinger as hostinger_connector

log = logging.getLogger("helm.routes.website_builder")
router = APIRouter(prefix="/api/website-builder", tags=["website-builder"])

# ── Stripe ────────────────────────────────────────────────────────────────────

def _stripe_client() -> stripe.StripeClient:
    key = config.stripe_key()
    if not key:
        mode = "test" if config.STRIPE_TEST_MODE else "live"
        raise HTTPException(502, f"Stripe not configured (STRIPE_{'TEST_' if config.STRIPE_TEST_MODE else ''}SECRET_KEY missing, mode={mode})")
    return stripe.StripeClient(key)


# ── Models ────────────────────────────────────────────────────────────────────

class CheckoutRequest(BaseModel):
    onboarding_id: str
    domain: str                     # e.g. "boutacare"
    tld: str                        # e.g. ".com"
    hosting_plan: str               # "starter" | "pro" | "business"
    platform: str                   # "wordpress" | "nextjs" | "static"
    provider: str                   # "hostinger" | "netlify"
    include_domain_bundle: bool = True
    wp_pro_addon: bool = False


class ExportRequest(BaseModel):
    onboarding_id: str
    domain: str
    tld: str
    hosting_plan: str
    platform: str
    provider: str


# ── Plan definitions ──────────────────────────────────────────────────────────

HOSTING_PLANS = [
    {
        "id": "starter",
        "name": "Starter",
        "price": 10.00,
        "price_id_env": "STRIPE_PRICE_HOSTING_STARTER",
        "features": ["1 website", "10 GB SSD", "Free SSL", "HELM management"],
    },
    {
        "id": "pro",
        "name": "Pro",
        "price": 15.00,
        "price_id_env": "STRIPE_PRICE_HOSTING_PRO",
        "features": ["3 websites", "30 GB SSD", "Free SSL", "Daily backups", "HELM management"],
        "recommended": True,
    },
    {
        "id": "business",
        "name": "Business",
        "price": 25.00,
        "price_id_env": "STRIPE_PRICE_HOSTING_BUSINESS",
        "features": ["Unlimited sites", "100 GB SSD", "Free SSL", "Daily backups", "Priority support", "HELM management"],
    },
]


def _plan_price_id(plan_id: str) -> str:
    plan = next((p for p in HOSTING_PLANS if p["id"] == plan_id), None)
    if not plan:
        raise HTTPException(400, f"Unknown hosting plan: {plan_id}")
    # In test mode, prefer STRIPE_TEST_PRICE_* env vars
    if config.STRIPE_TEST_MODE:
        test_key = "STRIPE_TEST_" + plan["price_id_env"].removeprefix("STRIPE_")
        price_id = os.getenv(test_key, "") or os.getenv(plan["price_id_env"], "")
    else:
        price_id = os.getenv(plan["price_id_env"], "")
    if not price_id:
        raise HTTPException(502, f"Stripe price not configured (mode={'test' if config.STRIPE_TEST_MODE else 'live'})")
    return price_id


def _domain_price_id(bundle: bool) -> str:
    """Return the correct domain price ID for current mode."""
    if bundle:
        key = "STRIPE_TEST_PRICE_DOMAIN_BUNDLE" if config.STRIPE_TEST_MODE else "STRIPE_PRICE_DOMAIN_BUNDLE"
    else:
        key = "STRIPE_TEST_PRICE_DOMAIN_STANDARD" if config.STRIPE_TEST_MODE else "STRIPE_PRICE_DOMAIN_STANDARD"
    return os.getenv(key, "")


# ── Recommendation logic ──────────────────────────────────────────────────────

def _recommend(industry: str, stage: str) -> dict:
    """Return platform/provider/plan recommendation based on business data."""
    industry_lower = (industry or "").lower()

    # E-commerce / retail → WordPress + Pro
    if any(k in industry_lower for k in ("e-commerce", "ecommerce", "retail", "shop", "store")):
        return {
            "platform": "wordpress",
            "provider": "hostinger",
            "plan": "pro",
            "reason": "WordPress with WooCommerce is ideal for e-commerce businesses.",
        }

    # Tech / SaaS / portfolio → Static + Hostinger
    if any(k in industry_lower for k in ("saas", "software", "tech", "portfolio", "agency")):
        return {
            "platform": "static",
            "provider": "hostinger",
            "plan": "starter",
            "reason": "A clean, fast static site is ideal for tech and portfolio businesses.",
        }

    # Default — service / consulting → WordPress + Starter
    return {
        "platform": "wordpress",
        "provider": "hostinger",
        "plan": "starter",
        "reason": "WordPress is the most flexible choice for service and consulting businesses.",
    }


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/domain/check")
async def check_domain(
    name: str,
    tld: str = ".com",
    user: AuthUser = Depends(get_current_user),
):
    """Check domain availability via Hostinger API."""
    if not re.match(r"^[a-z0-9][a-z0-9\-]{0,61}[a-z0-9]?$", name, re.IGNORECASE):
        raise HTTPException(400, "Invalid domain name")

    tld_clean = tld.lstrip(".")
    results = await hostinger_connector.check_availability(name, [tld_clean])
    if results:
        return results[0]
    raise HTTPException(502, "Domain check failed")


@router.get("/domain/suggest")
async def suggest_domains(
    business_name: str,
    user: AuthUser = Depends(get_current_user),
):
    """Auto-suggest available domains based on business name via Hostinger API."""
    slug = re.sub(r"[^a-z0-9]", "", business_name.lower().replace(" ", ""))
    if not slug:
        raise HTTPException(400, "Could not derive a domain slug from business name")

    results = await hostinger_connector.check_availability(slug, ["com", "net", "co", "io"])
    return {"suggestions": results, "slug": slug}


@router.get("/recommend")
async def get_recommendation(
    onboarding_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Return HELM's platform/hosting recommendation for this business."""
    # Load onboarding data to get industry
    data = await _sb_get(f"helm_business_onboarding?id=eq.{onboarding_id}&select=parsed_data,helm_businesses(industry,stage)")
    if not data:
        raise HTTPException(404, "Onboarding not found")

    row = data[0]
    parsed = row.get("parsed_data") or {}
    biz = (row.get("helm_businesses") or [{}])
    if isinstance(biz, list):
        biz = biz[0] if biz else {}
    industry = biz.get("industry") or parsed.get("industry", "")
    stage = biz.get("stage") or parsed.get("stage", "")

    return _recommend(industry, stage)


@router.get("/plans")
async def get_plans(user: AuthUser = Depends(get_current_user)):
    """Return hosting plan list with prices. Domain price from Hostinger catalog."""
    plans = []
    for p in HOSTING_PLANS:
        plans.append({
            "id": p["id"],
            "name": p["name"],
            "price": p["price"],
            "features": p["features"],
            "recommended": p.get("recommended", False),
            "price_id_configured": bool(os.getenv(p["price_id_env"], "")),
        })

    # Get real domain price from Hostinger catalog (fallback to default)
    domain_standard = await hostinger_connector.get_domain_price("com")
    domain_bundle = 1.00  # bundled with hosting purchase

    return {
        "hosting_plans": plans,
        "domain": {
            "standard_price": domain_standard,
            "bundle_price": domain_bundle,
            "currency": "USD",
        },
        "wp_pro_addon": {
            "price": 15.00,
            "label": "WP Pro Updates & Backup (BoutaByte)",
            "description": "Automated updates, daily backups, malware scans.",
        },
    }


@router.post("/checkout")
async def create_checkout(
    req: CheckoutRequest,
    user: AuthUser = Depends(get_current_user),
):
    """Create a Stripe Checkout session for domain + hosting purchase."""
    sc = _stripe_client()

    fqdn = f"{req.domain}.{req.tld.lstrip('.')}"

    # Build line items
    line_items = []

    # Hosting subscription
    hosting_price_id = _plan_price_id(req.hosting_plan)
    line_items.append({
        "price": hosting_price_id,
        "quantity": 1,
    })

    # Domain (bundle at $1.00 or standard)
    domain_price_id = _domain_price_id(req.include_domain_bundle)

    if domain_price_id:
        line_items.append({
            "price": domain_price_id,
            "quantity": 1,
        })

    # Optional WP Pro add-on
    if req.wp_pro_addon and req.platform == "wordpress":
        wp_addon_price_id = os.getenv("STRIPE_TEST_PRICE_WP_PRO_ADDON" if config.STRIPE_TEST_MODE else "STRIPE_PRICE_WP_PRO_ADDON", "")
        if wp_addon_price_id:
            line_items.append({
                "price": wp_addon_price_id,
                "quantity": 1,
            })

    # Load business_id from onboarding
    ob_data = await _sb_get(f"helm_business_onboarding?id=eq.{req.onboarding_id}&select=business_id")
    business_id = ob_data[0]["business_id"] if ob_data else None

    # Build success + cancel URLs
    base_url = config.HELM_PUBLIC_URL.rstrip("/")
    success_url = f"{base_url}/helm/?ws_session={{CHECKOUT_SESSION_ID}}&ob={req.onboarding_id}"
    cancel_url = f"{base_url}/helm/?ob={req.onboarding_id}&step=4"

    # Create Stripe checkout session (stripe-python 14.x: sc.v1.checkout.sessions)
    session = sc.v1.checkout.sessions.create(params={
        "mode": "subscription" if req.hosting_plan else "payment",
        "line_items": line_items,
        "success_url": success_url,
        "cancel_url": cancel_url,
        "metadata": {
            "onboarding_id": req.onboarding_id,
            "business_id": str(business_id or ""),
            "domain": req.domain,
            "tld": req.tld,
            "fqdn": fqdn,
            "platform": req.platform,
            "provider": req.provider,
            "hosting_plan": req.hosting_plan,
            "include_domain_bundle": str(req.include_domain_bundle).lower(),
            "wp_pro_addon": str(req.wp_pro_addon).lower(),
        },
    })

    # Record the build row as pending
    if business_id:
        await _sb_post("helm_website_builds", {
            "business_id": str(business_id),
            "domain": req.domain,
            "tld": req.tld,
            "platform": req.platform,
            "provider": req.provider,
            "hosting_plan": req.hosting_plan,
            "stripe_session_id": session.id,
            "stripe_payment_status": "pending",
            "provision_status": "pending",
            "wp_pro_addon": req.wp_pro_addon,
        })

    return {"checkout_url": session.url, "session_id": session.id}


@router.post("/webhook/complete")
async def webhook_complete(request: Request):
    """Stripe webhook — called when checkout.session.completed fires.

    Also called directly after Stripe redirects back to HELM (client-side trigger
    via GET param ws_session=...) — validates the session server-side then provisions.
    """
    webhook_secret = config.stripe_webhook_secret()
    payload = await request.body()
    sig_header = request.headers.get("stripe-signature", "")

    sc = _stripe_client()

    if webhook_secret and sig_header:
        try:
            event = sc.construct_event(payload, sig_header, webhook_secret)
        except stripe.SignatureVerificationError:
            raise HTTPException(400, "Invalid Stripe signature")

        if event.type != "checkout.session.completed":
            return {"received": True}

        session = event.data.object
    else:
        # Direct client-side call (ws_session param) — validate session by ID
        body = await request.json() if not payload else json.loads(payload)
        session_id = body.get("session_id") or body.get("ws_session")
        if not session_id:
            raise HTTPException(400, "session_id required")
        session = sc.v1.checkout.sessions.retrieve(session_id, params={})
        if session.payment_status not in ("paid", "no_payment_required"):
            raise HTTPException(402, "Payment not complete")

    meta = session.metadata or {}
    onboarding_id = meta.get("onboarding_id")
    business_id = meta.get("business_id")
    fqdn = meta.get("fqdn", "")
    platform = meta.get("platform", "wordpress")
    provider = meta.get("provider", "hostinger")
    hosting_plan = meta.get("hosting_plan", "starter")
    wp_pro_addon = meta.get("wp_pro_addon", "false").lower() == "true"

    if not onboarding_id or not business_id:
        raise HTTPException(400, "Missing metadata in session")

    # ── Register HELM subscription ─────────────────────────────────────────────
    stripe_subscription_id = getattr(session, "subscription", None)
    stripe_customer_id = getattr(session, "customer", None)
    subscription_info: dict = {"plan": hosting_plan, "is_test": config.STRIPE_TEST_MODE}

    if stripe_subscription_id and business_id:
        try:
            sub_obj = sc.v1.subscriptions.retrieve(stripe_subscription_id, params={})
            period_start = getattr(sub_obj, "current_period_start", None)
            period_end = getattr(sub_obj, "current_period_end", None)
            cancel_at_period_end = getattr(sub_obj, "cancel_at_period_end", False)
            sub_status = getattr(sub_obj, "status", "active")

            from core.subscriptions import upsert_from_stripe
            await upsert_from_stripe(
                business_id=business_id,
                stripe_subscription_id=stripe_subscription_id,
                stripe_customer_id=str(stripe_customer_id) if stripe_customer_id else None,
                stripe_session_id=session.id,
                status=sub_status,
                plan=hosting_plan,
                current_period_start=period_start,
                current_period_end=period_end,
                cancel_at_period_end=cancel_at_period_end,
                metadata={"platform": platform, "fqdn": fqdn, "test_mode": config.STRIPE_TEST_MODE},
            )
            subscription_info["status"] = sub_status
            subscription_info["period_end"] = period_end
            subscription_info["id"] = stripe_subscription_id
            log.info("Subscription %s registered for business %s", stripe_subscription_id, business_id)
        except Exception as exc:
            log.warning("Could not register subscription: %s", exc)
            subscription_info["status"] = "active"  # assume active on Stripe success

    # Update payment status in DB
    await _sb_patch(
        f"helm_website_builds?stripe_session_id=eq.{session.id}",
        {"stripe_payment_status": "paid", "provision_status": "provisioning"},
    )

    provision_data: dict = {}
    is_sandbox = config.STRIPE_TEST_MODE

    if is_sandbox:
        # ── Sandbox provisioning ───────────────────────────────────────────────
        # DNS record auto-created on boutabyte.cloud via Hostinger DNS API.
        # WordPress install on BB VPS is queued as HITL (no API for WP installs).
        domain_slug = meta.get("domain", "site")
        sandbox_subdomain = f"{domain_slug}.boutabyte.cloud"
        sandbox_url = f"https://{sandbox_subdomain}"
        dns_created = False

        try:
            await hostinger_connector.create_subdomain(domain_slug)
            dns_created = True
            log.info("Sandbox DNS record created: %s", sandbox_subdomain)
        except Exception as exc:
            log.warning("Could not auto-create DNS record for %s: %s", sandbox_subdomain, exc)

        hitl_payload = {
            "title": f"[SANDBOX] Install WordPress — {sandbox_subdomain}",
            "description": textwrap.dedent(f"""
                **TEST MODE PURCHASE** — No real money was charged.

                A HELM customer completed a test checkout. The DNS record has been
                {"✓ **auto-created**" if dns_created else "⚠ **NOT created (DNS API error)**"} for `{sandbox_subdomain} → 72.60.115.74`.

                **Intended Domain:** {fqdn}
                **Staging URL:** {sandbox_url}
                **Platform:** {platform}
                **Hosting Plan:** {hosting_plan}
                **Business ID:** {business_id}
                **WP Pro Add-on:** {"Yes" if wp_pro_addon else "No"}

                Steps on BB VPS (ssh root@bb-vps):
                1. {"Skip — DNS already done ✓" if dns_created else f"Manually create A record: {sandbox_subdomain} → 72.60.115.74"}
                2. Create WordPress Docker container: `docker run -d --name wp-{domain_slug} -p <port>:80 wordpress`
                3. Configure Caddy reverse proxy: add `{sandbox_subdomain}` route to /etc/caddy/Caddyfile
                4. Install WordPress, create Admin user, add the HELM customer's email as Administrator
                5. Email the customer their staging site credentials
                6. Update `provision_data` in `helm_website_builds` with `{{"site_url": "{sandbox_url}"}}`
                7. Set `provision_status = 'live'`
            """).strip(),
            "priority": "high",
            "source": "helm-website-builder-sandbox",
            "meta": {
                "business_id": business_id,
                "onboarding_id": onboarding_id,
                "fqdn": fqdn,
                "sandbox_subdomain": sandbox_subdomain,
                "dns_created": dns_created,
                "platform": platform,
                "hosting_plan": hosting_plan,
                "sandbox": True,
            },
        }
        provision_data = {
            "hitl_queued": True,
            "sandbox": True,
            "domain": fqdn,
            "sandbox_subdomain": sandbox_subdomain,
            "sandbox_url": sandbox_url,
            "dns_created": dns_created,
            "plan": hosting_plan,
            "note": f"Staging at {sandbox_url} — DNS {'auto-created' if dns_created else 'pending manual creation'}",
        }
    else:
        # ── Production provisioning — Hostinger HITL ──────────────────────────
        hitl_payload = {
            "title": f"Provision Hostinger Site — {fqdn}",
            "description": textwrap.dedent(f"""
                A HELM customer has purchased website hosting. Please provision their site.

                **Domain:** {fqdn}
                **Platform:** {platform}
                **Hosting Plan:** {hosting_plan}
                **Business ID:** {business_id}
                **Onboarding ID:** {onboarding_id}
                **WP Pro Add-on:** {"Yes" if wp_pro_addon else "No"}

                Steps:
                1. Log in to Hostinger Agency account (hPanel)
                2. Register domain {fqdn} on the agency account
                3. Create new hosting under the {hosting_plan} plan for {fqdn}
                4. {"Install WordPress via Auto-Installer" if platform == "wordpress" else "Deploy starter static site"}
                5. {"Install the OPAI WP Connector plugin" if platform == "wordpress" else "Connect site to HELM"}
                6. Update `provision_data` in `helm_website_builds` with the live URL
                7. Set `provision_status = 'live'`
            """).strip(),
            "priority": "high",
            "source": "helm-website-builder",
            "meta": {
                "business_id": business_id,
                "onboarding_id": onboarding_id,
                "fqdn": fqdn,
                "platform": platform,
                "provider": provider,
                "hosting_plan": hosting_plan,
                "wp_pro_addon": wp_pro_addon,
            },
        }
        provision_data = {"hitl_queued": True, "domain": fqdn, "plan": hosting_plan}

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                f"{config.TASKS_URL}/api/tasks",
                json=hitl_payload,
                headers={"Content-Type": "application/json"},
            )
        provision_status = "pending"
        log.info("HITL provisioning task queued for %s (sandbox=%s)", fqdn, is_sandbox)
    except Exception as exc:
        log.warning("Could not queue HITL task: %s", exc)
        provision_data["hitl_queued"] = False
        provision_data["error"] = str(exc)
        provision_status = "pending"

    # ── Update build record ────────────────────────────────────────────────────
    await _sb_patch(
        f"helm_website_builds?stripe_session_id=eq.{session.id}",
        {
            "provision_status": provision_status,
            "provision_data": provision_data,
            "wp_pro_addon": wp_pro_addon,
        },
    )

    # ── Update business website field ──────────────────────────────────────────
    website_url = provision_data.get("site_url") or provision_data.get("sandbox_url") or f"https://{fqdn}"
    await _sb_patch(
        f"helm_businesses?id=eq.{business_id}",
        {"website": website_url},
    )

    # ── Advance onboarding to step 5 ───────────────────────────────────────────
    await _sb_patch(
        f"helm_business_onboarding?id=eq.{onboarding_id}",
        {"current_step": 5},
    )

    # ── WP Pro add-on: register site in OP WordPress ──────────────────────────
    if wp_pro_addon and platform == "wordpress":
        try:
            await _register_in_op_wordpress(
                business_id=business_id,
                fqdn=fqdn,
                hosting_plan=hosting_plan,
                provision_data=provision_data,
            )
        except Exception as exc:
            log.warning("OP WordPress registration failed (non-fatal): %s", exc)

    # Build line-item summary for frontend display
    plan_obj = next((p for p in HOSTING_PLANS if p["id"] == hosting_plan), {"name": hosting_plan, "price": 10.00})
    domain_cost = 1.00 if meta.get("include_domain_bundle") == "true" else 14.99
    order_summary = {
        "domain": fqdn,
        "domain_price": domain_cost,
        "hosting_plan": plan_obj["name"],
        "hosting_price": plan_obj.get("price", 10.00),
        "wp_pro_addon": wp_pro_addon,
        "sandbox": is_sandbox,
    }

    return {
        "status": "ok",
        "provision_status": provision_status,
        "provision_data": provision_data,
        "website_url": website_url,
        "advance_to_step": 5,
        "subscription": subscription_info,
        "order_summary": order_summary,
    }


@router.get("/session-status")
async def session_status(
    session_id: str,
    user: AuthUser = Depends(get_current_user),
):
    """Check a Stripe checkout session status (called on Stripe redirect return)."""
    sc = _stripe_client()
    try:
        session = sc.v1.checkout.sessions.retrieve(session_id, params={})
        return {
            "session_id": session_id,
            "payment_status": session.payment_status,
            "metadata": session.metadata,
        }
    except Exception as exc:
        raise HTTPException(502, str(exc))


@router.get("/export")
async def export_setup_guide(
    onboarding_id: str,
    domain: str,
    tld: str = ".com",
    hosting_plan: str = "starter",
    platform: str = "wordpress",
    provider: str = "hostinger",
    user: AuthUser = Depends(get_current_user),
):
    """Generate and return a Markdown setup guide for the 'Export' option."""
    fqdn = f"{domain}.{tld.lstrip('.')}"
    plan_obj = next((p for p in HOSTING_PLANS if p["id"] == hosting_plan), HOSTING_PLANS[0])

    guide = _generate_guide(fqdn, platform, provider, plan_obj)

    filename = f"HELM-Website-Setup-{fqdn}.md"
    return Response(
        content=guide,
        media_type="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Helpers ───────────────────────────────────────────────────────────────────

def _generate_guide(fqdn: str, platform: str, provider: str, plan: dict) -> str:
    """Generate a Markdown setup guide."""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    if platform == "wordpress":
        platform_section = textwrap.dedent(f"""
            ## Platform: WordPress

            1. **Log in to Hostinger** → hPanel → Hosting → Add Website
            2. Select **{plan["name"]} plan** (${plan["price"]}/mo)
            3. Install WordPress via the Auto-Installer
            4. Set admin credentials and note them securely

            ### Connect to HELM
            1. In WordPress admin, go to **Users → Profile → Application Passwords**
            2. Create a new application password named "HELM"
            3. Copy the password and enter it in HELM → Website Setup
        """).strip()
    else:
        platform_section = textwrap.dedent(f"""
            ## Platform: Next.js / Static (Netlify)

            1. **Sign up at [Netlify](https://app.netlify.com)** if you don't have an account
            2. Create a new site (or connect your Git repo)
            3. Go to **User Settings → Applications → Personal Access Tokens**
            4. Create a token named "HELM"
            5. Copy the token and enter it in HELM → Website Setup
        """).strip()

    guide = textwrap.dedent(f"""
        # HELM Website Setup Guide
        **Generated:** {now}
        **Domain:** {fqdn}
        **Platform:** {platform.capitalize()}
        **Hosting:** {provider.capitalize()} — {plan["name"]} plan

        ---

        ## Step 1: Register Your Domain

        1. Go to [GoDaddy.com](https://godaddy.com) and search for **{fqdn}**
        2. Add it to your cart and complete purchase
        3. In GoDaddy DNS settings, point nameservers to your hosting provider:
           - **Hostinger NS:** ns1.dns-parking.com / ns2.dns-parking.com
           - **Netlify:** DNS delegation docs at docs.netlify.com/domains-https/

        ## Step 2: Set Up Hosting

        {platform_section}

        ## Step 3: Connect Back to HELM

        Once your site is live, return to HELM onboarding and enter your
        site credentials in the **Website Setup** step.

        ---

        *This guide was generated by HELM — Handsfree Enterprise Launch Machine.*
        *For support, contact your HELM administrator.*
    """).strip()

    return guide


async def _register_in_op_wordpress(
    business_id: str,
    fqdn: str,
    hosting_plan: str,
    provision_data: dict,
) -> None:
    """Register a newly provisioned WordPress site in the OP WordPress tool.

    This adds the site to the OP WordPress managed sites list, fully connected
    and ready for the OPAI WP plugin to be pushed.
    """
    site_url = provision_data.get("site_url") or f"https://{fqdn}"

    # OP WordPress stores managed sites in helm_businesses.website and also
    # has its own site registry in the opai-wordpress tool.
    # We call the OP WordPress internal API to register the site.
    op_wp_url = os.getenv("OP_WORDPRESS_URL", "http://127.0.0.1:8095")

    payload = {
        "site_url": site_url,
        "domain": fqdn,
        "business_id": business_id,
        "hosting_plan": hosting_plan,
        "plugin_auto_push": True,     # triggers plugin deployment queue
        "source": "helm-website-builder",
        "provision_data": provision_data,
    }

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            f"{op_wp_url}/api/sites/register",
            json=payload,
            headers={
                "Content-Type": "application/json",
                "X-Internal-Key": os.getenv("INTERNAL_API_KEY", ""),
            },
        )
        if resp.status_code not in (200, 201, 202):
            log.warning(
                "OP WordPress register returned %s: %s",
                resp.status_code,
                resp.text[:200],
            )
        else:
            log.info("Site %s registered in OP WordPress (plugin push queued)", fqdn)
