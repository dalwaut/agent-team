#!/usr/bin/env bash
# OPAI Sandbox Provisioner — Create a user sandbox end-to-end.
#
# Usage:
#   ./scripts/provision-sandbox.sh --user-id <uuid> --name <name> --email <email> \
#       [--role team|client|user] [--profile-json '{"expertise_level":"..."}']
#
# Steps:
#   1. Create directory on NFS mount (creates the NAS folder)
#   2. Copy skeleton from config/sandbox-skeleton/
#   3. Generate identity + config files
#   4. Generate personalized CLAUDE.md (source of truth)
#   5. Generate wiki knowledge base
#   6. Create UUID symlink
#   7. Update Supabase profile
#   8. Write provision report

set -euo pipefail

OPAI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USERS_ROOT="/workspace/users"
SKELETON_DIR="${OPAI_ROOT}/config/sandbox-skeleton"
DEFAULTS_FILE="${OPAI_ROOT}/config/sandbox-defaults.json"

# ── Parse arguments ──────────────────────────────────────────

USER_ID=""
USER_NAME=""
USER_EMAIL=""
USER_ROLE="team"
PROFILE_JSON="{}"

while [[ $# -gt 0 ]]; do
    case $1 in
        --user-id)      USER_ID="$2"; shift 2 ;;
        --name)         USER_NAME="$2"; shift 2 ;;
        --email)        USER_EMAIL="$2"; shift 2 ;;
        --role)         USER_ROLE="$2"; shift 2 ;;
        --profile-json) PROFILE_JSON="$2"; shift 2 ;;
        *) echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
done

if [[ -z "$USER_ID" || -z "$USER_NAME" || -z "$USER_EMAIL" ]]; then
    echo "Usage: provision-sandbox.sh --user-id <uuid> --name <name> --email <email> [--role team|client|user]"
    exit 1
fi

