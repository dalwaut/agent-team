"""Marq — Metadata pre-submission checks (5 checks, all warnings).

Validates app name, description, keywords, release notes, and localization.
Each check receives (app, metadata, submission, screenshots) dicts.
"""

import logging
from core.checker import register_check

log = logging.getLogger("marq.checks.metadata")

# Store name length limits
APPLE_NAME_MAX = 30
GOOGLE_NAME_MAX = 50
APPLE_SUBTITLE_MAX = 30

# Minimum description lengths (characters) — rough quality floor
MIN_SHORT_DESC = 10
MIN_FULL_DESC = 80
MAX_FULL_DESC_GOOGLE = 4000
MAX_FULL_DESC_APPLE = 4000

# Keyword spam indicators
KEYWORD_SPAM_INDICATORS = [
    "best", "top", "#1", "number one", "greatest", "amazing",
    "free", "cheap", "discount",
]


# ═══════════════════════════════════════════════════════════════════════════════
# Check 16: App Name Length
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("app_name_length", "metadata", "warning",
                 "App name must be within store character limits")
async def check_app_name_length(app, metadata, submission, screenshots):
    """Apple max 30 chars, Google max 50 chars."""
    name = metadata.get("app_name") or app.get("name") or ""
    subtitle = metadata.get("subtitle") or ""
    platform = app.get("platform", "both")

    if not name:
        return {
            "status": "failed",
            "recommendation": "App name is empty. Set app_name in metadata.",
            "details": {"app_name": None},
        }

    issues = []

    if platform in ("ios", "both") and len(name) > APPLE_NAME_MAX:
        issues.append(f"Apple: name is {len(name)} chars, max {APPLE_NAME_MAX}")

    if platform in ("android", "both") and len(name) > GOOGLE_NAME_MAX:
        issues.append(f"Google: name is {len(name)} chars, max {GOOGLE_NAME_MAX}")

    if platform in ("ios", "both") and subtitle and len(subtitle) > APPLE_SUBTITLE_MAX:
        issues.append(f"Apple subtitle: {len(subtitle)} chars, max {APPLE_SUBTITLE_MAX}")

    if issues:
        return {
            "status": "failed",
            "recommendation": "; ".join(issues),
            "doc_url": "https://developer.apple.com/app-store/product-page/",
            "details": {
                "name": name,
                "name_length": len(name),
                "subtitle": subtitle,
                "subtitle_length": len(subtitle) if subtitle else 0,
                "issues": issues,
            },
        }

    return {
        "status": "passed",
        "details": {
            "name": name,
            "name_length": len(name),
            "subtitle_length": len(subtitle) if subtitle else 0,
        },
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Check 17: Description Quality
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("description_quality", "metadata", "warning",
                 "Description must be meaningful and not keyword-stuffed")
async def check_description_quality(app, metadata, submission, screenshots):
    """Check description length, keyword density, and basic quality signals."""
    full_desc = metadata.get("full_description") or ""
    short_desc = metadata.get("short_description") or ""
    platform = app.get("platform", "both")

    if not full_desc:
        return {
            "status": "failed",
            "recommendation": "No full description set. Write a clear, informative description of your app's features and value proposition.",
            "details": {"full_description_length": 0},
        }

    issues = []

    # Length checks
    if len(full_desc) < MIN_FULL_DESC:
        issues.append(f"Full description too short ({len(full_desc)} chars, recommend at least {MIN_FULL_DESC})")

    if platform in ("android", "both") and len(full_desc) > MAX_FULL_DESC_GOOGLE:
        issues.append(f"Google: full description exceeds {MAX_FULL_DESC_GOOGLE} chars ({len(full_desc)})")

    if platform in ("android", "both") and short_desc and len(short_desc) < MIN_SHORT_DESC:
        issues.append(f"Short description too brief ({len(short_desc)} chars)")

    if platform in ("android", "both") and not short_desc:
        issues.append("Google Play requires a short description (up to 80 chars)")

    # Keyword stuffing detection — simple heuristic
    desc_lower = full_desc.lower()
    spam_found = [kw for kw in KEYWORD_SPAM_INDICATORS if desc_lower.count(kw) >= 3]
    if spam_found:
        issues.append(f"Possible keyword stuffing detected: {', '.join(spam_found)} used 3+ times")

    # ALL CAPS check — more than 30% caps is suspicious
    alpha_chars = [c for c in full_desc if c.isalpha()]
    if alpha_chars and sum(1 for c in alpha_chars if c.isupper()) / len(alpha_chars) > 0.3:
        issues.append("Excessive capitalization (>30% uppercase). Stores may flag this.")

    # Contact info in description (often rejected)
    contact_patterns = ["mailto:", "tel:", "phone:", "call us at"]
    contact_found = [p for p in contact_patterns if p in desc_lower]
    if contact_found:
        issues.append("Description contains contact info — use metadata fields instead")

    if issues:
        return {
            "status": "failed",
            "recommendation": "; ".join(issues),
            "doc_url": "https://developer.apple.com/app-store/product-page/",
            "details": {
                "full_description_length": len(full_desc),
                "short_description_length": len(short_desc) if short_desc else 0,
                "issues": issues,
            },
        }

    return {
        "status": "passed",
        "details": {
            "full_description_length": len(full_desc),
            "short_description_length": len(short_desc) if short_desc else 0,
        },
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Check 18: Keywords Optimization
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("keywords_optimization", "metadata", "warning",
                 "Keywords should be relevant, comma-separated, no trademarks")
async def check_keywords_optimization(app, metadata, submission, screenshots):
    """Apple: 100-char comma-separated keyword field.
    Google: no keyword field (uses description), but Play Console has tags."""
    platform = app.get("platform", "both")
    keywords = metadata.get("keywords") or ""

    if platform == "android":
        # Google doesn't have a keywords field — pass with info
        return {
            "status": "passed",
            "details": {"reason": "Google Play doesn't use a keywords field. Keywords come from your description and category."},
        }

    if not keywords:
        return {
            "status": "failed",
            "recommendation": "No keywords set. Apple allows up to 100 characters of comma-separated keywords. Choose relevant terms users would search for.",
            "doc_url": "https://developer.apple.com/app-store/search/",
            "details": {"keywords": None},
        }

    issues = []

    # Apple 100-char limit
    if len(keywords) > 100:
        issues.append(f"Keywords exceed Apple's 100-char limit ({len(keywords)} chars). Remove less relevant terms.")

    # Check format — should be comma-separated
    kw_list = [k.strip() for k in keywords.split(",") if k.strip()]

    if len(kw_list) < 3:
        issues.append(f"Only {len(kw_list)} keyword(s). Use more to improve discoverability.")

    # Check for app name in keywords (Apple says don't duplicate)
    app_name = (metadata.get("app_name") or app.get("name") or "").lower()
    if app_name:
        name_in_kw = [k for k in kw_list if k.lower() == app_name.lower()]
        if name_in_kw:
            issues.append("Don't include your app name in keywords — Apple already indexes it.")

    # Check for spaces after commas (common mistake — wastes characters)
    if ", " in keywords:
        issues.append("Remove spaces after commas in keywords — they count toward the 100-char limit.")

    # Check for common trademark terms (high rejection risk)
    trademark_terms = ["iphone", "ipad", "android", "google", "apple", "samsung", "facebook", "instagram", "tiktok", "youtube", "twitter"]
    trademark_found = [k for k in kw_list if k.lower() in trademark_terms]
    if trademark_found:
        issues.append(f"Potential trademark violations: {', '.join(trademark_found)}. Remove competitor/platform brand names.")

    if issues:
        return {
            "status": "failed",
            "recommendation": "; ".join(issues),
            "doc_url": "https://developer.apple.com/app-store/search/",
            "details": {
                "keywords": keywords,
                "keyword_count": len(kw_list),
                "keyword_length": len(keywords),
                "issues": issues,
            },
        }

    return {
        "status": "passed",
        "details": {
            "keyword_count": len(kw_list),
            "keyword_length": len(keywords),
        },
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Check 19: Release Notes Present
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("release_notes_present", "metadata", "warning",
                 "Release notes (What's New) should be present for updates")
async def check_release_notes_present(app, metadata, submission, screenshots):
    """Both stores require release notes for updates (not first submission).
    Generic notes like 'bug fixes' are technically valid but not optimal."""
    whats_new = metadata.get("whats_new") or ""
    version = metadata.get("version") or submission.get("version") or app.get("current_version") or ""

    # If this looks like a first version, release notes are optional
    if version in ("1.0", "1.0.0", "0.1.0", "0.0.1"):
        if not whats_new:
            return {
                "status": "passed",
                "details": {"reason": f"Version {version} appears to be first release — release notes optional"},
            }

    if not whats_new:
        return {
            "status": "failed",
            "recommendation": "Add release notes (What's New). Users and reviewers look at these. Describe what changed in this version.",
            "doc_url": "https://developer.apple.com/app-store/product-page/",
            "details": {"whats_new": None, "version": version},
        }

    issues = []

    # Very short notes
    if len(whats_new) < 10:
        issues.append(f"Release notes are very short ({len(whats_new)} chars). Add more detail about changes.")

    # Generic notes detection
    generic_patterns = ["bug fixes", "minor improvements", "performance improvements", "various fixes", "stability improvements"]
    notes_lower = whats_new.lower().strip()
    if notes_lower in generic_patterns or any(notes_lower == p for p in generic_patterns):
        issues.append("Release notes are generic. Consider describing specific changes — improves user trust and review approval.")

    if issues:
        return {
            "status": "failed",
            "recommendation": "; ".join(issues),
            "details": {"whats_new": whats_new, "whats_new_length": len(whats_new), "issues": issues},
        }

    return {
        "status": "passed",
        "details": {"whats_new_length": len(whats_new)},
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Check 20: Localization Completeness
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("localization_completeness", "metadata", "warning",
                 "All declared locales should have complete metadata")
async def check_localization_completeness(app, metadata, submission, screenshots):
    """If app declares multiple locales, each needs name + description at minimum.
    This is a single-metadata check — for full localization, compare across metadata rows.
    Phase 3 will add cross-locale comparison."""
    locale = metadata.get("locale", "en-US")

    # Required fields per locale
    required_fields = ["app_name", "full_description"]
    recommended_fields = ["short_description", "keywords", "whats_new"]

    missing_required = [f for f in required_fields if not (metadata.get(f) or "").strip()]
    missing_recommended = [f for f in recommended_fields if not (metadata.get(f) or "").strip()]

    if missing_required:
        return {
            "status": "failed",
            "recommendation": f"Locale '{locale}' is missing required fields: {', '.join(missing_required)}. Each locale needs at minimum: app_name and full_description.",
            "details": {
                "locale": locale,
                "missing_required": missing_required,
                "missing_recommended": missing_recommended,
            },
        }

    if missing_recommended:
        return {
            "status": "passed",
            "details": {
                "locale": locale,
                "complete": False,
                "missing_recommended": missing_recommended,
                "note": f"Locale '{locale}' has required fields but is missing: {', '.join(missing_recommended)}",
            },
        }

    return {
        "status": "passed",
        "details": {"locale": locale, "complete": True},
    }
