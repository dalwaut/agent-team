"""OPAI Engine — Memory Consolidator (v3 Phase 3.1).

Processes daily notes, audit entries, and heartbeat state into institutional
knowledge. Extracts stable facts, wiki update recommendations, learned
preferences, corrections, and MEMORY.md pruning candidates.

Triggered by the heartbeat at the configured hour (default 01:00).
Not a standalone background task — runs via heartbeat._check_consolidation().
"""

import json
import logging
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import config
from audit import log_audit

logger = logging.getLogger("opai-engine.consolidator")

# Lazy import path for shared modules
_shared_path = str(Path(__file__).parent.parent.parent / "shared")

# Tacit knowledge template for first run
_TACIT_TEMPLATE = """# OPAI Tacit Knowledge

> Auto-maintained by the Memory Consolidator (v3 Phase 3.1).
> Updated nightly at 01:00 from daily activity analysis.
> Last updated: {date}

## Learned Preferences
(User patterns detected from corrections and decisions)

## Corrections & Lessons
(Mistakes detected, corrections applied, lessons extracted)

## System Patterns
(Recurring system behaviors worth remembering)

## Decision Precedents
(HITL approval/rejection patterns that guide future autonomy)
"""

# Caps for state persistence
MAX_PROCESSED_NOTES = 60
MAX_EXTRACTION_HISTORY = 30
MAX_CORRECTION_LOG_DAYS = 90


