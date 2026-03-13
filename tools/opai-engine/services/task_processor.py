"""OPAI Engine — Task processor.

Migrated from opai-tasks/services.py. Full task lifecycle: CRUD, execution,
feedback fixer, audit, settings, evolve, archive, delegation.
"""

import json
import logging
import os
import random
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import config

# Shared audit logger
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "shared"))
from audit import log_audit as _shared_log_audit

log = logging.getLogger(__name__)


# ── Executor State ────────────────────────────────────────

_registry_lock = threading.Lock()
_running_jobs: dict = {}  # task_id → {agent_id, agent_type, started_at, thread}
_last_cycle_time: str | None = None
_cycle_squad_count: int = 0

# Default trusted senders (fallback when orchestrator.json has none configured)
_DEFAULT_TRUSTED_SENDERS = {
    "dallas@paradisewebfl.com",
    "denise@paradisewebfl.com",
    "caitlin@paradisewebfl.com",
    "dalwaut@gmail.com",
}

# ── Command Gate (v3.2) ───────────────────────────────────

from services.command_gate import build_intent, evaluate, enrich_audit as _enrich_intent


def should_bypass_approval(task: dict) -> bool:
    """Evaluate task via command gate. Returns True if auto-execute allowed.

    v3.2: replaces hardcoded source checks with configurable trust levels.
    Email tasks *always* require approval regardless of sender (closes prompt
    injection vector). Trust is determined by source + role/channel metadata.
    """
    source = task.get("source", "")
    routing = task.get("routing") or {}
    source_ref = task.get("sourceRef") or {}

    intent = build_intent(
        source=source,
        user_identity=source_ref.get("sender", "") or source_ref.get("userId", ""),
        channel_detail=source_ref.get("channelId", "") or source_ref.get("guildId", ""),
        action="task_execute",
        metadata={
            "role": routing.get("role", ""),
            "channel_role": routing.get("channel_role", ""),
            "guild_id": routing.get("guild_id", ""),
            "is_home_guild": routing.get("is_home_guild", False),
        },
    )

    decision = evaluate(intent)
    audit_entry = _enrich_intent(intent)

    # Store intent on task for audit trail
    task["commandIntent"] = audit_entry

    # Record in command channels audit ring
    try:
        from routes.command_channels import record_gate_decision
        record_gate_decision(audit_entry)
    except ImportError:
        pass

    log.info("command_gate: source=%s trust=%s decision=%s user=%s",
             source, intent.trust_level, decision, intent.user_identity or "system")

    # Record in approval tracker (v3.3)
    try:
        from services.approval_tracker import record_event
        event_map = {
            "allow": ("task_auto_approved", "auto_approved"),
            "approve": ("task_requires_approval", "pending"),
            "deny": ("task_denied", "denied"),
        }
        et, outcome = event_map.get(decision, ("task_requires_approval", "pending"))
        record_event(
            event_type=et,
            source=source,
            trust_level=intent.trust_level,
            action=intent.action,
            outcome=outcome,
            task_id=task.get("id", ""),
        )
    except Exception:
        pass

    return decision == "allow"


# ── Registry CRUD ─────────────────────────────────────────

def read_registry() -> dict:
    """Read the task registry, returning empty structure on failure."""
    try:
        if config.REGISTRY_JSON.is_file():
            return json.loads(config.REGISTRY_JSON.read_text())
    except (json.JSONDecodeError, OSError):
        pass
    return {"tasks": {}}


def write_registry(registry: dict):
    """Write the task registry atomically."""
    registry["lastUpdated"] = datetime.now(timezone.utc).isoformat()
    config.REGISTRY_JSON.parent.mkdir(parents=True, exist_ok=True)
    config.REGISTRY_JSON.write_text(json.dumps(registry, indent=2))


# ── Audit CRUD ────────────────────────────────────────────

_audit_lock = threading.Lock()
AUDIT_MAX_RECORDS = 2000


def read_audit() -> list:
    """Read the audit log, returning empty list on failure.

    Normalizes legacy records by adding a 'tier' field based on origin.
    """
    records = []
    try:
        if config.AUDIT_JSON.is_file():
            records = json.loads(config.AUDIT_JSON.read_text())
    except (json.JSONDecodeError, OSError):
        return []

    for r in records:
        if "tier" not in r:
            origin = r.get("origin", "")
            if origin in ("scheduled-squad", "push-op"):
                r["tier"] = "execution"
            else:
                r["tier"] = "system"
    return records


def write_audit(records: list):
    """Write the audit log atomically."""
    config.AUDIT_JSON.parent.mkdir(parents=True, exist_ok=True)
    config.AUDIT_JSON.write_text(json.dumps(records, indent=2))


def append_audit_record(record: dict):
    """Thread-safe append with cap; overflow archives old records."""
    with _audit_lock:
        records = read_audit()
        records.insert(0, record)  # newest first
        if len(records) > AUDIT_MAX_RECORDS:
            overflow = records[AUDIT_MAX_RECORDS:]
            records = records[:AUDIT_MAX_RECORDS]
            _archive_audit_records(overflow)
        write_audit(records)


def _archive_audit_records(overflow: list):
    """Append overflow records to audit-archive.json."""
    archive_path = config.OPAI_ROOT / "tasks" / "audit-archive.json"
    existing = []
    try:
        if archive_path.is_file():
            existing = json.loads(archive_path.read_text())
    except (json.JSONDecodeError, OSError):
        pass
    existing.extend(overflow)
    archive_path.write_text(json.dumps(existing, indent=2))


def get_completed_task_ids_from_audit() -> set:
    """Return set of task IDs that have a successful 'completed' audit record."""
    records = read_audit()
    return {r["taskId"] for r in records
            if r.get("status") == "completed" and r.get("origin") == "feedback-fixer"}


def get_today_token_usage() -> int:
    """Sum tokensTotal for all audit records from today."""
    today_prefix = datetime.now().strftime("audit-%Y%m%d")
    records = read_audit()
    total = 0
    for r in records:
        if r.get("id", "").startswith(today_prefix):
            total += r.get("tokensTotal", 0)
    return total


def _generate_audit_id() -> str:
    """Generate audit-YYYYMMDD-{random}-{ts} ID."""
    date_str = datetime.now().strftime("%Y%m%d")
    rand = random.randint(100, 999)
    ts = int(time.time() * 1000) % 100000
    return f"audit-{date_str}-{rand}-{ts}"


def _determine_origin(task: dict) -> str:
    """Map task routing/type to origin label.

    v3.2: uses commandIntent trust_level when available for richer labels.
    """
    routing = task.get("routing") or {}
    rtype = routing.get("type", "")
    mode = routing.get("mode", "")
    source = task.get("source", "")
    intent = task.get("commandIntent") or {}
    trust = intent.get("trust_level", "")

    if rtype == "feedback-fix" or source == "feedback":
        return "feedback-fixer"
    if trust == "command" and source:
        return f"{source}-command"
    if trust == "proposal":
        return f"{source}-proposal" if source else "proposal"
    if mode == "queued":
        return "hitl"
    if mode == "execute" and rtype == "agent-assigned":
        return "auto-executor"
    return "manual"


def _enrich_with_session_tokens(session_id: str) -> dict:
    """Read token usage from a Claude session JSONL file.

    Returns dict with tokensInput, tokensOutput, tokensCacheRead, tokensCacheCreate, tokensTotal.
    """
    empty = {"tokensInput": 0, "tokensOutput": 0, "tokensCacheRead": 0, "tokensCacheCreate": 0, "tokensTotal": 0}
    if not session_id:
        return empty

    claude_projects = Path.home() / ".claude" / "projects"
    if not claude_projects.is_dir():
        return empty

    # Find the JSONL file matching this session_id
    for project_dir in claude_projects.iterdir():
        if not project_dir.is_dir():
            continue
        jsonl = project_dir / f"{session_id}.jsonl"
        if jsonl.is_file():
            return _parse_session_tokens(jsonl)

    return empty


def _parse_session_tokens(jsonl_path: Path) -> dict:
    """Parse token usage from a session JSONL file."""
    tokens_in = 0
    tokens_out = 0
    tokens_cache_read = 0
    tokens_cache_create = 0

    try:
        with open(jsonl_path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                usage = entry.get("usage") or entry.get("message", {}).get("usage") or {}
                if usage:
                    tokens_in += usage.get("input_tokens", 0)
                    tokens_out += usage.get("output_tokens", 0)
                    tokens_cache_read += usage.get("cache_read_input_tokens", 0) or usage.get("cacheReadInputTokens", 0)
                    tokens_cache_create += usage.get("cache_creation_input_tokens", 0) or usage.get("cacheCreationInputTokens", 0)
    except OSError:
        pass

    total = tokens_in + tokens_out + tokens_cache_read + tokens_cache_create
    return {
        "tokensInput": tokens_in,
        "tokensOutput": tokens_out,
        "tokensCacheRead": tokens_cache_read,
        "tokensCacheCreate": tokens_cache_create,
        "tokensTotal": total,
    }


def extract_session_trace(session_id: str) -> list[dict]:
    """Extract the full tool call trace from a session JSONL.

    Returns a list of steps: [{turn, action, detail, file, thinking}]
    """
    if not session_id:
        return []
    import glob as glob_mod
    pattern = str(Path.home() / ".claude" / "projects" / "*" / f"{session_id}.jsonl")
    matches = glob_mod.glob(pattern)
    if not matches:
        return []
    try:
        steps = []
        turn = 0
        for line in open(matches[0]):
            obj = json.loads(line)
            msg = obj.get("message", {})
            if msg.get("role") != "assistant":
                continue
            has_tool = any(b.get("type") == "tool_use" for b in msg.get("content", []))
            if has_tool:
                turn += 1
            for block in msg.get("content", []):
                btype = block.get("type")
                if btype == "tool_use":
                    name = block.get("name", "?")
                    inp = block.get("input", {})
                    step = {"turn": turn, "action": name, "detail": "", "file": ""}
                    if name == "Read":
                        fp = inp.get("file_path", "?")
                        short = fp.split("/")[-1]
                        off = inp.get("offset", "")
                        lim = inp.get("limit", "")
                        step["file"] = short
                        step["detail"] = f"[{off}:{lim}]" if off or lim else "full file"
                    elif name == "Edit":
                        fp = inp.get("file_path", "?")
                        step["file"] = fp.split("/")[-1]
                        old_len = len(inp.get("old_string", ""))
                        new_len = len(inp.get("new_string", ""))
                        step["detail"] = f"{old_len}→{new_len} chars"
                    elif name == "Write":
                        fp = inp.get("file_path", "?")
                        step["file"] = fp.split("/")[-1]
                        step["detail"] = f"{len(inp.get('content', ''))} chars"
                    elif name in ("Grep", "Glob"):
                        step["detail"] = inp.get("pattern", "")[:60]
                    elif name == "Bash":
                        step["detail"] = inp.get("command", "")[:80]
                    else:
                        step["detail"] = str(inp)[:80]
                    steps.append(step)
                elif btype == "text" and block.get("text", "").strip():
                    steps.append({
                        "turn": turn,
                        "action": "text",
                        "detail": block["text"].strip()[:200],
                        "file": "",
                    })
        return steps
    except Exception:
        return []


def find_session_for_audit(record: dict) -> str:
    """Find the session ID for an audit record by scanning JSONL files.

    Matches by task ID in file content + completion time proximity.
    Pure file scan — no AI.
    """
    import glob as glob_mod
    task_id = record.get("taskId", "")
    completed_at = record.get("completedAt", "")
    if not task_id or not completed_at:
        return ""
    try:
        from datetime import datetime as _dt
        target_ts = _dt.fromisoformat(completed_at.replace("Z", "+00:00")).timestamp()
    except Exception:
        return ""
    pattern = str(Path.home() / ".claude" / "projects" / "*" / "*.jsonl")
    best_id = ""
    best_diff = 120  # max 2 minutes difference
    for fp in glob_mod.glob(pattern):
        if "/subagents/" in fp:
            continue
        try:
            mtime = os.path.getmtime(fp)
            diff = abs(mtime - target_ts)
            if diff > best_diff:
                continue
            # Quick check: read first 5KB for task ID
            with open(fp) as f:
                head = f.read(5000)
            if task_id not in head:
                continue
            # Extract session ID from first line
            first_obj = json.loads(head.split("\n", 1)[0])
            sid = first_obj.get("sessionId", "")
            if sid and diff < best_diff:
                best_diff = diff
                best_id = sid
        except Exception:
            continue
    return best_id


def stream_audit_analysis(record: dict, messages: list[dict]):
    """Stream Claude analysis of an audit record via SSE.

    Builds a system prompt with full run context, then streams Claude's
    response as Server-Sent Events.  Supports multi-turn follow-up
    via the `messages` parameter (list of {role, content} dicts).

    Yields SSE lines: "data: {json}\n\n"
    """
    import logging
    log = logging.getLogger(__name__)

    d = record.get("details") or {}

    # Gather all context fields
    context_parts = [
        f"Audit ID: {record.get('id', '?')}",
        f"Timestamp: {record.get('timestamp') or record.get('startedAt', '?')}",
        f"Tier: {record.get('tier', 'legacy')}",
        f"Service: {record.get('service', '?')}",
        f"Event: {record.get('event') or record.get('origin', '?')}",
        f"Status: {record.get('status', '?')}",
        f"Agent: {d.get('agentName') or d.get('agentId') or record.get('agentName') or record.get('agentId', '?')}",
        f"Agent Type: {d.get('agentType') or record.get('agentType', '?')}",
        f"Model: {d.get('model') or record.get('model', '?')}",
        f"Duration: {record.get('durationMs') or record.get('duration_ms', 0)}ms",
        f"Turns: {d.get('numTurns') or record.get('numTurns', '?')}",
        f"Tokens Total: {d.get('tokensTotal') or record.get('tokensTotal', 0)}",
        f"Tokens Input: {d.get('tokensInput') or record.get('tokensInput', 0)}",
        f"Tokens Output: {d.get('tokensOutput') or record.get('tokensOutput', 0)}",
        f"Cost: ${d.get('costUsd') or record.get('costUsd', 0)}",
    ]
    task_id = d.get("taskId") or record.get("taskId")
    if task_id:
        context_parts.append(f"Task ID: {task_id}")
        # Load task details for full context
        try:
            registry = read_registry()
            task = registry.get("tasks", {}).get(task_id)
            if task:
                context_parts.append(f"Task Title: {task.get('title', '?')}")
                context_parts.append(f"Task Description: {task.get('description', '')}")
                context_parts.append(f"Task Priority: {task.get('priority', '?')}")
        except Exception:
            pass

    error_msg = record.get("errorMessage") or d.get("errorMessage")
    if error_msg:
        context_parts.append(f"Error Message: {error_msg}")

    summary = record.get("summary", "")
    if summary:
        context_parts.append(f"Summary: {summary}")

    report_file = d.get("reportFile") or record.get("reportFile")
    if report_file:
        context_parts.append(f"Report File: {report_file}")
        try:
            rpath = Path(config.OPAI_ROOT) / report_file.lstrip("/")
            if rpath.is_file():
                report_text = rpath.read_text(errors="replace")[:8000]
                context_parts.append(f"\n--- Report Content ---\n{report_text}")
        except Exception:
            pass

    # Get trace steps if session available
    session_id = d.get("sessionId") or record.get("sessionId") or record.get("session_id", "")
    if not session_id:
        session_id = find_session_for_audit(record)
    if session_id:
        context_parts.append(f"Session ID: {session_id}")
        steps = extract_session_trace(session_id)
        if steps:
            trace_text = "\n".join(
                f"  T{s['turn']} {s['action']} {s.get('file', '')} {s.get('detail', '')}"
                for s in steps[:40]
            )
            context_parts.append(f"\n--- Tool Call Trace ({len(steps)} steps) ---\n{trace_text}")

    run_context = "\n".join(context_parts)

    system_prompt = (
        "You are OPAI Log Analyst, an expert at reading OPAI agent run audit logs.\n"
        "You have the full context of a single agent run below.\n\n"
        "Your job:\n"
        "1. Determine SUCCESS or FAILURE clearly.\n"
        "2. Explain what the run did (concise).\n"
        "3. If failed: identify the root cause, suggest specific fixes.\n"
        "4. If successful: note any anomalies (high token usage, long duration, etc.).\n"
        "5. When you suggest a fix, format it so the user can create a task from it.\n\n"
        "Keep responses focused and actionable. Use markdown formatting.\n\n"
        f"--- RUN CONTEXT ---\n{run_context}\n--- END CONTEXT ---"
    )

    # Build conversation for claude -p
    if messages:
        # Multi-turn: user follow-ups
        conversation = system_prompt + "\n\n"
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if role == "assistant":
                conversation += f"[Previous response]\n{content}\n\n"
            else:
                conversation += f"[User]\n{content}\n\n"
        conversation += "Respond to the latest user message."
    else:
        conversation = (
            system_prompt + "\n\n"
            "Analyze this run. Provide:\n"
            "1. **Status**: Clear success/failure verdict\n"
            "2. **What Happened**: Brief summary of the run\n"
            "3. **Issues Found**: Any problems, errors, or anomalies\n"
            "4. **Suggested Fix**: If applicable, a specific actionable fix\n"
        )

    clean_env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}

    # Resolve claude path
    claude_cmd = "claude"
    nvm_path = Path.home() / ".nvm" / "versions" / "node" / "v20.19.5" / "bin" / "claude"
    if nvm_path.is_file():
        claude_cmd = str(nvm_path)

    cmd = [claude_cmd, "-p", "--output-format", "stream-json", "--verbose",
           "--model", "haiku", "--max-turns", "1"]

    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=str(config.OPAI_ROOT),
            env=clean_env,
        )
        proc.stdin.write(conversation)
        proc.stdin.close()

        for raw_line in proc.stdout:
            line = raw_line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue

            etype = event.get("type", "")
            if etype == "assistant" and "message" in event:
                # Extract text from content blocks
                msg = event["message"]
                for block in msg.get("content", []):
                    if block.get("type") == "text":
                        yield f"data: {json.dumps({'type': 'text', 'content': block['text']})}\n\n"
            elif etype == "content_block_delta":
                delta = event.get("delta", {})
                if delta.get("type") == "text_delta":
                    yield f"data: {json.dumps({'type': 'delta', 'content': delta['text']})}\n\n"
            elif etype == "result":
                # Final result — send as complete
                result_text = event.get("result", "")
                if result_text:
                    yield f"data: {json.dumps({'type': 'result', 'content': result_text})}\n\n"

        proc.wait(timeout=10)
        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    except FileNotFoundError:
        yield f"data: {json.dumps({'type': 'error', 'content': 'Claude CLI not found'})}\n\n"
    except subprocess.TimeoutExpired:
        proc.kill()
        yield f"data: {json.dumps({'type': 'error', 'content': 'Analysis timed out'})}\n\n"
    except Exception as e:
        log.exception("Audit analysis error")
        yield f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n"


