"""Marq — Legal/Privacy pre-submission checks (9 checks, all blockers).

These catch the most common rejection reasons from both Apple and Google.
Each check receives (app, metadata, submission, screenshots) dicts.
"""

import logging
import httpx

from core.checker import register_check

log = logging.getLogger("marq.checks.legal")

# Apple and Google guideline URLs
APPLE_PRIVACY = "https://developer.apple.com/app-store/review/guidelines/#privacy"
APPLE_IAP = "https://developer.apple.com/app-store/review/guidelines/#in-app-purchase"
GOOGLE_PRIVACY = "https://support.google.com/googleplay/android-developer/answer/9859455"
GOOGLE_DATA_SAFETY = "https://support.google.com/googleplay/android-developer/answer/10787469"


async def _url_accessible(url: str, timeout: float = 10.0) -> tuple[bool, int]:
    """Check if a URL is accessible. Returns (accessible, status_code)."""
    if not url:
        return False, 0
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            r = await client.get(url)
            return r.is_success, r.status_code
    except Exception:
        return False, 0


def _has_text(text: str) -> bool:
    """Check if a string has meaningful content (not empty/whitespace)."""
    return bool(text and text.strip())


# ═══════════════════════════════════════════════════════════════════════════════
# Check 1: Privacy Policy URL Exists and Returns 200
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("privacy_policy_exists", "legal", "blocker",
                 "Privacy policy URL must be accessible and return HTTP 200")
