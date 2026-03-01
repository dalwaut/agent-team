"""OPAI PRD Pipeline — API Routes.

Data store: Supabase `prd_ideas` table (migrated from ideas.json).

Key flows:
  - Admin CRUD:    /api/ideas/* (admin JWT required)
  - Mobile submit: POST /api/submit (any authenticated user)
  - Auto-eval:     fires as asyncio background task on every new submission
  - Full PRD:      second agent pass on good verdicts → stored in full_prd column
"""

import asyncio
import json
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import sys
sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))

import config
import supabase_client as sb
from claude_api import call_claude
from audit import log_audit

# Auth — shared module
try:
    from auth import get_current_user, require_admin, AuthUser
    _USE_AUTH = True
except ImportError:
    _USE_AUTH = False
    class AuthUser:
        id = "dev"
        email = "dev@local"
        role = "admin"
        is_admin = True

log = logging.getLogger("opai-prd")
router = APIRouter(prefix="/api")


# ── Auth helpers ───────────────────────────────────────────────────────────────

def _admin():
    if _USE_AUTH:
        return Depends(require_admin)
    async def _noop(request: Request):
        return AuthUser()
    return Depends(_noop)


def _user():
    if _USE_AUTH:
        return Depends(get_current_user)
    async def _noop(request: Request):
        return AuthUser()
    return Depends(_noop)


# ── Pydantic models ────────────────────────────────────────────────────────────

class IdeaIn(BaseModel):
    name: str
    description: str
    target_market: str = ""
    notes: str = ""
    source: str = "manual"


class IdeasBulkIn(BaseModel):
    ideas: List[IdeaIn]


class MobileIdeaIn(BaseModel):
    """Rich idea submission from the mobile app."""
    title: str
    pain_point: str = ""
    solution: str = ""
    product_description: str = ""
    target_market: str = ""
    notes: str = ""
    # Optional extra fields (stored in notes if provided)
    core_magic: str = ""
    mvp_scope: str = ""
    tech_stack_recommendations: str = ""


class MoveToProjectIn(BaseModel):
    project_name: str
    project_slug: str