def _extract_edits_from_session(session_id: str) -> str:
    """Read session JSONL and extract Edit/Write tool calls as a summary.

    When the agent ends on a tool call instead of text, the JSON 'result'
    is empty. This function recovers what actually happened.
    """
    if not session_id:
        return ""
    # Search all project session dirs for the JSONL
    import glob as glob_mod
    pattern = str(Path.home() / ".claude" / "projects" / "*" / f"{session_id}.jsonl")
    matches = glob_mod.glob(pattern)
    if not matches:
        return ""
    try:
        edits = []
        texts = []
        for line in open(matches[0]):
            obj = json.loads(line)
            msg = obj.get("message", {})
            if msg.get("role") != "assistant":
                continue
            for block in msg.get("content", []):
                if block.get("type") == "tool_use" and block.get("name") in ("Edit", "Write"):
                    fp = block.get("input", {}).get("file_path", "?")
                    short = fp.split("/")[-1]
                    edits.append(f"- `{short}` — edited")
                elif block.get("type") == "text" and block.get("text", "").strip():
                    texts.append(block["text"].strip())
        if not edits:
            return ""
        parts = ["## Changes Applied (extracted from session)\n"]
        parts.extend(edits)
        if texts:
            parts.append(f"\n### Agent Notes\n{texts[-1][:500]}")
        return "\n".join(parts)
    except Exception:
        return ""


def _parse_claude_json_output(stdout: str) -> dict:
    """Parse claude --output-format json stdout.

    Returns dict with keys: result, cost_usd, duration_ms, duration_api_ms,
    num_turns, model, session_id, is_error. Falls back gracefully.
    """
    fallback = {
        "result": stdout.strip(),
        "cost_usd": 0.0,
        "duration_ms": 0,
        "duration_api_ms": 0,
        "num_turns": 0,
        "model": "",
        "session_id": "",
        "is_error": False,
    }
    try:
        wrapper = json.loads(stdout)
    except (json.JSONDecodeError, TypeError):
        return fallback

    return {
        "result": wrapper.get("result", "").strip() if isinstance(wrapper.get("result"), str) else str(wrapper.get("result", "")),
        "cost_usd": wrapper.get("cost_usd", 0.0) or 0.0,
        "duration_ms": wrapper.get("duration_ms", 0) or 0,
        "duration_api_ms": wrapper.get("duration_api_ms", 0) or 0,
        "num_turns": wrapper.get("num_turns", 0) or 0,
        "model": wrapper.get("model", "") or "",
        "session_id": wrapper.get("session_id", "") or "",
        "is_error": wrapper.get("is_error", False),
    }


def get_audit_summary(records: list, date_from: str = "", date_to: str = "") -> dict:
    """Aggregate audit stats from records (supports both legacy and tiered formats)."""
    filtered = records
    if date_from:
        filtered = [r for r in filtered if (r.get("timestamp") or r.get("startedAt") or "") >= date_from]
    if date_to:
        filtered = [r for r in filtered if (r.get("timestamp") or r.get("startedAt") or "") <= date_to + "T23:59:59Z"]

    total_runs = len(filtered)
    total_cost = 0.0
    total_duration = 0
    total_tokens = 0
    error_count = 0

    by_agent = {}
    by_origin = {}
    by_day = {}
    cost_by_day = {}
    cost_by_agent = {}
    tokens_by_day = {}
    tokens_by_agent = {}
    by_tier = {}
    by_service = {}

    for r in filtered:
        d = r.get("details") or {}
        r_tokens = r.get("tokensTotal", 0) or d.get("tokensTotal", 0) or 0
        r_cost = r.get("costUsd", 0) or d.get("costUsd", 0) or 0
        r_dur = r.get("durationMs", 0) or r.get("duration_ms", 0) or 0
        is_error = r.get("isError") or d.get("isError") or r.get("status") in ("failed", "timeout")

        total_tokens += r_tokens
        total_cost += r_cost
        total_duration += r_dur
        if is_error:
            error_count += 1

        agent = r.get("agentId") or d.get("agentId") or "unknown"
        origin = r.get("origin") or r.get("event") or "unknown"
        ts = r.get("timestamp") or r.get("startedAt") or ""
        day = ts[:10]
        tier = r.get("tier", "legacy")
        service = r.get("service", "")

        by_agent[agent] = by_agent.get(agent, 0) + 1
        by_origin[origin] = by_origin.get(origin, 0) + 1
        by_tier[tier] = by_tier.get(tier, 0) + 1
        if service:
            by_service[service] = by_service.get(service, 0) + 1
        if day:
            by_day[day] = by_day.get(day, 0) + 1
            cost_by_day[day] = cost_by_day.get(day, 0) + r_cost
            tokens_by_day[day] = tokens_by_day.get(day, 0) + r_tokens
        cost_by_agent[agent] = cost_by_agent.get(agent, 0) + r_cost
        tokens_by_agent[agent] = tokens_by_agent.get(agent, 0) + r_tokens

    return {
        "totalRuns": total_runs,
        "totalTokens": total_tokens,
        "avgTokensPerRun": round(total_tokens / total_runs) if total_runs else 0,
        "totalCostUsd": round(total_cost, 4),
        "avgCostUsd": round(total_cost / total_runs, 4) if total_runs else 0,
        "avgDurationMs": round(total_duration / total_runs) if total_runs else 0,
        "errorRate": round(error_count / total_runs, 3) if total_runs else 0,
        "byAgent": by_agent,
        "byOrigin": by_origin,
        "byDay": by_day,
        "costByDay": cost_by_day,
        "costByAgent": cost_by_agent,
        "tokensByDay": tokens_by_day,
        "tokensByAgent": tokens_by_agent,
        "byTier": by_tier,
        "byService": by_service,
    }


def generate_task_id(registry: dict) -> str:
    """Generate next task ID: t-YYYYMMDD-NNN."""
    date_str = datetime.now().strftime("%Y%m%d")
    existing = [k for k in registry["tasks"] if k.startswith(f"t-{date_str}-")]
    next_num = len(existing) + 1
    # Handle collisions
    while f"t-{date_str}-{next_num:03d}" in registry["tasks"]:
        next_num += 1
    return f"t-{date_str}-{next_num:03d}"


def get_summary(registry: dict) -> dict:
    """Compute summary counts from registry."""
    tasks = list(registry.get("tasks", {}).values())
    today = datetime.now().strftime("%Y-%m-%d")

    by_status = {}
    by_priority = {}
    by_project = {}
    by_source = {}
    overdue = 0

    for t in tasks:
        s = t.get("status", "unknown")
        by_status[s] = by_status.get(s, 0) + 1

        p = t.get("priority", "normal")
        by_priority[p] = by_priority.get(p, 0) + 1

        proj = t.get("project") or "unassigned"
        by_project[proj] = by_project.get(proj, 0) + 1

        src = t.get("source", "unknown")
        by_source[src] = by_source.get(src, 0) + 1

        deadline = t.get("deadline")
        if deadline and t.get("status") not in ("completed", "cancelled"):
            try:
                if deadline < today:
                    overdue += 1
            except (TypeError, ValueError):
                pass

    return {
        "total": len(tasks),
        "by_status": by_status,
        "by_priority": by_priority,
        "by_project": by_project,
        "by_source": by_source,
        "overdue": overdue,
    }


# ── Team Hub HITL Bridge (v3.5) ───────────────────────────

def create_teamhub_hitl_item(task_data: dict) -> dict | None:
    """Create a Team Hub item for HITL review instead of (in addition to) an .md file.

    Returns the created Team Hub item dict, or None on failure.
    Falls back gracefully — .md file remains the backup path.
    """
    try:
        import httpx

        title = task_data.get("title", "Untitled")
        description = task_data.get("description", "")
        priority = task_data.get("priority", "medium")
        source = task_data.get("source", "system")
        task_id = task_data.get("id", "")

        # Build description with task context
        desc_parts = [description]
        if task_id:
            desc_parts.append(f"\n---\nRegistry Task ID: `{task_id}`")
        if task_data.get("routing"):
            routing = task_data["routing"]
            desc_parts.append(f"Routing: type={routing.get('type', '?')}, mode={routing.get('mode', '?')}")

        params = {
            "workspace_id": config.WORKERS_WORKSPACE_ID,
            "user_id": config.SYSTEM_USER_ID,
            "type": "decision",
            "title": f"[HITL] {title}",
            "description": "\n".join(desc_parts),
            "priority": priority,
            "status": "awaiting-human",
            "list_id": config.HITL_QUEUE_LIST_ID,
            "source": source,
        }

        resp = httpx.post(
            f"{config.TEAMHUB_INTERNAL}/create-item",
            params=params,
            timeout=8.0,
        )
        if resp.status_code < 400:
            item = resp.json()
            log.info("Created Team Hub HITL item: %s for task %s", item.get("id", "?"), task_id)
            return item
        else:
            log.warning("Team Hub HITL create failed: %d %s", resp.status_code, resp.text[:200])
    except Exception as e:
        log.warning("Team Hub HITL bridge error: %s", e)
    return None


# ── HITL Briefings ────────────────────────────────────────

def list_hitl() -> list[dict]:
    """List HITL briefing files, filtering out orphans whose tasks no longer exist."""
    items = []
    hitl_dir = config.REPORTS_HITL
    if not hitl_dir.is_dir():
        return items

    registry = read_registry()
    task_ids = set(registry.get("tasks", {}).keys())

    for f in sorted(hitl_dir.glob("*.md"), reverse=True):
        task_id = f.stem  # e.g. "t-20260212-029"
        if task_id not in task_ids:
            # Orphan briefing — task was deleted/migrated. Auto-archive it.
            try:
                archive_hitl(f.name)
            except Exception:
                pass
            continue
        stat = f.stat()
        items.append({
            "filename": f.name,
            "size": stat.st_size,
            "modified": datetime.fromtimestamp(stat.st_mtime).isoformat() + "Z",
        })
    return items


def read_hitl(filename: str) -> str | None:
    """Read a HITL briefing file."""
    path = config.REPORTS_HITL / filename
    if not path.is_file() or ".." in filename:
        return None
    return path.read_text()


def archive_hitl(filename: str) -> bool:
    """Move a HITL briefing to the archive."""
    src = config.REPORTS_HITL / filename
    if not src.is_file() or ".." in filename:
        return False
    config.REPORTS_ARCHIVE.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(config.REPORTS_ARCHIVE / filename))
    return True


# ── Team/Squad Data ───────────────────────────────────────

def get_squads() -> list[dict]:
    """Read squad definitions from team.json with agent details."""
    try:
        if config.TEAM_JSON.is_file():
            data = json.loads(config.TEAM_JSON.read_text())
            squads = data.get("squads", {})
            roles = data.get("roles", {})
            result = []
            for name, info in squads.items():
                agent_ids = info.get("agents", [])
                agents_detail = []
                for aid in agent_ids:
                    role = roles.get(aid, {})
                    agents_detail.append({
                        "id": aid,
                        "name": role.get("name", aid),
                        "description": role.get("description", ""),
                    })
                result.append({
                    "name": name,
                    "agents": agent_ids,
                    "agentsDetail": agents_detail,
                    "description": info.get("description", ""),
                })
            return result
    except (json.JSONDecodeError, OSError):
        pass
    return []


def get_agents() -> dict:
    """Read agent roles and squads from team.json for the agent picker."""
    try:
        if config.TEAM_JSON.is_file():
            data = json.loads(config.TEAM_JSON.read_text())
            roles = data.get("roles", {})
            squads = data.get("squads", {})

            agents = []
            for key, info in roles.items():
                agents.append({
                    "id": key,
                    "name": info.get("name", key),
                    "description": info.get("description", ""),
                    "category": info.get("category", ""),
                    "type": "agent",
                })

            squad_list = []
            for key, info in squads.items():
                squad_list.append({
                    "id": key,
                    "name": key,
                    "description": info.get("description", ""),
                    "agents": info.get("agents", []),
                    "type": "squad",
                })

            return {"agents": agents, "squads": squad_list}
    except (json.JSONDecodeError, OSError):
        pass
    return {"agents": [], "squads": []}


def auto_route_task(task: dict) -> dict:
    """Classify a task and assign the best agent/squad automatically.

    Uses work-companion (Node.js) for keyword-based classification, then
    maps the result to a concrete agentConfig so the auto-executor can
    pick it up.  Falls back gracefully if work-companion is unavailable.

    Returns the (possibly mutated) task dict.
    """
    title = task.get("title", "")
    description = task.get("description", "")
    text = f"{title} {description}".strip()
    if not text:
        return task

    companion = config.OPAI_ROOT / "tools" / "work-companion" / "index.js"
    if not companion.is_file():
        return task

    try:
        proc = subprocess.run(
            ["node", "-e", f"""
const wc = require('{companion}');
const c = wc.classifyTask({json.dumps(text)});
const r = wc.routeTask(c);
console.log(JSON.stringify({{c, r}}));
"""],
            capture_output=True, text=True, timeout=10,
            cwd=str(config.OPAI_ROOT),
        )
        if proc.returncode != 0:
            return task

        result = json.loads(proc.stdout.strip())
        classification = result["c"]
        routing = result["r"]
    except (subprocess.TimeoutExpired, json.JSONDecodeError, KeyError, OSError):
        return task

    # Determine best single agent or squad
    squads = routing.get("squads", [])
    agents = routing.get("agents", [])
    mode = routing.get("mode", "propose")

    # Set routing info
    task["routing"] = {
        "type": classification.get("type", "feature"),
        "squads": squads,
        "mode": mode,
    }

    # Pick the primary agent/squad for agentConfig
    agent_id = None
    agent_type = "agent"
    agent_name = ""

    if squads:
        # Prefer squad execution — validates and gets agent list
        squad_id = squads[0]
        validation = validate_agent_config(squad_id, "squad")
        if validation.get("valid"):
            agent_id = squad_id
            agent_type = "squad"
            agent_name = squad_id
    elif agents:
        # Fall back to individual agent
        for candidate in agents:
            validation = validate_agent_config(candidate, "agent")
            if validation.get("valid"):
                agent_id = candidate
                agent_name = validation.get("name", candidate)
                break

    if agent_id:
        task["assignee"] = "agent"
        task["agentConfig"] = {
            "agentId": agent_id,
            "agentType": agent_type,
            "agentName": agent_name,
            "instructions": "",
        }
    else:
        # No valid agent found — assign to human for review
        task["assignee"] = "human"

    task["updatedAt"] = datetime.now(timezone.utc).isoformat()
    return task


