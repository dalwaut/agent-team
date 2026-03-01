"""Marq — Safety/Compliance pre-submission checks (5 checks, mixed severity).

Validates data safety declarations, category requirements, age rating consistency,
URL scheme conflicts, and architecture requirements.
Each check receives (app, metadata, submission, screenshots) dicts.
"""

import logging
from core.checker import register_check

log = logging.getLogger("marq.checks.safety")

# Categories that require extra compliance
HEALTH_CATEGORIES = ["Health & Fitness", "Medical", "health_and_fitness", "medical"]
FINANCE_CATEGORIES = ["Finance", "finance"]
KIDS_CATEGORIES = ["Kids", "Education", "kids", "education"]
GAMBLING_CATEGORIES = ["Casino", "Gambling", "casino", "gambling"]

# Reserved iOS URL schemes (will cause rejection if claimed)
RESERVED_URL_SCHEMES = [
    "http", "https", "mailto", "tel", "sms", "facetime", "facetime-audio",
    "maps", "music", "videos", "itms", "itms-apps", "itms-appss",
    "calshow", "x-apple-", "ibooks", "mobilesafari",
]


# ═══════════════════════════════════════════════════════════════════════════════
# Check 27: Data Safety / Privacy Nutrition Labels
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("data_safety_complete", "safety", "blocker",
                 "Data safety form (Google) / privacy nutrition labels (Apple) must be completed")