# Sanitize name for directory (lowercase, alphanumeric + hyphens only)
SAFE_NAME=$(echo "$USER_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g' | sed 's/--*/-/g' | sed 's/^-\|-$//g')

# Capitalize for display
DISPLAY_NAME=$(echo "$USER_NAME" | sed 's/\b\(.\)/\u\1/g')

# Parse profile data
EXPERTISE=$(echo "$PROFILE_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('expertise_level','beginner'))" 2>/dev/null || echo "beginner")
USE_CASE=$(echo "$PROFILE_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('primary_use_case','general'))" 2>/dev/null || echo "general")
TOOLS_PREF=$(echo "$PROFILE_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(','.join(d.get('tools',[])))" 2>/dev/null || echo "")
FOCUS_AREAS=$(echo "$PROFILE_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(','.join(d.get('focus_areas',[])))" 2>/dev/null || echo "")

# ── Colors ────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ── Preflight ────────────────────────────────────────────────

echo "=== OPAI Sandbox Provisioner ==="
echo "User: ${DISPLAY_NAME} (${USER_EMAIL})"
echo "ID: ${USER_ID}"
echo "Role: ${USER_ROLE}"
echo "Expertise: ${EXPERTISE} | Use case: ${USE_CASE}"
echo ""

if [[ ! -d "$USERS_ROOT" ]]; then
    err "Users root not mounted: ${USERS_ROOT}. Run setup-nfs.sh first."
fi

if [[ ! -d "$SKELETON_DIR" ]]; then
    err "Skeleton directory not found: ${SKELETON_DIR}"
fi

SANDBOX_DIR="${USERS_ROOT}/${DISPLAY_NAME}"

if [[ -d "$SANDBOX_DIR" ]]; then
    warn "Sandbox directory already exists: ${SANDBOX_DIR}"
    echo "  Re-provisioning will overwrite config but keep user files."
    echo ""
fi

# ── Step 1: Create sandbox directory on NFS mount ─────────────

echo "Creating sandbox directory on NAS..."
mkdir -p "${SANDBOX_DIR}"
log "Directory: ${SANDBOX_DIR}"

# ── Step 2: Copy skeleton ──────────────────────────────────

echo "Copying skeleton..."
rsync -rl --ignore-existing --no-perms --no-group --no-owner "${SKELETON_DIR}/" "${SANDBOX_DIR}/"

# Rename team.json template
if [[ -f "${SANDBOX_DIR}/agents/team.json.template" && ! -f "${SANDBOX_DIR}/agents/team.json" ]]; then
    mv "${SANDBOX_DIR}/agents/team.json.template" "${SANDBOX_DIR}/agents/team.json"
fi
rm -f "${SANDBOX_DIR}/agents/team.json.template"

# Create additional directories
mkdir -p "${SANDBOX_DIR}/wiki"
mkdir -p "${SANDBOX_DIR}/files"
mkdir -p "${SANDBOX_DIR}/Projects"

log "Skeleton copied"

# ── Step 3: Generate .opai-user.json ────────────────────────

cat > "${SANDBOX_DIR}/.opai-user.json" <<EOF
{
  "user_id": "${USER_ID}",
  "name": "${SAFE_NAME}",
  "display_name": "${DISPLAY_NAME}",
  "email": "${USER_EMAIL}",
  "role": "${USER_ROLE}",
  "expertise_level": "${EXPERTISE}",
  "primary_use_case": "${USE_CASE}",
  "sandbox_path": "${SANDBOX_DIR}",
  "provisioned_at": "$(date -Iseconds)",
  "opai_version": "1.3.0"
}
EOF
log "Generated .opai-user.json"

# ── Step 4: Generate config/sandbox.json with role limits ───

LIMITS=$(python3 -c "
import json
defaults = json.load(open('${DEFAULTS_FILE}'))
role = defaults['roles'].get('${USER_ROLE}', defaults['roles']['user'])
print(json.dumps(role, indent=2))
")

MAX_PARALLEL=$(echo "$LIMITS" | python3 -c "import json,sys; print(json.load(sys.stdin)['max_parallel_agents'])")
STORAGE_LIMIT=$(echo "$LIMITS" | python3 -c "import json,sys; print(json.load(sys.stdin)['storage_limit_gb'])")
AGENT_TIMEOUT=$(echo "$LIMITS" | python3 -c "import json,sys; print(json.load(sys.stdin)['agent_timeout_seconds'])")
ALLOWED_CATS=$(echo "$LIMITS" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['allowed_agent_categories']))")

cat > "${SANDBOX_DIR}/config/sandbox.json" <<EOF
{
  "user_id": "${USER_ID}",
  "name": "${SAFE_NAME}",
  "display_name": "${DISPLAY_NAME}",
  "role": "${USER_ROLE}",
  "limits": {
    "max_parallel_agents": ${MAX_PARALLEL},
    "storage_limit_gb": ${STORAGE_LIMIT},
    "agent_timeout_seconds": ${AGENT_TIMEOUT}
  },
  "allowed_agent_categories": ${ALLOWED_CATS},
  "central_queue_path": "/workspace/synced/opai/tasks/registry.json",
  "provisioned_at": "$(date -Iseconds)"
}
EOF
log "Generated config/sandbox.json"

# ── Step 5: Filter team.json based on role ──────────────────

STARTER_AGENTS=$(echo "$LIMITS" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['starter_agents']))")

python3 -c "
import json

team = json.load(open('${SANDBOX_DIR}/agents/team.json'))
starters = ${STARTER_AGENTS}

team['agents'] = {k: v for k, v in team['agents'].items() if k in starters}

for squad_name, squad in list(team['squads'].items()):
    squad['agents'] = [a for a in squad['agents'] if a in team['agents']]
    if not squad['agents']:
        del team['squads'][squad_name]

with open('${SANDBOX_DIR}/agents/team.json', 'w') as f:
    json.dump(team, f, indent=2)
"
log "Filtered agents for role: ${USER_ROLE}"

# ── Step 6: Generate CLAUDE.md (source of truth) ────────────