async def check_privacy_policy_exists(app, metadata, submission, screenshots):
    """Both Apple and Google require a valid, accessible privacy policy URL."""
    # Check app-level first, then metadata-level
    url = app.get("privacy_policy_url") or metadata.get("privacy_policy_url")

    if not url:
        return {
            "status": "failed",
            "recommendation": "Add a privacy policy URL to your app settings. Both Apple and Google require this for all apps.",
            "doc_url": APPLE_PRIVACY,
            "details": {"url": None, "reason": "No privacy policy URL configured"},
        }

    accessible, status_code = await _url_accessible(url)
    if not accessible:
        return {
            "status": "failed",
            "recommendation": f"Privacy policy URL returned HTTP {status_code}. Ensure the page is publicly accessible without authentication.",
            "doc_url": APPLE_PRIVACY,
            "details": {"url": url, "status_code": status_code},
        }

    return {
        "status": "passed",
        "details": {"url": url, "status_code": status_code},
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Check 2: Privacy Policy Content Quality
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("privacy_policy_content", "legal", "blocker",
                 "Privacy policy must cover required topics: data collection, retention, deletion, sharing")
async def check_privacy_policy_content(app, metadata, submission, screenshots):
    """Fetch privacy policy and check for required sections."""
    url = app.get("privacy_policy_url") or metadata.get("privacy_policy_url")

    if not url:
        return {
            "status": "skipped",
            "recommendation": "Cannot verify content — no privacy policy URL set.",
            "details": {"reason": "no_url"},
        }

    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
            r = await client.get(url)
            if not r.is_success:
                return {
                    "status": "skipped",
                    "recommendation": f"Could not fetch privacy policy (HTTP {r.status_code}).",
                    "details": {"status_code": r.status_code},
                }
            body = r.text.lower()
    except Exception as e:
        return {
            "status": "skipped",
            "recommendation": f"Could not fetch privacy policy: {e}",
            "details": {"error": str(e)},
        }

    # Required topics and keyword patterns
    required_topics = {
        "data_collection": ["collect", "gather", "obtain", "information we collect", "data we collect", "personal data", "personal information"],
        "data_retention": ["retain", "retention", "how long", "store your", "keep your", "deletion period", "data storage"],
        "data_deletion": ["delete", "deletion", "erase", "remove your", "right to delete", "data removal", "account deletion"],
        "data_sharing": ["share", "sharing", "third part", "disclose", "transfer", "provide to"],
    }

    found = {}
    missing = []
    for topic, keywords in required_topics.items():
        topic_found = any(kw in body for kw in keywords)
        found[topic] = topic_found
        if not topic_found:
            missing.append(topic.replace("_", " "))

    if missing:
        return {
            "status": "failed",
            "recommendation": f"Privacy policy is missing required sections: {', '.join(missing)}. Apple and Google both require these topics to be addressed.",
            "doc_url": APPLE_PRIVACY,
            "details": {"found": found, "missing": missing},
        }

    return {
        "status": "passed",
        "details": {"found": found},
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Check 3: Support URL Accessible
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("support_url_accessible", "legal", "blocker",
                 "Support URL must be accessible and return HTTP 200")
async def check_support_url_accessible(app, metadata, submission, screenshots):
    """Both stores require a working support URL."""
    url = app.get("support_url") or metadata.get("support_url")

    if not url:
        return {
            "status": "failed",
            "recommendation": "Add a support URL. Both Apple and Google require a way for users to contact you.",
            "doc_url": "https://developer.apple.com/app-store/review/guidelines/#customer-support",
            "details": {"url": None},
        }

    accessible, status_code = await _url_accessible(url)
    if not accessible:
        return {
            "status": "failed",
            "recommendation": f"Support URL returned HTTP {status_code}. Ensure the page is publicly accessible.",
            "details": {"url": url, "status_code": status_code},
        }

    return {
        "status": "passed",
        "details": {"url": url, "status_code": status_code},
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Check 4: Contact Information Present
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("contact_info_present", "legal", "blocker",
                 "App metadata must include contact email or phone")
async def check_contact_info_present(app, metadata, submission, screenshots):
    """Google requires a contact email. Apple requires support info."""
    # Check metadata content_rating_data for contact info, or support URL
    support_url = app.get("support_url") or metadata.get("support_url")
    content_rating = metadata.get("content_rating_data", {})
    has_contact_email = bool(content_rating.get("contact_email"))
    has_contact_phone = bool(content_rating.get("contact_phone"))

    if support_url or has_contact_email or has_contact_phone:
        return {
            "status": "passed",
            "details": {
                "support_url": bool(support_url),
                "contact_email": has_contact_email,
                "contact_phone": has_contact_phone,
            },
        }

    return {
        "status": "failed",
        "recommendation": "Add contact information. Google Play requires a contact email. Apple requires a support URL or contact method.",
        "doc_url": "https://support.google.com/googleplay/android-developer/answer/9859152",
        "details": {"support_url": False, "contact_email": False, "contact_phone": False},
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Check 5: Account Deletion Mechanism
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("account_deletion", "legal", "blocker",
                 "Apps with accounts must provide account deletion mechanism")
async def check_account_deletion(app, metadata, submission, screenshots):
    """Apple requires account deletion for any app with sign-in (since June 2022).
    Google requires it too (since Dec 2023)."""
    # Check if privacy policy mentions deletion
    url = app.get("privacy_policy_url") or metadata.get("privacy_policy_url")
    full_desc = metadata.get("full_description", "") or ""

    # If app doesn't seem to have accounts, pass with info
    account_keywords = ["sign in", "log in", "login", "sign up", "register", "create account", "account"]
    desc_lower = full_desc.lower()
    has_accounts = any(kw in desc_lower for kw in account_keywords)

    if not has_accounts:
        return {
            "status": "passed",
            "details": {"reason": "App does not appear to use accounts (based on description). If it does, ensure account deletion is available."},
        }

    # Check if privacy policy mentions deletion
    if url:
        try:
            async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
                r = await client.get(url)
                if r.is_success:
                    body = r.text.lower()
                    deletion_keywords = ["delete your account", "account deletion", "delete my account", "remove your account", "erase your account"]
                    if any(kw in body for kw in deletion_keywords):
                        return {
                            "status": "passed",
                            "details": {"privacy_policy_mentions_deletion": True},
                        }
        except Exception:
            pass

    return {
        "status": "failed",
        "recommendation": "Apps with user accounts must offer account deletion. Add deletion instructions to your privacy policy and ensure in-app deletion is available. Apple Guideline 5.1.1(v), Google Data Deletion requirement.",
        "doc_url": "https://developer.apple.com/support/offering-account-deletion-in-your-app/",
        "auto_fixable": False,
        "details": {"has_accounts": True, "deletion_documented": False},
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Check 6: Export Compliance
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("export_compliance", "legal", "blocker",
                 "Export compliance (ECCN/encryption) declarations must be set")
async def check_export_compliance(app, metadata, submission, screenshots):
    """Apple requires export compliance declarations for apps using encryption.
    Most apps use HTTPS which qualifies for the exemption."""
    content_rating = metadata.get("content_rating_data", {})
    export_declared = content_rating.get("export_compliance_declared", None)

    if export_declared is True:
        return {
            "status": "passed",
            "details": {"export_compliance_declared": True},
        }

    if export_declared is False:
        return {
            "status": "failed",
            "recommendation": "Export compliance is marked as not declared. If your app uses HTTPS (most do), select 'Yes' for uses encryption and 'Yes' for the HTTPS exemption.",
            "doc_url": "https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations",
            "details": {"export_compliance_declared": False},
        }

    # Not set — provide guidance
    return {
        "status": "failed",
        "recommendation": "Set export compliance in your app metadata. Most apps that only use HTTPS qualify for an exemption. Set content_rating_data.export_compliance_declared to true.",
        "doc_url": "https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations",
        "auto_fixable": True,
        "details": {"export_compliance_declared": None, "hint": "If app only uses HTTPS, set to true"},
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Check 7: Content Rating Complete
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("content_rating_complete", "legal", "blocker",
                 "Content rating questionnaire must be filled out")
async def check_content_rating_complete(app, metadata, submission, screenshots):
    """Both Apple and Google require a content rating. Apple uses their own system,
    Google uses IARC questionnaire."""
    content_rating = metadata.get("content_rating_data", {})

    if not content_rating or content_rating == {}:
        return {
            "status": "failed",
            "recommendation": "Complete the content rating questionnaire. Apple and Google require this to determine appropriate age ratings. Set content_rating_data in your metadata.",
            "doc_url": "https://support.google.com/googleplay/android-developer/answer/9859655",
            "auto_fixable": False,
            "details": {"content_rating_data": "empty"},
        }

    # Check for key fields
    has_age_rating = bool(content_rating.get("age_rating") or content_rating.get("rating"))
    has_violence = "violence" in content_rating or "mature_content" in content_rating
    has_any_answers = len(content_rating) >= 2

    if has_age_rating or has_any_answers:
        return {
            "status": "passed",
            "details": {"fields_present": list(content_rating.keys())},
        }

    return {
        "status": "failed",
        "recommendation": "Content rating data appears incomplete. Ensure you've answered the content rating questionnaire with at minimum: age_rating and content categories.",
        "doc_url": "https://support.google.com/googleplay/android-developer/answer/9859655",
        "details": {"fields_present": list(content_rating.keys()), "has_age_rating": has_age_rating},
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Check 8: In-App Purchase Compliance
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("iap_compliance", "legal", "blocker",
                 "In-app purchases must use platform billing (Apple IAP / Google Play Billing)")
async def check_iap_compliance(app, metadata, submission, screenshots):
    """Apple Guideline 3.1.1: apps must use Apple IAP for digital goods.
    Google has similar requirements for digital goods/subscriptions.
    This is the #1 rejection reason for many apps."""
    full_desc = (metadata.get("full_description", "") or "").lower()
    content_rating = metadata.get("content_rating_data", {})

    # Check for signs of external payment
    external_payment_keywords = ["paypal", "stripe checkout", "pay via web", "purchase on our website", "buy on web"]
    has_external_payment = any(kw in full_desc for kw in external_payment_keywords)

    if has_external_payment:
        return {
            "status": "failed",
            "recommendation": "Description mentions external payment methods. Digital goods and subscriptions must use Apple IAP (iOS) or Google Play Billing (Android). Physical goods/services are exempt.",
            "doc_url": APPLE_IAP,
            "details": {"external_payment_detected": True},
        }

    # Check if IAP is declared
    has_iap = content_rating.get("has_in_app_purchases", None)
    uses_platform_billing = content_rating.get("uses_platform_billing", None)

    if has_iap is True and uses_platform_billing is False:
        return {
            "status": "failed",
            "recommendation": "App has in-app purchases but doesn't use platform billing. Digital goods must use Apple IAP / Google Play Billing.",
            "doc_url": APPLE_IAP,
            "details": {"has_iap": True, "uses_platform_billing": False},
        }

    return {
        "status": "passed",
        "details": {
            "has_iap": has_iap,
            "uses_platform_billing": uses_platform_billing,
            "external_payment_detected": False,
        },
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Check 9: Subscription Disclosure
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("subscription_disclosure", "legal", "blocker",
                 "Subscription apps must display terms before purchase screen")
async def check_subscription_disclosure(app, metadata, submission, screenshots):
    """Apple Guideline 3.1.2: auto-renewing subscriptions must clearly display
    pricing, duration, and terms before the purchase screen."""
    content_rating = metadata.get("content_rating_data", {})
    full_desc = (metadata.get("full_description", "") or "").lower()

    has_subscriptions = content_rating.get("has_subscriptions", None)

    # Try to detect subscriptions from description
    sub_keywords = ["subscription", "subscribe", "monthly plan", "annual plan", "free trial", "auto-renew"]
    desc_has_subs = any(kw in full_desc for kw in sub_keywords)

    if has_subscriptions is True or desc_has_subs:
        # Check if terms are mentioned in description
        terms_keywords = ["terms", "pricing", "cancel", "cancellation", "auto-renew", "renewal"]
        has_terms_in_desc = any(kw in full_desc for kw in terms_keywords)

        if not has_terms_in_desc:
            return {
                "status": "failed",
                "recommendation": "Subscription app detected but description doesn't mention pricing/terms/cancellation. Apple requires subscription terms to be clearly visible before purchase. Add pricing, trial duration, and cancellation info to your description.",
                "doc_url": "https://developer.apple.com/app-store/review/guidelines/#subscriptions",
                "details": {"has_subscriptions": True, "terms_in_description": False},
            }

        return {
            "status": "passed",
            "details": {"has_subscriptions": True, "terms_in_description": True},
        }

    return {
        "status": "passed",
        "details": {"has_subscriptions": False, "reason": "No subscriptions detected"},
    }