def validate_agent_config(agent_id: str, agent_type: str = "agent") -> dict:
    """Validate that an agent or squad exists in team.json."""
    try:
        if not config.TEAM_JSON.is_file():
            return {"valid": False, "error": "team.json not found"}
        data = json.loads(config.TEAM_JSON.read_text())
    except (json.JSONDecodeError, OSError):
        return {"valid": False, "error": "Cannot read team.json"}

    if agent_type == "squad":
        squads = data.get("squads", {})
        if agent_id in squads:
            return {"valid": True, "name": agent_id, "type": "squad",
                    "agents": squads[agent_id].get("agents", [])}
        return {"valid": False, "error": f"Squad '{agent_id}' not found in team.json"}
    else:
        roles = data.get("roles", {})
        if agent_id in roles:
            return {"valid": True, "name": roles[agent_id].get("name", agent_id),
                    "type": "agent"}
        return {"valid": False, "error": f"Agent '{agent_id}' not found in team.json"}


def run_agent_task(task_id: str, agent_id: str, agent_type: str = "agent",
                   instructions: str = "") -> dict:
    """Run a specific agent on a task via claude -p.

    Builds a prompt from the task context + agent prompt file + custom instructions,
    pipes it to claude -p, saves the output as a report, and returns the result.
    """
    registry = read_registry()
    task = registry.get("tasks", {}).get(task_id)
    if not task:
        return {"success": False, "error": f"Task {task_id} not found"}

    # Load team.json
    try:
        team_data = json.loads(config.TEAM_JSON.read_text())
    except (json.JSONDecodeError, OSError):
        return {"success": False, "error": "Cannot read team.json"}

    # Build the prompt
    prompt_parts = []

    # Task context
    prompt_parts.append("# Task Assignment\n")
    prompt_parts.append(f"**Task ID:** {task_id}")
    prompt_parts.append(f"**Title:** {task.get('title', 'Untitled')}")
    prompt_parts.append(f"**Priority:** {task.get('priority', 'normal')}")
    prompt_parts.append(f"**Project:** {task.get('project') or 'N/A'}")
    prompt_parts.append(f"**Client:** {task.get('client') or 'N/A'}")
    desc = task.get("description", "")
    if desc:
        prompt_parts.append(f"\n**Description:**\n{desc}")
    if task.get("sourceRef"):
        ref = task["sourceRef"]
        prompt_parts.append(f"\n**Source:** {ref.get('account', '')} — {ref.get('senderName', '')} <{ref.get('sender', '')}>")
        if ref.get("subject"):
            prompt_parts.append(f"**Original Subject:** {ref['subject']}")

    prompt_parts.append("\n---\n")

    if agent_type == "squad":
        # For squads, we just trigger the squad runner
        squad_info = team_data.get("squads", {}).get(agent_id)
        if not squad_info:
            return {"success": False, "error": f"Squad '{agent_id}' not found"}

        # Update task routing and trigger via run_squad.sh
        now = datetime.now(timezone.utc).isoformat()
        task["assignee"] = "agent"
        task["status"] = "running"
        task["updatedAt"] = now
        task.setdefault("routing", {})
        task["routing"]["squads"] = [agent_id]
        task["routing"]["type"] = "agent-assigned"
        if instructions:
            task["agentConfig"] = {
                "agentId": agent_id,
                "agentType": "squad",
                "instructions": instructions,
            }
        write_registry(registry)

        # Trigger squad execution
        try:
            script = config.SCRIPTS_DIR / "run_squad.sh"
            if not script.is_file():
                return {"success": False, "error": "run_squad.sh not found"}

            # Strip CLAUDECODE to prevent nested-spawn block
            clean_env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
            proc = subprocess.Popen(
                ["bash", str(script), "-s", agent_id],
                cwd=str(config.OPAI_ROOT),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=clean_env,
            )

            # Background thread: drain pipes + wait for squad to finish
            def _mark_completed(pid, tid, aid):
                import logging
                _log = logging.getLogger("opai-tasks")
                try:
                    stdout_data, stderr_data = proc.communicate()
                    rc = proc.returncode
                    _log.info("Squad '%s' for task %s exited with code %d", aid, tid, rc)
                    if rc != 0:
                        _log.warning("Squad '%s' stderr: %s", aid, (stderr_data or b'').decode(errors='replace')[:500])
                        _log.warning("Squad '%s' stdout (tail): %s", aid, (stdout_data or b'').decode(errors='replace')[-500:])
                    with _registry_lock:
                        reg = read_registry()
                        t = reg.get("tasks", {}).get(tid)
                        if t and t.get("status") == "running":
                            now2 = datetime.now(timezone.utc).isoformat()
                            t["status"] = "completed" if rc == 0 else "failed"
                            t["completedAt"] = now2 if rc == 0 else None
                            t["updatedAt"] = now2
                            error_detail = (stderr_data or b'').decode(errors='replace')[:300].strip()
                            t.setdefault("agentConfig", {})["response"] = (
                                f"Squad '{aid}' exited with code {rc}"
                                + (f": {error_detail}" if error_detail else "")
                            )
                            t["executionResult"] = {
                                "exitCode": rc,
                                "stderr": (stderr_data or b'').decode(errors='replace')[:1000],
                                "stdout_tail": (stdout_data or b'').decode(errors='replace')[-500:],
                            }
                            write_registry(reg)
                except Exception as exc:
                    _log.error("_mark_completed error for task %s: %s", tid, exc)

            import threading
            threading.Thread(
                target=_mark_completed, args=(proc.pid, task_id, agent_id), daemon=True
            ).start()

            return {
                "success": True,
                "task_id": task_id,
                "agent_id": agent_id,
                "agent_type": "squad",
                "pid": proc.pid,
                "message": f"Squad '{agent_id}' started (PID {proc.pid})",
            }
        except OSError as e:
            return {"success": False, "error": f"Failed to start squad: {e}"}

    # Single agent execution
    role = team_data.get("roles", {}).get(agent_id)
    if not role:
        return {"success": False, "error": f"Agent '{agent_id}' not found"}

    # Load agent's base prompt
    prompt_file = config.SCRIPTS_DIR / role.get("prompt_file", "")
    if prompt_file.is_file():
        prompt_parts.append("# Agent Role Prompt\n")
        prompt_parts.append(prompt_file.read_text())
        prompt_parts.append("\n---\n")

    # Custom instructions
    if instructions:
        prompt_parts.append("# Custom Instructions\n")
        prompt_parts.append("The user has provided these specific instructions for this task. "
                            "Follow them as your PRIMARY directive:\n")
        prompt_parts.append(instructions)
        prompt_parts.append("\n---\n")

    prompt_parts.append("\n# Output Requirements\n")
    prompt_parts.append("- Output your complete report/response as markdown to STDOUT")
    prompt_parts.append("- Be thorough but actionable")
    prompt_parts.append("- If proposing tasks, format them as a numbered list with title, description, assignee, priority")
    prompt_parts.append("- Reference specific files and paths when relevant")

    full_prompt = "\n".join(prompt_parts)

    # Update task state
    now = datetime.now(timezone.utc).isoformat()
    task["assignee"] = "agent"
    task["status"] = "running"
    task["updatedAt"] = now
    task["agentConfig"] = {
        "agentId": agent_id,
        "agentType": "agent",
        "agentName": role.get("name", agent_id),
        "instructions": instructions,
    }
    write_registry(registry)

    # Build clean env (strip CLAUDECODE to prevent nested session errors)
    clean_env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}

    # Record start time for audit
    started_at = datetime.now(timezone.utc).isoformat()
    start_mono = time.monotonic()
    prompt_size = len(full_prompt)

    # Execute claude -p with JSON output for audit metadata
    def _make_audit_record(status, parsed=None, error_msg=None, report_file=None):
        """Build audit record from run context."""
        elapsed = int((time.monotonic() - start_mono) * 1000)
        p = parsed or {}
        # Enrich with token data from session JSONL
        token_data = _enrich_with_session_tokens(p.get("session_id", ""))
        record = {
            "id": _generate_audit_id(),
            "taskId": task_id,
            "agentId": agent_id,
            "agentType": "agent",
            "agentName": role.get("name", agent_id),
            "origin": _determine_origin(task),
            "model": p.get("model", "") or agent_model,
            "startedAt": started_at,
            "completedAt": datetime.now(timezone.utc).isoformat(),
            "durationMs": elapsed,
            "durationApiMs": p.get("duration_api_ms", 0),
            "numTurns": p.get("num_turns", 0),
            "costUsd": p.get("cost_usd", 0.0),
            "promptSizeChars": prompt_size,
            "outputSizeChars": len(p.get("result", "")) if p else 0,
            "isError": status != "completed",
            "errorMessage": error_msg,
            "reportFile": report_file,
            "status": status,
        }
        record.update(token_data)
        return record

    # Resolve per-agent tuning: model, max_turns, no_project_context
    agent_model = (task.get("agentConfig") or {}).get("model", "") or role.get("model", "")
    agent_max_turns = role.get("max_turns", 0)
    agent_no_project_ctx = role.get("no_project_context", False)

    claude_cmd = ["claude", "-p", "--output-format", "json"]
    if agent_model:
        claude_cmd.extend(["--model", agent_model])
    if agent_max_turns:
        claude_cmd.extend(["--max-turns", str(agent_max_turns)])
    if agent_no_project_ctx:
        claude_cmd.extend(["--setting-sources", "user"])

    try:
        result = subprocess.run(
            claude_cmd,
            input=full_prompt,
            capture_output=True,
            text=True,
            timeout=300,  # 5 minute timeout
            cwd=str(config.OPAI_ROOT),
            env=clean_env,
        )
    except FileNotFoundError:
        # Try nvm path
        claude_path = Path.home() / ".nvm" / "versions" / "node" / "v20.19.5" / "bin" / "claude"
        if not claude_path.is_file():
            # Restore task state
            task["status"] = "scheduled"
            task["updatedAt"] = datetime.now(timezone.utc).isoformat()
            write_registry(registry)
            append_audit_record(_make_audit_record("failed", error_msg="claude CLI not found"))
            return {"success": False, "error": "claude CLI not found"}
        try:
            nvm_cmd = [str(claude_path), "-p", "--output-format", "json"]
            if agent_model:
                nvm_cmd.extend(["--model", agent_model])
            if agent_max_turns:
                nvm_cmd.extend(["--max-turns", str(agent_max_turns)])
            if agent_no_project_ctx:
                nvm_cmd.extend(["--setting-sources", "user"])
            result = subprocess.run(
                nvm_cmd,
                input=full_prompt,
                capture_output=True,
                text=True,
                timeout=300,
                cwd=str(config.OPAI_ROOT),
                env=clean_env,
            )
        except subprocess.TimeoutExpired:
            task["status"] = "timed_out"
            task["updatedAt"] = datetime.now(timezone.utc).isoformat()
            write_registry(registry)
            append_audit_record(_make_audit_record("timeout", error_msg="Agent execution timed out (5 min)"))
            return {"success": False, "error": "Agent execution timed out (5 min)"}
    except subprocess.TimeoutExpired:
        task["status"] = "timed_out"
        task["updatedAt"] = datetime.now(timezone.utc).isoformat()
        write_registry(registry)
        append_audit_record(_make_audit_record("timeout", error_msg="Agent execution timed out (5 min)"))
        return {"success": False, "error": "Agent execution timed out (5 min)"}

    # Parse JSON wrapper for audit metadata + report text
    parsed = _parse_claude_json_output(result.stdout)

    if result.returncode != 0:
        task["status"] = "awaiting_retry"
        task["updatedAt"] = datetime.now(timezone.utc).isoformat()
        write_registry(registry)
        stderr = result.stderr.strip()[:500]
        error_msg = f"Agent failed (exit {result.returncode}): {stderr}"
        append_audit_record(_make_audit_record("failed", parsed=parsed, error_msg=error_msg))
        return {"success": False, "error": error_msg}

    report_content = parsed["result"]
    if not report_content:
        report_content = "(Agent produced no output)"

    # Save report
    date_str = datetime.now().strftime("%Y-%m-%d")
    report_dir = config.REPORTS_DIR / date_str
    report_dir.mkdir(parents=True, exist_ok=True)
    report_filename = f"task-{task_id}-{agent_id}.md"
    report_path = report_dir / report_filename

    report_header = f"# Agent Report: {role.get('name', agent_id)}\n"
    report_header += f"**Task:** {task_id} — {task.get('title', '')}\n"
    report_header += f"**Agent:** {agent_id} ({role.get('name', '')})\n"
    report_header += f"**Generated:** {datetime.now().isoformat()}\n"
    if instructions:
        report_header += f"**Instructions:** {instructions[:200]}\n"
    report_header += "\n---\n\n"

    full_report = report_header + report_content
    report_path.write_text(full_report)

    # Also save to latest/
    latest_dir = config.REPORTS_DIR / "latest"
    latest_dir.mkdir(parents=True, exist_ok=True)
    (latest_dir / report_filename).write_text(full_report)

    # Update task with response
    task["status"] = "completed"
    task["updatedAt"] = datetime.now(timezone.utc).isoformat()
    task["agentConfig"]["response"] = report_content
    task["agentConfig"]["reportFile"] = str(report_path)
    task["agentConfig"]["completedAt"] = datetime.now(timezone.utc).isoformat()
    write_registry(registry)

    # Log audit record
    append_audit_record(_make_audit_record("completed", parsed=parsed, report_file=str(report_path)))

    # Check personal notification watches
    try:
        from background.notifier import check_and_fire_personal_notifications
        check_and_fire_personal_notifications(
            task_id=task_id,
            status="completed",
            title=task.get("title", ""),
            worker=agent_id,
            summary=report_content[:300] if report_content else "",
        )
    except Exception:
        pass  # Non-critical

    # Close feedback loop: mark feedback as IMPLEMENTED when task completes
    if task.get("source") == "feedback":
        fid = (task.get("sourceRef") or {}).get("feedbackId")
        if fid:
            try:
                fb_items = parse_feedback_files()
                fb_item = next((i for i in fb_items if i["feedbackId"] == fid), None)
                if fb_item and not fb_item["implemented"]:
                    _mark_feedback_implemented(fb_item)
            except Exception:
                pass  # Non-critical — don't fail the task completion

    return {
        "success": True,
        "task_id": task_id,
        "agent_id": agent_id,
        "agent_name": role.get("name", agent_id),
        "report": report_content,
        "report_file": str(report_path),
    }


def run_agent_task_threaded(task_id: str, agent_id: str,
                            agent_type: str = "agent",
                            instructions: str = ""):
    """Run an agent task in a daemon thread. Updates _running_jobs state."""
    def _run():
        try:
            run_agent_task(task_id, agent_id, agent_type, instructions)
        except Exception:
            # On failure, revert task to awaiting_retry
            with _registry_lock:
                registry = read_registry()
                task = registry.get("tasks", {}).get(task_id)
                if task and task.get("status") == "running":
                    task["status"] = "awaiting_retry"
                    task["updatedAt"] = datetime.now(timezone.utc).isoformat()
                    write_registry(registry)
        finally:
            _running_jobs.pop(task_id, None)

    t = threading.Thread(target=_run, daemon=True)
    _running_jobs[task_id] = {
        "agent_id": agent_id,
        "agent_type": agent_type,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "thread": t,
    }
    t.start()