# Build agent list for CLAUDE.md
AGENT_LIST=$(python3 -c "
import json
team = json.load(open('${SANDBOX_DIR}/agents/team.json'))
for name, agent in team['agents'].items():
    print(f'| \`{name}\` | {agent[\"description\"]} |')
")

SQUAD_LIST=$(python3 -c "
import json
team = json.load(open('${SANDBOX_DIR}/agents/team.json'))
for name, squad in team['squads'].items():
    agents = ', '.join(squad['agents'])
    print(f'| \`{name}\` | {agents} | {squad[\"description\"]} |')
")

cat > "${SANDBOX_DIR}/CLAUDE.md" <<CLAUDEEOF
# ${DISPLAY_NAME}'s OPAI Workspace

> This is your personal OPAI sandbox — a mini agent system connected to the central OPAI orchestrator.
> This file is your source of truth. AI agents read this to understand your workspace.

## About You

| Field | Value |
|-------|-------|
| Name | ${DISPLAY_NAME} |
| Email | ${USER_EMAIL} |
| Role | ${USER_ROLE} |
| Expertise | ${EXPERTISE} |
| Primary Focus | ${USE_CASE} |
| Provisioned | $(date '+%Y-%m-%d') |

## Directory Structure

\`\`\`
${SANDBOX_DIR}/
  CLAUDE.md               This file — your workspace source of truth
  .opai-user.json         Identity metadata
  files/                  Personal file storage (NAS-backed, synced)
  agents/
    team.json             Your agent roster — customize freely
    prompts/              Agent prompt files (edit to change behavior)
  scripts/
    run_agent.sh           Run a single agent
    run_squad.sh           Run a squad (group of agents)
    submit_task.sh         Submit work to central OPAI queue
  reports/latest/          Agent output goes here
  tasks/queue.json         Your task queue (orchestrator reads this)
  config/sandbox.json      Your limits and settings
  wiki/                    Your knowledge base and docs
  workflows/               Usage guide and workflow docs
\`\`\`

## Your Agent Team

| Agent | What It Does |
|-------|-------------|
${AGENT_LIST}

## Your Squads

| Squad | Agents | Purpose |
|-------|--------|---------|
${SQUAD_LIST}

## Quick Start

\`\`\`bash
# List available squads
./scripts/run_squad.sh --list

# Run the review squad on your current project
./scripts/run_squad.sh review

# Run a single agent
./scripts/run_agent.sh reviewer

# Submit a task to the central OPAI system
./scripts/submit_task.sh "Review my latest changes" "Focus on security"
\`\`\`

## Your Limits

| Resource | Limit |
|----------|-------|
| Parallel agents | ${MAX_PARALLEL} |
| Storage | ${STORAGE_LIMIT} GB |
| Agent timeout | ${AGENT_TIMEOUT}s |
| Agent categories | ${ALLOWED_CATS} |

## How It Works

1. **Your agents** run within this sandbox using \`claude -p\` (zero API cost)
2. **Reports** are written to \`reports/latest/\` after each agent run
3. **Tasks** submitted via \`submit_task.sh\` go to your local queue
4. **The central orchestrator** scans your queue every 5 minutes and picks up pending tasks
5. **Results** come back as reports in your \`reports/\` directory
6. **Files** in \`files/\` are stored on the NAS and can be synced to your local machine via Synology Drive

## Customization

- Edit \`agents/prompts/*.txt\` to change how agents behave
- Edit \`agents/team.json\` to add new agents or squads
- Your changes are preserved across re-provisioning

## Connected Services

- **OPAI Chat** — AI assistant at \`/chat/\`
- **Messenger** — Team messaging at \`/messenger/\`
- **Central Queue** — Your tasks flow to the main OPAI orchestrator
- **NAS Storage** — Files backed up on Synology DS418
CLAUDEEOF

log "Generated CLAUDE.md"

# ── Step 7: Generate wiki knowledge base ─────────────────────

cat > "${SANDBOX_DIR}/wiki/README.md" <<WIKIEOF
# ${DISPLAY_NAME}'s OPAI Wiki

Your personal knowledge base. This wiki is auto-maintained by the system
and updated as your workspace evolves.

## Contents

- [Getting Started](getting-started.md) — First steps with your OPAI sandbox
- [Agents Guide](agents-guide.md) — How to use and customize your AI agents
- [File Storage](file-storage.md) — NAS storage, syncing, and file management
WIKIEOF

cat > "${SANDBOX_DIR}/wiki/getting-started.md" <<WIKIEOF
# Getting Started with OPAI

Welcome to your personal OPAI workspace, ${DISPLAY_NAME}!

## What You Have

Your workspace is a **sandbox** — an isolated environment with your own AI agents,
file storage, and task queue. Everything runs on the OPAI server and your files
are backed up on the Synology NAS.

## First Steps

### 1. Explore the Dashboard
After logging in at the OPAI portal, you'll see your dashboard with links to:
- **OPAI Chat** — Have conversations with AI, ask questions, get help with code
- **Messenger** — Send messages to other OPAI team members

### 2. Try Your Agents
Your agents are AI specialists that analyze code and produce reports. Try running one:
\`\`\`bash
./scripts/run_agent.sh reviewer
\`\`\`
Check the output in \`reports/latest/reviewer.md\`.

### 3. Submit a Task
You can submit tasks to the central OPAI system:
\`\`\`bash
./scripts/submit_task.sh "Analyze my project structure" "Look for improvements"
\`\`\`
The orchestrator picks these up automatically.

### 4. Store Files
Put files in your \`files/\` directory. They're stored on the NAS and backed up automatically.
You can optionally install **Synology Drive Client** to sync them to your local computer.

## Getting Help
- Check the [Agents Guide](agents-guide.md) to learn about customizing agents
- Use OPAI Chat to ask questions
- Send a message to an admin via Messenger
WIKIEOF

cat > "${SANDBOX_DIR}/wiki/agents-guide.md" <<WIKIEOF
# Agents Guide

## What Are Agents?

Agents are AI specialists that run within your sandbox. Each agent has a specific
role (reviewer, researcher, etc.) and produces a report when run.

## Your Current Agents

$(python3 -c "
import json
team = json.load(open('${SANDBOX_DIR}/agents/team.json'))
for name, agent in team['agents'].items():
    print(f'### {agent[\"name\"]} (\`{name}\`)')
    print(f'{agent[\"description\"]}')
    print(f'- Prompt: \`{agent[\"prompt_file\"]}\`')
    print(f'- Category: {agent[\"category\"]}')
    print()
")

## Running Agents

\`\`\`bash
# Run a single agent
./scripts/run_agent.sh <agent_name>

# Run a squad (group of agents)
./scripts/run_squad.sh <squad_name>

# List available squads
./scripts/run_squad.sh --list
\`\`\`

## Customizing Agents

### Change Agent Behavior
Edit the prompt file in \`agents/prompts/\`. For example, to make the reviewer
focus on security:
\`\`\`
Edit agents/prompts/reviewer.txt
\`\`\`

### Add a New Agent
1. Create a prompt file: \`agents/prompts/my-agent.txt\`
2. Add an entry to \`agents/team.json\`:
\`\`\`json
"my_agent": {
    "name": "My Agent",
    "category": "quality",
    "run_order": "parallel",
    "prompt_file": "agents/prompts/my-agent.txt",
    "description": "What this agent does"
}
\`\`\`
3. Optionally add it to a squad in the \`squads\` section

### Create a New Squad
Add to the \`squads\` section in \`agents/team.json\`:
\`\`\`json
"my_squad": {
    "agents": ["reviewer", "my_agent"],
    "description": "My custom squad"
}
\`\`\`
WIKIEOF

cat > "${SANDBOX_DIR}/wiki/file-storage.md" <<WIKIEOF
# File Storage

## How It Works

Your \`files/\` directory is stored on the **Synology DS418 NAS** and mounted
to the OPAI server via NFS. This means:

- Files are available from any OPAI tool (chat, agents, etc.)
- Files are backed up by the NAS (Btrfs snapshots + recycle bin)
- You can sync files to your local computer using Synology Drive

## Storage Limit

Your current storage limit is **${STORAGE_LIMIT} GB**.

## Synology Drive (Optional)

To sync files to your local machine:

1. Download Synology Drive Client from [synology.com](https://www.synology.com/en-us/dsm/feature/drive)
2. Connect to: \`192.168.2.138\` (LAN) or via Tailscale
3. Sync the \`opai-users/${DISPLAY_NAME}\` folder

## Important Notes

- Don't store secrets or credentials in files — use OPAI's secure storage
- Large files (videos, databases) count toward your storage limit
- The NAS recycle bin keeps deleted files for 30 days (admin-managed)
WIKIEOF

log "Generated wiki knowledge base"

# ── Step 8: Create UUID symlink ─────────────────────────────

UUID_LINK="${USERS_ROOT}/${USER_ID}"
if [[ -L "$UUID_LINK" ]]; then
    rm -f "$UUID_LINK"
fi
ln -s "${SANDBOX_DIR}" "$UUID_LINK"
log "Symlink: ${UUID_LINK} → ${SANDBOX_DIR}"

# ── Step 9: Update Supabase profile ─────────────────────────

SUPABASE_URL="${SUPABASE_URL:-}"
SUPABASE_SERVICE_KEY="${SUPABASE_SERVICE_KEY:-}"

if [[ -n "$SUPABASE_URL" && -n "$SUPABASE_SERVICE_KEY" ]]; then
    echo "Updating Supabase profile..."
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
        -X PATCH \
        "${SUPABASE_URL}/rest/v1/profiles?id=eq.${USER_ID}" \
        -H "apikey: ${SUPABASE_SERVICE_KEY}" \
        -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
        -H "Content-Type: application/json" \
        -H "Prefer: return=minimal" \
        -d "{
            \"sandbox_path\": \"${SANDBOX_DIR}\",
            \"sandbox_provisioned\": true,
            \"sandbox_provisioned_at\": \"$(date -Iseconds)\",
            \"sandbox_nas_path\": \"/volume2/opai-users/${DISPLAY_NAME}\"
        }")

    if [[ "$HTTP_CODE" == "204" || "$HTTP_CODE" == "200" ]]; then
        log "Supabase profile updated"
    else
        warn "Supabase update returned HTTP ${HTTP_CODE} (profile may not exist yet)"
    fi
else
    warn "SUPABASE_URL or SUPABASE_SERVICE_KEY not set — skipping profile update"
fi

# ── Step 10: Write provision report ─────────────────────────

REPORT_DIR="${OPAI_ROOT}/reports/$(date +%Y-%m-%d)"
mkdir -p "$REPORT_DIR"

cat > "${REPORT_DIR}/provision-${SAFE_NAME}.md" <<EOF
# Sandbox Provisioned: ${DISPLAY_NAME}

- **User ID**: ${USER_ID}
- **Email**: ${USER_EMAIL}
- **Role**: ${USER_ROLE}
- **Expertise**: ${EXPERTISE}
- **Use Case**: ${USE_CASE}
- **Sandbox**: ${SANDBOX_DIR}
- **NAS Path**: /volume2/opai-users/${DISPLAY_NAME}
- **Provisioned**: $(date -Iseconds)

## Limits
- max_parallel_agents: ${MAX_PARALLEL}
- storage_limit_gb: ${STORAGE_LIMIT}
- agent_timeout_seconds: ${AGENT_TIMEOUT}

## Starter Agents
$(python3 -c "import json; agents=json.load(open('${SANDBOX_DIR}/agents/team.json'))['agents']; [print(f'- {k}: {v[\"description\"]}') for k,v in agents.items()]")

## Files Created
- CLAUDE.md (source of truth)
- .opai-user.json (identity)
- config/sandbox.json (limits)
- agents/team.json (agent roster)
- wiki/ (knowledge base: 4 pages)
- scripts/ (run_agent, run_squad, submit_task)
EOF
log "Report written: ${REPORT_DIR}/provision-${SAFE_NAME}.md"

# ── Done ─────────────────────────────────────────────────────

echo ""
echo "=== Sandbox Provisioned ==="
echo "Path: ${SANDBOX_DIR}"
echo "UUID link: ${UUID_LINK}"
echo "CLAUDE.md: ${SANDBOX_DIR}/CLAUDE.md"
echo ""
echo "Contents:"
ls -la "${SANDBOX_DIR}/"