class UpdateIdeaIn(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    target_market: Optional[str] = None
    notes: Optional[str] = None
    status: Optional[str] = None


# ── Helper: new idea record ────────────────────────────────────────────────────

def _new_idea(name: str, description: str, target_market: str = "",
               notes: str = "", source: str = "manual",
               pain_point: str = "", solution: str = "",
               submitted_by: Optional[str] = None) -> dict:
    return {
        "id":            f"idea-{uuid.uuid4().hex[:8]}",
        "name":          name,
        "description":   description,
        "target_market": target_market,
        "notes":         notes,
        "source":        source,
        "status":        "pending",
        "pain_point":    pain_point or None,
        "solution":      solution or None,
        "evaluation":    None,
        "full_prd":      None,
        "submitted_by":  submitted_by,
        "submitted_at":  datetime.now(timezone.utc).isoformat(),
        "evaluated_at":  None,
        "project_path":  None,
        "moved_at":      None,
    }


# ── CSV parsing ───────────────────────────────────────────────────────────────

def _parse_csv(raw: str) -> List[dict]:
    lines = [l for l in raw.strip().splitlines() if l.strip()]
    if not lines:
        return []

    delim = "\t" if lines[0].count("\t") > lines[0].count(",") else ","

    def split_row(row: str) -> List[str]:
        parts, cur, in_q = [], [], False
        for ch in row:
            if ch == '"':
                in_q = not in_q
            elif ch == delim and not in_q:
                parts.append("".join(cur).strip().strip('"'))
                cur = []
            else:
                cur.append(ch)
        parts.append("".join(cur).strip().strip('"'))
        return parts

    headers = [h.lower().strip() for h in split_row(lines[0])]

    COL_MAP = {
        "name":          ["name", "title", "idea", "product", "product name", "idea name"],
        "description":   ["description", "desc", "detail", "details", "summary", "overview"],
        "target_market": ["target market", "target_market", "market", "audience", "customer"],
        "notes":         ["notes", "note", "context", "extra", "comments"],
    }

    def find_col(aliases):
        for a in aliases:
            if a in headers:
                return headers.index(a)
        return None

    col_name   = find_col(COL_MAP["name"])
    col_desc   = find_col(COL_MAP["description"])
    col_market = find_col(COL_MAP["target_market"])
    col_notes  = find_col(COL_MAP["notes"])

    if col_name is None and col_desc is None:
        col_name, col_desc = 0, 1

    ideas = []
    for row in lines[1:]:
        cells = split_row(row)
        if not any(cells):
            continue

        def g(idx):
            if idx is None or idx >= len(cells):
                return ""
            return cells[idx].strip()

        name = g(col_name) or f"Idea {len(ideas)+1}"
        desc = g(col_desc) or g(col_name)

        ideas.append({
            "name":          name,
            "description":   desc,
            "target_market": g(col_market),
            "notes":         g(col_notes),
            "source":        "csv",
        })
    return ideas


# ── PRDgent evaluation runner ─────────────────────────────────────────────────

async def _run_prdgent(targets: list) -> dict:
    """Run PRDgent evaluation on a list of idea dicts. Returns parsed result dict.

    Uses shared claude_api wrapper: API mode when ANTHROPIC_API_KEY is set
    (with PTC for batches of 3+), CLI fallback otherwise.
    """
    if not config.PROMPT_FILE.exists():
        raise RuntimeError(f"Prompt file not found: {config.PROMPT_FILE}")

    system_prompt = config.PROMPT_FILE.read_text()
    payload = {
        "evaluate": [
            {
                "id":            t["id"],
                "name":          t["name"],
                "description":   t["description"],
                "target_market": t.get("target_market") or "",
                "notes":         _build_notes(t),
            }
            for t in targets
        ]
    }

    user_prompt = json.dumps(payload, ensure_ascii=False)

    result = await call_claude(
        user_prompt,
        system=system_prompt,
        model=config.AGENT_MODEL,
        expect_json=True,
        timeout=300,
        api_key=config.ANTHROPIC_API_KEY or None,
        cli_args=["--max-turns", str(config.AGENT_MAX_TURNS), "--setting-sources", "user"],
    )

    log.info("PRDgent eval: mode=%s, cost=$%.4f, duration=%dms",
             result["mode"], result["cost_usd"], result["duration_ms"])

    # Use parsed JSON if available, fall back to regex extraction
    if result["parsed"] and "results" in result["parsed"]:
        return result["parsed"]

    # Regex fallback for non-clean JSON responses
    json_match = re.search(r'\{[\s\S]*"results"[\s\S]*\}', result["content"])
    if not json_match:
        raise ValueError(f"PRDgent returned non-JSON output: {result['content'][:300]}")

    return json.loads(json_match.group())


def _build_notes(idea: dict) -> str:
    """Combine notes + mobile fields into enriched notes for PRDgent."""
    parts = []
    if idea.get("notes"):
        parts.append(idea["notes"])
    if idea.get("pain_point"):
        parts.append(f"Pain point: {idea['pain_point']}")
    if idea.get("solution"):
        parts.append(f"Proposed solution: {idea['solution']}")
    return " | ".join(parts) if parts else ""


# ── Full PRD generation ────────────────────────────────────────────────────────

PRD_PROMPT_FILE = config.SCRIPTS_DIR / "prompt_prdgent_prd.txt"


async def _generate_full_prd(idea: dict, evaluation: dict) -> Optional[str]:
    """Run second agent pass to generate a complete written PRD. Returns markdown string.

    Uses shared claude_api wrapper: API mode when ANTHROPIC_API_KEY is set, CLI fallback.
    """
    if not PRD_PROMPT_FILE.exists():
        log.warning("Full PRD prompt file not found: %s", PRD_PROMPT_FILE)
        return None

    system_prompt = PRD_PROMPT_FILE.read_text()
    payload = {"idea": idea, "evaluation": evaluation}
    user_prompt = json.dumps(payload, ensure_ascii=False)

    try:
        result = await call_claude(
            user_prompt,
            system=system_prompt,
            model=config.AGENT_MODEL,
            expect_json=True,
            timeout=360,
            api_key=config.ANTHROPIC_API_KEY or None,
            cli_args=["--max-turns", "5", "--setting-sources", "user"],
        )

        log.info("PRD gen: mode=%s, cost=$%.4f, duration=%dms",
                 result["mode"], result["cost_usd"], result["duration_ms"])

        # Use parsed JSON if available
        if result["parsed"] and "prd" in result["parsed"]:
            return result["parsed"]["prd"]

        # Regex fallback
        json_match = re.search(r'\{[\s\S]*"prd"[\s\S]*\}', result["content"])
        if not json_match:
            log.error("Full PRD agent returned non-JSON: %s", result["content"][:300])
            return None

        parsed = json.loads(json_match.group())
        return parsed.get("prd")
    except Exception as e:
        log.error("Full PRD generation failed: %s", e)
        return None


# ── Background: auto-evaluate + full PRD ─────────────────────────────────────

async def _auto_evaluate_and_prd(idea_id: str):
    """
    Background task: run PRDgent on a freshly submitted idea,
    then generate a full PRD if verdict is 'good'.
    """
    try:
        idea = await sb.get_idea(idea_id)
        if not idea:
            log.error("Auto-eval: idea %s not found", idea_id)
            return

        log.info("Auto-eval starting for idea %s: %s", idea_id, idea["name"])

        result = await _run_prdgent([idea])
        now = datetime.now(timezone.utc).isoformat()

        for r in result.get("results", []):
            if r["id"] != idea_id:
                continue

            verdict = r["verdict"]
            new_status = "evaluated" if verdict == "good" else "reviewed"

            updates = {
                "evaluation":   r,
                "status":       new_status,
                "evaluated_at": now,
            }

            # Good verdict → generate full PRD
            if verdict == "good":
                log.info("Auto-eval: verdict GOOD for %s — generating full PRD", idea_id)
                full_prd = await _generate_full_prd(idea, r)
                if full_prd:
                    updates["full_prd"] = full_prd
                    log.info("Full PRD generated for %s (%d chars)", idea_id, len(full_prd))

            await sb.update_idea(idea_id, updates)
            log.info("Auto-eval complete for %s: verdict=%s", idea_id, verdict)
            try:
                log_audit(
                    tier="execution",
                    service="opai-prd",
                    event="idea-evaluation",
                    status="completed",
                    summary=f"PRDgent evaluated '{idea.get('name', idea_id)}' — verdict: {verdict}",
                    details={"idea_id": idea_id, "verdict": verdict, "has_full_prd": bool(updates.get("full_prd"))},
                )
            except Exception:
                pass
            return

        log.warning("Auto-eval: no result for idea %s", idea_id)

    except Exception as e:
        log.error("Auto-eval failed for %s: %s", idea_id, e, exc_info=True)
        # Mark as evaluation_failed so admin knows something went wrong
        try:
            await sb.update_idea(idea_id, {"status": "pending", "notes": f"[eval-error] {e}"})
        except Exception:
            pass


# ── Endpoints — Mobile submit ──────────────────────────────────────────────────

@router.post("/submit")
async def submit_idea(body: MobileIdeaIn, background_tasks: BackgroundTasks, user=_user()):
    """
    Public-facing submit endpoint for mobile and other sources.
    Requires a valid Supabase JWT (any role — not admin-only).
    Returns immediately; evaluation happens in the background.
    """
    # Combine extra fields into notes
    extra_parts = []
    if body.core_magic:
        extra_parts.append(f"Core magic: {body.core_magic}")
    if body.mvp_scope:
        extra_parts.append(f"MVP scope: {body.mvp_scope}")
    if body.tech_stack_recommendations:
        extra_parts.append(f"Tech stack: {body.tech_stack_recommendations}")
    combined_notes = " | ".join(filter(None, [body.notes] + extra_parts))

    description = body.product_description or body.solution or body.pain_point or ""

    idea = _new_idea(
        name          = body.title,
        description   = description,
        target_market = body.target_market,
        notes         = combined_notes,
        source        = "mobile",
        pain_point    = body.pain_point,
        solution      = body.solution,
        submitted_by  = getattr(user, "id", None),
    )

    created = await sb.create_idea(idea)

    # Fire background evaluation — non-blocking
    background_tasks.add_task(_auto_evaluate_and_prd, created["id"])

    log.info("Idea submitted: %s (%s) by %s", created["id"], created["name"], getattr(user, "email", "?"))

    return {
        "idea_id": created["id"],
        "name":    created["name"],
        "status":  "queued",
        "message": "Idea submitted successfully. PRDgent is evaluating it now — check back in 2–3 minutes.",
    }


# ── Endpoints — Ideas CRUD ────────────────────────────────────────────────────

@router.get("/ideas")
async def list_ideas(user=_admin()):
    ideas = await sb.get_ideas()
    return {"ideas": ideas, "total": len(ideas)}


@router.post("/ideas")
async def add_idea(body: IdeaIn, user=_admin()):
    idea = _new_idea(
        name=body.name, description=body.description,
        target_market=body.target_market, notes=body.notes, source=body.source,
    )
    created = await sb.create_idea(idea)
    return created


@router.post("/ideas/bulk")
async def add_ideas_bulk(body: IdeasBulkIn, user=_admin()):
    created = []
    for b in body.ideas:
        idea = _new_idea(
            name=b.name, description=b.description,
            target_market=b.target_market, notes=b.notes, source=b.source,
        )
        row = await sb.create_idea(idea)
        created.append(row)
    return {"created": len(created), "ideas": created}


@router.post("/ideas/import-csv")
async def import_csv(request: Request, user=_admin()):
    body = await request.json()
    raw = body.get("csv", "")
    if not raw.strip():
        raise HTTPException(400, "Empty CSV")

    rows = _parse_csv(raw)
    if not rows:
        raise HTTPException(400, "Could not parse any ideas from CSV — check column headers")

    dry_run = body.get("dry_run", False)
    if dry_run:
        preview = [r["name"] for r in rows[:20]]
        return {"parsed": len(rows), "preview": preview}

    created = []
    for r in rows:
        idea = _new_idea(
            name=r["name"], description=r["description"],
            target_market=r.get("target_market", ""), notes=r.get("notes", ""),
            source="csv",
        )
        row = await sb.create_idea(idea)
        created.append(row)
    return {"parsed": len(created), "ideas": created}


@router.patch("/ideas/{idea_id}")
async def update_idea(idea_id: str, body: UpdateIdeaIn, user=_admin()):
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(400, "No fields to update")
    updated = await sb.update_idea(idea_id, updates)
    if not updated:
        raise HTTPException(404, "Idea not found")
    return updated


@router.delete("/ideas/{idea_id}")
async def delete_idea(idea_id: str, user=_admin()):
    ok = await sb.delete_idea(idea_id)
    if not ok:
        raise HTTPException(404, "Idea not found")
    return {"deleted": idea_id}


# ── Endpoint — Run PRDgent evaluation (manual / admin) ────────────────────────

@router.post("/evaluate")
async def evaluate_ideas(request: Request, user=_admin()):
    """
    Manually evaluate ideas through PRDgent.
    Body: { "idea_ids": ["idea-abc123", ...] }  (empty list = all pending)
    """
    body = await request.json()
    idea_ids: list = body.get("idea_ids", [])

    all_ideas = await sb.get_ideas()

    if idea_ids:
        targets = [i for i in all_ideas if i["id"] in idea_ids]
    else:
        targets = [i for i in all_ideas if i["status"] == "pending"]

    if not targets:
        raise HTTPException(400, "No matching ideas to evaluate")

    try:
        result = await _run_prdgent(targets)
    except asyncio.TimeoutError:
        raise HTTPException(504, "PRDgent timed out after 300s")
    except FileNotFoundError:
        raise HTTPException(500, "claude CLI not found — check PATH")
    except ValueError as e:
        raise HTTPException(502, str(e))

    updated = []
    for r in result.get("results", []):
        verdict = r["verdict"]
        updates = {
            "evaluation":   r,
            "status":       "evaluated" if verdict == "good" else "reviewed",
            "evaluated_at": datetime.now(timezone.utc).isoformat(),
        }
        row = await sb.update_idea(r["id"], updates)
        updated.append(row)

    return {
        "evaluated":  len(updated),
        "ideas":      updated,
        "agent_meta": {
            "evaluated_at": result.get("evaluated_at"),
            "agent":        result.get("agent"),
            "version":      result.get("version"),
        },
    }


# ── Endpoint — Generate Full PRD (manual trigger) ─────────────────────────────

@router.post("/ideas/{idea_id}/generate-prd")
async def generate_prd(idea_id: str, user=_admin()):
    """
    Manually trigger full PRD generation for an evaluated idea.
    Can be used to regenerate or trigger for non-auto-evaluated ideas.
    """
    idea = await sb.get_idea(idea_id)
    if not idea:
        raise HTTPException(404, "Idea not found")
    if not idea.get("evaluation"):
        raise HTTPException(400, "Idea must be evaluated before generating a full PRD")

    full_prd = await _generate_full_prd(idea, idea["evaluation"])
    if not full_prd:
        raise HTTPException(502, "PRD generation failed — check logs")

    updated = await sb.update_idea(idea_id, {"full_prd": full_prd})
    return {"idea_id": idea_id, "prd_length": len(full_prd), "idea": updated}


# ── Endpoint — Approve / Reject ───────────────────────────────────────────────

@router.post("/ideas/{idea_id}/approve")
async def approve_idea(idea_id: str, user=_admin()):
    updated = await sb.update_idea(idea_id, {"status": "approved"})
    if not updated:
        raise HTTPException(404, "Idea not found")
    return updated


@router.post("/ideas/{idea_id}/reject")
async def reject_idea(idea_id: str, user=_admin()):
    updated = await sb.update_idea(idea_id, {"status": "rejected"})
    if not updated:
        raise HTTPException(404, "Idea not found")
    return updated


# ── Endpoint — Move to Project ────────────────────────────────────────────────

def _slugify(s: str) -> str:
    s = s.lower().strip()
    s = re.sub(r"[^\w\s-]", "", s)
    s = re.sub(r"[\s_]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s[:60]


@router.post("/ideas/{idea_id}/move-to-project")
async def move_to_project(idea_id: str, body: MoveToProjectIn, user=_admin()):
    """Scaffold a project folder in Projects/ from an approved idea."""
    idea = await sb.get_idea(idea_id)
    if not idea:
        raise HTTPException(404, "Idea not found")
    if idea["status"] not in ("approved", "evaluated"):
        raise HTTPException(400, f"Idea must be approved before moving (current: {idea['status']})")

    slug = _slugify(body.project_slug or body.project_name)
    if not slug:
        raise HTTPException(400, "Invalid project name")

    project_dir = config.PROJECTS_DIR / slug
    if project_dir.exists():
        raise HTTPException(409, f"Project folder already exists: Projects/{slug}")

    project_dir.mkdir(parents=True)
    for sub in config.PROJECT_SUBDIRS:
        (project_dir / sub).mkdir()

    ev     = idea.get("evaluation") or {}
    scores = ev.get("scores") or {}

    def bullet(items):
        return "\n".join(f"- {x}" for x in (items or [])) or "- N/A"

    readme = f"""# {body.project_name}

> Scaffolded by PRDgent on {datetime.now(timezone.utc).strftime('%Y-%m-%d')}

## Overview

{idea['description']}

**Target Market**: {idea.get('target_market') or 'TBD'}

---

## PRDgent Evaluation

**Verdict**: {ev.get('verdict', 'N/A').upper()}
**One-line Summary**: {ev.get('one_line_summary', '')}

| Criterion | Score |
|-----------|-------|
| Market Demand | {scores.get('market_demand', '—')}/10 |
| Differentiation | {scores.get('differentiation', '—')}/10 |
| Feasibility | {scores.get('feasibility', '—')}/10 |
| Monetization | {scores.get('monetization', '—')}/10 |
| Timing | {scores.get('timing', '—')}/10 |
| **Average** | **{scores.get('average', '—')}** |

### Strengths
{bullet(ev.get('strengths'))}

### Concerns
{bullet(ev.get('concerns'))}

### Recommended Next Steps
{chr(10).join(f'{i+1}. {s}' for i, s in enumerate(ev.get('recommended_next_steps') or []))}

---

## Directory Structure

```
{slug}/
├── docs/         # Product docs, specs, research
├── assets/       # Logos, screenshots, mockups
├── research/     # Market research, competitor analysis
├── designs/      # Wireframes, design files
├── README.md     # This file
└── PRD.md        # Full Product Requirements Document
```
"""

    # Use AI-generated full PRD if available, otherwise scaffold
    if idea.get("full_prd"):
        prd_doc = idea["full_prd"]
    else:
        prd_doc = f"""# Product Requirements Document — {body.project_name}

> Created: {datetime.now(timezone.utc).strftime('%Y-%m-%d')}
> Status: Draft
> Source Idea ID: {idea_id}

---

## 1. Problem Statement

{idea['description']}

## 2. Target Customer

{ev.get('target_customer', idea.get('target_market', 'TBD'))}

## 3. Competitive Landscape

{ev.get('competitive_landscape', 'To be researched.')}

## 4. Core Features

- [ ] Feature 1
- [ ] Feature 2
- [ ] Feature 3

## 5. Success Metrics

- Metric 1
- Metric 2

## 6. Out of Scope (V1)

-

## 7. Open Questions

{bullet(ev.get('concerns')) if ev.get('concerns') else '- None yet'}

---

*PRD scaffold. Run PRDgent full PRD generation to auto-populate all sections.*
"""

    (project_dir / "README.md").write_text(readme)
    (project_dir / "PRD.md").write_text(prd_doc)

    now = datetime.now(timezone.utc).isoformat()
    await sb.update_idea(idea_id, {
        "status":       "moved",
        "project_path": f"Projects/{slug}",
        "moved_at":     now,
    })

    try:
        log_audit(
            tier="system",
            service="opai-prd",
            event="project-created",
            status="completed",
            summary=f"Idea '{idea.get('name', idea_id)}' moved to Projects/{slug}",
            details={"idea_id": idea_id, "project_path": f"Projects/{slug}", "used_full_prd": bool(idea.get("full_prd"))},
        )
    except Exception:
        pass

    return {
        "idea_id":       idea_id,
        "project_path":  f"Projects/{slug}",
        "project_name":  body.project_name,
        "created_dirs":  config.PROJECT_SUBDIRS,
        "created_files": ["README.md", "PRD.md"],
        "used_full_prd": bool(idea.get("full_prd")),
    }


# ── Endpoint — Auth config ─────────────────────────────────────────────────────

@router.get("/auth/config")
async def auth_config():
    return {
        "supabase_url":      config.SUPABASE_URL,
        "supabase_anon_key": config.SUPABASE_ANON_KEY,
    }


# ── Endpoint — Stats ───────────────────────────────────────────────────────────

@router.get("/stats")
async def get_stats(user=_admin()):
    ideas = await sb.get_ideas()
    return {
        "total":     len(ideas),
        "pending":   sum(1 for i in ideas if i["status"] == "pending"),
        "evaluated": sum(1 for i in ideas if i["status"] in ("evaluated", "reviewed")),
        "approved":  sum(1 for i in ideas if i["status"] == "approved"),
        "rejected":  sum(1 for i in ideas if i["status"] == "rejected"),
        "moved":     sum(1 for i in ideas if i["status"] == "moved"),
        "good_ideas": sum(1 for i in ideas if (i.get("evaluation") or {}).get("verdict") == "good"),
        "with_full_prd": sum(1 for i in ideas if i.get("full_prd")),
    }


# ── Endpoint — YouTube to Idea ───────────────────────────────────────────────

class YouTubeIdeaIn(BaseModel):
    url: str
    title: Optional[str] = None
    author: Optional[str] = None
    transcript: Optional[str] = None
    summary_data: Optional[dict] = None


@router.post("/ideas/from-youtube")
async def idea_from_youtube(req: YouTubeIdeaIn, bg: BackgroundTasks):
    """Create a PRD idea from a YouTube video (admin only, no auth for internal calls).

    Extracts idea from video content, creates idea with source='youtube',
    and auto-triggers PRDgent evaluation.
    """
    from youtube import process_video, truncate_transcript

    title = req.title
    author = req.author
    transcript = req.transcript

    # Fetch video info if not provided
    if not transcript:
        info = await process_video(req.url)
        if info.get("error") and not info.get("transcript"):
            raise HTTPException(status_code=422, detail=info["error"])
        title = title or info.get("title", "")
        author = author or info.get("author", "")
        transcript = info.get("transcript", "")

    if not transcript:
        raise HTTPException(status_code=422, detail="No transcript available for this video")

    # Build idea from video
    desc_parts = []
    sd = req.summary_data
    if sd and sd.get("description"):
        desc_parts.append(sd["description"])
    if sd and sd.get("summary"):
        desc_parts.append(sd["summary"][:500])
    if not desc_parts:
        desc_parts.append(truncate_transcript(transcript, 2000))

    notes_parts = [f"Source video: {req.url}"]
    if author:
        notes_parts.append(f"Author: {author}")
    if sd and sd.get("key_points"):
        notes_parts.append("Key points: " + "; ".join(sd["key_points"][:5]))
    if sd and sd.get("topics"):
        notes_parts.append("Topics: " + ", ".join(sd["topics"]))

    idea = _new_idea(
        name=title or "YouTube Video Idea",
        description="\n\n".join(desc_parts),
        target_market="",
        notes=" | ".join(notes_parts),
        source="youtube",
    )

    row = await sb.create_idea(idea)
    log.info("YouTube idea created: %s — %s", row["id"], row["name"])

    try:
        log_audit(
            tier="execution",
            service="opai-prd",
            event="idea-from-youtube",
            status="completed",
            summary=f"Idea from YouTube: {title or req.url}",
            details={"idea_id": row["id"], "video_url": req.url},
        )
    except Exception:
        pass

    # Auto-evaluate in background
    bg.add_task(_auto_evaluate_and_prd, row["id"])

    return {"id": row["id"], "name": row["name"], "status": "pending"}