# ── Feedback Fixer (direct claude -p for feedback items) ─────

# Map feedback tool names to their source directories
_TOOL_DIR_MAP = {
    "TeamHub": "opai-team-hub",
    "Chat": "opai-chat",
    "Files": "opai-files",
    "Monitor": "opai-monitor",
    "Tasks": "opai-tasks",
    "Portal": "opai-portal",
    "Agents": "opai-agents",
    "Marketplace": "opai-marketplace",
    "Docs": "opai-docs",
    "Forum": "opai-forum",
    "ForumBot": "opai-forumbot",
    "Billing": "opai-billing",
    "Users": "opai-users",
    "Dev": "opai-dev",
    "Terminal": "opai-terminal",
    "Messenger": "opai-messenger",
    "Orchestrator": "opai-orchestrator",
    "EmailAgent": "opai-email-agent",
    "WordPress": "opai-wordpress",
}


def _resolve_tool_dir(tool_name: str) -> Path | None:
    """Map a feedback tool name to its source directory."""
    mapped = _TOOL_DIR_MAP.get(tool_name)
    if mapped:
        d = config.OPAI_ROOT / "tools" / mapped
        if d.is_dir():
            return d
    # Fuzzy fallback: try opai-{lowercase}
    candidate = config.OPAI_ROOT / "tools" / f"opai-{tool_name.lower().replace(' ', '-')}"
    if candidate.is_dir():
        return candidate
    return None


_TOOL_WIKI_MAP = {
    "TeamHub": "team-hub.md",
    "Chat": "chat.md",
    "Files": "files.md",
    "Monitor": "monitor.md",
    "Tasks": "task-control-panel.md",
    "Portal": "portal.md",
    "Agents": "agent-studio.md",
    "Marketplace": "marketplace.md",
    "Docs": "docs.md",
    "Billing": "billing.md",
    "Orchestrator": "orchestrator.md",
    "Forum": "forumbot.md",
    "Dev": "dev-ide.md",
    "WordPress": "op-wordpress.md",
}


def _build_feedback_fix_prompt(task: dict, fb_item: dict) -> str:
    """Build a rich prompt with agent role, wiki context, and HITL notes."""
    tool_name = fb_item.get("tool", "")
    tool_dir = _resolve_tool_dir(tool_name)
    severity = fb_item.get("severity", "MEDIUM")
    category = fb_item.get("category", "")
    description = fb_item.get("description", task.get("description", ""))

    parts = []

    # Load the registered agent prompt file for role context
    prompt_file = config.SCRIPTS_DIR / "prompt_feedback_fixer.txt"
    if prompt_file.is_file():
        parts.append(prompt_file.read_text().strip())
        parts.append("\n\n---\n")

    # Task-specific context
    parts.append("# Current Feedback Task\n")
    parts.append(f"**Feedback ID:** {fb_item.get('feedbackId', 'N/A')}")
    parts.append(f"**Tool:** {tool_name}")
    parts.append(f"**Severity:** {severity}")
    parts.append(f"**Category:** {category}")
    parts.append(f"**Task ID:** {task.get('id', 'N/A')}")
    parts.append(f"\n## User Feedback\n\n{description}\n")

    # HITL / human-added context from task notes or instructions
    instructions = (task.get("agentConfig") or {}).get("instructions", "")
    notes = task.get("notes", "")
    if instructions:
        parts.append(f"## Human Instructions\n\n{instructions}\n")
    if notes:
        parts.append(f"## Reviewer Notes\n\n{notes}\n")

    # Source location and safety constraints
    if tool_dir:
        parts.append(f"## Source Location\n")
        parts.append(f"The tool's source code is at: `{tool_dir}`")
        parts.append(f"Workspace root: `{config.OPAI_ROOT}`")
        parts.append(f"**IMPORTANT:** Only modify files within `{tool_dir}` — "
                     "do not edit other tools or system files.\n")

    parts.append("## Rules\n")
    parts.append("- ONLY edit files within the tool's directory")
    parts.append("- Do NOT modify .env, config, service, or Caddyfile files")
    parts.append("- If a service restart is needed, note it in your summary — a human will do it\n")

    return "\n".join(parts)


def _run_feedback_fix(task_id: str, fb_item: dict) -> dict:
    """Run claude -p directly to fix a feedback item.

    Unlike run_agent_task which uses agent prompts, this builds a
    feedback-specific prompt that instructs claude to find and fix the
    issue in the tool's source code.
    """
    registry = read_registry()
    task = registry.get("tasks", {}).get(task_id)
    if not task:
        return {"success": False, "error": f"Task {task_id} not found"}

    # Build the feedback-fix prompt
    full_prompt = _build_feedback_fix_prompt(task, fb_item)

    # Check retry limit (max 3 attempts)
    retry_count = task.get("retryCount", 0)
    MAX_RETRIES = 3
    if retry_count >= MAX_RETRIES:
        task["status"] = "failed"
        task["updatedAt"] = datetime.now(timezone.utc).isoformat()
        task["statusNote"] = f"Max retries ({MAX_RETRIES}) exceeded"
        write_registry(registry)
        return {"success": False, "error": f"Max retries ({MAX_RETRIES}) exceeded for task {task_id}"}

    is_retry = retry_count > 0
    previous_session_id = task.get("lastSessionId", "")

    # Update task state
    now = datetime.now(timezone.utc).isoformat()
    task["status"] = "running"
    task["retryCount"] = retry_count + 1
    task["updatedAt"] = now
    write_registry(registry)

    # Build clean env
    clean_env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}

    # Determine working directory — prefer the tool's dir for better context
    tool_dir = _resolve_tool_dir(fb_item.get("tool", ""))
    cwd = str(tool_dir) if tool_dir else str(config.OPAI_ROOT)

    # Record start time for audit
    started_at = datetime.now(timezone.utc).isoformat()
    start_mono = time.monotonic()
    prompt_size = len(full_prompt)

    def _make_fb_audit_record(status, parsed=None, error_msg=None, report_file=None):
        elapsed = int((time.monotonic() - start_mono) * 1000)
        p = parsed or {}
        token_data = _enrich_with_session_tokens(p.get("session_id", ""))
        record = {
            "id": _generate_audit_id(),
            "taskId": task_id,
            "agentId": "feedback-fixer",
            "agentType": "claude-direct",
            "agentName": "Feedback Fixer",
            "origin": "feedback-fixer",
            "model": p.get("model", "") or model,
            "startedAt": started_at,
            "completedAt": datetime.now(timezone.utc).isoformat(),
            "durationMs": elapsed,
            "durationApiMs": p.get("duration_api_ms", 0),
            "numTurns": p.get("num_turns", 0),
            "costUsd": p.get("cost_usd", 0.0),
            "promptSizeChars": prompt_size,
            "outputSizeChars": len(p.get("result", "")) if p else 0,
            "isError": status != "completed",
            "errorMessage": error_msg,
            "reportFile": report_file,
            "status": status,
        }
        record.update(token_data)
        return record

    # Execute claude -p with full permissions for file editing
    # --dangerously-skip-permissions is required because -p (print mode) is
    # non-interactive and cannot prompt for permission. The fixer runs in a
    # controlled subprocess scoped to the tool's source directory.
    #
    # SAFETY: --tools RESTRICTS to file operations only (--allowedTools only pre-approves,
    # it does NOT restrict). The fixer can read/edit/write files but CANNOT run bash commands.
    # Resolve model: task-level override → settings default → "sonnet"
    model = (task.get("agentConfig") or {}).get("model", "")
    if not model:
        model = get_settings().get("feedback_fixer_model", "sonnet")
    max_turns = str(get_settings().get("feedback_fixer_max_turns", 10))

    _MINI_SYSTEM = (
        "You are a surgical code editor. STRICT RULES: "
        "1) You get ONE Grep call total — make it count with a broad regex. "
        "2) After Grep, Read ONLY the relevant section (use offset+limit). "
        "3) Edit by turn 4 at the latest. Most of your turns should be Edits. "
        "4) Your VERY LAST message MUST be text summarizing changes. "
        "NEVER end on a tool call. NEVER use Bash. NEVER Grep more than once."
    )
    claude_args = [
        "claude", "-p",
        "--output-format", "json",
        "--dangerously-skip-permissions",
        "--tools", "Read,Edit,Write,Glob,Grep",
        "--max-turns", max_turns,
        "--model", model,
        "--setting-sources", "user",
        "--system-prompt", _MINI_SYSTEM,
    ]
    # On retry, resume the previous session to benefit from cached context
    if is_retry and previous_session_id:
        claude_args.extend(["--resume", previous_session_id])
        # Override the prompt on resume to include retry context
        full_prompt = (
            "The previous attempt did not succeed. The fix was not applied "
            "(likely due to permission/refusal or incomplete changes).\n\n"
            "Please try again. Here is the original task:\n\n" + full_prompt
        )
    try:
        result = subprocess.run(
            claude_args,
            input=full_prompt,
            capture_output=True,
            text=True,
            timeout=600,  # 10 minute timeout for implementation tasks
            cwd=cwd,
            env=clean_env,
        )
    except FileNotFoundError:
        claude_path = Path.home() / ".nvm" / "versions" / "node" / "v20.19.5" / "bin" / "claude"
        if not claude_path.is_file():
            task["status"] = "scheduled"
            task["updatedAt"] = datetime.now(timezone.utc).isoformat()
            write_registry(registry)
            append_audit_record(_make_fb_audit_record("failed", error_msg="claude CLI not found"))
            return {"success": False, "error": "claude CLI not found"}
        try:
            result = subprocess.run(
                [str(claude_path), "-p", "--output-format", "json",
                 "--dangerously-skip-permissions",
                 "--tools", "Read,Edit,Write,Glob,Grep",
                 "--max-turns", max_turns,
                 "--model", model,
                 "--setting-sources", "user",
                 "--system-prompt", _MINI_SYSTEM],
                input=full_prompt,
                capture_output=True,
                text=True,
                timeout=600,
                cwd=cwd,
                env=clean_env,
            )
        except subprocess.TimeoutExpired:
            task["status"] = "timed_out"
            task["updatedAt"] = datetime.now(timezone.utc).isoformat()
            write_registry(registry)
            append_audit_record(_make_fb_audit_record("timeout", error_msg="Feedback fix timed out (10 min)"))
            return {"success": False, "error": "Feedback fix timed out (10 min)"}
    except subprocess.TimeoutExpired:
        task["status"] = "timed_out"
        task["updatedAt"] = datetime.now(timezone.utc).isoformat()
        write_registry(registry)
        append_audit_record(_make_fb_audit_record("timeout", error_msg="Feedback fix timed out (10 min)"))
        return {"success": False, "error": "Feedback fix timed out (10 min)"}

    # Parse JSON wrapper for audit metadata + report text
    parsed = _parse_claude_json_output(result.stdout)

    # Store session ID for potential --resume on retry
    session_id = parsed.get("session_id", "")
    if session_id:
        task["lastSessionId"] = session_id

    if result.returncode != 0:
        task["status"] = "awaiting_retry"
        task["updatedAt"] = datetime.now(timezone.utc).isoformat()
        write_registry(registry)
        stderr = result.stderr.strip()[:500]
        error_msg = f"Feedback fix failed (exit {result.returncode}): {stderr}"
        append_audit_record(_make_fb_audit_record("failed", parsed=parsed, error_msg=error_msg))
        return {"success": False, "error": error_msg}

    report_content = parsed["result"]
    if not report_content:
        # Agent ended on a tool call — extract edits from session JSONL
        report_content = _extract_edits_from_session(session_id)
    if not report_content:
        report_content = "(Agent produced no output)"

    # Check if the agent actually succeeded — detect permission failures,
    # refusals, or empty results that shouldn't count as "completed"
    _FAILURE_INDICATORS = [
        "unable to proceed",
        "without write permission",
        "permission denied",
        "grant write access",
        "cannot edit",
        "cannot modify",
        "no changes were made",
        "i can't make changes",
        "read-only",
    ]
    output_lower = report_content.lower()
    fix_actually_applied = not any(ind in output_lower for ind in _FAILURE_INDICATORS)

    # Save report
    date_str = datetime.now().strftime("%Y-%m-%d")
    report_dir = config.REPORTS_DIR / date_str
    report_dir.mkdir(parents=True, exist_ok=True)
    report_filename = f"task-{task_id}-feedback-fix.md"
    report_path = report_dir / report_filename

    tool_name = fb_item.get("tool", "Unknown")
    status_label = "COMPLETED" if fix_actually_applied else "FAILED (no changes applied)"
    report_header = f"# Feedback Fix Report\n"
    report_header += f"**Task:** {task_id} — {task.get('title', '')}\n"
    report_header += f"**Tool:** {tool_name}\n"
    report_header += f"**Feedback:** {fb_item.get('description', '')}\n"
    report_header += f"**Status:** {status_label}\n"
    report_header += f"**Generated:** {datetime.now().isoformat()}\n\n---\n\n"

    full_report = report_header + report_content
    report_path.write_text(full_report)

    latest_dir = config.REPORTS_DIR / "latest"
    latest_dir.mkdir(parents=True, exist_ok=True)
    (latest_dir / report_filename).write_text(full_report)

    # Update task — only mark completed if changes were actually applied
    now = datetime.now(timezone.utc).isoformat()
    if fix_actually_applied:
        task["status"] = "completed"
        task["completedAt"] = now
    else:
        retry_count = task.get("retryCount", 0)
        max_retries = 3
        if retry_count < max_retries:
            task["status"] = "awaiting_retry"
            task["retryCount"] = retry_count + 1
        else:
            task["status"] = "failed"
    task["updatedAt"] = now
    task["agentConfig"]["response"] = report_content
    task["agentConfig"]["reportFile"] = str(report_path)
    task["agentConfig"]["completedAt"] = now if fix_actually_applied else None
    write_registry(registry)

    # Log audit record — override outputSizeChars with actual report content length
    audit_status = "completed" if fix_actually_applied else "failed"
    audit_rec = _make_fb_audit_record(
        audit_status, parsed=parsed,
        error_msg=None if fix_actually_applied else "No changes applied (permission/refusal detected)",
        report_file=str(report_path),
    )
    audit_rec["outputSizeChars"] = len(report_content)
    append_audit_record(audit_rec)

    # Close feedback loop — ONLY if the fix was actually applied
    if fix_actually_applied:
        fid = (task.get("sourceRef") or {}).get("feedbackId")
        if fid:
            try:
                fb_items = parse_feedback_files()
                fb = next((i for i in fb_items if i["feedbackId"] == fid), None)
                if fb and not fb["implemented"]:
                    _mark_feedback_implemented(fb)
            except Exception:
                pass

    return {
        "success": True,
        "task_id": task_id,
        "report": report_content,
        "report_file": str(report_path),
    }


def _run_feedback_fix_threaded(task_id: str, fb_item: dict):
    """Run feedback fix in a daemon thread."""
    def _run():
        try:
            _run_feedback_fix(task_id, fb_item)
        except Exception:
            with _registry_lock:
                registry = read_registry()
                task = registry.get("tasks", {}).get(task_id)
                if task and task.get("status") == "running":
                    task["status"] = "awaiting_retry"
                    task["updatedAt"] = datetime.now(timezone.utc).isoformat()
                    write_registry(registry)
        finally:
            _running_jobs.pop(task_id, None)

    t = threading.Thread(target=_run, daemon=True)
    _running_jobs[task_id] = {
        "agent_id": "feedback-fixer",
        "agent_type": "claude-direct",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "thread": t,
    }
    t.start()


