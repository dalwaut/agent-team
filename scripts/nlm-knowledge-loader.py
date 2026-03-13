#!/usr/bin/env python3
"""NotebookLM Knowledge Loader — Organized RAG notebooks.

Creates topic-specific notebooks and loads relevant sources into each.
Tracks what's been loaded to avoid duplicates on re-run.

Notebooks:
  1. OPAI System Knowledge (existing) — wiki docs (already synced by background job)
  2. Client Portfolio — Drive structure docs, client context
  3. Business & HELM — Playbooks, business context, pricing, service delivery
  4. Technical Reference — Knowledge library, dev commands, API refs
  5. Agent Ops — Agent framework, prompt files, conventions
"""

import asyncio
import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools" / "shared"))

from nlm import (
    is_available, get_client, ensure_notebook,
    add_source_text, list_notebooks, NotebookLMError,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("nlm-loader")

WORKSPACE = Path("/workspace/synced/opai")
STATE_FILE = WORKSPACE / "tools" / "opai-engine" / "data" / "nlm-loader-state.json"

# ── Notebook Definitions ────────────────────────────────────────────────────

NOTEBOOKS = {
    "client-portfolio": {
        "title": "Client Portfolio — Drive & Project Files",
        "description": "Client drive structures, project context, brand assets index",
        "sources": [
            # Master drive index
            {"path": "Library/knowledge/ALL-DRIVES-INDEX.md", "title": "ALL Drives Master Index"},
            # Per-client drive structures (auto-discovered below)
            # + business context
            {"path": "tools/shared/drive-reference.md", "title": "Drive Quick Reference"},
            {"path": "tools/shared/business-context.md", "title": "Business Context"},
        ],
        "glob_sources": [
            # All client drive structure docs
            {"pattern": "Library/knowledge/*-Structure.md", "title_prefix": "Drive: "},
        ],
    },
    "business-helm": {
        "title": "Business & HELM — Playbooks & Strategy",
        "description": "HELM playbooks, business models, pricing, service delivery",
        "sources": [
            {"path": "Library/helm-playbooks/README.md", "title": "HELM Playbooks Index"},
            {"path": "Library/helm-playbooks/ai-native-saas-playbook.md", "title": "AI-Native SaaS Playbook"},
            {"path": "Library/helm-playbooks/affiliate-revenue-streams.md", "title": "Affiliate Revenue Streams"},
            {"path": "Library/opai-wiki/tools/helm.md", "title": "HELM Wiki — Full Architecture"},
            {"path": "Library/opai-wiki/plans/opai-evolution.md", "title": "OPAI Evolution Roadmap (v2→v4)"},
            {"path": "Library/knowledge/concepts/generative-engine-optimization.md", "title": "GEO — Generative Engine Optimization"},
            {"path": "Library/knowledge/reference/multi-model-api-gateways.md", "title": "Multi-Model API Gateways"},
            {"path": "Library/knowledge/reference/agency-pricing-framework.md", "title": "Agency Pricing Framework"},
            {"path": "Library/knowledge/reference/service-delivery-workflow.md", "title": "Service Delivery Workflow"},
            {"path": "Library/knowledge/reference/client-onboarding-checklist.md", "title": "Client Onboarding Checklist"},
        ],
        "glob_sources": [
            {"pattern": "Library/helm-playbooks/*.md", "title_prefix": "Playbook: "},
        ],
    },
    "technical-reference": {
        "title": "Technical Reference — Dev & API Docs",
        "description": "Development commands, API refs, infrastructure, deployment guides",
        "sources": [
            {"path": "Library/knowledge/REFERENCE-INDEX.md", "title": "Reference Library Index"},
            {"path": "Library/knowledge/reference/Dev Commands.md", "title": "Dev Commands Cheat Sheet"},
            {"path": "Library/knowledge/reference/agent-command-reference.md", "title": "Agent Command Reference"},
            {"path": "Library/knowledge/reference/OPAI-System-Context.md", "title": "OPAI System Context"},
            {"path": "Library/knowledge/reference/OPAI-Tools-API-Context.md", "title": "OPAI Tools API Context"},
            {"path": "Library/knowledge/reference/claude-code-agent-teams.md", "title": "Claude Code Agent Teams"},
            {"path": "Library/knowledge/reference/AI-Build-Instructions.md", "title": "AI Build Instructions"},
            {"path": "Library/knowledge/reference/n8n-API-Reference.md", "title": "n8n API Reference"},
            {"path": "Library/knowledge/reference/n8n commands.md", "title": "n8n Commands"},
            {"path": "Library/knowledge/reference/Linux 24.04 LTS.md", "title": "Linux Admin Commands"},
            {"path": "Library/knowledge/google-workspace-api.md", "title": "Google Workspace API"},
            {"path": "Library/knowledge/reference/zeroclaw-raspberry-pi.md", "title": "ZeroClaw Raspberry Pi"},
            {"path": "Library/opai-wiki/core/auth-network.md", "title": "Auth & Network Architecture"},
            {"path": "Library/opai-wiki/core/services-systemd.md", "title": "Services & systemd"},
            {"path": "Library/opai-wiki/infra/mcp-infrastructure.md", "title": "MCP Infrastructure"},
            {"path": "Library/knowledge/reference/tool-selection-guide.md", "title": "Tool Selection Guide"},
            {"path": "Library/knowledge/reference/opai-troubleshooting-guide.md", "title": "OPAI Troubleshooting Guide"},
        ],
    },
    "agent-ops": {
        "title": "Agent Ops — Prompts, Framework & Conventions",
        "description": "Agent roles, squad definitions, prompt library, operational conventions",
        "sources": [
            {"path": "Library/opai-wiki/agents/agent-framework.md", "title": "Agent Framework (43 roles, 27 squads)"},
            {"path": "team.json", "title": "Team Roster & Squad Definitions"},
            {"path": "CLAUDE.md", "title": "CLAUDE.md — System Conventions"},
            {"path": "CONVENTIONS.md", "title": "CONVENTIONS.md"},
            {"path": "Library/opai-wiki/infra/fleet-action-items.md", "title": "Fleet Coordinator & Action Items"},
            {"path": "Library/opai-wiki/infra/heartbeat.md", "title": "Heartbeat & Proactive Intelligence"},
            {"path": "Library/opai-wiki/infra/meta-assessment.md", "title": "Meta-Assessment (2nd-order loop)"},
            {"path": "notes/Improvements/prompt-audit-scorecard.md", "title": "Prompt Audit Scorecard"},
        ],
        "glob_sources": [
            # Load A-grade prompts (the best ones, most useful as reference)
            {"pattern": "scripts/prompt_self_assessment.txt", "title_prefix": "Prompt: "},
            {"pattern": "scripts/prompt_executor_safe.txt", "title_prefix": "Prompt: "},
            {"pattern": "scripts/prompt_builder.txt", "title_prefix": "Prompt: "},
            {"pattern": "scripts/prompt_prdgent.txt", "title_prefix": "Prompt: "},
            {"pattern": "scripts/prompt_wiki_librarian.txt", "title_prefix": "Prompt: "},
            {"pattern": "scripts/prompt_meta_assessment.txt", "title_prefix": "Prompt: "},
            {"pattern": "scripts/prompt_dam_planner.txt", "title_prefix": "Prompt: "},
            {"pattern": "scripts/prompt_email_manager.txt", "title_prefix": "Prompt: "},
        ],
    },
}


def _load_state() -> dict:
    try:
        if STATE_FILE.exists():
            return json.loads(STATE_FILE.read_text())
    except Exception:
        pass
    return {"notebooks": {}, "loaded_sources": {}}


def _save_state(state: dict):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2))


