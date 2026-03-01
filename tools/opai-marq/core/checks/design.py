"""Marq — Design/Assets pre-submission checks (6 checks).

Validates screenshots, feature graphics, and icons against store requirements.
Each check receives (app, metadata, submission, screenshots) dicts.
"""

import logging
from core.checker import register_check

log = logging.getLogger("marq.checks.design")

# Required screenshot dimensions per device type (width x height)
# Apple requires exact pixel dimensions
APPLE_SCREENSHOT_SPECS = {
    "iphone_6_7": {"sizes": [(1290, 2796), (2796, 1290)], "label": "iPhone 6.7\" (14 Pro Max, 15 Plus)"},
    "iphone_6_5": {"sizes": [(1284, 2778), (2778, 1284), (1242, 2688), (2688, 1242)], "label": "iPhone 6.5\" (11 Pro Max, XS Max)"},
    "ipad_12_9":  {"sizes": [(2048, 2732), (2732, 2048)], "label": "iPad Pro 12.9\""},
    "ipad_11":    {"sizes": [(1668, 2388), (2388, 1668)], "label": "iPad Pro 11\""},
}

# Google is more flexible — minimum dimensions
GOOGLE_SCREENSHOT_SPECS = {
    "phone":       {"min_side": 320, "max_side": 3840, "label": "Phone"},
    "tablet_7":    {"min_side": 320, "max_side": 3840, "label": "7\" Tablet"},
    "tablet_10":   {"min_side": 320, "max_side": 3840, "label": "10\" Tablet"},
    "chromebook":  {"min_side": 320, "max_side": 3840, "label": "Chromebook"},
    "tv":          {"min_side": 1280, "max_side": 3840, "label": "TV"},
}

# Minimum screenshot counts
APPLE_MIN_SCREENSHOTS = 1   # 1 per device type
GOOGLE_MIN_SCREENSHOTS = 2  # 2-8 per device type


# ═══════════════════════════════════════════════════════════════════════════════
# Check 10: Screenshot Dimensions
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("screenshots_dimensions", "design", "blocker",
                 "Screenshots must match required dimensions for each device type")
