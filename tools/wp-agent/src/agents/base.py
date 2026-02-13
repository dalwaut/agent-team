"""
Base Agent class for WordPress operations
All specialized agents inherit from this
"""

from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum

from ..core.client import WordPressClient, APIResponse, get_client


class ActionStatus(Enum):
    """Status of an agent action"""
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    SUCCESS = "success"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class ActionResult:
    """Result of an agent action"""
    action: str
    status: ActionStatus
    data: Any = None
    error: Optional[str] = None
    timestamp: datetime = field(default_factory=datetime.now)
    duration_ms: Optional[float] = None

    def to_dict(self) -> dict:
        return {
            'action': self.action,
            'status': self.status.value,
            'data': self.data,
            'error': self.error,
            'timestamp': self.timestamp.isoformat(),
            'duration_ms': self.duration_ms
        }


@dataclass
class AgentCapability:
    """Describes a capability/action an agent can perform"""
    name: str
    description: str
    parameters: List[Dict[str, Any]] = field(default_factory=list)
    requires_auth: bool = True
    http_method: str = "GET"

    def to_dict(self) -> dict:
        return {
            'name': self.name,
            'description': self.description,
            'parameters': self.parameters,
            'requires_auth': self.requires_auth,
            'http_method': self.http_method
        }


class BaseAgent(ABC):
    """
    Abstract base class for all WordPress agents

    Each agent is responsible for a specific domain (posts, pages, media, etc.)
    and exposes a set of capabilities that can be invoked.
    """

    def __init__(self, client: Optional[WordPressClient] = None):
        """
        Initialize agent with WordPress client

        Args:
            client: WordPressClient instance. If None, uses singleton.
        """
        self.client = client or get_client()
        self._capabilities: Dict[str, AgentCapability] = {}
        self._register_capabilities()

    @property
    @abstractmethod
    def name(self) -> str:
        """Agent name identifier"""
        pass

    @property
    @abstractmethod
    def description(self) -> str:
        """Human-readable agent description"""
        pass

    @abstractmethod
    def _register_capabilities(self):
        """Register all capabilities this agent supports"""
        pass

    def register_capability(self, capability: AgentCapability):
        """Register a single capability"""
        self._capabilities[capability.name] = capability

    def get_capabilities(self) -> List[AgentCapability]:
        """Get list of all capabilities"""
        return list(self._capabilities.values())

    def get_capability(self, name: str) -> Optional[AgentCapability]:
        """Get a specific capability by name"""
        return self._capabilities.get(name)

    def has_capability(self, name: str) -> bool:
        """Check if agent has a specific capability"""
        return name in self._capabilities

    def execute(self, action: str, **kwargs) -> ActionResult:
        """
        Execute an action by name

        Args:
            action: Name of the action/capability to execute
            **kwargs: Parameters for the action

        Returns:
            ActionResult with status and data
        """
        import time
        start_time = time.time()

        if not self.has_capability(action):
            return ActionResult(
                action=action,
                status=ActionStatus.FAILED,
                error=f"Unknown action: {action}. Available: {list(self._capabilities.keys())}"
            )

        # Find and call the method
        method_name = f"action_{action.replace('-', '_')}"
        method = getattr(self, method_name, None)

        if method is None:
            return ActionResult(
                action=action,
                status=ActionStatus.FAILED,
                error=f"Action method not implemented: {method_name}"
            )

        try:
            result = method(**kwargs)
            duration = (time.time() - start_time) * 1000

            if isinstance(result, APIResponse):
                return ActionResult(
                    action=action,
                    status=ActionStatus.SUCCESS if result.success else ActionStatus.FAILED,
                    data=result.data,
                    error=result.error,
                    duration_ms=duration
                )
            elif isinstance(result, ActionResult):
                result.duration_ms = duration
                return result
            else:
                return ActionResult(
                    action=action,
                    status=ActionStatus.SUCCESS,
                    data=result,
                    duration_ms=duration
                )
        except Exception as e:
            duration = (time.time() - start_time) * 1000
            return ActionResult(
                action=action,
                status=ActionStatus.FAILED,
                error=str(e),
                duration_ms=duration
            )

    def to_dict(self) -> dict:
        """Serialize agent info to dictionary"""
        return {
            'name': self.name,
            'description': self.description,
            'capabilities': [cap.to_dict() for cap in self.get_capabilities()]
        }

    def __repr__(self):
        return f"{self.__class__.__name__}(name={self.name}, capabilities={len(self._capabilities)})"
