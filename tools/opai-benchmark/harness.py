"""OPAI Benchmark Harness — Claude CLI invocation with metric capture.

Core engine: invokes Claude CLI exactly as OPAI services do, captures
token counts, cost, timing, tool calls, and round trips from JSON output.
"""

import asyncio
import json
import os
import re
import tempfile
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

OPAI_ROOT = Path("/workspace/synced/opai")
CLAUDE_BIN = "claude"

# Sonnet 4.6 pricing ($/M tokens) — used for cost→token estimation
# Blended rate assumes ~75% input, 25% output (typical conversational ratio)
MODEL_PRICING = {
    "claude-sonnet-4-6": {"input": 3.0, "output": 15.0, "blended": 6.0},
    "claude-haiku-4-5":  {"input": 0.80, "output": 4.0, "blended": 1.6},
    "claude-opus-4-6":   {"input": 15.0, "output": 75.0, "blended": 30.0},
}
DEFAULT_BLENDED_RATE = 6.0  # $/M tokens (sonnet fallback)


def estimate_tokens_from_cost(cost_usd: float, model: Optional[str] = None) -> int:
    """Estimate total tokens from cost using model pricing.

    Returns approximate token count. Useful when CLI doesn't expose raw counts.
    """
    if cost_usd <= 0:
        return 0
    rate = DEFAULT_BLENDED_RATE
    if model:
        for key, pricing in MODEL_PRICING.items():
            if key in model:
                rate = pricing["blended"]
                break
    return int(cost_usd / (rate / 1_000_000))

# Try to resolve claude binary via nvm (same as discord-bridge)
_nvm_path = Path.home() / ".nvm/versions/node"
_nvm_candidates = (
    [str(p / "bin/claude") for p in sorted(_nvm_path.glob("v*"), reverse=True)]
    if _nvm_path.exists() else []
)
for candidate in [
    os.popen("which claude 2>/dev/null").read().strip(),
    *_nvm_candidates,
    "/usr/local/bin/claude",
    "/usr/bin/claude",
]:
    if candidate and Path(candidate).is_file():
        CLAUDE_BIN = candidate
        break


@dataclass
class InvocationMetrics:
    """Metrics captured from a single Claude CLI invocation."""
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    total_tokens: int = 0
    estimated_tokens: int = 0  # derived from cost when raw counts unavailable
    cost_usd: float = 0.0
    wall_time_ms: int = 0
    num_turns: int = 0
    tools_called: list = field(default_factory=list)
    session_id: Optional[str] = None
    model: Optional[str] = None
    response_text: str = ""
    is_error: bool = False
    error_message: str = ""
    raw_json: Optional[dict] = None

    def to_dict(self) -> dict:
        d = asdict(self)
        d.pop("raw_json", None)
        d.pop("response_text", None)
        return d

    @property
    def effective_tokens(self) -> int:
        """Best available token count: real if available, estimated otherwise."""
        return self.total_tokens if self.total_tokens > 0 else self.estimated_tokens


@dataclass
class ScenarioConfig:
    """Configuration for a benchmark invocation."""
    prompt: str
    model: Optional[str] = None
    max_turns: int = 5
    system_prompt: Optional[str] = None
    mcp_config: Optional[dict] = None
    allowed_tools: Optional[list] = None
    timeout: int = 120
    cwd: str = str(OPAI_ROOT)


def _clean_env() -> dict:
    """Build a clean environment (strip CLAUDECODE to prevent nesting blocks)."""
    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
    return env


def _build_args(cfg: ScenarioConfig) -> tuple:
    """Build Claude CLI argument list from scenario config.

    Returns (args, use_stdin) — if prompt is long, pipe via stdin.
    """
    # For short prompts, pass as -p arg; for long ones, use stdin
    use_stdin = len(cfg.prompt) > 4000
    if use_stdin:
        args = [CLAUDE_BIN, "-p", "--output-format", "json"]
    else:
        args = [CLAUDE_BIN, "-p", cfg.prompt, "--output-format", "json"]

    if cfg.model:
        args.extend(["--model", cfg.model])

    if cfg.max_turns:
        args.extend(["--max-turns", str(cfg.max_turns)])

    if cfg.system_prompt:
        args.extend(["--system-prompt", cfg.system_prompt])

    if cfg.allowed_tools:
        args.extend(["--allowedTools", ",".join(cfg.allowed_tools)])

    return args, use_stdin


def _write_temp_mcp_config(mcp_config: dict) -> str:
    """Write MCP config to a temp file, return path."""
    fd, path = tempfile.mkstemp(prefix="opai-bench-mcp-", suffix=".json")
    with os.fdopen(fd, "w") as f:
        json.dump({"mcpServers": mcp_config}, f)
    return path


def _parse_json_response(stdout: str) -> dict:
    """Parse Claude CLI JSON output, handling potential wrapper structures."""
    try:
        data = json.loads(stdout.strip())
        return data
    except json.JSONDecodeError:
        # Try to find JSON in mixed output
        for line in stdout.strip().split("\n"):
            line = line.strip()
            if line.startswith("{"):
                try:
                    return json.loads(line)
                except json.JSONDecodeError:
                    continue
        return {}


def _deep_get(data: dict, *paths) -> any:
    """Try multiple dot-separated paths, return first non-zero/non-None value."""
    for path in paths:
        obj = data
        for key in path.split("."):
            if isinstance(obj, dict):
                obj = obj.get(key)
            else:
                obj = None
                break
        if obj is not None and obj != 0:
            return obj
    return 0


