"""OPAI Engine — Command Channels API (v3.2).

View channel trust configuration and recent command gate audit trail.
"""

import logging

from fastapi import APIRouter

import config
from services.command_gate import _load_channel_config, enrich_audit

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/command-channels")

# In-memory ring buffer for recent gate decisions (last 50)
_audit_ring: list[dict] = []
AUDIT_RING_MAX = 50


def record_gate_decision(audit_entry: dict):
    """Append a gate decision to the in-memory ring buffer."""
    _audit_ring.append(audit_entry)
    if len(_audit_ring) > AUDIT_RING_MAX:
        del _audit_ring[: len(_audit_ring) - AUDIT_RING_MAX]


@router.get("/config")
async def get_config():
    """Return current channel trust configuration."""
    return {
        "command_channels": _load_channel_config(),
    }


@router.get("/audit")
async def get_audit():
    """Return recent command gate decisions (last 50)."""
    return {
        "count": len(_audit_ring),
        "decisions": list(reversed(_audit_ring)),
    }