def _build_batch_feedback_prompt(tasks_and_items: list[tuple[dict, dict]]) -> str:
    """Build a single prompt containing multiple feedback items for the same tool."""
    if not tasks_and_items:
        return ""

    # Use the first item's tool context for the shared header
    first_task, first_item = tasks_and_items[0]
    tool_name = first_item.get("tool", "")

    parts = []

    # Shared agent role prompt
    prompt_file = config.SCRIPTS_DIR / "prompt_feedback_fixer.txt"
    if prompt_file.is_file():
        parts.append(prompt_file.read_text().strip())
        parts.append("\n\n---\n")

    parts.append(f"# Batched Feedback Fix — {tool_name}\n")
    parts.append(f"You have **{len(tasks_and_items)} feedback items** to fix for the **{tool_name}** tool.")
    parts.append("Fix each one in sequence. After completing all fixes, summarize what you changed.\n")

    # Per-item sections
    for i, (task, fb_item) in enumerate(tasks_and_items, 1):
        parts.append(f"## Item {i}: {fb_item.get('category', 'General')}")
        parts.append(f"**Task ID:** {task.get('id', 'N/A')}")
        parts.append(f"**Feedback ID:** {fb_item.get('feedbackId', 'N/A')}")
        parts.append(f"**Severity:** {fb_item.get('severity', 'MEDIUM')}")
        parts.append(f"**Description:** {fb_item.get('description', task.get('description', ''))}\n")

    # Shared context
    tool_dir = _resolve_tool_dir(tool_name)
    if tool_dir:
        parts.append(f"## Source Location\n")
        parts.append(f"The tool's source code is at: `{tool_dir}`")
        parts.append(f"**IMPORTANT:** Only modify files within `{tool_dir}`.\n")

    parts.append("## CRITICAL SAFETY RULES\n")
    parts.append("- NEVER stop, restart, or kill ANY systemd services")
    parts.append("- ONLY edit source files within the tool's directory")
    parts.append("- Do NOT modify config files, service files, or .env files")
    parts.append("- Your job is CODE CHANGES ONLY\n")

    # Wiki embedding removed — was adding 3KB to every batch prompt (inflates all turns).
    # Efficiency rules for batch mode too
    parts.append("## EFFICIENCY RULES\n")
    parts.append("- Use Grep/Glob to find exact locations, then Read only relevant sections (offset+limit)")
    parts.append("- Do NOT read entire large files or wiki/README docs")
    parts.append("- Be surgical — search → read section → edit\n")

    return "\n".join(parts)


def _run_feedback_fix_batch(task_ids: list[str], fb_items: list[dict]) -> dict:
    """Run a single claude session to fix multiple feedback items for the same tool."""
    registry = read_registry()
    tasks_and_items = []
    for tid, fb in zip(task_ids, fb_items):
        task = registry.get("tasks", {}).get(tid)
        if not task:
            continue
        tasks_and_items.append((task, fb))

    if not tasks_and_items:
        return {"success": False, "error": "No valid tasks found"}

    full_prompt = _build_batch_feedback_prompt(tasks_and_items)

    # Mark all tasks running
    now = datetime.now(timezone.utc).isoformat()
    for task, _ in tasks_and_items:
        task["status"] = "running"
        task["retryCount"] = task.get("retryCount", 0) + 1
        task["updatedAt"] = now
    write_registry(registry)

    # Build env and resolve paths
    clean_env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
    tool_name = fb_items[0].get("tool", "")
    tool_dir = _resolve_tool_dir(tool_name)
    cwd = str(tool_dir) if tool_dir else str(config.OPAI_ROOT)

    started_at = datetime.now(timezone.utc).isoformat()
    start_mono = time.monotonic()
    prompt_size = len(full_prompt)

    model = get_settings().get("feedback_fixer_model", "sonnet")
    max_turns = str(get_settings().get("feedback_fixer_max_turns", 10))
    # Batch gets extra turns proportional to item count (capped at 40)
    batch_turns = str(min(40, int(max_turns) + (len(tasks_and_items) - 1) * 5))

    _MINI_SYSTEM_BATCH = (
        "You are a surgical code editor. Fix multiple feedback items efficiently. "
        "Use Grep to find code, Read with offset+limit, Edit to fix. "
        "Never read entire files. Never use Bash. "
        "Your FINAL message MUST be a text summary of all changes."
    )
    claude_args = [
        "claude", "-p",
        "--output-format", "json",
        "--dangerously-skip-permissions",
        "--tools", "Read,Edit,Write,Glob,Grep",
        "--max-turns", batch_turns,
        "--model", model,
        "--setting-sources", "user",
        "--system-prompt", _MINI_SYSTEM_BATCH,
    ]
    try:
        result = subprocess.run(
            claude_args, input=full_prompt, capture_output=True, text=True,
            timeout=600, cwd=cwd, env=clean_env,
        )
    except FileNotFoundError:
        claude_path = Path.home() / ".nvm" / "versions" / "node" / "v20.19.5" / "bin" / "claude"
        if not claude_path.is_file():
            for task, _ in tasks_and_items:
                task["status"] = "scheduled"
                task["updatedAt"] = datetime.now(timezone.utc).isoformat()
            write_registry(registry)
            return {"success": False, "error": "claude CLI not found"}
        try:
            result = subprocess.run(
                [str(claude_path)] + claude_args[1:],
                input=full_prompt, capture_output=True, text=True,
                timeout=600, cwd=cwd, env=clean_env,
            )
        except subprocess.TimeoutExpired:
            for task, _ in tasks_and_items:
                task["status"] = "timed_out"
                task["updatedAt"] = datetime.now(timezone.utc).isoformat()
            write_registry(registry)
            return {"success": False, "error": "Batch feedback fix timed out"}
    except subprocess.TimeoutExpired:
        for task, _ in tasks_and_items:
            task["status"] = "timed_out"
            task["updatedAt"] = datetime.now(timezone.utc).isoformat()
        write_registry(registry)
        return {"success": False, "error": "Batch feedback fix timed out"}

    parsed = _parse_claude_json_output(result.stdout)
    report_content = parsed.get("result", "") or "(No output)"
    elapsed = int((time.monotonic() - start_mono) * 1000)
    token_data = _enrich_with_session_tokens(parsed.get("session_id", ""))
    fix_applied = result.returncode == 0

    # Save batch report
    date_str = datetime.now().strftime("%Y-%m-%d")
    report_dir = config.REPORTS_DIR / date_str
    report_dir.mkdir(parents=True, exist_ok=True)
    batch_id = "-".join(tid.split("-")[-1] for tid in task_ids[:4])
    report_filename = f"batch-feedback-{tool_name}-{batch_id}.md"
    report_path = report_dir / report_filename

    header = f"# Batch Feedback Fix Report — {tool_name}\n"
    header += f"**Tasks:** {', '.join(task_ids)}\n"
    header += f"**Status:** {'COMPLETED' if fix_applied else 'FAILED'}\n"
    header += f"**Generated:** {datetime.now().isoformat()}\n\n---\n\n"
    (report_path).write_text(header + report_content)

    # Update all tasks and create audit records
    now = datetime.now(timezone.utc).isoformat()
    for task, fb in tasks_and_items:
        if fix_applied:
            task["status"] = "completed"
            task["completedAt"] = now
        else:
            task["status"] = "awaiting_retry"
        task["updatedAt"] = now

        # Audit record per task
        record = {
            "id": _generate_audit_id(),
            "taskId": task["id"],
            "agentId": "feedback-fixer",
            "agentType": "claude-direct",
            "agentName": "Feedback Fixer (batch)",
            "origin": "feedback-fixer",
            "model": parsed.get("model", model),
            "startedAt": started_at,
            "completedAt": now,
            "durationMs": elapsed,
            "durationApiMs": parsed.get("duration_api_ms", 0),
            "numTurns": parsed.get("num_turns", 0),
            "costUsd": parsed.get("cost_usd", 0.0),
            "promptSizeChars": prompt_size,
            "outputSizeChars": len(report_content),
            "isError": not fix_applied,
            "errorMessage": None if fix_applied else "Batch fix failed",
            "reportFile": str(report_path),
            "status": "completed" if fix_applied else "failed",
            "batchSize": len(tasks_and_items),
        }
        record.update(token_data)
        append_audit_record(record)

    write_registry(registry)

    # Close feedback loop for completed items
    if fix_applied:
        for task, fb in tasks_and_items:
            fid = (task.get("sourceRef") or {}).get("feedbackId")
            if fid:
                try:
                    fb_list = parse_feedback_files()
                    fb_match = next((i for i in fb_list if i["feedbackId"] == fid), None)
                    if fb_match and not fb_match["implemented"]:
                        _mark_feedback_implemented(fb_match)
                except Exception:
                    pass

    return {"success": True, "task_ids": task_ids, "report_file": str(report_path)}


def _run_feedback_fix_batch_threaded(task_ids: list[str], fb_items: list[dict]):
    """Run batched feedback fix in a daemon thread."""
    batch_key = f"batch-{'-'.join(task_ids[:3])}"

    def _run():
        try:
            _run_feedback_fix_batch(task_ids, fb_items)
        except Exception:
            with _registry_lock:
                registry = read_registry()
                for tid in task_ids:
                    task = registry.get("tasks", {}).get(tid)
                    if task and task.get("status") == "running":
                        task["status"] = "awaiting_retry"
                        task["updatedAt"] = datetime.now(timezone.utc).isoformat()
                write_registry(registry)
        finally:
            _running_jobs.pop(batch_key, None)
            for tid in task_ids:
                _running_jobs.pop(tid, None)

    t = threading.Thread(target=_run, daemon=True)
    # Register all task IDs so dedup prevents re-launching
    for tid in task_ids:
        _running_jobs[tid] = {
            "agent_id": "feedback-fixer-batch",
            "agent_type": "claude-direct",
            "started_at": datetime.now(timezone.utc).isoformat(),
            "thread": t,
        }
    _running_jobs[batch_key] = {
        "agent_id": "feedback-fixer-batch",
        "agent_type": "claude-direct",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "thread": t,
    }
    t.start()


def auto_execute_cycle():
    """Find pending/scheduled agent-assigned tasks and launch them.

    Called every 30s by the lifespan loop. Respects max_parallel_jobs,
    max_squad_runs_per_cycle, and cooldown_minutes settings.

    Status model (9 states):
      pending → scheduled → running → completed / failed / timed_out
      pending → cancelled
      failed → awaiting_retry → scheduled (retry)

    Tasks that ALWAYS run regardless of global auto_execute:
    - Scheduled tasks — authorized, waiting for slot.
    - Queued feedback-fix tasks (source: "feedback", mode: "queued").
    - Evolution-plan tasks (source: "evolution-plan"/"self-assessment").
    """
    global _last_cycle_time, _cycle_squad_count

    settings = get_settings()
    auto_execute_enabled = settings.get("auto_execute", False)
    queue_enabled = settings.get("queue_enabled", True)
    max_parallel = settings.get("max_parallel_jobs", 3)
    max_squads = settings.get("max_squad_runs_per_cycle", 2)

    # Check for timed-out tasks every cycle
    check_task_timeouts()

    # Global queue pause — stops ALL execution including queued feedback-fix
    if not queue_enabled:
        return

    # Daily token budget guard — skip launching if budget exhausted
    # When budget is disabled, run without any budget wall
    if settings.get("daily_token_budget_enabled", False):
        budget = settings.get("daily_token_budget", 5000000)
        used = get_today_token_usage()
        if used >= budget:
            log.info("Daily token budget exhausted (%d/%d) — skipping auto-execute cycle", used, budget)
            return

    # How many slots are available?
    active = len(_running_jobs)
    available = max_parallel - active
    if available <= 0:
        return

    # Find eligible tasks
    with _registry_lock:
        registry = read_registry()

    tasks_list = list(registry.get("tasks", {}).values())
    eligible = []
    for task in tasks_list:
        status = task.get("status")
        routing = task.get("routing") or {}
        routing_mode = routing.get("mode", "")

        # Eligible status gates:
        # - "pending"        → needs auto_execute ON (unless bypass applies)
        # - "scheduled"      → approved/system-generated, waiting for slot
        # - "awaiting_retry" → failed, will auto-retry (transitions to scheduled)
        # NOTE: "running" tasks are NOT re-queued — they're already executing.
        is_scheduled = (status in ("scheduled", "awaiting_retry"))
        if status not in ("pending",) and not is_scheduled:
            continue
        if task.get("assignee") != "agent":
            continue
        ac = task.get("agentConfig") or {}
        if not ac.get("agentId"):
            continue
        # Don't re-launch tasks already running
        if task.get("id") in _running_jobs:
            continue

        is_queued_feedback = (routing.get("type") == "feedback-fix"
                              and routing_mode == "queued"
                              and task.get("source") == "feedback")

        # Evolution-plan tasks (generated by self-assessment/evolve dry runs)
        # always run regardless of auto_execute — they were system-generated
        # and already reviewed (mode=execute means "ready to run").
        # Source is the reliable key here; type varies ("evolution-fix", "bug_fix", "audit", etc.)
        is_evolution_task = (
            routing_mode in ("execute", "queued")
            and task.get("source") in ("evolution-plan", "self-assessment")
        )

        # Scheduled tasks are authorized — always eligible.
        # Queued feedback + evolution tasks bypass auto_execute gate.
        # Regular pending tasks need auto_execute ON.
        if is_scheduled or is_queued_feedback or is_evolution_task or auto_execute_enabled:
            eligible.append(task)

    if not eligible:
        return

    # Sort by priority (critical first)
    priority_order = {"critical": 0, "high": 1, "normal": 2, "low": 3}
    eligible.sort(key=lambda t: priority_order.get(t.get("priority", "normal"), 2))

    # Separate feedback-fix tasks from regular tasks, group feedback by tool
    feedback_by_tool = {}
    regular_tasks = []
    for task in eligible:
        routing = task.get("routing") or {}
        if routing.get("type") == "feedback-fix" and task.get("source") == "feedback":
            if routing.get("mode") not in ("execute", "queued"):
                continue
            tool = (task.get("sourceRef") or {}).get("tool", "Unknown")
            feedback_by_tool.setdefault(tool, []).append(task)
        else:
            regular_tasks.append(task)

    squad_count = 0
    launched = 0

    # Launch batched feedback fixes (one session per tool)
    for tool_name, tool_tasks in feedback_by_tool.items():
        if launched >= available:
            break
        # Build batch items
        batch_items = []
        batch_task_ids = []
        for task in tool_tasks:
            if launched >= available:
                break
            fb_ref = task.get("sourceRef") or {}
            batch_items.append({
                "taskId": task["id"],
                "feedbackId": fb_ref.get("feedbackId", ""),
                "tool": fb_ref.get("tool", ""),
                "severity": fb_ref.get("severity", "LOW"),
                "category": fb_ref.get("category", ""),
                "description": task.get("description", ""),
                "file": fb_ref.get("file", ""),
            })
            batch_task_ids.append(task["id"])
        if len(batch_items) == 1:
            # Single item — use the standard fixer
            _run_feedback_fix_threaded(batch_task_ids[0], batch_items[0])
        else:
            # Multiple items for same tool — batch them
            _run_feedback_fix_batch_threaded(batch_task_ids, batch_items)
        launched += 1  # One slot per tool batch

    # Launch regular (non-feedback) tasks
    for task in regular_tasks:
        if launched >= available:
            break

        ac = task.get("agentConfig", {})
        agent_id = ac["agentId"]
        agent_type = ac.get("agentType", "agent")

        # Validate the agent exists
        validation = validate_agent_config(agent_id, agent_type)
        if not validation.get("valid"):
            continue

        # Squad rate limiting
        if agent_type == "squad":
            if squad_count >= max_squads:
                continue
            squad_count += 1

        run_agent_task_threaded(
            task_id=task["id"],
            agent_id=agent_id,
            agent_type=agent_type,
            instructions=ac.get("instructions", ""),
        )
        launched += 1

    _last_cycle_time = datetime.now(timezone.utc).isoformat()
    _cycle_squad_count = squad_count

    # Health-tier audit: log cycle summary when tasks were launched
    if launched > 0:
        try:
            _shared_log_audit(
                tier="health",
                service="opai-tasks",
                event="auto-execute-cycle",
                status="completed",
                summary=f"Auto-execute cycle: {launched} task(s) launched, {squad_count} squad(s)",
                details={
                    "launched": launched,
                    "squads": squad_count,
                    "feedbackBatches": len(feedback_by_tool),
                    "regularTasks": len(regular_tasks),
                    "eligible": len(eligible),
                    "activeSlots": active,
                    "maxParallel": max_parallel,
                },
            )
        except Exception:
            pass  # Audit write failure should never break the cycle


