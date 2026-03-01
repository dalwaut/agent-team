"""AI Assistant — generates flow graphs from natural language via Claude CLI."""

import asyncio
import json
import os
from pathlib import Path

from services.agent_manager import list_agents, _read_team, _user_paths
from services.squad_manager import list_squads
import config

CLAUDE_CLI = Path.home() / ".nvm" / "versions" / "node" / "v20.19.5" / "bin" / "claude"


async def build_flow(prompt: str, user=None) -> dict:
    """Generate flow nodes and connections from a natural language description."""
    if not prompt.strip():
        raise ValueError("Prompt cannot be empty")

    # Gather available agents and squads for context
    agents = list_agents(user)
    squads = list_squads(user)

    agent_list = ", ".join(a["id"] for a in agents) if agents else "(none)"
    agent_details = "\n".join(
        f"  - {a['id']}: {a.get('description', a.get('name', a['id']))}"
        for a in agents
    ) if agents else "(none)"
    squad_list = ", ".join(s["id"] for s in squads) if squads else "(none)"
    squad_details = "\n".join(
        f"  - {s['id']}: agents=[{', '.join(a['id'] if isinstance(a, dict) else a for a in s.get('agents', []))}] — {s.get('description', '')}"
        for s in squads
    ) if squads else "(none)"

    system_prompt = f"""You are an AI that generates visual workflow graphs for the OPAI Agent Studio.

Available squads: {squad_list}
Squad details:
{squad_details}

Available agents: {agent_list}
Agent details:
{agent_details}

You must output ONLY valid JSON with this exact structure:
{{
  "nodes": [
    {{ "id": "n1", "type": "trigger", "x": 300, "y": 60, "config": {{ "trigger_type": "manual" }} }},
    {{ "id": "n2", "type": "squad", "x": 300, "y": 180, "config": {{ "squad": "squad_id", "on_fail": "stop" }} }}
  ],
  "connections": [
    {{ "id": "c1", "from": "n1", "fromPort": "out", "to": "n2", "toPort": "in" }}
  ]
}}

Node types:
- "trigger": Entry point. config.trigger_type = "manual" or "schedule". If schedule, include config.cron (e.g. "0 9 * * *"). No "in" port.
- "squad": Runs a squad. config.squad = squad ID, config.on_fail = "stop" or "continue". IMPORTANT: config.custom_prompt is a JSON string mapping agent IDs to their custom prompts for this run context. Generate meaningful, specific prompts for each agent in the squad based on the user's request.
- "agent": Runs a single agent. config.agent = agent ID, config.on_fail = "stop" or "continue". IMPORTANT: config.custom_prompt should contain a specific prompt string tailored to the user's request that overrides/augments the agent's default behavior.
- "following": Fires when another workflow/squad completes. config.follows = name, config.follows_type = "workflow" or "squad", config.trigger_on = "success" or "failure" or "any". No "in" port.

Rules:
- Always start with a trigger or following node
- IDs must be sequential: n1, n2, n3... and c1, c2, c3...
- Layout vertically: y increases by 120 for each row, x=300 for main chain
- Connect nodes top-to-bottom using "out" → "in" ports
- For failure branches, use "fail" → "in" ports
- Only reference squads/agents that exist in the available lists above
- ALWAYS generate custom_prompt values for agent and squad nodes. For squad nodes, custom_prompt must be a JSON string like {{"agent_id": "prompt text", ...}} with entries for each agent in the squad. For agent nodes, custom_prompt is a plain string.
- Output ONLY the JSON object, no markdown fences, no explanation"""

    full_prompt = f"{system_prompt}\n\nUser request: {prompt}"

    # Build subprocess env — strip CLAUDECODE to avoid nested session block
    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
    env["OPAI_ROOT"] = str(config.WORKSPACE_ROOT)

    cli_path = str(CLAUDE_CLI)
    if not Path(cli_path).is_file():
        raise ValueError(f"Claude CLI not found at {cli_path}")

    proc = await asyncio.create_subprocess_exec(
        cli_path, "-p", "--output-format", "json",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
        cwd=str(config.WORKSPACE_ROOT),
    )

    stdout, stderr = await asyncio.wait_for(
        proc.communicate(input=full_prompt.encode("utf-8")),
        timeout=120,
    )

    if proc.returncode != 0:
        err = stderr.decode("utf-8", errors="replace") if stderr else "Unknown error"
        raise ValueError(f"Claude CLI failed: {err[:500]}")

    raw = stdout.decode("utf-8", errors="replace").strip()

    # Claude CLI --output-format json wraps result in {"type":"result","result":"..."}
    try:
        cli_response = json.loads(raw)
        if isinstance(cli_response, dict) and "result" in cli_response:
            raw = cli_response["result"]
    except json.JSONDecodeError:
        pass

    # Extract JSON from response (strip markdown fences if present)
    if "```" in raw:
        start = raw.find("{")
        end = raw.rfind("}") + 1
        if start >= 0 and end > start:
            raw = raw[start:end]

    try:
        flow = json.loads(raw)
    except json.JSONDecodeError:
        raise ValueError(f"AI returned invalid JSON: {raw[:300]}")

    if not isinstance(flow, dict) or "nodes" not in flow or "connections" not in flow:
        raise ValueError("AI response missing 'nodes' or 'connections'")

    # Validate referenced agents/squads exist
    agent_ids = {a["id"] for a in agents}
    squad_ids = {s["id"] for s in squads}

    for node in flow["nodes"]:
        if node.get("type") == "squad" and node.get("config", {}).get("squad"):
            if node["config"]["squad"] not in squad_ids:
                raise ValueError(f"AI referenced unknown squad: {node['config']['squad']}")
        if node.get("type") == "agent" and node.get("config", {}).get("agent"):
            if node["config"]["agent"] not in agent_ids:
                raise ValueError(f"AI referenced unknown agent: {node['config']['agent']}")

    return flow
