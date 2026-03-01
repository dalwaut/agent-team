"""HELM — Social media routes (placeholder router for social endpoints)."""

from __future__ import annotations

import logging
import sys
from pathlib import Path

from fastapi import APIRouter

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))

log = logging.getLogger("helm.routes.social")
router = APIRouter()

# Social-specific endpoints will be added here as platform connectors are wired up.
# Will include: post scheduling, analytics sync, platform management.
