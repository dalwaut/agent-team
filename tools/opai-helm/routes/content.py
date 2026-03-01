"""HELM — Content management routes (placeholder router for content endpoints)."""

from __future__ import annotations

import logging
import sys
from pathlib import Path

from fastapi import APIRouter

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))

log = logging.getLogger("helm.routes.content")
router = APIRouter()

# Content-specific endpoints will be added here as connectors are wired up.
# The content_generate job (jobs/content_generate.py) handles automated content creation.
# This router will expose manual content CRUD and publishing controls.