async def check_data_safety_complete(app, metadata, submission, screenshots):
    """Google: Data Safety section required since July 2022.
    Apple: Privacy Nutrition Labels required since Dec 2020.
    Both must accurately describe data collection, sharing, and security practices."""
    content_rating = metadata.get("content_rating_data", {})
    platform = app.get("platform", "both")

    issues = []

    if platform in ("android", "both"):
        data_safety = content_rating.get("data_safety_form") or content_rating.get("data_safety")
        if not data_safety:
            issues.append("Google Data Safety form not completed. This is required for all Google Play apps. Describe what data you collect, share, and how it's secured.")
        elif isinstance(data_safety, dict):
            # Basic structure check
            required_sections = ["data_collected", "data_shared", "security_practices"]
            missing = [s for s in required_sections if s not in data_safety]
            if missing:
                issues.append(f"Data Safety form incomplete — missing sections: {', '.join(missing)}")

    if platform in ("ios", "both"):
        privacy_labels = content_rating.get("privacy_nutrition_labels") or content_rating.get("privacy_labels")
        if not privacy_labels:
            issues.append("Apple Privacy Nutrition Labels not completed. Required for all App Store apps. Declare data types collected and their purposes.")
        elif isinstance(privacy_labels, dict):
            if not privacy_labels.get("data_types"):
                issues.append("Privacy Nutrition Labels present but no data types declared. Declare each data type your app collects (or select 'no data collected').")

    if issues:
        return {
            "status": "failed",
            "recommendation": "; ".join(issues),
            "doc_url": "https://support.google.com/googleplay/android-developer/answer/10787469",
            "auto_fixable": False,
            "details": {"issues": issues, "platform": platform},
        }

    return {
        "status": "passed",
        "details": {"platform": platform, "data_safety_complete": True},
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Check 28: Category-Specific Requirements
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("category_requirements", "safety", "warning",
                 "Category-specific compliance requirements (health, finance, kids)")
async def check_category_requirements(app, metadata, submission, screenshots):
    """Certain app categories trigger additional requirements:
    - Health/Medical: disclaimers, not a replacement for professional advice
    - Finance: may need licensing info
    - Kids/Education: COPPA compliance, no behavioral advertising
    - Gambling: regional licensing requirements"""
    category = (app.get("category") or metadata.get("category") or "").strip()
    full_desc = (metadata.get("full_description") or "").lower()
    content_rating = metadata.get("content_rating_data", {})

    if not category:
        return {
            "status": "passed",
            "details": {"reason": "No category set — set category in app settings for category-specific checks"},
        }

    issues = []

    # Health/Medical
    if category in HEALTH_CATEGORIES:
        health_disclaimers = ["not a substitute", "consult your doctor", "professional medical",
                              "not intended to diagnose", "health disclaimer", "for informational purposes"]
        has_disclaimer = any(d in full_desc for d in health_disclaimers)
        if not has_disclaimer:
            issues.append("Health/Medical app: add a medical disclaimer stating the app is not a substitute for professional medical advice. Apple and Google both require this.")

    # Finance
    if category in FINANCE_CATEGORIES:
        finance_keywords = ["license", "licensed", "regulated", "registered", "fdic", "sec", "finra"]
        has_licensing = any(k in full_desc for k in finance_keywords)
        if not has_licensing:
            issues.append("Finance app: consider adding licensing/regulatory information. Some jurisdictions require disclosure of financial service licensing.")

    # Kids
    if category in KIDS_CATEGORIES:
        is_kids_app = content_rating.get("is_kids_app", None)
        age_rating = content_rating.get("age_rating", "")

        if is_kids_app or (age_rating and any(x in str(age_rating).lower() for x in ["4+", "everyone", "3+"])):
            coppa_keywords = ["coppa", "children's privacy", "parental consent", "under 13"]
            privacy_url = app.get("privacy_policy_url") or ""
            has_coppa = any(k in full_desc.lower() for k in coppa_keywords)

            if not has_coppa:
                issues.append("Kids/Education app: ensure COPPA compliance. Privacy policy must address children's data. No behavioral advertising allowed. Apple Guideline 1.3, Google Families Policy.")

    # Gambling
    if category in GAMBLING_CATEGORIES:
        issues.append("Gambling/Casino category detected. Both stores require proper licensing for real-money gambling. Simulated gambling has different (less strict) requirements.")

    if issues:
        return {
            "status": "failed",
            "recommendation": "; ".join(issues),
            "doc_url": "https://developer.apple.com/app-store/review/guidelines/#kids-category",
            "details": {"category": category, "issues": issues},
        }

    return {
        "status": "passed",
        "details": {"category": category},
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Check 29: Age Rating Consistency
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("age_rating_consistency", "safety", "warning",
                 "App content should match the declared age rating")
async def check_age_rating_consistency(app, metadata, submission, screenshots):
    """Both stores will reject apps where content doesn't match the declared age rating.
    Apple uses their own system (4+, 9+, 12+, 17+).
    Google uses IARC (Everyone, Teen, Mature).

    This is a heuristic check — looks for mature content indicators in description."""
    content_rating = metadata.get("content_rating_data", {})
    age_rating = content_rating.get("age_rating") or content_rating.get("rating") or ""
    full_desc = (metadata.get("full_description") or "").lower()

    if not age_rating:
        return {
            "status": "skipped",
            "recommendation": "No age rating declared. Complete the content rating questionnaire first.",
            "details": {"age_rating": None},
        }

    # Mature content indicators
    mature_keywords = ["violence", "blood", "gore", "gambling", "alcohol", "drug",
                       "tobacco", "sexual", "nudity", "profanity", "horror",
                       "weapon", "gun", "kill", "war", "combat"]
    mature_found = [kw for kw in mature_keywords if kw in full_desc]

    # Map common rating values to restrictiveness level
    rating_str = str(age_rating).lower()
    is_low_rating = any(r in rating_str for r in ["4+", "everyone", "3+", "all ages", "e "])

    if is_low_rating and len(mature_found) >= 2:
        return {
            "status": "failed",
            "recommendation": f"Description contains mature content indicators ({', '.join(mature_found)}) but age rating is '{age_rating}'. Consider a higher rating, or revise the description. Mismatched ratings cause rejections.",
            "doc_url": "https://support.google.com/googleplay/android-developer/answer/9859655",
            "details": {
                "age_rating": age_rating,
                "mature_indicators": mature_found,
                "note": "This is a heuristic check — review manually",
            },
        }

    return {
        "status": "passed",
        "details": {
            "age_rating": age_rating,
            "mature_indicators_found": mature_found,
        },
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Check 30: URL Scheme Conflict (iOS)
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("url_scheme_conflict", "safety", "blocker",
                 "Custom URL schemes must not conflict with system-reserved schemes")
async def check_url_scheme_conflict(app, metadata, submission, screenshots):
    """Apple rejects apps that register URL schemes reserved by iOS.
    Apps should use reverse-domain-style schemes (e.g., com.example.myapp://)."""
    platform = app.get("platform", "both")

    if platform == "android":
        return {
            "status": "skipped",
            "details": {"reason": "Android-only app — iOS URL scheme check not applicable"},
        }

    content_rating = metadata.get("content_rating_data", {})
    url_schemes = content_rating.get("url_schemes") or content_rating.get("custom_url_schemes") or []

    if not url_schemes:
        return {
            "status": "passed",
            "details": {"reason": "No custom URL schemes declared. If your app registers URL schemes, declare them in content_rating_data.url_schemes."},
        }

    conflicts = []
    for scheme in url_schemes:
        scheme_lower = str(scheme).lower()
        for reserved in RESERVED_URL_SCHEMES:
            if scheme_lower == reserved or scheme_lower.startswith(f"{reserved}:"):
                conflicts.append(f"'{scheme}' conflicts with reserved scheme '{reserved}'")

    if conflicts:
        return {
            "status": "failed",
            "recommendation": f"URL scheme conflicts detected: {'; '.join(conflicts)}. Use a unique, reverse-domain-style scheme (e.g., com.yourcompany.appname).",
            "doc_url": "https://developer.apple.com/documentation/xcode/defining-a-custom-url-scheme-for-your-app",
            "details": {"url_schemes": url_schemes, "conflicts": conflicts},
        }

    return {
        "status": "passed",
        "details": {"url_schemes": url_schemes, "conflicts": []},
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Check 31: Bitcode / ARM64 Architecture (iOS)
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("bitcode_arm64", "safety", "warning",
                 "iOS apps must include arm64 architecture (bitcode deprecated)")
async def check_bitcode_arm64(app, metadata, submission, screenshots):
    """Apple deprecated Bitcode in Xcode 14. Apps must include arm64 slice.
    Simulator builds should include arm64 for M-series Macs.
    This check validates declared architecture info — full binary analysis in Phase 4."""
    platform = app.get("platform", "both")

    if platform == "android":
        return {
            "status": "skipped",
            "details": {"reason": "Android-only app — iOS architecture check not applicable"},
        }

    content_rating = metadata.get("content_rating_data", {})
    architectures = content_rating.get("architectures") or content_rating.get("supported_architectures") or []
    includes_bitcode = content_rating.get("includes_bitcode", None)

    # Bitcode warning
    if includes_bitcode is True:
        return {
            "status": "failed",
            "recommendation": "App includes Bitcode, which Apple deprecated in Xcode 14. Remove 'Enable Bitcode' from build settings (ENABLE_BITCODE=NO).",
            "doc_url": "https://developer.apple.com/documentation/xcode-release-notes/xcode-14-release-notes",
            "details": {"includes_bitcode": True},
        }

    # Architecture check
    if architectures:
        has_arm64 = "arm64" in [a.lower() for a in architectures]
        if not has_arm64:
            return {
                "status": "failed",
                "recommendation": "App doesn't include arm64 architecture. All iOS apps must support arm64. Check your Xcode build settings (ARCHS).",
                "details": {"architectures": architectures, "has_arm64": False},
            }
        return {
            "status": "passed",
            "details": {"architectures": architectures, "has_arm64": True},
        }

    # No architecture info declared — pass with note
    return {
        "status": "passed",
        "details": {
            "note": "No architecture info declared. Phase 4 will analyze the actual binary. Ensure arm64 is included in your Xcode build settings.",
        },
    }
