"""Marq — Technical/Performance pre-submission checks (6 checks, mixed severity).

Validates demo credentials, functionality, permissions, API levels, and platform requirements.
Each check receives (app, metadata, submission, screenshots) dicts.
"""

import logging
from core.checker import register_check

log = logging.getLogger("marq.checks.technical")

# Google's minimum targetSdkVersion requirement (as of 2024)
# Updated annually — Google requires targeting within 1 year of latest API level
GOOGLE_MIN_TARGET_SDK = 34   # Android 14 (Aug 2024 requirement)
GOOGLE_MIN_TARGET_SDK_NEW = 34  # For new apps
GOOGLE_MIN_TARGET_SDK_UPDATE = 33  # For existing app updates


# ═══════════════════════════════════════════════════════════════════════════════
# Check 21: Demo/Test Credentials
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("demo_credentials", "technical", "blocker",
                 "Apps with login must provide demo credentials for review")
async def check_demo_credentials(app, metadata, submission, screenshots):
    """Apple Guideline 2.1: apps requiring authentication must provide a demo account.
    Google also recommends this. Missing demo credentials = almost guaranteed rejection.
    This is the #2 rejection reason on Apple."""
    full_desc = (metadata.get("full_description") or "").lower()

    # Check if app has login/accounts
    login_keywords = ["sign in", "log in", "login", "sign up", "register", "create account", "authentication"]
    has_login = any(kw in full_desc for kw in login_keywords)

    if not has_login:
        return {
            "status": "passed",
            "details": {"reason": "App doesn't appear to require sign-in based on description"},
        }

    # Check content_rating_data for demo credentials
    content_rating = metadata.get("content_rating_data", {})
    demo_username = content_rating.get("demo_username") or content_rating.get("demo_email")
    demo_password = content_rating.get("demo_password")

    # Also check submission notes
    review_notes = (submission.get("notes") or submission.get("review_notes") or "")
    notes_lower = review_notes.lower()
    has_creds_in_notes = ("demo" in notes_lower or "test account" in notes_lower) and ("password" in notes_lower or "@" in notes_lower)

    if demo_username and demo_password:
        return {
            "status": "passed",
            "details": {"demo_username": demo_username, "has_password": True},
        }

    if has_creds_in_notes:
        return {
            "status": "passed",
            "details": {"credentials_in_review_notes": True},
        }

    return {
        "status": "failed",
        "recommendation": "App appears to require sign-in but no demo credentials provided. Apple rejects ~20% of apps for this. Add demo_username and demo_password to content_rating_data, or include them in submission review notes.",
        "doc_url": "https://developer.apple.com/app-store/review/guidelines/#performance",
        "details": {"has_login": True, "demo_credentials_provided": False},
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Check 22: Minimum Functionality
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("minimum_functionality", "technical", "warning",
                 "App must provide meaningful functionality beyond a webview wrapper")
async def check_minimum_functionality(app, metadata, submission, screenshots):
    """Apple Guideline 4.2: apps must provide some amount of functionality beyond
    just a website wrapped in a native shell. This is a heuristic check — full AI review in Phase 3.

    Common rejection: apps that are just a UIWebView/WKWebView loading a URL."""
    full_desc = (metadata.get("full_description") or "").lower()

    # Webview wrapper indicators
    webview_indicators = [
        "web app", "webview", "website wrapper", "loads our website",
        "mobile version of our website", "access our website",
        "wrapper", "opens the browser",
    ]

    # Native functionality indicators (positive signals)
    native_indicators = [
        "push notification", "offline", "camera", "gps", "location",
        "bluetooth", "nfc", "biometric", "face id", "touch id",
        "widget", "apple watch", "siri", "augmented reality", "ar kit",
        "core data", "healthkit", "apple pay", "google pay",
        "machine learning", "on-device",
    ]

    webview_matches = [ind for ind in webview_indicators if ind in full_desc]
    native_matches = [ind for ind in native_indicators if ind in full_desc]

    if webview_matches and not native_matches:
        return {
            "status": "failed",
            "recommendation": "App description suggests a webview wrapper without native features. Apple Guideline 4.2 requires meaningful functionality. Highlight native features in your description, or add native capabilities.",
            "doc_url": "https://developer.apple.com/app-store/review/guidelines/#minimum-functionality",
            "details": {
                "webview_indicators": webview_matches,
                "native_indicators": [],
                "note": "Consider adding: push notifications, offline support, device features",
            },
        }

    if webview_matches and native_matches:
        return {
            "status": "passed",
            "details": {
                "webview_indicators": webview_matches,
                "native_indicators": native_matches,
                "note": "App has webview indicators but also lists native features — should be OK",
            },
        }

    return {
        "status": "passed",
        "details": {
            "native_indicators": native_matches if native_matches else ["none detected — manual review recommended"],
        },
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Check 23: Permissions Justified
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("permissions_justified", "technical", "blocker",
                 "Requested permissions must be justified and minimal")
async def check_permissions_justified(app, metadata, submission, screenshots):
    """Both stores require apps to only request permissions they need.
    Apple: privacy usage descriptions required for each permission.
    Google: sensitive permissions need justification in Play Console.

    Checks content_rating_data.permissions array for common issues."""
    content_rating = metadata.get("content_rating_data", {})
    permissions = content_rating.get("permissions", [])
    full_desc = (metadata.get("full_description") or "").lower()

    if not permissions:
        # No permissions declared — either none needed or not filled in
        return {
            "status": "passed",
            "details": {"reason": "No special permissions declared. If your app uses camera, location, etc., declare them in content_rating_data.permissions."},
        }

    # High-risk permissions that need strong justification
    sensitive_permissions = {
        "camera": ["photo", "camera", "scan", "qr", "barcode", "video", "face"],
        "location": ["map", "location", "nearby", "gps", "directions", "navigate", "distance"],
        "microphone": ["voice", "audio", "record", "speech", "dictation", "call"],
        "contacts": ["contact", "address book", "friend", "invite"],
        "calendar": ["calendar", "event", "schedule", "appointment"],
        "photos": ["photo", "gallery", "image", "picture", "album"],
        "health": ["health", "fitness", "workout", "medical", "step"],
        "background_location": ["tracking", "always on", "background", "real-time location"],
        "phone": ["call", "dial", "phone"],
    }

    issues = []
    for perm in permissions:
        perm_lower = perm.lower()
        # Find matching sensitive permission
        for sensitive_perm, justification_keywords in sensitive_permissions.items():
            if sensitive_perm in perm_lower:
                # Check if description mentions a reason for this permission
                justified = any(kw in full_desc for kw in justification_keywords)
                if not justified:
                    issues.append(f"'{perm}' permission requested but no clear justification found in description. Explain why your app needs this.")
                break

    # Special: background location is almost always flagged
    bg_location = [p for p in permissions if "background" in p.lower() and "location" in p.lower()]
    if bg_location:
        issues.append("Background location permission detected. Both stores heavily scrutinize this. Ensure you have a strong use case (navigation, fitness tracking, etc.) clearly described.")

    if issues:
        return {
            "status": "failed",
            "recommendation": "; ".join(issues),
            "doc_url": "https://developer.apple.com/app-store/review/guidelines/#data-collection-and-storage",
            "details": {"permissions": permissions, "issues": issues},
        }

    return {
        "status": "passed",
        "details": {"permissions": permissions, "all_justified": True},
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Check 24: API Level Compliance (Android)
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("api_level_compliance", "technical", "blocker",
                 "Android targetSdkVersion must meet Google Play minimum")
async def check_api_level_compliance(app, metadata, submission, screenshots):
    """Google requires apps to target a recent Android API level.
    As of 2024: new apps must target API 34 (Android 14).
    Updates must target API 33+ (Android 13).
    This changes annually — Google announces new requirements each year."""
    platform = app.get("platform", "both")

    if platform == "ios":
        return {
            "status": "skipped",
            "details": {"reason": "iOS-only app — Android API level not applicable"},
        }

    content_rating = metadata.get("content_rating_data", {})
    target_sdk = content_rating.get("target_sdk_version") or content_rating.get("targetSdkVersion")

    if target_sdk is None:
        return {
            "status": "failed",
            "recommendation": f"Android targetSdkVersion not set. Google requires API {GOOGLE_MIN_TARGET_SDK}+ for new apps. Set content_rating_data.target_sdk_version.",
            "doc_url": "https://developer.android.com/google/play/requirements/target-sdk",
            "auto_fixable": False,
            "details": {"target_sdk_version": None, "required_minimum": GOOGLE_MIN_TARGET_SDK},
        }

    try:
        sdk_int = int(target_sdk)
    except (ValueError, TypeError):
        return {
            "status": "failed",
            "recommendation": f"Invalid targetSdkVersion: {target_sdk}. Must be an integer (e.g., 34).",
            "details": {"target_sdk_version": target_sdk},
        }

    if sdk_int < GOOGLE_MIN_TARGET_SDK:
        return {
            "status": "failed",
            "recommendation": f"targetSdkVersion {sdk_int} is below Google's minimum ({GOOGLE_MIN_TARGET_SDK}). Update your build.gradle to target API {GOOGLE_MIN_TARGET_SDK}+.",
            "doc_url": "https://developer.android.com/google/play/requirements/target-sdk",
            "details": {"target_sdk_version": sdk_int, "required_minimum": GOOGLE_MIN_TARGET_SDK},
        }

    return {
        "status": "passed",
        "details": {"target_sdk_version": sdk_int, "required_minimum": GOOGLE_MIN_TARGET_SDK},
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Check 25: Sign in with Apple
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("sign_in_with_apple", "technical", "blocker",
                 "iOS apps using third-party login must also offer Sign in with Apple")
async def check_sign_in_with_apple(app, metadata, submission, screenshots):
    """Apple Guideline 4.8: apps that offer third-party login (Google, Facebook, etc.)
    must also offer Sign in with Apple. This is one of Apple's most enforced rules.
    Exemption: apps that exclusively use their own account system."""
    platform = app.get("platform", "both")

    if platform == "android":
        return {
            "status": "skipped",
            "details": {"reason": "Android-only app — Sign in with Apple not required"},
        }

    full_desc = (metadata.get("full_description") or "").lower()
    content_rating = metadata.get("content_rating_data", {})

    # Third-party login providers
    third_party_providers = ["google sign", "sign in with google", "facebook login",
                             "sign in with facebook", "twitter login", "github login",
                             "social login", "oauth", "sso"]

    has_third_party = any(p in full_desc for p in third_party_providers)
    has_third_party = has_third_party or content_rating.get("has_third_party_login", False)

    if not has_third_party:
        return {
            "status": "passed",
            "details": {"reason": "No third-party login providers detected in description"},
        }

    # Check for Sign in with Apple
    apple_sign_in_keywords = ["sign in with apple", "apple sign in", "apple id login", "siwa"]
    has_apple_login = any(kw in full_desc for kw in apple_sign_in_keywords)
    has_apple_login = has_apple_login or content_rating.get("has_sign_in_with_apple", False)

    if not has_apple_login:
        return {
            "status": "failed",
            "recommendation": "Third-party login detected but Sign in with Apple is not mentioned. Apple Guideline 4.8 requires it. Add Sign in with Apple before submitting to the App Store.",
            "doc_url": "https://developer.apple.com/sign-in-with-apple/",
            "details": {"has_third_party_login": True, "has_sign_in_with_apple": False},
        }

    return {
        "status": "passed",
        "details": {"has_third_party_login": True, "has_sign_in_with_apple": True},
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Check 26: Crash Rate Threshold
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("crash_rate_threshold", "technical", "warning",
                 "No known crash issues should exist before submission")
async def check_crash_rate_threshold(app, metadata, submission, screenshots):
    """Both stores monitor crash rates post-release. Pre-submission, we check if
    the submission includes known crash info. In Phase 4, this will connect to
    Crashlytics/Sentry for actual crash rate data.

    Google's bad behavior threshold: >1.09% crash rate or >0.18% ANR rate."""
    content_rating = metadata.get("content_rating_data", {})
    crash_rate = content_rating.get("crash_rate")
    anr_rate = content_rating.get("anr_rate")

    # Known issues in submission
    known_issues = submission.get("known_issues") or []

    crash_issues = [i for i in known_issues if "crash" in str(i).lower()]
    if crash_issues:
        return {
            "status": "failed",
            "recommendation": f"Submission has {len(crash_issues)} known crash issue(s). Fix crashes before submitting — stores penalize high crash rates.",
            "details": {"known_crash_issues": crash_issues},
        }

    # If crash rate data is available (Phase 4 integration)
    if crash_rate is not None:
        try:
            rate = float(crash_rate)
            if rate > 1.09:
                return {
                    "status": "failed",
                    "recommendation": f"Crash rate is {rate}% — exceeds Google's 1.09% threshold. Fix stability issues before submitting.",
                    "doc_url": "https://developer.android.com/topic/performance/vitals/crash",
                    "details": {"crash_rate": rate, "threshold": 1.09},
                }
        except (ValueError, TypeError):
            pass

    if anr_rate is not None:
        try:
            rate = float(anr_rate)
            if rate > 0.18:
                return {
                    "status": "failed",
                    "recommendation": f"ANR rate is {rate}% — exceeds Google's 0.18% threshold. Optimize main thread performance.",
                    "doc_url": "https://developer.android.com/topic/performance/vitals/anr",
                    "details": {"anr_rate": rate, "threshold": 0.18},
                }
        except (ValueError, TypeError):
            pass

    return {
        "status": "passed",
        "details": {
            "known_crash_issues": 0,
            "crash_rate": crash_rate,
            "anr_rate": anr_rate,
            "note": "No crash issues detected. Phase 4 will add Crashlytics/Sentry integration.",
        },
    }
