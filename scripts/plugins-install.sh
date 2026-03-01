#!/bin/bash
# Install wshobson plugins for on-demand use in Claude Code sessions.
# Plugins are installed but DISABLED by default (enabledPlugins: false in settings.json).
# Enable per-session with: /plugin install <name>
#
# Usage:
#   ./scripts/plugins-install.sh              # Install all relevant plugins
#   ./scripts/plugins-install.sh core         # Install core stack only
#   ./scripts/plugins-install.sh security     # Install security plugins only

set -euo pipefail

SETTINGS="$HOME/.claude/settings.json"

# Plugin groups
CORE=(
  python-development
  javascript-typescript
  shell-scripting
  database-design
  developer-essentials
  documentation-generation
  framework-migration
)

SECURITY=(
  security-scanning
  security-compliance
  incident-response
)

WORKFLOWS=(
  agent-teams
  full-stack-orchestration
)

FRONTEND=(
  frontend-mobile-development
  ui-design
  accessibility-compliance
)

BUSINESS=(
  startup-business-analyst
  business-analytics
  payment-processing
)

INFRA=(
  cicd-automation
  cloud-infrastructure
  observability-monitoring
  kubernetes-operations
)

AI=(
  llm-application-dev
)

BACKEND=(
  backend-development
  api-scaffolding
)

# Select group
case "${1:-all}" in
  core)     PLUGINS=("${CORE[@]}") ;;
  security) PLUGINS=("${SECURITY[@]}") ;;
  workflows) PLUGINS=("${WORKFLOWS[@]}") ;;
  frontend) PLUGINS=("${FRONTEND[@]}") ;;
  business) PLUGINS=("${BUSINESS[@]}") ;;
  infra)    PLUGINS=("${INFRA[@]}") ;;
  ai)       PLUGINS=("${AI[@]}") ;;
  backend)  PLUGINS=("${BACKEND[@]}") ;;
  all)      PLUGINS=("${CORE[@]}" "${SECURITY[@]}" "${WORKFLOWS[@]}" "${FRONTEND[@]}" "${BUSINESS[@]}" "${INFRA[@]}" "${AI[@]}" "${BACKEND[@]}") ;;
  *)        echo "Usage: $0 [core|security|workflows|frontend|business|infra|ai|backend|all]"; exit 1 ;;
esac

echo "Installing ${#PLUGINS[@]} plugins (disabled by default)..."
echo ""

for plugin in "${PLUGINS[@]}"; do
  echo "  -> $plugin"
  # claude CLI plugin install command
  claude plugin install "$plugin" 2>/dev/null || echo "     (already installed or unavailable)"
done

echo ""
echo "Done. Plugins installed but disabled."
echo "Enable in a session with: /plugin install <name>"
echo "Or toggle in ~/.claude/settings.json → enabledPlugins"