def _extract_metrics(data: dict, wall_time_ms: int) -> InvocationMetrics:
    """Extract metrics from Claude CLI JSON response."""
    metrics = InvocationMetrics(wall_time_ms=wall_time_ms)

    # Response text
    metrics.response_text = data.get("result", "")
    metrics.session_id = data.get("session_id")
    metrics.is_error = data.get("is_error", False)
    metrics.model = data.get("model")
    metrics.raw_json = data

    # Token counts — try multiple paths (CLI format varies across versions)
    metrics.input_tokens = _deep_get(data,
        "input_tokens", "usage.input_tokens", "stats.input_tokens",
        "num_input_tokens")
    metrics.output_tokens = _deep_get(data,
        "output_tokens", "usage.output_tokens", "stats.output_tokens",
        "num_output_tokens")
    metrics.cache_read_tokens = _deep_get(data,
        "cache_read_tokens", "usage.cache_read_input_tokens",
        "cache_read_input_tokens")
    metrics.cache_creation_tokens = _deep_get(data,
        "cache_creation_tokens", "usage.cache_creation_input_tokens",
        "cache_creation_input_tokens")
    metrics.total_tokens = _deep_get(data,
        "total_tokens", "usage.total_tokens", "stats.total_tokens")

    # Cost — try multiple field names
    metrics.cost_usd = (
        data.get("cost_usd")
        or data.get("total_cost_usd")
        or data.get("total_cost")
        or _deep_get(data, "usage.cost_usd", "stats.cost_usd")
        or 0.0
    )

    # Num turns
    metrics.num_turns = data.get("num_turns", 0)

    # Tool calls — parse from conversation messages if available
    tools = []
    messages = data.get("messages", [])
    for msg in messages:
        if isinstance(msg, dict):
            content = msg.get("content", [])
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "tool_use":
                        tools.append({
                            "name": block.get("name", "unknown"),
                            "input": block.get("input", {}),
                        })
    metrics.tools_called = tools

    # Compute total from parts if not directly available
    if not metrics.total_tokens and (metrics.input_tokens or metrics.output_tokens):
        metrics.total_tokens = metrics.input_tokens + metrics.output_tokens

    # Always compute estimated tokens from cost as fallback/comparison
    metrics.estimated_tokens = estimate_tokens_from_cost(metrics.cost_usd, metrics.model)

    return metrics


async def invoke_claude(cfg: ScenarioConfig) -> InvocationMetrics:
    """Invoke Claude CLI and capture metrics.

    This mirrors how OPAI services invoke Claude:
    - Strips CLAUDECODE env var
    - Uses --output-format json for metric capture
    - Sends prompt via stdin
    - Parses response for tokens, cost, tools, and session info
    """
    args, use_stdin = _build_args(cfg)
    env = _clean_env()
    mcp_temp = None

    if cfg.mcp_config:
        mcp_temp = _write_temp_mcp_config(cfg.mcp_config)
        args.extend(["--mcp-config", mcp_temp])

    start = time.monotonic()
    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.PIPE if use_stdin else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            cwd=cfg.cwd,
        )

        try:
            stdin_data = cfg.prompt.encode() if use_stdin else None
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                proc.communicate(input=stdin_data),
                timeout=cfg.timeout,
            )
        except asyncio.TimeoutError:
            proc.kill()
            wall_ms = int((time.monotonic() - start) * 1000)
            return InvocationMetrics(
                wall_time_ms=wall_ms,
                is_error=True,
                error_message=f"Timeout after {cfg.timeout}s",
            )

        wall_ms = int((time.monotonic() - start) * 1000)
        stdout = stdout_bytes.decode("utf-8", errors="replace")
        stderr = stderr_bytes.decode("utf-8", errors="replace")

        if proc.returncode != 0:
            return InvocationMetrics(
                wall_time_ms=wall_ms,
                is_error=True,
                error_message=f"Exit {proc.returncode}: {stderr[:500]}",
                response_text=stdout,
            )

        data = _parse_json_response(stdout)
        metrics = _extract_metrics(data, wall_ms)

        if stderr:
            # Claude CLI sometimes emits useful info to stderr
            metrics.error_message = stderr[:500] if "error" in stderr.lower() else ""

        return metrics

    finally:
        if mcp_temp:
            try:
                os.unlink(mcp_temp)
            except OSError:
                pass


def score_tool_accuracy(expected_tools: list, actual_tools: list) -> float:
    """Score tool selection accuracy (0.0 to 1.0).

    Measures: did Claude call the right tools?
    - 1.0 = all expected tools called, no unexpected tools
    - Partial credit for subset matches
    """
    if not expected_tools:
        return 1.0 if not actual_tools else 0.5

    actual_names = {t["name"] if isinstance(t, dict) else t for t in actual_tools}
    expected_set = set(expected_tools)

    if not expected_set:
        return 1.0

    hits = expected_set & actual_names
    extras = actual_names - expected_set

    # Precision-recall F1
    precision = len(hits) / len(actual_names) if actual_names else (1.0 if not expected_set else 0.0)
    recall = len(hits) / len(expected_set)

    if precision + recall == 0:
        return 0.0
    return 2 * (precision * recall) / (precision + recall)


def score_param_accuracy(expected_params: dict, actual_tools: list, tool_name: str) -> float:
    """Score parameter accuracy for a specific tool call (0.0 to 1.0).

    Checks if expected key-value pairs appear in the tool's input.
    """
    if not expected_params:
        return 1.0

    # Find the tool call
    for t in actual_tools:
        name = t["name"] if isinstance(t, dict) else t
        if name == tool_name:
            actual_input = t.get("input", {}) if isinstance(t, dict) else {}
            hits = sum(1 for k, v in expected_params.items() if actual_input.get(k) == v)
            return hits / len(expected_params) if expected_params else 1.0

    return 0.0  # Tool not found