def cleanup_stale_jobs():
    """Reset tasks stuck as running back to scheduled on startup.
    Also checks for timed-out tasks."""
    with _registry_lock:
        registry = read_registry()
        changed = False
        for task in registry.get("tasks", {}).values():
            if task.get("status") == "running" and task.get("assignee") == "agent":
                task["status"] = "scheduled"
                task["updatedAt"] = datetime.now(timezone.utc).isoformat()
                changed = True
        if changed:
            write_registry(registry)


# Timeout defaults (in seconds)
AGENT_TIMEOUT_SECONDS = 600     # 10 minutes for single agents
SQUAD_TIMEOUT_SECONDS = 1800    # 30 minutes for squads


def check_task_timeouts():
    """Check running tasks for timeout and mark them timed_out.
    Called every auto_execute_cycle (30s)."""
    now_dt = datetime.now(timezone.utc)
    with _registry_lock:
        registry = read_registry()
        changed = False
        for task in registry.get("tasks", {}).values():
            if task.get("status") != "running":
                continue
            updated = task.get("updatedAt")
            if not updated:
                continue
            try:
                started = datetime.fromisoformat(updated)
                if started.tzinfo is None:
                    started = started.replace(tzinfo=timezone.utc)
                elapsed = (now_dt - started).total_seconds()
            except (ValueError, TypeError):
                continue

            ac = task.get("agentConfig") or {}
            timeout = SQUAD_TIMEOUT_SECONDS if ac.get("agentType") == "squad" else AGENT_TIMEOUT_SECONDS

            if elapsed > timeout:
                task["status"] = "timed_out"
                task["updatedAt"] = now_dt.isoformat()
                task.setdefault("agentConfig", {})["response"] = (
                    f"Task timed out after {int(elapsed)}s (limit: {timeout}s)"
                )
                # Remove from running jobs if tracked
                tid = task.get("id")
                if tid and tid in _running_jobs:
                    del _running_jobs[tid]
                changed = True
                log.info("Task %s timed out after %ds", task.get("id"), int(elapsed))
        if changed:
            write_registry(registry)


def get_executor_status() -> dict:
    """Get current executor state for the status indicator."""
    settings = get_settings()
    jobs = {}
    for tid, info in _running_jobs.items():
        jobs[tid] = {
            "agent_id": info["agent_id"],
            "agent_type": info["agent_type"],
            "started_at": info["started_at"],
        }
    return {
        "enabled": settings.get("auto_execute", False),
        "running_count": len(jobs),
        "running_jobs": jobs,
        "last_cycle": _last_cycle_time,
        "max_parallel": settings.get("max_parallel_jobs", 3),
    }


def auto_archive_task(task_id: str) -> dict:
    """Archive a completed task only if it has an agent report."""
    with _registry_lock:
        registry = read_registry()
        task = registry.get("tasks", {}).get(task_id)
        if not task:
            return {"success": False, "error": f"Task {task_id} not found"}
        if task.get("status") != "completed":
            return {"success": False, "error": "Task is not completed"}
        ac = task.get("agentConfig") or {}
        if not ac.get("reportFile") and not ac.get("response"):
            return {"success": False, "error": "No agent report found — manual archive only"}

    return archive_tasks([task_id])


# ── Feedback ──────────────────────────────────────────────

FEEDBACK_DIR = config.OPAI_ROOT / "notes" / "Improvements"


def parse_feedback_files() -> list[dict]:
    """Parse all Feedback-*.md files and return structured items."""
    items = []
    if not FEEDBACK_DIR.is_dir():
        return items

    for fp in sorted(FEEDBACK_DIR.glob("Feedback-*.md")):
        tool_name = fp.stem.replace("Feedback-", "")
        content = fp.read_text(encoding="utf-8", errors="replace")

        for severity in ("HIGH", "MEDIUM", "LOW"):
            import re
            pattern = rf"## {severity}\n([\s\S]*?)(?=\n## |$)"
            match = re.search(pattern, content)
            if not match:
                continue

            section = match.group(1)
            # Parse each line item (desc uses [\s\S]+? to handle multi-line descriptions)
            line_re = re.compile(
                r'^- (?P<struck>~~)?\*\*\[(?P<cat>[^\]]+)\]\*\* (?P<desc>[\s\S]+?) _\((?P<id>[^,]+), (?P<ts>[^)]+)\)_'
                r'(?:~~ \*\*IMPLEMENTED\*\*.*)?$',
                re.MULTILINE,
            )
            for m in line_re.finditer(section):
                implemented = bool(m.group("struck"))
                # Collapse multi-line descriptions to single line
                desc = re.sub(r'\s*\n+\s*', ' ', m.group("desc")).strip()
                items.append({
                    "feedbackId": m.group("id").strip(),
                    "tool": tool_name,
                    "severity": severity,
                    "category": m.group("cat"),
                    "description": desc,
                    "timestamp": m.group("ts").strip(),
                    "implemented": implemented,
                    "file": fp.name,
                })

    return items


def get_feedback_summary(items: list[dict], registry: dict) -> dict:
    """Compute summary stats and cross-reference with tasks."""
    by_severity = {}
    by_tool = {}
    actionable = 0
    implemented_count = 0

    task_by_feedback = {}
    for task in registry.get("tasks", {}).values():
        ref = task.get("sourceRef") or {}
        fid = ref.get("feedbackId")
        if fid:
            task_by_feedback[fid] = task

    for item in items:
        sev = item["severity"]
        by_severity[sev] = by_severity.get(sev, 0) + 1
        tool = item["tool"]
        by_tool[tool] = by_tool.get(tool, 0) + 1

        if item["implemented"]:
            implemented_count += 1
        elif sev in ("HIGH", "MEDIUM"):
            actionable += 1

        linked_task = task_by_feedback.get(item["feedbackId"])
        if linked_task:
            item["taskId"] = linked_task.get("id")
            item["taskStatus"] = linked_task.get("status")
            ac = linked_task.get("agentConfig") or {}
            item["taskAgent"] = ac.get("agentName", ac.get("agentId", ""))
        else:
            item["taskId"] = None
            item["taskStatus"] = None
            item["taskAgent"] = None

    return {
        "total": len(items),
        "actionable": actionable,
        "implemented": implemented_count,
        "by_severity": by_severity,
        "by_tool": by_tool,
    }


def feedback_action(feedback_id: str, action: str, agent_id: str | None = None,
                     agent_type: str = "agent", extra_data: dict | None = None) -> dict:
    """Execute an action on a feedback item.

    Actions: run, queue, add-context, create-task, mark-done, dismiss
    """
    items = parse_feedback_files()
    item = next((i for i in items if i["feedbackId"] == feedback_id), None)
    if not item:
        return {"success": False, "error": f"Feedback {feedback_id} not found"}

    if action == "run":
        # Create task + launch feedback fixer agent directly
        registry = read_registry()
        # Check if task already exists for this feedback
        for task in registry.get("tasks", {}).values():
            ref = task.get("sourceRef") or {}
            if ref.get("feedbackId") == feedback_id:
                existing_id = task["id"]
                if task.get("status") in ("pending", "scheduled"):
                    _run_feedback_fix_threaded(existing_id, item)
                    return {"success": True, "task_id": existing_id, "launched": True}
                return {"success": True, "task_id": existing_id, "launched": False,
                        "message": f"Task {existing_id} already exists (status: {task.get('status')})"}

        task_id = generate_task_id(registry)
        now = datetime.now(timezone.utc).isoformat()
        priority_map = {"HIGH": "critical", "MEDIUM": "high", "LOW": "normal"}

        task = {
            "id": task_id,
            "title": f"[{item['tool']}] {item['description'][:120]}",
            "description": item["description"],
            "source": "feedback",
            "sourceRef": {
                "feedbackId": feedback_id,
                "tool": item["tool"],
                "severity": item["severity"],
                "category": item["category"],
                "file": item["file"],
            },
            "project": None,
            "client": None,
            "assignee": "agent",
            "status": "scheduled",
            "priority": priority_map.get(item["severity"], "normal"),
            "deadline": None,
            "routing": {"type": "feedback-fix", "squads": [], "mode": "execute"},
            "queueId": None,
            "createdAt": now,
            "updatedAt": None,
            "completedAt": None,
            "agentConfig": {
                "agentId": "feedback-fixer",
                "agentType": "claude-direct",
                "agentName": "Feedback Fixer",
                "instructions": "",
            },
            "attachments": [],
        }

        registry["tasks"][task_id] = task
        write_registry(registry)

        _run_feedback_fix_threaded(task_id, item)
        return {"success": True, "task_id": task_id, "launched": True}

    elif action == "queue":
        # Create task WITHOUT launching — sits in registry for orchestrator
        # or manual "Run" later. Same dedup logic as "run".
        registry = read_registry()
        for task in registry.get("tasks", {}).values():
            ref = task.get("sourceRef") or {}
            if ref.get("feedbackId") == feedback_id:
                return {"success": True, "task_id": task["id"], "queued": True,
                        "message": f"Task {task['id']} already exists (status: {task.get('status')})"}

        task_id = generate_task_id(registry)
        now = datetime.now(timezone.utc).isoformat()
        priority_map = {"HIGH": "critical", "MEDIUM": "high", "LOW": "normal"}

        task = {
            "id": task_id,
            "title": f"[{item['tool']}] {item['description'][:120]}",
            "description": item["description"],
            "source": "feedback",
            "sourceRef": {
                "feedbackId": feedback_id,
                "tool": item["tool"],
                "severity": item["severity"],
                "category": item["category"],
                "file": item["file"],
            },
            "project": None,
            "client": None,
            "assignee": "agent",
            "status": "pending",
            "priority": priority_map.get(item["severity"], "normal"),
            "deadline": None,
            "routing": {"type": "feedback-fix", "squads": [], "mode": "queued"},
            "queueId": None,
            "createdAt": now,
            "updatedAt": None,
            "completedAt": None,
            "agentConfig": {
                "agentId": "feedback-fixer",
                "agentType": "agent",
                "agentName": "Feedback Fixer",
                "instructions": "",
            },
            "attachments": [],
        }

        registry["tasks"][task_id] = task
        write_registry(registry)
        return {"success": True, "task_id": task_id, "queued": True}

    elif action == "add-context":
        context = (extra_data or {}).get("context", "").strip()
        if not context:
            return {"success": False, "error": "No context provided"}
        return _append_feedback_context(item, context)

    elif action == "create-task":
        registry = read_registry()
        # Check if task already exists
        for task in registry.get("tasks", {}).values():
            ref = task.get("sourceRef") or {}
            if ref.get("feedbackId") == feedback_id:
                return {"success": False, "error": f"Task already exists: {task['id']}"}

        task_id = generate_task_id(registry)
        now = datetime.now(timezone.utc).isoformat()
        priority_map = {"HIGH": "critical", "MEDIUM": "high", "LOW": "normal"}

        task = {
            "id": task_id,
            "title": f"[{item['tool']}] {item['description'][:120]}",
            "description": item["description"],
            "source": "feedback",
            "sourceRef": {
                "feedbackId": feedback_id,
                "tool": item["tool"],
                "severity": item["severity"],
                "category": item["category"],
                "file": item["file"],
            },
            "project": None,
            "client": None,
            "assignee": "agent" if agent_id else None,
            "status": "pending",
            "priority": priority_map.get(item["severity"], "normal"),
            "deadline": None,
            "routing": {"type": "feedback", "squads": [], "mode": "propose"},
            "queueId": None,
            "createdAt": now,
            "updatedAt": None,
            "completedAt": None,
            "agentConfig": None,
            "attachments": [],
        }

        if agent_id:
            validation = validate_agent_config(agent_id, "agent")
            if validation.get("valid"):
                task["agentConfig"] = {
                    "agentId": agent_id,
                    "agentType": "agent",
                    "agentName": validation.get("name", agent_id),
                    "instructions": "",
                }

        registry["tasks"][task_id] = task
        write_registry(registry)
        return {"success": True, "task_id": task_id, "task": task}

    elif action == "mark-done":
        return _mark_feedback_implemented(item)

    elif action == "dismiss":
        return _remove_feedback_line(item)

    elif action == "change-severity":
        new_severity = (extra_data or {}).get("severity", "").upper()
        if new_severity not in ("HIGH", "MEDIUM", "LOW"):
            return {"success": False, "error": f"Invalid severity: {new_severity}"}
        return _change_feedback_severity(item, new_severity)

    elif action == "re-evaluate":
        return _re_evaluate_feedback(item)

    else:
        return {"success": False, "error": f"Unknown action: {action}"}


def _mark_feedback_implemented(item: dict) -> dict:
    """Add strikethrough + IMPLEMENTED marker to a feedback line."""
    fp = FEEDBACK_DIR / item["file"]
    if not fp.is_file():
        return {"success": False, "error": "File not found"}

    content = fp.read_text(encoding="utf-8")
    fid = item["feedbackId"]
    today = datetime.now().strftime("%Y-%m-%d")

    # Find the line containing this feedback ID
    lines = content.split("\n")
    for i, line in enumerate(lines):
        if fid in line and line.strip().startswith("- **["):
            # Wrap in strikethrough
            stripped = line.lstrip("- ")
            lines[i] = f"- ~~{stripped}~~ **IMPLEMENTED** _({today})_"
            break
    else:
        return {"success": False, "error": "Feedback line not found in file"}

    fp.write_text("\n".join(lines), encoding="utf-8")
    return {"success": True, "feedbackId": fid, "action": "mark-done"}


def _append_feedback_context(item: dict, context: str) -> dict:
    """Append human context to a feedback line in its source file."""
    fp = FEEDBACK_DIR / item["file"]
    if not fp.is_file():
        return {"success": False, "error": "File not found"}

    content = fp.read_text(encoding="utf-8")
    fid = item["feedbackId"]

    lines = content.split("\n")
    for i, line in enumerate(lines):
        if fid in line and line.strip().startswith("- **["):
            # Insert context before the timestamp portion
            ts_marker = f"_({fid},"
            if ts_marker in line:
                lines[i] = line.replace(ts_marker, f"**[Context: {context}]** _({fid},")
            break
    else:
        return {"success": False, "error": "Feedback line not found in file"}

    fp.write_text("\n".join(lines), encoding="utf-8")
    return {"success": True, "feedbackId": fid, "action": "add-context"}


def _remove_feedback_line(item: dict) -> dict:
    """Remove a feedback line from its file."""
    fp = FEEDBACK_DIR / item["file"]
    if not fp.is_file():
        return {"success": False, "error": "File not found"}

    content = fp.read_text(encoding="utf-8")
    fid = item["feedbackId"]

    lines = content.split("\n")
    new_lines = [line for line in lines if fid not in line]

    if len(new_lines) == len(lines):
        return {"success": False, "error": "Feedback line not found in file"}

    fp.write_text("\n".join(new_lines), encoding="utf-8")
    return {"success": True, "feedbackId": fid, "action": "dismiss"}


def _change_feedback_severity(item: dict, new_severity: str) -> dict:
    """Move a feedback line from its current severity section to a new one."""
    fp = FEEDBACK_DIR / item["file"]
    if not fp.is_file():
        return {"success": False, "error": "File not found"}

    content = fp.read_text(encoding="utf-8")
    fid = item["feedbackId"]
    old_severity = item["severity"]

    if old_severity == new_severity:
        return {"success": True, "feedbackId": fid, "action": "change-severity",
                "severity": new_severity, "message": "Already at this severity"}

    # Find and remove the line from its current section
    lines = content.split("\n")
    target_line = None
    for i, line in enumerate(lines):
        if fid in line:
            target_line = lines.pop(i)
            break

    if not target_line:
        return {"success": False, "error": "Feedback line not found in file"}

    # Find the new severity section and insert after the header
    content = "\n".join(lines)
    section_header = f"## {new_severity}"
    section_idx = content.find(section_header)
    if section_idx == -1:
        # Section doesn't exist — append it
        content += f"\n{section_header}\n{target_line}\n"
    else:
        insert_pos = section_idx + len(section_header)
        content = content[:insert_pos] + "\n" + target_line + content[insert_pos:]

    fp.write_text(content, encoding="utf-8")
    return {"success": True, "feedbackId": fid, "action": "change-severity",
            "severity": new_severity}