def _resolve_sources(nb_key: str, nb_config: dict) -> list[dict]:
    """Resolve all sources for a notebook, including glob patterns."""
    sources = []
    seen_paths = set()

    # Explicit sources
    for src in nb_config.get("sources", []):
        full_path = WORKSPACE / src["path"]
        if full_path.exists() and str(full_path) not in seen_paths:
            sources.append({"path": str(full_path), "title": src["title"]})
            seen_paths.add(str(full_path))

    # Glob sources
    for glob_spec in nb_config.get("glob_sources", []):
        pattern = glob_spec["pattern"]
        prefix = glob_spec.get("title_prefix", "")
        for fp in sorted(WORKSPACE.glob(pattern)):
            if str(fp) not in seen_paths:
                name = fp.stem.replace("-Structure", "").replace("-", " ")
                sources.append({"path": str(fp), "title": f"{prefix}{name}"})
                seen_paths.add(str(fp))

    return sources


async def load_notebook(client, nb_key: str, nb_config: dict, state: dict):
    """Create/find notebook and load sources."""
    title = nb_config["title"]
    log.info("━" * 60)
    log.info("Notebook: %s", title)

    # Get or create notebook
    existing_id = state["notebooks"].get(nb_key)
    nb_id = await ensure_notebook(client, title, existing_id)
    state["notebooks"][nb_key] = nb_id
    log.info("  ID: %s", nb_id)

    # Resolve sources
    sources = _resolve_sources(nb_key, nb_config)
    log.info("  Sources to process: %d", len(sources))

    # Track loaded sources per notebook
    loaded_key = f"loaded_{nb_key}"
    loaded = state.get("loaded_sources", {}).get(loaded_key, {})

    added = 0
    skipped = 0
    failed = 0

    for src in sources:
        fp = Path(src["path"])
        title_str = src["title"]

        # Skip if already loaded and file hasn't changed
        mtime = fp.stat().st_mtime
        prev = loaded.get(str(fp))
        if prev and prev.get("mtime", 0) >= mtime:
            skipped += 1
            continue

        try:
            content = fp.read_text(encoding="utf-8")
            if not content.strip():
                skipped += 1
                continue

            # Truncate very large files (NLM has per-source limits)
            if len(content) > 500000:
                content = content[:500000] + "\n\n... (truncated)"

            await add_source_text(client, nb_id, title_str, content)
            loaded[str(fp)] = {"mtime": mtime, "title": title_str}
            added += 1
            log.info("  + %s", title_str)

            # Rate-limit pause
            await asyncio.sleep(2)

        except Exception as e:
            failed += 1
            log.warning("  ! Failed: %s — %s", title_str, e)

    # Save loaded state
    if "loaded_sources" not in state:
        state["loaded_sources"] = {}
    state["loaded_sources"][loaded_key] = loaded

    log.info("  Result: %d added, %d skipped (unchanged), %d failed", added, skipped, failed)
    return {"added": added, "skipped": skipped, "failed": failed}