async def check_screenshots_dimensions(app, metadata, submission, screenshots):
    """Validate each screenshot's width/height against store requirements."""
    if not screenshots:
        return {
            "status": "skipped",
            "recommendation": "No screenshots uploaded. Upload screenshots before running dimension checks.",
            "details": {"screenshot_count": 0},
        }

    invalid = []
    valid_count = 0

    for ss in screenshots:
        w = ss.get("width")
        h = ss.get("height")
        device = ss.get("device_type", "")
        store = ss.get("store", "")

        if not w or not h:
            invalid.append({
                "id": ss.get("id"),
                "device_type": device,
                "reason": "Missing width/height — re-upload to capture dimensions",
            })
            continue

        if store == "apple" and device in APPLE_SCREENSHOT_SPECS:
            spec = APPLE_SCREENSHOT_SPECS[device]
            if (w, h) not in spec["sizes"]:
                expected = " or ".join(f"{s[0]}x{s[1]}" for s in spec["sizes"])
                invalid.append({
                    "id": ss.get("id"),
                    "device_type": device,
                    "actual": f"{w}x{h}",
                    "expected": expected,
                    "reason": f"Apple {spec['label']}: expected {expected}, got {w}x{h}",
                })
                continue

        if store == "google" and device in GOOGLE_SCREENSHOT_SPECS:
            spec = GOOGLE_SCREENSHOT_SPECS[device]
            min_s, max_s = spec["min_side"], spec["max_side"]
            if w < min_s or h < min_s or w > max_s or h > max_s:
                invalid.append({
                    "id": ss.get("id"),
                    "device_type": device,
                    "actual": f"{w}x{h}",
                    "reason": f"Google {spec['label']}: each side must be {min_s}-{max_s}px, got {w}x{h}",
                })
                continue

        valid_count += 1

    if invalid:
        return {
            "status": "failed",
            "recommendation": f"{len(invalid)} screenshot(s) have incorrect dimensions. Resize to match store requirements.",
            "doc_url": "https://developer.apple.com/help/app-store-connect/reference/screenshot-specifications",
            "details": {"invalid": invalid, "valid_count": valid_count},
        }

    return {
        "status": "passed",
        "details": {"valid_count": valid_count, "total": len(screenshots)},
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Check 11: Minimum Screenshot Count
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("screenshots_minimum_count", "design", "blocker",
                 "Minimum number of screenshots required per device type")
async def check_screenshots_minimum_count(app, metadata, submission, screenshots):
    """Apple requires at least 1 screenshot per device type.
    Google requires 2-8 screenshots per device type."""
    platform = app.get("platform", "both")

    if not screenshots:
        return {
            "status": "failed",
            "recommendation": "No screenshots uploaded. Apple requires at least 1 per device type, Google requires 2-8.",
            "doc_url": "https://developer.apple.com/help/app-store-connect/reference/screenshot-specifications",
            "details": {"screenshot_count": 0},
        }

    # Group by store and device type
    by_store_device = {}
    for ss in screenshots:
        key = f"{ss.get('store', 'unknown')}:{ss.get('device_type', 'unknown')}"
        by_store_device[key] = by_store_device.get(key, 0) + 1

    issues = []

    if platform in ("ios", "both"):
        apple_screenshots = [ss for ss in screenshots if ss.get("store") == "apple"]
        if not apple_screenshots:
            issues.append("No Apple screenshots uploaded. iOS requires at least 1 screenshot per supported device.")
        else:
            # Check each device type has minimum
            apple_devices = {}
            for ss in apple_screenshots:
                dt = ss.get("device_type", "unknown")
                apple_devices[dt] = apple_devices.get(dt, 0) + 1
            for dt, count in apple_devices.items():
                if count < APPLE_MIN_SCREENSHOTS:
                    issues.append(f"Apple {dt}: {count} screenshot(s), need at least {APPLE_MIN_SCREENSHOTS}")

    if platform in ("android", "both"):
        google_screenshots = [ss for ss in screenshots if ss.get("store") == "google"]
        if not google_screenshots:
            issues.append("No Google Play screenshots uploaded. Android requires 2-8 phone screenshots.")
        else:
            google_devices = {}
            for ss in google_screenshots:
                dt = ss.get("device_type", "unknown")
                google_devices[dt] = google_devices.get(dt, 0) + 1
            phone_count = google_devices.get("phone", 0)
            if phone_count < GOOGLE_MIN_SCREENSHOTS:
                issues.append(f"Google phone: {phone_count} screenshot(s), need at least {GOOGLE_MIN_SCREENSHOTS}")

    if issues:
        return {
            "status": "failed",
            "recommendation": "; ".join(issues),
            "doc_url": "https://developer.apple.com/help/app-store-connect/reference/screenshot-specifications",
            "details": {"by_store_device": by_store_device, "issues": issues},
        }

    return {
        "status": "passed",
        "details": {"by_store_device": by_store_device},
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Check 12: Screenshot Format
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("screenshots_format", "design", "warning",
                 "Screenshots must be PNG or JPEG (no alpha channel on JPEG)")
async def check_screenshots_format(app, metadata, submission, screenshots):
    """Both stores accept PNG and JPEG. Apple rejects JPEG with alpha."""
    if not screenshots:
        return {
            "status": "skipped",
            "details": {"reason": "No screenshots uploaded"},
        }

    issues = []
    for ss in screenshots:
        fmt = (ss.get("format") or "").lower()
        if fmt and fmt not in ("png", "jpeg", "jpg", "webp"):
            issues.append({
                "id": ss.get("id"),
                "format": fmt,
                "reason": f"Unsupported format: {fmt}. Use PNG or JPEG.",
            })

        # Check validation_errors from upload
        errors = ss.get("validation_errors") or []
        if errors:
            issues.append({
                "id": ss.get("id"),
                "format": fmt,
                "validation_errors": errors,
            })

    if issues:
        return {
            "status": "failed",
            "recommendation": f"{len(issues)} screenshot(s) have format issues. Use PNG or JPEG format.",
            "details": {"issues": issues},
        }

    return {
        "status": "passed",
        "details": {"total": len(screenshots), "all_valid_format": True},
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Check 13: Screenshot Accuracy (Warning — not a blocker)
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("screenshots_accuracy", "design", "warning",
                 "Screenshots should accurately represent the app (AI check)")
async def check_screenshots_accuracy(app, metadata, submission, screenshots):
    """Placeholder for AI-powered screenshot/description matching.
    This is a warning-only check — human review recommended.
    Full AI implementation in Phase 3 when metadata builder is ready."""
    if not screenshots:
        return {
            "status": "skipped",
            "details": {"reason": "No screenshots to verify"},
        }

    # Phase 2: basic check — just verify screenshots exist and have valid data
    valid = [ss for ss in screenshots if ss.get("storage_key") and ss.get("is_valid", True)]

    if len(valid) < len(screenshots):
        invalid_count = len(screenshots) - len(valid)
        return {
            "status": "failed",
            "recommendation": f"{invalid_count} screenshot(s) have issues. Ensure all screenshots are valid and represent your app accurately.",
            "details": {"total": len(screenshots), "valid": len(valid), "invalid": invalid_count},
        }

    return {
        "status": "passed",
        "details": {"total": len(screenshots), "valid": len(valid), "note": "Manual review recommended — AI accuracy check available in Phase 3"},
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Check 14: Google Feature Graphic
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("feature_graphic_android", "design", "warning",
                 "Google Play requires a 1024x500 feature graphic")
async def check_feature_graphic_android(app, metadata, submission, screenshots):
    """Google Play requires a 1024x500 feature graphic for store listing promotion."""
    platform = app.get("platform", "both")

    if platform == "ios":
        return {
            "status": "skipped",
            "details": {"reason": "iOS-only app — Google feature graphic not needed"},
        }

    # Look for a feature graphic in screenshots with special device_type or dimensions
    feature_graphics = [
        ss for ss in screenshots
        if ss.get("store") == "google"
        and ss.get("width") == 1024
        and ss.get("height") == 500
    ]

    if not feature_graphics:
        return {
            "status": "failed",
            "recommendation": "Upload a 1024x500 feature graphic for Google Play. This is required for store listing and used in promotional spots.",
            "doc_url": "https://support.google.com/googleplay/android-developer/answer/9866151",
            "details": {"found": False},
        }

    return {
        "status": "passed",
        "details": {"found": True, "count": len(feature_graphics)},
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Check 15: App Icon Specifications
# ═══════════════════════════════════════════════════════════════════════════════

@register_check("icon_specs", "design", "warning",
                 "App icon must meet size and format requirements")
async def check_icon_specs(app, metadata, submission, screenshots):
    """Apple requires 1024x1024 PNG (no alpha, no rounded corners).
    Google requires 512x512 PNG."""
    icon_key = app.get("icon_storage_key")

    if not icon_key:
        return {
            "status": "failed",
            "recommendation": "No app icon uploaded. Apple requires 1024x1024 PNG. Google requires 512x512 PNG. Upload via app settings.",
            "doc_url": "https://developer.apple.com/design/human-interface-guidelines/app-icons",
            "details": {"icon_uploaded": False},
        }

    # Icon exists — basic pass (detailed validation would need image inspection)
    return {
        "status": "passed",
        "details": {"icon_uploaded": True, "storage_key": icon_key, "note": "Verify: Apple 1024x1024 PNG no alpha, Google 512x512 PNG"},
    }
