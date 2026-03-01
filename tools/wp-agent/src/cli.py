"""
WordPress Agent CLI
Command-line interface for WordPress management
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Optional

from .orchestrator import AgentOrchestrator, get_orchestrator


def format_output(data, format_type: str = "json") -> str:
    """Format output for display"""
    if format_type == "json":
        return json.dumps(data, indent=2, default=str)
    elif format_type == "table":
        # Simple table format for lists
        if isinstance(data, list) and data:
            if isinstance(data[0], dict):
                headers = list(data[0].keys())
                lines = ["\t".join(headers)]
                lines.append("-" * 60)
                for item in data:
                    lines.append("\t".join(str(item.get(h, "")) for h in headers))
                return "\n".join(lines)
        return str(data)
    else:
        return str(data)


def cmd_list_agents(orchestrator: AgentOrchestrator, args):
    """List all available agents"""
    agents = orchestrator.list_agents()
    print(format_output(agents, args.format))


def cmd_list_capabilities(orchestrator: AgentOrchestrator, args):
    """List all capabilities"""
    if args.agent:
        agent = orchestrator.get_agent(args.agent)
        if not agent:
            print(f"Error: Unknown agent '{args.agent}'")
            return
        caps = [cap.to_dict() for cap in agent.get_capabilities()]
    else:
        caps = orchestrator.list_all_capabilities()

    print(format_output(caps, args.format))


def cmd_execute(orchestrator: AgentOrchestrator, args):
    """Execute a command"""
    # Parse additional arguments as key=value pairs
    kwargs = {}
    for param in args.params:
        if '=' in param:
            key, value = param.split('=', 1)
            # Try to parse as JSON for complex types
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                pass
            kwargs[key] = value

    result = orchestrator.execute_command(args.command, **kwargs)
    output = result.to_dict()

    print(format_output(output, args.format))


def cmd_test(orchestrator: AgentOrchestrator, args):
    """Test API connection"""
    result = orchestrator.test_connection()
    print(format_output(result.to_dict(), args.format))


def cmd_discover(orchestrator: AgentOrchestrator, args):
    """Discover API endpoints"""
    result = orchestrator.discover_endpoints()
    print(format_output(result.to_dict(), args.format))


def cmd_info(orchestrator: AgentOrchestrator, args):
    """Show site and orchestrator info"""
    info = orchestrator.to_dict()
    print(format_output(info, args.format))


def cmd_interactive(orchestrator: AgentOrchestrator, args):
    """Start interactive mode"""
    print("WordPress Agent Interactive Mode")
    print("Type 'help' for commands, 'exit' to quit\n")

    while True:
        try:
            line = input("wp-agent> ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nExiting...")
            break

        if not line:
            continue

        if line.lower() in ('exit', 'quit', 'q'):
            break

        if line.lower() == 'help':
            print("""
Commands:
  agents              List all agents
  caps [agent]        List capabilities (optionally for specific agent)
  exec <cmd> [args]   Execute command (e.g., exec posts.list per_page=5)
  test                Test API connection
  info                Show site info
  help                Show this help
  exit                Exit interactive mode

Examples:
  exec posts.list
  exec posts.create title="My Post" content="Hello" status=draft
  exec pages.get page_id=123
  caps posts
""")
            continue

        parts = line.split()
        cmd = parts[0].lower()

        if cmd == 'agents':
            agents = orchestrator.list_agents()
            for a in agents:
                print(f"  {a['name']}: {a['description']} ({a['capabilities_count']} actions)")

        elif cmd == 'caps':
            agent_name = parts[1] if len(parts) > 1 else None
            if agent_name:
                agent = orchestrator.get_agent(agent_name)
                if agent:
                    for cap in agent.get_capabilities():
                        print(f"  {cap.name}: {cap.description}")
                else:
                    print(f"Unknown agent: {agent_name}")
            else:
                for cap in orchestrator.list_all_capabilities():
                    print(f"  {cap['full_name']}: {cap['description']}")

        elif cmd == 'exec':
            if len(parts) < 2:
                print("Usage: exec <agent.action> [key=value ...]")
                continue

            command = parts[1]
            kwargs = {}
            for param in parts[2:]:
                if '=' in param:
                    key, value = param.split('=', 1)
                    try:
                        value = json.loads(value)
                    except json.JSONDecodeError:
                        pass
                    kwargs[key] = value

            result = orchestrator.execute_command(command, **kwargs)
            print(json.dumps(result.to_dict(), indent=2, default=str))

        elif cmd == 'test':
            result = orchestrator.test_connection()
            print(json.dumps(result.to_dict(), indent=2, default=str))

        elif cmd == 'info':
            print(json.dumps(orchestrator.to_dict(), indent=2, default=str))

        else:
            print(f"Unknown command: {cmd}. Type 'help' for available commands.")


def main():
    """Main CLI entry point"""
    parser = argparse.ArgumentParser(
        description="WordPress Agent CLI - Manage WordPress sites via REST API",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  wp-agent agents                    List all agents
  wp-agent caps                      List all capabilities
  wp-agent caps -a posts             List posts agent capabilities
  wp-agent exec posts.list           List all posts
  wp-agent exec posts.create title="Hello" status=draft
  wp-agent test                      Test API connection
  wp-agent -i                        Start interactive mode

Environment Variables:
  WP_PASSWORD    WordPress password (recommended for security)
"""
    )

    parser.add_argument(
        '-c', '--config',
        help='Path to config.yaml file',
        default=None
    )

    parser.add_argument(
        '-f', '--format',
        choices=['json', 'table'],
        default='json',
        help='Output format (default: json)'
    )

    parser.add_argument(
        '-i', '--interactive',
        action='store_true',
        help='Start interactive mode'
    )

    subparsers = parser.add_subparsers(dest='command', help='Available commands')

    # agents command
    subparsers.add_parser('agents', help='List all available agents')

    # caps command
    caps_parser = subparsers.add_parser('caps', help='List capabilities')
    caps_parser.add_argument('-a', '--agent', help='Filter by agent name')

    # exec command
    exec_parser = subparsers.add_parser('exec', help='Execute a command')
    exec_parser.add_argument('cmd', metavar='COMMAND', help='Command in format agent.action')
    exec_parser.add_argument('params', nargs='*', help='Parameters as key=value')

    # test command
    subparsers.add_parser('test', help='Test API connection')

    # discover command
    subparsers.add_parser('discover', help='Discover available API endpoints')

    # info command
    subparsers.add_parser('info', help='Show site and orchestrator info')

    args = parser.parse_args()

    # Initialize orchestrator
    try:
        orchestrator = AgentOrchestrator()
        if not orchestrator.initialize(args.config):
            print("Failed to initialize. Check config.yaml and credentials.", file=sys.stderr)
            sys.exit(1)
    except Exception as e:
        print(f"Initialization error: {e}", file=sys.stderr)
        sys.exit(1)

    # Handle interactive mode
    if args.interactive:
        cmd_interactive(orchestrator, args)
        return

    # Handle commands
    if args.command == 'agents':
        cmd_list_agents(orchestrator, args)
    elif args.command == 'caps':
        cmd_list_capabilities(orchestrator, args)
    elif args.command == 'exec':
        # Remap args for execute
        args.command = args.cmd
        cmd_execute(orchestrator, args)
    elif args.command == 'test':
        cmd_test(orchestrator, args)
    elif args.command == 'discover':
        cmd_discover(orchestrator, args)
    elif args.command == 'info':
        cmd_info(orchestrator, args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
