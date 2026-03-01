"""Marq — Pre-submission check engine (31 checks).

Each check function receives (app, metadata, submission, screenshots)
and returns {check_id, status, severity, details, recommendation, doc_url}.

Implemented in Phase 2 — this module provides the framework and registry.
"""

import logging

log = logging.getLogger("marq.checker")

# Check registry: check_id -> {fn, category, severity, description}
CHECK_REGISTRY: dict = {}


def register_check(check_id: str, category: str, severity: str, description: str):
    """Decorator to register a pre-submission check."""
    def decorator(fn):
        CHECK_REGISTRY[check_id] = {
            "fn": fn,
            "category": category,
            "severity": severity,
            "description": description,
        }
        return fn
    return decorator


async def run_all_checks(app: dict, metadata: dict, submission: dict, screenshots: list) -> list[dict]:
    """Run all registered checks and return results."""
    results = []
    for check_id, check in CHECK_REGISTRY.items():
        try:
            result = await check["fn"](app, metadata, submission, screenshots)
            result.setdefault("check_id", check_id)
            result.setdefault("category", check["category"])
            result.setdefault("severity", check["severity"])
            results.append(result)
        except Exception:
            log.exception("Check %s failed", check_id)
            results.append({
                "check_id": check_id,
                "category": check["category"],
                "severity": check["severity"],
                "status": "skipped",
                "recommendation": "Check failed to execute — review manually",
                "details": {},
            })
    return results


def calculate_score(results: list[dict]) -> int:
    """Calculate pre-check score from results. 100 - (blockers*20) - (warnings*5)."""
    score = 100
    for r in results:
        if r.get("status") == "failed":
            if r.get("severity") == "blocker":
                score -= 20
            elif r.get("severity") == "warning":
                score -= 5
    return max(0, score)


def has_blockers(results: list[dict]) -> bool:
    """Return True if any blocker check failed."""
    return any(
        r.get("status") == "failed" and r.get("severity") == "blocker"
        for r in results
    )
