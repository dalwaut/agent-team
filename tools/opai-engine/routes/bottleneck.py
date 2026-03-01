"""OPAI Engine — Bottleneck Detection routes (v3.3).

Exposes the approval tracker data + bottleneck suggestions to the dashboard.
"""

from fastapi import APIRouter

router = APIRouter(prefix="/api/bottleneck", tags=["bottleneck"])

# Set by app.py at startup
_detector = None


def set_detector(detector):
    global _detector
    _detector = detector


# ── Approval Tracker ────────────────────────────────────────

@router.get("/tracker")
def get_tracker(limit: int = 100, event_type: str = None):
    """Recent approval events + aggregate stats."""
    from services.approval_tracker import get_events, get_stats
    return {
        "events": get_events(limit=limit, event_type=event_type),
        "stats": get_stats(),
    }


@router.get("/tracker/stats")
def get_tracker_stats():
    """Just aggregate stats."""
    from services.approval_tracker import get_stats
    return get_stats()


# ── Bottleneck Suggestions ──────────────────────────────────

@router.get("/suggestions")
def get_suggestions():
    """All bottleneck suggestions."""
    if not _detector:
        return {"suggestions": [], "error": "Detector not initialized"}
    return {"suggestions": _detector.get_suggestions()}


@router.post("/suggestions/{suggestion_id}/accept")
def accept_suggestion(suggestion_id: str):
    """Accept a suggestion and apply the config change."""
    if not _detector:
        return {"success": False, "error": "Detector not initialized"}
    return _detector.accept_suggestion(suggestion_id)


@router.post("/suggestions/{suggestion_id}/dismiss")
def dismiss_suggestion(suggestion_id: str):
    """Dismiss a suggestion."""
    if not _detector:
        return {"success": False, "error": "Detector not initialized"}
    ok = _detector.dismiss_suggestion(suggestion_id)
    return {"success": ok}


@router.post("/scan")
def trigger_scan():
    """Trigger a manual bottleneck scan."""
    if not _detector:
        return {"success": False, "error": "Detector not initialized"}
    return _detector.scan()