class MemoryConsolidator:
    """Nightly consolidator — extracts knowledge from daily activity."""

    def __init__(self):
        self._state_file = config.CONSOLIDATOR_STATE_FILE
        self._state: dict = {
            "last_run_date": None,
            "processed_notes": [],
            "extraction_history": [],
            "pruning_log": [],
            "saved_at": None,
        }
        self._load_state()

    # ── Main Entry ────────────────────────────────────────────

    async def run(self, heartbeat) -> dict:
        """Main entry: collect -> extract -> write -> notify -> persist state.

        Args:
            heartbeat: Heartbeat instance for snapshot access.

        Returns:
            Summary dict of the consolidation run.
        """
        start = time.time()
        today = datetime.now()
        date_str = today.strftime("%Y-%m-%d")

        logger.info("Memory consolidation starting for %s", date_str)

        try:
            # 1. Collect input data
            input_data = self._collect_input_data(date_str, heartbeat)

            # 2. Extract insights via Claude
            extraction = await self._extract_insights(input_data, date_str)

            if not extraction:
                logger.warning("Consolidation produced no extraction")
                return {"status": "empty", "date": date_str}

            # 3. Write outputs
            self._update_tacit_knowledge(extraction, date_str)
            self._write_wiki_recommendations(extraction, date_str)
            self._write_report(extraction, date_str)

            # 4. Send notification
            orch = config.load_orchestrator_config()
            cons_cfg = orch.get("consolidator", {})
            if cons_cfg.get("notification_enabled", True):
                try:
                    from background.notifier import notify_consolidation
                    await notify_consolidation(extraction, date_str)
                except Exception as e:
                    logger.warning("Consolidation notification failed: %s", e)

            # 5. Update state
            duration_ms = int((time.time() - start) * 1000)
            history_entry = {
                "date": date_str,
                "facts_count": len(extraction.get("stable_facts", [])),
                "wiki_updates_count": len(extraction.get("wiki_updates", [])),
                "preferences_count": len(extraction.get("learned_preferences", [])),
                "corrections_count": len(extraction.get("corrections", [])),
                "pruning_count": len(extraction.get("pruning_candidates", [])),
                "duration_ms": duration_ms,
            }

            self._state["last_run_date"] = date_str
            if date_str not in self._state["processed_notes"]:
                self._state["processed_notes"].insert(0, date_str)
            self._state["processed_notes"] = self._state["processed_notes"][:MAX_PROCESSED_NOTES]
            self._state["extraction_history"].insert(0, history_entry)
            self._state["extraction_history"] = self._state["extraction_history"][:MAX_EXTRACTION_HISTORY]
            self._save_state()

            # 6. Audit
            log_audit(
                tier="system",
                service="opai-engine",
                event="consolidator:run",
                status="completed",
                summary=(
                    f"Consolidation — {history_entry['facts_count']} facts, "
                    f"{history_entry['wiki_updates_count']} wiki recs, "
                    f"{history_entry['preferences_count']} preferences, "
                    f"{history_entry['corrections_count']} corrections"
                ),
                duration_ms=duration_ms,
                details=history_entry,
            )

            logger.info(
                "Consolidation complete: %d facts, %d wiki, %d prefs, %d corrections (%dms)",
                history_entry["facts_count"],
                history_entry["wiki_updates_count"],
                history_entry["preferences_count"],
                history_entry["corrections_count"],
                duration_ms,
            )

            return {
                "status": "completed",
                "date": date_str,
                **history_entry,
            }

        except Exception as e:
            duration_ms = int((time.time() - start) * 1000)
            logger.error("Consolidation failed: %s", e)
            log_audit(
                tier="system",
                service="opai-engine",
                event="consolidator:run",
                status="failed",
                summary=f"Consolidation failed: {e}",
                duration_ms=duration_ms,
            )
            return {"status": "failed", "date": date_str, "error": str(e)}

    # ── Data Collection ───────────────────────────────────────

    def _collect_input_data(self, date_str: str, heartbeat) -> dict:
        """Read daily note, audit entries, task changes, heartbeat state, tacit knowledge."""
        data = {
            "date": date_str,
            "daily_note": "",
            "audit_entries": [],
            "task_changes": [],
            "heartbeat_summary": {},
            "current_tacit_knowledge": "",
            "corrections_detected": [],
        }

        # Daily note (yesterday or today depending on timing)
        note_path = config.DAILY_NOTES_DIR / f"{date_str}.md"
        if not note_path.is_file():
            # Try yesterday's note (consolidator runs at 01:00)
            from datetime import timedelta
            yesterday = (datetime.strptime(date_str, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")
            note_path = config.DAILY_NOTES_DIR / f"{yesterday}.md"

        if note_path.is_file():
            try:
                data["daily_note"] = note_path.read_text()[:8000]  # Cap input
            except OSError as e:
                logger.warning("Failed to read daily note: %s", e)

        # Audit entries (last 24 hours)
        try:
            if config.AUDIT_JSON.is_file():
                records = json.loads(config.AUDIT_JSON.read_text())
                # Filter to last 24h worth of entries
                data["audit_entries"] = [
                    r for r in records
                    if r.get("timestamp", "") >= f"{date_str}T00:00:00"
                    or r.get("timestamp", "").startswith(date_str)
                ][:100]  # Cap at 100 entries
        except (json.JSONDecodeError, OSError) as e:
            logger.warning("Failed to read audit.json: %s", e)

        # Task registry changes
        try:
            if config.REGISTRY_JSON.is_file():
                registry = json.loads(config.REGISTRY_JSON.read_text())
                for tid, task in registry.get("tasks", {}).items():
                    updated = task.get("updatedAt", "")
                    if updated and updated[:10] == date_str:
                        data["task_changes"].append({
                            "id": tid,
                            "title": task.get("title", tid),
                            "status": task.get("status", "unknown"),
                        })
        except (json.JSONDecodeError, OSError) as e:
            logger.warning("Failed to read registry.json: %s", e)

        # Heartbeat summary
        snapshot = heartbeat.get_latest()
        data["heartbeat_summary"] = snapshot.get("summary", {})

        # Current tacit knowledge
        if config.TACIT_KNOWLEDGE_FILE.is_file():
            try:
                data["current_tacit_knowledge"] = config.TACIT_KNOWLEDGE_FILE.read_text()[:4000]
            except OSError:
                pass

        # Detect corrections
        data["corrections_detected"] = self._detect_corrections(data["audit_entries"])

        return data

    def _detect_corrections(self, audit_entries: list[dict]) -> list[dict]:
        """Find HITL rejections, re-assignments, failed->retry patterns."""
        corrections = []

        # Index by event type for pattern matching
        by_event: dict[str, list[dict]] = {}
        for entry in audit_entries:
            evt = entry.get("event", "")
            by_event.setdefault(evt, []).append(entry)

        for entry in audit_entries:
            tier = entry.get("tier", "")
            event = entry.get("event", "")
            status = entry.get("status", "")
            summary = entry.get("summary", "").lower()
            details = entry.get("details", {})

            # HITL rejection
            if tier == "execution" and status == "failed":
                if "reject" in summary or "hitl" in summary:
                    corrections.append({
                        "type": "hitl_rejection",
                        "event": event,
                        "summary": entry.get("summary", ""),
                        "details": details,
                    })

            # Task re-assignment (same task_id with different agentId)
            if tier == "execution" and details.get("taskId"):
                task_id = details["taskId"]
                agent_id = details.get("agentId", "")
                for other in audit_entries:
                    other_details = other.get("details", {})
                    if (
                        other is not entry
                        and other_details.get("taskId") == task_id
                        and other_details.get("agentId", "") != agent_id
                        and agent_id and other_details.get("agentId")
                    ):
                        corrections.append({
                            "type": "reassignment",
                            "task_id": task_id,
                            "from_agent": agent_id,
                            "to_agent": other_details.get("agentId"),
                        })
                        break  # One correction per task

            # Feedback fix
            if event == "feedback:fix" and status == "completed":
                corrections.append({
                    "type": "feedback_fix",
                    "summary": entry.get("summary", ""),
                    "details": details,
                })

        # Failed-then-retry: same event type, first failed then completed within 2h
        for evt, entries in by_event.items():
            failed_entries = [e for e in entries if e.get("status") == "failed"]
            completed_entries = [e for e in entries if e.get("status") == "completed"]
            for f in failed_entries:
                f_ts = f.get("timestamp", "")
                for c in completed_entries:
                    c_ts = c.get("timestamp", "")
                    if c_ts > f_ts:
                        try:
                            ft = datetime.fromisoformat(f_ts.replace("Z", "+00:00"))
                            ct = datetime.fromisoformat(c_ts.replace("Z", "+00:00"))
                            if (ct - ft).total_seconds() < 7200:  # 2 hours
                                corrections.append({
                                    "type": "failed_retry",
                                    "event": evt,
                                    "failed_at": f_ts,
                                    "completed_at": c_ts,
                                })
                                break
                        except (ValueError, TypeError):
                            pass

        return corrections

    # ── AI Extraction ─────────────────────────────────────────

    async def _extract_insights(self, input_data: dict, date_str: str) -> dict | None:
        """Call Claude (haiku) to extract structured insights from collected data."""
        if _shared_path not in sys.path:
            sys.path.insert(0, _shared_path)
        from claude_api import call_claude

        orch = config.load_orchestrator_config()
        cons_cfg = orch.get("consolidator", {})
        model = cons_cfg.get("model", "haiku")
        max_tokens = cons_cfg.get("max_extraction_tokens", 2000)

        system_prompt = (
            "You are OPAI's Memory Consolidator. Your job is to extract stable facts, "
            "wiki update recommendations, learned preferences, corrections, and MEMORY.md "
            "pruning candidates from today's activity data.\n\n"
            "Return ONLY a JSON object with exactly 5 keys:\n"
            "- stable_facts: [{fact, confidence, source}] — things confirmed by repeated observation\n"
            "- wiki_updates: [{file, section, action, content, reason}] — recommended wiki changes\n"
            "- learned_preferences: [{preference, evidence, confidence}] — user behavioral patterns\n"
            "- corrections: [{original, correction, lesson}] — mistakes detected and corrected\n"
            "- pruning_candidates: [{memory_entry, reason, safe}] — MEMORY.md entries safe to remove\n\n"
            "Be conservative — only report HIGH-CONFIDENCE extractions. "
            "Empty arrays are fine. Do not fabricate or speculate."
        )

        # Build user prompt
        prompt_parts = [f"## Consolidation Input — {date_str}\n"]

        # Daily note
        if input_data.get("daily_note"):
            prompt_parts.append("### Daily Note")
            prompt_parts.append(input_data["daily_note"][:4000])
            prompt_parts.append("")

        # Audit summary (execution tier only, summarized)
        exec_entries = [
            e for e in input_data.get("audit_entries", [])
            if e.get("tier") == "execution"
        ]
        if exec_entries:
            prompt_parts.append("### Execution Audit (today)")
            for e in exec_entries[:20]:
                status = e.get("status", "?")
                summary = e.get("summary", e.get("event", "?"))
                prompt_parts.append(f"- [{status}] {summary}")
            prompt_parts.append("")

        # Corrections detected
        if input_data.get("corrections_detected"):
            prompt_parts.append("### Correction Signals Detected")
            for c in input_data["corrections_detected"][:10]:
                prompt_parts.append(f"- Type: {c['type']} — {json.dumps(c, default=str)[:200]}")
            prompt_parts.append("")

        # Task changes
        if input_data.get("task_changes"):
            prompt_parts.append("### Task Changes")
            for tc in input_data["task_changes"][:15]:
                prompt_parts.append(f"- {tc['title']} — {tc['status']}")
            prompt_parts.append("")

        # Heartbeat summary
        hb_summary = input_data.get("heartbeat_summary", {})
        if hb_summary:
            prompt_parts.append("### Heartbeat Summary")
            prompt_parts.append(
                f"Total items: {hb_summary.get('total', 0)}, "
                f"Healthy: {hb_summary.get('healthy', 0)}, "
                f"Running tasks: {hb_summary.get('running_tasks', 0)}, "
                f"CPU: {hb_summary.get('cpu', 0):.0f}%, "
                f"Memory: {hb_summary.get('memory', 0):.0f}%"
            )
            prompt_parts.append("")

        # Current tacit knowledge (so Claude doesn't duplicate)
        if input_data.get("current_tacit_knowledge"):
            prompt_parts.append("### Current Tacit Knowledge (do not duplicate)")
            prompt_parts.append(input_data["current_tacit_knowledge"][:2000])
            prompt_parts.append("")

        prompt = "\n".join(prompt_parts)

        try:
            result = await call_claude(
                prompt,
                system=system_prompt,
                model=model,
                max_tokens=max_tokens,
                expect_json=True,
                timeout=60,
            )

            parsed = result.get("parsed")
            if parsed and isinstance(parsed, dict):
                # Validate expected keys
                for key in ("stable_facts", "wiki_updates", "learned_preferences", "corrections", "pruning_candidates"):
                    if key not in parsed:
                        parsed[key] = []
                return parsed

            logger.warning("Consolidator: Claude returned non-dict or unparseable response")
            return None

        except Exception as e:
            logger.error("Consolidator AI extraction failed: %s", e)
            return None

    # ── Output Writers ────────────────────────────────────────

    def _update_tacit_knowledge(self, extraction: dict, date_str: str):
        """Append new preferences/corrections to tacit-knowledge.md."""
        tk_file = config.TACIT_KNOWLEDGE_FILE

        # Create from template if doesn't exist
        if not tk_file.is_file():
            tk_file.parent.mkdir(parents=True, exist_ok=True)
            tk_file.write_text(_TACIT_TEMPLATE.format(date=date_str))

        content = tk_file.read_text()

        additions = []

        # Learned preferences
        prefs = extraction.get("learned_preferences", [])
        if prefs:
            for p in prefs:
                pref = p.get("preference", "")
                evidence = p.get("evidence", "")
                confidence = p.get("confidence", "medium")
                if pref:
                    entry = f"- [{date_str}] [{confidence}] {pref}"
                    if evidence:
                        entry += f"\n  Evidence: {evidence}"
                    # Check for duplicates (substring match on the preference text)
                    if pref not in content:
                        additions.append(("## Learned Preferences", entry))

        # Corrections
        corrections = extraction.get("corrections", [])
        if corrections:
            for c in corrections:
                original = c.get("original", "")
                correction = c.get("correction", "")
                lesson = c.get("lesson", "")
                if lesson:
                    entry = f"- [{date_str}] {lesson}"
                    if original and correction:
                        entry += f"\n  Was: {original} | Now: {correction}"
                    if lesson not in content:
                        additions.append(("## Corrections & Lessons", entry))

        # Stable facts → System Patterns
        facts = extraction.get("stable_facts", [])
        if facts:
            for f in facts:
                fact = f.get("fact", "")
                confidence = f.get("confidence", "medium")
                source = f.get("source", "")
                if fact and confidence == "high":
                    entry = f"- [{date_str}] {fact}"
                    if source:
                        entry += f" (source: {source})"
                    if fact not in content:
                        additions.append(("## System Patterns", entry))

        if not additions:
            return

        # Insert entries under their sections
        for section, entry in additions:
            if section in content:
                # Find the section and append after it (before next ## or end)
                idx = content.index(section) + len(section)
                # Find the next line after the section header
                next_newline = content.index("\n", idx)
                content = content[:next_newline] + "\n" + entry + content[next_newline:]
            else:
                # Append section at end
                content += f"\n{section}\n{entry}\n"

        # Update last-updated date
        content = content.replace(
            content.split("Last updated:")[1].split("\n")[0] if "Last updated:" in content else "",
            f" {date_str}" if "Last updated:" in content else "",
        )

        tk_file.write_text(content)
        logger.info("Tacit knowledge updated with %d entries", len(additions))

    def _write_wiki_recommendations(self, extraction: dict, date_str: str):
        """Write wiki-recommendations.json for the wiki-librarian to consume."""
        wiki_updates = extraction.get("wiki_updates", [])

        recommendations = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "generated_by": "consolidator",
            "date": date_str,
            "recommendations": wiki_updates,
        }

        out_file = config.WIKI_RECOMMENDATIONS_FILE
        out_file.parent.mkdir(parents=True, exist_ok=True)
        out_file.write_text(json.dumps(recommendations, indent=2))
        logger.info("Wiki recommendations written: %d entries", len(wiki_updates))

    def _write_report(self, extraction: dict, date_str: str):
        """Write reports/{date}/consolidation.md."""
        reports_dir = config.REPORTS_DIR / date_str
        reports_dir.mkdir(parents=True, exist_ok=True)
        report_path = reports_dir / "consolidation.md"

        lines = [
            f"# Memory Consolidation Report — {date_str}",
            "",
            f"> Generated at {datetime.now().strftime('%H:%M')} by Memory Consolidator v3.1",
            "",
        ]

        # Stable Facts
        facts = extraction.get("stable_facts", [])
        lines.append(f"## Stable Facts ({len(facts)})")
        if facts:
            for f in facts:
                lines.append(f"- [{f.get('confidence', '?')}] {f.get('fact', '?')} (source: {f.get('source', '?')})")
        else:
            lines.append("_None extracted._")
        lines.append("")

        # Wiki Recommendations
        wiki = extraction.get("wiki_updates", [])
        lines.append(f"## Wiki Recommendations ({len(wiki)})")
        if wiki:
            lines.append("| File | Section | Action | Reason |")
            lines.append("|------|---------|--------|--------|")
            for w in wiki:
                lines.append(
                    f"| `{w.get('file', '?')}` | {w.get('section', '?')} | "
                    f"{w.get('action', '?')} | {w.get('reason', '?')} |"
                )
        else:
            lines.append("_None recommended._")
        lines.append("")

        # Learned Preferences
        prefs = extraction.get("learned_preferences", [])
        lines.append(f"## Learned Preferences ({len(prefs)})")
        if prefs:
            for p in prefs:
                lines.append(f"- [{p.get('confidence', '?')}] {p.get('preference', '?')}")
                if p.get("evidence"):
                    lines.append(f"  Evidence: {p['evidence']}")
        else:
            lines.append("_None detected._")
        lines.append("")

        # Corrections
        corrections = extraction.get("corrections", [])
        lines.append(f"## Corrections ({len(corrections)})")
        if corrections:
            for c in corrections:
                lines.append(f"- {c.get('lesson', '?')}")
                if c.get("original"):
                    lines.append(f"  Was: {c['original']}")
                if c.get("correction"):
                    lines.append(f"  Now: {c['correction']}")
        else:
            lines.append("_None detected._")
        lines.append("")

        # Pruning Candidates
        pruning = extraction.get("pruning_candidates", [])
        lines.append(f"## Pruning Candidates ({len(pruning)})")
        if pruning:
            for p in pruning:
                safe_str = "SAFE" if p.get("safe") else "REVIEW"
                lines.append(f"- [{safe_str}] {p.get('memory_entry', '?')} — {p.get('reason', '?')}")
        else:
            lines.append("_None identified._")

        report_path.write_text("\n".join(lines))
        logger.info("Consolidation report written: %s", report_path)

    def _prune_memory_md(self, extraction: dict):
        """Conservative MEMORY.md pruning (disabled by default)."""
        orch = config.load_orchestrator_config()
        cons_cfg = orch.get("consolidator", {})
        if not cons_cfg.get("prune_memory_md", False):
            return

        pruning = extraction.get("pruning_candidates", [])
        safe_candidates = [p for p in pruning if p.get("safe")]

        if not safe_candidates or not config.MEMORY_MD_FILE.is_file():
            return

        content = config.MEMORY_MD_FILE.read_text()
        pruned_count = 0

        for candidate in safe_candidates:
            entry = candidate.get("memory_entry", "")
            if entry and entry in content:
                content = content.replace(entry, "")
                pruned_count += 1
                self._state["pruning_log"].append({
                    "date": datetime.now(timezone.utc).isoformat(),
                    "entry": entry[:100],
                    "reason": candidate.get("reason", ""),
                })

        if pruned_count:
            config.MEMORY_MD_FILE.write_text(content)
            # Keep pruning log bounded (90 days)
            self._state["pruning_log"] = self._state["pruning_log"][-MAX_CORRECTION_LOG_DAYS:]
            logger.info("MEMORY.md pruned: %d entries removed", pruned_count)

    # ── Public API ────────────────────────────────────────────

    def get_latest(self) -> dict:
        """Return last run summary (for API)."""
        return {
            "last_run_date": self._state.get("last_run_date"),
            "processed_notes_count": len(self._state.get("processed_notes", [])),
            "latest_extraction": (
                self._state["extraction_history"][0]
                if self._state.get("extraction_history")
                else None
            ),
        }

    def get_history(self) -> dict:
        """Return last 30 extractions (for API)."""
        return {
            "extraction_history": self._state.get("extraction_history", []),
            "processed_notes": self._state.get("processed_notes", []),
            "pruning_log": self._state.get("pruning_log", []),
        }

    async def trigger(self, heartbeat) -> dict:
        """Force immediate consolidation (for API/testing)."""
        return await self.run(heartbeat)

    # ── State Persistence ─────────────────────────────────────

    def _load_state(self):
        """Restore consolidator state from disk."""
        try:
            if self._state_file.is_file():
                loaded = json.loads(self._state_file.read_text())
                self._state.update(loaded)
                logger.info(
                    "Consolidator state restored: last run %s",
                    self._state.get("last_run_date", "never"),
                )
        except (json.JSONDecodeError, OSError) as e:
            logger.warning("Failed to load consolidator state: %s", e)

    def _save_state(self):
        """Persist consolidator state to disk."""
        try:
            self._state["saved_at"] = datetime.now(timezone.utc).isoformat()
            self._state_file.parent.mkdir(parents=True, exist_ok=True)
            self._state_file.write_text(json.dumps(self._state, indent=2, default=str))
        except Exception as e:
            logger.error("Failed to save consolidator state: %s", e)
