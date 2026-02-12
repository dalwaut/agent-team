"""
Agent Orchestrator
Central coordinator for all WordPress agents
"""

from typing import Dict, List, Optional, Any, Type
from dataclasses import dataclass
import json

from .core.client import WordPressClient, get_client, reset_client
from .agents.base import BaseAgent, ActionResult, ActionStatus, AgentCapability
from .agents import (
    PostsAgent,
    PagesAgent,
    MediaAgent,
    TaxonomyAgent,
    UsersAgent,
    CommentsAgent,
    SettingsAgent,
    MenusAgent,
    PluginsAgent,
    SearchAgent,
)


@dataclass
class OrchestratorConfig:
    """Configuration for the orchestrator"""
    config_path: Optional[str] = None
    auto_discover: bool = True


class AgentOrchestrator:
    """
    Central orchestrator for WordPress agent operations

    Manages agent lifecycle, routing, and provides unified interface
    for all WordPress operations.
    """

    # Registry of all available agent classes
    AGENT_REGISTRY: Dict[str, Type[BaseAgent]] = {
        "posts": PostsAgent,
        "pages": PagesAgent,
        "media": MediaAgent,
        "taxonomy": TaxonomyAgent,
        "users": UsersAgent,
        "comments": CommentsAgent,
        "settings": SettingsAgent,
        "menus": MenusAgent,
        "plugins": PluginsAgent,
        "search": SearchAgent,
    }

    def __init__(self, config: Optional[OrchestratorConfig] = None):
        """
        Initialize orchestrator

        Args:
            config: Optional configuration
        """
        self.config = config or OrchestratorConfig()
        self._client: Optional[WordPressClient] = None
        self._agents: Dict[str, BaseAgent] = {}
        self._initialized = False

    def initialize(self, config_path: Optional[str] = None) -> bool:
        """
        Initialize the orchestrator with WordPress connection

        Args:
            config_path: Path to config.yaml

        Returns:
            True if initialization successful
        """
        try:
            reset_client()  # Reset singleton
            self._client = get_client(config_path or self.config.config_path)

            # Initialize all agents
            for name, agent_class in self.AGENT_REGISTRY.items():
                self._agents[name] = agent_class(self._client)

            self._initialized = True
            return True

        except Exception as e:
            print(f"Initialization failed: {e}")
            return False

    @property
    def client(self) -> WordPressClient:
        """Get the WordPress client"""
        if not self._client:
            raise RuntimeError("Orchestrator not initialized. Call initialize() first.")
        return self._client

    def get_agent(self, name: str) -> Optional[BaseAgent]:
        """Get an agent by name"""
        return self._agents.get(name)

    def list_agents(self) -> List[Dict[str, Any]]:
        """List all available agents"""
        return [
            {
                "name": agent.name,
                "description": agent.description,
                "capabilities_count": len(agent.get_capabilities())
            }
            for agent in self._agents.values()
        ]

    def list_all_capabilities(self) -> List[Dict[str, Any]]:
        """List all capabilities across all agents"""
        capabilities = []
        for agent in self._agents.values():
            for cap in agent.get_capabilities():
                capabilities.append({
                    "agent": agent.name,
                    "action": cap.name,
                    "description": cap.description,
                    "method": cap.http_method,
                    "full_name": f"{agent.name}.{cap.name}"
                })
        return capabilities

    def execute(self, agent_name: str, action: str, **kwargs) -> ActionResult:
        """
        Execute an action on a specific agent

        Args:
            agent_name: Name of the agent
            action: Action/capability to execute
            **kwargs: Action parameters

        Returns:
            ActionResult with status and data
        """
        if not self._initialized:
            return ActionResult(
                action=f"{agent_name}.{action}",
                status=ActionStatus.FAILED,
                error="Orchestrator not initialized"
            )

        agent = self.get_agent(agent_name)
        if not agent:
            return ActionResult(
                action=f"{agent_name}.{action}",
                status=ActionStatus.FAILED,
                error=f"Unknown agent: {agent_name}. Available: {list(self._agents.keys())}"
            )

        return agent.execute(action, **kwargs)

    def execute_command(self, command: str, **kwargs) -> ActionResult:
        """
        Execute a command in format 'agent.action'

        Args:
            command: Command string like 'posts.list' or 'media.upload'
            **kwargs: Action parameters

        Returns:
            ActionResult
        """
        if '.' not in command:
            return ActionResult(
                action=command,
                status=ActionStatus.FAILED,
                error="Command must be in format 'agent.action'"
            )

        agent_name, action = command.split('.', 1)
        return self.execute(agent_name, action, **kwargs)

    def test_connection(self) -> ActionResult:
        """Test API connection"""
        if not self._initialized:
            return ActionResult(
                action="test-connection",
                status=ActionStatus.FAILED,
                error="Orchestrator not initialized"
            )

        result = self._client.test_connection()
        return ActionResult(
            action="test-connection",
            status=ActionStatus.SUCCESS if result.success else ActionStatus.FAILED,
            data=result.data,
            error=result.error
        )

    def discover_endpoints(self) -> ActionResult:
        """Discover all available API endpoints"""
        if not self._initialized:
            return ActionResult(
                action="discover-endpoints",
                status=ActionStatus.FAILED,
                error="Orchestrator not initialized"
            )

        result = self._client.discover_endpoints()
        return ActionResult(
            action="discover-endpoints",
            status=ActionStatus.SUCCESS if result.success else ActionStatus.FAILED,
            data=result.data,
            error=result.error
        )

    def get_site_info(self) -> Dict[str, Any]:
        """Get site information from config"""
        if self._client:
            return {
                "url": self._client.base_url,
                "api_base": self._client.api_base,
                "name": self._client.config['site'].get('name', 'Unknown'),
            }
        return {}

    def to_dict(self) -> Dict[str, Any]:
        """Serialize orchestrator state"""
        return {
            "initialized": self._initialized,
            "site": self.get_site_info() if self._initialized else None,
            "agents": self.list_agents(),
            "total_capabilities": len(self.list_all_capabilities())
        }


# Convenience singleton
_orchestrator: Optional[AgentOrchestrator] = None

def get_orchestrator(config_path: Optional[str] = None) -> AgentOrchestrator:
    """Get or create singleton orchestrator"""
    global _orchestrator
    if _orchestrator is None:
        _orchestrator = AgentOrchestrator()
        _orchestrator.initialize(config_path)
    return _orchestrator

def reset_orchestrator():
    """Reset singleton orchestrator"""
    global _orchestrator
    _orchestrator = None