def _re_evaluate_feedback(item: dict) -> dict:
    """Re-evaluate a feedback item against the current state of the app.

    Checks if the requested feature/fix is still missing by examining the
    tool's source code and wiki docs. Returns a status tag and reasoning.
    """
    import re as _re
    import logging

    log = logging.getLogger(__name__)
    tool_name = item.get("tool", "")
    description = item.get("description", "")
    category = item.get("category", "")

    # Gather context: wiki doc + source file listing
    wiki_context = ""
    wiki_file = _TOOL_WIKI_MAP.get(tool_name)
    if wiki_file:
        wp = config.OPAI_ROOT / "Library" / "opai-wiki" / wiki_file
        if wp.is_file():
            wiki_context = wp.read_text(encoding="utf-8", errors="replace")[:3000]

    source_context = ""
    tool_dir = _resolve_tool_dir(tool_name)
    if tool_dir and tool_dir.is_dir():
        source_files = []
        for ext in ("*.py", "*.js", "*.html"):
            source_files.extend(str(f.relative_to(tool_dir)) for f in tool_dir.rglob(ext)
                               if "node_modules" not in str(f) and "venv" not in str(f))
        source_context = "Source files: " + ", ".join(sorted(source_files)[:30])

    prompt = (
        'You are evaluating whether a user\'s feedback request has been addressed.\n\n'
        f'Feedback: "{description}"\n'
        f'Category: {category}\n'
        f'Tool: {tool_name}\n\n'
        'Wiki documentation excerpt:\n'
        f'{wiki_context[:2000] if wiki_context else "(no wiki doc found)"}\n\n'
        f'{source_context}\n\n'
        'Has this feedback been implemented or addressed? Consider:\n'
        '1. Is the feature/fix described in the wiki docs as existing?\n'
        '2. Based on file names and structure, does it look implemented?\n\n'
        'Respond with ONLY a valid JSON object (no markdown, no explanation):\n'
        '{"status": "missing" or "unnecessary" or "implemented" or "partial", '
        '"reason": "1-2 sentence explanation"}\n\n'
        'Use "unnecessary" if the feature already exists or the request does not make sense.\n'
        'Use "missing" if the feature/fix is genuinely needed and not yet present.\n'
        'Use "implemented" if it has been built already.\n'
        'Use "partial" if only partly addressed.'
    )

    # Build clean env without CLAUDECODE
    clean_env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}

    claude_args = ["claude", "-p", "--output-format", "json"]

    def _run_claude(args):
        return subprocess.run(
            args, input=prompt, capture_output=True, text=True,
            timeout=60, env=clean_env,
        )

    try:
        result = _run_claude(claude_args)
    except FileNotFoundError:
        # Fallback to absolute nvm path (systemd doesn't have nvm in PATH)
        claude_path = Path.home() / ".nvm" / "versions" / "node" / "v20.19.5" / "bin" / "claude"
        if not claude_path.is_file():
            log.error("claude CLI not found at %s", claude_path)
            return {
                "success": True, "feedbackId": item["feedbackId"],
                "action": "re-evaluate",
                "evaluation": {"status": "missing", "reason": "Claude CLI not found — cannot evaluate"},
            }
        try:
            result = _run_claude([str(claude_path), "-p", "--output-format", "json"])
        except Exception as exc:
            log.error("Claude re-evaluate fallback failed: %s", exc)
            return {
                "success": True, "feedbackId": item["feedbackId"],
                "action": "re-evaluate",
                "evaluation": {"status": "missing", "reason": f"Evaluation error: {exc}"},
            }
    except subprocess.TimeoutExpired:
        log.warning("Re-evaluate timed out for %s", item["feedbackId"])
        return {
            "success": True, "feedbackId": item["feedbackId"],
            "action": "re-evaluate",
            "evaluation": {"status": "missing", "reason": "Evaluation timed out — try again"},
        }
    except Exception as exc:
        log.error("Re-evaluate subprocess error: %s", exc)
        return {
            "success": True, "feedbackId": item["feedbackId"],
            "action": "re-evaluate",
            "evaluation": {"status": "missing", "reason": f"Evaluation error: {exc}"},
        }

    raw = result.stdout.strip()
    stderr = result.stderr.strip()
    if result.returncode != 0:
        log.error("Claude re-evaluate failed (rc=%d): stderr=%s", result.returncode, stderr[:500])
        return {
            "success": True, "feedbackId": item["feedbackId"],
            "action": "re-evaluate",
            "evaluation": {"status": "missing", "reason": f"Claude exited with error (rc={result.returncode})"},
        }

    # Parse claude JSON wrapper → extract inner result text
    try:
        wrapper = json.loads(raw)
        raw = wrapper.get("result", raw)
    except (json.JSONDecodeError, TypeError):
        pass

    # Extract JSON object from response (handles nested quotes in reason)
    json_match = _re.search(r'\{[^{}]*"status"\s*:\s*"[^"]+"\s*,\s*"reason"\s*:\s*"[^"]*"[^{}]*\}', raw)
    if json_match:
        try:
            evaluation = json.loads(json_match.group())
            return {
                "success": True,
                "feedbackId": item["feedbackId"],
                "action": "re-evaluate",
                "evaluation": {
                    "status": evaluation.get("status", "missing"),
                    "reason": evaluation.get("reason", "Unable to determine"),
                },
            }
        except json.JSONDecodeError:
            pass

    log.warning("Re-evaluate: could not parse JSON from response: %s", raw[:300])
    return {
        "success": True, "feedbackId": item["feedbackId"],
        "action": "re-evaluate",
        "evaluation": {"status": "missing", "reason": "Could not parse evaluation response"},
    }


def get_queue() -> dict:
    """Read the deferred operations queue."""
    try:
        if config.QUEUE_JSON.is_file():
            return json.loads(config.QUEUE_JSON.read_text())
    except (json.JSONDecodeError, OSError):
        pass
    return {"items": []}


# ── Settings ──────────────────────────────────────────────

def _get_agent_from_team(agent_id: str) -> dict:
    """Read an agent's config from team.json."""
    try:
        team_json = config.OPAI_ROOT / "team.json"
        if team_json.is_file():
            team = json.loads(team_json.read_text())
            return team.get("roles", {}).get(agent_id, {})
    except (json.JSONDecodeError, OSError):
        pass
    return {}


def get_settings() -> dict:
    """Read task processor settings.

    For feedback_fixer_model and feedback_fixer_max_turns, the source of truth
    is team.json (the agent's own config). This keeps Agent Studio and
    execution settings in sync. Falls back to orchestrator.json.
    """
    try:
        if config.ORCHESTRATOR_JSON.is_file():
            data = json.loads(config.ORCHESTRATOR_JSON.read_text())
        else:
            data = {}
    except (json.JSONDecodeError, OSError):
        data = {}
    tp = data.get("task_processor", {})

    # Read feedback fixer agent config from team.json (single source of truth)
    ff_agent = _get_agent_from_team("feedback_fixer")
    ff_model = ff_agent.get("model") or tp.get("feedback_fixer_model", "sonnet")
    ff_turns = ff_agent.get("max_turns") or tp.get("feedback_fixer_max_turns", 10)

    return {
        "auto_execute": tp.get("auto_execute", False),
        "queue_enabled": tp.get("queue_enabled", True),
        "max_squad_runs_per_cycle": tp.get("max_squad_runs_per_cycle", 2),
        "cooldown_minutes": tp.get("cooldown_minutes", 30),
        "max_parallel_jobs": tp.get("max_parallel_jobs", 3),
        "feedback_autofix_threshold": tp.get("feedback_autofix_threshold", "HIGH"),
        "feedback_poll_interval": tp.get("feedback_poll_interval", 10),
        "feedback_poll_on_demand": tp.get("feedback_poll_on_demand", False),
        "feedback_fixer_model": ff_model,
        "feedback_fixer_max_turns": ff_turns,
        "daily_token_budget_enabled": tp.get("daily_token_budget_enabled", False),
        "daily_token_budget": tp.get("daily_token_budget", 5000000),
        "trusted_senders": tp.get("trusted_senders", list(_DEFAULT_TRUSTED_SENDERS)),
    }


def update_settings(settings: dict) -> dict:
    """Update task processor settings in orchestrator config."""
    try:
        if config.ORCHESTRATOR_JSON.is_file():
            data = json.loads(config.ORCHESTRATOR_JSON.read_text())
        else:
            data = {}
    except (json.JSONDecodeError, OSError):
        data = {}

    tp = data.setdefault("task_processor", {})
    for key in ("auto_execute", "queue_enabled", "max_squad_runs_per_cycle",
                 "cooldown_minutes", "max_parallel_jobs", "feedback_autofix_threshold",
                 "feedback_poll_interval", "feedback_poll_on_demand",
                 "feedback_fixer_model", "feedback_fixer_max_turns",
                 "daily_token_budget_enabled", "daily_token_budget", "trusted_senders"):
        if key in settings:
            tp[key] = settings[key]

    config.ORCHESTRATOR_JSON.write_text(json.dumps(data, indent=2))

    # Sync feedback fixer model/turns to team.json so Agent Studio stays in sync
    if "feedback_fixer_model" in settings or "feedback_fixer_max_turns" in settings:
        try:
            team_json = config.OPAI_ROOT / "team.json"
            if team_json.is_file():
                team = json.loads(team_json.read_text())
                ff = team.get("roles", {}).get("feedback_fixer", {})
                if "feedback_fixer_model" in settings:
                    ff["model"] = settings["feedback_fixer_model"]
                if "feedback_fixer_max_turns" in settings:
                    ff["max_turns"] = settings["feedback_fixer_max_turns"]
                team_json.write_text(json.dumps(team, indent=2))
        except Exception:
            pass  # non-critical — orchestrator.json is the fallback

    return {"success": True, "settings": tp}


# ── Evolve (Self-Assessment + Evolution Loop) ─────────────

import re as _re
import subprocess
import threading

# Track in-memory dry-run status per type ("self_assessment" or "evolution")
_evolve_dry_run_status: dict = {
    "self_assessment": "idle",   # idle | running | done | failed
    "evolution": "idle",
}


def _evolve_freq_to_cron(freq_type: str, freq_value: int, time_hour: int, time_minute: int) -> str:
    """Convert UI schedule settings to a cron expression."""
    if freq_type == "minutes":
        return f"*/{max(1, freq_value)} * * * *"
    elif freq_type == "hours":
        return f"0 */{max(1, freq_value)} * * *"
    elif freq_type == "weekly":
        return f"{time_minute} {time_hour} * * 1"
    else:  # daily
        return f"{time_minute} {time_hour} * * *"


def _cron_to_evolve_freq(cron: str) -> dict:
    """Parse a cron expression back to UI settings dict."""
    parts = cron.strip().split()
    if len(parts) != 5:
        return {"frequency_type": "daily", "frequency_value": 1, "time_hour": 2, "time_minute": 0}
    m, h, _d, _mo, wd = parts
    if m.startswith("*/"):
        return {"frequency_type": "minutes", "frequency_value": int(m[2:]), "time_hour": 0, "time_minute": 0}
    if h.startswith("*/"):
        return {"frequency_type": "hours", "frequency_value": int(h[2:]), "time_hour": 0, "time_minute": 0}
    if wd != "*":
        return {"frequency_type": "weekly", "frequency_value": 1, "time_hour": int(h), "time_minute": int(m)}
    return {"frequency_type": "daily", "frequency_value": 1, "time_hour": int(h), "time_minute": int(m)}


def get_evolve_settings() -> dict:
    """Return evolve schedule settings from orchestrator.json."""
    try:
        data = json.loads(config.ORCHESTRATOR_JSON.read_text()) if config.ORCHESTRATOR_JSON.is_file() else {}
    except Exception:
        data = {}
    ev = data.get("evolve", {})
    schedules = data.get("schedules", {})

    # Parse self_assessment schedule
    sa_block = ev.get("self_assessment", {})
    if not sa_block:
        sa_block = _cron_to_evolve_freq(schedules.get("self_assessment", "0 2 * * *"))
    evo_block = ev.get("evolution", {})
    if not evo_block:
        evo_block = _cron_to_evolve_freq(schedules.get("evolution", "0 3 * * *"))

    return {
        "enabled": ev.get("enabled", True),
        "self_assessment": {
            "frequency_type": sa_block.get("frequency_type", "daily"),
            "frequency_value": sa_block.get("frequency_value", 1),
            "time_hour": sa_block.get("time_hour", 2),
            "time_minute": sa_block.get("time_minute", 0),
        },
        "evolution": {
            "frequency_type": evo_block.get("frequency_type", "daily"),
            "frequency_value": evo_block.get("frequency_value", 1),
            "time_hour": evo_block.get("time_hour", 3),
            "time_minute": evo_block.get("time_minute", 0),
        },
        "dry_run_status": dict(_evolve_dry_run_status),
    }


def update_evolve_settings(settings: dict) -> dict:
    """Write evolve settings to orchestrator.json and recalculate cron expressions."""
    try:
        data = json.loads(config.ORCHESTRATOR_JSON.read_text()) if config.ORCHESTRATOR_JSON.is_file() else {}
    except Exception:
        data = {}

    ev = data.setdefault("evolve", {})
    schedules = data.setdefault("schedules", {})

    if "enabled" in settings:
        ev["enabled"] = bool(settings["enabled"])

    for key in ("self_assessment", "evolution"):
        if key in settings:
            block = settings[key]
            ev[key] = {
                "frequency_type": block.get("frequency_type", "daily"),
                "frequency_value": int(block.get("frequency_value", 1)),
                "time_hour": int(block.get("time_hour", 2 if key == "self_assessment" else 3)),
                "time_minute": int(block.get("time_minute", 0)),
            }
            # Update the live cron schedule
            schedules[key] = _evolve_freq_to_cron(
                ev[key]["frequency_type"], ev[key]["frequency_value"],
                ev[key]["time_hour"], ev[key]["time_minute"],
            )

    config.ORCHESTRATOR_JSON.write_text(json.dumps(data, indent=2))
    return {"success": True, "evolve": ev, "schedules": {k: schedules.get(k) for k in ("self_assessment", "evolution")}}


def trigger_evolve_dry_run(run_type: str) -> dict:
    """Fire-and-forget dry run. run_type = 'self_assessment' | 'evolution'."""
    global _evolve_dry_run_status
    if run_type not in ("self_assessment", "evolution"):
        return {"success": False, "error": "Invalid type"}
    if _evolve_dry_run_status.get(run_type) == "running":
        return {"success": False, "error": "Already running"}

    _evolve_dry_run_status[run_type] = "running"

    def _run():
        global _evolve_dry_run_status
        try:
            if run_type == "self_assessment":
                script = str(config.SCRIPTS_DIR / "run_squad.sh")
                args = [script, "-s", "evolve", "--skip-preflight", "--force"]
            else:
                script = str(config.SCRIPTS_DIR / "run_auto.sh")
                args = [script, "--mode", "safe", "--dry-run", "--yes", "--skip-preflight"]

            import os as _os
            nvm_bin = str(Path.home() / ".nvm" / "versions" / "node" / "v20.19.5" / "bin")
            env = {**_os.environ, "CLAUDECODE": ""}
            env["PATH"] = nvm_bin + ":" + env.get("PATH", "")
            result = subprocess.run(args, cwd=str(config.OPAI_ROOT), capture_output=True, text=True,
                                    timeout=20 * 60, env=env)
            _evolve_dry_run_status[run_type] = "done" if result.returncode == 0 else "failed"
        except Exception as e:
            _evolve_dry_run_status[run_type] = "failed"

    threading.Thread(target=_run, daemon=True).start()
    return {"success": True, "status": "running", "type": run_type}


