"""OPAI Engine — Command Gate (v3.2).

Replaces the hardcoded should_bypass_approval() logic with a configurable,
auditable trust classification system.  Every action request is wrapped in a
CommandIntent that records *who*, *where*, and *what* — then evaluated against
the command_channels config from orchestrator.json.

Trust levels:
    command  — authenticated operator, auto-execute allowed
    proposal — semi-trusted, task enters as pending (requires approval)
    context  — read-only input, cannot create executable tasks
"""

import logging
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone

import config

log = logging.getLogger(__name__)

VALID_TRUST_LEVELS = ("command", "proposal", "context")


@dataclass
class CommandIntent:
    """Metadata about who/what triggered an action."""

    source: str = ""           # telegram, discord, email, portal, scheduler, system, feedback
    trust_level: str = "proposal"  # command, proposal, context
    user_identity: str = ""    # telegram user ID, discord user#guild, email address, JWT sub
    channel_detail: str = ""   # channel ID, guild:channel, mailbox name
    action: str = ""           # task_execute, task_create, worker_control, etc.
    metadata: dict = field(default_factory=dict)


def _load_channel_config() -> dict:
    """Load command_channels config from orchestrator.json (cached per call)."""
    cfg = config.load_orchestrator_config()
    return cfg.get("command_channels", {})


def classify_trust(source: str, metadata: dict | None = None) -> str:
    """Determine trust level from source + metadata.

    Returns one of: 'command', 'proposal', 'context'.
    """
    metadata = metadata or {}
    channels = _load_channel_config()

    # Look up source-specific config
    ch_cfg = channels.get(source)
    if ch_cfg is None:
        # Unknown source -> default
        default = channels.get("default", {})
        return default.get("trust_level", "proposal")

    # ── Role-based trust (telegram, portal) ──
    if "trust_by_role" in ch_cfg:
        role = metadata.get("role", "")
        trust = ch_cfg["trust_by_role"].get(role)
        if trust and trust in VALID_TRUST_LEVELS:
            return trust
        # Role not in map -> fall through to default
        return channels.get("default", {}).get("trust_level", "proposal")

    # ── Channel-role trust (discord) ──
    if "trust_by_channel_role" in ch_cfg:
        channel_role = metadata.get("channel_role", "")

        # Discord: if require_home_guild is set, non-home guilds cap at proposal
        require_home = ch_cfg.get("require_home_guild", False)
        is_home = metadata.get("is_home_guild", False)

        trust = ch_cfg["trust_by_channel_role"].get(channel_role)
        if trust and trust in VALID_TRUST_LEVELS:
            # Enforce home guild requirement: non-home guild can't get command trust
            if require_home and not is_home and trust == "command":
                return "proposal"
            return trust
        # Channel role not in map -> proposal
        return "proposal"

    # ── Flat trust level (email, scheduler, system, feedback) ──
    if "trust_level" in ch_cfg:
        trust = ch_cfg["trust_level"]
        if trust in VALID_TRUST_LEVELS:
            return trust

    # Fallback
    return "proposal"


def evaluate(intent: CommandIntent) -> str:
    """Gate decision based on trust level.

    Returns:
        'allow'   — command trust, auto-execute
        'approve' — proposal trust, requires human approval
        'deny'    — context trust, cannot create executable tasks
    """
    if intent.trust_level == "command":
        return "allow"
    if intent.trust_level == "context":
        return "deny"
    return "approve"


def build_intent(
    source: str,
    user_identity: str = "",
    channel_detail: str = "",
    action: str = "",
    metadata: dict | None = None,
) -> CommandIntent:
    """Factory: classify trust and build intent in one call."""
    metadata = metadata or {}
    trust = classify_trust(source, metadata)

    return CommandIntent(
        source=source,
        trust_level=trust,
        user_identity=user_identity,
        channel_detail=channel_detail,
        action=action,
        metadata=metadata,
    )


def enrich_audit(intent: CommandIntent) -> dict:
    """Format intent for audit logging / task metadata."""
    return {
        "source": intent.source,
        "trust_level": intent.trust_level,
        "user_identity": intent.user_identity,
        "channel_detail": intent.channel_detail,
        "action": intent.action,
        "decision": evaluate(intent),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
