"""OPAI Engine — Bottleneck Detector (v3.3).

Background agent that scans approval tracker data for patterns and
generates suggestions to remove recurring bottlenecks.

Three pattern detectors:
  1. Source auto-approve  — source approved N+ times, 0 rejections → upgrade trust
  2. Worker action auto-approve — worker action approved N+ times → remove gate
  3. Slow approval — tasks waiting avg >2h → notify + suggest auto-approval

Runs every `bottleneck_detector.interval_hours` (default 6h).
Writes suggestions to data/bottleneck-suggestions.json.
"""

import asyncio
import json
import logging
from datetime import datetime, timezone, timedelta

import config

logger = logging.getLogger("opai-engine.bottleneck-detector")


class BottleneckDetector:

    def __init__(self):
        self.state = self._load_state()
        self.suggestions = self._load_suggestions()

    # ── Persistence ─────────────────────────────────────────

    def _load_state(self) -> dict:
        try:
            if config.BOTTLENECK_STATE_FILE.is_file():
                return json.loads(config.BOTTLENECK_STATE_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
        return {"last_scan": None, "dismissed_ids": []}

    def _save_state(self):
        config.BOTTLENECK_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        config.BOTTLENECK_STATE_FILE.write_text(json.dumps(self.state, indent=2))

    def _load_suggestions(self) -> dict:
        try:
            if config.BOTTLENECK_SUGGESTIONS_FILE.is_file():
                return json.loads(config.BOTTLENECK_SUGGESTIONS_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
        return {"suggestions": [], "last_updated": None}

    def _save_suggestions(self):
        config.BOTTLENECK_SUGGESTIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
        self.suggestions["last_updated"] = datetime.now(timezone.utc).isoformat()
        config.BOTTLENECK_SUGGESTIONS_FILE.write_text(
            json.dumps(self.suggestions, indent=2, default=str)
        )

    # ── Public methods for routes ───────────────────────────

    def get_suggestions(self) -> list:
        return self.suggestions.get("suggestions", [])

    def get_suggestion(self, suggestion_id: str) -> dict | None:
        for s in self.suggestions.get("suggestions", []):
            if s["id"] == suggestion_id:
                return s
        return None

    def dismiss_suggestion(self, suggestion_id: str) -> bool:
        for s in self.suggestions.get("suggestions", []):
            if s["id"] == suggestion_id and s["status"] == "pending":
                s["status"] = "dismissed"
                self.state.setdefault("dismissed_ids", []).append(suggestion_id)
                self._save_suggestions()
                self._save_state()
                return True
        return False

    def accept_suggestion(self, suggestion_id: str) -> dict:
        """Accept a suggestion and apply the config change."""
        s = self.get_suggestion(suggestion_id)
        if not s:
            return {"success": False, "error": "Suggestion not found"}
        if s["status"] != "pending":
            return {"success": False, "error": f"Suggestion already {s['status']}"}

        result = self._apply_suggestion(s)
        if result["success"]:
            s["status"] = "accepted"
            s["accepted_at"] = datetime.now(timezone.utc).isoformat()
            self._save_suggestions()
        return result

    # ── Scan ────────────────────────────────────────────────

    def scan(self) -> dict:
        """Run all pattern detectors. Returns summary."""
        cfg = config.load_orchestrator_config().get("bottleneck_detector", {})
        threshold = cfg.get("approval_threshold", 10)
        lookback_days = cfg.get("lookback_days", 7)

        # Load tracker events
        try:
            from services.approval_tracker import get_events
            events = get_events(limit=500)
        except Exception as e:
            logger.error("Cannot read approval tracker: %s", e)
            return {"scanned": False, "error": str(e)}

        # Filter to lookback window
        cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days)
        recent = []
        for ev in events:
            ts = ev.get("timestamp", "")
            try:
                evt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                if evt >= cutoff:
                    recent.append(ev)
            except (ValueError, TypeError):
                continue

        dismissed = set(self.state.get("dismissed_ids", []))
        new_suggestions = []

        # Detector 1: Source auto-approve
        new_suggestions.extend(
            self._detect_source_auto_approve(recent, threshold, dismissed)
        )

        # Detector 2: Worker action auto-approve
        new_suggestions.extend(
            self._detect_worker_action_auto_approve(recent, threshold, dismissed)
        )

        # Detector 3: Slow approval
        new_suggestions.extend(
            self._detect_slow_approval(recent, dismissed)
        )

        # Merge new suggestions (avoid duplicates by id)
        existing_ids = {s["id"] for s in self.suggestions.get("suggestions", [])}
        added = 0
        for s in new_suggestions:
            if s["id"] not in existing_ids and s["id"] not in dismissed:
                self.suggestions.setdefault("suggestions", []).append(s)
                existing_ids.add(s["id"])
                added += 1

        self.state["last_scan"] = datetime.now(timezone.utc).isoformat()
        self._save_state()
        self._save_suggestions()

        logger.info(
            "Bottleneck scan complete: %d events analyzed, %d new suggestions",
            len(recent), added,
        )
        return {
            "scanned": True,
            "events_analyzed": len(recent),
            "new_suggestions": added,
            "total_suggestions": len(self.suggestions.get("suggestions", [])),
        }

    # ── Pattern Detectors ───────────────────────────────────

    def _detect_source_auto_approve(
        self, events: list, threshold: int, dismissed: set
    ) -> list:
        """Detect sources that are always approved and could be upgraded to command trust."""
        source_stats: dict[str, dict] = {}

        for ev in events:
            src = ev.get("source", "")
            if not src or src in ("system", "scheduler", "worker"):
                continue
            et = ev.get("event_type", "")
            if et in ("task_manually_approved", "task_auto_approved"):
                stats = source_stats.setdefault(src, {"approved": 0, "denied": 0})
                stats["approved"] += 1
            elif et in ("task_denied", "task_cancelled"):
                stats = source_stats.setdefault(src, {"approved": 0, "denied": 0})
                stats["denied"] += 1

        suggestions = []
        for src, stats in source_stats.items():
            sid = f"bn-source_auto_approve-{src}"
            if sid in dismissed:
                continue
            if stats["approved"] >= threshold and stats["denied"] == 0:
                suggestions.append({
                    "id": sid,
                    "kind": "bottleneck",
                    "type": "source_auto_approve",
                    "title": f"Upgrade '{src}' trust to 'command' (auto-approve)",
                    "description": (
                        f"Source '{src}' has been approved {stats['approved']} times "
                        f"with 0 rejections in the lookback window. Consider upgrading "
                        f"its trust level to 'command' so tasks from this source "
                        f"execute automatically."
                    ),
                    "pattern": {
                        "type": "source_auto_approve",
                        "source": src,
                        "approved_count": stats["approved"],
                        "denied_count": stats["denied"],
                    },
                    "status": "pending",
                    "created_at": datetime.now(timezone.utc).isoformat(),
                })
        return suggestions

    def _detect_worker_action_auto_approve(
        self, events: list, threshold: int, dismissed: set
    ) -> list:
        """Detect worker actions that are always approved and could drop the gate."""
        action_stats: dict[str, dict] = {}

        for ev in events:
            et = ev.get("event_type", "")
            wid = ev.get("worker_id", "")
            action = ev.get("action", "")
            if not wid or not action:
                continue
            key = f"{wid}:{action}"

            if et == "worker_approval_approved":
                stats = action_stats.setdefault(key, {"approved": 0, "denied": 0, "worker_id": wid, "action": action})
                stats["approved"] += 1
            elif et == "worker_approval_denied":
                stats = action_stats.setdefault(key, {"approved": 0, "denied": 0, "worker_id": wid, "action": action})
                stats["denied"] += 1

        suggestions = []
        for key, stats in action_stats.items():
            sid = f"bn-worker_action_auto_approve-{key}"
            if sid in dismissed:
                continue
            if stats["approved"] >= threshold and stats["denied"] == 0:
                suggestions.append({
                    "id": sid,
                    "kind": "bottleneck",
                    "type": "worker_action_auto_approve",
                    "title": f"Remove approval gate for {stats['worker_id']}:{stats['action']}",
                    "description": (
                        f"Worker '{stats['worker_id']}' action '{stats['action']}' has been "
                        f"approved {stats['approved']} times with 0 rejections. Consider removing "
                        f"'{stats['action']}' from requires_approval in workers.json."
                    ),
                    "pattern": {
                        "type": "worker_action_auto_approve",
                        "worker_id": stats["worker_id"],
                        "action": stats["action"],
                        "approved_count": stats["approved"],
                        "denied_count": stats["denied"],
                    },
                    "status": "pending",
                    "created_at": datetime.now(timezone.utc).isoformat(),
                })
        return suggestions

    def _detect_slow_approval(self, events: list, dismissed: set) -> list:
        """Detect sources where approval wait time exceeds 2 hours on average."""
        source_waits: dict[str, list] = {}

        for ev in events:
            et = ev.get("event_type", "")
            if et != "task_manually_approved":
                continue
            src = ev.get("source", "")
            wt = ev.get("wait_time_sec")
            if src and wt is not None:
                source_waits.setdefault(src, []).append(wt)

        suggestions = []
        for src, waits in source_waits.items():
            sid = f"bn-slow_approval-{src}"
            if sid in dismissed:
                continue
            if len(waits) < 3:
                continue
            avg_wait = sum(waits) / len(waits)
            if avg_wait > 7200:  # 2 hours
                avg_hrs = round(avg_wait / 3600, 1)
                suggestions.append({
                    "id": sid,
                    "kind": "bottleneck",
                    "type": "slow_approval",
                    "title": f"Slow approvals from '{src}' (avg {avg_hrs}h wait)",
                    "description": (
                        f"Tasks from '{src}' wait an average of {avg_hrs} hours before "
                        f"approval ({len(waits)} samples). Consider upgrading trust to "
                        f"'command' or increasing review frequency."
                    ),
                    "pattern": {
                        "type": "slow_approval",
                        "source": src,
                        "avg_wait_hours": avg_hrs,
                        "sample_count": len(waits),
                    },
                    "status": "pending",
                    "created_at": datetime.now(timezone.utc).isoformat(),
                })
        return suggestions

    # ── Apply suggestion ────────────────────────────────────

    def _apply_suggestion(self, suggestion: dict) -> dict:
        """Apply the config change for an accepted suggestion."""
        stype = suggestion.get("type", "")
        pattern = suggestion.get("pattern", {})

        if stype == "source_auto_approve":
            return self._apply_source_upgrade(pattern)
        elif stype == "worker_action_auto_approve":
            return self._apply_worker_gate_removal(pattern)
        elif stype == "slow_approval":
            return self._apply_source_upgrade(pattern)
        else:
            return {"success": False, "error": f"Unknown suggestion type: {stype}"}

    def _apply_source_upgrade(self, pattern: dict) -> dict:
        """Upgrade a source's trust level to 'command' in orchestrator.json."""
        source = pattern.get("source", "")
        if not source:
            return {"success": False, "error": "No source in pattern"}

        try:
            orch = json.loads(config.ORCHESTRATOR_JSON.read_text())
            channels = orch.setdefault("command_channels", {})
            channel = channels.get(source)

            if channel is None:
                # Add new channel entry
                channels[source] = {"trust_level": "command"}
            elif "trust_level" in channel:
                channel["trust_level"] = "command"
            elif "trust_by_role" in channel:
                # Upgrade all roles to command
                for role in channel["trust_by_role"]:
                    channel["trust_by_role"][role] = "command"
            else:
                channels[source] = {"trust_level": "command"}

            config.ORCHESTRATOR_JSON.write_text(json.dumps(orch, indent=2))
            logger.info("Upgraded source '%s' trust to command in orchestrator.json", source)
            return {"success": True, "action": f"Upgraded '{source}' to command trust"}

        except Exception as e:
            logger.error("Failed to apply source upgrade: %s", e)
            return {"success": False, "error": str(e)}

    def _apply_worker_gate_removal(self, pattern: dict) -> dict:
        """Remove an action from requires_approval in workers.json."""
        worker_id = pattern.get("worker_id", "")
        action = pattern.get("action", "")
        if not worker_id or not action:
            return {"success": False, "error": "Missing worker_id or action"}

        workers_json = config.OPAI_ROOT / "config" / "workers.json"
        try:
            workers = json.loads(workers_json.read_text())
            worker = workers.get(worker_id)
            if not worker:
                return {"success": False, "error": f"Worker '{worker_id}' not found"}

            requires = worker.get("guardrails", {}).get("requires_approval", [])
            if action in requires:
                requires.remove(action)
                workers_json.write_text(json.dumps(workers, indent=2))
                logger.info(
                    "Removed '%s' from requires_approval for worker '%s'",
                    action, worker_id,
                )
                return {
                    "success": True,
                    "action": f"Removed '{action}' from {worker_id}.guardrails.requires_approval",
                }
            else:
                return {"success": True, "action": "Action not in requires_approval (already removed)"}

        except Exception as e:
            logger.error("Failed to apply worker gate removal: %s", e)
            return {"success": False, "error": str(e)}

    # ── Background loop ─────────────────────────────────────

    async def run(self):
        """Main background loop."""
        cfg = config.load_orchestrator_config().get("bottleneck_detector", {})
        if not cfg.get("enabled", True):
            logger.info("Bottleneck detector disabled")
            return

        interval = cfg.get("interval_hours", 6) * 3600
        logger.info("Bottleneck detector started (interval=%dh)", interval // 3600)

        # Initial delay before first scan
        await asyncio.sleep(30)
        self.scan()

        while True:
            await asyncio.sleep(interval)
            try:
                self.scan()
            except Exception as e:
                logger.error("Bottleneck scan error: %s", e)