async def main():
    log.info("=" * 60)
    log.info("NotebookLM Knowledge Loader — Organized RAG Notebooks")
    log.info("=" * 60)

    if not is_available():
        log.error("NotebookLM not configured. Run: notebooklm login")
        return

    state = _load_state()

    # List existing notebooks
    client = await get_client()
    async with client:
        existing = await list_notebooks(client)
        log.info("\nExisting notebooks: %d", len(existing))
        for nb in existing:
            log.info("  - %s (%s, %d sources)", nb["title"], nb["id"], nb.get("source_count", 0))

        # Load each notebook
        totals = {"added": 0, "skipped": 0, "failed": 0}
        for nb_key, nb_config in NOTEBOOKS.items():
            try:
                result = await load_notebook(client, nb_key, nb_config, state)
                totals["added"] += result["added"]
                totals["skipped"] += result["skipped"]
                totals["failed"] += result["failed"]
                _save_state(state)  # Save after each notebook
            except Exception as e:
                log.error("  ERROR loading %s: %s", nb_key, e)

    log.info("\n" + "=" * 60)
    log.info("DONE — %d sources added, %d skipped, %d failed",
             totals["added"], totals["skipped"], totals["failed"])
    log.info("State saved to: %s", STATE_FILE)

    # Print notebook summary
    log.info("\nNotebook Registry:")
    for nb_key, nb_id in state.get("notebooks", {}).items():
        src_count = len(state.get("loaded_sources", {}).get(f"loaded_{nb_key}", {}))
        log.info("  %s: %s (%d sources)", nb_key, nb_id, src_count)


if __name__ == "__main__":
    asyncio.run(main())