def _parse_evolve_plan_steps(content: str) -> list:
    """Parse ```fix blocks from an evolve plan into structured step dicts."""
    steps = []
    pattern = _re.compile(r"```fix\n(.*?)```", _re.DOTALL)
    for i, match in enumerate(pattern.finditer(content)):
        block = match.group(1)
        step = {"index": i, "raw": block.strip(), "action": "", "file": "", "reason": "", "before": "", "after": ""}
        for line in block.splitlines():
            line = line.strip()
            if line.startswith("FILE:"):
                step["file"] = line[5:].strip()
            elif line.startswith("ACTION:"):
                step["action"] = line[7:].strip()
            elif line.startswith("REASON:"):
                step["reason"] = line[7:].strip()
            elif line.startswith("LINE:"):
                step["line"] = line[5:].strip()
            elif line.startswith("COMMAND:"):
                step["command"] = line[8:].strip()
            elif line.startswith("BEFORE:"):
                step["before"] = line[7:].strip()
            elif line.startswith("AFTER:"):
                step["after"] = line[6:].strip()

        # Build a clean title
        if step["action"] == "run_command":
            step["title"] = f"Run: {step.get('command', 'command')[:60]}"
        elif step["file"]:
            step["title"] = f"[{step['action']}] {step['file']}"
        else:
            step["title"] = f"Step {i + 1}: {step['action'] or 'fix'}"

        step["priority"] = "normal"
        steps.append(step)
    return steps


def get_evolve_reports() -> dict:
    """Return metadata and parsed steps for the latest evolve reports."""
    latest = config.OPAI_REPORTS_LATEST

    def _report_info(filename: str, parse_steps: bool = False) -> dict:
        path = latest / filename
        if not path.is_file():
            return {"exists": False, "path": str(path)}
        stat = path.stat()
        info = {
            "exists": True,
            "path": str(path),
            "size": stat.st_size,
            "modified": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        }
        if parse_steps:
            try:
                content = path.read_text(errors="replace")
                info["steps"] = _parse_evolve_plan_steps(content)
                info["step_count"] = len(info["steps"])
            except Exception:
                info["steps"] = []
                info["step_count"] = 0
        return info

    return {
        "self_assessment": _report_info("self_assessment.md"),
        "evolve_plan": _report_info("evolve_safe_plan.md", parse_steps=True),
        "dry_run_status": dict(_evolve_dry_run_status),
    }


def create_tasks_from_plan_steps(steps: list) -> dict:
    """Create system tasks in the registry from selected evolve plan steps."""
    registry = read_registry()
    now = datetime.now(timezone.utc).isoformat()
    date_str = datetime.now().strftime("%Y%m%d")
    created = []

    for step in steps:
        # Generate unique task ID
        existing = [k for k in registry["tasks"] if k.startswith(f"t-{date_str}-")]
        n = len(existing) + 1
        while f"t-{date_str}-{n:03d}" in registry["tasks"]:
            n += 1
        task_id = f"t-{date_str}-{n:03d}"

        title = step.get("title", f"Evolve fix: {step.get('file', 'unknown')}")

        # Build rich description + instructions for the builder agent
        instructions_parts = [
            f"Apply the following evolution plan fix:\n",
            f"**Action:** {step.get('action', 'N/A')}",
            f"**File:** {step.get('file', 'N/A')}",
            f"**Reason:** {step.get('reason', 'N/A')}",
        ]
        if step.get("before"):
            instructions_parts.append(f"\n**Before:**\n```\n{step['before']}\n```")
        if step.get("after"):
            instructions_parts.append(f"\n**After:**\n```\n{step['after']}\n```")
        if step.get("command"):
            instructions_parts.append(f"\n**Command to run:** `{step['command']}`")
        if step.get("raw"):
            instructions_parts.append(f"\n**Full spec:**\n```fix\n{step['raw']}\n```")
        instructions = "\n".join(instructions_parts)

        description = (
            f"**Source:** Evolution Plan (evolve_safe_plan.md)\n\n"
            f"**File:** {step.get('file', 'N/A')}\n"
            f"**Action:** {step.get('action', 'N/A')}\n"
            f"**Reason:** {step.get('reason', 'N/A')}\n\n"
            f"```fix\n{step.get('raw', '')}\n```"
        )

        task = {
            "id": task_id,
            "title": title,
            "description": description,
            "source": "evolution-plan",
            "sourceRef": {"planFile": str(config.OPAI_REPORTS_LATEST / "evolve_safe_plan.md"), "stepIndex": step.get("index", 0)},
            "project": None,
            "client": None,
            "assignee": "agent",
            "status": "scheduled",
            "priority": step.get("priority", "normal"),
            "deadline": None,
            "routing": {"type": "evolution-fix", "squads": ["build"], "mode": "execute"},
            "queueId": None,
            "createdAt": now,
            "updatedAt": None,
            "completedAt": None,
            "agentConfig": {
                "agentId": "build",
                "agentType": "squad",
                "agentName": "Build Squad",
                "instructions": instructions,
                "response": None,
                "completedAt": None,
            },
            "attachments": [{
                "name": "evolve_safe_plan.md",
                "path": str(config.OPAI_REPORTS_LATEST / "evolve_safe_plan.md"),
                "addedAt": now,
            }],
        }
        registry["tasks"][task_id] = task
        created.append(task_id)

    if created:
        write_registry(registry)

    return {"success": True, "created": created, "count": len(created)}


# ── Auth ──────────────────────────────────────────────────

def verify_auth(token: str | None) -> bool:
    """Check bearer token if AUTH_TOKEN is set."""
    if not config.AUTH_TOKEN:
        return True
    return token == config.AUTH_TOKEN


# ── Archive ───────────────────────────────────────────────

def read_archive() -> dict:
    """Read the task archive."""
    try:
        if config.ARCHIVE_JSON.is_file():
            return json.loads(config.ARCHIVE_JSON.read_text())
    except (json.JSONDecodeError, OSError):
        pass
    return {"tasks": {}, "archivedCount": 0}


def write_archive(archive: dict):
    """Write the task archive."""
    archive["lastUpdated"] = datetime.now(timezone.utc).isoformat()
    archive["archivedCount"] = len(archive.get("tasks", {}))
    config.ARCHIVE_JSON.parent.mkdir(parents=True, exist_ok=True)
    config.ARCHIVE_JSON.write_text(json.dumps(archive, indent=2))


def archive_tasks(task_ids: list[str]) -> dict:
    """Move tasks from registry to archive."""
    registry = read_registry()
    archive = read_archive()
    archived = []
    now = datetime.now(timezone.utc).isoformat()

    for task_id in task_ids:
        task = registry.get("tasks", {}).get(task_id)
        if not task:
            continue
        task["archivedAt"] = now
        archive.setdefault("tasks", {})[task_id] = task
        del registry["tasks"][task_id]
        archived.append(task_id)

    if archived:
        write_registry(registry)
        write_archive(archive)

    return {"success": True, "archived": archived, "count": len(archived)}


def restore_tasks(task_ids: list[str]) -> dict:
    """Restore tasks from archive back to registry."""
    registry = read_registry()
    archive = read_archive()
    restored = []

    for task_id in task_ids:
        task = archive.get("tasks", {}).get(task_id)
        if not task:
            continue
        task.pop("archivedAt", None)
        registry.setdefault("tasks", {})[task_id] = task
        del archive["tasks"][task_id]
        restored.append(task_id)

    if restored:
        write_registry(registry)
        write_archive(archive)

    return {"success": True, "restored": restored, "count": len(restored)}


def delete_archived_tasks(task_ids: list[str]) -> dict:
    """Permanently delete tasks from archive."""
    archive = read_archive()
    deleted = []

    for task_id in task_ids:
        if task_id in archive.get("tasks", {}):
            del archive["tasks"][task_id]
            deleted.append(task_id)

    if deleted:
        write_archive(archive)

    return {"success": True, "deleted": deleted, "count": len(deleted)}


# ── Plan Files ────────────────────────────────────────────

def _resolve_plan_dir(project: str | None) -> Path:
    """Get the Plans directory for a project, or the global one."""
    if project:
        # Check Projects/ first, then Clients/
        proj_dir = config.PROJECTS_DIR / project
        if proj_dir.is_dir():
            return proj_dir / "Plans"
        client_dir = config.CLIENTS_DIR / project
        if client_dir.is_dir():
            return client_dir / "Plans"
        # Fall back to creating under Projects/
        return proj_dir / "Plans"
    # No project — use global plans dir
    return config.OPAI_ROOT / "Plans"


def save_plan_file(task_id: str, content: str, filename: str | None = None) -> dict:
    """Save a plan file and attach it to the task."""
    registry = read_registry()
    task = registry.get("tasks", {}).get(task_id)
    if not task:
        return {"success": False, "error": f"Task {task_id} not found"}

    plan_dir = _resolve_plan_dir(task.get("project"))
    plan_dir.mkdir(parents=True, exist_ok=True)

    # Generate filename from task title if not provided
    if not filename:
        safe_title = "".join(c if c.isalnum() or c in "-_ " else "" for c in (task.get("title") or "plan"))
        safe_title = safe_title.strip().replace(" ", "-")[:60]
        filename = f"{task_id}-{safe_title}.md"

    plan_path = plan_dir / filename

    # Remove old plan for this task if it exists (replace, not accumulate)
    attachments = task.get("attachments") or []
    old_plans = [a for a in attachments if a.get("type") == "plan"]
    for old in old_plans:
        old_path = Path(old["path"])
        if old_path.is_file():
            old_path.unlink()
        attachments.remove(old)

    # Write new plan
    plan_path.write_text(content, encoding="utf-8")

    # Attach to task
    now = datetime.now(timezone.utc).isoformat()
    attachments.append({
        "name": filename,
        "path": str(plan_path),
        "type": "plan",
        "addedAt": now,
    })
    task["attachments"] = attachments
    task["updatedAt"] = now
    write_registry(registry)

    return {"success": True, "path": str(plan_path), "filename": filename}


# ── File Reader ───────────────────────────────────────────

ALLOWED_ROOTS = [
    config.OPAI_ROOT,
    config.WORKSPACE_ROOT / "reports",
    config.WORKSPACE_ROOT / "logs",
]

BLOCKED_PATTERNS = {".env", "credentials", "secrets", ".git"}


def read_file_safe(path: str) -> dict:
    """Read a file with path safety checks."""
    from pathlib import Path as P

    p = P(path).resolve()

    # Must be under an allowed root
    if not any(str(p).startswith(str(r)) for r in ALLOWED_ROOTS):
        return {"success": False, "error": "Path not in allowed roots", "status": 403}

    # Block sensitive patterns
    for part in p.parts:
        if any(blocked in part.lower() for blocked in BLOCKED_PATTERNS):
            return {"success": False, "error": "Access to this path is restricted", "status": 403}

    if not p.exists():
        return {"success": False, "error": "File not found", "status": 404}

    if not p.is_file():
        return {"success": False, "error": "Path is not a file", "status": 400}

    # Size limit: 1MB
    if p.stat().st_size > 1_048_576:
        return {"success": False, "error": "File too large (max 1MB)", "status": 400}

    try:
        content = p.read_text(encoding="utf-8", errors="replace")
        return {
            "success": True,
            "path": str(p),
            "name": p.name,
            "content": content,
            "size": p.stat().st_size,
        }
    except Exception as e:
        return {"success": False, "error": str(e), "status": 500}


# ── Contacts ──────────────────────────────────────────────

def get_contacts() -> dict:
    """Read contacts from config/contacts.json."""
    try:
        if config.CONTACTS_JSON.is_file():
            return json.loads(config.CONTACTS_JSON.read_text())
    except (json.JSONDecodeError, OSError):
        pass
    return {"contacts": [], "specialAssignees": ["human", "agent"]}


def get_projects() -> dict:
    """Scan Projects/ and Clients/ dirs for folder names."""
    projects = []
    clients = []
    try:
        if config.PROJECTS_DIR.is_dir():
            projects = sorted([d.name for d in config.PROJECTS_DIR.iterdir() if d.is_dir()])
    except OSError:
        pass
    try:
        if config.CLIENTS_DIR.is_dir():
            clients = sorted([d.name for d in config.CLIENTS_DIR.iterdir() if d.is_dir()])
    except OSError:
        pass
    return {"projects": projects, "clients": clients}


def get_email_accounts() -> list[dict]:
    """Read email accounts from email-checker's config.json."""
    try:
        cfg_path = config.EMAIL_CHECKER_DIR / "config.json"
        if cfg_path.is_file():
            data = json.loads(cfg_path.read_text())
            accounts = []
            for acct in data.get("accounts", []):
                accounts.append({
                    "name": acct.get("name", "Unknown"),
                    "env_prefix": acct.get("env_prefix", ""),
                    "email": acct.get("_note", "").split(" — ")[0] if " — " in acct.get("_note", "") else acct.get("name", ""),
                })
            return accounts
    except (json.JSONDecodeError, OSError):
        pass
    return []


# ── Email (Node bridge) ─────────────────────────────────

def send_task_email(task: dict, to: str, subject: str | None = None,
                    body: str | None = None, from_account: str = "") -> dict:
    """Send task details via Node email bridge (email-checker's sender.js)."""
    task_id = task.get("id", "unknown")
    task_title = task.get("title", "No title")

    if not subject:
        subject = f"[OPAI Task {task_id}] {task_title}"

    if not body:
        lines = [
            f"Task: {task_id}",
            f"Title: {task_title}",
            f"Status: {task.get('status', 'unknown')}",
            f"Priority: {task.get('priority', 'normal')}",
            f"Project: {task.get('project') or 'N/A'}",
            f"Client: {task.get('client') or 'N/A'}",
            f"Assignee: {task.get('assignee') or 'Unassigned'}",
            f"Deadline: {task.get('deadline') or 'None'}",
            "",
            "Description:",
            task.get("description", "No description"),
        ]
        if task.get("sourceRef"):
            ref = task["sourceRef"]
            lines.extend([
                "",
                "Source:",
                f"  Account: {ref.get('account', 'N/A')}",
                f"  Sender: {ref.get('senderName', '')} <{ref.get('sender', '')}>",
                f"  Subject: {ref.get('subject', '')}",
            ])
        body = "\n".join(lines)

    payload = json.dumps({
        "to": to,
        "subject": subject,
        "body": body,
        "envPrefix": from_account,
    })

    try:
        result = subprocess.run(
            ["node", str(config.SEND_EMAIL_SCRIPT)],
            input=payload,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            stderr = result.stderr.strip()
            return {"success": False, "error": stderr or "Node bridge failed"}
        return json.loads(result.stdout.strip())
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "Email send timed out"}
    except (json.JSONDecodeError, OSError) as e:
        return {"success": False, "error": str(e)}


# ── Delegation ───────────────────────────────────────────

def delegate_to_person(task_id: str, assignee: str, send_email: bool = False,
                       email_to: str = "", from_account: str = "",
                       message: str = "") -> dict:
    """Delegate a task to a person, optionally sending email notification."""
    registry = read_registry()
    task = registry.get("tasks", {}).get(task_id)
    if not task:
        return {"success": False, "error": f"Task {task_id} not found"}

    now = datetime.now(timezone.utc).isoformat()
    task["assignee"] = assignee
    task["status"] = "scheduled"
    task["updatedAt"] = now
    write_registry(registry)

    result = {"success": True, "task_id": task_id, "assignee": assignee}

    if send_email and email_to:
        subject = f"[OPAI Task {task_id}] Delegated: {task.get('title', 'No title')}"
        body_lines = [
            f"Hi {assignee},",
            "",
            f"A task has been assigned to you.",
            "",
            f"Task: {task_id}",
            f"Title: {task.get('title', 'No title')}",
            f"Priority: {task.get('priority', 'normal')}",
            f"Project: {task.get('project') or 'N/A'}",
            f"Deadline: {task.get('deadline') or 'None'}",
            "",
            "Description:",
            task.get("description", "No description"),
        ]
        if message:
            body_lines.extend(["", "Note from delegator:", message])
        body = "\n".join(body_lines)

        email_result = send_task_email(task, email_to, subject=subject,
                                        body=body, from_account=from_account)
        result["email"] = email_result

    return result
